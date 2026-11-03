import {describe, expect, it, vi} from 'vitest'
import {type Secrets} from '../src/lib/config'
import {
  buildCritiquePrompt,
  buildProposalPrompt,
  failureKind,
  makeCouncilPass,
  parseCritiques,
  parseProposals,
  type CouncilProposal,
  type CouncilSlice,
} from '../src/lib/council'
import {type SupporterRun} from '../src/lib/supporter'

// CYRA-1133 — the machine runs four read-only sessions on one project and sends proposals and votes; the server decides.
const secrets = {
  sync: {apiUrl: 'https://cyi.test'},
  host: {id: 'host-1', token: 'cyi_ah_hosttoken'},
  hosts: {LAB: {cwd: '/repos/lab'}},
} as Secrets

const slice: CouncilSlice = {
  run_id: 'run-1', project_key: 'LAB', mode: 'dry_run', max_proposals: 3, engines: ['claude', 'codex'],
  models: {claude: ['claude-opus-5-5'], codex: ['gpt-6-astra']}, kinds: ['error', 'code', 'product'],
  risks: ['low', 'medium', 'serious'], signals: {errors: [], slow: [], monitors_down: []}, open_tickets: [], open_ideas: [],
}

const proposalJson = (title: string) =>
  JSON.stringify({proposals: [{title, problem: 'p', solution: 's', kind: 'code', risk: 'low', engine: 'codex', model: 'gpt-6-astra'}]})

function server(body: unknown, status = 200, sliceText?: string) {
  const posts: unknown[] = []
  const urls: string[] = []
  const fetchFn = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
    urls.push(String(url))
    if (String(url).endsWith('/council_slice')) {
      return new Response(status === 204 ? null : sliceText ?? JSON.stringify({data: body}), {status})
    }
    posts.push(JSON.parse(String(init?.body)))
    return new Response(JSON.stringify({data: {status: 'completed', outcomes: {}}}), {status: 200})
  })
  return {fetchFn: fetchFn as unknown as typeof globalThis.fetch, posts, urls}
}

