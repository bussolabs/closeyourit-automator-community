import {readFileSync} from 'node:fs'
import {Flags} from '@oclif/core'
import {BaseCommand} from '../base'
import {
  assertBudget,
  buildDiscoveryRole,
  DEFAULT_DISCOVERY_BUDGET,
  type DiscoveryBudget,
  type DiscoveryReport,
  type DiscoveryRole,
  type DiscoverySignal,
  type DiscoverySource,
  DISCOVERY_SOURCES,
  evaluateDiscovery,
  isDiscoverySource,
  parseSignal,
} from '../lib/discovery'
import {isRuntimeId, RUNTIME_IDS} from '../lib/route'
import {AutomatorError, ErrorCodes} from '../errors/error-codes'

export default class Discovery extends BaseCommand {
  static description =
    'Ruolo read-only per la bug discovery (CYAU-29): cerca problemi reali senza modificare il codice. Con --runtime + --role definisce il ruolo discovery per un runtime — permission mode read-only (plan per claude, read-only per codex), sorgenti consentite (errori/CI/uptime/performance/flussi critici) e budget — separato dal ticket worker (non modifica file, non apre PR). Senza --role valuta i segnali grezzi dell\'agente (--signal/--signals-file): valida lo schema fonte/evidenza/impatto/confidenza (DoD) e applica il budget, tenendo i più impattanti e confidenti. Produce segnali → exit 0; input non valido → exit 2'

  static examples = [
    '<%= config.bin %> discovery --role --runtime claude',
    '<%= config.bin %> discovery --role --runtime codex --source errors --source performance --max-signals 5 --json',
    '<%= config.bin %> discovery --signal \'{"source":"errors","title":"500 al checkout","evidence":"42/24h","impact":"high","confidence":0.8}\' --json',
    '<%= config.bin %> discovery --signals-file signals.json --min-confidence 0.6 --json',
  ]

  static flags = {
    code: Flags.string({description: 'codice del ticket (solo per etichettare l\'output, es. CYAU-29)'}),
    role: Flags.boolean({description: 'definisce e mostra il ruolo discovery read-only per --runtime', default: false}),
    runtime: Flags.string({description: `runtime del ruolo discovery (${RUNTIME_IDS.join(', ')}); richiesto con --role`}),
    source: Flags.string({
      description: `sorgenti consentite del ruolo (ripetibile; ${DISCOVERY_SOURCES.join(', ')}); default: tutte`,
      multiple: true,
    }),
    signal: Flags.string({description: 'un segnale grezzo in JSON da valutare (ripetibile)', multiple: true}),
    'signals-file': Flags.string({description: 'file con un array JSON di segnali da valutare'}),
    'max-signals': Flags.integer({description: `budget: numero massimo di segnali per run (default ${DEFAULT_DISCOVERY_BUDGET.maxSignals})`}),
    'min-confidence': Flags.string({
      description: `budget: confidenza minima [0,1] sotto cui un segnale è rumore (default ${DEFAULT_DISCOVERY_BUDGET.minConfidence})`,
    }),
  }

  async run(): Promise<unknown> {
    const {flags} = await this.parse(Discovery)

    // The budget comes from the CLI (untrusted): validated BEFORE any use (assertBudget → exit 2 on NaN/out of range).
    const budget = this.resolveBudget(flags['max-signals'], flags['min-confidence'])

    // Two modes: --role DEFINES the read-only role (the runtime is needed for the permission mode); otherwise the
    // agent's raw signals are EVALUATED against the budget. No go/no-go gate: discovery produces signals.
    return flags.role ? this.runRole(flags, budget) : this.runSignals(flags, budget)
  }

  /** Role mode: builds the read-only discovery role for the runtime (--role requires --runtime). */
  private runRole(flags: DiscoveryFlags, budget: DiscoveryBudget): unknown {
    if (flags.runtime === undefined) {
      throw this.invalidInput('--role richiede --runtime (claude|codex) per il permission mode read-only')
    }

    if (!isRuntimeId(flags.runtime)) {
      throw this.invalidInput(`Runtime non riconosciuto: "${flags.runtime}" (attesi: ${RUNTIME_IDS.join(', ')})`)
    }

    const role = buildDiscoveryRole(flags.runtime, {sources: this.resolveSources(flags.source), budget})
    if (!this.jsonEnabled()) this.printRole(role)
    return {code: flags.code ?? null, ...role}
  }

