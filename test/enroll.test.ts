import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import {afterEach, beforeEach, describe, expect, it} from 'vitest'
import {repoExists, runEnroll, type EnrollDeps} from '../src/lib/enroll'
import {type ProbeResult} from '../src/lib/deps'
import {type RuntimeStatus} from '../src/lib/runtime'
import {type Secrets} from '../src/lib/config'
import {type EnsureHostResult} from '../src/lib/host'

// All-green diagnostics: every required CLI present, every required runtime available.
const OK_DEPS: ProbeResult[] = [
  {name: 'mise', bin: 'mise', present: true, version: '2025.1.0', required: true},
  {name: 'node', bin: 'node', present: true, version: 'v24.11.0', required: true},
  {name: 'cyi', bin: 'cyi', present: true, version: '0.0.21', required: true},
  {name: 'claude', bin: 'claude', present: true, version: '1.0.0', required: true},
  {name: 'codex', bin: 'codex', present: false, version: null, required: false},
]

const OK_RUNTIMES: RuntimeStatus[] = [
  {id: 'claude', required: true, available: true},
  {id: 'codex', required: false, available: false},
]

const OK_SECRETS: Secrets = {
  claudeToken: 'tok-headless',
  sync: {orgToken: 'cyi_a_x'},
  host: {id: 'h1', token: 'cyi_ah_s'},
  hosts: {CYRA: {cwd: '/repos/cyra'}},
}

/** Ready-machine deps: every check passes. The overrides replace the single pieces. */
function okDeps(over: Partial<EnrollDeps> = {}): EnrollDeps {
  return {
    secrets: OK_SECRETS,
    registrar: async (): Promise<EnsureHostResult> => ({status: 'existing', host: {id: 'h1', token: 'cyi_ah_s'}}),
    probeDeps: () => OK_DEPS,
    probeRuntimes: async () => OK_RUNTIMES,
    guardrailsInstalled: () => true,
    serviceHealth: () => ({installed: true, running: true}),
    githubAuthenticated: () => true,
    cyiAuthenticated: () => true,
    codexAuthenticated: () => true,
    claudeAuthenticated: () => true,
    repoExists: () => true,
    skillsModeEnabled: () => true,
    skillBundleResolved: () => true,
    ...over,
  }
}

function step(result: {steps: Array<{key: string; status: string; detail?: string}>}, key: string): {status: string; detail?: string} {
  const found = result.steps.find((s) => s.key === key)
  if (!found) throw new Error(`passo mancante: ${key}`)
  return found
}

