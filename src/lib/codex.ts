import {sessionSettings} from './session-settings'
import {spawnSync} from 'node:child_process'
import * as fs from 'node:fs'
import * as path from 'node:path'
import {type CodexActionT} from './schema'
import {CODEX_MODEL} from './models'
import {extractRetryFindings} from './claude'
import {FLOW_STEPS, SKILL_PLUGIN} from './flow-engine'
import {sandboxAllowedDomains} from './guardrails'
import {guardrailsSettingsPath} from './paths'

// Codex provider-specific logic (CYAU-4), twin of claude.ts: building the `codex exec` argv.
// The execution ENGINE (spawn/timeout/log/on_failure) stays generic in executor.ts;
// the ORCHESTRATION (start + healthCheck) lives in CodexRuntime (runtime.ts).
//
// Security model (CYAU-25): the PRIMARY control is the runtime-agnostic command policy of the process wrapper
// (executor.runAction), which applies to every runtime. Codex adds as an ADDITIONAL DEFENCE the native SANDBOX
// (`read-only`/`workspace-write`, `danger-full-access` not exposed by the schema), disabled network and the `.rules`
// policy installed by the Automator. The user config is ignored, so sandbox and approval policy cannot be
// loosened by the local configuration; the rules forbid sensitive operations inside the session.
//
// Outcome: `codex exec` exits with code ≠0 when the turn fails or is interrupted (official source
// codex-rs/exec/src/lib.rs). The exit code is therefore the source of truth for the status — no downgrade of an
// exit-0 as for claude (`is_error`): the generic engine receives no `isError` predicate.

/** Binary of the headless Codex CLI (npm package `@openai/codex`). */
export const CODEX_BIN = 'codex'
const DENY_SHELL_HOOK = 'hooks.PreToolUse=[{matcher="^(Bash|Shell|shell|shell_command|exec_command)$", hooks=[{type="command", command="/bin/sh -c \'exit 2\'", timeout=5}]}]'

/**
 * Argv for a codex action (without the binary):
 * `--ask-for-approval never exec --ignore-user-config --sandbox <mode> ... -- <prompt>`.
 * `codex exec` is the non-interactive (headless) mode.
 * - `--sandbox` is ALWAYS present (default `read-only` from the schema): the automator is authoritative on confinement
 *   instead of inheriting the level from the local config `~/.codex/config.toml` (which could be more permissive).
 *   The authorized working directory is inherited by the child process (cwd resolved in executor.ts); `workspace-write`
 *   confines Codex's writes to that directory.
 * - In every mode it forces `-c sandbox_workspace_write.network_access=false` (CYAU-25): the sandbox confines
 *   the FILESYSTEM, but the NETWORK is a separate axis — off by default BUT overridable in the local config.
 *   Without this override a Codex agent could `git push`/deploy over the network during its own turn,
 *   bypassing the command policy (which inspects the actions' commands, not the agent's INTERNAL commands). Same
 *   philosophy as an always explicit `--sandbox`: authoritative regardless of the local config.
 * - `--ignore-user-config` prevents `config.toml` from overriding these choices; `--ask-for-approval never`
 *   avoids hanging prompts. The installed `.rules` policy stays loaded (it is disabled only with `--ignore-rules`,
 *   a flag the Automator does not expose).
 * - The prompt is a POSITIONAL argument, preceded by `--` (end of options): without it, a `run` starting with
 *   `-` would be interpreted as a flag (e.g. `-c`/`--config` → config override), not as a prompt.
 *
 * A phase skill (`action.skill`, CYRA-921) takes `buildCodexSkillArgv` instead: same hooks, network allowlist and
 * workspace-only writes as Claude's skill-mode. This argv stays for the reviewer and the playbook actions.
 */
export function buildCodexArgv(
  action: CodexActionT,
  guardrailsSettings: string = guardrailsSettingsPath(),
  cwd?: string,
): string[] {
  if (action.skill) return buildCodexSkillArgv(action, action.skill, guardrailsSettings, cwd)
  const args = [
    '--ask-for-approval',
    'never',
    '--dangerously-bypass-hook-trust',
    'exec',
    '--ignore-user-config',
    '--sandbox',
    action.sandbox,
    '-c',
    'sandbox_workspace_write.network_access=false',
    '-c',
    'features.hooks=true',
    '-c',
    DENY_SHELL_HOOK,
    '-c',
    'shell_environment_policy.inherit="none"',
  ]
  args.push('--model', action.model ?? CODEX_MODEL)
  args.push('--', action.run)
  return args
}

// Claude hook matchers → the Codex tool they guard. Codex sends shell commands as `Bash` with `{command}`, like
// Claude, and file edits as `apply_patch` with the patch text (require-worktree.mjs reads both).
const CODEX_HOOK_MATCHERS: Readonly<Record<string, string>> = {
  'Bash': '^Bash$',
  'Edit|Write|MultiEdit|NotebookEdit': '^apply_patch$',
}
const HOOK_TIMEOUT_SECONDS = 60
const PERMISSIONS_PROFILE = 'automator'

/**
 * CYRA-921 — argv of a phase skill run by Codex. Parity with Claude's skill-mode, verified on Ubuntu 24.04:
 *  - the guardrail hooks are the SAME commands Claude runs (read from the installed, hash-pinned Claude settings),
 *    so a command or an edit is judged by the same code whichever engine asks;
 *  - writes only in the session's workspace (the ticket worktree), the rest of the filesystem read-only;
 *  - network only through Codex's managed proxy, to the same domains Claude's sandbox allows;
 *  - `--ignore-rules`: the `.rules` policy forbids git, which the skills need. Claude has no such layer either:
 *    push and deploy are judged by the hooks (guard-branch-push, block-production) and the command policy.
 * Without the installed hooks the argv is not built (fail-closed): an unguarded skill session never starts.
 */
