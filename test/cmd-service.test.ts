import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest'
import {loadSecrets, saveSecrets} from '../src/lib/config'
import {saveLease} from '../src/lib/lease'
import {type DaemonOptions} from '../src/lib/daemon'
import {run, runCaptured, runExpectingExit} from './helpers/command'

const fake = vi.hoisted(() => ({
  manager: {
    install: vi.fn(),
    uninstall: vi.fn(),
    status: vi.fn(() => ({installed: true, running: true, pid: 123, detail: 'active (running)'})),
    unitPath: () => '/unit/path.service',
    logsPath: () => 'journalctl --user -u x',
  },
  runDaemon: vi.fn(async () => undefined),
  installGuardrails: vi.fn(() => ({
    hooksDir: '/g/hooks',
    settingsPath: '/g/settings.json',
    codexRulesPath: '/codex/rules/closeyourit-automator.rules',
    hooks: ['a.mjs', 'b.mjs', 'c.mjs', 'd.mjs'],
  })),
  guardrailsInstalled: vi.fn(() => true),
  activeManagedGuardrailPaths: vi.fn(() => ({
    hooksDir: '/managed/g/hooks',
    settingsPath: '/managed/g/settings.json',
    codexRulesPath: '/managed/codex/rules/closeyourit-automator.rules',
    worktreesRoot: '/managed/worktrees',
    nodePath: process.execPath,
  })),
  saveManagedServiceConfig: vi.fn(),
  enableSecureCredentials: vi.fn(),
  probeLinuxHost: vi.fn(async () => [
    {id: 'linux', ok: true},
    {id: 'systemd-cgroup-v2', ok: true},
    {id: 'bubblewrap', ok: true},
    {id: 'secret-service', ok: true},
  ]),
  installAutoUpdate: vi.fn(),
  removeAutoUpdate: vi.fn(),
}))

vi.mock('../src/lib/service', () => ({
  detectPlatform: () => 'linux',
  buildPathEnv: () => '/shims:/usr/bin',
  serviceManager: () => fake.manager,
  userRuntimeDir: () => '/run/user/1001',
}))

vi.mock('../src/lib/auto-update-timer', () => ({
  installAutoUpdate: fake.installAutoUpdate,
  removeAutoUpdate: fake.removeAutoUpdate,
}))

vi.mock('../src/lib/daemon', () => ({
  runDaemon: fake.runDaemon,
}))

vi.mock('../src/lib/guardrails', () => ({
  installGuardrails: fake.installGuardrails,
  guardrailsInstalled: fake.guardrailsInstalled,
}))

vi.mock('../src/lib/managed-service', () => ({
  activeManagedGuardrailPaths: fake.activeManagedGuardrailPaths,
  saveManagedServiceConfig: fake.saveManagedServiceConfig,
}))

vi.mock('../src/lib/config', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../src/lib/config')>()),
  enableSecureCredentials: fake.enableSecureCredentials,
}))

vi.mock('../src/lib/linux-host', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../src/lib/linux-host')>()),
  probeLinuxHost: fake.probeLinuxHost,
}))

// Import AFTER the mocks.
const {default: Install} = await import('../src/commands/install')
const {default: Uninstall} = await import('../src/commands/uninstall')
const {default: Status} = await import('../src/commands/status')
const {default: Daemon} = await import('../src/commands/daemon')

