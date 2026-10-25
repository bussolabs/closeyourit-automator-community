import * as fs from 'node:fs'
import * as path from 'node:path'
import {randomUUID} from 'node:crypto'
import {spawnSync} from 'node:child_process'
import {z} from 'zod'
import {leaseHealth} from './activity'
import {hasOperationalHostIdentity, type Secrets} from './config'
import {type FetchFn} from './heartbeat'
import {type LeaseRecord} from './lease'
import {policyCachePath, usageDir} from './paths'
import {isSafeRunId, writeAtomicJson} from './state'
import {AutomatorError, ErrorCodes} from '../errors/error-codes'

// Budget, concurrency limits and kill switch (CYAU-32). Autonomy must be controllable: no host may
// exceed the configured limits and a kill switch must be able to stop new work quickly. The core is
// PURE and deterministic (same policy + same snapshot → same decision): the gate is repeatable and auditable.
// The policy lives SERVER-side (limits per host/repository/organization) with a FAIL-CLOSED local CACHE — if the
// policy cannot be retrieved (server down, cache missing/expired) the gate BLOCKS (not fail-open, never "no limit"
// by mistake). The module executes NOTHING (starting/stopping a run belongs to the orchestrator, as lease does not implement it):
// it decides whether a run can start/continue and, on the kill switch, asks for a safe CHECKPOINT — NEVER a brutal kill
// (the `checkpoint` outcome is the only stop signal for a running run → a Git write is never interrupted).

const DEFAULT_API = 'https://app.closeyour.it'

/** Host-scoped endpoint of the limits policy (server-side, resolves host/repo/org). ⚠️ Server dependency. */
export const DEFAULT_API_LIMITS_PATH = '/api/v1/limits'

// Hard timeout on the policy GET: a hung server must not block the gate (like the other calls of the
// automator channel). On expiry the fetch aborts → handled as "server unreachable" → cache/fail-closed.
const REQUEST_TIMEOUT_MS = 15_000

// ── Policy schema (untrusted input: from the server or the CLI) ──────────────────────────────────────────

const HHMM = /^([01]\d|2[0-3]):[0-5]\d$/

/** An allowed time window (UTC, consistent with schedule.ts): optional days + time [start, end). */
const ScheduleWindowSchema = z
  .object({
    // Allowed days of the week, 0=Sunday..6=Saturday (UTC). Missing/empty = every day.
    days: z.array(z.number().int().min(0).max(6)).optional(),
    start: z.string().regex(HHMM), // "HH:MM" UTC (inclusive)
    end: z.string().regex(HHMM), // "HH:MM" UTC (exclusive); start > end crosses midnight
  })
  .strip()

// Policy schema: EXTRAS stripped (evolving server contract, a new field does not break the policy) but
// types of the KNOWN fields validated (a negative/non-integer limit → invalid policy → fail-closed downstream). All
// limits are OPTIONAL: missing = not binding → a policy can impose only some axes.
const LimitsPolicySchema = z
  .object({
    scope: z.enum(['host', 'repository', 'organization']).optional(),
    max_parallel: z.number().int().nonnegative().optional(), // slots: max concurrent runs on the host
    max_daily_runs: z.number().int().nonnegative().optional(), // budget: runs started per day
    max_daily_cost: z.number().nonnegative().optional(), // budget: accumulated cost per day (abstract unit)
    max_runtime_seconds: z.number().int().nonnegative().optional(), // max duration of a single run
    schedule: z.array(ScheduleWindowSchema).optional(), // allowed time windows (UTC)
    stop_dispatch: z.boolean().optional(), // kill switch: no new run, the active ones → safe checkpoint
    max_age_seconds: z.number().int().nonnegative().optional(), // max cache freshness (fail-closed if expired)
  })
  .strip()

export type ScheduleWindow = z.infer<typeof ScheduleWindowSchema>
export type LimitsPolicy = z.infer<typeof LimitsPolicySchema>
export type LimitsScope = NonNullable<LimitsPolicy['scope']>

/** Validates a raw policy (server/CLI). Non-object or malformed known field → null (never crash, never fail-open). */
export function parseLimitsPolicy(raw: unknown): LimitsPolicy | null {
  const parsed = LimitsPolicySchema.safeParse(raw)
  return parsed.success ? parsed.data : null
}

// ── Time windows (UTC) ───────────────────────────────────────────────────────────────────────────────────

/** "HH:MM" → minutes since the start of the day, or null if malformed (already validated by the schema). */
function minutesFromHm(hm: string): number | null {
  const m = HHMM.exec(hm)
  if (!m) return null
  const [h, min] = hm.split(':').map(Number)
  return h * 60 + min
}

/** true if `now` (UTC) falls in a single window: allowed day AND time in [start, end) (with midnight wrap). */
function isWithinWindow(window: ScheduleWindow, now: Date): boolean {
  if (window.days && window.days.length > 0 && !window.days.includes(now.getUTCDay())) return false
  const start = minutesFromHm(window.start)
  const end = minutesFromHm(window.end)
  if (start === null || end === null) return false
  const t = now.getUTCHours() * 60 + now.getUTCMinutes()
  // start <= end: window within the same day; start > end: window crossing midnight.
  return start <= end ? t >= start && t < end : t >= start || t < end
}

