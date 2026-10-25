import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import {Flags} from '@oclif/core'
import {BaseCommand} from '../base'
import {installRoot as defaultInstallRoot, guardrailsSettingsPath} from '../lib/paths'
import {
  describeRuntimeDivergences,
  detectPlatform,
  diffManagedServiceRuntime,
  diffServiceRuntime,
  type ManagedServiceRuntime,
  type OsPlatform,
  type RuntimeDivergence,
  serviceManager,
  type ServiceManager,
  type ServiceRuntime,
  SYSTEMD_UNIT,
  userRuntimeDir,
} from '../lib/service'
import {activeManagedGuardrailPaths, loadManagedServiceConfig, saveManagedServiceConfig, type ManagedServiceConfig} from '../lib/managed-service'
import {ServiceMigration, type ServiceMigrationJournal} from '../lib/service-migration'
import type {GuardrailPaths} from '../lib/guardrails'
import {holdIdleHost, type IdleHold} from '../lib/host-idle'
import {type AutoUpdateFields, installAutoUpdate} from '../lib/auto-update-timer'
import {
  assertReleaseChannel,
  busyResult,
  DEFAULT_CHANNEL,
  defaultUpdateProbe,
  RECOVERY_REPEAT_HINT,
  type ReleaseChannel,
  runUpdate,
  selectPinnedRelease,
  selectTargetRelease,
  SERVICE_RECONCILIATION_HINT,
  type UpdateProbe,
  type UpdateResult,
} from '../lib/update'
import {redactSecrets} from '../lib/secret-redaction'
import {recordUpdateOutcome} from '../lib/update-outcome'
import {type PinResult, reconcileRuntimePins} from '../lib/runtime-pins'
import {probeAgentRuntimes} from '../lib/runtime-probe'
import {AutomatorError, ErrorCodes} from '../errors/error-codes'

/** Release API of the stable tag: the probe picks the most recently created append-only generation. */
const DEFAULT_MANIFEST_BASE_URL = 'https://api.github.com/repos/bussolabs/closeyourit-automator-community/releases/tags/automator-channels'

/**
 * The service gates run with the INSTALLED binary and block before the download: if the defect is in the gate
 * itself, no later release could fix it, because the fixed code is never executed
 * (CYAU-156). Every rejection therefore carries the recovery path with it, instead of just failing.
 */
const SERVICE_GATE_REMEDIATION =
  'se il blocco dipende da un difetto di questa versione, aggiornare i soli byte con `automator update --skip-service-preflight` e poi rieseguire `automator update` con la nuova versione installata'

/** The recovery prompts the result may carry; the command mirrors them without deciding them. */
const RECOVERY_HINTS = new Set([SERVICE_RECONCILIATION_HINT, RECOVERY_REPEAT_HINT])

/** Rejection by a service gate: diagnostic message + remedy, also structured for the `--json` output. */
function serviceGateError(message: string, details: Record<string, unknown> = {}): AutomatorError {
  return new AutomatorError(ErrorCodes.Update.failed, `${message}; ${SERVICE_GATE_REMEDIATION}`, 1, {
    ...details,
    remediation: SERVICE_GATE_REMEDIATION,
  })
}

/**
 * A defective gate does not reject with a diagnosis: it crashes. Any error coming out of a gate therefore carries the remedy
 * — an unexpected exception is exactly the dead-end case to recover from, not a path to leave silent.
 */
function guardServiceGate<T>(gate: () => T): T {
  try {
    return gate()
  } catch (error) {
    if (error instanceof AutomatorError) {
      if (error.details?.remediation !== undefined) throw error
      throw new AutomatorError(error.code, `${error.message}; ${SERVICE_GATE_REMEDIATION}`, error.exitCode, {
        ...(error.details ?? {}),
        remediation: SERVICE_GATE_REMEDIATION,
      })
    }
    const detail = redactSecrets(error instanceof Error ? error.message : String(error))
    throw serviceGateError(`controllo del servizio non completato: ${detail}`)
  }
}

