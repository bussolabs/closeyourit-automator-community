import {z} from 'zod'
import {isReviewVerdict, type ReviewFinding, ReviewVerdictLabelSchema, type ReviewVerdictLabel} from './review'
import {type RunPhase} from './state-machine'
import {type RunRecord} from './state'
import {AutomatorError, ErrorCodes} from '../errors/error-codes'

// Implementation and review limit of two cycles (CYAU-21). A ticket must not consume resources forever
// when implementer (CYAU-18) and reviewer (CYAU-20) do not converge: after TWO unapproved cycles the ticket
// requires human intervention. PURE and DETERMINISTIC module (no I/O, no randomness): same counters +
// same verdict → same decision, so the gate is repeatable and auditable.
//
// Two pure pieces (the I/O — reading the history, posting the comment — belongs to the `cycle` command/orchestrator):
//  1. the COUNTERS — `countCycles` derives `attempts` (implementation attempts) and `reviewCycles` (review
//     cycles) from the checkpoint history. Persistence is NOT a separate counter to maintain: it is the
//     `runs/<run-id>.json` history (CYAU-12), which lives on disk and survives restarts → the counters do NOT reset
//     (Technical analysis: "do not reset the counters on restart") and cannot diverge from a second store.
//  2. the GATE — `evaluateCycle` decides the next phase from the current review verdict and the number of
//     cycles: approved → forward (in_review); changes under the budget → another round (implementing); changes
//     at the limit → human intervention (blocked); a blocker finding → human intervention always.
//
// The summary of the unresolved findings (`summarizeCycle`) is the text the orchestrator comments on CloseYourIt
// (DoD: "unresolved findings are kept in the ticket").

/** The default budget: TWO automatic cycles (CYAU-21). Beyond that, human intervention is needed. */
export const DEFAULT_CYCLE_LIMIT = 2

/** A run's counters, derived from the checkpoint history (persisted, they do not reset on restart). */
export interface CycleCounts {
  /** How many times `implementing` was (re)entered (implementation attempts). */
  attempts: number
  /** How many reviews were started (`reviewing` checkpoints): the review cycles. */
  reviewCycles: number
}

/**
 * Counts attempts and cycles from the checkpoint history. Pure: the history is the RunRecord's `checkpoints` field,
 * which the command reads from `runs/<run-id>.json`. Counting `implementing`/`reviewing` instead of keeping a separate
 * counter is single-source-of-truth: on restart the same history is re-read and the same values re-derived.
 */
export function countCycles(run: RunRecord | null): CycleCounts {
  let attempts = 0
  let reviewCycles = 0
  for (const checkpoint of run?.checkpoints ?? []) {
    if (checkpoint.phase === 'implementing') attempts++
    else if (checkpoint.phase === 'reviewing') reviewCycles++
  }

  return {attempts, reviewCycles}
}

/** The phases the gate can route the run to (subset of `RunPhase`), all legal from `reviewing`. */
const CYCLE_NEXT_PHASES = ['in_review', 'implementing', 'blocked'] as const
const CycleNextPhaseSchema = z.enum(CYCLE_NEXT_PHASES)

/** The cycle gate decision (auditable zod schema). `.strict()`: stable contract. */
export const CycleDecisionSchema = z
  .object({
    verdict: ReviewVerdictLabelSchema,
    /** The current review cycle number (1-based). */
    cycle: z.number().int().nonnegative(),
    /** The budget of automatic cycles. */
    limit: z.number().int().positive(),
    /** true if the budget is exhausted (changes requested at the limit): the reason for human intervention. */
    limitReached: z.boolean(),
    /** true if the run can NOT continue automatically (budget exhausted or blocker finding). */
    requiresHuman: z.boolean(),
    /** The next phase (CYAU-16 state machine): in_review / implementing / blocked. */
    next: CycleNextPhaseSchema,
    reasons: z.array(z.string()),
  })
  .strict()
export type CycleDecision = z.infer<typeof CycleDecisionSchema>

/** The gate input: the current review verdict, the current cycle and (optionally) the budget. */
export interface CycleInput {
  verdict: ReviewVerdictLabel
  /** The current review cycle number (1-based): the command derives it from `countCycles(run).reviewCycles`. */
  cycle: number
  /** The budget of automatic cycles (default `DEFAULT_CYCLE_LIMIT`). */
  limit?: number
}

/**
 * Decides the next phase from the current review verdict and the number of cycles. Pure and deterministic.
 * - `approved` → `in_review`: no blocking finding, the run advances to human review;
 * - `blocked` → `blocked`: a blocker finding ALWAYS requires human intervention (regardless of the budget);
 * - `changes_requested` under the budget (`cycle < limit`) → `implementing`: another round is granted;
 * - `changes_requested` at the budget (`cycle >= limit`) → `blocked`: the workflow does NOT exceed the limit (DoD) → human.
 * The final `.parse()` guarantees the auditable schema.
 */
