import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import {describe, expect, it, vi} from 'vitest'
import {materialize, buildSync, makeSync, type HostMap} from '../src/lib/sync'
import {type AutomatorClient} from '../src/lib/client'
import {type RunResult} from '../src/lib/executor'
import {loadSecrets, saveSecrets, type Secrets} from '../src/lib/config'
import {PlaybookSchema} from '../src/lib/schema'
import {type WorkspaceManifest, type WorkspaceManifestRepository} from '../src/lib/workspace-manifest'

// CYAU-87: the sync is host-scoped. The server says WHICH repositories belong to this host (manifest); the
// local host map says WHERE they are. From there a single queue sentinel per project is born: runtime, permissions,
// skill and TTL do not live here, the claimed phase profile imposes them.
const entry = (key: string, repo?: string): WorkspaceManifestRepository => {
  const full = repo ?? `bussolabs/${key.toLowerCase()}`
  return {project_key: key, path: full.split('/').pop() as string, repo: full, default_branch: 'main'}
}

function manifest(repositories: WorkspaceManifestRepository[]): WorkspaceManifest {
  return {version: 1, digest: 'd1', workspace_root_hint: 'Lavoro/Github/Personale', repositories}
}

const hosts: HostMap = {
  CYI: {cwd: '/repos/closeyourit-rails'},
  DR: {cwd: '/repos/driverone-rails'},
}

function fakeClient(m: WorkspaceManifest | null): AutomatorClient {
  return {getWorkspaceManifest: async () => m} as unknown as AutomatorClient
}

const result = (over: Partial<RunResult> = {}): RunResult => ({
  status: 'success', exitCode: 0, errorCode: null, durationMs: 42, logPath: '/tmp/log', stdout: 'ok', ...over,
})

async function withStoredSecrets<T>(secrets: Secrets, run: () => Promise<T>): Promise<T> {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'automator-sync-auth-'))
  const previous = process.env.AUTOMATOR_CONFIG_DIR
  process.env.AUTOMATOR_CONFIG_DIR = dir
  try {
    saveSecrets(secrets)
    return await run()
  } finally {
    if (previous === undefined) delete process.env.AUTOMATOR_CONFIG_DIR
    else process.env.AUTOMATOR_CONFIG_DIR = previous
    fs.rmSync(dir, {recursive: true, force: true})
  }
}

function sequencedFetch(responses: Array<{ok: boolean; status: number; json?: unknown}>) {
  const calls: Array<{url: string; opts: RequestInit}> = []
  const fn = vi.fn(async (url: string | URL, opts?: RequestInit) => {
    const response = responses.shift()
    if (!response) throw new Error('fetch inattesa')
    calls.push({url: String(url), opts: opts ?? {}})
    return {
      ok: response.ok,
      status: response.status,
      json: async () => response.json,
    } as unknown as Response
  })
  return {fn: fn as unknown as typeof globalThis.fetch, calls}
}