export default class Update extends BaseCommand {
  static description =
    "Distribuisce e aggiorna l'Automator in modo controllato: scarica in una staging univoca, verifica il checksum prima dell'estrazione, esegue il preflight e promuove la release immutabile con rename prima dello switch atomico di `current`. Prima del restart migra e verifica i guardrail della nuova release; un fallimento ripristina symlink e guardrail precedenti, SENZA perdere run. La versione già attiva è un no-op sui byte e riconcilia i guardrail. Un --target-version con vincoli server richiede una --server-version valida: se assente o non interpretabile, il pin è rifiutato senza modifiche. I gate del servizio girano col binario installato: quando rifiutano dicono anche come recuperare, e --skip-service-preflight aggiorna i soli byte gestiti senza toccare il servizio, così un difetto nei controlli si corregge con un secondo update invece che disinstallando. Gate: aggiornato o già aggiornato → exit 0; incompatibile o rollback riuscito → exit 3; fallimento/integrità/rollback non verificato → exit 1; input non valido → exit 2. --dry-run non scarica né attiva"

  static examples = [
    '<%= config.bin %> update',
    '<%= config.bin %> update --channel beta',
    '<%= config.bin %> update --dry-run --json',
    '<%= config.bin %> update --target-version 1.4.0 --server-version 5.2.0',
    '<%= config.bin %> update --migrate-service',
    '<%= config.bin %> update --skip-service-preflight',
  ]

  static flags = {
    channel: Flags.string({description: 'canale di distribuzione (stable|beta)', default: DEFAULT_CHANNEL}),
    'install-root': Flags.string({description: 'root gestita del codice (default: AUTOMATOR_INSTALL_ROOT o ~/.local/lib/...)'}),
    'manifest-url': Flags.string({description: `base degli asset di release (default: ${DEFAULT_MANIFEST_BASE_URL})`}),
    'server-version': Flags.string({description: 'versione del server CloseYourIt corrente (per la compatibilità)'}),
    'target-version': Flags.string({description: 'fissa una versione specifica; se dichiara vincoli server, richiede --server-version valida (fail-closed)'}),
    'allow-downgrade': Flags.boolean({description: 'consenti di installare una versione ≤ corrente', default: false}),
    'migrate-service': Flags.boolean({
      description: 'migra esplicitamente una unit checkout legacy al layout managed, con rollback transazionale',
      default: false,
    }),
    'skip-service-preflight': Flags.boolean({
      description:
        'recovery da controlli di avvio difettosi: salta i gate del servizio e aggiorna soltanto i byte gestiti, senza riavviare il daemon né migrare i guardrail; subito dopo va rieseguito `automator update` con la nuova versione. Incompatibile con --migrate-service',
      default: false,
    }),
    'dry-run': Flags.boolean({description: 'mostra la release selezionata senza scaricare né attivare nulla', default: false}),
  }

