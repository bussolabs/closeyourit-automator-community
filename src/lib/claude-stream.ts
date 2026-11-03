import {StringDecoder} from 'node:string_decoder'

// Reader for `claude -p --output-format stream-json` (CYAU-282). The stream is one JSON object per line and
// its last line (`type: "result"`) carries the same fields as `--output-format json`. Only that line, and any
// line that is not a stream event, reaches `onOutput`: whatever reads stdout today (`claudeIsError`,
// `claudeSessionCostUsd`, `parseAgentReport`) keeps seeing the same text. Every other event goes to `onEvent`.
// The events never enter stdout: one small edit already produces tens of KB, and stdout is capped, so the
// cap would cut exactly the result line.

/**
 * A single event line can carry a whole file (`tool_use_result.originalFile`). Past this size the line is
 * dropped while it streams, so memory stays bounded.
 */
export const STREAM_MAX_LINE_BYTES = 16 * 1024 * 1024

export interface ClaudeStreamHandlers {
  onOutput: (text: string) => void
  onEvent: (event: Record<string, unknown>) => void
}

export interface ClaudeStreamReader {
  push(chunk: Buffer | string): void
  end(): void
}

function streamEvent(line: string): Record<string, unknown> | undefined {
  let parsed: unknown
  try {
    parsed = JSON.parse(line)
  } catch {
    return undefined
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return undefined
  const event = parsed as Record<string, unknown>
  return typeof event.type === 'string' && event.type !== 'result' ? event : undefined
}

export function createClaudeStreamReader(
  handlers: ClaudeStreamHandlers,
  maxLineBytes: number = STREAM_MAX_LINE_BYTES,
): ClaudeStreamReader {
  const decoder = new StringDecoder('utf8')
  let pending = ''
  let pendingBytes = 0
  let dropping = false
  let ended = false

  const emit = (line: string, newline: string): void => {
    const event = streamEvent(line)
    if (event) handlers.onEvent(event)
    else handlers.onOutput(`${line}${newline}`)
  }

  const feed = (text: string): void => {
    let start = 0
    let index = text.indexOf('\n', start)
    while (index !== -1) {
      const piece = text.slice(start, index)
      if (!dropping) emit(`${pending}${piece}`, '\n')
      pending = ''
      pendingBytes = 0
      dropping = false
      start = index + 1
      index = text.indexOf('\n', start)
    }

    if (dropping || start === text.length) return
    const rest = text.slice(start)
    pendingBytes += Buffer.byteLength(rest)
    if (pendingBytes > maxLineBytes) {
      dropping = true
      pending = ''
      return
    }

    pending += rest
  }

  return {
    push(chunk) {
      if (ended) return
      feed(typeof chunk === 'string' ? chunk : decoder.write(chunk))
    },
    end() {
      if (ended) return
      feed(decoder.end())
      ended = true
      if (!dropping && pending !== '') emit(pending, '')
      pending = ''
    },
  }
}
