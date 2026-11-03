import {describe, expect, it} from 'vitest'
import {
  type ApiResponse,
  type ApprovalKind,
  type AutomationView,
  CANARY_PATHS,
  type CanaryClock,
  type CanaryConfig,
  type CanaryServer,
  classifyBoundaryProbe,
  CODE_PHASE,
  decoyAccepts,
  formatCanaryAlert,
  HIDDEN_RESOURCE_CODE,
  makeCanaryServer,
  parseAutomationView,
  PERMISSION_DENIED_CODE,
  PLAN_PHASE,
  runCanary,
} from '../src/lib/canary'

// Nightly canary (CYAU-205): the engine decides between success, a valid denial on the decoy and a stop
// with alert. The fake world below plays the Sandbox workflow, the decoy and the clock; nothing reaches
// a real server.

const NIGHT_MS = Date.parse('2026-11-02T01:00:00Z')

const config: CanaryConfig = {
  sandboxProject: 'SBX',
  decoyProject: 'DECOY',
  decoyTicket: 'DECOY-1',
  deadlineMs: 60 * 60_000,
  pollMs: 60_000,
  hiddenDecoyCountsAsDenial: false,
}

const denied: ApiResponse = {status: 403, code: PERMISSION_DENIED_CODE}
const accepted: ApiResponse = {status: 200, body: {data: {}}}

interface WorldOptions {
  /** The phases the night's ticket goes through; each read advances one step unless stalled. */
  phases?: Array<string | 'staging'>
  /** The workflow never moves past this index: a disconnected model. */
  stallAt?: number
  decoy?: Partial<AutomationView> | 'unreadable'
  decoyAnswer?: (kind: ApprovalKind) => ApiResponse
  approvalAnswer?: ApiResponse
  createAnswer?: {ok: true; code: string} | {ok: false; response: ApiResponse}
  readAs?: {code: string; project: string}
}

function world(options: WorldOptions = {}) {
  const phases = options.phases ?? ['triage', PLAN_PHASE, 'autopilot', CODE_PHASE, 'closer_staging', 'staging']
  let step = 0
  let now = NIGHT_MS
  const calls: string[] = []
  const created = options.createAnswer ?? {ok: true as const, code: 'SBX-7'}

  const advance = (): void => {
    if (options.stallAt !== undefined && step >= options.stallAt) return
    if (phases[step] === PLAN_PHASE && !calls.includes('collaudo approve plan SBX/SBX-7')) return
    if (phases[step] === CODE_PHASE && !calls.includes('collaudo approve code SBX/SBX-7')) return
    if (step < phases.length - 1) step++
  }

  const sandboxView = (): AutomationView => {
    const phase = phases[step]
    return {
      code: options.readAs?.code ?? 'SBX-7',
      project: options.readAs?.project ?? 'SBX',
      phase: phase === 'staging' ? 'closer_production' : phase,
      reviewGate: phase === CODE_PHASE,
      stagingVerified: phase === 'staging',
    }
  }

  const decoyView = (): AutomationView => ({
    code: 'DECOY-1',
    project: 'DECOY',
    phase: PLAN_PHASE,
    reviewGate: true,
    stagingVerified: false,
    ...(options.decoy === 'unreadable' ? {} : options.decoy),
  })

  const server = (who: 'collaudo' | 'observer'): CanaryServer => ({
    async createTicket(project, title) {
      calls.push(`${who} create ${project} ${title}`)
      return created
    },
    async readAutomation(project, ticket) {
      calls.push(`${who} read ${project}/${ticket}`)
      if (project === 'DECOY') {
        if (options.decoy === 'unreadable') return {ok: false, response: {status: 404, code: HIDDEN_RESOURCE_CODE}}
        return {ok: true, view: decoyView()}
      }
      const view = sandboxView()
      advance()
      return {ok: true, view}
    },
    async approve(kind, project, ticket) {
      calls.push(`${who} approve ${kind} ${project}/${ticket}`)
      if (project === 'DECOY') return (options.decoyAnswer ?? (() => denied))(kind)
      return options.approvalAnswer ?? accepted
    },
  })

  const clock: CanaryClock = {
    now: () => now,
    sleep: async (ms) => {
      now += ms
    },
  }

  return {calls, clock, collaudo: server('collaudo'), observer: server('observer'), elapsed: () => now - NIGHT_MS}
}

const approvals = (calls: string[]): string[] => calls.filter((call) => call.includes(' approve '))