  /** Builds the real probe (curl/tar/symlink/restart). Overridable in tests. */
  protected makeProbe(
    installRoot: string,
    manifestBaseUrl: string,
    migrateService = false,
    skipServicePreflight = false,
  ): UpdateProbe {
    const platform = this.currentPlatform()
    // Explicit recovery (CYAU-156): the gates are not even built, so a defect of theirs in the installed
    // version can no longer block the release that fixes it. The probe touches only the managed bytes: no
    // unit read, no guardrail migrated, no restart — the Node is the one of the running updater.
    if (skipServicePreflight) {
      return defaultUpdateProbe({
        installRoot,
        manifestBaseUrl,
        restartCommand: this.restartCommand(platform),
        healthCommand: () => ({cmd: process.execPath, args: [path.join(installRoot, 'current', 'bin', 'run.js'), '--version']}),
        candidateHealthCommand: (releaseDir) => ({
          cmd: process.execPath,
          args: [path.join(releaseDir, 'bin', 'run.js'), '--version'],
        }),
        serviceInstalled: () => false,
      })
    }
    const manager = this.makeServiceManager(platform)
    let managedService = false
    let serviceNode = process.execPath
    let expectedRuntime: ManagedServiceRuntime | null = null
    let expectedDefinition: ServiceRuntime | null = null
    let expectedGuardrailPaths: GuardrailPaths | undefined
    let migration: ServiceMigration | null = null
    let migrationCommitted = false
    const runtimeMatches = (
      observed: ManagedServiceRuntime | null,
      expected: ManagedServiceRuntime,
    ): boolean => diffManagedServiceRuntime(observed, expected).length === 0
    const definitionMatches = (observed: ServiceRuntime | null, expected: ServiceRuntime): boolean =>
      diffServiceRuntime(observed, expected).length === 0
    // DIAGNOSTIC gates (CYAU-102): when the live identity does not match, the message reports WHICH field diverges
    // with expected and actual, and the structured divergences travel in the error (`details`) for the `--json` output.
    const rejectManagedDivergence = (observed: ManagedServiceRuntime | null, expected: ManagedServiceRuntime): void => {
      const divergences = diffManagedServiceRuntime(observed, expected)
      if (divergences.length === 0) return
      throw serviceGateError(
        `daemon live non coincide con la definizione gestita su disco: ${describeRuntimeDivergences(divergences)}`,
        {divergences},
      )
    }
    const rejectLegacyDivergence = (observed: ServiceRuntime | null, expected: ServiceRuntime): void => {
      const divergences = diffServiceRuntime(observed, expected)
      if (divergences.length === 0) return
      throw serviceGateError(
        `daemon live non coincide con la unit disk legacy: ${describeRuntimeDivergences(divergences)}`,
        {divergences},
      )
    }
    const rejectPersistedDivergence = (persisted: ManagedServiceConfig, expected: ManagedServiceRuntime): void => {
      const persistedConfigDir = path.dirname(path.dirname(persisted.guardrails.settingsPath))
      const divergences: RuntimeDivergence[] = []
      if (persisted.nodePath !== expected.nodePath) divergences.push({field: 'nodePath', expected: expected.nodePath, actual: persisted.nodePath})
      if (persisted.codexHome !== expected.codexHome) divergences.push({field: 'codexHome', expected: expected.codexHome, actual: persisted.codexHome})
      if (persistedConfigDir !== expected.configDir) divergences.push({field: 'configDir', expected: expected.configDir, actual: persistedConfigDir})
      if (divergences.length === 0) return
      throw serviceGateError(
        `runtime persistito non coincide con Node/config/CODEX_HOME dell'unit installata: ${describeRuntimeDivergences(divergences)}`,
        {divergences},
      )
    }
    const managedDefinition = (legacy: ServiceRuntime): ServiceRuntime => ({
      ...legacy,
      kind: 'managed',
      installRoot,
      entrypoint: path.join(installRoot, 'current', 'bin', 'run.js'),
      env: {...legacy.env, AUTOMATOR_INSTALL_ROOT: installRoot},
    })
    const managedIdentity = (runtime: ServiceRuntime): ManagedServiceRuntime => ({
      installRoot,
      nodePath: runtime.nodePath,
      entrypoint: path.join(installRoot, 'current', 'bin', 'run.js'),
      daemonArgs: [...runtime.daemonArgs],
      configDir: runtime.configDir,
      codexHome: runtime.codexHome,
    })
    const migrationConfig = (runtime: ServiceRuntime): ManagedServiceConfig => ({
      version: 1,
      codexHome: runtime.codexHome,
      nodePath: runtime.nodePath,
      guardrails: {
        hooksDir: path.join(runtime.configDir, 'guardrails', 'hooks'),
        settingsPath: path.join(runtime.configDir, 'guardrails', 'settings.json'),
        codexRulesPath: path.join(runtime.codexHome, 'rules', 'closeyourit-automator.rules'),
        worktreesRoot: path.join(runtime.homeDir, '.local', 'share', 'closeyourit-automator', 'worktrees'),
      },
    })
    const currentTarget = (): string | null => {
      try {
        return fs.realpathSync(path.join(installRoot, 'current'))
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null
        throw error
      }
    }
    const configureMigration = (legacy: ServiceRuntime, config: ManagedServiceConfig): void => {
      migration = new ServiceMigration({installRoot, manager, legacy, config})
      expectedDefinition = managedDefinition(legacy)
      expectedRuntime = managedIdentity(legacy)
      serviceNode = legacy.nodePath
      expectedGuardrailPaths = {...config.guardrails, nodePath: config.nodePath}
      managedService = true
    }
    const journalRuntimeMatches = (observed: ServiceRuntime | null, journal: ServiceMigrationJournal): boolean =>
      definitionMatches(observed, journal.legacy) || definitionMatches(observed, managedDefinition(journal.legacy))
    const assertMigrationRuntime = (journal: ServiceMigrationJournal): void => {
      const status = manager.status()
      if (!status.installed) {
        throw serviceGateError('unit del journal di migrazione assente')
      }
      const disk = manager.runtime()
      if (!journalRuntimeMatches(disk, journal)) {
        throw serviceGateError('unit su disco non coincide con il journal di migrazione')
      }
      if (status.running) {
        const live = manager.loadedRuntime()
        // A crash can leave disk and live in the two opposite identities between rename, daemon-reload and restart.
        // Both are attested by the journal; restart() reconciles them under the update lock.
        if (!journalRuntimeMatches(live, journal)) {
          throw serviceGateError('daemon live estraneo alle identità del journal di migrazione')
        }
      }
    }
    const preflightServiceDefinition = (): void => {
      const recovery = new ServiceMigration({installRoot, manager})
      const journal = recovery.attestedJournal()
      if (journal !== null) {
        assertMigrationRuntime(journal)
        return
      }
      const status = manager.status()
      if (!status.installed) return
      const definition = manager.runtime()
      if (definition?.kind === 'legacy') {
        if (!migrateService) {
          throw serviceGateError('servizio checkout legacy rilevato: ripetere esplicitamente con --migrate-service')
        }
        if (status.running) rejectLegacyDivergence(manager.loadedRuntime(), definition)
        return
      }
      const runtime = manager.managedRuntime()
      if (runtime === null || runtime.installRoot !== installRoot) {
        throw serviceGateError(
          `servizio installato non gestito dalla root richiesta (${installRoot}); eseguire install --managed sulla stessa root`,
        )
      }
      if (status.running) rejectManagedDivergence(manager.loadedManagedRuntime(), runtime)
      const persisted = loadManagedServiceConfig(installRoot)
      if (persisted !== null) rejectPersistedDivergence(persisted, runtime)
    }
    const finalizeLegacyRollback = (): void => {
      const activeMigration = migration
      const journal = activeMigration?.attestedJournal()
      if (!activeMigration || !journal) return
      // It is idempotent even when the unit is already legacy, and it is still needed to restore metadata/guardrails
      // possibly mutated before apply() reached the unit swap.
      activeMigration.restoreLegacy()
      if (
        !definitionMatches(manager.runtime(), journal.legacy) ||
        !definitionMatches(manager.loadedRuntime(), journal.legacy) ||
        !manager.status().running
      ) throw new AutomatorError(ErrorCodes.Update.failed, 'rollback della unit legacy non verificato', 1)
    }
    const recoverOrphanedRollback = (): boolean => {
      const activeMigration = migration
      const journal = activeMigration?.attestedJournal()
      if (!activeMigration || journal?.phase !== 'restoring') return false
      finalizeLegacyRollback()
      activeMigration.finalizeLegacy()
      migration = null
      return true
    }
    return defaultUpdateProbe({
      installRoot,
      manifestBaseUrl,
      restartCommand: this.restartCommand(platform),
      preflightService: () => guardServiceGate(preflightServiceDefinition),
      restartService: () => {
        const activeMigration = migration
        if (activeMigration !== null) {
          let journal = activeMigration.journal()
          const target = currentTarget()
          if (journal === null) {
            if (target === null) throw new AutomatorError(ErrorCodes.Update.failed, 'target current assente durante la migrazione', 1)
            journal = activeMigration.prepare(target)
          }
          if (target === journal.targetPath) activeMigration.apply()
          else activeMigration.restoreLegacy()
          return
        }
        const expected = expectedRuntime
        if (expected === null || !runtimeMatches(manager.managedRuntime(), expected)) {
          throw new AutomatorError(ErrorCodes.Update.failed, 'unit gestita cambiata durante l\'update', 1)
        }
        manager.restart()
      },
      // Preflight and health use the Node of the actually installed unit, not the one of the updater shell. The
      // callback is resolved after serviceInstalled(), which validates root, entrypoint and metadata before the download.
      healthCommand: () => ({cmd: serviceNode, args: [path.join(installRoot, 'current', 'bin', 'run.js'), '--version']}),
      candidateHealthCommand: (releaseDir) => ({
        cmd: serviceNode,
        args: [path.join(releaseDir, 'bin', 'run.js'), '--version'],
      }),
      guardrailPaths: () => expectedGuardrailPaths,
      prepareService: (targetPath) => {
        const activeMigration = migration
        if (activeMigration === null || activeMigration.attestedJournal() !== null) return
        activeMigration.prepare(targetPath)
      },
      skipGuardrailMigration: (releaseDir) => {
        const journal = migration?.attestedJournal()
        return journal !== null && journal !== undefined && fs.realpathSync(releaseDir) !== journal.targetPath
      },
      rollbackService: finalizeLegacyRollback,
      recoverService: () => guardServiceGate(recoverOrphanedRollback),
      commitService: () => {
        const activeMigration = migration
        // After a rollback the owned candidate release may already have been removed. The other paths and all the
        // backups stay attested; finalizeLegacy runs the same confined check without dereferencing targets.
        const journal = activeMigration?.attestedJournal(false)
        if (!activeMigration || !journal) return
        const target = currentTarget()
        const disk = manager.runtime()
        const live = manager.loadedRuntime()
        const running = manager.status().running
        const managed = managedDefinition(journal.legacy)
        if (definitionMatches(disk, managed) && definitionMatches(live, managed) && running) {
          if (target !== journal.targetPath) {
            throw new AutomatorError(ErrorCodes.Update.failed, 'unit managed attiva senza il target current attestato', 1)
          }
          activeMigration.finalizeManaged()
          migration = null
          migrationCommitted = true
          return
        }
        if (!definitionMatches(disk, journal.legacy) || !definitionMatches(live, journal.legacy) || !running) {
          throw new AutomatorError(ErrorCodes.Update.failed, 'commit del servizio non coincide né con managed né con rollback legacy', 1)
        }
        activeMigration.finalizeLegacy()
        migration = null
      },
      serviceInstalled: () => guardServiceGate((): boolean => {
        const recovery = new ServiceMigration({installRoot, manager})
        const journal = recovery.attestedJournal()
        if (journal !== null) {
          assertMigrationRuntime(journal)
          configureMigration(journal.legacy, journal.config)
          return true
        }
        const status = manager.status()
        if (!status.installed) return false
        const definition = manager.runtime()
        if (definition?.kind === 'legacy') {
          if (!migrateService) {
            throw serviceGateError('servizio checkout legacy rilevato: ripetere esplicitamente con --migrate-service')
          }
          if (status.running) rejectLegacyDivergence(manager.loadedRuntime(), definition)
          configureMigration(definition, migrationConfig(definition))
          return true
        }
        // Fully validates the desired definition on disk without starting it: the reload happens only in the
        // restart after the guardrail migration, then health compares the live identity of the service manager.
        const runtime = manager.managedRuntime()
        if (runtime === null || runtime.installRoot !== installRoot) {
          throw serviceGateError(
            `servizio installato non gestito dalla root richiesta (${installRoot}); eseguire install --managed sulla stessa root`,
          )
        }
        if (status.running) rejectManagedDivergence(manager.loadedManagedRuntime(), runtime)
        const persisted = loadManagedServiceConfig(installRoot)
        if (persisted !== null) rejectPersistedDivergence(persisted, runtime)
        serviceNode = persisted?.nodePath ?? runtime.nodePath
        if (persisted === null) {
          const guardrails = {
            hooksDir: path.join(runtime.configDir, 'guardrails', 'hooks'),
            settingsPath: path.join(runtime.configDir, 'guardrails', 'settings.json'),
            codexRulesPath: path.join(runtime.codexHome, 'rules', 'closeyourit-automator.rules'),
            worktreesRoot: path.join(os.homedir(), '.local', 'share', 'closeyourit-automator', 'worktrees'),
          }
          expectedGuardrailPaths = {...guardrails, nodePath: runtime.nodePath}
          saveManagedServiceConfig(installRoot, {
            version: 1,
            codexHome: runtime.codexHome,
            nodePath: runtime.nodePath,
            guardrails,
          })
        } else {
          expectedGuardrailPaths = {...persisted.guardrails, nodePath: persisted.nodePath}
        }
        expectedRuntime = runtime
        expectedDefinition = definition?.kind === 'managed' ? definition : null
        managedService = true
        return true
      }),
      // After every restart/rollback the standalone health is not enough: the unit's daemon must be alive too.
      serviceRunning: () => {
        const activeMigration = migration
        const journal = activeMigration?.journal()
        if (activeMigration && journal) {
          const target = currentTarget()
          if (target === journal.targetPath) {
            const expected = managedDefinition(journal.legacy)
            const healthy = definitionMatches(manager.runtime(), expected) &&
              definitionMatches(manager.loadedRuntime(), expected) && manager.status().running
            return healthy
          }
          const healthy = definitionMatches(manager.runtime(), journal.legacy) &&
            definitionMatches(manager.loadedRuntime(), journal.legacy) && manager.status().running
          return healthy
        }
        const expected = expectedRuntime
        if (!managedService || expected === null) return true
        if (migrationCommitted && expectedDefinition !== null) {
          return definitionMatches(manager.loadedRuntime(), expectedDefinition) && manager.status().running
        }
        return runtimeMatches(manager.loadedManagedRuntime(), expected) && manager.status().running
      },
    })
  }

