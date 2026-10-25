import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import {afterEach, describe, expect, it, vi} from 'vitest'
import {
  reserveDispatchLimits,
  TicketCoordinator,
  type TicketCoordinatorDeps,
  type TicketPreflightInput,
  type TicketPreflightResult,
} from '../src/lib/ticket-coordinator'
import {gatherGuidance, type GuidanceDeps} from '../src/lib/guidance'
import {REFERENCE_BLOCKED_MARKER, type ReferenceProbe, type TicketGuidance} from '../src/lib/ticket-guidance'
import {type ClarificationStatus, decideClarification} from '../src/lib/clarification'
import {evaluateLimits, failClosedDecision} from '../src/lib/limits'

const guidanceDeps: GuidanceDeps = {
  fs: {
    read: (file) => file.endsWith('CLAUDE.md') ? '# regole' : null,
    isRepoRoot: () => true,
  },
  kb: {search: () => ({ok: true, pages: []})},
}

const tempDirs: string[] = []
afterEach(() => {
  for (const dir of tempDirs.splice(0)) fs.rmSync(dir, {recursive: true, force: true})
})

const reserveInMemory: NonNullable<TicketCoordinatorDeps['reserveLimits']> = async (policy, snapshot) => ({
  decision: evaluateLimits(policy, snapshot, 'dispatch'),
  usage: {date: '2026-07-14', runs: snapshot.runs_today + 1, cost: snapshot.cost_today},
})

/**
 * The clarification state as the SYSTEM declares it (contract `agent-clarification/v1`). Since CYAU-189 the
 * coordinator no longer derives it from the comments: whoever tests it passes the reader, whoever does not waits.
 */
function clarificationStatus(over: Partial<ClarificationStatus> = {}): ClarificationStatus {
  return {state: 'ready', cycles: 0, hasReply: false, source: 'system', ...over}
}

/** A fake reader: the state is decided by the test, without starting `cyi`. */
function fakeReader(status: ClarificationStatus = clarificationStatus()): NonNullable<TicketCoordinatorDeps['readClarificationState']> {
  return () => status
}

function coordinator(deps: TicketCoordinatorDeps = {guidance: guidanceDeps}): TicketCoordinator {
  return new TicketCoordinator({
    ...deps,
    readClarificationState: deps.readClarificationState ?? fakeReader(),
    reserveLimits: deps.reserveLimits ?? reserveInMemory,
  })
}

function input(overrides: Partial<TicketPreflightInput> = {}): TicketPreflightInput {
  return {
    ticket: {
      project: 'CYAU',
      code: 'CYAU-34',
      cwd: '/repo',
      title: 'Aggiungere test backend al daemon',
      comments: [],
    },
    needsDecision: false,
    limits: {
      policy: {max_parallel: 2},
      snapshot: {running: 0, runs_today: 0, cost_today: 0, now: new Date('2026-07-14T10:00:00Z')},
    },
    ...overrides,
  }
}

function orderedDeps(order: string[], status: ClarificationStatus = clarificationStatus()): TicketCoordinatorDeps {
  return {
    guidance: guidanceDeps,
    gatherGuidance: (...args) => {
      order.push('guidance')
      return gatherGuidance(...args)
    },
    // CYRA-628 — it asks the system for the state; here the answer is faked without starting `cyi`.
    readClarificationState: () => {
      order.push('clarification-state')
      return status
    },
    decideClarification: (...args) => {
      order.push('clarification-gate')
      return decideClarification(...args)
    },
    evaluateLimits: (...args) => {
      order.push('limits')
      return evaluateLimits(...args)
    },
    failClosedDecision,
    reserveLimits: reserveInMemory,
  }
}

