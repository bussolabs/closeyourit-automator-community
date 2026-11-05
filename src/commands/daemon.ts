import * as path from 'node:path'
import {Flags} from '@oclif/core'
import {BaseCommand} from '../base'
import {runDaemon} from '../lib/daemon'
import {makeSupporterPass} from '../lib/supporter'
import {makeCouncilPass} from '../lib/council'
import {hasOperationalHostIdentity, loadSecrets, secretCapabilities} from '../lib/config'
import {combineBeats, heartbeatMissingReason, makeHeartbeat} from '../lib/heartbeat'
import {makeHostRegistrar} from '../lib/host'
import {makeLeaseRenewer} from '../lib/lease'
import {agentRuntimeReadiness} from '../lib/runtime-probe'
import {makeOrgClaudeCredentialReconciler} from '../lib/org-claude-credential'
import {makeOrgOpenrouterKeyReconciler} from '../lib/org-openrouter-credential'
import {makeSkillsReconciler} from '../lib/skills-manifest'
import {makeSync} from '../lib/sync'
import {agentConversationsDir, logsDir, lockPath, playbookPath, skillsModeEnabled, statePath} from '../lib/paths'
import {localConversationStore} from '../lib/agent-conversation'
import {agentCodexHome} from '../lib/executor'
import {guardrailsInstalled, installGuardrails} from '../lib/guardrails'
import {activeManagedGuardrailPaths} from '../lib/managed-service'
import {makeGithubTokenFetcher} from '../lib/github-token'
import {makeQueueClaimer, makeQueueDeferrer, makeTicketPreflight, resolveHostFlowConcurrency} from '../lib/ticket-preflight'
import {detectPlatform, type OsPlatform} from '../lib/service'
import {consumeHangMarker, createHangReportQueue, startHangWatchdog} from '../lib/hang-watchdog'

export default class Daemon extends BaseCommand {
  static description = 'Avvia il loop persistente (tenuto vivo dal servizio systemd utente)'

  static examples = ['<%= config.bin %> daemon', '<%= config.bin %> daemon --interval 30']

  static flags = {
    playbook: Flags.string({description: 'Path del playbook (default: ./playbook.yml o AUTOMATOR_PLAYBOOK)'}),
    interval: Flags.integer({description: 'Secondi tra le iterazioni', default: 60}),
  }

  /** Test seam: the real daemon is available only on Linux. */
  protected currentPlatform(): OsPlatform {
    return detectPlatform()
  }

  async run(): Promise<unknown> {
    this.currentPlatform()
    const {flags} = await this.parse(Daemon)
    // CYAU-289: before anything else, take the hang the previous process left behind (moved aside, read once), so
    // it reaches exactly one beat even if this start fails later.
    const hangReports = createHangReportQueue(consumeHangMarker())
    const file = playbookPath(flags.playbook)
    // Legacy upgrade: the previous updater does not know the generation marker of the new release. The first
    // boot adopts/repairs the canonical set on the persisted paths of the managed unit, using its effective Node,
    // before scheduling any run. An unmanaged service instead keeps using the paths derived from the env.
    const guardrailPaths = activeManagedGuardrailPaths()
    if (!guardrailsInstalled(guardrailPaths)) {
      installGuardrails(path.join(this.config.root, 'assets', 'guardrails'), guardrailPaths)
    }
    const secrets = loadSecrets()
    const log = (message: string): void => this.log(`[${new Date().toISOString()}] ${message}`)

    // Agent Host self-registration at boot: idempotent and best-effort. `ensureHostRegistered` never
    // throws (fetch with timeout → handled network error, persistence caught) and returns within the
    // timeout: it neither kills nor hangs the daemon startup; if it fails, it retries at the next start.
    // CYAU-220: the registrar also writes the heartbeat section when missing (hosts installed before included);
    // the lookup has its own timeout and never throws, so a slow server does not hold the start either.
    const registrar = makeHostRegistrar(secrets, log, undefined, this.config.version)
    const registration = registrar ? await registrar() : undefined
    const setup = registration?.heartbeat
    const heartbeatMissing = heartbeatMissingReason(secrets, setup?.status === 'missing' ? setup.reason : undefined)
    if (heartbeatMissing) log(heartbeatMissing)
    // CYAU-224: fetch the organization's Claude credential before the first cycle, then every few beats. A change
    // drops the cached readiness probe: it ran with the old credential and may hold for up to an hour.
    const claudeCredential = makeOrgClaudeCredentialReconciler(secrets, {log, onChange: () => agentRuntimeReadiness.invalidate()})
    if (claudeCredential) await claudeCredential(true)
    // CYAU-228: the same for the OpenRouter key OpenCode reviews with.
    const openrouterKey = makeOrgOpenrouterKeyReconciler(secrets, {log})
    if (openrouterKey) await openrouterKey(true)

    // CYAU-289: the watchdog thread gets the reduced-beat target in memory; without a heartbeat it only writes the marker.
    const watchdog = startHangWatchdog({
      beat: secrets.heartbeat && hasOperationalHostIdentity(secrets)
        ? {heartbeat: secrets.heartbeat, hostToken: secrets.host.token, hostId: secrets.host.id, version: this.config.version}
        : undefined,
      onResumed: () => hangReports.push(consumeHangMarker()),
      log,
    })

    await runDaemon({
      playbookFile: file,
      stateFile: statePath(),
      logDir: logsDir(),
      lockFile: lockPath(),
      intervalMs: flags.interval * 1000,
      label: 'automator',
      secrets: secretCapabilities(secrets),
      // Host beat: monitor heartbeat + renewal of the active leases (while the host is alive its leases
      // stay its own; if it dies, the beats stop and the server expires them → recovery) + reconciliation of the
      // skill bundle with the server pin (CYAU-129: without it, the bundle only arrived by hand and never updated).
      heartbeat: combineBeats(
        makeHeartbeat(secrets, {version: this.config.version, log, hang: () => hangReports.take()}),
        makeLeaseRenewer(secrets),
        makeSkillsReconciler(secrets, {log}),
        claudeCredential,
        openrouterKey,
      ),
      sync: makeSync(secrets, log), // undefined when sync is not configured → local playbook file
      supporter: makeSupporterPass(secrets, {log}), // CYAU-235
      council: makeCouncilPass(secrets, {log}), // CYAU-273
      preflight: makeTicketPreflight(secrets),
      // CYAU-101: a stop with a candidate in hand puts the ticket on hold server-side, so the project
      // queue advances instead of fetching the same ticket again at every tick.
      deferQueue: makeQueueDeferrer(secrets),
      // CYAU-169: the dispatch asks for work with the atomic claim, so several tickets of the SAME queue
      // can run together up to the cap instead of waiting one tick each.
      claimQueue: makeQueueClaimer(secrets),
      // CYAU-248: each ticket session gets a one-hour GitHub token for its own repository.
      githubToken: makeGithubTokenFetcher(secrets, {log}),
      // CYAU-285: a phase interrupted by a restart resumes its agent conversation when its file is still here.
      conversations: localConversationStore(agentConversationsDir(), () => agentCodexHome()),
      // Skill-mode (CYAU-69): dispatch via bounded pool, cap = host-scoped max_parallel. Skill-mode is fixed for
      // the process (env); the resolver re-reads the policy at every iteration (fresh, fail-closed cache).
      skillsMode: skillsModeEnabled(),
      flowMaxParallel: () => resolveHostFlowConcurrency(secrets, new Date()),
      watchdog,
      log,
    })

    return {stopped: true}
  }
}
