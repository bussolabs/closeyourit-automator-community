import {z} from 'zod'
import {isReviewerId, isRuntimeId, REVIEWER_IDS, RUNTIME_IDS, type ReviewerId, type RuntimeAvailability, type RuntimeId} from './route'
import {type RunPhase} from './state-machine'
import {strictObjectContract} from './structured-schema'
import {AutomatorError, ErrorCodes} from '../errors/error-codes'

// Claude ↔ Codex cross review (CYAU-20). Every implementation must be reviewable by the OTHER
// agent before the human review. This module is PURE and DETERMINISTIC (no I/O, no randomness): same
// implementer + findings pair → same verdict, so the review is repeatable, verifiable and auditable.
//
// The module separates the selection from the concrete execution (in `review-execution.ts`) and defines the two pure ends —
//  1. WHO reviews — `selectReviewer` picks the runtime different from the implementer (DoD: "the reviewer is different
//     from the implementer"). With only two runtimes the reviewer is uniquely the other one; if the other is unavailable the
//     cross review is IMPOSSIBLE (never fall back to the implementer itself → it would violate the DoD).
//  2. WHAT the outcome is worth — `decideVerdict` structures the verdict (approved / changes_requested / blocked) from
//     the reviewer's FINDINGS, split into blocking (blocker/major) and non-blocking (minor/info).
//
// The verdict is read-only by contract (the reviewer evaluates requirements, diff, tests and risks WITHOUT modifying the
// code — Scenario 1) and hooks into the state machine (CYAU-16): `reviewVerdictToPhase` maps the outcome onto the
// next phase (approved → in_review, changes_requested → implementing, blocked → blocked), all transitions
// legal from `reviewing`.

/**
 * Severity of a review finding. `blocker` and `major` are BLOCKING (they prevent approval); `minor` and
 * `info` are not. The blocker/major distinction refines the verdict: `blocker` requires intervention (→ blocked),
 * `major` is fixable by the implementer (→ changes_requested).
 */
export const REVIEW_SEVERITIES = ['blocker', 'major', 'minor', 'info'] as const
export const ReviewSeveritySchema = z.enum(REVIEW_SEVERITIES)
export type ReviewSeverity = z.infer<typeof ReviewSeveritySchema>

/** The severities that BLOCK approval ("blocking" findings, technical analysis). */
const BLOCKING_SEVERITIES: ReadonlySet<ReviewSeverity> = new Set<ReviewSeverity>(['blocker', 'major'])

/** The aspects the reviewer evaluates without modifying the code (Scenario 1: requirements, diff, tests, risks). */
export const REVIEW_ASPECTS = ['requirements', 'diff', 'tests', 'risks'] as const
export const ReviewAspectSchema = z.enum(REVIEW_ASPECTS)
export type ReviewAspect = z.infer<typeof ReviewAspectSchema>

/** The structured review outcome (DoD: "structured and auditable verdict"). */
export const REVIEW_VERDICTS = ['approved', 'changes_requested', 'blocked'] as const
export const ReviewVerdictLabelSchema = z.enum(REVIEW_VERDICTS)
export type ReviewVerdictLabel = z.infer<typeof ReviewVerdictLabelSchema>

/** The runtimes as a schema (aligned with `RuntimeId`/`RUNTIME_IDS` of route.ts): used to validate the auditable verdict. */
const RuntimeSchema = z.enum(['claude', 'codex'])
/** CYAU-228 — whoever reviewed: a runtime, or OpenCode, which only reviews. */
const ReviewerSchema = z.enum(['claude', 'codex', 'opencode'])

/**
 * A NORMALIZED review finding: missing `aspect` and `detail` become `null` (never `undefined`). It is
 * the reviewer's observation on an aspect — it describes, it does not modify (read-only). `.strict()`: no extra field.
 */
const reviewFindingContract = strictObjectContract({
  severity: {
    schema: ReviewSeveritySchema,
    jsonSchema: {type: 'string', enum: REVIEW_SEVERITIES},
  },
  aspect: {
    schema: ReviewAspectSchema.nullable(),
    jsonSchema: {anyOf: [{type: 'string', enum: REVIEW_ASPECTS}, {type: 'null'}]},
  },
  title: {
    schema: z.string().min(1),
    jsonSchema: {type: 'string', minLength: 1},
  },
  detail: {
    schema: z.string().nullable(),
    jsonSchema: {anyOf: [{type: 'string'}, {type: 'null'}]},
  },
})
export const ReviewFindingSchema = reviewFindingContract.schema
export const REVIEW_FINDING_JSON_SCHEMA = reviewFindingContract.jsonSchema
export type ReviewFinding = z.infer<typeof ReviewFindingSchema>

