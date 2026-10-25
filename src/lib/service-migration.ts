import {createHash, randomUUID} from 'node:crypto'
import * as fs from 'node:fs'
import * as path from 'node:path'
import {z} from 'zod'
import {GUARDRAIL_HOOKS, planGuardrailFiles, type PlannedGuardrailFile} from './guardrails'
import {managedServiceConfigPath, saveManagedServiceConfig, type ManagedServiceConfig} from './managed-service'
import {
  isServiceRuntimeSemanticallyValid,
  renderSystemdUnit,
  type ServiceManager,
  type ServiceRuntime,
} from './service'

const AbsolutePath = z.string().refine(path.isAbsolute, 'path assoluto richiesto')
const FileIdentitySchema = z.object({
  dev: z.number().int().nonnegative(),
  ino: z.number().int().nonnegative(),
  mode: z.number().int().nonnegative(),
  size: z.number().int().nonnegative(),
  sha256: z.string().regex(/^[a-f0-9]{64}$/),
}).strict()
type FileIdentity = z.infer<typeof FileIdentitySchema>

const DirectoryIdentitySchema = z.object({
  dev: z.number().int().nonnegative(),
  ino: z.number().int().nonnegative(),
}).strict()
type DirectoryIdentity = z.infer<typeof DirectoryIdentitySchema>

const RuntimeSchema = z.object({
  kind: z.literal('legacy'),
  platform: z.literal('linux'),
  installRoot: z.null(),
  nodePath: AbsolutePath,
  entrypoint: AbsolutePath,
  daemonArgs: z.array(z.string()),
  pathEnv: z.string(),
  homeDir: AbsolutePath,
  workingDir: AbsolutePath,
  env: z.record(z.string()),
  configDir: AbsolutePath,
  codexHome: AbsolutePath,
}).strict().refine(isServiceRuntimeSemanticallyValid, 'runtime servizio semanticamente non valido')

const MANAGED_UNIT_MODE = 0o600

const ConfigSchema = z.object({
  version: z.literal(1),
  codexHome: AbsolutePath,
  nodePath: AbsolutePath,
  guardrails: z.object({
    hooksDir: AbsolutePath,
    settingsPath: AbsolutePath,
    codexRulesPath: AbsolutePath,
    worktreesRoot: AbsolutePath,
  }).strict(),
}).strict()

const MetadataSnapshotSchema = z.object({
  existed: z.boolean(),
  identity: FileIdentitySchema.nullable(),
  backupPath: AbsolutePath.nullable(),
  managedSha256: z.string().regex(/^[a-f0-9]{64}$/).nullable(),
}).strict()

const GuardrailSnapshotSchema = z.object({
  path: AbsolutePath,
  existed: z.boolean(),
  identity: FileIdentitySchema.nullable(),
  backupPath: AbsolutePath.nullable(),
  managedSha256: z.string().regex(/^[a-f0-9]{64}$/),
  allowedManagedSha256: z.array(z.string().regex(/^[a-f0-9]{64}$/)).min(1),
}).strict()

export const ServiceMigrationJournalSchema = z.object({
  version: z.literal(1),
  transactionId: z.string().uuid(),
  migrationsRootCreated: z.boolean(),
  migrationsRootIdentity: DirectoryIdentitySchema,
  backupRootIdentity: DirectoryIdentitySchema,
  phase: z.enum(['prepared', 'applied', 'restoring']),
  installRoot: AbsolutePath,
  canonicalInstallRoot: AbsolutePath,
  unitPath: AbsolutePath,
  canonicalUnitPath: AbsolutePath,
  unitIdentity: FileIdentitySchema,
  unitBackupPath: AbsolutePath,
  managedUnitSha256: z.string().regex(/^[a-f0-9]{64}$/),
  managedUnitIdentity: FileIdentitySchema.nullable(),
  targetPath: AbsolutePath,
  legacy: RuntimeSchema,
  config: ConfigSchema,
  metadata: MetadataSnapshotSchema,
  guardrails: z.array(GuardrailSnapshotSchema).min(1),
}).strict()

export type ServiceMigrationJournal = z.infer<typeof ServiceMigrationJournalSchema>

export function serviceMigrationJournalPath(installRoot: string): string {
  return path.join(path.resolve(installRoot), '.service-migration.json')
}

