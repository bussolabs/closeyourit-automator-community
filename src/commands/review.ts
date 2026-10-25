import {Flags} from '@oclif/core'
import {performance} from 'node:perf_hooks'
import {BaseCommand} from '../base'
import {isRuntimeId, RUNTIME_IDS, type RuntimeAvailability, type RuntimeId} from '../lib/route'
import {
  decideVerdict,
  type ReviewOptions,
  type ReviewerSelection,
  type ReviewVerdict,
  selectReviewer,
} from '../lib/review'
import {
  executeChunkedCrossReview,
  resolveReviewDiff,
  ReviewSnapshotExecutionError,
  type ReviewExecutionResult,
} from '../lib/review-execution'
import {AutomatorError, ErrorCodes} from '../errors/error-codes'

export default class Review extends BaseCommand {
  static description =
    'Esegue DAVVERO la revisione incrociata di una lavorazione (CYAU-20/45): seleziona il runtime diverso dall’implementatore, gli passa requisiti+test+rischi+base+diff in modalità read-only, valida il report JSON e solo allora deriva approved / changes_requested / blocked. Unavailable, timeout, cancellazione, exit nonzero o output malformato sono sempre blocked. Con --select mostra soltanto la selezione senza eseguire né approvare.'

  static examples = [
    '<%= config.bin %> review --implementer claude --select',
    '<%= config.bin %> review --implementer claude --base main --requirements "criteri" --tests "suite verde" --risks "nessuno noto" --json',
    '<%= config.bin %> review --implementer codex --reviewer claude --base origin/main --requirements "DoD" --tests "gate verdi" --risks "valutati" --code CYAU-20',
  ]

  static flags = {
    implementer: Flags.string({
      description: `il runtime che ha implementato la lavorazione (${RUNTIME_IDS.join(', ')}): il reviewer sarà l'altro`,
      required: true,
    }),
    code: Flags.string({description: 'codice del ticket (solo per etichettare l\'output, es. CYAU-20)'}),
    select: Flags.boolean({
      description: 'stampa solo il reviewer selezionato e gli aspetti da valutare, senza calcolare il verdetto',
      default: false,
    }),
    base: Flags.string({description: 'commit/ref base del diff da revisionare (obbligatoria salvo --select)'}),
    requirements: Flags.string({description: 'snapshot completo di requisiti, analisi tecnica e criteri di accettazione'}),
    tests: Flags.string({description: 'evidenza dei test e quality gate realmente eseguiti'}),
    risks: Flags.string({description: 'valutazione esplicita dei rischi residui (anche “nessuno noto”)'}),
    timeout: Flags.integer({description: 'timeout massimo del reviewer in secondi', default: 300, min: 1, max: 3600}),
    reviewer: Flags.string({
      description: `override umano: forza il reviewer (deve essere diverso dall'implementatore) (${RUNTIME_IDS.join(', ')})`,
    }),
    unavailable: Flags.string({
      description: `marca un runtime come indisponibile per la selezione del reviewer (ripetibile, da doctor) (${RUNTIME_IDS.join(', ')})`,
      multiple: true,
    }),
    prefer: Flags.string({
      description: `preferenza tra i candidati reviewer (ripetibile) (${RUNTIME_IDS.join(', ')})`,
      multiple: true,
    }),
  }

  async run(): Promise<unknown> {
    const {flags} = await this.parse(Review)

    // Input defence: implementer/reviewer/runtime come from the CLI, untrusted. A value outside the known domains
    // exits cleanly (exit 2) BEFORE reviewing, instead of being silently ignored.
    if (!isRuntimeId(flags.implementer)) {
      throw this.invalidInput(`Implementatore non riconosciuto: "${flags.implementer}" (attesi: ${RUNTIME_IDS.join(', ')})`)
    }

    const implementer: RuntimeId = flags.implementer
    const options: ReviewOptions = {
      availability: this.resolveAvailability(flags.unavailable),
      preference: this.resolveRuntimes(flags.prefer, 'preferenza'),
      override: this.resolveOverride(flags.reviewer),
    }

    if (flags.select) return this.runSelect(flags.code, implementer, options)
    if (!flags.base || flags.base.trim() === '') throw this.invalidInput('--base è obbligatoria per eseguire la review')
    if (!flags.requirements || flags.requirements.trim() === '') {
      throw this.invalidInput('--requirements è obbligatorio per verificare i requisiti della review')
    }
    if (!flags.tests || flags.tests.trim() === '') throw this.invalidInput('--tests è obbligatorio come evidenza dei gate')
    if (!flags.risks || flags.risks.trim() === '') throw this.invalidInput('--risks è obbligatorio come valutazione dei rischi')
    const requirements = this.reviewContext(flags.requirements, 'requirements')
    const testEvidence = this.reviewContext(flags.tests, 'tests')
    const riskAssessment = this.reviewContext(flags.risks, 'risks')
    return this.runExecutedVerdict(
      flags.code,
      implementer,
      flags.base,
      requirements,
      testEvidence,
      riskAssessment,
      flags.timeout,
      options,
    )
  }

