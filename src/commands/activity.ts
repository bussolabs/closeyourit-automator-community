import {BaseCommand} from '../base'
import {type HostActivity, readHostActivity} from '../lib/activity'
import {loadSecrets} from '../lib/config'
import {renderTable} from '../lib/output'
import {scanTicketAttempts, type TicketAttemptRecord, type UnreadableTicketAttempts} from '../lib/ticket-attempts'

/** What the command returns: the current activity plus the spend accumulated per ticket (CYAU-155). */
interface ActivityReport extends HostActivity {
  ticket_spend: TicketAttemptRecord[]
  /** CYAU-324 — count files that cannot be read: listed, never silently dropped from the view. */
  ticket_spend_unreadable: UnreadableTicketAttempts[]
}

export default class Activity extends BaseCommand {
  static description =
    "Mostra le lavorazioni attive di questo host (ticket, fase, runtime, durata, stato del lease), la spesa accumulata per ticket e lo stato operativo aggregato: la stessa vista che l'automator invia a CloseYourIt via heartbeat per la dashboard Automation (CYAU-31). Read-only e best-effort (uno state dir illeggibile → host idle), nessun gate: esce sempre 0"

  static examples = ['<%= config.bin %> activity', '<%= config.bin %> activity --json']

  async run(): Promise<unknown> {
    await this.parse(Activity)
    // The per-ticket spend does NOT go into `HostActivity`: that structure is the heartbeat payload sent to the
    // server, while this is local data for the operator. It travels alongside, not inside.
    const spend = scanTicketAttempts()
    const report: ActivityReport = {
      ...readHostActivity(loadSecrets()),
      ticket_spend: spend.records,
      ticket_spend_unreadable: spend.unreadable,
    }
    if (!this.jsonEnabled()) this.printActivity(report)
    return report
  }

  private printActivity(activity: ActivityReport): void {
    this.log(`stato host: ${activity.host_status}`)
    if (activity.active_runs.length === 0) {
      this.log('(nessuna lavorazione attiva)')
    } else {
      const rows = activity.active_runs.map((run) => [
        run.ticket,
        run.phase ?? '-',
        run.runtime ?? '-',
        run.started_at ?? '-',
        run.lease_health,
        run.stalled ? 'ferma' : '',
      ])
      this.log(renderTable(['ticket', 'fase', 'runtime', 'inizio', 'lease', 'stato'], rows))
    }
    this.printTicketSpend(activity.ticket_spend, activity.ticket_spend_unreadable)
  }

  /**
   * How much each ticket cost and how many times we tried it (CYAU-155). This is the missing view: with only the
   * daily total, a ticket resumed dozens of times disappeared inside the spend of all the others.
   */
  private printTicketSpend(spend: TicketAttemptRecord[], unreadable: UnreadableTicketAttempts[]): void {
    if (spend.length === 0 && unreadable.length === 0) return
    const rows = spend.map((entry) => [
      entry.ticket,
      entry.project,
      entry.phase ?? '-',
      String(entry.attempts),
      String(entry.total_attempts),
      entry.total_cost.toFixed(2),
    ])
    // CYAU-324: the ticket is stopped on that file until a person presses Retry — it must show up here.
    for (const entry of unreadable) {
      rows.push([entry.ticket, entry.project ?? '-', 'conteggio illeggibile', '-', '-', '-'])
    }
    this.log('')
    this.log('spesa per ticket:')
    this.log(renderTable(['ticket', 'progetto', 'fase', 'tentativi fase', 'tentativi totali', 'costo'], rows))
  }
}
