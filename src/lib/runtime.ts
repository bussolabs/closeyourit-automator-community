import {spawn as nodeSpawn} from 'node:child_process'
import {type Action} from './schema'
import {type RunContext, type RunResult, buildCommand, runAction, type SpawnFn} from './executor'
import {claudeIsError, CLAUDE_BIN} from './claude'
import {CODEX_BIN} from './codex'
import {claudeGuardrailsInstalled, codexGuardrailsInstalled} from './guardrails'
import {activeManagedGuardrailPaths} from './managed-service'
import {openLog} from './logger'
import {ErrorCodes} from '../errors/error-codes'
import {runProcessProbe, type ProcessProbeOptions} from './process-probe'
import {LOCAL_WORK_ENGINE} from './models'

// Common agent execution contract. It abstracts the PROVIDER (today the local claude/shell CLI via process,
// tomorrow a provider via API or another CLI) behind three capabilities: availability check, start,
// cancellation. The daemon always runs the same `execute → result` cycle, independent of the concrete runtime.
// The concrete providers: `SpawnRuntime` (generic local shell commands), `ClaudeRuntime` (claude actions, with
// guardrail gate and output interpretation) and `CodexRuntime` (codex actions, sandboxed `codex exec`, outcome
// via exit code). The runner routes every action to the runtime of its `type`.

/** Outcome of a runtime's availability check. */
export interface RuntimeHealth {
  available: boolean
  detail?: string // reason when not available (exit code, error message)
}

/** Handle on a started execution: the outcome (promise) and the cancellation. */
export interface RuntimeExecution {
  /** Resolves with the action outcome (never rejects: errors become `status`). */
  readonly result: Promise<RunResult>
  /** Cancels the running execution (best-effort): ends the underlying process/provider. */
  cancel(): void
}

/** Common contract: start (`execute`), cancellation (`RuntimeExecution.cancel`), availability (`healthCheck`). */
export interface AgentRuntime {
  /** Runtime identifier, for diagnostics and logs. */
  readonly id: string
  /** Provider availability check (e.g. binary reachable / endpoint ready). */
  healthCheck(): Promise<RuntimeHealth>
  /** Starts an action; returns the handle with the outcome and the cancellation. */
  execute(name: string, action: Action, ctx: RunContext): RuntimeExecution
}

/** Probes the availability of a local CLI provider (`<cmd> <args>`): exit 0 = ready. Never throws (health = false). */
async function probeHealth(spawn: SpawnFn, cmd: string, args: string[], options: ProcessProbeOptions = {}): Promise<RuntimeHealth> {
  const result = await runProcessProbe(cmd, args, {...options, spawn})
  if (result.timedOut) return {available: false, detail: `timeout dopo ${options.timeoutMs ?? 5000}ms`}
  if (result.error) return {available: false, detail: result.error}
  return result.code === 0 ? {available: true} : {available: false, detail: `exit ${result.code}`}
}

/**
 * Starts `runAction` propagating the cancellation: `cancel()` and any external signal (daemon shutdown)
 * abort the execution. The listener on the external signal must be detached at the end of the run: a shared,
 * long-lived signal (reused across runs) would otherwise accumulate a listener for every finished action → memory leak.
 * `isError` downgrades an exit-0 to a failure (the claude provider passes `claudeIsError`).
 */
function executeWithCancel(
  name: string,
  action: Action,
  ctx: RunContext,
  spawnDefault: SpawnFn,
  isError?: (stdout: string) => boolean,
): RuntimeExecution {
  const controller = new AbortController()
  const external = ctx.signal
  let detachExternal = (): void => undefined
  if (external) {
    if (external.aborted) controller.abort()
    else {
      const onExternalAbort = (): void => controller.abort()
      external.addEventListener('abort', onExternalAbort, {once: true})
      detachExternal = () => external.removeEventListener('abort', onExternalAbort)
    }
  }
  const result = runAction(name, action, {...ctx, spawn: ctx.spawn ?? spawnDefault, signal: controller.signal, isError})
  void result.then(detachExternal, detachExternal)
  return {result, cancel: () => controller.abort()}
}

export interface SpawnRuntimeOptions {
  /** Injectable spawn (default `node:child_process.spawn`); also used by the health probe. */
  spawn?: SpawnFn
  /** Command that probes the provider availability (default `claude --version`). */
  healthCommand?: {cmd: string; args: string[]}
  /** Probe timeout/cleanup; injectable for tests and slow installations. */
  probe?: Omit<ProcessProbeOptions, 'spawn'>
}

/**
 * Runtime for generic local commands, delegating to `runAction`.
 * The public behaviour stays unchanged — it is the current implementation encapsulated behind the common contract.
 * Cancellation propagates an `AbortSignal` down to the child.
 */
export class SpawnRuntime implements AgentRuntime {
  readonly id = 'spawn'
  private readonly spawn: SpawnFn
  private readonly healthCommand: {cmd: string; args: string[]}
  private readonly probeOptions: Omit<ProcessProbeOptions, 'spawn'>

