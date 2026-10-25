import {describe, expect, it} from 'vitest'
import {
  countCycles,
  CycleDecisionSchema,
  DEFAULT_CYCLE_LIMIT,
  evaluateCycle,
  summarizeCycle,
} from '../src/lib/cycle'
import {type ReviewFinding} from '../src/lib/review'
import {type Checkpoint, type RunRecord} from '../src/lib/state'
import {AutomatorError, ErrorCodes} from '../src/errors/error-codes'

// The cycle limit (CYAU-21) prevents a run from consuming resources forever when implementer and
// reviewer do not converge. It is PURE and DETERMINISTIC: counters derived from the persisted checkpoint history
// (they do not reset at restart, CYAU-12) + a gate on the review verdict (CYAU-20) that, after two unapproved
// cycles, requires human intervention. It executes nothing: it decides and composes the summary to keep in the ticket.

function checkpoint(phase: string): Checkpoint {
  return {phase, branch: null, commit: null, worktree: null, dirty: null, artifacts: [], outcome: null, at: '2026-07-12T10:00:00.000Z'}
}

function run(phases: string[]): RunRecord {
  return {run_id: 'r', ticket: 'CYAU-21', repository: 'acme/widget', updated_at: 'x', checkpoints: phases.map(checkpoint)}
}

function finding(severity: ReviewFinding['severity'], extra: Partial<ReviewFinding> = {}): ReviewFinding {
  return {severity, aspect: null, title: `rilievo ${severity}`, detail: null, ...extra}
}

describe('DEFAULT_CYCLE_LIMIT', () => {
  it('the default automatic budget is two cycles (CYAU-21)', () => {
    expect(DEFAULT_CYCLE_LIMIT).toBe(2)
  })
})

describe('countCycles — counters derived from the persisted history (they do not reset at restart)', () => {
  it('missing run → zero attempts and zero cycles', () => {
    expect(countCycles(null)).toEqual({attempts: 0, reviewCycles: 0})
  })

  it('counts the implementation attempts (implementing checkpoints)', () => {
    expect(countCycles(run(['validating', 'ready', 'implementing', 'verifying']))).toEqual({attempts: 1, reviewCycles: 0})
  })

  it('conta i cicli di review (checkpoint reviewing)', () => {
    const r = run(['implementing', 'verifying', 'reviewing', 'implementing', 'verifying', 'reviewing'])
    expect(countCycles(r)).toEqual({attempts: 2, reviewCycles: 2})
  })

  it('ignores the phases that are neither implementing nor reviewing', () => {
    expect(countCycles(run(['validating', 'ready', 'waiting', 'blocked', 'in_review']))).toEqual({attempts: 0, reviewCycles: 0})
  })
})

describe('evaluateCycle — budget gate (DoD: the workflow does not exceed two automatic cycles)', () => {
  it('approved review → advances to in_review, no human intervention', () => {
    const d = evaluateCycle({verdict: 'approved', cycle: 1})
    expect(d.next).toBe('in_review')
    expect(d.requiresHuman).toBe(false)
    expect(d.limitReached).toBe(false)
  })

  it('first cycle with change requests (under the limit) → goes back to implementing', () => {
    const d = evaluateCycle({verdict: 'changes_requested', cycle: 1})
    expect(d.next).toBe('implementing')
    expect(d.requiresHuman).toBe(false)
    expect(d.limitReached).toBe(false)
  })

  it('second unapproved cycle (limit reached) → human intervention, not repeated (Scenario 1)', () => {
    const d = evaluateCycle({verdict: 'changes_requested', cycle: 2})
    expect(d.next).toBe('blocked')
    expect(d.requiresHuman).toBe(true)
    expect(d.limitReached).toBe(true)
  })

  it('beyond the limit (third cycle) it still stays a human intervention', () => {
    const d = evaluateCycle({verdict: 'changes_requested', cycle: 3})
    expect(d.next).toBe('blocked')
    expect(d.limitReached).toBe(true)
    expect(d.requiresHuman).toBe(true)
  })

  it('a blocker finding requires human intervention regardless of the budget (even at the first cycle)', () => {
    const d = evaluateCycle({verdict: 'blocked', cycle: 1})
    expect(d.next).toBe('blocked')
    expect(d.requiresHuman).toBe(true)
    // It is not the cycle limit that stops: it is the blocker finding.
    expect(d.limitReached).toBe(false)
  })

  it('a custom limit moves the threshold (configurable budget)', () => {
    expect(evaluateCycle({verdict: 'changes_requested', cycle: 2, limit: 3}).next).toBe('implementing')
    expect(evaluateCycle({verdict: 'changes_requested', cycle: 3, limit: 3}).next).toBe('blocked')
  })

  it('carries non-empty reasons and mentions the cycle and the limit (explainable routing)', () => {
    const d = evaluateCycle({verdict: 'changes_requested', cycle: 2})
    expect(d.reasons.length).toBeGreaterThan(0)
    expect(d.reasons.join(' ')).toContain('2')
  })

  it('every decision conforms to the auditable schema', () => {
    for (const verdict of ['approved', 'changes_requested', 'blocked'] as const) {
      for (const cycle of [1, 2, 3]) {
        expect(() => CycleDecisionSchema.parse(evaluateCycle({verdict, cycle}))).not.toThrow()
      }
    }
  })

  it('is deterministic: same input → same decision', () => {
    const input = {verdict: 'changes_requested', cycle: 2} as const
    expect(evaluateCycle(input)).toEqual(evaluateCycle(input))
  })
})

