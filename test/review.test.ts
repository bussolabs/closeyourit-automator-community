import {describe, expect, it} from 'vitest'
import {
  selectServerReviewer,
  decideVerdict,
  isBlockingSeverity,
  isReviewSeverity,
  isReviewVerdict,
  parseFinding,
  REVIEW_ASPECTS,
  type ReviewFinding,
  type ReviewInput,
  ReviewVerdictSchema,
  reviewVerdictToPhase,
  selectReviewer,
} from '../src/lib/review'
import {AutomatorError, ErrorCodes} from '../src/errors/error-codes'

// The cross review (CYAU-20) takes whoever implemented a run and picks the OTHER runtime as the
// read-only reviewer (DoD: "the reviewer differs from the implementer"), then structures the outcome into an
// auditable verdict — approved / changes_requested / blocked — derived from the findings (blocking and not). It is PURE and
// DETERMINISTIC (no I/O, no randomness): it does not run the review (that is the orchestrator/executor), but
// selects who reviews and turns their findings into a repeatable and verifiable verdict.

function finding(severity: ReviewFinding['severity'], extra: Partial<ReviewFinding> = {}): ReviewFinding {
  return {severity, aspect: null, title: `rilievo ${severity}`, detail: null, ...extra}
}

const CLAUDE_IMPL: ReviewInput = {implementer: 'claude', reviewer: 'codex', executionStatus: 'completed', findings: []}

describe('reviewer selection (Scenario 1 / DoD: the reviewer differs from the implementer)', () => {
  it('if Claude implements, Codex reviews', () => {
    const sel = selectReviewer('claude')
    expect(sel.reviewer).toBe('codex')
    expect(sel.available).toBe(true)
  })

  it('if Codex implements, Claude reviews', () => {
    const sel = selectReviewer('codex')
    expect(sel.reviewer).toBe('claude')
    expect(sel.available).toBe(true)
  })

  it('the reviewer never matches the implementer', () => {
    for (const impl of ['claude', 'codex'] as const) {
      expect(selectReviewer(impl).reviewer).not.toBe(impl)
    }
  })

  it('the review is always read-only (it does not modify the code)', () => {
    expect(selectReviewer('claude').readOnly).toBe(true)
  })

  it('the brief lists the aspects to evaluate: requirements, diff, tests, risks', () => {
    const sel = selectReviewer('claude')
    expect(sel.aspects).toEqual([...REVIEW_ASPECTS])
    expect(sel.aspects).toContain('requirements')
    expect(sel.aspects).toContain('diff')
    expect(sel.aspects).toContain('tests')
    expect(sel.aspects).toContain('risks')
  })

  it('carries non-empty reasons', () => {
    const sel = selectReviewer('claude')
    expect(sel.reasons.length).toBeGreaterThan(0)
    expect(sel.reasons.every((r) => typeof r === 'string' && r.trim() !== '')).toBe(true)
  })
})

describe('reviewer selection — availability and override', () => {
  it('the other runtime unavailable → no different reviewer, cross review impossible', () => {
    const sel = selectReviewer('claude', {availability: {codex: false}})
    expect(sel.reviewer).toBeNull()
    expect(sel.available).toBe(false)
  })

  it('NEVER falls back to the implementer even if it is the only available one (it would violate the DoD)', () => {
    // Codex down and Claude implementer: the only "available" one would be Claude, but it is the implementer → forbidden.
    const sel = selectReviewer('claude', {availability: {claude: true, codex: false}})
    expect(sel.reviewer).toBeNull()
    expect(sel.available).toBe(false)
  })

  it('a human override can force the reviewer, as long as it differs from the implementer', () => {
    const sel = selectReviewer('claude', {override: {reviewer: 'codex'}})
    expect(sel.reviewer).toBe('codex')
    expect(sel.available).toBe(true)
  })

  it('an override choosing the same runtime as the implementer is rejected (DoD)', () => {
    let err: unknown
    try {
      selectReviewer('claude', {override: {reviewer: 'claude'}})
    } catch (e) {
      err = e
    }

    expect(err).toBeInstanceOf(AutomatorError)
    expect((err as AutomatorError).code).toBe(ErrorCodes.Review.invalidInput)
  })

  it('an override towards an unavailable reviewer stays authoritative but flagged as unavailable', () => {
    const sel = selectReviewer('claude', {override: {reviewer: 'codex'}, availability: {codex: false}})
    expect(sel.reviewer).toBe('codex')
    expect(sel.available).toBe(false)
  })

  it('an invalid implementer is rejected', () => {
    expect(() => selectReviewer('gpt' as never)).toThrow(AutomatorError)
  })

  it('an override towards an invalid runtime is rejected (defence in depth)', () => {
    let err: unknown
    try {
      selectReviewer('claude', {override: {reviewer: 'gpt' as never}})
    } catch (e) {
      err = e
    }

    expect(err).toBeInstanceOf(AutomatorError)
    expect((err as AutomatorError).code).toBe(ErrorCodes.Review.invalidInput)
  })
})