describe('install', () => {
  beforeEach(() => {
    fake.probeLinuxHost.mockReset().mockResolvedValue([
      {id: 'linux', ok: true},
      {id: 'systemd-cgroup-v2', ok: true},
      {id: 'bubblewrap', ok: true},
      {id: 'secret-service', ok: true},
    ])
  })

  it('chiama serviceManager().install, installa i guardrail e stampa l’hint linger su Linux', async () => {
    fake.manager.install.mockClear()
    fake.installGuardrails.mockClear()
    const {result, stdout} = await runCaptured(Install, ['--playbook', '/tmp/pb.yml'])
    expect(fake.manager.install).toHaveBeenCalledTimes(1)
    expect(fake.installGuardrails).toHaveBeenCalledTimes(1)
    expect((result as {platform: string; guardrails: string}).platform).toBe('linux')
    expect((result as {guardrails: string}).guardrails).toBe('/g/settings.json')
    expect((result as {codexGuardrails: string}).codexGuardrails).toBe('/codex/rules/closeyourit-automator.rules')
    expect(stdout).toContain('linger')
    expect(stdout).toContain('Guardrail')
    expect(stdout).toContain('Guardrail Codex')
  })

  it('installs and validates the guardrails before starting the service', async () => {
    const order: string[] = []
    fake.installGuardrails.mockImplementationOnce(() => {
      order.push('guardrails')
      return {hooksDir: '/g/hooks', settingsPath: '/g/settings.json', codexRulesPath: '/codex/rules/closeyourit-automator.rules', hooks: ['a.mjs']}
    })
    fake.manager.install.mockImplementationOnce(() => order.push('service'))

    await run(Install, ['--playbook', '/tmp/pb.yml'])

    expect(order).toEqual(['guardrails', 'service'])
  })

  it('does not start the service if the guardrail installation fails', async () => {
    fake.manager.install.mockClear()
    fake.installGuardrails.mockImplementationOnce(() => {
      throw new Error('guardrail corrotti')
    })

    await expect(run(Install, ['--playbook', '/tmp/pb.yml'])).rejects.toThrow('guardrail corrotti')
    expect(fake.manager.install).not.toHaveBeenCalled()
  })

  it('passes --interval in the daemon args when different from the default', async () => {
    fake.manager.install.mockClear()
    await run(Install, ['--playbook', '/tmp/pb.yml', '--interval', '30'])
    const passed = fake.manager.install.mock.calls[0][0] as {args: string[]}
    expect(passed.args).toContain('--interval')
    expect(passed.args).toContain('30')
  })

  it('without --managed wires the entrypoint of the current checkout (backward compat), without AUTOMATOR_INSTALL_ROOT', async () => {
    fake.manager.install.mockClear()
    await run(Install, ['--playbook', '/tmp/pb.yml'])
    const passed = fake.manager.install.mock.calls[0][0] as {entrypoint: string; env: Record<string, string>}
    expect(passed.entrypoint).toMatch(/bin\/run\.js$/)
    expect(passed.entrypoint).not.toContain('/current/')
    expect(passed.env.AUTOMATOR_INSTALL_ROOT).toBeUndefined()
  })

  it('with --managed points the service to installRoot/current/bin/run.js so updates take effect (CYAU-33)', async () => {
    fake.manager.install.mockClear()
    fake.saveManagedServiceConfig.mockClear()
    fake.enableSecureCredentials.mockClear()
    const result = (await run(Install, ['--playbook', '/tmp/pb.yml', '--managed', '--install-root', '/opt/a'])) as {
      entrypoint: string
      managed: boolean
    }
    const passed = fake.manager.install.mock.calls[0][0] as {entrypoint: string; env: Record<string, string>}
    expect(passed.entrypoint).toBe('/opt/a/current/bin/run.js')
    expect(passed.env.AUTOMATOR_INSTALL_ROOT).toBe('/opt/a')
    expect(result.managed).toBe(true)
    expect(result.entrypoint).toBe('/opt/a/current/bin/run.js')
    expect(fake.saveManagedServiceConfig).toHaveBeenCalledWith('/opt/a', expect.objectContaining({
      version: 1,
      nodePath: process.execPath,
      guardrails: expect.objectContaining({codexRulesPath: '/codex/rules/closeyourit-automator.rules'}),
    }))
    expect(fake.enableSecureCredentials).toHaveBeenCalledWith({
      version: 1,
      provider: 'closeyourit-keychain',
      project: 'CYAU',
      environment: 'production',
    }, {serviceAccountToken: undefined})
  })

  it('normalizes a relative --install-root before wiring it into the managed service', async () => {
    fake.manager.install.mockClear()
    const relative = 'relative-managed-root'

    await run(Install, ['--playbook', '/tmp/pb.yml', '--managed', '--install-root', relative])

    const passed = fake.manager.install.mock.calls[0][0] as {entrypoint: string; env: Record<string, string>}
    const expected = path.resolve(relative)
    expect(passed.entrypoint).toBe(path.join(expected, 'current', 'bin', 'run.js'))
    expect(passed.env.AUTOMATOR_INSTALL_ROOT).toBe(expected)
  })

  it('persists in the service the effective CODEX_HOME used to install the policy', async () => {
    fake.manager.install.mockClear()
    const previous = process.env.CODEX_HOME
    process.env.CODEX_HOME = '/tmp/automator-custom-codex-home'
    try {
      await run(Install, ['--playbook', '/tmp/pb.yml'])
    } finally {
      if (previous === undefined) delete process.env.CODEX_HOME
      else process.env.CODEX_HOME = previous
    }

    const passed = fake.manager.install.mock.calls[0][0] as {env: Record<string, string>}
    expect(passed.env.CODEX_HOME).toBe('/tmp/automator-custom-codex-home')
  })

  describe('mandatory gate of the Linux contract', () => {
    beforeEach(() => {
      fake.manager.install.mockClear()
      fake.installGuardrails.mockClear()
      fake.saveManagedServiceConfig.mockClear()
    })

    it('rejects BEFORE installing anything when a Linux prerequisite is missing', async () => {
      fake.probeLinuxHost.mockResolvedValue([
        {id: 'linux', ok: true},
        {id: 'systemd-cgroup-v2', ok: false, detail: 'systemd >= 254 richiesto'},
      ])

      const {message} = await runExpectingExit(Install, ['--playbook', '/tmp/pb.yml'], 2)

      expect(message).toContain('systemd >= 254 richiesto')
      expect(fake.installGuardrails).not.toHaveBeenCalled()
      expect(fake.saveManagedServiceConfig).not.toHaveBeenCalled()
      expect(fake.manager.install).not.toHaveBeenCalled()
    })

    it('also rejects in managed mode without touching credentials or configuration', async () => {
      fake.probeLinuxHost.mockResolvedValue([{id: 'linux', ok: false, detail: 'Automator supporta esclusivamente Linux'}])
      fake.enableSecureCredentials.mockClear()

      await runExpectingExit(Install, ['--playbook', '/tmp/pb.yml', '--managed', '--install-root', '/opt/a'], 2)

      expect(fake.enableSecureCredentials).not.toHaveBeenCalled()
      expect(fake.saveManagedServiceConfig).not.toHaveBeenCalled()
      expect(fake.manager.install).not.toHaveBeenCalled()
    })

    it('with --skills-enabled and attested confinement installs and enables skill-mode in the unit', async () => {
      const {stdout} = await runCaptured(Install, ['--playbook', '/tmp/pb.yml', '--skills-enabled'])

      expect(fake.probeLinuxHost).toHaveBeenCalledTimes(1)
      expect(fake.manager.install).toHaveBeenCalledTimes(1)
      const passed = fake.manager.install.mock.calls[0][0] as {env: Record<string, string>}
      expect(passed.env.AUTOMATOR_SKILLS_ENABLED).toBe('true')
      expect(stdout).toContain('Skill-mode ABILITATO')
    })

    it('saves production hosts and sandbox domains from the install shell into the unit (CYRA-914 B9)', async () => {
      process.env.AUTOMATOR_PRODUCTION_HOSTS = 'prod.example.com'
      process.env.AUTOMATOR_SANDBOX_DOMAINS = 'cyi.example.com'
      try {
        await run(Install, ['--playbook', '/tmp/pb.yml'])
      } finally {
        delete process.env.AUTOMATOR_PRODUCTION_HOSTS
        delete process.env.AUTOMATOR_SANDBOX_DOMAINS
      }

      const passed = fake.manager.install.mock.calls[0][0] as {env: Record<string, string>}
      expect(passed.env.AUTOMATOR_PRODUCTION_HOSTS).toBe('prod.example.com')
      expect(passed.env.AUTOMATOR_SANDBOX_DOMAINS).toBe('cyi.example.com')
    })

    it('leaves both out of the unit when the install shell has none', async () => {
      await run(Install, ['--playbook', '/tmp/pb.yml'])

      const passed = fake.manager.install.mock.calls[0][0] as {env: Record<string, string>}
      expect(passed.env).not.toHaveProperty('AUTOMATOR_PRODUCTION_HOSTS')
      expect(passed.env).not.toHaveProperty('AUTOMATOR_SANDBOX_DOMAINS')
    })

    it('without --skills-enabled still verifies the Linux contract and leaves skill-mode off', async () => {
      await run(Install, ['--playbook', '/tmp/pb.yml'])

      expect(fake.probeLinuxHost).toHaveBeenCalledTimes(1)
      const passed = fake.manager.install.mock.calls[0][0] as {env: Record<string, string>}
      expect(passed.env.AUTOMATOR_SKILLS_ENABLED).toBeUndefined()
    })
  })
})