/** RAW shape of a finding as it arrives from the reviewer (untrusted input): optional aspect/detail. */
export const ReviewFindingInputSchema = z
  .object({
    severity: ReviewSeveritySchema,
    aspect: ReviewAspectSchema.optional(),
    title: z.string().min(1),
    detail: z.string().optional(),
  })
  .strict()

/** Structured, auditable verdict of the cross review. `.strict()`: stable contract. */
export const ReviewVerdictSchema = z
  .object({
    verdict: ReviewVerdictLabelSchema,
    implementer: RuntimeSchema,
    reviewer: ReviewerSchema.nullable(),
    /** true if a DIFFERENT reviewer evaluated (DoD): false if the cross review was not possible. */
    crossReviewed: z.boolean(),
    /** The reviewer does not modify the code (Scenario 1): always true, part of the contract. */
    readOnly: z.literal(true),
    findings: z.array(ReviewFindingSchema),
    /** Number of blocking findings (blocker + major). */
    blockingCount: z.number().int().nonnegative(),
    /** Number of non-blocking findings (minor + info). */
    advisoryCount: z.number().int().nonnegative(),
    reasons: z.array(z.string()),
  })
  .strict()
export type ReviewVerdict = z.infer<typeof ReviewVerdictSchema>

/** true if `value` is a known severity (input defence: untrusted reviewer/CLI input). */
export function isReviewSeverity(value: unknown): value is ReviewSeverity {
  return typeof value === 'string' && (REVIEW_SEVERITIES as readonly string[]).includes(value)
}

/** true if `severity` BLOCKS approval (blocker or major): the public "blocking vs non-blocking" rule. */
export function isBlockingSeverity(severity: ReviewSeverity): boolean {
  return BLOCKING_SEVERITIES.has(severity)
}

/** true if `value` is a known verdict. */
export function isReviewVerdict(value: unknown): value is ReviewVerdictLabel {
  return typeof value === 'string' && (REVIEW_VERDICTS as readonly string[]).includes(value)
}

/**
 * CYRA-921 — who reviews, decided per machine on the server and delivered with the lease: `cross` (the other
 * engine, the default) or `same` (the same engine in a new session, for a machine with one engine).
 */
export const REVIEW_MODES = ['cross', 'same'] as const
export type ReviewMode = (typeof REVIEW_MODES)[number]

export function isReviewMode(value: unknown): value is ReviewMode {
  return typeof value === 'string' && (REVIEW_MODES as readonly string[]).includes(value)
}

/** Human correction of the selection: forces the reviewer (it must still be different from the implementer — DoD). */
export interface ReviewOverride {
  reviewer?: ReviewerId
}

export interface ReviewOptions {
  /** Runtime availability (from doctor): an unavailable reviewer cannot review. */
  availability?: RuntimeAvailability
  /** Preference order among the reviewer candidates (default `RUNTIME_IDS`). */
  preference?: RuntimeId[]
  override?: ReviewOverride
  /** `same`: the implementer reviews itself in a new session (CYRA-921). Missing = `cross`. */
  mode?: ReviewMode
}

/** The reviewer selection outcome: who reviews (different from the implementer) and what they must evaluate. */
export interface ReviewerSelection {
  implementer: RuntimeId
  /** The reviewing runtime, different from the implementer. `null` if no different runtime is available. */
  reviewer: ReviewerId | null
  /** true if a different, available reviewer was found. */
  available: boolean
  /** The review is read-only: it does not modify the code (Scenario 1). Always true. */
  readOnly: true
  /** The aspects to evaluate (requirements, diff, tests, risks): the reviewer's read-only brief. */
  aspects: ReviewAspect[]
  reasons: string[]
}

export const REVIEW_EXECUTION_STATUSES = ['completed', 'unavailable', 'timeout', 'cancelled', 'failed', 'malformed'] as const
export type ReviewExecutionStatus = (typeof REVIEW_EXECUTION_STATUSES)[number]

/**
 * The verdict input contains the ACTUAL outcome of the reviewer process. Only `completed` can produce approved;
 * unavailability, timeout, cancellation, nonzero exit and malformed output are always blocking.
 */
export interface ReviewInput {
  implementer: RuntimeId
  reviewer: ReviewerId | null
  executionStatus: ReviewExecutionStatus
  findings: ReviewFinding[]
  /** `same` accepts a review by the implementer's own engine (CYRA-921). Missing = `cross`. */
  mode?: ReviewMode
}

/** Available unless probed unavailable: only `=== false` excludes a candidate (missing/`true` → available). */
function isAvailable(availability: RuntimeAvailability, runtime: ReviewerId): boolean {
  return availability[runtime] !== false
}

/**
 * The reviewer candidates, in preference order then canonical runtimes. The implementer is ALWAYS excluded (DoD: the
 * reviewer must be different). Duplicates removed. Used only without override (the override is authoritative upstream).
 */
