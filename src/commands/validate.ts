import {Args} from '@oclif/core'
import {BaseCommand} from '../base'
import {validatePlaybook} from '../lib/playbook'
import {parseSchedule} from '../lib/schedule'
import {playbookPath} from '../lib/paths'
import {AutomatorError, ErrorCodes} from '../errors/error-codes'

export default class Validate extends BaseCommand {
  static description = 'Valida un playbook: schema (zod) + sintassi degli schedule di ogni azione'

  static examples = ['<%= config.bin %> validate', '<%= config.bin %> validate ./playbook.yml --json']

  static args = {
    playbook: Args.string({description: 'Path del playbook (default: ./playbook.yml o AUTOMATOR_PLAYBOOK)'}),
  }

  async run(): Promise<unknown> {
    const {args} = await this.parse(Validate)
    const file = playbookPath(args.playbook)

    const result = validatePlaybook(file)
    if (!result.ok) {
      throw new AutomatorError(result.code, result.issues.map((i) => `${i.path}: ${i.message}`).join('; '), 2)
    }

    // Valid schema → also validate the syntax of every schedule (not covered by zod).
    const scheduleErrors: Array<{name: string; message: string}> = []
    for (const [name, action] of Object.entries(result.playbook.actions)) {
      try {
        parseSchedule(action.schedule)
      } catch (error) {
        scheduleErrors.push({name, message: error instanceof AutomatorError ? error.message : String(error)})
      }
    }

    if (scheduleErrors.length > 0) {
      throw new AutomatorError(
        ErrorCodes.Schedule.invalid,
        scheduleErrors.map((e) => `${e.name}: ${e.message}`).join('; '),
        2,
      )
    }

    const names = Object.keys(result.playbook.actions)
    if (!this.jsonEnabled()) this.log(`OK — ${names.length} azioni valide: ${names.join(', ')}`)

    return {ok: true, file, actions: names}
  }
}