  protected makeServiceManager(platform: OsPlatform): ServiceManager {
    return serviceManager(platform)
  }

  /** Test seam: in production it takes the host cycle lock (CYAU-202). */
  protected holdIdle(): IdleHold {
    return holdIdleHost()
  }

  /**
   * CYAU-209 — brings Claude and Codex to the versions pinned in the release and really tests them. Runs while holding
   * the lock and BEFORE runUpdate, which restarts the service even when it is already up to date: the daemon snapshots the
   * launchers at startup, so without that restart it would reject the CLIs just changed. The versions are those
   * of the binary running `update`: after a release jump they align at the next hourly round.
   */
  protected reconcileRuntimes(): Promise<PinResult> {
    return reconcileRuntimePins({
      probe: () => probeAgentRuntimes({settingsPath: activeManagedGuardrailPaths().settingsPath ?? guardrailsSettingsPath()}),
    })
  }

  /** Test seam: writes and enables the automatic update units (CYAU-202). */
  protected installAutoUpdateTimer(homeDir: string, fields: AutoUpdateFields): void {
    installAutoUpdate(homeDir, fields)
  }

  /**
   * CYAU-202 — the timer is born with `install --managed`, but machines already installed do not have it: exactly
   * the ones the ticket exists for would stay without it. Every healthy update reconciles it, as it already does with the
   * guardrails, reading the environment from the daemon's REAL unit: so the timer and the daemon cannot diverge
   * (with a different state folder the update would look at another lock).
   *
   * Only on a managed unit: with a legacy checkout unit `update` does not update that code and the timer would run
   * idle. A timer that does not turn on just warns — it does not turn a successful update into an error.
   */
  private reconcileAutoUpdateTimer(platform: OsPlatform): void {
    try {
      const runtime = this.makeServiceManager(platform).runtime()
      if (runtime === null || runtime.kind !== 'managed') return
      this.installAutoUpdateTimer(runtime.homeDir, {
        nodePath: runtime.nodePath,
        entrypoint: runtime.entrypoint,
        pathEnv: runtime.pathEnv,
        homeDir: runtime.homeDir,
        runtimeDir: userRuntimeDir(),
        env: runtime.env,
      })
    } catch (error) {
      this.warn(`timer di aggiornamento automatico non riconciliato: ${redactSecrets(error instanceof Error ? error.message : String(error))}`)
    }
  }

