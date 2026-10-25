import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest'
import Register from '../src/commands/register'
import {loadSecrets, saveSecrets} from '../src/lib/config'
import {runCaptured, runExpectingExit} from './helpers/command'

let dir: string
const savedEnv = {...process.env}

class LinuxRegister extends Register {
  protected currentPlatform() {
    return 'linux' as const
  }
}

function stubFetch(res: {ok: boolean; json?: unknown}): void {
  vi.stubGlobal('fetch', vi.fn(async () => ({ok: res.ok, json: async () => res.json}) as unknown as Response))
}

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'automator-register-cmd-'))
  process.env.AUTOMATOR_CONFIG_DIR = dir
})

afterEach(() => {
  process.env = {...savedEnv}
  vi.unstubAllGlobals()
  fs.rmSync(dir, {recursive: true, force: true})
})

describe('register command', () => {
  it('sync not configured → exit 2', async () => {
    saveSecrets({})
    await runExpectingExit(LinuxRegister, [], 2)
  })

  it('failed registration (server unreachable) → exit 1', async () => {
    saveSecrets({sync: {orgToken: 'cyi_a_x'}})
    stubFetch({ok: false})
    await runExpectingExit(LinuxRegister, [], 1)
  })

  it('happy: registers and persists host_id + credential in the 0600 secret', async () => {
    saveSecrets({sync: {orgToken: 'cyi_a_x'}})
    stubFetch({ok: true, json: {data: {id: 'h1', token: 'cyi_ah_s'}}})
    const {result, stdout} = await runCaptured(LinuxRegister, [])
    expect((result as {status: string}).status).toBe('registered')
    expect((result as {host_id: string}).host_id).toBe('h1')
    expect(stdout).toContain('h1')
    const s = loadSecrets()
    expect(s.host).toEqual({id: 'h1', token: 'cyi_ah_s'})
    expect(typeof s.hostFingerprint).toBe('string')
  })

  it('duplicate registration is idempotent: second run → existing, same host_id', async () => {
    saveSecrets({sync: {orgToken: 'cyi_a_x'}})
    stubFetch({ok: true, json: {data: {id: 'h1', token: 'cyi_ah_s'}}})
    await runCaptured(LinuxRegister, [])
    // Even if the server answers with a different id, the already registered host stays unchanged (local no-op).
    stubFetch({ok: true, json: {data: {id: 'h2', token: 'cyi_ah_altro'}}})
    const {result} = await runCaptured(LinuxRegister, [])
    expect((result as {status: string}).status).toBe('existing')
    expect((result as {host_id: string}).host_id).toBe('h1')
    expect(loadSecrets().host).toEqual({id: 'h1', token: 'cyi_ah_s'})
  })

  it('already valid host without org token → existing without network', async () => {
    saveSecrets({sync: {}, host: {id: 'h1', token: 'cyi_ah_s'}, hostFingerprint: 'fp'})
    const fetch = vi.fn()
    vi.stubGlobal('fetch', fetch)
    const {result} = await runCaptured(LinuxRegister, [])
    expect(result).toMatchObject({status: 'existing', host_id: 'h1'})
    expect(fetch).not.toHaveBeenCalled()
  })
})
