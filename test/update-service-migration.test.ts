import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import {afterEach, beforeEach, describe, expect, it} from 'vitest'
import Update from '../src/commands/update'
import {loadManagedServiceConfig} from '../src/lib/managed-service'
import {serviceMigrationJournalPath} from '../src/lib/service-migration'
import {
  quoteSystemdWord,
  renderSystemdUnit,
  serviceManager,
  type ExecFn,
  type ServiceManager,
  type ServiceRuntime,
} from '../src/lib/service'
import type {UpdateProbe} from '../src/lib/update'
import {testConfig} from './helpers/command'

let injectedManager: ServiceManager
const GUARDRAIL_ASSETS = path.resolve(__dirname, '..', 'assets', 'guardrails')

class MigrationUpdate extends Update {
  publicMakeProbe(installRoot: string): UpdateProbe {
    return this.makeProbe(installRoot, 'https://invalid.example/releases', true)
  }

  protected currentPlatform() {
    return 'linux' as const
  }

  protected makeServiceManager(): ServiceManager {
    return injectedManager
  }
}

interface Fixture {
  root: string
  home: string
  release1: string
  release2: string
  unitPath: string
  originalUnit: string
  originalMode: number
  manager: ServiceManager
  control: {
    failNextRestart: boolean
    liveRuntime: ServiceRuntime | null
    restarts: number
  }
}

function release(root: string, version: string): string {
  const directory = path.join(root, 'releases', version)
  const bin = path.join(directory, 'bin')
  fs.mkdirSync(bin, {recursive: true})
  fs.writeFileSync(
    path.join(bin, 'run.js'),
    `console.log('@bussolabs/closeyourit-automator/${version} test')\n`,
  )
  fs.cpSync(GUARDRAIL_ASSETS, path.join(directory, 'assets', 'guardrails'), {recursive: true})
  return directory
}

function prepareGuardrails(probe: UpdateProbe, target: string): void {
  probe.prepareService?.(target)
  probe.migrateGuardrails(target)
}

function loadedSystemd(runtime: ServiceRuntime): string {
  const command = [runtime.nodePath, runtime.entrypoint, ...runtime.daemonArgs]
    .map((argument) => quoteSystemdWord(argument))
    .join(' ')
  const environment = Object.entries({PATH: runtime.pathEnv, HOME: runtime.homeDir, ...runtime.env})
    .map(([key, value]) => quoteSystemdWord(`${key}=${value}`))
    .join(' ')
  return [
    `ExecStart={ path=${runtime.nodePath} ; argv[]=${command} ; ignore_errors=no ; start_time=[n/a] ; stop_time=[n/a] ; pid=0 ; code=(null) ; status=0/0 }`,
    `Environment=${environment}`,
    `WorkingDirectory=${runtime.workingDir}`,
    '',
  ].join('\n')
}

function fixture(): Fixture {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'automator-update-service-'))
  const root = path.join(base, 'managed')
  const home = path.join(base, 'home')
  const checkout = path.join(base, 'checkout')
  const configDir = path.join(base, 'config')
  const codexHome = path.join(base, 'codex')
  const workingDir = path.join(base, 'work')
  const playbook = path.join(workingDir, 'playbook.yml')
  fs.mkdirSync(path.join(checkout, 'bin'), {recursive: true})
  fs.mkdirSync(workingDir, {recursive: true})
  fs.mkdirSync(root, {recursive: true})
  const release1 = release(root, '1.0.0')
  const release2 = release(root, '2.0.0')
  fs.symlinkSync(release1, path.join(root, 'current'))

  let manager!: ServiceManager
  const control = {failNextRestart: false, liveRuntime: null as ServiceRuntime | null, restarts: 0}
  const exec: ExecFn = (_cmd, args) => {
    if (args.includes('ActiveState')) return {code: 0, stdout: 'ActiveState=active\nMainPID=42\n', stderr: ''}
    if (args.includes('ExecStart')) {
      const runtime = control.liveRuntime
      return runtime === null
        ? {code: 1, stdout: '', stderr: 'runtime non attestabile'}
        : {code: 0, stdout: loadedSystemd(runtime), stderr: ''}
    }
    if (args.includes('restart')) {
      control.restarts += 1
      if (control.failNextRestart) {
        control.failNextRestart = false
        return {code: 1, stdout: '', stderr: 'crash simulato prima del restart'}
      }
      control.liveRuntime = manager.runtime()
    }
    return {code: 0, stdout: '', stderr: ''}
  }
  manager = serviceManager('linux', exec, home)
  const originalUnit = renderSystemdUnit({
    description: 'legacy checkout',
    execStart: [process.execPath, path.join(checkout, 'bin', 'run.js'), 'daemon', '--playbook', playbook],
    workingDir,
    pathEnv: '/opt/mise/shims:/usr/bin',
    homeDir: home,
    env: {AUTOMATOR_CONFIG_DIR: configDir, AUTOMATOR_PLAYBOOK: playbook, CODEX_HOME: codexHome},
  })
  const unitPath = manager.unitPath()
  fs.mkdirSync(path.dirname(unitPath), {recursive: true})
  fs.writeFileSync(unitPath, originalUnit, {mode: 0o640})
  control.liveRuntime = manager.runtime()
  return {root, home, release1, release2, unitPath, originalUnit, originalMode: 0o640, manager, control}
}