/** true if `now` is inside at least one window. Missing/empty → no time restriction (always allowed). */
export function isWithinSchedule(windows: ScheduleWindow[] | undefined, now: Date): boolean {
  if (!windows || windows.length === 0) return true
  return windows.some((w) => isWithinWindow(w, now))
}

// ── Pure gate ──────────────────────────────────────────────────────────────────────────────────────────────

/** Which limit determined the decision (for the audit and the message to the orchestrator). */
export type LimitKind =
  | 'kill-switch'
  | 'max-parallel'
  | 'daily-runs'
  | 'daily-cost'
  | 'max-runtime'
  | 'schedule'
  | 'policy-unavailable' // policy configured but not retrievable (server down + cache missing/expired)
  | 'usage-unavailable' // daily usage unreadable with a configured budget (fail-closed)

/** The evaluation context: DISPATCH starts a new run, CONTINUE continues an already started run. */
export type LimitsMode = 'dispatch' | 'continue'

/**
 * Gate outcome:
 * - `admit` the run can start/continue;
 * - `deny` (dispatch only) do NOT start a new run — a limit is exceeded or the kill switch is active;
 * - `checkpoint` (continue only) bring the run to a safe CHECKPOINT and stop it — NEVER a brutal kill (DoD).
 * There is no `kill` outcome: STRUCTURAL property (like "no merge" in deliver) → the gate can never ask
 * to brutally interrupt a Git write in progress.
 */
export type LimitsOutcome = 'admit' | 'deny' | 'checkpoint'

/** Current state observed by the host, compared with the policy limits. */
export interface LimitsSnapshot {
  running: number // runs alive now (occupied slots)
  runs_today: number // runs started today (budget)
  cost_today: number // cost accumulated today (budget)
  run_runtime_seconds?: number // duration of the run being evaluated (continue only); undefined = unknown
  budget_readable?: boolean // false = daily usage unreadable (corrupt usage) → fail-closed on the budget
  usage_lock_cleanup_pending?: boolean
  usage_retryable?: boolean
  pending_runs?: number
  pending_cost?: number
  now: Date
}

/** Gate decision (auditable). */
export interface LimitsDecision {
  outcome: LimitsOutcome
  mode: LimitsMode
  limit: LimitKind | null // the limit that decided (null if admit)
  reason: string
  scope: LimitsScope | null // who the policy applies to (host/repository/organization), for the audit
}

function decide(outcome: LimitsOutcome, mode: LimitsMode, limit: LimitKind | null, reason: string, scope: LimitsScope | null): LimitsDecision {
  return {outcome, mode, limit, reason, scope}
}

/**
 * Evaluates whether a run respects the limits (pure, deterministic). DISPATCH (new run): kill switch → time window
 * → slots → run budget → cost budget (the first violation wins; the kill switch takes precedence over everything). A
 * run already started (CONTINUE) is NOT subject to the slot/budget thresholds (it already occupies a slot): kill switch, runtime,
 * window or unverifiable usage produce `checkpoint` (clean stop), NEVER `deny` — a live run is never killed.
 */
