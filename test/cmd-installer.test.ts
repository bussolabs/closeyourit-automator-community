import {beforeEach, describe, expect, it, vi} from 'vitest'
import {run, runCaptured, runExpectingExit} from './helpers/command'

const fake = vi.hoisted(() => ({
  probeAll: vi.fn(),
  setupDep: vi.fn(),
  probeRuntimes: vi.fn(),
  deps: [
    {name: 'mise', managedBy: 'setup', required: true},
    {name: 'gh', managedBy: 'setup', required: false},
  ],
}))

vi.mock('../src/lib/deps', () => ({
  DEPS: fake.deps,
  probeAll: fake.probeAll,
  probeAllAsync: fake.probeAll,
  setupDep: fake.setupDep,
  defaultShellExec: () => ({code: 0, stdout: '', stderr: ''}),
}))

vi.mock('../src/lib/runtime', () => ({
  probeRuntimes: fake.probeRuntimes,
}))

vi.mock('../src/lib/service', () => ({
  detectPlatform: () => 'linux',
  // doctor reads the guardrail inputs of the unit on Linux (CYRA-914 B9): no unit in these tests.
  adoptServiceGuardrailEnv: () => undefined,
  serviceManager: () => ({}),
}))

vi.mock('../src/lib/linux-host', () => ({
  probeLinuxHost: async () => [
    {id: 'linux', ok: true},
    {id: 'systemd-cgroup-v2', ok: true},
    {id: 'bubblewrap', ok: true},
    {id: 'secret-service', ok: true},
  ],
  requireLinuxHost: () => undefined,
}))

const {default: Doctor} = await import('../src/commands/doctor')
const {default: Setup} = await import('../src/commands/setup')

describe('doctor', () => {
  beforeEach(() => {
    // Default: entrambi i runtime disponibili; i test specifici sovrascrivono.
    fake.probeRuntimes.mockResolvedValue([
      {id: 'claude', required: true, available: true},
      {id: 'codex', required: false, available: true},
    ])
  })

  it('all CLIs present and runtimes available → ok', async () => {
    fake.probeAll.mockReturnValue([
      {name: 'mise', present: true, version: '1.0', required: true},
      {name: 'gh', present: false, version: null, required: false},
    ])
    const result = (await run(Doctor, ['--json'])) as {ok: boolean; runtimes: unknown[]}
    expect(result.ok).toBe(true)
    expect(result.runtimes).toHaveLength(2)
  })

  it('a missing required CLI → exit 1', async () => {
    fake.probeAll.mockReturnValue([{name: 'claude', present: false, version: null, required: true}])
    const {stderr} = await runExpectingExit(Doctor, [], 1)
    expect(stderr).toContain('C000-DEP-001')
  })

  it('prints the CLI table in human form', async () => {
    fake.probeAll.mockReturnValue([{name: 'mise', present: true, version: '1.0', required: true}])
    const {stdout} = await runCaptured(Doctor, [])
    expect(stdout).toContain('CLI')
  })

  it('shows availability and problems of claude and codex separately (Scenario 1)', async () => {
    fake.probeAll.mockReturnValue([{name: 'mise', present: true, version: '1.0', required: true}])
    fake.probeRuntimes.mockResolvedValue([
      {id: 'claude', required: true, available: true},
      {
        id: 'codex',
        required: false,
        available: false,
        detail: 'exit 1',
        fix: "installa la CLI codex con 'automator setup --optional'",
      },
    ])
    const {stdout} = await runCaptured(Doctor, [])
    expect(stdout).toContain('RUNTIME')
    expect(stdout).toContain('claude')
    expect(stdout).toContain('codex')
    expect(stdout).toContain('exit 1') // codex problem shown
    expect(stdout).toContain('automator setup') // actionable fix
  })

  it('required runtime unavailable → exit 1 with an actionable fix without secrets', async () => {
    fake.probeAll.mockReturnValue([{name: 'mise', present: true, version: '1.0', required: true}])
    fake.probeRuntimes.mockResolvedValue([
      {
        id: 'claude',
        required: true,
        available: false,
        detail: 'exit 127',
        fix: "installa/aggiorna la CLI claude con 'automator setup'",
      },
    ])
    const {stderr} = await runExpectingExit(Doctor, [], 1)
    expect(stderr).toContain('C000-RUNTIME-001')
    expect(stderr).toContain('automator setup') // actionable fix
    expect(stderr).not.toMatch(/cyi_|sk-|oauth|CLAUDE_CODE/i) // no secret exposed
  })

  it('optional runtime unavailable → reported but does not block (ok)', async () => {
    fake.probeAll.mockReturnValue([{name: 'mise', present: true, version: '1.0', required: true}])
    fake.probeRuntimes.mockResolvedValue([
      {id: 'claude', required: true, available: true},
      {id: 'codex', required: false, available: false, detail: 'exit 1', fix: "installa la CLI codex con 'automator setup --optional'"},
    ])
    const result = (await run(Doctor, ['--json'])) as {ok: boolean; runtimes: Array<{id: string; available: boolean}>}
    expect(result.ok).toBe(true)
    expect(result.runtimes.find((r) => r.id === 'codex')?.available).toBe(false)
  })
})

describe('setup', () => {
  it('all already present → no failed', async () => {
    fake.setupDep.mockImplementation((dep: {name: string}) => ({name: dep.name, outcome: 'already-present'}))
    const result = (await run(Setup, ['--json'])) as {results: Array<{outcome: string}>}
    expect(result.results.every((r) => r.outcome === 'already-present')).toBe(true)
  })

  it('a failed installation → exit 1', async () => {
    fake.setupDep.mockImplementation((dep: {name: string}) => ({
      name: dep.name,
      outcome: dep.name === 'gh' ? 'failed' : 'installed',
    }))
    const {stderr} = await runExpectingExit(Setup, [], 1)
    expect(stderr).toContain('C000-DEP-002')
  })

  it('--dry-run passes the option to setupDep', async () => {
    fake.setupDep.mockClear()
    fake.setupDep.mockReturnValue({name: 'x', outcome: 'skipped'})
    await run(Setup, ['--dry-run', '--json'])
    expect(fake.setupDep.mock.calls[0][2]).toMatchObject({dryRun: true})
  })
})
