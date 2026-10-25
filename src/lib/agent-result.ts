import {z} from 'zod'
import {type RunResult} from './executor'

// UNIFORM outcome of an agent run (Claude/Codex/shell), comparable across runtimes so the workflow can
// resume and decide the next phase (CYAU-6). The schema is the source of truth: every runtime, however it
// ends (success/error/timeout/cancel) and whatever output it produces (valid or not), converges HERE via
// `normalizeAgentResult`, which ALWAYS returns an object validated with `AgentRunResultSchema`.

/** Normalized outcome of a run: maps the process status + cancellation into a closed domain. */
export const AgentOutcome = z.enum(['success', 'failure', 'timeout', 'cancelled'])
export type AgentOutcomeT = z.infer<typeof AgentOutcome>

/**
 * Structured report the agent MAY emit (JSON) to populate the rich fields of the result. snake_case:
 * it is the natural format an agent writes in its final output. All optional (`.partial()`): a
 * missing or partial report stays valid; a field of the wrong type or out of range invalidates the WHOLE report
 * (all-or-nothing degradation → `reportParsed=false`, fields at defaults) without ever failing the normalization.
 */
export const AgentReportSchema = z
  .object({
    summary: z.string(),
    changed_files: z.array(z.string()),
    tests: z
      .object({
        passed: z.number().int().nonnegative(),
        failed: z.number().int().nonnegative(),
        summary: z.string(),
      })
      .partial(),
    risks: z.array(z.string()),
    commit: z.string(),
    confidence: z.number().min(0).max(1),
  })
  .partial()
export type AgentReport = z.infer<typeof AgentReportSchema>

/** Test outcome reported by the agent, normalized: missing fields as `null` (never `undefined`). */
const AgentTestsSchema = z
  .object({
    passed: z.number().int().nonnegative().nullable(),
    failed: z.number().int().nonnegative().nullable(),
    summary: z.string().nullable(),
  })
  .strict()

/** Metadata of the process and of the output validation (the "how" of the run, not the "what"). */
export const AgentRunMetadataSchema = z
  .object({
    runtime: z.string(), // id of the runtime that ran: 'claude' | 'codex' | 'spawn'
    action: z.string(), // action name in the playbook
    exitCode: z.number().nullable(),
    errorCode: z.string().nullable(),
    durationMs: z.number(),
    logPath: z.string(),
    reportParsed: z.boolean(), // true if a structured report was recognised AND validated
  })
  .strict()

/** Uniform schema of an agent run result. `.strict()`: no extra field (stable contract). */
export const AgentRunResultSchema = z
  .object({
    outcome: AgentOutcome,
    summary: z.string().nullable(),
    changedFiles: z.array(z.string()),
    tests: AgentTestsSchema,
    risks: z.array(z.string()),
    commit: z.string().nullable(),
    confidence: z.number().min(0).max(1).nullable(),
    metadata: AgentRunMetadataSchema,
  })
  .strict()
export type AgentRunResult = z.infer<typeof AgentRunResultSchema>

function tryJson(text: string): unknown {
  try {
    return JSON.parse(text)
  } catch {
    return undefined
  }
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/**
 * If stdout is the JSON wrapper of `claude -p --output-format json`, the agent text is in the `result` field;
 * otherwise stdout is already the raw text (codex/shell). In both cases the report is looked for in that text.
 */
function unwrapClaude(stdout: string): string {
  const obj = tryJson(stdout)
  if (isPlainObject(obj) && typeof obj.result === 'string') return obj.result
  return stdout
}

/** Last ```json block in the text (the agent closes with the report): tolerant of surrounding prose. */
function lastFencedJson(text: string): string | undefined {
  const re = /```json\s*([\s\S]*?)```/g
  let match: RegExpExecArray | null
  let last: string | undefined
  while ((match = re.exec(text)) !== null) last = match[1]
  return last
}

/** Extracts the candidate report object from stdout: whole text as JSON, or the last ```json block. */
function extractReportObject(stdout: string): unknown {
  const text = unwrapClaude(stdout)
  const whole = tryJson(text)
  if (isPlainObject(whole)) return whole
  const fenced = lastFencedJson(text)
  if (fenced !== undefined) {
    const parsed = tryJson(fenced)
    if (isPlainObject(parsed)) return parsed
  }

  return undefined
}

/**
 * Extracts and VALIDATES the report emitted by the agent from stdout. `parsed=false` if there is no
 * recognisable report or it does not match `AgentReportSchema` (invalid output) → the rich fields stay at defaults.
 */
export function parseAgentReport(stdout: string): {report: AgentReport | null; parsed: boolean} {
  const raw = extractReportObject(stdout)
  if (raw === undefined) return {report: null, parsed: false}
  const result = AgentReportSchema.safeParse(raw)
  // Valid only if it matches the schema AND carries at least one recognised field: an empty object or one with only
  // unknown fields (stripped by zod) is not a report but JSON noise → `reportParsed=false`, fields at defaults.
  if (!result.success || Object.keys(result.data).length === 0) return {report: null, parsed: false}
  return {report: result.data, parsed: true}
}

export interface NormalizeInput {
  /** Id of the runtime that ran the action (`AgentRuntime.id`): 'claude' | 'codex' | 'spawn'. */
  runtime: string
  /** Action name in the playbook. */
  action: string
  /** Raw outcome of the execution engine (executor). */
  result: RunResult
  /** The execution was cancelled (cancel/abort): the outcome becomes `cancelled` regardless of the status. */
  cancelled?: boolean
}

/** Cancellation wins over everything; timeout and success are explicit; any other outcome is a failure. */
function outcomeOf(status: RunResult['status'], cancelled: boolean): AgentOutcomeT {
  if (cancelled) return 'cancelled'
  if (status === 'timeout') return 'timeout'
  return status === 'success' ? 'success' : 'failure'
}

function normalizeTests(tests: AgentReport['tests']): z.infer<typeof AgentTestsSchema> {
  return {passed: tests?.passed ?? null, failed: tests?.failed ?? null, summary: tests?.summary ?? null}
}

/**
 * Normalizes a runtime's raw outcome into a uniform, validated `AgentRunResult`. It is the point where the
 * runtimes become comparable: any provider, any outcome (success/error/timeout/cancel) and
 * any output (valid or not) produce the SAME schema. The final `.parse()` is the schema guarantee.
 */
export function normalizeAgentResult(input: NormalizeInput): AgentRunResult {
  const {runtime, action, result} = input
  const {report, parsed} = parseAgentReport(result.stdout)
  const candidate = {
    outcome: outcomeOf(result.status, input.cancelled ?? false),
    summary: report?.summary ?? null,
    changedFiles: report?.changed_files ?? [],
    tests: normalizeTests(report?.tests),
    risks: report?.risks ?? [],
    commit: report?.commit ?? null,
    confidence: report?.confidence ?? null,
    metadata: {
      runtime,
      action,
      exitCode: result.exitCode,
      errorCode: result.errorCode,
      durationMs: result.durationMs,
      logPath: result.logPath,
      reportParsed: parsed,
    },
  }

  return AgentRunResultSchema.parse(candidate)
}