function sha256(content: Buffer | string): string {
  return createHash('sha256').update(content).digest('hex')
}

function fsyncDirectory(directory: string): void {
  const descriptor = fs.openSync(directory, 'r')
  try {
    fs.fsyncSync(descriptor)
  } finally {
    fs.closeSync(descriptor)
  }
}

function ensurePrivateDirectory(directory: string): void {
  try {
    const stat = fs.lstatSync(directory)
    if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error(`directory privata non regolare: ${directory}`)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
    fs.mkdirSync(directory, {mode: 0o700})
    fsyncDirectory(path.dirname(directory))
  }
  fs.chmodSync(directory, 0o700)
}

function directoryIdentity(directory: string): DirectoryIdentity {
  const stat = fs.lstatSync(directory)
  if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error(`directory privata non regolare: ${directory}`)
  return {dev: stat.dev, ino: stat.ino}
}

function sameDirectoryIdentity(actual: DirectoryIdentity, expected: DirectoryIdentity): boolean {
  return actual.dev === expected.dev && actual.ino === expected.ino
}

function ensureMigrationRoot(directory: string): {created: boolean; identity: DirectoryIdentity} {
  let created = false
  try {
    fs.mkdirSync(directory, {mode: 0o700})
    created = true
    fsyncDirectory(path.dirname(directory))
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
  }
  const identity = directoryIdentity(directory)
  fs.chmodSync(directory, 0o700)
  if (!sameDirectoryIdentity(directoryIdentity(directory), identity)) {
    throw new Error(`identità directory privata cambiata: ${directory}`)
  }
  return {created, identity}
}

function quarantineDirectory(
  directory: string,
  expected: DirectoryIdentity,
  installRoot: string,
  label: string,
): string {
  const quarantine = path.join(installRoot, `.service-migration-cleanup-${randomUUID()}`)
  fs.renameSync(directory, quarantine)
  fsyncDirectory(installRoot)
  if (!sameDirectoryIdentity(directoryIdentity(quarantine), expected)) {
    throw new Error(`${label} sostituita durante il cleanup; preservata in quarantena: ${quarantine}`)
  }
  return quarantine
}

function restoreQuarantinedDirectory(quarantine: string, destination: string): void {
  try {
    fs.lstatSync(destination)
    throw new Error(`destinazione ricreata durante il cleanup; quarantena preservata: ${quarantine}`)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
  }
  fs.renameSync(quarantine, destination)
  fsyncDirectory(path.dirname(destination))
}

function regularIdentity(file: string): FileIdentity {
  const stat = fs.lstatSync(file)
  if (!stat.isFile() || stat.isSymbolicLink()) throw new Error(`file non regolare o symlink: ${file}`)
  const content = fs.readFileSync(file)
  return {dev: stat.dev, ino: stat.ino, mode: stat.mode & 0o777, size: stat.size, sha256: sha256(content)}
}

function sameIdentity(actual: FileIdentity, expected: FileIdentity): boolean {
  return actual.dev === expected.dev && actual.ino === expected.ino && actual.mode === expected.mode &&
    actual.size === expected.size && actual.sha256 === expected.sha256
}

function atomicWrite(file: string, content: Buffer | string, mode: number): void {
  const directory = path.dirname(file)
  fs.mkdirSync(directory, {recursive: true})
  const temporary = path.join(directory, `.${path.basename(file)}.${process.pid}.${randomUUID()}.tmp`)
  let descriptor: number | null = null
  try {
    descriptor = fs.openSync(temporary, 'wx', mode)
    fs.writeFileSync(descriptor, content)
    fs.fchmodSync(descriptor, mode)
    fs.fsyncSync(descriptor)
    fs.closeSync(descriptor)
    descriptor = null
    fs.renameSync(temporary, file)
    fsyncDirectory(directory)
  } finally {
    if (descriptor !== null) fs.closeSync(descriptor)
    fs.rmSync(temporary, {force: true})
  }
}