  /** Test seam: in production it always validates the real operating system before every update. */
  protected currentPlatform(): OsPlatform {
    return detectPlatform()
  }

  /** Restart command of the only supported service manager. */
  protected restartCommand(_platform: OsPlatform): {cmd: string; args: string[]} {
    return {cmd: 'systemctl', args: ['--user', 'restart', SYSTEMD_UNIT]}
  }

  async run(): Promise<unknown> {
    const {flags} = await this.parse(Update)
    assertReleaseChannel(flags.channel)
    const channel: ReleaseChannel = flags.channel
    const installRoot = path.resolve(flags['install-root']?.trim() || defaultInstallRoot())
    const manifestBaseUrl = flags['manifest-url']?.trim() || DEFAULT_MANIFEST_BASE_URL
    const serverVersion = flags['server-version']?.trim() || null
    const targetVersion = flags['target-version']?.trim() || null
    const skipServicePreflight = flags['skip-service-preflight']

    // The two consents are mutually exclusive: --migrate-service asks to MUTATE the unit, recovery not to touch it at all.
    if (skipServicePreflight && flags['migrate-service']) {
      throw new AutomatorError(
        ErrorCodes.Update.invalidInput,
        '--skip-service-preflight e --migrate-service sono incompatibili: il recovery non tocca il servizio, la migrazione lo richiede',
        2,
      )
    }

    // CYAU-202 — from here the update starts by itself (systemd timer) and nobody checks any more whether the machine is busy:
    // the "machine free" gate lives in the command, not in the timer. The hold lasts as long as the update, so between the
    // check and the service restart no new run can start.
    //
    // Two paths stay out of it, for the same reason: they restart nothing. `--dry-run` touches
    // nothing; `--skip-service-preflight` updates only the managed bytes without restarting the daemon — and it is the only
    // way to fix a host if one day THIS gate were the defective one (CYAU-156).
    const idle = flags['dry-run'] || skipServicePreflight ? null : this.holdIdle()
    if (idle !== null && !idle.held) {
      return this.emit({
        dryRun: false,
        channel,
        installRoot,
        skipServicePreflight,
        result: busyResult(channel, null, idle.reason),
      })
    }

    const probe = this.makeProbe(installRoot, manifestBaseUrl, flags['migrate-service'], skipServicePreflight)

    // The service gate (serviceInstalled/preflightService) THROWS before runUpdate returns an UpdateResult:
    // without this catch the AutomatorError escaped emit() and `--json` stayed empty (CYAU-102). Here the gate
    // error still produces a structured JSON payload (code, message and divergences) before rethrowing.
    if (flags['dry-run']) {
      try {
        return this.runDryRun({channel, installRoot, serverVersion, targetVersion, allowDowngrade: flags['allow-downgrade']}, probe)
      } catch (error) {
        throw this.reportGateException(error, {dryRun: true, channel, installRoot})
      }
    }

    // Recovery does not restart the daemon: changed CLIs would stay rejected until the next restart.
    const pins = skipServicePreflight ? null : await this.reconcileRuntimes()
    if (pins && !this.jsonEnabled()) {
      if (pins.outcome === 'updated') this.log(`CLI dei modelli aggiornate: ${pins.changes.join(', ')}`)
      if (pins.outcome === 'failed' || pins.outcome === 'rolled-back') this.warn(`CLI dei modelli: ${pins.detail}`)
    }

    let result: UpdateResult
    try {
      result = runUpdate(
        {installRoot, channel, serverVersion, allowDowngrade: flags['allow-downgrade'], targetVersion, skipServicePreflight},
        probe,
      )
    } catch (error) {
      throw this.reportGateException(error, {dryRun: false, channel, installRoot})
    } finally {
      // Even on failure: a hold not given back would stop the daemon until the first restart.
      if (idle?.held) idle.release()
    }
    const emitted = this.emit({dryRun: false, channel, installRoot, skipServicePreflight, result})
    // After emit, which clears the warning on a healthy update: CLIs left behind must be seen anyway.
    if (pins?.outcome === 'failed' || pins?.outcome === 'rolled-back') {
      this.rememberOutcome({outcome: 'failed', reason: `CLI dei modelli: ${pins.detail}`, fromVersion: null, toVersion: null})
    }
    return emitted
  }

