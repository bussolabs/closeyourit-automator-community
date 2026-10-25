import {Command, type Interfaces} from '@oclif/core'
import {AutomatorError} from './errors/error-codes'
import {redactSecrets} from './lib/secret-redaction'

export abstract class BaseCommand extends Command {
  static enableJsonFlag = true

  /** Prints `code: message` for domain errors, then exits with their exit code. */
  protected async catch(error: Interfaces.CommandError): Promise<unknown> {
    if (error instanceof AutomatorError) {
      this.logToStderr(`${error.code}: ${redactSecrets(error.message)}`)
      return this.exit(error.exitCode)
    }
    return super.catch(error)
  }
}
