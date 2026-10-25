import * as fs from 'node:fs'
import * as path from 'node:path'
import {type HostEntry, type Secrets} from './config'
import {type ProbeResult} from './deps'
import {type RuntimeStatus} from './runtime'
import {type EnsureHostResult} from './host'
import {skillsPluginDir} from './paths'

// Guided enrollment of the Mac/host (CYAU-9). A single verifiable, idempotent path that turns a
// new machine into an operational worker: registers the machine as an Agent Host (CloseYourIt device
// flow), checks provider/GitHub/guardrails/repositories/service, then runs the full diagnostics
// (the same probes as `doctor`). It mutates nothing irreversible and NEVER prints secrets: every step
// reports only an outcome and how to remedy it. Re-running it is safe — registration is a no-op if already done and
// all the other checks are read-only.

export type StepStatus = 'ok' | 'missing'

export type StepKey = 'cyi' | 'host' | 'provider' | 'codex' | 'github' | 'guardrails' | 'repositories' | 'skill-bundle' | 'service'

/** System service state relevant to the enrollment: installed AND running. */
export interface ServiceHealth {
  installed: boolean
  running: boolean
}

export interface EnrollStep {
  key: StepKey
  label: string
  required: boolean // if true and not 'ok', the enrollment is not ready
  status: StepStatus
  detail?: string // plain outcome/remedy — NEVER secrets (token/cwd)
}

export interface EnrollDiagnostics {
  deps: ProbeResult[]
  runtimes: RuntimeStatus[]
}

export interface EnrollResult {
  ready: boolean // true when every required step is ok AND the diagnostics have no required gaps
  steps: EnrollStep[]
  diagnostics: EnrollDiagnostics
}

export interface EnrollDeps {
  secrets: Secrets
  // Agent Host registrar: missing when the registration authority is missing (service account token cyi_u_
  // in the credential store, or org token cyi_a_ for backward compat).
  registrar?: () => Promise<EnsureHostResult>
  probeDeps: () => ProbeResult[] | Promise<ProbeResult[]> // CLI probe (doctor)
  probeRuntimes: () => Promise<RuntimeStatus[]> // agent runtime probe (doctor)
  claudeAuthenticated: () => boolean | Promise<boolean> // `claude auth status`: the machine's LOCAL auth, not a token in the vault
  guardrailsInstalled: () => boolean
  serviceHealth: () => ServiceHealth
  githubAuthenticated: () => boolean | Promise<boolean>
  cyiAuthenticated: () => boolean | Promise<boolean> // CloseYourIt device flow (`cyi login`), the agent's identity on the tickets
  codexAuthenticated: () => boolean | Promise<boolean> // Codex device flow (`codex login`), OPTIONAL runtime of the cross review
  // Skill-mode on for the service (unit env): decides whether the skill bundle is a prerequisite.
  skillsModeEnabled: () => boolean
  // Skill bundle resolvable on disk: it MUST use the same resolution as the queue preflight
  // (`realpath` of `skillsPluginDir()`), otherwise enroll and preflight can diverge and the machine
  // goes back to declaring itself ready while the queue stops.
  skillBundleResolved: () => boolean
  repoExists: (cwd: string) => boolean
}

/** CloseYourIt device flow: `cyi login` authenticates the account the agent self-assigns and comments tickets with. */
function cyiStep(authenticated: boolean): EnrollStep {
  const base = {key: 'cyi' as const, label: 'CloseYourIt CLI (cyi) autenticata', required: true}
  return authenticated
    ? {...base, status: 'ok', detail: 'cyi autenticata (device flow)'}
    : {...base, status: 'missing', detail: "cyi non autenticata: esegui 'cyi login' (device flow)"}
}

/** Registers the host on CloseYourIt (idempotent). Without configured sync it is a missing step, not an error. */
async function hostStep(registrar?: () => Promise<EnsureHostResult>): Promise<EnrollStep> {
  const base = {key: 'host' as const, label: 'CloseYourIt host (registrazione device)', required: true}
  if (!registrar) {
    return {...base, status: 'missing', detail: "autorità di registrazione assente: fornisci il token del service account (cyi_u_) come CLOSEYOURIT_TOKEN durante 'automator install --managed'"}
  }
  const res = await registrar()
  if (res.status === 'failed') {
    return {...base, status: 'missing', detail: 'registrazione non riuscita: CloseYourIt non raggiungibile, riprova'}
  }
  const verb = res.status === 'existing' ? 'già registrato' : 'registrato'
  return {...base, status: 'ok', detail: `host ${verb} (id ${res.host?.id ?? '-'})`}
}

