import {describe, expect, it} from 'vitest'
import {
  advancesFlow,
  composeSkillInvocation,
  type FlowClaim,
  FLOW_STEPS,
  isFlowStep,
  isStepDisposition,
  nextStep,
  phaseToStep,
  resolveFlowConcurrency,
  runFlowPool,
  skillCommandForStep,
  STEP_DISPOSITIONS,
  type StepOutcome,
} from '../src/lib/flow-engine'

/** Controlled promise: keeps a step in flight until the test resolves it (like the gates in ticket-cycle.test). */
function deferred<T>(): {promise: Promise<T>; resolve: (value: T) => void} {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((r) => {
    resolve = r
  })
  return {promise, resolve}
}

/** Drains the microtask queue (the pool refill happens entirely in microtasks until the next park). */
const flush = async (): Promise<void> => {
  await new Promise((r) => setTimeout(r, 0))
  await new Promise((r) => setTimeout(r, 0))
}

describe('flow-engine — flow graph', () => {
  it('the steps are the five of the flow, in order', () => {
    expect(FLOW_STEPS).toEqual(['triage', 'plan', 'autopilot', 'closer-staging', 'closer-production'])
  })

  it('skillCommandForStep → /closeyourit-skills:<step>', () => {
    expect(skillCommandForStep('triage')).toBe('/closeyourit-skills:triage')
    expect(skillCommandForStep('closer-production')).toBe('/closeyourit-skills:closer-production')
  })

  it('nextStep follows the sequence and ends on the last one', () => {
    expect(nextStep('triage')).toBe('plan')
    expect(nextStep('plan')).toBe('autopilot')
    expect(nextStep('autopilot')).toBe('closer-staging')
    expect(nextStep('closer-staging')).toBe('closer-production')
    expect(nextStep('closer-production')).toBeNull()
  })

  it('isFlowStep recognises only the known steps', () => {
    expect(isFlowStep('triage')).toBe(true)
    expect(isFlowStep('closer-staging')).toBe(true)
    expect(isFlowStep('deploy')).toBe(false)
    expect(isFlowStep(42)).toBe(false)
  })
})

describe('flow-engine — composeSkillInvocation', () => {
  it('composes command + args (ticket code) + plugin_dir', () => {
    expect(composeSkillInvocation('triage', 'CYRA-132', '/d/skills/v1/closeyourit-skills')).toEqual({
      command: '/closeyourit-skills:triage',
      args: 'CYRA-132',
      plugin_dir: '/d/skills/v1/closeyourit-skills',
    })
  })

  it('rejects an unsafe ticket code (it ends up in the -p prompt)', () => {
    expect(() => composeSkillInvocation('triage', '../evil', '/d')).toThrow(/non sicuro/)
    expect(() => composeSkillInvocation('triage', 'a b', '/d')).toThrow(/non sicuro/)
  })

  it('rejects an unknown step and a missing plugin_dir', () => {
    expect(() => composeSkillInvocation('deploy' as never, 'CYRA-1', '/d')).toThrow(/step/)
    expect(() => composeSkillInvocation('triage', 'CYRA-1', '')).toThrow(/plugin_dir/)
  })
})

describe('flow-engine — phaseToStep', () => {
  it('maps the 5 execution_phases (vocabulary A) to the flow step (C)', () => {
    // Host-first (CYAU-87, Option A): the candidate carries the authoritative execution_phase, keyed directly
    // (no longer vocabulary B `*_queued`). The 5 phases are all mapped: the host runs each phase in sequence.
    expect(phaseToStep('triage')).toBe('triage')
    expect(phaseToStep('planner')).toBe('plan')
    expect(phaseToStep('autopilot')).toBe('autopilot')
    expect(phaseToStep('closer_staging')).toBe('closer-staging')
    expect(phaseToStep('closer_production')).toBe('closer-production')
  })

  it('fail-closed on vocabulary B (*_queued) and non-executable FSM states', () => {
    expect(phaseToStep('triage_queued')).toBeNull() // vocabulary B is no longer the key (Option A)
    expect(phaseToStep('autopilot_queued')).toBeNull()
    expect(phaseToStep('planning')).toBeNull()
    expect(phaseToStep('review_blocked')).toBeNull()
    expect(phaseToStep('')).toBeNull()
    expect(phaseToStep(undefined)).toBeNull()
    expect(phaseToStep(42)).toBeNull()
  })

  it('does not resolve inherited prototype keys (constructor/toString)', () => {
    expect(phaseToStep('constructor')).toBeNull()
    expect(phaseToStep('toString')).toBeNull()
  })
})