describe('council pass', () => {
  it('is off without an operational host identity', () => {
    expect(makeCouncilPass({sync: {apiUrl: 'https://cyi.test'}} as Secrets)).toBeUndefined()
  })

  it('does nothing when the server has no slice', async () => {
    const {fetchFn, posts} = server(null, 204)
    const run = vi.fn()
    await makeCouncilPass(secrets, {fetchFn, run})!()
    expect(run).not.toHaveBeenCalled()
    expect(posts).toEqual([])
  })

  it('does nothing when the server predates the council (404)', async () => {
    const {fetchFn, posts} = server(null, 404, JSON.stringify({error: {code: 'not_found'}}))
    const run = vi.fn()
    await makeCouncilPass(secrets, {fetchFn, run})!()
    expect(run).not.toHaveBeenCalled()
    expect(posts).toEqual([])
  })

  it('does nothing when the slice body is unreadable', async () => {
    const {fetchFn, posts} = server(null, 200, 'not json')
    const run = vi.fn()
    await makeCouncilPass(secrets, {fetchFn, run})!()
    expect(run).not.toHaveBeenCalled()
    expect(posts).toEqual([])
  })

  it('collects proposals from both engines, cross votes, and posts them', async () => {
    const {fetchFn, posts, urls} = server(slice)
    const run: SupporterRun = vi.fn(async (engine, request) => {
      if (request.prompt.includes('PROPOSE')) return {ok: true, text: proposalJson(`from ${engine}`)}
      const other = engine === 'claude' ? 'codex-1' : 'claude-1'
      return {ok: true, text: JSON.stringify({votes: [{ref: other, vote: 'approve', risk: 'low', reason: 'ok'}]})}
    })
    const log = vi.fn()
    await makeCouncilPass(secrets, {fetchFn, run, log})!()
    expect(run).toHaveBeenCalledTimes(4)
    expect(vi.mocked(run).mock.calls.map(([engine, request]) => [engine, request.cwd])).toEqual([
      ['claude', '/repos/lab'], ['codex', '/repos/lab'], ['claude', '/repos/lab'], ['codex', '/repos/lab'],
    ])
    expect(urls.at(-1)).toBe('https://cyi.test/api/v1/agent_host/council_slices/run-1/result')
    const body = posts[0] as {proposals: Array<{ref: string; proposer: string}>; critiques: Array<{ref: string; critic: string}>}
    expect(body.proposals.map((p) => [p.ref, p.proposer])).toEqual([['claude-1', 'claude'], ['codex-1', 'codex']])
    expect(body.critiques.map((c) => [c.ref, c.critic])).toEqual([['codex-1', 'claude'], ['claude-1', 'codex']])
    expect(log).toHaveBeenCalledWith('council: LAB completed')
  })

  it('skips the vote of an engine when the other proposed nothing', async () => {
    const {fetchFn, posts} = server(slice)
    const run: SupporterRun = vi.fn(async (engine, request) => {
      if (request.prompt.includes('PROPOSE')) {
        return {ok: true, text: engine === 'claude' ? proposalJson('only claude') : JSON.stringify({proposals: []})}
      }
      return {ok: true, text: JSON.stringify({votes: [{ref: 'claude-1', vote: 'reject', risk: 'low', reason: 'no'}]})}
    })
    await makeCouncilPass(secrets, {fetchFn, run})!()
    expect(run).toHaveBeenCalledTimes(3)
    expect(posts[0]).toMatchObject({critiques: [{ref: 'claude-1', critic: 'codex', vote: 'reject'}]})
  })

  it('keeps at most max_proposals per engine before the votes', async () => {
    const {fetchFn, posts} = server({...slice, max_proposals: 2})
    const many = JSON.stringify({proposals: [1, 2, 3].map((n) => ({title: `t${n}`, problem: 'p', solution: 's', kind: 'code', risk: 'low'}))})
    const run: SupporterRun = vi.fn(async (_engine, request) =>
      ({ok: true as const, text: request.prompt.includes('PROPOSE') ? many : JSON.stringify({votes: []})}))
    await makeCouncilPass(secrets, {fetchFn, run})!()
    const votePrompts = vi.mocked(run).mock.calls.slice(2).map(([, request]) => request.prompt)
    expect(votePrompts.every((prompt) => !prompt.includes('-3"'))).toBe(true)
    expect((posts[0] as {proposals: Array<{ref: string}>}).proposals.map((p) => p.ref))
      .toEqual(['claude-1', 'claude-2', 'codex-1', 'codex-2'])
  })

  it('reports a quota failure and stops', async () => {
    const {fetchFn, posts} = server(slice)
    const run: SupporterRun = vi.fn(async () => ({ok: false as const, detail: 'exit 1 usage limit reached'}))
    await makeCouncilPass(secrets, {fetchFn, run})!()
    expect(run).toHaveBeenCalledTimes(1)
    expect(posts[0]).toEqual({failure: {kind: 'quota', detail: expect.any(String)}})
  })

  it('reports an auth failure without the token the session printed', async () => {
    const {fetchFn, posts} = server(slice)
    const token = `cyi_ah_${'a'.repeat(40)}`
    const run: SupporterRun = vi.fn(async () => ({ok: false as const, detail: `exit 1 401 unauthorized ${token}`}))
    await makeCouncilPass(secrets, {fetchFn, run})!()
    const failure = (posts[0] as {failure: {kind: string; detail: string}}).failure
    expect(failure.kind).toBe('auth')
    expect(failure.detail).not.toContain(token)
  })

  it('reports a failed vote session', async () => {
    const {fetchFn, posts} = server(slice)
    const run: SupporterRun = vi.fn(async (engine, request) =>
      request.prompt.includes('PROPOSE') ? {ok: true as const, text: proposalJson(`from ${engine}`)} : {ok: false as const, detail: 'timed out'})
    await makeCouncilPass(secrets, {fetchFn, run})!()
    expect(run).toHaveBeenCalledTimes(3)
    expect(posts[0]).toEqual({failure: {kind: 'session', detail: 'timed out'}})
  })

  it('reports unreadable proposals as invalid', async () => {
    const {fetchFn, posts} = server(slice)
    const run: SupporterRun = vi.fn(async () => ({ok: true as const, text: 'I could not decide.'}))
    await makeCouncilPass(secrets, {fetchFn, run})!()
    expect(run).toHaveBeenCalledTimes(1)
    expect(posts[0]).toEqual({failure: {kind: 'invalid', detail: expect.any(String)}})
  })

  it('reports unreadable votes as invalid', async () => {
    const {fetchFn, posts} = server(slice)
    const run: SupporterRun = vi.fn(async (engine, request) =>
      ({ok: true as const, text: request.prompt.includes('PROPOSE') ? proposalJson(`from ${engine}`) : 'no votes'}))
    await makeCouncilPass(secrets, {fetchFn, run})!()
    expect(run).toHaveBeenCalledTimes(3)
    expect(posts[0]).toEqual({failure: {kind: 'invalid', detail: expect.any(String)}})
  })

  it('reports a project the machine does not map', async () => {
    const {fetchFn, posts} = server({...slice, project_key: 'NOPE'})
    await makeCouncilPass(secrets, {fetchFn, run: vi.fn()})!()
    expect(posts[0]).toEqual({failure: {kind: 'not_mapped', detail: expect.any(String)}})
  })

  it('logs the server error code when the result is refused', async () => {
    const fetchFn = vi.fn(async (url: string | URL | Request) => String(url).endsWith('/council_slice')
      ? new Response(JSON.stringify({data: {...slice, project_key: 'NOPE'}}), {status: 200})
      : new Response(JSON.stringify({error: {code: 'R409-COUNCIL-001'}}), {status: 409})) as unknown as typeof globalThis.fetch
    const log = vi.fn()
    await makeCouncilPass(secrets, {fetchFn, run: vi.fn(), log})!()
    expect(log).toHaveBeenCalledWith('council: NOPE R409-COUNCIL-001')
  })

  it('logs the HTTP status when the result answer is unreadable', async () => {
    const fetchFn = vi.fn(async (url: string | URL | Request) => String(url).endsWith('/council_slice')
      ? new Response(JSON.stringify({data: {...slice, project_key: 'NOPE'}}), {status: 200})
      : new Response('oops', {status: 502})) as unknown as typeof globalThis.fetch
    const log = vi.fn()
    await makeCouncilPass(secrets, {fetchFn, run: vi.fn(), log})!()
    expect(log).toHaveBeenCalledWith('council: NOPE 502')
  })

  it('never throws when the server cannot be reached', async () => {
    const fetchFn = vi.fn(async () => { throw new Error('offline') }) as unknown as typeof globalThis.fetch
    const log = vi.fn()
    await expect(makeCouncilPass(secrets, {fetchFn, run: vi.fn(), log})!()).resolves.toBeUndefined()
    expect(log).toHaveBeenCalledWith('council: error (continuing): offline')
  })
})

