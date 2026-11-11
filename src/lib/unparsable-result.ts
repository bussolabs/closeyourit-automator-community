import {boundedExcerpt} from './logger'
import {sanitizeMultiline} from './output'
import {type ExecutionPhase} from './phase-profile'
import {redactSecrets} from './secret-redaction'

/**
 * CYAU-192 — the SYNTHETIC `blocked` the host delivers in place of an uninterpretable result.
 *
 * When the model produced a result outside the contract (invented enums, hybrid keys, prose without JSON)
 * the runner recorded C422-WORKFLOW-001 in the log and delivered NOTHING: the server marked the run
 * "interrupted" after the stall and stopped it after two times, and whoever looked at the ticket knew nothing —
 * the reason was in a log file on a machine. The delivery (`deliverAttempt`) is the only channel to
 * the ticket, so the reason goes through there: a block that says what did not fit the format.
 *
 * Shape per phase, because the server revalidates against the vendored schema of the claimed PHASE:
 * - planner/autopilot → v2 contract, `failure` with `retryable: true`: the server reads it as "I could not
 *   look" (unreachable) and puts the phase back in the queue, calling a person only beyond its
 *   cap. The local cap (`ticket-attempts.ts`) triggers anyway at the next claim: `retryable` without
 *   a limit would be a loop.
 * - closer_staging/closer_production → v1 contract, `blocked` + `causa: 'unreachable'`, same reading.
 * - triage → the contract has NO `blocked`; `waiting`/`escalated` are the two states the server treats
 *   exactly like a block declared by the agent (`block_from_agent!`), and `causa` is read there too.
 *   `escalated` is used, which in the skill means "the team is needed": it is what an unreadable triage asks for.
 *   The other required fields (`category`, `risk`, …) are filled with the most prudent value and the reason
 *   is in `reasons`, so nobody can mistake the verdict for a judgement on the ticket.
 */
export const UNPARSABLE_REASON_PREFIX = 'Risultato non interpretabile: '
export const UNPARSABLE_HUMAN_ACTION =
  'Se si ripete, rileggere le istruzioni della skill: il modello non ha rispettato il formato del risultato'
/** The review did not happen: there is no result to review, and the report says so. */
export const HOST_SYNTHETIC_REVIEW_SUMMARY = 'Generata dall\'host: nessun risultato da rileggere'
/** How many characters of findings go into the reason: it is a line on the ticket card, not a dump. */
export const UNPARSABLE_REASON_CHARS = 700
/** How much output ends up in `technical_detail`: enough to recognise its shape, redacted and delimited. */
export const UNPARSABLE_TECHNICAL_DETAIL_CHARS = 4000

export interface SyntheticBlockedInput {
  phase: ExecutionPhase
  /** The claimed ticket's code: the contract requires it on every phase. */
  code: string
  /** The findings of `parseWorkflowResultDetailed`, already in the `path: message` form. */
  issues: string[]
  /** The raw stdout of the session: it is redacted and truncated before leaving the machine. */
  stdout: string
  /**
   * CYRA-1197 — the host measured with git that the branch conflicts with main. The block then says
   * `merge_conflict`, so the server starts the round that resolves it instead of retrying the same session.
   */
  mergeConflict?: boolean
}

/**
 * The reason on one line, truncated: fixed prefix + findings. zod findings quote the received value
 * ("received 'cyi_…'"), so they go through the centralized redaction and the control sequence
 * cleanup BEFORE the cut: a truncation on the raw text can split a token and let the
 * remaining piece through.
 */
export function unparsableReason(issues: string[]): string {
  return `${UNPARSABLE_REASON_PREFIX}${boundedReason(issues.join('; '))}`
}

/** Redacted and cleaned of control sequences, THEN cut: the same order for every reason that leaves the machine. */
function boundedReason(text: string): string {
  const clean = sanitizeMultiline(redactSecrets(text))
  return clean.length > UNPARSABLE_REASON_CHARS ? `${clean.slice(0, UNPARSABLE_REASON_CHARS)}…` : clean
}

/** Stdout excerpt that may travel to the server: redacted BEFORE the cut, without control sequences. */
function technicalDetail(stdout: string): string {
  return boundedExcerpt(sanitizeMultiline(redactSecrets(stdout)), UNPARSABLE_TECHNICAL_DETAIL_CHARS)
}

export function syntheticBlockedResult(input: SyntheticBlockedInput): Record<string, unknown> {
  const reason = unparsableReason(input.issues)
  switch (input.phase) {
    case 'planner':
    case 'autopilot':
      return {
        contract_version: 2,
        code: input.code,
        state: 'blocked',
        failure: {
          category: input.mergeConflict ? 'merge_conflict' : 'unknown',
          summary: reason,
          retryable: !input.mergeConflict,
          human_action: UNPARSABLE_HUMAN_ACTION,
          technical_detail: technicalDetail(input.stdout),
        },
        security_findings: [],
      }
    case 'closer_staging':
    case 'closer_production':
      return {code: input.code, state: 'blocked', tag: null, causa: 'unreachable', reason}
    case 'triage':
      return {
        code: input.code,
        category: 'mixed',
        capabilities: [],
        risk: 'high',
        requires_human_approval: true,
        reasons: [reason],
        state: 'escalated',
        causa: 'unreachable',
      }
  }
}

/**
 * CYAU-306 — the SYNTHETIC `blocked` the host delivers when the checks are still red on the last allowed round.
 *
 * Before, the local cycle closed `blocked` (C409-CYCLE-002) and NOTHING reached the server: without a delivery
 * the attempt went stale, the server put the phase back in the queue and the ticket started again on red
 * checks, with nobody told why. The block says it the way the server already reads blocks: v2 contract,
 * `quality_gate`, and `retryable: false` — a person has to look, retrying alone gives the same red.
 *
 * Only for a RED check: a check whose outcome could not be read (`unavailable`) consumes no round and
 * never gets here. The reason is the CI summary, redacted and cut like the one of the unreadable result.
 */
export const CYCLE_LIMIT_REASON_PREFIX = 'Controlli rossi anche all\'ultimo giro di correzione: '
export const CYCLE_LIMIT_HUMAN_ACTION =
  'Correggere i controlli rossi o rivedere il piano, poi sbloccare il ticket: la macchina non riprova da sola'

export interface CycleLimitBlockedInput {
  /** The claimed ticket's code: the contract requires it. */
  code: string
  /** What the CI said on the last round (`verification.summary`): redacted and truncated here. */
  summary: string
}

export function cycleLimitReason(summary: string): string {
  return `${CYCLE_LIMIT_REASON_PREFIX}${boundedReason(summary)}`
}

/** Autopilot only: it is the one phase whose delivery goes through the CI check, so the only one with this limit. */
export function cycleLimitBlockedResult(input: CycleLimitBlockedInput): Record<string, unknown> {
  return {
    contract_version: 2,
    code: input.code,
    state: 'blocked',
    failure: {
      category: 'quality_gate',
      summary: cycleLimitReason(input.summary),
      retryable: false,
      human_action: CYCLE_LIMIT_HUMAN_ACTION,
    },
    security_findings: [],
  }
}
