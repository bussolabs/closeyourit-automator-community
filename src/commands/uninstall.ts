import * as os from 'node:os'
import {BaseCommand} from '../base'
import {serviceManager} from '../lib/service'
import {removeAutoUpdate} from '../lib/auto-update-timer'

export default class Uninstall extends BaseCommand {
  static description = 'Rimuove il servizio (bootout/disable + cancella la unit)'

  static examples = ['<%= config.bin %> uninstall']

  async run(): Promise<unknown> {
    await this.parse(Uninstall)
    const manager = serviceManager()
    const unit = manager.unitPath()
    manager.uninstall()
    // The automatic update timer goes away with the service: on its own it would call a binary that no longer
    // restarts anything. Idempotent on a machine that never had it (CYAU-202).
    removeAutoUpdate(os.homedir())
    if (!this.jsonEnabled()) this.log(`Servizio rimosso. Unit cancellata: ${unit}`)
    return {removed: true, unit}
  }
}
