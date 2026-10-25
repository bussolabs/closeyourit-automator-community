import * as fs from 'node:fs'
import * as path from 'node:path'
import {randomUUID} from 'node:crypto'
import {performance} from 'node:perf_hooks'
import {runsDir} from './paths'
import {defaultIsAlive} from './lock'
import {
  directoryLockOwnerName,
  lockProcessIdentity,
  parseDirectoryLockOwner,
  prepareDirectoryLockClaim,
  releaseDirectoryLock,
  type ProcessIdentity,
} from './directory-lock'
import {AutomatorError, ErrorCodes} from '../errors/error-codes'
import {AgentRunResultSchema, type AgentRunResult} from './agent-result'
import {coerceTicketAutomationEvidence, type TicketAutomationEvidence} from './ticket-evidence'

export type RunStatus = 'success' | 'failure' | 'timeout' | 'skipped'

export interface ActionState {
  last_run: string | null // ISO 8601
  last_status: RunStatus | null
  last_duration_ms: number | null
  last_exit_code: number | null
  last_error_code: string | null
  /** Last uniform outcome of the action: persisted for recovery/reporting after a restart (CYAU-46). */
  last_result: AgentRunResult | null
}

export interface State {
  version: 1
  actions: Record<string, ActionState>
}

export function emptyState(): State {
  return {version: 1, actions: {}}
}

export function emptyActionState(): ActionState {
  return {last_run: null, last_status: null, last_duration_ms: null, last_exit_code: null, last_error_code: null, last_result: null}
}

// ── Run checkpoints (CYAU-12) ─────────────────────────────────────────────────────────────
// A run can resume after an interruption without losing the point it reached. Every completed
// phase adds a Checkpoint to the run; the last checkpoint is the point to resume from.
// Every run lives in a dedicated FILE (`runs/<run-id>.json`), separate from the scheduler's
// `state.json`: the `checkpoint` command and the daemon loop write different files → no lost update.

/**
 * Checkpoint of ONE phase: where the work is (branch, commit, worktree), whether there are uncommitted changes
 * (dirty), the produced artefacts, the outcome and when.
 */
export interface Checkpoint {
  phase: string
  branch: string | null
  commit: string | null
  worktree: string | null
  dirty: boolean | null
  artifacts: string[]
  outcome: RunStatus | null
  at: string // ISO 8601
  /** Agent outcome produced by THIS phase; omitted in legacy checkpoints or those that do not run a runtime. */
  result?: AgentRunResult
  /** Gate, read-only review and budget decision produced by the automatic cycle (CYAU-36). */
  automation?: TicketAutomationEvidence
}

/** A run on a ticket in a repository, with the per-phase checkpoint history (append-only). */
export interface RunRecord {
  run_id: string
  /** Crash-safe lineage: this run adopted the recoverable checkpoint of the indicated run. */
  adopted_from?: string
  ticket: string | null
  repository: string | null // owner/repo
  runtime?: string | null // runtime working the run (claude/codex), if known → feeds the dashboard (CYAU-31)
  updated_at: string // ISO 8601 of the last checkpoint
  checkpoints: Checkpoint[]
  /** Last known agent outcome, kept even if the later phases do not run a runtime. */
  result?: AgentRunResult
}

// Segments that, used as a file name (`runs/<run-id>.json`) or as a key, would climb the path or
// mutate the prototype. The run-id comes from the orchestrator/CLI WITHOUT runtime validation → input
// defence, like `workspace.isSafeSegment` / `discover.isUnsafeKey`.
const UNSAFE_SEGMENTS: ReadonlySet<string> = new Set(['', '.', '..', '__proto__', 'prototype', 'constructor'])

/** true if `id` is a run-id safe as a file name: non-empty, not `.`/`..`, without separators/null, not hostile. */
export function isSafeRunId(id: string): boolean {
  return !UNSAFE_SEGMENTS.has(id) && !/[/\\\0]/.test(id)
}