describe('evaluateCycle — difesa all’ingresso', () => {
  it('verdetto sconosciuto → C400-CYCLE-001', () => {
    let err: unknown
    try {
      evaluateCycle({verdict: 'rejected' as never, cycle: 1})
    } catch (e) {
      err = e
    }

    expect(err).toBeInstanceOf(AutomatorError)
    expect((err as AutomatorError).code).toBe(ErrorCodes.Cycle.invalidInput)
  })

  it('negative or non-integer cycle → C400-CYCLE-001', () => {
    expect(() => evaluateCycle({verdict: 'approved', cycle: -1})).toThrow(AutomatorError)
    expect(() => evaluateCycle({verdict: 'approved', cycle: 1.5})).toThrow(AutomatorError)
  })

  it('limit not a positive integer → C400-CYCLE-001', () => {
    expect(() => evaluateCycle({verdict: 'approved', cycle: 1, limit: 0})).toThrow(AutomatorError)
    expect(() => evaluateCycle({verdict: 'approved', cycle: 1, limit: -2})).toThrow(AutomatorError)
    expect(() => evaluateCycle({verdict: 'approved', cycle: 1, limit: 1.5})).toThrow(AutomatorError)
  })
})

describe('summarizeCycle — the unresolved findings are kept in the ticket (DoD)', () => {
  it('when the limit is reached, keeps the unresolved findings in the summary', () => {
    const d = evaluateCycle({verdict: 'changes_requested', cycle: 2})
    const findings = [finding('major', {title: 'manca test per il caso N', aspect: 'tests'}), finding('major', {title: 'errore non gestito', aspect: 'diff'})]
    const s = summarizeCycle(d, {ticket: 'CYAU-21', attempts: 2, findings})

    expect(s.limitReached).toBe(true)
    expect(s.requiresHuman).toBe(true)
    expect(s.outstandingFindings).toEqual(findings)
    // The findings stay in the comment text (kept in the ticket).
    expect(s.text).toContain('manca test per il caso N')
    expect(s.text).toContain('errore non gestito')
    expect(s.text).toContain('CYAU-21')
    expect(s.text).toContain('2')
  })

  it('the summary of an approval does not flag human intervention', () => {
    const d = evaluateCycle({verdict: 'approved', cycle: 1})
    const s = summarizeCycle(d, {ticket: 'CYAU-21', attempts: 1, findings: []})
    expect(s.requiresHuman).toBe(false)
    expect(s.limitReached).toBe(false)
    expect(s.outstandingFindings).toEqual([])
  })

  it('a blocker finding is kept in the summary even at the first cycle (without aspect it is formatted anyway)', () => {
    const d = evaluateCycle({verdict: 'blocked', cycle: 1})
    const s = summarizeCycle(d, {ticket: 'CYAU-21', attempts: 1, findings: [finding('blocker', {title: 'requisito ambiguo'})]})
    expect(s.requiresHuman).toBe(true)
    expect(s.text).toContain('requisito ambiguo')
    expect(s.text).toContain('[blocker]')
  })

  it('without ticket and without findings still produces a valid summary', () => {
    const d = evaluateCycle({verdict: 'changes_requested', cycle: 1})
    const s = summarizeCycle(d, {})
    expect(s.ticket).toBeNull()
    expect(s.attempts).toBe(0)
    expect(typeof s.text).toBe('string')
    expect(s.text.length).toBeGreaterThan(0)
  })
})