  /**
   * Selection mode: who reviews (different runtime) and what to evaluate (read-only). Gate: if no different
   * reviewer is available cross review is impossible → blocked, dedicated exit 3 (like `route`/`lease`)
   * so a shell gate does not continue without cross review (human review remains). An override equal
   * to the implementer is already rejected by `selectReviewer` (exit 2).
   */
  private runSelect(code: string | undefined, implementer: RuntimeId, options: ReviewOptions): unknown {
    const selection = selectReviewer(implementer, options)
    const payload = {code: code ?? null, ...selection}
    if (!this.jsonEnabled()) this.printSelection(code, selection)

    if (!selection.available) {
      const error = new AutomatorError(
        ErrorCodes.Review.blocked,
        `Nessun reviewer diverso da ${implementer} disponibile: revisione incrociata impossibile — non procedere in automatico`,
        3,
      )
      if (this.jsonEnabled()) this.logJson({...payload, error: {code: error.code, message: error.message}})
      throw error
    }

    return payload
  }

  /**
   * Verdict mode (default): structures the outcome only after the reviewer has actually run. Safe-by-default
   * shell gate: approved → exit 0; changes_requested/blocked → exit 3. The decision stays available — with
   * --json with the code in the payload (oclif suppresses stderr), in human mode printed with the code on stderr.
   */
  private async runExecutedVerdict(
    code: string | undefined,
    implementer: RuntimeId,
    base: string,
    requirements: string,
    testEvidence: string,
    riskAssessment: string,
    timeoutSeconds: number,
    options: ReviewOptions,
  ): Promise<unknown> {
    const selection = selectReviewer(implementer, options)
    const cwd = process.cwd()
    const timeoutMs = timeoutSeconds * 1000
    const deadline = performance.now() + timeoutMs
    const controller = new AbortController()
    const cancel = (): void => controller.abort()
    process.once('SIGINT', cancel)
    process.once('SIGTERM', cancel)
    let execution: ReviewExecutionResult
    let baseCommit: string | null = null
    let diff = ''
    let diffSha256 = ''
    let snapshotTree = ''
    try {
      if (!selection.available) {
        execution = {
          status: 'unavailable',
          reviewer: selection.reviewer,
          findings: [],
          detail: `reviewer diverso da ${implementer} non disponibile`,
          attestation: null,
        }
      } else {
        try {
          const snapshot = await resolveReviewDiff(base, cwd, {signal: controller.signal, timeoutMs, deadlineMs: deadline})
        baseCommit = snapshot.baseCommit
        diff = snapshot.diff
        diffSha256 = snapshot.diffSha256
        snapshotTree = snapshot.snapshotTree
        const reviewerTimeoutMs = deadline - performance.now()
        if (reviewerTimeoutMs <= 0) throw new ReviewSnapshotExecutionError('timeout')
        execution = await executeChunkedCrossReview({
          implementer,
          selection,
          base,
          baseCommit,
          diff,
          diffSha256,
          snapshotTree,
          requirements,
          testEvidence,
          riskAssessment,
          cwd,
          timeoutMs: reviewerTimeoutMs,
          deadlineMs: deadline,
          code,
          signal: controller.signal,
        })
        if (execution.status === 'completed') {
          try {
            const current = await resolveReviewDiff(base, cwd, {
              signal: controller.signal,
              timeoutMs: deadline - performance.now(),
              deadlineMs: deadline,
            })
            if (
              current.baseCommit !== baseCommit ||
              current.snapshotTree !== snapshotTree ||
              current.diffSha256 !== diffSha256
            ) {
              execution = {
                status: 'failed',
                reviewer: execution.reviewer,
                findings: [],
                detail: 'snapshot Git cambiato durante la review',
                attestation: null,
              }
            }
          } catch (error) {
            execution = {
              status: error instanceof ReviewSnapshotExecutionError ? error.status : 'failed',
              reviewer: execution.reviewer,
              findings: [],
              detail: error instanceof ReviewSnapshotExecutionError
                ? error.message
                : 'snapshot Git cambiato durante la review',
              attestation: null,
            }
          }
        }
        } catch (error) {
          if (!(error instanceof ReviewSnapshotExecutionError)) throw error
          execution = {
            status: error.status,
            reviewer: selection.reviewer,
            findings: [],
            detail: error.message,
            attestation: null,
          }
        }
      }

      // Last synchronous gate before deriving/printing the verdict: from here to the output there are no awaits, so
      // an already delivered signal or an expired deadline cannot turn into an approval.
      if (execution.status === 'completed' && controller.signal.aborted) {
        execution = {
          status: 'cancelled',
          reviewer: execution.reviewer,
          findings: [],
          detail: 'review annullata prima del verdetto',
          attestation: null,
        }
      } else if (execution.status === 'completed' && performance.now() >= deadline) {
        execution = {
          status: 'timeout',
          reviewer: execution.reviewer,
          findings: [],
          detail: 'review scaduta prima del verdetto',
          attestation: null,
        }
      }

      const verdict = decideVerdict({
        implementer,
        reviewer: execution.reviewer,
        executionStatus: execution.status,
        findings: execution.findings,
      })
      const payload = {
        code: code ?? null,
        base,
        baseCommit,
        diffSha256: diffSha256 || null,
        snapshotTree: snapshotTree || null,
        execution: {status: execution.status, detail: execution.detail, attestation: execution.attestation},
        ...verdict,
      }
      if (!this.jsonEnabled()) this.printVerdict(code, verdict)

      const gate = GATE_BY_VERDICT[verdict.verdict]
      if (this.jsonEnabled()) {
        // All JSON verdicts, exit 3 included, are emitted while the listeners are still installed.
        if (gate) {
          const error = new AutomatorError(gate.code, `${gate.message} (verdetto: ${verdict.verdict}) — non procedere`, 3)
          this.logJson({...payload, error: {code: error.code, message: error.message}})
          throw error
        }
        this.logJson(payload)
        return undefined
      }
      if (gate) {
        throw new AutomatorError(gate.code, `${gate.message} (verdetto: ${verdict.verdict}) — non procedere`, 3)
      }
      return payload
    } finally {
      process.removeListener('SIGINT', cancel)
      process.removeListener('SIGTERM', cancel)
    }
  }

