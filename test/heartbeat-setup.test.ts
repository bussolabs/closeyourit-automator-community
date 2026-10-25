import {describe, expect, it, vi} from 'vitest'
import {ensureHeartbeatConfig, heartbeatSlug, resolveProjectId} from '../src/lib/heartbeat-setup'
import {type Secrets, type SecretsUpdater} from '../src/lib/config'

// CYAU-220 — the machine resolves its install project and writes its own heartbeat section.

type Page = {ok?: boolean; status?: number; body?: unknown}

function pagedFetch(pages: Page[]) {
  const urls: string[] = []
  const fn = vi.fn(async (input: string | URL | Request) => {
    urls.push(String(input))
    const page = pages[urls.length - 1] ?? {body: {data: []}}
    return {ok: page.ok ?? true, status: page.status ?? 200, json: async () => page.body} as Response
  })
  return {fn: fn as unknown as typeof globalThis.fetch, urls}
}

// A server that never answers: the request ends only when the signal aborts it.
const hangingFetch = (async (_input: string | URL | Request, init?: RequestInit) => new Promise<Response>((_resolve, reject) => {
  init?.signal?.addEventListener('abort', () => reject(new Error('aborted')))
})) as unknown as typeof globalThis.fetch

describe('resolveProjectId', () => {
  it('finds the key on a later page, case-insensitive, with the service account bearer', async () => {
    const auth: Array<string | null> = []
    const pages: Page[] = [
      {body: {data: [{id: 'p-1', key: 'CYRA'}], meta: {total_pages: 2}}},
      {body: {data: [{id: 'p-2', key: 'cyau'}], meta: {total_pages: 2}}},
    ]
    const fn = vi.fn(async (_input: string | URL | Request, init?: RequestInit) => {
      auth.push(new Headers(init?.headers).get('Authorization'))
      const page = pages[auth.length - 1]
      return {ok: true, status: 200, json: async () => page.body} as Response
    })
    const result = await resolveProjectId('CYAU', 'cyi_u_sa', {apiUrl: 'https://api.example', fetchFn: fn as unknown as typeof globalThis.fetch})

    expect(result).toEqual({outcome: 'found', id: 'p-2'})
    expect(fn.mock.calls.map((call) => String(call[0]))).toEqual([
      'https://api.example/cli/v1/projects?page=1&per=100',
      'https://api.example/cli/v1/projects?page=2&per=100',
    ])
    expect(auth).toEqual(['Bearer cyi_u_sa', 'Bearer cyi_u_sa'])
  })

  it('default API when no apiUrl is configured', async () => {
    const {fn, urls} = pagedFetch([{body: {data: [{id: 'p-1', key: 'CYAU'}]}}])
    await resolveProjectId('CYAU', 'cyi_u_sa', {fetchFn: fn})
    expect(urls[0]).toBe('https://app.closeyour.it/cli/v1/projects?page=1&per=100')
  })

  it('key absent from every page → not visible to this machine', async () => {
    const {fn} = pagedFetch([{body: {data: [{id: 'p-1', key: 'CYRA'}, null, {key: 'CYAU'}], meta: {total_pages: 1}}}])
    await expect(resolveProjectId('CYAU', 'cyi_u_sa', {fetchFn: fn})).resolves.toEqual({
      outcome: 'missing', reason: "project CYAU is not visible to this machine's service account",
    })
  })

  it('refused lookup → the HTTP status, never the body', async () => {
    const {fn} = pagedFetch([{ok: false, status: 403, body: {error: 'cyi_u_leaked'}}])
    const result = await resolveProjectId('CYAU', 'cyi_u_sa', {fetchFn: fn})
    expect(result).toEqual({outcome: 'missing', reason: 'project lookup refused by CloseYourIt (HTTP 403)'})
    expect(JSON.stringify(result)).not.toContain('cyi_')
  })

  it('unreadable body → treated as an empty page', async () => {
    const fn = vi.fn(async () => ({ok: true, status: 200, json: async () => {
      throw new Error('not json')
    }}) as unknown as Response)
    await expect(resolveProjectId('CYAU', 'cyi_u_sa', {fetchFn: fn as unknown as typeof globalThis.fetch}))
      .resolves.toMatchObject({outcome: 'missing'})
  })

  it('network error → missing, never throws', async () => {
    const fn = vi.fn(async () => {
      throw new Error('ECONNREFUSED')
    })
    await expect(resolveProjectId('CYAU', 'cyi_u_sa', {fetchFn: fn as unknown as typeof globalThis.fetch})).resolves.toEqual({
      outcome: 'missing', reason: 'project lookup failed (CloseYourIt not reachable)',
    })
  })

  it('server that does not answer → stops at the timeout and says so', async () => {
    const started = Date.now()
    const result = await resolveProjectId('CYAU', 'cyi_u_sa', {fetchFn: hangingFetch, timeoutMs: 50})
    expect(result).toEqual({outcome: 'missing', reason: 'project lookup timed out (CloseYourIt did not answer in time)'})
    expect(Date.now() - started).toBeLessThan(5000)
  })

  it('a server announcing endless pages is not walked forever', async () => {
    const fn = vi.fn(async () => ({ok: true, status: 200, json: async () => ({data: [], meta: {total_pages: 10_000}})}) as Response)
    await resolveProjectId('CYAU', 'cyi_u_sa', {fetchFn: fn as unknown as typeof globalThis.fetch})
    expect(fn).toHaveBeenCalledTimes(20)
  })
})

