import * as os from 'node:os'
import * as path from 'node:path'
import {Flags} from '@oclif/core'
import {BaseCommand} from '../base'
import {buildPathEnv, detectPlatform, serviceManager, userRuntimeDir} from '../lib/service'
import {installAutoUpdate} from '../lib/auto-update-timer'
import {codexHomeDir, configDir, installRoot as managedInstallRoot, playbookPath, stateDir, worktreesDir} from '../lib/paths'
import {installGuardrails} from '../lib/guardrails'
import {saveManagedServiceConfig} from '../lib/managed-service'
import {enableSecureCredentials} from '../lib/config'
import {probeLinuxHost, requireLinuxHost} from '../lib/linux-host'

export default class Install extends BaseCommand {
  static description = 'Installa il servizio systemd user su Linux'

  static examples = [
    '<%= config.bin %> install',
    '<%= config.bin %> install --playbook ./playbook.yml --interval 30',
    '<%= config.bin %> install --managed',
  ]

  static flags = {
    playbook: Flags.string({description: 'Path del playbook (default: ./playbook.yml o AUTOMATOR_PLAYBOOK)'}),
    interval: Flags.integer({description: 'Secondi tra le iterazioni del daemon', default: 60}),
    // Managed layout (CYAU-33): the service runs `installRoot/current/bin/run.js` (the SYMLINK path, not
    // resolved) → at every restart systemd follows `current`, so `automator update` (swap of `current` +
    // restart) restarts the daemon on the new version. Without --managed the unit hardwires the current checkout
    // (backward compat: development/`pnpm build`), which updates do NOT update.
    managed: Flags.boolean({description: 'punta il servizio al layout gestito installRoot/current (aggiornabile con automator update)', default: false}),
    'install-root': Flags.string({description: 'root gestita (con --managed): default AUTOMATOR_INSTALL_ROOT o ~/.local/lib/...'}),
    'secrets-project': Flags.string({description: 'progetto CloseYourIt che custodisce i secret del servizio managed', default: 'CYAU'}),
    'secrets-environment': Flags.string({description: 'environment CloseYourIt dei secret del servizio managed', default: 'production'}),
    // Host-first turn-on (CYAU-90): the daemon runs the phases via the closeyourit-skills skills instead of the
    // legacy prompt-mode. Off by default (additive, fail-closed): without it, the daemon stays in prompt-mode.
    'skills-enabled': Flags.boolean({description: 'abilita lo skill-mode del daemon (esecuzione host-first via il bundle closeyourit-skills)', default: false}),
  }

