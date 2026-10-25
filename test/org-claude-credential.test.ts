import {afterEach, describe, expect, it, vi} from 'vitest'
import {
  applyOrgClaudeCredential,
  claudeAuthEnv,
  fetchOrgClaudeCredential,
  makeOrgClaudeCredentialReconciler,
  orgClaudeCredential,
  parseOrgClaudeCredential,
  resetOrgClaudeCredential,
  type OrgClaudeCredentialStore,
} from '../src/lib/org-claude-credential'
import {resolveClaudeReviewCredential} from '../src/lib/claude-review-credential'
import {type Secrets} from '../src/lib/config'

const API_KEY = 'sk-ant-api03-orgkey'
const OAUTH = 'sk-ant-oat01-orgtoken'

function memoryStore(initial?: string): OrgClaudeCredentialStore & {value?: string; saves: number; clears: number} {
  const store = {
    value: initial,
    saves: 0,
    clears: 0,
    load: () => store.value,
    save: (token: string) => {
      store.saves++
      store.value = token
      return true
    },
    clear: () => {
      store.clears++
      store.value = undefined
      return true
    },
  }
  return store
}

const secrets: Secrets = {sync: {apiUrl: 'https://cyi.test'}, host: {id: 'host-1', token: 'cyi_ah_hosttoken'}}

function respond(status: number, body?: unknown) {
  return vi.fn(async () => new Response(body === undefined ? null : JSON.stringify(body), {status}))
}

afterEach(() => resetOrgClaudeCredential(memoryStore()))

describe('parseOrgClaudeCredential', () => {
  it('maps an API key and a setup-token to the variable Claude reads', () => {
    expect(parseOrgClaudeCredential(API_KEY)).toEqual({env: 'ANTHROPIC_API_KEY', token: API_KEY})
    expect(parseOrgClaudeCredential(OAUTH)).toEqual({env: 'CLAUDE_CODE_OAUTH_TOKEN', token: OAUTH})
  })

  it('rejects anything that is not a Claude credential', () => {
    expect(parseOrgClaudeCredential('cyi_ah_x')).toBeUndefined()
    expect(parseOrgClaudeCredential('sk-ant-api03 with space')).toBeUndefined()
    expect(parseOrgClaudeCredential(undefined)).toBeUndefined()
  })
})

describe('orgClaudeCredential', () => {
  it('reads the stored credential once', () => {
    const store = memoryStore(OAUTH)
    const load = vi.spyOn(store, 'load')
    resetOrgClaudeCredential(store)

    expect(orgClaudeCredential()).toEqual({env: 'CLAUDE_CODE_OAUTH_TOKEN', token: OAUTH})
    orgClaudeCredential()
    expect(load).toHaveBeenCalledTimes(1)
  })

  it('ignores a malformed stored value', () => {
    resetOrgClaudeCredential(memoryStore('garbage'))

    expect(orgClaudeCredential()).toBeUndefined()
  })
})

describe('applyOrgClaudeCredential', () => {
  it('sets, rotates, keeps and removes, mirroring each change in the store', () => {
    const store = memoryStore()
    resetOrgClaudeCredential(store)

    expect(applyOrgClaudeCredential(parseOrgClaudeCredential(API_KEY))).toBe('set')
    expect(applyOrgClaudeCredential(parseOrgClaudeCredential(API_KEY))).toBe('unchanged')
    expect(applyOrgClaudeCredential(parseOrgClaudeCredential(OAUTH))).toBe('rotated')
    expect(store.value).toBe(OAUTH)
    expect(applyOrgClaudeCredential(undefined)).toBe('removed')
    expect(store.value).toBeUndefined()
    expect(orgClaudeCredential()).toBeUndefined()
    expect(applyOrgClaudeCredential(undefined)).toBe('unchanged')
    expect([store.saves, store.clears]).toEqual([2, 1])
  })
})

describe('claudeAuthEnv', () => {
  const inherited = {ANTHROPIC_API_KEY: 'sk-ant-machine', CLAUDE_CODE_OAUTH_TOKEN: 'sk-ant-oat01-machine', PATH: '/bin'}

  it('passes the machine credentials through when the organization lends none', () => {
    expect(claudeAuthEnv(inherited)).toEqual({ANTHROPIC_API_KEY: 'sk-ant-machine', CLAUDE_CODE_OAUTH_TOKEN: 'sk-ant-oat01-machine'})
  })

  it('replaces every inherited Claude variable with the organization credential', () => {
    resetOrgClaudeCredential(memoryStore(OAUTH))

    expect(claudeAuthEnv(inherited)).toEqual({CLAUDE_CODE_OAUTH_TOKEN: OAUTH})
  })

  // CYAU-223 — the review keeps the same order as the sessions: organization, then environment, then the machine.
  it('the Claude review follows the same precedence, the machine sign-in coming last', () => {
    const machine = () => JSON.stringify({claudeAiOauth: {accessToken: 'sk-ant-oat01-login', expiresAt: Date.now() + 3_600_000}})
    expect(resolveClaudeReviewCredential({env: inherited, readFile: machine}).env).toEqual(claudeAuthEnv(inherited))
    expect(resolveClaudeReviewCredential({env: {PATH: '/bin'}, readFile: machine}))
      .toMatchObject({source: 'machine', env: {CLAUDE_CODE_OAUTH_TOKEN: 'sk-ant-oat01-login'}})

    resetOrgClaudeCredential(memoryStore(API_KEY))
    expect(resolveClaudeReviewCredential({env: inherited, readFile: machine}))
      .toEqual({status: 'valid', source: 'organization', env: claudeAuthEnv(inherited)})
  })
})

