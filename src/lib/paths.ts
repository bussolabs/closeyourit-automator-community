import * as os from 'node:os'
import * as path from 'node:path'

// Centralized path resolution. The envs are read at call time (overridden in tests).
// Env convention: AUTOMATOR_* for state/playbook, XDG_STATE_HOME honoured on Linux.

function trimmed(value: string | undefined): string | undefined {
  return value && value.trim() !== '' ? value.trim() : undefined
}

/** State directory (XDG): state.json, logs/, lock, daemon.log. Never inside the repo. */
export function stateDir(): string {
  const override = trimmed(process.env.AUTOMATOR_STATE_DIR)
  if (override) return override
  const xdg = trimmed(process.env.XDG_STATE_HOME)
  const base = xdg ?? path.join(os.homedir(), '.local', 'state')
  return path.join(base, 'closeyourit-automator')
}

/** Config directory: non-sensitive local data; managed credentials live in the vault/credential store. */
export function configDir(): string {
  const override = trimmed(process.env.AUTOMATOR_CONFIG_DIR)
  if (override) return override
  const xdg = trimmed(process.env.XDG_CONFIG_HOME)
  const base = xdg ?? path.join(os.homedir(), '.config')
  return path.join(base, 'closeyourit-automator')
}

/**
 * Managed DATA directory (XDG data): checkouts and worktrees the automator owns and maintains, separate from the
 * operator's personal repositories (CYAU-11). They are persistent data (not ephemeral state, not config nor
 * secrets) → `~/.local/share`, override `AUTOMATOR_DATA_DIR`, honours `XDG_DATA_HOME`.
 */
export function dataDir(): string {
  const override = trimmed(process.env.AUTOMATOR_DATA_DIR)
  if (override) return override
  const xdg = trimmed(process.env.XDG_DATA_HOME)
  const base = xdg ?? path.join(os.homedir(), '.local', 'share')
  return path.join(base, 'closeyourit-automator')
}

/**
 * Root of the MANAGED installation of the automator code (CYAU-33): distinct from state/config/data. The code
 * of every version lives in `installRoot/releases/<version>/` and the ACTIVE version is the `installRoot/
 * current` symlink. `automator update` downloads a VERIFIED release (checksum), extracts it into a new `releases/` and
 * atomically swaps `current`; a failed update restores the symlink to the previous release WITHOUT
 * touching `stateDir`/`configDir`/`dataDir` → running runs are not lost (DoD). Override
 * `AUTOMATOR_INSTALL_ROOT`; default `~/.local/lib/closeyourit-automator` (executable code ≠ XDG state/data).
 */
export function installRoot(): string {
  const override = trimmed(process.env.AUTOMATOR_INSTALL_ROOT)
  if (override) return override
  return path.join(os.homedir(), '.local', 'lib', 'closeyourit-automator')
}

/** Checkouts managed by the automator, layout `repositories/<owner>/<repo>` (one per GitHub repo). */
export function repositoriesDir(): string {
  return path.join(dataDir(), 'repositories')
}

/** Isolated per-ticket worktrees, layout `worktrees/<project>/<ticket>` (one per worked ticket). */
export function worktreesDir(): string {
  return path.join(dataDir(), 'worktrees')
}

/**
 * Directory of the cloned skill bundles (C.1): the `closeyourit-skills` plugin at the PINNED version lives in
 * `skills/<version>` and the ACTIVE version is the `skills/current` symlink (same pattern as `installRoot`).
 * The automator runs the skills in skill-mode with `claude --plugin-dir <skillsPluginDir()>`. Managed data
 * (not state/config/secrets) → under `dataDir()`.
 */
export function skillsDir(): string {
  return path.join(dataDir(), 'skills')
}

/**
 * Path of the ACTIVE skill plugin passed to `claude --plugin-dir` (skill-mode). Default `skills/current`;
 * override `AUTOMATOR_SKILLS_DIR` (machine path, not a secret). C.1 clones the pinned bundle here.
 */
export function skillsPluginDir(): string {
  const override = trimmed(process.env.AUTOMATOR_SKILLS_DIR)
  if (override) return override
  return path.join(skillsDir(), 'current')
}

/**
 * true if skill-mode is on for ticket runs (env `AUTOMATOR_SKILLS_ENABLED=1|true`). Off by
 * default: additive, the pipeline stays in prompt-mode until it is explicitly turned on (the "switch").
 */
export function skillsModeEnabled(): boolean {
  const value = trimmed(process.env.AUTOMATOR_SKILLS_ENABLED)?.toLowerCase()
  return value === '1' || value === 'true'
}

export function statePath(): string {
  return path.join(stateDir(), 'state.json')
}

export function logsDir(): string {
  return path.join(stateDir(), 'logs')
}

/**
 * Directory of the runs' checkpoints (CYAU-12): one `runs/<run-id>.json` file per run, so the
 * `checkpoint` command does not share the file with the daemon loop (`state.json`) → no lost update.
 */
export function runsDir(): string {
  return path.join(stateDir(), 'runs')
}

/**
 * Directory of the active leases held by this host (CYAU-14): one `leases/<ticket>.json` file per locked
 * ticket. The `lease` command writes/removes them; the daemon renews them at the beat. File per ticket (like the
 * `runs/`) → whoever acquires and whoever renews write different files, no lost update.
 */
