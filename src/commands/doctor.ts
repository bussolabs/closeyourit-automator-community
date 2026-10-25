import {BaseCommand} from '../base'
import {probeAllAsync} from '../lib/deps'
import {probeRuntimes, type RuntimeStatus} from '../lib/runtime'
import {renderTable} from '../lib/output'
import {AutomatorError, ErrorCodes} from '../errors/error-codes'
import {probeLinuxHost, requireLinuxHost} from '../lib/linux-host'
import {activeManagedGuardrailPaths} from '../lib/managed-service'
import {guardrailsSettingsPath} from '../lib/paths'
import {probeAgentRuntimes, type RuntimeReadiness} from '../lib/runtime-probe'
import {
  claudeReviewCredentialProblem,
  resolveClaudeReviewCredential,
  type ClaudeReviewCredential,
} from '../lib/claude-review-credential'
import {CLAUDE_LOCAL_AUTH_ENV} from '../lib/env-capabilities'
import {orgClaudeCredential} from '../lib/org-claude-credential'
import {orgOpenrouterKey} from '../lib/org-openrouter-credential'
import {checkPrivateServer, privateServerMessage} from '../lib/private-server'
import {resolveReviewerRuntime} from '../lib/review-execution'
import {adoptServiceGuardrailEnv, serviceManager} from '../lib/service'

export default class Doctor extends BaseCommand {
  static description = 'Verifica CLI e runtime agente (claude/codex) prima di avviare il servizio'

  static examples = ['<%= config.bin %> doctor', '<%= config.bin %> doctor --json']

