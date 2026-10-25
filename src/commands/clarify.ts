import * as fs from 'node:fs'
import {Flags} from '@oclif/core'
import {BaseCommand} from '../base'
import {
  type ClarificationDecision,
  type ClarificationStatus,
  DEFAULT_CLARIFICATION_LIMIT,
  decideClarification,
  parseSystemClarificationState,
  readClarificationState,
} from '../lib/clarification'
import {AutomatorError, ErrorCodes} from '../errors/error-codes'

export default class Clarify extends BaseCommand {
  static description =
    'Gestisce i chiarimenti senza bloccare la coda (CYAU-22): letto lo stato del ciclo di chiarimenti dal SISTEMA (contratto `agent-clarification/v1`) decide se il ticket è lavorabile in automatico o se è in attesa di una risposta. Un ticket waiting NON trattiene lo slot: l\'orchestratore lo salta e continua la coda; una risposta successiva lo rende di nuovo lavorabile. Le domande le pubblica il server quando il triage le consegna (CYRA-221): qui si legge lo stato e si decide. Lavorabile → exit 0; in attesa/escalato/illeggibile → exit 3 (rilascia lo slot, non procedere); input non valido → exit 2'

  static examples = [
    '<%= config.bin %> clarify --code CYAU-22 --project CYAU',
    '<%= config.bin %> clarify --code CYAU-22 --project CYAU --needs-decision',
    '<%= config.bin %> clarify --state-file clarifications.json --json',
  ]

  static flags = {
    code: Flags.string({description: 'codice del ticket (es. CYAU-22); con --project lo stato si chiede al sistema'}),
    project: Flags.string({description: 'chiave del progetto (es. CYAU); serve per chiedere lo stato al sistema'}),
    'state-file': Flags.string({
      description: 'file JSON con la risposta di `cyi tickets clarifications --json` (stato già letto): alternativa a --code/--project',
    }),
    'needs-decision': Flags.boolean({
      description: 'l\'agente ha stabilito che manca una decisione funzionale indispensabile (non può procedere)',
      default: false,
    }),
    limit: Flags.integer({
      description: `budget di cicli di chiarimento prima dell'escalation (default ${DEFAULT_CLARIFICATION_LIMIT})`,
      default: DEFAULT_CLARIFICATION_LIMIT,
    }),
  }

  async run(): Promise<unknown> {
    const {flags} = await this.parse(Clarify)

    // Input defence: the budget comes from the CLI, untrusted. A value that is not a positive integer exits cleanly
    // (exit 2) before any read.
    const limit = flags.limit
    if (!Number.isInteger(limit) || limit < 1) {
      throw this.invalidInput(`Limite non valido: "${limit}" (atteso un intero ≥ 1)`)
    }

    // CYAU-189 — the SYSTEM states the status, in the format of the `agent-clarification/v1` contract. It used to be
    // derived from comments with a regex copied by hand from the server: a reformatted line changed the status
    // of a run, and a reader's diverging copy changed it only for that reader.
    const status = this.readStatus(flags)
    const decision = decideClarification({status, needsDecision: flags['needs-decision'], limit})

    const payload = {
      code: flags.code ?? null,
      state: decision.state,
      cycles: status.cycles,
      hasReply: status.hasReply,
      source: status.source ?? null,
      action: decision.action,
      cycle: decision.cycle,
      limit: decision.limit,
      workable: decision.workable,
      requiresHuman: decision.requiresHuman,
      phase: decision.phase,
      reasons: decision.reasons,
    }

    if (!this.jsonEnabled()) this.printDecision(payload)

    // Safe-by-default shell gate (like cycle/review/lease): a ticket that cannot be worked does NOT hold the slot →
    // dedicated exit 3 so the orchestrator skips it and continues the queue. Distinguishes waiting (waiting/ask) from
    // the need for human intervention (escalation).
    if (!decision.workable) {
      const error = decision.requiresHuman
        ? new AutomatorError(ErrorCodes.Clarify.escalated, `${this.gateMessage(decision)} — non procedere`, 3)
        : new AutomatorError(ErrorCodes.Clarify.waiting, `${this.gateMessage(decision)} — rilascia lo slot e continua la coda`, 3)
      if (this.jsonEnabled()) this.logJson({...payload, error: {code: error.code, message: error.message}})
      throw error
    }

    return payload
  }

  /**
   * The clarification cycle state: asked to the system (`--code` + `--project`) or read from a file that
   * already carries the endpoint response (`--state-file`). With neither, exit cleanly (exit 2): not
   * knowing whether a question is pending is not "no pending question".
   */
  private readStatus(flags: {code?: string; project?: string; 'state-file'?: string}): ClarificationStatus {
    const file = flags['state-file']
    if (file !== undefined) {
      let raw: string
      try {
        raw = fs.readFileSync(file, 'utf8')
      } catch {
        throw this.invalidInput(`Impossibile leggere il file dello stato dei chiarimenti: ${file}`)
      }

      const status = parseSystemClarificationState(raw)
      if (!status) {
        throw this.invalidInput(`Il file dello stato non rispetta il contratto agent-clarification/v1: ${file}`)
      }

      return status
    }

    if (!flags.code || !flags.project) {
      throw this.invalidInput('Serve --state-file, oppure --code e --project per chiedere lo stato al sistema')
    }

    return readClarificationState(flags.code, flags.project)
  }

  /** The gate message by action (waiting / limit reached / already escalated). */
  private gateMessage(decision: ClarificationDecision): string {
    switch (decision.action) {
      case 'escalate': {
        return decision.state === 'escalated'
          ? `Il ticket è già stato escalato al ciclo ${decision.cycle}: richiede l'intervento del team`
          : `Raggiunto il limite di ${decision.limit} cicli di chiarimento senza una risposta utile (ciclo ${decision.cycle}): richiede l'intervento del team`
      }

      case 'wait': {
        return decision.state === 'unreadable'
          ? 'Stato dei chiarimenti non leggibile: il ticket non è lavorabile ora'
          : `Il ticket è in attesa di una risposta (ciclo ${decision.cycle}/${decision.limit}): non è lavorabile ora`
      }

      default: {
        // ask
        return `Pubblicata una domanda al ciclo ${decision.cycle}/${decision.limit}: il ticket attende una risposta`
      }
    }
  }

  private invalidInput(message: string): AutomatorError {
    return new AutomatorError(ErrorCodes.Clarify.invalidInput, message, 2)
  }

  private printDecision(p: {
    code: string | null
    state: string
    action: string
    cycle: number
    limit: number
    workable: boolean
    requiresHuman: boolean
    reasons: string[]
  }): void {
    const flag = p.requiresHuman ? ' · INTERVENTO UMANO' : p.workable ? '' : ' · SLOT LIBERO'
    this.log(`clarify · ${p.code ? `${p.code} · ` : ''}stato ${p.state} · azione ${p.action} · ciclo ${p.cycle}/${p.limit}${flag}`)
    this.log('  motivazioni:')
    for (const reason of p.reasons) this.log(`    - ${reason}`)
  }
}
