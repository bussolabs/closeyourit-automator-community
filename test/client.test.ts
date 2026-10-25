import {describe, expect, it, vi} from 'vitest'
import {makeClient} from '../src/lib/client'
import {type SyncConfig} from '../src/lib/config'

const cfg: SyncConfig = {orgToken: 'cyi_a_secret'}

function fakeFetch(res: {ok: boolean; status?: number; json?: unknown}) {
  const calls: Array<{url: string; opts: RequestInit}> = []
  const fn = vi.fn(async (url: string | URL, opts?: RequestInit) => {
    calls.push({url: String(url), opts: opts ?? {}})
    return {ok: res.ok, status: res.status ?? (res.ok ? 200 : 500), json: async () => res.json} as unknown as Response
  })
  return {fn: fn as unknown as typeof globalThis.fetch, calls}
}


describe('makeClient#getWorkspaceManifest', () => {
  const manifestBody = {
    data: {
      version: 1,
      digest: 'sha',
      workspace_root_hint: 'Lavoro/Github/Personale',
      repositories: [{project_key: 'CYRA', path: 'apps/closeyourit/closeyourit-rails', repo: 'bussolabs/closeyourit-rails', default_branch: 'main', group: 'CloseYourIt'}],
    },
  }

  it('GET /api/v1/agent_host/workspace_manifest host-scoped and returns the parsed manifest', async () => {
    const {fn, calls} = fakeFetch({ok: true, json: manifestBody})
    const result = await makeClient(cfg, fn, 'cyi_ah_host').getWorkspaceManifest()
    expect(calls[0].url).toBe('https://app.closeyour.it/api/v1/agent_host/workspace_manifest')
    expect((calls[0].opts.headers as Record<string, string>).Authorization).toBe('Bearer cyi_ah_host')
    expect(result?.workspace_root_hint).toBe('Lavoro/Github/Personale')
    expect(result?.repositories).toHaveLength(1)
    expect(result?.repositories[0]).toMatchObject({project_key: 'CYRA', repo: 'bussolabs/closeyourit-rails', default_branch: 'main'})
  })

  it('HTTP non-ok → null', async () => {
    const {fn} = fakeFetch({ok: false})
    expect(await makeClient(cfg, fn, 'cyi_ah_host').getWorkspaceManifest()).toBeNull()
  })

  it('unparsable body (repositories missing) → null', async () => {
    const {fn} = fakeFetch({ok: true, json: {data: {version: 1}}})
    expect(await makeClient(cfg, fn, 'cyi_ah_host').getWorkspaceManifest()).toBeNull()
  })

  it('network error → null (best-effort)', async () => {
    const fn = (async () => {
      throw new Error('network down')
    }) as unknown as typeof globalThis.fetch
    expect(await makeClient(cfg, fn, 'cyi_ah_host').getWorkspaceManifest()).toBeNull()
  })

  it('without host credential (pre-registration) → null without calling the network', async () => {
    const {fn, calls} = fakeFetch({ok: true, json: manifestBody})
    expect(await makeClient(cfg, fn).getWorkspaceManifest()).toBeNull()
    expect(calls).toHaveLength(0)
  })

  // CYAU-87: the manifest is the call that opens every tick, so it is the one the bounded 401 recovery
  // lives on. The auth outcomes must stay distinct: only an explicit 401 authorizes the host token rotation.
  it.each([
    {status: 401, outcome: 'unauthorized'},
    {status: 403, outcome: 'forbidden'},
    {status: 500, outcome: 'unavailable'},
  ] as const)('getWorkspaceManifestResult distingue HTTP $status come $outcome', async ({status, outcome}) => {
    const {fn} = fakeFetch({ok: false, status})
    expect(await makeClient(cfg, fn, 'cyi_ah_host').getWorkspaceManifestResult()).toEqual({outcome})
  })

  it('getWorkspaceManifestResult tells the network apart as unavailable', async () => {
    const fn = (async () => {
      throw new Error('network down')
    }) as unknown as typeof globalThis.fetch
    expect(await makeClient(cfg, fn, 'cyi_ah_host').getWorkspaceManifestResult()).toEqual({outcome: 'unavailable'})
  })

  it('an unparsable manifest is unavailable, not a credential problem', async () => {
    const {fn} = fakeFetch({ok: true, json: {data: {version: 1}}})
    expect(await makeClient(cfg, fn, 'cyi_ah_host').getWorkspaceManifestResult()).toEqual({outcome: 'unavailable'})
  })
})

describe('makeClient#getSkillsManifest', () => {
  const bundleBody = {data: {version: '0.1.0', digest: 'a'.repeat(40), repo: 'bussolabs/closeyourit-skills', ref: 'v0.1.0'}}

  it('GET /api/v1/agent_host/skill_manifest host-scoped and returns the parsed bundle', async () => {
    const {fn, calls} = fakeFetch({ok: true, json: bundleBody})
    const result = await makeClient(cfg, fn, 'cyi_ah_host').getSkillsManifest()
    expect(calls[0].url).toBe('https://app.closeyour.it/api/v1/agent_host/skill_manifest')
    expect((calls[0].opts.headers as Record<string, string>).Authorization).toBe('Bearer cyi_ah_host')
    expect(result).toEqual({version: '0.1.0', digest: 'a'.repeat(40), repo: 'bussolabs/closeyourit-skills', ref: 'v0.1.0'})
  })

  it('non-ok HTTP (e.g. 404 no pinned bundle) → null', async () => {
    const {fn} = fakeFetch({ok: false})
    expect(await makeClient(cfg, fn, 'cyi_ah_host').getSkillsManifest()).toBeNull()
  })

  it('unparsable body (ref missing) → null', async () => {
    const {fn} = fakeFetch({ok: true, json: {data: {version: '0.1.0', repo: 'o/r'}}})
    expect(await makeClient(cfg, fn, 'cyi_ah_host').getSkillsManifest()).toBeNull()
  })

  it('network error → null (best-effort)', async () => {
    const fn = (async () => {
      throw new Error('network down')
    }) as unknown as typeof globalThis.fetch
    expect(await makeClient(cfg, fn, 'cyi_ah_host').getSkillsManifest()).toBeNull()
  })

  it('without host credential → null without calling the network', async () => {
    const {fn, calls} = fakeFetch({ok: true, json: bundleBody})
    expect(await makeClient(cfg, fn).getSkillsManifest()).toBeNull()
    expect(calls).toHaveLength(0)
  })
})