describe('TicketCoordinator.preflight', () => {
  it('composes the real call sites in the order Guidance → clarifications → limits', async () => {
    const order: string[] = []
    const result = await coordinator(orderedDeps(order)).preflight(input())

    expect(result.outcome).toBe('admit')
    expect(result.state).toBe('ready')
    expect(order).toEqual([
      'guidance',
      'clarification-state',
      'clarification-gate',
      'limits',
    ])
    expect(result.audit.map((entry) => entry.phase)).toEqual([
      'guidance', 'clarification', 'limits',
    ])
    expect(result.guidance.code).toBe('CYAU-34')
    expect(result.limits?.outcome).toBe('admit')
  })

  it('reads Guidance before stopping for a pending clarification and records state and reason', async () => {
    const order: string[] = []
    const result = await coordinator(
      orderedDeps(order, clarificationStatus({state: 'waiting', cycles: 1})),
    ).preflight(input())

    expect(result.outcome).toBe('stop')
    expect(result.state).toBe('waiting')
    expect(result.reason).toContain('attesa')
    expect(order[0]).toBe('guidance')
    expect(order).not.toContain('limits')
    expect(result.audit.at(-1)).toMatchObject({phase: 'clarification', state: 'stopped'})
    expect(result.audit.at(-1)?.reason).not.toBe('')
  })

  it('Guidance required but missing → stop before any other phase', async () => {
    const order: string[] = []
    const deps = orderedDeps(order)
    deps.guidance = {fs: {read: () => null, isRepoRoot: () => true}, kb: guidanceDeps.kb}

    const result = await coordinator(deps).preflight(input())

    expect(result).toMatchObject({outcome: 'stop', state: 'blocked'})
    expect(result.reason).toContain('Guidance richiesta ma non disponibile')
    expect(order).toEqual(['guidance'])
  })


  it('missing limits policy → auditable fail-closed stop', async () => {
    const order: string[] = []
    const base = input()
    const result = await coordinator(orderedDeps(order)).preflight(input({
      limits: {...base.limits, policy: null},
    }))

    expect(result).toMatchObject({outcome: 'stop', state: 'blocked'})
    expect(result.reason).toContain('fail-closed')
    expect(result.limits).toMatchObject({outcome: 'deny', limit: 'policy-unavailable'})
    expect(result.audit.at(-1)).toMatchObject({phase: 'limits', state: 'failed'})
  })


  // ── The gates that remain, and remain fail-closed ───────────────────────────────────────────────────────────
  describe('gate fail-closed', () => {
    const highRisk = {
      project: 'CYAU', code: 'CYAU-34', cwd: '/repo', title: 'Migrazione production', comments: [],
    }

    it('guidance and limits stop the ticket, always', async () => {
      // CYAU-71 — here it was tested that the server admission did NOT make the other gates non-blocking.
      // That delegation no longer exists: no local gate decides the admission. The part that matters remains,
      // that is these two stop the ticket, and it stays pinned so a gate added tomorrow does not inherit
      // the opposite by mistake.
      const noGuidance = await coordinator({
        guidance: {fs: {read: () => null, isRepoRoot: () => true}, kb: guidanceDeps.kb},
      }).preflight(input({ticket: highRisk}))
      expect(noGuidance).toMatchObject({outcome: 'stop', state: 'blocked'})
      expect(noGuidance.reason).toContain('Guidance richiesta ma non disponibile')

      const base = input()
      const noPolicy = await coordinator().preflight(input({
        ticket: highRisk, limits: {...base.limits, policy: null},
      }))
      expect(noPolicy).toMatchObject({outcome: 'stop', state: 'blocked'})
      expect(noPolicy.limits).toMatchObject({outcome: 'deny', limit: 'policy-unavailable'})
    })

    it('a pending clarification stops anyway', async () => {
      const result = await coordinator({
        guidance: guidanceDeps,
        readClarificationState: fakeReader(clarificationStatus({state: 'escalated', cycles: 2})),
      }).preflight(input({ticket: highRisk}))

      expect(result).toMatchObject({outcome: 'stop', state: 'blocked'})
      expect(result.clarification).toMatchObject({action: 'escalate', requiresHuman: true})
    })
  })

  it('escalated clarification → state blocked and not waiting', async () => {
    const result = await coordinator({
      guidance: guidanceDeps,
      readClarificationState: fakeReader(clarificationStatus({state: 'escalated', cycles: 2})),
    }).preflight(input())

    expect(result).toMatchObject({outcome: 'stop', state: 'blocked'})
    expect(result.clarification).toMatchObject({action: 'escalate', requiresHuman: true})
  })

  // CYAU-189 — the fallback on the comments no longer exists: without a reader, the state is unreadable and the ticket
  // waits. A coordinator that admits because it did not look is how a machine ends up working on a
  // ticket that is waiting for a person.
  it('without a clarification reader the ticket waits, it is not admitted', async () => {
    const senzaLettore = new TicketCoordinator({guidance: guidanceDeps, reserveLimits: reserveInMemory})

    const result = await senzaLettore.preflight(input())

    expect(result).toMatchObject({outcome: 'stop', state: 'waiting'})
    expect(result.clarification).toMatchObject({action: 'wait', state: 'unreadable', workable: false})
  })

  // The SERVER publishes the questions when the triage delivers them (CYRA-221): here the state is read and we
  // stop, without composing a second comment — it would be a body the comment cap rejects, containing
  // questions that on this side have no record to live in.
  it('ask action → stops waiting without publishing anything', async () => {
    const publishComment = vi.fn(async () => true)
    const result = await coordinator({guidance: guidanceDeps, publishComment}).preflight(input({
      needsDecision: true,
    }))

    expect(result).toMatchObject({outcome: 'stop', state: 'waiting'})
    expect(result.clarification).toMatchObject({action: 'ask', workable: false})
    expect(publishComment).not.toHaveBeenCalled()
  })

  it('answer after waiting → resumes even if the target keeps needsDecision=true', async () => {
    const result = await coordinator({
      guidance: guidanceDeps,
      readClarificationState: fakeReader(clarificationStatus({cycles: 1, hasReply: true})),
    }).preflight(input({needsDecision: true}))

    expect(result).toMatchObject({outcome: 'admit', state: 'ready'})
    expect(result.clarification).toMatchObject({action: 'resume', workable: true})
  })

  it('real concurrent reservation → a single admit on the last daily slot', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ticket-preflight-usage-'))
    tempDirs.push(dir)
    const snapshot = {running: 0, runs_today: 0, cost_today: 0, now: new Date('2026-07-14T10:00:00Z')}
    const options = {usageDir: dir, clock: () => snapshot.now}

    const results = await Promise.all([
      reserveDispatchLimits({max_daily_runs: 1}, snapshot, 0, options),
      reserveDispatchLimits({max_daily_runs: 1}, snapshot, 0, options),
    ])

    expect(results.map((result) => result.decision.outcome).sort()).toEqual(['admit', 'deny'])
    expect(results.find((result) => result.decision.outcome === 'deny')?.decision.limit).toBe('daily-runs')
  })

  it('an unexpected error in any phase stops closed and does not start the next phases', async () => {
    const order: string[] = []
    const deps = orderedDeps(order)
    deps.gatherGuidance = vi.fn(() => {
      order.push('guidance')
      throw new Error('filesystem non leggibile')
    })

    const result = await coordinator(deps).preflight(input())

    expect(result).toMatchObject({outcome: 'stop', state: 'blocked'})
    expect(result.reason).toContain('guidance')
    expect(result.reason).not.toContain('filesystem non leggibile')
    expect(order).toEqual(['guidance'])
    expect(result.audit).toEqual([
      expect.objectContaining({phase: 'guidance', state: 'failed'}),
    ])
  })

  it('runner adapter without ticket detail → fail-closed stop', async () => {
    const worker = coordinator()
    const preflight = worker.actionPreflight(() => null)

    await expect(Promise.resolve(preflight('agentcyau', {
      schedule: 'every 1m', type: 'shell', run: 'echo x', enabled: true, catch_up: false,
    }, {playbookDir: '/repo'}))).resolves.toMatchObject({
      outcome: 'stop',
      state: 'blocked',
      reason: expect.stringContaining('dettaglio ticket non disponibile'),
    })
  })

  it('runner adapter with ticket detail → runs the coordinator', async () => {
    const worker = coordinator()
    const detail = input()
    const preflight = worker.actionPreflight((name) => name === 'agentcyau' ? detail : null)

    await expect(Promise.resolve(preflight('agentcyau', {
      schedule: 'every 1m', type: 'shell', run: 'echo x', enabled: true, catch_up: false,
    }, {playbookDir: '/repo'}))).resolves.toMatchObject({outcome: 'admit', state: 'ready'})
  })
})

