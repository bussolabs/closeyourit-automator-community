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
}

/**
 * The reason on one line, truncated: fixed prefix + findings. zod findings quote the received value
 * ("received 'cyi_…'"), so they go through the centralized redaction and the control sequence
 * cleanup BEFORE the cut: a truncation on the raw text can split a token and let the
 * remaining piece through.
 */
export function unparsableReason(issues: string[]): string {
  const joined = sanitizeMultiline(redactSecrets(issues.join('; ')))
  const bounded = joined.length > UNPARSABLE_REASON_CHARS ? `${joined.slice(0, UNPARSABLE_REASON_CHARS)}…` : joined
  return `${UNPARSABLE_REASON_PREFIX}${bounded}`
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
          category: 'unknown',
          summary: reason,
          retryable: true,
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
