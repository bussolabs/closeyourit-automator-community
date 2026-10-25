// Flow engine (C.3/C.4), PURE part. The automator is a FLOW ORCHESTRATOR: for every ticket it runs the steps in order,
// each one a SKILL of the `closeyourit-skills` plugin run via `claude -p /closeyourit-skills:<step>`
// (skill-mode, C.2). Here live the pure pieces (no DIRECT I/O): the step order, the step→slash-command map,
// the composition of the skill descriptor (command+args+plugin_dir) that feeds `buildClaudeArgv` and — C.4 — the
// bounded-pool scheduler that gives PER-STEP concurrency. The claim, the execution via ClaudeRuntime and the attempt
// delivery are I/O INJECTED into the scheduler (`claimNext`/`runStep`), so the flow stays pure and testable.

import {type ExecutionPhase} from './phase-profile'

/** The name of the plugin that groups the flow's skills: the slash-commands are namespaced `/<plugin>:<step>`. */
export const SKILL_PLUGIN = 'closeyourit-skills'

/** The flow steps, IN THE ORDER run for every ticket. */
export const FLOW_STEPS = ['triage', 'plan', 'autopilot', 'closer-staging', 'closer-production'] as const
export type FlowStep = (typeof FLOW_STEPS)[number]

// The ticket code ends up in the skill's `-p` prompt (controlled data); it matches the schema's `code` regex
// (TicketTarget) and `ClaudeAction.skill.args`, so the composed action passes the downstream validation.
const SAFE_TICKET_CODE = /^[A-Za-z0-9][A-Za-z0-9_-]*$/

/** true if `value` is a known flow step (input defence: the phase comes from the server). */
export function isFlowStep(value: unknown): value is FlowStep {
  return typeof value === 'string' && (FLOW_STEPS as readonly string[]).includes(value)
}

/** The skill's slash-command for a step: `/closeyourit-skills:<step>`. */
export function skillCommandForStep(step: FlowStep): string {
  return `/${SKILL_PLUGIN}:${step}`
}

/** The next step in the flow, or null if `step` is the last one (`closer-production`). */
export function nextStep(step: FlowStep): FlowStep | null {
  const i = FLOW_STEPS.indexOf(step)
  return i >= 0 && i < FLOW_STEPS.length - 1 ? FLOW_STEPS[i + 1] : null
}

// Maps the claim's AUTHORITATIVE `execution_phase` (vocabulary A, one of the 5 `ExecutionPhase`) to the flow
// step (vocabulary C). Host-first (CYAU-87, Option A): the candidate now carries the signed `execution_phase`
// (aligned with the lease), so it is keyed directly on it — NO longer on vocabulary B `*_queued` of
// `workflow.phase` (which for planner-ready is `planning`/`review_blocked`, not mappable). All 5 phases
// are mapped: the host claims and runs every phase in sequence.
const PHASE_TO_STEP: Record<ExecutionPhase, FlowStep> = {
  triage: 'triage',
  planner: 'plan',
  autopilot: 'autopilot',
  closer_staging: 'closer-staging',
  closer_production: 'closer-production',
}

/**
 * Derives the flow step from the claim's `execution_phase` (server input, untrusted). Fail-closed: an
 * unknown/missing/vocabulary B (`*_queued`) phase → null (the caller does a fail-closed stop). `Object.hasOwn` keeps
 * inherited keys (`constructor`/`toString`…) from falsely resolving to a step.
 */
export function phaseToStep(phase: unknown): FlowStep | null {
  return typeof phase === 'string' && Object.hasOwn(PHASE_TO_STEP, phase)
    ? PHASE_TO_STEP[phase as ExecutionPhase]
    : null
}

/** Skill invocation descriptor: matches the schema's `ClaudeAction.skill` (C.2). */
export interface SkillInvocation {
  command: string
  args?: string
  plugin_dir: string
}

/**
 * Composes the skill invocation for a step on a ticket: `/closeyourit-skills:<step>` with the ticket CODE as
 * argument. The code is controlled data (it ends up in the `-p` prompt), validated fail-closed with the same regex
 * as the schema; the ticket CONTENT stays untrusted and the skill reads it via `cyi`, it is not passed here.
 * `pluginDir` is the clone of the pinned bundle (provided by C.1).
 */