describe('classifyBoundaryProbe', () => {
  it('counts only a permission denial as proof of the boundary', () => {
    expect(classifyBoundaryProbe(denied, false)).toEqual({outcome: 'denied'})
  })

  it('treats an accepted decoy approval as a breach', () => {
    for (const status of [200, 201, 204]) {
      expect(classifyBoundaryProbe({status}, false).outcome).toBe('breach')
    }
  })

  it.each([
    ['a state error', {status: 422, code: 'R422-TICKET-006'}],
    ['a conflict', {status: 409, code: 'R409-TICKET-022'}],
    ['an approver that is not a person', {status: 403, code: 'R403-TICKET-021'}],
    ['a forbidden answer without a code', {status: 403}],
    ['an invalid request', {status: 400, code: 'R422-SYSTEM-002'}],
    ['an expired key', {status: 401, code: 'R401-CLIAUTH-002'}],
    ['an internal error', {status: 500}],
    ['no answer', {status: 0, code: 'network'}],
  ])('does not count %s as a permission denial', (_label, response) => {
    expect(classifyBoundaryProbe(response as ApiResponse, true).outcome).toBe('inconclusive')
  })

  it('counts a hidden decoy only when a person opted in', () => {
    const hidden: ApiResponse = {status: 404, code: HIDDEN_RESOURCE_CODE}
    expect(classifyBoundaryProbe(hidden, false).outcome).toBe('inconclusive')
    expect(classifyBoundaryProbe(hidden, true)).toEqual({outcome: 'denied'})
    expect(classifyBoundaryProbe({status: 404, code: 'R404-OTHER-001'}, true).outcome).toBe('inconclusive')
  })
})

describe('decoyAccepts', () => {
  const view: AutomationView = {code: 'DECOY-1', project: 'DECOY', phase: PLAN_PHASE, reviewGate: false, stagingVerified: false}

  it('needs a plan waiting for the plan probe and a review gate for the code probe', () => {
    expect(decoyAccepts('plan', view)).toBe(true)
    expect(decoyAccepts('code', view)).toBe(false)
    expect(decoyAccepts('plan', {...view, phase: 'autopilot'})).toBe(false)
    expect(decoyAccepts('code', {...view, reviewGate: true})).toBe(true)
  })
})