function buildCodexSkillArgv(
  action: CodexActionT,
  skill: NonNullable<CodexActionT['skill']>,
  guardrailsSettings: string,
  cwd: string | undefined,
): string[] {
  const step = skillStep(skill.command)
  const gitRoots = action.sandbox === 'workspace-write' ? ticketGitWritableRoots(cwd) : []
  const filesystem = ['":root"="read"', `":workspace_roots"="${action.sandbox === 'workspace-write' ? 'write' : 'read'}"`, ...gitRoots.map((root) => `${JSON.stringify(root)}="write"`)]
    .join(', ')
  const invocation = `Use $${step} at ${skill.plugin_dir}/skills/${step}/SKILL.md${skill.args ? ` with this input: ${skill.args}` : ''}`
  const retryFindings = extractRetryFindings(action.run)
  const prompt = retryFindings ? `${invocation}\n\n${retryFindings}` : invocation
  const domains = sandboxAllowedDomains().map((domain) => `${JSON.stringify(domain)}="allow"`).join(', ')
  return [
    '--ask-for-approval', 'never',
    '--dangerously-bypass-hook-trust',
    'exec',
    '--ignore-user-config',
    '--ignore-rules',
    '-c', 'features.hooks=true',
    '-c', 'features.network_proxy=true',
    '-c', `hooks.PreToolUse=${codexHooks(guardrailsSettings, action, cwd ?? process.cwd())}`,
    '-c', `default_permissions="${PERMISSIONS_PROFILE}"`,
    '-c', `permissions.${PERMISSIONS_PROFILE}.filesystem={${filesystem}}`,
    '-c', `permissions.${PERMISSIONS_PROFILE}.network.enabled=true`,
    '-c', `permissions.${PERMISSIONS_PROFILE}.network.domains={${domains}}`,
    // The executor already builds the session env (cyi credential, no managed secrets): the skill scripts need it.
    '-c', 'shell_environment_policy.inherit="all"',
    '--model', action.model ?? CODEX_MODEL,
    '--', prompt,
  ]
}

/**
 * The Git data a commit and a push of the ticket worktree write to, outside the worktree itself: the worktree's own
 * git dir, the shared objects, and the `ticket/` branches with their reflogs and remote-tracking refs. Not `main`,
 * not the config, not the hooks. Measured on Ubuntu 24.04: without them `commit.sh` fails on a read-only index.
 * Created beforehand, so a first commit or push finds them. Not a linked worktree → no session.
 */
function ticketGitWritableRoots(cwd: string | undefined): string[] {
  if (!cwd) throw new Error('a Codex write phase needs the ticket worktree as cwd')
  const probe = spawnSync('git', ['-C', cwd, 'rev-parse', '--path-format=absolute', '--git-dir', '--git-common-dir'], {encoding: 'utf8'})
  const [gitDir, commonDir] = probe.status === 0 ? probe.stdout.trim().split('\n').map((dir) => fs.realpathSync(dir)) : []
  if (!gitDir || !commonDir || gitDir === commonDir) throw new Error(`not a linked Git worktree: ${cwd}`)
  const roots = [
    gitDir,
    path.join(commonDir, 'objects'),
    path.join(commonDir, 'refs', 'heads', 'ticket'),
    path.join(commonDir, 'logs', 'refs', 'heads', 'ticket'),
    path.join(commonDir, 'refs', 'remotes', 'origin', 'ticket'),
    path.join(commonDir, 'logs', 'refs', 'remotes', 'origin', 'ticket'),
  ]
  for (const root of roots) fs.mkdirSync(root, {recursive: true})
  return roots
}

function skillStep(command: string): string {
  const [plugin, step, ...rest] = command.replace(/^\//, '').split(':')
  if (plugin !== SKILL_PLUGIN || rest.length > 0 || !(FLOW_STEPS as readonly string[]).includes(step ?? '')) {
    throw new Error(`skill not runnable by Codex: ${command}`)
  }
  return step!
}

/** The Claude PreToolUse hooks as a Codex TOML inline array. Any surprise in the settings stops the session. */
function codexHooks(settingsPath: string, action: CodexActionT, cwd: string): string {
  const settings = sessionSettings(settingsPath, action, cwd) as {hooks?: {PreToolUse?: unknown}}
  const groups = settings.hooks?.PreToolUse
  if (!Array.isArray(groups) || groups.length === 0) throw new Error('guardrail hooks missing from the settings')
  const rendered = groups.map((group: {matcher?: unknown; hooks?: unknown}) => {
    const matcher = typeof group.matcher === 'string' ? CODEX_HOOK_MATCHERS[group.matcher] : undefined
    if (!matcher || !Array.isArray(group.hooks) || group.hooks.length === 0) {
      throw new Error(`guardrail hook not translatable for Codex: ${String(group.matcher)}`)
    }
    const hooks = group.hooks.map((hook: {type?: unknown; command?: unknown}) => {
      if (hook.type !== 'command' || typeof hook.command !== 'string') throw new Error('invalid guardrail hook')
      return `{type="command", command=${JSON.stringify(hook.command)}, timeout=${HOOK_TIMEOUT_SECONDS}}`
    })
    return `{matcher=${JSON.stringify(matcher)}, hooks=[${hooks.join(', ')}]}`
  })
  return `[${rendered.join(', ')}]`
}
