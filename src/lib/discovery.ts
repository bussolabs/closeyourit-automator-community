import {z} from 'zod'
import {isRuntimeId, RUNTIME_IDS, type RuntimeId} from './route'
import {AutomatorError, ErrorCodes} from '../errors/error-codes'

// Read-only agents for bug discovery (CYAU-29). The system must be able to SEARCH for real problems without
// letting the agents modify the code right away: a discovery role runs read-only (read-only permission
// mode), analyses allowed sources (errors, CI, uptime, performance, critical flows) and produces
// SIGNALS with evidence — never a change, never a PR (Scenario 1 / DoD). This module is PURE and DETERMINISTIC
// (no I/O, no randomness): same input → same outcome, so discovery is repeatable and auditable.
//
// The module does NOT run the agent (launching the read-only session belongs to the orchestrator/executor, as `route` does not
// launch the implementer): it defines the pure pieces of the technical analysis —
//  1. the discovery ROLE, with a read-only permission mode per runtime and STRUCTURAL read-only (does not modify files,
//     does not open PRs): it is the separation from the ticket worker (CYAU-18), made first-class by `AgentRole`;
//  2. the allowed SOURCES discovery can analyse (allowlist);
//  3. the signal SCHEMA — source, evidence, impact, confidence (DoD: "every signal contains source, impact and
//     confidence") — validated because the agent's output is untrusted input;
//  4. the BUDGET (how many signals per run, which confidence threshold) with which noise and excess are discarded,
//     keeping the most impactful and confident signals.

// ── Agent role: discovery separate from the ticket worker (DoD) ─────────────────────────────────────────────────

/**
 * Agent role. `discovery` is read-only (searches and reports, does not touch the repository); `worker` is the ticket
 * worker that implements (CYAU-18: writes code and opens PRs). The separation is first-class: the two dangerous
 * capabilities (modifying files, opening PRs) depend ONLY on the role, and for discovery they are denied.
 */
export const AGENT_ROLES = ['discovery', 'worker'] as const
export const AgentRoleSchema = z.enum(AGENT_ROLES)
export type AgentRole = z.infer<typeof AgentRoleSchema>

/** true if `value` is a known role (input defence: untrusted CLI input). */
export function isAgentRole(value: unknown): value is AgentRole {
  return typeof value === 'string' && (AGENT_ROLES as readonly string[]).includes(value)
}

/** Only the ticket worker can modify files: discovery is read-only (DoD "they cannot modify files"). */
export function roleCanModifyFiles(role: AgentRole): boolean {
  return role === 'worker'
}

/** Only the ticket worker can open PRs: discovery delivers nothing (DoD "they cannot open PRs"). */
export function roleCanOpenPr(role: AgentRole): boolean {
  return role === 'worker'
}

// ── Read-only permission mode per runtime (Technical analysis) ───────────────────────────────────────────────

/**
 * The READ-ONLY permission mode of each runtime — the only one allowed for a discovery agent. For `claude` it is
 * `plan` (planning mode: reads and reasons without Edit/Write, cf. CLAUDE.md "Read-only → plan"); for `codex` it is the
 * `read-only` sandbox (vs `workspace-write`). They are the same literals as `PermissionMode`/`SandboxMode`
 * (schema.ts): discovery reuses the runtimes' native confinements, it does not invent new ones.
 */
export const READ_ONLY_MODE: Readonly<Record<RuntimeId, string>> = {claude: 'plan', codex: 'read-only'}

/** The runtime's read-only permission mode (the source of truth to build a discovery action). */
export function readOnlyModeFor(runtime: RuntimeId): string {
  return READ_ONLY_MODE[runtime]
}

/**
 * true if `mode` is EXACTLY the read-only permission mode of `runtime`. Defensive guard: rejects every write/interaction
 * mode (`acceptEdits`/`auto`/`bypassPermissions`/`manual`/`dontAsk`/`workspace-write`) and the
 * read-only mode of the OTHER runtime → never a discovery configured so that it can write.
 */
export function isReadOnlyMode(runtime: RuntimeId, mode: string): boolean {
  return READ_ONLY_MODE[runtime] === mode
}

// ── Allowed sources (Scenario 1) ─────────────────────────────────────────────────────────────────────────

