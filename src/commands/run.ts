import * as path from 'node:path'
import {Args, Flags} from '@oclif/core'
import {BaseCommand} from '../base'
import {loadPlaybook} from '../lib/playbook'
import {buildCommand} from '../lib/executor'
import {ClaudeRuntime, CodexRuntime, SpawnRuntime} from '../lib/runtime'
import {loadSecrets, secretCapabilities} from '../lib/config'
import {logsDir, playbookPath} from '../lib/paths'
import {AutomatorError, ErrorCodes} from '../errors/error-codes'
import {redactSecrets} from '../lib/secret-redaction'
import {detectPlatform, type OsPlatform} from '../lib/service'

export default class Run extends BaseCommand {
  static description = "Esegue UNA azione ora, ignorando lo schedule (on-demand)"

  static examples = ['<%= config.bin %> run triage', '<%= config.bin %> run report --dry-run']

  static args = {
    action: Args.string({description: 'Nome azione dal playbook', required: true}),
  }

  static flags = {
    'dry-run': Flags.boolean({description: 'Mostra il comando risolto senza eseguirlo'}),
    playbook: Flags.string({description: 'Path del playbook (default: ./playbook.yml o AUTOMATOR_PLAYBOOK)'}),
  }

  /** Test seam: real execution of actions is available only on Linux. */
  protected currentPlatform(): OsPlatform {
    return detectPlatform()
  }

  async run(): Promise<unknown> {
    this.currentPlatform()
    const {args, flags} = await this.parse(Run)
    const file = playbookPath(flags.playbook)
    const playbook = loadPlaybook(file)
    const action = playbook.actions[args.action]
    if (!action) {
      throw new AutomatorError(ErrorCodes.Action.notFound, `Azione non trovata: ${args.action}`, 2)
    }

    const playbookDir = path.dirname(file)
    const built = buildCommand(action, playbookDir)

    if (flags['dry-run']) {
      const safeAction = redactSecrets(args.action)
      const safeCommand = redactSecrets(built.display)
      const safeCwd = redactSecrets(built.cwd)
      if (!this.jsonEnabled()) this.log(`[dry-run] cwd=${safeCwd}\n${safeCommand}`)
      return {dryRun: true, action: safeAction, command: safeCommand, cwd: safeCwd}
    }

    // Route by type: claude → ClaudeRuntime (guardrail gate + is_error), codex → CodexRuntime (sandbox,
    // outcome via exit code), the others → SpawnRuntime.
    const runtime =
      action.type === 'claude' ? new ClaudeRuntime() : action.type === 'codex' ? new CodexRuntime() : new SpawnRuntime()
    const result = await runtime.execute(args.action, action, {
      playbookDir,
      logDir: logsDir(),
      now: new Date(),
      secrets: secretCapabilities(loadSecrets()),
    }).result
    if (result.status !== 'success') {
      throw new AutomatorError(
        result.errorCode ?? ErrorCodes.Exec.failed,
        `Azione ${args.action}: ${result.status} (exit=${result.exitCode ?? '-'}, log: ${result.logPath})`,
        1,
      )
    }

    const safeAction = redactSecrets(args.action)
    const safeLogPath = redactSecrets(result.logPath)
    if (!this.jsonEnabled()) this.log(`success — log: ${safeLogPath}`)
    return {
      action: safeAction,
      status: result.status,
      exitCode: result.exitCode,
      durationMs: result.durationMs,
      logPath: safeLogPath,
    }
  }
}