describe('uninstall', () => {
  it('chiama serviceManager().uninstall', async () => {
    fake.manager.uninstall.mockClear()
    const result = (await run(Uninstall, [])) as {removed: boolean}
    expect(fake.manager.uninstall).toHaveBeenCalledTimes(1)
    expect(result.removed).toBe(true)
  })
})

describe('status', () => {
  it('returns the service status', async () => {
    const result = (await run(Status, ['--json'])) as {installed: boolean; running: boolean; pid: number}
    expect(result.installed).toBe(true)
    expect(result.pid).toBe(123)
  })

  it('prints the fields in human-readable form', async () => {
    const {stdout} = await runCaptured(Status, [])
    expect(stdout).toContain('running')
  })
})

describe('daemon', () => {
  // Isolated config dir: the daemon boot reads/writes the real secrets (host self-registration) and must
  // never touch the 0600 file of the machine running the tests.
  let cfgDir: string
  const savedEnv = {...process.env}

  beforeEach(() => {
    cfgDir = fs.mkdtempSync(path.join(os.tmpdir(), 'automator-daemon-cmd-'))
    process.env.AUTOMATOR_CONFIG_DIR = cfgDir
    fake.guardrailsInstalled.mockReset().mockReturnValue(true)
    fake.activeManagedGuardrailPaths.mockClear()
  })

  afterEach(() => {
    process.env = {...savedEnv}
    vi.unstubAllGlobals()
    fs.rmSync(cfgDir, {recursive: true, force: true})
  })

  it('starts runDaemon with the interval in ms', async () => {
    fake.runDaemon.mockClear()
    await run(Daemon, ['--playbook', '/tmp/pb.yml', '--interval', '30'])
    expect(fake.runDaemon).toHaveBeenCalledTimes(1)
    const options = fake.runDaemon.mock.calls[0][0] as DaemonOptions
    expect(options.intervalMs).toBe(30_000)
    expect(options.preflight).toEqual(expect.any(Function))
  })

  it('at the first boot of a new release adopts the legacy guardrails before scheduling runs', async () => {
    fake.runDaemon.mockClear()
    fake.installGuardrails.mockClear()
    fake.guardrailsInstalled.mockReturnValueOnce(false)
    process.env.AUTOMATOR_INSTALL_ROOT = '/opt/managed'

    await run(Daemon, ['--playbook', '/tmp/pb.yml'])

    const expected = {
      hooksDir: '/managed/g/hooks',
      settingsPath: '/managed/g/settings.json',
      codexRulesPath: '/managed/codex/rules/closeyourit-automator.rules',
      worktreesRoot: '/managed/worktrees',
      nodePath: process.execPath,
    }
    expect(fake.activeManagedGuardrailPaths).toHaveBeenCalledWith()
    expect(fake.guardrailsInstalled).toHaveBeenCalledWith(expected)
    expect(fake.installGuardrails).toHaveBeenCalledWith(
      expect.stringMatching(/assets\/guardrails$/),
      expected,
    )
    expect(fake.installGuardrails.mock.invocationCallOrder[0]).toBeLessThan(fake.runDaemon.mock.invocationCallOrder[0])
  })

  it('self-registers the host at boot when the sync is configured, then starts the loop', async () => {
    fake.runDaemon.mockClear()
    saveSecrets({sync: {orgToken: 'cyi_a_x'}})
    vi.stubGlobal('fetch', vi.fn(async () => ({ok: true, json: async () => ({data: {id: 'h9', token: 'cyi_ah_s'}})}) as unknown as Response))
    await run(Daemon, ['--playbook', '/tmp/pb.yml'])
    expect(loadSecrets().host).toEqual({id: 'h9', token: 'cyi_ah_s'})
    expect(fake.runDaemon).toHaveBeenCalledTimes(1)
  })

  it('daemon: after pull 401 and rotation, the lease renewal uses the new token Authorization', async () => {
    fake.runDaemon.mockReset()
    process.env.AUTOMATOR_STATE_DIR = path.join(cfgDir, 'state')
    saveSecrets({
      sync: {orgToken: 'cyi_a_org'},
      hostFingerprint: 'fp-stabile',
      host: {id: 'h1', token: 'cyi_ah_old'},
    })
    saveLease({
      ticket: 'CYAU-62', host_id: 'h1', run_id: 'run-62', agent: 'codex', ttl_seconds: 3600,
      expires_at: null, acquired_at: '2026-07-13T10:00:00.000Z', updated_at: '2026-07-13T10:00:00.000Z',
    })

    const authorizations: string[] = []
    const fetch = vi.fn(async (url: string | URL, opts?: RequestInit) => {
      const target = String(url)
      const authorization = (opts?.headers as Record<string, string>).Authorization
      authorizations.push(authorization)
      if (target.endsWith('/api/v1/agent_host/claude_credential') || target.endsWith('/api/v1/agent_host/openrouter_credential')) {
        return {ok: false, status: 404, json: async () => ({})} as unknown as Response
      }
      if (target.endsWith('/api/v1/agent_host/workspace_manifest') && authorization === 'Bearer cyi_ah_old') {
        return {ok: false, status: 401, json: async () => ({})} as unknown as Response
      }
      if (target.endsWith('/api/v1/hosts')) {
        return {ok: true, status: 200, json: async () => ({data: {id: 'h1', token: 'cyi_ah_new'}})} as unknown as Response
      }
      if (target.endsWith('/api/v1/agent_host/workspace_manifest')) {
        return {ok: true, status: 200, json: async () => ({
          data: {version: 1, digest: 'd1', workspace_root_hint: 'x', repositories: []},
        })} as unknown as Response
      }
      return {
        ok: true,
        status: 200,
        json: async () => ({data: {ticket: 'CYAU-62', host_id: 'h1', run_id: 'run-62', expires_at: '2026-07-13T14:00:00.000Z'}}),
      } as unknown as Response
    })
    vi.stubGlobal('fetch', fetch)
    fake.runDaemon.mockImplementationOnce(async (options: DaemonOptions) => {
      await options.sync?.()
      await options.heartbeat?.(true)
    })

    await run(Daemon, ['--playbook', '/tmp/pb.yml'])

    expect(authorizations).toEqual([
      // CYAU-224: the organization's Claude credential is asked once at boot, before the first cycle.
      'Bearer cyi_ah_old',
      // CYAU-228: so is the OpenRouter key OpenCode reviews with.
      'Bearer cyi_ah_old',
      'Bearer cyi_ah_old',
      'Bearer cyi_a_org',
      'Bearer cyi_ah_new',
      'Bearer cyi_ah_new',
    ])
  })

  it('without configured sync does not attempt the registration but still starts the loop', async () => {
    fake.runDaemon.mockClear()
    saveSecrets({})
    await run(Daemon, ['--playbook', '/tmp/pb.yml'])
    expect(loadSecrets().host).toBeUndefined()
    expect(fake.runDaemon).toHaveBeenCalledTimes(1)
  })

  // CYAU-220 — a daemon that cannot beat says why in the log, and starts anyway.
  it('without a heartbeat it logs the reason at boot and still starts the loop', async () => {
    fake.runDaemon.mockClear()
    saveSecrets({})
    const {stdout} = await runCaptured(Daemon, ['--playbook', '/tmp/pb.yml'])
    expect(stdout).toContain('heartbeat: not configured — this host is not registered yet')
    expect(fake.runDaemon).toHaveBeenCalledTimes(1)
  })

  it('registered host with no install project → logs the setup reason, without secrets', async () => {
    fake.runDaemon.mockClear()
    saveSecrets({sync: {}, host: {id: 'h1', token: 'cyi_ah_s'}, hostFingerprint: 'fp'})
    vi.stubGlobal('fetch', vi.fn(async () => ({ok: false, status: 404, json: async () => ({})}) as unknown as Response))
    const {stdout} = await runCaptured(Daemon, ['--playbook', '/tmp/pb.yml'])
    expect(stdout).toContain('heartbeat: not configured — no project chosen at install')
    expect(stdout).not.toContain('cyi_ah_s')
    expect(fake.runDaemon).toHaveBeenCalledTimes(1)
  })

  it('heartbeat already configured → no warning', async () => {
    fake.runDaemon.mockClear()
    saveSecrets({sync: {}, host: {id: 'h1', token: 'cyi_ah_s'}, heartbeat: {projectId: 'p1', slug: 'automator-h1'}})
    vi.stubGlobal('fetch', vi.fn(async () => ({ok: false, status: 404, json: async () => ({})}) as unknown as Response))
    const {stdout} = await runCaptured(Daemon, ['--playbook', '/tmp/pb.yml'])
    expect(stdout).not.toContain('heartbeat: not configured')
    expect(loadSecrets().heartbeat).toEqual({projectId: 'p1', slug: 'automator-h1'})
  })
})