const queueTicket = {
  selection_token: 'opaque-snapshot-token', id: 't1', code: 'CYAU-34', title: 'Preflight queue-driven',
  description: 'Descrizione', technical_analysis: 'Analisi', kind: 'bug', closed_at: null,
  project: {id: 'p1', key: 'CYAU', repo: 'closeyourit/automator', default_branch: 'main'},
  status: {id: 's1', code: 'open', label: 'Open', category: 'backlog'},
  priority: {id: 'pr1', code: 'high', label: 'High'},
  milestone: {id: 'm1', code: 'm1', label: 'Sprint', due_on: null},
  platforms: [{id: 'pl1', code: 'backend', label: 'Backend'}],
  scenarios: [{title: 'Coda', step_given: 'ticket', step_when: 'tick', step_then: 'claim', step_expected: 'una volta'}],
  conditions: [{text: 'Claim atomico'}], comments: [{id: 'c1', body: 'Nota', author: {id: 'u1', name: 'Alessio'}, created_at: 'now', updated_at: 'now'}],
  workflow: {id: 'w1', phase: 'triage_queued', execution_phase: 'triage', snapshot_version: 1},
}

describe('makeClient ticket queue', () => {
  it('host-scoped GET snapshot (flat queue CYAU-84) validates the complete detail', async () => {
    const {fn, calls} = fakeFetch({ok: true, json: {data: queueTicket}})
    const result = await makeClient(cfg, fn, 'cyi_ah_host').getTicketQueue('CY AU')
    expect(result).toMatchObject({outcome: 'candidate', candidate: {code: 'CYAU-34', selection_token: 'opaque-snapshot-token'}})
    // Host-first (CYAU-84): flattened queue, no agent_id in the URL; only project_key in the query.
    expect(calls[0].url).toBe('https://app.closeyour.it/api/v1/ticket_queue?project_key=CY+AU')
    expect((calls[0].opts.headers as Record<string, string>).Authorization).toBe('Bearer cyi_ah_host')
  })

  it('null data is an empty queue; malformed essential payload and failures are fail-closed errors', async () => {
    const empty = fakeFetch({ok: true, json: {data: null}})
    await expect(makeClient(cfg, empty.fn, 'cyi_ah_host').getTicketQueue('CYAU')).resolves.toEqual({outcome: 'empty'})
    const malformed = fakeFetch({ok: true, json: {data: {...queueTicket, selection_token: ''}}})
    await expect(makeClient(cfg, malformed.fn, 'cyi_ah_host').getTicketQueue('CYAU')).resolves.toEqual({outcome: 'error'})
    const http = fakeFetch({ok: false, status: 500})
    await expect(makeClient(cfg, http.fn, 'cyi_ah_host').getTicketQueue('CYAU')).resolves.toEqual({outcome: 'error'})
  })

  it('host-first (CYAU-87): the candidate requires a valid execution_phase (fail-closed on missing/unknown)', async () => {
    const withPhase = (execution_phase: unknown) =>
      ({data: {...queueTicket, workflow: {...queueTicket.workflow, execution_phase}}})
    // Valid → candidate; the authoritative pre-claim phase is exposed to derive the PhaseProfile.
    const ok = fakeFetch({ok: true, json: withPhase('planner')})
    const result = await makeClient(cfg, ok.fn, 'cyi_ah_host').getTicketQueue('CYAU')
    expect(result.outcome).toBe('candidate')
    if (result.outcome === 'candidate') expect(result.candidate.workflow.execution_phase).toBe('planner')
    // Missing → fail-closed: without phase the host cannot derive runtime/skill from the PhaseProfile.
    const missing = fakeFetch({ok: true, json: {data: {...queueTicket, workflow: {id: 'w1', phase: 'triage_queued', snapshot_version: 1}}}})
    await expect(makeClient(cfg, missing.fn, 'cyi_ah_host').getTicketQueue('CYAU')).resolves.toEqual({outcome: 'error'})
    // Vocabulary B (*_queued) or unknown value → fail-closed (not a valid execution_phase).
    const bad = fakeFetch({ok: true, json: withPhase('triage_queued')})
    await expect(makeClient(cfg, bad.fn, 'cyi_ah_host').getTicketQueue('CYAU')).resolves.toEqual({outcome: 'error'})
  })

  it('CYRA-184: the server admission survives the parsing and is not stripped', async () => {
    const admitted = fakeFetch({ok: true, json: {data: {...queueTicket, agent_eligibility: 'allowed'}}})
    const result = await makeClient(cfg, admitted.fn, 'cyi_ah_host').getTicketQueue('CYAU')
    expect(result.outcome).toBe('candidate')
    if (result.outcome === 'candidate') expect(result.candidate.agent_eligibility).toBe('allowed')

    // Older server: the field is simply absent, and the candidate stays valid (backward compat).
    const legacy = fakeFetch({ok: true, json: {data: queueTicket}})
    const before = await makeClient(cfg, legacy.fn, 'cyi_ah_host').getTicketQueue('CYAU')
    expect(before.outcome).toBe('candidate')
    if (before.outcome === 'candidate') expect(before.candidate.agent_eligibility).toBeUndefined()
  })

  it('POST claim sends only the atomic contract and accepts 201/200', async () => {
    const lease = {ticket: 'CYAU-34', host_id: 'h1', run_id: 'r1', agent: 'triage', attempt_id: 'at1', expires_at: '2026-07-14T12:00:00Z'}
    const {fn, calls} = fakeFetch({ok: true, status: 201, json: {data: lease}})
    const request = {selection_token: 'opaque', host_id: 'h1', run_id: 'r1', ttl_seconds: 30}
    await expect(makeClient(cfg, fn, 'cyi_ah_host').claimTicketQueue(request)).resolves.toEqual({outcome: 'acquired', lease})
    // Host-first (CYAU-84): flattened claim, no agent_id in the URL.
    expect(calls[0].url).toBe('https://app.closeyour.it/api/v1/ticket_queue/claims')
    expect(JSON.parse(calls[0].opts.body as string)).toEqual(request)
  })

  // CYRA-621 — the server decides the version number and it arrives with the lease. Before, the machine
  // looked at the last tag and chose by itself which digit to bump: two phases started close together could
  // choose the SAME number, and nobody noticed before the publication.
  it('the claim carries the assigned version number, and on the final release also the code point', async () => {
    const lease = {
      ticket: 'CYAU-34', host_id: 'h1', run_id: 'r1', attempt_id: 'at1', expires_at: '2026-07-14T12:00:00Z',
      release: {version: 'v0.4.0', sha: 'a'.repeat(40)},
    }
    const {fn} = fakeFetch({ok: true, status: 201, json: {data: lease}})
    const result = await makeClient(cfg, fn, 'cyi_ah_host')
      .claimTicketQueue({selection_token: 'x', host_id: 'h1', run_id: 'r1', ttl_seconds: 30})
    expect(result.outcome).toBe('acquired')
    if (result.outcome === 'acquired') expect(result.lease.release).toEqual({version: 'v0.4.0', sha: 'a'.repeat(40)})
  })

  // SHAPE whitelist, as for every other field arriving from the network: an out-of-grammar number
  // is DISCARDED, not cleaned up and used anyway. Better a phase that stops because the number
  // is missing than one that publishes a free-text "new version" as if it were a number.
  it('an out-of-grammar number is discarded, and a crooked code point does not take the number away', async () => {
    const base = {ticket: 'CYAU-34', host_id: 'h1', run_id: 'r1', attempt_id: 'at1', expires_at: '2026-07-14T12:00:00Z'}
    for (const release of [{version: '0.4.0'}, {version: 'v0.4'}, {version: 42}, {version: 'v0.4.0.1'}, null]) {
      const {fn} = fakeFetch({ok: true, status: 201, json: {data: {...base, release}}})
      const result = await makeClient(cfg, fn, 'cyi_ah_host')
        .claimTicketQueue({selection_token: 'x', host_id: 'h1', run_id: 'r1', ttl_seconds: 30})
      if (result.outcome === 'acquired') expect(result.lease.release).toBeUndefined()
    }

    const {fn} = fakeFetch({ok: true, status: 201, json: {data: {...base, release: {version: 'v0.4.0', sha: 'NOPE'}}}})
    const result = await makeClient(cfg, fn, 'cyi_ah_host')
      .claimTicketQueue({selection_token: 'x', host_id: 'h1', run_id: 'r1', ttl_seconds: 30})
    if (result.outcome === 'acquired') expect(result.lease.release).toEqual({version: 'v0.4.0'})
  })

  it('host-first: the claim exposes execution_phase + profile_digest from the lease (for the phase-profile twin)', async () => {
    const lease = {
      ticket: 'CYAU-34', host_id: 'h1', run_id: 'r1', attempt_id: 'at1', expires_at: '2026-07-14T12:00:00Z',
      execution_phase: 'triage', profile_digest: '8ec11d059e1b6fe97afc3d987ba4d2e5741f010e0d865a6fd1754244f44a4065',
    }
    const {fn} = fakeFetch({ok: true, status: 201, json: {data: lease}})
    const request = {selection_token: 'opaque', host_id: 'h1', run_id: 'r1', ttl_seconds: 3600}
    await expect(makeClient(cfg, fn, 'cyi_ah_host').claimTicketQueue(request))
      .resolves.toEqual({outcome: 'acquired', lease})
  })

  it('host-first: an unknown execution_phase in the lease is discarded (fail-closed), the rest stays', async () => {
    const {fn} = fakeFetch({ok: true, status: 201, json: {data: {
      ticket: 'CYAU-34', host_id: 'h1', run_id: 'r1', attempt_id: 'at1', expires_at: '2026-07-14T12:00:00Z',
      execution_phase: 'triage_queued', profile_digest: 42,
    }}})
    const result = await makeClient(cfg, fn, 'cyi_ah_host')
      .claimTicketQueue({selection_token: 'opaque', host_id: 'h1', run_id: 'r1', ttl_seconds: 3600})
    expect(result).toMatchObject({outcome: 'acquired'})
    expect(result.lease).not.toHaveProperty('execution_phase') // vocabulary B (*_queued) is not a valid phase
    expect(result.lease).not.toHaveProperty('profile_digest')  // non-string → discarded
  })

  it('PUT delivers the typed result on the attempt', async () => {
    const {fn, calls} = fakeFetch({ok: true, status: 200, json: {data: {id: 'at1'}}})
    const payload = {runtime: 'claude' as const, reviewer_runtime: 'codex' as const,
      result: {outcome: 'workable'}, review: {status: 'accepted' as const, summary: 'Ok'}}
    await expect(makeClient(cfg, fn, 'cyi_ah_host').deliverAttempt('at/1', payload))
      .resolves.toEqual({outcome: 'ok', status: 200})
    expect(calls[0].url).toBe('https://app.closeyour.it/api/v1/agent_attempts/at%2F1/result')
    expect(calls[0].opts.method).toBe('PUT')
  })

  // CYAU-105: a boolean made 401/403/409/422/500/timeout/missing-token the SAME silence, and they are failures
  // with different remedies. Every row here is a distinct remedy the log must be able to name.
  it.each([
    [401, undefined, {outcome: 'unauthorized', status: 401}],
    [403, undefined, {outcome: 'forbidden', status: 403}],
    [404, {error: {code: 'R404-ATTEMPT-001'}}, {outcome: 'rejected', status: 404, code: 'R404-ATTEMPT-001'}],
    [409, {error: {code: 'R409-ATTEMPT-003'}}, {outcome: 'rejected', status: 409, code: 'R409-ATTEMPT-003'}],
    [422, {error: {code: 'R422-ATTEMPT-001'}}, {outcome: 'rejected', status: 422, code: 'R422-ATTEMPT-001'}],
    [422, null, {outcome: 'rejected', status: 422}], // rejection without code: it stays a rejection, not an outage
    [500, undefined, {outcome: 'unavailable', status: 500}],
    [503, undefined, {outcome: 'unavailable', status: 503}],
  ])('la consegna distingue lo status %i dagli altri esiti', async (status, body, expected) => {
    const payload = {runtime: 'claude' as const, reviewer_runtime: 'codex' as const,
      result: {outcome: 'workable'}, review: {status: 'accepted' as const, summary: 'Ok'}}
    const {fn, calls} = fakeFetch({ok: false, status, json: body})
    await expect(makeClient(cfg, fn, 'cyi_ah_host').deliverAttempt('at1', payload)).resolves.toEqual(expected)
    expect(calls).toHaveLength(1)
  })

  it('the delivery is fail-closed without host token and on network error, as an INDETERMINATE outcome', async () => {
    const payload = {runtime: 'claude' as const, reviewer_runtime: 'codex' as const,
      result: {outcome: 'workable'}, review: {status: 'accepted' as const, summary: 'Ok'}}
    // No host credential: nothing left → indeterminate, never "rejected by the server".
    const unused = fakeFetch({ok: true})
    await expect(makeClient(cfg, unused.fn).deliverAttempt('at1', payload)).resolves.toEqual({outcome: 'unavailable'})
    expect(unused.calls).toHaveLength(0)

    // Network down or timeout: the server may have applied it without the answer coming back → no status.
    const network = (async () => { throw new Error('rete non disponibile') }) as unknown as typeof globalThis.fetch
    await expect(makeClient(cfg, network, 'cyi_ah_host').deliverAttempt('at1', payload)).resolves.toEqual({outcome: 'unavailable'})
  })

  it.each([
    [409, 'R409-QUEUE-001', 'stale'],
    [409, 'R409-LEASE-001', 'held'],
    [422, 'R422-QUEUE-001', 'invalid'],
    [500, 'R500-X', 'error'],
  ] as const)('claim HTTP %s/%s → %s', async (status, code, outcome) => {
    const {fn} = fakeFetch({ok: false, status, json: {error: {code}}})
    await expect(makeClient(cfg, fn, 'cyi_ah_host').claimTicketQueue({
      selection_token: 'opaque', host_id: 'h1', run_id: 'r1', ttl_seconds: 30,
    })).resolves.toMatchObject({outcome})
  })

  // CYAU-120: a bare `error` made a 403 "host not eligible", a 404, an unmapped 409 and a server
  // down the same log line. On minion-1 four projects stayed stuck for five days because the
  // eligibility 403 (host considered dead during a long run) was indistinguishable from an
  // outage. The server status and code now reach the caller, as already in `deliverAttempt`.
  it.each([
    [403, 'R403-AGENT-006'],
    [403, 'R403-LEASE-001'],
    [404, 'R404-QUEUE-001'],
    [409, 'R409-QUEUE-005'],
    [409, 'R409-QUEUE-002'],
    [500, 'R500-X'],
  ] as const)('claim rejected with %s/%s: status and code reach the caller', async (status, code) => {
    const {fn} = fakeFetch({ok: false, status, json: {error: {code}}})
    await expect(makeClient(cfg, fn, 'cyi_ah_host').claimTicketQueue({
      selection_token: 'opaque', host_id: 'h1', run_id: 'r1', ttl_seconds: 30,
    })).resolves.toMatchObject({outcome: 'error', status, serverCode: code})
  })

  it('claim rejected without recognizable code: the status stays, which is already a remedy', async () => {
    const {fn} = fakeFetch({ok: false, status: 502, json: null})
    const result = await makeClient(cfg, fn, 'cyi_ah_host').claimTicketQueue({
      selection_token: 'opaque', host_id: 'h1', run_id: 'r1', ttl_seconds: 30,
    })
    expect(result).toMatchObject({outcome: 'error', status: 502})
    expect(result).not.toHaveProperty('serverCode')
  })

  it('claim 2xx without attempt_id: the server answered, so the status stays', async () => {
    const {fn} = fakeFetch({ok: true, status: 200, json: {data: {ticket: 'CYAU-120', host_id: 'h1', run_id: 'r1'}}})
    await expect(makeClient(cfg, fn, 'cyi_ah_host').claimTicketQueue({
      selection_token: 'opaque', host_id: 'h1', run_id: 'r1', ttl_seconds: 30,
    })).resolves.toMatchObject({outcome: 'error', status: 200})
  })

  it('without host token it makes no queue calls', async () => {
    const {fn, calls} = fakeFetch({ok: true, json: {data: queueTicket}})
    await expect(makeClient(cfg, fn).getTicketQueue('CYAU')).resolves.toEqual({outcome: 'error'})
    await expect(makeClient(cfg, fn).claimTicketQueue({selection_token: 'x', host_id: 'h1', run_id: 'r1', ttl_seconds: 30}))
      .resolves.toEqual({outcome: 'error', lease: null})
    expect(calls).toHaveLength(0)
  })

  it('network errors on snapshot and claim stay fail-closed', async () => {
    const fn = (async () => { throw new Error('rete non disponibile') }) as unknown as typeof globalThis.fetch
    const client = makeClient(cfg, fn, 'cyi_ah_host')
    await expect(client.getTicketQueue('CYAU')).resolves.toEqual({outcome: 'error'})
    await expect(client.claimTicketQueue({selection_token: 'x', host_id: 'h1', run_id: 'r1', ttl_seconds: 30}))
      .resolves.toEqual({outcome: 'error', lease: null})
  })
})