export function composeSkillInvocation(step: FlowStep, ticketCode: string, pluginDir: string): SkillInvocation {
  if (!isFlowStep(step)) throw new Error(`step di flusso sconosciuto: "${String(step)}"`)
  if (!SAFE_TICKET_CODE.test(ticketCode)) throw new Error(`codice ticket non sicuro: "${ticketCode}"`)
  if (!pluginDir) throw new Error('plugin_dir mancante')
  return {command: skillCommandForStep(step), args: ticketCode, plugin_dir: pluginDir}
}

// ── C.4: PER-STEP concurrency (bounded pool + slot release on waiting) ────────────────────────────────────────
//
// The scheduler does not invent a new model: it REUSES the two invariants already alive in the lease runtime (limits.ts +
// ticket-preflight.ts + clarification.ts):
//   1. HARD CAP = `limits.max_parallel` (authoritative server-side). As `evaluateLimits` denies the dispatch
//      when `running >= max_parallel`, the pool never admits more than `maxParallel` concurrent steps.
//   2. SLOT RELEASE ON WAITING. A non-blocking step (handoff, e.g. triage → plan) or one in `waiting` (e.g. plan
//      waiting for the CTO) RELEASES the slot and the host takes another ticket instead of standing still — identical to the
//      clarification pattern ("release the slot"). Every step is ONE claim: the slot is taken only WHILE `runStep`
//      runs; when it ends (whatever the disposition) it is freed. What the pool limits is how many steps run
//      AT THE SAME TIME. The flow continuation (next step for `advanced`, resumption for `waiting`) is
//      re-queued by the server: the pool works "one step per claim" and does not chain steps internally.

/**
 * A step's outcome for the scheduler. `advanced` = step concluded, the flow advances to the next step (non-blocking
 * handoff); `waiting` = parked waiting for an external event (CTO/clarification), the slot must be released;
 * `blocked` = human intervention needed; `failed` = error. Vocabulary aligned with `TicketPreflightState`/clarification.
 */
export const STEP_DISPOSITIONS = ['advanced', 'waiting', 'blocked', 'failed'] as const
export type StepDisposition = (typeof STEP_DISPOSITIONS)[number]

/** true if `value` is a known disposition (input defence: the outcome comes from the injected `runStep`). */
export function isStepDisposition(value: unknown): value is StepDisposition {
  return typeof value === 'string' && (STEP_DISPOSITIONS as readonly string[]).includes(value)
}

/** true ONLY if the step advanced the flow (handoff to the next step); the other outcomes stop/park it. */
export function advancesFlow(disposition: StepDisposition): boolean {
  return disposition === 'advanced'
}

/** A claim: the ticket code and the flow step to run NOW (one step per claim). */
export interface FlowClaim {
  ticketCode: string
  step: FlowStep
}

/** The outcome of running a step: produced by the injected `runStep`; the real I/O stays outside the pool. */
export interface StepOutcome {
  disposition: StepDisposition
  /** Diagnostic only: the next step when `advanced` (normally `nextStep(step)`; null = flow concluded). */
  nextStep?: FlowStep | null
  detail?: string
}

/**
 * An entry of the pool trace: the worked claim and its outcome. Generic on the claim type (`TClaim`, default
 * `FlowClaim`): the pool is indifferent to the claim's SHAPE — it takes it from `claimNext` and passes it back to `runStep`
 * intact. The daemon/runner wiring (CYAU-69) uses the due action `{name, action}` as claim, one step per claim.
 */
export interface FlowPoolEntry<TClaim = FlowClaim> {
  claim: TClaim
  outcome: StepOutcome
}

/** Pool dependencies: the hard cap + the two injected I/O functions (claim from the queue, step execution). */
export interface FlowPoolDeps<TClaim = FlowClaim> {
  /** Hard cap of concurrent claims/steps = `limits.max_parallel` (authoritative). The pool never exceeds it. */
  maxParallel: number
  /** Takes the next claim (already filtered/attested upstream); null = nothing else to take NOW → drain and close. */
  claimNext: () => Promise<TClaim | null> | TClaim | null
  /** Runs ONE step for a claim (skill via ClaudeRuntime + deliverAttempt, upstream) and returns its outcome. */
  runStep: (claim: TClaim) => Promise<StepOutcome> | StepOutcome
  /** Observer of the current occupancy (tests/telemetry): invoked at every slot take and release. */
  onOccupancyChange?: (occupied: number) => void
}

