import {createHash} from 'node:crypto'

// Twin of the Rails `Agents::PhaseProfile` (app/models/agents/phase_profile.rb): in the host-first model it is the PHASE
// (`execution_phase`) — not a typed agent — that determines runtime, skill, sandbox, permissions and ttl. The host-first
// wire carries ONLY `execution_phase` + `profile_digest`, never the profile: the automator runs the skill
// LOCALLY, so it keeps this copy and reconciles it with the server via `profile_digest`. The contract fixture
// `fixtures/valid/phase_profiles.json` pins the digests — a drift between this twin and the server PhaseProfile breaks the
// parity test (besides `R409-LEASE-005` at runtime). The constants are deep-frozen: the profile is not mutable.

export type ExecutionPhase = 'triage' | 'planner' | 'autopilot' | 'closer_staging' | 'closer_production'

export interface PhaseProfile {
  readonly skill: string
  readonly runtime: 'claude' | 'codex'
  readonly sandbox: 'workspace-write' | null
  // ALL phases run with headless Claude `bypassPermissions`: in headless there is no approver, and
  // every other mode denies the scripts the skills are made of. The READ phases ran in `plan` until
  // 2026-07-30 — `plan` does not prevent writes, it prevents EXECUTION: every triage Bash ended up in
  // `permission_denials` and the session gave up writing prose. No run ever completed.
  // The READ↔WRITE difference is the SANDBOX and the tool whitelist, not the mode (CYAU-119): the read phases carry
  // read-only `allowedTools` → in skill-mode `--tools` excludes Edit/Write (claude.ts) and, without `workspace-write`,
  // they have no managed worktree, so `require-worktree` denies every Edit/Write outside the managed worktree root.
  // This twin is ONLY the canonical data for the digest — it is NOT the spawning site: the safety of bypassPermissions
  // is NOT entrusted to this value but enforced downstream by executor.ts/claude.ts on EVERY session, with the
  // REQUIRED guardrails (block-production/block-destructive-db/require-worktree=Edit/Write only in the worktree/guard-branch-push)
  // + pre-spawn command-policy, fail-closed. `null` = no mode (legacy/codex phase, no longer produced host-first).
  readonly permissionMode: 'plan' | 'bypassPermissions' | null
  // Whitelist of the phase's FILE TOOLS: it enters the digest (`allowed_tools`, server twin) and it is ALSO the data from which
  // `claude.ts` derives the session's `--tools` argv (via `composeQueueSkillAction` → `skillTools`). CYAU-132,
  // declared == applied ON FILE TOOLS: the file tools the session applies are EXACTLY these — the read ones
  // `Read,Glob,Grep` (no Edit/Write), the write ones `[]` = no limit = all file tools. The profile therefore does not promise
  // a file-tool restriction it then does not apply.
  //   Bash is NOT in this whitelist (nor in the digest) and must NOT be: it is an EXECUTION tool, a different axis from the
  //   file tools. It is always added by skill-mode (the skills run their own scripts) and it CAN run commands that
  //   write files: what confines its writes is the OS-level sandbox (CYAU-67) + the hooks, NOT the tool list. For
  //   read phases without a managed worktree the known residual "Bash can write in host.cwd" therefore remains (related to
  //   CYAU-67, outside the scope of this ticket). Declaring Bash in the digest would require changing in a
  //   coordinated way the server twin `Agents::PhaseProfile` + the parity fixture: it is not a change the automator
  //   can make on its own without breaking `R409-LEASE-005`.
  readonly allowedTools: readonly string[]
  readonly ttl: number
}

// Twin of Agents::Agent::READ_ONLY_TOOLS (read-only whitelist of the claude phases).
const READ_ONLY_TOOLS: readonly string[] = Object.freeze(['Read', 'Glob', 'Grep'])
const NO_TOOLS: readonly string[] = Object.freeze([])
// Per-phase execution cap, in parity with RebuildAuthorizedAgents (hardcoded timeout_seconds 3600).
const DEFAULT_TTL_SECONDS = 3600

const PHASE_PROFILES: Readonly<Record<ExecutionPhase, PhaseProfile>> = Object.freeze({
  triage: Object.freeze({
    skill: '/closeyourit-triage', runtime: 'claude', sandbox: null,
    permissionMode: 'bypassPermissions', allowedTools: READ_ONLY_TOOLS, ttl: DEFAULT_TTL_SECONDS,
  }),
  planner: Object.freeze({
    skill: '/closeyourit-planner', runtime: 'claude', sandbox: null,
    permissionMode: 'bypassPermissions', allowedTools: READ_ONLY_TOOLS, ttl: DEFAULT_TTL_SECONDS,
  }),
  autopilot: Object.freeze({
    skill: '/closeyourit-autopilot', runtime: 'claude', sandbox: 'workspace-write',
    permissionMode: 'bypassPermissions', allowedTools: NO_TOOLS, ttl: DEFAULT_TTL_SECONDS,
  }),
  closer_staging: Object.freeze({
    skill: '/closeyourit-closer-staging', runtime: 'claude', sandbox: 'workspace-write',
    permissionMode: 'bypassPermissions', allowedTools: NO_TOOLS, ttl: DEFAULT_TTL_SECONDS,
  }),
  closer_production: Object.freeze({
    skill: '/closeyourit-closer-production', runtime: 'claude', sandbox: 'workspace-write',
    permissionMode: 'bypassPermissions', allowedTools: NO_TOOLS, ttl: DEFAULT_TTL_SECONDS,
  }),
})

// The 5 executable phases, in flow order (== Agents::PhaseProfile::PHASES).
export const EXECUTION_PHASES: readonly ExecutionPhase[] = Object.freeze(
  Object.keys(PHASE_PROFILES) as ExecutionPhase[],
)

// Own-key guard (never inherited prototype properties: `toString`/`constructor` → false).
export function isExecutionPhase(value: unknown): value is ExecutionPhase {
  return typeof value === 'string' && Object.hasOwn(PHASE_PROFILES, value)
}

// Fail-closed lookup: profile or null for an unknown phase (twin of PhaseProfile.for).
export function phaseProfile(phase: string): PhaseProfile | null {
  return isExecutionPhase(phase) ? PHASE_PROFILES[phase] : null
}

// Canonical fingerprint, twin of Agents::PhaseProfile#digest: SHA256 of the profile JSON with the snake_case keys
// in alphabetical order (allowed_tools, permission_mode, runtime, sandbox, skill_key, ttl) — the same
// serialization as `JSON.generate(to_h.sort_by { |k, _| k.to_s }.to_h)` on the Rails side. JS `JSON.stringify` of an
// object with the keys in this order produces the same string byte for byte → same digest.
export function phaseProfileDigest(phase: string): string | null {
  const profile = phaseProfile(phase)
  if (!profile) return null
  const canonical = {
    allowed_tools: [...profile.allowedTools],
    permission_mode: profile.permissionMode,
    runtime: profile.runtime,
    sandbox: profile.sandbox,
    skill_key: profile.skill,
    ttl: profile.ttl,
  }
  return createHash('sha256').update(JSON.stringify(canonical)).digest('hex')
}