export function evaluateCycle(input: CycleInput): CycleDecision {
  if (!isReviewVerdict(input.verdict)) {
    throw invalidInput(`Verdetto non riconosciuto: "${String(input.verdict)}" (attesi: approved, changes_requested, blocked)`)
  }

  if (!Number.isInteger(input.cycle) || input.cycle < 0) {
    throw invalidInput(`Ciclo non valido: "${String(input.cycle)}" (atteso un intero ≥ 0)`)
  }

  const limit = input.limit ?? DEFAULT_CYCLE_LIMIT
  if (!Number.isInteger(limit) || limit < 1) {
    throw invalidInput(`Limite non valido: "${String(limit)}" (atteso un intero ≥ 1)`)
  }

  const {verdict, cycle} = input
  let next: RunPhase
  let requiresHuman: boolean
  let limitReached = false
  let reasons: string[]

  switch (verdict) {
    case 'approved': {
      next = 'in_review'
      requiresHuman = false
      reasons = [`Review approvata al ciclo ${cycle}/${limit}: la lavorazione avanza alla review umana (in_review)`]
      break
    }

    case 'blocked': {
      // A blocker finding (CYAU-20) stops the run regardless of the budget: human intervention is needed right away.
      next = 'blocked'
      requiresHuman = true
      reasons = [`Rilievo blocker al ciclo ${cycle}: il ticket richiede intervento umano (a prescindere dal budget di ${limit} cicli)`]
      break
    }

    case 'changes_requested': {
      limitReached = cycle >= limit
      if (limitReached) {
        next = 'blocked'
        requiresHuman = true
        reasons = [
          `Raggiunto il limite di ${limit} cicli automatici senza approvazione (ciclo ${cycle}): il ticket richiede intervento umano — il workflow non supera ${limit} cicli`,
        ]
      } else {
        next = 'implementing'
        requiresHuman = false
        reasons = [
          `Review chiede modifiche al ciclo ${cycle}/${limit}: si torna a implementare (restano ${limit - cycle} cicli automatici)`,
        ]
      }

      break
    }
  }

  return CycleDecisionSchema.parse({verdict, cycle, limit, limitReached, requiresHuman, next, reasons})
}

/** The run summary to keep in the ticket (DoD: "unresolved findings are kept"). */
export interface CycleSummary {
  ticket: string | null
  verdict: ReviewVerdictLabel
  cycle: number
  limit: number
  attempts: number
  limitReached: boolean
  requiresHuman: boolean
  /** The unresolved findings of the last review, kept for the audit and the ticket comment. */
  outstandingFindings: ReviewFinding[]
  /** The text of the comment to post on CloseYourIt (auditable, lists the unresolved findings). */
  text: string
}

export interface CycleSummaryOptions {
  ticket?: string | null
  /** The implementation attempts (from `countCycles`): part of the summary (Technical analysis: "attempt"). */
  attempts?: number
  /** The findings of the last review, to keep in the ticket. */
  findings?: ReviewFinding[]
}

/**
 * Composes the decision summary: the outcome, the cycles/attempts and the unresolved findings. The `text` is what
 * the orchestrator posts as a comment on CloseYourIt — it is the channel through which "unresolved findings are kept
 * in the ticket" (DoD). Pure: posts nothing, returns text and structure.
 */
export function summarizeCycle(decision: CycleDecision, opts: CycleSummaryOptions = {}): CycleSummary {
  const ticket = opts.ticket ?? null
  const attempts = opts.attempts ?? 0
  const findings = opts.findings ?? []

  return {
    ticket,
    verdict: decision.verdict,
    cycle: decision.cycle,
    limit: decision.limit,
    attempts,
    limitReached: decision.limitReached,
    requiresHuman: decision.requiresHuman,
    outstandingFindings: findings,
    text: composeSummaryText(decision, ticket, attempts, findings),
  }
}

/** The summary header by outcome (readable reason for the block or the advance). */
function summaryHeadline(decision: CycleDecision): string {
  if (decision.limitReached) {
    return `Revisione automatica fermata: raggiunto il limite di ${decision.limit} cicli senza approvazione. Il ticket richiede intervento umano.`
  }

  if (decision.requiresHuman) {
    return `Revisione automatica fermata al ciclo ${decision.cycle}: un rilievo blocker richiede intervento umano.`
  }

  if (decision.verdict === 'approved') {
    return `Revisione automatica approvata al ciclo ${decision.cycle}/${decision.limit}: la lavorazione avanza alla review umana.`
  }

  return `Revisione automatica al ciclo ${decision.cycle}/${decision.limit}: modifiche richieste, si torna a implementare.`
}

/** The comment text: header + attempts + list of the unresolved findings (if any). */
function composeSummaryText(decision: CycleDecision, ticket: string | null, attempts: number, findings: ReviewFinding[]): string {
  const prefix = ticket ? `[${ticket}] ` : ''
  const lines = [`${prefix}${summaryHeadline(decision)}`, `Tentativi di implementazione: ${attempts} · cicli di review: ${decision.cycle}/${decision.limit}.`]
  if (findings.length > 0) {
    lines.push(`Rilievi irrisolti (${findings.length}):`)
    for (const f of findings) lines.push(`- [${f.severity}${f.aspect ? `/${f.aspect}` : ''}] ${f.title}`)
  }

  return lines.join('\n')
}

function invalidInput(message: string): AutomatorError {
  return new AutomatorError(ErrorCodes.Cycle.invalidInput, message, 2)
}
