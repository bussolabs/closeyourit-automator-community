import {afterEach, describe, expect, it, vi} from 'vitest'
import {
  applyOrgOpenrouterKey,
  fetchOrgOpenrouterKey,
  makeOrgOpenrouterKeyReconciler,
  orgOpenrouterKey,
  resetOrgOpenrouterKey,
  type OrgOpenrouterCredentialStore,
} from '../src/lib/org-openrouter-credential'
import {type Secrets} from '../src/lib/config'
import {isManagedSecretEnv} from '../src/lib/env-capabilities'
import {redactSecrets} from '../src/lib/secret-redaction'

// CYAU-228 — the OpenRouter key OpenCode reviews with, lent by the organization.
const KEY = 'sk-or-v1-orgkey'

function memoryStore(initial?: string): OrgOpenrouterCredentialStore & {value?: string} {
  const store = {
    value: initial,
    load: () => store.value,
    save: (token: string) => { store.value = token; return true },
    clear: () => { store.value = undefined; return true },
  }
  return store
}

const secrets: Secrets = {sync: {apiUrl: 'https://cyi.test'}, host: {id: 'host-1', token: 'cyi_ah_hosttoken'}}

function respond(status: number, body?: unknown) {
  return vi.fn(async () => new Response(body === undefined ? null : JSON.stringify(body), {status}))
}

afterEach(() => resetOrgOpenrouterKey(memoryStore()))

describe('orgOpenrouterKey', () => {
  it('reads the stored key once and ignores anything that is not an OpenRouter key', () => {
    resetOrgOpenrouterKey(memoryStore(KEY))
    expect(orgOpenrouterKey()).toBe(KEY)

    resetOrgOpenrouterKey(memoryStore('sk-ant-api03-claude'))
    expect(orgOpenrouterKey()).toBeUndefined()
  })

  it('sets, rotates and removes the key in memory and in the store', () => {
    const store = memoryStore()
    resetOrgOpenrouterKey(store)

    expect(applyOrgOpenrouterKey(KEY)).toBe('set')
    expect(applyOrgOpenrouterKey(KEY)).toBe('unchanged')
    expect(applyOrgOpenrouterKey('sk-or-v1-new')).toBe('rotated')
    expect(store.value).toBe('sk-or-v1-new')
    expect(applyOrgOpenrouterKey(undefined)).toBe('removed')
    expect(store.value).toBeUndefined()
  })
})

describe('fetchOrgOpenrouterKey', () => {
  it('asks the server with the host token', async () => {
    const fetchFn = respond(200, {data: {env: 'OPENROUTER_API_KEY', token: KEY}})

    expect(await fetchOrgOpenrouterKey(secrets, fetchFn)).toEqual({outcome: 'set', value: KEY})
    const [url, init] = fetchFn.mock.calls[0] as unknown as [string, RequestInit]
    expect(url).toBe('https://cyi.test/api/v1/agent_host/openrouter_credential')
    expect((init.headers as Record<string, string>).Authorization).toBe('Bearer cyi_ah_hosttoken')
  })

  it('treats 404 and 403 as no key, and anything else as unknown', async () => {
    expect(await fetchOrgOpenrouterKey(secrets, respond(404))).toEqual({outcome: 'none'})
    expect(await fetchOrgOpenrouterKey(secrets, respond(403))).toEqual({outcome: 'none'})
    expect(await fetchOrgOpenrouterKey(secrets, respond(500))).toEqual({outcome: 'unavailable'})
    expect(await fetchOrgOpenrouterKey(secrets, respond(200, {data: {token: 'not-a-key'}}))).toEqual({outcome: 'unavailable'})
  })
})

describe('makeOrgOpenrouterKeyReconciler', () => {
  it('fetches on the first beat and then every five, never logging the key', async () => {
    const store = memoryStore()
    resetOrgOpenrouterKey(store)
    const fetchFn = respond(200, {data: {token: KEY}})
    const logs: string[] = []
    const beat = makeOrgOpenrouterKeyReconciler(secrets, {fetchFn, log: (message) => logs.push(message)})!

    for (let index = 0; index < 6; index++) await beat(true)

    expect(fetchFn).toHaveBeenCalledTimes(2)
    expect(store.value).toBe(KEY)
    expect(logs.join('\n')).not.toContain(KEY)
  })

  it('keeps the last key when the server cannot be reached', async () => {
    resetOrgOpenrouterKey(memoryStore(KEY))
    await makeOrgOpenrouterKeyReconciler(secrets, {fetchFn: respond(503)})!(true)

    expect(orgOpenrouterKey()).toBe(KEY)
  })
})

describe('OpenRouter key outside the review', () => {
  it('is a managed secret, stripped from actions, and redacted from output', () => {
    expect(isManagedSecretEnv('OPENROUTER_API_KEY')).toBe(true)
    expect(redactSecrets(`token ${KEY} and OPENROUTER_API_KEY=${KEY}`)).not.toContain('orgkey')
  })
})
