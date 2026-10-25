import {beforeEach, describe, expect, it, vi} from 'vitest'

const reviewExecution = vi.hoisted(() => ({
  execute: vi.fn(),
  resolveDiff: vi.fn(),
}))

vi.mock('../src/lib/review-execution', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/lib/review-execution')>()
  return {
    ...actual,
    executeChunkedCrossReview: reviewExecution.execute,
    resolveReviewDiff: reviewExecution.resolveDiff,
  }
})

import Review from '../src/commands/review'
import {ReviewSnapshotExecutionError, reviewDiffSha256} from '../src/lib/review-execution'
import {runCaptured, runExpectingExit} from './helpers/command'

interface SelectionPayload {
  reviewer: string | null
  available: boolean
  readOnly: boolean
  aspects: string[]
}

interface VerdictPayload {
  code: string | null
  base: string
  baseCommit: string | null
  snapshotTree: string | null
  diffSha256: string | null
  execution: {
    status: string
    detail: string | null
    attestation: {reviewedBaseCommit: string; reviewedSnapshotTree: string; reviewedDiffSha256: string} | null
  }
  verdict: string
  implementer: string
  reviewer: string | null
  crossReviewed: boolean
  findings: Array<{severity: string; aspect: string | null; title: string; detail: string | null}>
  blockingCount: number
  advisoryCount: number
  error?: {code: string; message: string}
}

const baseArgs = [
  '--implementer', 'claude',
  '--base', 'main',
  '--requirements', 'correggere il gate review',
  '--tests', 'suite completa verde',
  '--risks', 'nessun rischio residuo noto',
]

beforeEach(() => {
  const diff = 'diff --git a/a b/a\n+x\n'
  reviewExecution.resolveDiff.mockReset().mockReturnValue({
    baseCommit: 'a'.repeat(40),
    snapshotTree: 'b'.repeat(40),
    diff,
    diffSha256: reviewDiffSha256(diff),
  })
  reviewExecution.execute.mockReset().mockImplementation(async (input: {
    baseCommit: string
    snapshotTree: string
    diffSha256: string
    selection: {reviewer: string | null; available: boolean}
  }) => ({
    status: input.selection.available ? 'completed' : 'unavailable',
    reviewer: input.selection.reviewer,
    findings: [],
    detail: null,
    attestation: input.selection.available
      ? {
        reviewedBaseCommit: input.baseCommit,
        reviewedSnapshotTree: input.snapshotTree,
        reviewedDiffSha256: input.diffSha256,
      }
      : null,
  }))
})

describe('review command — selection separate from execution', () => {
  it('Claude implements → selects read-only Codex without running it', async () => {
    const {result} = await runCaptured(Review, ['--implementer', 'claude', '--select', '--json'])
    const payload = result as SelectionPayload
    expect(payload).toMatchObject({reviewer: 'codex', available: true, readOnly: true})
    expect(payload.aspects).toEqual(['requirements', 'diff', 'tests', 'risks'])
    expect(reviewExecution.execute).not.toHaveBeenCalled()
  })

  it('implementa Codex → seleziona Claude', async () => {
    const {result} = await runCaptured(Review, ['--implementer', 'codex', '--select', '--json'])
    expect((result as SelectionPayload).reviewer).toBe('claude')
  })

  it('reviewer unavailable at selection → blocked exit 3', async () => {
    const {stderr} = await runExpectingExit(
      Review,
      ['--implementer', 'claude', '--select', '--unavailable', 'codex'],
      3,
    )
    expect(stderr).toContain('C409-REVIEW-003')
  })

  it('reviewer equal to the implementer → invalid input', async () => {
    const {stderr} = await runExpectingExit(Review, ['--implementer', 'claude', '--reviewer', 'claude', '--select'], 2)
    expect(stderr).toContain('C400-REVIEW-001')
  })
})

