import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import {describe, expect, it, vi} from 'vitest'
import {ensureHostRegistered as ensureHostRegisteredRaw, makeHostRegistrar, type HostRegistrarDeps} from '../src/lib/host'
import {type AutomatorClient, type HostRegistration, type RegisteredHost} from '../src/lib/client'
import {loadSecrets, saveSecrets, updateSecrets, type Secrets} from '../src/lib/config'
import {withHostRotationLock} from '../src/lib/host-auth'

// Fake client: records the calls to registerHost and returns the injected outcome (default: valid host).
function fakeClient(impl?: (reg: HostRegistration) => RegisteredHost | null): {client: AutomatorClient; calls: HostRegistration[]} {
  const calls: HostRegistration[] = []
  const client: AutomatorClient = {
    getWorkspaceManifest: async () => null,
    registerHost: async (reg) => {
      calls.push(reg)
      return impl ? impl(reg) : {id: 'h1', token: 'cyi_ah_secret'}
    },
    acquireLease: async () => ({outcome: 'error', lease: null}),
    releaseLease: async () => false,
  }
  return {client, calls}
}

const claimCandidate = (candidate: string): string => candidate

// The suite also runs on the development Mac, but the product registers exclusively Linux hosts.
const ensureHostRegistered = (deps: HostRegistrarDeps) => ensureHostRegisteredRaw({platform: 'linux', ...deps})

