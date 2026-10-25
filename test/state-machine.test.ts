import {describe, expect, it} from 'vitest'
import {
  type CyiStatus,
  INITIAL_PHASE,
  isRunPhase,
  latestRunPhase,
  planTransition,
  RUN_PHASES,
  runPhaseToCyiStatus,
  type RunPhase,
  TRANSITIONS,
  canTransition,
} from '../src/lib/state-machine'
import {type Checkpoint, type RunRecord} from '../src/lib/state'

function checkpoint(phase: string): Checkpoint {
  return {phase, branch: null, commit: null, worktree: null, dirty: null, artifacts: [], outcome: null, at: '2026-07-12T10:00:00.000Z'}
}

function run(phases: string[]): RunRecord {
  return {run_id: 'r', ticket: 'CYAU-16', repository: null, updated_at: 'x', checkpoints: phases.map(checkpoint)}
}

describe('RUN_PHASES / isRunPhase', () => {
  it('exposes the nine run states', () => {
    expect(RUN_PHASES).toEqual([
      'validating', 'ready', 'implementing', 'verifying', 'reviewing', 'waiting', 'blocked', 'in_review', 'completed',
    ])
  })

  it('the initial phase (ticket acquired) is validating', () => {
    expect(INITIAL_PHASE).toBe('validating')
  })

  it('recognizes the valid states and rejects unknown / non-string ones', () => {
    for (const p of RUN_PHASES) expect(isRunPhase(p)).toBe(true)
    expect(isRunPhase('implement')).toBe(false) // legacy granular phase, not a machine state
    expect(isRunPhase('')).toBe(false)
    expect(isRunPhase(42)).toBe(false)
    expect(isRunPhase(null)).toBe(false)
  })
})

describe('runPhaseToCyiStatus (separation of run state / CYI status)', () => {
  it('the active run states map to in_progress', () => {
    const inProgress: RunPhase[] = ['validating', 'ready', 'implementing', 'verifying', 'reviewing', 'waiting', 'blocked']
    for (const p of inProgress) expect(runPhaseToCyiStatus(p)).toBe('in_progress')
  })

  it('in_review and completed map to in_review (the automator does not close: human review)', () => {
    expect(runPhaseToCyiStatus('in_review')).toBe('in_review')
    expect(runPhaseToCyiStatus('completed')).toBe('in_review')
  })

  it('every state has a defined CYI mapping', () => {
    for (const p of RUN_PHASES) {
      const status: CyiStatus = runPhaseToCyiStatus(p)
      expect(['in_progress', 'in_review']).toContain(status)
    }
  })
})

describe('canTransition', () => {
  it('the self-transition is always allowed (idempotence)', () => {
    for (const p of RUN_PHASES) expect(canTransition(p, p)).toBe(true)
  })

  it('every edge declared in TRANSITIONS is allowed and is a valid phase transition (DoD: valid transitions tested)', () => {
    for (const from of RUN_PHASES) {
      for (const to of TRANSITIONS[from]) {
        expect(canTransition(from, to)).toBe(true)
        const plan = planTransition(from, to)
        expect(plan.allowed).toBe(true)
        expect(plan.phaseChanged).toBe(true)
      }
    }
  })

  it('allows the happy flow validating → … → completed', () => {
    expect(canTransition('validating', 'ready')).toBe(true)
    expect(canTransition('ready', 'implementing')).toBe(true)
    expect(canTransition('implementing', 'verifying')).toBe(true)
    expect(canTransition('verifying', 'reviewing')).toBe(true)
    expect(canTransition('reviewing', 'in_review')).toBe(true)
    expect(canTransition('in_review', 'completed')).toBe(true)
  })

  it('allows going back on failure (verify/review → implementing)', () => {
    expect(canTransition('verifying', 'implementing')).toBe(true)
    expect(canTransition('reviewing', 'implementing')).toBe(true)
    expect(canTransition('in_review', 'implementing')).toBe(true)
  })

  it('rejects phase jumps and exits from a terminal state', () => {
    expect(canTransition('validating', 'completed')).toBe(false)
    expect(canTransition('implementing', 'reviewing')).toBe(false) // salta verifying
    expect(canTransition('ready', 'in_review')).toBe(false)
    expect(canTransition('completed', 'implementing')).toBe(false) // terminale
    expect(canTransition('completed', 'reviewing')).toBe(false)
  })
})

describe('planTransition — ingresso (ticket acquisito)', () => {
  it('from no phase only entering the initial phase (validating) is allowed', () => {
    const plan = planTransition(null, 'validating')
    expect(plan).toMatchObject({from: null, to: 'validating', allowed: true, phaseChanged: true, cyiStatus: 'in_progress', cyiStatusChanged: true})
  })

  it('from no phase one cannot enter in the middle of the flow', () => {
    const plan = planTransition(null, 'implementing')
    expect(plan.allowed).toBe(false)
    expect(plan.phaseChanged).toBe(false)
    expect(plan.cyiStatusChanged).toBe(false)
  })
})

describe('planTransition — idempotency (retry / restart do not duplicate external effects)', () => {
  it('re-applying the same phase is allowed but changes nothing (no external effect)', () => {
    for (const p of RUN_PHASES) {
      const plan = planTransition(p, p)
      expect(plan.allowed).toBe(true)
      expect(plan.phaseChanged).toBe(false)
      expect(plan.cyiStatusChanged).toBe(false)
    }
  })

  it('advancing between two states with the same CYI status changes the phase but NOT the external status', () => {
    // in_review → completed: both map to in_review → the ticket status must not be re-applied.
    const plan = planTransition('in_review', 'completed')
    expect(plan.allowed).toBe(true)
    expect(plan.phaseChanged).toBe(true)
    expect(plan.cyiStatus).toBe('in_review')
    expect(plan.cyiStatusChanged).toBe(false)
  })
})

describe('planTransition — cambio di stato CYI (effetto esterno)', () => {
  it('reviewing → in_review promotes the ticket to in_review (external effect to apply)', () => {
    const plan = planTransition('reviewing', 'in_review')
    expect(plan.allowed).toBe(true)
    expect(plan.cyiStatus).toBe('in_review')
    expect(plan.cyiStatusChanged).toBe(true)
  })

  it('a disallowed transition changes neither phase nor CYI status', () => {
    // `validating → completed` stays forbidden: all the work would be skipped.
    const plan = planTransition('validating', 'completed')
    expect(plan.allowed).toBe(false)
    expect(plan.phaseChanged).toBe(false)
    expect(plan.cyiStatusChanged).toBe(false)
  })

  // CYAU-181 — runtime finished does not mean delivery accepted: forbids the premature terminal.
  it('implementing → completed is forbidden until CI, review and server have passed', () => {
    expect(planTransition('implementing', 'completed').allowed).toBe(false)
  })
})

describe('latestRunPhase', () => {
  it('run null → null', () => {
    expect(latestRunPhase(null)).toBeNull()
  })

  it('returns the last valid phase of the state machine', () => {
    expect(latestRunPhase(run(['validating', 'ready', 'implementing']))).toBe('implementing')
  })

  it('ignores the legacy granular phases and returns the last known phase', () => {
    expect(latestRunPhase(run(['validating', 'implement', 'test']))).toBe('validating')
  })

  it('no known phase (only legacy checkpoints) → null', () => {
    expect(latestRunPhase(run(['setup', 'implement', 'commit']))).toBeNull()
  })
})
