import * as fs from 'node:fs'
import {oneclickStatePath} from './paths'
import {writeAtomicJson} from './state'
import type {ProbeResult} from './deps'
import type {RuntimeStatus} from './runtime'
import type {EnrollResult} from './enroll'
import type {ReplicationReport} from './workspace-manifest'
import type {SkillsSyncReport} from './skills-manifest'
import {LOCAL_WORK_ENGINE} from './models'

// OneClick provisioning of a worker machine (CYAU OneClick): turns a new Mac/host into an operational worker with
// a single command, as a sequence of ordered, idempotent STAGES. Every completed stage is CHECKPOINTED under
// the state dir (state.ts pattern) → re-running `oneclick` resumes from the first uncompleted stage. The stages
// that require a HUMAN ACTION (missing toolchain → bootstrap.sh; missing device-flow auth → gh/cyi/claude/
// codex login) do NOT perform it: they print the instruction and stop (blocked); the state does not advance and a rerun,
// after the action, resumes. The `runOneClick` core is PURE: stage handlers and store are injectable → the
// LOGIC (order, resume from checkpoint, block) is tested without really running update/install/clone.

export type OneClickStageId = 'toolchain' | 'auth' | 'update' | 'install' | 'enroll' | 'workspace' | 'skills' | 'doctor'

// Canonical stage order: toolchain → auth → update → install → enroll → workspace → skills → doctor.
export const ONECLICK_STAGES: readonly OneClickStageId[] = ['toolchain', 'auth', 'update', 'install', 'enroll', 'workspace', 'skills', 'doctor']

export type StageStatus = 'completed' | 'blocked' | 'failed'

/**
 * Outcome of ONE stage: `completed` (continue), `blocked` (human action → stop, resume with a rerun after
 * the action), `failed` (operational error → stop). `instructions` are the human steps to perform before
 * re-running (blocked only). `data` is the stage's structured payload (e.g. the replication report), for the audit/--json.
 */
export interface StageOutcome {
  status: StageStatus
  detail: string
  instructions?: string[]
  data?: unknown
}

export type StageHandler = () => StageOutcome | Promise<StageOutcome>
export type OneClickStages = Record<OneClickStageId, StageHandler>

/** Resumable state: the COMPLETED stages (in canonical order). A blocked/failed stage does not enter here → the rerun retries it. */
export interface OneClickState {
  version: 1
  updated_at: string // ISO 8601 of the last completed stage
  completed: OneClickStageId[]
}

export function emptyOneClickState(): OneClickState {
  return {version: 1, updated_at: '', completed: []}
}

/** Injectable store of the resumable state (default: `oneclick.json` file under the state dir). */
export interface OneClickStore {
  load(): OneClickState
  save(state: OneClickState): void
  reset(): void // discards the state → the next run restarts from the first stage (the stages are idempotent)
}

export interface OneClickStageResult {
  stage: OneClickStageId
  status: StageStatus | 'skipped' // skipped = already completed in a previous run (resume)
  detail: string
  instructions?: string[]
  data?: unknown
}

export interface OneClickResult {
  ready: boolean // true if EVERY stage is completed
  stopped: OneClickStageId | null // the stage that stopped (blocked/failed), or null if ready
  status: StageStatus | 'ready'
  results: OneClickStageResult[]
  completed: OneClickStageId[]
  instructions: string[] // the blocking stage's instructions (convenience for printing)
}

export interface RunOneClickDeps {
  stages: OneClickStages
  store: OneClickStore
  now?: () => string // ISO 8601, injectable in tests
}

/**
 * PURE, RESUMABLE orchestrator: runs the stages in canonical order skipping those already completed (from the
 * store), stopping at the first `blocked`/`failed` (the state does NOT advance further → a rerun retries that stage).
 * Every completed stage is persisted AT ONCE (checkpoint): an interruption keeps the progress up to the last
 * completed one. Returns `ready:true` only when all stages are completed.
 */