  /**
   * A gate exception (AutomatorError) on the error path: with `--json` emits the structured payload with
   * code, message and any gate divergences (`details`), so this path does not stay silent either
   * (DoD CYAU-102). Returns the error to rethrow for the exit code; non-Automator errors pass unchanged.
   */
  private reportGateException(
    error: unknown,
    base: {dryRun: boolean; channel: ReleaseChannel; installRoot: string},
  ): unknown {
    // A rejecting gate does not go through emit() but leaves the machine on the old version exactly like a
    // failure: without this, the quietest case of all would stay invisible from the panel (CYAU-202).
    if (!base.dryRun) {
      this.rememberOutcome({
        outcome: 'failed',
        reason: error instanceof Error ? error.message : String(error),
        fromVersion: null,
        toVersion: null,
      })
    }
    if (error instanceof AutomatorError && this.jsonEnabled()) {
      this.logJson({...base, error: {code: error.code, message: error.message, ...(error.details ?? {})}})
    }
    return error
  }

  /**
   * Records the outcome for the beat. It cannot fail a SUCCESSFUL update: if the state folder is not
   * writable it says so and moves on, instead of turning a success into an error.
   */
  private rememberOutcome(result: {outcome: string; reason: string; fromVersion: string | null; toVersion: string | null}): void {
    try {
      recordUpdateOutcome(result)
    } catch (error) {
      this.warn(`esito dell'aggiornamento non registrato: ${redactSecrets(error instanceof Error ? error.message : String(error))}`)
    }
  }

