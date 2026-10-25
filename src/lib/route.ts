// The two engines that can work a ticket (CYAU-71).
//
// The automatic, capabilities-based choice between the two used to live here too: which engine for the UI, which
// for the backend, with policy, scores and fallbacks. It is no longer needed. Since CYRA-184 the server makes the
// decision, and the twelve waves made it final: the phase, the engine and the constraint arrive
// signed with the assignment, and the machine executes them instead of recomputing them.
//
// The vocabulary remains: what the two engines are called, how a valid name is recognised, how to say
// that one is not available. The ticket cycle, the cross review and the discovery of the
// installed runtimes use it.

/** The concrete runtimes/providers that can implement a ticket (they match the claude/codex action `type`s). */
export type RuntimeId = 'claude' | 'codex'

/** The canonical set of runtimes. The order is also the historical preference order (Claude first). */
export const RUNTIME_IDS: readonly RuntimeId[] = ['claude', 'codex']

/** true if `value` is a known runtime. Input defence: overrides/flags come from the CLI, untrusted. */
export function isRuntimeId(value: unknown): value is RuntimeId {
  return typeof value === 'string' && (RUNTIME_IDS as readonly string[]).includes(value)
}

/** CYAU-228 — the engines that can review: the two that work, plus OpenCode, which only ever reviews. */
export type ReviewerId = RuntimeId | 'opencode'

export const REVIEWER_IDS: readonly ReviewerId[] = [...RUNTIME_IDS, 'opencode']

export function isReviewerId(value: unknown): value is ReviewerId {
  return typeof value === 'string' && (REVIEWER_IDS as readonly string[]).includes(value)
}

/**
 * Runtime availability on the machine: `false` says that engine is not usable here.
 * `true` or **missing** = available (conservative: without information no fallback is forced).
 */
export type RuntimeAvailability = Partial<Record<ReviewerId, boolean>>