describe('runCanary', () => {
  it('creates the night ticket, approves plan and code and reaches staging without alert', async () => {
    const w = world()
    const report = await runCanary(config, w.collaudo, w.observer, w.clock)

    expect(report).toMatchObject({ok: true, night: '2026-11-02', ticket: 'SBX-7', approved: ['plan', 'code'], boundaryChecks: 2, alert: null})
    expect(w.calls[0]).toBe('collaudo create SBX Nightly canary 2026-11-02')
    expect(approvals(w.calls)).toEqual([
      'collaudo approve plan DECOY/DECOY-1',
      'collaudo approve plan SBX/SBX-7',
      'collaudo approve code DECOY/DECOY-1',
      'collaudo approve code SBX/SBX-7',
    ])
  })

  it('reads the decoy only through the observer, right before each probe', async () => {
    const w = world()
    await runCanary(config, w.collaudo, w.observer, w.clock)

    expect(w.calls.filter((call) => call.includes('DECOY/DECOY-1') && call.includes(' read '))).toEqual([
      'observer read DECOY/DECOY-1',
      'observer read DECOY/DECOY-1',
    ])
    const firstProbe = w.calls.indexOf('collaudo approve plan DECOY/DECOY-1')
    expect(w.calls[firstProbe - 1]).toBe('observer read DECOY/DECOY-1')
  })

  it('approves only the ticket created that night', async () => {
    const w = world()
    await runCanary(config, w.collaudo, w.observer, w.clock)

    const sandboxApprovals = approvals(w.calls).filter((call) => call.includes('SBX/'))
    expect(sandboxApprovals.every((call) => call.endsWith('SBX/SBX-7'))).toBe(true)
  })

  it('stops when the server answers for another ticket than the night one', async () => {
    const w = world({readAs: {code: 'SBX-3', project: 'SBX'}})
    const report = await runCanary(config, w.collaudo, w.observer, w.clock)

    expect(report.alert).toMatchObject({stage: 'read', urgent: false})
    expect(approvals(w.calls)).toEqual([])
  })

  it('stops when the created ticket is not on the Sandbox project', async () => {
    const w = world({createAnswer: {ok: true, code: 'CYAU-9'}})
    const report = await runCanary(config, w.collaudo, w.observer, w.clock)

    expect(report.alert).toMatchObject({stage: 'create', ticket: 'CYAU-9'})
    expect(approvals(w.calls)).toEqual([])
  })

  it('alerts when the ticket cannot be created', async () => {
    const w = world({createAnswer: {ok: false, response: {status: 401, code: 'R401-CLIAUTH-001'}}})
    const report = await runCanary(config, w.collaudo, w.observer, w.clock)

    expect(report.alert).toMatchObject({stage: 'create', ticket: null})
    expect(report.alert?.reason).toContain('R401-CLIAUTH-001')
  })

  it('does not attempt the probe and approves nothing when the decoy does not accept approvals', async () => {
    const w = world({decoy: {phase: 'autopilot', reviewGate: false}})
    const report = await runCanary(config, w.collaudo, w.observer, w.clock)

    expect(report.alert).toMatchObject({stage: 'decoy', urgent: false, workflowPhase: PLAN_PHASE})
    expect(report.boundaryChecks).toBe(0)
    expect(approvals(w.calls)).toEqual([])
  })

  it('does not attempt the probe when the observer cannot read the decoy', async () => {
    const w = world({decoy: 'unreadable'})
    const report = await runCanary(config, w.collaudo, w.observer, w.clock)

    expect(report.alert?.stage).toBe('decoy')
    expect(approvals(w.calls)).toEqual([])
  })

  it('stops at the code step when the decoy is no longer under review', async () => {
    const w = world({decoy: {reviewGate: false}})
    const report = await runCanary(config, w.collaudo, w.observer, w.clock)

    expect(report.approved).toEqual(['plan'])
    expect(report.alert).toMatchObject({stage: 'decoy', workflowPhase: CODE_PHASE})
    expect(approvals(w.calls)).not.toContain('collaudo approve code SBX/SBX-7')
  })

  it.each([
    ['a state error', {status: 422, code: 'R422-TICKET-006'}],
    ['an invalid request', {status: 400, code: 'R422-SYSTEM-002'}],
    ['an internal error', {status: 500}],
  ])('stops the approvals when the decoy refusal is %s', async (_label, answer) => {
    const w = world({decoyAnswer: () => answer as ApiResponse})
    const report = await runCanary(config, w.collaudo, w.observer, w.clock)

    expect(report.ok).toBe(false)
    expect(report.alert).toMatchObject({stage: 'boundary', urgent: false})
    expect(report.alert?.reason).toContain(String((answer as ApiResponse).status))
    expect(approvals(w.calls)).toEqual(['collaudo approve plan DECOY/DECOY-1'])
  })

  it('stops at once with an urgent alert when the decoy approval is accepted', async () => {
    const w = world({decoyAnswer: () => accepted})
    const report = await runCanary(config, w.collaudo, w.observer, w.clock)

    expect(report.alert).toMatchObject({stage: 'boundary', urgent: true})
    expect(report.alert?.reason).toContain('revoke')
    expect(formatCanaryAlert(report)).toMatch(/^URGENT canary alert/)
    expect(approvals(w.calls)).toEqual(['collaudo approve plan DECOY/DECOY-1'])
  })

  it('stops the code step when the second probe is accepted, after a valid first one', async () => {
    const w = world({decoyAnswer: (kind) => (kind === 'code' ? accepted : denied)})
    const report = await runCanary(config, w.collaudo, w.observer, w.clock)

    expect(report.approved).toEqual(['plan'])
    expect(report.alert).toMatchObject({stage: 'boundary', urgent: true})
    expect(approvals(w.calls)).not.toContain('collaudo approve code SBX/SBX-7')
  })

  it('accepts a hidden decoy as a denial only when configured', async () => {
    const hidden = (): ApiResponse => ({status: 404, code: HIDDEN_RESOURCE_CODE})
    const strict = world({decoyAnswer: hidden})
    expect((await runCanary(config, strict.collaudo, strict.observer, strict.clock)).alert?.stage).toBe('boundary')

    const optedIn = world({decoyAnswer: hidden})
    expect((await runCanary({...config, hiddenDecoyCountsAsDenial: true}, optedIn.collaudo, optedIn.observer, optedIn.clock)).ok).toBe(true)
  })

  it('alerts with the stage when the night ticket approval is refused', async () => {
    const w = world({approvalAnswer: {status: 422, code: 'R422-TICKET-006'}})
    const report = await runCanary(config, w.collaudo, w.observer, w.clock)

    expect(report.alert).toMatchObject({stage: 'plan-approval', ticket: 'SBX-7', workflowPhase: PLAN_PHASE})
  })

  it('simulated failure: a disconnected model stops the night at the deadline with phase and reason', async () => {
    // The workflow stops in autopilot, as with a reviewer whose model is unreachable.
    const w = world({stallAt: 2})
    const report = await runCanary(config, w.collaudo, w.observer, w.clock)

    expect(report.ok).toBe(false)
    expect(report.approved).toEqual(['plan'])
    expect(report.alert).toMatchObject({stage: 'deadline', workflowPhase: 'autopilot', ticket: 'SBX-7', urgent: false})
    expect(report.alert?.reason).toContain('within 60 minutes')
    expect(w.elapsed()).toBe(config.deadlineMs)
    expect(formatCanaryAlert(report)).toContain('stage deadline, phase autopilot')
  })

  it('keeps polling through read failures and names the last one at the deadline', async () => {
    const w = world()
    const flaky: CanaryServer = {
      ...w.collaudo,
      async readAutomation(project, ticket) {
        if (project === 'SBX') return {ok: false, response: {status: 503}}
        return w.collaudo.readAutomation(project, ticket)
      },
    }
    const report = await runCanary(config, flaky, w.observer, w.clock)

    expect(report.alert).toMatchObject({stage: 'deadline', workflowPhase: null})
    expect(report.alert?.reason).toContain('HTTP 503')
  })
})

