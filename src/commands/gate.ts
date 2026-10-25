import * as path from 'node:path'
import {Flags} from '@oclif/core'
import {BaseCommand} from '../base'
import {
  type CheckResult,
  defaultCheckRunner,
  type GateStage,
  type GateVerdict,
  isGateStage,
  loadQualityGate,
  type PlannedCheck,
  planGate,
  runGate,
} from '../lib/quality-gate'
import {AutomatorError, ErrorCodes} from '../errors/error-codes'
import {GATE_BUSY_LABEL, withBusyMarker} from '../lib/busy-marker'
import {redactSecrets} from '../lib/secret-redaction'

/** Default path of the quality gate config, relative to the repository root (versioned in git). */
const DEFAULT_CONFIG_REL = path.join('.closeyourit', 'quality-gate.yml')

/** Accepted shape for `--ticket`: the value ends up in a marker readable by others, it is not trusted. */
const TICKET_PATTERN = /^[\dA-Za-z][\d._A-Za-z-]{0,63}$/

export default class Gate extends BaseCommand {
  static description =
    'Esegue la parte locale del quality gate configurabile di un repository (CYAU-23/CYAU-181): legge `checks` da `.closeyourit/quality-gate.yml` — setup, unit, integration, lint, typecheck, security, full — e li esegue con mise e timeout. Nella versione 2, la sezione `remote` è attestata separatamente dal flusso Autopilot sulla PR draft e non viene simulata da questo comando. Il gate FALLISCE se una verifica OBBLIGATORIA non passa (le verifiche advisory sono segnalate ma non bloccano). Comandi e risultati sono registrati senza segreti (l\'esito non porta né env né output). Gate shell safe-by-default: superato → exit 0; una obbligatoria non passa → exit 3 (non procedere); config non valida/non trovata → exit 2'

  static examples = [
    '<%= config.bin %> gate --cwd /path/al/repo',
    '<%= config.bin %> gate --cwd /path/al/repo --only lint --only typecheck',
    '<%= config.bin %> gate --cwd /path/al/repo --dry-run',
    '<%= config.bin %> gate --config ./ci/quality-gate.yml --keep-going --json',
  ]

  static flags = {
    cwd: Flags.string({description: 'directory del repository dove eseguire le verifiche (default: cwd corrente)', default: '.'}),
    config: Flags.string({description: `file di config del quality gate (default: <cwd>/${DEFAULT_CONFIG_REL})`}),
    only: Flags.string({description: 'esegue solo le fasi indicate (ripetibile): setup|unit|integration|lint|typecheck|security|full', multiple: true}),
    ticket: Flags.string({description: 'ticket in lavorazione, dichiarato nel marcatore «cartella in uso» mentre il gate gira'}),
    'keep-going': Flags.boolean({description: 'esegue tutte le verifiche anche dopo un obbligatorio fallito (report completo, no fail-fast)', default: false}),
    'dry-run': Flags.boolean({description: 'pianifica e mostra i comandi senza eseguirli', default: false}),
  }