  constructor(opts: SpawnRuntimeOptions = {}) {
    this.spawn = opts.spawn ?? (nodeSpawn as unknown as SpawnFn)
    this.healthCommand = opts.healthCommand ?? {cmd: CLAUDE_BIN, args: ['--version']}
    this.probeOptions = opts.probe ?? {}
  }

  healthCheck(): Promise<RuntimeHealth> {
    return probeHealth(this.spawn, this.healthCommand.cmd, this.healthCommand.args, this.probeOptions)
  }

  execute(name: string, action: Action, ctx: RunContext): RuntimeExecution {
    // Defence in depth: every agent action ALWAYS goes through its own provider and gate, even if routed
    // here. The routing in the runner stays an optimization, not a security requirement.
    if (action.type === 'claude') return new ClaudeRuntime({spawn: this.spawn}).execute(name, action, ctx)
    if (action.type === 'codex') return new CodexRuntime({spawn: this.spawn}).execute(name, action, ctx)
    return executeWithCancel(name, action, ctx, this.spawn)
  }
}

export interface ClaudeRuntimeOptions {
  /** Injectable spawn (default `node:child_process.spawn`); also used by the health probe. */
  spawn?: SpawnFn
  /** Guardrail installation check (override for tests; default: real check on disk). */
  guardrailsInstalled?: () => boolean
  probe?: Omit<ProcessProbeOptions, 'spawn'>
}

/**
 * Provider dedicated to **claude** actions (today the local `claude` CLI, tomorrow a provider via API): encapsulates
 * the claude-specific logic extracted from executor.ts — the **guardrail gate** (hooks required in every mode,
 * otherwise it REJECTS with `C412` without ever spawning) and the **output interpretation** (`is_error` ⇒ failure
 * even at exit 0). It preserves authentication, permissions, the guardrails' `--settings`, timeout and reporting:
 * the actual execution (argv via `buildClaudeArgv`, spawn/timeout/log/on_failure) is delegated to `runAction`.
 */
export class ClaudeRuntime implements AgentRuntime {
  readonly id = 'claude'
  private readonly spawn: SpawnFn
  private readonly guardrailsInstalled: () => boolean
  private readonly probeOptions: Omit<ProcessProbeOptions, 'spawn'>

  constructor(opts: ClaudeRuntimeOptions = {}) {
    this.spawn = opts.spawn ?? (nodeSpawn as unknown as SpawnFn)
    this.guardrailsInstalled = opts.guardrailsInstalled ?? (() => claudeGuardrailsInstalled(activeManagedGuardrailPaths()))
    this.probeOptions = opts.probe ?? {}
  }

  healthCheck(): Promise<RuntimeHealth> {
    return probeHealth(this.spawn, CLAUDE_BIN, ['--version'], this.probeOptions)
  }

  execute(name: string, action: Action, ctx: RunContext): RuntimeExecution {
    if (action.type === 'codex') return new CodexRuntime({spawn: this.spawn}).execute(name, action, ctx)
    if (action.type !== 'claude') return executeWithCancel(name, action, ctx, this.spawn)

    // Every permission mode requires the hooks: the chosen mode cannot disable the policy.
    const guardrailsOk = ctx.guardrailsInstalled ?? this.guardrailsInstalled
    if (!guardrailsOk()) {
      return {result: Promise.resolve(rejectGuardrails(name, action, ctx)), cancel: () => undefined}
    }

    return executeWithCancel(name, action, ctx, this.spawn, claudeIsError)
  }
}

export interface CodexRuntimeOptions {
  /** Injectable spawn (default `node:child_process.spawn`); also used by the health probe. */
  spawn?: SpawnFn
  guardrailsInstalled?: () => boolean
  /** CYRA-921 — a skill session runs under the Claude hooks too: both generations must be installed and intact. */
  skillGuardrailsInstalled?: () => boolean
  probe?: Omit<ProcessProbeOptions, 'spawn'>
}

/**
 * Provider dedicated to **codex** actions (local `codex exec` CLI, non-interactive/headless). Like ClaudeRuntime
 * it requires the installed `.rules` policy and stays subject to the wrapper's **command policy** (`runAction`, CYAU-25).
 * The native sandbox (`danger-full-access` not exposed), disabled network, ignored user config and the Codex
 * policy confine the session and block sensitive operations before execution. The outcome is given by the exit code:
 * no downgrade of an exit-0. It preserves timeout, logs, cancellation and reporting: the actual execution
 * (argv via `buildCodexArgv`, spawn/timeout/log/on_failure) is delegated to `runAction`; `cancel()` and an external signal
 * abort the execution (SIGTERM→SIGKILL down to the child).
 */
export class CodexRuntime implements AgentRuntime {
  readonly id = 'codex'
  private readonly spawn: SpawnFn
  private readonly guardrailsInstalled: () => boolean
  private readonly skillGuardrailsInstalled: () => boolean
  private readonly probeOptions: Omit<ProcessProbeOptions, 'spawn'>

