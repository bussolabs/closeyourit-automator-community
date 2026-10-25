import {spawnSync} from 'node:child_process'
import {type LeaseRecord} from './lease'
import {latestCheckpoint, type RunRecord} from './state'

// Recovery audit of an interrupted run (CYAU-15). Given a run that stopped (host restarted or
// offline), decides whether to RESUME safely or REPORT for intervention, without ever touching the worktree —
// never delete or duplicate unrecoverable changes. The decision combines five signals (Technical
// analysis): same host, local commit, pushed branch, dirty worktree, expired lease. Pure: commit/dirty
// come from the checkpoint (`RunRecord`), the lease state from the lease file, and "branch pushed" is probed from the
// worktree via `RecoveryGit` (injectable). Whoever evaluates the recovery is not necessarily whoever produced the run:
// - the SAME host coming back online still has the local worktree → all the work is recoverable in place;
// - ANOTHER host can recover only what ended up on the remote → local-only work must be reported.

/** What to do with the run: resume it, stop for an intervention, or leave it to the host that holds it. */
export type RecoveryDecision = 'resume' | 'manual' | 'blocked'

/**
 * Why of `decision`:
 * - `no-checkpoint`    no valid checkpoint → it is not known where to resume from (manual);
 * - `same-host-resume` it is our run and the local worktree is intact → resumable in place (resume);
 * - `remote-resume`    other host, but the work is intact on the remote (or there is no local work) → resumable (resume);
 * - `local-only-work`  other host and local-only work (dirty or unpushed commit) → not recoverable (manual);
 * - `lease-held`       the lease still belongs to another live host → do not recover (blocked).
 */
export type RecoveryReason = 'no-checkpoint' | 'same-host-resume' | 'remote-resume' | 'local-only-work' | 'lease-held'

/** Lease ownership relative to the evaluating host: ours, someone else's, or missing. */
export type LeaseOwner = 'ours' | 'other' | 'none'

/** The observed signals that lead to the decision (exposed for transparency/telemetry). */
export interface RecoverySignals {
  hasCheckpoint: boolean
  sameHost: boolean
  leaseOwner: LeaseOwner
  /** Does the ticket's current lease belong to THIS run (run_id matches)? null if there is no lease/run. */
  leaseRunMatches: boolean | null
  /** true = expired, false = still valid, null = undetermined (no lease or unknown expiry). */
  leaseExpired: boolean | null
  dirty: boolean | null
  /** Is the last checkpoint's commit on a remote branch? true/false, null = not verifiable. */
  branchPushed: boolean | null
  /** Is there work living only on the host's disk (dirty or unpushed commit) → not recoverable elsewhere. */
  localOnlyWork: boolean
}

export interface RecoveryInput {
  run: RunRecord | null
  lease: LeaseRecord | null
  /** Agent Host identity of WHO evaluates (host.id in the secrets). null if not registered → never "same host". */
  hostId: string | null
  /** Outcome of the `remoteContains` probe on the last checkpoint's commit (null if not probeable). */
  branchPushed: boolean | null
  now: Date
}

export interface RecoveryPlan {
  decision: RecoveryDecision
  reason: RecoveryReason
  /** The phase to resume from (the last checkpoint), or null if not resumable. */
  resumePhase: string | null
  ticket: string | null
  signals: RecoverySignals
}

/**
 * Lease expiry relative to `now`. null if there is no lease or the expiry is not known/parsable: in these
 * cases we cannot claim the lease is dead → the caller stays conservative (does not recover someone else's
 * lease of uncertain state).
 */
function leaseExpired(lease: LeaseRecord | null, now: Date): boolean | null {
  if (!lease?.expires_at) return null
  const at = new Date(lease.expires_at).getTime()
  if (Number.isNaN(at)) return null
  return at <= now.getTime()
}

/**
 * Decides how to recover an interrupted run from checkpoint, lease and remote branch state.
 * Pure, deterministic function: no I/O, injected `now`. Rule precedence:
 *  1. no valid checkpoint → manual (no-checkpoint): it is not known where to resume from;
 *  2. lease of ANOTHER host not (yet) expired → blocked (lease-held): live work elsewhere, do not touch;
 *  3. same host → resume (same-host-resume): the local worktree is intact, everything is recoverable in place;
 *  4. otherwise (other host / no lease, lease expired or missing):
 *     - local-only work (dirty or unpushed commit) → manual (local-only-work): not recoverable elsewhere;
 *     - work intact on the remote (or no local work) → resume (remote-resume).
 */