function atomicReplaceChecked(file: string, content: Buffer | string, mode: number, expected: FileIdentity): void {
  const before = regularIdentity(file)
  if (!sameIdentity(before, expected)) throw new Error('unit cambiata: identità disk diversa dalla classificazione')
  const directory = path.dirname(file)
  const temporary = path.join(directory, `.${path.basename(file)}.${process.pid}.${randomUUID()}.migration`)
  let descriptor: number | null = null
  try {
    descriptor = fs.openSync(temporary, 'wx', mode)
    fs.writeFileSync(descriptor, content)
    fs.fchmodSync(descriptor, mode)
    fs.fsyncSync(descriptor)
    fs.closeSync(descriptor)
    descriptor = null
    // Second attestation immediately before the swap: no symlink is followed.
    if (!sameIdentity(regularIdentity(file), expected)) throw new Error('unit cambiata durante lo swap')
    fs.renameSync(temporary, file)
    fsyncDirectory(directory)
  } finally {
    if (descriptor !== null) fs.closeSync(descriptor)
    fs.rmSync(temporary, {force: true})
  }
}

function writeJournal(journal: ServiceMigrationJournal): void {
  const parsed = ServiceMigrationJournalSchema.parse(journal)
  atomicWrite(serviceMigrationJournalPath(parsed.installRoot), `${JSON.stringify(parsed)}\n`, 0o600)
}

export function loadServiceMigrationJournal(installRoot: string): ServiceMigrationJournal | null {
  const file = serviceMigrationJournalPath(installRoot)
  try {
    const stat = fs.lstatSync(file)
    if (!stat.isFile() || stat.isSymbolicLink()) throw new Error('journal migrazione servizio non regolare')
    return ServiceMigrationJournalSchema.parse(JSON.parse(fs.readFileSync(file, 'utf8')))
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null
    const detail = error instanceof Error ? error.message : String(error)
    throw new Error(`journal migrazione servizio non valido: ${detail}`)
  }
}

function migratedUnit(runtime: ServiceRuntime, installRoot: string): string {
  if (runtime.kind !== 'legacy') throw new Error('runtime legacy richiesto')
  const entrypoint = path.join(installRoot, 'current', 'bin', 'run.js')
  const env = {...runtime.env, AUTOMATOR_INSTALL_ROOT: installRoot}
  return renderSystemdUnit({
    description: 'CloseYourIt automator daemon',
    execStart: [runtime.nodePath, entrypoint, ...runtime.daemonArgs],
    workingDir: runtime.workingDir,
    pathEnv: runtime.pathEnv,
    homeDir: runtime.homeDir,
    env,
  })
}

function assertConfinedTarget(canonicalRoot: string, targetPath: string): string {
  const canonicalTarget = fs.realpathSync(targetPath)
  const releasesRoot = path.join(canonicalRoot, 'releases')
  if (path.dirname(canonicalTarget) !== releasesRoot) throw new Error('target servizio fuori dal layout releases canonico')
  return canonicalTarget
}

function backupFile(source: string, destination: string): FileIdentity {
  const identity = regularIdentity(source)
  atomicWrite(destination, fs.readFileSync(source), 0o600)
  if (regularIdentity(destination).sha256 !== identity.sha256) throw new Error('backup non verificabile')
  return identity
}

function verifiedBackupContent(file: string, expectedSha256: string, label: string): Buffer {
  const before = regularIdentity(file)
  const content = fs.readFileSync(file)
  const after = regularIdentity(file)
  if (
    before.sha256 !== expectedSha256 || sha256(content) !== expectedSha256 ||
    after.sha256 !== expectedSha256 || !sameIdentity(after, before)
  ) {
    throw new Error(`backup ${label} alterato o non verificabile`)
  }
  return content
}

function assertConfigMatchesLegacy(runtime: ServiceRuntime, config: ManagedServiceConfig): void {
  const expected = {
    hooksDir: path.join(runtime.configDir, 'guardrails', 'hooks'),
    settingsPath: path.join(runtime.configDir, 'guardrails', 'settings.json'),
    codexRulesPath: path.join(runtime.codexHome, 'rules', 'closeyourit-automator.rules'),
    worktreesRoot: path.join(runtime.homeDir, '.local', 'share', 'closeyourit-automator', 'worktrees'),
  }
  if (
    config.nodePath !== runtime.nodePath || config.codexHome !== runtime.codexHome ||
    Object.entries(expected).some(([key, value]) => config.guardrails[key as keyof typeof expected] !== value)
  ) throw new Error('configurazione migrazione non coerente con il runtime legacy')
}

