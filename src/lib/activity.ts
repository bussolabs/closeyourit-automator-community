import {type Secrets} from './config'
import {type LeaseRecord, listLeases} from './lease'
import {readRun, type RunRecord, runPath} from './state'
import {latestRunPhase, type RunPhase} from './state-machine'

// Host activity snapshot for the Automation dashboard (CYAU-31). The automator is the ONLY source of truth
// on "what the machine is doing": for every active run (= held lease) it composes the ticket, the
// current phase, the runtime, the start (duration) and the lease state, plus an aggregate operational state. The
// channel is the heartbeat (host-scoped): so CloseYourIt identifies which host works each ticket and makes
// blocked runs evident. PURE, deterministic core (no I/O, injected `now`) → testable and repeatable;
// reading the state from disk lives behind `readHostActivity`, best-effort (it never fails the beat).

/**
 * Operational state of the host derived from its runs. `online`/`offline` are NOT here: the server decides them
 * from the beat (`cron_missed` watchdog). These are the states only the host knows:
 * - `idle` no active run; `busy` at least one progressing; `waiting` waiting for the customer;
 * - `recovery_required` at least one stopped run (blocked phase or expired lease) → needs a look.
 */
export type HostStatus = 'idle' | 'busy' | 'waiting' | 'recovery_required'

/** Health of a run's lease relative to `now`: `unknown` if the server did not expose the expiry. */
export type LeaseHealth = 'active' | 'expired' | 'unknown'

/** An active run on this host, with the data the dashboard shows for the ticket row. */
export interface ActiveRun {
  ticket: string
  run_id: string
  phase: RunPhase | null // current phase (last known checkpoint); null = acquired but no phase yet
  runtime: string | null // claude/codex if known (from the RunRecord); null if not yet recorded
  started_at: string | null // start of the run (lease acquisition) → the dashboard computes the duration
  updated_at: string | null // last sign of activity: the most recent between the last checkpoint and the lease renewal
  lease_expires_at: string | null // lease expiry from the server
  lease_health: LeaseHealth
  stalled: boolean // the run is stopped: blocked phase or expired lease → highlighted in the dashboard (DoD)
}

/** Full snapshot: aggregate operational state + list of active runs. */
export interface HostActivity {
  host_status: HostStatus
  active_runs: ActiveRun[]
}

/** Host without active runs: the fallback snapshot (also when reading the state fails). */
export const IDLE_ACTIVITY: HostActivity = {host_status: 'idle', active_runs: []}

/** The first non-empty string among the candidates, or `null` (ISO fields can be `''` after the coerce from disk). */
function firstNonEmpty(...values: Array<string | null | undefined>): string | null {
  for (const value of values) {
    if (typeof value === 'string' && value !== '') return value
  }
  return null
}

/** The most recent ISO timestamp among the non-empty, parsable candidates, or `null` if none is valid. */
function mostRecent(...values: Array<string | null | undefined>): string | null {
  let best: string | null = null
  let bestMs = Number.NEGATIVE_INFINITY
  for (const value of values) {
    if (typeof value !== 'string' || value === '') continue
    const ms = Date.parse(value)
    if (Number.isNaN(ms) || ms <= bestMs) continue
    bestMs = ms
    best = value
  }
  return best
}

/**
 * Lease health relative to `now`. Missing or unparsable expiry → `unknown` (conservative: declared neither
 * expired nor alive). Expired (`expires_at <= now`) → `expired`; future → `active`.
 */
export function leaseHealth(expiresAt: string | null, now: Date): LeaseHealth {
  if (!expiresAt) return 'unknown'
  const ms = Date.parse(expiresAt)
  if (Number.isNaN(ms)) return 'unknown'
  return ms <= now.getTime() ? 'expired' : 'active'
}

/**
 * Composes the row of an active run from a lease and (if already started) from its run. The phase is
 * the last known checkpoint (`null` = acquired but no phase yet); the runtime comes from the RunRecord (CYAU-31);
 * the start from the lease acquisition (fallback: first checkpoint). `stalled` marks stopped work (DoD "blocked
 * runs evident"): `blocked` phase or expired lease.
 */
