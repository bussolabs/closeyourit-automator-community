import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import {afterEach, describe, expect, it, vi} from 'vitest'
import {managedServiceConfigPath, type ManagedServiceConfig} from '../src/lib/managed-service'
import {installGuardrails} from '../src/lib/guardrails'
import {
  ServiceMigration,
  loadServiceMigrationJournal,
  serviceMigrationJournalPath,
} from '../src/lib/service-migration'
import {type ServiceManager, type ServiceRuntime} from '../src/lib/service'

const roots: string[] = []
const GUARDRAIL_ASSETS = path.resolve(__dirname, '..', 'assets', 'guardrails')

function setup(): {
  root: string
  unit: string
  legacyBytes: string
  legacy: ServiceRuntime
  manager: ServiceManager
  restart: ReturnType<typeof vi.fn>
  config: ManagedServiceConfig
} {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'automator-service-migration-'))
  roots.push(root)
  const unit = path.join(root, 'legacy.service')
  const legacyBytes = '[Service]\nExecStart=legacy\n'
  fs.writeFileSync(unit, legacyBytes, {mode: 0o640})
  const homeDir = path.join(root, 'home user')
  const configDir = path.join(root, 'config dir')
  const codexHome = path.join(root, 'codex home')
  const legacy: ServiceRuntime = {
    kind: 'legacy',
    platform: 'linux',
    installRoot: null,
    nodePath: path.join(root, 'node path', 'node'),
    entrypoint: path.join(root, 'checkout old', 'bin', 'run.js'),
    daemonArgs: ['daemon', '--playbook', path.join(configDir, 'playbook 100%.yml'), '--interval', '30'],
    pathEnv: '/mise shims:/usr/bin',
    homeDir,
    workingDir: configDir,
    env: {
      AUTOMATOR_STATE_DIR: path.join(root, 'state dir'),
      AUTOMATOR_CONFIG_DIR: configDir,
      AUTOMATOR_PLAYBOOK: path.join(configDir, 'playbook 100%.yml'),
      CODEX_HOME: codexHome,
    },
    configDir,
    codexHome,
  }
  const restart = vi.fn()
  const manager = {
    unitPath: () => unit,
    logsPath: () => '/logs/automator.log',
    runtime: () => legacy,
    restart,
  } as unknown as ServiceManager
  const config: ManagedServiceConfig = {
    version: 1,
    nodePath: legacy.nodePath,
    codexHome: legacy.codexHome,
    guardrails: {
      hooksDir: path.join(configDir, 'guardrails', 'hooks'),
      settingsPath: path.join(configDir, 'guardrails', 'settings.json'),
      codexRulesPath: path.join(codexHome, 'rules', 'closeyourit-automator.rules'),
      worktreesRoot: path.join(homeDir, '.local', 'share', 'closeyourit-automator', 'worktrees'),
    },
  }
  return {root, unit, legacyBytes, legacy, manager, restart, config}
}

afterEach(() => {
  for (const root of roots.splice(0)) fs.rmSync(root, {recursive: true, force: true})
})

function releaseTarget(root: string): string {
  const target = path.join(root, 'releases', '1.2.3')
  fs.mkdirSync(target, {recursive: true})
  fs.cpSync(GUARDRAIL_ASSETS, path.join(target, 'assets', 'guardrails'), {recursive: true})
  return target
}

function rewriteJournal(root: string, mutate: (journal: Record<string, any>) => void): void {
  const file = serviceMigrationJournalPath(root)
  const journal = JSON.parse(fs.readFileSync(file, 'utf8')) as Record<string, any>
  mutate(journal)
  fs.writeFileSync(file, `${JSON.stringify(journal)}\n`, {mode: 0o600})
}

