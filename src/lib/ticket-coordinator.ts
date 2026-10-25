import {
  decideClarification,
  readClarificationState,
  type ClarificationDecision,
} from './clarification'
import {
  deriveKbQueries,
  gatherGuidance,
  type GuidanceDeps,
  type GuidancePack,
} from './guidance'
import {
  evaluateLimits,
  failClosedDecision,
  recordUsage,
  type LimitsDecision,
  type LimitsPolicy,
  type LimitsSnapshot,
  type UsageRecord,
  usageDateKey,
} from './limits'
import {
  composeReferenceStopComment,
  composeTicketGuidanceMarkdown,
  consultRequiredReferences,
  defaultReferenceProbe,
  type GuidanceEntry,
  hasReferenceStopComment,
  type ReferenceProbe,
  type TicketGuidance,
} from './ticket-guidance'
import {type ActionPreflightContext, type ActionPreflightFn} from './runner'
import {type Action} from './schema'

// Coordination of a ticket's preflight (CYAU-34). This is the only point that composes the existing gates
// before the runner starts the runtime: Guidance → clarifications → limits. Every stop
// is fail-closed and carries phase, state and reason; the coordinator neither acquires leases nor starts the runtime.

export type TicketPreflightPhase = 'guidance' | 'clarification' | 'limits'
export type TicketPreflightState = 'ready' | 'waiting' | 'blocked'
export type TicketPreflightAuditState = 'passed' | 'stopped' | 'failed'

export interface TicketPreflightAuditEntry {
  phase: TicketPreflightPhase
  state: TicketPreflightAuditState
  reason: string
}

/** A ticket comment, as it arrives from `cyi tickets comments --json` (untrusted input: optional id/body). */
export interface TicketComment {
  id?: string | null
  body?: string | null
}

/** Full detail the daemon must know before starting the ticket's run. */
/**
 * A ticket's content, as it arrives from the server. It lived in `classify.ts` because it was the input
 * of the local classification; since CYAU-71 that is gone, and the content stays where it is used.
 */
export interface TicketContent {
  code?: string
  title?: string
  description?: string
  technicalAnalysis?: string
  kind?: string
  labels?: string[]
}

/** A finding of the review that rejected the previous attempt of the same phase (CYAU-237). */
export interface PreviousReviewFinding {
  id: number
  severity: string
  title: string
  detail: string
}

export interface TicketDetail extends TicketContent {
  project: string
  code: string
  /** Trusted base branch from the sync queue; missing on legacy servers/CLIs. */
  defaultBranch?: string
  cwd: string
  comments: TicketComment[]
  status?: string
  /** Canonical status code (`open`/`in_progress`/`resolved`…), distinct from the label shown to the user. */
  statusCode?: string
  /**
   * Status category decided by the server (`open`/`in_progress`/`done`…). It is the only reliable signal to
   * know whether the work is already concluded: a ticket resolved by hand does NOT carry a closing date (CYAU-155).
   */
  statusCategory?: string
  priority?: string
  milestone?: string
  platforms?: string[]
  closedAt?: string
  weight?: number
  dueAt?: string
  createdAt?: string
  updatedAt?: string
  assignee?: string
  reporter?: string
  reviewer?: string
  /** Previous plan and CTO feedback coming from the queue's server-side snapshot. */
  automationContext?: string
  /**
   * The plan APPROVED by the CTO, already rendered in markdown. Unlike `automationContext` it is NOT ticket
   * material: it is the document the organization decided to have implemented, produced by the planner
   * phase and approved by a person. It therefore travels in the TRUSTED part of the prompt — inside the untrusted
   * block the agent could not take it as its own spec, and the autopilot skill, which requires an approved
   * spec, stopped on every ticket.
   */
  approvedPlan?: string
  /** CYAU-240 — clarification questions already answered: decisions taken on the ticket, oldest first. */
  answeredQuestions?: Array<{question: string; answer: string}>
  /**
   * CYAU-236 — what the review of the previous attempt asked to fix, already rendered as untrusted data with
   * the authoritative order around it. Without it a retry found its own open PR and declared the work done.
   */
  reworkFindings?: string
  /** CYAU-237 — the same findings, structured and numbered, for the reviewer of the new attempt. */
  previousReviewFindings?: PreviousReviewFinding[]
  /**
   * Structured guidance resolved SERVER-side and attached to the ticket (CYAU-1): references/procedures/rules already
   * resolved by hierarchy. Missing on legacy servers (backward compat: no behaviour change).
   */
  guidance?: TicketGuidance
  scenarios?: Array<{
    title?: string
    given?: string
    when?: string
    then?: string
    expected?: string
  }>
  conditions?: string[]
}

