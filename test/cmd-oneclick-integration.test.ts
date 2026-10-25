import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest'
import {saveSecrets} from '../src/lib/config'
import type {StageOutcome} from '../src/lib/oneclick'
import {runCaptured, runExpectingExit} from './helpers/command'

// Integration of the REAL wiring of the oneclick command (stageDeps/replicate/makeStore), with the system probes
// mocked (gh/systemctl/probe spawns are not deterministic in tests) and the manifest served via a stubbed fetch.
// runSubcommand is overridden so as NOT to really spawn update/install (the orchestration is already tested elsewhere).
const fake = vi.hoisted(() => ({
  probeAll: vi.fn(() => [
    {name: 'mise', bin: 'mise', present: true, version: '2025.1', required: true},
    {name: 'node', bin: 'node', present: true, version: 'v24.11.0', required: true},
    {name: 'cyi', bin: 'cyi', present: true, version: '0.0.21', required: true},
    {name: 'claude', bin: 'claude', present: true, version: '1.0.0', required: true},
    {name: 'gh', bin: 'gh', present: true, version: '2.96.0', required: true},
    {name: 'codex', bin: 'codex', present: false, version: null, required: false},
  ]),
  githubAuthenticated: vi.fn(async () => true),
  cyiAuthenticated: vi.fn(async () => true),
  codexAuthenticated: vi.fn(async () => true),
  claudeAuthenticated: vi.fn(async () => true),
  probeRuntimes: vi.fn(async () => [
    {id: 'claude', required: true, available: true},
    {id: 'codex', required: false, available: false},
  ]),
  guardrailsInstalled: vi.fn(() => true),
  serviceHealth: vi.fn(() => ({installed: true, running: true})),
}))

vi.mock('../src/lib/deps', () => ({
  probeAllAsync: fake.probeAll,
  githubAuthenticatedAsync: fake.githubAuthenticated,
  cyiAuthenticatedAsync: fake.cyiAuthenticated,
  codexAuthenticatedAsync: fake.codexAuthenticated,
  claudeAuthenticatedAsync: fake.claudeAuthenticated,
}))

vi.mock('../src/lib/runtime', () => ({
  probeRuntimes: fake.probeRuntimes,
}))

vi.mock('../src/lib/guardrails', () => ({
  guardrailsInstalled: fake.guardrailsInstalled,
}))

vi.mock('../src/lib/service', () => ({
  detectPlatform: () => 'linux',
  serviceManager: () => ({status: () => fake.serviceHealth()}),
}))

const {default: OneClick} = await import('../src/commands/oneclick')

/** Subclass that does not spawn the sub-commands (update/install) but records their invocation. */
function testCommand(subcalls: Array<[string, string[]]>): typeof OneClick {
  return class extends OneClick {
    protected override runSubcommand(command: string, args: string[]): StageOutcome {
      subcalls.push([command, args])
      return {status: 'completed', detail: `${command} stub`}
    }
  }
}

function stubManifestFetch(repositories: unknown[] = []): void {
  vi.stubGlobal('fetch', vi.fn(async (url: string | URL) => {
    if (String(url).includes('/api/v1/agent_host/workspace_manifest')) {
      return {ok: true, json: async () => ({data: {version: 1, digest: 'sha', workspace_root_hint: 'ws', repositories}})} as unknown as Response
    }
    return {ok: false, status: 404, json: async () => ({})} as unknown as Response
  }))
}

let cfgDir: string
let stateDir: string
let repoDir: string
const savedEnv = {...process.env}

