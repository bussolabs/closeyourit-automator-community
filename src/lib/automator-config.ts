import * as fs from 'node:fs'
import {z} from 'zod'
import {hasOperationalHostIdentity, type Secrets} from './config'
import {type FetchFn} from './heartbeat'
import {EXECUTION_PHASES, isExecutionPhase, type ExecutionPhase} from './phase-profile'
import {automatorConfigCachePath} from './paths'
import {writeAtomicJson} from './state'

// Flow config downloadable by the automator (CYAU-73, B.3 + C.6). The automator is a FLOW ORCHESTRATOR: for every
// ticket it runs the flow steps in order (phase-profile/flow-engine), with per-step concurrency. Until now the
// SHAPE of the flow — the SEQUENCE of phases and the per-phase CONCURRENCY — is FIXED in the code (the "first release":
// FLOW_STEPS/EXECUTION_PHASES + serial concurrency). This module makes that shape REMOTELY CONFIGURABLE:
// an "automator" section in CloseYourIt defines it and the automator downloads it from GET /api/v1/agent_host/
// automator_config with a fail-closed CACHE. The endpoint lives on the Rails side (closeyourit-rails); here lives the
// CLIENT COUNTERPART (fetch/cache/resolve + consumption helpers), twin of the limits channel (limits.ts).
//
// FAIL-CLOSED, but DIFFERENT from limits: a missing LIMITS policy must BLOCK (fail-open would be "no
// limit", dangerous). A missing flow config instead DEGRADES to the hardcoded DEFAULT (the FIXED flow of the first
// release, already known and safe): the system keeps working with the built-in flow — never stopped, but never
// with an UNAUTHORIZED configuration either (Scenario 2: "does not apply an unauthorized configuration"). The
// default needs no authorization (it ships with the code), so even a host token revocation or an expired cache
// fall back to it without bypassing anything.
//
// The core is PURE and defensive (untrusted server input → fail-closed parser); the I/O (fetch + disk cache) lives
// behind injectable probes (fetcher, cacheFile), so the resolve is testable without network or a real endpoint.

const DEFAULT_API = 'https://app.closeyour.it'

/** Host-scoped endpoint of the flow config (server-side, "automator" section). ⚠️ Server dependency (closeyourit-rails). */
export const DEFAULT_API_AUTOMATOR_CONFIG_PATH = '/api/v1/agent_host/automator_config'

// Hard timeout on the GET: a hung server must not block the loop (like the other calls of the automator channel).
// On expiry the fetch aborts → handled as "server unreachable" → cache/default fail-closed.
const REQUEST_TIMEOUT_MS = 15_000

// ── Flow config schema (untrusted input: from the server) ─────────────────────────────────────────────────

// A phase of the sequence: it must belong to the canonical vocabulary of the 5 execution phases (twin of the Rails
// `Agents::PhaseProfile::PHASES`). Reuses the `isExecutionPhase` guard (Object.hasOwn → never an inherited prototype
// key). An unknown phase in the sequence → failed parse → fail-closed to the default (never an invented shape).
const ExecutionPhaseSchema = z.custom<ExecutionPhase>((v) => isExecutionPhase(v), {
  message: 'fase di esecuzione sconosciuta',
})

// Schema: strips the EXTRAS (evolving server contract, a new field does not break the config) but the types of the KNOWN
// fields are validated. `sequence` is required and non-empty (a sequence without phases is not a valid configuration);
// `concurrency` is a phase→positive integer map, OPTIONAL (missing = default concurrency for every phase) with
// the KEYS constrained to the vocabulary of the 5 known phases (like the sequence): an unknown key — typically a
// typo — would silently invalidate only that entry and run serially without the operator knowing, so it
// invalidates the WHOLE config → fail-closed to default/cache, never a partial unauthorized configuration.
// `max_age_seconds` is the cache's maximum freshness (fail-closed if expired), as in the limits channel.
const AutomatorFlowConfigSchema = z
  .object({
    sequence: z.array(ExecutionPhaseSchema).min(1),
    concurrency: z
      .record(z.number().int().positive())
      .refine((m) => Object.keys(m).every(isExecutionPhase), {message: 'concorrenza con una fase sconosciuta'})
      .optional(),
    max_age_seconds: z.number().int().nonnegative().optional(),
  })
  .strip()

export type AutomatorFlowConfig = z.infer<typeof AutomatorFlowConfigSchema>

/** Validates a raw flow config (from the server or the cache). Non-object/malformed known field → null (never fail-open). */
export function parseAutomatorConfig(raw: unknown): AutomatorFlowConfig | null {
  const parsed = AutomatorFlowConfigSchema.safeParse(raw)
  return parsed.success ? parsed.data : null
}