describe('ensureHostRegistered', () => {
  it('first registration: generates the fingerprint, registers and persists id+credential+fingerprint', async () => {
    const {client, calls} = fakeClient()
    const secrets: Secrets = {sync: {orgToken: 'cyi_a_x'}}
    const saved: Secrets[] = []
    const res = await ensureHostRegistered({
      clientForSync: () => client,
      secrets,
      save: (s) => saved.push(structuredClone(s)),
      hostname: () => 'minion-linux',
      platform: 'linux',
      arch: 'arm64',
      version: '0.0.1',
      newFingerprint: () => 'fp-uuid',
      claimFingerprint: claimCandidate,
    })
    expect(res.status).toBe('registered')
    expect(res.host).toEqual({id: 'h1', token: 'cyi_ah_secret'})
    expect(calls).toHaveLength(1)
    expect(calls[0]).toMatchObject({
      fingerprint: 'fp-uuid',
      hostname: 'minion-linux',
      platform: 'linux',
      arch: 'arm64',
      automator_version: '0.0.1',
    })
    // The fingerprint is persisted BEFORE the POST (first save), the identity after (last save).
    expect(saved[0].hostFingerprint).toBe('fp-uuid')
    expect(saved.at(-1)?.host).toEqual({id: 'h1', token: 'cyi_ah_secret'})
    // Preserva i segreti preesistenti (sync) nell'oggetto salvato.
    expect(saved.at(-1)?.sync).toEqual({orgToken: 'cyi_a_x'})
  })

  it('registers with the service account token (cyi_u_), without org token', async () => {
    const {client, calls} = fakeClient()
    const secrets: Secrets = {sync: {apiUrl: 'https://x.example'}}
    const saved: Secrets[] = []
    const res = await ensureHostRegistered({
      clientForSync: () => client,
      loadRegistrationToken: () => 'cyi_u_sa',
      secrets,
      save: (s) => saved.push(structuredClone(s)),
      newFingerprint: () => 'fp-sa',
      claimFingerprint: claimCandidate,
    })
    expect(res.status).toBe('registered')
    expect(res.host).toEqual({id: 'h1', token: 'cyi_ah_secret'})
    expect(calls).toHaveLength(1)
    expect(saved.at(-1)?.host).toEqual({id: 'h1', token: 'cyi_ah_secret'})
  })

  it('without service account token nor org token → failed, does not call the client', async () => {
    const {client, calls} = fakeClient()
    const secrets: Secrets = {sync: {apiUrl: 'https://x.example'}}
    const res = await ensureHostRegistered({
      clientForSync: () => client,
      loadRegistrationToken: () => undefined,
      secrets,
      save: () => {
        throw new Error('non deve salvare senza autorità di registrazione')
      },
      newFingerprint: () => 'fp-x',
      claimFingerprint: claimCandidate,
    })
    expect(res.status).toBe('failed')
    expect(calls).toHaveLength(0)
  })

  it('idempotent: host already present → no-op, does not call the client', async () => {
    const {client, calls} = fakeClient()
    const secrets: Secrets = {host: {id: 'h1', token: 'cyi_ah_x'}, hostFingerprint: 'fp'}
    const res = await ensureHostRegistered({
      clientForSync: () => client,
      secrets,
      save: () => {
        throw new Error('non deve salvare quando è già registrato')
      },
    })
    expect(res.status).toBe('existing')
    expect(res.host).toEqual({id: 'h1', token: 'cyi_ah_x'})
    expect(calls).toHaveLength(0)
  })

  it('requires the re-read org token only when a new registration is really needed', async () => {
    const clientForSync = vi.fn(() => fakeClient().client)
    const secrets: Secrets = {sync: {orgToken: 'cyi_a_stale'}}

    await expect(ensureHostRegistered({
      clientForSync,
      secrets,
      load: () => ({sync: {apiUrl: 'https://current.example'}}),
      claimFingerprint: claimCandidate,
    })).resolves.toEqual({status: 'failed', host: null})

    expect(clientForSync).not.toHaveBeenCalled()
  })

  it.each([
    {name: 'Server Host token not valid for Automator', host: {id: 'h-old', token: 'cyi_h_server'}},
    {name: 'malformed id', host: {id: '', token: 'cyi_ah_host'}},
  ])('$name: re-registers with the same fingerprint and persists the new identity', async ({host}) => {
    const {client, calls} = fakeClient(() => ({id: 'h-new', token: 'cyi_ah_new'}))
    const secrets: Secrets = {sync: {orgToken: 'cyi_a_x'}, host, hostFingerprint: 'fp-stabile'}
    const saved: Secrets[] = []
    const res = await ensureHostRegistered({
      clientForSync: () => client, secrets,
      save: (s) => saved.push(structuredClone(s)), claimFingerprint: claimCandidate,
    })

    expect(res).toEqual({status: 'registered', host: {id: 'h-new', token: 'cyi_ah_new'}})
    expect(calls).toHaveLength(1)
    expect(calls[0].fingerprint).toBe('fp-stabile')
    expect(saved.at(-1)?.host).toEqual({id: 'h-new', token: 'cyi_ah_new'})
    expect(saved.at(-1)?.hostFingerprint).toBe('fp-stabile')
  })

  it('retry after a failure: reuses the persisted fingerprint (no new UUID)', async () => {
    const {client, calls} = fakeClient()
    const secrets: Secrets = {sync: {orgToken: 'cyi_a_x'}, hostFingerprint: 'fp-persistito'}
    const res = await ensureHostRegistered({
      clientForSync: () => client,
      secrets,
      save: () => undefined,
      newFingerprint: () => 'fp-nuovo',
      claimFingerprint: claimCandidate,
    })
    expect(res.status).toBe('registered')
    expect(calls[0].fingerprint).toBe('fp-persistito')
  })

  it.skipIf(process.platform !== 'linux')('two concurrent bootstraps without fingerprint converge to a single server identity', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'automator-host-concurrent-'))
    const previous = process.env.AUTOMATOR_CONFIG_DIR
    process.env.AUTOMATOR_CONFIG_DIR = dir
    const identities = new Map<string, RegisteredHost>()
    const calls: HostRegistration[] = []
    const client = fakeClient((registration) => {
      calls.push(registration)
      const existing = identities.get(registration.fingerprint)
      if (existing) return existing
      const created = {id: `h-${identities.size + 1}`, token: `cyi_ah_${identities.size + 1}`}
      identities.set(registration.fingerprint, created)
      return created
    }).client

    try {
      saveSecrets({sync: {orgToken: 'cyi_a_x'}})
      const productionDeps = {
        clientForSync: () => client,
        load: loadSecrets,
        update: updateSecrets,
        withMutationLock: withHostRotationLock,
      }
      const [first, second] = await Promise.all([
        ensureHostRegistered({...productionDeps, secrets: loadSecrets(), newFingerprint: () => 'fp-a'}),
        ensureHostRegistered({...productionDeps, secrets: loadSecrets(), newFingerprint: () => 'fp-b'}),
      ])

      expect(first.host).toEqual(second.host)
      expect(identities.size).toBe(1)
      expect(calls).toHaveLength(1)
      expect(new Set(calls.map((call) => call.fingerprint))).toEqual(new Set([loadSecrets().hostFingerprint]))
      expect(loadSecrets().host).toEqual(first.host)
    } finally {
      if (previous === undefined) delete process.env.AUTOMATOR_CONFIG_DIR
      else process.env.AUTOMATOR_CONFIG_DIR = previous
      fs.rmSync(dir, {recursive: true, force: true})
    }
  })

  it('failed registration → status failed, still persists the fingerprint, no host', async () => {
    const {client} = fakeClient(() => null)
    const secrets: Secrets = {sync: {orgToken: 'cyi_a_x'}}
    const saved: Secrets[] = []
    const res = await ensureHostRegistered({
      clientForSync: () => client,
      secrets,
      save: (s) => saved.push(structuredClone(s)),
      newFingerprint: () => 'fp',
      claimFingerprint: claimCandidate,
    })
    expect(res.status).toBe('failed')
    expect(res.host).toBeNull()
    expect(saved[0].hostFingerprint).toBe('fp')
    expect(saved.every((s) => s.host === undefined)).toBe(true)
  })

  it('omits automator_version when not provided', async () => {
    const {client, calls} = fakeClient()
    await ensureHostRegistered({
      clientForSync: () => client, secrets: {sync: {orgToken: 'cyi_a_x'}}, save: () => undefined,
      newFingerprint: () => 'fp', claimFingerprint: claimCandidate,
    })
    expect(calls[0]).not.toHaveProperty('automator_version')
  })

  it('fingerprint persistence error → failed without propagating (best-effort at boot)', async () => {
    const {client, calls} = fakeClient()
    const res = await ensureHostRegistered({
      clientForSync: () => client,
      secrets: {sync: {orgToken: 'cyi_a_x'}},
      newFingerprint: () => 'fp',
      claimFingerprint: claimCandidate,
      save: () => {
        throw new Error('disk full')
      },
    })
    expect(res.status).toBe('failed')
    expect(res.host).toBeNull()
    expect(calls).toHaveLength(0)
  })

  it('persistence error after the registration → failed without propagating', async () => {
    const {client} = fakeClient()
    const res = await ensureHostRegistered({
      clientForSync: () => client,
      secrets: {sync: {orgToken: 'cyi_a_x'}, hostFingerprint: 'fp'},
      claimFingerprint: claimCandidate,
      save: () => {
        throw new Error('disk full')
      },
    })
    expect(res.status).toBe('failed')
    expect(res.host).toBeNull()
  })
})

