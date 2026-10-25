import * as fs from 'node:fs'
import {Flags} from '@oclif/core'
import {BaseCommand} from '../base'
import {AgentRunResultSchema} from '../lib/agent-result'
import {
  type DefaultProbeOptions,
  type DeliveryProbe,
  type DeliveryResult,
  defaultDeliveryProbe,
  planDelivery,
  type PrContent,
  type PrTests,
  prContentFromResult,
  runDelivery,
} from '../lib/deliver'
import {AutomatorError, ErrorCodes} from '../errors/error-codes'

export default class Deliver extends BaseCommand {
  static description =
    'Consegna la lavorazione per la review umana (CYAU-24): quando i gate automatici sono verdi, pusha il branch consentito (solo ticket/*), apre la PR con `gh` in modo non interattivo (riepilogo, test, rischi nel body), e collega ticket ↔ PR. Lo stato del ticket lo decide il server quando registra la consegna, non questo comando (CYAU-174). Nessun merge automatico, nessuna risoluzione automatica. Gate shell safe-by-default: consegnato → exit 0; gate non verdi → exit 3 (non consegnare); branch non consegnabile/input non valido → exit 2; comando (git/gh/cyi) fallito → exit 1'

  static examples = [
    '<%= config.bin %> deliver --ticket CYAU-24 --branch ticket/CYAU-24 --project CYAU --cwd /path/al/worktree --gate-passed --result-file result.json',
    '<%= config.bin %> deliver --ticket CYAU-24 --branch ticket/CYAU-24 --project CYAU --summary "..." --risk "..." --dry-run',
  ]

  static flags = {
    ticket: Flags.string({description: 'codice del ticket (es. CYAU-24)', required: true}),
    branch: Flags.string({description: 'branch da consegnare: deve essere ticket/<ticket> (push consentito solo lì)', required: true}),
    project: Flags.string({description: 'project-key CloseYourIt per i comandi cyi (commento + transizione di stato)', required: true}),
    cwd: Flags.string({description: 'worktree dove eseguire git/gh (default: cwd corrente)', default: '.'}),
    base: Flags.string({description: 'branch base della PR (default: main)', default: 'main'}),
    remote: Flags.string({description: 'remote verso cui pushare (default: origin)', default: 'origin'}),
    'gate-passed': Flags.boolean({
      description: 'conferma che i gate automatici sono verdi: senza, non si consegna (safe-by-default)',
      default: false,
    }),
    'result-file': Flags.string({description: 'file JSON con l\'esito uniforme dell\'agente (AgentRunResult): riempie riepilogo/test/rischi'}),
    summary: Flags.string({description: 'riepilogo per il body della PR (override del result-file)'}),
    risk: Flags.string({description: 'un rischio per il body della PR (ripetibile; override del result-file)', multiple: true}),
    'tests-passed': Flags.integer({description: 'numero di test passati riportati nel body della PR'}),
    'tests-failed': Flags.integer({description: 'numero di test falliti riportati nel body della PR'}),
    'test-summary': Flags.string({description: 'riepilogo testuale dell\'esito dei test'}),
    'changed-file': Flags.string({description: 'un file modificato da elencare nella PR (ripetibile)', multiple: true}),
    title: Flags.string({description: 'titolo della PR (override del titolo derivato dal riepilogo)'}),
    'dry-run': Flags.boolean({description: 'mostra il piano (branch, titolo, body) senza pushare né aprire la PR', default: false}),
  }

  /** Builds the real probe (git/gh/cyi). Overridable in tests to inject a fake probe. */
  protected makeProbe(opts: DefaultProbeOptions): DeliveryProbe {
    return defaultDeliveryProbe(opts)
  }