export function evaluateLimits(policy: LimitsPolicy, snapshot: LimitsSnapshot, mode: LimitsMode): LimitsDecision {
  const scope = policy.scope ?? null

  if (mode === 'continue') {
    if (policy.stop_dispatch) {
      return decide('checkpoint', mode, 'kill-switch', 'kill switch attivo: porta la run a un checkpoint sicuro e fermala', scope)
    }
    if (snapshot.budget_readable === false) {
      return decide('checkpoint', mode, 'usage-unavailable', 'consumo giornaliero non leggibile (fail-closed): porta la run a un checkpoint sicuro', scope)
    }
    // Max runtime: a CONFIGURED limit but an UNKNOWN runtime (the orchestrator did not pass the duration)
    // → checkpoint (fail-closed): I cannot confirm the run is within the limit, so I do not admit it forever.
    if (policy.max_runtime_seconds !== undefined) {
      if (snapshot.run_runtime_seconds === undefined) {
        return decide('checkpoint', mode, 'max-runtime', 'runtime della run sconosciuto con un limite configurato (fail-closed): porta la run a un checkpoint sicuro', scope)
      }
      if (snapshot.run_runtime_seconds > policy.max_runtime_seconds) {
        return decide('checkpoint', mode, 'max-runtime', `runtime massimo superato (${snapshot.run_runtime_seconds}s > ${policy.max_runtime_seconds}s): checkpoint`, scope)
      }
    }
    if (!isWithinSchedule(policy.schedule, snapshot.now)) {
      return decide('checkpoint', mode, 'schedule', 'fuori dalla finestra oraria consentita: porta la run a un checkpoint sicuro', scope)
    }
    return decide('admit', mode, null, 'la run può proseguire', scope)
  }

  if (policy.stop_dispatch) {
    return decide('deny', mode, 'kill-switch', 'kill switch attivo: nessuna nuova run', scope)
  }
  if (!isWithinSchedule(policy.schedule, snapshot.now)) {
    return decide('deny', mode, 'schedule', 'fuori dalla finestra oraria consentita: nessuna nuova run', scope)
  }
  if (policy.max_parallel !== undefined && snapshot.running >= policy.max_parallel) {
    return decide('deny', mode, 'max-parallel', `slot pieni (${snapshot.running}/${policy.max_parallel} run concorrenti)`, scope)
  }
  // An UNVERIFIABLE usage blocks every new dispatch even if this policy exposes no explicit budget:
  // assuming zero would hide usage that already happened and a later policy could reopen the budget.
  if (snapshot.budget_readable === false) {
    return decide('deny', mode, 'usage-unavailable', 'consumo giornaliero non leggibile (fail-closed): nessuna nuova run', scope)
  }
  const pendingRuns = snapshot.pending_runs ?? 0
  if (policy.max_daily_runs !== undefined && (
    pendingRuns > 0
      ? snapshot.runs_today + pendingRuns > policy.max_daily_runs
      : snapshot.runs_today >= policy.max_daily_runs
  )) {
    return decide('deny', mode, 'daily-runs', `budget run giornaliere esaurito (${snapshot.runs_today}/${policy.max_daily_runs})`, scope)
  }
  const pendingCost = snapshot.pending_cost ?? 0
  if (policy.max_daily_cost !== undefined && (
    pendingCost > 0
      ? snapshot.cost_today + pendingCost > policy.max_daily_cost
      : snapshot.cost_today >= policy.max_daily_cost
  )) {
    return decide('deny', mode, 'daily-cost', `budget di costo giornaliero esaurito (${snapshot.cost_today}/${policy.max_daily_cost})`, scope)
  }
  return decide('admit', mode, null, 'la run può partire', scope)
}

/**
 * FAIL-CLOSED decision when the policy is configured but NOT retrievable (server down + cache missing/expired):
 * the current limits are unknown, so do not risk exceeding them. DISPATCH → deny (do not start); CONTINUE →
 * checkpoint (bring the run to a safe checkpoint, never a kill).
 */
export function failClosedDecision(mode: LimitsMode, scope: LimitsScope | null = null): LimitsDecision {
  return mode === 'dispatch'
    ? decide('deny', mode, 'policy-unavailable', 'policy non recuperabile (fail-closed): nessuna nuova run', scope)
    : decide('checkpoint', mode, 'policy-unavailable', 'policy non recuperabile (fail-closed): porta la run a un checkpoint sicuro', scope)
}

// ── Occupied slots (from the active leases) ────────────────────────────────────────────────────────────────────────

/**
 * Number of occupied slots = LIVE leases of this host. An expired one (`expired`) is a run no longer alive (recovery),
 * it does not occupy a slot; an unknown expiry (`unknown`) is conservatively counted (it occupies until it is known to
 * have expired). `hostId` null = no identity filter (counts all live leases).
 */
export function countRunningLeases(leases: LeaseRecord[], hostId: string | null, now: Date): number {
  return leases.filter((l) => (hostId === null || l.host_id === hostId) && leaseHealth(l.expires_at, now) !== 'expired').length
}

// ── Local policy cache (fail-closed) ─────────────────────────────────────────────────────────────────

/**
 * DEFAULT cache expiry when the policy does not impose its own (`max_age_seconds`). The cache is a
 * convenience for SHORT outages, not a permanent source of truth: after this time without reaching the
 * server the gate fails closed (blocks) instead of trusting a potentially stale policy indefinitely —
 * e.g. a kill switch activated server-side during a long outage is not ignored forever. One hour is ample for
 * a network blip but not for a prolonged absence; the policy can shorten/lengthen it with `max_age_seconds`.
 */
export const DEFAULT_CACHE_MAX_AGE_SECONDS = 3600

/** The last policy known from the server + when it was retrieved (for the cache expiry). */
export interface CachedPolicy {
  policy: LimitsPolicy
  fetched_at: string // ISO 8601
}

/** Persists (atomically) the policy in cache with the retrieval timestamp. */
export function writeCachedPolicy(policy: LimitsPolicy, fetchedAt: Date, file: string = policyCachePath()): void {
  const cached: CachedPolicy = {policy, fetched_at: fetchedAt.toISOString()}
  writeAtomicJson(file, cached)
}

/**
 * Reads the cached policy, or `null` if missing/corrupt/non-conforming/EXPIRED. The expiry (fail-closed) triggers if
 * `now - fetched_at` exceeds `policy.max_age_seconds` (if set) or the default `DEFAULT_CACHE_MAX_AGE_SECONDS`
 * — the cache ALWAYS expires, so a stale policy does not stay valid forever during an outage. An unparsable
 * `fetched_at` → expired (conservative). Missing file/illegal JSON/invalid policy → null (never fail-open).
 */
