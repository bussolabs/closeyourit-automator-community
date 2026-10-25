import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import {afterEach, beforeEach, describe, expect, it} from 'vitest'
import Update from '../src/commands/update'
import {type ManagedServiceRuntime, type OsPlatform, type ServiceManager, type ServiceRuntime, type ServiceStatus} from '../src/lib/service'
import {type ReleaseEntry, type ReleaseManifest, type UpdateProbe, type UpdateTransaction} from '../src/lib/update'
import {type IdleHold} from '../src/lib/host-idle'
import {type AutoUpdateFields} from '../src/lib/auto-update-timer'
import {loadManagedServiceConfig, saveManagedServiceConfig} from '../src/lib/managed-service'
import {AutomatorError, ErrorCodes} from '../src/errors/error-codes'
import {run, runCaptured, runExpectingExit, testConfig} from './helpers/command'
import {readUpdateFailure} from '../src/lib/update-outcome'
import {type PinResult} from '../src/lib/runtime-pins'

// The `update` command (CYAU-33) distributes/updates the Automator: downloads from the channel a VERIFIED and
// compatible version, installs it in the atomic layout releases/<version> + `current`, restarts and checks health; a
// failed update restores the previous one without losing runs. Safe-by-default shell gate: updated/already up to date
// → exit 0; incompatible → exit 3; rolled-back → exit 3; failed → exit 1; invalid input → exit 2. The real
// execution (curl/tar/symlink/restart) is injected in the tests by a fake probe (no process, no network).

interface ProbeCalls {
  download: number
  activate: string[]
  restore: string[]
  restart: number
}

interface FakeOptions {
  current?: string | null
  manifest?: ReleaseManifest
  checksum?: string
  currentTarget?: string | null
  healthy?: boolean
  serviceInstalled?: boolean
}

let calls: ProbeCalls
let fakeOpts: FakeOptions
let fakeCurrentTarget: string | null
let healthChecks: number
let manifestFetches: number

function entry(version: string, extra: Partial<ReleaseEntry> = {}): ReleaseEntry {
  return {version, channel: 'stable', url: `https://x/${version}.tgz`, sha256: 'sha256:MATCH', ...extra}
}

/** Runs `fn` expecting an AutomatorError, so the tests can inspect its code/message/details. */
function captureAutomatorError(fn: () => unknown): AutomatorError {
  try {
    fn()
  } catch (error) {
    if (error instanceof AutomatorError) return error
    throw error
  }
  throw new Error('atteso un AutomatorError, nessuna eccezione lanciata')
}

function makeFakeProbe(): UpdateProbe {
  fakeCurrentTarget = fakeOpts.currentTarget ?? (fakeOpts.current ? `/opt/a/releases/${fakeOpts.current}` : null)
  healthChecks = 0
  let transaction: UpdateTransaction | null = null
  return {
    acquireLock: () => 'command-lock',
    releaseLock: () => {},
    reapStaging: () => 0,
    readTransaction: () => transaction,
    writeTransaction: (value) => { transaction = value },
    clearTransaction: () => { transaction = null },
    currentVersion: () => fakeCurrentTarget ? fakeCurrentTarget.split('/').at(-1) ?? null : fakeOpts.current ?? null,
    fetchManifest: () => {
      manifestFetches += 1
      return fakeOpts.manifest ?? {channel: 'stable', releases: []}
    },
    download: () => {
      calls.download += 1
    },
    checksum: () => fakeOpts.checksum ?? 'MATCH',
    createStaging: (prefix) => `${prefix}test`,
    extract: () => {},
    preflight: () => true,
    releaseExists: () => false,
    activateRetained: () => false,
    markReleaseOwnership: () => {},
    releaseOwnedBy: () => true,
    promote: () => {},
    readCurrentTarget: () => fakeCurrentTarget,
    serviceInstalled: () => fakeOpts.serviceInstalled ?? true,
    migrateGuardrails: () => {},
    activate: (dir) => {
      calls.activate.push(dir)
      fakeCurrentTarget = dir
    },
    restore: (prev) => {
      calls.restore.push(prev)
      fakeCurrentTarget = prev
    },
    deactivate: (expectedTarget) => {
      if (fakeCurrentTarget === expectedTarget) fakeCurrentTarget = null
    },
    restart: () => {
      calls.restart += 1
    },
    healthCheck: () => healthChecks++ === 0 ? fakeOpts.healthy ?? true : true,
    cleanup: () => {},
  }
}

// CYAU-202: the cycle lock acquisition is injected; by default the test machine is free, so no test
// touches the real host pidfile.
let idleHold: IdleHold = {held: true, release: () => { idleReleases += 1 }}
let idleReleases = 0
// CYAU-202: daemon unit as seen by the update and timers actually installed.
let timerRuntime: ServiceRuntime | null = null
let installedTimers: Array<{homeDir: string; fields: AutoUpdateFields}> = []
// CYAU-209: alignment of the model CLIs, injected. By default it is already aligned.
let pinResult: PinResult = {outcome: 'aligned'}
let pinCalls = 0

// Test subclass: injects the fake probe in place of the real one (curl/tar/symlink).
class TestUpdate extends Update {
  // The test host is always Linux: the real `detectPlatform()` would reject the development machine.
  protected currentPlatform(): OsPlatform {
    return 'linux'
  }

  protected holdIdle(): IdleHold {
    return idleHold
  }

  protected async reconcileRuntimes(): Promise<PinResult> {
    pinCalls += 1
    return pinResult
  }

  protected installAutoUpdateTimer(homeDir: string, fields: AutoUpdateFields): void {
    installedTimers.push({homeDir, fields})
  }

  protected makeServiceManager(): ServiceManager {
    return {
      install: () => {},
      uninstall: () => {},
      status: () => ({installed: timerRuntime !== null, running: true}),
      runtime: () => timerRuntime,
      loadedRuntime: () => timerRuntime,
      managedRuntime: () => null,
      loadedManagedRuntime: () => null,
      restart: () => {},
      logsPath: () => '/logs',
      unitPath: () => '/unit',
    }
  }

  protected makeProbe(
    _installRoot?: string,
    _manifestBaseUrl?: string,
    migrateService = false,
    skipServicePreflight = false,
  ): UpdateProbe {
    receivedMigrateService = migrateService
    receivedSkipServicePreflight = skipServicePreflight
    return makeFakeProbe()
  }
}

// CYAU-156: replicates an installed version with FAULTY service checks — they throw before any
// network access, so no later release could fix them. As in the real probe, with explicit
// consent the gates are not even built.
class BrokenServiceGatesUpdate extends TestUpdate {
  protected makeProbe(
    installRoot?: string,
    manifestBaseUrl?: string,
    migrateService = false,
    skipServicePreflight = false,
  ): UpdateProbe {
    const probe = super.makeProbe(installRoot, manifestBaseUrl, migrateService, skipServicePreflight)
    if (skipServicePreflight) return {...probe, serviceInstalled: () => false}
    const broken = (): never => {
      throw new AutomatorError(ErrorCodes.Update.failed, 'controlli del servizio difettosi', 1)
    }
    return {...probe, preflightService: broken, serviceInstalled: broken}
  }
}