export async function runOneClick(deps: RunOneClickDeps): Promise<OneClickResult> {
  const now = deps.now ?? (() => new Date().toISOString())
  const state = deps.store.load()
  const completed = new Set<OneClickStageId>(state.completed.filter((s) => ONECLICK_STAGES.includes(s)))
  const results: OneClickStageResult[] = []

  for (const stage of ONECLICK_STAGES) {
    if (completed.has(stage)) {
      results.push({stage, status: 'skipped', detail: 'già completato in un run precedente'})
      continue
    }

    const outcome = await deps.stages[stage]()
    results.push({
      stage,
      status: outcome.status,
      detail: outcome.detail,
      ...(outcome.instructions ? {instructions: outcome.instructions} : {}),
      ...(outcome.data !== undefined ? {data: outcome.data} : {}),
    })

    if (outcome.status !== 'completed') {
      return {
        ready: false,
        stopped: stage,
        status: outcome.status,
        results,
        completed: ONECLICK_STAGES.filter((s) => completed.has(s)),
        instructions: outcome.instructions ?? [],
      }
    }

    completed.add(stage)
    // Immediate checkpoint after every stage: an interruption keeps the progress, the rerun does not repeat it.
    deps.store.save({version: 1, updated_at: now(), completed: ONECLICK_STAGES.filter((s) => completed.has(s))})
  }

  return {ready: true, stopped: null, status: 'ready', results, completed: ONECLICK_STAGES.filter((s) => completed.has(s)), instructions: []}
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/**
 * Reads the resumable state, tolerantly: missing or corrupt file (illegal JSON / non-object root) → empty
 * state (restarts from the first stage: the stages are idempotent, a rerun from scratch is safe). Unknown stage
 * ids in the `completed` list are discarded (never considered completed).
 */
export function readOneClickState(file: string): OneClickState {
  let raw: string
  try {
    raw = fs.readFileSync(file, 'utf8')
  } catch {
    return emptyOneClickState()
  }

  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    return emptyOneClickState()
  }
  if (!isRecord(parsed)) return emptyOneClickState()

  const completed = Array.isArray(parsed.completed)
    ? parsed.completed.filter((s): s is OneClickStageId => typeof s === 'string' && (ONECLICK_STAGES as readonly string[]).includes(s))
    : []
  return {version: 1, updated_at: typeof parsed.updated_at === 'string' ? parsed.updated_at : '', completed}
}

/** Real store on the `oneclick.json` file (atomic write via state.ts). No secrets: only the list of stages. */
export function defaultOneClickStore(file: string = oneclickStatePath()): OneClickStore {
  return {
    load: () => readOneClickState(file),
    save: (state) => writeAtomicJson(file, state),
    reset: () => {
      try {
        fs.rmSync(file, {force: true})
      } catch {
        // best-effort: a failed reset leaves the previous state (re-runnable anyway).
      }
    },
  }
}

// ── Pure outcome helpers: they map the outcome of each stage's probes into a StageOutcome ─────────────────
// Separate from the command (which does the real I/O) so the DECISION of every stage is testable without processes/network.

/** Toolchain bootstrap instruction (the only piece that starts without Node). */
export const BOOTSTRAP_SCRIPT = 'procedures/machine-bootstrap/bootstrap.sh'

/** Toolchain stage: required CLIs present? Missing → blocked (run bootstrap.sh, then relaunch). */
export function toolchainOutcome(deps: ProbeResult[]): StageOutcome {
  const missing = deps.filter((d) => d.required && !d.present).map((d) => d.name)
  if (missing.length === 0) return {status: 'completed', detail: 'toolchain completa (CLI richieste presenti)', data: {deps}}
  return {
    status: 'blocked',
    detail: `CLI richieste mancanti: ${missing.join(', ')}`,
    instructions: [`Esegui ${BOOTSTRAP_SCRIPT} per installare la toolchain (mise/node/pnpm/gh/cyi/claude), poi rilancia 'automator oneclick'`],
    data: {deps, missing},
  }
}

export interface AuthProbes {
  github: boolean
  cyi: boolean
  claudeAuth: boolean
  codex: boolean
}

/**
 * Auth stage (device flow): missing gh/cyi/claude → blocked with the login instructions (it does NOT run the device
 * flows, it prints them). Codex is OPTIONAL (cross review): its absence does NOT block, it is only a suggestion.
 */
