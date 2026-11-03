import {afterEach, beforeEach, describe, expect, it} from 'vitest'
import Canary, {CANARY_OBSERVER_TOKEN_ENV, CANARY_TOKEN_ENV} from '../src/commands/canary'
import {type ApiResponse, type CanaryClock, type CanaryServer, CODE_PHASE, PERMISSION_DENIED_CODE, PLAN_PHASE} from '../src/lib/canary'
import {runCaptured, runExpectingExit} from './helpers/command'

// The `canary` command (CYAU-205): keys only from the environment (cyi run), exit 0 at staging, exit 1 on
// a stop with alert, exit 4 when the decoy approval is accepted, exit 2 on invalid input. Fake servers.

const COLLAUDO = 'cyi_u_collaudo0123456789abcdef'
const OBSERVER = 'cyi_u_observer0123456789abcdef'

let decoyAnswer: ApiResponse = {status: 403, code: PERMISSION_DENIED_CODE}
let stalled = false
let madeWith: {apiUrl: string; collaudo: string; observer: string} | null = null

function fakeServer(): CanaryServer {
  const phases = ['triage', PLAN_PHASE, CODE_PHASE, 'staging']
  let step = 0
  return {
    async createTicket() {
      return {ok: true, code: 'SBX-7'}
    },
    async readAutomation(project) {
      if (project === 'DECOY') return {ok: true, view: {code: 'DECOY-1', project: 'DECOY', phase: PLAN_PHASE, reviewGate: true, stagingVerified: false}}
      const phase = phases[step]
      if (!stalled && step < phases.length - 1) step++
      return {ok: true, view: {code: 'SBX-7', project: 'SBX', phase, reviewGate: phase === CODE_PHASE, stagingVerified: phase === 'staging'}}
    },
    async approve(_kind, project) {
      return project === 'DECOY' ? decoyAnswer : {status: 200}
    },
  }
}

class TestCanary extends Canary {
  protected makeServers(apiUrl: string, collaudo: string, observer: string): {collaudo: CanaryServer; observer: CanaryServer} {
    madeWith = {apiUrl, collaudo, observer}
    const server = fakeServer()
    return {collaudo: server, observer: server}
  }

  protected clock(): CanaryClock {
    let now = Date.parse('2026-11-02T01:00:00Z')
    return {now: () => now, sleep: async (ms) => {
      now += ms
    }}
  }
}

const argv = ['--sandbox-project', 'SBX', '--decoy-project', 'DECOY', '--decoy-ticket', 'DECOY-1', '--deadline-minutes', '30']

describe('canary command', () => {
  const saved = {collaudo: process.env[CANARY_TOKEN_ENV], observer: process.env[CANARY_OBSERVER_TOKEN_ENV]}

  beforeEach(() => {
    process.env[CANARY_TOKEN_ENV] = COLLAUDO
    process.env[CANARY_OBSERVER_TOKEN_ENV] = OBSERVER
    decoyAnswer = {status: 403, code: PERMISSION_DENIED_CODE}
    stalled = false
    madeWith = null
  })

  afterEach(() => {
    for (const [name, value] of [[CANARY_TOKEN_ENV, saved.collaudo], [CANARY_OBSERVER_TOKEN_ENV, saved.observer]] as const) {
      if (value === undefined) delete process.env[name]
      else process.env[name] = value
    }
  })

  it('reaches staging and exits 0 with the keys taken from the environment', async () => {
    const {result, stdout} = await runCaptured(TestCanary, argv)

    expect(result).toMatchObject({ok: true, ticket: 'SBX-7', approved: ['plan', 'code']})
    expect(stdout).toContain('SBX-7 reached staging')
    expect(madeWith).toEqual({apiUrl: 'https://app.closeyour.it', collaudo: COLLAUDO, observer: OBSERVER})
  })

  it('exits 1 with stage and reason when the night stalls past the deadline', async () => {
    stalled = true
    const {message} = await runExpectingExit(TestCanary, argv, 1)

    expect(message).toContain('C504-CANARY-002')
    expect(message).toContain('stage deadline, phase triage')
  })

  it('exits 4 and asks to revoke the key when the decoy approval is accepted', async () => {
    decoyAnswer = {status: 200}
    const {message} = await runExpectingExit(TestCanary, argv, 4)

    expect(message).toContain('C403-CANARY-003')
    expect(message).toContain('revoke the collaudo key')
  })

  it('exits 1 when the decoy refuses for another reason', async () => {
    decoyAnswer = {status: 422, code: 'R422-TICKET-006'}
    const {message} = await runExpectingExit(TestCanary, argv, 1)

    expect(message).toContain('stage boundary')
  })

  it('refuses to start without a user token in the environment', async () => {
    delete process.env[CANARY_TOKEN_ENV]
    const {message} = await runExpectingExit(TestCanary, argv, 2)

    expect(message).toContain(`${CANARY_TOKEN_ENV} is missing`)
    expect(madeWith).toBeNull()
  })

  it('refuses the same identity as collaudo and observer', async () => {
    process.env[CANARY_OBSERVER_TOKEN_ENV] = COLLAUDO
    await runExpectingExit(TestCanary, argv, 2)
    expect(madeWith).toBeNull()
  })

  it.each([
    [['--sandbox-project', 'SBX', '--decoy-project', 'SBX', '--decoy-ticket', 'SBX-1'], 'outside the Sandbox'],
    [['--sandbox-project', 'SBX', '--decoy-project', 'DECOY', '--decoy-ticket', 'OTHER-1'], 'a ticket of DECOY'],
    [['--sandbox-project', 'sb/x', '--decoy-project', 'DECOY', '--decoy-ticket', 'DECOY-1'], 'project keys'],
    [['--sandbox-project', 'SBX', '--decoy-project', 'DECOY', '--decoy-ticket', 'DECOY-1', '--poll-seconds', '0'], 'positive'],
  ])('rejects invalid input %j', async (args, expected) => {
    const {message} = await runExpectingExit(TestCanary, args, 2)
    expect(message).toContain(expected)
  })
})
