import {Args} from '@oclif/core'
import {BaseCommand} from '../base'
import {hasOperationalHostIdentity, loadSecrets} from '../lib/config'
import {makeClient} from '../lib/client'
import {skillsDir} from '../lib/paths'
import {defaultSkillsGit, syncFromSkillsManifest} from '../lib/skills-manifest'
import {AutomatorError, ErrorCodes} from '../errors/error-codes'

/**
 * `automator skill sync`: downloads the PINNED skill bundle (plugin `closeyourit-skills`) from the host-scoped manifest
 * (`GET /api/v1/agent_host/skill_manifest`) and syncs it under `skills/<version>`, promoting `skills/current`
 * (the skill-mode `--plugin-dir`). Idempotent and non-destructive (reuses `syncFromSkillsManifest` / C.1).
 * No bundle pinned server-side (404) → soft no-op (the host stays in prompt-mode): additive.
 */
export default class Skill extends BaseCommand {
  static description =
    "Sincronizza il bundle skill pinnato (plugin closeyourit-skills) dal manifest host-scoped: clona/aggiorna skills/<version> al ref pinnato, verifica il digest e promuove skills/current. Idempotente e non distruttivo. Nessun bundle pinnato → niente da fare (prompt-mode)"

  static examples = ['<%= config.bin %> skill sync', '<%= config.bin %> skill sync --json']

  static args = {
    action: Args.string({description: "sottocomando (per ora solo 'sync')", default: 'sync', options: ['sync']}),
  }

  async run(): Promise<unknown> {
    await this.parse(Skill)
    const secrets = loadSecrets()

    if (!secrets.sync) {
      throw new AutomatorError(ErrorCodes.Sync.notConfigured, 'Canale API non configurato: manca "sync" nei secret', 2)
    }
    if (!hasOperationalHostIdentity(secrets)) {
      throw new AutomatorError(ErrorCodes.Sync.hostNotConfigured, 'Host non registrato o credenziale host non valida: esegui "automator register"', 2)
    }

    const client = makeClient(secrets.sync, undefined, secrets.host.token)
    // Exactly the same sync as the daemon beat (CYAU-129): this command only saves waiting for the
    // next round. No privileged path — if it had one, the manual and the automatic behaviour
    // would diverge, and that is the first thing nobody remembers later.
    // `checkPinLag` is the only difference, and it is not a privilege: whoever runs the command is looking NOW,
    // so the pin ↔ published tags comparison (CYAU-135) is always paid; the beat does it on a cadence.
    const report = await syncFromSkillsManifest({client, base: skillsDir(), git: defaultSkillsGit(), checkPinLag: true})

    // null = host not registered or no pinned bundle (404) → prompt-mode. Additive: soft no-op (exit 0).
    if (report === null) {
      if (!this.jsonEnabled()) this.log('Nessun bundle skill pinnato: niente da sincronizzare (gli host restano in prompt-mode)')
      return {synced: false, action: null, pluginDir: null, pinCheck: {state: 'skipped'}}
    }

    if (!report.ok) {
      // report.detail already embeds the Manifest.* code (occupied/mismatch/gitFailed).
      throw new AutomatorError(ErrorCodes.Manifest.gitFailed, `sync skill fallita: ${report.detail}`, 1)
    }

    if (!this.jsonEnabled()) {
      this.log(`bundle ${report.version} (${report.repo}@${report.ref}) ${report.action}: ${report.detail}`)
      this.log(`plugin attivo: ${report.pluginDir}`)
      // The sync succeeded and that is exactly the point: the host is aligned TO THE PIN, but the pin fell
      // behind what the repo published. It is not a command error (exit 0): it is the only possible
      // diagnosis from here of a release that looks successful and leaves the machines on the old instructions.
      if (report.pinCheck.state === 'behind') {
        this.log('')
        this.log(
          `⚠ Pin non aggiornato: il server pinna la ${report.pinCheck.lag.pinned}, ma ${report.repo} ha già pubblicato la ${report.pinCheck.lag.latest}. `
            + 'Finché il pin resta indietro ogni host esegue le istruzioni vecchie: ripubblica il tag o registra il pin a mano.',
        )
      }
      // Silence = "pin up to date" for the reader: a check that did not succeed must be said, otherwise this
      // command reassures without having verified anything.
      if (report.pinCheck.state === 'unknown') {
        this.log('')
        this.log(
          `⚠ Pin non verificato: le versioni pubblicate da ${report.repo} non sono leggibili in questo momento. `
            + 'Il bundle attivo è quello pinnato, ma non si può dire se il pin sia aggiornato.',
        )
      }
    }
    return {synced: true, ...report}
  }
}