  /** Dry-run: reads the current version and the manifest (read-only), shows the selection. Neither downloads nor activates. */
  private runDryRun(
    input: {channel: ReleaseChannel; installRoot: string; serverVersion: string | null; targetVersion: string | null; allowDowngrade: boolean},
    probe: UpdateProbe,
  ): unknown {
    // The dry-run also consults the network: an ambiguous legacy unit is therefore rejected before the manifest.
    probe.preflightService?.()
    const current = probe.currentVersion()
    const manifest = probe.fetchManifest(input.channel)

    let decision: string
    let targetV: string | null
    let reason: string
    if (input.targetVersion != null) {
      const selection = selectPinnedRelease(manifest, {
        channel: input.channel,
        currentVersion: current,
        targetVersion: input.targetVersion,
        serverVersion: input.serverVersion,
      })
      decision = selection.decision
      targetV = selection.target?.version ?? null
      reason = selection.reason
    } else {
      const sel = selectTargetRelease(manifest, {channel: input.channel, currentVersion: current, serverVersion: input.serverVersion, allowDowngrade: input.allowDowngrade})
      decision = sel.decision
      targetV = sel.target?.version ?? null
      reason = sel.reason
    }

    const payload = {dryRun: true, channel: input.channel, installRoot: input.installRoot, currentVersion: current, selection: {decision, targetVersion: targetV, reason}}
    if (!this.jsonEnabled()) {
      this.log(`update (dry-run) · canale ${input.channel} · attuale ${current ?? '(nessuna)'} → ${targetV ?? '—'} [${decision}]`)
      this.log(`  ${reason}`)
    }
    return payload
  }