export function readCachedPolicy(now: Date, file: string = policyCachePath()): LimitsPolicy | null {
  let raw: string
  try {
    raw = fs.readFileSync(file, 'utf8')
  } catch {
    return null
  }

  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    return null
  }
  if (typeof parsed !== 'object' || parsed === null) return null

  const policy = parseLimitsPolicy((parsed as {policy?: unknown}).policy)
  if (!policy) return null

  const maxAge = policy.max_age_seconds ?? DEFAULT_CACHE_MAX_AGE_SECONDS
  const fetchedMs = Date.parse((parsed as {fetched_at?: unknown}).fetched_at as string)
  if (Number.isNaN(fetchedMs) || now.getTime() - fetchedMs > maxAge * 1000) return null
  return policy
}

// ── Daily usage store (budget) ────────────────────────────────────────────────────────────────────────
// One `usage/<YYYY-MM-DD>.json` file per day (UTC) with the number of runs started and the accumulated cost. File-per-
// day (like `leases/`/`runs/`) → no lost update across days. On the same day the read-modify-write is
// serialized by a create-exclusive lock; a leftover lock is not stolen automatically and blocks the gate,
// because recovering it without an audit could hide a record that was only partially completed.

const USAGE_LOCK_TIMEOUT_MS = 5_000
const USAGE_LOCK_POLL_MS = 10
const USAGE_LOCK_TRANSIENT_MS = 5_000
const USAGE_LOCK_FALLBACK_STALE_MS = 60_000

/** Usage of a day: runs started and accumulated cost. */
export interface UsageRecord {
  date: string // YYYY-MM-DD (UTC)
  runs: number
  cost: number
}

/** The date key (UTC) of the day of `now`, used as the usage file name. */
export function usageDateKey(now: Date): string {
  return now.toISOString().slice(0, 10)
}

/** Path of a day's usage file: `<usageDir>/<date>.json`. Validates the date as a segment (never path traversal). */
export function usagePath(date: string, dir: string = usageDir()): string {
  if (!isSafeRunId(date)) {
    throw new AutomatorError(ErrorCodes.Limits.invalidInput, `data di usage non sicura come nome file: "${date}"`, 2)
  }
  return path.join(dir, `${date}.json`)
}

/** Per-day lock: separate from the canonical JSON and visible to the gate if the writer crashes. */
export function usageLockPath(date: string, dir: string = usageDir()): string {
  return `${usagePath(date, dir)}.lock`
}

/** Outcome of the usage read: the record + whether the file was CORRUPT (present but unreadable/malformed). */
export interface ReadUsageResult {
  usage: UsageRecord
  /** true = unreliable file/lock/quarantine. The MISSING file without artifacts (no usage today) is valid;
   *  any unverifiable state is treated fail-closed, never as zero usage. */
  corrupt: boolean
  lock_cleanup_pending?: boolean
  retryable?: boolean
}

export interface ReadUsageOptions {
  /** Probe invoked after acquiring the lock and before the read; useful to verify the protocol. */
  onLockedRead?: () => void
  closeLock?: (fd: number) => void
  removeLock?: (file: string) => void
}

/**
 * Reads a day's usage distinguishing a MISSING file (legitimate: no usage yet, `corrupt:false`) from a
 * CORRUPT one (present but unreadable/malformed → `corrupt:true`): assuming zero on corruption would REOPEN the budget
 * (fail-open) → the budget gate treats it fail-closed instead. A non-finite/negative number is "malformed".
 */
function emptyUsage(date: string): UsageRecord {
  return {date, runs: 0, cost: 0}
}

/** true/false = known presence; null = unverifiable I/O, hence fail-closed. */
function pathPresent(file: string): boolean | null {
  try {
    fs.lstatSync(file)
    return true
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'ENOENT' ? false : null
  }
}

/** A quarantine without a canonical file is a persistent block: only an explicit recovery can recreate it. */
function hasUsageQuarantine(file: string): boolean | null {
  try {
    const prefix = `${path.basename(file)}.corrupt-`
    return fs.readdirSync(path.dirname(file)).some((entry) => entry.startsWith(prefix))
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'ENOENT' ? false : null
  }
}

function readUsageFile(date: string, dir: string): ReadUsageResult {
  const empty: UsageRecord = {date, runs: 0, cost: 0}
  const file = usagePath(date, dir)
  // writeAtomicJson uses this name: a leftover temp makes it undetermined which increment was at commit.
  // Do not ignore it after a manual lock recovery: it remains evidence to preserve and reconcile.
  if (pathPresent(`${file}.tmp`) !== false) {
    return {usage: empty, corrupt: true, lock_cleanup_pending: true, retryable: false}
  }
  let raw: string
  try {
    raw = fs.readFileSync(file, 'utf8')
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') return {usage: empty, corrupt: true}
    const quarantined = hasUsageQuarantine(file)
    return {usage: empty, corrupt: quarantined !== false}
  }

  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    return {usage: empty, corrupt: true}
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return {usage: empty, corrupt: true}
  const p = parsed as Record<string, unknown>
  const dateOk = p.date === date
  const runsOk = typeof p.runs === 'number' && Number.isSafeInteger(p.runs) && p.runs >= 0
  const costOk = typeof p.cost === 'number' && Number.isFinite(p.cost) && p.cost >= 0 && p.cost <= Number.MAX_SAFE_INTEGER
  if (!dateOk || !runsOk || !costOk) return {usage: empty, corrupt: true}
  return {usage: {date, runs: p.runs as number, cost: p.cost as number}, corrupt: false}
}