// CYAU-169: ATOMIC queue take-over (server endpoint CYRA-588). It picks the candidate and claims it in
// a single request, so two concurrent claims on the same queue take DIFFERENT tickets instead of re-reading
// the same head and finding it stale. The TTL does not belong to the client: the server decides it with the phase (the candidate
// is not yet known when asking for work), and for the same reason the candidate does NOT carry the selection_token —
// the selection has already been spent by the take-over.
describe('makeClient#claimNextTicket', () => {
  const claimed = {
    ticket: 'CYAU-34', host_id: 'h1', run_id: 'r1', attempt_id: 'at1', expires_at: '2026-07-14T12:00:00Z',
    execution_phase: 'triage', profile_digest: '8ec11d059e1b6fe97afc3d987ba4d2e5741f010e0d865a6fd1754244f44a4065',
  }
  const {selection_token: _token, ...candidate} = queueTicket
  const request = {project_key: 'CYAU', host_id: 'h1', run_id: 'r1'}

  it('POST next_claim with only the atomic contract and returns lease + candidate together', async () => {
    const {fn, calls} = fakeFetch({ok: true, status: 201, json: {data: {...claimed, candidate}}})
    await expect(makeClient(cfg, fn, 'cyi_ah_host').claimNextTicket(request))
      .resolves.toEqual({outcome: 'claimed', lease: claimed, candidate})
    expect(calls[0].url).toBe('https://app.closeyour.it/api/v1/ticket_queue/next_claim')
    expect(calls[0].opts.method).toBe('POST')
    expect((calls[0].opts.headers as Record<string, string>).Authorization).toBe('Bearer cyi_ah_host')
    // No ttl_seconds and no selection_token: both belong to a phase the client does not know yet.
    expect(JSON.parse(calls[0].opts.body as string)).toEqual(request)
  })

  it('also accepts the 200 (non-fresh take-over) with the same wire as the 201', async () => {
    const {fn} = fakeFetch({ok: true, status: 200, json: {data: {...claimed, candidate}}})
    await expect(makeClient(cfg, fn, 'cyi_ah_host').claimNextTicket(request))
      .resolves.toMatchObject({outcome: 'claimed'})
  })

  // CYRA-921
  it('reads who reviews the work, and drops a value it does not know', async () => {
    const same = fakeFetch({ok: true, status: 201, json: {data: {...claimed, review_mode: 'same', candidate}}})
    await expect(makeClient(cfg, same.fn, 'cyi_ah_host').claimNextTicket(request))
      .resolves.toMatchObject({outcome: 'claimed', lease: {review_mode: 'same'}})

    const unknown = fakeFetch({ok: true, status: 201, json: {data: {...claimed, review_mode: 'nobody', candidate}}})
    const result = await makeClient(cfg, unknown.fn, 'cyi_ah_host').claimNextTicket(request)
    expect(result.outcome).toBe('claimed')
    expect(result.outcome === 'claimed' ? result.lease.review_mode : 'not claimed').toBeUndefined()
  })

  // CYAU-226
  it('reads the reviewer named on the server, and drops an engine it does not know', async () => {
    const named = fakeFetch({ok: true, status: 201, json: {data: {...claimed, reviewer: 'claude', candidate}}})
    await expect(makeClient(cfg, named.fn, 'cyi_ah_host').claimNextTicket(request))
      .resolves.toMatchObject({outcome: 'claimed', lease: {reviewer: 'claude'}})

    const unknown = fakeFetch({ok: true, status: 201, json: {data: {...claimed, reviewer: 'gemini', candidate}}})
    const result = await makeClient(cfg, unknown.fn, 'cyi_ah_host').claimNextTicket(request)
    expect(result.outcome === 'claimed' ? result.lease.reviewer : 'not claimed').toBeUndefined()
  })

  // CYAU-228
  it('reads OpenCode as reviewer with the OpenRouter model it reviews with', async () => {
    const named = fakeFetch({ok: true, status: 201, json: {data: {
      ...claimed, reviewer: 'opencode', reviewer_model: ' anthropic/claude-sonnet-4.5 ', candidate,
    }}})
    await expect(makeClient(cfg, named.fn, 'cyi_ah_host').claimNextTicket(request))
      .resolves.toMatchObject({outcome: 'claimed', lease: {reviewer: 'opencode', reviewer_model: 'anthropic/claude-sonnet-4.5'}})

    const blank = fakeFetch({ok: true, status: 201, json: {data: {...claimed, reviewer: 'opencode', reviewer_model: '', candidate}}})
    const result = await makeClient(cfg, blank.fn, 'cyi_ah_host').claimNextTicket(request)
    expect(result.outcome === 'claimed' ? result.lease.reviewer_model : 'not claimed').toBeUndefined()
  })

  // CYRA-921
  it('reads which engine does the work, and drops a value it does not know', async () => {
    const codex = fakeFetch({ok: true, status: 201, json: {data: {...claimed, work_engine: 'codex', candidate}}})
    await expect(makeClient(cfg, codex.fn, 'cyi_ah_host').claimNextTicket(request))
      .resolves.toMatchObject({outcome: 'claimed', lease: {work_engine: 'codex'}})

    const unknown = fakeFetch({ok: true, status: 201, json: {data: {...claimed, work_engine: 'gemini', candidate}}})
    const result = await makeClient(cfg, unknown.fn, 'cyi_ah_host').claimNextTicket(request)
    expect(result.outcome).toBe('claimed')
    expect(result.outcome === 'claimed' ? result.lease.work_engine : 'not claimed').toBeUndefined()
  })

  it('null data is "no work", not an error: the queue is drained', async () => {
    const {fn} = fakeFetch({ok: true, status: 200, json: {data: null}})
    await expect(makeClient(cfg, fn, 'cyi_ah_host').claimNextTicket(request)).resolves.toEqual({outcome: 'empty'})
  })

  it('the candidate does not require the selection_token but requires a valid execution_phase (fail-closed)', async () => {
    const withPhase = (execution_phase: unknown) =>
      ({data: {...claimed, candidate: {...candidate, workflow: {...candidate.workflow, execution_phase}}}})
    const planner = fakeFetch({ok: true, status: 201, json: withPhase('planner')})
    const result = await makeClient(cfg, planner.fn, 'cyi_ah_host').claimNextTicket(request)
    expect(result.outcome).toBe('claimed')
    if (result.outcome === 'claimed') expect(result.candidate.workflow.execution_phase).toBe('planner')
    // Vocabulary B (*_queued): not a runnable phase → the claim is not usable, the server answered.
    const queued = fakeFetch({ok: true, status: 201, json: withPhase('triage_queued')})
    await expect(makeClient(cfg, queued.fn, 'cyi_ah_host').claimNextTicket(request))
      .resolves.toEqual({outcome: 'rejected', status: 201})
  })

  it('2xx without attempt_id or without candidate is unusable: rejection with the status, never a half claim', async () => {
    const noAttempt = fakeFetch({ok: true, status: 201, json: {data: {...claimed, attempt_id: undefined, candidate}}})
    await expect(makeClient(cfg, noAttempt.fn, 'cyi_ah_host').claimNextTicket(request))
      .resolves.toEqual({outcome: 'rejected', status: 201})
    const noCandidate = fakeFetch({ok: true, status: 201, json: {data: claimed}})
    await expect(makeClient(cfg, noCandidate.fn, 'cyi_ah_host').claimNextTicket(request))
      .resolves.toEqual({outcome: 'rejected', status: 201})
  })

  // A discarded but already CREATED claim would leave the ticket occupied until expiry, for an error that belongs to the
  // server: if the answer says at least which ticket it is, it is given back immediately.
  it('a discarded but already taken claim is given back, not left occupied', async () => {
    const {fn, calls} = fakeFetch({ok: true, status: 201, json: {data: {...claimed, candidate: {broken: true}}}})
    await expect(makeClient(cfg, fn, 'cyi_ah_host').claimNextTicket(request))
      .resolves.toEqual({outcome: 'rejected', status: 201})
    const release = calls.filter((call) => call.url.includes('/release'))
    expect(release).toHaveLength(1)
    expect(release[0].url).toBe('https://app.closeyour.it/api/v1/leases/CYAU-34/release')
    expect(JSON.parse(release[0].opts.body as string)).toEqual({ticket: 'CYAU-34', host_id: 'h1', run_id: 'r1'})
  })

  it('a 2xx without even a recognizable lease does not invent a release', async () => {
    const {fn, calls} = fakeFetch({ok: true, status: 201, json: {data: {candidate}}})
    await expect(makeClient(cfg, fn, 'cyi_ah_host').claimNextTicket(request))
      .resolves.toEqual({outcome: 'rejected', status: 201})
    expect(calls.filter((call) => call.url.includes('/release'))).toHaveLength(0)
  })

  // As in the two-step claim (CYAU-120): the server status and code reach the caller, because a
  // non-eligible host, an out-of-scope project and a reached cap have different remedies.
  it.each([
    [403, 'R403-AGENT-006'],
    [403, 'R403-LEASE-001'],
    [404, 'R404-AGENT-002'],
    [409, 'R409-QUEUE-002'],
    [500, 'R500-X'],
  ] as const)('rejection %s/%s: status and code reach the caller', async (status, code) => {
    const {fn} = fakeFetch({ok: false, status, json: {error: {code}}})
    await expect(makeClient(cfg, fn, 'cyi_ah_host').claimNextTicket(request))
      .resolves.toEqual({outcome: 'rejected', status, serverCode: code})
  })

  it('rejection without code: the status stays, which is already a remedy', async () => {
    const {fn} = fakeFetch({ok: false, status: 502, json: null})
    const result = await makeClient(cfg, fn, 'cyi_ah_host').claimNextTicket(request)
    expect(result).toEqual({outcome: 'rejected', status: 502})
  })

  it('network down or missing host credential: no answer, so no status (indeterminate outcome)', async () => {
    const unused = fakeFetch({ok: true, status: 201, json: {data: {...claimed, candidate}}})
    await expect(makeClient(cfg, unused.fn).claimNextTicket(request)).resolves.toEqual({outcome: 'error'})
    expect(unused.calls).toHaveLength(0)
    const network = (async () => { throw new Error('rete non disponibile') }) as unknown as typeof globalThis.fetch
    await expect(makeClient(cfg, network, 'cyi_ah_host').claimNextTicket(request)).resolves.toEqual({outcome: 'error'})
  })
})

