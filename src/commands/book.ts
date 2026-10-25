import {Flags} from '@oclif/core'
import {BaseCommand} from '../base'
import {
  assignPageToBook,
  type BookAssignmentInput,
  type BookAssignmentPlan,
  type BookAssignmentResult,
  type BookRegistry,
  defaultBookRegistry,
  planBookAssignment,
} from '../lib/book'
import {AutomatorError} from '../errors/error-codes'

export default class Book extends BaseCommand {
  static description =
    'Assegna una pagina Knowledge a un book tematico autorizzato e verifica la sua posizione nel sommario (CYAU-28), controparte «membership» di `publish` (CYAU-27, che crea/aggiorna la pagina). Risolve il book per titolo nel progetto (scope/anti-BOLA), assegna la pagina SOLO se non è già nel sommario (idempotente, mai un doppione), MAI la rimuove (strutturale) e rilegge il sommario per confermare la posizione. Gate shell safe-by-default: assegnato o già presente → exit 0; book assente o ambiguo → exit 3 (segnalato, non assegna); input non valido → exit 2; comando `cyi kb book` fallito o verifica del sommario fallita → exit 1'

  static examples = [
    '<%= config.bin %> book --project CYAU --page-id 1a2b3c --book "Deploy & infra" --ticket CYAU-28',
    '<%= config.bin %> book --project CYAU --page-id 1a2b3c --book "Deploy & infra" --position 3 --dry-run',
  ]

  static flags = {
    project: Flags.string({description: 'project-key CloseYourIt: scope della ricerca dei book (anti-BOLA)', required: true}),
    'page-id': Flags.string({description: 'id della pagina Knowledge da assegnare (di norma restituito da `publish`)', required: true}),
    book: Flags.string({description: 'titolo del book tematico indicato dalla policy (chiave della risoluzione)', required: true}),
    position: Flags.integer({description: 'posizione 1-based nel sommario dove inserire la pagina (default: in fondo)'}),
    ticket: Flags.string({description: 'codice del ticket (metadato di provenienza)'}),
    'dry-run': Flags.boolean({description: 'risolve il book e mostra il piano senza assegnare la pagina', default: false}),
  }

  /** Builds the real Knowledge probe (cyi kb book). Overridable in tests to inject a fake one. */
  protected makeRegistry(): BookRegistry {
    return defaultBookRegistry()
  }

  async run(): Promise<unknown> {
    const {flags} = await this.parse(Book)

    const input: BookAssignmentInput = {
      project: flags.project,
      pageId: flags['page-id'],
      bookTitle: flags.book,
      ticket: flags.ticket ?? null,
      position: flags.position ?? null,
    }

    const registry = this.makeRegistry()

    if (flags['dry-run']) {
      // planBookAssignment validates the input, resolves the book and reads its table of contents (read-only: assigns nothing).
      const plan = planBookAssignment(input, registry)
      if (!this.jsonEnabled()) this.printPlan(plan, input.position ?? null)
      return {
        dryRun: true,
        project: plan.project,
        pageId: plan.pageId,
        bookId: plan.bookId,
        bookTitle: plan.bookTitle,
        alreadyPresent: plan.alreadyPresent,
        position: plan.position,
        toc: plan.toc,
      }
    }

    try {
      const result = assignPageToBook(input, registry)
      if (!this.jsonEnabled()) this.printResult(result)
      return {dryRun: false, ...result}
    } catch (error) {
      // The "do not assign" gate (missing/ambiguous book, exit 3) emits the payload with the error on stdout in --json,
      // like the other gates (publish/deliver): oclif suppresses stderr in JSON. The other errors (input exit 2,
      // command exit 1) are left to the BaseCommand catch (stderr, `code: message`).
      if (error instanceof AutomatorError && error.exitCode === 3 && this.jsonEnabled()) {
        this.logJson({dryRun: false, project: flags.project, pageId: flags['page-id'], book: flags.book, error: {code: error.code, message: error.message}})
      }

      throw error
    }
  }

  private printPlan(plan: BookAssignmentPlan, requestedPosition: number | null): void {
    this.log(`book · dry-run · pagina ${plan.pageId} → «${plan.bookTitle}» (id ${plan.bookId}) · progetto ${plan.project}`)
    const state = plan.alreadyPresent ? `già nel sommario in posizione ${plan.position}` : 'non ancora nel sommario'
    this.log(`  stato: ${state}${requestedPosition !== null ? ` · posizione richiesta ${requestedPosition}` : ''}`)
    this.log(`  sommario attuale: ${plan.toc.length > 0 ? plan.toc.join(', ') : '(vuoto)'}`)
  }

  private printResult(result: BookAssignmentResult): void {
    this.log(`book · ${result.action} · pagina ${result.pageId} → «${result.bookTitle}» (id ${result.bookId}) · progetto ${result.project}`)
    this.log(`  posizione nel sommario: ${result.position}`)
    this.log('  motivazioni:')
    for (const reason of result.reasons) this.log(`    - ${reason}`)
  }
}