export function deriveActiveRun(lease: LeaseRecord, run: RunRecord | null, now: Date): ActiveRun {
  const phase = latestRunPhase(run)
  const health = leaseHealth(lease.expires_at, now)
  return {
    ticket: lease.ticket,
    run_id: lease.run_id,
    phase,
    runtime: run?.runtime ?? null,
    started_at: firstNonEmpty(lease.acquired_at, run?.checkpoints[0]?.at),
    // Last progress = the most RECENT between the last checkpoint (phase) and the last lease renewal (the
    // daemon renews at every beat, often more recent than the checkpoint): "when the run gave its
    // last sign of activity". Not the first available → does not underestimate a recently renewed lease.
    updated_at: mostRecent(run?.updated_at, lease.updated_at),
    lease_expires_at: lease.expires_at,
    lease_health: health,
    stalled: phase === 'blocked' || health === 'expired',
  }
}

/**
 * Aggregate operational state of the host, by precedence from the worst case (so the operator sees the
 * problem at once): a stopped run → `recovery_required`; one waiting for the customer → `waiting`; otherwise, if there
 * is at least one → `busy`; none → `idle`.
 */
export function hostStatus(runs: ActiveRun[]): HostStatus {
  if (runs.length === 0) return 'idle'
  if (runs.some((r) => r.stalled)) return 'recovery_required'
  if (runs.some((r) => r.phase === 'waiting')) return 'waiting'
  return 'busy'
}

export interface HostActivityInput {
  leases: LeaseRecord[]
  runs: RunRecord[] // known runs, matched to the leases by run_id (one without a lease is no longer active → excluded)
  hostId: string | null // filters the leases of THIS host identity; `null` = no filter (no known identity)
  now: Date
}

/**
 * Derives the activity snapshot (pure, deterministic). Iterates over the LEASES (the ACTIVE runs: a held
 * lease = a claimed ticket), matching them to the runs by `run_id`. Filters out the leases of another
 * host identity (stale records after a re-registration, like `renewActiveLeases`). Deterministic order
 * (the leases come from `readdir`, FS order not guaranteed): by ticket, then run_id.
 */
export function deriveHostActivity(input: HostActivityInput): HostActivity {
  const runById = new Map<string, RunRecord>()
  for (const run of input.runs) {
    if (run.run_id !== '') runById.set(run.run_id, run)
  }

  const activeRuns = input.leases
    .filter((lease) => input.hostId === null || lease.host_id === input.hostId)
    .map((lease) => deriveActiveRun(lease, runById.get(lease.run_id) ?? null, input.now))
    .sort((a, b) => (a.ticket === b.ticket ? a.run_id.localeCompare(b.run_id) : a.ticket.localeCompare(b.ticket)))

  return {host_status: hostStatus(activeRuns), active_runs: activeRuns}
}

/** Injectable probes for reading the state (in tests: no real disk). */
export interface ReadActivityDeps {
  leases?: () => LeaseRecord[]
  readRunById?: (runId: string) => RunRecord | null
  now?: () => Date
}

/** Reads a run-id's run from the state dir; missing/hostile run-id or unreadable file → `null`. */
function defaultReadRunById(runId: string): RunRecord | null {
  try {
    return readRun(runPath(runId)).run
  } catch {
    return null
  }
}

/**
 * Activity snapshot read from the state dir: the active leases + their runs. `hostId` from `secrets.host.id`
 * (filters out the stale leases of an old identity). BEST-EFFORT: any I/O error degrades to `IDLE_ACTIVITY`
 * → it must never fail the heartbeat (consistent with the beat swallowing network errors). Recomputed at EVERY
 * beat (the state changes): it must NOT be memoized like the static capabilities.
 */
export function readHostActivity(secrets: Secrets, deps: ReadActivityDeps = {}): HostActivity {
  try {
    const list = deps.leases ?? (() => listLeases())
    const readById = deps.readRunById ?? defaultReadRunById
    const now = (deps.now ?? (() => new Date()))()
    const leases = list()
    const runs: RunRecord[] = []
    for (const lease of leases) {
      const run = readById(lease.run_id)
      if (run) runs.push(run)
    }
    return deriveHostActivity({leases, runs, hostId: secrets.host?.id ?? null, now})
  } catch {
    return IDLE_ACTIVITY
  }
}