  async run(): Promise<unknown> {
    const {flags} = await this.parse(Gate)

    // Input defence: --only comes from the CLI, untrusted. An unknown stage exits cleanly (exit 2)
    // BEFORE reading the config, instead of silently filtering down to zero checks.
    const only = this.resolveOnly(flags.only)
    const ticket = this.resolveTicket(flags.ticket)

    const cwd = path.resolve(flags.cwd)
    const configPath = flags.config ? path.resolve(flags.config) : path.join(cwd, DEFAULT_CONFIG_REL)
    const safeCwd = redactSecrets(cwd)
    const safeConfigPath = redactSecrets(configPath)
    // loadQualityGate throws AutomatorError (exit 2): C404-GATE-003 when missing, C400-GATE-001 when invalid.
    const config = loadQualityGate(configPath)

    // --only MUST select at least one configured check: filtering to zero would be a no-op that exits 0 ("gate
    // passed") without having checked anything → misleading fail-open. An --only that matches no check
    // is a usage error (exit 2), not a passed gate.
    if (only && planGate(config, {only}).length === 0) {
      throw new AutomatorError(
        ErrorCodes.Gate.invalidConfig,
        `Nessuna verifica configurata per le fasi richieste in --only: ${only.join(', ')}`,
        2,
      )
    }

    if (flags['dry-run']) {
      const planned = planGate(config, {only})
      const payload = {
        config: safeConfigPath,
        cwd: safeCwd,
        dryRun: true,
        planned: planned.map((p) => ({stage: p.stage, required: p.required, timeout: p.timeout, command: redactSecrets(p.command)})),
      }
      if (!this.jsonEnabled()) this.printPlan(planned)
      return payload
    }

    // The folder is busy for the whole duration of the checks (CYAU-168): whoever cleans up reads the marker
    // and skips the folder instead of removing it from under a running gate. The marker only informs: if
    // it is not writable the gate runs anyway, and it is removed even when the gate fails or is cancelled.
    const report = await withBusyMarker(cwd, {label: GATE_BUSY_LABEL, ticket}, () => runGate(config, {
      runCheck: defaultCheckRunner({cwd}),
      keepGoing: flags['keep-going'],
      only,
    }))

    const {verdict} = report
    const payload = {
      config: safeConfigPath,
      cwd: safeCwd,
      dryRun: false,
      passed: verdict.passed,
      total: verdict.total,
      passedCount: verdict.passedCount,
      skipped: verdict.skipped,
      checks: report.checks,
      failedRequired: verdict.failedRequired,
      failedAdvisory: verdict.failedAdvisory,
      reasons: verdict.reasons,
    }

    if (!this.jsonEnabled()) this.printReport(report.checks, verdict)

    // Safe-by-default shell gate (like cycle/lease): a required check that did not pass fails the gate →
    // dedicated exit 3, so a shell gate does not continue to review/PR with broken checks (DoD).
    if (!verdict.passed) {
      const error = new AutomatorError(
        ErrorCodes.Gate.failed,
        `Quality gate fallito: ${verdict.failedRequired.length} verifica/e obbligatoria/e non passata/e — non procedere`,
        3,
      )
      if (this.jsonEnabled()) this.logJson({...payload, error: {code: error.code, message: error.message}})
      throw error
    }

    return payload
  }

  /** Normalizes --only into known stages; an unknown value → exit 2 (untrusted CLI input). Empty → no filter. */
  private resolveOnly(flag: string[] | undefined): GateStage[] | undefined {
    if (!flag || flag.length === 0) return undefined
    const stages: GateStage[] = []
    for (const value of flag) {
      if (!isGateStage(value)) {
        throw new AutomatorError(ErrorCodes.Gate.invalidConfig, `Fase non riconosciuta in --only: "${value}"`, 2)
      }

      stages.push(value)
    }

    return stages
  }

  /** Normalizes --ticket: a malformed value exits cleanly (exit 2) instead of ending up in the marker. */
  private resolveTicket(flag: string | undefined): string | null {
    if (flag === undefined) return null
    const ticket = flag.trim()
    if (!TICKET_PATTERN.test(ticket)) {
      throw new AutomatorError(ErrorCodes.Gate.invalidConfig, `Ticket non valido in --ticket: "${flag}"`, 2)
    }

    return ticket
  }

  private printPlan(planned: PlannedCheck[]): void {
    this.log(`quality gate · piano (${planned.length} verifiche) · dry-run`)
    for (const p of planned) this.log(`  [${p.stage}]${p.required ? '' : ' (advisory)'} timeout ${p.timeout}s · ${redactSecrets(p.command)}`)
  }

  private printReport(checks: CheckResult[], verdict: GateVerdict): void {
    const flag = verdict.passed ? 'SUPERATO' : 'FALLITO'
    this.log(`quality gate · ${flag} · ${verdict.passedCount}/${verdict.total} passate${verdict.skipped > 0 ? ` · ${verdict.skipped} saltate` : ''}`)
    for (const c of checks) {
      const mark = c.status === 'passed' ? '✓' : c.status === 'skipped' ? '·' : '✗'
      this.log(`  ${mark} [${c.stage}]${c.required ? '' : ' (advisory)'} ${c.status}${c.exitCode === null ? '' : ` (exit ${c.exitCode})`} · ${redactSecrets(c.command)}`)
    }

    this.log('  motivazioni:')
    for (const reason of verdict.reasons) this.log(`    - ${redactSecrets(reason)}`)
  }
}
