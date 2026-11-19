import {describe, expect, it} from 'vitest'
import {
  REVIEW_FAULT_KINDS,
  REVIEW_MAX_ATTEMPTS,
  REVIEW_RETRY_WAIT_MS,
  isTechnicalReviewFault,
  reviewFaultOfExecutionStatus,
  reviewFaultReason,
  shouldRetryReviewFault,
  type ReviewFaultKind,
} from '../src/lib/review-fault'

// CYAU-335 — a review that did not happen because of the machine is a pause, not a rejection of the work.
describe('review fault classification', () => {
  it('maps every reviewer execution status that is not a verdict', () => {
    expect(reviewFaultOfExecutionStatus('unavailable')).toBe('unavailable')
    expect(reviewFaultOfExecutionStatus('timeout')).toBe('transient')
    expect(reviewFaultOfExecutionStatus('failed')).toBe('transient')
    expect(reviewFaultOfExecutionStatus('malformed')).toBe('transient')
    expect(reviewFaultOfExecutionStatus('cancelled')).toBe('cancelled')
  })

  it('treats a completed execution as no fault of the machine', () => {
    // `completed` reaches here only through a caller bug: the safe answer is the one that keeps today's
    // behaviour (delivered, judged by the server), never a free retry.
    expect(reviewFaultOfExecutionStatus('completed')).toBe('work')
  })

  it('only a machine fault spares the attempt', () => {
    const technical: ReviewFaultKind[] = ['quota', 'transient', 'unavailable', 'cancelled']
    for (const kind of technical) expect(isTechnicalReviewFault(kind)).toBe(true)
    expect(isTechnicalReviewFault('work')).toBe(false)
  })

  it('only a transient fault is worth another try in the same session', () => {
    expect(shouldRetryReviewFault('transient')).toBe(true)
    // A quota limit resets in minutes or hours: waiting for it here would hold the machine on one ticket.
    expect(shouldRetryReviewFault('quota')).toBe(false)
    expect(shouldRetryReviewFault('unavailable')).toBe(false)
    expect(shouldRetryReviewFault('cancelled')).toBe(false)
    expect(shouldRetryReviewFault('work')).toBe(false)
  })

  it('every kind is listed, so a new one cannot stay unclassified', () => {
    expect([...REVIEW_FAULT_KINDS]).toEqual(['quota', 'transient', 'unavailable', 'cancelled', 'work'])
  })

  it('bounds the retry: one more try, after a wait', () => {
    expect(REVIEW_MAX_ATTEMPTS).toBe(2)
    expect(REVIEW_RETRY_WAIT_MS).toBeGreaterThan(0)
    expect(REVIEW_RETRY_WAIT_MS).toBeLessThanOrEqual(60_000)
  })

  it('names the fault on the attempt as a fault, not as a judgement', () => {
    const reason = reviewFaultReason('quota', 'reviewer out of quota until 10:00')
    expect(reason).toContain('technical fault')
    expect(reason).toContain('not a rejection')
    expect(reason).toContain('quota')
    expect(reason).toContain('reviewer out of quota until 10:00')
  })
})