class RejectingServicePreflightUpdate extends TestUpdate {
  protected makeProbe(installRoot?: string, manifestBaseUrl?: string, migrateService = false): UpdateProbe {
    const probe = super.makeProbe(installRoot, manifestBaseUrl, migrateService)
    return {
      ...probe,
      preflightService: () => {
        throw new AutomatorError(ErrorCodes.Update.failed, 'servizio legacy richiede --migrate-service', 1)
      },
    }
  }
}

// CYAU-102: the service gate THROWS (does not return an UpdateResult) → replicates a diagnostic rejection with
// divergences to verify that the error path still produces a structured JSON payload.
class RejectingServiceInstalledUpdate extends TestUpdate {
  protected makeProbe(installRoot?: string, manifestBaseUrl?: string, migrateService = false): UpdateProbe {
    const probe = super.makeProbe(installRoot, manifestBaseUrl, migrateService)
    return {
      ...probe,
      serviceInstalled: () => {
        throw new AutomatorError(
          ErrorCodes.Update.failed,
          'daemon live non coincide con la definizione gestita su disco: nodePath atteso /service/node effettivo /wrong/node',
          1,
          {divergences: [{field: 'nodePath', expected: '/service/node', actual: '/wrong/node'}]},
        )
      },
    }
  }
}

let exposedServiceStatus: ServiceStatus = {installed: false, running: false}
let exposedManagedRuntime: ManagedServiceRuntime | null = null
let exposedLoadedRuntime: ManagedServiceRuntime | null = null
let exposedRuntime: ServiceRuntime | null = null
let exposedLoadedDefinition: ServiceRuntime | null = null
let managedRuntimeCalls = 0
let receivedMigrateService = false
let receivedSkipServicePreflight = false
let exposedStatusError: Error | null = null
let savedStateDir: string | undefined
let isolatedStateDir = ''

// Subclass that EXPOSES the real protected methods (without overriding them) to verify their construction.
class ExposedUpdate extends Update {
  publicMakeProbe(
    installRoot: string,
    manifestBaseUrl: string,
    migrateService = false,
    skipServicePreflight = false,
  ): UpdateProbe {
    return this.makeProbe(installRoot, manifestBaseUrl, migrateService, skipServicePreflight)
  }

  publicRestartCommand(platform: OsPlatform): {cmd: string; args: string[]} {
    return this.restartCommand(platform)
  }

  protected makeServiceManager(): ServiceManager {
    return {
      install: () => {},
      uninstall: () => {},
      status: () => {
        if (exposedStatusError) throw exposedStatusError
        return exposedServiceStatus
      },
      runtime: () => exposedRuntime,
      loadedRuntime: () => exposedLoadedDefinition,
      managedRuntime: () => {
        managedRuntimeCalls += 1
        return exposedManagedRuntime
      },
      loadedManagedRuntime: () => exposedLoadedRuntime,
      restart: () => {},
      logsPath: () => '/logs',
      unitPath: () => '/unit',
    }
  }

  protected currentPlatform(): OsPlatform {
    return 'linux'
  }
}

beforeEach(() => {
  calls = {download: 0, activate: [], restore: [], restart: 0}
  fakeOpts = {}
  fakeCurrentTarget = null
  healthChecks = 0
  manifestFetches = 0
  exposedServiceStatus = {installed: false, running: false}
  exposedManagedRuntime = null
  exposedLoadedRuntime = null
  exposedRuntime = null
  exposedLoadedDefinition = null
  managedRuntimeCalls = 0
  receivedMigrateService = false
  receivedSkipServicePreflight = false
  exposedStatusError = null
  idleReleases = 0
  idleHold = {held: true, release: () => { idleReleases += 1 }}
  timerRuntime = null
  installedTimers = []
  pinResult = {outcome: 'aligned'}
  pinCalls = 0
  // The update outcome is recorded in the state folder (CYAU-202): isolating it keeps the tests out of
  // the real one of the machine.
  savedStateDir = process.env.AUTOMATOR_STATE_DIR
  isolatedStateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'automator-cmd-update-'))
  process.env.AUTOMATOR_STATE_DIR = isolatedStateDir
})

afterEach(() => {
  if (savedStateDir === undefined) delete process.env.AUTOMATOR_STATE_DIR
  else process.env.AUTOMATOR_STATE_DIR = savedStateDir
  fs.rmSync(isolatedStateDir, {recursive: true, force: true})
})

interface UpdatePayload {
  dryRun: boolean
  channel: string
  installRoot: string
  currentVersion?: string | null
  serviceReconciliation?: string
  selection?: {decision: string; targetVersion: string | null; reason: string}
  result?: {outcome: string; toVersion: string | null; verified: boolean; rolledBack: boolean; reasons: string[]}
}

describe('update — happy path e stati', () => {
  it('updates to a newer verified version → exit 0, outcome updated', async () => {
    fakeOpts = {current: '1.0.0', manifest: {channel: 'stable', releases: [entry('1.0.0'), entry('1.2.0')]}, currentTarget: '/opt/a/releases/1.0.0', healthy: true}
    const payload = (await run(TestUpdate, ['--install-root', '/opt/a'])) as UpdatePayload
    expect(payload.result?.outcome).toBe('updated')
    expect(payload.result?.toVersion).toBe('1.2.0')
    expect(payload.result?.verified).toBe(true)
    expect(calls.activate).toEqual(['/opt/a/releases/1.2.0'])
    expect(calls.restart).toBe(1)
  })

  it('already on the latest version → exit 0, outcome up-to-date, nothing downloaded', async () => {
    fakeOpts = {current: '1.2.0', manifest: {channel: 'stable', releases: [entry('1.0.0'), entry('1.2.0')]}}
    const payload = (await run(TestUpdate, ['--install-root', '/opt/a'])) as UpdatePayload
    expect(payload.result?.outcome).toBe('up-to-date')
    expect(calls.download).toBe(0)
    expect(calls.activate).toEqual([])
  })

  it('without --install-root uses the default managed root; --manifest-url is accepted', async () => {
    fakeOpts = {current: '1.0.0', manifest: {channel: 'stable', releases: [entry('1.0.0'), entry('1.2.0')]}, currentTarget: '/x/1.0.0', healthy: true}
    const payload = (await run(TestUpdate, ['--manifest-url', 'https://mirror/latest'])) as UpdatePayload
    expect(payload.result?.outcome).toBe('updated')
    expect(payload.installRoot).toContain('closeyourit-automator')
  })

  it('normalizes a relative --install-root before building symlink and release', async () => {
    fakeOpts = {current: '1.2.0', manifest: {channel: 'stable', releases: [entry('1.2.0')]}}

    const payload = (await run(TestUpdate, ['--install-root', './automator-relative'])) as UpdatePayload

    expect(payload.installRoot).toBe(path.resolve('automator-relative'))
  })
})