function guardrailPlan(targetPath: string, runtime: ServiceRuntime, config: ManagedServiceConfig): PlannedGuardrailFile[] {
  assertConfigMatchesLegacy(runtime, config)
  return planGuardrailFiles(path.join(targetPath, 'assets', 'guardrails'), {
    ...config.guardrails,
    nodePath: config.nodePath,
  })
}

export interface ServiceMigrationOptions {
  installRoot: string
  manager: ServiceManager
  legacy?: ServiceRuntime
  config?: ManagedServiceConfig
}

export class ServiceMigration {
  private readonly installRoot: string
  private readonly manager: ServiceManager
  private readonly legacy?: ServiceRuntime
  private readonly config?: ManagedServiceConfig

  constructor(options: ServiceMigrationOptions) {
    this.installRoot = path.resolve(options.installRoot)
    this.manager = options.manager
    this.legacy = options.legacy
    this.config = options.config
  }

  journal(): ServiceMigrationJournal | null {
    return loadServiceMigrationJournal(this.installRoot)
  }

  /** Protected seam for deterministic fault injection at the cleanup commit point. */
  protected cleanupCommitted(): void {}

  /** Checks confinement and backups before the caller uses the journal's legacy/config for other writes. */
  attestedJournal(requireTarget?: boolean): ServiceMigrationJournal | null {
    const journal = this.journal()
    if (journal === null) return null
    // `restoring` is persisted before touching the unit: after the verified rollback the updater may delete the
    // candidate release and crash before finalizing this journal. A new instance must be able to resume
    // by attesting all the remaining backups/paths without dereferencing the now intentionally missing target.
    this.assertJournalPaths(journal, requireTarget ?? journal.phase !== 'restoring')
    this.verifyBackups(journal)
    return journal
  }

  prepare(targetPath: string): ServiceMigrationJournal {
    const existing = this.journal()
    if (existing) {
      this.assertJournalPaths(existing)
      const canonicalTarget = assertConfinedTarget(existing.canonicalInstallRoot, targetPath)
      if (canonicalTarget !== existing.targetPath) throw new Error('journal esistente legato a un target diverso')
      if (this.legacy && JSON.stringify(RuntimeSchema.parse(this.legacy)) !== JSON.stringify(existing.legacy)) {
        throw new Error('journal esistente legato a un runtime legacy diverso')
      }
      if (this.config && JSON.stringify(ConfigSchema.parse(this.config)) !== JSON.stringify(existing.config)) {
        throw new Error('journal esistente legato a una configurazione diversa')
      }
      return existing
    }
    if (!this.legacy || this.legacy.kind !== 'legacy' || !this.config) throw new Error('contesto legacy incompleto')
    const rootStat = fs.lstatSync(this.installRoot)
    if (!rootStat.isDirectory() || rootStat.isSymbolicLink()) throw new Error('installRoot symlink non consentita')
    const canonicalRoot = fs.realpathSync(this.installRoot)
    const canonicalTarget = assertConfinedTarget(canonicalRoot, targetPath)
    const parsedLegacy = RuntimeSchema.parse(this.legacy)
    const parsedConfig = ConfigSchema.parse(this.config)
    const plannedGuardrails = guardrailPlan(canonicalTarget, parsedLegacy, parsedConfig)
    const unitPath = path.resolve(this.manager.unitPath())
    const canonicalUnitPath = fs.realpathSync(unitPath)
    const classifiedIdentity = regularIdentity(unitPath)
    const observed = this.manager.runtime()
    if (observed === null || JSON.stringify(RuntimeSchema.parse(observed)) !== JSON.stringify(parsedLegacy)) {
      throw new Error('unit legacy cambiata rispetto alla classificazione iniziale')
    }
    if (!sameIdentity(regularIdentity(unitPath), classifiedIdentity)) {
      throw new Error('unit legacy cambiata durante la riclassificazione')
    }
    const transactionId = randomUUID()
    const migrationsRoot = path.join(this.installRoot, '.service-migration')
    const {created: migrationsRootCreated, identity: migrationsRootIdentity} = ensureMigrationRoot(migrationsRoot)
    const backupRoot = path.join(migrationsRoot, transactionId)
    ensurePrivateDirectory(backupRoot)
    const backupRootIdentity = directoryIdentity(backupRoot)
    if (
      fs.realpathSync(migrationsRoot) !== path.join(canonicalRoot, '.service-migration') ||
      fs.realpathSync(backupRoot) !== path.join(canonicalRoot, '.service-migration', transactionId)
    ) throw new Error('directory backup fuori dalla installRoot canonica')
    const unitBackupPath = path.join(backupRoot, 'unit.backup')
    const unitIdentity = backupFile(unitPath, unitBackupPath)
    if (
      !sameIdentity(unitIdentity, classifiedIdentity) || fs.realpathSync(unitPath) !== canonicalUnitPath ||
      !sameIdentity(regularIdentity(unitPath), unitIdentity)
    ) {
      throw new Error('unit cambiata durante la preparazione del backup')
    }

    const metadataPath = managedServiceConfigPath(this.installRoot)
    let metadata: z.infer<typeof MetadataSnapshotSchema>
    try {
      const identity = regularIdentity(metadataPath)
      const backupPath = path.join(backupRoot, 'service-runtime.backup')
      backupFile(metadataPath, backupPath)
      metadata = {existed: true, identity, backupPath, managedSha256: null}
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
      metadata = {existed: false, identity: null, backupPath: null, managedSha256: null}
    }

    const guardrails = plannedGuardrails.map((planned, index) => {
      const managedSha256 = sha256(planned.content)
      const allowedManagedSha256 = [managedSha256, ...planned.transitionalContents.map((content) => sha256(content))]
      try {
        const identity = regularIdentity(planned.path)
        const backupPath = path.join(backupRoot, `guardrail-${index}.backup`)
        backupFile(planned.path, backupPath)
        return {path: planned.path, existed: true, identity, backupPath, managedSha256, allowedManagedSha256}
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
        return {path: planned.path, existed: false, identity: null, backupPath: null, managedSha256, allowedManagedSha256}
      }
    })

    const managed = migratedUnit(this.legacy, this.installRoot)
    const journal: ServiceMigrationJournal = {
      version: 1,
      transactionId,
      migrationsRootCreated,
      migrationsRootIdentity,
      backupRootIdentity,
      phase: 'prepared',
      installRoot: this.installRoot,
      canonicalInstallRoot: canonicalRoot,
      unitPath,
      canonicalUnitPath,
      unitIdentity,
      unitBackupPath,
      managedUnitSha256: sha256(managed),
      managedUnitIdentity: null,
      targetPath: canonicalTarget,
      legacy: parsedLegacy,
      config: parsedConfig,
      metadata,
      guardrails,
    }
    writeJournal(journal)
    return journal
  }

