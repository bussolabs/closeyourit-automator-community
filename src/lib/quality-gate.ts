import {spawn as nodeSpawn} from 'node:child_process'
import * as fs from 'node:fs'
import {parse} from 'yaml'
import {z, type ZodError} from 'zod'
import {AutomatorError, ErrorCodes} from '../errors/error-codes'
import {redactSecrets} from './secret-redaction'

// Quality gates configurable per repository (CYAU-23). Every repository DECLARES the repeatable checks that
// Automator runs before the review and the PR — setup, unit, integration, lint, typecheck, security, full
// suite — in a VERSIONED config (versioned in the target repo, inspectable). The checks run with mise
// (the right tools on the PATH via shims) and a TIMEOUT (SIGTERM→SIGKILL, like the executor). The core is pure and
// deterministic:
//  1. the PLAN — `orderChecks`/`buildCheckCommand`/`planGate` compose the resolved argv (`mise exec -- sh -c
//     <run>`) for each check, in the canonical phase order. Pure (no I/O).
//  2. the GATE — `evaluateGate` decides from the checks' OUTCOME: the gate FAILS if a REQUIRED check does not
//     pass (DoD). Non-required checks are advisory (they do not block). Pure and auditable (zod schema).
// The real execution lives behind an injectable `RunCheck` probe (`runGate` orchestrates the fail-fast; the command
// uses `defaultCheckRunner`, which spawns with the timeout) — so the orchestration is testable without real processes.
//
// "Without secrets" (DoD): the record of every check (`CheckResult`) carries only the REDACTED command and the outcome
// (status/exitCode/duration). Environment and output are never recorded; the command, deriving from the config,
// is treated as untrusted input anyway and redacted before it enters the report.

/** The seven canonical quality gate phases (Technical analysis), in execution order (setup first, full last). */
export const GATE_STAGES = ['setup', 'unit', 'integration', 'lint', 'typecheck', 'security', 'full'] as const
export const GateStageSchema = z.enum(GATE_STAGES)
export type GateStage = z.infer<typeof GateStageSchema>

/** Default timeout (seconds) of a check, like the executor. Exceeded → SIGTERM→SIGKILL, outcome `timeout`. */
export const DEFAULT_GATE_TIMEOUT_S = 300
/** Maximum timeout allowed for a check (aligned with the playbook: no check runs more than an hour). */
export const MAX_GATE_TIMEOUT_S = 3600
/** Default wrapper: `mise exec --` puts the repo's tools (node/pnpm…) on the PATH. A repo can override it. */
export const DEFAULT_RUNNER: readonly string[] = ['mise', 'exec', '--']

const TimeoutSchema = z.number().int().positive().max(MAX_GATE_TIMEOUT_S)

/** Authoritative gate run by the PR's CI. The names are exact: no glob that could widen the green. */
export const RemoteQualityGateConfigSchema = z
  .object({
    provider: z.literal('github'),
    required_checks: z.array(z.string().trim().min(1)).min(1).refine(
      (checks) => new Set(checks).size === checks.length,
      'i check remoti richiesti devono essere univoci',
    ),
    /** Total CI wait window (seconds). */
    timeout: z.number().int().positive().max(3600).default(1800),
    /** Polling interval (seconds), bounded so as neither to hammer GitHub nor leave the worker silent. */
    poll_interval: z.number().int().positive().max(60).default(10),
  })
  .strict()
export type RemoteQualityGateConfig = z.infer<typeof RemoteQualityGateConfigSchema>

/** A declared check: the phase, the shell command, whether it is required (default yes: fail-closed), the timeout. */
export const GateCheckSchema = z
  .object({
    stage: GateStageSchema,
    run: z.string().min(1),
    /** Required by default: a "safe by default" gate blocks on a check not declared advisory. */
    required: z.boolean().default(true),
    /** Timeout of the single check (seconds); missing → the config's global timeout. */
    timeout: TimeoutSchema.optional(),
    description: z.string().optional(),
  })
  .strict()