describe('update — model CLIs (CYAU-209)', () => {
  const upToDate = () => {
    fakeOpts = {current: '1.2.0', manifest: {channel: 'stable', releases: [entry('1.2.0')]}}
  }

  it('aligns Claude and Codex before the restart, while holding the lock', async () => {
    upToDate()
    pinResult = {outcome: 'updated', changes: ['codex 0.146.1 → 0.156.1']}
    await run(TestUpdate, ['--install-root', '/opt/a'])
    expect(pinCalls).toBe(1)
    expect(readUpdateFailure()).toBeNull()
  })

  it('a failed alignment stays as a notice for the beat even if the automator is updated', async () => {
    upToDate()
    pinResult = {outcome: 'rolled-back', detail: 'prova fallita con claude 2.1.274 (claude: exit 1): tornato a claude 2.1.222'}
    const payload = (await run(TestUpdate, ['--install-root', '/opt/a'])) as UpdatePayload
    expect(payload.result?.outcome).toBe('up-to-date')
    expect(readUpdateFailure()?.reason).toContain('CLI dei modelli: prova fallita con claude 2.1.274')
  })

  it('dry-run, recovery and busy machine do not touch the CLIs', async () => {
    upToDate()
    await run(TestUpdate, ['--install-root', '/opt/a', '--dry-run'])
    await run(TestUpdate, ['--install-root', '/opt/a', '--skip-service-preflight'])
    idleHold = {held: false, reason: 'lavorazione in corso'}
    await run(TestUpdate, ['--install-root', '/opt/a'])
    expect(pinCalls).toBe(0)
  })
})

describe('update — gate non-ok outcomes mapped to exit code', () => {
  it('no version compatible with the server → exit 3 (C409-UPDATE-002)', async () => {
    fakeOpts = {current: '1.0.0', manifest: {channel: 'stable', releases: [entry('1.0.0'), entry('2.0.0', {minServer: '9.0.0'})]}}
    const {stderr} = await runExpectingExit(TestUpdate, ['--install-root', '/opt/a', '--server-version', '5.0.0'], 3)
    expect(stderr).toContain('C409-UPDATE-002')
  })

  it('gate outcome with --json prints payload+error on stdout and exits 3', async () => {
    fakeOpts = {current: '1.0.0', manifest: {channel: 'stable', releases: [entry('1.0.0'), entry('2.0.0', {minServer: '9.0.0'})]}}
    const {stdout} = await runExpectingExit(TestUpdate, ['--install-root', '/opt/a', '--server-version', '5.0.0', '--json'], 3)
    expect(stdout).toContain('C409-UPDATE-002')
  })

  // CYAU-102 (DoD 3): the service gate THROWS before runUpdate returns an UpdateResult. Before, the error
  // escaped emit() and `--json` stayed empty; now this path also emits a structured JSON payload.
  it('a throwing service gate still produces a structured JSON payload with --json', async () => {
    const {stdout} = await runExpectingExit(RejectingServiceInstalledUpdate, ['--install-root', '/opt/a', '--json'], 1)
    // In `--json` the output goes ONLY to stdout: a complete payload, no longer the empty file of before (CYAU-102).
    const payload = JSON.parse(stdout) as {installRoot: string; error: {code: string; message: string; divergences: unknown}}
    expect(payload.installRoot).toBe('/opt/a')
    expect(payload.error.code).toBe('C500-UPDATE-004')
    expect(payload.error.message).toContain('nodePath')
    expect(payload.error.divergences).toEqual([{field: 'nodePath', expected: '/service/node', actual: '/wrong/node'}])
  })

  it('without --json the throwing gate reports the diverging field on stderr and exits 1', async () => {
    const {stdout, stderr} = await runExpectingExit(RejectingServiceInstalledUpdate, ['--install-root', '/opt/a'], 1)
    expect(stdout).toBe('')
    expect(stderr).toContain('C500-UPDATE-004')
    expect(stderr).toContain('nodePath')
  })

  it('failed and restored update → exit 3 (C409-UPDATE-003), rollback done', async () => {
    fakeOpts = {current: '1.0.0', manifest: {channel: 'stable', releases: [entry('1.0.0'), entry('1.2.0')]}, currentTarget: '/opt/a/releases/1.0.0', healthy: false}
    const {stderr} = await runExpectingExit(TestUpdate, ['--install-root', '/opt/a'], 3)
    expect(stderr).toContain('C409-UPDATE-003')
    expect(calls.restore).toEqual(['/opt/a/releases/1.0.0'])
  })

  it('non-matching checksum → exit 1 (C500-UPDATE-004), version not activated', async () => {
    fakeOpts = {current: '1.0.0', manifest: {channel: 'stable', releases: [entry('1.0.0'), entry('1.2.0')]}, checksum: 'TAMPERED'}
    const {stderr} = await runExpectingExit(TestUpdate, ['--install-root', '/opt/a'], 1)
    expect(stderr).toContain('C500-UPDATE-004')
    expect(calls.activate).toEqual([])
  })

  it('unknown channel → exit 2 (C400-UPDATE-001)', async () => {
    const {stderr} = await runExpectingExit(TestUpdate, ['--channel', 'nightly'], 2)
    expect(stderr).toContain('C400-UPDATE-001')
  })
})