/** Agent provider: claude runtime available (probe) + valid LOCAL auth (`claude auth status`). The automator does NOT
 * keep the Claude token: the auth lives on the machine (claude login / ANTHROPIC_API_KEY). Never prints the token. */
function providerStep(runtimes: RuntimeStatus[], claudeAuthenticated: boolean): EnrollStep {
  const base = {key: 'provider' as const, label: 'Provider agente (claude)', required: true}
  const runtimeOk = runtimes.find((r) => r.id === 'claude')?.available === true
  if (runtimeOk && claudeAuthenticated) return {...base, status: 'ok', detail: 'claude disponibile e autenticato localmente'}
  const problems: string[] = []
  if (!runtimeOk) problems.push("claude non disponibile: installa/aggiorna con 'automator setup'")
  if (!claudeAuthenticated) problems.push("claude non autenticato per il servizio: esegui 'claude login' come utente del servizio (auth durevole via HOME; una API key va resa durevole nell'ambiente del servizio, non solo nella shell)")
  return {...base, status: 'missing', detail: problems.join(' · ')}
}

/**
 * Codex authenticated (device flow `codex login`). OPTIONAL runtime (Claude↔Codex cross review): it is NOT
 * required, so its absence does not block `ready` — it is a recommended step, not an error. Like gh/cyi,
 * it checks only the probe outcome, never prints the token.
 */
function codexStep(authenticated: boolean): EnrollStep {
  const base = {key: 'codex' as const, label: 'Codex CLI (codex) autenticata', required: false}
  return authenticated
    ? {...base, status: 'ok', detail: 'codex autenticata (device flow)'}
    : {...base, status: 'missing', detail: "codex non autenticata (opzionale, review incrociata): esegui 'codex login'"}
}

function githubStep(authenticated: boolean): EnrollStep {
  const base = {key: 'github' as const, label: 'GitHub CLI (gh) autenticata', required: true}
  return authenticated
    ? {...base, status: 'ok', detail: 'gh autenticata'}
    : {...base, status: 'missing', detail: "gh non autenticata: esegui 'gh auth login' (scope repo)"}
}

function guardrailsStep(installed: boolean): EnrollStep {
  const base = {key: 'guardrails' as const, label: 'Guardrail bypass installati', required: true}
  return installed
    ? {...base, status: 'ok', detail: 'hook + settings.json presenti'}
    : {...base, status: 'missing', detail: "guardrail assenti: esegui 'automator install'"}
}

/** Every project of the host map must point to a real git checkout on THIS machine. Reports the KEYS, never the paths. */
function repositoriesStep(hosts: Record<string, HostEntry> | undefined, repoExists: (cwd: string) => boolean): EnrollStep {
  const base = {key: 'repositories' as const, label: 'Repository mappati (host-map)', required: true}
  const entries = Object.entries(hosts ?? {})
  if (entries.length === 0) {
    return {...base, status: 'missing', detail: "nessun repository mappato: esegui 'automator link <dir>' per rilevarli dai remote Git"}
  }
  const missing = entries.filter(([, entry]) => !repoExists(entry.cwd)).map(([key]) => key)
  if (missing.length > 0) {
    return {...base, status: 'missing', detail: `checkout non trovato per: ${missing.join(', ')} — esegui 'automator link <dir>'`}
  }
  return {...base, status: 'ok', detail: `${entries.length} repository verificati`}
}

/**
 * In skill-mode the queue can run only with the skill bundle present on disk: without it, the preflight
 * stops with the "skill bundle missing or unresolvable" reason BEFORE the claim (`ticket-preflight.ts`) and the
 * machine stays silent — it beats, it is certified, it claims nothing, and no log tells the operator.
 * Since CYAU-129 the daemon downloads it by itself at the beat (`makeSkillsReconciler`), so the step here is a
 * SNAPSHOT of now, not work left to the operator: an enroll launched before the first beat
 * sees it missing and a minute later sees it in place. `automator skill sync` remains to force it right away.
 *
 * With skill-mode off there is no queue to serve: the step stays informative (not required), like the
 * preflight that in that case does not even start the confinement probe.
 */