export interface TicketLimitsInput {
    policy: LimitsPolicy | null
    snapshot: LimitsSnapshot
    estimatedCost?: number
}

export interface TicketPreflightInput {
  ticket: TicketDetail
  /** true when the analysis found an indispensable functional decision still missing. */
  needsDecision: boolean
  requireGuidance?: boolean
  guidanceQueries?: string[]
  /** `policy: null` means not attestable: the coordinator blocks fail-closed. */
  limits: TicketLimitsInput | (() => Promise<TicketLimitsInput> | TicketLimitsInput)
}

export interface TicketPreflightResult {
  outcome: 'admit' | 'stop'
  state: TicketPreflightState
  reason: string
  audit: TicketPreflightAuditEntry[]
  guidance: GuidancePack | null
  clarification: ClarificationDecision | null
  limits: LimitsDecision | null
  reservation: UsageRecord | null
  ticket: TicketDetail | null
}

export interface LimitsReservation {
  decision: LimitsDecision
  usage: UsageRecord | null
}

export type PublishClarificationFn = (ticket: TicketDetail, body: string) => Promise<boolean>
export type ReserveLimitsFn = (
  policy: LimitsPolicy,
  snapshot: LimitsSnapshot,
  estimatedCost: number,
) => Promise<LimitsReservation>

/** Explicit dependencies: the defaults are the real call sites; the substitutions serve only the ordering tests. */
export interface TicketCoordinatorDeps {
  guidance: GuidanceDeps
  gatherGuidance?: typeof gatherGuidance
  /**
   * Where the clarification cycle state comes from. The default reads nothing and declares the state
   * unreadable: this module is pure, and whoever uses it in production passes the reader that asks the SYSTEM
   * (`ticket-preflight`). Fail-closed on purpose — a coordinator built without a reader must make the
   * ticket wait, not admit it because it did not look (CYRA-628, CYAU-189).
   */
  readClarificationState?: typeof readClarificationState
  decideClarification?: typeof decideClarification
  evaluateLimits?: typeof evaluateLimits
  failClosedDecision?: typeof failClosedDecision
  /** Consultation of the required references (CYAU-1); default: real read-only `cyi kb` probe. */
  referenceProbe?: ReferenceProbe
  /** Posts a comment on the ticket (CYAU-1): used to report a required reference that cannot be consulted. */
  publishComment?: PublishClarificationFn
  reserveLimits?: ReserveLimitsFn
}

type Artifacts = Pick<
  TicketPreflightResult,
  'guidance' | 'clarification' | 'limits' | 'reservation' | 'ticket'
>

const EMPTY_ARTIFACTS: Artifacts = {
  guidance: null,
  clarification: null,
  limits: null,
  reservation: null,
  ticket: null,
}

class ReservationDeniedError extends Error {
  constructor(readonly decision: LimitsDecision) {
    super(decision.reason)
  }
}

/**
 * Atomically evaluates and books a new run in the usage store. The decision is recomputed INSIDE the lock
 * on the current counters, so two concurrent daemons cannot both admit themselves on the same last budget slot.
 */