describe('TicketCoordinator.preflight — structured guidance from the ticket detail (CYAU-1)', () => {
  const accessibleProbe: ReferenceProbe = {consult: () => ({accessible: true})}

  function ticketWith(guidance: TicketGuidance) {
    return {project: 'CYAU', code: 'CYAU-1', cwd: '/repo', title: 'Test backend', comments: [], guidance}
  }

  function preflightWith(
    guidance: TicketGuidance,
    deps: Partial<TicketCoordinatorDeps> = {},
  ): Promise<TicketPreflightResult> {
    return coordinator({guidance: guidanceDeps, referenceProbe: accessibleProbe, ...deps})
      .preflight(input({ticket: ticketWith(guidance)}))
  }

  it('Scenario 1: logs the received procedures and carries them into the agent context', async () => {
    const result = await preflightWith({
      references: [],
      rules: [],
      procedures: [
        {key: 'org/global.md', origin: 'org', level: 'global', applicationMode: 'always'},
        {key: 'stack/project.md', origin: 'stack', level: 'project', applicationMode: 'on_demand'},
      ],
    })

    expect(result.outcome).toBe('admit')
    const guidanceAudit = result.audit.find((entry) => entry.phase === 'guidance')
    expect(guidanceAudit?.reason).toContain('procedure ricevute')
    expect(guidanceAudit?.reason).toContain('org/global.md')
    expect(guidanceAudit?.reason).toContain('stack/project.md')
    // The procedures (with their levels) enter the uniform package that ends up in the prompt.
    expect(result.guidance?.markdown).toContain('org/global.md')
    expect(result.guidance?.markdown).toContain('global')
    expect(result.guidance?.markdown).toContain('on_demand')
  })

  it('Scenario 2: inaccessible mandatory reference → comments and stops without claim', async () => {
    const publishComment = vi.fn(async () => true)
    const inaccessibleProbe: ReferenceProbe = {
      consult: ({key}) => ({accessible: false, reason: `${key} non raggiungibile`}),
    }
    const order: string[] = []
    const deps = orderedDeps(order)
    deps.referenceProbe = inaccessibleProbe
    deps.publishComment = publishComment

    const result = await coordinator(deps).preflight(input({
      ticket: {
        project: 'ADV', code: 'ADV-1', cwd: '/repo', title: 'Ticket Advenias', comments: [],
        guidance: {references: [{key: 'advenias-care-md-docs', required: true}], procedures: [], rules: []},
      },
    }))

    expect(result).toMatchObject({outcome: 'stop', state: 'blocked'})
    expect(result.reason).toContain('advenias-care-md-docs')
    // Comment published once, customer-friendly, mentioning the inaccessible document and carrying the marker.
    expect(publishComment).toHaveBeenCalledTimes(1)
    expect(publishComment.mock.calls[0][1]).toContain('advenias-care-md-docs')
    expect(publishComment.mock.calls[0][1]).toContain(REFERENCE_BLOCKED_MARKER)
    // No claim: the limits phase (where the reservation happens) is never reached.
    expect(order).toEqual(['guidance'])
    expect(result.audit.at(-1)).toMatchObject({phase: 'guidance', state: 'stopped'})
  })

  it('idempotence: an already commented ticket (marker present) does not receive a second block comment', async () => {
    const publishComment = vi.fn(async () => true)
    const inaccessibleProbe: ReferenceProbe = {consult: () => ({accessible: false, reason: 'non raggiungibile'})}
    const result = await coordinator({guidance: guidanceDeps, referenceProbe: inaccessibleProbe, publishComment})
      .preflight(input({
        ticket: {
          project: 'ADV', code: 'ADV-1', cwd: '/repo', title: 'Ticket Advenias',
          comments: [{id: 'c1', body: `blocco precedente ${REFERENCE_BLOCKED_MARKER}`}],
          guidance: {references: [{key: 'advenias-care-md-docs', required: true}], procedures: [], rules: []},
        },
      }))

    expect(result).toMatchObject({outcome: 'stop', state: 'blocked'})
    expect(publishComment).not.toHaveBeenCalled()
  })

  it('records in the audit if the block comment cannot be published (never silently ignored)', async () => {
    const publishComment = vi.fn(async () => false)
    const inaccessibleProbe: ReferenceProbe = {consult: () => ({accessible: false, reason: 'x'})}
    const result = await coordinator({guidance: guidanceDeps, referenceProbe: inaccessibleProbe, publishComment})
      .preflight(input({
        ticket: {
          project: 'ADV', code: 'ADV-1', cwd: '/repo', title: 'Ticket Advenias', comments: [],
          guidance: {references: [{key: 'k', required: true}], procedures: [], rules: []},
        },
      }))

    expect(result).toMatchObject({outcome: 'stop', state: 'blocked'})
    expect(result.reason).toContain('commento di blocco non pubblicato')
  })

  it('consultable mandatory reference → its content enters the context (not only the key)', async () => {
    const probe: ReferenceProbe = {consult: () => ({accessible: true, title: 'Guida Git', content: 'contenuto reale'})}
    const result = await preflightWith(
      {references: [{key: 'global/git.md', required: true}], procedures: [], rules: []},
      {referenceProbe: probe},
    )

    expect(result.outcome).toBe('admit')
    expect(result.guidance?.markdown).toContain('contenuto reale')
  })

  it('consultable mandatory reference → proceeds and carries it into the context', async () => {
    const consulted: string[] = []
    const probe: ReferenceProbe = {
      consult: ({key, project}) => {
        consulted.push(`${project}:${key}`)
        return {accessible: true}
      },
    }
    const result = await preflightWith(
      {references: [{key: 'global/git.md', required: true}], procedures: [], rules: []},
      {referenceProbe: probe},
    )

    expect(result.outcome).toBe('admit')
    expect(consulted).toEqual(['CYAU:global/git.md'])
    expect(result.guidance?.markdown).toContain('global/git.md')
  })

  it('Scenario 3: the rules are verbatim data in the context (no special condition)', async () => {
    const result = await preflightWith({
      references: [],
      procedures: [],
      rules: [{key: 'development.tdd'}, {key: 'documentation.update_kb'}],
    })

    expect(result.outcome).toBe('admit')
    expect(result.guidance?.markdown).toContain('development.tdd')
    expect(result.guidance?.markdown).toContain('documentation.update_kb')
  })

  it('a NON-mandatory reference is not consulted before the claim', async () => {
    const consult = vi.fn(() => ({accessible: false, reason: 'non dovrebbe essere chiamata'}))
    const result = await preflightWith(
      {references: [{key: 'facoltativa.md', required: false}], procedures: [], rules: []},
      {referenceProbe: {consult}},
    )

    expect(result.outcome).toBe('admit')
    expect(consult).not.toHaveBeenCalled()
  })

  it('missing guidance → unchanged behaviour, no consultation nor procedure summary', async () => {
    const consult = vi.fn(() => ({accessible: true}))
    const result = await coordinator({guidance: guidanceDeps, referenceProbe: {consult}}).preflight(input())

    expect(result.outcome).toBe('admit')
    expect(consult).not.toHaveBeenCalled()
    expect(result.audit.find((entry) => entry.phase === 'guidance')?.reason).not.toContain('procedure ricevute')
  })
})
