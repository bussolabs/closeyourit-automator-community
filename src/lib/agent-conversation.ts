import {createHash, randomUUID} from 'node:crypto'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import {type Action} from './schema'
import {isRecord, mutateJsonFileAtomically, writeAtomicJson} from './state'

// CYAU-285 — the agent conversation of a ticket phase survives a restart of the machine.
//
// Before, every session started from zero: a reboot twenty minutes into an autopilot threw those twenty minutes
// away, because the new run had no way to find the conversation the old one was having. Now the automator names
// the conversation BEFORE the work starts (Claude takes the name we give it; Codex announces its own in its first
// event) and writes it here, one file per ticket and phase. The run identity is not the key: a restart claims
// the ticket again with a new one.
//
// A conversation is resumed only when everything still matches — same ticket, phase, engine, folder and
// instruction — AND its file is still on this machine (the rule asked on the ticket: never resume blind). Anything
// else starts a new conversation, as before, and says why in the run log. The entry is removed when the phase
// ends, well or badly, so the next phase never inherits it.

export type ConversationEngine = 'claude' | 'codex'

/** What the session receives: start a conversation (with its name, when we choose it) or resume a named one. */
export type AgentConversation =
  | {mode: 'new'; id?: string}
  | {mode: 'resume'; id: string}

export interface ConversationEntry {
  version: 1
  ticket: string
  phase: string
  engine: ConversationEngine
  conversation_id: string
  cwd: string
  prompt_sha256: string
  recorded_at: string
}

export interface ConversationTarget {
  ticket: string
  phase: string
  engine: ConversationEngine
  cwd: string
  /** `conversationFingerprint` of the instruction the session starts from. */
  fingerprint: string
}

export interface ConversationStore {
  dir: string
  /** Whether the conversation's file is still on this machine: without it a resume would fail by construction. */
  sessionExists(engine: ConversationEngine, id: string, cwd: string): boolean
}

export interface ConversationChoice {
  conversation: AgentConversation
  /** Why an existing entry was NOT resumed; absent when there was nothing to resume. */
  reason?: string
}

/**
 * Sent instead of the original instruction when a conversation is resumed: the instruction is already in the
 * conversation, and repeating it would invite the agent to start the task over.
 */
export const CONVERSATION_RESUME_PROMPT = [
  'This conversation was interrupted before it finished: the automator stopped and is now resuming it.',
  'Continue the same task from where you stopped. Check what is already done in the working copy instead of redoing it,',
  'and end with the final result the original instruction asks for, in the same format.',
].join(' ')

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

/** Conversation ids go into paths and argv: only a UUID is accepted, from us or from the engine. */
export function isConversationId(value: unknown): value is string {
  return typeof value === 'string' && UUID.test(value)
}

/** The name Claude gets for a new conversation. */
export function newConversationId(): string {
  return randomUUID()
}

/**
 * The fingerprint of the instruction a phase session starts from. A conversation born for a different task (a new
 * plan, review findings, another skill bundle) must not be continued as if it were this one.
 */
export function conversationFingerprint(action: Action): string {
  const skill = 'skill' in action && action.skill
    ? {command: action.skill.command, args: action.skill.args ?? null, plugin_dir: action.skill.plugin_dir}
    : null
  return createHash('sha256').update(JSON.stringify({type: action.type, run: action.run, skill})).digest('hex')
}

/** The entry file of a ticket phase. Ticket and phase come from the server: only file-name-safe characters survive. */
export function conversationEntryPath(dir: string, ticket: string, phase: string): string {
  const safe = (value: string): string => value.replace(/[^A-Za-z0-9_-]/g, '_')
  return path.join(dir, `${safe(ticket)}--${safe(phase)}.json`)
}

type EntryRead = {status: 'missing'} | {status: 'corrupt'} | {status: 'ok'; entry: ConversationEntry}

/** Reads an entry. Anything unexpected is `corrupt`: a damaged entry is never resumed. */
export function readConversationEntry(dir: string, ticket: string, phase: string): EntryRead {
  let raw: string
  try {
    raw = fs.readFileSync(conversationEntryPath(dir, ticket, phase), 'utf8')
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'ENOENT' ? {status: 'missing'} : {status: 'corrupt'}
  }
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    return {status: 'corrupt'}
  }
  if (!isRecord(parsed) || parsed.version !== 1 || parsed.ticket !== ticket || parsed.phase !== phase ||
      (parsed.engine !== 'claude' && parsed.engine !== 'codex') || !isConversationId(parsed.conversation_id) ||
      typeof parsed.cwd !== 'string' || typeof parsed.prompt_sha256 !== 'string' || typeof parsed.recorded_at !== 'string') {
    return {status: 'corrupt'}
  }
  return {status: 'ok', entry: parsed as unknown as ConversationEntry}
}

/** Writes the entry atomically, before the session does any work with that conversation. */
export function recordConversation(dir: string, target: ConversationTarget, id: string, now: Date = new Date()): void {
  if (!isConversationId(id)) throw new Error('conversation id is not a UUID')
  const entry: ConversationEntry = {
    version: 1,
    ticket: target.ticket,
    phase: target.phase,
    engine: target.engine,
    conversation_id: id,
    cwd: path.resolve(target.cwd),
    prompt_sha256: target.fingerprint,
    recorded_at: now.toISOString(),
  }
  writeAtomicJson(conversationEntryPath(dir, target.ticket, target.phase), entry)
}