describe('makeClient#registerHost', () => {
  const reg = {fingerprint: 'fp', hostname: 'minion', platform: 'linux', arch: 'arm64', automator_version: '0.0.1'}

  it('POST /api/v1/hosts with the fingerprint and the service account Bearer, returns id+token', async () => {
    const {fn, calls} = fakeFetch({ok: true, json: {data: {id: 'h1', token: 'cyi_ah_s'}}})
    const res = await makeClient(cfg, fn, 'cyi_ah_host', 'cyi_u_sa').registerHost(reg)
    expect(res).toEqual({id: 'h1', token: 'cyi_ah_s'})
    expect(calls[0].url).toBe('https://app.closeyour.it/api/v1/hosts')
    expect(calls[0].opts.method).toBe('POST')
    expect((calls[0].opts.headers as Record<string, string>).Authorization).toBe('Bearer cyi_u_sa')
    expect(JSON.parse(calls[0].opts.body as string)).toMatchObject({fingerprint: 'fp', hostname: 'minion', platform: 'linux'})
  })

  it('HTTP non-ok → null', async () => {
    const {fn} = fakeFetch({ok: false})
    expect(await makeClient(cfg, fn, 'cyi_ah_host').registerHost(reg)).toBeNull()
  })

  it('data without valid id/token → null (contract not respected)', async () => {
    const {fn} = fakeFetch({ok: true, json: {data: {id: 'h1'}}})
    expect(await makeClient(cfg, fn, 'cyi_ah_host').registerHost(reg)).toBeNull()
  })

  it('rejects a bootstrap answer with the distinct Server Host token cyi_h_', async () => {
    const {fn} = fakeFetch({ok: true, json: {data: {id: 'h1', token: 'cyi_h_server'}}})
    expect(await makeClient(cfg, fn).registerHost(reg)).toBeNull()
  })

  it('envelope without data → null', async () => {
    const {fn} = fakeFetch({ok: true, json: {}})
    expect(await makeClient(cfg, fn, 'cyi_ah_host').registerHost(reg)).toBeNull()
  })

  it('network error → null (best-effort)', async () => {
    const fn = (async () => {
      throw new Error('down')
    }) as unknown as typeof globalThis.fetch
    expect(await makeClient(cfg, fn, 'cyi_ah_host').registerHost(reg)).toBeNull()
  })

  it.each([
    {status: 401, outcome: 'unauthorized'},
    {status: 403, outcome: 'forbidden'},
    {status: 500, outcome: 'unavailable'},
  ] as const)('registerHostResult distingue HTTP $status come $outcome', async ({status, outcome}) => {
    const {fn} = fakeFetch({ok: false, status})
    expect(await makeClient(cfg, fn).registerHostResult(reg)).toEqual({outcome})
  })
})

