import {describe, expect, it} from 'vitest'
import {
  ClarificationDecisionSchema,
  DEFAULT_CLARIFICATION_LIMIT,
  decideClarification,
  MAX_QUESTIONS,
  parseSystemClarificationState,
  type ClarificationStatus,
  readClarificationState,
} from '../src/lib/clarification'
import {AutomatorError, ErrorCodes} from '../src/errors/error-codes'

// Clarification handling without blocking the queue (CYAU-22). An ambiguous ticket can wait for an answer while
// the machine continues with other work: when an indispensable functional decision is missing, a simple
// question is published, the slot is RELEASED and the queue continues; a later answer makes the ticket
// workable again; after TWO cycles without a useful answer it escalates (human intervention needed).
//
// The SYSTEM states the state in the `agent-clarification/v1` contract format (CYAU-189): here the local
// judgement is tested on the cases the bundle does not carry (illegal JSON, extra keys, missing command), while the
// parity with the official examples lives in `contract-agent-clarification.test.ts`. The gate stays pure and
// deterministic: same state → same decision.

function status(over: Partial<ClarificationStatus> = {}): ClarificationStatus {
  return {state: 'ready', cycles: 0, hasReply: false, ...over}
}

describe('DEFAULT_CLARIFICATION_LIMIT', () => {
  it('the default clarification budget is two cycles, then escalation (CYAU-22)', () => {
    expect(DEFAULT_CLARIFICATION_LIMIT).toBe(2)
  })

  it('at most three questions per round (agent-clarification/v1 contract)', () => {
    expect(MAX_QUESTIONS).toBe(3)
  })
})

// ── CYRA-628 / CYAU-189 ───────────────────────────────────────────────────────────────────────────
//
// The SYSTEM knows the state. Reading it from the comments meant guessing it: it was enough for the
// system itself to write any line for it to be read as an answer, and the ticket
// restarted without anyone having answered. The comment fallback — the third hand-made copy
// of the same rule — is gone: when asking fails, we wait.
describe('readClarificationState — the state is asked to the system', () => {
  const reply =(stdout: string, status = 0, stderr = '') => () => ({status, stdout, stderr})
  const waiting = JSON.stringify({data: {state: 'waiting', cycles: 2, has_reply: false, rounds: [{
    cycle: 1, questions: ['Quale ambiente?'], response: null, answered_at: null, created_at: '2026-07-31T09:02:00Z',
  }, {
    cycle: 2, questions: ['E per gli altri ruoli?'], response: null, answered_at: null, created_at: '2026-07-31T10:30:00Z',
  }]}})

  it('queries the system on the requested ticket and project', () => {
    const seen: Array<{cmd: string; args: string[]}> = []
    readClarificationState('CYRA-132', 'CYRA', (cmd, args) => {
      seen.push({cmd, args: [...args]})
      return {status: 0, stdout: waiting, stderr: ''}
    })

    expect(seen).toEqual([{cmd: 'cyi', args: ['tickets', 'clarifications', 'CYRA-132', '-p', 'CYRA', '--json']}])
  })

  it('reads the state the system declares', () => {
    const state = readClarificationState('CYRA-132', 'CYRA', reply(waiting))

    expect(state).toEqual({state: 'waiting', cycles: 2, hasReply: false, source: 'system'})
  })

  // The network failure is not an answer: declaring "all good" here would send a machine to
  // work on a ticket that is waiting for a person.
  it('on a transport error the state is unreadable', () => {
    const state = readClarificationState('CYRA-132', 'CYRA', reply('', 1, 'connessione rifiutata'))

    expect(state).toEqual({state: 'unreadable', cycles: 0, hasReply: false, source: 'unreadable'})
  })

  // CYAU-189 — with the command missing we wait. Falling back on the comments meant keeping locally the
  // copy of the server regex: a machine with the old CLI must update it, not guess.
  it('with the command missing it does NOT fall back on the discussion: the state is unreadable', () => {
    const state = readClarificationState('CYRA-132', 'CYRA', reply('', 127, 'command clarifications not found'))

    expect(state.state).toBe('unreadable')
    expect(state.source).toBe('unreadable')
  })

  it('an answer without the expected shape counts as unreadable, not as "all good"', () => {
    expect(readClarificationState('CYRA-132', 'CYRA', reply('non json')).state).toBe('unreadable')
  })

  it('a state outside the contract counts as unreadable', () => {
    const outside = JSON.stringify({data: {state: 'boh', cycles: 1, has_reply: false, rounds: []}})

    expect(readClarificationState('CYRA-132', 'CYRA', reply(outside)).state).toBe('unreadable')
  })

  it('an unreadable state makes the gate wait, never proceed', () => {
    const state = readClarificationState('CYRA-132', 'CYRA', reply('', 1, 'rete giù'))

    const decision = decideClarification({status: state, needsDecision: false})

    expect(decision.action).toBe('wait')
    expect(decision.workable).toBe(false)
  })
})

// The local judgement on the payload: the parity with the official examples sits in contract-agent-clarification,
// here remain the cases the bundle does not carry.
describe('parseSystemClarificationState — the payload is judged with the contract', () => {
  const ready = {state: 'ready', cycles: 0, has_reply: false, rounds: []}

  it('accepts both the answer wrapped in data and the bare one', () => {
    expect(parseSystemClarificationState(JSON.stringify({data: ready})))
      .toEqual(parseSystemClarificationState(JSON.stringify(ready)))
  })

  it('a key the contract does not provide for makes the answer unreadable', () => {
    // Reading it halfway would mean letting the gate decide on an answer I did not understand.
    expect(parseSystemClarificationState(JSON.stringify({data: {...ready, extra: true}}))).toBeUndefined()
  })

  it('a missing mandatory field makes the answer unreadable', () => {
    expect(parseSystemClarificationState(JSON.stringify({data: {state: 'ready', cycles: 0}}))).toBeUndefined()
  })

  it('illegal, empty or null JSON count as unreadable', () => {
    for (const raw of ['', 'non json', 'null', '[]']) {
      expect(parseSystemClarificationState(raw), raw).toBeUndefined()
    }
  })
})