export function readUsageResult(
  date: string,
  dir: string = usageDir(),
  options: ReadUsageOptions = {},
): ReadUsageResult {
  const lock = usageLockPath(date, dir)
  let fd: number
  try {
    fd = createUsageLock(lock, () => new Date())
  } catch {
    // Active writer/reader, leftover lock or undetermined I/O: an unverifiable read cannot open the gate.
    const state = usageLockState(lock)
    return {
      usage: emptyUsage(date),
      corrupt: true,
      lock_cleanup_pending: state !== 'active',
      retryable: state === 'active',
    }
  }

  let result: ReadUsageResult
  try {
    options.onLockedRead?.()
    result = readUsageFile(date, dir)
  } catch {
    result = {usage: emptyUsage(date), corrupt: true}
  }

  try {
    releaseUsageLock(lock, fd, options.closeLock, options.removeLock)
  } catch {
    return {usage: emptyUsage(date), corrupt: true, lock_cleanup_pending: true, retryable: false}
  }
  return result
}

/** Reads a day's usage; missing/corrupt/malformed file → zeros (never crash). For display/activity. */
export function readUsage(date: string, dir: string = usageDir()): UsageRecord {
  return readUsageResult(date, dir).usage
}

export interface RecordUsageOptions {
  lockTimeoutMs?: number
  pollMs?: number
  now?: () => Date
  /** Injectable probes of the lock protocol; the defaults are the node:fs sync primitives. */
  writeLock?: (fd: number, contents: string) => void
  syncLock?: (fd: number) => void
  syncLockDirectory?: (directory: string) => void
  closeLock?: (fd: number) => void
  removeLock?: (file: string) => void
  /** Validation run under the same lock, right before the commit (atomic gate+reservation). */
  beforeCommit?: (current: UsageRecord) => void
  durableWrite?: (file: string, data: unknown) => void
}

function usageUnavailable(message: string): AutomatorError {
  return new AutomatorError(ErrorCodes.Limits.usageUnavailable, message, 3)
}

/** The lock intentionally stays present, but the counter was not updated: no automatic retries. */
export class UsageRecoveryPendingError extends AutomatorError {
  constructor(message: string) {
    super(ErrorCodes.Limits.usageUnavailable, message, 3)
  }
}

export class UsageLockCleanupPendingError extends UsageRecoveryPendingError {}

export class UsageLockBusyError extends AutomatorError {
  constructor() {
    super(ErrorCodes.Limits.usageUnavailable, 'usage giornaliero occupato da un writer attivo; riprovare più tardi', 3)
  }
}

/** Temp fsync → rename → fsync directory: `recorded:true` implies persistence across a power loss. */
export interface DurableUsageIo {
  open?: typeof fs.openSync
  write?: typeof fs.writeFileSync
  sync?: typeof fs.fsyncSync
  close?: typeof fs.closeSync
  rename?: typeof fs.renameSync
}

export class UsageCommitUncertainError extends Error {}

export function writeDurableUsageJson(file: string, data: unknown, io: DurableUsageIo = {}): void {
  const directory = path.dirname(file)
  const temporary = `${file}.tmp`
  fs.mkdirSync(directory, {recursive: true})

  // Also makes durable the usage directory entry, which may have been created just before by the lock.
  try {
    const parentDescriptor = (io.open ?? fs.openSync)(path.dirname(directory), 'r')
    try {
      ;(io.sync ?? fs.fsyncSync)(parentDescriptor)
    } finally {
      ;(io.close ?? fs.closeSync)(parentDescriptor)
    }
  } catch {
    throw usageUnavailable('directory usage non sincronizzabile prima del commit; nessun consumo registrato')
  }

  let fileDescriptor: number | null = null
  try {
    fileDescriptor = (io.open ?? fs.openSync)(temporary, 'w', 0o600)
    ;(io.write ?? fs.writeFileSync)(fileDescriptor, `${JSON.stringify(data, null, 2)}\n`)
    ;(io.sync ?? fs.fsyncSync)(fileDescriptor)
    ;(io.close ?? fs.closeSync)(fileDescriptor)
    fileDescriptor = null
    ;(io.rename ?? fs.renameSync)(temporary, file)
  } catch {
    const temporaryPresent = pathPresent(temporary)
    if (temporaryPresent !== false) {
      throw new UsageRecoveryPendingError('commit usage interrotto prima del rename; temp preservato per recovery manuale')
    }
    throw usageUnavailable('persistenza usage fallita prima del rename; nessun consumo registrato')
  } finally {
    if (fileDescriptor !== null) {
      try { (io.close ?? fs.closeSync)(fileDescriptor) } catch { /* the tmp stays fail-closed */ }
    }
  }

  try {
    const directoryDescriptor = (io.open ?? fs.openSync)(directory, 'r')
    try {
      ;(io.sync ?? fs.fsyncSync)(directoryDescriptor)
    } finally {
      ;(io.close ?? fs.closeSync)(directoryDescriptor)
    }
  } catch {
    throw new UsageCommitUncertainError('rename eseguito ma fsync della directory non attestabile')
  }
}