  apply(): void {
    let journal = this.requiredJournal()
    this.assertJournalPaths(journal)
    const managed = migratedUnit(journal.legacy, journal.installRoot)
    if (sha256(managed) !== journal.managedUnitSha256) {
      throw new Error('integrità unit managed non coincide con il journal')
    }
    const current = regularIdentity(journal.unitPath)
    if (current.sha256 !== journal.managedUnitSha256) {
      atomicReplaceChecked(journal.unitPath, managed, MANAGED_UNIT_MODE, journal.unitIdentity)
    } else if (current.mode !== MANAGED_UNIT_MODE) {
      throw new Error('unit managed con mode inatteso')
    }
    const managedIdentity = regularIdentity(journal.unitPath)
    if (managedIdentity.sha256 !== journal.managedUnitSha256 || managedIdentity.mode !== MANAGED_UNIT_MODE) {
      throw new Error('unit managed non verificabile')
    }
    saveManagedServiceConfig(journal.installRoot, journal.config)
    const metadataIdentity = regularIdentity(managedServiceConfigPath(journal.installRoot))
    journal = {
      ...journal,
      phase: 'applied',
      managedUnitIdentity: managedIdentity,
      metadata: {...journal.metadata, managedSha256: metadataIdentity.sha256},
    }
    writeJournal(journal)
    this.manager.restart()
  }