describe('makeClient host-scoped credential (revocable identity)', () => {
  const reg = {fingerprint: 'fp', hostname: 'minion', platform: 'linux', arch: 'arm64'}

  const emptyManifest = {data: {version: 1, digest: 'd', workspace_root_hint: 'x', repositories: []}}

  it('the manifest pull uses the host token when registered → revoking it disables the pull', async () => {
    const {fn, calls} = fakeFetch({ok: true, json: emptyManifest})
    await makeClient(cfg, fn, 'cyi_ah_host').getWorkspaceManifest()
    expect((calls[0].opts.headers as Record<string, string>).Authorization).toBe('Bearer cyi_ah_host')
  })

  it('without host token the operations fail closed without using the org token', async () => {
    const {fn, calls} = fakeFetch({ok: true, json: emptyManifest})
    expect(await makeClient(cfg, fn).getWorkspaceManifest()).toBeNull()
    expect((await makeClient(cfg, fn).acquireLease(leaseReq)).outcome).toBe('error')
    expect(await makeClient(cfg, fn).releaseLease({ticket: 'CYAU-13', host_id: 'h1', run_id: 'r1'})).toBe(false)
    expect((await makeClient(cfg, fn).renewLease({ticket: 'CYAU-13', host_id: 'h1', run_id: 'r1', ttl_seconds: 60})).outcome).toBe('error')
    expect(calls).toHaveLength(0)
  })

  it('401/403 cause no retry or automatic downgrade to the org token', async () => {
    const {fn, calls} = fakeFetch({ok: false, status: 401})
    expect(await makeClient(cfg, fn, 'cyi_ah_host').getWorkspaceManifest()).toBeNull()
    expect(calls).toHaveLength(1)
    expect((calls[0].opts.headers as Record<string, string>).Authorization).toBe('Bearer cyi_ah_host')

    const forbidden = fakeFetch({ok: false, status: 403})
    expect(await makeClient(cfg, forbidden.fn, 'cyi_ah_host').getWorkspaceManifest()).toBeNull()
    expect(forbidden.calls).toHaveLength(1)
    expect((forbidden.calls[0].opts.headers as Record<string, string>).Authorization).toBe('Bearer cyi_ah_host')
  })

  it('the host-scoped operations work even after the org token removal', async () => {
    const {fn, calls} = fakeFetch({ok: true, json: emptyManifest})
    expect((await makeClient({}, fn, 'cyi_ah_host').getWorkspaceManifest())?.repositories).toEqual([])
    expect(calls).toHaveLength(1)
    expect((calls[0].opts.headers as Record<string, string>).Authorization).toBe('Bearer cyi_ah_host')
  })

  it('the bootstrap without service account token nor org token fails closed without fetch', async () => {
    const {fn, calls} = fakeFetch({ok: true, json: {data: {id: 'h1', token: 'cyi_ah_s'}}})
    expect(await makeClient({}, fn).registerHost(reg)).toBeNull()
    expect(calls).toHaveLength(0)
  })

  it('registerHost uses the service account token (cyi_u_) when present, not the host one', async () => {
    const {fn, calls} = fakeFetch({ok: true, json: {data: {id: 'h1', token: 'cyi_ah_s'}}})
    await makeClient(cfg, fn, 'cyi_ah_host', 'cyi_u_sa').registerHost(reg)
    expect((calls[0].opts.headers as Record<string, string>).Authorization).toBe('Bearer cyi_u_sa')
  })

  it('registerHost falls back to the org token (backward compat) when the service account token is missing', async () => {
    const {fn, calls} = fakeFetch({ok: true, json: {data: {id: 'h1', token: 'cyi_ah_s'}}})
    await makeClient(cfg, fn, 'cyi_ah_host').registerHost(reg)
    expect((calls[0].opts.headers as Record<string, string>).Authorization).toBe('Bearer cyi_a_secret')
  })
})