// ── The FIXED flow of the first release (fail-closed default) ────────────────────────────────────────────────

/** Per-phase concurrency when not configured: 1 = serial, never unlimited (consistent with `resolveFlowConcurrency`). */
export const DEFAULT_PHASE_CONCURRENCY = 1

/**
 * The DEFAULT flow config = the FIXED flow of the first release: the sequence is the 5 execution phases in
 * order (EXECUTION_PHASES), the concurrency is the default one for every phase (no override → serial). It is the
 * resolve's fail-closed verdict when there is no valid remote configuration. Deep-frozen (like the PhaseProfiles):
 * it is not mutable, so the resolve can return it by reference without risk of corruption.
 */
export const DEFAULT_AUTOMATOR_CONFIG: AutomatorFlowConfig = Object.freeze({
  sequence: Object.freeze([...EXECUTION_PHASES]) as ExecutionPhase[],
})

// ── Local cache (fail-closed, always expires) ────────────────────────────────────────────────────────────────

/**
 * Fail-closed on freshness: a cache older than this (or than the config's `max_age_seconds`, if set)
 * is considered expired → fall back to the default. An hour is wide for a network blip but not for a prolonged
 * absence: an obsolete remote configuration does not stay valid forever during an outage.
 */
export const DEFAULT_CACHE_MAX_AGE_SECONDS = 3600

/** The last flow config known from the server + when it was retrieved (for the cache expiry). */
export interface CachedAutomatorConfig {
  config: AutomatorFlowConfig
  fetched_at: string // ISO 8601
}

/** Persists (atomically) the flow config in the cache with the retrieval timestamp. */
export function writeCachedAutomatorConfig(
  config: AutomatorFlowConfig,
  fetchedAt: Date,
  file: string = automatorConfigCachePath(),
): void {
  const cached: CachedAutomatorConfig = {config, fetched_at: fetchedAt.toISOString()}
  writeAtomicJson(file, cached)
}

/**
 * Reads the cached flow config, or `null` if missing/corrupt/non-conforming/EXPIRED. The expiry (fail-closed)
 * triggers if `now - fetched_at` exceeds `config.max_age_seconds` (if set) or the default. An unparsable
 * `fetched_at` or one IN THE FUTURE (negative age: clock skew or tampered file) → expired (conservative). Missing file/illegal
 * JSON/invalid config → null (never fail-open).
 */
export function readCachedAutomatorConfig(now: Date, file: string = automatorConfigCachePath()): AutomatorFlowConfig | null {
  let raw: string
  try {
    raw = fs.readFileSync(file, 'utf8')
  } catch {
    return null
  }

  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    return null
  }
  if (typeof parsed !== 'object' || parsed === null) return null

  const config = parseAutomatorConfig((parsed as {config?: unknown}).config)
  if (!config) return null

  const maxAge = config.max_age_seconds ?? DEFAULT_CACHE_MAX_AGE_SECONDS
  const fetchedMs = Date.parse((parsed as {fetched_at?: unknown}).fetched_at as string)
  const ageMs = now.getTime() - fetchedMs
  // negative age = `fetched_at` in the future: anomalous → expired, otherwise a cache with a timestamp in the future
  // would stay valid well beyond the freshness window (potentially forever).
  if (Number.isNaN(fetchedMs) || ageMs < 0 || ageMs > maxAge * 1000) return null
  return config
}

/**
 * Removes the cached flow config (best-effort). Used on `auth-denied` (host token revocation): a revoked
 * config must NOT stay reusable by a later `unavailable` call. Missing file → no-op (force);
 * a removal error is ignored (the cache is ephemeral, never propagate).
 */
export function removeCachedAutomatorConfig(file: string = automatorConfigCachePath()): void {
  try {
    fs.rmSync(file, {force: true})
  } catch {
    /* best-effort */
  }
}

// ── Retrieval from the server (injectable probe) ─────────────────────────────────────────────────────────────────

/** Discriminated outcome: a revocation (auth-denied) is not an outage and cannot re-enable a config from the cache. */
export type AutomatorConfigFetchOutcome =
  | {outcome: 'success'; data: unknown}
  | {outcome: 'unavailable'}
  | {outcome: 'auth-denied'}

/** Probe that retrieves the raw flow config from the server. Injectable in tests. */
export interface AutomatorConfigFetcher {
  fetch(): Promise<AutomatorConfigFetchOutcome>
}