  constructor(opts: CodexRuntimeOptions = {}) {
    this.spawn = opts.spawn ?? (nodeSpawn as unknown as SpawnFn)
    this.guardrailsInstalled = opts.guardrailsInstalled ?? (() => codexGuardrailsInstalled(activeManagedGuardrailPaths()))
    this.skillGuardrailsInstalled = opts.skillGuardrailsInstalled ??
      (() => codexGuardrailsInstalled(activeManagedGuardrailPaths()) && claudeGuardrailsInstalled(activeManagedGuardrailPaths()))
    this.probeOptions = opts.probe ?? {}
  }

  healthCheck(): Promise<RuntimeHealth> {
    return probeHealth(this.spawn, CODEX_BIN, ['--version'], this.probeOptions)
  }

  execute(name: string, action: Action, ctx: RunContext): RuntimeExecution {
    if (action.type === 'claude') return new ClaudeRuntime({spawn: this.spawn}).execute(name, action, ctx)
    if (action.type === 'codex') {
      const guardrailsOk = ctx.guardrailsInstalled ?? (action.skill ? this.skillGuardrailsInstalled : this.guardrailsInstalled)
      if (!guardrailsOk()) return {result: Promise.resolve(rejectGuardrails(name, action, ctx)), cancel: () => undefined}
    }
    return executeWithCancel(name, action, ctx, this.spawn)
  }
}

/** Outcome of an agent runtime probe for the diagnostics (`automator doctor`). */
export interface RuntimeStatus {
  id: string // 'claude' | 'codex'
  required: boolean // claude is required, codex is optional (consistent with DEPS)
  available: boolean // the binary answers the `--version` probe (exit 0)
  detail?: string // problem when not available (exit code / message) — NEVER credentials
  fix?: string // practical fix when not available — static, without secrets
}

/** Descriptor of an agent runtime probeable by doctor: how to instantiate it, whether it is required, how to fix it. */
export interface AgentRuntimeSpec {
  id: string
  required: boolean
  fix: string
  make(spawn?: SpawnFn, probe?: Omit<ProcessProbeOptions, 'spawn'>): AgentRuntime
}

// Agent runtimes probed by doctor. The probe uses each runtime's `healthCheck` (`<bin> --version`):
// NON-destructive and without authentication → it neither touches nor prints credentials (the `fix` is a static string).
export const AGENT_RUNTIMES: AgentRuntimeSpec[] = [
  {
    id: 'claude',
    required: LOCAL_WORK_ENGINE === 'claude',
    fix: "installa/aggiorna la CLI claude con 'automator setup'",
    make: (spawn, probe) => new ClaudeRuntime({spawn, probe}),
  },
  {
    id: 'codex',
    required: LOCAL_WORK_ENGINE === 'codex',
    fix: "installa la CLI codex con 'automator setup --optional'",
    make: (spawn, probe) => new CodexRuntime({spawn, probe}),
  },
]

/**
 * Probes the availability of each agent runtime (Claude, Codex) for `automator doctor`, in a
 * NON-destructive way (`healthCheck` = `<bin> --version`, exit 0 ⇒ available). It never throws: a missing
 * or non-executable binary becomes `available: false` with the probe's `detail` and a practical `fix`
 * (static, without secrets). `spawn` injectable for tests; by default every runtime uses `node:child_process`.
 */
export async function probeRuntimes(
  spawn?: SpawnFn,
  specs: AgentRuntimeSpec[] = AGENT_RUNTIMES,
  options: Omit<ProcessProbeOptions, 'spawn'> = {},
): Promise<RuntimeStatus[]> {
  const outcomes = await Promise.allSettled(
    specs.map((spec) => Promise.resolve().then(() => spec.make(spawn, options).healthCheck())),
  )
  return outcomes.map((outcome, index) => {
    const spec = specs[index]
    const health: RuntimeHealth = outcome.status === 'fulfilled'
      ? outcome.value
      : {available: false, detail: 'probe fallito'}
    return {
      id: spec.id,
      required: spec.required,
      available: health.available,
      detail: health.detail,
      fix: health.available ? undefined : spec.fix,
    }
  })
}

/** Rejection RunResult for a claude bypass action without installed guardrails (C412), with a per-action log. */
function rejectGuardrails(name: string, action: Action, ctx: RunContext): RunResult {
  let built
  try {
    built = buildCommand(action, ctx.playbookDir, undefined, ctx.authorizedCwd)
  } catch {
    built = {cmd: action.type, args: [], cwd: ctx.playbookDir, display: action.run}
  }
  const log = openLog(ctx.logDir, name, ctx.now)
  log.header({type: action.type, command: built.display, cwd: built.cwd, start: ctx.now})
  log.footer({
    status: 'failure',
    error_code: ErrorCodes.Guardrails.missing,
    reason: `guardrail ${action.type} non installati o non validi`,
  })
  return {status: 'failure', exitCode: null, errorCode: ErrorCodes.Guardrails.missing, durationMs: 0, logPath: log.path, stdout: '', stdoutTruncated: false}
}