  async run(): Promise<unknown> {
    await this.parse(Doctor)
    // The guardrails depend on hosts and domains saved in the unit, not in this shell (CYRA-914 B9). Only Linux has a
    // unit; elsewhere the host checks below already say the platform is unsupported.
    if (process.platform === 'linux') adoptServiceGuardrailEnv(serviceManager())
    // The two families and every single probe are isolated: a hung CLI does not hide the state of the others.
    const [deps, runtimes, hostChecks] = await Promise.all([probeAllAsync(), probeRuntimes(), probeLinuxHost()])

    // Cross review (CYAU-66) requires BOTH runtimes available: the implementer and the OPPOSITE runtime
    // that reviews its output before delivery. Codex is `required:false` (the playbook path only uses
    // Claude), so the table shows it as optional — a misleading message for a host of the host-first
    // queue, where WITHOUT the reviewer runtime every delivery is rejected and the run is wasted. The warning
    // here is the "doctor checks BOTH runtimes" part with an operational meaning, without imposing Codex as a
    // gate (it would break the playbook path): it stays a warning, not an error.
    const crossReviewAvailable = runtimes.every((r) => r.available)
    // CYAU-206 — `--version` and `codex login status` say the CLI is there, not that the model answers: on
    // 23/09 they said "Logged in" with the login revoked. The real probe starts only if both CLIs are there.
    const liveProbe: RuntimeReadiness | undefined = crossReviewAvailable
      ? await probeAgentRuntimes({settingsPath: activeManagedGuardrailPaths().settingsPath ?? guardrailsSettingsPath()})
      : undefined
    // CYAU-223 — the confined Claude review cannot see the machine home: check the credential it will really get,
    // whenever Claude is installed and whatever the state of Codex.
    const claudeReview = deps.find((dep) => dep.name === 'claude')?.present ? resolveClaudeReviewCredential() : undefined
    const claudeReviewProblem = claudeReview && claudeReviewCredentialProblem(claudeReview)
    // CYAU-238 — with Codex at work, a server on a private network must be written as its IPv4 address. Never blocking.
    const privateServer = await checkPrivateServer()

    if (!this.jsonEnabled()) {
      this.log(
        renderTable(
          ['CLI', 'PRESENTE', 'VERSIONE', 'RICHIESTA'],
          deps.map((d) => [d.name, d.present ? 'sì' : 'no', d.version ?? '-', d.required ? 'sì' : 'no']),
        ),
      )
      this.log('')
      this.log(
        renderTable(
          ['HOST LINUX', 'DISPONIBILE', 'PROBLEMA'],
          hostChecks.map((check) => [check.id, check.ok ? 'sì' : 'no', check.detail ?? '-']),
        ),
      )
      this.log('')
      this.log(
        renderTable(
          ['RUNTIME', 'DISPONIBILE', 'RICHIESTO', 'PROBLEMA'],
          runtimes.map((r) => [r.id, r.available ? 'sì' : 'no', r.required ? 'sì' : 'no', problem(r)]),
        ),
      )
      if (!crossReviewAvailable) {
        this.log('')
        this.log(
          '⚠ Revisione incrociata non disponibile: servono entrambi i runtime (claude e codex). '
            + 'Con la rilettura «L\'altro motore» le consegne di questa macchina vengono rifiutate. '
            + "Installa il runtime mancante con 'automator setup --optional', oppure in CloseYourIt → Automator "
            + 'imposta per questa macchina «Chi rilegge il lavoro: Lo stesso motore» (CYRA-921).',
        )
      }
      if (liveProbe) {
        this.log('')
        this.log(liveProbe.ready
          ? 'Prova reale di claude e codex: rispondono.'
          : `⚠ Prova reale fallita: ${liveProbe.detail}. Finché non risponde, la macchina non chiede lavoro alla coda.`)
        // The service gets its Claude token from the user manager environment (environment.d), which an SSH
        // shell does not load: there the probe fails even while the daemon works.
        if (!liveProbe.ready && liveProbe.detail?.startsWith('claude:') && !orgClaudeCredential()
          && !CLAUDE_LOCAL_AUTH_ENV.some((name) => process.env[name])) {
          this.log('This shell has no Claude credentials, while the service may get them from ~/.config/environment.d: '
            + 'the failed probe holds for this shell only. Check the host state on CloseYourIt before logging in again.')
        }
      }
      // CYRA-878: the review runs only trusted executables (no group/other write on the file or any parent).
      // CYAU-222: checked with the same resolution the diff review uses, on both runtimes whatever is installed,
      // because Claude's review runs inside the Codex sandbox: without a usable Codex no diff review can run.
      for (const id of ['claude', 'codex'] as const) {
        try {
          await resolveReviewerRuntime(id, {forbiddenRoots: []})
        } catch (error) {
          this.log('')
          this.log(`⚠ ${id} cannot review: ${error instanceof Error ? error.message : String(error)}. `
            + (id === 'codex' ? "Claude's diff review runs inside the Codex sandbox, so every diff review will be unavailable. " : '')
            + `Install ${id} under /usr/local/bin, ~/.local/bin or a mise install (a global 'sudo npm -g' in /usr/lib is refused), `
            + `then 'chmod -R go-w' its install path.`)
        }
      }
      // CYAU-228 — OpenCode reviews with the organization's OpenRouter key and nothing else: say whether it is here.
      if (deps.find((dep) => dep.name === 'opencode')?.present) {
        this.log('')
        this.log(orgOpenrouterKey()
          ? 'OpenCode can review: the organization OpenRouter key is on this machine.'
          : '⚠ OpenCode is installed but the organization OpenRouter key is not on this machine, so OpenCode reviews '
            + 'will be unavailable. The owner sets it in CloseYourIt → Agents → OpenRouter key.')
      }
      const privateServerLine = privateServerMessage(privateServer)
      if (privateServerLine) {
        this.log('')
        this.log(privateServerLine)
      }
      if (claudeReview) {
        this.log('')
        this.log(claudeReviewProblem ? `✗ Claude cannot review: ${claudeReviewProblem}` : claudeReviewSignIn(claudeReview))
      }
    }

    const missing = deps.filter((d) => d.required && !d.present)
    if (missing.length > 0) {
      throw new AutomatorError(
        ErrorCodes.Dep.missingRequired,
        `CLI richieste mancanti: ${missing.map((d) => d.name).join(', ')} — lancia bin/bootstrap.sh o 'automator setup'`,
        1,
      )
    }

    try {
      requireLinuxHost(hostChecks)
    } catch (error) {
      throw new AutomatorError(
        ErrorCodes.Service.unsupportedOs,
        `Host Linux non idoneo: ${error instanceof Error ? error.message : String(error)}`,
        1,
      )
    }

    // A REQUIRED runtime present as a CLI but not usable (probe ≠ exit 0) stays blocking: the `fix`
    // gives the practical correction, without exposing secrets. Optional runtimes (codex) are only reported.
    const unavailable = runtimes.filter((r) => r.required && !r.available)
    if (unavailable.length > 0) {
      throw new AutomatorError(
        ErrorCodes.Runtime.unavailable,
        `Runtime richiesti non disponibili: ${unavailable.map((r) => `${r.id} (${r.fix})`).join('; ')}`,
        1,
      )
    }

    // CYAU-223: blocking, because every Claude review of this machine would end «not logged in».
    if (claudeReviewProblem) {
      throw new AutomatorError(ErrorCodes.Runtime.unavailable, `Claude cannot review: ${claudeReviewProblem}`, 1)
    }

    return {
      ok: true, deps, runtimes, hostChecks, crossReviewAvailable,
      ...(liveProbe ? {liveProbe} : {}),
      ...(privateServer.kind === 'none' ? {} : {privateServer}),
      // Status and source only: the token itself never reaches the output.
      ...(claudeReview ? {claudeReview: {status: claudeReview.status, source: claudeReview.source}} : {}),
    }
  }
}

function claudeReviewSignIn(credential: ClaudeReviewCredential): string {
  if (credential.source === 'organization') return 'Claude can review: it uses the organization Claude credential.'
  if (credential.source === 'environment') return 'Claude can review: it uses the Claude token of the service environment.'
  if (credential.source === 'machine') {
    return `Claude can review: it uses the Claude sign-in of this machine, valid until ${new Date(credential.expiresAt).toISOString()}.`
  }
  return 'Claude cannot review: no credential.'
}

/** PROBLEMA column: '-' when available, otherwise "problem — practical correction" (never secrets). */
function problem(r: RuntimeStatus): string {
  return r.available ? '-' : [r.detail, r.fix].filter(Boolean).join(' — ')
}
