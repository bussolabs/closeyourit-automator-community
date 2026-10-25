import * as path from 'node:path'
import {Flags} from '@oclif/core'
import {BaseCommand} from '../base'
import {loadPlaybook} from '../lib/playbook'
import {selectDue} from '../lib/scheduler'
import {loadState} from '../lib/state'
import {runOnce} from '../lib/runner'
import {loadSecrets, secretCapabilities} from '../lib/config'
import {combineBeats, heartbeatMissingReason, makeHeartbeat} from '../lib/heartbeat'
import {makeLeaseRenewer} from '../lib/lease'
import {makeOrgClaudeCredentialReconciler} from '../lib/org-claude-credential'
import {makeOrgOpenrouterKeyReconciler} from '../lib/org-openrouter-credential'
import {makeSkillsReconciler} from '../lib/skills-manifest'
import {makeSync} from '../lib/sync'
import {logsDir, lockPath, playbookPath, skillsModeEnabled, statePath} from '../lib/paths'
import {type Playbook} from '../lib/schema'
import {type TicketQueueTarget} from '../lib/runner'
import {makeGithubTokenFetcher} from '../lib/github-token'
import {makeQueueClaimer, makeQueueDeferrer, makeTicketPreflight, resolveHostFlowConcurrency} from '../lib/ticket-preflight'
import {detectPlatform, type OsPlatform} from '../lib/service'

export default class Tick extends BaseCommand {
  static description = 'Esegue una singola iterazione: valuta le azioni due e le lancia (invocato dal servizio)'

  static examples = ['<%= config.bin %> tick', '<%= config.bin %> tick --dry-run --json']

  static flags = {
    'dry-run': Flags.boolean({description: 'Elenca le azioni due senza eseguirle'}),
    playbook: Flags.string({description: 'Path del playbook (default: ./playbook.yml o AUTOMATOR_PLAYBOOK)'}),
  }

  /** Test seam: a real operational iteration is available only on Linux. */
  protected currentPlatform(): OsPlatform {
    return detectPlatform()
  }

  async run(): Promise<unknown> {
    this.currentPlatform()
    const {flags} = await this.parse(Tick)
    const file = playbookPath(flags.playbook)
    const playbookDir = path.dirname(file)
    const now = new Date()
    const secrets = loadSecrets()
    const sync = makeSync(secrets, (message) => {
      if (!this.jsonEnabled()) this.log(message)
    })

    if (flags['dry-run']) {
      // The dry-run stays on the local playbook (shows the file's schedule, does not touch the network).
      const playbook = loadPlaybook(file)
      const selection = selectDue(playbook, loadState(statePath()), now)
      const payload = {
        dryRun: true,
        due: selection.due.map((entry) => ({name: entry.name, reason: entry.decision.reason})),
        seed: selection.seed.map((entry) => entry.name),
        errors: selection.errors,
      }
      if (!this.jsonEnabled()) {
        this.log(`due: ${payload.due.map((d) => d.name).join(', ') || '(nessuna)'}`)
        this.log(`seed: ${payload.seed.join(', ') || '(nessuna)'}`)
        if (payload.errors.length > 0) this.log(`errori schedule: ${payload.errors.map((e) => e.name).join(', ')}`)
      }
      return payload
    }

    // Agent source: API (sync configured) or local playbook file.
    let playbook: Playbook
    let authorizedCwds: Record<string, string> | undefined
    let ticketQueues: Record<string, TicketQueueTarget> | undefined
    if (sync) {
      const synced = await sync()
      if (!synced) {
        if (!this.jsonEnabled()) this.log('sync: niente da eseguire')
        return {skipped: true, executed: [], seeded: [], scheduleErrors: [], pruned: 0}
      }

      playbook = synced.playbook
      authorizedCwds = synced.authorizedCwds
      ticketQueues = synced.ticketQueues
    } else {
      playbook = loadPlaybook(file)
    }

    // CYAU-220: a tick launched by hand says the same thing the daemon says when the machine cannot beat.
    const heartbeatMissing = heartbeatMissingReason(secrets)
    if (heartbeatMissing && !this.jsonEnabled()) this.log(heartbeatMissing)
    // CYAU-224: the tick sees the same Claude credential the daemon would.
    await makeOrgClaudeCredentialReconciler(secrets, {log: (message) => this.log(message)})?.(true)
    await makeOrgOpenrouterKeyReconciler(secrets, {log: (message) => this.log(message)})?.(true)
    const result = await runOnce({
      playbook,
      playbookDir,
      now,
      stateFile: statePath(),
      logDir: logsDir(),
      lockFile: lockPath(),
      label: 'automator',
      secrets: secretCapabilities(secrets),
      // Host beat: monitor heartbeat + renewal of the active leases (a tick keeps the held leases alive) +
      // reconciliation of the skill bundle with the server pin (CYAU-129). A single `tick` runs it too: whoever
      // debugs by hand must see the same machine the daemon will see, not one with a different bundle.
      heartbeat: combineBeats(
        makeHeartbeat(secrets, {version: this.config.version}),
        makeLeaseRenewer(secrets),
        makeSkillsReconciler(secrets, {log: (message) => this.log(message)}),
      ),
      authorizedCwds,
      ticketQueues,
      preflight: makeTicketPreflight(secrets),
      // CYAU-101: a stop with a candidate in hand puts the ticket on hold server-side, so the project
      // queue advances instead of fetching the same ticket again at every tick.
      deferQueue: makeQueueDeferrer(secrets),
      // CYAU-169: the dispatch asks for work with the atomic claim, so several tickets of the SAME queue
      // can run together up to the cap instead of waiting one tick each.
      claimQueue: makeQueueClaimer(secrets),
      // CYAU-248: each ticket session gets a one-hour GitHub token for its own repository.
      githubToken: makeGithubTokenFetcher(secrets, {log: (message) => this.log(message)}),
      // Skill-mode (CYAU-69): dispatch via bounded pool, cap = host-scoped max_parallel. The resolver is invoked
      // by runOnce ONLY in skill-mode (no policy call in prompt-mode).
      skillsMode: skillsModeEnabled(),
      flowMaxParallel: () => resolveHostFlowConcurrency(secrets, now),
    })

    if (!this.jsonEnabled()) {
      if (result.skipped) this.log('skip: tick già in corso (lock detenuto)')
      else {
        this.log(`eseguite: ${result.executed.map((e) => `${e.name}=${e.status}`).join(', ') || '(nessuna)'}`)
        for (const stopped of result.preflightStopped) {
          this.log(`preflight stop "${stopped.name}" [${stopped.state}]: ${stopped.reason}`)
        }
      }
    }

    return result
  }
}