describe('prompts', () => {
  it('asks for proposals with the slice limits and carries the data', () => {
    const prompt = buildProposalPrompt({...slice, open_tickets: [{code: 'LAB-1', title: 'Fix login'}]}, 'claude')
    expect(prompt).toContain('PROPOSE. You are claude')
    expect(prompt).toContain('At most 3 proposals')
    expect(prompt).toContain('one of error, code, product')
    expect(prompt).toContain('Fix login')
  })

  it('asks for votes on the given proposals only', () => {
    const proposal: CouncilProposal = {ref: 'codex-1', proposer: 'codex', title: 'Cache it', problem: 'p', solution: 's',
      kind: 'code', risk: 'low'}
    const prompt = buildCritiquePrompt(slice, 'claude', [proposal])
    expect(prompt).toContain('VOTE. You are claude')
    expect(prompt).toContain('"ref": "codex-1"')
    expect(prompt).toContain('Cache it')
  })
})

describe('parsing', () => {
  it('reads proposals and stamps ref and proposer', () => {
    expect(parseProposals(proposalJson('a'), 'codex')?.[0]).toMatchObject({ref: 'codex-1', proposer: 'codex', title: 'a'})
  })

  it('takes the last JSON object with proposals and drops items that are not objects', () => {
    const text = `draft {"proposals":[{"title":"old"}]} then {bad json} final ${JSON.stringify({proposals: ['x', {title: 'new'}]})}`
    expect(parseProposals(text, 'claude')).toEqual([{title: 'new', ref: 'claude-1', proposer: 'claude'}])
  })

  it('ignores braces inside strings and an object that never closes', () => {
    const text = `${JSON.stringify({proposals: [{title: 'a "}" b'}]})} trailing {"proposals": [`
    expect(parseProposals(text, 'codex')?.[0]).toMatchObject({title: 'a "}" b', ref: 'codex-1'})
  })

  it('finds the JSON after a stray opening brace', () => {
    const text = `Templates use { for blocks.\n${proposalJson('after brace')}`
    expect(parseProposals(text, 'claude')?.[0]).toMatchObject({title: 'after brace', ref: 'claude-1'})
  })

  it('finds the JSON after a stray quote before a brace', () => {
    const text = `He wrote "{ and stopped.\n${proposalJson('after quote')}`
    expect(parseProposals(text, 'claude')?.[0]).toMatchObject({title: 'after quote', ref: 'claude-1'})
  })

  it('skips a balanced block that is not JSON after the answer', () => {
    expect(parseProposals(`${proposalJson('kept')} then {bad json}`, 'codex')?.[0]).toMatchObject({title: 'kept'})
  })

  // A quadratic scan of 200 KB takes minutes; the 5 s bound still catches it, while the CI runner with
  // coverage on is ~35x slower than a laptop and tripped the old 1 s bound on a ~33 ms parse. CYAU-303
  const PARSE_BUDGET_MS = 5000

  it('gives up quickly on output made only of opening braces', () => {
    const started = performance.now()
    expect(parseProposals('{'.repeat(200 * 1024), 'claude')).toBeNull()
    expect(performance.now() - started).toBeLessThan(PARSE_BUDGET_MS)
  })

  it('finds the JSON after about 100 KB of prose with stray braces and quotes', () => {
    const prose = 'Templates use { for blocks and a " here. '.repeat(2500)
    expect(prose.length).toBeGreaterThan(100 * 1024)
    const started = performance.now()
    expect(parseProposals(`${prose}\n${proposalJson('late')}`, 'codex')?.[0]).toMatchObject({title: 'late', ref: 'codex-1'})
    expect(performance.now() - started).toBeLessThan(PARSE_BUDGET_MS)
  })

  it('finds the JSON after more than 256 KB of text', () => {
    const text = `${'plain words without braces. '.repeat(10_000)}\n${proposalJson('far')}`
    expect(text.length).toBeGreaterThan(256 * 1024)
    expect(parseProposals(text, 'codex')?.[0]).toMatchObject({title: 'far'})
  })

  it('returns null on text without proposals', () => {
    expect(parseProposals('no json here', 'claude')).toBeNull()
  })

  it('reads votes and stamps the critic', () => {
    const votes = parseCritiques(JSON.stringify({votes: [{ref: 'claude-1', vote: 'reject', risk: 'serious', reason: 'r'}]}), 'codex')
    expect(votes?.[0]).toMatchObject({ref: 'claude-1', critic: 'codex', vote: 'reject'})
  })

  it('keeps only the vote fields the server reads', () => {
    const text = JSON.stringify({votes: [{ref: 'claude-1', vote: 'approve', risk: 'low', reason: 'r', critic: 'claude', extra: 'x'}]})
    expect(parseCritiques(text, 'codex')).toEqual([{ref: 'claude-1', critic: 'codex', vote: 'approve', risk: 'low', reason: 'r'}])
  })

  it('returns null on text without votes', () => {
    expect(parseCritiques('{"proposals":[]}', 'codex')).toBeNull()
  })

  it('classifies failures', () => {
    expect(failureKind('HTTP 429 rate limit')).toBe('quota')
    expect(failureKind('please run /login')).toBe('auth')
    expect(failureKind('timed out')).toBe('session')
  })
})
