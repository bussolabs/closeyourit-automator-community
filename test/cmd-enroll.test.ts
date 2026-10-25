import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest'
import {loadSecrets, saveSecrets} from '../src/lib/config'
import {runCaptured} from './helpers/command'

// Mocked system probes (real gh/systemctl/claude spawns are not deterministic in tests). repoExists stays
// real: the checkouts are temporary directories with `.git`. The host registration goes through the real
// makeHostRegistrar → stubbed fetch.
const fake = vi.hoisted(() => ({
  probeAll: vi.fn(() => [
    {name: 'mise', bin: 'mise', present: true, version: '2025.1', required: true},
    {name: 'node', bin: 'node', present: true, version: 'v24.11.0', required: true},
    {name: 'cyi', bin: 'cyi', present: true, version: '0.0.21', required: true},
    {name: 'claude', bin: 'claude', present: true, version: '1.0.0', required: true},
    {name: 'codex', bin: 'codex', present: false, version: null, required: false},
  ]),
  githubAuthenticated: vi.fn(() => true),
  cyiAuthenticated: vi.fn(() => true),
  codexAuthenticated: vi.fn(() => true),
  claudeAuthenticated: vi.fn(() => true),
  probeRuntimes: vi.fn(async () => [
    {id: 'claude', required: true, available: true},
    {id: 'codex', required: false, available: false},
  ]),
  guardrailsInstalled: vi.fn(() => true),
  serviceHealth: vi.fn(() => ({installed: true, running: true})),
  // Off by default: the skill bundle is not a prerequisite in prompt mode.
  skillsMode: vi.fn(() => false),
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
  serviceManager: () => ({
    status: () => fake.serviceHealth(),
    unitPath: () => '/unit/closeyourit-automator.service',
    logsPath: () => '/log/path.log',
  }),
  // Skill-mode read from the unit (CYAU-95): driven here by the fake, so the command stays testable without
  // querying the systemd of the machine running the suite.
  serviceSkillsModeEnabled: () => fake.skillsMode(),
}))

const {default: Enroll} = await import('../src/commands/enroll')

function stubFetch(res: {ok: boolean; json?: unknown}): void {
  vi.stubGlobal('fetch', vi.fn(async () => ({ok: res.ok, json: async () => res.json}) as unknown as Response))
}

let cfgDir: string
let repoDir: string
const savedEnv = {...process.env}

interface EnrollCmdResult {
  ready: boolean
  steps: Array<{key: string; status: string}>
}

beforeEach(() => {
  cfgDir = fs.mkdtempSync(path.join(os.tmpdir(), 'automator-enroll-cmd-'))
  repoDir = fs.mkdtempSync(path.join(os.tmpdir(), 'automator-enroll-repo-'))
  fs.mkdirSync(path.join(repoDir, '.git'))
  process.env.AUTOMATOR_CONFIG_DIR = cfgDir
  fake.probeAll.mockClear()
  fake.githubAuthenticated.mockClear().mockReturnValue(true)
  fake.cyiAuthenticated.mockClear().mockReturnValue(true)
  fake.codexAuthenticated.mockClear().mockReturnValue(true)
  fake.claudeAuthenticated.mockClear().mockReturnValue(true)
  fake.probeRuntimes.mockClear()
  fake.guardrailsInstalled.mockClear().mockReturnValue(true)
  fake.serviceHealth.mockClear().mockReturnValue({installed: true, running: true})
})

afterEach(() => {
  process.env = {...savedEnv}
  vi.unstubAllGlobals()
  fs.rmSync(cfgDir, {recursive: true, force: true})
  fs.rmSync(repoDir, {recursive: true, force: true})
})

