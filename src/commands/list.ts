import {Args} from '@oclif/core'
import {BaseCommand} from '../base'
import {loadPlaybook} from '../lib/playbook'
import {nextFire, parseSchedule} from '../lib/schedule'
import {loadState} from '../lib/state'
import {playbookPath, statePath} from '../lib/paths'
import {renderTable} from '../lib/output'

interface Row {
  name: string
  type: string
  schedule: string
  enabled: boolean
  last_status: string
  last_run: string
  next_run: string
}

export default class List extends BaseCommand {
  static description = 'Elenca le azioni del playbook con schedule, stato e prossima esecuzione'

  static examples = ['<%= config.bin %> list', '<%= config.bin %> list --json']

  static args = {
    playbook: Args.string({description: 'Path del playbook (default: ./playbook.yml o AUTOMATOR_PLAYBOOK)'}),
  }

  async run(): Promise<unknown> {
    const {args} = await this.parse(List)
    const file = playbookPath(args.playbook)
    const playbook = loadPlaybook(file)
    const state = loadState(statePath())
    const now = new Date()

    const rows: Row[] = Object.entries(playbook.actions).map(([name, action]) => {
      const st = state.actions[name]
      const lastRun = st?.last_run ? new Date(st.last_run) : null
      let nextRun = '-'
      try {
        const parsed = parseSchedule(action.schedule)
        const next = nextFire(parsed, lastRun ?? now, lastRun)
        nextRun = next ? next.toISOString() : '-'
      } catch {
        nextRun = 'schedule invalido'
      }
      return {
        name,
        type: action.type,
        schedule: action.schedule,
        enabled: action.enabled,
        last_status: st?.last_status ?? '-',
        last_run: st?.last_run ?? '-',
        next_run: nextRun,
      }
    })

    if (!this.jsonEnabled()) {
      this.log(
        renderTable(
          ['NOME', 'TIPO', 'SCHEDULE', 'ON', 'ULTIMO', 'LAST RUN', 'NEXT RUN'],
          rows.map((r) => [
            r.name,
            r.type,
            r.schedule,
            r.enabled ? 'sì' : 'no',
            r.last_status,
            r.last_run,
            r.next_run,
          ]),
        ),
      )
    }

    return {file, actions: rows}
  }
}
