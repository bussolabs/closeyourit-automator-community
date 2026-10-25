import {Args, Flags} from '@oclif/core'
import {BaseCommand} from '../base'
import {
  countCycles,
  type CycleDecision,
  type CycleSummary,
  DEFAULT_CYCLE_LIMIT,
  evaluateCycle,
  summarizeCycle,
} from '../lib/cycle'
import {isReviewVerdict, parseFinding, type ReviewFinding, REVIEW_VERDICTS, type ReviewVerdictLabel} from '../lib/review'
import {readRunAtomically, runPath} from '../lib/state'
import {AutomatorError, ErrorCodes} from '../errors/error-codes'

export default class Cycle extends BaseCommand {
  static description =
    'Applica il limite di implementazione e review a due cicli (CYAU-21): dato il verdetto della review corrente e i contatori derivati dallo storico persistito della lavorazione (runs/<run-id>.json, non si resettano al riavvio), decide se la lavorazione può proseguire in automatico — approvata → avanza (in_review); modifiche sotto il budget → altro giro (implementing) — o se ha superato i due cicli e richiede intervento umano (blocked). Conserva i rilievi irrisolti in un riepilogo da commentare sul ticket. Può proseguire → exit 0; serve intervento umano → exit 3 (non procedere); input non valido → exit 2'

  static examples = [
    '<%= config.bin %> cycle run-42 --verdict changes_requested --code CYAU-21',
    '<%= config.bin %> cycle run-42 --verdict changes_requested --finding \'{"severity":"major","aspect":"tests","title":"manca test"}\'',
    '<%= config.bin %> cycle run-42 --verdict approved --json',
    '<%= config.bin %> cycle run-42 --verdict changes_requested --limit 3',
  ]

  static args = {
    'run-id': Args.string({description: 'identificativo stabile della lavorazione (nome del file di checkpoint)', required: true}),
  }

  static flags = {
    verdict: Flags.string({
      description: `il verdetto della review corrente (${REVIEW_VERDICTS.join(', ')})`,
      required: true,
    }),
    code: Flags.string({description: 'codice del ticket (etichetta l\'output e il riepilogo, es. CYAU-21)'}),
    finding: Flags.string({
      description: 'un rilievo dell\'ultima review come JSON ({"severity","title","aspect?","detail?"}), ripetibile: conservato nel riepilogo',
      multiple: true,
    }),
    limit: Flags.integer({description: `budget di cicli automatici (default ${DEFAULT_CYCLE_LIMIT})`, default: DEFAULT_CYCLE_LIMIT}),
  }

  async run(): Promise<unknown> {
    const {args, flags} = await this.parse(Cycle)
    const runId = args['run-id']
    // Validate the run-id (file name) BEFORE any I/O: a hostile run-id exits cleanly (exit 2), never traversal.
    const file = runPath(runId)

    // Input defence: the verdict comes from the CLI, untrusted. A value outside the known domains exits cleanly
    // (exit 2) BEFORE reading the history, instead of being silently ignored.
    if (!isReviewVerdict(flags.verdict)) {
      throw this.invalidInput(`Verdetto non riconosciuto: "${flags.verdict}" (attesi: ${REVIEW_VERDICTS.join(', ')})`)
    }

    const verdict: ReviewVerdictLabel = flags.verdict
    const findings = this.resolveFindings(flags.finding)

    // Reads the persisted history (NOT shared with the daemon → no lost update). Read-only on the history: the
    // real transition is applied by `transition`. A corrupt file is PRESERVED (quarantine) instead of being
    // read as valid: never lose work, never a count from broken data (treated as a new run).
    const now = new Date()
    const {run, corrupt, quarantined} = readRunAtomically(file, now.toISOString().replace(/[:.]/g, '-'))
    const source = corrupt ? null : run

    const counts = countCycles(source)
    // Current cycle = the review cycles recorded in the history. Evaluating a verdict implies that at least the
    // current review happened → the current cycle is ≥ 1 even if the `reviewing` checkpoint were not (yet)
    // recorded (defensive off-by-one: never count zero cycles while judging a review).
    const cycle = Math.max(counts.reviewCycles, 1)

    const decision = evaluateCycle({verdict, cycle, limit: flags.limit})
    const ticket = flags.code ?? source?.ticket ?? null
    const summary = summarizeCycle(decision, {ticket, attempts: counts.attempts, findings})

    const payload = {
      runId,
      ticket,
      quarantined,
      verdict: decision.verdict,
      cycle: decision.cycle,
      limit: decision.limit,
      attempts: counts.attempts,
      reviewCycles: counts.reviewCycles,
      limitReached: decision.limitReached,
      requiresHuman: decision.requiresHuman,
      next: decision.next,
      reasons: decision.reasons,
      summary: summary.text,
      outstandingFindings: summary.outstandingFindings,
    }

    if (!this.jsonEnabled()) {
      if (quarantined) this.log(`file di stato precedente corrotto → preservato in ${quarantined}`)
      this.printDecision(runId, decision, summary)
    }

    // Safe-by-default shell gate (like review/lease): if the run needs human intervention — budget exhausted
    // (DoD: no more than two cycles) or a blocker finding — do NOT proceed automatically → dedicated exit 3. The summary
    // stays available (in the payload with --json, printed above in human mode) so unresolved findings are
    // kept for the ticket comment.
    if (decision.requiresHuman) {
      const error = new AutomatorError(ErrorCodes.Cycle.limitReached, `${this.gateMessage(decision)} — non procedere`, 3)
      if (this.jsonEnabled()) this.logJson({...payload, error: {code: error.code, message: error.message}})
      throw error
    }

    return payload
  }

  /** Findings from the --finding flags: each value is validated JSON (severity/aspect/title). Malformed → exit 2. */
  private resolveFindings(flag: string[] | undefined): ReviewFinding[] {
    const findings: ReviewFinding[] = []
    for (const raw of flag ?? []) {
      let parsed: unknown
      try {
        parsed = JSON.parse(raw)
      } catch {
        throw this.invalidInput(`Rilievo non è JSON valido: ${raw}`)
      }

      try {
        findings.push(parseFinding(parsed))
      } catch (error) {
        // Remap the review domain error (parseFinding always throws an AutomatorError) onto the cycle command
        // domain, keeping the message and exit 2: it is an input of the cycle command.
        throw this.invalidInput((error as Error).message)
      }
    }

    return findings
  }

  /** The gate message: distinguishes the limit reached (the ticket's case) from a blocker finding. */
  private gateMessage(decision: CycleDecision): string {
    if (decision.limitReached) {
      return `Superato il budget di ${decision.limit} cicli automatici senza approvazione (ciclo ${decision.cycle}): il ticket richiede intervento umano`
    }

    return `La review richiede intervento umano al ciclo ${decision.cycle} (rilievo blocker)`
  }

  private invalidInput(message: string): AutomatorError {
    return new AutomatorError(ErrorCodes.Cycle.invalidInput, message, 2)
  }

  private printDecision(runId: string, d: CycleDecision, summary: CycleSummary): void {
    const flag = d.requiresHuman ? ' · INTERVENTO UMANO' : ''
    this.log(`cycle ${runId} · verdetto ${d.verdict.toUpperCase()} · ciclo ${d.cycle}/${d.limit} → ${d.next}${flag}`)
    this.log('  motivazioni:')
    for (const reason of d.reasons) this.log(`    - ${reason}`)
    // The summary (with the unresolved findings) is what the orchestrator keeps in the ticket.
    this.log('  riepilogo:')
    for (const line of summary.text.split('\n')) this.log(`    ${line}`)
  }
}