describe('enroll command', () => {
  it('ready machine: registers the host, all steps ok, ready true + diagnostics printed', async () => {
    saveSecrets({claudeToken: 'tok', sync: {orgToken: 'cyi_a_x'}, hosts: {CYRA: {cwd: repoDir}}})
    stubFetch({ok: true, json: {data: {id: 'h1', token: 'cyi_ah_s'}}})

    const {result, stdout} = await runCaptured(Enroll, [])
    const res = result as EnrollCmdResult
    expect(res.ready).toBe(true)
    expect(res.steps.every((s) => s.status === 'ok')).toBe(true)
    expect(stdout).toContain('pronta')
    // The full diagnostics (CLI + runtime) are printed at the end, like doctor.
    expect(stdout).toContain('mise')
    expect(stdout).toContain('claude')
    // Host persisted in the 0600 secret.
    expect(loadSecrets().host).toEqual({id: 'h1', token: 'cyi_ah_s'})
  })

  it('new Linux host: missing steps shown, ready false, no token printed', async () => {
    fake.githubAuthenticated.mockReturnValue(false)
    fake.cyiAuthenticated.mockReturnValue(false)
    fake.claudeAuthenticated.mockReturnValue(false)
    fake.guardrailsInstalled.mockReturnValue(false)
    fake.serviceHealth.mockReturnValue({installed: false, running: false})
    // Claude not logged in locally, no host map: only the sync to register the host.
    saveSecrets({sync: {orgToken: 'cyi_a_SEGRETO'}})
    stubFetch({ok: true, json: {data: {id: 'h1', token: 'cyi_ah_SEGRETO'}}})

    const {result, stdout} = await runCaptured(Enroll, [])
    const res = result as EnrollCmdResult
    expect(res.ready).toBe(false)
    expect(stdout).toContain('incompleto')
    // The host step is ok anyway (device registered); cyi/provider/github/guardrail/repo/service are missing.
    expect(res.steps.find((s) => s.key === 'host')?.status).toBe('ok')
    expect(res.steps.filter((s) => s.status === 'missing').map((s) => s.key)).toEqual(
      expect.arrayContaining(['cyi', 'provider', 'github', 'guardrails', 'repositories', 'service']),
    )
    // It never prints the secrets.
    expect(stdout).not.toContain('cyi_a_SEGRETO')
    expect(stdout).not.toContain('cyi_ah_SEGRETO')
  })

  it('a required CLI missing from the diagnostics appears among the missing steps', async () => {
    // All steps ok but the diagnostics find cyi missing → ready false AND cyi listed among the missing ones.
    fake.probeAll.mockReturnValueOnce([
      {name: 'mise', bin: 'mise', present: true, version: '2025.1', required: true},
      {name: 'node', bin: 'node', present: true, version: 'v24.11.0', required: true},
      {name: 'cyi', bin: 'cyi', present: false, version: null, required: true},
      {name: 'claude', bin: 'claude', present: true, version: '1.0.0', required: true},
    ])
    saveSecrets({claudeToken: 'tok', sync: {orgToken: 'cyi_a_x'}, hosts: {CYRA: {cwd: repoDir}}})
    stubFetch({ok: true, json: {data: {id: 'h1', token: 'cyi_ah_s'}}})

    const {result, stdout} = await runCaptured(Enroll, [])
    expect((result as EnrollCmdResult).ready).toBe(false)
    expect(stdout).toContain('CLI cyi')
  })

  it('is repeatable and idempotent: the second run reuses the host, same outcome', async () => {
    saveSecrets({claudeToken: 'tok', sync: {orgToken: 'cyi_a_x'}, hosts: {CYRA: {cwd: repoDir}}})
    stubFetch({ok: true, json: {data: {id: 'h1', token: 'cyi_ah_s'}}})

    const first = (await runCaptured(Enroll, [])).result as EnrollCmdResult
    // Even if the server answered with a different id, the already registered host stays unchanged (local no-op).
    stubFetch({ok: true, json: {data: {id: 'h2', token: 'cyi_ah_altro'}}})
    const second = (await runCaptured(Enroll, [])).result as EnrollCmdResult

    expect(first.ready).toBe(true)
    expect(second.ready).toBe(true)
    expect(loadSecrets().host).toEqual({id: 'h1', token: 'cyi_ah_s'})
  })

  it('already valid host without org token → host step ok and no POST', async () => {
    saveSecrets({
      claudeToken: 'tok',
      sync: {},
      host: {id: 'h1', token: 'cyi_ah_s'},
      hostFingerprint: 'fp',
      hosts: {CYRA: {cwd: repoDir}},
    })
    const fetch = vi.fn()
    vi.stubGlobal('fetch', fetch)

    const {result} = await runCaptured(Enroll, [])
    const res = result as EnrollCmdResult
    expect(res.ready).toBe(true)
    expect(res.steps.find((s) => s.key === 'host')?.status).toBe('ok')
    expect(fetch).not.toHaveBeenCalled()
  })

  it('--json returns the structured result without printing the tables', async () => {
    saveSecrets({claudeToken: 'tok', sync: {orgToken: 'cyi_a_x'}, hosts: {CYRA: {cwd: repoDir}}})
    stubFetch({ok: true, json: {data: {id: 'h1', token: 'cyi_ah_s'}}})

    const {result, stdout} = await runCaptured(Enroll, ['--json'])
    const res = result as EnrollCmdResult
    expect(res.ready).toBe(true)
    expect(res.steps).toHaveLength(9)
    // With --json the human-readable tables and the outcome message are suppressed (only oclif's JSON remains).
    expect(stdout).not.toContain('PASSO')
    expect(stdout).not.toContain('Enrollment')
  })
})