/**
 * The sources a discovery agent can analyse (allowlist, Scenario 1): errors, CI, uptime, performance and
 * critical flows. They are also the sources allowed for a signal (`DiscoverySignal.source`): a signal is always born
 * from one of these.
 */
export const DISCOVERY_SOURCES = ['errors', 'ci', 'uptime', 'performance', 'critical-flows'] as const
export const DiscoverySourceSchema = z.enum(DISCOVERY_SOURCES)
export type DiscoverySource = z.infer<typeof DiscoverySourceSchema>

/** true if `value` is an allowed source (input defence: untrusted CLI/agent input). */
export function isDiscoverySource(value: unknown): value is DiscoverySource {
  return typeof value === 'string' && (DISCOVERY_SOURCES as readonly string[]).includes(value)
}

// ── Impact level ───────────────────────────────────────────────────────────────────────────────────────

/** A signal's impact, from lowest to highest (the order matters: it drives the priority in the budget). */
export const IMPACT_LEVELS = ['low', 'medium', 'high', 'critical'] as const
export const ImpactLevelSchema = z.enum(IMPACT_LEVELS)
export type ImpactLevel = z.infer<typeof ImpactLevelSchema>

/** true if `value` is a known impact level. */
export function isImpactLevel(value: unknown): value is ImpactLevel {
  return typeof value === 'string' && (IMPACT_LEVELS as readonly string[]).includes(value)
}

/** Numeric impact rank for sorting (critical highest). */
function impactRank(impact: ImpactLevel): number {
  return IMPACT_LEVELS.indexOf(impact)
}

// ── Budget (Technical analysis) ──────────────────────────────────────────────────────────────────────────────

/**
 * Budget of a discovery run: how many signals to produce at most (`maxSignals`, avoids the flood) and below
 * which confidence to discard them as noise (`minConfidence`). It is configurable DATA (like the `route` policy).
 */
export const DiscoveryBudgetSchema = z
  .object({
    maxSignals: z.number().int().positive(),
    minConfidence: z.number().min(0).max(1),
  })
  .strict()
export type DiscoveryBudget = z.infer<typeof DiscoveryBudgetSchema>

/** Default budget: at most 10 signals per run, minimum confidence 0.5 (below is noise). */
export const DEFAULT_DISCOVERY_BUDGET: DiscoveryBudget = {maxSignals: 10, minConfidence: 0.5}

/** Validates a budget (untrusted CLI input): maxSignals positive integer, minConfidence in [0,1]. Exit 2 otherwise. */
export function assertBudget(budget: DiscoveryBudget): void {
  if (!Number.isInteger(budget.maxSignals) || budget.maxSignals < 1) {
    throw invalidInput(`Budget non valido: maxSignals dev'essere un intero positivo (ricevuto ${budget.maxSignals})`)
  }

  if (!(budget.minConfidence >= 0 && budget.minConfidence <= 1)) {
    throw invalidInput(`Budget non valido: minConfidence dev'essere in [0,1] (ricevuto ${budget.minConfidence})`)
  }
}

// ── Built discovery role (structural read-only) ────────────────────────────────────────────────────────

/** Fields common to the two branches of the discovery role (the structural read-only: literal true/false). */
const discoveryRoleShape = {
  role: z.literal('discovery'),
  readOnly: z.literal(true),
  canModifyFiles: z.literal(false),
  canOpenPr: z.literal(false),
  allowedSources: z.array(DiscoverySourceSchema),
  budget: DiscoveryBudgetSchema,
  reasons: z.array(z.string()),
}

/**
 * The discovery role configured for a runtime. **Union discriminated on `runtime`**: the `permissionMode` is
 * CONSTRAINED to that runtime's read-only mode (claude→`plan`, codex→`read-only`, mirror of `READ_ONLY_MODE`) —
 * it is not a free `z.string()`. With the literals `readOnly:true`/`canModifyFiles:false`/`canOpenPr:false`, the
 * read-only is thus a STRUCTURAL property of the schema (like `readOnly:true` in ReviewVerdict or
 * `autoMerged:false` in deliver): **no value of the type** — neither built by hand nor deserialized — can carry
 * a writable permission mode (`acceptEdits`/`bypassPermissions`/`workspace-write`…). `.strict()`: no extra field.
 */
