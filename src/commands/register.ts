import {BaseCommand} from '../base'
import {loadSecrets} from '../lib/config'
import {makeHostRegistrar} from '../lib/host'
import {detectPlatform, type OsPlatform} from '../lib/service'
import {AutomatorError, ErrorCodes} from '../errors/error-codes'

export default class Register extends BaseCommand {
  static description = 'Registra questa installazione come Agent Host su CloseYourIt (idempotente)'

  static examples = ['<%= config.bin %> register', '<%= config.bin %> register --json']

  /** Test seam: the real CLI accepts only a platform detected as Linux. */
  protected currentPlatform(): OsPlatform {
    return detectPlatform()
  }

  async run(): Promise<unknown> {
    await this.parse(Register)
    const secrets = loadSecrets()
    const registrar = makeHostRegistrar(secrets, undefined, undefined, this.config.version, this.currentPlatform())
    if (!registrar) {
      throw new AutomatorError(ErrorCodes.Host.notConfigured, 'Registrazione host non configurata: manca il token del service account (cyi_u_) nel credential store — passalo come CLOSEYOURIT_TOKEN durante "automator install --managed"', 2)
    }

    const result = await registrar()
    if (result.status === 'failed') {
      throw new AutomatorError(ErrorCodes.Host.registerFailed, 'Registrazione host fallita: CloseYourIt non raggiungibile o ha rifiutato', 1)
    }

    if (!this.jsonEnabled()) {
      const verb = result.status === 'existing' ? 'già registrato' : 'registrato'
      this.log(`Agent Host ${verb}: host_id=${result.host?.id}`)
    }

    return {status: result.status, host_id: result.host?.id ?? null}
  }
}