  restoreLegacy(): void {
    let journal = this.requiredJournal()
    this.assertJournalPaths(journal, journal.phase !== 'restoring')
    this.verifyBackups(journal)
    this.verifyGuardrailRestoreInputs(journal)
    if (journal.phase !== 'restoring') {
      journal = {...journal, phase: 'restoring'}
      writeJournal(journal)
    }
    const current = regularIdentity(journal.unitPath)
    if (current.sha256 !== journal.unitIdentity.sha256) {
      const expected = journal.managedUnitIdentity
      if (!expected || !sameIdentity(current, expected)) throw new Error('unit managed cambiata: identità non ripristinabile')
      const legacyUnit = verifiedBackupContent(journal.unitBackupPath, journal.unitIdentity.sha256, 'unit')
      atomicReplaceChecked(journal.unitPath, legacyUnit, journal.unitIdentity.mode, expected)
    }
    const restoredUnit = regularIdentity(journal.unitPath)
    if (restoredUnit.sha256 !== journal.unitIdentity.sha256 || restoredUnit.mode !== journal.unitIdentity.mode) {
      throw new Error('unit legacy non ripristinata')
    }
    this.restoreMetadata(journal)
    this.restoreGuardrails(journal)
    this.verifyRestoredMetadata(journal)
    this.verifyLegacyGuardrails(journal)
    this.manager.restart()
  }

  finalizeManaged(): void {
    const journal = this.requiredJournal()
    this.assertJournalPaths(journal)
    const unit = regularIdentity(journal.unitPath)
    if (unit.sha256 !== journal.managedUnitSha256 || unit.mode !== MANAGED_UNIT_MODE) {
      throw new Error('unit managed non verificata prima del commit')
    }
    const metadata = regularIdentity(managedServiceConfigPath(journal.installRoot))
    if (!journal.metadata.managedSha256 || metadata.sha256 !== journal.metadata.managedSha256) {
      throw new Error('metadata managed non verificata prima del commit')
    }
    for (const snapshot of journal.guardrails) {
      if (regularIdentity(snapshot.path).sha256 !== snapshot.managedSha256) {
        throw new Error('guardrail managed non verificato prima del commit')
      }
    }
    this.clear(journal)
  }

  finalizeLegacy(): void {
    const journal = this.requiredJournal()
    // The candidate target may already have been deleted after rollback and health, but backup/unit/config
    // stay fully attested before deleting the service journal.
    this.assertJournalPaths(journal, false)
    const unit = regularIdentity(journal.unitPath)
    if (unit.sha256 !== journal.unitIdentity.sha256 || unit.mode !== journal.unitIdentity.mode) {
      throw new Error('unit legacy non verificata prima del rollback')
    }
    if (journal.metadata.existed) {
      const metadata = regularIdentity(managedServiceConfigPath(journal.installRoot))
      if (!journal.metadata.identity || metadata.sha256 !== journal.metadata.identity.sha256) throw new Error('metadata legacy non ripristinata')
    } else if (fs.existsSync(managedServiceConfigPath(journal.installRoot))) {
      throw new Error('metadata managed residua dopo rollback')
    }
    this.verifyLegacyGuardrails(journal)
    this.clear(journal)
  }

  private requiredJournal(): ServiceMigrationJournal {
    const journal = this.journal()
    if (!journal) throw new Error('journal migrazione servizio assente')
    return journal
  }

  private assertJournalPaths(journal: ServiceMigrationJournal, requireTarget = true): void {
    const canonicalRoot = fs.realpathSync(journal.installRoot)
    if (journal.installRoot !== this.installRoot || canonicalRoot !== journal.canonicalInstallRoot) throw new Error('installRoot canonica cambiata')
    if (fs.realpathSync(journal.unitPath) !== journal.canonicalUnitPath) throw new Error('path canonico unit cambiato')
    const backupRoot = path.join(journal.installRoot, '.service-migration', journal.transactionId)
    const migrationsRootStat = fs.lstatSync(path.dirname(backupRoot))
    const backupRootStat = fs.lstatSync(backupRoot)
    if (
      !migrationsRootStat.isDirectory() || migrationsRootStat.isSymbolicLink() ||
      !sameDirectoryIdentity({dev: migrationsRootStat.dev, ino: migrationsRootStat.ino}, journal.migrationsRootIdentity) ||
      !backupRootStat.isDirectory() || backupRootStat.isSymbolicLink() ||
      !sameDirectoryIdentity({dev: backupRootStat.dev, ino: backupRootStat.ino}, journal.backupRootIdentity) ||
      fs.realpathSync(backupRoot) !== path.join(canonicalRoot, '.service-migration', journal.transactionId) ||
      journal.unitBackupPath !== path.join(backupRoot, 'unit.backup') || !regularIdentity(journal.unitBackupPath)
    ) throw new Error('backup unit fuori confinement')
    assertConfigMatchesLegacy(journal.legacy, journal.config)
    const expectedPaths = [
      path.join(path.dirname(journal.config.guardrails.settingsPath), 'generation.json'),
      ...GUARDRAIL_HOOKS.map((hook) => path.join(journal.config.guardrails.hooksDir, hook)),
      journal.config.guardrails.settingsPath,
      journal.config.guardrails.codexRulesPath,
    ].map((value) => path.resolve(value))
    if (
      expectedPaths.length !== journal.guardrails.length ||
      journal.guardrails.some((snapshot, index) => snapshot.path !== expectedPaths[index]) ||
      journal.guardrails.some((snapshot, index) => snapshot.backupPath !== null && snapshot.backupPath !== path.join(backupRoot, `guardrail-${index}.backup`)) ||
      (journal.metadata.backupPath !== null && journal.metadata.backupPath !== path.join(backupRoot, 'service-runtime.backup'))
    ) throw new Error('snapshot guardrail fuori confinement')
    if (path.dirname(journal.targetPath) !== path.join(canonicalRoot, 'releases')) {
      throw new Error('target servizio fuori dal layout releases canonico')
    }
    if (requireTarget) assertConfinedTarget(canonicalRoot, journal.targetPath)
  }