const leaseReq = {ticket: 'CYAU-13', host_id: 'h1', run_id: 'run-42', agent: 'triage', ttl_seconds: 3600}
const leaseData = {ticket: 'CYAU-13', host_id: 'h1', run_id: 'run-42', agent: 'triage', expires_at: '2026-07-12T15:00:00.000Z'}

describe('makeClient#acquireLease', () => {
  it('POST /api/v1/leases with the body and 2xx → outcome acquired + lease', async () => {
    const {fn, calls} = fakeFetch({ok: true, status: 201, json: {data: leaseData}})
    const res = await makeClient(cfg, fn, 'cyi_ah_host').acquireLease(leaseReq)
    expect(res.outcome).toBe('acquired')
    expect(res.lease).toEqual(leaseData)
    expect(calls[0].url).toBe('https://app.closeyour.it/api/v1/leases')
    expect(calls[0].opts.method).toBe('POST')
    expect(JSON.parse(calls[0].opts.body as string)).toEqual(leaseReq)
  })

  it('409 → outcome held with the returned holder (the other host holds the lease)', async () => {
    const holder = {ticket: 'CYAU-13', host_id: 'h2', expires_at: '2026-07-12T15:00:00.000Z'}
    const {fn} = fakeFetch({ok: false, status: 409, json: {data: holder}})
    const res = await makeClient(cfg, fn, 'cyi_ah_host').acquireLease(leaseReq)
    expect(res.outcome).toBe('held')
    expect(res.lease?.host_id).toBe('h2')
  })

  it('409 without valid body → held with lease null (the outcome counts, not the details)', async () => {
    const {fn} = fakeFetch({ok: false, status: 409, json: {}})
    const res = await makeClient(cfg, fn, 'cyi_ah_host').acquireLease(leaseReq)
    expect(res.outcome).toBe('held')
    expect(res.lease).toBeNull()
  })

  it('409 with the holder = US (same host_id + run_id) → acquired (idempotent retry, lost answer)', async () => {
    const mine = {ticket: 'CYAU-13', host_id: 'h1', run_id: 'run-42', expires_at: '2026-07-12T15:00:00.000Z'}
    const {fn} = fakeFetch({ok: false, status: 409, json: {data: mine}})
    const res = await makeClient(cfg, fn, 'cyi_ah_host').acquireLease(leaseReq)
    expect(res.outcome).toBe('acquired')
    expect(res.lease?.run_id).toBe('run-42')
  })

  it('409 same host_id but different run_id → held (another run holds the lease)', async () => {
    const other = {ticket: 'CYAU-13', host_id: 'h1', run_id: 'run-99', expires_at: '2026-07-12T15:00:00.000Z'}
    const {fn} = fakeFetch({ok: false, status: 409, json: {data: other}})
    expect((await makeClient(cfg, fn, 'cyi_ah_host').acquireLease(leaseReq)).outcome).toBe('held')
  })

  it('other non-ok HTTP (500) → outcome error (indeterminate outcome, best-effort)', async () => {
    const {fn} = fakeFetch({ok: false, status: 500})
    const res = await makeClient(cfg, fn, 'cyi_ah_host').acquireLease(leaseReq)
    expect(res.outcome).toBe('error')
    expect(res.lease).toBeNull()
  })

  it('network error → outcome error', async () => {
    const fn = (async () => {
      throw new Error('down')
    }) as unknown as typeof globalThis.fetch
    const res = await makeClient(cfg, fn, 'cyi_ah_host').acquireLease(leaseReq)
    expect(res.outcome).toBe('error')
  })

  it('uses the host-scoped credential when registered (lease bound to the host identity)', async () => {
    const {fn, calls} = fakeFetch({ok: true, status: 201, json: {data: leaseData}})
    await makeClient(cfg, fn, 'cyi_ah_host').acquireLease(leaseReq)
    expect((calls[0].opts.headers as Record<string, string>).Authorization).toBe('Bearer cyi_ah_host')
  })

  it('2xx with non-JSON body → acquired with lease null (the status confirms the acquisition)', async () => {
    const fn = (async () => ({
      ok: true,
      status: 201,
      json: async () => {
        throw new Error('not json')
      },
    })) as unknown as typeof globalThis.fetch
    const res = await makeClient(cfg, fn, 'cyi_ah_host').acquireLease(leaseReq)
    expect(res.outcome).toBe('acquired')
    expect(res.lease).toBeNull()
  })
})