function processStartMarker(pid: number): string | null {
  const result = spawnSync('ps', ['-p', String(pid), '-o', 'lstart='], {
    encoding: 'utf8',
    timeout: 500,
    stdio: ['ignore', 'pipe', 'ignore'],
  })
  const marker = result.status === 0 ? result.stdout.trim() : ''
  return marker || null
}

let ownProcessStartMarker: string | null | undefined

function processStartMarkerForCurrentProcess(): string | null {
  if (ownProcessStartMarker === undefined) ownProcessStartMarker = processStartMarker(process.pid)
  return ownProcessStartMarker
}

function usageLockRecoveryPath(file: string): string {
  return `${file}.recovery`
}

function usageLockState(file: string): 'active' | 'stale' {
  if (pathPresent(usageLockRecoveryPath(file)) !== false) return 'stale'
  let ageMs = Number.POSITIVE_INFINITY
  try {
    ageMs = Math.max(0, Date.now() - fs.lstatSync(file).mtimeMs)
    const parsed = JSON.parse(fs.readFileSync(file, 'utf8')) as {
      pid?: unknown
      process_started_at?: unknown
      recovery_pending?: unknown
    }
    if (parsed.recovery_pending === true) return 'stale'
    if (typeof parsed.pid !== 'number' || !Number.isSafeInteger(parsed.pid) || parsed.pid <= 0) {
      return ageMs <= USAGE_LOCK_TRANSIENT_MS ? 'active' : 'stale'
    }
    if (typeof parsed.process_started_at === 'string' && parsed.process_started_at.length > 0) {
      const currentMarker = processStartMarker(parsed.pid)
      if (currentMarker === null) return ageMs <= USAGE_LOCK_TRANSIENT_MS ? 'active' : 'stale'
      return currentMarker === parsed.process_started_at ? 'active' : 'stale'
    }
    try {
      process.kill(parsed.pid, 0)
      return ageMs <= USAGE_LOCK_FALLBACK_STALE_MS ? 'active' : 'stale'
    } catch (error) {
      return (error as NodeJS.ErrnoException).code === 'EPERM' && ageMs <= USAGE_LOCK_FALLBACK_STALE_MS
        ? 'active'
        : 'stale'
    }
  } catch {
    return ageMs <= USAGE_LOCK_TRANSIENT_MS ? 'active' : 'stale'
  }
}

const delay = async (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms))

function createUsageLock(
  file: string,
  now: () => Date,
  io: Pick<RecordUsageOptions, 'writeLock' | 'syncLock' | 'syncLockDirectory' | 'closeLock' | 'removeLock'> = {},
): number {
  fs.mkdirSync(path.dirname(file), {recursive: true})
  if (pathPresent(usageLockRecoveryPath(file)) !== false) {
    throw new UsageLockCleanupPendingError('recovery usage pendente; rimuovere esplicitamente lock e marker dopo la riconciliazione')
  }
  const processStartedAt = processStartMarkerForCurrentProcess()
  const fd = fs.openSync(file, 'wx', 0o600)
  try {
    const contents = `${JSON.stringify({pid: process.pid, started_at: now().toISOString(), process_started_at: processStartedAt})}\n`
    ;(io.writeLock ?? fs.writeFileSync)(fd, contents)
    ;(io.syncLock ?? fs.fsyncSync)(fd)
    ;(io.syncLockDirectory ?? ((directory: string) => {
      const directoryFd = fs.openSync(directory, 'r')
      try {
        fs.fsyncSync(directoryFd)
      } finally {
        fs.closeSync(directoryFd)
      }
    }))(path.dirname(file))
    return fd
  } catch {
    try {
      ;(io.closeLock ?? fs.closeSync)(fd)
    } catch {
      // Undetermined close: do not remove the lock, which must keep blocking every writer/reader.
      throw new UsageLockCleanupPendingError('inizializzazione e chiusura del lock usage fallite; lock preservato per recovery manuale')
    }
    try {
      ;(io.removeLock ?? ((target: string) => fs.rmSync(target, {force: true})))(file)
    } catch {
      throw new UsageLockCleanupPendingError('inizializzazione e rimozione del lock usage fallite; lock residuo da recuperare manualmente')
    }
    throw usageUnavailable('inizializzazione del lock usage fallita; nessun consumo registrato')
  }
}