  async run(): Promise<unknown> {
    const {flags} = await this.parse(Install)

    // The Linux contract is a prerequisite of the installation, not a skill-mode option. Checking it
    // before guardrails, credentials and unit prevents partial installations and any silent downgrade.
    const hostChecks = await probeLinuxHost()
    try {
      requireLinuxHost(hostChecks)
    } catch (error) {
      this.error(
        `Host Linux non idoneo: ${error instanceof Error ? error.message : String(error)}. ` +
        'Installa systemd >= 254, abilita il user manager e cgroup v2, installa bubblewrap/libsecret ' +
        'e rendi disponibile una sessione D-Bus con Secret Service sbloccato.',
        {exit: 2},
      )
    }

    const platform = detectPlatform()
    const homeDir = os.homedir()
    const file = playbookPath(flags.playbook)
    const installRootDir = path.resolve(flags['install-root']?.trim() || managedInstallRoot())
    const codexHome = codexHomeDir()

    const args = ['daemon', '--playbook', file]
    if (flags.interval !== 60) args.push('--interval', String(flags.interval))

    // In managed mode the entrypoint is the `current` symlink (followed at every start → updates take effect);
    // otherwise the checkout `install` runs from (fixed path).
    const entrypoint = flags.managed
      ? path.join(installRootDir, 'current', 'bin', 'run.js')
      : path.join(this.config.root, 'bin', 'run.js')

    // First prepare and validate the whole guardrail set with atomic writes. Only then may the daemon start:
    // systemd `enable --now` must not observe a partial installation.
    const guardrails = installGuardrails(path.join(this.config.root, 'assets', 'guardrails'))

    if (flags.managed) {
      const serviceAccountToken = process.env.CLOSEYOURIT_TOKEN
      try {
        enableSecureCredentials({
          version: 1,
          provider: 'closeyourit-keychain',
          project: flags['secrets-project'],
          environment: flags['secrets-environment'],
        }, {serviceAccountToken})
      } finally {
        // The token is needed only for the migration into the credential store: no later subprocess inherits it.
        delete process.env.CLOSEYOURIT_TOKEN
      }
      saveManagedServiceConfig(installRootDir, {
        version: 1,
        codexHome,
        nodePath: process.execPath,
        guardrails: {
          hooksDir: guardrails.hooksDir,
          settingsPath: guardrails.settingsPath,
          codexRulesPath: guardrails.codexRulesPath,
          worktreesRoot: worktreesDir(),
        },
      })
    }

    const pathEnv = buildPathEnv(homeDir)
    const serviceEnv = {
      AUTOMATOR_STATE_DIR: stateDir(),
      AUTOMATOR_CONFIG_DIR: configDir(),
      AUTOMATOR_PLAYBOOK: file,
      // The Codex policy is installed in the effective home resolved here: the daemon must use the same root,
      // even when CODEX_HOME was an override of the shell that ran `install`.
      CODEX_HOME: codexHome,
      // With --managed the daemon inherits the managed root so `automator update` works on the same installRoot.
      ...(flags.managed ? {AUTOMATOR_INSTALL_ROOT: installRootDir} : {}),
      // Host-first turn-on (CYAU-90): turns on skill-mode in the daemon (the value is read by skillsModeEnabled()).
      // Off by default → prompt-mode; allowed in the unit via SAFE_SERVICE_ENV.
      ...(flags['skills-enabled'] ? {AUTOMATOR_SKILLS_ENABLED: 'true'} : {}),
      // Set in the install shell, read by the guardrails: without them in the unit the daemon would build other guardrails
      // than the installed ones and refuse every Claude session (CYRA-914 B9).
      ...(process.env.AUTOMATOR_PRODUCTION_HOSTS ? {AUTOMATOR_PRODUCTION_HOSTS: process.env.AUTOMATOR_PRODUCTION_HOSTS} : {}),
      ...(process.env.AUTOMATOR_SANDBOX_DOMAINS ? {AUTOMATOR_SANDBOX_DOMAINS: process.env.AUTOMATOR_SANDBOX_DOMAINS} : {}),
    }

    const manager = serviceManager(platform)
    manager.install({
      nodePath: process.execPath,
      entrypoint,
      args,
      pathEnv,
      workingDir: path.dirname(file),
      env: serviceEnv,
    })

    // CYAU-202: the timer that updates the machine by itself. Only in managed mode — without it, the unit points to
    // the checkout `install` started from and `automator update` does not touch it: a timer there would run idle.
    // The environment is THE SAME as the daemon's: with a different state folder the update would look at another
    // lock and would not see that the machine is working.
    if (flags.managed) {
      installAutoUpdate(homeDir, {
        nodePath: process.execPath,
        entrypoint,
        pathEnv,
        homeDir,
        runtimeDir: userRuntimeDir(),
        env: serviceEnv,
      })
    }

    if (!this.jsonEnabled()) {
      this.log(`Servizio installato (${platform}).`)
      this.log(`Unit:      ${manager.unitPath()}`)
      this.log(`Entrypoint: ${entrypoint}`)
      this.log(`Log:       ${manager.logsPath()}`)
      this.log(`Guardrail Claude: ${guardrails.settingsPath} (${guardrails.hooks.length} hook)`)
      this.log(`Guardrail Codex:  ${guardrails.codexRulesPath}`)
      if (flags.managed) {
        this.log(`Gestito: il servizio segue ${path.join(installRootDir, 'current')} (aggiornabile con "automator update").`)
        this.log('Aggiornamento automatico attivo: ogni ora, e solo quando la macchina non sta lavorando.')
        this.log('Esegui prima "automator update" per popolare la release attiva, altrimenti il servizio non parte.')
      }
      this.log(flags['skills-enabled']
        ? 'Skill-mode ABILITATO: il daemon esegue le fasi host-first via il bundle closeyourit-skills.'
        : 'Skill-mode OFF (prompt-mode): ripeti QUESTO stesso comando "install" con --skills-enabled in coda (mantieni le opzioni gia\' usate: --managed/--playbook/--install-root/--interval) per accendere l\'esecuzione host-first.')
      if (platform === 'linux') {
        this.log('Server headless (avvio senza login): loginctl enable-linger "$USER"')
      }
    }

    return {
      platform,
      unit: manager.unitPath(),
      entrypoint,
      managed: flags.managed,
      skillsEnabled: flags['skills-enabled'],
      logs: manager.logsPath(),
      playbook: file,
      guardrails: guardrails.settingsPath,
      codexGuardrails: guardrails.codexRulesPath,
      credentialsProvider: flags.managed ? {
        provider: 'closeyourit-keychain',
        project: flags['secrets-project'],
        environment: flags['secrets-environment'],
      } : null,
    }
  }
}