describe('review command — real execution mandatory before the verdict', () => {
  it('reviewer already known as unavailable blocks before acquiring the Git snapshot', async () => {
    const {stdout} = await runExpectingExit(
      Review,
      [...baseArgs, '--unavailable', 'codex', '--json'],
      3,
    )
    const payload = JSON.parse(stdout) as VerdictPayload

    expect(payload).toMatchObject({
      baseCommit: null,
      snapshotTree: null,
      diffSha256: null,
      verdict: 'blocked',
      execution: {status: 'unavailable'},
    })
    expect(reviewExecution.resolveDiff).not.toHaveBeenCalled()
    expect(reviewExecution.execute).not.toHaveBeenCalled()
  })

  it('zero findings from a completed review → approved', async () => {
    const {result, stdout} = await runCaptured(Review, [...baseArgs, '--json'])
    const payload = JSON.parse(stdout) as VerdictPayload
    expect(result).toBeUndefined()
    expect(payload).toMatchObject({
      base: 'main',
      baseCommit: 'a'.repeat(40),
      snapshotTree: 'b'.repeat(40),
      diffSha256: reviewDiffSha256('diff --git a/a b/a\n+x\n'),
      verdict: 'approved',
      reviewer: 'codex',
      crossReviewed: true,
      execution: {
        status: 'completed',
        attestation: {
          reviewedBaseCommit: 'a'.repeat(40),
          reviewedSnapshotTree: 'b'.repeat(40),
          reviewedDiffSha256: reviewDiffSha256('diff --git a/a b/a\n+x\n'),
        },
      },
    })
    expect(reviewExecution.execute).toHaveBeenCalledOnce()
    expect(reviewExecution.execute.mock.calls[0][0]).toMatchObject({
      implementer: 'claude',
      base: 'main',
      baseCommit: 'a'.repeat(40),
      snapshotTree: 'b'.repeat(40),
      diff: expect.stringContaining('diff --git'),
      diffSha256: reviewDiffSha256('diff --git a/a b/a\n+x\n'),
    })
    const initialDeadline = reviewExecution.resolveDiff.mock.calls[0][2].deadlineMs
    expect(initialDeadline).toEqual(expect.any(Number))
    expect(reviewExecution.execute.mock.calls[0][0].deadlineMs).toBe(initialDeadline)
    expect(reviewExecution.resolveDiff.mock.calls[1][2].deadlineMs).toBe(initialDeadline)
  })

  it('a concurrent change after the reviewer invalidates the snapshot and blocks the approval', async () => {
    reviewExecution.resolveDiff
      .mockReturnValueOnce({
        baseCommit: 'a'.repeat(40), snapshotTree: 'b'.repeat(40), diff: 'diff iniziale',
        diffSha256: reviewDiffSha256('diff iniziale'),
      })
      .mockReturnValueOnce({
        baseCommit: 'a'.repeat(40), snapshotTree: 'c'.repeat(40), diff: 'diff cambiato',
        diffSha256: reviewDiffSha256('diff cambiato'),
      })
    const {stdout} = await runExpectingExit(Review, [...baseArgs, '--json'], 3)
    const payload = JSON.parse(stdout) as VerdictPayload
    expect(payload.verdict).toBe('blocked')
    expect(payload.crossReviewed).toBe(false)
    expect(payload.execution).toMatchObject({status: 'failed', detail: 'snapshot Git cambiato durante la review'})
  })

  it('major finding validated by the reviewer → changes_requested exit 3', async () => {
    reviewExecution.execute.mockResolvedValue({
      status: 'completed',
      reviewer: 'codex',
      findings: [{severity: 'major', aspect: 'tests', title: 'manca il caso N', detail: null}],
      detail: null,
    })
    const {stdout} = await runExpectingExit(Review, [...baseArgs, '--json'], 3)
    const payload = JSON.parse(stdout) as VerdictPayload
    expect(payload.verdict).toBe('changes_requested')
    expect(payload.blockingCount).toBe(1)
    expect(payload.error?.code).toBe('C409-REVIEW-002')
  })

  it('finding blocker → blocked exit 3', async () => {
    reviewExecution.execute.mockResolvedValue({
      status: 'completed', reviewer: 'codex',
      findings: [{severity: 'blocker', aspect: 'risks', title: 'perdita dati', detail: null}], detail: null,
    })
    const {stderr} = await runExpectingExit(Review, baseArgs, 3)
    expect(stderr).toContain('C409-REVIEW-003')
  })

  it.each(['unavailable', 'timeout', 'cancelled', 'failed', 'malformed'])(
    'esecuzione %s → blocked e crossReviewed false',
    async (status) => {
      reviewExecution.execute.mockResolvedValue({status, reviewer: 'codex', findings: [], detail: `review ${status}`})
      const {stdout} = await runExpectingExit(Review, [...baseArgs, '--json'], 3)
      const payload = JSON.parse(stdout) as VerdictPayload
      expect(payload.verdict).toBe('blocked')
      expect(payload.crossReviewed).toBe(false)
      expect(payload.execution.status).toBe(status)
      expect(payload.error?.code).toBe('C409-REVIEW-003')
    },
  )

  it('also emits a blocked JSON while the SIGINT listener is still installed', async () => {
    reviewExecution.execute.mockResolvedValue({
      status: 'failed', reviewer: 'codex', findings: [], detail: 'review failed', attestation: null,
    })
    const listenersBefore = process.listenerCount('SIGINT')
    const prototype = Review.prototype as unknown as {logJson(value: unknown): void}
    const original = prototype.logJson
    let listenerObserved = false
    vi.spyOn(prototype, 'logJson').mockImplementation(function (this: Review, value: unknown) {
      listenerObserved = process.listenerCount('SIGINT') > listenersBefore
      original.call(this, value)
    })

    await runExpectingExit(Review, [...baseArgs, '--json'], 3)
    expect(listenerObserved).toBe(true)
    expect(process.listenerCount('SIGINT')).toBe(listenersBefore)
  })

  it('an explicitly unavailable reviewer is not started and does not approve', async () => {
    const {stdout} = await runExpectingExit(
      Review,
      [
        '--implementer', 'claude', '--base', 'main', '--requirements', 'requisiti', '--tests', 'verdi',
        '--risks', 'nessuno', '--unavailable', 'codex', '--json',
      ],
      3,
    )
    const payload = JSON.parse(stdout) as VerdictPayload
    expect(payload.execution.status).toBe('unavailable')
    expect(payload.verdict).toBe('blocked')
  })

  it.each(['timeout', 'cancelled', 'failed'] as const)(
    'interruption %s during the initial snapshot produces a structured blocked verdict',
    async (status) => {
      reviewExecution.resolveDiff.mockRejectedValueOnce(new ReviewSnapshotExecutionError(status))
      const {stdout} = await runExpectingExit(Review, [...baseArgs, '--json'], 3)
      const payload = JSON.parse(stdout) as VerdictPayload
      expect(payload).toMatchObject({
        baseCommit: null,
        snapshotTree: null,
        diffSha256: null,
        verdict: 'blocked',
        crossReviewed: false,
        execution: {status},
        error: {code: 'C409-REVIEW-003'},
      })
      expect(reviewExecution.execute).not.toHaveBeenCalled()
    },
  )

  it('cancellation during the post-review revalidation stays cancelled and not approved', async () => {
    const diff = 'diff iniziale'
    reviewExecution.resolveDiff
      .mockReturnValueOnce({
        baseCommit: 'a'.repeat(40), snapshotTree: 'b'.repeat(40), diff,
        diffSha256: reviewDiffSha256(diff),
      })
      .mockRejectedValueOnce(new ReviewSnapshotExecutionError('cancelled'))
    const {stdout} = await runExpectingExit(Review, [...baseArgs, '--json'], 3)
    const payload = JSON.parse(stdout) as VerdictPayload
    expect(payload).toMatchObject({verdict: 'blocked', execution: {status: 'cancelled'}})
  })

  it('a SIGINT delivered at the end of the revalidation stays cancelled and structured', async () => {
    const existingListeners = new Set(process.listeners('SIGINT'))
    let commandListenerInvoked = false
    const snapshot = {
      baseCommit: 'a'.repeat(40),
      snapshotTree: 'b'.repeat(40),
      diff: 'diff finale',
      diffSha256: reviewDiffSha256('diff finale'),
    }
    reviewExecution.resolveDiff
      .mockReturnValueOnce(snapshot)
      .mockImplementationOnce(async () => {
        queueMicrotask(() => {
          const commandListener = process.listeners('SIGINT').find((listener) => !existingListeners.has(listener))
          if (commandListener) {
            commandListenerInvoked = true
            commandListener()
          }
        })
        return snapshot
      })

    const {stdout} = await runExpectingExit(Review, [...baseArgs, '--json'], 3)
    expect(commandListenerInvoked).toBe(true)
    expect(JSON.parse(stdout)).toMatchObject({
      verdict: 'blocked',
      execution: {status: 'cancelled'},
      error: {code: 'C409-REVIEW-003'},
    })
  })

  it('a completed result observed past the deadline is not printed as approved', async () => {
    const now = vi.spyOn(performance, 'now')
    reviewExecution.execute.mockImplementation(async (input: {
      baseCommit: string
      snapshotTree: string
      diffSha256: string
      selection: {reviewer: string | null}
    }) => {
      now.mockReturnValue(Number.MAX_SAFE_INTEGER)
      return {
        status: 'completed',
        reviewer: input.selection.reviewer,
        findings: [],
        detail: null,
        attestation: {
          reviewedBaseCommit: input.baseCommit,
          reviewedSnapshotTree: input.snapshotTree,
          reviewedDiffSha256: input.diffSha256,
        },
      }
    })

    try {
      const {stdout} = await runExpectingExit(Review, [...baseArgs, '--json'], 3)
      const payload = JSON.parse(stdout) as VerdictPayload
      expect(payload).toMatchObject({
        verdict: 'blocked',
        crossReviewed: false,
        execution: {status: 'timeout', detail: 'review scaduta prima del verdetto', attestation: null},
      })
    } finally {
      now.mockRestore()
    }
  })

  it('--timeout is propagated in milliseconds', async () => {
    await runCaptured(Review, [...baseArgs, '--timeout', '12'])
    expect(reviewExecution.execute.mock.calls[0][0].timeoutMs).toBeGreaterThan(11_900)
    expect(reviewExecution.execute.mock.calls[0][0].timeoutMs).toBeLessThanOrEqual(12_000)
  })

  it('human output shows ticket, reviewer and verdict', async () => {
    const {stdout} = await runCaptured(Review, [...baseArgs, '--code', 'CYAU-45'])
    expect(stdout).toContain('CYAU-45')
    expect(stdout.toLowerCase()).toContain('approved')
    expect(stdout.toLowerCase()).toContain('reviewer')
  })
})