describe('update --dry-run', () => {
  it('shows the selected release without downloading or activating anything', async () => {
    fakeOpts = {current: '1.0.0', manifest: {channel: 'stable', releases: [entry('1.0.0'), entry('1.3.0')]}}
    const payload = (await run(TestUpdate, ['--install-root', '/opt/a', '--dry-run', '--json'])) as UpdatePayload
    expect(payload.dryRun).toBe(true)
    expect(payload.selection?.decision).toBe('update')
    expect(payload.selection?.targetVersion).toBe('1.3.0')
    expect(calls.download).toBe(0)
    expect(calls.activate).toEqual([])
  })

  it('human-form dry-run prints channel, current version and target', async () => {
    fakeOpts = {current: null, manifest: {channel: 'stable', releases: [entry('1.0.0')]}}
    const {stdout} = await runCaptured(TestUpdate, ['--install-root', '/opt/a', '--dry-run'])
    expect(stdout).toContain('dry-run')
    expect(stdout).toContain('1.0.0')
  })

  it('dry-run with a non-existent pin → decision none', async () => {
    fakeOpts = {current: '1.0.0', manifest: {channel: 'stable', releases: [entry('1.0.0')]}}
    const payload = (await run(TestUpdate, ['--install-root', '/opt/a', '--dry-run', '--target-version', '9.9.9', '--json'])) as UpdatePayload
    expect(payload.selection?.decision).toBe('none')
  })

  it('dry-run with an existing pin → decision update', async () => {
    fakeOpts = {current: '1.0.0', manifest: {channel: 'stable', releases: [entry('1.0.0'), entry('1.2.0')]}}
    const payload = (await run(TestUpdate, ['--install-root', '/opt/a', '--dry-run', '--target-version', '1.2.0', '--json'])) as UpdatePayload
    expect(payload.selection?.decision).toBe('update')
    expect(payload.selection?.targetVersion).toBe('1.2.0')
  })

  it('dry-run with an incompatible pin → decision incompatible', async () => {
    fakeOpts = {current: '1.0.0', manifest: {channel: 'stable', releases: [entry('2.0.0', {minServer: '9.0.0'})]}}

    const payload = (await run(TestUpdate, [
      '--install-root', '/opt/a', '--dry-run', '--target-version', '2.0.0', '--server-version', '5.0.0', '--json',
    ])) as UpdatePayload

    expect(payload.selection?.decision).toBe('incompatible')
    expect(payload.selection?.targetVersion).toBeNull()
  })

  it('dry-run rejects a constrained pin if --server-version is missing', async () => {
    fakeOpts = {current: '1.0.0', manifest: {channel: 'stable', releases: [entry('2.0.0', {minServer: '1.0.0'})]}}

    const payload = (await run(TestUpdate, [
      '--install-root', '/opt/a', '--dry-run', '--target-version', '2.0.0', '--json',
    ])) as UpdatePayload

    expect(payload.selection?.decision).toBe('incompatible')
    expect(payload.selection?.targetVersion).toBeNull()
  })

  it('already up-to-date dry-run (human form) shows target "—" and decision up-to-date', async () => {
    fakeOpts = {current: '1.2.0', manifest: {channel: 'stable', releases: [entry('1.0.0'), entry('1.2.0')]}}
    const {stdout} = await runCaptured(TestUpdate, ['--install-root', '/opt/a', '--dry-run'])
    expect(stdout).toContain('up-to-date')
    expect(stdout).toContain('—')
  })
})

describe('update — pin e canale beta', () => {
  it('--target-version pins a specific channel version', async () => {
    fakeOpts = {current: '1.2.0', manifest: {channel: 'stable', releases: [entry('1.0.0'), entry('1.2.0')]}, currentTarget: '/opt/a/releases/1.2.0', healthy: true}
    const payload = (await run(TestUpdate, ['--install-root', '/opt/a', '--target-version', '1.0.0'])) as UpdatePayload
    expect(payload.result?.outcome).toBe('updated')
    expect(payload.result?.toVersion).toBe('1.0.0')
  })

  it('--channel beta queries the beta channel', async () => {
    fakeOpts = {
      current: null,
      manifest: {channel: 'beta', releases: [{version: '2.0.0-beta.1', channel: 'beta', url: 'https://x/b.tgz', sha256: 'sha256:MATCH'}]},
      currentTarget: null,
      healthy: true,
    }
    const payload = (await run(TestUpdate, ['--install-root', '/opt/a', '--channel', 'beta'])) as UpdatePayload
    expect(payload.channel).toBe('beta')
    expect(payload.result?.outcome).toBe('updated')
    expect(payload.result?.toVersion).toBe('2.0.0-beta.1')
  })

  it('--target-version does not bypass server compatibility', async () => {
    fakeOpts = {current: '1.0.0', manifest: {channel: 'stable', releases: [entry('2.0.0', {minServer: '9.0.0'})]}}

    const {stderr} = await runExpectingExit(TestUpdate, [
      '--install-root', '/opt/a', '--target-version', '2.0.0', '--server-version', '5.0.0',
    ], 3)

    expect(stderr).toContain('C409-UPDATE-002')
  })

  it('--target-version fails closed with missing or malformed server version without mutating the release', async () => {
    for (const serverArgs of [[], ['--server-version', 'server-next']]) {
      calls = {download: 0, activate: [], restore: [], restart: 0}
      fakeOpts = {current: '1.0.0', manifest: {channel: 'stable', releases: [entry('2.0.0', {minServer: '1.0.0'})]}}

      const {stderr} = await runExpectingExit(TestUpdate, [
        '--install-root', '/opt/a', '--target-version', '2.0.0', ...serverArgs,
      ], 3)

      expect(stderr).toContain('C409-UPDATE-002')
      expect(calls.download).toBe(0)
      expect(calls.activate).toEqual([])
      expect(calls.restore).toEqual([])
      expect(calls.restart).toBe(0)
    }
  })
})

