import * as fs from 'node:fs'
import * as path from 'node:path'
import {sanitizeMultiline} from './output'
import {createStreamingSecretRedactor, redactSecretChunks, redactSecrets} from './secret-redaction'

/** `Date` → `YYYYMMDDTHHmmss` (UTC), used in the log file name. */
export function formatTimestamp(now: Date): string {
  return now.toISOString().slice(0, 19).replace(/[-:]/g, '')
}

function parseTimestamp(stamp: string): Date | null {
  const match = /^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})$/.exec(stamp)
  if (!match) return null
  const [, y, mo, d, h, mi, s] = match.map(Number)
  return new Date(Date.UTC(y, mo - 1, d, h, mi, s))
}

export interface ActionLog {
  path: string
  header(info: {type: string; command: string; cwd: string; start: Date}): void
  write(chunk: string, source?: 'stdout' | 'stderr'): void
  /** Conservatively closes every pending secret candidate at an artificial truncation boundary. */
  truncate(): void
  flush(): void
  footer(result: Record<string, unknown>): void
}

type LogSource = 'stdout' | 'stderr'
const MAX_ORDERED_BUFFER_CHARS = 1024 * 1024

interface BufferedLogEvent {
  source: LogSource
  chunk: string
}

/**
 * Appends to the log file, creating it with 0o600 permissions (CYAU-113): even after best-effort
 * redaction the log can contain sensitive output data → it must be readable ONLY by the user writing it.
 * `appendFileSync` with `mode` applies the permissions only on creation (an existing file stays unchanged) and
 * loops the write until ALL bytes are written — a single `writeSync` could write only part of them
 * on large outputs and silently truncate the log. umask does not touch the owner bits → 0o600 guaranteed.
 */
function appendPrivate(file: string, text: string): void {
  fs.appendFileSync(file, text, {mode: 0o600})
}

/** Opens (creates) an action's log file: `logs/<action>-<ts>.log`. Every write is sanitized. */
export function openLog(dir: string, action: string, now: Date): ActionLog {
  fs.mkdirSync(dir, {recursive: true, mode: 0o700})
  const file = path.join(dir, `${action}-${formatTimestamp(now)}.log`)
  const append = (text: string): void => appendPrivate(file, text)
  const streams = new Map<LogSource, ReturnType<typeof createStreamingSecretRedactor>>()
  let buffered: BufferedLogEvent[] = []
  let bufferedChars = 0
  let bufferContexts = new Map<LogSource, string>()
  const streamFor = (source: LogSource): ReturnType<typeof createStreamingSecretRedactor> => {
    const existing = streams.get(source)
    if (existing) return existing
    const created = createStreamingSecretRedactor()
    streams.set(source, created)
    return created
  }

  const appendBuffered = (forced = false): void => {
    const positions = new Map<LogSource, number[]>()
    for (const [index, event] of buffered.entries()) {
      const sourcePositions = positions.get(event.source) ?? []
      sourcePositions.push(index)
      positions.set(event.source, sourcePositions)
    }

    const safe = buffered.map(() => '')
    for (const [source, sourcePositions] of positions) {
      const stream = streamFor(source)
      const chunks = sourcePositions.map((index) => buffered[index].chunk)
      const redacted = redactSecretChunks(
        chunks,
        bufferContexts.get(source) ?? '',
        forced ? stream.pendingLength() : 0,
      )
      for (const [index, eventIndex] of sourcePositions.entries()) safe[eventIndex] = redacted[index]
      if (forced) stream.forceRedactPending()
    }

    for (const chunk of safe) if (chunk !== '') append(sanitizeMultiline(chunk))
    buffered = []
    bufferedChars = 0
    bufferContexts = new Map()
  }

  const allStreamsResolved = (): boolean => [...streams.values()].every((stream) => stream.pendingLength() === 0)

  const buffer = (event: BufferedLogEvent): void => {
    buffered.push(event)
    bufferedChars += event.chunk.length
    if (allStreamsResolved()) appendBuffered()
    else if (bufferedChars >= MAX_ORDERED_BUFFER_CHARS) appendBuffered(true)
  }

  const flush = (): void => {
    if (buffered.length > 0) {
      for (const stream of streams.values()) stream.flush()
      appendBuffered()
      return
    }
    for (const stream of streams.values()) {
      const tail = stream.flush()
      if (tail !== '') append(sanitizeMultiline(tail))
    }
  }

  return {
    path: file,
    header(info) {
      append(
        [
          `# azione: ${action}`,
          `# tipo:    ${info.type}`,
          `# comando: ${sanitizeMultiline(redactSecrets(info.command))}`,
          `# cwd:     ${sanitizeMultiline(info.cwd)}`,
          `# start:   ${info.start.toISOString()}`,
          '',
          '',
        ].join('\n'),
      )
    },
    write(chunk, source = 'stdout') {
      const stream = streamFor(source)
      if (buffered.length === 0) {
        const safe = stream.write(chunk)
        if (safe !== '') append(sanitizeMultiline(safe))
        const pendingLength = stream.pendingLength()
        if (pendingLength > 0) {
          for (const [existingSource, existingStream] of streams) {
            bufferContexts.set(existingSource, existingStream.leftContext())
          }
          buffer({source, chunk: chunk.slice(-pendingLength)})
        }
        return
      }

      if (!bufferContexts.has(source)) bufferContexts.set(source, stream.leftContext())
      const wasSuppressing = stream.isSuppressing()
      const safe = stream.write(chunk)
      const pendingLength = stream.pendingLength()
      const orderedChunk = wasSuppressing ? `${safe}${chunk.slice(chunk.length - pendingLength)}` : chunk
      buffer({source, chunk: orderedChunk})
    },
    truncate() {
      if (buffered.length > 0) {
        appendBuffered(true)
        return
      }
      for (const stream of streams.values()) {
        const forced = stream.forceRedactPending()
        if (forced !== '') append(sanitizeMultiline(forced))
      }
    },
    flush,
    footer(result) {
      flush()
      append(renderFooter(result))
    },
  }
}

