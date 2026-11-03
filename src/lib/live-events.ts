import os from 'node:os'
import path from 'node:path'
import {redactSecrets} from './secret-redaction'

// Compact live events from Claude's stream-json events (CYAU-282): what the agent reads, searches, runs and
// changes, ready to leave the machine. Built from an allowlist of fields, never by copying the raw event:
// `tool_use_result.originalFile` (the whole file) and the raw `oldString`/`newString` never get out.
// Paths are relative to the ticket folder; anything outside it is dropped, so no host path leaks.

export interface LiveHunk {
  oldStart: number
  oldLines: number
  newStart: number
  newLines: number
  /** Review-style lines: ' ' context, '+' added, '-' removed. */
  lines: string[]
}

export type LiveEvent =
  | {kind: 'file_change'; path: string; created: boolean; added: number; removed: number; hunks: LiveHunk[] | null}
  | {kind: 'file_read'; path: string}
  | {kind: 'search'; pattern: string}
  | {kind: 'command'; command: string}

export interface LiveEventOptions {
  /** The ticket folder: every reported path is relative to it. */
  cwd: string
  /** The project allows the code view; when false only names and counts leave the machine. */
  includeCode: boolean
}

/** Past this many lines a change keeps its counts but not its code. */
export const LIVE_MAX_HUNK_LINES = 400
export const LIVE_MAX_LINE_CHARS = 500
const LIVE_MAX_TEXT_CHARS = 300