  /** Signals mode: collects the raw signals, validates them (DoD schema) and applies the budget. */
  private runSignals(flags: DiscoveryFlags, budget: DiscoveryBudget): unknown {
    const signals = this.collectRawSignals(flags).map((raw) => parseSignal(raw))
    const report = evaluateDiscovery(signals, budget)
    if (!this.jsonEnabled()) this.printReport(report)
    return {code: flags.code ?? null, ...report}
  }

  /** The budget from the flags (or the defaults), validated: maxSignals positive integer, minConfidence in [0,1]. */
  private resolveBudget(maxSignals: number | undefined, minConfidence: string | undefined): DiscoveryBudget {
    const budget: DiscoveryBudget = {
      maxSignals: maxSignals ?? DEFAULT_DISCOVERY_BUDGET.maxSignals,
      minConfidence: minConfidence === undefined ? DEFAULT_DISCOVERY_BUDGET.minConfidence : Number(minConfidence),
    }
    assertBudget(budget) // NaN (non-numeric --min-confidence) and out of range → exit 2
    return budget
  }

  /** The validated allowed sources (untrusted CLI input), or `undefined` for the default (all). */
  private resolveSources(flag: string[] | undefined): DiscoverySource[] | undefined {
    if (!flag || flag.length === 0) return undefined
    const sources: DiscoverySource[] = []
    for (const value of flag) {
      if (!isDiscoverySource(value)) {
        throw this.invalidInput(`Sorgente non riconosciuta: "${value}" (attese: ${DISCOVERY_SOURCES.join(', ')})`)
      }

      sources.push(value)
    }

    return sources
  }

  /** Collects the raw signals from --signal (inline JSON, repeatable) and --signals-file (JSON array). */
  private collectRawSignals(flags: DiscoveryFlags): unknown[] {
    const raws: unknown[] = []
    for (const value of flags.signal ?? []) raws.push(this.parseJson(value, 'segnale'))
    if (flags['signals-file'] !== undefined) {
      const parsed = this.parseJson(this.readFile(flags['signals-file']), 'file dei segnali')
      if (!Array.isArray(parsed)) throw this.invalidInput('Il file dei segnali deve contenere un array JSON di segnali')
      raws.push(...parsed)
    }

    return raws
  }

  private parseJson(text: string, what: string): unknown {
    try {
      return JSON.parse(text)
    } catch {
      throw this.invalidInput(`${what} non è JSON valido`)
    }
  }

  private readFile(path: string): string {
    try {
      return readFileSync(path, 'utf8')
    } catch {
      throw this.invalidInput(`File dei segnali illeggibile: ${path}`)
    }
  }

  private invalidInput(message: string): AutomatorError {
    return new AutomatorError(ErrorCodes.Discovery.invalidInput, message, 2)
  }

  private printRole(role: DiscoveryRole): void {
    this.log(`discovery · ruolo ${role.role} · runtime ${role.runtime} · permission mode ${role.permissionMode} (read-only)`)
    this.log(`  può modificare file: ${role.canModifyFiles ? 'sì' : 'no'} · può aprire PR: ${role.canOpenPr ? 'sì' : 'no'}`)
    this.log(`  sorgenti consentite: ${role.allowedSources.join(', ')}`)
    this.log(`  budget: max ${role.budget.maxSignals} segnali, confidenza minima ${role.budget.minConfidence}`)
    this.log('  motivazioni:')
    for (const reason of role.reasons) this.log(`    - ${reason}`)
  }

  private printReport(report: DiscoveryReport): void {
    this.log(`discovery · segnali accettati ${report.accepted.length} · scartati ${report.dropped.length}`)
    for (const s of report.accepted) this.printSignal(s)
    if (report.dropped.length > 0) {
      this.log('  scartati:')
      for (const d of report.dropped) this.log(`    - ${d.signal.title}: ${d.reason}`)
    }

    this.log('  motivazioni:')
    for (const reason of report.reasons) this.log(`    - ${reason}`)
  }

  private printSignal(s: DiscoverySignal): void {
    this.log(`  - [${s.impact}] ${s.title} (fonte ${s.source}, confidenza ${s.confidence})`)
    this.log(`      evidenza: ${s.evidence}`)
  }
}

/** Shape of the parsed flags used by the private helpers (avoids repeating oclif's inference). */
interface DiscoveryFlags {
  code?: string
  role: boolean
  runtime?: string
  source?: string[]
  signal?: string[]
  'signals-file'?: string
  'max-signals'?: number
  'min-confidence'?: string
}