// CYAU-202 — next to the daemon the timer launching the update is installed. Only in managed mode:
// without --managed the unit points to the checkout, which `automator update` does not update, and a timer there would run idle.
describe('install — timer di aggiornamento automatico', () => {
  beforeEach(() => {
    fake.installAutoUpdate.mockClear()
    fake.removeAutoUpdate.mockClear()
    fake.probeLinuxHost.mockReset().mockResolvedValue([
      {id: 'linux', ok: true},
      {id: 'systemd-cgroup-v2', ok: true},
      {id: 'bubblewrap', ok: true},
      {id: 'secret-service', ok: true},
    ])
  })

  it('--managed → timer installed with the same environment as the daemon', async () => {
    await run(Install, ['--managed', '--install-root', '/opt/a', '--json'])

    expect(fake.installAutoUpdate).toHaveBeenCalledTimes(1)
    const [, fields] = fake.installAutoUpdate.mock.calls[0] as [string, {entrypoint: string; env: Record<string, string>; runtimeDir?: string}]
    expect(fields.entrypoint).toBe('/opt/a/current/bin/run.js')
    expect(fields.env.AUTOMATOR_INSTALL_ROOT).toBe('/opt/a')
    // Same state folder as the daemon: that is where the lock the "idle machine" gate relies on lives.
    const [daemonOptions] = fake.manager.install.mock.calls.at(-1) as [{env: Record<string, string>}]
    expect(fields.env.AUTOMATOR_STATE_DIR).toBe(daemonOptions.env.AUTOMATOR_STATE_DIR)
    expect(fields.runtimeDir).toBe('/run/user/1001')
  })

  it('without --managed → no timer: update would not update the checkout', async () => {
    await run(Install, ['--json'])

    expect(fake.installAutoUpdate).not.toHaveBeenCalled()
  })

  it('uninstall also removes the timer', async () => {
    await run(Uninstall, ['--json'])

    expect(fake.removeAutoUpdate).toHaveBeenCalledTimes(1)
  })
})