// Generated files are noise in a review and lock files can be huge; credential-like files never show code.
const NAME_ONLY_FILES = [
  /(^|\/)db\/schema\.rb$/,
  /(^|\/)db\/structure\.sql$/,
  /(^|\/)(Gemfile|Cargo|poetry|composer|pubspec|flake)\.lock$/,
  /(^|\/)(package-lock\.json|pnpm-lock\.yaml|yarn\.lock|go\.sum|bun\.lockb?)$/,
  /(^|\/)\.env(\.|$)/,
  /(^|\/)config\/(master|credentials)(\/.*)?\.key$/,
  /\.(pem|key|p12|pfx|keystore|jks)$/,
  /(^|\/)credentials(\.[a-z]+)?\.yml(\.enc)?$/,
]

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function shorten(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max)}…` : text
}

/** Free text (a command, a search pattern) with the ticket folder made relative and the home folder as `~`. */
function hostPathsHidden(text: string, cwd: string): string {
  const folder = path.resolve(cwd)
  return text
    .split(`${folder}/`).join('')
    .split(folder).join('.')
    .split(os.homedir()).join('~')
}

function safeText(text: string, cwd: string): string {
  return shorten(redactSecrets(hostPathsHidden(text, cwd)), LIVE_MAX_TEXT_CHARS)
}

// With the code view off a command keeps only its program and plain arguments: heredocs, quoted strings,
// redirections and inline scripts (`-c`, `-e`) can carry code, so everything from the first of them is cut.
const PLAIN_ARGUMENT = /^[\w@%+=:,./~-]+$/
const INLINE_SCRIPT_FLAGS = new Set(['-c', '-e', '--eval', '-r'])
const MAX_PLAIN_ARGUMENTS = 8

function commandWithoutCode(command: string): string {
  const tokens = (command.split('\n')[0] ?? '').trim().split(/\s+/).filter(Boolean)
  const kept: string[] = []
  for (const token of tokens) {
    if (kept.length >= MAX_PLAIN_ARGUMENTS || INLINE_SCRIPT_FLAGS.has(token) || !PLAIN_ARGUMENT.test(token)) break
    kept.push(token)
  }

  const cut = kept.length < tokens.length || command.includes('\n')
  return cut ? `${kept.join(' ')} …`.trim() : kept.join(' ')
}

function relativePath(filePath: unknown, cwd: string): string | undefined {
  if (typeof filePath !== 'string' || filePath === '') return undefined
  const relative = path.relative(path.resolve(cwd), path.resolve(cwd, filePath))
  if (relative === '' || relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) return undefined
  return relative.split(path.sep).join('/')
}

function hunksFrom(result: Record<string, unknown>): LiveHunk[] | undefined {
  if (result.type === 'create' && typeof result.content === 'string') {
    const lines = result.content.split('\n')
    if (lines.at(-1) === '') lines.pop()
    return [{oldStart: 0, oldLines: 0, newStart: 1, newLines: lines.length, lines: lines.map((line) => `+${line}`)}]
  }

  if (!Array.isArray(result.structuredPatch)) return undefined
  const hunks: LiveHunk[] = []
  for (const hunk of result.structuredPatch) {
    if (!isRecord(hunk) || !Array.isArray(hunk.lines)) return undefined
    const numbers = [hunk.oldStart, hunk.oldLines, hunk.newStart, hunk.newLines]
    if (!numbers.every((value) => typeof value === 'number' && Number.isInteger(value))) return undefined
    hunks.push({
      oldStart: hunk.oldStart as number,
      oldLines: hunk.oldLines as number,
      newStart: hunk.newStart as number,
      newLines: hunk.newLines as number,
      lines: hunk.lines.filter((line): line is string => typeof line === 'string'),
    })
  }

  return hunks
}

function fileChange(result: Record<string, unknown>, options: LiveEventOptions): LiveEvent | undefined {
  const file = relativePath(result.filePath, options.cwd)
  const hunks = hunksFrom(result)
  if (!file || !hunks) return undefined
  const lines = hunks.flatMap((hunk) => hunk.lines)
  const added = lines.filter((line) => line.startsWith('+')).length
  const removed = lines.filter((line) => line.startsWith('-')).length
  const showCode = options.includeCode
    && !NAME_ONLY_FILES.some((pattern) => pattern.test(file))
    && lines.length <= LIVE_MAX_HUNK_LINES
  return {
    kind: 'file_change',
    path: file,
    created: result.type === 'create',
    added,
    removed,
    // Without code only the four numbers travel: they say where it changed, which the app compares across
    // tickets to warn about conflicts and hold the queue (CYAU-299).
    hunks: showCode
      ? hunks.map((hunk) => ({...hunk, lines: hunk.lines.map((line) => shorten(redactSecrets(line), LIVE_MAX_LINE_CHARS))}))
      : hunks.map((hunk) => ({...hunk, lines: []})),
  }
}

// The app rejects a whole batch over one empty text, so a step with nothing to say is not a step.
function withText(event: LiveEvent | undefined): LiveEvent | undefined {
  if (event?.kind === 'search' && event.pattern.trim() === '') return undefined
  if (event?.kind === 'command' && event.command.trim() === '') return undefined
  return event
}

function toolUseEvent(item: Record<string, unknown>, options: LiveEventOptions): LiveEvent | undefined {
  const input = isRecord(item.input) ? item.input : {}
  switch (item.name) {
    case 'Read': {
      const file = relativePath(input.file_path, options.cwd)
      return file ? {kind: 'file_read', path: file} : undefined
    }

    case 'Grep':
    case 'Glob': {
      return typeof input.pattern === 'string'
        ? {kind: 'search', pattern: safeText(input.pattern, options.cwd)}
        : undefined
    }

    case 'Bash': {
      return typeof input.command === 'string'
        ? {kind: 'command', command: safeText(options.includeCode ? input.command : commandWithoutCode(input.command), options.cwd)}
        : undefined
    }

    default: {
      return undefined
    }
  }
}

/**
 * The live events carried by one stream-json event. File changes come from the tool RESULT (the change was
 * applied); reads, searches and commands from the tool CALL. Unknown shapes produce nothing.
 */
export function liveEventsFromClaude(event: Record<string, unknown>, options: LiveEventOptions): LiveEvent[] {
  if (event.type === 'user' && isRecord(event.tool_use_result)) {
    const change = fileChange(event.tool_use_result, options)
    return change ? [change] : []
  }

  if (event.type === 'assistant' && isRecord(event.message) && Array.isArray(event.message.content)) {
    return event.message.content
      .filter((item): item is Record<string, unknown> => isRecord(item) && item.type === 'tool_use')
      .map((item) => withText(toolUseEvent(item, options)))
      .filter((live): live is LiveEvent => live !== undefined)
  }

  return []
}