describe('update — construction of the real probe and restart command', () => {
  it('restartCommand usa systemd user su Linux', async () => {
    const cmd = new ExposedUpdate([], {} as never)
    expect(cmd.publicRestartCommand('linux')).toEqual({
      cmd: 'systemctl',
      args: ['--user', 'restart', 'closeyourit-automator.service'],
    })
  })

  it('makeProbe builds a real probe with all methods (no command run)', async () => {
    const cmd = new ExposedUpdate([], await testConfig())
    const probe = cmd.publicMakeProbe('/opt/a', 'https://dl/latest')
    for (const method of ['acquireLock', 'releaseLock', 'reapStaging', 'readTransaction', 'writeTransaction', 'clearTransaction', 'currentVersion', 'fetchManifest', 'download', 'checksum', 'createStaging', 'extract', 'preflight', 'releaseExists', 'markReleaseOwnership', 'releaseOwnedBy', 'promote', 'serviceInstalled', 'activate', 'restore', 'deactivate', 'restart', 'healthCheck', 'cleanup']) {
      expect(typeof (probe as unknown as Record<string, unknown>)[method]).toBe('function')
    }
    expect(probe.serviceInstalled()).toBe(false)
  })

  it('rejects a non-managed service or one bound to a different installRoot', async () => {
    exposedServiceStatus = {installed: true, running: true}
    const cmd = new ExposedUpdate([], await testConfig())

    expect(() => cmd.publicMakeProbe('/opt/a', 'https://dl/latest').serviceInstalled()).toThrow(/non gestito/i)
    expect(managedRuntimeCalls).toBe(1)

    exposedManagedRuntime = {
      installRoot: '/opt/other',
      nodePath: '/service/node',
      entrypoint: '/opt/other/current/bin/run.js',
      daemonArgs: ['daemon', '--playbook', '/p/playbook.yml'],
      configDir: '/opt/config',
      codexHome: '/opt/codex',
    }
    expect(() => cmd.publicMakeProbe('/opt/a', 'https://dl/latest').serviceInstalled()).toThrow(/non gestito/i)
    expect(managedRuntimeCalls).toBe(2)
  })

  it('legacy checkout unit requires --migrate-service before the network', async () => {
    const legacy: ServiceRuntime = {
      kind: 'legacy', platform: 'linux', installRoot: null,
      nodePath: '/service/node', entrypoint: '/checkout/bin/run.js',
      daemonArgs: ['daemon', '--playbook', '/p/playbook.yml'],
      pathEnv: '/shims:/usr/bin', homeDir: '/home', workingDir: '/p',
      env: {AUTOMATOR_CONFIG_DIR: '/opt/config', AUTOMATOR_PLAYBOOK: '/p/playbook.yml', CODEX_HOME: '/opt/codex'},
      configDir: '/opt/config', codexHome: '/opt/codex',
    }
    exposedServiceStatus = {installed: true, running: false}
    exposedRuntime = legacy
    const cmd = new ExposedUpdate([], await testConfig())

    expect(() => cmd.publicMakeProbe('/opt/a', 'https://dl/latest').serviceInstalled()).toThrow(/--migrate-service/i)
    expect(cmd.publicMakeProbe('/opt/a', 'https://dl/latest', true).serviceInstalled()).toBe(true)
  })

  it('legacy migration rejects disk/live mismatch before the network', async () => {
    const legacy: ServiceRuntime = {
      kind: 'legacy', platform: 'linux', installRoot: null,
      nodePath: '/service/node', entrypoint: '/checkout/bin/run.js',
      daemonArgs: ['daemon', '--playbook', '/p/playbook.yml'],
      pathEnv: '/shims:/usr/bin', homeDir: '/home', workingDir: '/p',
      env: {AUTOMATOR_CONFIG_DIR: '/opt/config', AUTOMATOR_PLAYBOOK: '/p/playbook.yml', CODEX_HOME: '/opt/codex'},
      configDir: '/opt/config', codexHome: '/opt/codex',
    }
    exposedServiceStatus = {installed: true, running: true}
    exposedRuntime = legacy
    exposedLoadedDefinition = {...legacy, entrypoint: '/other/bin/run.js'}
    const cmd = new ExposedUpdate([], await testConfig())

    expect(() => cmd.publicMakeProbe('/opt/a', 'https://dl/latest', true).serviceInstalled()).toThrow(/disk.*live|daemon live/i)
  })

  it('propagates the explicit --migrate-service flag to the probe', async () => {
    fakeOpts = {current: '1.2.0', currentTarget: '/opt/a/releases/1.2.0', manifest: {channel: 'stable', releases: [entry('1.2.0')]}}
    await run(TestUpdate, ['--install-root', '/opt/a', '--migrate-service', '--json'])
    expect(receivedMigrateService).toBe(true)
  })

  it('with --target-version rejects the legacy service before any manifest fetch', async () => {
    fakeOpts = {current: '1.0.0', manifest: {channel: 'stable', releases: [entry('2.0.0')]}}

    const {stderr} = await runExpectingExit(RejectingServicePreflightUpdate, [
      '--install-root', '/opt/a', '--target-version', '2.0.0', '--server-version', '1.0.0',
    ], 1)

    expect(stderr).toMatch(/legacy.*--migrate-service/i)
    expect(manifestFetches).toBe(0)
    expect(calls.download).toBe(0)
  })

  it('--dry-run also runs the service preflight before the read-only fetch', async () => {
    fakeOpts = {current: '1.0.0', manifest: {channel: 'stable', releases: [entry('2.0.0')]}}

    const {stderr} = await runExpectingExit(RejectingServicePreflightUpdate, [
      '--install-root', '/opt/a', '--dry-run',
    ], 1)

    expect(stderr).toMatch(/legacy.*--migrate-service/i)
    expect(manifestFetches).toBe(0)
  })

  it('rejects before the migration a live daemon diverging from the on-disk unit', async () => {
    exposedServiceStatus = {installed: true, running: true}
    exposedManagedRuntime = {
      installRoot: '/opt/a',
      nodePath: '/service/node',
      entrypoint: '/opt/a/current/bin/run.js',
      daemonArgs: ['daemon', '--playbook', '/p/playbook.yml'],
      configDir: '/opt/config',
      codexHome: '/opt/codex',
    }
    const cmd = new ExposedUpdate([], await testConfig())

    expect(() => cmd.publicMakeProbe('/opt/a', 'https://dl/latest').serviceInstalled()).toThrow(/daemon live/i)
  })

  it.each([
    ['root', {installRoot: '/opt/other'}],
    ['node', {nodePath: '/other/node'}],
    ['entrypoint', {entrypoint: '/opt/a/current/bin/other.js'}],
    ['argv count', {daemonArgs: ['daemon', '--playbook', '/p/playbook.yml', '--interval', '30']}],
    ['argv value', {daemonArgs: ['daemon', '--playbook', '/other/playbook.yml']}],
    ['config', {configDir: '/other/config'}],
    ['codex', {codexHome: '/other/codex'}],
  ] as const)('rejects live managed mismatch on field %s', async (_field, override) => {
    const runtime: ManagedServiceRuntime = {
      installRoot: '/opt/a', nodePath: '/service/node', entrypoint: '/opt/a/current/bin/run.js',
      daemonArgs: ['daemon', '--playbook', '/p/playbook.yml'], configDir: '/opt/config', codexHome: '/opt/codex',
    }
    exposedServiceStatus = {installed: true, running: true}
    exposedManagedRuntime = runtime
    exposedLoadedRuntime = {...runtime, ...override}

    const cmd = new ExposedUpdate([], await testConfig())
    expect(() => cmd.publicMakeProbe('/opt/a', 'https://dl/latest').serviceInstalled()).toThrow(/daemon live/i)
  })

  // CYAU-102 (DoD 2): when the gate rejects, it must say WHICH field diverges, with expected and actual — in the
  // message and in the structured divergences (`details`) feeding the `--json` output.
  it('the managed rejection names the diverging field with expected and actual', async () => {
    const runtime: ManagedServiceRuntime = {
      installRoot: '/opt/a', nodePath: '/service/node', entrypoint: '/opt/a/current/bin/run.js',
      daemonArgs: ['daemon', '--playbook', '/p/playbook.yml'], configDir: '/opt/config', codexHome: '/opt/codex',
    }
    exposedServiceStatus = {installed: true, running: true}
    exposedManagedRuntime = runtime
    exposedLoadedRuntime = {...runtime, nodePath: '/shim/node'}

    const cmd = new ExposedUpdate([], await testConfig())
    const error = captureAutomatorError(() => cmd.publicMakeProbe('/opt/a', 'https://dl/latest').serviceInstalled())
    expect(error.code).toBe('C500-UPDATE-004')
    expect(error.message).toContain('nodePath')
    expect(error.message).toContain('/service/node')
    expect(error.message).toContain('/shim/node')
    expect(error.details?.divergences).toEqual([{field: 'nodePath', expected: '/service/node', actual: '/shim/node'}])
  })

  it('the managed rejection with an unreadable live definition declares it explicitly', async () => {
    exposedServiceStatus = {installed: true, running: true}
    exposedManagedRuntime = {
      installRoot: '/opt/a', nodePath: '/service/node', entrypoint: '/opt/a/current/bin/run.js',
      daemonArgs: ['daemon', '--playbook', '/p/playbook.yml'], configDir: '/opt/config', codexHome: '/opt/codex',
    }
    exposedLoadedRuntime = null

    const cmd = new ExposedUpdate([], await testConfig())
    const error = captureAutomatorError(() => cmd.publicMakeProbe('/opt/a', 'https://dl/latest').serviceInstalled())
    expect(error.details?.divergences).toEqual([
      {field: 'definizione live', expected: 'unit gestita leggibile e coerente', actual: 'assente o non interpretabile'},
    ])
  })

  it.each([
    ['node', {nodePath: '/other/node'}],
    ['codex', {codexHome: '/other/codex'}],
    ['config', {settingsPath: '/other/config/guardrails/settings.json'}],
  ] as const)('rejects diverging persisted metadata on field %s', async (_field, override) => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'automator-update-metadata-'))
    const runtime: ManagedServiceRuntime = {
      installRoot: root, nodePath: '/service/node', entrypoint: path.join(root, 'current', 'bin', 'run.js'),
      daemonArgs: ['daemon', '--playbook', '/p/playbook.yml'], configDir: '/opt/config', codexHome: '/opt/codex',
    }
    const guardrails = {
      hooksDir: '/opt/config/guardrails/hooks', settingsPath: '/opt/config/guardrails/settings.json',
      codexRulesPath: '/opt/codex/rules/closeyourit-automator.rules', worktreesRoot: '/worktrees',
      ...(override.settingsPath ? {settingsPath: override.settingsPath} : {}),
    }
    saveManagedServiceConfig(root, {
      version: 1,
      nodePath: override.nodePath ?? runtime.nodePath,
      codexHome: override.codexHome ?? runtime.codexHome,
      guardrails: {
        ...guardrails,
        codexRulesPath: path.join(override.codexHome ?? runtime.codexHome, 'rules', 'closeyourit-automator.rules'),
      },
    })
    exposedServiceStatus = {installed: true, running: false}
    exposedManagedRuntime = runtime
    try {
      const cmd = new ExposedUpdate([], await testConfig())
      expect(() => cmd.publicMakeProbe(root, 'https://dl/latest').serviceInstalled()).toThrow(/runtime persistito/i)
    } finally {
      fs.rmSync(root, {recursive: true, force: true})
    }
  })

  it('with --skip-service-preflight builds no service gate', async () => {
    const legacy: ServiceRuntime = {
      kind: 'legacy', platform: 'linux', installRoot: null,
      nodePath: '/service/node', entrypoint: '/checkout/bin/run.js',
      daemonArgs: ['daemon', '--playbook', '/p/playbook.yml'],
      pathEnv: '/shims:/usr/bin', homeDir: '/home', workingDir: '/p',
      env: {AUTOMATOR_CONFIG_DIR: '/opt/config', AUTOMATOR_PLAYBOOK: '/p/playbook.yml', CODEX_HOME: '/opt/codex'},
      configDir: '/opt/config', codexHome: '/opt/codex',
    }
    exposedServiceStatus = {installed: true, running: true}
    exposedRuntime = legacy
    exposedLoadedDefinition = {...legacy, entrypoint: '/other/bin/run.js'}
    const cmd = new ExposedUpdate([], await testConfig())

    const probe = cmd.publicMakeProbe('/opt/a', 'https://dl/latest', false, true)

    expect(probe.serviceInstalled()).toBe(false)
    expect(() => probe.preflightService?.()).not.toThrow()
  })

  // CYAU-156 (DoD 2): a rejecting gate must say what to do, otherwise only uninstall + reinstall remains.
  it.each([
    ['service of another root', () => {
      exposedServiceStatus = {installed: true, running: true}
    }],
    ['diverging live daemon', () => {
      exposedServiceStatus = {installed: true, running: true}
      exposedManagedRuntime = {
        installRoot: '/opt/a', nodePath: '/service/node', entrypoint: '/opt/a/current/bin/run.js',
        daemonArgs: ['daemon', '--playbook', '/p/playbook.yml'], configDir: '/opt/config', codexHome: '/opt/codex',
      }
      exposedLoadedRuntime = null
    }],
  ] as const)('the gate rejection %s points to the recovery path', async (_case, arrange) => {
    arrange()
    const cmd = new ExposedUpdate([], await testConfig())

    const error = captureAutomatorError(() => cmd.publicMakeProbe('/opt/a', 'https://dl/latest').serviceInstalled())

    expect(error.message).toContain('--skip-service-preflight')
    expect(String(error.details?.remediation)).toContain('automator update')
  })

  // A FAULTY gate does not reject with a diagnosis: it crashes. That path too must come with the remedy, otherwise
  // exactly the dead-end case of the ticket remains.
  it.each([
    ['the preflight gate', (probe: UpdateProbe) => probe.preflightService?.()],
    ['the pre-download gate', (probe: UpdateProbe) => probe.serviceInstalled()],
  ] as const)('an unexpected crash in %s still points to the recovery path', async (_case, invoke) => {
    exposedStatusError = new TypeError('lettura della unit non riuscita: undefined non è una funzione')
    const cmd = new ExposedUpdate([], await testConfig())

    const error = captureAutomatorError(() => invoke(cmd.publicMakeProbe('/opt/a', 'https://dl/latest')))

    expect(error.code).toBe('C500-UPDATE-004')
    expect(error.message).toContain('--skip-service-preflight')
    expect(String(error.details?.remediation)).toContain('automator update')
  })

  it('atomically adopts the metadata of a legacy unit before the restart', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'automator-update-legacy-'))
    exposedServiceStatus = {installed: true, running: false}
    exposedManagedRuntime = {
      installRoot: root,
      nodePath: '/service/node',
      entrypoint: path.join(root, 'current', 'bin', 'run.js'),
      daemonArgs: ['daemon', '--playbook', '/p/playbook.yml'],
      configDir: path.join(root, 'config'),
      codexHome: path.join(root, 'codex'),
    }
    const cmd = new ExposedUpdate([], await testConfig())
    try {
      expect(cmd.publicMakeProbe(root, 'https://dl/latest').serviceInstalled()).toBe(true)
      expect(loadManagedServiceConfig(root)).toMatchObject({
        nodePath: '/service/node',
        codexHome: path.join(root, 'codex'),
        guardrails: {
          settingsPath: path.join(root, 'config', 'guardrails', 'settings.json'),
          codexRulesPath: path.join(root, 'codex', 'rules', 'closeyourit-automator.rules'),
        },
      })
    } finally {
      fs.rmSync(root, {recursive: true, force: true})
    }
  })
})