describe('fetchOrgClaudeCredential', () => {
  it('asks the server with the host token', async () => {
    const fetchFn = respond(200, {data: {kind: 'api_key', env: 'ANTHROPIC_API_KEY', token: API_KEY}})

    const result = await fetchOrgClaudeCredential(secrets, fetchFn as unknown as typeof fetch)

    expect(result).toEqual({outcome: 'set', value: {env: 'ANTHROPIC_API_KEY', token: API_KEY}})
    expect(fetchFn).toHaveBeenCalledWith('https://cyi.test/api/v1/agent_host/claude_credential', expect.objectContaining({
      method: 'GET',
      headers: {Authorization: 'Bearer cyi_ah_hosttoken'},
    }))
  })

  it.each([404, 403])('reads %i as "no credential for this machine"', async (status) => {
    expect(await fetchOrgClaudeCredential(secrets, respond(status, {error: {}}) as unknown as typeof fetch)).toEqual({outcome: 'none'})
  })

  it.each([
    ['a 401', respond(401)],
    ['a 500', respond(500)],
    ['a malformed token', respond(200, {data: {token: 'not-claude'}})],
    ['a body that is not JSON', vi.fn(async () => new Response('<html>', {status: 200}))],
    ['a network error', vi.fn(async () => { throw new Error('offline') })],
  ])('reads %s as unavailable', async (_label, fetchFn) => {
    expect(await fetchOrgClaudeCredential(secrets, fetchFn as unknown as typeof fetch)).toEqual({outcome: 'unavailable'})
  })

  it('does not call the server without a host identity', async () => {
    const fetchFn = respond(200)

    expect(await fetchOrgClaudeCredential({sync: {}}, fetchFn as unknown as typeof fetch)).toEqual({outcome: 'unavailable'})
    expect(fetchFn).not.toHaveBeenCalled()
  })
})

describe('makeOrgClaudeCredentialReconciler', () => {
  it('is off without a host identity', () => {
    expect(makeOrgClaudeCredentialReconciler({})).toBeUndefined()
  })

  it('fetches on the first beat and then every few beats, logging changes without the token', async () => {
    resetOrgClaudeCredential(memoryStore())
    const log = vi.fn()
    const fetchFn = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({data: {token: API_KEY}}), {status: 200}))
      .mockResolvedValueOnce(new Response(JSON.stringify({data: {token: OAUTH}}), {status: 200}))
      .mockResolvedValueOnce(new Response(null, {status: 500}))
      .mockResolvedValueOnce(new Response(null, {status: 404}))
    const beat = makeOrgClaudeCredentialReconciler(secrets, {fetchFn: fetchFn as unknown as typeof fetch, log, everyBeats: 2})!

    for (let i = 0; i < 8; i++) await beat(true)

    expect(fetchFn).toHaveBeenCalledTimes(4)
    expect(log.mock.calls.map(([message]) => message)).toEqual([
      'claude: using the organization credential for Claude sessions',
      'claude: organization credential rotated',
      'claude: organization credential removed, back to the machine sign-in',
    ])
    expect(JSON.stringify(log.mock.calls)).not.toContain('sk-ant-')
    expect(orgClaudeCredential()).toBeUndefined()
  })

  it('reports each change, so a readiness probe run with the old credential can be dropped', async () => {
    resetOrgClaudeCredential(memoryStore())
    const onChange = vi.fn()
    const fetchFn = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({data: {token: API_KEY}}), {status: 200}))
      .mockResolvedValueOnce(new Response(JSON.stringify({data: {token: API_KEY}}), {status: 200}))
      .mockResolvedValueOnce(new Response(null, {status: 404}))
    const beat = makeOrgClaudeCredentialReconciler(secrets, {fetchFn: fetchFn as unknown as typeof fetch, onChange, everyBeats: 1})!

    for (let i = 0; i < 3; i++) await beat(true)

    expect(onChange.mock.calls).toEqual([['set'], ['removed']])
  })

  it('keeps the last credential when the server cannot be reached', async () => {
    resetOrgClaudeCredential(memoryStore(API_KEY))
    const beat = makeOrgClaudeCredentialReconciler(secrets, {fetchFn: respond(502) as unknown as typeof fetch})!

    await beat(true)

    expect(orgClaudeCredential()?.token).toBe(API_KEY)
  })
})