export function leasesDir(): string {
  return path.join(stateDir(), 'leases')
}

/**
 * Local cache of the limits policy (CYAU-32): the last policy known from the server, so the host keeps
 * enforcing the limits even when the server is temporarily unreachable. It is ephemeral (not "work"): if
 * missing/corrupt/expired the gate is fail-closed (blocks), not fail-open. The cache is keyed by `repository`
 * (`limits-cache/<sanitized-repo>.json`) so during an outage one repository's policy is NOT reused on the
 * wrong repository; without a repository it is the host-scoped cache (`limits-policy.json`). The repository is
 * sanitized to a safe file name (never a `..` segment: the result always carries the `.json` extension).
 */
export function policyCachePath(repository?: string): string {
  if (!repository || repository.trim() === '') return path.join(stateDir(), 'limits-policy.json')
  const safe = repository.replace(/[^A-Za-z0-9._-]/g, '_')
  return path.join(stateDir(), 'limits-cache', `${safe}.json`)
}

/**
 * Daily usage directory (CYAU-32): one `usage/<YYYY-MM-DD>.json` file per day (UTC) with the number of
 * started runs and the accumulated cost. File per day (like `leases/`/`runs/`) → no lost update across days.
 * It feeds the daily budget limits (daily runs/cost).
 */
export function usageDir(): string {
  return path.join(stateDir(), 'usage')
}

/**
 * Directory of the per-ticket counters (CYAU-155): one `ticket-attempts/<project>__<code>.json` file per worked
 * ticket, with the consecutive attempts on the current phase and the accumulated spend. File per ticket (like
 * `leases/`/`runs/`) → no lost update between concurrent runs. It is the only memory that crosses the ticks:
 * without it, a ticket that always fails the same way goes back to the queue forever.
 */
export function ticketAttemptsDir(): string {
  return path.join(stateDir(), 'ticket-attempts')
}

/**
 * Local cache of the downloaded flow config (CYAU-73): the last flow configuration (phase sequence +
 * per-phase concurrency) known from the server, so the host can keep working with the configured flow even
 * when the server is temporarily unreachable. It is keyed by `hostId` (`automator-config-cache/<sanitized-
 * host>.json`, as `policyCachePath` is by repository) so after a host IDENTITY CHANGE the old host's
 * configuration is NOT reused — it might not be authorized for the new one; without `hostId`
 * it is the generic host-scoped cache (`automator-config.json`). The host_id is sanitized to a safe file name (never
 * a `..` segment: the result always carries the `.json` extension). Ephemeral (not "work"): if missing/
 * corrupt/expired the resolve is fail-closed, DEGRADING to the hardcoded FIXED flow (the first release), never an
 * unauthorized configuration.
 */
export function automatorConfigCachePath(hostId?: string): string {
  if (!hostId || hostId.trim() === '') return path.join(stateDir(), 'automator-config.json')
  const safe = hostId.replace(/[^A-Za-z0-9._-]/g, '_')
  return path.join(stateDir(), 'automator-config-cache', `${safe}.json`)
}

/**
 * Resumable state of the OneClick provisioning (CYAU OneClick): a single `oneclick.json` file under the state dir
 * that remembers which ordered stages are already completed, so re-running `automator oneclick` resumes from the
 * uncompleted stage (state.ts pattern). It contains no secrets (only the list of stages). Ephemeral: a
 * missing/corrupt file restarts from the first stage (the stages are idempotent).
 */
export function oneclickStatePath(): string {
  return path.join(stateDir(), 'oneclick.json')
}

export function lockPath(): string {
  return path.join(stateDir(), 'tick.lock')
}

export function daemonLogPath(): string {
  return path.join(stateDir(), 'daemon.log')
}

/**
 * Absolute playbook path. Precedence: explicit argument → AUTOMATOR_PLAYBOOK → ./playbook.yml.
 * Resolved against the process cwd (the argument may already be absolute).
 */
export function playbookPath(explicit?: string): string {
  const chosen = trimmed(explicit) ?? trimmed(process.env.AUTOMATOR_PLAYBOOK) ?? 'playbook.yml'
  return path.resolve(chosen)
}

/** Directory of the installed guardrails (hooks + settings.json) — under configDir, outside the target repos. */
export function guardrailsDir(): string {
  return path.join(configDir(), 'guardrails')
}

/** Directory containing the installed .mjs hooks. */
export function guardrailsHooksDir(): string {
  return path.join(guardrailsDir(), 'hooks')
}

/** Guardrail settings.json passed to `claude --settings` for every agent session. */
export function guardrailsSettingsPath(): string {
  return path.join(guardrailsDir(), 'settings.json')
}

/** Effective Codex home: the installer only adds the Automator policy, without reading user config or auth. */
export function codexHomeDir(): string {
  return path.resolve(trimmed(process.env.CODEX_HOME) ?? path.join(os.homedir(), '.codex'))
}

/** Exec policy installed in the active Codex user layer; forbidden decisions cannot be loosened locally. */
export function codexGuardrailsRulesPath(): string {
  return path.join(codexHomeDir(), 'rules', 'closeyourit-automator.rules')
}