// CYAU-156: the update startup checks run from the INSTALLED binary. If the defect is there, publishing a
// fixed release is not enough — the new code never runs. The explicit recovery path updates
// only the managed bytes, without touching the service, and says what to do right after.
describe('update --skip-service-preflight — recovery from faulty startup checks', () => {
  const manifest = {channel: 'stable' as const, releases: [entry('1.0.0'), entry('1.2.0')]}

  beforeEach(() => {
    fakeOpts = {current: '1.0.0', manifest, currentTarget: '/opt/a/releases/1.0.0', healthy: true}
  })

  it('without the flag a faulty check blocks any later release', async () => {
    const {stderr} = await runExpectingExit(BrokenServiceGatesUpdate, ['--install-root', '/opt/a'], 1)

    expect(stderr).toContain('controlli del servizio difettosi')
    expect(calls.download).toBe(0)
    expect(calls.activate).toEqual([])
  })

  it('with the flag the fixed release is activated without uninstalling and reinstalling', async () => {
    const payload = (await run(BrokenServiceGatesUpdate, ['--install-root', '/opt/a', '--skip-service-preflight'])) as UpdatePayload

    expect(payload.result?.outcome).toBe('updated')
    expect(payload.result?.toVersion).toBe('1.2.0')
    expect(calls.activate).toEqual(['/opt/a/releases/1.2.0'])
    expect(calls.restart).toBe(0)
  })

  it('declares in the payload that the service was not reconciled', async () => {
    const payload = (await run(TestUpdate, ['--install-root', '/opt/a', '--skip-service-preflight', '--json'])) as UpdatePayload

    expect(payload.serviceReconciliation).toBe('skipped')
    expect(receivedSkipServicePreflight).toBe(true)
  })

  it('in human form says which command to run right after', async () => {
    const {stdout} = await runCaptured(TestUpdate, ['--install-root', '/opt/a', '--skip-service-preflight'])

    expect(stdout).toContain('automator update')
    expect(stdout).toMatch(/servizio non riconciliato/i)
  })

  it('on a failed update it does not suggest reconciling a version that was not installed', async () => {
    fakeOpts = {current: '1.0.0', manifest, currentTarget: '/opt/a/releases/1.0.0', checksum: 'TAMPERED'}

    const {stdout} = await runExpectingExit(TestUpdate, ['--install-root', '/opt/a', '--skip-service-preflight'], 1)

    expect(stdout).not.toMatch(/servizio non riconciliato/i)
    expect(calls.activate).toEqual([])
  })

  it('--dry-run also skips the faulty preflight and shows the selection', async () => {
    const payload = (await run(BrokenServiceGatesUpdate, [
      '--install-root', '/opt/a', '--dry-run', '--skip-service-preflight', '--json',
    ])) as UpdatePayload

    expect(payload.selection?.decision).toBe('update')
    expect(payload.selection?.targetVersion).toBe('1.2.0')
  })

  it('together with --migrate-service it is invalid input → exit 2 (C400-UPDATE-001)', async () => {
    const {stderr} = await runExpectingExit(
      TestUpdate,
      ['--install-root', '/opt/a', '--skip-service-preflight', '--migrate-service'],
      2,
    )

    expect(stderr).toContain('C400-UPDATE-001')
    expect(calls.download).toBe(0)
  })
})

