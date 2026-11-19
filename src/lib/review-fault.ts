import {type ReviewExecutionStatus} from './review'

/**
 * CYAU-335 — a review that produced no verdict is not always a "no" to the work.
 *
 * Before, every unavailable review travelled with the delivery as `review: unavailable`, which the server
 * reads exactly like a rejection: it consumed the phase's review budget and after two rounds called a
 * person. But an exhausted quota, a reviewer process that died and a diff Git could not acquire say
 * nothing about the work — they say the MACHINE could not judge it. Counting them as rejections stopped
 * sound work and filled the decision queue with faults nobody could act on (10 of the 138 stuck runs
 * on 2026-11-19).
 *
 * So the reason is classified. A fault of the machine (`quota`, `transient`, `unavailable`, `cancelled`)
 * holds the delivery, says so on the attempt and gives the attempt back; a reason that belongs to the WORK
 * (`work`) keeps travelling to the server, because there retrying the same working copy gives the same
 * answer and whoever wrote it has to fix it.
 */
export const REVIEW_FAULT_KINDS = ['quota', 'transient', 'unavailable', 'cancelled', 'work'] as const
export type ReviewFaultKind = (typeof REVIEW_FAULT_KINDS)[number]

/** Faults of the machine: the work was never judged, so the attempt must not be charged for them. */
const TECHNICAL_FAULTS: ReadonlySet<ReviewFaultKind> = new Set<ReviewFaultKind>(['quota', 'transient', 'unavailable', 'cancelled'])

/**
 * The retry asks the SAME reviewer again, deliberately: the reviewer must differ from the implementer (the
 * cross-review is there exactly for that), so with two engines the choice is already forced — the only other
 * engine is the one that wrote the work. Falling back to it would turn a cross-review into a self-review
 * without the server having asked for one, which weakens the very guarantee the review exists to give. An
 * exhausted engine therefore waits for its reset (the pause stops the claim) instead of being swapped out.
 */
/** At most two attempts at the review inside one session: one more try, never a loop. */
export const REVIEW_MAX_ATTEMPTS = 2

/**
 * Wait before trying the review again. Short on purpose: the session holds the ticket's lease while it waits, so a
 * long wait would keep the machine on one ticket. Everything longer than this is waited for BETWEEN rounds, with
 * the ticket back in the queue.
 */
export const REVIEW_RETRY_WAIT_MS = 30_000

export function isTechnicalReviewFault(kind: ReviewFaultKind): boolean {
  return TECHNICAL_FAULTS.has(kind)
}

/**
 * True only for a fault a second try can beat: a process that died, a timeout, an answer outside the format. A
 * quota limit resets in minutes or hours and an unavailable reviewer stays unavailable — retrying either here
 * would only spin. A cancellation means the service is stopping: nothing is started again.
 */
export function shouldRetryReviewFault(kind: ReviewFaultKind): boolean {
  return kind === 'transient'
}

/**
 * The fault behind a reviewer execution that did not reach a verdict. `completed` cannot be a fault: if it ever
 * gets here it is a caller bug, and the answer is the one that keeps the previous behaviour — delivered and judged
 * by the server — instead of granting a free retry.
 */
export function reviewFaultOfExecutionStatus(status: ReviewExecutionStatus): ReviewFaultKind {
  switch (status) {
    case 'unavailable':
      return 'unavailable'
    case 'timeout':
    case 'failed':
    case 'malformed':
      return 'transient'
    case 'cancelled':
      return 'cancelled'
    case 'completed':
      return 'work'
  }
}

/** What the attempt is told: a fault of the machine, with its reason, never a judgement on the work (AC-5). */
export function reviewFaultReason(kind: ReviewFaultKind, detail: string): string {
  return `review not produced by a technical fault (${kind}), not a rejection of the work: ${detail}`
}