  private restoreMetadata(journal: ServiceMigrationJournal): void {
    const metadataPath = managedServiceConfigPath(journal.installRoot)
    if (journal.metadata.existed) {
      if (!journal.metadata.backupPath || !journal.metadata.identity) throw new Error('backup metadata legacy incompleto')
      const current = regularIdentity(metadataPath)
      if (current.sha256 === journal.metadata.identity.sha256 && current.mode === journal.metadata.identity.mode) return
      if (!journal.metadata.managedSha256 || current.sha256 !== journal.metadata.managedSha256) throw new Error('metadata managed cambiata')
      const legacyMetadata = verifiedBackupContent(journal.metadata.backupPath, journal.metadata.identity.sha256, 'metadata')
      atomicReplaceChecked(metadataPath, legacyMetadata, journal.metadata.identity.mode, current)
      return
    }
    try {
      const current = regularIdentity(metadataPath)
      if (!journal.metadata.managedSha256 || current.sha256 !== journal.metadata.managedSha256) throw new Error('metadata managed cambiata')
      fs.rmSync(metadataPath)
      fsyncDirectory(path.dirname(metadataPath))
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
    }
  }

  private verifyRestoredMetadata(journal: ServiceMigrationJournal): void {
    const metadataPath = managedServiceConfigPath(journal.installRoot)
    if (journal.metadata.existed) {
      const current = regularIdentity(metadataPath)
      if (!journal.metadata.identity || current.sha256 !== journal.metadata.identity.sha256 || current.mode !== journal.metadata.identity.mode) {
        throw new Error('metadata legacy non ripristinata')
      }
      return
    }
    if (fs.existsSync(metadataPath)) throw new Error('metadata managed residua dopo rollback')
  }

  private verifyBackups(journal: ServiceMigrationJournal): void {
    const unitBackup = regularIdentity(journal.unitBackupPath)
    if (unitBackup.sha256 !== journal.unitIdentity.sha256) throw new Error('backup unit alterato o non verificabile')
    if (journal.metadata.existed) {
      if (!journal.metadata.backupPath || !journal.metadata.identity) throw new Error('backup metadata legacy incompleto')
      const metadataBackup = regularIdentity(journal.metadata.backupPath)
      if (metadataBackup.sha256 !== journal.metadata.identity.sha256) throw new Error('backup metadata alterato o non verificabile')
    }
    for (const snapshot of journal.guardrails) {
      if (!snapshot.existed) continue
      if (!snapshot.backupPath || !snapshot.identity) throw new Error('backup guardrail legacy incompleto')
      if (regularIdentity(snapshot.backupPath).sha256 !== snapshot.identity.sha256) {
        throw new Error('backup guardrail alterato o non verificabile')
      }
    }
  }

  private verifyGuardrailRestoreInputs(journal: ServiceMigrationJournal): void {
    for (const snapshot of journal.guardrails) {
      try {
        const current = regularIdentity(snapshot.path)
        if (snapshot.existed && snapshot.identity && current.sha256 === snapshot.identity.sha256 && current.mode === snapshot.identity.mode) continue
        if (!snapshot.allowedManagedSha256.includes(current.sha256)) throw new Error(`guardrail cambiato: ${snapshot.path}`)
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT' && !snapshot.existed) continue
        throw error
      }
    }
  }

