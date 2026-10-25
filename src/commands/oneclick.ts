import {spawnSync} from 'node:child_process'
import * as path from 'node:path'
import {Flags} from '@oclif/core'
import {BaseCommand} from '../base'
import {hasOperationalHostIdentity, loadSecrets, type Secrets} from '../lib/config'
import {makeClient} from '../lib/client'
import {makeHostRegistrar} from '../lib/host'
import {claudeAuthenticatedAsync, codexAuthenticatedAsync, cyiAuthenticatedAsync, githubAuthenticatedAsync, probeAllAsync} from '../lib/deps'
import {probeRuntimes} from '../lib/runtime'
import {guardrailsInstalled} from '../lib/guardrails'
import {serviceManager} from '../lib/service'
import {repoExists, runEnroll, skillBundleResolved} from '../lib/enroll'
import {
  buildOneClickStages,
  defaultOneClickStore,
  type OneClickResult,
  type OneClickStageDeps,
  type OneClickStore,
  runOneClick,
  type StageOutcome,
  subcommandOutcome,
} from '../lib/oneclick'
import {replicateFromManifest, type ReplicationReport} from '../lib/workspace-manifest'
import {syncFromSkillsManifest, type SkillsSyncReport} from '../lib/skills-manifest'
import {skillsDir, skillsModeEnabled} from '../lib/paths'
import {AutomatorError, ErrorCodes} from '../errors/error-codes'

export default class OneClick extends BaseCommand {
  static description =
    "Provisioning OneClick di una macchina worker: esegue in sequenza gli stadi (toolchain → auth → update → install --managed → register+enroll → replica workspace → doctor), ognuno idempotente e checkpointato. Se uno stadio richiede un'azione umana (toolchain assente → bootstrap.sh; login device-flow mancante) si ferma stampando cosa fare; rieseguire 'automator oneclick' riprende dallo stadio non completato. Esiti: pronto → exit 0; azione umana richiesta → exit 3; stadio fallito → exit 1"

  static examples = ['<%= config.bin %> oneclick', '<%= config.bin %> oneclick --json', '<%= config.bin %> oneclick --reset']

  static flags = {
    reset: Flags.boolean({description: 'riparte da zero: scarta lo stato resumable e riesegue tutti gli stadi', default: false}),
    channel: Flags.string({description: 'canale di update (stable|beta)', default: 'stable'}),
  }

  async run(): Promise<unknown> {
    const {flags} = await this.parse(OneClick)
    const secrets = loadSecrets()
    const store = this.makeStore()
    if (flags.reset) store.reset()

    const result = await runOneClick({stages: buildOneClickStages(this.stageDeps(secrets, flags.channel)), store})

    if (!this.jsonEnabled()) this.printResult(result)
    if (result.ready) return this.payload(result)

    // Blocking stage: human action (exit 3, safe-by-default gate) vs operational failure (exit 1).
    const error = result.status === 'failed'
      ? new AutomatorError(ErrorCodes.OneClick.failed, `stadio "${result.stopped}" fallito: ${stageDetail(result)}`, 1)
      : new AutomatorError(ErrorCodes.OneClick.stopped, `stadio "${result.stopped}" richiede un'azione umana; esegui i passi indicati e rilancia 'automator oneclick' per riprendere`, 3)

    if (this.jsonEnabled()) this.logJson({...this.payload(result), error: {code: error.code, message: error.message}})
    throw error
  }

  /** Store of the resumable state. Overridable in tests. */
  protected makeStore(): OneClickStore {
    return defaultOneClickStore()
  }