describe('service migration journal', () => {
  it('a missing or invalid journal content fails explicitly', () => {
    const absent = setup()
    expect(() => new ServiceMigration({installRoot: absent.root, manager: absent.manager}).apply())
      .toThrow(/journal migrazione servizio assente/i)

    const malformed = setup()
    fs.writeFileSync(serviceMigrationJournalPath(malformed.root), '{not-json')
    expect(() => loadServiceMigrationJournal(malformed.root)).toThrow(/journal migrazione servizio non valido/i)

    const notAFile = setup()
    fs.mkdirSync(serviceMigrationJournalPath(notAFile.root))
    expect(() => loadServiceMigrationJournal(notAFile.root)).toThrow(/non regolare/i)
  })

  it('migra systemd preservando argv/config e normalizzando mode, poi finalizza', () => {
    const ctx = setup()
    const target = releaseTarget(ctx.root)
    const migration = new ServiceMigration({installRoot: ctx.root, manager: ctx.manager, legacy: ctx.legacy, config: ctx.config})

    migration.prepare(target)
    expect(loadServiceMigrationJournal(ctx.root)).toMatchObject({phase: 'prepared', targetPath: fs.realpathSync(target)})
    installGuardrails(path.join(target, 'assets', 'guardrails'), {...ctx.config.guardrails, nodePath: ctx.config.nodePath})
    migration.apply()

    const migrated = fs.readFileSync(ctx.unit, 'utf8')
    expect(migrated).toContain(path.join(ctx.root, 'current', 'bin', 'run.js'))
    expect(migrated).toContain('playbook')
    expect(migrated).toContain('30')
    expect(migrated).toContain('100%%')
    expect(fs.statSync(ctx.unit).mode & 0o777).toBe(0o600)
    expect(fs.statSync(managedServiceConfigPath(ctx.root)).mode & 0o777).toBe(0o600)
    expect(ctx.restart).toHaveBeenCalledTimes(1)

    migration.finalizeManaged()
    expect(fs.existsSync(serviceMigrationJournalPath(ctx.root))).toBe(false)
    expect(fs.existsSync(path.join(ctx.root, '.service-migration'))).toBe(false)
  })

  it('rollback restores bytes, mode and missing metadata even after a new instance', () => {
    const ctx = setup()
    const target = releaseTarget(ctx.root)
    new ServiceMigration({installRoot: ctx.root, manager: ctx.manager, legacy: ctx.legacy, config: ctx.config}).prepare(target)
    new ServiceMigration({installRoot: ctx.root, manager: ctx.manager}).apply()

    const recovered = new ServiceMigration({installRoot: ctx.root, manager: ctx.manager})
    recovered.restoreLegacy()
    recovered.finalizeLegacy()

    expect(fs.readFileSync(ctx.unit, 'utf8')).toBe(ctx.legacyBytes)
    expect(fs.statSync(ctx.unit).mode & 0o777).toBe(0o640)
    expect(fs.existsSync(managedServiceConfigPath(ctx.root))).toBe(false)
    expect(fs.existsSync(serviceMigrationJournalPath(ctx.root))).toBe(false)
    expect(fs.existsSync(path.join(ctx.root, '.service-migration'))).toBe(false)
  })

  it('apply rejects a corrupt managedUnitSha256 before any swap or metadata', () => {
    const ctx = setup()
    const migration = new ServiceMigration({installRoot: ctx.root, manager: ctx.manager, legacy: ctx.legacy, config: ctx.config})
    migration.prepare(releaseTarget(ctx.root))
    rewriteJournal(ctx.root, (journal) => { journal.managedUnitSha256 = '0'.repeat(64) })

    expect(() => migration.apply()).toThrow(/hash|managed.*journal|integrità/i)
    expect(fs.readFileSync(ctx.unit, 'utf8')).toBe(ctx.legacyBytes)
    expect(fs.statSync(ctx.unit).mode & 0o777).toBe(0o640)
    expect(fs.existsSync(managedServiceConfigPath(ctx.root))).toBe(false)
    expect(ctx.restart).not.toHaveBeenCalled()
  })

  it('a structurally valid journal rejects semantically impossible runtimes', () => {
    const invalidMutations: Array<(journal: Record<string, any>) => void> = [
      (journal) => { journal.legacy.daemonArgs = ['daemon', '--playbook', 'relative.yml'] },
      (journal) => { journal.legacy.env.API_TOKEN = 'secret' },
      (journal) => { journal.legacy.env.AUTOMATOR_INSTALL_ROOT = journal.installRoot },
    ]

    for (const mutate of invalidMutations) {
      const ctx = setup()
      new ServiceMigration({installRoot: ctx.root, manager: ctx.manager, legacy: ctx.legacy, config: ctx.config})
        .prepare(releaseTarget(ctx.root))
      rewriteJournal(ctx.root, mutate)
      expect(() => loadServiceMigrationJournal(ctx.root)).toThrow(/runtime|journal.*non valido|semant/i)
    }
  })

  it('rejects a symlink and a unit replaced between classification and swap without overwriting it', () => {
    const symlink = setup()
    const real = path.join(symlink.root, 'real-unit')
    fs.renameSync(symlink.unit, real)
    fs.symlinkSync(real, symlink.unit)
    expect(() => new ServiceMigration({installRoot: symlink.root, manager: symlink.manager, legacy: symlink.legacy, config: symlink.config})
      .prepare(releaseTarget(symlink.root))).toThrow(/symlink|regolare/i)

    const changed = setup()
    const migration = new ServiceMigration({installRoot: changed.root, manager: changed.manager, legacy: changed.legacy, config: changed.config})
    migration.prepare(releaseTarget(changed.root))
    fs.rmSync(changed.unit)
    fs.writeFileSync(changed.unit, 'attacker replacement\n')

    expect(() => migration.apply()).toThrow(/cambiata|identità/i)
    expect(fs.readFileSync(changed.unit, 'utf8')).toBe('attacker replacement\n')
    expect(changed.restart).not.toHaveBeenCalled()

    const backupSymlink = setup()
    const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'automator-migration-outside-'))
    roots.push(outside)
    fs.symlinkSync(outside, path.join(backupSymlink.root, '.service-migration'))
    expect(() => new ServiceMigration({
      installRoot: backupSymlink.root, manager: backupSymlink.manager,
      legacy: backupSymlink.legacy, config: backupSymlink.config,
    }).prepare(releaseTarget(backupSymlink.root))).toThrow(/directory privata|backup fuori/i)
    expect(fs.readdirSync(outside)).toEqual([])
  })

  it('rejects a legacy unit reclassified or mutated before the backup', () => {
    const changedRuntime = setup()
    const otherLegacy = {...changedRuntime.legacy, nodePath: path.join(changedRuntime.root, 'other-node')}
    const otherManager = {...changedRuntime.manager, runtime: () => otherLegacy} as ServiceManager
    expect(() => new ServiceMigration({
      installRoot: changedRuntime.root, manager: otherManager,
      legacy: changedRuntime.legacy, config: changedRuntime.config,
    }).prepare(releaseTarget(changedRuntime.root))).toThrow(/cambiata.*classificazione/i)

    const changedBytes = setup()
    const mutatingManager = {
      ...changedBytes.manager,
      runtime: () => {
        fs.writeFileSync(changedBytes.unit, 'valid replacement observed too late\n')
        return changedBytes.legacy
      },
    } as ServiceManager
    expect(() => new ServiceMigration({
      installRoot: changedBytes.root, manager: mutatingManager,
      legacy: changedBytes.legacy, config: changedBytes.config,
    }).prepare(releaseTarget(changedBytes.root))).toThrow(/cambiata.*riclassificazione/i)
    expect(fs.readFileSync(changedBytes.unit, 'utf8')).toBe('valid replacement observed too late\n')
  })

  it('restore fails closed if the managed unit was modified after the swap', () => {
    const ctx = setup()
    const migration = new ServiceMigration({installRoot: ctx.root, manager: ctx.manager, legacy: ctx.legacy, config: ctx.config})
    migration.prepare(releaseTarget(ctx.root))
    migration.apply()
    fs.writeFileSync(ctx.unit, 'changed managed unit\n')

    expect(() => migration.restoreLegacy()).toThrow(/cambiata|identità/i)
    expect(fs.readFileSync(ctx.unit, 'utf8')).toBe('changed managed unit\n')
  })

  it('an existing journal rejects a different target instead of adopting it implicitly', () => {
    const ctx = setup()
    const migration = new ServiceMigration({installRoot: ctx.root, manager: ctx.manager, legacy: ctx.legacy, config: ctx.config})
    migration.prepare(releaseTarget(ctx.root))
    const other = path.join(ctx.root, 'releases', '2.0.0')
    fs.mkdirSync(other, {recursive: true})
    expect(() => migration.prepare(other)).toThrow(/target.*diverso|journal.*target/i)
  })

  it('an existing journal also stays bound to the original runtime and configuration', () => {
    const ctx = setup()
    const target = releaseTarget(ctx.root)
    new ServiceMigration({installRoot: ctx.root, manager: ctx.manager, legacy: ctx.legacy, config: ctx.config}).prepare(target)

    expect(() => new ServiceMigration({
      installRoot: ctx.root, manager: ctx.manager,
      legacy: {...ctx.legacy, nodePath: path.join(ctx.root, 'other-node')}, config: ctx.config,
    }).prepare(target)).toThrow(/runtime legacy diverso/i)
    expect(() => new ServiceMigration({
      installRoot: ctx.root, manager: ctx.manager, legacy: ctx.legacy,
      config: {...ctx.config, guardrails: {...ctx.config.guardrails, worktreesRoot: path.join(ctx.root, 'other-worktrees')}},
    }).prepare(target)).toThrow(/configurazione diversa/i)
  })

  it('prepare rejects incomplete context, symlink root and target outside releases', () => {
    const incomplete = setup()
    const target = releaseTarget(incomplete.root)
    expect(() => new ServiceMigration({installRoot: incomplete.root, manager: incomplete.manager}).prepare(target))
      .toThrow(/contesto legacy incompleto/i)
    expect(() => new ServiceMigration({installRoot: incomplete.root, manager: incomplete.manager, legacy: incomplete.legacy}).prepare(target))
      .toThrow(/contesto legacy incompleto/i)
    expect(() => new ServiceMigration({
      installRoot: incomplete.root, manager: incomplete.manager,
      legacy: {...incomplete.legacy, kind: 'managed', installRoot: incomplete.root}, config: incomplete.config,
    }).prepare(target)).toThrow(/contesto legacy incompleto/i)

    const linked = setup()
    const link = `${linked.root}-link`
    fs.symlinkSync(linked.root, link)
    expect(() => new ServiceMigration({installRoot: link, manager: linked.manager, legacy: linked.legacy, config: linked.config})
      .prepare(releaseTarget(linked.root))).toThrow(/installRoot symlink/i)
    fs.unlinkSync(link)

    const outside = setup()
    const outsideTarget = path.join(outside.root, 'outside')
    fs.mkdirSync(outsideTarget)
    expect(() => new ServiceMigration({
      installRoot: outside.root, manager: outside.manager, legacy: outside.legacy, config: outside.config,
    }).prepare(outsideTarget)).toThrow(/fuori.*releases/i)
  })

  it('apply is idempotent on the managed bytes and rejects a diverging mode', () => {
    const ctx = setup()
    const target = releaseTarget(ctx.root)
    const migration = new ServiceMigration({installRoot: ctx.root, manager: ctx.manager, legacy: ctx.legacy, config: ctx.config})
    migration.prepare(target)
    installGuardrails(path.join(target, 'assets', 'guardrails'), {...ctx.config.guardrails, nodePath: ctx.config.nodePath})
    migration.apply()
    expect(() => migration.apply()).not.toThrow()
    expect(ctx.restart).toHaveBeenCalledTimes(2)
    fs.chmodSync(ctx.unit, 0o644)
    expect(() => migration.apply()).toThrow(/mode inatteso/i)
  })

  it('finalizeManaged rejects unattested unit, metadata or guardrails', () => {
    const makeApplied = () => {
      const ctx = setup()
      const target = releaseTarget(ctx.root)
      const migration = new ServiceMigration({installRoot: ctx.root, manager: ctx.manager, legacy: ctx.legacy, config: ctx.config})
      migration.prepare(target)
      installGuardrails(path.join(target, 'assets', 'guardrails'), {...ctx.config.guardrails, nodePath: ctx.config.nodePath})
      migration.apply()
      return {ctx, migration}
    }

    const wrongMode = makeApplied()
    fs.chmodSync(wrongMode.ctx.unit, 0o644)
    expect(() => wrongMode.migration.finalizeManaged()).toThrow(/unit managed non verificata/i)

    const metadata = makeApplied()
    fs.writeFileSync(managedServiceConfigPath(metadata.ctx.root), '{}\n')
    expect(() => metadata.migration.finalizeManaged()).toThrow(/metadata managed non verificata/i)

    const guardrail = makeApplied()
    fs.writeFileSync(guardrail.ctx.config.guardrails.settingsPath, 'changed\n')
    expect(() => guardrail.migration.finalizeManaged()).toThrow(/guardrail managed non verificato/i)
  })

  it('restoring pre-existing metadata is idempotent after a post-restore crash', () => {
    const ctx = setup()
    fs.writeFileSync(managedServiceConfigPath(ctx.root), '{"legacy":true}\n', {mode: 0o640})
    const migration = new ServiceMigration({installRoot: ctx.root, manager: ctx.manager, legacy: ctx.legacy, config: ctx.config})
    migration.prepare(releaseTarget(ctx.root))
    migration.apply()
    migration.restoreLegacy()
    expect(() => migration.restoreLegacy()).not.toThrow()
    migration.finalizeLegacy()
    expect(fs.readFileSync(managedServiceConfigPath(ctx.root), 'utf8')).toBe('{"legacy":true}\n')
    expect(fs.statSync(managedServiceConfigPath(ctx.root)).mode & 0o777).toBe(0o640)
  })

  it('altered backups block the rollback before overwriting unit or metadata', () => {
    const unitBackup = setup()
    const migration = new ServiceMigration({installRoot: unitBackup.root, manager: unitBackup.manager, legacy: unitBackup.legacy, config: unitBackup.config})
    migration.prepare(releaseTarget(unitBackup.root))
    migration.apply()
    const managedUnit = fs.readFileSync(unitBackup.unit, 'utf8')
    const journal = migration.journal()!
    fs.writeFileSync(journal.unitBackupPath, 'tampered backup\n')
    expect(() => migration.restoreLegacy()).toThrow(/backup.*verific|alterato/i)
    expect(fs.readFileSync(unitBackup.unit, 'utf8')).toBe(managedUnit)

    const metadataBackup = setup()
    fs.writeFileSync(managedServiceConfigPath(metadataBackup.root), '{"legacy":true}\n')
    const second = new ServiceMigration({installRoot: metadataBackup.root, manager: metadataBackup.manager, legacy: metadataBackup.legacy, config: metadataBackup.config})
    second.prepare(releaseTarget(metadataBackup.root))
    second.apply()
    const secondManaged = fs.readFileSync(metadataBackup.unit, 'utf8')
    const secondJournal = second.journal()!
    fs.writeFileSync(secondJournal.metadata.backupPath!, 'tampered metadata backup\n')
    expect(() => second.restoreLegacy()).toThrow(/backup.*verific|alterato/i)
    expect(fs.readFileSync(metadataBackup.unit, 'utf8')).toBe(secondManaged)
  })

  it('re-attests the backup bytes after the precheck and before every restore', () => {
    const unit = setup()
    const unitMigration = new ServiceMigration({installRoot: unit.root, manager: unit.manager, legacy: unit.legacy, config: unit.config})
    const unitTarget = releaseTarget(unit.root)
    unitMigration.prepare(unitTarget)
    installGuardrails(path.join(unitTarget, 'assets', 'guardrails'), {...unit.config.guardrails, nodePath: unit.config.nodePath})
    unitMigration.apply()
    const managedUnit = fs.readFileSync(unit.unit, 'utf8')
    const unitJournal = unitMigration.journal()!
    const unitPrivate = unitMigration as unknown as {
      verifyGuardrailRestoreInputs(journal: object): void
    }
    const verifyGuardrails = unitPrivate.verifyGuardrailRestoreInputs.bind(unitMigration)
    unitPrivate.verifyGuardrailRestoreInputs = (journal) => {
      verifyGuardrails(journal)
      fs.writeFileSync(unitJournal.unitBackupPath, 'mutazione dopo precheck\n')
    }
    expect(() => unitMigration.restoreLegacy()).toThrow(/backup.*alterato|verificabile/i)
    expect(fs.readFileSync(unit.unit, 'utf8')).toBe(managedUnit)

    const guardrail = setup()
    const generation = path.join(path.dirname(guardrail.config.guardrails.settingsPath), 'generation.json')
    fs.mkdirSync(path.dirname(generation), {recursive: true})
    fs.writeFileSync(generation, 'legacy generation\n')
    const guardrailMigration = new ServiceMigration({
      installRoot: guardrail.root, manager: guardrail.manager, legacy: guardrail.legacy, config: guardrail.config,
    })
    const guardrailTarget = releaseTarget(guardrail.root)
    guardrailMigration.prepare(guardrailTarget)
    installGuardrails(path.join(guardrailTarget, 'assets', 'guardrails'), {...guardrail.config.guardrails, nodePath: guardrail.config.nodePath})
    guardrailMigration.apply()
    const guardrailJournal = guardrailMigration.journal()!
    const generationSnapshot = guardrailJournal.guardrails.find((snapshot) => snapshot.path === generation)!
    const managedGeneration = fs.readFileSync(generation, 'utf8')
    const guardrailPrivate = guardrailMigration as unknown as {
      verifyBackups(journal: object): void
      restoreGuardrails(journal: object): void
    }
    guardrailPrivate.verifyBackups(guardrailJournal)
    fs.writeFileSync(generationSnapshot.backupPath!, 'mutazione dopo precheck\n')
    expect(() => guardrailPrivate.restoreGuardrails(guardrailJournal)).toThrow(/backup.*alterato|verificabile/i)
    expect(fs.readFileSync(generation, 'utf8')).toBe(managedGeneration)

    const metadata = setup()
    const metadataPath = managedServiceConfigPath(metadata.root)
    fs.writeFileSync(metadataPath, '{"legacy":true}\n')
    const metadataMigration = new ServiceMigration({
      installRoot: metadata.root, manager: metadata.manager, legacy: metadata.legacy, config: metadata.config,
    })
    metadataMigration.prepare(releaseTarget(metadata.root))
    metadataMigration.apply()
    const metadataJournal = metadataMigration.journal()!
    const managedMetadata = fs.readFileSync(metadataPath, 'utf8')
    const metadataPrivate = metadataMigration as unknown as {
      verifyBackups(journal: object): void
      restoreMetadata(journal: object): void
    }
    metadataPrivate.verifyBackups(metadataJournal)
    fs.writeFileSync(metadataJournal.metadata.backupPath!, 'mutazione dopo precheck\n')
    expect(() => metadataPrivate.restoreMetadata(metadataJournal)).toThrow(/backup.*alterato|verificabile/i)
    expect(fs.readFileSync(metadataPath, 'utf8')).toBe(managedMetadata)
  })

  it('verifies all legacy destinations before restarting', () => {
    const ctx = setup()
    const generation = path.join(path.dirname(ctx.config.guardrails.settingsPath), 'generation.json')
    fs.mkdirSync(path.dirname(generation), {recursive: true})
    fs.writeFileSync(generation, 'legacy generation\n')
    const migration = new ServiceMigration({installRoot: ctx.root, manager: ctx.manager, legacy: ctx.legacy, config: ctx.config})
    const target = releaseTarget(ctx.root)
    migration.prepare(target)
    installGuardrails(path.join(target, 'assets', 'guardrails'), {...ctx.config.guardrails, nodePath: ctx.config.nodePath})
    migration.apply()
    const privateMigration = migration as unknown as {restoreGuardrails(journal: object): void}
    const restoreGuardrails = privateMigration.restoreGuardrails.bind(migration)
    privateMigration.restoreGuardrails = (journal) => {
      restoreGuardrails(journal)
      fs.writeFileSync(generation, 'mutazione dopo restore\n')
    }

    expect(() => migration.restoreLegacy()).toThrow(/guardrail legacy non ripristinato/i)
    expect(ctx.restart).toHaveBeenCalledTimes(1)
  })

  it('rejects guardrail symlinks during preparation and foreign mutations before the restore', () => {
    const symlink = setup()
    fs.mkdirSync(path.dirname(symlink.config.guardrails.settingsPath), {recursive: true})
    const victim = path.join(symlink.root, 'victim-settings')
    fs.writeFileSync(victim, 'victim\n')
    fs.symlinkSync(victim, symlink.config.guardrails.settingsPath)
    expect(() => new ServiceMigration({
      installRoot: symlink.root, manager: symlink.manager, legacy: symlink.legacy, config: symlink.config,
    }).prepare(releaseTarget(symlink.root))).toThrow(/symlink|regolare/i)
    expect(fs.readFileSync(victim, 'utf8')).toBe('victim\n')

    const changed = setup()
    const target = releaseTarget(changed.root)
    const migration = new ServiceMigration({
      installRoot: changed.root, manager: changed.manager, legacy: changed.legacy, config: changed.config,
    })
    migration.prepare(target)
    installGuardrails(path.join(target, 'assets', 'guardrails'), {...changed.config.guardrails, nodePath: changed.config.nodePath})
    migration.apply()
    const managedUnit = fs.readFileSync(changed.unit, 'utf8')
    fs.writeFileSync(changed.config.guardrails.settingsPath, 'external mutation\n')

    expect(() => migration.restoreLegacy()).toThrow(/guardrail cambiato/i)
    expect(fs.readFileSync(changed.unit, 'utf8')).toBe(managedUnit)
  })

  it('restoreGuardrails does not overwrite a foreign mutation that appeared after the precheck', () => {
    const ctx = setup()
    const generation = path.join(path.dirname(ctx.config.guardrails.settingsPath), 'generation.json')
    fs.mkdirSync(path.dirname(generation), {recursive: true})
    fs.writeFileSync(generation, 'legacy generation\n')
    const target = releaseTarget(ctx.root)
    const migration = new ServiceMigration({installRoot: ctx.root, manager: ctx.manager, legacy: ctx.legacy, config: ctx.config})
    migration.prepare(target)
    installGuardrails(path.join(target, 'assets', 'guardrails'), {...ctx.config.guardrails, nodePath: ctx.config.nodePath})
    migration.apply()
    fs.writeFileSync(generation, 'external mutation after precheck\n')

    const privateMigration = migration as unknown as {restoreGuardrails(journal: object): void}
    expect(() => privateMigration.restoreGuardrails(migration.journal()!)).toThrow(/guardrail cambiato/i)
    expect(fs.readFileSync(generation, 'utf8')).toBe('external mutation after precheck\n')
  })

  it('clear removes only the root created by the transaction and preserves pre-existing or foreign directories', () => {
    const preexisting = setup()
    const preexistingRoot = path.join(preexisting.root, '.service-migration')
    fs.mkdirSync(preexistingRoot)
    const firstTarget = releaseTarget(preexisting.root)
    const first = new ServiceMigration({installRoot: preexisting.root, manager: preexisting.manager, legacy: preexisting.legacy, config: preexisting.config})
    first.prepare(firstTarget)
    installGuardrails(path.join(firstTarget, 'assets', 'guardrails'), {...preexisting.config.guardrails, nodePath: preexisting.config.nodePath})
    first.apply()
    first.finalizeManaged()
    expect(fs.existsSync(preexistingRoot)).toBe(true)
    expect(fs.readdirSync(preexistingRoot)).toEqual([])

    const foreign = setup()
    const foreignRoot = path.join(foreign.root, '.service-migration')
    const secondTarget = releaseTarget(foreign.root)
    const second = new ServiceMigration({installRoot: foreign.root, manager: foreign.manager, legacy: foreign.legacy, config: foreign.config})
    second.prepare(secondTarget)
    fs.writeFileSync(path.join(foreignRoot, 'foreign.keep'), 'preserve\n')
    installGuardrails(path.join(secondTarget, 'assets', 'guardrails'), {...foreign.config.guardrails, nodePath: foreign.config.nodePath})
    second.apply()
    second.finalizeManaged()
    expect(fs.readFileSync(path.join(foreignRoot, 'foreign.keep'), 'utf8')).toBe('preserve\n')

    const replaced = setup()
    const replacedRoot = path.join(replaced.root, '.service-migration')
    const replacedTarget = releaseTarget(replaced.root)
    const third = new ServiceMigration({installRoot: replaced.root, manager: replaced.manager, legacy: replaced.legacy, config: replaced.config})
    const replacedJournal = third.prepare(replacedTarget)
    installGuardrails(path.join(replacedTarget, 'assets', 'guardrails'), {...replaced.config.guardrails, nodePath: replaced.config.nodePath})
    third.apply()
    const originalRoot = `${replacedRoot}.original`
    fs.renameSync(replacedRoot, originalRoot)
    fs.mkdirSync(replacedRoot)
    fs.cpSync(path.join(originalRoot, replacedJournal.transactionId), path.join(replacedRoot, replacedJournal.transactionId), {recursive: true})
    expect(() => third.finalizeManaged()).toThrow(/identità.*directory|root.*cambiat|backup.*confinement/i)
    expect(fs.existsSync(replacedRoot)).toBe(true)
  })

  it('clear rejects a backup directory replaced before the commit and does not delete its data', () => {
    const ctx = setup()
    const target = releaseTarget(ctx.root)
    const migration = new ServiceMigration({installRoot: ctx.root, manager: ctx.manager, legacy: ctx.legacy, config: ctx.config})
    const journal = migration.prepare(target)
    installGuardrails(path.join(target, 'assets', 'guardrails'), {...ctx.config.guardrails, nodePath: ctx.config.nodePath})
    migration.apply()
    const backupRoot = path.dirname(journal.unitBackupPath)
    fs.renameSync(backupRoot, `${backupRoot}.owned`)
    fs.mkdirSync(backupRoot)
    fs.writeFileSync(path.join(backupRoot, 'foreign.keep'), 'non cancellare\n')

    const privateMigration = migration as unknown as {clear(value: object): void}
    expect(() => privateMigration.clear(migration.journal()!)).toThrow(/identità directory backup.*cambiata/i)
    const quarantines = fs.readdirSync(ctx.root).filter((entry) => entry.startsWith('.service-migration-cleanup-'))
    expect(quarantines).toHaveLength(0)
    expect(fs.readFileSync(path.join(backupRoot, 'foreign.keep'), 'utf8')).toBe('non cancellare\n')
    expect(fs.existsSync(serviceMigrationJournalPath(ctx.root))).toBe(true)
  })

  it('a crash in the cleanup after the commit does not leave a journal blocking the recovery', () => {
    class CleanupCrashMigration extends ServiceMigration {
      protected override cleanupCommitted(): void {
        throw new Error('crash simulato dopo cleanup commit')
      }
    }
    const ctx = setup()
    const target = releaseTarget(ctx.root)
    const migration = new CleanupCrashMigration({installRoot: ctx.root, manager: ctx.manager, legacy: ctx.legacy, config: ctx.config})
    const journal = migration.prepare(target)
    installGuardrails(path.join(target, 'assets', 'guardrails'), {...ctx.config.guardrails, nodePath: ctx.config.nodePath})
    migration.apply()
    const backupRoot = path.dirname(journal.unitBackupPath)
    const privateMigration = migration as unknown as {clear(value: object): void}
    expect(() => privateMigration.clear(migration.journal()!)).toThrow(/crash simulato/i)

    expect(fs.existsSync(backupRoot)).toBe(true)
    expect(fs.existsSync(serviceMigrationJournalPath(ctx.root))).toBe(false)
    expect(new ServiceMigration({installRoot: ctx.root, manager: ctx.manager}).journal()).toBeNull()
  })

  it('finalizeLegacy rejects metadata/guardrail leftovers and mutated legacy guardrails', () => {
    const restored = (ctx: ReturnType<typeof setup>, preinstall = false) => {
      const target = releaseTarget(ctx.root)
      if (preinstall) installGuardrails(GUARDRAIL_ASSETS, {...ctx.config.guardrails, nodePath: ctx.config.nodePath})
      const migration = new ServiceMigration({installRoot: ctx.root, manager: ctx.manager, legacy: ctx.legacy, config: ctx.config})
      migration.prepare(target)
      installGuardrails(path.join(target, 'assets', 'guardrails'), {...ctx.config.guardrails, nodePath: ctx.config.nodePath})
      migration.apply()
      migration.restoreLegacy()
      return migration
    }

    const metadata = setup()
    const metadataMigration = restored(metadata)
    fs.writeFileSync(managedServiceConfigPath(metadata.root), '{}\n')
    expect(() => metadataMigration.finalizeLegacy()).toThrow(/metadata managed residua/i)

    const residual = setup()
    const residualMigration = restored(residual)
    fs.mkdirSync(path.dirname(residual.config.guardrails.settingsPath), {recursive: true})
    fs.writeFileSync(residual.config.guardrails.settingsPath, 'residual\n')
    expect(() => residualMigration.finalizeLegacy()).toThrow(/guardrail managed residuo/i)

    const changed = setup()
    const changedMigration = restored(changed, true)
    fs.writeFileSync(changed.config.guardrails.settingsPath, 'changed after restore\n')
    expect(() => changedMigration.finalizeLegacy()).toThrow(/guardrail legacy non ripristinato/i)
  })
})