describe('decideClarification — gate: a waiting ticket does not hold the slot (Scenario 1 / DoD)', () => {
  it('a decision is missing and no question asked yet → ask at cycle 1, not workable (releases the slot)', () => {
    const d = decideClarification({status: status(), needsDecision: true})
    expect(d.action).toBe('ask')
    expect(d.cycle).toBe(1)
    expect(d.workable).toBe(false)
    expect(d.requiresHuman).toBe(false)
    expect(d.phase).toBe('waiting')
    // The reason explicitly mentions the slot release and the queue that continues.
    expect(d.reasons.join(' ').toLowerCase()).toContain('slot')
  })

  it('second round below the limit (one cycle already done) → ask at cycle 2', () => {
    const d = decideClarification({status: status({cycles: 1}), needsDecision: true})
    expect(d.action).toBe('ask')
    expect(d.cycle).toBe(2)
    expect(d.workable).toBe(false)
  })

  it('at the two-cycle limit → escalate, human intervention, do not open a third round (DoD)', () => {
    const d = decideClarification({status: status({cycles: 2}), needsDecision: true})
    expect(d.action).toBe('escalate')
    expect(d.requiresHuman).toBe(true)
    expect(d.workable).toBe(false)
    expect(d.phase).toBe('blocked')
  })

  it('beyond the limit it stays an escalation anyway', () => {
    const d = decideClarification({status: status({cycles: 3}), needsDecision: true})
    expect(d.action).toBe('escalate')
    expect(d.requiresHuman).toBe(true)
  })

  it('a later answer makes the ticket workable again → resume (DoD)', () => {
    const d = decideClarification({status: status({state: 'ready', cycles: 1, hasReply: true}), needsDecision: false})
    expect(d.action).toBe('resume')
    expect(d.workable).toBe(true)
    expect(d.requiresHuman).toBe(false)
    expect(d.phase).toBeNull()
  })

  it('with an answer but a decision is STILL needed → new question (not a silent resume)', () => {
    const d = decideClarification({status: status({state: 'ready', cycles: 1, hasReply: true}), needsDecision: true})
    expect(d.action).toBe('ask')
    expect(d.cycle).toBe(2)
  })

  it('pending question without answer (queue round) → wait: not workable, does not duplicate the question', () => {
    const d = decideClarification({status: status({state: 'waiting', cycles: 1}), needsDecision: false})
    expect(d.action).toBe('wait')
    expect(d.workable).toBe(false)
    expect(d.requiresHuman).toBe(false)
    expect(d.phase).toBe('waiting')
  })

  it('question already pending: even if a decision were needed it does not repeat the question (wait)', () => {
    const d = decideClarification({status: status({state: 'waiting', cycles: 1}), needsDecision: true})
    expect(d.action).toBe('wait')
  })

  it('no clarification at stake and no missing decision → proceed (workable)', () => {
    const d = decideClarification({status: status(), needsDecision: false})
    expect(d.action).toBe('proceed')
    expect(d.workable).toBe(true)
    expect(d.phase).toBeNull()
  })

  it('ticket already escalated → escalate, human intervention (regardless of the missing decision)', () => {
    const d = decideClarification({status: status({state: 'escalated', cycles: 2}), needsDecision: false})
    expect(d.action).toBe('escalate')
    expect(d.requiresHuman).toBe(true)
    expect(d.workable).toBe(false)
  })

  it('a custom limit moves the escalation threshold', () => {
    const under = decideClarification({status: status({cycles: 2}), needsDecision: true, limit: 3})
    expect(under.action).toBe('ask')
    expect(under.cycle).toBe(3)
    const at = decideClarification({status: status({cycles: 3}), needsDecision: true, limit: 3})
    expect(at.action).toBe('escalate')
  })

  it('every decision conforms to the auditable schema', () => {
    const statuses: ClarificationStatus[] = [
      status(),
      status({cycles: 1}),
      status({cycles: 2}),
      status({state: 'waiting', cycles: 1}),
      status({state: 'ready', cycles: 1, hasReply: true}),
      status({state: 'escalated', cycles: 2}),
    ]
    for (const s of statuses) {
      for (const needsDecision of [true, false]) {
        expect(() => ClarificationDecisionSchema.parse(decideClarification({status: s, needsDecision}))).not.toThrow()
      }
    }
  })

  it('is deterministic: same input → same decision', () => {
    const input = {status: status(), needsDecision: true} as const
    expect(decideClarification(input)).toEqual(decideClarification(input))
  })

  it('limit not a positive integer → C400-CLARIFY-001', () => {
    let err: unknown
    try {
      decideClarification({status: status(), needsDecision: true, limit: 0})
    } catch (e) {
      err = e
    }

    expect(err).toBeInstanceOf(AutomatorError)
    expect((err as AutomatorError).code).toBe(ErrorCodes.Clarify.invalidInput)
    expect(() => decideClarification({status: status(), needsDecision: true, limit: 1.5})).toThrow(AutomatorError)
  })
})

