import {Flags} from '@oclif/core'
import {BaseCommand} from '../base'
import {DEPS, defaultShellExec, setupDep, type SetupResult} from '../lib/deps'
import {detectPlatform} from '../lib/service'
import {renderTable} from '../lib/output'
import {AutomatorError, ErrorCodes} from '../errors/error-codes'

export default class Setup extends BaseCommand {
  static description = 'Installa (idempotente) le CLI mancanti per la piattaforma corrente'

  static examples = ['<%= config.bin %> setup', '<%= config.bin %> setup --dry-run', '<%= config.bin %> setup --optional']

  static flags = {
    'dry-run': Flags.boolean({description: 'Mostra i comandi di installazione senza eseguirli'}),
    optional: Flags.boolean({description: 'Installa anche le CLI optional (codex, pnpm)'}),
  }

  async run(): Promise<unknown> {
    const {flags} = await this.parse(Setup)
    const platform = detectPlatform()

    const results: SetupResult[] = DEPS.map((dep) =>
      setupDep(dep, defaultShellExec, {dryRun: flags['dry-run'], optional: flags.optional}),
    )

    if (!this.jsonEnabled()) {
      this.log(
        renderTable(
          ['CLI', 'ESITO', 'DETTAGLIO'],
          results.map((r) => [r.name, r.outcome, r.detail ?? '']),
        ),
      )
    }

    const failed = results.filter((r) => r.outcome === 'failed')
    if (failed.length > 0) {
      throw new AutomatorError(ErrorCodes.Dep.installFailed, `Installazione fallita: ${failed.map((r) => r.name).join(', ')}`, 1)
    }

    return {platform, results}
  }
}