  async run(): Promise<unknown> {
    const {flags} = await this.parse(Deliver)
    const content = this.resolveContent(flags)

    if (flags['dry-run']) {
      // planDelivery validates the branch (exit 2 when not deliverable) and composes title/body without running anything.
      const plan = planDelivery({content, branch: flags.branch, base: flags.base, titleOverride: flags.title})
      if (!this.jsonEnabled()) this.printPlan(plan.branch, plan.base, plan.title, plan.body)
      return {dryRun: true, ticket: plan.ticket, branch: plan.branch, base: plan.base, title: plan.title, body: plan.body, autoMerge: plan.autoMerge}
    }

    const probe = this.makeProbe({project: flags.project})

    try {
      const result = runDelivery(
        {
          content,
          branch: flags.branch,
          cwd: flags.cwd,
          gatePassed: flags['gate-passed'],
          base: flags.base,
          remote: flags.remote,
          titleOverride: flags.title,
        },
        probe,
      )

      if (!this.jsonEnabled()) this.printResult(result)
      return {dryRun: false, ...result}
    } catch (error) {
      // The "do not deliver" gate (gates not green, exit 3) emits the payload with the error on stdout in --json, like
      // the other gates (cycle/gate): oclif suppresses stderr in JSON. The other errors (input exit 2, command exit 1)
      // are left to the BaseCommand catch (stderr, `code: message`).
      if (error instanceof AutomatorError && error.exitCode === 3 && this.jsonEnabled()) {
        this.logJson({dryRun: false, ticket: flags.ticket, branch: flags.branch, error: {code: error.code, message: error.message}})
      }

      throw error
    }
  }

  /** Composes the PR content: from --result-file (agent outcome) and/or from the flags, with the flags as override. */
  private resolveContent(flags: {
    ticket: string
    'result-file'?: string
    summary?: string
    risk?: string[]
    'tests-passed'?: number
    'tests-failed'?: number
    'test-summary'?: string
    'changed-file'?: string[]
  }): PrContent {
    const fromResult = flags['result-file'] ? this.loadResultFile(flags['result-file'], flags.ticket) : null

    const summary = flags.summary ?? fromResult?.summary ?? null
    const risks = flags.risk ?? fromResult?.risks ?? []
    const changedFiles = flags['changed-file'] ?? fromResult?.changedFiles

    const tests = this.resolveTests(flags, fromResult?.tests ?? null)

    return {ticket: flags.ticket, summary, tests, risks, changedFiles}
  }

  /** The test outcome from the flags (if at least one is given) or the one from the result-file. Neither → null. */
  private resolveTests(
    flags: {'tests-passed'?: number; 'tests-failed'?: number; 'test-summary'?: string},
    fallback: PrTests | null,
  ): PrTests | null {
    const hasFlag = flags['tests-passed'] !== undefined || flags['tests-failed'] !== undefined || flags['test-summary'] !== undefined
    if (!hasFlag) return fallback
    const passed = flags['tests-passed'] ?? null
    const failed = flags['tests-failed'] ?? null
    // Input defence, consistent with AgentReportSchema (nonnegative): a negative count is absurd data.
    if ((passed !== null && passed < 0) || (failed !== null && failed < 0)) {
      throw this.invalidInput('I conteggi dei test (--tests-passed / --tests-failed) non possono essere negativi')
    }

    return {passed, failed, summary: flags['test-summary'] ?? null}
  }

  /** Reads the result-file (AgentRunResult JSON) and derives the PR content from it. Invalid input → exit 2. */
  private loadResultFile(file: string, ticket: string): PrContent {
    let raw: string
    try {
      raw = fs.readFileSync(file, 'utf8')
    } catch {
      throw this.invalidInput(`--result-file non leggibile: ${file}`)
    }

    let parsed: unknown
    try {
      parsed = JSON.parse(raw)
    } catch {
      throw this.invalidInput(`--result-file non è JSON valido: ${file}`)
    }

    const result = AgentRunResultSchema.safeParse(parsed)
    if (!result.success) {
      throw this.invalidInput(`--result-file non è un esito agente valido (AgentRunResult): ${file}`)
    }

    return prContentFromResult(ticket, result.data)
  }

  private invalidInput(message: string): AutomatorError {
    return new AutomatorError(ErrorCodes.Deliver.invalidInput, message, 2)
  }

  private printPlan(branch: string, base: string, title: string, body: string): void {
    this.log(`deliver · dry-run · ${branch} → ${base} (nessun merge automatico)`)
    this.log(`  titolo PR: ${title}`)
    this.log('  body PR:')
    for (const line of body.split('\n')) this.log(`    ${line}`)
  }

  private printResult(result: DeliveryResult): void {
    this.log(`deliver · ${result.ticket} · ${result.branch} → ${result.base}`)
    this.log(`  push: ${result.pushed ? 'ok' : 'no'} · PR: ${result.prCreated ? 'aperta' : 'riusata'} ${result.prUrl}`)
    // CYAU-174 — a status this program did not set is no longer declared: the server decides it
    // when it records the delivery. Saying it here would be a line asserting someone else's fact.
    this.log(`  merge automatico: no`)
    this.log('  motivazioni:')
    for (const reason of result.reasons) this.log(`    - ${reason}`)
  }
}