  /** Prints the result and maps the outcome onto a shell-safe exit code. */
  private emit(input: {
    dryRun: false
    channel: ReleaseChannel
    installRoot: string
    skipServicePreflight: boolean
    result: UpdateResult
  }): unknown {
    const {result, skipServicePreflight} = input
    // CYAU-202: the outcome stays written so the beat carries it to CloseYourIt — since the update starts from
    // a timer, nobody reads it on screen any more.
    this.rememberOutcome(result)
    // The timer is reconciled only when the update really touched the service and the machine is on the right
    // version: on a failure there is nothing to turn back on.
    if (!skipServicePreflight && (result.outcome === 'updated' || result.outcome === 'up-to-date')) {
      this.reconcileAutoUpdateTimer(this.currentPlatform())
    }
    // Recovery updates only the bytes: whoever reads the outcome must know the daemon still runs on the previous one.
    const payload = {
      dryRun: input.dryRun,
      channel: input.channel,
      installRoot: input.installRoot,
      serviceReconciliation: skipServicePreflight ? 'skipped' : 'applied',
      result,
    }
    if (!this.jsonEnabled()) {
      this.printResult(result)
      // The result decides the prompts: on a failed or rolled-back outcome there is nothing to reconcile.
      if (skipServicePreflight) {
        for (const hint of result.reasons.filter((reason) => RECOVERY_HINTS.has(reason))) this.log(`  ${hint}`)
      }
    }

    // updated / up-to-date → success (exit 0). `busy` exits 0 too: postponing is the expected behaviour,
    // and a timer marking itself failed at every long run would be an alarm without a fault.
    if (result.outcome === 'updated' || result.outcome === 'up-to-date' || result.outcome === 'busy') return payload

    // "Gate" outcomes: not a success, but not all operational errors. Distinct codes and exits for the audit.
    const error =
      result.outcome === 'incompatible'
        ? new AutomatorError(ErrorCodes.Update.incompatible, result.reason, 3)
        : result.outcome === 'rolled-back'
          ? new AutomatorError(ErrorCodes.Update.rolledBack, result.reason, 3)
          : new AutomatorError(ErrorCodes.Update.failed, result.reason, 1)

    if (this.jsonEnabled()) this.logJson({...payload, error: {code: error.code, message: error.message}})
    throw error
  }

  private printResult(result: UpdateResult): void {
    this.log(`update · canale ${result.channel} · ${result.outcome.toUpperCase()}`)
    this.log(`  ${result.fromVersion ?? '(nessuna)'} → ${result.toVersion ?? '—'}`)
    this.log(`  ${result.reason}`)
    if (result.verified) this.log('  checksum verificato')
    if (result.rolledBack) this.log('  ripristinata la versione precedente (nessuna run persa)')
  }
}