export async function reserveDispatchLimits(
  policy: LimitsPolicy,
  snapshot: LimitsSnapshot,
  estimatedCost = 0,
  options: {usageDir?: string; clock?: () => Date} = {},
): Promise<LimitsReservation> {
  const initial = evaluateLimits(policy, snapshot, 'dispatch')
  if (initial.outcome !== 'admit') return {decision: initial, usage: null}

  const clock = options.clock ?? (() => new Date())
  const date = usageDateKey(snapshot.now)
  try {
    const usage = await recordUsage(date, {runs: 1, cost: estimatedCost}, options.usageDir, {
      beforeCommit(current) {
        const now = clock()
        if (usageDateKey(now) !== date) {
          throw new Error('giorno UTC cambiato durante la prenotazione usage')
        }
        const locked = evaluateLimits(policy, {
          ...snapshot,
          runs_today: current.runs,
          cost_today: current.cost,
          budget_readable: true,
          pending_runs: 1,
          pending_cost: estimatedCost,
          now,
        }, 'dispatch')
        if (locked.outcome !== 'admit') throw new ReservationDeniedError(locked)
      },
    })
    return {decision: initial, usage}
  } catch (error) {
    if (error instanceof ReservationDeniedError) return {decision: error.decision, usage: null}
    return {
      decision: {
        outcome: 'deny',
        mode: 'dispatch',
        limit: 'usage-unavailable',
        reason: 'prenotazione del budget non attestabile (fail-closed): nessuna nuova run',
        scope: policy.scope ?? null,
      },
      usage: null,
    }
  }
}

function stopped(
  state: Exclude<TicketPreflightState, 'ready'>,
  reason: string,
  audit: TicketPreflightAuditEntry[],
  artifacts: Artifacts,
): TicketPreflightResult {
  return {outcome: 'stop', state, reason, audit, ...artifacts}
}

/** The label of a guidance entry for the audit: its key, or a placeholder if missing. */
function entryLabel(entry: GuidanceEntry): string {
  return typeof entry.key === 'string' && entry.key.trim() !== '' ? entry.key : '(senza chiave)'
}

/**
 * Summary of the structured guidance for the guidance phase audit (CYAU-1). Lists the received PROCEDURES
 * (Scenario 1 "the log shows the received procedures") and counts references/rules. Empty if there is no guidance.
 */
function ticketGuidanceSummary(guidance?: TicketGuidance): string {
  if (!guidance) return ''
  const parts: string[] = []
  if (guidance.procedures.length > 0) parts.push(`procedure ricevute: ${guidance.procedures.map(entryLabel).join(', ')}`)
  if (guidance.references.length > 0) parts.push(`${guidance.references.length} reference`)
  if (guidance.rules.length > 0) parts.push(`${guidance.rules.length} regole`)
  return parts.length > 0 ? `; ${parts.join('; ')}` : ''
}

export class TicketCoordinator {
  readonly #deps: Required<Omit<TicketCoordinatorDeps, 'guidance' | 'publishComment'>>
    & Pick<TicketCoordinatorDeps, 'guidance' | 'publishComment'>