/** Path of a run's checkpoint file: `<runsDir>/<run-id>.json`. Validates the run-id (never path traversal). */
export function runPath(runId: string, base: string = runsDir()): string {
  if (!isSafeRunId(runId)) {
    throw new AutomatorError(ErrorCodes.State.invalidRunId, `run-id non sicuro come nome file: "${runId}"`, 2)
  }

  return path.join(base, `${runId}.json`)
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** Untrusted local/durable input: a partial result or one with invented fields is ignored entirely. */
function coerceAgentRunResult(value: unknown): AgentRunResult | null {
  const parsed = AgentRunResultSchema.safeParse(value)
  return parsed.success ? parsed.data : null
}

function isRunStatus(value: unknown): value is RunStatus {
  return value === 'success' || value === 'failure' || value === 'timeout' || value === 'skipped'
}

const FILE_LOCK_TIMEOUT_MS = 16_000
const FILE_LOCK_POLL_MS = 10
const EMPTY_LOCK_STALE_MS = 1_000
const fileLockWaitBuffer = new Int32Array(new SharedArrayBuffer(4))

/** Injectable hooks and dependencies to test interleaving and crashes without weakening the real path. */
export interface AtomicFileOptions {
  lockDir?: string
  timeoutMs?: number
  pollMs?: number
  clock?: () => number
  isAlive?: (pid: number) => boolean
  processIdentity?: ProcessIdentity
  beforeAcquire?: () => void
  beforeRename?: (temp: string, destination: string) => void
}

function waitForFileLock(ms: number): void {
  if (ms > 0) Atomics.wait(fileLockWaitBuffer, 0, 0, ms)
}

/** Recovers only owners that are surely dead; live or unverifiable PIDs stay fail-closed. */
function recoverDeadFileWriter(
  lockDir: string,
  deadline: number,
  clock: () => number,
  isAlive: (pid: number) => boolean,
  identify: ProcessIdentity,
): void {
  let entries: string[]
  try {
    entries = fs.readdirSync(lockDir)
  } catch {
    return
  }

  if (entries.length === 0) {
    try {
      if (Date.now() - fs.statSync(lockDir).mtimeMs >= EMPTY_LOCK_STALE_MS) fs.rmdirSync(lockDir)
    } catch {
      // The creator may have published the owner in the meantime.
    }
    return
  }

  for (const entry of entries) {
    if (clock() >= deadline) return
    const owner = parseDirectoryLockOwner(entry)
    if (!owner) continue
    const alive = isAlive(owner.pid)
    if (clock() >= deadline) return
    const identity = alive ? identify(owner.pid, Math.max(1, deadline - clock())) : null
    if (clock() >= deadline) return
    if (alive && (identity === null || identity === owner.identity)) continue
    try { fs.rmdirSync(path.join(lockDir, entry)) } catch { /* recovery concorrente */ }
  }
  try { fs.rmdirSync(lockDir) } catch { /* owner vivo, ignoto o successore concorrente */ }
}

/**
 * Cross-process lock for a single canonical file. All local read-modify-writes go through here: the read
 * happens only after the acquisition and the lock is released by generation, so an old owner cannot
 * remove a successor's one. A crash is recovered only when PID and start identity prove that
 * the owner no longer exists.
 */
export function withFileWriteLock<T>(file: string, run: () => T, options: AtomicFileOptions = {}): T {
  const lockDir = options.lockDir ?? `${file}.write.lock`
  fs.mkdirSync(path.dirname(lockDir), {recursive: true})
  options.beforeAcquire?.()

  const clock = options.clock ?? (() => performance.now())
  const deadline = clock() + (options.timeoutMs ?? FILE_LOCK_TIMEOUT_MS)
  const pollMs = options.pollMs ?? FILE_LOCK_POLL_MS
  const isAlive = options.isAlive ?? defaultIsAlive
  const identify = options.processIdentity ?? lockProcessIdentity
  const identity = identify(process.pid, Math.max(1, deadline - clock()))
  if (!identity) throw new Error('identità avvio processo non disponibile per il lock file')
  const owner = directoryLockOwnerName(process.pid, identity)

  while (true) {
    const claim = prepareDirectoryLockClaim(lockDir, owner)
    let acquired: boolean
    try {
      if (clock() >= deadline) throw new Error(`timeout acquisizione lock per ${path.basename(file)}`)
      acquired = claim.publish()
    } catch (error) {
      claim.discard()
      throw error
    }

    if (acquired) {
      try {
        return run()
      } finally {
        releaseDirectoryLock(lockDir, owner)
      }
    }

    recoverDeadFileWriter(lockDir, deadline, clock, isAlive, identify)
    const remaining = deadline - clock()
    if (remaining <= 0) throw new Error(`timeout acquisizione lock per ${path.basename(file)}`)
    waitForFileLock(Math.min(pollMs, remaining))
  }
}

function syncDirectoryBestEffort(directory: string): void {
  let fd: number | null = null
  try {
    fd = fs.openSync(directory, 'r')
    fs.fsyncSync(fd)
  } catch {
    // The rename/rm already happened atomically: do not turn a valid commit into an ambiguous error.
  } finally {
    if (fd !== null) {
      try { fs.closeSync(fd) } catch { /* best effort dopo commit */ }
    }
  }
}

/** Replaces the file with a unique sibling, fsynced and published with an atomic rename. Lock already held. */
function replaceJsonUnderLock(file: string, data: unknown, options: AtomicFileOptions): void {
  const directory = path.dirname(file)
  fs.mkdirSync(directory, {recursive: true})
  const temp = `${file}.tmp-${process.pid}-${randomUUID()}`
  let fd: number | null = null
  let published = false

  try {
    fd = fs.openSync(temp, 'wx', 0o600)
    fs.writeFileSync(fd, `${JSON.stringify(data, null, 2)}\n`, 'utf8')
    fs.fsyncSync(fd)
    fs.closeSync(fd)
    fd = null
    options.beforeRename?.(temp, file)
    fs.renameSync(temp, file)
    published = true
    syncDirectoryBestEffort(directory)
  } finally {
    if (fd !== null) {
      try { fs.closeSync(fd) } catch { /* the temp cleanup continues */ }
    }
    if (!published) fs.rmSync(temp, {force: true})
  }
}

export type AtomicJsonMutation<T> =
  | {type: 'write'; data: unknown; value: T}
  | {type: 'remove'; value: T}
  | {type: 'none'; value: T}

/** Runs read/decision/write-or-remove under the same lock of the canonical file. */
export function mutateJsonFileAtomically<T>(
  file: string,
  mutate: () => AtomicJsonMutation<T>,
  options: AtomicFileOptions = {},
): T {
  return withFileWriteLock(file, () => {
    const mutation = mutate()
    if (mutation.type === 'write') replaceJsonUnderLock(file, mutation.data, options)
    if (mutation.type === 'remove') {
      fs.rmSync(file, {force: true})
      syncDirectoryBestEffort(path.dirname(file))
    }
    return mutation.value
  }, options)
}

/** Serialized, crash-safe write: unique temp + fsync + atomic rename. */
export function writeAtomicJson(file: string, data: unknown, options: AtomicFileOptions = {}): void {
  mutateJsonFileAtomically(file, () => ({type: 'write', data, value: undefined}), options)
}

/**
 * Preserves a corrupt file by renaming it `…​.corrupt-<stamp>` instead of letting it be overwritten: the content
 * stays for inspection/recovery. `stamp` must be filesystem-safe. Returns the quarantine path, or `null`
 * if there was nothing to preserve (missing file / failed rename).
 */
export function quarantineCorruptState(file: string, stamp: string): string | null {
  const dest = `${file}.corrupt-${stamp}`
  try {
    fs.renameSync(file, dest)
    return dest
  } catch {
    return null
  }
}

// ── Scheduler state.json ─────────────────────────────────────────────────────────────────────────

export interface ReadStateResult {
  state: State
  /** true if the file exists but is NOT interpretable (illegal JSON, non-object root or `actions` section).
   *  A missing file is NOT corrupt (first start). The caller must preserve (quarantine) a corrupt file
   *  instead of overwriting it → never lose work. */
  corrupt: boolean
}

/**
 * Reads the scheduler state distinguishing a missing file (first start) from a corrupt/partial one (to preserve).
 * Single malformed actions degrade to defaults (granular tolerance); an `actions` present but
 * non-object marks the whole file `corrupt` (broken structure).
 */
export function readState(file: string): ReadStateResult {
  let raw: string
  try {
    raw = fs.readFileSync(file, 'utf8')
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return {state: emptyState(), corrupt: false}
    return {state: emptyState(), corrupt: true}
  }

  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    return {state: emptyState(), corrupt: true}
  }
  if (!isRecord(parsed)) return {state: emptyState(), corrupt: true}

  let corrupt = false
  const actions: Record<string, ActionState> = {}
  if ('actions' in parsed) {
    if (isRecord(parsed.actions)) {
      for (const [name, value] of Object.entries(parsed.actions)) {
        if (isRecord(value)) {
          actions[name] = {
            ...emptyActionState(),
            ...value,
            // Files older than CYAU-46 do not have the field; a malformed value does not become trusted state.
            last_result: coerceAgentRunResult(value.last_result),
          } as ActionState
        }
      }
    } else corrupt = true
  }

  return {state: {version: 1, actions}, corrupt}
}