describe('makeHostRegistrar', () => {
  it('undefined if the sync is not configured', () => {
    expect(makeHostRegistrar({})).toBeUndefined()
  })

  it('returns a function if the sync is configured', () => {
    expect(typeof makeHostRegistrar({sync: {orgToken: 'cyi_a_x'}})).toBe('function')
  })

  it('valid host without org token → idempotent existing registrar, without POST', async () => {
    const fetchFn = vi.fn()
    const registrar = makeHostRegistrar({sync: {}, host: {id: 'h1', token: 'cyi_ah_host'}}, undefined, fetchFn as unknown as typeof globalThis.fetch, undefined, undefined, {projectKey: () => undefined})
    expect(registrar).toBeDefined()
    await expect(registrar!()).resolves.toMatchObject({status: 'existing', host: {id: 'h1', token: 'cyi_ah_host'}})
    expect(fetchFn).not.toHaveBeenCalled()
  })

  it('missing host without org token → undefined: cannot bootstrap', () => {
    expect(makeHostRegistrar({sync: {}})).toBeUndefined()
  })

  it.skipIf(process.platform !== 'linux')('rebuilds the bootstrap client inside the lock using only the re-read apiUrl and orgToken', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'automator-host-reload-'))
    const previous = process.env.AUTOMATOR_CONFIG_DIR
    process.env.AUTOMATOR_CONFIG_DIR = dir
    const fetchFn = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      expect(String(input)).toBe('https://current.example/api/v1/hosts')
      expect(new Headers(init?.headers).get('Authorization')).toBe('Bearer cyi_a_current')
      return {ok: true, status: 201, json: async () => ({data: {id: 'h1', token: 'cyi_ah_current'}})} as Response
    })

    try {
      saveSecrets({sync: {apiUrl: 'https://stale.example', orgToken: 'cyi_a_stale'}})
      const registrar = makeHostRegistrar(loadSecrets(), undefined, fetchFn as typeof globalThis.fetch)
      saveSecrets({sync: {apiUrl: 'https://current.example', orgToken: 'cyi_a_current'}})

      await expect(registrar!()).resolves.toMatchObject({
        status: 'registered', host: {id: 'h1', token: 'cyi_ah_current'},
      })
      expect(fetchFn).toHaveBeenCalledTimes(1)
    } finally {
      if (previous === undefined) delete process.env.AUTOMATOR_CONFIG_DIR
      else process.env.AUTOMATOR_CONFIG_DIR = previous
      fs.rmSync(dir, {recursive: true, force: true})
    }
  })
})

