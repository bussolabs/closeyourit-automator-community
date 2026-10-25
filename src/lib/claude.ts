import {sessionSettings} from './session-settings'
import {type ClaudeActionT} from './schema'
import {guardrailsSettingsPath} from './paths'
import {CLAUDE_MODEL} from './models'

// Claude provider-specific logic, extracted from executor.ts (CYAU-3): building the `claude` argv
// and interpreting the JSON output. The execution ENGINE (spawn/timeout/log/on_failure) stays
// generic in executor.ts; the ORCHESTRATION (guardrail gate + execution) lives in ClaudeRuntime (runtime.ts).

/** Binary of the headless Claude Code CLI. */
export const CLAUDE_BIN = 'claude'
const CLAUDE_FILE_TOOLS = ['Read', 'Glob', 'Grep', 'Edit', 'Write', 'MultiEdit', 'NotebookEdit'] as const
// In skill-mode (C.2) the plugin's versioned/trusted skills run their OWN scripts (cyi, git, node, gate.mjs):
// the session therefore has Bash BESIDES the file tools. Two-level confinement, both injected via --settings:
//  - OS-level SANDBOX (CYAU-67, `sandbox` key in the settings): bubblewrap on Linux confines the
//    Bash subprocesses — WRITES denied outside the worktree (cwd) and network denied except the allowlist, fail-closed if
//    the sandbox is not available. It is the real boundary of skill-mode (parity with Codex --sandbox workspace-write),
//    not a bypassable string parser.
//  - Guardrail HOOKS on the command/tool: block-production / block-destructive-db / guard-branch-push inspect the
//    Bash command STRING; require-worktree confines the WRITE targets of the FILE TOOLS (Edit/Write, realpath +
//    git top-level) to the worktree.
// The two levels are complementary: the sandbox closes the hole the hooks (textual denylist on the command) did not
// cover — a Bash write outside the worktree (rm/mv/sed -i, redirect, python -c…) is now confined by the OS.
const CLAUDE_SKILL_TOOLS = [...CLAUDE_FILE_TOOLS, 'Bash'] as const

/**
 * Separator the runner inserts into the `run` of a RETRY ATTEMPT: the findings to fix FIRST, then
 * the authoritative base instruction AFTER (`<finding>\n\n<separator heading>\n<run base>`). It is the
 * contract SHARED with the runner (`runner.ts` on retries): `composeRetryRun` writes it, `extractRetryFindings`
 * reads it back. Skill-mode needs it to recognise and propagate the findings (Finding 2), where the base prompt is
 * the skill invocation and not `run`.
 */
export const RETRY_FINDINGS_SEPARATOR = '\n\n# Istruzione originale autoritativa\n'

/** Composes a retry's `run`: the findings to fix, then the authoritative base instruction (contract above). */
export function composeRetryRun(findings: string, originalRun: string): string {
  return `${findings}${RETRY_FINDINGS_SEPARATOR}${originalRun}`
}

/**
 * The findings of a retry extracted from the `run` (the part BEFORE the separator), or undefined if `run` is not a retry
 * run (no separator) or if the findings would be empty (separator at the start). In prompt-mode the `run` is already
 * the whole prompt (findings + instruction) and nothing needs extracting; in skill-mode the base prompt is
 * the skill invocation, so these findings must be APPENDED so the skill knows what to fix.
 */
export function extractRetryFindings(run: string): string | undefined {
  const index = run.indexOf(RETRY_FINDINGS_SEPARATOR)
  return index > 0 ? run.slice(0, index) : undefined
}

/**
 * Argv for a claude action (without the binary). Two modes:
 *  - inline prompt: `-p <run> --tools <file-tool>` (Bash structurally denied);
 *  - skill-mode (`action.skill`, C.2): `-p "<slash-command> <ticket>" --plugin-dir <dir> --tools <file-tool+Bash>`,
 *    where a skill of the `closeyourit-skills` plugin does the step's work.
 * Both inject `--settings <guardrail> --setting-sources ''`: the PreToolUse hooks stay authoritative in every
 * permission mode and cannot be loosened by local config.
 */
export function buildClaudeArgv(action: ClaudeActionT, guardrailsSettings: string = guardrailsSettingsPath(), cwd: string = process.cwd()): string[] {
  if (action.skill) return buildClaudeSkillArgv(action, action.skill, guardrailsSettings, cwd)
  // The CLI never receives Bash in prompt-mode: the boundary is structural, so wrappers, interpreters, scripts and
  // expansions cannot bypass a textual denylist. The hooks stay a fail-closed second line.
  const args = ['-p', action.run, '--output-format', 'json', '--tools', CLAUDE_FILE_TOOLS.join(',')]
  if (action.permission_mode) args.push('--permission-mode', action.permission_mode)
  const allowedTools = action.allowed_tools?.filter((tool) => CLAUDE_FILE_TOOLS.includes(tool as typeof CLAUDE_FILE_TOOLS[number]))
  if (allowedTools && allowedTools.length > 0) args.push('--allowed-tools', ...allowedTools)
  args.push('--model', action.model ?? CLAUDE_MODEL)
  args.push('--settings', guardrailsSettings, '--setting-sources', '')
  return args
}