// CYAU-202 — the update starts by itself (systemd timer), so it can no longer count on an operator
// checking whether the machine is busy: the "machine free" gate sits in the command. Refusing is NOT an error —
// it is the expected behaviour, and the next round retries: exit 0, otherwise the timer would mark itself
// failed at every long run.
describe('update — never interrupts a run in progress', () => {
  const manifest: ReleaseManifest = {channel: 'stable', releases: [entry('1.2.0')]}

  it('machine at work → no download, no activation, busy outcome', async () => {
    fakeOpts = {current: '1.0.0', manifest, currentTarget: '/opt/a/releases/1.0.0'}
    idleHold = {held: false, reason: 'la macchina sta lavorando dalle 2026-09-23T10:00:00.000Z: aggiornamento rimandato'}

    const payload = (await run(TestUpdate, ['--install-root', '/opt/a', '--json'])) as UpdatePayload

    expect(payload.result?.outcome).toBe('busy')
    expect(payload.result?.reason).toContain('sta lavorando')
    expect(calls.download).toBe(0)
    expect(calls.activate).toEqual([])
    expect(calls.restart).toBe(0)
    expect(manifestFetches).toBe(0)
  })

  it('machine at work → the text says why and exit 0 (the timer will retry, it is not a failure)', async () => {
    fakeOpts = {current: '1.0.0', manifest, currentTarget: '/opt/a/releases/1.0.0'}
    idleHold = {held: false, reason: 'la macchina sta lavorando: aggiornamento rimandato'}

    const {stdout} = await runCaptured(TestUpdate, ['--install-root', '/opt/a'])

    expect(stdout).toContain('BUSY')
    expect(stdout).toContain('sta lavorando')
  })

  it('free machine → updates and releases the hold once the work is done', async () => {
    fakeOpts = {current: '1.0.0', manifest, currentTarget: '/opt/a/releases/1.0.0'}

    const payload = (await run(TestUpdate, ['--install-root', '/opt/a', '--json'])) as UpdatePayload

    expect(payload.result?.outcome).toBe('updated')
    expect(idleReleases).toBe(1)
  })

  it('failed update → the hold is released anyway', async () => {
    fakeOpts = {current: '1.0.0', manifest, currentTarget: '/opt/a/releases/1.0.0', checksum: 'TAMPERED'}

    await runExpectingExit(TestUpdate, ['--install-root', '/opt/a'], 1)

    expect(idleReleases).toBe(1)
  })

  it('--dry-run does not ask for the hold: it touches nothing and must not block a cycle', async () => {
    fakeOpts = {current: '1.0.0', manifest, currentTarget: '/opt/a/releases/1.0.0'}
    idleHold = {held: false, reason: 'la macchina sta lavorando'}

    const payload = (await run(TestUpdate, ['--install-root', '/opt/a', '--dry-run', '--json'])) as UpdatePayload

    expect(payload.selection?.decision).toBe('update')
    expect(payload.result).toBeUndefined()
  })

  it('--skip-service-preflight stays the recovery path: no restart, so no gate to pass', async () => {
    fakeOpts = {current: '1.0.0', manifest, currentTarget: '/opt/a/releases/1.0.0', serviceInstalled: false}
    idleHold = {held: false, reason: 'la macchina sta lavorando'}

    const payload = (await run(TestUpdate, ['--install-root', '/opt/a', '--skip-service-preflight', '--json'])) as UpdatePayload

    expect(payload.result?.outcome).toBe('updated')
    expect(calls.restart).toBe(0)
  })
})