// CYAU-220 — every registration command goes through makeHostRegistrar, so the heartbeat section is written there.
describe('makeHostRegistrar → heartbeat section', () => {
  const PROJECTS = {data: [{id: 'p-other', key: 'CYRA'}, {id: 'p-cyau', key: 'CYAU'}], meta: {total_pages: 1}}

  // Answers the host registration and the project list; records every URL and bearer it saw.
  function serverFetch(projects: unknown = PROJECTS, registration: {ok: boolean} = {ok: true}) {
    const calls: Array<{url: string; auth: string | null}> = []
    const fn = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input)
      calls.push({url, auth: new Headers(init?.headers).get('Authorization')})
      if (url.endsWith('/api/v1/hosts')) {
        return {ok: registration.ok, status: registration.ok ? 201 : 503, json: async () => ({data: {id: 'h1', token: 'cyi_ah_new'}})} as Response
      }
      return {ok: true, status: 200, json: async () => projects} as Response
    })
    return {fn: fn as unknown as typeof globalThis.fetch, calls}
  }

  // In-memory secrets.json behind the same updater contract as updateSecrets.
  function memoryUpdate(initial: Secrets) {
    let stored = structuredClone(initial)
    const update = vi.fn((mutate: (current: Secrets) => Secrets | null) => {
      const next = mutate(structuredClone(stored))
      if (next === null) return {updated: false, secrets: structuredClone(stored)}
      stored = structuredClone(next)
      return {updated: true, secrets: structuredClone(next)}
    })
    return {update, stored: () => stored}
  }

  const heartbeatDeps = (update?: ReturnType<typeof memoryUpdate>['update']) => ({
    projectKey: () => 'CYAU',
    serviceToken: () => 'cyi_u_service',
    ...(update ? {update} : {}),
  })

  async function inConfigDir(run: () => Promise<void>): Promise<void> {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'automator-host-heartbeat-'))
    const previous = process.env.AUTOMATOR_CONFIG_DIR
    process.env.AUTOMATOR_CONFIG_DIR = dir
    try {
      await run()
    } finally {
      if (previous === undefined) delete process.env.AUTOMATOR_CONFIG_DIR
      else process.env.AUTOMATOR_CONFIG_DIR = previous
      fs.rmSync(dir, {recursive: true, force: true})
    }
  }

  it.skipIf(process.platform !== 'linux')('fresh registration → writes the heartbeat section for the install project', async () => {
    await inConfigDir(async () => {
      const {fn, calls} = serverFetch()
      const logs: string[] = []
      saveSecrets({sync: {apiUrl: 'https://api.example', orgToken: 'cyi_a_x'}})
      const registrar = makeHostRegistrar(loadSecrets(), (m) => logs.push(m), fn, undefined, 'linux', heartbeatDeps())
      const result = await registrar!()

      expect(result).toMatchObject({status: 'registered', heartbeat: {status: 'configured'}})
      expect(loadSecrets().heartbeat).toEqual({apiUrl: 'https://api.example', projectId: 'p-cyau', slug: 'automator-h1'})
      // The lookup goes to the CLI project list with the service account token, never with the host token.
      expect(calls[1]).toEqual({url: 'https://api.example/cli/v1/projects?page=1&per=100', auth: 'Bearer cyi_u_service'})
      expect(logs.some((m) => m.includes('heartbeat: configured for project p-cyau (monitor automator-h1)'))).toBe(true)
      // No secret in the log lines nor in the saved section.
      expect(logs.join('\n')).not.toMatch(/cyi_(u|ah|a)_/)
      expect(JSON.stringify(loadSecrets().heartbeat)).not.toMatch(/cyi_/)
    })
  })

  it.skipIf(process.platform !== 'linux')('failed registration → no heartbeat attempt', async () => {
    await inConfigDir(async () => {
      const {fn, calls} = serverFetch(PROJECTS, {ok: false})
      saveSecrets({sync: {orgToken: 'cyi_a_x'}})
      const result = await makeHostRegistrar(loadSecrets(), undefined, fn, undefined, 'linux', heartbeatDeps())!()

      expect(result).toEqual({status: 'failed', host: null})
      expect(calls.some((call) => call.url.includes('/cli/v1/projects'))).toBe(false)
      expect(loadSecrets().heartbeat).toBeUndefined()
    })
  })

  it('host registered before the fix, no heartbeat → the restart writes it', async () => {
    const secrets: Secrets = {sync: {}, host: {id: 'h1', token: 'cyi_ah_host'}}
    const memory = memoryUpdate(secrets)
    const {fn} = serverFetch()
    const result = await makeHostRegistrar(secrets, undefined, fn, undefined, undefined, heartbeatDeps(memory.update))!()

    expect(result).toMatchObject({status: 'existing', heartbeat: {status: 'configured'}})
    expect(memory.stored().heartbeat).toEqual({projectId: 'p-cyau', slug: 'automator-h1'})
    // Updated in place: the beat built right after the registration sees it.
    expect(secrets.heartbeat).toEqual({projectId: 'p-cyau', slug: 'automator-h1'})
  })

  it('heartbeat section already present → left identical, no lookup, no write', async () => {
    const heartbeat = {projectId: 'p-first', slug: 'chosen-by-hand', environment: 'staging'}
    const secrets: Secrets = {sync: {}, host: {id: 'h1', token: 'cyi_ah_host'}, heartbeat}
    const memory = memoryUpdate(secrets)
    const {fn} = serverFetch()
    const result = await makeHostRegistrar(secrets, undefined, fn, undefined, undefined, heartbeatDeps(memory.update))!()

    expect(result.heartbeat).toEqual({status: 'existing', heartbeat})
    expect(secrets.heartbeat).toEqual(heartbeat)
    expect(fn).not.toHaveBeenCalled()
    expect(memory.update).not.toHaveBeenCalled()
  })

  it('a section written meanwhile by another process wins over the one just composed', async () => {
    const secrets: Secrets = {sync: {}, host: {id: 'h1', token: 'cyi_ah_host'}}
    const memory = memoryUpdate({...secrets, heartbeat: {projectId: 'p-first', slug: 'other'}})
    const {fn} = serverFetch()
    const result = await makeHostRegistrar(secrets, undefined, fn, undefined, undefined, heartbeatDeps(memory.update))!()

    expect(result.heartbeat).toEqual({status: 'existing', heartbeat: {projectId: 'p-first', slug: 'other'}})
    expect(memory.stored().heartbeat).toEqual({projectId: 'p-first', slug: 'other'})
    expect(secrets.heartbeat).toEqual({projectId: 'p-first', slug: 'other'})
  })

  it('project not visible to the machine → missing with the reason, nothing written', async () => {
    const secrets: Secrets = {sync: {}, host: {id: 'h1', token: 'cyi_ah_host'}}
    const memory = memoryUpdate(secrets)
    const {fn} = serverFetch({data: [{id: 'p-other', key: 'CYRA'}], meta: {total_pages: 1}})
    const result = await makeHostRegistrar(secrets, undefined, fn, undefined, undefined, heartbeatDeps(memory.update))!()

    expect(result).toMatchObject({status: 'existing'})
    expect(result.heartbeat).toEqual({status: 'missing', reason: "project CYAU is not visible to this machine's service account"})
    expect(memory.update).not.toHaveBeenCalled()
    expect(secrets.heartbeat).toBeUndefined()
  })
})
