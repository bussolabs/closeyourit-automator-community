import {BaseCommand} from '../base'
import {serviceManager} from '../lib/service'
import {renderRecord} from '../lib/output'

export default class Status extends BaseCommand {
  static description = 'Mostra lo stato del servizio (installato / in esecuzione / pid)'

  static examples = ['<%= config.bin %> status', '<%= config.bin %> status --json']

  async run(): Promise<unknown> {
    await this.parse(Status)
    const manager = serviceManager()
    const status = manager.status()
    const payload = {...status, unit: manager.unitPath(), logs: manager.logsPath()}
    if (!this.jsonEnabled()) this.log(renderRecord(payload))
    return payload
  }
}