/** Loads the state; missing or corrupt file → empty state (never crashes). Backward-compatible wrapper of `readState`. */
export function loadState(file: string): State {
  return readState(file).state
}

/** Atomic write of the scheduler's state.json. */
export function saveState(file: string, state: State): void {
  writeAtomicJson(file, state)
}

/** Updates the state of a single action (mutates and returns the state), preserving the others. */
export function updateAction(state: State, name: string, patch: Partial<ActionState>): State {
  state.actions[name] = {...emptyActionState(), ...state.actions[name], ...patch}
  return state
}

// ── runs/<run-id>.json (a run's checkpoints) ─────────────────────────────────────────────────

/** Normalizes a raw checkpoint from disk: `phase` (string) is the minimal identity; the rest degrades to defaults. */
function coerceCheckpoint(value: unknown): Checkpoint | null {
  if (!isRecord(value) || typeof value.phase !== 'string') return null
  const result = coerceAgentRunResult(value.result)
  const automation = coerceTicketAutomationEvidence(value.automation)
  return {
    phase: value.phase,
    branch: typeof value.branch === 'string' ? value.branch : null,
    commit: typeof value.commit === 'string' ? value.commit : null,
    worktree: typeof value.worktree === 'string' ? value.worktree : null,
    dirty: typeof value.dirty === 'boolean' ? value.dirty : null,
    artifacts: Array.isArray(value.artifacts) ? value.artifacts.filter((a): a is string => typeof a === 'string') : [],
    outcome: isRunStatus(value.outcome) ? value.outcome : null,
    at: typeof value.at === 'string' ? value.at : '',
    ...(result ? {result} : {}),
    ...(automation ? {automation} : {}),
  }
}