describe('review command — difesa all’ingresso', () => {
  it('without --base the verdict mode fails before running', async () => {
    const {stderr} = await runExpectingExit(Review, ['--implementer', 'claude'], 2)
    expect(stderr).toContain('C400-REVIEW-001')
    expect(reviewExecution.execute).not.toHaveBeenCalled()
  })

  it('without an explicit requirements snapshot does not start the reviewer', async () => {
    const {stderr} = await runExpectingExit(Review, ['--implementer', 'claude', '--base', 'main'], 2)
    expect(stderr).toContain('C400-REVIEW-001')
    expect(reviewExecution.execute).not.toHaveBeenCalled()
  })

  it('without test evidence and risk assessment does not start the reviewer', async () => {
    const {stderr} = await runExpectingExit(
      Review,
      ['--implementer', 'claude', '--base', 'main', '--requirements', 'requisiti'],
      2,
    )
    expect(stderr).toContain('C400-REVIEW-001')
    expect(reviewExecution.execute).not.toHaveBeenCalled()
  })

  it('unrecognised --implementer → exit 2', async () => {
    const {stderr} = await runExpectingExit(Review, ['--implementer', 'gpt', '--base', 'main', '--requirements', 'x'], 2)
    expect(stderr).toContain('C400-REVIEW-001')
  })

  it('unrecognised --reviewer → exit 2', async () => {
    const {stderr} = await runExpectingExit(
      Review,
      ['--implementer', 'claude', '--reviewer', 'gpt', '--base', 'main', '--requirements', 'x'],
      2,
    )
    expect(stderr).toContain('C400-REVIEW-001')
  })

  it('invalid Git base → exit 2 and no reviewer started', async () => {
    reviewExecution.resolveDiff.mockImplementation(() => {
      throw Object.assign(new Error('base invalida'), {code: 'C400-REVIEW-001', exitCode: 2})
    })
    await expect(runCaptured(Review, baseArgs)).rejects.toThrow('base invalida')
    expect(reviewExecution.execute).not.toHaveBeenCalled()
  })
})
