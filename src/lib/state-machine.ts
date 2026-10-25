import {type RunRecord} from './state'

// State machine of a run (CYAU-16). Every run advances through EXPLICIT,
// recoverable and visible phases: here live the canonical set of states, the graph of allowed transitions
// and the mapping to the ticket status on CloseYourIt (CYI). PURE module (no I/O): persistence belongs to
// the `transition` command (append of a checkpoint to `runs/<run-id>.json`, as in CYAU-12).
//
// Two distinct planes (Technical analysis: "separate run state from CYI state"):
// - the RUN STATE is the internal, granular phase of the run (nine values below);
// - the CYI STATE is the ticket status on the tracker, which the automator can set (in_progress / in_review).
// Many run states share the same CYI state → a phase transition does NOT always imply a change of
// ticket status. `planTransition` distinguishes the two (`phaseChanged` vs `cyiStatusChanged`) so an idempotent
// handler applies the EXTERNAL effect (updating the ticket) only when it really changes: retry and restart
// do not duplicate it (DoD).

/** Run state. Nine explicit phases from acquisition to completion. */
export type RunPhase =
  | 'validating'
  | 'ready'
  | 'implementing'
  | 'verifying'
  | 'reviewing'
  | 'waiting'
  | 'blocked'
  | 'in_review'
  | 'completed'

/** The canonical set of states, in happy-path order. */
export const RUN_PHASES: readonly RunPhase[] = [
  'validating',
  'ready',
  'implementing',
  'verifying',
  'reviewing',
  'waiting',
  'blocked',
  'in_review',
  'completed',
]

/** The phase a run enters as soon as the ticket is acquired. */
export const INITIAL_PHASE: RunPhase = 'validating'

/**
 * Ticket status on CloseYourIt that the automator can set. Deliberately reduced: the automator moves the
 * ticket to "in progress" and then "in review", but does NOT close it (Resolved/Closed remain human review).
 */
export type CyiStatus = 'in_progress' | 'in_review'

// Run states that correspond to "in review" on the tracker side. `completed` is the INTERNAL terminal state of the
// automatic run: the ticket stays "In Review" anyway, waiting for the human review → same CYI state.
const IN_REVIEW_PHASES: ReadonlySet<RunPhase> = new Set<RunPhase>(['in_review', 'completed'])

/** The CYI state corresponding to a run state. All active run states → `in_progress`. */
export function runPhaseToCyiStatus(phase: RunPhase): CyiStatus {
  return IN_REVIEW_PHASES.has(phase) ? 'in_review' : 'in_progress'
}

/**
 * Graph of the allowed transitions (besides the self-transition, always legal for idempotency). It reflects the
 * real flow of the autopilot orchestrator: progress validating → ready → implementing → verifying →
 * reviewing → in_review → completed, with a return to `implementing` on failure (verification/review/reviewer) and
 * the cross-cutting branches `waiting` (waiting for the customer) and `blocked` (intervention) from every active state.
 */
export const TRANSITIONS: Record<RunPhase, readonly RunPhase[]> = {
  // Happy path forward + two branches common to every active state: `waiting` (waiting for the customer's answer)
  // and `blocked` (intervention needed). The ticket stays "In Progress" in both (CYI mapping = in_progress).
  validating: ['ready', 'waiting', 'blocked'],
  ready: ['implementing', 'waiting', 'blocked'],
  // Even when the final outcome belongs to the server, the end of the runtime is not yet the delivery: CI,
  // cross-review and acceptance go through the explicit phases before the terminal one (CYAU-181).
  implementing: ['verifying', 'waiting', 'blocked'],
  // Verification failed → back to implementing; passed → review.
  verifying: ['reviewing', 'implementing', 'waiting', 'blocked'],
  // Internal review with findings → back to implementing; ok → the ticket moves to "In Review".
  reviewing: ['in_review', 'implementing', 'waiting', 'blocked'],
  // After the customer's answer / the unblock, resume from one of the active states.
  waiting: ['validating', 'ready', 'implementing', 'verifying', 'reviewing', 'blocked'],
  blocked: ['validating', 'ready', 'implementing', 'verifying', 'reviewing', 'waiting'],
  // The reviewer asks for changes → back to implementing; approved → completed (CYI state unchanged).
  in_review: ['implementing', 'completed', 'blocked'],
  // Terminal state: no exit (besides the idempotent self-transition).
  completed: [],
}

/** true if `value` is a known state of the state machine (input defence: untrusted CLI/legacy input). */
export function isRunPhase(value: unknown): value is RunPhase {
  return typeof value === 'string' && (RUN_PHASES as readonly string[]).includes(value)
}

/**
 * true if the transition `from → to` is allowed. The self-transition (`from === to`) is ALWAYS legal: it is the
 * idempotent case (retry/restart re-recording the current state) and must never be an error.
 */
export function canTransition(from: RunPhase, to: RunPhase): boolean {
  if (from === to) return true
  return TRANSITIONS[from].includes(to)
}

/** Outcome of planning a transition: what changes (run phase) and whether the external effect is needed (CYI state). */
export interface TransitionPlan {
  /** The current phase before the transition; `null` = the run has no state yet (entry). */
  from: RunPhase | null
  to: RunPhase
  /** Is the transition allowed? If not, nothing is persisted and no effect is applied. */
  allowed: boolean
  /** Does the run phase really change? `false` on an allowed self-transition → no new checkpoint to record. */
  phaseChanged: boolean
  /** The CYI state corresponding to `to`. */
  cyiStatus: CyiStatus
  /** Does the CYI state change compared to `from`? ONLY if `true` must the external effect be applied (update the ticket). */
  cyiStatusChanged: boolean
}

/**
 * Plans the transition `from → to` distinguishing the phase change (internal) from the CYI state change
 * (external). From `from = null` (no phase yet) only entering the initial phase is allowed
 * (`validating`), i.e. when the ticket has just been acquired. Pure, deterministic function: it is the heart
 * of idempotency — an illegal transition or a self-transition yields no external
 * effect (`cyiStatusChanged = false`), so retry and restart do not duplicate it.
 */
export function planTransition(from: RunPhase | null, to: RunPhase): TransitionPlan {
  const allowed = from === null ? to === INITIAL_PHASE : canTransition(from, to)
  const cyiStatus = runPhaseToCyiStatus(to)
  const prevCyi = from === null ? null : runPhaseToCyiStatus(from)
  return {
    from,
    to,
    allowed,
    phaseChanged: allowed && from !== to,
    cyiStatus,
    cyiStatusChanged: allowed && prevCyi !== cyiStatus,
  }
}

/**
 * The current state machine phase derived from the checkpoint history: the LAST checkpoint whose
 * `phase` is a known state. Ignores checkpoints with legacy granular phases (e.g. `setup`/`commit`) → `null` if
 * none. `null` means "no state yet" → the only allowed transition is to `validating`.
 */
export function latestRunPhase(run: RunRecord | null): RunPhase | null {
  if (!run) return null
  for (let i = run.checkpoints.length - 1; i >= 0; i--) {
    const {phase} = run.checkpoints[i]
    if (isRunPhase(phase)) return phase
  }
  return null
}