function candidateReviewers(implementer: RuntimeId, preference: RuntimeId[] | undefined): RuntimeId[] {
  const order = [...(preference ?? []), ...RUNTIME_IDS]
  const seen = new Set<RuntimeId>()
  const result: RuntimeId[] = []
  for (const runtime of order) {
    if (!isRuntimeId(runtime) || runtime === implementer || seen.has(runtime)) continue
    seen.add(runtime)
    result.push(runtime)
  }

  return result
}

/**
 * Picks the reviewer for a run implemented by `implementer`. Pure and deterministic. The reviewer is
 * ALWAYS a runtime different from the implementer (DoD): with two runtimes it is the other one. Without override, if no different
 * runtime is available cross review is impossible (`reviewer = null`, `available = false`) — never
 * fall back to the implementer. A human override is AUTHORITATIVE (as in `route`): it forces the reviewer (which MUST
 * be different, otherwise it is an error) and, if unavailable, stays chosen but reported as unavailable (no
 * silent fallback against the human choice).
 */
export function selectReviewer(implementer: RuntimeId, opts: ReviewOptions = {}): ReviewerSelection {
  if (!isRuntimeId(implementer)) {
    throw invalidInput(`Implementatore non riconosciuto: "${String(implementer)}" (attesi: ${RUNTIME_IDS.join(', ')})`)
  }

  const availability = opts.availability ?? {}
  const overrideReviewer = opts.override?.reviewer
  const reviewer = opts.mode === 'same'
    ? implementer
    : resolveReviewer(implementer, opts.preference, availability, overrideReviewer)
  const available = reviewer !== null && isAvailable(availability, reviewer)
  return {
    implementer,
    reviewer,
    available,
    readOnly: true,
    aspects: [...REVIEW_ASPECTS],
    reasons: selectionReasons(implementer, reviewer, overrideReviewer !== undefined, opts.mode),
  }
}

/**
 * CYAU-226 — the reviewer the server names for this machine wins: the implementer itself means a new session of
 * it, another engine is forced like a human override. Without a name, the mode decides as before.
 */
export function selectServerReviewer(
  implementer: RuntimeId,
  opts: {availability?: RuntimeAvailability; mode?: ReviewMode; reviewer?: ReviewerId},
): ReviewerSelection {
  const {reviewer, ...rest} = opts
  if (reviewer === undefined) return selectReviewer(implementer, rest)
  if (reviewer === implementer) return selectReviewer(implementer, {...rest, mode: 'same'})
  return selectReviewer(implementer, {...rest, mode: 'cross', override: {reviewer}})
}

/**
 * Resolves WHICH runtime reviews. With override: the human choice is authoritative (validated as different
 * from the implementer), used regardless of availability (`available` reflects it downstream). Without override:
 * the first different available runtime by preference, or `null` if none.
 */
function resolveReviewer(
  implementer: RuntimeId,
  preference: RuntimeId[] | undefined,
  availability: RuntimeAvailability,
  override: ReviewerId | undefined,
): ReviewerId | null {
  if (override !== undefined) {
    if (!isReviewerId(override)) {
      throw invalidInput(`Unknown reviewer: "${String(override)}" (expected: ${REVIEWER_IDS.join(', ')})`)
    }

    if (override === implementer) {
      throw invalidInput(
        `Il reviewer deve essere diverso dall'implementatore (${implementer}): la revisione incrociata richiede l'altro runtime`,
      )
    }

    return override
  }

  return candidateReviewers(implementer, preference).find((r) => isAvailable(availability, r)) ?? null
}

/**
 * Structures the verdict from the execution outcome and the validated findings. Pure and deterministic: only
 * `completed` with a different reviewer can approve; every other state is `blocked` and `crossReviewed=false`.
 * On a completed review: blocker → blocked, major → changes_requested, otherwise approved.
 */