  /** The human reviewer override (validated), if given. */
  private resolveOverride(flag: string | undefined): {reviewer?: RuntimeId} {
    if (flag === undefined) return {}
    if (!isRuntimeId(flag)) {
      throw this.invalidInput(`Reviewer non riconosciuto: "${flag}" (attesi: ${RUNTIME_IDS.join(', ')})`)
    }

    return {reviewer: flag}
  }

  /** Runtime availability from the --unavailable flags (validated): each one marked unavailable. */
  private resolveAvailability(flag: string[] | undefined): RuntimeAvailability {
    const availability: RuntimeAvailability = {}
    for (const runtime of this.resolveRuntimes(flag, 'disponibilità')) availability[runtime] = false
    return availability
  }

  /** A list of runtimes from the flags (validated): used for both --prefer and --unavailable. */
  private resolveRuntimes(flag: string[] | undefined, kind: string): RuntimeId[] {
    const runtimes: RuntimeId[] = []
    for (const value of flag ?? []) {
      if (!isRuntimeId(value)) {
        throw this.invalidInput(`Runtime non valido nella ${kind}: "${value}" (attesi: ${RUNTIME_IDS.join(', ')})`)
      }

      runtimes.push(value)
    }

    return runtimes
  }

  private invalidInput(message: string): AutomatorError {
    return new AutomatorError(ErrorCodes.Review.invalidInput, message, 2)
  }

  private reviewContext(value: string, flag: string): string {
    if (value.includes('\0') || Buffer.byteLength(value) > 64 * 1024) {
      throw this.invalidInput(`--${flag} non valido o troppo grande (massimo 65536 byte)`)
    }
    return value.trim()
  }

  private printSelection(code: string | undefined, s: ReviewerSelection): void {
    const reviewer = s.reviewer ?? 'nessuno (indisponibile)'
    this.log(`review ${labelFor(code)} · implementatore ${s.implementer} · reviewer ${reviewer} (read-only)`)
    this.log(`  aspetti da valutare: ${s.aspects.join(', ')}`)
    this.log('  motivazioni:')
    for (const reason of s.reasons) this.log(`    - ${reason}`)
  }

  private printVerdict(code: string | undefined, v: ReviewVerdict): void {
    const reviewer = v.reviewer ?? 'nessuno'
    this.log(`review ${labelFor(code)} · verdetto ${v.verdict.toUpperCase()} · reviewer ${reviewer} (read-only)`)
    this.log(`  implementatore: ${v.implementer} · revisionato da un runtime diverso: ${v.crossReviewed ? 'sì' : 'no'}`)
    this.log(`  finding: ${v.blockingCount} bloccanti, ${v.advisoryCount} non bloccanti`)
    for (const f of v.findings) this.log(`    - [${f.severity}${f.aspect ? `/${f.aspect}` : ''}] ${f.title}`)
    this.log('  motivazioni:')
    for (const reason of v.reasons) this.log(`    - ${reason}`)
  }
}

/** The verdicts that are a gate (do not proceed): they map to the dedicated code/exit 3. `approved` is not here → exit 0. */
const GATE_BY_VERDICT: Record<string, {code: string; message: string} | undefined> = {
  changes_requested: {
    code: ErrorCodes.Review.changesRequested,
    message: 'La review chiede modifiche: rilievi bloccanti da correggere, si torna a implementare',
  },
  blocked: {
    code: ErrorCodes.Review.blocked,
    message: 'La review è bloccata: revisione incrociata impossibile o finding blocker',
  },
}

/** Labels the ticket in the output: the code if given, otherwise a generic "ticket". */
function labelFor(code: string | undefined): string {
  return code && code.trim() !== '' ? `ticket ${code}` : 'ticket'
}