/** The summary of one pool pass. */
export interface FlowPoolResult<TClaim = FlowClaim> {
  entries: FlowPoolEntry<TClaim>[]
  /** The maximum of slots taken AT THE SAME TIME observed. DoD: ≤ `maxParallel` (cap never exceeded). */
  maxConcurrent: number
  /** Number of steps run (claims worked). */
  claimed: number
  /** Present if `claimNext` threw: the pool stopped taking new claims (fail-closed) and drained the active ones. */
  claimError?: string
}

/**
 * Maps `limits.max_parallel` (optional in the policy) to the pool's EFFECTIVE cap, FAIL-CLOSED: `undefined` →
 * `fallback` (default 1, i.e. serial — never unlimited); `0` stays `0` (no claim admitted, consistent with a
 * policy that closes all slots). A negative or non-integer value is a corrupt policy → error: a cap is not
 * guessed. The caller (daemon/runner wiring) passes `policy.max_parallel` to this function.
 */
export function resolveFlowConcurrency(maxParallel: number | undefined, fallback = 1): number {
  if (maxParallel === undefined) {
    if (!Number.isInteger(fallback) || fallback < 1) throw new Error(`fallback concorrenza non valido: "${String(fallback)}"`)
    return fallback
  }
  if (!Number.isInteger(maxParallel) || maxParallel < 0) throw new Error(`max_parallel non valido: "${String(maxParallel)}"`)
  return maxParallel
}

/**
 * PURE bounded-pool scheduler for the flow's PER-STEP concurrency. It keeps up to `maxParallel` steps in flight:
 * it fills the free slots with `claimNext`, runs every step with `runStep`, and at the END of every step frees the slot
 * and tries to take a claim again. The occupancy (`occupied`) is incremented SYNCHRONOUSLY on admission — before
 * any later `await` — so there is never over-admission beyond the cap. `claimNext=null` = nothing to
 * take NOW: the pool drains the active steps and closes (the advanced/parked tickets go back into the queue server-side).
 * A `runStep` error becomes a `failed` disposition (fail-closed) and does not kill the pool; a
 * `claimNext` error stops the admission (fail-closed) but lets the steps already in flight finish.
 */
export async function runFlowPool<TClaim = FlowClaim>(deps: FlowPoolDeps<TClaim>): Promise<FlowPoolResult<TClaim>> {
  const cap = deps.maxParallel
  if (!Number.isInteger(cap) || cap < 0) throw new Error(`maxParallel non valido: "${String(cap)}"`)

  const entries: FlowPoolEntry<TClaim>[] = []
  const active = new Set<Promise<void>>()
  let occupied = 0
  let maxConcurrent = 0
  let draining = cap === 0 // cap 0 = all slots closed: no claim admitted.
  let claimError: string | undefined

  const changeOccupancy = (delta: number): void => {
    occupied += delta
    if (occupied > maxConcurrent) maxConcurrent = occupied
    deps.onOccupancyChange?.(occupied)
  }

  const launch = (claim: TClaim): void => {
    // Takes the slot SYNCHRONOUSLY: done before the next `await claimNext`, no other admission can slip in.
    changeOccupancy(1)
    const task = (async () => {
      let outcome: StepOutcome
      try {
        outcome = await deps.runStep(claim)
        if (!isStepDisposition(outcome?.disposition)) {
          outcome = {disposition: 'failed', detail: 'disposition step non riconosciuta (fail-closed)'}
        }
      } catch (error) {
        outcome = {disposition: 'failed', detail: error instanceof Error ? error.message : String(error)}
      }
      entries.push({claim, outcome})
    })()
    const tracked = task.finally(() => {
      changeOccupancy(-1) // releases the slot at the end of the step (whatever the disposition), like the lease on waiting.
      active.delete(tracked)
    })
    active.add(tracked)
  }

  while (!draining || active.size > 0) {
    // Fill the free slots while the queue has claims AND there is capacity under the cap.
    while (!draining && occupied < cap) {
      let claim: TClaim | null
      try {
        claim = await deps.claimNext()
      } catch (error) {
        claimError = error instanceof Error ? error.message : String(error)
        draining = true // fail-closed: no new claims, but let the steps in flight finish.
        break
      }
      if (claim === null) {
        draining = true // queue empty NOW: stop admitting, then drain.
        break
      }
      launch(claim)
    }
    if (active.size === 0) break
    await Promise.race(active) // wait for at least one step to free its slot, then refill.
  }

  return {entries, maxConcurrent, claimed: entries.length, ...(claimError ? {claimError} : {})}
}