/** Creates the lock with O_EXCL: two processes cannot both observe the same counter before writing. */
async function acquireUsageLock(file: string, options: RecordUsageOptions): Promise<number> {
  const deadline = Date.now() + (options.lockTimeoutMs ?? USAGE_LOCK_TIMEOUT_MS)
  const pollMs = options.pollMs ?? USAGE_LOCK_POLL_MS

  while (true) {
    try {
      return createUsageLock(file, options.now ?? (() => new Date()), options)
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
      const remaining = deadline - Date.now()
      if (remaining <= 0) {
        if (usageLockState(file) === 'active') throw new UsageLockBusyError()
        throw new UsageLockCleanupPendingError('lock usage residuo o non attestabile; recovery manuale richiesta')
      }
      await delay(Math.min(pollMs, remaining))
    }
  }
}

function releaseUsageLock(
  file: string,
  fd: number,
  close: (fd: number) => void = fs.closeSync,
  remove: (file: string) => void = fs.rmSync,
): void {
  let identity: {dev: bigint; ino: bigint} | null = null
  try {
    const stat = fs.fstatSync(fd, {bigint: true})
    identity = {dev: stat.dev, ino: stat.ino}
  } catch {
    // Without identity the cleanup can still fail closed, but the marker will not overwrite a new owner.
  }
  try {
    close(fd)
  } catch {
    // If the close is undetermined the lock stays: removing it would allow a second writer on the same fd.
    markUsageLockRecoveryPending(file, identity)
    throw usageUnavailable('chiusura del lock usage fallita; consumo non ritentabile finché la recovery non è esplicita')
  }
  try {
    remove(file)
  } catch {
    markUsageLockRecoveryPending(file, identity)
    throw usageUnavailable('rilascio del lock usage fallito; stato lasciato fail-closed per recovery manuale')
  }
}

function markUsageLockRecoveryPending(file: string, identity: {dev: bigint; ino: bigint} | null): void {
  if (identity === null) return
  const stillOwned = (): boolean => {
    try {
      const current = fs.lstatSync(file, {bigint: true})
      return current.dev === identity.dev && current.ino === identity.ino
    } catch {
      return false
    }
  }
  if (!stillOwned()) return
  const recovery = usageLockRecoveryPath(file)
  const temporary = `${recovery}.tmp-${process.pid}-${randomUUID()}`
  let fd: number | null = null
  try {
    fd = fs.openSync(temporary, 'wx', 0o600)
    fs.writeFileSync(fd, `${JSON.stringify({recovery_pending: true, marked_at: new Date().toISOString()})}\n`)
    fs.fsyncSync(fd)
    fs.closeSync(fd)
    fd = null
    if (!stillOwned()) {
      return
    }
    try {
      fs.linkSync(temporary, recovery)
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
    }
    const directoryFd = fs.openSync(path.dirname(file), 'r')
    try {
      fs.fsyncSync(directoryFd)
    } finally {
      fs.closeSync(directoryFd)
    }
  } catch {
    // Best effort: the original error stays authoritative and the lock is never removed automatically.
  } finally {
    if (fd !== null) {
      try { fs.closeSync(fd) } catch { /* the lock stays fail-closed */ }
    }
    try { fs.rmSync(temporary, {force: true}) } catch { /* artefatto preservato: recovery manuale */ }
  }
}

/** The record is already on the canonical file, but the lock was not cleaned up: an automatic retry would duplicate the usage. */
export class UsageRecordedLockError extends AutomatorError {
  constructor(readonly usage: UsageRecord, detail = 'cleanup del lock fallito') {
    super(
      ErrorCodes.Limits.usageUnavailable,
      `consumo scritto, ma ${detail}: non ritentare; recovery manuale richiesta`,
      3,
    )
  }
}

function quarantineUsage(file: string, now: Date): string | null {
  if (pathPresent(file) !== true) return null
  const stamp = now.toISOString().replace(/[:.]/g, '-')
  const destination = `${file}.corrupt-${stamp}-${process.pid}-${randomUUID()}`
  try {
    fs.renameSync(file, destination)
    return destination
  } catch {
    return null
  }
}

/**
 * Increments the usage under the per-day lock. Corrupt/partial state is quarantined and BLOCKS: it is
 * never replaced with zero. A quarantine without a canonical file keeps blocking until an explicit and
 * auditable recovery recreates a valid record; a new day uses a distinct file/lock.
 */