describe('materialize', () => {
  it('one queue sentinel for every manifest project present in the host map', () => {
    const m = materialize(manifest([entry('CYI'), entry('DR')]), hosts)
    expect(Object.keys(m.actions)).toHaveLength(2)
    expect(m.skipped).toHaveLength(0)
  })

  it('project not in the host map → skipped (never a silent drop)', () => {
    const m = materialize(manifest([entry('NOPE')]), hosts)
    expect(m.actions).toEqual({})
    expect(m.skipped).toEqual([{projectKey: 'NOPE', reason: 'host-unmapped'}])
  })

  it('manifest entry without project key → skipped, no action', () => {
    const m = materialize(manifest([{project_key: '  ', path: 'x', repo: 'bussolabs/x', default_branch: 'main'}]), hosts)
    expect(m.actions).toEqual({})
    expect(m.skipped).toEqual([{projectKey: '', reason: 'project-key-missing'}])
  })

  it('the sentinel carries the cwd from the local host configuration', () => {
    const m = materialize(manifest([entry('CYI')]), hosts)
    const action = Object.values(m.actions)[0] as Record<string, unknown>
    expect(action).toMatchObject({
      type: 'claude',
      cwd: '/repos/closeyourit-rails',
      containment: 'strong',
    })
  })

  it('the sentinel does NOT carry runtime, permissions or timeout from the remote: the phase profile imposes them', () => {
    const m = materialize(manifest([entry('CYI')]), hosts)
    const action = Object.values(m.actions)[0] as Record<string, unknown>
    expect(action).not.toHaveProperty('permission_mode')
    expect(action).not.toHaveProperty('allowed_tools')
    expect(action).not.toHaveProperty('model')
    expect(action).not.toHaveProperty('timeout')
    expect(action).not.toHaveProperty('ticket')
  })

  it('project repeated in the manifest → a single action (defensive dedup)', () => {
    const m = materialize(manifest([entry('CYI'), entry('CYI', 'bussolabs/altro')]), hosts)
    expect(Object.keys(m.actions)).toHaveLength(1)
    expect(Object.keys(m.ticketQueues)).toHaveLength(1)
    expect(m.skipped).toEqual([])
  })

  it('the queue target carries project and repository attested by the manifest', () => {
    const m = materialize(manifest([entry('CYI', 'closeyourit/closeyourit-rails')]), hosts)
    const name = Object.keys(m.actions)[0]
    expect(m.ticketQueues[name]).toEqual({projectKey: 'CYI', repository: 'closeyourit/closeyourit-rails'})
    expect(m.authorizedCwds[name]).toBe('/repos/closeyourit-rails')
  })

  it('stable host-first cadence: polling at every tick, catch_up on', () => {
    const m = materialize(manifest([entry('CYI')]), hosts)
    const action = Object.values(m.actions)[0] as Record<string, unknown>
    expect(action.schedule).toBe('every 1s')
    expect(action.catch_up).toBe(true)
  })

  it('keys colliding after sanitization receive a numeric suffix', () => {
    const m = materialize(manifest([entry('CY-I', 'bussolabs/uno'), entry('CY.I', 'bussolabs/due')]),
      {'CY-I': hosts.CYI, 'CY.I': hosts.DR})
    const keys = Object.keys(m.actions)
    expect(keys).toHaveLength(2)
    expect(new Set(keys).size).toBe(2)
  })

  it('the generated playbook is valid for PlaybookSchema', () => {
    const m = materialize(manifest([entry('CYI'), entry('DR')]), hosts)
    const parsed = PlaybookSchema.safeParse({version: 1, actions: m.actions})
    expect(parsed.success).toBe(true)
  })
})

describe('buildSync', () => {
  it('failed manifest fetch → null', async () => {
    expect(await buildSync({client: fakeClient(null), hosts})()).toBeNull()
  })

  it('no project mapped on this host → null', async () => {
    expect(await buildSync({client: fakeClient(manifest([entry('NOPE')])), hosts})()).toBeNull()
  })

  it('happy → valid playbook with the trusted cwd from the local config', async () => {
    const synced = await buildSync({client: fakeClient(manifest([entry('CYI')])), hosts})()
    expect(synced).not.toBeNull()
    expect(synced!.playbook.version).toBe(1)
    expect(Object.keys(synced!.playbook.actions)).toHaveLength(1)
    const name = Object.keys(synced!.playbook.actions)[0]
    expect(synced!.authorizedCwds[name]).toBe('/repos/closeyourit-rails')
  })

  it('propagates the queue targets in the sync result', async () => {
    const synced = await buildSync({client: fakeClient(manifest([entry('CYI', 'closeyourit/closeyourit-rails')])), hosts})()
    const name = Object.keys(synced!.playbook.actions)[0]
    expect(synced!.ticketQueues[name]).toEqual({projectKey: 'CYI', repository: 'closeyourit/closeyourit-rails'})
  })
})