  constructor(deps: TicketCoordinatorDeps) {
    this.#deps = {
      guidance: deps.guidance,
      gatherGuidance: deps.gatherGuidance ?? gatherGuidance,
      readClarificationState: deps.readClarificationState ??
        (() => ({state: 'unreadable', cycles: 0, hasReply: false, source: 'unreadable'})),
      decideClarification: deps.decideClarification ?? decideClarification,
      evaluateLimits: deps.evaluateLimits ?? evaluateLimits,
      failClosedDecision: deps.failClosedDecision ?? failClosedDecision,
      referenceProbe: deps.referenceProbe ?? defaultReferenceProbe(),
      publishComment: deps.publishComment,
      reserveLimits: deps.reserveLimits ?? reserveDispatchLimits,
    }
  }

  async preflight(input: TicketPreflightInput): Promise<TicketPreflightResult> {
    const audit: TicketPreflightAuditEntry[] = []
    const artifacts: Artifacts = {...EMPTY_ARTIFACTS}
    let phase: TicketPreflightPhase = 'guidance'

    try {
      const {ticket} = input
      artifacts.ticket = ticket
      artifacts.guidance = this.#deps.gatherGuidance(
        {
          project: ticket.project,
          code: ticket.code,
          cwd: ticket.cwd,
          queries: [...deriveKbQueries(ticket), ...(input.guidanceQueries ?? [])],
        },
        this.#deps.guidance,
      )
      if ((input.requireGuidance ?? true) && artifacts.guidance.sources.length === 0) {
        const reason = 'Guidance richiesta ma non disponibile: ticket non lavorabile (fail-closed)'
        audit.push({phase, state: 'failed', reason})
        return stopped('blocked', reason, audit, artifacts)
      }
      // CYAU-1: consumes the structured guidance resolved by the backend (references/procedures/rules) BEFORE the
      // clarity check and the claim. The REQUIRED references are verified here: if one cannot be consulted it
      // stops cleanly (comment + stop), without claim (DoD "inaccessible required produces a clean stop"). The
      // procedures/rules are added to the context as verbatim data, without special per-key logic
      // (Scenario 3), and the received procedures are recorded in the audit (Scenario 1 "the log shows the procedures").
      if (ticket.guidance) {
        const references = consultRequiredReferences(ticket.guidance, ticket.project, this.#deps.referenceProbe)
        if (references.inaccessible.length > 0) {
          // Posts the block comment ONLY ONCE (idempotency via marker): a ticket re-evaluated at every
          // preflight does not receive the same comment in a loop. The publication outcome is recorded in the audit —
          // a stop without a successful comment stays visible, not silently ignored.
          let commentNote = ''
          if (!hasReferenceStopComment(ticket.comments)) {
            const published = this.#deps.publishComment
              ? await this.#deps
                  .publishComment(ticket, composeReferenceStopComment(references.inaccessible))
                  .catch(() => false)
              : false
            if (!published) commentNote = '; commento di blocco non pubblicato'
          }
          const reason = `reference obbligatorie non consultabili prima del claim: ${references.inaccessible.map((entry) => entry.key).join(', ')}${commentNote}`
          audit.push({phase, state: 'stopped', reason})
          return stopped('blocked', reason, audit, artifacts)
        }
        // Guidance + CONTENT of the consulted required references in the uniform package (prompt-mode). In
        // skill-mode (host-first queue) the action is composed from the PhaseProfile and the skill reads the ticket via `cyi`:
        // the package stays the auditable artefact, but the channel to the agent is that one (by host-first design).
        artifacts.guidance = {
          ...artifacts.guidance,
          markdown: `${artifacts.guidance.markdown}\n\n${composeTicketGuidanceMarkdown(ticket.guidance, references.consulted)}`,
        }
      }
      audit.push({
        phase,
        state: 'passed',
        reason: `Guidance raccolta da ${artifacts.guidance.sources.length} fonti${ticketGuidanceSummary(ticket.guidance)}`,
      })

      // CYAU-71 — here there used to be the ticket classification and the split plan, and below them the automatic
      // choice between the two engines. Since CYRA-184 they no longer decided anything: the admission is given by the
      // server. The twelve waves finished the job — phase, engine and constraint arrive signed with
      // the assignment — and the server publishes its own assessment on `agent_eligibility`, with the
      // written reason. What remained was a computation nobody read: neither the skill channel nor the legacy
      // prompt put it into the action.

      phase = 'clarification'
      // CYRA-628 — the state is asked of the SYSTEM, the only one that really knows it: reading it from the
      // comments meant guessing it, and a line written by the system itself was enough to
      // restart a ticket nobody had answered.
      const clarificationStatus = this.#deps.readClarificationState(ticket.code, ticket.project)
      artifacts.clarification = this.#deps.decideClarification({
        status: clarificationStatus,
        // The clarification contract considers a later answer as resolving: do not reopen right away
        // the same question just because the scheduled target keeps needs_decision=true.
        needsDecision: input.needsDecision && !clarificationStatus.hasReply,
      })
      if (!artifacts.clarification.workable) {
        // The SERVER publishes the questions (CYRA-221): they are born from triage and live in their record, with the
        // service line and the marker written by `Agents::Clarifications::Ask` in the same transaction as the
        // delivery. Here the state is read and we stop — composing a second comment on this side meant
        // a long body the comment cap (CYRA-222) rejects, and questions without a record to live in.
        const reason = artifacts.clarification.reasons.join('; ')
        const state: Exclude<TicketPreflightState, 'ready'> = artifacts.clarification.requiresHuman
          ? 'blocked'
          : 'waiting'
        audit.push({phase, state: 'stopped', reason})
        return stopped(state, reason, audit, artifacts)
      }
      audit.push({
        phase,
        state: 'passed',
        reason: artifacts.clarification.reasons.join('; '),
      })

      phase = 'limits'
      // The remote/local loading of policy and usage really belongs to the limits phase: tickets stopped by
      // Guidance or clarifications do no early I/O nor mask the correct reason.
      const limits = typeof input.limits === 'function' ? await input.limits() : input.limits
      artifacts.limits = limits.policy === null
        ? this.#deps.failClosedDecision('dispatch')
        : this.#deps.evaluateLimits(limits.policy, limits.snapshot, 'dispatch')
      if (artifacts.limits.outcome === 'admit' && limits.policy !== null) {
        const reservation = await this.#deps.reserveLimits(
          limits.policy,
          limits.snapshot,
          limits.estimatedCost ?? 0,
        )
        artifacts.limits = reservation.decision
        artifacts.reservation = reservation.usage
      }
      if (artifacts.limits.outcome !== 'admit') {
        const reason = artifacts.limits.reason
        const technical = artifacts.limits.limit === 'policy-unavailable' || artifacts.limits.limit === 'usage-unavailable'
        audit.push({phase, state: technical ? 'failed' : 'stopped', reason})
        return stopped('blocked', reason, audit, artifacts)
      }
      audit.push({phase, state: 'passed', reason: artifacts.limits.reason})

      return {
        outcome: 'admit',
        state: 'ready',
        reason: 'preflight completato: ticket lavorabile',
        audit,
        ...artifacts,
      }
    } catch {
      const reason = `preflight ${phase} non completabile (fail-closed)`
      audit.push({phase, state: 'failed', reason})
      return stopped('blocked', reason, audit, artifacts)
    }
  }

  /**
   * Adapts the coordinator to the runner gate. An action without ticket detail is blocked: when the preflight
   * is configured, the absence of the context cannot turn into a silent bypass.
   */
  actionPreflight(
    resolve: (
      name: string,
      action: Action,
      context: ActionPreflightContext,
    ) => Promise<TicketPreflightInput | null | undefined> | TicketPreflightInput | null | undefined,
  ): ActionPreflightFn {
    return async (name, action, context) => {
      let input: TicketPreflightInput | null | undefined
      try {
        input = await resolve(name, action, context)
      } catch {
        const reason = 'contesto ticket non autorizzabile (fail-closed)'
        return {
          outcome: 'stop',
          state: 'blocked',
          reason,
          audit: [{phase: 'guidance', state: 'failed', reason}],
        }
      }
      // undefined = generic scheduler action, explicitly not ticket-scoped: no ticket gate to apply.
      if (input === undefined) return {outcome: 'admit', state: 'ready', reason: 'azione non ticket', audit: []}
      if (input === null) {
        return {
          outcome: 'stop',
          state: 'blocked',
          reason: 'dettaglio ticket non disponibile (fail-closed)',
          audit: [{phase: 'guidance', state: 'failed', reason: 'dettaglio ticket non disponibile (fail-closed)'}],
        }
      }

      return this.preflight(input)
    }
  }
}