  private restoreGuardrails(journal: ServiceMigrationJournal): void {
    for (const snapshot of journal.guardrails) {
      if (snapshot.existed) {
        if (!snapshot.backupPath || !snapshot.identity) throw new Error('backup guardrail legacy incompleto')
        const current = regularIdentity(snapshot.path)
        if (current.sha256 === snapshot.identity.sha256 && current.mode === snapshot.identity.mode) continue
        if (!snapshot.allowedManagedSha256.includes(current.sha256)) throw new Error(`guardrail cambiato: ${snapshot.path}`)
        const legacyGuardrail = verifiedBackupContent(snapshot.backupPath, snapshot.identity.sha256, 'guardrail')
        atomicReplaceChecked(snapshot.path, legacyGuardrail, snapshot.identity.mode, current)
        continue
      }
      try {
        const current = regularIdentity(snapshot.path)
        if (!snapshot.allowedManagedSha256.includes(current.sha256)) throw new Error(`guardrail cambiato: ${snapshot.path}`)
        if (!sameIdentity(regularIdentity(snapshot.path), current)) throw new Error(`guardrail cambiato durante il restore: ${snapshot.path}`)
        fs.rmSync(snapshot.path)
        fsyncDirectory(path.dirname(snapshot.path))
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
      }
    }
  }

  private verifyLegacyGuardrails(journal: ServiceMigrationJournal): void {
    for (const snapshot of journal.guardrails) {
      if (snapshot.existed) {
        const current = regularIdentity(snapshot.path)
        if (!snapshot.identity || current.sha256 !== snapshot.identity.sha256 || current.mode !== snapshot.identity.mode) {
          throw new Error('guardrail legacy non ripristinato')
        }
      } else {
        try {
          fs.lstatSync(snapshot.path)
          throw new Error('guardrail managed residuo dopo rollback')
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
        }
      }
    }
  }

  private clear(journal: ServiceMigrationJournal): void {
    const journalPath = serviceMigrationJournalPath(journal.installRoot)
    const migrationsRoot = path.join(journal.installRoot, '.service-migration')
    const backupRoot = path.dirname(journal.unitBackupPath)
    if (!sameDirectoryIdentity(directoryIdentity(migrationsRoot), journal.migrationsRootIdentity)) {
      throw new Error('identità directory root migrazione cambiata')
    }
    if (!sameDirectoryIdentity(directoryIdentity(backupRoot), journal.backupRootIdentity)) {
      throw new Error('identità directory backup migrazione cambiata')
    }
    // Commit point: after the durable removal of the journal the service is already attested and a crash
    // during cleanup can only leave orphan private directories, never an unrecoverable journal.
    fs.rmSync(journalPath)
    fsyncDirectory(path.dirname(journalPath))
    this.cleanupCommitted()
    const backupQuarantine = quarantineDirectory(
      backupRoot,
      journal.backupRootIdentity,
      journal.installRoot,
      'directory backup migrazione',
    )
    if (!sameDirectoryIdentity(directoryIdentity(migrationsRoot), journal.migrationsRootIdentity)) {
      throw new Error(`identità directory root migrazione cambiata; backup preservato in quarantena: ${backupQuarantine}`)
    }
    fs.rmSync(backupQuarantine, {recursive: true})
    fsyncDirectory(journal.installRoot)
    if (!journal.migrationsRootCreated) return
    if (fs.readdirSync(migrationsRoot).length > 0) return
    const rootQuarantine = quarantineDirectory(
      migrationsRoot,
      journal.migrationsRootIdentity,
      journal.installRoot,
      'directory root migrazione',
    )
    try {
      if (fs.readdirSync(rootQuarantine).length > 0) {
        restoreQuarantinedDirectory(rootQuarantine, migrationsRoot)
        return
      }
      fs.rmdirSync(rootQuarantine)
      fsyncDirectory(journal.installRoot)
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code
      if (code !== 'ENOTEMPTY' && code !== 'EEXIST') throw error
      restoreQuarantinedDirectory(rootQuarantine, migrationsRoot)
    }
  }
}