export function authOutcome(probes: AuthProbes, engine: 'claude' | 'codex' = LOCAL_WORK_ENGINE): StageOutcome {
  const instructions: string[] = []
  if (!probes.github) instructions.push("gh non autenticata: esegui 'gh auth login' (scope repo)")
  if (!probes.cyi) instructions.push("cyi non autenticata: esegui 'cyi login' (device flow)")
  // CYRA-921 — a machine that works with Codex needs Codex signed in; Claude becomes the optional reviewer.
  if (engine === 'codex') {
    if (!probes.codex) instructions.push("codex not signed in for the service: run 'codex login' as the service user")
    if (instructions.length > 0) {
      return {status: 'blocked', detail: `autenticazioni richieste mancanti: ${instructions.length}`, instructions}
    }
    return {status: 'completed', detail: probes.claudeAuth ? 'gh/cyi/codex signed in; claude signed in' : 'gh/cyi/codex signed in; claude (optional) not signed in'}
  }
  if (!probes.claudeAuth) instructions.push("claude non autenticato per il servizio: esegui 'claude login' come utente del servizio (auth durevole via HOME; una API key va resa durevole nell'ambiente del servizio, non solo nella shell)")
  if (instructions.length > 0) {
    return {status: 'blocked', detail: `autenticazioni richieste mancanti: ${instructions.length}`, instructions}
  }
  return {
    status: 'completed',
    detail: probes.codex
      ? 'gh/cyi/claude autenticati; codex autenticato'
      : "gh/cyi/claude autenticati; codex (opzionale) non autenticato — per la review incrociata: 'codex login'",
  }
}

/** Enroll stage (register + checks): ready → completed; otherwise blocked with the missing steps (never the secrets). */
export function enrollOutcome(result: EnrollResult): StageOutcome {
  if (result.ready) return {status: 'completed', detail: 'host registrato e prerequisiti verificati'}
  const missing = [
    // The skill bundle is the only prerequisite OneClick installs AFTERWARDS (`skills` stage, which in turn
    // requires the host identity registered right here): blocking the enrollment on it would make the first
    // provisioning impossible — enroll would not pass while the bundle is missing, and the bundle would never
    // arrive because the stage that downloads it is never reached. Outside OneClick the step stays blocking,
    // but since CYAU-129 it no longer requires an intervention: the daemon beat reconciles it with the server pin.
    ...result.steps.filter((s) => s.required && s.status !== 'ok' && s.key !== 'skill-bundle').map((s) => s.label),
    ...result.diagnostics.deps.filter((d) => d.required && !d.present).map((d) => `CLI ${d.name}`),
  ]
  if (missing.length === 0) {
    return {status: 'completed', detail: 'host registrato; bundle skill atteso dallo stadio successivo'}
  }
  return {
    status: 'blocked',
    detail: `enrollment incompleto: ${missing.join(', ')}`,
    instructions: missing.map((m) => `Completa: ${m}`),
    data: {steps: result.steps},
  }
}

/**
 * Workspace stage: unretrievable manifest → failed (host not registered or server unreachable);
 * otherwise the replication is best-effort → completed with the report (per-repo failures do NOT block OneClick,
 * they are noted for the audit).
 */
export function workspaceOutcome(report: ReplicationReport | null): StageOutcome {
  if (report === null) {
    return {status: 'failed', detail: 'manifest del workspace non recuperabile (host non registrato o server irraggiungibile)'}
  }
  const {cloned, updated, failed, rejected, outcomes} = report
  return {
    status: 'completed',
    detail: `workspace replicato: ${cloned} clonati, ${updated} aggiornati, ${failed} falliti, ${rejected.length} scartati (${outcomes.length} repo)`,
    data: report,
  }
}

/**
 * Skills stage (bundle of the `closeyourit-skills` plugin). ADDITIVE, unlike workspace: `null` = host not
 * registered or no bundle pinned server-side (404) → prompt-mode, NOT an error. A sync not promoted for an
 * OPERATIONAL reason (occupied/git) does NOT block OneClick (the skills are optional): `completed`, noted for the audit.
 * The `mismatch` instead is different (CYAU-117): it is a failed INTEGRITY check — the content at the origin does not
 * match the approved version — and must be made `failed`, so the host does not continue as if nothing happened and whoever
 * looks at the outcome sees the failure. Successful promotion → completed with the active `pluginDir` (`skills/current`).
 */
export function skillsOutcome(report: SkillsSyncReport | null): StageOutcome {
  if (report === null) return {status: 'completed', detail: 'nessun bundle skill pinnato: gli host restano in prompt-mode'}
  if (report.action === 'mismatch') {
    return {status: 'failed', detail: `bundle skill NON verificato (integrità fallita): ${report.detail}`, data: report}
  }
  if (!report.ok) return {status: 'completed', detail: `bundle skill non promosso (prompt-mode): ${report.detail}`, data: report}
  // `current` = it was already aligned with the pin (CYAU-129: the reconciliation in the beat keeps it updated, so
  // a re-run OneClick often finds it already in place). Stage completed anyway: the active bundle is the right one.
  const base = report.action === 'current'
    ? `bundle skill ${report.version} già attivo → ${report.pluginDir}`
    : `bundle skill ${report.version} pronto (${report.action}) → ${report.pluginDir}`
  return {status: 'completed', detail: `${base}${pinLagNote(report)}`, data: report}
}

