import {Flags} from '@oclif/core'
import {BaseCommand} from '../base'
import {isUserToken} from '../lib/config'
import {
  type CanaryClock,
  type CanaryConfig,
  type CanaryReport,
  type CanaryServer,
  formatCanaryAlert,
  makeCanaryServer,
  runCanary,
  systemClock,
} from '../lib/canary'
import {DEFAULT_API} from '../lib/client'
import {AutomatorError, ErrorCodes} from '../errors/error-codes'

/** The keys arrive only from the vault, through `cyi run`: never from a flag, a file or an argument. */
export const CANARY_TOKEN_ENV = 'CANARY_COLLAUDO_TOKEN'
export const CANARY_OBSERVER_TOKEN_ENV = 'CANARY_OBSERVER_TOKEN'

const PROJECT_KEY_RE = /^[A-Z][A-Z0-9]{1,15}$/
const TICKET_CODE_RE = /^[A-Z][A-Z0-9]{1,15}-\d+$/

export default class Canary extends BaseCommand {
  static description =
    'Canarino notturno (CYAU-205): crea un ticket innocuo sul progetto Sandbox e lo segue fino allo staging, approvando piano e codice con l\'account collaudo. Prima di ogni approvazione l\'osservatore conferma che il ticket esca è approvabile e l\'account collaudo deve ricevere un diniego per permessi sulla stessa approvazione. Le chiavi arrivano solo dall\'ambiente (cyi run): CANARY_COLLAUDO_TOKEN e CANARY_OBSERVER_TOKEN. Esiti: staging raggiunto → exit 0; fermo con avviso (fase e motivo) → exit 1; approvazione dell\'esca accettata → exit 4, revocare la chiave; input non valido → exit 2'

  static examples = [
    'cyi run -p SBX -e test -- <%= config.bin %> canary --sandbox-project SBX --decoy-project DECOY --decoy-ticket DECOY-1',
  ]

  static flags = {
    'sandbox-project': Flags.string({description: 'chiave del progetto Sandbox, l\'unico su cui l\'account collaudo approva', required: true}),
    'decoy-project': Flags.string({description: 'chiave del progetto esca, fuori dal perimetro dell\'account collaudo', required: true}),
    'decoy-ticket': Flags.string({description: 'codice del ticket esca, tenuto approvabile', required: true}),
    'deadline-minutes': Flags.integer({description: 'minuti entro cui il ticket deve arrivare allo staging', default: 240}),
    'poll-seconds': Flags.integer({description: 'secondi tra due letture dello stato del ticket', default: 60}),
    'hidden-decoy-counts-as-denial': Flags.boolean({
      description: 'conta come diniego anche l\'esca nascosta all\'account collaudo (R404), dopo che l\'osservatore ne ha confermato l\'esistenza',
      default: false,
    }),
    'api-url': Flags.string({description: 'URL del server CloseYourIt', default: DEFAULT_API}),
  }

  /** Builds the two identities. Overridable in tests to inject fakes. */
  protected makeServers(apiUrl: string, collaudoToken: string, observerToken: string): {collaudo: CanaryServer; observer: CanaryServer} {
    return {collaudo: makeCanaryServer(collaudoToken, apiUrl), observer: makeCanaryServer(observerToken, apiUrl)}
  }

  protected clock(): CanaryClock {
    return systemClock
  }

  async run(): Promise<CanaryReport> {
    const {flags} = await this.parse(Canary)
    const config = this.resolveConfig(flags)
    const collaudoToken = this.token(CANARY_TOKEN_ENV)
    const observerToken = this.token(CANARY_OBSERVER_TOKEN_ENV)
    if (collaudoToken === observerToken) throw this.invalidInput('the observer must be a different identity from the collaudo account')

    const {collaudo, observer} = this.makeServers(flags['api-url'], collaudoToken, observerToken)
    const report = await runCanary(config, collaudo, observer, this.clock())
    const line = formatCanaryAlert(report)
    if (!report.alert) {
      if (!this.jsonEnabled()) this.log(line)
      return report
    }
    const error = report.alert.urgent
      ? new AutomatorError(ErrorCodes.Canary.boundaryBreach, line, 4)
      : new AutomatorError(ErrorCodes.Canary.stopped, line, 1)
    if (this.jsonEnabled()) this.logJson({...report, error: {code: error.code, message: error.message}})
    throw error
  }

  private resolveConfig(flags: {
    'sandbox-project': string
    'decoy-project': string
    'decoy-ticket': string
    'deadline-minutes': number
    'poll-seconds': number
    'hidden-decoy-counts-as-denial': boolean
  }): CanaryConfig {
    const sandbox = flags['sandbox-project'].toUpperCase()
    const decoy = flags['decoy-project'].toUpperCase()
    const decoyTicket = flags['decoy-ticket'].toUpperCase()
    if (!PROJECT_KEY_RE.test(sandbox) || !PROJECT_KEY_RE.test(decoy)) throw this.invalidInput('project keys must be CloseYourIt project keys (for example SBX)')
    if (sandbox === decoy) throw this.invalidInput('the decoy project must be outside the Sandbox project')
    if (!TICKET_CODE_RE.test(decoyTicket) || !decoyTicket.startsWith(`${decoy}-`)) throw this.invalidInput(`the decoy ticket must be a ticket of ${decoy}`)
    if (flags['deadline-minutes'] <= 0 || flags['poll-seconds'] <= 0) throw this.invalidInput('deadline and poll interval must be positive')
    return {
      sandboxProject: sandbox,
      decoyProject: decoy,
      decoyTicket,
      deadlineMs: flags['deadline-minutes'] * 60_000,
      pollMs: flags['poll-seconds'] * 1000,
      hiddenDecoyCountsAsDenial: flags['hidden-decoy-counts-as-denial'],
    }
  }

  private token(name: string): string {
    const value = process.env[name]
    if (!isUserToken(value)) throw this.invalidInput(`${name} is missing or is not a CloseYourIt user token: run the canary through cyi run`)
    return value
  }

  private invalidInput(message: string): AutomatorError {
    return new AutomatorError(ErrorCodes.Canary.invalidInput, message, 2)
  }
}