describe('update --migrate-service — smoke transazionale su filesystem reale', () => {
  let state: Fixture

  beforeEach(() => {
    state = fixture()
    injectedManager = state.manager
  })

  afterEach(() => {
    fs.rmSync(path.dirname(state.root), {recursive: true, force: true})
  })

  it('migrates the legacy unit to the managed current, restarts and commits only after disk/live health', async () => {
    const command = new MigrationUpdate([], await testConfig())
    const probe = command.publicMakeProbe(state.root)

    expect(probe.serviceInstalled()).toBe(true)
    probe.activate(state.release2)
    prepareGuardrails(probe, state.release2)
    probe.restart()

    expect(state.manager.runtime()).toMatchObject({
      kind: 'managed',
      installRoot: state.root,
      entrypoint: path.join(state.root, 'current', 'bin', 'run.js'),
      nodePath: process.execPath,
    })
    expect(fs.existsSync(serviceMigrationJournalPath(state.root))).toBe(true)
    expect(probe.healthCheck('2.0.0')).toBe(true)
    // The health only attests: the journal stays available until runUpdate commits the transaction.
    expect(fs.existsSync(serviceMigrationJournalPath(state.root))).toBe(true)
    probe.commitService?.()
    expect(fs.existsSync(serviceMigrationJournalPath(state.root))).toBe(false)
    expect(loadManagedServiceConfig(state.root)).toMatchObject({nodePath: process.execPath})
    expect(fs.statSync(state.unitPath).mode & 0o777).toBe(0o600)
  })

  it('after the managed swap restores legacy unit, mode and metadata if current goes back to the previous release', async () => {
    const command = new MigrationUpdate([], await testConfig())
    const probe = command.publicMakeProbe(state.root)

    expect(probe.serviceInstalled()).toBe(true)
    probe.activate(state.release2)
    prepareGuardrails(probe, state.release2)
    probe.restart()
    probe.restore(state.release1)
    probe.restart()

    expect(probe.healthCheck('1.0.0')).toBe(true)
    expect(fs.existsSync(serviceMigrationJournalPath(state.root))).toBe(true)
    // runUpdate deletes the owned candidate release before finalizing the service journal. Simulate a crash
    // in that gap: the new instance must adopt the `restoring` journal even without the now removed target.
    fs.rmSync(state.release2, {recursive: true})
    const recovered = new MigrationUpdate([], await testConfig()).publicMakeProbe(state.root)
    expect(recovered.serviceInstalled()).toBe(true)
    expect(recovered.recoverService?.()).toBe(true)
    expect(fs.readFileSync(state.unitPath, 'utf8')).toBe(state.originalUnit)
    expect(fs.statSync(state.unitPath).mode & 0o777).toBe(state.originalMode)
    expect(loadManagedServiceConfig(state.root)).toBeNull()
    expect(fs.existsSync(serviceMigrationJournalPath(state.root))).toBe(false)
  })

  it('a no-op on the same release can restore and finalize legacy after a failed health', async () => {
    const probe = new MigrationUpdate([], await testConfig()).publicMakeProbe(state.root)
    expect(probe.serviceInstalled()).toBe(true)
    prepareGuardrails(probe, state.release1)
    probe.restart()
    expect(state.manager.runtime()?.kind).toBe('managed')
    expect(probe.healthCheck('9.9.9')).toBe(false)

    probe.rollbackService?.()
    probe.commitService?.()

    expect(state.manager.runtime()?.kind).toBe('legacy')
    expect(state.manager.loadedRuntime()?.kind).toBe('legacy')
    expect(fs.readFileSync(state.unitPath, 'utf8')).toBe(state.originalUnit)
    expect(fs.existsSync(serviceMigrationJournalPath(state.root))).toBe(false)
  })

  it('recovers phase applied with managed disk and still legacy live after a crash before the restart', async () => {
    const first = new MigrationUpdate([], await testConfig()).publicMakeProbe(state.root)
    expect(first.serviceInstalled()).toBe(true)
    first.activate(state.release2)
    prepareGuardrails(first, state.release2)
    state.control.failNextRestart = true
    expect(() => first.restart()).toThrow(/crash simulato/i)
    expect(state.manager.runtime()?.kind).toBe('managed')
    expect(state.manager.loadedRuntime()?.kind).toBe('legacy')

    const recovered = new MigrationUpdate([], await testConfig()).publicMakeProbe(state.root)
    expect(recovered.serviceInstalled()).toBe(true)
    recovered.restart()
    expect(recovered.healthCheck('2.0.0')).toBe(true)
    recovered.commitService?.()

    expect(state.manager.loadedRuntime()?.kind).toBe('managed')
    expect(fs.existsSync(serviceMigrationJournalPath(state.root))).toBe(false)
  })

  it('a pending journal with a missing unit fails closed before treating the service as not installed', async () => {
    const first = new MigrationUpdate([], await testConfig()).publicMakeProbe(state.root)
    expect(first.serviceInstalled()).toBe(true)
    first.activate(state.release2)
    prepareGuardrails(first, state.release2)
    first.restart()
    fs.rmSync(state.unitPath)

    const recovered = new MigrationUpdate([], await testConfig()).publicMakeProbe(state.root)
    expect(() => recovered.serviceInstalled()).toThrow()
    expect(fs.existsSync(serviceMigrationJournalPath(state.root))).toBe(true)
  })

  it('rollbackService forces the restart if the disk is already legacy but the live is still managed', async () => {
    const probe = new MigrationUpdate([], await testConfig()).publicMakeProbe(state.root)
    expect(probe.serviceInstalled()).toBe(true)
    probe.activate(state.release2)
    prepareGuardrails(probe, state.release2)
    probe.restart()
    probe.restore(state.release1)
    state.control.failNextRestart = true
    expect(() => probe.restart()).toThrow(/crash simulato/i)
    expect(state.manager.runtime()?.kind).toBe('legacy')
    expect(state.manager.loadedRuntime()?.kind).toBe('managed')
    const before = state.control.restarts

    probe.rollbackService?.()

    expect(state.control.restarts).toBe(before + 1)
    expect(state.manager.loadedRuntime()?.kind).toBe('legacy')
    expect(fs.existsSync(serviceMigrationJournalPath(state.root))).toBe(true)
    probe.commitService?.()
    expect(fs.existsSync(serviceMigrationJournalPath(state.root))).toBe(false)
  })

  it('bootstrap without previous restores legacy unit, metadata and guardrails after a failed health', async () => {
    const base = path.dirname(state.root)
    const guardrailsDir = path.join(base, 'config', 'guardrails')
    const hooksDir = path.join(guardrailsDir, 'hooks')
    const generationPath = path.join(guardrailsDir, 'generation.json')
    const settingsPath = path.join(guardrailsDir, 'settings.json')
    const originalHook = path.join(hooksDir, 'block-production.mjs')
    const rulesPath = path.join(base, 'codex', 'rules', 'closeyourit-automator.rules')
    fs.mkdirSync(hooksDir, {recursive: true})
    fs.writeFileSync(generationPath, 'legacy generation\n', {mode: 0o640})
    fs.writeFileSync(settingsPath, 'legacy settings\n', {mode: 0o604})
    fs.writeFileSync(originalHook, 'legacy hook\n', {mode: 0o644})

    const probe = new MigrationUpdate([], await testConfig()).publicMakeProbe(state.root)
    expect(probe.serviceInstalled()).toBe(true)
    probe.activate(state.release2)
    prepareGuardrails(probe, state.release2)
    expect(fs.readFileSync(settingsPath, 'utf8')).toContain(
      path.join(state.home, '.local', 'share', 'closeyourit-automator', 'worktrees'),
    )
    probe.restart()
    expect(probe.healthCheck('9.9.9')).toBe(false)

    fs.unlinkSync(path.join(state.root, 'current'))
    probe.rollbackService?.()
    expect(fs.existsSync(serviceMigrationJournalPath(state.root))).toBe(true)
    probe.commitService?.()

    expect(fs.readFileSync(state.unitPath, 'utf8')).toBe(state.originalUnit)
    expect(fs.statSync(state.unitPath).mode & 0o777).toBe(state.originalMode)
    expect(loadManagedServiceConfig(state.root)).toBeNull()
    expect(fs.readFileSync(generationPath, 'utf8')).toBe('legacy generation\n')
    expect(fs.statSync(generationPath).mode & 0o777).toBe(0o640)
    expect(fs.readFileSync(settingsPath, 'utf8')).toBe('legacy settings\n')
    expect(fs.statSync(settingsPath).mode & 0o777).toBe(0o604)
    expect(fs.readFileSync(originalHook, 'utf8')).toBe('legacy hook\n')
    expect(fs.statSync(originalHook).mode & 0o777).toBe(0o644)
    expect(fs.existsSync(path.join(hooksDir, 'block-destructive-db.mjs'))).toBe(false)
    expect(fs.existsSync(path.join(hooksDir, 'require-worktree.mjs'))).toBe(false)
    expect(fs.existsSync(path.join(hooksDir, 'guard-branch-push.mjs'))).toBe(false)
    expect(fs.existsSync(rulesPath)).toBe(false)
    expect(fs.existsSync(serviceMigrationJournalPath(state.root))).toBe(false)
  })
})