export function auditRecovery(input: RecoveryInput): RecoveryPlan {
  const {run, lease, hostId, branchPushed, now} = input
  const latest = run ? latestCheckpoint(run) : null

  const hasCheckpoint = latest !== null
  // The ticket's current lease belongs to THIS run only if the run_id matches: after the run
  // was interrupted, the lease may have been re-acquired by a different run (same ticket, other
  // run_id) — even on the same host. In that case it is NOT "ours", and resuming the old run
  // would duplicate the work. So both the host and the run_id are needed to call ourselves owners.
  const leaseRunMatches = lease !== null && run !== null ? lease.run_id === run.run_id : null
  const sameHost = hostId !== null && lease !== null && leaseRunMatches === true && lease.host_id === hostId
  const expired = leaseExpired(lease, now)
  const leaseOwner: LeaseOwner = lease ? (sameHost ? 'ours' : 'other') : 'none'
  const dirty = latest?.dirty ?? null
  // A last-checkpoint commit that is not (verifiably) on the remote is local-only work.
  const hasLocalCommit = Boolean(latest?.commit) && branchPushed !== true
  const localOnlyWork = dirty === true || hasLocalCommit

  const ticket = run?.ticket ?? lease?.ticket ?? null
  const signals: RecoverySignals = {hasCheckpoint, sameHost, leaseOwner, leaseRunMatches, leaseExpired: expired, dirty, branchPushed, localOnlyWork}

  const plan = (decision: RecoveryDecision, reason: RecoveryReason, resumePhase: string | null): RecoveryPlan => ({
    decision,
    reason,
    resumePhase,
    ticket,
    signals,
  })

  if (!hasCheckpoint) return plan('manual', 'no-checkpoint', null)

  // The lease is still active but does NOT belong to this run (other host, or a run_id re-acquired even
  // on the same host): the ticket is alive elsewhere, do not recover. Only the lease expiry (dead host) opens
  // the recovery. An uncertain state (unknown expiry) stays conservative → blocked.
  if (leaseOwner === 'other' && expired !== true) return plan('blocked', 'lease-held', null)

  // It is our run: the local worktree contains everything (local commits and dirty state too), so it is
  // recoverable in place. If the lease expired, the downstream gate (`automator lease`) re-acquires it — and
  // fails safely if another host took it in the meantime.
  if (sameHost) return plan('resume', 'same-host-resume', latest.phase)

  // Other host (or no lease), lease expired/missing: only what ended up on the remote is recovered.
  if (localOnlyWork) return plan('manual', 'local-only-work', null)
  return plan('resume', 'remote-resume', latest.phase)
}

// ── Git probe: is the last checkpoint's commit reachable from a remote branch? ────────────────────

/** Git probe for the recovery. It never mutates the worktree nor the local branches (only the remote-tracking refs). */
export interface RecoveryGit {
  /** true if `commit` is reachable from a CURRENT remote branch; false if not; null if not verifiable. */
  remoteContains(worktree: string, commit: string): boolean | null
}

/**
 * Real git probe (spawnSync, argv array = no shell). It FIRST updates the remote-tracking refs with `git fetch`
 * so the check reflects the CURRENT server state, not stale refs: a local `git push` updates the
 * tracking refs, but a push made by ANOTHER host would not show without fetch (false negative), and a stale
 * ref could make a commit later removed upstream look pushed (false positive). The fetch touches neither
 * worktree, index nor local branches. If the remote is not reachable the current state is undetermined → null
 * (conservative: never declare "pushed" what we cannot confirm). `git branch -r --contains` then reads
 * the updated tracking refs.
 */
export function defaultRecoveryGit(): RecoveryGit {
  return {
    remoteContains(worktree, commit) {
      // Update the remote refs: without it, the check would use a potentially stale state. Remote
      // unreachable / not a repo → we cannot confirm the current state → null.
      const fetched = spawnSync('git', ['-C', worktree, 'fetch', '--quiet'], {encoding: 'utf8'})
      if (fetched.status !== 0) return null
      // `--contains=<commit>` binds the sha to the option: an anomalous commit is never taken for a flag.
      const res = spawnSync('git', ['-C', worktree, 'branch', '-r', `--contains=${commit}`], {encoding: 'utf8'})
      if (res.status !== 0) return null // unknown commit (not pushed and not fetchable) → not verifiable
      return res.stdout.trim() !== ''
    },
  }
}