export type GateCheck = z.infer<typeof GateCheckSchema>

const QualityGateBaseSchema = z.object({
    /** Runner prefix common to all checks (Technical analysis: "run with mise"); [] = no wrap. */
    runner: z.array(z.string()).default([...DEFAULT_RUNNER]),
    /** Global timeout (seconds), used by the checks without their own `timeout`. */
    timeout: TimeoutSchema.default(DEFAULT_GATE_TIMEOUT_S),
    checks: z.array(GateCheckSchema).min(1, 'almeno una verifica richiesta'),
  })

/**
 * v1: local checks only. v2: fast local gate + authoritative remote CI on the PR. The explicit clean break keeps
 * a `remote` key ignored by an old Automator from making a delivery that is not protected look protected.
 */
export const QualityGateConfigSchema = z.discriminatedUnion('version', [
  QualityGateBaseSchema.extend({version: z.literal(1)}).strict(),
  QualityGateBaseSchema.extend({version: z.literal(2), remote: RemoteQualityGateConfigSchema}).strict(),
])
export type QualityGateConfig = z.infer<typeof QualityGateConfigSchema>

/** true if `value` is one of the canonical phases (input defence for CLI overrides, e.g. --only). */
export function isGateStage(value: unknown): value is GateStage {
  return typeof value === 'string' && (GATE_STAGES as readonly string[]).includes(value)
}

// ── Loader (I/O, like playbook.ts) ────────────────────────────────────────────────────────────────────────

export interface GateIssue {
  path: string
  message: string
}

export type GateValidationResult =
  | {ok: true; config: QualityGateConfig}
  | {ok: false; code: string; issues: GateIssue[]}

function formatIssues(err: ZodError): GateIssue[] {
  return err.issues.map((issue) => ({
    path: issue.path.length > 0 ? issue.path.join('.') : '(root)',
    message: issue.message,
  }))
}

/** Reads and validates the quality gate config without throwing: returns the typed result. */
export function validateQualityGate(file: string): GateValidationResult {
  let raw: string
  try {
    raw = fs.readFileSync(file, 'utf8')
  } catch {
    return {ok: false, code: ErrorCodes.Gate.notFound, issues: [{path: '(file)', message: `Config del quality gate non trovata: ${file}`}]}
  }

  let doc: unknown
  try {
    doc = parse(raw)
  } catch (error) {
    return {ok: false, code: ErrorCodes.Gate.invalidConfig, issues: [{path: '(yaml)', message: (error as Error).message}]}
  }

  const result = QualityGateConfigSchema.safeParse(doc)
  if (!result.success) {
    return {ok: false, code: ErrorCodes.Gate.invalidConfig, issues: formatIssues(result.error)}
  }

  return {ok: true, config: result.data}
}

/** Loads a valid config or throws `AutomatorError` (exit 2 = invalid config/usage). */
export function loadQualityGate(file: string): QualityGateConfig {
  const result = validateQualityGate(file)
  if (result.ok) return result.config
  const summary = result.issues.map((issue) => `${issue.path}: ${issue.message}`).join('; ')
  throw new AutomatorError(result.code, summary, 2)
}

// ── Plan (pure) ──────────────────────────────────────────────────────────────────────────────────────────

const STAGE_ORDER: Record<GateStage, number> = Object.fromEntries(GATE_STAGES.map((s, i) => [s, i])) as Record<GateStage, number>

/**
 * Sorts the checks by canonical phase (setup first, full last), preserving the declaration order for
 * equal phases (stable sort). Deterministic: the execution order does not depend on how the file is written.
 */
export function orderChecks(checks: GateCheck[]): GateCheck[] {
  return [...checks].sort((a, b) => STAGE_ORDER[a.stage] - STAGE_ORDER[b.stage])
}