export const DiscoveryRoleSchema = z.discriminatedUnion('runtime', [
  z.object({...discoveryRoleShape, runtime: z.literal('claude'), permissionMode: z.literal('plan')}).strict(),
  z.object({...discoveryRoleShape, runtime: z.literal('codex'), permissionMode: z.literal('read-only')}).strict(),
])
export type DiscoveryRole = z.infer<typeof DiscoveryRoleSchema>

export interface BuildDiscoveryRoleOptions {
  /** Subset of allowed sources (default: all). Normalized to a set in canonical order. */
  sources?: DiscoverySource[]
  /** Run budget (default `DEFAULT_DISCOVERY_BUDGET`). */
  budget?: DiscoveryBudget
}

/**
 * Builds the discovery role for a runtime: FORCES the read-only permission mode (`plan`/`read-only`) and structurally
 * denies writes and PRs. Pure and deterministic. `runtime`, `sources` and `budget` are validated (untrusted CLI
 * input) → exit 2. The final `.parse()` guarantees the role is, by construction, read-only.
 */
export function buildDiscoveryRole(runtime: RuntimeId, opts: BuildDiscoveryRoleOptions = {}): DiscoveryRole {
  if (!isRuntimeId(runtime)) {
    throw invalidInput(`Runtime non riconosciuto: "${String(runtime)}" (attesi: ${RUNTIME_IDS.join(', ')})`)
  }

  const allowedSources = normalizeSources(opts.sources)
  const budget = opts.budget ?? DEFAULT_DISCOVERY_BUDGET
  assertBudget(budget)

  const permissionMode = readOnlyModeFor(runtime)
  const reasons = [
    `Ruolo discovery su ${runtime}: permission mode read-only "${permissionMode}" (nessuna scrittura, nessuna PR)`,
    'Separato dal ticket worker: cerca e segnala problemi, non modifica file né apre PR',
    `Sorgenti consentite: ${allowedSources.join(', ')}`,
    `Budget: al più ${budget.maxSignals} segnali per run, confidenza minima ${budget.minConfidence}`,
  ]

  return DiscoveryRoleSchema.parse({
    role: 'discovery',
    runtime,
    permissionMode,
    readOnly: true,
    canModifyFiles: false,
    canOpenPr: false,
    allowedSources,
    budget,
    reasons,
  })
}

/** The sources as a SET in canonical order (default: all). Validates every source (untrusted input). */
function normalizeSources(sources: DiscoverySource[] | undefined): DiscoverySource[] {
  if (sources === undefined) return [...DISCOVERY_SOURCES]
  const set = new Set<DiscoverySource>()
  for (const source of sources) {
    if (!isDiscoverySource(source)) {
      throw invalidInput(`Sorgente non riconosciuta: "${String(source)}" (attese: ${DISCOVERY_SOURCES.join(', ')})`)
    }

    set.add(source)
  }

  return DISCOVERY_SOURCES.filter((s) => set.has(s))
}

// ── Signal schema (source/evidence/impact/confidence) ───────────────────────────────────────────────────

/**
 * A NORMALIZED discovery signal: the DoD in schema form. It ALWAYS carries the source (allowed source),
 * the evidence (Scenario 1: "signals with evidence"), the impact and the confidence; a missing `detail` becomes `null`
 * (never `undefined`). `.strict()`: no extra field (the agent's output is not trusted).
 */
export const DiscoverySignalSchema = z
  .object({
    source: DiscoverySourceSchema,
    title: z.string().min(1),
    evidence: z.string().min(1),
    impact: ImpactLevelSchema,
    confidence: z.number().min(0).max(1),
    detail: z.string().nullable(),
  })
  .strict()
export type DiscoverySignal = z.infer<typeof DiscoverySignalSchema>

/** RAW shape of a signal as it arrives from the agent (untrusted input): optional `detail`. */
const DiscoverySignalInputSchema = z
  .object({
    source: DiscoverySourceSchema,
    title: z.string().min(1),
    evidence: z.string().min(1),
    impact: ImpactLevelSchema,
    confidence: z.number().min(0).max(1),
    detail: z.string().optional(),
  })
  .strict()