describe('flow-engine — step dispositions (C.4)', () => {
  it('STEP_DISPOSITIONS lists the known outcomes in the expected order', () => {
    expect(STEP_DISPOSITIONS).toEqual(['advanced', 'waiting', 'blocked', 'failed'])
  })

  it('isStepDisposition recognises only the known outcomes', () => {
    expect(isStepDisposition('advanced')).toBe(true)
    expect(isStepDisposition('waiting')).toBe(true)
    expect(isStepDisposition('done')).toBe(false)
    expect(isStepDisposition(1)).toBe(false)
  })

  it('advancesFlow is true only for advanced (handoff); waiting/blocked/failed stop or park', () => {
    expect(advancesFlow('advanced')).toBe(true)
    expect(advancesFlow('waiting')).toBe(false)
    expect(advancesFlow('blocked')).toBe(false)
    expect(advancesFlow('failed')).toBe(false)
  })
})

describe('flow-engine — resolveFlowConcurrency (C.4)', () => {
  it('undefined → serial fallback (1 by default), never unlimited', () => {
    expect(resolveFlowConcurrency(undefined)).toBe(1)
    expect(resolveFlowConcurrency(undefined, 3)).toBe(3)
  })

  it('an explicit cap is respected; 0 = no slot', () => {
    expect(resolveFlowConcurrency(2)).toBe(2)
    expect(resolveFlowConcurrency(0)).toBe(0)
  })

  it('fail-closed on invalid cap or fallback (corrupted policy)', () => {
    expect(() => resolveFlowConcurrency(-1)).toThrow(/max_parallel/)
    expect(() => resolveFlowConcurrency(1.5)).toThrow(/max_parallel/)
    expect(() => resolveFlowConcurrency(undefined, 0)).toThrow(/fallback/)
  })
})