describe('runEnroll', () => {
  it('ready machine: all steps ok and ready true', async () => {
    const result = await runEnroll(okDeps())
    expect(result.ready).toBe(true)
    expect(result.steps.map((s) => s.key)).toEqual(['cyi', 'host', 'provider', 'codex', 'github', 'guardrails', 'repositories', 'skill-bundle', 'service'])
    expect(result.steps.every((s) => s.status === 'ok')).toBe(true)
  })

  it('the final diagnostics report the probed CLIs and runtimes (equivalent to doctor)', async () => {
    const result = await runEnroll(okDeps())
    expect(result.diagnostics.deps).toEqual(OK_DEPS)
    expect(result.diagnostics.runtimes).toEqual(OK_RUNTIMES)
  })

  it('probes the runtimes only once and reuses the outcome for provider and diagnostics', async () => {
    let calls = 0
    const result = await runEnroll(
      okDeps({
        probeRuntimes: async () => {
          calls += 1
          return OK_RUNTIMES
        },
      }),
    )
    expect(calls).toBe(1)
    expect(step(result, 'provider').status).toBe('ok')
    expect(result.diagnostics.runtimes).toEqual(OK_RUNTIMES)
  })

  it('isolates throwing probes: the others complete and the diagnostics stay actionable', async () => {
    let runtimeCompleted = false
    const result = await runEnroll(
      okDeps({
        probeDeps: () => {
          throw new Error('boom con cyi_ah_SEGRETO')
        },
        probeRuntimes: async () => {
          runtimeCompleted = true
          return OK_RUNTIMES
        },
      }),
    )

    expect(runtimeCompleted).toBe(true)
    expect(result.ready).toBe(false)
    expect(result.diagnostics.runtimes).toEqual(OK_RUNTIMES)
    expect(result.diagnostics.deps).toEqual([
      {name: 'diagnostica', bin: '-', present: false, version: null, required: true},
    ])
    expect(JSON.stringify(result)).not.toContain('cyi_ah_SEGRETO')
  })

  describe('cyi step (CloseYourIt device flow)', () => {
    it('cyi not authenticated → missing, not ready', async () => {
      const result = await runEnroll(okDeps({cyiAuthenticated: () => false}))
      expect(step(result, 'cyi').status).toBe('missing')
      expect(step(result, 'cyi').detail).toContain('cyi login')
      expect(result.ready).toBe(false)
    })

    it('cyi authenticated → ok', async () => {
      const result = await runEnroll(okDeps({cyiAuthenticated: () => true}))
      expect(step(result, 'cyi').status).toBe('ok')
    })
  })

  describe('host step (machine registration)', () => {
    it('missing registration authority (missing registrar) → missing host, not ready', async () => {
      const result = await runEnroll(okDeps({registrar: undefined}))
      expect(step(result, 'host').status).toBe('missing')
      // The remedy points to the service account token (cyi_u_), no longer to the org token in the vault.
      expect(step(result, 'host').detail).toContain('service account')
      expect(step(result, 'host').detail).toContain('CLOSEYOURIT_TOKEN')
      expect(result.ready).toBe(false)
    })

    it('failed registration (server unreachable) → missing host', async () => {
      const result = await runEnroll(okDeps({registrar: async () => ({status: 'failed', host: null})}))
      expect(step(result, 'host').status).toBe('missing')
      expect(result.ready).toBe(false)
    })

    it('host already registered → ok and idempotent (shows the host_id, never the token)', async () => {
      const result = await runEnroll(okDeps({registrar: async () => ({status: 'existing', host: {id: 'h9', token: 'cyi_ah_segreto'}})}))
      expect(step(result, 'host').status).toBe('ok')
      expect(step(result, 'host').detail).toContain('h9')
      expect(step(result, 'host').detail).not.toContain('cyi_ah_segreto')
    })

    it('just registered → ok', async () => {
      const result = await runEnroll(okDeps({registrar: async () => ({status: 'registered', host: {id: 'h1', token: 'cyi_ah_s'}})}))
      expect(step(result, 'host').status).toBe('ok')
    })
  })

  describe('provider step', () => {
    it('claude runtime not available → missing', async () => {
      const result = await runEnroll(okDeps({probeRuntimes: async () => [{id: 'claude', required: true, available: false}]}))
      expect(step(result, 'provider').status).toBe('missing')
      expect(step(result, 'provider').detail).toContain('claude')
      expect(result.ready).toBe(false)
    })

    it('claude not authenticated locally → missing provider (machine auth, not a token in the vault)', async () => {
      const result = await runEnroll(okDeps({claudeAuthenticated: () => false}))
      expect(step(result, 'provider').status).toBe('missing')
      expect(step(result, 'provider').detail).toContain('claude login')
    })

    it('runtime missing AND not authenticated → missing with both reasons', async () => {
      const result = await runEnroll(
        okDeps({
          claudeAuthenticated: () => false,
          probeRuntimes: async () => [{id: 'claude', required: true, available: false}],
        }),
      )
      const detail = step(result, 'provider').detail ?? ''
      expect(detail).toContain('non disponibile')
      expect(detail).toContain('claude login')
    })
  })

  describe('codex step (device flow, OPTIONAL)', () => {
    it('codex authenticated → ok', async () => {
      const result = await runEnroll(okDeps({codexAuthenticated: () => true}))
      expect(step(result, 'codex').status).toBe('ok')
    })

    it('codex not authenticated → missing but does NOT block ready (optional runtime)', async () => {
      const result = await runEnroll(okDeps({codexAuthenticated: () => false}))
      expect(step(result, 'codex').status).toBe('missing')
      expect(step(result, 'codex').detail).toContain('codex login')
      // Codex is optional: its absence must not make the machine "not ready".
      expect(result.ready).toBe(true)
    })
  })

  describe('github step', () => {
    it('gh not authenticated → missing, not ready', async () => {
      const result = await runEnroll(okDeps({githubAuthenticated: () => false}))
      expect(step(result, 'github').status).toBe('missing')
      expect(step(result, 'github').detail).toContain('gh auth login')
      expect(result.ready).toBe(false)
    })
  })

  describe('guardrails step', () => {
    it('missing guardrails → missing, not ready', async () => {
      const result = await runEnroll(okDeps({guardrailsInstalled: () => false}))
      expect(step(result, 'guardrails').status).toBe('missing')
      expect(step(result, 'guardrails').detail).toContain('install')
      expect(result.ready).toBe(false)
    })
  })

  // CYAU-95: without the skill bundle on disk the queue preflight stops BEFORE the claim
  // (skill bundle missing or unresolvable) and the machine stays mute: it beats, it is certified, it does not
  // work. `enroll` did not look at it and declared it "ready".
  describe('skill bundle step', () => {
    it('skill-mode on and bundle missing → missing with the remedy, not ready', async () => {
      const result = await runEnroll(okDeps({skillsModeEnabled: () => true, skillBundleResolved: () => false}))
      expect(step(result, 'skill-bundle').status).toBe('missing')
      expect(step(result, 'skill-bundle').detail).toContain('skill sync')
      expect(result.ready).toBe(false)
    })

    it('skill-mode on and bundle resolvable → ok', async () => {
      const result = await runEnroll(okDeps({skillsModeEnabled: () => true, skillBundleResolved: () => true}))
      expect(step(result, 'skill-bundle').status).toBe('ok')
      expect(result.ready).toBe(true)
    })

    // With skill-mode off there is no queue to serve: requiring the bundle would send the operator
    // looking for a non-existent failure (same logic as the preflight, which does not even start the probe).
    it('skill-mode off and bundle missing → not required, the machine stays ready', async () => {
      const result = await runEnroll(okDeps({skillsModeEnabled: () => false, skillBundleResolved: () => false}))
      expect(step(result, 'skill-bundle').status).toBe('ok')
      expect(result.steps.find((s) => s.key === 'skill-bundle')?.required).toBe(false)
      expect(result.ready).toBe(true)
    })
  })

  describe('repositories step', () => {
    it('empty host map → missing', async () => {
      const result = await runEnroll(okDeps({secrets: {...OK_SECRETS, hosts: {}}}))
      expect(step(result, 'repositories').status).toBe('missing')
      expect(result.ready).toBe(false)
    })

    it('missing host map → missing', async () => {
      const result = await runEnroll(okDeps({secrets: {...OK_SECRETS, hosts: undefined}}))
      expect(step(result, 'repositories').status).toBe('missing')
    })

    it('checkout not found for a key → missing, lists the key (never the path)', async () => {
      const result = await runEnroll(
        okDeps({
          secrets: {...OK_SECRETS, hosts: {CYRA: {cwd: '/manca'}, CYI: {cwd: '/c’è'}}},
          repoExists: (cwd) => cwd === '/c’è',
        }),
      )
      expect(step(result, 'repositories').status).toBe('missing')
      expect(step(result, 'repositories').detail).toContain('CYRA')
      expect(step(result, 'repositories').detail).not.toContain('/manca')
    })

    it('all checkouts present → ok', async () => {
      const result = await runEnroll(okDeps({repoExists: () => true}))
      expect(step(result, 'repositories').status).toBe('ok')
    })
  })

  describe('service step (user systemd)', () => {
    it('service not installed → missing, not ready', async () => {
      const result = await runEnroll(okDeps({serviceHealth: () => ({installed: false, running: false})}))
      expect(step(result, 'service').status).toBe('missing')
      expect(step(result, 'service').detail).toContain('install')
      expect(result.ready).toBe(false)
    })

    it('installed but daemon stopped → missing (a host with the service down is not operational)', async () => {
      const result = await runEnroll(okDeps({serviceHealth: () => ({installed: true, running: false})}))
      expect(step(result, 'service').status).toBe('missing')
      expect(step(result, 'service').detail).toContain('non in esecuzione')
      expect(result.ready).toBe(false)
    })

    it('installed and running → ok', async () => {
      const result = await runEnroll(okDeps({serviceHealth: () => ({installed: true, running: true})}))
      expect(step(result, 'service').status).toBe('ok')
    })
  })

  describe('diagnostics gate', () => {
    it('required CLI missing → not ready even if all steps are ok', async () => {
      const brokenDeps = OK_DEPS.map((d) => (d.name === 'cyi' ? {...d, present: false, version: null} : d))
      const result = await runEnroll(okDeps({probeDeps: () => brokenDeps}))
      expect(result.steps.every((s) => s.status === 'ok')).toBe(true)
      expect(result.ready).toBe(false)
    })

    it('required runtime not available → not ready', async () => {
      const result = await runEnroll(
        okDeps({probeRuntimes: async () => [{id: 'claude', required: true, available: false}]}),
      )
      expect(result.ready).toBe(false)
    })

    it('missing optional CLI does not block (codex missing) → stays ready', async () => {
      const result = await runEnroll(okDeps())
      expect(result.diagnostics.deps.find((d) => d.name === 'codex')?.present).toBe(false)
      expect(result.ready).toBe(true)
    })
  })

  it('never exposes the secrets in the result (claude/org/host token)', async () => {
    const result = await runEnroll(
      okDeps({
        secrets: {
          claudeToken: 'CLAUDE_SEGRETISSIMO',
          sync: {orgToken: 'cyi_a_SEGRETO'},
          host: {id: 'h1', token: 'cyi_ah_SEGRETO'},
          hosts: {CYRA: {cwd: '/repos/cyra'}},
        },
        registrar: async () => ({status: 'existing', host: {id: 'h1', token: 'cyi_ah_SEGRETO'}}),
      }),
    )
    const dump = JSON.stringify(result)
    expect(dump).not.toContain('CLAUDE_SEGRETISSIMO')
    expect(dump).not.toContain('cyi_a_SEGRETO')
    expect(dump).not.toContain('cyi_ah_SEGRETO')
  })
})

describe('repoExists', () => {
  let dir: string

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'automator-enroll-repo-'))
  })

  afterEach(() => {
    fs.rmSync(dir, {recursive: true, force: true})
  })

  it('directory with .git → true', () => {
    fs.mkdirSync(path.join(dir, '.git'))
    expect(repoExists(dir)).toBe(true)
  })

  it('worktree with .git file (gitdir pointer) → true', () => {
    fs.writeFileSync(path.join(dir, '.git'), 'gitdir: /altrove/.git/worktrees/x\n')
    expect(repoExists(dir)).toBe(true)
  })

  it('directory without .git → false', () => {
    expect(repoExists(dir)).toBe(false)
  })

  it('non-existent path → false', () => {
    expect(repoExists(path.join(dir, 'non-esiste'))).toBe(false)
  })
})