describe('parseAutomationView', () => {
  it('reads the automation of a ticket and treats wrong types as not reported', () => {
    expect(parseAutomationView({data: {ticket_code: 'SBX-7', project_key: 'SBX', phase: CODE_PHASE, review_gate: true, closer_staging_verified_at: '2026-11-02T03:00:00Z'}}))
      .toEqual({code: 'SBX-7', project: 'SBX', phase: CODE_PHASE, reviewGate: true, stagingVerified: true})
    expect(parseAutomationView({data: {code: 'SBX-7', project_key: 'SBX', phase: 3, review_gate: 'yes'}}))
      .toEqual({code: 'SBX-7', project: 'SBX', phase: null, reviewGate: false, stagingVerified: false})
    expect(parseAutomationView({data: {project_key: 'SBX'}})).toBeNull()
    expect(parseAutomationView(null)).toBeNull()
  })
})

describe('makeCanaryServer', () => {
  const token = 'cyi_u_canarytesttoken0123456789'

  function fakeFetch(answers: Record<string, {status: number; body: unknown}>) {
    const requests: Array<{url: string; method: string; auth: string | null; body: string | undefined}> = []
    const fetchFn = (async (url: string, init: RequestInit) => {
      const headers = init.headers as Record<string, string>
      requests.push({url, method: String(init.method), auth: headers.Authorization ?? null, body: init.body as string | undefined})
      const answer = answers[`${init.method} ${url}`]
      if (!answer) throw new TypeError('fetch failed')
      return new Response(JSON.stringify(answer.body), {status: answer.status, headers: {'Content-Type': 'application/json'}})
    }) as unknown as typeof globalThis.fetch
    return {requests, fetchFn}
  }

  it('refuses anything but a user token', () => {
    expect(() => makeCanaryServer('cyi_ah_hosttoken', 'https://x.test')).toThrow(/user token/)
  })

  it('sends the same approval request on the Sandbox and on the decoy, changing only the ticket', async () => {
    const api = 'https://cyi.test'
    const {requests, fetchFn} = fakeFetch({
      [`POST ${api}${CANARY_PATHS.codeApproval('SBX', 'SBX-7')}`]: {status: 200, body: {data: {code: 'SBX-7'}}},
      [`POST ${api}${CANARY_PATHS.codeApproval('DECOY', 'DECOY-1')}`]: {status: 403, body: {error: {code: PERMISSION_DENIED_CODE, message: 'Permission denied'}}},
    })
    const server = makeCanaryServer(token, api, fetchFn)

    expect(await server.approve('code', 'SBX', 'SBX-7')).toMatchObject({status: 200, code: undefined})
    expect(await server.approve('code', 'DECOY', 'DECOY-1')).toMatchObject({status: 403, code: PERMISSION_DENIED_CODE})
    expect(requests[0].body).toBe(requests[1].body)
    expect(requests[0].method).toBe(requests[1].method)
    expect(requests[0].url.replace('SBX/tickets/SBX-7', 'DECOY/tickets/DECOY-1')).toBe(requests[1].url)
    expect(requests.every((request) => request.auth === `Bearer ${token}`)).toBe(true)
  })

  it('creates the ticket and reads its code from the envelope', async () => {
    const api = 'https://cyi.test'
    const {requests, fetchFn} = fakeFetch({
      [`POST ${api}${CANARY_PATHS.tickets('SBX')}`]: {status: 201, body: {data: {code: 'SBX-7'}}},
    })
    const server = makeCanaryServer(token, api, fetchFn)

    expect(await server.createTicket('SBX', 'Nightly canary 2026-11-02', 'body')).toEqual({ok: true, code: 'SBX-7'})
    expect(JSON.parse(String(requests[0].body))).toEqual({title: 'Nightly canary 2026-11-02', description: 'body'})
  })

  it('reports a network failure as no answer, without the token', async () => {
    const {fetchFn} = fakeFetch({})
    const server = makeCanaryServer(token, 'https://cyi.test', fetchFn)

    const answer = await server.approve('plan', 'SBX', 'SBX-7')
    expect(answer).toEqual({status: 0, code: 'network'})
    const read = await server.readAutomation('SBX', 'SBX-7')
    expect(read.ok).toBe(false)
    expect(JSON.stringify(read)).not.toContain(token)
  })
})