describe('flow-engine — runFlowPool: per-step concurrency (C.4)', () => {
  it('DoD: the max_parallel cap is never exceeded (bounded concurrent slots)', async () => {
    const codes = ['CYRA-1', 'CYRA-2', 'CYRA-3', 'CYRA-4']
    const gates = new Map<string, ReturnType<typeof deferred<StepOutcome>>>()
    const started: string[] = []
    const occupancies: number[] = []
    let i = 0

    const done = runFlowPool({
      maxParallel: 2,
      claimNext: () => (i < codes.length ? {ticketCode: codes[i++], step: 'autopilot'} : null),
      runStep: (claim) => {
        started.push(claim.ticketCode)
        const gate = deferred<StepOutcome>()
        gates.set(claim.ticketCode, gate)
        return gate.promise
      },
      onOccupancyChange: (n) => occupancies.push(n),
    })

    await flush()
    // With only two slots, ONLY the first two steps start: the 3rd and 4th wait for a slot to free up.
    expect(started).toEqual(['CYRA-1', 'CYRA-2'])

    gates.get('CYRA-1')!.resolve({disposition: 'advanced'})
    await flush()
    // With ONE slot freed → the 3rd starts, not the 4th too: the cap stays 2.
    expect(started).toEqual(['CYRA-1', 'CYRA-2', 'CYRA-3'])

    gates.get('CYRA-2')!.resolve({disposition: 'advanced'})
    await flush()
    expect(started).toEqual(['CYRA-1', 'CYRA-2', 'CYRA-3', 'CYRA-4'])

    gates.get('CYRA-3')!.resolve({disposition: 'advanced'})
    gates.get('CYRA-4')!.resolve({disposition: 'advanced'})
    const result = await done

    expect(result.claimed).toBe(4)
    expect(result.maxConcurrent).toBe(2) // reaches the cap (real concurrency) ...
    expect(Math.max(...occupancies)).toBe(2) // ... and NEVER exceeds it
  })

  it('DoD: after triage the engine claims a 2nd ticket (the handoff frees the slot)', async () => {
    const claims: FlowClaim[] = [
      {ticketCode: 'CYRA-10', step: 'triage'},
      {ticketCode: 'CYRA-11', step: 'triage'},
    ]
    let i = 0
    const seen: string[] = []

    // ONE slot only: the 2nd claim can start ONLY if the triage of the 1st freed the slot.
    const result = await runFlowPool({
      maxParallel: 1,
      claimNext: () => (i < claims.length ? claims[i++] : null),
      runStep: (claim) => {
        seen.push(claim.ticketCode)
        return {disposition: 'advanced', nextStep: nextStep(claim.step)}
      },
    })

    expect(seen).toEqual(['CYRA-10', 'CYRA-11']) // the 2nd claim happened AFTER the triage of the 1st
    expect(result.claimed).toBe(2)
    expect(result.maxConcurrent).toBe(1) // never more than one slot
    expect(result.entries[0].outcome.disposition).toBe('advanced')
    expect(result.entries[0].outcome.nextStep).toBe('plan') // triage → plan (handoff non bloccante)
  })

  it('DoD: a waiting plan does not occupy a slot while another flow starts', async () => {
    const claims: FlowClaim[] = [
      {ticketCode: 'CYRA-20', step: 'plan'}, // waits for the CTO → waiting
      {ticketCode: 'CYRA-21', step: 'triage'}, // another flow that must be able to start
    ]
    let i = 0
    const seen: string[] = []
    const planGate = deferred<StepOutcome>()

    // ONE slot only: if the waiting plan kept it occupied, CYRA-21 would NEVER start.
    const done = runFlowPool({
      maxParallel: 1,
      claimNext: () => (i < claims.length ? claims[i++] : null),
      runStep: (claim) => {
        seen.push(claim.ticketCode)
        return claim.step === 'plan' ? planGate.promise : {disposition: 'advanced'}
      },
    })

    await flush()
    // The plan is in flight (waiting for the CTO): it occupies the only slot but is not resolved yet → CYRA-21 has not started.
    expect(seen).toEqual(['CYRA-20'])

    // The plan resolves to WAITING: it releases the slot (clarification pattern), without advancing the flow.
    planGate.resolve({disposition: 'waiting'})
    await flush()
    // With the only slot now free, the other flow starts: the waiting did not keep the slot occupied.
    expect(seen).toEqual(['CYRA-20', 'CYRA-21'])

    const result = await done
    expect(result.maxConcurrent).toBe(1) // never more than one slot occupied at the same time
    expect(result.entries.find((e) => e.claim.ticketCode === 'CYRA-20')!.outcome.disposition).toBe('waiting')
    expect(result.claimed).toBe(2)
  })

  it('empty queue (claimNext=null) drains without working any step', async () => {
    const result = await runFlowPool({
      maxParallel: 2,
      claimNext: () => null,
      runStep: () => {
        throw new Error('runStep non deve mai essere invocato a coda vuota')
      },
    })
    expect(result.claimed).toBe(0)
    expect(result.entries).toEqual([])
    expect(result.maxConcurrent).toBe(0)
  })

  it('cap 0 admits no claim (all slots closed)', async () => {
    let claimCalls = 0
    const result = await runFlowPool({
      maxParallel: 0,
      claimNext: () => {
        claimCalls++
        return {ticketCode: 'CYRA-30', step: 'triage'}
      },
      runStep: () => ({disposition: 'advanced'}),
    })
    expect(result.claimed).toBe(0)
    expect(claimCalls).toBe(0) // draining right away: it does not even try to take a claim
  })

  it('a runStep error becomes a failed disposition and does not bring down the pool', async () => {
    const claims: FlowClaim[] = [
      {ticketCode: 'CYRA-40', step: 'autopilot'},
      {ticketCode: 'CYRA-41', step: 'triage'},
    ]
    let i = 0

    const result = await runFlowPool({
      maxParallel: 1,
      claimNext: () => (i < claims.length ? claims[i++] : null),
      runStep: (claim) => {
        if (claim.ticketCode === 'CYRA-40') throw new Error('skill esplosa')
        return {disposition: 'advanced'}
      },
    })

    expect(result.claimed).toBe(2) // the pool continued with the 2nd after the failure of the 1st
    const failed = result.entries.find((e) => e.claim.ticketCode === 'CYRA-40')!
    expect(failed.outcome.disposition).toBe('failed')
    expect(failed.outcome.detail).toContain('skill esplosa')
  })

  it('a claimNext error stops admission but lets the in-flight steps finish', async () => {
    const gate = deferred<StepOutcome>()
    let calls = 0

    const done = runFlowPool({
      maxParallel: 2,
      claimNext: () => {
        calls++
        if (calls === 1) return {ticketCode: 'CYRA-50', step: 'autopilot'}
        throw new Error('coda irraggiungibile')
      },
      runStep: () => gate.promise,
    })

    await flush()
    // The 1st claim is in flight; the 2nd claim attempt throws → the pool stops admitting but does not abandon the active one.
    gate.resolve({disposition: 'advanced'})
    const result = await done

    expect(result.claimError).toContain('coda irraggiungibile')
    expect(result.claimed).toBe(1)
    expect(result.entries[0].claim.ticketCode).toBe('CYRA-50')
    expect(result.entries[0].outcome.disposition).toBe('advanced')
  })
})