/**
 * Skill-mode argv: runs the slash-command of the plugin loaded from `plugin_dir`. The prompt is `<command> <args>`
 * (args = ONLY the ticket code, validated safe by the schema; the skill reads the untrusted content via
 * cyi). Bash is enabled (the skills run their own scripts) but the guardrail hooks stay injected and
 * authoritative. permission_mode/model are propagated; the FILE TOOLS come from `allowed_tools` (see `skillTools`).
 *
 * On RETRIES the runner puts the findings to fix in `action.run` (before the shared separator). In
 * skill-mode the base prompt is the skill invocation, not `run`: if `action.run` carries retry findings we
 * APPEND them to the prompt (`<command> <args>\n\n<finding>`), so the revision does not repeat the same invocation
 * idly but passes the skill what to fix (Finding 2). Without retry findings the prompt stays the bare invocation.
 */
function buildClaudeSkillArgv(
  action: ClaudeActionT,
  skill: NonNullable<ClaudeActionT['skill']>,
  guardrailsSettings: string,
  cwd: string,
): string[] {
  const invocation = skill.args ? `${skill.command} ${skill.args}` : skill.command
  const retryFindings = extractRetryFindings(action.run)
  const prompt = retryFindings ? `${invocation}\n\n${retryFindings}` : invocation
  const args = ['-p', prompt, '--output-format', 'json', '--plugin-dir', skill.plugin_dir, '--tools', skillTools(action.allowed_tools)]
  if (action.permission_mode) args.push('--permission-mode', action.permission_mode)
  args.push('--model', action.model ?? CLAUDE_MODEL)
  args.push('--settings', JSON.stringify(sessionSettings(guardrailsSettings, action, cwd)), '--setting-sources', '')
  return args
}

/**
 * The FILE TOOLS of the skill-mode session (CYAU-119). Bash is ALWAYS present — the skills run their own scripts
 * (cyi/git/node) and the real boundary is the OS-level sandbox + the guardrail hooks, not the tool list.
 *  - `allowed_tools` missing/empty → no whitelist: all file tools (the WRITE phases implement in the isolated
 *    worktree, where `require-worktree` allows Edit/Write).
 *  - `allowed_tools` present → ONLY those file tools (the READ phases triage/planner carry `Read,Glob,Grep` from the
 *    profile → no Edit/Write: they cannot modify files). An explicit allowed_tools without file tools NEVER
 *    falls back to the full list (fail-closed): at most Bash alone remains.
 *
 * CYAU-132 (declared == applied ON FILE TOOLS): this is the ONLY source of the file tools that really reach the
 * skill-mode session, and it is a function of only the `allowed_tools` the PhaseProfile DECLARES (digest twin → server
 * twin, see `phase-profile.ts`). So the applied file tools are exactly the declared ones (no more, no less):
 * the profile does not promise a file-tool restriction it then does not apply. Bash is separate — it is NOT a file tool and NOT
 * in the profile/digest: it is an EXECUTION tool always added by skill-mode (the skills run their own scripts) and
 * CAN write files via the shell; what confines its writes is the OS-level sandbox (CYAU-67) + the hooks, not this list.
 * Exported because the file-tool invariant is verifiable end to end against the real profiles (`claude.test.ts`).
 *
 * Read phases additionally deny filesystem writes to the authorized checkout in the OS sandbox.
 */
export function skillTools(allowedTools: ClaudeActionT['allowed_tools']): string {
  if (!allowedTools || allowedTools.length === 0) return CLAUDE_SKILL_TOOLS.join(',')
  const fileTools = allowedTools.filter((tool) => CLAUDE_FILE_TOOLS.includes(tool as typeof CLAUDE_FILE_TOOLS[number]))
  return [...fileTools, 'Bash'].join(',')
}

/**
 * exit==0 but JSON with `is_error === true` ⇒ failure: a claude session that ended in error is not a success.
 * Non-JSON output with exit 0 → do not downgrade (not every run emits the result JSON on stdout).
 */
export function claudeIsError(stdout: string): boolean {
  try {
    const parsed = JSON.parse(stdout.trim())
    return Boolean((parsed as {is_error?: unknown}).is_error)
  } catch {
    return false
  }
}

/**
 * The session's spend in dollars, from the result JSON `--output-format json` writes on stdout
 * (`total_cost_usd`). It is the only point where the automator knows the REAL cost of a run: the daily
 * usage sums estimates, and on a ticket resumed dozens of times the difference is the whole story (CYAU-155).
 * `null` when the output is not the result JSON or the field is not a usable number: never an invented cost.
 */
export function claudeSessionCostUsd(stdout: string): number | null {
  let parsed: unknown
  try {
    parsed = JSON.parse(stdout.trim())
  } catch {
    return null
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return null
  const cost = (parsed as {total_cost_usd?: unknown}).total_cost_usd
  return typeof cost === 'number' && Number.isFinite(cost) && cost >= 0 && cost <= Number.MAX_SAFE_INTEGER
    ? cost
    : null
}
