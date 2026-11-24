import {isReviewerId, isRuntimeId, RUNTIME_IDS, type ReviewerId, type RuntimeId} from './route'
import {type SupporterEngine} from './supporter'

// CYAU-305 — the engines this machine uses, as the server declares them in the response to every accepted beat.
// Before asking for work the machine checks quota and answer only of the engines it uses: a machine that works,
// reviews and supports with Codex must not stop because Claude ran out. The server chooses the engines; the
// machine only reads them. Anything missing, stale or unknown means "not known", and then both are checked,
// exactly as before this list existed — the prudent default.

export interface HostEngines {
  work: RuntimeId
  reviewer: ReviewerId
  /** `null` = the server declared the supporter off. */
  supporter: SupporterEngine | null
}

/** Past this age a list no longer narrows anything: the server may have moved the machine in the meantime. */
export const HOST_ENGINES_TTL_MS = 5 * 60_000

/**
 * Reads `data.engines` (or a top-level `engines`) from a beat response. The list counts only when complete: work
 * and reviewer with known names, and a supporter that is a known name or explicitly `null` (off). A missing
 * supporter key is incomplete, not off. Anything else is `null` — never a partial list, never a guess (R-4).
 */
export function parseHostEngines(body: unknown): HostEngines | null {
  if (!body || typeof body !== 'object') return null
  const data = (body as {data?: unknown}).data
  const source = data && typeof data === 'object' && 'engines' in data ? data : body
  const engines = (source as {engines?: unknown}).engines
  if (!engines || typeof engines !== 'object' || Array.isArray(engines)) return null
  const {work, reviewer, supporter} = engines as Record<string, unknown>
  if (!isRuntimeId(work) || !isReviewerId(reviewer)) return null
  // The supporter engines are the reviewer ones: the two that work plus OpenCode.
  const support = supporter === null ? null : isReviewerId(supporter) ? supporter : undefined
  if (support === undefined) return null
  return {work, reviewer, supporter: support}
}

export type EngineRole = 'lavoro' | 'rilettura' | 'supporto'

/**
 * The quota-bound engines a list needs, each with the roles it covers. OpenCode consumes neither Claude nor Codex
 * quota, so it adds nothing. `null` (no valid list) needs both, with no role to name.
 */
export function enginesInUse(engines: HostEngines | null): Map<RuntimeId, EngineRole[]> {
  const inUse = new Map<RuntimeId, EngineRole[]>()
  if (!engines) {
    for (const runtime of RUNTIME_IDS) inUse.set(runtime, [])
    return inUse
  }
  const roles: Array<[EngineRole, ReviewerId | SupporterEngine | null]> = [['lavoro', engines.work], ['rilettura', engines.reviewer], ['supporto', engines.supporter]]
  for (const [role, engine] of roles) {
    if (!isRuntimeId(engine)) continue
    inUse.set(engine, [...(inUse.get(engine) ?? []), role])
  }
  return inUse
}

/** The last list the server sent, shared by the beat that writes it and the claim that reads it. */
export interface HostEnginesStore {
  /**
   * Replaces the list: `null` clears it, so a rejected, bad or broken beat never leaves an older list alive. A beat
   * lost to a network error does not call it (CYAU-348): the older list then lives only until the TTL from `at`.
   */
  replace(engines: HostEngines | null, at?: Date): void
  /** The list, or `null` when there is none or it is older than the TTL. */
  current(now?: Date): HostEngines | null
}

export function makeHostEnginesStore(ttlMs: number = HOST_ENGINES_TTL_MS): HostEnginesStore {
  let last: {engines: HostEngines; at: number} | null = null
  return {
    replace(engines, at = new Date()) {
      last = engines ? {engines, at: at.getTime()} : null
    },
    current(now = new Date()) {
      if (!last) return null
      const age = now.getTime() - last.at
      return age >= 0 && age < ttlMs ? last.engines : null
    },
  }
}

/** The process-wide list: the daemon's beat writes it, its claims read it. */
export const hostEngines = makeHostEnginesStore()