/** Removes the entry of a ticket phase. Missing is fine. */
export function clearConversation(dir: string, ticket: string, phase: string): void {
  const file = conversationEntryPath(dir, ticket, phase)
  mutateJsonFileAtomically(file, () => ({type: fs.existsSync(file) ? 'remove' : 'none', value: undefined}))
}

/**
 * Resume or start over. `forceNew` names a reason that rules a resume out whatever the entry says (review
 * corrections, a resume that just failed). An entry that is not resumed is removed: it describes a conversation
 * this phase will not continue.
 */
export function chooseConversation(
  store: ConversationStore,
  target: ConversationTarget,
  forceNew?: string,
  now: Date = new Date(),
): ConversationChoice {
  const read = readConversationEntry(store.dir, target.ticket, target.phase)
  if (read.status === 'missing') return {conversation: {mode: 'new'}}
  let reason: string
  if (read.status === 'corrupt') reason = 'conversation entry unreadable'
  else {
    const refused = forceNew ?? mismatch(store, read.entry, target, now)
    if (!refused) return {conversation: {mode: 'resume', id: read.entry.conversation_id}}
    reason = refused
  }
  clearConversation(store.dir, target.ticket, target.phase)
  return {conversation: {mode: 'new'}, reason}
}

/**
 * Past this age an entry is not resumed: a phase interrupted that long ago has most likely been worked elsewhere
 * since, and its conversation describes a working copy that no longer exists.
 */
export const CONVERSATION_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000

function mismatch(store: ConversationStore, entry: ConversationEntry, target: ConversationTarget, now: Date): string | undefined {
  if (entry.engine !== target.engine) return `conversation recorded for ${entry.engine}, phase runs on ${target.engine}`
  if (entry.cwd !== path.resolve(target.cwd)) return 'conversation recorded in a different working folder'
  if (entry.prompt_sha256 !== target.fingerprint) return 'conversation recorded for a different instruction'
  const age = now.getTime() - Date.parse(entry.recorded_at)
  if (!(age <= CONVERSATION_MAX_AGE_MS)) return 'conversation recorded too long ago'
  let exists = false
  try {
    exists = store.sessionExists(entry.engine, entry.conversation_id, target.cwd)
  } catch {
    exists = false
  }
  return exists ? undefined : 'conversation file no longer on this machine'
}

/**
 * The store of this machine: the registry in `dir`, the conversation files where the engines keep them — Claude
 * under its config dir, Codex under the home the agent sessions run with. That home is resolved when a resume is
 * considered, as the session would resolve it, and a failure there only means no resume.
 */
export function localConversationStore(dir: string, codexHome: () => string, env: NodeJS.ProcessEnv = process.env): ConversationStore {
  const configured = env.CLAUDE_CONFIG_DIR?.trim()
  const claudeConfig = configured && path.isAbsolute(configured) ? configured : path.join(os.homedir(), '.claude')
  return {
    dir,
    sessionExists: (engine, id, cwd) => engine === 'claude'
      ? claudeConversationExists(id, cwd, claudeConfig)
      : codexConversationExists(id, codexHome()),
  }
}

/**
 * Claude keeps a conversation in `<config>/projects/<folder>/<id>.jsonl`, the folder being the session cwd with
 * every non-alphanumeric character turned into `-`. Very long folders get a shortened name, so the other
 * project folders are looked at too before saying the file is gone.
 */
export function claudeConversationExists(id: string, cwd: string, configDir: string): boolean {
  if (!isConversationId(id)) return false
  const projects = path.join(configDir, 'projects')
  const file = `${id}.jsonl`
  if (isFile(path.join(projects, path.resolve(cwd).replace(/[^A-Za-z0-9]/g, '-'), file))) return true
  let folders: fs.Dirent[]
  try {
    folders = fs.readdirSync(projects, {withFileTypes: true})
  } catch {
    return false
  }
  return folders.some((folder) => folder.isDirectory() && isFile(path.join(projects, folder.name, file)))
}

/** Codex keeps a conversation in `<codex home>/sessions/YYYY/MM/DD/rollout-<time>-<id>.jsonl`. */
export function codexConversationExists(id: string, codexHome: string): boolean {
  if (!isConversationId(id)) return false
  const suffix = `-${id.toLowerCase()}.jsonl`
  const walk = (dir: string, depth: number): boolean => {
    let entries: fs.Dirent[]
    try {
      entries = fs.readdirSync(dir, {withFileTypes: true})
    } catch {
      return false
    }
    for (const entry of entries) {
      if (entry.isFile() && entry.name.toLowerCase().endsWith(suffix)) return true
      if (entry.isDirectory() && depth > 0 && walk(path.join(dir, entry.name), depth - 1)) return true
    }
    return false
  }
  return walk(path.join(codexHome, 'sessions'), 3)
}

function isFile(file: string): boolean {
  try {
    return fs.statSync(file).isFile()
  } catch {
    return false
  }
}