// CYRA-921
describe('same-engine review, for a machine with one engine', () => {
  it('picks the implementer itself when the machine is set to same', () => {
    const selection = selectReviewer('claude', {mode: 'same', availability: {codex: false}})
    expect(selection).toMatchObject({implementer: 'claude', reviewer: 'claude', available: true})
  })

  it('approves a completed review by the same engine only in same mode', () => {
    const same: ReviewInput = {implementer: 'claude', reviewer: 'claude', executionStatus: 'completed', findings: [], mode: 'same'}
    expect(decideVerdict(same)).toMatchObject({verdict: 'approved', crossReviewed: true, reviewer: 'claude'})
    expect(() => decideVerdict({...same, mode: 'cross'})).toThrow(AutomatorError)
    expect(() => decideVerdict({...same, mode: undefined})).toThrow(AutomatorError)
  })

  it('without a mode the reviewer is still the other engine', () => {
    expect(selectReviewer('codex').reviewer).toBe('claude')
  })
})

describe('verdict from the findings (schema: approved / changes_requested / blocked)', () => {
  it('no finding → approved (different reviewer available)', () => {
    const v = decideVerdict(CLAUDE_IMPL)
    expect(v.verdict).toBe('approved')
    expect(v.crossReviewed).toBe(true)
    expect(v.reviewer).toBe('codex')
  })

  it('only non-blocking findings (minor/info) → approved', () => {
    const v = decideVerdict({...CLAUDE_IMPL, findings: [finding('minor'), finding('info')]})
    expect(v.verdict).toBe('approved')
    expect(v.blockingCount).toBe(0)
    expect(v.advisoryCount).toBe(2)
  })

  it('a major (blocking) finding → changes_requested (back to implementing)', () => {
    const v = decideVerdict({...CLAUDE_IMPL, findings: [finding('major'), finding('info')]})
    expect(v.verdict).toBe('changes_requested')
    expect(v.blockingCount).toBe(1)
    expect(v.advisoryCount).toBe(1)
  })

  it('a blocker finding → blocked (intervention needed)', () => {
    const v = decideVerdict({...CLAUDE_IMPL, findings: [finding('blocker')]})
    expect(v.verdict).toBe('blocked')
    expect(v.crossReviewed).toBe(true)
    expect(v.blockingCount).toBe(1)
  })

  it('blocker takes precedence over major', () => {
    const v = decideVerdict({...CLAUDE_IMPL, findings: [finding('major'), finding('blocker')]})
    expect(v.verdict).toBe('blocked')
    expect(v.blockingCount).toBe(2)
  })

  it('major takes precedence over minor', () => {
    const v = decideVerdict({...CLAUDE_IMPL, findings: [finding('minor'), finding('major')]})
    expect(v.verdict).toBe('changes_requested')
  })

  it('the verdict reports implementer and reviewer for the audit', () => {
    const v = decideVerdict({implementer: 'codex', reviewer: 'claude', executionStatus: 'completed', findings: []})
    expect(v.implementer).toBe('codex')
    expect(v.reviewer).toBe('claude')
  })

  it('keeps the evaluated findings in the verdict (auditable)', () => {
    const findings = [finding('major', {title: 'manca test per il caso N', aspect: 'tests'})]
    const v = decideVerdict({...CLAUDE_IMPL, findings})
    expect(v.findings).toEqual(findings)
  })
})

describe('verdict when the cross review is impossible', () => {
  it('no different reviewer available → blocked, not reviewed', () => {
    const v = decideVerdict({implementer: 'claude', reviewer: null, executionStatus: 'unavailable', findings: []})
    expect(v.verdict).toBe('blocked')
    expect(v.crossReviewed).toBe(false)
    expect(v.reviewer).toBeNull()
  })

  it('the block reason mentions the impossibility of the cross review', () => {
    const v = decideVerdict({implementer: 'claude', reviewer: 'codex', executionStatus: 'failed', findings: []})
    expect(v.reasons.join(' ').toLowerCase()).toContain('failed')
  })

  it.each(['unavailable', 'timeout', 'cancelled', 'failed', 'malformed'] as const)(
    'execution %s → blocked and not reviewed, never approved',
    (executionStatus) => {
      const v = decideVerdict({implementer: 'claude', reviewer: 'codex', executionStatus, findings: []})
      expect(v.verdict).toBe('blocked')
      expect(v.crossReviewed).toBe(false)
    },
  )

  it('a reviewer equal to the implementer is rejected even downstream of the execution', () => {
    expect(() => decideVerdict({implementer: 'claude', reviewer: 'claude', executionStatus: 'completed', findings: []})).toThrow(
      AutomatorError,
    )
  })
})

