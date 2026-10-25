import {Flags} from '@oclif/core'
import {BaseCommand} from '../base'
import {
  assertKbKind,
  DEFAULT_KB_KIND,
  defaultKbPublisher,
  defaultPublishRepo,
  type KbKind,
  type KbPublisher,
  KB_KINDS,
  planPublish,
  type PublishInput,
  type PublishPlan,
  type PublishRepo,
  type PublishResult,
  runPublish,
} from '../lib/publish'
import {AutomatorError} from '../errors/error-codes'
import {redactSecrets} from '../lib/secret-redaction'

export default class Publish extends BaseCommand {
  static description =
    'Pubblica la documentazione VERSIONATA nella Knowledge CloseYourIt. Deriva una publication key stabile da progetto+fonte canonica e usa un solo publish atomico server-side (create/update/adoption idempotenti anche tra worker concorrenti), MAI delete. Appende la provenienza fonte/commit/ticket/run. Gate safe-by-default: pubblicato → exit 0; file non versionato, path sensibile o secret → exit 3; input non valido → exit 2; cyi kb publish fallito → exit 1'

  static examples = [
    '<%= config.bin %> publish --project CYAU --title "closeyourit-automator — scheduler" --source-file docs/overview.md --kind guide --ticket CYAU-27 --run-id run-1',
    '<%= config.bin %> publish --project CYAU --title "ADR: queue backend" --source-file docs/adr/queue.md --kind decision --ticket CYAU-27 --dry-run',
  ]

  static flags = {
    project: Flags.string({description: 'project-key CloseYourIt: scope della pubblicazione atomica', required: true}),
    title: Flags.string({description: 'titolo della pagina Knowledge; l’identità stabile deriva dal file sorgente', required: true}),
    'source-file': Flags.string({description: 'file sorgente VERSIONATO da cui deriva la pagina (relativo al worktree o assoluto)', required: true}),
    kind: Flags.string({description: `tipo pagina: ${KB_KINDS.join('|')}`, default: DEFAULT_KB_KIND}),
    ticket: Flags.string({description: 'codice del ticket (metadato di provenienza)', required: true}),
    'run-id': Flags.string({description: 'run-id della lavorazione (metadato di provenienza)'}),
    commit: Flags.string({description: 'commit sorgente da pubblicare (default: HEAD; stesso snapshot per blob e provenienza)'}),
    cwd: Flags.string({description: 'worktree su cui verificare git (tracked + HEAD) (default: cwd corrente)', default: '.'}),
    'dry-run': Flags.boolean({description: 'compone e mostra il body senza creare/aggiornare la pagina', default: false}),
  }

  /** Builds the real repository probe (fs + git). Overridable in tests to inject a fake one. */
  protected makeRepo(): PublishRepo {
    return defaultPublishRepo()
  }

  /** Builds the real Knowledge probe (cyi kb). Overridable in tests to inject a fake one. */
  protected makeKb(): KbPublisher {
    return defaultKbPublisher()
  }

  async run(): Promise<unknown> {
    const {flags} = await this.parse(Publish)

    // Input defence: a kind outside note|decision|guide → exit 2 with the dedicated code (not the oclif error).
    assertKbKind(flags.kind)

    const input: PublishInput = {
      project: flags.project,
      title: flags.title,
      kind: flags.kind as KbKind,
      sourceFile: flags['source-file'],
      cwd: flags.cwd,
      ticket: flags.ticket,
      runId: flags['run-id'] ?? null,
      commit: flags.commit ?? null,
    }

    const repo = this.makeRepo()

    if (flags['dry-run']) {
      // planPublish validates everything and composes the body (read-only: reads the file and checks git, does not touch the KB).
      const plan = planPublish(input, repo)
      if (!this.jsonEnabled()) this.printPlan(plan)
      return {dryRun: true, project: plan.project, title: plan.title, kind: plan.kind, sourceFile: plan.sourceFile, commit: plan.commit, publicationKey: plan.publicationKey, body: plan.body}
    }

    try {
      const result = runPublish(input, repo, this.makeKb())
      if (!this.jsonEnabled()) this.printResult(result)
      return {dryRun: false, ...result}
    } catch (error) {
      // The "do not publish" gates (unversioned file / secret, exit 3) emit the payload with the error on
      // stdout in --json, like the other gates (deliver/gate/cycle): oclif suppresses stderr in JSON. The other errors
      // (input exit 2, command exit 1) are left to the BaseCommand catch (stderr, `code: message`).
      if (error instanceof AutomatorError && error.exitCode === 3 && this.jsonEnabled()) {
        this.logJson({
          dryRun: false,
          project: redactSecrets(flags.project),
          title: redactSecrets(flags.title),
          error: {code: error.code, message: redactSecrets(error.message)},
        })
      }

      throw error
    }
  }

  private printPlan(plan: PublishPlan): void {
    this.log(`publish · dry-run · «${plan.title}» (${plan.kind}) → progetto ${plan.project}`)
    this.log(`  fonte: ${plan.sourceFile}${plan.commit ? ` @ ${plan.commit}` : ''}`)
    this.log(`  publication key: ${plan.publicationKey}`)
    this.log('  body:')
    for (const line of plan.body.split('\n')) this.log(`    ${line}`)
  }

  private printResult(result: PublishResult): void {
    this.log(`publish · ${result.action} · «${result.title}» (${result.kind}) → progetto ${result.project}`)
    this.log(`  pagina: ${result.pageId} · fonte: ${result.sourceFile}${result.commit ? ` @ ${result.commit}` : ''}`)
    this.log('  motivazioni:')
    for (const reason of result.reasons) this.log(`    - ${reason}`)
  }
}