describe('makeSync', () => {
  it('undefined if the sync is not configured', () => {
    expect(makeSync({} as Secrets)).toBeUndefined()
  })

  it('defined if sync is present and uses the injected fetch', async () => {
    const fn = vi.fn(async () => ({ok: true, json: async () => ({data: manifest([entry('CYI')])})}) as unknown as Response)
    const secrets: Secrets = {sync: {}, host: {id: 'h1', token: 'cyi_ah_host'}, hosts}
    const sync = makeSync(secrets, undefined, fn as unknown as typeof globalThis.fetch)
    expect(sync).toBeDefined()
    const synced = await sync!()
    expect(synced).not.toBeNull()
    expect(fn).toHaveBeenCalled()
  })

  it('pre-registration fails closed without fetch or fallback to the local playbook', async () => {
    const fn = vi.fn()
    const sync = makeSync({sync: {orgToken: 'cyi_a_x'}}, undefined, fn as unknown as typeof globalThis.fetch)
    expect(sync).toBeDefined()
    expect(await sync!()).toBeNull()
    expect(fn).not.toHaveBeenCalled()
  })

  it('first pull 401 → org-scoped register, persists the new identity and retries once host-scoped', async () => {
    const initial: Secrets = {
      sync: {orgToken: 'cyi_a_org'}, hostFingerprint: 'fp-stabile',
      host: {id: 'h1', token: 'cyi_ah_old'}, hosts,
    }

    await withStoredSecrets(initial, async () => {
      const {fn, calls} = sequencedFetch([
        {ok: false, status: 401},
        {ok: true, status: 200, json: {data: {id: 'h1', token: 'cyi_ah_new'}}},
        {ok: true, status: 200, json: {data: manifest([entry('CYI')])}},
      ])
      const sync = makeSync(loadSecrets(), undefined, fn, 'linux')

      await expect(sync!()).resolves.not.toBeNull()
      expect(calls.map((call) => call.url)).toEqual([
        'https://app.closeyour.it/api/v1/agent_host/workspace_manifest',
        'https://app.closeyour.it/api/v1/hosts',
        'https://app.closeyour.it/api/v1/agent_host/workspace_manifest',
      ])
      expect(calls.map((call) => (call.opts.headers as Record<string, string>).Authorization)).toEqual([
        'Bearer cyi_ah_old', 'Bearer cyi_a_org', 'Bearer cyi_ah_new',
      ])
      expect(loadSecrets().host).toEqual({id: 'h1', token: 'cyi_ah_new'})
    })
  })

  it('second 401 after rotation → stop without loop or second registration', async () => {
    const initial: Secrets = {
      sync: {orgToken: 'cyi_a_org'}, hostFingerprint: 'fp-stabile',
      host: {id: 'h1', token: 'cyi_ah_old'}, hosts,
    }

    await withStoredSecrets(initial, async () => {
      const {fn, calls} = sequencedFetch([
        {ok: false, status: 401},
        {ok: true, status: 200, json: {data: {id: 'h1', token: 'cyi_ah_new'}}},
        {ok: false, status: 401},
      ])
      await expect(makeSync(loadSecrets(), undefined, fn, 'linux')!()).resolves.toBeNull()
      expect(calls).toHaveLength(3)
      expect(calls.filter((call) => call.url.endsWith('/api/v1/hosts'))).toHaveLength(1)
    })
  })

  it.each([
    {status: 403, orgToken: 'cyi_a_org'},
    {status: 401, orgToken: undefined},
    {status: 500, orgToken: 'cyi_a_org'},
  ])('pull HTTP $status with orgToken=$orgToken → no register/fallback', async ({status, orgToken}) => {
    const syncConfig = orgToken ? {orgToken} : {}
    const initial: Secrets = {
      sync: syncConfig, hostFingerprint: 'fp-stabile', host: {id: 'h1', token: 'cyi_ah_old'}, hosts,
    }

    await withStoredSecrets(initial, async () => {
      const {fn, calls} = sequencedFetch([{ok: false, status}])
      await expect(makeSync(loadSecrets(), undefined, fn)!()).resolves.toBeNull()
      expect(calls).toHaveLength(1)
      expect((calls[0].opts.headers as Record<string, string>).Authorization).toBe('Bearer cyi_ah_old')
      expect(loadSecrets().host).toEqual({id: 'h1', token: 'cyi_ah_old'})
    })
  })
})