describe('mapping of the verdict to the next phase (state machine CYAU-16)', () => {
  it('approved → in_review', () => {
    expect(reviewVerdictToPhase('approved')).toBe('in_review')
  })

  it('changes_requested → implementing', () => {
    expect(reviewVerdictToPhase('changes_requested')).toBe('implementing')
  })

  it('blocked → blocked', () => {
    expect(reviewVerdictToPhase('blocked')).toBe('blocked')
  })
})

describe('finding validation (input from the reviewer, untrusted)', () => {
  it('a valid finding is accepted and normalized', () => {
    const f = parseFinding({severity: 'major', title: 'bug nel diff'})
    expect(f.severity).toBe('major')
    expect(f.title).toBe('bug nel diff')
    expect(f.aspect).toBeNull()
    expect(f.detail).toBeNull()
  })

  it('normalizes missing aspect and detail to null', () => {
    const f = parseFinding({severity: 'info', title: 'nota'})
    expect(f.aspect).toBeNull()
    expect(f.detail).toBeNull()
  })

  it('an unknown severity is rejected', () => {
    let err: unknown
    try {
      parseFinding({severity: 'critical', title: 'x'})
    } catch (e) {
      err = e
    }

    expect(err).toBeInstanceOf(AutomatorError)
    expect((err as AutomatorError).code).toBe(ErrorCodes.Review.invalidInput)
  })

  it('a finding without title is rejected', () => {
    expect(() => parseFinding({severity: 'minor'})).toThrow(AutomatorError)
  })

  it('a finding with an unknown aspect is rejected', () => {
    expect(() => parseFinding({severity: 'minor', title: 'x', aspect: 'sicurezza'})).toThrow(AutomatorError)
  })

  it('a non-object finding is rejected', () => {
    expect(() => parseFinding('non un oggetto')).toThrow(AutomatorError)
  })
})

describe('type guard and schema (auditability)', () => {
  it('isReviewSeverity recognizes only the known severities', () => {
    expect(isReviewSeverity('blocker')).toBe(true)
    expect(isReviewSeverity('major')).toBe(true)
    expect(isReviewSeverity('minor')).toBe(true)
    expect(isReviewSeverity('info')).toBe(true)
    expect(isReviewSeverity('critical')).toBe(false)
  })

  it('isBlockingSeverity: blocker and major block, minor and info do not', () => {
    expect(isBlockingSeverity('blocker')).toBe(true)
    expect(isBlockingSeverity('major')).toBe(true)
    expect(isBlockingSeverity('minor')).toBe(false)
    expect(isBlockingSeverity('info')).toBe(false)
  })

  it('isReviewVerdict recognizes only the known verdicts', () => {
    expect(isReviewVerdict('approved')).toBe(true)
    expect(isReviewVerdict('changes_requested')).toBe(true)
    expect(isReviewVerdict('blocked')).toBe(true)
    expect(isReviewVerdict('rejected')).toBe(false)
  })

  it('every produced verdict conforms to the auditable schema', () => {
    for (const findings of [[], [finding('minor')], [finding('major')], [finding('blocker')]]) {
      const v = decideVerdict({...CLAUDE_IMPL, findings})
      expect(() => ReviewVerdictSchema.parse(v)).not.toThrow()
    }
  })
})

describe('determinism (repeatable and verifiable verdict)', () => {
  it('the same input always produces the same verdict', () => {
    const input: ReviewInput = {...CLAUDE_IMPL, findings: [finding('major'), finding('minor')]}
    expect(decideVerdict(input)).toEqual(decideVerdict(input))
  })

  it('a duplicate is not collapsed: every finding counts in the counts', () => {
    const v = decideVerdict({...CLAUDE_IMPL, findings: [finding('minor'), finding('minor')]})
    expect(v.advisoryCount).toBe(2)
  })
})

describe('reviewer named on the server (CYAU-226)', () => {
  it('uses the named engine when it differs from the implementer', () => {
    expect(selectServerReviewer('claude', {reviewer: 'codex'})).toMatchObject({reviewer: 'codex', available: true})
    expect(selectServerReviewer('codex', {reviewer: 'claude'})).toMatchObject({reviewer: 'claude', available: true})
  })

  it('reviews with the same engine when the named one is the implementer', () => {
    expect(selectServerReviewer('codex', {reviewer: 'codex'})).toMatchObject({reviewer: 'codex', available: true})
  })

  it('keeps the named engine even when it is not available, reported as unavailable', () => {
    expect(selectServerReviewer('claude', {reviewer: 'codex', availability: {codex: false}}))
      .toMatchObject({reviewer: 'codex', available: false})
  })

  it('falls back to the mode without a named reviewer', () => {
    expect(selectServerReviewer('claude', {})).toMatchObject({reviewer: 'codex'})
    expect(selectServerReviewer('claude', {mode: 'same'})).toMatchObject({reviewer: 'claude'})
  })
})