function skillBundleStep(skillsMode: boolean, resolved: boolean): EnrollStep {
  const base = {key: 'skill-bundle' as const, label: 'Bundle skill (skill-mode)', required: skillsMode}
  if (!skillsMode) return {...base, status: 'ok', detail: 'skill-mode spento: nessun bundle richiesto (prompt-mode)'}
  return resolved
    ? {...base, status: 'ok', detail: 'bundle skill presente e risolvibile'}
    : {...base, status: 'missing', detail: "bundle skill assente: il daemon lo scarica da solo al prossimo battito; 'automator skill sync' per non aspettare"}
}

// A host is operational only if the service is installed AND the daemon runs: a stopped unit runs nothing,
// so 'installed but not running' stays a step to do (CYAU-9, Codex review).
function serviceStep(health: ServiceHealth): EnrollStep {
  const base = {key: 'service' as const, label: 'Servizio systemd utente', required: true}
  if (!health.installed) return {...base, status: 'missing', detail: "servizio non installato: esegui 'automator install'"}
  if (!health.running) return {...base, status: 'missing', detail: 'servizio installato ma non in esecuzione: controlla i log del servizio'}
  return {...base, status: 'ok', detail: 'unit installata e in esecuzione'}
}

/**
 * Runs the enrollment: registers the host (idempotent), collects the step outcomes and the diagnostics.
 * The runtimes are probed only ONCE and reused both by the provider step and by the diagnostics (no
 * double spawn). `ready` is true only if every required step is ok AND the diagnostics have no required
 * CLIs/runtimes missing — so "ready" also covers the prerequisites `doctor` checks.
 */
export async function runEnroll(deps: EnrollDeps): Promise<EnrollResult> {
  const [runtimeOutcome, depsOutcome, cyiOutcome, githubOutcome, codexOutcome, claudeOutcome] = await Promise.allSettled([
    Promise.resolve().then(() => deps.probeRuntimes()),
    Promise.resolve().then(() => deps.probeDeps()),
    Promise.resolve().then(() => deps.cyiAuthenticated()),
    Promise.resolve().then(() => deps.githubAuthenticated()),
    Promise.resolve().then(() => deps.codexAuthenticated()),
    Promise.resolve().then(() => deps.claudeAuthenticated()),
  ])
  const runtimes = runtimeOutcome.status === 'fulfilled'
    ? runtimeOutcome.value
    : [{id: 'claude', required: true, available: false, detail: 'probe fallito', fix: "riprova 'automator enroll'"}]
  const probedDeps = depsOutcome.status === 'fulfilled'
    ? depsOutcome.value
    : [{name: 'diagnostica', bin: '-', present: false, version: null, required: true}]
  const steps: EnrollStep[] = [
    cyiStep(cyiOutcome.status === 'fulfilled' && cyiOutcome.value),
    await hostStep(deps.registrar),
    providerStep(runtimes, claudeOutcome.status === 'fulfilled' && claudeOutcome.value),
    codexStep(codexOutcome.status === 'fulfilled' && codexOutcome.value),
    githubStep(githubOutcome.status === 'fulfilled' && githubOutcome.value),
    guardrailsStep(deps.guardrailsInstalled()),
    repositoriesStep(deps.secrets.hosts, deps.repoExists),
    skillBundleStep(deps.skillsModeEnabled(), deps.skillBundleResolved()),
    serviceStep(deps.serviceHealth()),
  ]
  const diagnostics: EnrollDiagnostics = {deps: probedDeps, runtimes}

  const stepsOk = steps.every((s) => !s.required || s.status === 'ok')
  const depsOk = diagnostics.deps.every((d) => !d.required || d.present)
  const runtimesOk = diagnostics.runtimes.every((r) => !r.required || r.available)
  return {ready: stepsOk && depsOk && runtimesOk, steps, diagnostics}
}

/**
 * true if the skill bundle is resolvable on disk. It is DELIBERATELY the same resolution as the queue
 * preflight (`realpath` of the `skills/current` symlink, which there also pins the bytes against a
 * concurrent re-point): if the two diverged, `enroll` would go back to declaring ready a machine
 * that then stops at the first tick. `realpath` throwing = missing bundle.
 */
export function skillBundleResolved(): boolean {
  try {
    return fs.realpathSync(skillsPluginDir()).length > 0
  } catch {
    return false
  }
}

/**
 * true if `cwd` exists and is a git checkout (`.git` as a directory in the repo or as a file in worktrees).
 * Best-effort: any I/O error → false (the enrollment reports it as a missing checkout).
 */
export function repoExists(cwd: string): boolean {
  try {
    return fs.existsSync(cwd) && fs.existsSync(path.join(cwd, '.git'))
  } catch {
    return false
  }
}