function latestCheckpointResult(checkpoints: Checkpoint[]): AgentRunResult | null {
  for (let i = checkpoints.length - 1; i >= 0; i--) {
    const result = checkpoints[i]?.result
    if (result) return result
  }
  return null
}

/** Normalizes a raw run from disk, discarding malformed checkpoints (granular degradation). */
function coerceRunRecord(value: Record<string, unknown>): RunRecord {
  const raw = Array.isArray(value.checkpoints) ? value.checkpoints : []
  const checkpoints = raw.map(coerceCheckpoint).filter((c): c is Checkpoint => c !== null)
  const updatedAt = typeof value.updated_at === 'string' ? value.updated_at : (checkpoints.at(-1)?.at ?? '')
  const result = coerceAgentRunResult(value.result) ?? latestCheckpointResult(checkpoints)
  return {
    run_id: typeof value.run_id === 'string' ? value.run_id : '',
    ...(typeof value.adopted_from === 'string' && isSafeRunId(value.adopted_from)
      ? {adopted_from: value.adopted_from}
      : {}),
    ticket: typeof value.ticket === 'string' ? value.ticket : null,
    repository: typeof value.repository === 'string' ? value.repository : null,
    // runtime is ADDITIVE and backward-compatible: a file written before CYAU-31 does not have it → field omitted.
    ...(typeof value.runtime === 'string' ? {runtime: value.runtime} : {}),
    updated_at: updatedAt,
    checkpoints,
    ...(result ? {result} : {}),
  }
}

export interface ReadRunResult {
  /** The run read, or `null` if the file is missing (never started) or corrupt. */
  run: RunRecord | null
  corrupt: boolean
}

/** Reads a run's checkpoint file. Missing → not corrupt (never started); illegal JSON/non-object → corrupt. */
export function readRun(file: string): ReadRunResult {
  let raw: string
  try {
    raw = fs.readFileSync(file, 'utf8')
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return {run: null, corrupt: false}
    return {run: null, corrupt: true}
  }

  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    return {run: null, corrupt: true}
  }
  if (!isRecord(parsed)) return {run: null, corrupt: true}

  return {run: coerceRunRecord(parsed), corrupt: false}
}

export interface AtomicReadRunResult extends ReadRunResult {
  quarantined: string | null
}

/** Reads and, only if still corrupt after the lock, preserves the observed file without hitting a new writer. */
export function readRunAtomically(
  file: string,
  corruptStamp: string,
  options: AtomicFileOptions = {},
): AtomicReadRunResult {
  return withFileWriteLock(file, () => {
    const current = readRun(file)
    const quarantined = current.corrupt ? quarantineCorruptState(file, `${corruptStamp}-${randomUUID()}`) : null
    return {...current, quarantined}
  }, options)
}

/** Atomic write of a run's checkpoint file. */
export function saveRun(file: string, run: RunRecord): void {
  writeAtomicJson(file, run)
}

export interface RunMutation<T> {
  /** `undefined` means no-op on the canonical file; a RunRecord is published atomically. */
  run?: RunRecord
  value: T
}

export interface AtomicRunMutationResult<T> {
  value: T
  quarantined: string | null
}

