import {Args, Flags} from '@oclif/core'
import {BaseCommand} from '../base'
import {hasOperationalHostIdentity, loadSecrets} from '../lib/config'
import {makeClient} from '../lib/client'
import {collectRepoTargets} from '../lib/discover'
import {
  defaultWorkspaceGit,
  inspectWorkspace,
  prepareWorkspace,
  ticketBranch,
} from '../lib/workspace'
import {AutomatorError, ErrorCodes} from '../errors/error-codes'

export default class Workspace extends BaseCommand {
  static description =
    'Prepara il checkout gestito (repositories/<owner>/<repo>) e un worktree isolato per il ticket (worktrees/<project>/<ticket>), separati dai repository personali. Idempotente: clona/aggiunge solo se manca, riusa e preserva il lavoro esistente'

  static examples = ['<%= config.bin %> workspace CYAU CYAU-11', '<%= config.bin %> workspace CYAU CYAU-11 --dry-run --json']

  static args = {
    project: Args.string({description: 'project-key CloseYourIt (deve avere un repository GitHub associato)', required: true}),
    ticket: Args.string({description: 'codice del ticket (es. CYAU-11) → worktree isolato + branch ticket/<ticket>', required: true}),
  }

  static flags = {
    url: Flags.string({description: 'URL git da clonare (default: https://github.com/<owner>/<repo>.git)'}),
    branch: Flags.string({description: 'branch del worktree (default: ticket/<ticket>)'}),
    'dry-run': Flags.boolean({description: 'Mostra il piano senza clonare né creare il worktree'}),
  }

  async run(): Promise<unknown> {
    const {args, flags} = await this.parse(Workspace)
    const secrets = loadSecrets()

    // The "GitHub map" (project → repo) comes from the CloseYourIt agents: without sync there is nothing to clone.
    if (!secrets.sync) {
      throw new AutomatorError(ErrorCodes.Sync.notConfigured, 'Canale API non configurato: manca "sync" nei secret', 2)
    }

    if (!hasOperationalHostIdentity(secrets)) {
      throw new AutomatorError(ErrorCodes.Sync.hostNotConfigured, 'Host non registrato o credenziale host non valida: esegui "automator register"', 2)
    }

    const client = makeClient(secrets.sync, undefined, secrets.host.token)
    const manifest = await client.getWorkspaceManifest()
    if (manifest === null) {
      throw new AutomatorError(ErrorCodes.Sync.fetchFailed, 'Impossibile pescare il manifest dei repository da CloseYourIt', 1)
    }

    const repo = collectRepoTargets(manifest).get(args.project)
    if (!repo) {
      throw new AutomatorError(
        ErrorCodes.Workspace.noRepo,
        `Il progetto "${args.project}" non ha un repository GitHub associato tra gli agenti: nulla da clonare`,
        1,
      )
    }

    const branch = flags.branch ?? ticketBranch(args.ticket)
    const git = defaultWorkspaceGit()

    if (flags['dry-run']) {
      const inspected = inspectWorkspace({fullName: repo, projectKey: args.project, ticket: args.ticket, url: flags.url, branch}, git)
      if (!this.jsonEnabled()) {
        this.log(`(dry-run) repository ${inspected.repoAction}: ${inspected.repoPath}`)
        this.log(`(dry-run) worktree ${inspected.worktreeAction}: ${inspected.worktreePath} (${branch})`)
      }

      return {dryRun: true, project: args.project, ticket: args.ticket, repo, ...inspected}
    }

    const result = prepareWorkspace({fullName: repo, projectKey: args.project, ticket: args.ticket, url: flags.url, branch}, git)
    if (!this.jsonEnabled()) {
      this.log(`repository ${result.repoAction}: ${result.repoPath}`)
      this.log(`worktree ${result.worktreeAction}: ${result.worktreePath} (${result.branch})`)
    }

    return {dryRun: false, project: args.project, ticket: args.ticket, repo, ...result}
  }
}