export function decideVerdict(input: ReviewInput): ReviewVerdict {
  if (!isRuntimeId(input.implementer)) throw invalidInput(`Implementatore non riconosciuto: "${String(input.implementer)}"`)
  if (input.reviewer !== null && !isReviewerId(input.reviewer)) {
    throw invalidInput(`Reviewer non riconosciuto: "${String(input.reviewer)}"`)
  }
  if (input.reviewer === input.implementer && input.mode !== 'same') {
    throw invalidInput(`Il reviewer deve essere diverso dall'implementatore (${input.implementer})`)
  }
  if (!(REVIEW_EXECUTION_STATUSES as readonly string[]).includes(input.executionStatus)) {
    throw invalidInput(`Esito esecuzione reviewer non riconosciuto: "${String(input.executionStatus)}"`)
  }

  const completed = input.executionStatus === 'completed'
  if (completed && input.reviewer === null) throw invalidInput('Una review completata deve identificare il reviewer')
  const findings = completed ? input.findings : []
  const blockingCount = findings.filter((f) => isBlockingSeverity(f.severity)).length
  const advisoryCount = findings.length - blockingCount

  let verdict: ReviewVerdictLabel
  let crossReviewed: boolean
  let reasons: string[]
  if (!completed || input.reviewer === null) {
    verdict = 'blocked'
    crossReviewed = false
    reasons = [
      `Revisione incrociata non completata (${input.executionStatus}): nessuna approvazione automatica → blocked`,
    ]
  } else {
    crossReviewed = true
    const hasBlocker = findings.some((f) => f.severity === 'blocker')
    const hasMajor = findings.some((f) => f.severity === 'major')
    verdict = hasBlocker ? 'blocked' : hasMajor ? 'changes_requested' : 'approved'
    reasons = verdictReasons(input.reviewer, input.implementer, verdict, blockingCount, advisoryCount)
  }

  return ReviewVerdictSchema.parse({
    verdict,
    implementer: input.implementer,
    reviewer: input.reviewer,
    crossReviewed,
    readOnly: true,
    findings,
    blockingCount,
    advisoryCount,
    reasons,
  })
}

/** The phase after the review, by verdict (CYAU-16 state machine). Legal transitions from `reviewing`. */
const VERDICT_TO_PHASE: Record<ReviewVerdictLabel, RunPhase> = {
  approved: 'in_review',
  changes_requested: 'implementing',
  blocked: 'blocked',
}

/**
 * Maps the verdict onto the run's next phase (CYAU-16): `approved → in_review` (towards the human
 * review), `changes_requested → implementing` (findings to fix), `blocked → blocked` (intervention needed).
 */
export function reviewVerdictToPhase(verdict: ReviewVerdictLabel): RunPhase {
  return VERDICT_TO_PHASE[verdict]
}

/**
 * Validates and normalizes a raw reviewer finding (untrusted input). A non-conforming JSON (unknown severity/aspect,
 * missing title, extra fields) is rejected with a dedicated code before entering the verdict.
 */
export function parseFinding(raw: unknown): ReviewFinding {
  const result = ReviewFindingInputSchema.safeParse(raw)
  if (!result.success) {
    const detail = result.error.issues.map((i) => i.message).join('; ')
    throw invalidInput(`Finding della review non valido: ${detail}`)
  }

  const {severity, aspect, title, detail} = result.data
  return {severity, aspect: aspect ?? null, title, detail: detail ?? null}
}

/** The reasons for the reviewer selection (explainable routing): read-only, different from the implementer. */
function selectionReasons(
  implementer: RuntimeId, reviewer: ReviewerId | null, overridden: boolean, mode?: ReviewMode,
): string[] {
  const reasons: string[] = []
  if (mode === 'same' && reviewer === implementer) {
    reasons.push(`Reviewer ${reviewer}: the same runtime in a new session (the machine is set to same-engine review)`)
  } else if (reviewer === null) {
    reasons.push(`Nessun reviewer diverso da ${implementer} disponibile: la revisione incrociata non è possibile`)
  } else {
    reasons.push(`Reviewer ${reviewer}: runtime diverso dall'implementatore ${implementer} (revisione incrociata)`)
    if (overridden) reasons.push(`Reviewer forzato manualmente a ${reviewer}`)
  }

  reasons.push(`Review read-only: valuta ${REVIEW_ASPECTS.join(', ')} senza modificare il codice`)
  return reasons
}

/** The reasons for the verdict (auditable): reviewer, outcome, count of blocking and non-blocking findings. */
function verdictReasons(
  reviewer: ReviewerId,
  implementer: RuntimeId,
  verdict: ReviewVerdictLabel,
  blockingCount: number,
  advisoryCount: number,
): string[] {
  const reasons = [`Revisione incrociata: ${reviewer} ha revisionato l'implementazione di ${implementer} (read-only)`]
  reasons.push(`Finding: ${blockingCount} bloccanti, ${advisoryCount} non bloccanti`)
  switch (verdict) {
    case 'approved': {
      reasons.push('Nessun finding bloccante → approved: la lavorazione può passare alla review umana (in_review)')
      break
    }

    case 'changes_requested': {
      reasons.push('Finding bloccanti (major) da correggere → changes_requested: si torna a implementare')
      break
    }

    case 'blocked': {
      reasons.push('Finding blocker: serve intervento → blocked (non procedere in automatico)')
      break
    }
  }

  return reasons
}

function invalidInput(message: string): AutomatorError {
  return new AutomatorError(ErrorCodes.Review.invalidInput, message, 2)
}