beforeEach(() => {
  cfgDir = fs.mkdtempSync(path.join(os.tmpdir(), 'automator-1click-cfg-'))
  stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'automator-1click-state-'))
  repoDir = fs.mkdtempSync(path.join(os.tmpdir(), 'automator-1click-repo-'))
  fs.mkdirSync(path.join(repoDir, '.git'))
  process.env.AUTOMATOR_CONFIG_DIR = cfgDir
  process.env.AUTOMATOR_STATE_DIR = stateDir
  fake.probeAll.mockClear()
  fake.githubAuthenticated.mockClear().mockResolvedValue(true)
  fake.cyiAuthenticated.mockClear().mockResolvedValue(true)
  fake.codexAuthenticated.mockClear().mockResolvedValue(true)
  fake.claudeAuthenticated.mockClear().mockResolvedValue(true)
  fake.probeRuntimes.mockClear()
  fake.guardrailsInstalled.mockClear().mockReturnValue(true)
  fake.serviceHealth.mockClear().mockReturnValue({installed: true, running: true})
})

afterEach(() => {
  process.env = {...savedEnv}
  vi.unstubAllGlobals()
  fs.rmSync(cfgDir, {recursive: true, force: true})
  fs.rmSync(stateDir, {recursive: true, force: true})
  fs.rmSync(repoDir, {recursive: true, force: true})
})

describe('oneclick command — wiring reale', () => {
  it('machine already ready (registered host): all stages complete → exit 0, workspace replicated', async () => {
    // Operational host already present → no-op registrar; manifest with empty repos → no network clone.
    saveSecrets({claudeToken: 'tok', sync: {orgToken: 'cyi_a_x'}, host: {id: 'h1', token: 'cyi_ah_s'}, hosts: {CYRA: {cwd: repoDir}}})
    stubManifestFetch([])
    const subcalls: Array<[string, string[]]> = []

    const {result, stdout} = await runCaptured(testCommand(subcalls), ['--channel', 'beta'])
    const payload = result as {ready: boolean; completed: string[]}

    expect(payload.ready).toBe(true)
    expect(payload.completed).toEqual(['toolchain', 'auth', 'update', 'install', 'enroll', 'workspace', 'skills', 'doctor'])
    // update/install went through runSubcommand (with the chosen channel), not spawned.
    expect(subcalls).toEqual([['update', ['--channel', 'beta']], ['install', ['--managed']]])
    expect(stdout).toContain('pronta')
    // The real resumable state was persisted.
    expect(JSON.parse(fs.readFileSync(path.join(stateDir, 'oneclick.json'), 'utf8')).completed).toHaveLength(8)
  })

  it('incomplete toolchain (required CLI missing) → exit 3, stops before update/install', async () => {
    fake.probeAll.mockReturnValue([{name: 'cyi', bin: 'cyi', present: false, version: null, required: true}])
    saveSecrets({claudeToken: 'tok', sync: {orgToken: 'cyi_a_x'}, host: {id: 'h1', token: 'cyi_ah_s'}, hosts: {CYRA: {cwd: repoDir}}})
    stubManifestFetch([])
    const subcalls: Array<[string, string[]]> = []

    const {stderr, stdout} = await runExpectingExit(testCommand(subcalls), [], 3)
    expect(stderr).toContain('C409-ONECLICK-001')
    expect(stdout).toContain('bootstrap.sh')
    expect(subcalls).toEqual([]) // stopped at stage 1, no sub-command
  })

  it('unregistered host → enroll blocks before the replication (exit 3), no manifest fetch', async () => {
    // No operational host identity: makeHostRegistrar without orgToken nor host → missing registrar → missing host.
    saveSecrets({claudeToken: 'tok', hosts: {CYRA: {cwd: repoDir}}})
    const fetch = vi.fn(async () => ({ok: false, status: 404, json: async () => ({})}) as unknown as Response)
    vi.stubGlobal('fetch', fetch)
    const subcalls: Array<[string, string[]]> = []

    const {stderr} = await runExpectingExit(testCommand(subcalls), [], 3)
    expect(stderr).toContain('C409-ONECLICK-001')
    // enroll is the blocking stage (after the update/install stubs) → the manifest is never requested.
    expect(fetch).not.toHaveBeenCalled()
  })
})