/**
 * Real probe: host-scoped GET of the flow config. Uses the revocable HOST credential when registered (revoking it
 * server-side also disables the remote configuration), without fallback to the org token. Without sync/host identity
 * → `unavailable`; outage/5xx/network error → `unavailable`; 401/403 → `auth-denied` (cache forbidden, the built-in
 * default can neither be bypassed nor denied). The expected body is `{data: <config>}` (twin of the limits channel).
 */
export function defaultAutomatorConfigFetcher(secrets: Secrets, fetchFn: FetchFn = globalThis.fetch): AutomatorConfigFetcher {
  return {
    async fetch() {
      const cfg = secrets.sync
      if (!cfg || !hasOperationalHostIdentity(secrets)) return {outcome: 'unavailable'}
      const token = secrets.host.token
      try {
        const res = await fetchFn(`${cfg.apiUrl ?? DEFAULT_API}${DEFAULT_API_AUTOMATOR_CONFIG_PATH}`, {
          method: 'GET',
          headers: {Authorization: `Bearer ${token}`, 'Content-Type': 'application/json'},
          signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
        })
        if (res.status === 401 || res.status === 403) return {outcome: 'auth-denied'}
        if (!res.ok) return {outcome: 'unavailable'}
        const body = (await res.json().catch(() => null)) as {data?: unknown} | null
        return {outcome: 'success', data: body?.data ?? null}
      } catch {
        return {outcome: 'unavailable'}
      }
    },
  }
}

// ── Flow config resolution (server → cache → default) ────────────────────────────────────────────────

/** The origin of the resolved config: `default` is the fail-closed to the fixed flow (never an unauthorized config). */
export type AutomatorConfigSource = 'server' | 'cache' | 'default' | 'auth-denied'

/** The resolve result: the `config` is ALWAYS valid (never null) — at worst it is the hardcoded default. */
export interface ResolvedAutomatorConfig {
  config: AutomatorFlowConfig
  source: AutomatorConfigSource
}

/**
 * Resolves the applicable flow config: tries the server, then the local cache, then the hardcoded DEFAULT (fail-closed).
 * A valid server response updates the cache (so the host stays configured when the server becomes
 * unreachable again). An INVALID response falls back to the cache; an `auth-denied` instead INVALIDATES the cache on
 * disk and falls back to the default immediately — a revocation is not bypassed with a previously valid config, and
 * without removing it a later `unavailable` would reuse it. The cache write is best-effort: its
 * failure does not prevent using the server config just downloaded. Unlike the limits channel, the
 * fail-closed is not a block but the known FIXED flow: the system keeps working the tickets.
 */
export async function resolveAutomatorConfig(
  fetcher: AutomatorConfigFetcher,
  now: Date,
  cacheFile: string = automatorConfigCachePath(),
): Promise<ResolvedAutomatorConfig> {
  const fetched = await fetcher.fetch()
  if (fetched.outcome === 'auth-denied') {
    removeCachedAutomatorConfig(cacheFile)
    return {config: DEFAULT_AUTOMATOR_CONFIG, source: 'auth-denied'}
  }
  if (fetched.outcome === 'success') {
    const config = parseAutomatorConfig(fetched.data)
    if (config) {
      // The cache is best-effort: if the write fails (full disk/permissions) the server config just downloaded
      // and validated stays valid anyway — the resolve is not rejected for a persistence error.
      try {
        writeCachedAutomatorConfig(config, now, cacheFile)
      } catch {
        /* best-effort */
      }
      return {config, source: 'server'}
    }
  }

  const cached = readCachedAutomatorConfig(now, cacheFile)
  if (cached) return {config: cached, source: 'cache'}
  return {config: DEFAULT_AUTOMATOR_CONFIG, source: 'default'}
}

// ── Consumption helpers (the hook point of the flow wiring) ──────────────────────────────────────────

/** The config's phase sequence (defensive copy: the caller cannot mutate the frozen default). */
export function flowSequence(config: AutomatorFlowConfig): ExecutionPhase[] {
  return [...config.sequence]
}

/**
 * The concurrency configured for a phase, or `DEFAULT_PHASE_CONCURRENCY` (serial) if not specified. Fail-closed
 * and defensive: `Object.hasOwn` avoids inherited prototype keys and a non-integer/non-positive value (which the
 * schema already excludes, but defence in depth costs nothing) falls back to the default — never an unlimited pool.
 */
export function concurrencyForPhase(config: AutomatorFlowConfig, phase: ExecutionPhase): number {
  const map = config.concurrency
  if (map && Object.hasOwn(map, phase)) {
    const value = map[phase]
    if (Number.isInteger(value) && value > 0) return value
  }
  return DEFAULT_PHASE_CONCURRENCY
}