/**
 * Validates and normalizes a raw agent signal (untrusted input). A signal without source/evidence/impact/
 * confidence, with out-of-domain values or extra fields is rejected with a dedicated code (exit 2) — an incomplete
 * signal never enters the report (DoD: "every signal contains source, impact and confidence").
 */
export function parseSignal(raw: unknown): DiscoverySignal {
  const result = DiscoverySignalInputSchema.safeParse(raw)
  if (!result.success) {
    const detail = result.error.issues.map((i) => `${i.path.join('.') || '(radice)'}: ${i.message}`).join('; ')
    throw invalidInput(`Segnale di discovery non valido: ${detail}`)
  }

  const {source, title, evidence, impact, confidence, detail} = result.data
  return {source, title, evidence, impact, confidence, detail: detail ?? null}
}

// ── Evaluation with budget → auditable report ───────────────────────────────────────────────────────────────

/** A signal discarded by the budget, with the reason (auditable: it is known WHY it was not reported). */
export const DroppedSignalSchema = z.object({signal: DiscoverySignalSchema, reason: z.string()}).strict()
export type DroppedSignal = z.infer<typeof DroppedSignalSchema>

/** Report of a discovery run: the kept signals, the discarded ones (with the reason), the budget and the reasons. */
export const DiscoveryReportSchema = z
  .object({
    accepted: z.array(DiscoverySignalSchema),
    dropped: z.array(DroppedSignalSchema),
    budget: DiscoveryBudgetSchema,
    reasons: z.array(z.string()),
  })
  .strict()
export type DiscoveryReport = z.infer<typeof DiscoveryReportSchema>

/**
 * Applies the budget to a set of ALREADY validated signals (`parseSignal`). Pure and deterministic: (1) discards the
 * signals below `minConfidence` (noise); (2) sorts the remaining ones by descending impact, then descending
 * confidence (on ties the input order, stable); (3) keeps the first `maxSignals`, the rest is discarded for
 * budget. Returns an auditable report (schema guaranteed by the final `.parse()`).
 */
export function evaluateDiscovery(
  signals: DiscoverySignal[],
  budget: DiscoveryBudget = DEFAULT_DISCOVERY_BUDGET,
): DiscoveryReport {
  assertBudget(budget)

  const dropped: DroppedSignal[] = []
  const candidates: DiscoverySignal[] = []
  for (const signal of signals) {
    if (signal.confidence < budget.minConfidence) {
      dropped.push({
        signal,
        reason: `Confidenza ${signal.confidence} sotto la soglia ${budget.minConfidence}: scartato come rumore`,
      })
    } else {
      candidates.push(signal)
    }
  }

  // Deterministic sort: impact desc, confidence desc, input order on ties (safe even with an unstable sort).
  const ranked = candidates
    .map((signal, index) => ({signal, index}))
    .sort((a, b) => {
      const byImpact = impactRank(b.signal.impact) - impactRank(a.signal.impact)
      if (byImpact !== 0) return byImpact
      const byConfidence = b.signal.confidence - a.signal.confidence
      if (byConfidence !== 0) return byConfidence
      return a.index - b.index
    })
    .map((x) => x.signal)

  const accepted = ranked.slice(0, budget.maxSignals)
  for (const signal of ranked.slice(budget.maxSignals)) {
    dropped.push({signal, reason: `Oltre il budget di ${budget.maxSignals} segnali per run: scartato`})
  }

  const reasons = [
    `Segnali ricevuti: ${signals.length} · accettati: ${accepted.length} · scartati: ${dropped.length}`,
    `Budget: al più ${budget.maxSignals} segnali, confidenza minima ${budget.minConfidence}`,
    accepted.length > 0
      ? 'Ordinati per impatto e confidenza decrescenti (i più critici e confidenti per primi)'
      : 'Nessun segnale sopra soglia: la discovery non ha prodotto segnali riportabili',
  ]

  return DiscoveryReportSchema.parse({accepted, dropped, budget, reasons})
}

/** Builds the invalid input error (exit 2), input defence (untrusted CLI/agent input). */
function invalidInput(message: string): AutomatorError {
  return new AutomatorError(ErrorCodes.Discovery.invalidInput, message, 2)
}