/**
 * Reads, validates and updates a run under the same file lock. It is the primitive used by the checkpoint
 * appends and by the transitions: an old snapshot can no longer overwrite already published phases.
 */
export function mutateRunAtomically<T>(
  file: string,
  corruptStamp: string,
  mutate: (run: RunRecord | null) => RunMutation<T>,
  options: AtomicFileOptions = {},
): AtomicRunMutationResult<T> {
  return mutateJsonFileAtomically(file, () => {
    const {run, corrupt} = readRun(file)
    const quarantined = corrupt ? quarantineCorruptState(file, `${corruptStamp}-${randomUUID()}`) : null
    const mutation = mutate(run)
    return mutation.run === undefined
      ? {type: 'none', value: {value: mutation.value, quarantined}}
      : {type: 'write', data: mutation.run, value: {value: mutation.value, quarantined}}
  }, options)
}

/**
 * Timestamp of the next checkpoint assigned inside the publication critical section. The clock can
 * go backwards and external probes can end out of order: the value therefore stays strictly after
 * the last checkpoint observed under lock, so history and `updated_at` never regress.
 */
export function checkpointPublicationAt(existing: RunRecord | null, now: Date = new Date()): string {
  const currentMs = now.getTime()
  const previousMs = Date.parse(existing?.checkpoints.at(-1)?.at ?? '')
  const publicationMs = Number.isFinite(previousMs) && previousMs >= currentMs ? previousMs + 1 : currentMs
  return new Date(publicationMs).toISOString()
}

/** Invariant metadata of a run: they enrich the RunRecord without ever overwriting it with `null`. */
export interface RunMeta {
  ticket?: string | null
  repository?: string | null // owner/repo
  runtime?: string | null // implementing runtime (claude/codex), shown in the dashboard (CYAU-31)
}

/** Fields of a phase checkpoint; the optional ones degrade to `null`/empty list. */
export interface CheckpointInput {
  phase: string
  branch?: string | null
  commit?: string | null
  worktree?: string | null
  dirty?: boolean | null
  artifacts?: string[]
  outcome?: RunStatus | null
  at: string // ISO 8601
  /** Uniform outcome produced by the phase; already validated by normalizeAgentResult. */
  result?: AgentRunResult | null
  automation?: TicketAutomationEvidence | null
}

/**
 * Records a phase checkpoint on a run, returning the UPDATED RunRecord (pure function, does not
 * mutate the input). At the first phase `existing` is `null` → creates; then it APPENDS the checkpoints (never overwrites the
 * history). `run_id` is always the one passed (authoritative from the file name/CLI). `meta` enriches
 * ticket/repository only if given (a phase without meta does not clear the already known ones).
 */
export function recordCheckpoint(existing: RunRecord | null, runId: string, meta: RunMeta, input: CheckpointInput): RunRecord {
  // Programmatic callers are a boundary too: the TS type does not protect deserialized/cast data at runtime.
  // A malformed result degrades as on read (omitted on the new checkpoint, last valid one preserved).
  const inputResult = coerceAgentRunResult(input.result)
  const automation = coerceTicketAutomationEvidence(input.automation)
  const checkpoint: Checkpoint = {
    phase: input.phase,
    branch: input.branch ?? null,
    commit: input.commit ?? null,
    worktree: input.worktree ?? null,
    dirty: input.dirty ?? null,
    artifacts: input.artifacts ?? [],
    outcome: input.outcome ?? null,
    at: input.at,
    ...(inputResult ? {result: inputResult} : {}),
    ...(automation ? {automation} : {}),
  }

  // runtime: like ticket/repository, it is enriched and not cleared → a phase without runtime does not delete it.
  // Emitted only if known (field omitted when null) → backward compat with RunRecords written before CYAU-31.
  const runtime = meta.runtime ?? existing?.runtime ?? null
  const result = inputResult ?? existing?.result ?? null
  return {
    run_id: runId,
    ...(existing?.adopted_from ? {adopted_from: existing.adopted_from} : {}),
    ticket: meta.ticket ?? existing?.ticket ?? null,
    repository: meta.repository ?? existing?.repository ?? null,
    ...(runtime !== null ? {runtime} : {}),
    updated_at: input.at,
    checkpoints: [...(existing?.checkpoints ?? []), checkpoint],
    ...(result !== null ? {result} : {}),
  }
}

/** The last checkpoint recorded for a run (the point to resume from), or `null` if none. */
export function latestCheckpoint(run: RunRecord): Checkpoint | null {
  return run.checkpoints.at(-1) ?? null
}