export async function recordUsage(
  date: string,
  delta: {runs?: number; cost?: number},
  dir: string = usageDir(),
  options: RecordUsageOptions = {},
): Promise<UsageRecord> {
  const file = usagePath(date, dir)
  const lock = usageLockPath(date, dir)
  const fd = await acquireUsageLock(lock, options)
  let committed: UsageRecord | null = null
  let operationError: unknown = null
  try {
    const current = readUsageFile(date, dir)
    if (current.corrupt) {
      const quarantined = quarantineUsage(file, (options.now ?? (() => new Date()))())
      const detail = quarantined ? `file precedente preservato in ${quarantined}` : 'quarantena pendente o file non leggibile'
      throw usageUnavailable(`usage giornaliero non affidabile: ${detail}; recovery manuale richiesta`)
    }

    const deltaRuns = delta.runs ?? 0
    const deltaCost = delta.cost ?? 0
    if (!Number.isSafeInteger(deltaRuns) || deltaRuns < 0 || !Number.isFinite(deltaCost) || deltaCost < 0 || deltaCost > Number.MAX_SAFE_INTEGER) {
      throw usageUnavailable('incremento usage non rappresentabile in sicurezza')
    }
    options.beforeCommit?.(current.usage)
    const runs = current.usage.runs + deltaRuns
    const cost = current.usage.cost + deltaCost
    if (!Number.isSafeInteger(runs) || runs < 0 || !Number.isFinite(cost) || cost < 0 || cost > Number.MAX_SAFE_INTEGER) {
      throw usageUnavailable('totale usage non rappresentabile in sicurezza; nessuna scrittura eseguita')
    }
    const appliedCost = cost - current.usage.cost
    if (deltaCost > 0 && appliedCost < deltaCost) {
      throw usageUnavailable('incremento costo non rappresentabile senza sottostima; nessuna scrittura eseguita')
    }

    const updated: UsageRecord = {
      date,
      runs,
      cost,
    }
    try {
      ;(options.durableWrite ?? writeDurableUsageJson)(file, updated)
      committed = updated
    } catch (error) {
      if (error instanceof UsageCommitUncertainError) committed = updated
      throw error
    }
  } catch (error) {
    operationError = error
  }

  try {
    releaseUsageLock(lock, fd, options.closeLock, options.removeLock)
  } catch (error) {
    if (committed) throw new UsageRecordedLockError(committed)
    if (operationError) throw new UsageLockCleanupPendingError('operazione usage fallita e cleanup del lock non riuscito; recovery manuale richiesta')
    throw error
  }
  if (operationError) {
    if (committed) throw new UsageRecordedLockError(committed, 'durabilità del rename non attestabile')
    throw operationError
  }
  return committed!
}

// ── Policy resolution (server → cache → none) ────────────────────────────────────────────────────────

/** Discriminated outcome: a revocation is not an outage and cannot re-enable a policy from the cache. */
export type PolicyFetchOutcome =
  | {outcome: 'success'; data: unknown}
  | {outcome: 'unavailable'}
  | {outcome: 'auth-denied'}

/** Probe that retrieves the raw policy from the server. Injectable in tests. */
export interface PolicyFetcher {
  fetch(): Promise<PolicyFetchOutcome>
}

/**
 * Real probe: host-scoped GET of the policy. Uses the revocable HOST credential when registered (revoking it
 * server-side also disables the limits), without falling back to the org token. `repository` (if given)
 * is passed as a query so the server can return the REPO-specific policy (the host/repo/org scope is resolved by the
 * server). Without sync/token or on outage/5xx → `unavailable`; 401/403 → `auth-denied` (cache forbidden).
 */
export function defaultPolicyFetcher(secrets: Secrets, fetchFn: FetchFn = globalThis.fetch, repository?: string): PolicyFetcher {
  return {
    async fetch() {
      const cfg = secrets.sync
      if (!cfg || !hasOperationalHostIdentity(secrets)) return {outcome: 'unavailable'}
      const token = secrets.host.token
      const query = repository ? `?repository=${encodeURIComponent(repository)}` : ''
      try {
        const res = await fetchFn(`${cfg.apiUrl ?? DEFAULT_API}${DEFAULT_API_LIMITS_PATH}${query}`, {
          method: 'GET',
          headers: {Authorization: `Bearer ${token}`, 'Content-Type': 'application/json'},
          signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
        })
        if (res.status === 401 || res.status === 403) return {outcome: 'auth-denied'}
        if (!res.ok) return {outcome: 'unavailable'}
        const body = (await res.json().catch(() => null)) as {data?: unknown} | null
        return {outcome: 'success', data: body?.data ?? null}
      } catch {
        return {outcome: 'unavailable'}
      }
    },
  }
}

/** `auth-denied` is an immediate fail-closed: the cache cannot bypass revocation/forbidden. */
export type PolicySource = 'server' | 'cache' | 'none' | 'auth-denied'

export interface ResolvedPolicy {
  policy: LimitsPolicy | null
  source: PolicySource
}

/**
 * Resolves the applicable policy: tries the server, then the local cache, then `none` (fail-closed downstream). A
 * valid server response updates the cache (so the host stays protected when the server becomes unreachable again).
 * An INVALID response falls back to the cache; an auth-denied instead fails closed immediately.
 */
export async function resolveLimitsPolicy(fetcher: PolicyFetcher, now: Date, cacheFile: string = policyCachePath()): Promise<ResolvedPolicy> {
  const fetched = await fetcher.fetch()
  if (fetched.outcome === 'auth-denied') return {policy: null, source: 'auth-denied'}
  if (fetched.outcome === 'success') {
    const policy = parseLimitsPolicy(fetched.data)
    if (policy) {
      writeCachedPolicy(policy, now, cacheFile)
      return {policy, source: 'server'}
    }
  }

  const cached = readCachedPolicy(now, cacheFile)
  if (cached) return {policy: cached, source: 'cache'}
  return {policy: null, source: 'none'}
}