describe('makeClient#releaseLease', () => {
  const rel = {ticket: 'CYAU-13', host_id: 'h1', run_id: 'run-42'}

  it('POST /api/v1/leases/:ticket/release with the body → true on ok', async () => {
    const {fn, calls} = fakeFetch({ok: true, status: 200})
    const ok = await makeClient(cfg, fn, 'cyi_ah_host').releaseLease(rel)
    expect(ok).toBe(true)
    expect(calls[0].url).toBe('https://app.closeyour.it/api/v1/leases/CYAU-13/release')
    expect(calls[0].opts.method).toBe('POST')
    expect((calls[0].opts.headers as Record<string, string>).Authorization).toBe('Bearer cyi_ah_host')
    expect(JSON.parse(calls[0].opts.body as string)).toEqual(rel)
  })

  it('encodeURIComponent of the ticket in the path (never an ambiguous URL segment)', async () => {
    const {fn, calls} = fakeFetch({ok: true, status: 200})
    await makeClient(cfg, fn, 'cyi_ah_host').releaseLease({...rel, ticket: 'A B/C'})
    expect(calls[0].url).toBe('https://app.closeyour.it/api/v1/leases/A%20B%2FC/release')
  })

  it('404 → true (idempotent: lease already released or expired)', async () => {
    const {fn} = fakeFetch({ok: false, status: 404})
    expect(await makeClient(cfg, fn, 'cyi_ah_host').releaseLease(rel)).toBe(true)
  })

  it('other non-ok HTTP (500) → false', async () => {
    const {fn} = fakeFetch({ok: false, status: 500})
    expect(await makeClient(cfg, fn, 'cyi_ah_host').releaseLease(rel)).toBe(false)
  })

  it('network error → false (best-effort)', async () => {
    const fn = (async () => {
      throw new Error('down')
    }) as unknown as typeof globalThis.fetch
    expect(await makeClient(cfg, fn, 'cyi_ah_host').releaseLease(rel)).toBe(false)
  })
})