/** The SINGLE footer formatting, shared by `footer()` and `appendLogFooter`: two copies would diverge. */
function renderFooter(record: Record<string, unknown>): string {
  const lines = Object.entries(record).map(([key, value]) => `# ${key}: ${sanitizeMultiline(redactSecrets(String(value)))}`)
  return ['', '', ...lines, ''].join('\n')
}

/**
 * Appends a footer to the log of an ALREADY CLOSED action (CYAU-105).
 *
 * `runAction` writes its own footer as soon as the process ends, so BEFORE the runner downgrades
 * the outcome when the result delivery does not start or is rejected: without this addition the file
 * keeps declaring `status: success` on a run that delivered nothing — and that is exactly
 * the footer that sent the diagnosis astray. The terminal footer follows the one of `runAction`
 * (append-only: the history is not rewritten, the final outcome is added).
 *
 * `excerpt` is the delimited block for uninterpretable output: it lives ONLY in the log file — never in the
 * state nor in a network payload — and goes through the same redaction as the other content.
 *
 * Returns `false` if the write did not succeed, instead of throwing: a log that cannot be written must not
 * abort the tick, but it must not stay silent either — the caller reports it.
 */
export function appendLogFooter(
  file: string,
  record: Record<string, unknown>,
  excerpt?: {label: string; text: string},
): boolean {
  try {
    let payload = renderFooter(record)
    if (excerpt && excerpt.text !== '') {
      const label = sanitizeMultiline(excerpt.label)
      payload += [`# ---- ${label} ----`, sanitizeMultiline(redactSecrets(excerpt.text)), `# ---- fine ${label} ----`, ''].join('\n')
    }
    appendPrivate(file, payload)
    return true
  } catch {
    return false
  }
}

/**
 * Bounded excerpt of an output: head and tail, with the middle elided. It puts ENOUGH of the
 * uninterpretable result in the log to understand what it looked like (a markdown fence? prose? a truncated envelope?)
 * without copying 1 MiB of stdout into the log at every failure.
 */
export function boundedExcerpt(text: string, maxChars: number): string {
  if (maxChars <= 0) return ''
  if (text.length <= maxChars) return text
  const half = Math.floor(maxChars / 2)
  const omitted = text.length - half * 2
  return `${text.slice(0, half)}\n… [${omitted} caratteri omessi] …\n${text.slice(text.length - half)}`
}

/** Deletes logs older than `keepDays` (timestamp read from the file name). Returns the number removed. */
export function prune(dir: string, keepDays: number, now: Date): number {
  let entries: string[]
  try {
    entries = fs.readdirSync(dir)
  } catch {
    return 0
  }
  const cutoff = now.getTime() - keepDays * 86_400_000
  let removed = 0
  for (const entry of entries) {
    const match = /-(\d{8}T\d{6})\.log$/.exec(entry)
    if (!match) continue
    const stamp = parseTimestamp(match[1])
    if (stamp && stamp.getTime() < cutoff) {
      fs.rmSync(path.join(dir, entry), {force: true})
      removed += 1
    }
  }
  return removed
}
