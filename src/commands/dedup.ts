import {Flags} from '@oclif/core'
import {BaseCommand} from '../base'
import {
  type DedupInput,
  type DedupResult,
  DEFAULT_SIMILARITY_THRESHOLDS,
  defaultTicketSearch,
  runDedup,
  type SimilarityThresholds,
  type TicketSearch,
} from '../lib/dedup'
import {parseSignal} from '../lib/discovery'
import {AutomatorError, ErrorCodes} from '../errors/error-codes'

export default class Dedup extends BaseCommand {
  static description =
    'Deduplica un segnale della discovery (CYAU-29) prima di creare un ticket (CYAU-30): calcola la chiave sorgente (fingerprint da fonte + repository + stack normalizzato), cerca i ticket esistenti su CloseYourIt (ricerca CYI) e li confronta per fingerprint e similarità. Nessun ticket viene deciso senza ricerca duplicati (DoD). Esiti come gate shell safe-by-default: nessun duplicato → exit 0 (si può creare, col footer-impronta); duplicato affidabile → exit 3 (arricchisci il ticket esistente col commento composto, non creare); match ambiguo → exit 3 (resta in triage per revisione umana); input non valido → exit 2; ricerca CYI fallita → exit 1'

  static examples = [
    '<%= config.bin %> dedup --project CYAU --repository bussolabs/closeyourit --signal \'{"source":"errors","title":"500 al checkout","evidence":"42/24h","impact":"high","confidence":0.8}\' --stack "app/models/order.rb:142 charge"',
    '<%= config.bin %> dedup --project CYAU --repository bussolabs/closeyourit --source errors --title "500 al checkout" --evidence "42/24h" --impact high --confidence 0.8 --json',
  ]

  static flags = {
    project: Flags.string({description: 'project-key CloseYourIt: scope della ricerca CYI dei duplicati', required: true}),
    repository: Flags.string({description: 'repository dove il segnale è stato rilevato (parte della chiave sorgente)', required: true}),
    signal: Flags.string({description: 'il segnale della discovery come JSON ({source,title,evidence,impact,confidence,detail?})'}),
    // Alternative to --signal: compose the signal from the single flags (convenience; --signal takes precedence).
    source: Flags.string({description: 'fonte del segnale (errors|ci|uptime|performance|critical-flows); se non usi --signal'}),
    title: Flags.string({description: 'titolo del segnale; se non usi --signal'}),
    evidence: Flags.string({description: 'evidenza del segnale; se non usi --signal'}),
    impact: Flags.string({description: 'impatto del segnale (low|medium|high|critical); se non usi --signal'}),
    confidence: Flags.string({description: 'confidenza del segnale [0,1]; se non usi --signal'}),
    detail: Flags.string({description: 'dettaglio opzionale del segnale; se non usi --signal'}),
    stack: Flags.string({description: 'firma grezza dello stack/errore (normalizzata per il fingerprint); default: l\'evidenza del segnale'}),
    strong: Flags.string({description: `soglia di similarità FORTE [0,1] (default ${DEFAULT_SIMILARITY_THRESHOLDS.strong})`}),
    weak: Flags.string({description: `soglia di similarità DEBOLE [0,1] (default ${DEFAULT_SIMILARITY_THRESHOLDS.weak})`}),
    code: Flags.string({description: 'codice del ticket sorgente (solo per etichettare l\'output, es. CYAU-30)'}),
  }

  /** Builds the real CYI search probe (cyi tickets list). Overridable in tests to inject a fake one. */
  protected makeSearch(): TicketSearch {
    return defaultTicketSearch()
  }