describe('makeClient#renewLease', () => {
  const renew = {ticket: 'CYAU-13', host_id: 'h1', run_id: 'run-42', ttl_seconds: 3600}
  const renewed = {ticket: 'CYAU-13', host_id: 'h1', run_id: 'run-42', expires_at: '2026-07-12T16:00:00.000Z'}

  it('POST /api/v1/leases/:ticket/renew with the body and 2xx → renewed + new expiry', async () => {
    const {fn, calls} = fakeFetch({ok: true, status: 200, json: {data: renewed}})
    const res = await makeClient(cfg, fn, 'cyi_ah_host').renewLease(renew)
    expect(res.outcome).toBe('renewed')
    expect(res.lease?.expires_at).toBe('2026-07-12T16:00:00.000Z')
    expect(calls[0].url).toBe('https://app.closeyour.it/api/v1/leases/CYAU-13/renew')
    expect(calls[0].opts.method).toBe('POST')
    expect((calls[0].opts.headers as Record<string, string>).Authorization).toBe('Bearer cyi_ah_host')
    expect(JSON.parse(calls[0].opts.body as string)).toEqual(renew)
  })

  it('renewed keeps the owner (host_id unchanged)', async () => {
    const {fn} = fakeFetch({ok: true, status: 200, json: {data: renewed}})
    const res = await makeClient(cfg, fn, 'cyi_ah_host').renewLease(renew)
    expect(res.lease?.host_id).toBe('h1')
  })

  it('encodeURIComponent of the ticket in the path', async () => {
    const {fn, calls} = fakeFetch({ok: true, status: 200, json: {data: renewed}})
    await makeClient(cfg, fn, 'cyi_ah_host').renewLease({...renew, ticket: 'A B/C'})
    expect(calls[0].url).toBe('https://app.closeyour.it/api/v1/leases/A%20B%2FC/renew')
  })

  it('409 → held (the lease belongs to another host: stop renewing)', async () => {
    const holder = {ticket: 'CYAU-13', host_id: 'h2', expires_at: renewed.expires_at}
    const {fn} = fakeFetch({ok: false, status: 409, json: {data: holder}})
    const res = await makeClient(cfg, fn, 'cyi_ah_host').renewLease(renew)
    expect(res.outcome).toBe('held')
    expect(res.lease?.host_id).toBe('h2')
  })

  it('404 → expired (lease expired/missing server-side)', async () => {
    const {fn} = fakeFetch({ok: false, status: 404})
    const res = await makeClient(cfg, fn, 'cyi_ah_host').renewLease(renew)
    expect(res.outcome).toBe('expired')
    expect(res.lease).toBeNull()
  })

  it('other non-ok HTTP (500) → error (indeterminate)', async () => {
    const {fn} = fakeFetch({ok: false, status: 500})
    expect((await makeClient(cfg, fn, 'cyi_ah_host').renewLease(renew)).outcome).toBe('error')
  })

  it('network error → error (best-effort)', async () => {
    const fn = (async () => {
      throw new Error('down')
    }) as unknown as typeof globalThis.fetch
    expect((await makeClient(cfg, fn, 'cyi_ah_host').renewLease(renew)).outcome).toBe('error')
  })

  it('a dedicated signal interrupts a hanging HTTP renew before the general client timeout', async () => {
    let received: AbortSignal | null = null
    const fn = vi.fn((_url: string | URL, opts?: RequestInit) => new Promise<Response>((_resolve, reject) => {
      received = opts?.signal as AbortSignal
      received.addEventListener('abort', () => reject(new Error('aborted')), {once: true})
    })) as unknown as typeof globalThis.fetch
    const controller = new AbortController()

    const pending = makeClient(cfg, fn, 'cyi_ah_host').renewLease(renew, controller.signal)
    controller.abort()

    await expect(pending).resolves.toEqual({outcome: 'error', lease: null})
    expect(received?.aborted).toBe(true)
  })

  it('2xx with non-JSON body → renewed with lease null (the status confirms the renewal)', async () => {
    const fn = (async () => ({
      ok: true,
      status: 200,
      json: async () => {
        throw new Error('not json')
      },
    })) as unknown as typeof globalThis.fetch
    const res = await makeClient(cfg, fn, 'cyi_ah_host').renewLease(renew)
    expect(res.outcome).toBe('renewed')
    expect(res.lease).toBeNull()
  })
})

describe('makeClient#deferTicketQueue — CYAU-101', () => {
  const req = {selection_token: 'opaque', host_id: 'host-1', reason: 'preflight_blocked' as const}

  it('host-scoped POST with the complete contract; 201 and replay 200 are both valid', async () => {
    const created = fakeFetch({ok: true, status: 201, json: {data: {id: 'd1'}}})
    await expect(makeClient(cfg, created.fn, 'cyi_ah_host').deferTicketQueue(req)).resolves.toBe(true)
    expect(created.calls[0].url).toBe('https://app.closeyour.it/api/v1/ticket_queue/deferrals')
    expect(created.calls[0].opts.method).toBe('POST')
    expect((created.calls[0].opts.headers as Record<string, string>).Authorization).toBe('Bearer cyi_ah_host')
    // `host_id` is mandatory as in the claim: without it, the server answers 403 R403-QUEUE-001 and every
    // deferral would be inert — a defect invisible to a test looking only at the boolean outcome.
    expect(JSON.parse(String(created.calls[0].opts.body))).toEqual({
      selection_token: 'opaque', host_id: 'host-1', reason: 'preflight_blocked',
    })

    const replay = fakeFetch({ok: true, status: 200, json: {data: {id: 'd1'}}})
    await expect(
      makeClient(cfg, replay.fn, 'cyi_ah_host').deferTicketQueue({...req, reason: 'needs_clarification'}),
    ).resolves.toBe(true)
  })

  it('rejection, network error or missing host token → false without throwing (best-effort)', async () => {
    const rejected = fakeFetch({ok: false, status: 422})
    await expect(makeClient(cfg, rejected.fn, 'cyi_ah_host').deferTicketQueue(req)).resolves.toBe(false)

    const forbidden = fakeFetch({ok: false, status: 403, json: {error: {code: 'R403-QUEUE-001'}}})
    await expect(makeClient(cfg, forbidden.fn, 'cyi_ah_host').deferTicketQueue(req)).resolves.toBe(false)

    const down = (async () => {
      throw new Error('network down')
    }) as unknown as typeof globalThis.fetch
    await expect(makeClient(cfg, down, 'cyi_ah_host').deferTicketQueue(req)).resolves.toBe(false)

    const unauthenticated = fakeFetch({ok: true, status: 201})
    await expect(makeClient(cfg, unauthenticated.fn).deferTicketQueue(req)).resolves.toBe(false)
    expect(unauthenticated.calls).toHaveLength(0)
  })

  it('empty selection or host_id → no call: it would be a certain 403', async () => {
    const noSelection = fakeFetch({ok: true, status: 201})
    await expect(
      makeClient(cfg, noSelection.fn, 'cyi_ah_host').deferTicketQueue({...req, selection_token: '  '}),
    ).resolves.toBe(false)
    expect(noSelection.calls).toHaveLength(0)

    const noHost = fakeFetch({ok: true, status: 201})
    await expect(
      makeClient(cfg, noHost.fn, 'cyi_ah_host').deferTicketQueue({...req, host_id: ''}),
    ).resolves.toBe(false)
    expect(noHost.calls).toHaveLength(0)
  })
})