/**
 * CYAU-135. The bundle is the right one — it is aligned with the pin — but the PIN fell behind what the
 * repo already published: nothing needs fixing on the host, and indeed the stage stays `completed`. Without this
 * note the gap would appear nowhere and the skills release would look successful while every
 * machine runs the old instructions.
 */
function pinLagNote(report: SkillsSyncReport): string {
  if (report.pinCheck.state === 'behind') {
    return ` — ATTENZIONE: il pin è fermo alla ${report.pinCheck.lag.pinned} ma ${report.repo} ha già pubblicato la ${report.pinCheck.lag.latest}`
  }
  // A check that did not succeed is not a passed check: whoever reads the outcome must be able to tell them apart.
  if (report.pinCheck.state === 'unknown') return ` — pin non verificato (versioni pubblicate da ${report.repo} non leggibili)`
  return ''
}

/** Final doctor stage: required CLIs/runtimes ok → completed; missing → failed. Codex (optional) only noted. */
export function doctorOutcome(deps: ProbeResult[], runtimes: RuntimeStatus[]): StageOutcome {
  const missingDeps = deps.filter((d) => d.required && !d.present).map((d) => d.name)
  const missingRuntimes = runtimes.filter((r) => r.required && !r.available).map((r) => r.id)
  if (missingDeps.length > 0 || missingRuntimes.length > 0) {
    return {
      status: 'failed',
      detail: `diagnostica finale: CLI mancanti [${missingDeps.join(', ') || '-'}], runtime mancanti [${missingRuntimes.join(', ') || '-'}]`,
      data: {deps, runtimes},
    }
  }
  const codexAvailable = runtimes.find((r) => r.id === 'codex')?.available === true
  return {
    status: 'completed',
    detail: `diagnostica finale ok; codex (opzionale) ${codexAvailable ? 'disponibile' : 'non disponibile'}`,
    data: {deps, runtimes},
  }
}

/**
 * Maps the exit code of an automator subcommand (update/install) onto a StageOutcome. Pure and testable: exit
 * 0 → completed; exit 3 (update gate: no compatible version or successful rollback → healthy system but
 * not updated) → blocked (wait/human action, resumable); any other exit → failed (operational error).
 */
export function subcommandOutcome(command: string, args: string[], code: number): StageOutcome {
  if (code === 0) return {status: 'completed', detail: `${command} completato`}
  if (code === 3) {
    return {
      status: 'blocked',
      detail: `${command} non ha potuto proseguire (exit 3)`,
      instructions: [`Rivedi l'esito di 'automator ${command} ${args.join(' ')}' e rilancia 'automator oneclick'`],
    }
  }
  return {status: 'failed', detail: `${command} fallito (exit ${code})`}
}

/** Injectable probes to compose the real stages; they separate the DECISION (outcome helpers) from the I/O. */
export interface OneClickStageDeps {
  probeToolchain: () => Promise<ProbeResult[]>
  probeAuth: () => Promise<AuthProbes>
  runUpdate: () => Promise<StageOutcome>
  runInstall: () => Promise<StageOutcome>
  runEnrollment: () => Promise<EnrollResult>
  replicate: () => Promise<ReplicationReport | null>
  syncSkills: () => Promise<SkillsSyncReport | null>
  diagnose: () => Promise<{deps: ProbeResult[]; runtimes: RuntimeStatus[]}>
}

/** Composes the stage handlers from the injectable probes: applies the pure outcome helpers to the I/O outcome. */
export function buildOneClickStages(deps: OneClickStageDeps): OneClickStages {
  return {
    toolchain: async () => toolchainOutcome(await deps.probeToolchain()),
    auth: async () => authOutcome(await deps.probeAuth()),
    update: () => deps.runUpdate(),
    install: () => deps.runInstall(),
    enroll: async () => enrollOutcome(await deps.runEnrollment()),
    workspace: async () => workspaceOutcome(await deps.replicate()),
    skills: async () => skillsOutcome(await deps.syncSkills()),
    doctor: async () => {
      const {deps: cliDeps, runtimes} = await deps.diagnose()
      return doctorOutcome(cliDeps, runtimes)
    },
  }
}