describe('heartbeatSlug', () => {
  it('derives a stable monitor name from the host id', () => {
    expect(heartbeatSlug('0b9f2c1e-AB12-4c3d')).toBe('automator-0b9f2c1e-ab12-4c3d')
    expect(heartbeatSlug('h 1/x')).toBe('automator-h-1-x')
  })
})

describe('ensureHeartbeatConfig', () => {
  const registered = (): Secrets => ({sync: {apiUrl: 'https://api.example'}, host: {id: 'h1', token: 'cyi_ah_host'}})
  // A fresh server per test: the project is always found, so only the step under test can fail.
  const deps = () => ({
    projectKey: (): string | undefined => 'CYAU',
    serviceToken: (): string | undefined => 'cyi_u_sa',
    fetchFn: pagedFetch([{body: {data: [{id: 'p-cyau', key: 'CYAU'}]}}]).fn,
  })

  it('host not registered → missing, no lookup', async () => {
    const fetchFn = vi.fn()
    await expect(ensureHeartbeatConfig({sync: {}}, {...deps(), fetchFn: fetchFn as unknown as typeof globalThis.fetch}))
      .resolves.toEqual({status: 'missing', reason: 'this host is not registered yet'})
    expect(fetchFn).not.toHaveBeenCalled()
  })

  it('no project chosen at install → missing with the reason', async () => {
    await expect(ensureHeartbeatConfig(registered(), {...deps(), projectKey: () => undefined}))
      .resolves.toEqual({status: 'missing', reason: 'no project chosen at install (managed mode, --secrets-project)'})
  })

  it('no service account token → missing with the reason', async () => {
    await expect(ensureHeartbeatConfig(registered(), {...deps(), serviceToken: () => 'cyi_ah_wrong-kind'}))
      .resolves.toEqual({status: 'missing', reason: 'no service account token in the credential store'})
  })

  it('the token already in memory is used by default', async () => {
    const {fn} = pagedFetch([{body: {data: [{id: 'p-cyau', key: 'CYAU'}]}}])
    const update: SecretsUpdater = (mutate) => ({updated: true, secrets: mutate({})!})
    const secrets = {...registered(), cyiToken: 'cyi_u_memory'}
    const result = await ensureHeartbeatConfig(secrets, {projectKey: () => 'CYAU', fetchFn: fn, update})
    expect(result).toEqual({status: 'configured', heartbeat: {apiUrl: 'https://api.example', projectId: 'p-cyau', slug: 'automator-h1'}})
    expect(vi.mocked(fn).mock.calls[0][1]?.headers).toEqual({Authorization: 'Bearer cyi_u_memory'})
  })

  it('save failure → missing, never throws, nothing set in memory', async () => {
    const secrets = registered()
    const update: SecretsUpdater = () => {
      throw new Error('disk full')
    }
    await expect(ensureHeartbeatConfig(secrets, {...deps(), update}))
      .resolves.toEqual({status: 'missing', reason: 'the heartbeat section could not be saved'})
    expect(secrets.heartbeat).toBeUndefined()
  })

  it('an updater that keeps nothing → missing, never a phantom section', async () => {
    const update: SecretsUpdater = () => ({updated: false, secrets: {}})
    await expect(ensureHeartbeatConfig(registered(), {...deps(), update}))
      .resolves.toEqual({status: 'missing', reason: 'the heartbeat section could not be saved'})
  })

  it('server silent at start → missing within the timeout, the start goes on', async () => {
    const update = vi.fn()
    const result = await ensureHeartbeatConfig(registered(), {...deps(), fetchFn: hangingFetch, timeoutMs: 50, update})
    expect(result).toEqual({status: 'missing', reason: 'project lookup timed out (CloseYourIt did not answer in time)'})
    expect(update).not.toHaveBeenCalled()
  })
})