  /**
   * REAL probes of every stage. Overridable in tests (the orchestration — order/resume/exit — is tested with
   * fake probes, without really running update/install/clone). update/install run as subcommands.
   */
  protected stageDeps(secrets: Secrets, channel: string): OneClickStageDeps {
    return {
      probeToolchain: () => probeAllAsync(),
      probeAuth: async () => {
        const [github, cyi, codex, claude] = await Promise.all([githubAuthenticatedAsync(), cyiAuthenticatedAsync(), codexAuthenticatedAsync(), claudeAuthenticatedAsync()])
        return {github, cyi, codex, claudeAuth: claude}
      },
      runUpdate: async () => this.runSubcommand('update', ['--channel', channel]),
      runInstall: async () => this.runSubcommand('install', ['--managed']),
      runEnrollment: () => runEnroll({
        secrets,
        registrar: makeHostRegistrar(secrets, undefined, undefined, this.config.version),
        probeDeps: () => probeAllAsync(),
        probeRuntimes: () => probeRuntimes(),
        guardrailsInstalled: () => guardrailsInstalled(),
        serviceHealth: () => {
          const s = serviceManager().status()
          return {installed: s.installed, running: s.running}
        },
        githubAuthenticated: () => githubAuthenticatedAsync(),
        cyiAuthenticated: () => cyiAuthenticatedAsync(),
        codexAuthenticated: () => codexAuthenticatedAsync(),
        claudeAuthenticated: () => claudeAuthenticatedAsync(),
        repoExists,
        skillsModeEnabled: () => skillsModeEnabled(),
        skillBundleResolved,
      }),
      replicate: () => this.replicate(secrets),
      syncSkills: () => this.syncSkills(secrets),
      diagnose: async () => {
        const [deps, runtimes] = await Promise.all([probeAllAsync(), probeRuntimes()])
        return {deps, runtimes}
      },
    }
  }

  /** Fetches the server manifest and replicates the repos under the resolved workspace root (secret override or hint under $HOME). */
  protected replicate(secrets: Secrets): Promise<ReplicationReport | null> {
    const client = secrets.sync && hasOperationalHostIdentity(secrets) ? makeClient(secrets.sync, undefined, secrets.host.token) : null
    return replicateFromManifest({client, workspaceRootOverride: secrets.workspaceRoot})
  }

  /** Fetches the skill manifest and syncs the pinned bundle under skillsDir() (best-effort, additive). */
  protected syncSkills(secrets: Secrets): Promise<SkillsSyncReport | null> {
    const client = secrets.sync && hasOperationalHostIdentity(secrets) ? makeClient(secrets.sync, undefined, secrets.host.token) : null
    // OneClick is the snapshot the operator reads at setup: like `skill sync`, the pin ↔ published tags
    // comparison (CYAU-135) is always paid. It runs once, not every minute like the beat.
    return syncFromSkillsManifest({client, base: skillsDir(), checkPinLag: true})
  }

  /**
   * Runs an automator subcommand as a subprocess and maps its exit code onto the StageOutcome (via
   * subcommandOutcome, pure). Overridable in tests (so as not to really spawn update/install).
   */
  protected runSubcommand(command: string, args: string[]): StageOutcome {
    const entrypoint = path.join(this.config.root, 'bin', 'run.js')
    const res = spawnSync(process.execPath, [entrypoint, command, ...args], {encoding: 'utf8', stdio: ['ignore', 'inherit', 'inherit']})
    return subcommandOutcome(command, args, res.status ?? 1)
  }

  private payload(result: OneClickResult): Record<string, unknown> {
    return {
      ready: result.ready,
      stopped: result.stopped,
      status: result.status,
      completed: result.completed,
      instructions: result.instructions,
      stages: result.results.map((r) => ({stage: r.stage, status: r.status, detail: r.detail})),
    }
  }

  private printResult(result: OneClickResult): void {
    this.log('OneClick provisioning')
    for (const r of result.results) {
      const mark = r.status === 'completed' ? 'ok' : r.status === 'skipped' ? '· (già fatto)' : r.status === 'blocked' ? 'AZIONE' : 'FALLITO'
      this.log(`  [${mark}] ${r.stage} — ${r.detail}`)
    }
    this.log('')
    if (result.ready) {
      this.log('Macchina pronta: tutti gli stadi completati.')
      return
    }
    this.log(`Fermato allo stadio "${result.stopped}" (${result.status}).`)
    if (result.instructions.length > 0) {
      this.log('Passi da eseguire:')
      for (const step of result.instructions) this.log(`  - ${step}`)
    }
    this.log("Poi rilancia 'automator oneclick' per riprendere da dove si è fermato.")
  }
}

/** Detail of the last stage (the one that stopped), for the error message. */
function stageDetail(result: OneClickResult): string {
  return result.results.at(-1)?.detail ?? result.status
}