// CYAU-202 — nobody reads the outcome on screen anymore: the update starts from a timer. A failure stays written and the
// beat carries it to CloseYourIt; a successful update clears the previous notice.
describe('update — the outcome stays written for CloseYourIt', () => {
  const manifest: ReleaseManifest = {channel: 'stable', releases: [entry('1.2.0')]}

  it('failed update → notice recorded with the missed version', async () => {
    fakeOpts = {current: '1.0.0', manifest, currentTarget: '/opt/a/releases/1.0.0', checksum: 'TAMPERED'}

    await runExpectingExit(TestUpdate, ['--install-root', '/opt/a'], 1)

    expect(readUpdateFailure()?.reason).toContain('1.2.0')
  })

  it('successful update → the previous notice disappears', async () => {
    fakeOpts = {current: '1.0.0', manifest, currentTarget: '/opt/a/releases/1.0.0', checksum: 'TAMPERED'}
    await runExpectingExit(TestUpdate, ['--install-root', '/opt/a'], 1)

    fakeOpts = {current: '1.0.0', manifest, currentTarget: '/opt/a/releases/1.0.0'}
    await run(TestUpdate, ['--install-root', '/opt/a', '--json'])

    expect(readUpdateFailure()).toBeNull()
  })

  it('busy machine → no notice: it is not a failed attempt', async () => {
    fakeOpts = {current: '1.0.0', manifest, currentTarget: '/opt/a/releases/1.0.0'}
    idleHold = {held: false, reason: 'la macchina sta lavorando'}

    await run(TestUpdate, ['--install-root', '/opt/a', '--json'])

    expect(readUpdateFailure()).toBeNull()
  })

  it('a rejecting service check still leaves the notice: the machine stays behind', async () => {
    fakeOpts = {current: '1.0.0', manifest, currentTarget: '/opt/a/releases/1.0.0'}

    await runExpectingExit(RejectingServiceInstalledUpdate, ['--install-root', '/opt/a'], 1)

    expect(readUpdateFailure()?.reason).toContain('non coincide')
  })
})

// CYAU-202 — the timer is created with `install --managed`, but the already installed machines do not have it: without this
// exactly the ones the ticket exists for would stay without automatic update. Every healthy update
// reconciles it, as it already does with the guardrails, reading the environment from the REAL daemon unit.
describe('update — reconciles the automatic update timer', () => {
  const manifest: ReleaseManifest = {channel: 'stable', releases: [entry('1.2.0')]}

  const managedUnit: ServiceRuntime = {
    kind: 'managed',
    platform: 'linux',
    installRoot: '/opt/a',
    nodePath: '/usr/bin/node',
    entrypoint: '/opt/a/current/bin/run.js',
    daemonArgs: ['daemon', '--playbook', '/home/automator/playbook.yml'],
    pathEnv: '/shims:/usr/bin',
    homeDir: '/home/automator',
    workingDir: '/home/automator',
    env: {AUTOMATOR_STATE_DIR: '/home/automator/.local/state/closeyourit-automator', AUTOMATOR_INSTALL_ROOT: '/opt/a'},
    configDir: '/home/automator/.config/closeyourit-automator',
    codexHome: '/home/automator/.codex',
  }

  it('successful update on managed unit → timer reconciled with the daemon environment', async () => {
    fakeOpts = {current: '1.0.0', manifest, currentTarget: '/opt/a/releases/1.0.0'}
    timerRuntime = managedUnit

    await run(TestUpdate, ['--install-root', '/opt/a', '--json'])

    expect(installedTimers).toHaveLength(1)
    expect(installedTimers[0].homeDir).toBe('/home/automator')
    expect(installedTimers[0].fields.entrypoint).toBe('/opt/a/current/bin/run.js')
    expect(installedTimers[0].fields.env.AUTOMATOR_STATE_DIR).toBe('/home/automator/.local/state/closeyourit-automator')
  })

  it('machine already on the latest version → the timer is installed anyway (the case of those missing only the timer)', async () => {
    fakeOpts = {current: '1.2.0', manifest, currentTarget: '/opt/a/releases/1.2.0'}
    timerRuntime = managedUnit

    await run(TestUpdate, ['--install-root', '/opt/a', '--json'])

    expect(installedTimers).toHaveLength(1)
  })

  it('legacy checkout unit → no timer: update does not update that code', async () => {
    fakeOpts = {current: '1.0.0', manifest, currentTarget: '/opt/a/releases/1.0.0'}
    timerRuntime = {...managedUnit, kind: 'legacy', installRoot: null}

    await run(TestUpdate, ['--install-root', '/opt/a', '--json'])

    expect(installedTimers).toEqual([])
  })

  it('no installed service (first bootstrap) → no timer', async () => {
    fakeOpts = {current: '1.0.0', manifest, currentTarget: '/opt/a/releases/1.0.0', serviceInstalled: false}
    timerRuntime = null

    await run(TestUpdate, ['--install-root', '/opt/a', '--json'])

    expect(installedTimers).toEqual([])
  })

  it('failed update → no timer touched', async () => {
    fakeOpts = {current: '1.0.0', manifest, currentTarget: '/opt/a/releases/1.0.0', checksum: 'TAMPERED'}
    timerRuntime = managedUnit

    await runExpectingExit(TestUpdate, ['--install-root', '/opt/a'], 1)

    expect(installedTimers).toEqual([])
  })

  it('--skip-service-preflight does not touch the service, so not the timer either', async () => {
    fakeOpts = {current: '1.0.0', manifest, currentTarget: '/opt/a/releases/1.0.0', serviceInstalled: false}
    timerRuntime = managedUnit

    await run(TestUpdate, ['--install-root', '/opt/a', '--skip-service-preflight', '--json'])

    expect(installedTimers).toEqual([])
  })

  it('a timer that does not turn on warns but does not overturn a successful update', async () => {
    fakeOpts = {current: '1.0.0', manifest, currentTarget: '/opt/a/releases/1.0.0'}
    timerRuntime = managedUnit

    class FailingTimerUpdate extends TestUpdate {
      protected installAutoUpdateTimer(): void {
        throw new Error('systemctl enable fallito')
      }
    }

    const payload = (await run(FailingTimerUpdate, ['--install-root', '/opt/a', '--json'])) as UpdatePayload

    expect(payload.result?.outcome).toBe('updated')
  })
})
