import {BaseCommand} from '../base'
import {loadSecrets} from '../lib/config'
import {makeHostRegistrar} from '../lib/host'
import {claudeAuthenticatedAsync, codexAuthenticatedAsync, cyiAuthenticatedAsync, githubAuthenticatedAsync, probeAllAsync} from '../lib/deps'
import {probeRuntimes} from '../lib/runtime'
import {guardrailsInstalled} from '../lib/guardrails'
import {serviceManager, serviceSkillsModeEnabled} from '../lib/service'
import {repoExists, runEnroll, skillBundleResolved} from '../lib/enroll'
import {renderTable} from '../lib/output'

export default class Enroll extends BaseCommand {
  static description =
    'Enrollment guidato del Mac: registra la macchina, verifica i prerequisiti (provider, GitHub, guardrail, repository, servizio) ed esegue la diagnostica completa. Ripetibile e idempotente'

  static examples = ['<%= config.bin %> enroll', '<%= config.bin %> enroll --json']

  async run(): Promise<unknown> {
    await this.parse(Enroll)
    const secrets = loadSecrets()

    // A single verifiable path: host registration (idempotent) + read-only checks + diagnostics.
    // No step throws: a missing prerequisite is a "to do" step, not an error (new Mac = normal).
    const result = await runEnroll({
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
      // Skill-mode of the UNIT, not of the shell: see serviceSkillsModeEnabled.
      skillsModeEnabled: () => serviceSkillsModeEnabled(serviceManager()),
      skillBundleResolved,
    })

    if (!this.jsonEnabled()) {
      this.log(
        renderTable(
          ['PASSO', 'ESITO', 'DETTAGLIO'],
          result.steps.map((s) => [s.label, s.status === 'ok' ? 'ok' : 'da fare', s.detail ?? '']),
        ),
      )
      this.log('')
      // Full diagnostics at the end (same probes as `doctor`): CLI + agent runtime.
      this.log(
        renderTable(
          ['CLI', 'PRESENTE', 'VERSIONE', 'RICHIESTA'],
          result.diagnostics.deps.map((d) => [d.name, d.present ? 'sì' : 'no', d.version ?? '-', d.required ? 'sì' : 'no']),
        ),
      )
      this.log('')
      this.log(
        renderTable(
          ['RUNTIME', 'DISPONIBILE', 'RICHIESTO'],
          result.diagnostics.runtimes.map((r) => [r.id, r.available ? 'sì' : 'no', r.required ? 'sì' : 'no']),
        ),
      )
      this.log('')
      if (result.ready) {
        this.log('Enrollment completo: la macchina è pronta.')
      } else {
        // The missing steps also include the required CLIs detected by the diagnostics (they count towards `ready`
        // but have no dedicated step) → the list covers ALL the causes of "not ready" (Codex review).
        const todo = [
          ...result.steps.filter((s) => s.required && s.status !== 'ok').map((s) => s.label),
          ...result.diagnostics.deps.filter((d) => d.required && !d.present).map((d) => `CLI ${d.name}`),
        ]
        this.log(`Enrollment incompleto — passaggi mancanti: ${todo.join(', ')}`)
      }
    }

    return result
  }
}