  async run(): Promise<unknown> {
    const {flags} = await this.parse(Dedup)

    const input: DedupInput = {
      project: flags.project,
      signal: this.resolveSignal(flags),
      repository: flags.repository,
      stack: flags.stack ?? null,
      thresholds: this.resolveThresholds(flags),
    }

    // runDedup validates the input (exit 2), ALWAYS runs the CYI search (the real probe fails with exit 1) and decides.
    const result = runDedup(input, this.makeSearch())
    if (!this.jsonEnabled()) this.printResult(result)

    const payload = {code: flags.code ?? null, ...result}

    // Safe-by-default shell gate (like publish/book/cycle): ONLY `create` is green (exit 0). A reliable duplicate
    // or an ambiguous match must NOT lead to creating a ticket → dedicated exit 3. The payload (target/comment for
    // enrichment, candidates for triage) stays on stdout even with --json (oclif suppresses stderr in JSON).
    if (result.decision === 'enrich') {
      const error = new AutomatorError(
        ErrorCodes.Dedup.duplicateFound,
        `Duplicato affidabile del ticket ${result.target}: arricchisci quello col commento, non creare — non procedere`,
        3,
      )
      if (this.jsonEnabled()) this.logJson({...payload, error: {code: error.code, message: error.message}})
      throw error
    }

    if (result.decision === 'triage') {
      const error = new AutomatorError(
        ErrorCodes.Dedup.ambiguousMatch,
        `Match ambiguo (${result.candidates.length} candidati): resta in triage per revisione umana — non procedere`,
        3,
      )
      if (this.jsonEnabled()) this.logJson({...payload, error: {code: error.code, message: error.message}})
      throw error
    }

    return payload
  }

  /** The signal from --signal (JSON) or from the single flags, validated with the discovery schema (untrusted input). */
  private resolveSignal(flags: DedupFlags): DedupInput['signal'] {
    let raw: unknown
    if (flags.signal !== undefined) {
      raw = this.parseJson(flags.signal, 'segnale')
    } else {
      raw = {
        source: flags.source,
        title: flags.title,
        evidence: flags.evidence,
        impact: flags.impact,
        confidence: flags.confidence === undefined ? undefined : Number(flags.confidence),
        ...(flags.detail !== undefined ? {detail: flags.detail} : {}),
      }
    }

    try {
      return parseSignal(raw)
    } catch (error) {
      // parseSignal throws an AutomatorError of the discovery domain: remap it onto the dedup domain (it is an input of
      // this command), keeping the message and exit 2 (as cycle remaps parseFinding).
      throw this.invalidInput((error as Error).message)
    }
  }

  /** Similarity thresholds from the flags (or the defaults), validated by assertThresholds inside runDedup (exit 2). */
  private resolveThresholds(flags: DedupFlags): SimilarityThresholds {
    return {
      strong: flags.strong === undefined ? DEFAULT_SIMILARITY_THRESHOLDS.strong : Number(flags.strong),
      weak: flags.weak === undefined ? DEFAULT_SIMILARITY_THRESHOLDS.weak : Number(flags.weak),
    }
  }

  private parseJson(text: string, what: string): unknown {
    try {
      return JSON.parse(text)
    } catch {
      throw this.invalidInput(`${what} non è JSON valido`)
    }
  }

  private invalidInput(message: string): AutomatorError {
    return new AutomatorError(ErrorCodes.Dedup.invalidInput, message, 2)
  }

  private printResult(result: DedupResult): void {
    this.log(`dedup · ${result.decision.toUpperCase()} · fingerprint ${result.fingerprint} · repository ${result.repository}`)
    if (result.decision === 'enrich') this.log(`  arricchisci il ticket ${result.target} (non creare un duplicato)`)
    if (result.candidates.length > 0) {
      this.log('  candidati:')
      for (const c of result.candidates) {
        this.log(`    - ${c.code} «${c.title}» (${c.matchType}, similarità ${c.similarity.toFixed(2)}, stato ${c.status ?? 'n/d'})`)
      }
    }

    this.log('  motivazioni:')
    for (const reason of result.reasons) this.log(`    - ${reason}`)
    if (result.enrichmentComment !== null) {
      this.log('  commento di arricchimento (da postare sul ticket esistente):')
      for (const line of result.enrichmentComment.split('\n')) this.log(`    ${line}`)
    }
  }
}

/** Shape of the parsed flags used by the private helpers (avoids repeating oclif's inference). */
interface DedupFlags {
  project: string
  repository: string
  signal?: string
  source?: string
  title?: string
  evidence?: string
  impact?: string
  confidence?: string
  detail?: string
  stack?: string
  strong?: string
  weak?: string
  code?: string
}