function quote(arg: string): string {
  return /[\s"']/.test(arg) ? JSON.stringify(arg) : arg
}

export interface BuiltCheck {
  cmd: string
  args: string[]
  display: string
}

/**
 * Builds a check's resolved argv: `<runner> sh -c <run>`. The `run` command is a shell string
 * (it allows pipes/`&&`), run by `sh -c` with the PATH prepared by the runner. Empty runner → direct `sh -c`. Pure.
 */
export function buildCheckCommand(check: Pick<GateCheck, 'run'>, runner: readonly string[] = DEFAULT_RUNNER): BuiltCheck {
  const shell = ['sh', '-c', check.run]
  const parts = runner.length > 0 ? [...runner, ...shell] : shell
  const [cmd, ...args] = parts
  return {cmd, args, display: parts.map(quote).join(' ')}
}

/** A planned check: the phase, whether it is required, the resolved timeout and the argv ready for the spawn. */
export interface PlannedCheck {
  stage: GateStage
  run: string
  required: boolean
  /** Resolved timeout (seconds): the check's own or, if missing, the config's global one. */
  timeout: number
  cmd: string
  args: string[]
  /** The command in readable form, still raw because the execution plan needs it; it must be redacted before output. */
  command: string
}

export interface PlanOptions {
  /** Restricts to the given phases only (after the canonical sort). Missing → all. */
  only?: GateStage[]
}

/** Plans the checks to run: sorts, filters (`only`), resolves the timeouts and composes the argv. Pure. */
export function planGate(config: QualityGateConfig, opts: PlanOptions = {}): PlannedCheck[] {
  const only = opts.only ? new Set(opts.only) : null
  return orderChecks(config.checks)
    .filter((check) => !only || only.has(check.stage))
    .map((check) => {
      const built = buildCheckCommand(check, config.runner)
      return {
        stage: check.stage,
        run: check.run,
        required: check.required,
        timeout: check.timeout ?? config.timeout,
        cmd: built.cmd,
        args: built.args,
        command: built.display,
      }
    })
}

// ── Gate (pure, auditable) ───────────────────────────────────────────────────────────────────────────────

/** The observed outcome of a single check (recorded without secrets). `skipped`: not run (fail-fast). */
export type CheckStatus = 'passed' | 'failed' | 'timeout' | 'skipped'

/** The record of a check: already redacted command and outcome, without environment or output. `.strict()`. */
export const CheckResultSchema = z
  .object({
    stage: GateStageSchema,
    command: z.string(),
    required: z.boolean(),
    status: z.enum(['passed', 'failed', 'timeout', 'skipped']),
    exitCode: z.number().int().nullable(),
    durationMs: z.number().nonnegative(),
  })
  .strict()
export type CheckResult = z.infer<typeof CheckResultSchema>

const FailedCheckSchema = z.object({stage: GateStageSchema, command: z.string(), status: z.enum(['failed', 'timeout', 'skipped'])}).strict()

/** The quality gate verdict (auditable zod schema). */
export const GateVerdictSchema = z
  .object({
    /** true if EVERY required check passed (DoD: fails if a required one does not pass). */
    passed: z.boolean(),
    total: z.number().int().nonnegative(),
    passedCount: z.number().int().nonnegative(),
    skipped: z.number().int().nonnegative(),
    /** The required checks that did not pass (they fail the gate). */
    failedRequired: z.array(FailedCheckSchema),
    /** The failed advisory checks (reported, they do not block). */
    failedAdvisory: z.array(FailedCheckSchema),
    reasons: z.array(z.string()),
  })
  .strict()
export type GateVerdict = z.infer<typeof GateVerdictSchema>

/**
 * Decides the verdict from the checks' outcomes. Pure and deterministic: the gate PASSES if and only if every
 * REQUIRED check is `passed`; a required `failed`/`timeout`/`skipped` fails it (DoD). The advisory ones
 * (required:false) are reported but do not block. The final `.parse()` guarantees the auditable schema.
 */
export function evaluateGate(results: CheckResult[]): GateVerdict {
  const failedRequired = results
    .filter((r) => r.required && r.status !== 'passed')
    .map((r) => ({stage: r.stage, command: r.command, status: r.status as 'failed' | 'timeout' | 'skipped'}))
  const failedAdvisory = results
    .filter((r) => !r.required && r.status !== 'passed' && r.status !== 'skipped')
    .map((r) => ({stage: r.stage, command: r.command, status: r.status as 'failed' | 'timeout'}))

  const passed = failedRequired.length === 0
  const passedCount = results.filter((r) => r.status === 'passed').length
  const skipped = results.filter((r) => r.status === 'skipped').length

  const reasons: string[] = []
  if (passed) {
    reasons.push(`Quality gate superato: ${passedCount}/${results.length} verifiche passate${failedAdvisory.length > 0 ? ` (${failedAdvisory.length} advisory fallite, non bloccanti)` : ''}`)
  } else {
    reasons.push(`Quality gate fallito: ${failedRequired.length} verifica/e obbligatoria/e non passata/e`)
    for (const f of failedRequired) reasons.push(`[${f.stage}] ${f.status}: ${f.command}`)
  }

  return GateVerdictSchema.parse({passed, total: results.length, passedCount, skipped, failedRequired, failedAdvisory, reasons})
}

// ── Execution (injectable probe) ────────────────────────────────────────────────────────────────────────

/** The raw outcome of ONE executed check (never `skipped`: `runGate` decides that). Without output/env. */
export interface CheckOutcome {
  status: 'passed' | 'failed' | 'timeout'
  exitCode: number | null
  durationMs: number
}

/** The probe that runs a single planned check (injectable: mocked in tests, real spawn in prod). */
export type RunCheck = (planned: PlannedCheck) => Promise<CheckOutcome>

export interface GateReport {
  checks: CheckResult[]
  verdict: GateVerdict
}

export interface RunGateDeps {
  runCheck: RunCheck
  /** false (default): fail-fast at the first failed required check. true: runs all checks (full report). */
  keepGoing?: boolean
  only?: GateStage[]
}

/**
 * Orchestrates running the checks in SEQUENCE (setup before unit, etc.). Fail-fast by default: after the
 * first REQUIRED check that did not pass, the following ones are `skipped` (not run) — there is no point launching the
 * full suite if the setup is broken. With `keepGoing` it runs all of them for a full report. Composes the record (without
 * secrets) and the verdict. A failed advisory check does NOT trigger the fail-fast.
 */
export async function runGate(config: QualityGateConfig, deps: RunGateDeps): Promise<GateReport> {
  const planned = planGate(config, {only: deps.only})
  const checks: CheckResult[] = []
  let requiredFailed = false

  for (const p of planned) {
    const safeCommand = redactSecrets(p.command)
    if (requiredFailed && !deps.keepGoing) {
      checks.push({stage: p.stage, command: safeCommand, required: p.required, status: 'skipped', exitCode: null, durationMs: 0})
      continue
    }

    const outcome = await deps.runCheck(p)
    checks.push({stage: p.stage, command: safeCommand, required: p.required, status: outcome.status, exitCode: outcome.exitCode, durationMs: outcome.durationMs})
    if (p.required && outcome.status !== 'passed') requiredFailed = true
  }

  return {checks, verdict: evaluateGate(checks)}
}

const KILL_GRACE_MS = 5000

/** Spawn options of a check. `detached:true` puts the child in a NEW process group → the timeout can
 * end the whole tree (mise → sh → pnpm → …), not just the direct process. */
export interface GateSpawnOptions {
  cwd: string
  env: NodeJS.ProcessEnv
  stdio: ['ignore', 'pipe', 'pipe']
  detached: boolean
}

/** Minimal subset of ChildProcess: `pid` is needed to kill the process group (`-pid`) on timeout/abort. */
export interface GateChild {
  pid?: number
  stdout: {on(event: 'data', cb: (chunk: Buffer | string) => void): void} | null
  stderr: {on(event: 'data', cb: (chunk: Buffer | string) => void): void} | null
  on(event: 'close', cb: (code: number | null, signal: NodeJS.Signals | null) => void): void
  on(event: 'error', cb: (err: Error) => void): void
  kill(signal?: NodeJS.Signals): boolean
}

export type GateSpawnFn = (cmd: string, args: string[], opts: GateSpawnOptions) => GateChild

export interface CheckRunContext {
  cwd: string
  /** Env of the child processes (they inherit `process.env` + this). Passed to the children, NEVER recorded in the record. */
  env?: NodeJS.ProcessEnv
  spawn?: GateSpawnFn
  /** Signal sending (injectable in tests); default `process.kill`. Used with `-pid` for the process group. */
  kill?: (pid: number, signal: NodeJS.Signals) => void
  signal?: AbortSignal
  clock?: () => number
}

/**
 * The real probe: spawns the check in a NEW process group (`detached:true`) so the timeout can
 * end the WHOLE process tree (mise → sh → pnpm → node…), not just the direct process — a hung test
 * is really killed, no orphan processes in a long-running daemon. The timeout sends SIGTERM to the
 * group, then SIGKILL after the grace. It does NOT capture the output (the outcome must not be able to carry secrets): stdout/stderr
 * are drained and discarded. Cooperative cancellation (`signal`) ends the group like the timeout.
 */
export function defaultCheckRunner(ctx: CheckRunContext): RunCheck {
  const spawnFn = ctx.spawn ?? (nodeSpawn as unknown as GateSpawnFn)
  const clock = ctx.clock ?? Date.now
  const killFn = ctx.kill ?? ((pid: number, signal: NodeJS.Signals) => process.kill(pid, signal))
  const env: NodeJS.ProcessEnv = {...process.env, ...ctx.env}

  return (planned) =>
    new Promise<CheckOutcome>((resolve) => {
      const timeoutMs = planned.timeout * 1000
      let timedOut = false
      let settled = false
      let timer: ReturnType<typeof setTimeout>
      const startedAt = clock()
      const child: GateChild = spawnFn(planned.cmd, planned.args, {cwd: ctx.cwd, env, stdio: ['ignore', 'pipe', 'pipe'], detached: true})

      // Kills the child's WHOLE process group (`-pid`): with `detached` the child is its leader, so the
      // signal also reaches its descendants. Fallback to the child alone if the pid is missing (failed spawn) or the
      // group kill throws (group already ended: benign race).
      const killGroup = (signal: NodeJS.Signals): void => {
        const pid = child.pid
        if (typeof pid === 'number') {
          try {
            killFn(-pid, signal)
            return
          } catch {
            // group already dead or not killed: fall back to the child
          }
        }

        try {
          child.kill(signal)
        } catch {
          // already dead
        }
      }

      const kill = (): void => {
        killGroup('SIGTERM')
        setTimeout(() => killGroup('SIGKILL'), KILL_GRACE_MS)
      }
      const onAbort = (): void => kill()
      const finish = (code: number | null): void => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        ctx.signal?.removeEventListener('abort', onAbort)
        const durationMs = clock() - startedAt
        const status: CheckOutcome['status'] = timedOut ? 'timeout' : code === 0 ? 'passed' : 'failed'
        resolve({status, exitCode: code, durationMs})
      }

      // Drains and DISCARDS the output: the pipes must be consumed (otherwise they fill up and block the child), but nothing
      // of the output enters the record → any secret printed by the command is never recorded.
      child.stdout?.on('data', () => undefined)
      child.stderr?.on('data', () => undefined)
      child.on('error', () => finish(null)) // e.g. ENOENT (command not found)
      child.on('close', (code) => finish(code))

      timer = setTimeout(() => {
        timedOut = true
        kill()
      }, timeoutMs)

      if (ctx.signal) {
        if (ctx.signal.aborted) kill()
        else ctx.signal.addEventListener('abort', onAbort, {once: true})
      }
    })
}
