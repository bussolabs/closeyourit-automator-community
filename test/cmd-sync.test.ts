import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest'
import Sync from '../src/commands/sync'
import TickCommand from '../src/commands/tick'
import {loadSecrets, saveSecrets} from '../src/lib/config'
import {runCaptured, runExpectingExit} from './helpers/command'

let dir: string
const savedEnv = {...process.env}

class LinuxSync extends Sync {
  protected currentPlatform() {
    return 'linux' as const
  }
}

class Tick extends TickCommand {
  protected currentPlatform() {
    return 'linux' as const
  }
}

const manifest = {
  version: 1,
  digest: 'd1',
  workspace_root_hint: 'Lavoro/Github/Personale',
  repositories: [{project_key: 'CYI', path: 'closeyourit-rails', repo: 'bussolabs/closeyourit-rails', default_branch: 'main'}],
}

function stubFetch(res: {ok: boolean; json?: unknown}): void {
  vi.stubGlobal('fetch', vi.fn(async () => ({ok: res.ok, json: async () => res.json}) as unknown as Response))
}

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'automator-sync-cmd-'))
  process.env.AUTOMATOR_CONFIG_DIR = dir
})

afterEach(() => {
  process.env = {...savedEnv}
  vi.unstubAllGlobals()
  fs.rmSync(dir, {recursive: true, force: true})
})

describe('sync command', () => {
  it('sync not configured → exit 2', async () => {
    saveSecrets({})
    await runExpectingExit(LinuxSync, [], 2)
  })

  it('pre-registration → exit 2 without contacting the server', async () => {
    saveSecrets({sync: {orgToken: 'cyi_a_x'}})
    const fetch = vi.fn()
    vi.stubGlobal('fetch', fetch)
    await runExpectingExit(LinuxSync, [], 2)
    expect(fetch).not.toHaveBeenCalled()
  })

  it('failed fetch → exit 1', async () => {
    saveSecrets({sync: {orgToken: 'cyi_a_x'}, host: {id: 'h1', token: 'cyi_ah_host'}, hosts: {}})
    stubFetch({ok: false})
    await runExpectingExit(LinuxSync, [], 1)
  })

  it('happy: materializes and writes the generated playbook', async () => {
    saveSecrets({sync: {}, host: {id: 'h1', token: 'cyi_ah_host'}, hosts: {CYI: {cwd: '/repos/cyi'}}})
    stubFetch({ok: true, json: {data: manifest}})
    const out = path.join(dir, 'gen.yml')
    const {result} = await runCaptured(LinuxSync, ['--out', out])
    expect(fs.existsSync(out)).toBe(true)
    expect(fs.readFileSync(out, 'utf8')).toContain('version: 1')
    expect((result as {actions: string[]}).actions).toHaveLength(1)
  })

  it('pull 401 → rotates, persists and completes the command with the single retry', async () => {
    saveSecrets({
      sync: {orgToken: 'cyi_a_x'}, hostFingerprint: 'fp-stabile',
      host: {id: 'h1', token: 'cyi_ah_old'}, hosts: {CYI: {cwd: '/repos/cyi'}},
    })
    const responses = [
      {ok: false, status: 401, json: {}},
      {ok: true, status: 200, json: {data: {id: 'h1', token: 'cyi_ah_new'}}},
      {ok: true, status: 200, json: {data: manifest}},
    ]
    const fetch = vi.fn(async () => {
      const response = responses.shift()!
      return {ok: response.ok, status: response.status, json: async () => response.json} as unknown as Response
    })
    vi.stubGlobal('fetch', fetch)

    const {result} = await runCaptured(LinuxSync, [])

    expect((result as {repositories: number}).repositories).toBe(1)
    expect(fetch).toHaveBeenCalledTimes(3)
    expect(loadSecrets().host).toEqual({id: 'h1', token: 'cyi_ah_new'})
  })

  it('unmapped project → skipped in the result + log', async () => {
    saveSecrets({sync: {orgToken: 'cyi_a_x'}, host: {id: 'h1', token: 'cyi_ah_host'}, hosts: {}})
    stubFetch({ok: true, json: {data: manifest}})
    const {result, stdout} = await runCaptured(LinuxSync, [])
    expect((result as {skipped: unknown[]}).skipped).toHaveLength(1)
    expect(stdout).toContain('skip')
  })
})

describe('tick with sync', () => {
  it('fetches the manifest via API and materializes the queue sentinel of the mapped project', async () => {
    process.env.AUTOMATOR_STATE_DIR = dir
    saveSecrets({sync: {orgToken: 'cyi_a_x'}, host: {id: 'h1', token: 'cyi_ah_host'}, hosts: {CYI: {cwd: '/repos/cyi'}}})
    stubFetch({ok: true, json: {data: manifest}})
    const {result} = await runCaptured(Tick, [])
    const tick = result as {skipped: boolean; preflightStopped: Array<{name: string; state: string}>}
    // Full host-first chain: manifest → sentinel of the mapped project → queue preflight. Without a
    // claimable candidate the preflight stops fail-closed, which is exactly what it must do.
    expect(tick.skipped).toBe(false)
    expect(tick.preflightStopped.map((entry) => entry.name)).toEqual(['cyi'])
    expect(tick.preflightStopped[0].state).toBe('blocked')
  })

  it('sync without projects mapped on this host → skipped', async () => {
    process.env.AUTOMATOR_STATE_DIR = dir
    saveSecrets({sync: {orgToken: 'cyi_a_x'}, host: {id: 'h1', token: 'cyi_ah_host'}, hosts: {}})
    stubFetch({ok: true, json: {data: manifest}})
    const {result} = await runCaptured(Tick, [])
    expect((result as {skipped: boolean}).skipped).toBe(true)
  })
})
