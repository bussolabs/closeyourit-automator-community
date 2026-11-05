import {AUTOMATOR_GIT_IDENTITY} from './git-identity'
import {spawn as nodeSpawn} from 'node:child_process'
import {spawnSync} from 'node:child_process'
import {createHash, randomUUID} from 'node:crypto'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import {StringDecoder} from 'node:string_decoder'
import {type Action} from './schema'
import {buildClaudeArgv, type ClaudeArgvOptions, CLAUDE_BIN} from './claude'
import {createClaudeStreamReader} from './claude-stream'
import {buildCodexArgv, type CodexArgvOptions, CODEX_BIN, readCodexEvent} from './codex'
import {type AgentConversation} from './agent-conversation'
import {gitAdminDirectory} from './busy-marker'
import {evaluateAction} from './command-policy'
import {openLog} from './logger'
import {ErrorCodes} from '../errors/error-codes'
import {codexHomeDir, guardrailsSettingsPath} from './paths'
import {activeManagedGuardrailPaths} from './managed-service'
import {redactSecrets, redactSecretsAtTruncation} from './secret-redaction'
import {CYI_AUTH_ENV, GITHUB_TOKEN_ENV, isManagedSecretEnv, type SecretCapabilities} from './env-capabilities'
import {sharedVmContainmentBackend, vmContainmentInstalled} from './vm-containment'
import {claudeAuthEnv} from './org-claude-credential'
import {
  createStrongContainmentBackend,
  type StrongContainmentBackend,
  type StrongContainmentHandle,
} from './process-containment'

// Generic execution engine of a single action. Builds the argv,
// spawns without a shell where possible (argv array = no injection), applies timeouts (SIGTERM→SIGKILL),
// captures stdout/stderr in the per-action log, derives the status. The Claude-provider-specific logic
// (guardrail gate, output interpretation) lives in ClaudeRuntime (runtime.ts) / claude.ts: here the claude
// branch of `buildCommand` only delegates the argv construction to `buildClaudeArgv` (the codex branch to
// `buildCodexArgv`), and the downgrade of an exit-0 to failure is driven by the generic predicate `ctx.isError`
// (claude: is_error; codex uses the native exit code, no predicate) — no coupling to a provider in the engine.

const DEFAULT_TIMEOUT_S = 300
const KILL_GRACE_MS = 5000
const PIPE_DRAIN_GRACE_MS = 1000
const CONTAINMENT_POLL_MS = 25
const CONTAINMENT_MAX_POLL_MS = 500
const CONTAINMENT_CLEANUP_MS = 1000
const CONTAINMENT_MAX_CLEANUP_MS = 30_000
const OUTPUT_MAX_BYTES = 1024 * 1024
const OUTPUT_TRUNCATED = '\n[automator: output troncato a 1 MiB; pipe drenati]\n'
const REMOVED_GIT_ENV = [
  'GIT_DIR', 'GIT_WORK_TREE', 'GIT_COMMON_DIR', 'GIT_OBJECT_DIRECTORY',
  'GIT_ALTERNATE_OBJECT_DIRECTORIES', 'GIT_INDEX_FILE', 'GIT_NAMESPACE',
  'GIT_SHALLOW_FILE', 'GIT_REPLACE_REF_BASE', 'GIT_CONFIG_PARAMETERS',
  // CYAU-193: the session's git identity is fixed (see AUTOMATOR_GIT_IDENTITY); the identity envs
  // would win over the config and make it replaceable by the playbook.
  'GIT_AUTHOR_NAME', 'GIT_AUTHOR_EMAIL', 'GIT_AUTHOR_DATE', 'GIT_COMMITTER_NAME', 'GIT_COMMITTER_EMAIL', 'GIT_COMMITTER_DATE',
  // CYAU-128: ONLY GIT_EXTERNAL_DIFF. `git diff` ALWAYS invokes it as the external diff command; emptying it
  // (='') does not disable it — git tries to launch a program named with the empty string ("external diff died") and
  // the diff dies inside every agent session. It must be REMOVED (not emptied): missing ⇒ git finds no
  // external diff IN THE ENV. It closes the ENV vector that emptying meant to close without reopening
  // another one in the env: the children's env is built here by the automator, so "missing" does not inherit an
  // outer GIT_EXTERNAL_DIFF. Only the fallback on the git CONFIG `diff.external` remains possible — a different
  // axis, NON-env: system/global are already disabled (GIT_CONFIG_SYSTEM/GLOBAL='' below) and a managed
  // checkout does not carry `diff.external` in .git/config (git clone does not import the remote's config). NB: one
  // cannot "turn off" diff.external by forcing `diff.external=` via GIT_CONFIG — an empty config breaks git
  // exactly like the empty env (verified). It must therefore be removed, not emptied.
  'GIT_EXTERNAL_DIFF',
] as const
const DANGEROUS_ENV = [
  'NODE_OPTIONS', 'NODE_PATH', 'BASH_ENV', 'ENV', 'ZDOTDIR', 'CDPATH',
  'LD_PRELOAD', 'LD_LIBRARY_PATH', 'LD_AUDIT', 'GCONV_PATH',
  'DYLD_INSERT_LIBRARIES', 'DYLD_LIBRARY_PATH', 'DYLD_FRAMEWORK_PATH',
  'DYLD_FALLBACK_LIBRARY_PATH', 'DYLD_FALLBACK_FRAMEWORK_PATH',
  'RUBYOPT', 'RUBYLIB', 'PYTHONPATH', 'PYTHONHOME', 'PERL5OPT', 'PERL5LIB',
  'BUNDLE_GEMFILE', 'GEM_HOME', 'GEM_PATH',
  'GIT_EXEC_PATH', 'GIT_SSH', 'GIT_SSH_COMMAND', 'GIT_CONFIG_GLOBAL', 'GIT_CONFIG_SYSTEM',
  // CYAU-128: git invokes these GIT_* as commands only OUTSIDE the diff (pager/editor/askpass/proxy) or they are
  // not commands (GIT_DIFF_OPTS, options only). Emptying them does NOT break `git diff` (verified: exit 0) and is the
  // SAFE disabling: '' wins over config and the fallback envs, so git does NOT fall back to
  // core.pager/PAGER, core.editor/EDITOR/VISUAL, sequence.editor, core.askpass/SSH_ASKPASS. Removing them (like
  // GIT_EXTERNAL_DIFF) would reopen those fallbacks: that is why they stay HERE as '', not in REMOVED_GIT_ENV.
  'GIT_DIFF_OPTS', 'GIT_PAGER', 'GIT_EDITOR', 'GIT_SEQUENCE_EDITOR', 'GIT_ASKPASS', 'GIT_PROXY_COMMAND',
  'CLAUDE_CODE_SAFE_MODE', 'CLAUDE_CODE_SIMPLE',
] as const

export interface BuiltCommand {
  cmd: string
  args: string[]
  cwd: string
  display: string
  /**
   * The NAME with which the launcher must be invoked, when it differs from the binary that runs it. Needed by
   * polymorphic shims — mise is full of them: `shims/claude` is a symlink to `mise`, and mise decides what
   * to launch from the name it was called with, like busybox. Resolving the symlink to pin it
   * (`resolveExecutable`) loses that name, and mise starts without knowing which tool to run.
   */
  argv0?: string
}

export interface RunResult {
  status: 'success' | 'failure' | 'timeout'
  exitCode: number | null
  errorCode: string | null
  durationMs: number
  logPath: string
  stdout: string
  /**
   * `stdout` was cut at `OUTPUT_MAX_BYTES` (CYAU-105). The flag already existed inside `spawnCollect` but
   * was discarded: without it, a result unreadable because truncated is indistinguishable from one never emitted, and
   * the two have opposite remedies. It goes in the log, not in a payload.
   */
  stdoutTruncated: boolean
}

/** Minimal subset of ChildProcess needed, so tests inject a fake without real processes. */
export interface ChildLike {
  pid?: number
  stdin?: {
    end(data?: string, callback?: (error?: Error | null) => void): void
    on?(event: 'error', cb: (err: Error) => void): void
  } | null
  stdout: {on(event: 'data', cb: (chunk: Buffer | string) => void): void} | null
  stderr: {on(event: 'data', cb: (chunk: Buffer | string) => void): void} | null
  on(event: 'close', cb: (code: number | null, signal: NodeJS.Signals | null) => void): void
  on(event: 'error', cb: (err: Error) => void): void
  kill(signal?: NodeJS.Signals): boolean
}

export type SpawnFn = (
  cmd: string,
  args: string[],
  opts: {cwd: string; env: NodeJS.ProcessEnv; stdio: ['ignore' | 'pipe', 'pipe', 'pipe']; detached?: boolean; argv0?: string},
) => ChildLike

export interface RunContext {
  playbookDir: string
  logDir: string
  now: Date
  spawn?: SpawnFn
  secrets?: SecretCapabilities
  clock?: () => number // to measure the duration in tests (default Date.now)
  guardrailsInstalled?: () => boolean // override for tests; used by the Claude and Codex providers
  signal?: AbortSignal // cooperative cancellation: an abort terminates the child (SIGTERM→SIGKILL)
  isError?: (stdout: string) => boolean // downgrades an exit-0 to failure (claude: is_error); default: none
  /** Absolute cwd derived from the local host map (sync), not from the remote payload. */
  authorizedCwd?: string
  /**
   * Log file name, when the action's one is not enough (CYAU-169): the same queue action can
   * run several times in the same round, one per ticket, and without telling them apart the runs would end up
   * mixed in a single file — unreadable exactly when one needs to understand what one of them did.
   */
  logName?: string
  /**
   * The test data space of THIS run (CYAU-167), passed to the children as `TEST_SLOT`.
   *
   * It is not a secret and does not go through the capabilities: it is a name, and it is needed where the suite really runs —
   * inside the agent session. The local gate is not enough: on a repository without a trusted policy
   * it does not apply at all, and those are exactly the projects with a test database.
   */
  testSlot?: string
  /** Testable override; in production it verifies realpath and the Git top-level. */
  authorizeCwd?: (cwd: string) => string
  /** Testable override; in production it resolves the launchers on the inherited PATH, before applying env.vars. */
  resolveExecutable?: (command: string, trustedPath: string | undefined) => string
  kill?: (pid: number, signal: NodeJS.Signals) => void
  platform?: NodeJS.Platform
  /** Kernel backend for `containment: strong` actions; default systemd/cgroup v2 on Linux. */
  strongContainment?: StrongContainmentBackend
  /** Optional notification when the strong cleanup exceeds the first deadline; the action stays blocked fail-closed. */
  onContainmentFailure?: () => void
  containmentCleanupMs?: number
  containmentMaxCleanupMs?: number
  /**
   * CYAU-282 — receives every stream-json event of a claude action while it runs. Passing it switches the
   * session to `stream-json`; stdout and the log still get only the result line. It informs and cannot fail
   * the session: a throwing handler is ignored.
   */
  onStreamEvent?: (event: Record<string, unknown>) => void
  /**
   * CYAU-285 — the conversation an agent session starts (with the name Claude is given) or resumes. Codex
   * honours it only in a phase skill session, where its `--json` events carry the name it chose.
   */
  conversation?: AgentConversation
  /**
   * CYAU-285 — receives the conversation name Codex announces in its first event, so it is recorded before the work
   * goes on. Like `onStreamEvent` it informs and cannot fail the session.
   */
  onConversationStarted?: (id: string) => void
}

function quote(arg: string): string {
  return /[\s"']/.test(arg) ? JSON.stringify(arg) : arg
}

/**
 * Fail-closed matrix. Headless `claude` uses the organization's credential when one is lent (CYAU-224), otherwise
 * the machine's LOCAL auth — subscription via `claude login` (inherited via HOME, without env) or API key/setup-token
 * in the service environment. Either way Claude auth variables reach EXCLUSIVELY
 * the `claude` action: for shell/codex they stay stripped (MANAGED_SECRET_ENV) and are never reintroduced, so
 * the Anthropic key does not leak to other actions. Passing them back to claude keeps probe and runtime consistent (a
 * `claude auth status` probe that sees the credential in the environment matches a claude action that receives it).
 */
export function actionSecretEnv(
  action: Action,
  capabilities: SecretCapabilities = {},
  inheritedEnv: NodeJS.ProcessEnv = process.env,
): NodeJS.ProcessEnv {
  // CYAU-224: the organization's credential when set, otherwise the machine's own (inherited) one.
  const env: NodeJS.ProcessEnv = action.type === 'claude' ? claudeAuthEnv(inheritedEnv) : {}
  // MACHINE identity for `cyi` (CYAU-108). Only for AGENT actions: they are the sessions that run the
  // skills, and the skills talk to CloseYourIt via `cyi`. A playbook shell action does not receive it — if
  // it needed it, it would need a dedicated capability.
  // Without this line the session falls back to the identity `cyi login` left on disk: that of a
  // person, with their permissions and their name in the tickets' audit.
  if ((action.type === 'claude' || action.type === 'codex') && capabilities.cyiAuth) {
    env[CYI_AUTH_ENV] = capabilities.cyiAuth
  }
  // CYAU-248: the ticket's one-hour GitHub token. gh refuses to start on an unreadable config dir and
  // `~/.config/gh` is denied to the sandbox (CYAU-242), so gh gets a dir of its own outside the home.
  if ((action.type === 'claude' || action.type === 'codex') && capabilities.githubToken) {
    env[GITHUB_TOKEN_ENV] = capabilities.githubToken
    env.GH_CONFIG_DIR = path.join(os.tmpdir(), 'closeyourit-automator-gh')
  }
  return env
}

function stripManagedSecretEnv(env: NodeJS.ProcessEnv): void {
  for (const key of Object.keys(env)) if (isManagedSecretEnv(key)) delete env[key]
}

/**
 * Builds the resolved argv for an action (claude|shell|codex).
 * The claude branch delegates the argv construction to `buildClaudeArgv` (claude.ts), which always injects the
 * authoritative settings. The gate that REJECTS the action when the provider guardrails are not installed lives in the runtimes.
 */
export function buildCommand(
  action: Action,
  playbookDir: string,
  guardrailsSettings: string = guardrailsSettingsPath(),
  authorizedCwd?: string,
  options: ClaudeArgvOptions & CodexArgvOptions = {},
): BuiltCommand {
  let cmd: string
  let args: string[]

  const cwd = resolveActionCwd(action, playbookDir, authorizedCwd)
  if (action.type === 'claude') {
    cmd = CLAUDE_BIN
    args = buildClaudeArgv(action, guardrailsSettings, cwd, options)
  } else if (action.type === 'codex') {
    cmd = CODEX_BIN
    args = buildCodexArgv(action, guardrailsSettings, cwd, options)
  } else {
    cmd = 'sh'
    args = ['-c', action.run]
  }

  return {cmd, args, cwd, display: redactSecrets([cmd, ...args.map(quote)].join(' '))}
}

/** Resolves the cwd with the same trust boundary for runtime and preflight. */
export function resolveActionCwd(action: Action, playbookDir: string, authorizedCwd?: string): string {
  const requested = action.cwd ?? '.'
  if (authorizedCwd !== undefined) {
    if (path.resolve(requested) !== path.resolve(authorizedCwd)) throw new Error('cwd diversa dalla directory autorizzata')
    return path.resolve(authorizedCwd)
  } else {
    const segments = requested.split(/[\\/]+/)
    if (path.isAbsolute(requested) || path.win32.isAbsolute(requested) || segments.includes('..')) {
      throw new Error('cwd assoluta o con traversal non consentita')
    }
    const cwd = path.resolve(playbookDir, requested)
    const relative = path.relative(path.resolve(playbookDir), cwd)
    if (relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) throw new Error('cwd fuori playbook')
    return cwd
  }
}

/** Resolves and authorizes the canonical cwd before any ticket I/O or runtime start. */
export function authorizeActionCwd(action: Action, playbookDir: string, authorizedCwd?: string): string {
  const cwd = resolveActionCwd(action, playbookDir, authorizedCwd)
  return authorizedCwd === undefined ? authorizeLocalGitCwd(cwd, playbookDir) : authorizeGitCwd(cwd)
}

function authorizeGitCwd(cwd: string): string {
  const real = fs.realpathSync(cwd)
  const git = spawnSync('git', ['-C', real, 'rev-parse', '--show-toplevel'], {encoding: 'utf8'})
  if (git.status !== 0 || git.stdout.trim() === '') throw new Error('cwd non e un repository/worktree Git')
  const topLevel = fs.realpathSync(git.stdout.trim())
  if (topLevel !== real) throw new Error('cwd deve coincidere con la root del repository/worktree autorizzato')
  return real
}

function authorizeLocalGitCwd(cwd: string, playbookDir: string): string {
  const realBase = fs.realpathSync(playbookDir)
  const realCwd = fs.realpathSync(cwd)
  const relative = path.relative(realBase, realCwd)
  if (relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
    throw new Error('cwd reale fuori playbook (symlink non consentito)')
  }
  return authorizeGitCwd(realCwd)
}

/**
 * CYAU-184 — two paths: `canonical` (the real binary, the one the pinning inspects and signs) and
 * `execPath` (the path found on the PATH, BEFORE the symlinks: the one to run). A polymorphic
 * shim like mise's dispatches on the name it is invoked with: running the canonical one made
 * mise start with the tool's arguments — even the compensating argv0 was lost as soon as the
 * command went through the supervisor (`sh -c`). What is run changes, not what is checked.
 */
interface ResolvedLauncher {execPath: string; canonical: string}

function resolveExecutable(command: string, trustedPath: string | undefined): ResolvedLauncher {
  if (path.isAbsolute(command)) {
    const canonical = fs.realpathSync(command)
    fs.accessSync(canonical, fs.constants.X_OK)
    if (!fs.statSync(canonical).isFile()) throw new Error(`launcher non valido: ${command}`)
    return {execPath: command, canonical}
  }
  for (const directory of (trustedPath ?? '').split(path.delimiter).filter(Boolean)) {
    if (!path.isAbsolute(directory)) continue
    const candidate = path.join(directory, command)
    try {
      const canonical = fs.realpathSync(candidate)
      fs.accessSync(canonical, fs.constants.X_OK)
      if (path.isAbsolute(canonical) && fs.statSync(canonical).isFile()) return {execPath: candidate, canonical}
    } catch {
      // Continue on the trusted PATH.
    }
  }
  throw new Error(`launcher non trovato: ${command}`)
}

interface LauncherBaseline {execPath: string; path: string; sha256: string}
const BASELINE_LAUNCHERS = ['sh', CLAUDE_BIN, CODEX_BIN] as const
const launcherBaselines = new Map<string, Map<string, LauncherBaseline>>()

function fileSha256(file: string): string {
  return createHash('sha256').update(fs.readFileSync(file)).digest('hex')
}

function baselinesFor(trustedPath: string | undefined): Map<string, LauncherBaseline> {
  const key = trustedPath ?? ''
  const cached = launcherBaselines.get(key)
  if (cached) return cached
  const captured = new Map<string, LauncherBaseline>()
  for (const launcher of BASELINE_LAUNCHERS) {
    try {
      const resolved = resolveExecutable(launcher, trustedPath)
      captured.set(launcher, {execPath: resolved.execPath, path: resolved.canonical, sha256: fileSha256(resolved.canonical)})
    } catch {
      // Optional provider not installed: it stays unavailable until the process restarts.
    }
  }
  launcherBaselines.set(key, captured)
  return captured
}

// Snapshot at runtime import: no window between daemon start and first action.
baselinesFor(process.env.PATH)

function resolvePinnedExecutable(command: string, trustedPath: string | undefined): string {
  const key = path.basename(command)
  const baseline = baselinesFor(trustedPath).get(key)
  if (!baseline) throw new Error(`launcher non disponibile nel baseline: ${command}`)
  const canonical = fs.realpathSync(baseline.path)
  fs.accessSync(canonical, fs.constants.X_OK)
  if (!fs.statSync(canonical).isFile() || canonical !== baseline.path || fileSha256(canonical) !== baseline.sha256) {
    throw new Error(`launcher modificato dopo il baseline: ${command}`)
  }
  // CYAU-184 — once the canonical one is verified, the path found on the PATH is run: a shim must
  // start with its own name, and the compensating argv0 does not survive the supervisor (`sh -c`).
  // That the execPath still points to the signed canonical one is guaranteed by the realpath below.
  //
  // DECLARED BOUNDARY (TOCTOU): between this check and the spawn there remains a window in which the shim
  // could be repointed. Whoever can rewrite a file in a trusted PATH directory already owns
  // the user running the automator: it is a same-privilege attack, outside the threat model
  // (which protects from REMOTE DATA, which still cannot choose either path or launcher).
  // Node offers no portable exec-by-fd that would close the window; the sha pinning on the canonical one and
  // this realpath reduce it to the practical minimum.
  if (fs.realpathSync(baseline.execPath) !== canonical) {
    throw new Error(`launcher modificato dopo il baseline: ${command}`)
  }
  return baseline.execPath
}

function resolveLaunchers(built: BuiltCommand, resolver: (command: string, trustedPath: string | undefined) => string, trustedPath: string | undefined): BuiltCommand {
  const original = built.cmd
  const cmd = resolver(original, trustedPath)
  // The original name survives the resolution: the pinning verifies the canonical binary, but since
  // CYAU-184 the path found on the PATH is run (the shim dispatches on the name). argv0 stays for the
  // unsupervised path; for a normal launcher it matches the basename and changes nothing.
  return {...built, cmd, argv0: path.basename(original),
          display: redactSecrets([cmd, ...built.args.map(quote)].join(' '))}
}

interface SpawnOutcome {
  code: number | null
  timedOut: boolean
  stdout: string
  stdoutTruncated: boolean
  containmentFailed: boolean
}

function boundUtf8(text: string, maxBytes: number): string {
  const bytes = Buffer.from(text)
  if (bytes.length <= maxBytes) return text
  const decoder = new StringDecoder('utf8')
  return decoder.write(bytes.subarray(0, maxBytes))
}

function boundTruncatedStdout(text: string, maxBytes: number): string {
  const marker = '[REDACTED]'
  if (!text.endsWith(marker) || Buffer.byteLength(text) <= maxBytes) return boundUtf8(text, maxBytes)
  const prefix = text.slice(0, -marker.length)
  return `${boundUtf8(prefix, maxBytes - Buffer.byteLength(marker))}${marker}`
}

function spawnCollect(
  spawnFn: SpawnFn,
  built: {cmd: string; args: string[]; cwd: string; argv0?: string},
  env: NodeJS.ProcessEnv,
  timeoutMs: number,
  onChunk: (chunk: string, source: 'stdout' | 'stderr', truncated?: boolean) => void,
  signal?: AbortSignal,
  options: {
    kill?: (pid: number, signal: NodeJS.Signals) => void
    platform?: NodeJS.Platform
    containment?: StrongContainmentHandle
    onContainmentFailure?: () => void
    containmentCleanupMs?: number
    containmentMaxCleanupMs?: number
    /** stdout is a Claude stream-json: events go here, only the result line goes on as stdout (CYAU-282). */
    streamEvents?: (event: Record<string, unknown>) => void
    /** The stream events are written to the log too (Codex `--json`, CYAU-285). */
    logStreamEvents?: boolean
  } = {},
): Promise<SpawnOutcome> {
  return new Promise((resolve) => {
    const stdoutChunks: Buffer[] = []
    let stdoutBytes = 0
    let stdoutTruncated = false
    let logBytes = 0
    let logTruncated = false
    let truncationWritten = false
    let timedOut = false
    let settled = false
    let terminating = false
    let killEscalated = false
    let childClosed = false
    let containmentFailed = false
    let containmentDeadline: number | undefined
    let containmentMaxDeadline: number | undefined
    let timer: ReturnType<typeof setTimeout>
    let forceTimer: ReturnType<typeof setTimeout> | undefined
    let drainTimer: ReturnType<typeof setTimeout> | undefined
    let containmentPoll: ReturnType<typeof setTimeout> | undefined
    let containmentPollMs = CONTAINMENT_POLL_MS
    const platform = options.platform ?? process.platform
    const killFn = options.kill ?? ((pid: number, sig: NodeJS.Signals) => process.kill(pid, sig))
    const stdoutLogDecoder = new StringDecoder('utf8')
    const stderrLogDecoder = new StringDecoder('utf8')
    let child: ChildLike
    try {
      child = spawnFn(built.cmd, built.args, {
        cwd: built.cwd,
        env,
        stdio: ['ignore', 'pipe', 'pipe'],
        detached: options.containment ? false : platform !== 'win32',
        ...(built.argv0 ? {argv0: built.argv0} : {}),
      })
    } catch {
      resolve({code: null, timedOut: false, stdout: '', stdoutTruncated: false, containmentFailed: false})
      return
    }

    const killGroup = async (sig: NodeJS.Signals): Promise<void> => {
      if (options.containment && (sig === 'SIGTERM' || sig === 'SIGKILL')) {
        try {
          if (await options.containment.signal(sig)) return
        } catch {
          // Unit not yet registered or ambiguous manager: terminate at least the wrapper; empty stays authoritative.
        }
        try { child.kill(sig) } catch { /* wrapper gia terminato */ }
        return
      }
      if (platform !== 'win32' && typeof child.pid === 'number') {
        try {
          killFn(-child.pid, sig)
          return
        } catch {
          // Benign race: fall back to the direct child.
        }
      }
      try { child.kill(sig) } catch { /* processo gia terminato */ }
    }
    let containmentFailureNotified = false
    const finishWhenContained = async (code: number | null): Promise<void> => {
      if (settled) return
      if (!options.containment) {
        finish(code)
        return
      }
      const cleanupMs = options.containmentCleanupMs ?? CONTAINMENT_CLEANUP_MS
      containmentDeadline ??= Date.now() + cleanupMs
      containmentMaxDeadline ??= Date.now() + Math.max(cleanupMs, options.containmentMaxCleanupMs ?? CONTAINMENT_MAX_CLEANUP_MS)
      try {
        if (await options.containment.empty()) {
          finish(code)
          return
        }
      } catch {
        // An ambiguous probe does not approve the cleanup: retry until the absolute deadline.
      }
      if (Date.now() >= containmentMaxDeadline) {
        containmentFailed = true
        if (!containmentFailureNotified) {
          containmentFailureNotified = true
          options.onContainmentFailure?.()
        }
        finish(null)
        return
      }
      if (Date.now() >= containmentDeadline) {
        containmentFailed = true
        if (!containmentFailureNotified) {
          containmentFailureNotified = true
          options.onContainmentFailure?.()
        }
        // Local fail-closed: do not kill the whole daemon and do not approve the run while the kernel identity
        // stays ambiguous. Retry KILL+verify in bounded windows until the container is proven empty.
        containmentDeadline = Date.now() + cleanupMs
        await killGroup('SIGKILL')
      }
      const untilDeadline = Math.max(1, Math.min(containmentDeadline - Date.now(), containmentMaxDeadline - Date.now()))
      const delay = Math.min(containmentPollMs, untilDeadline)
      containmentPollMs = Math.min(containmentPollMs * 2, CONTAINMENT_MAX_POLL_MS)
      containmentPoll = setTimeout(() => void finishWhenContained(code), delay)
    }
    const finishDuringTermGrace = async (): Promise<void> => {
      if (settled || !options.containment || !forceTimer || killEscalated) return
      try {
        if (await options.containment.empty()) {
          // The main process terminated leaving descendants: even if TERM cleaned them up,
          // the run is not approved as a success because its lifecycle was anomalous.
          finish(null)
          return
        }
      } catch {
        // Stay in the grace period: SIGKILL and the authoritative check follow at the deadline.
      }
      const delay = containmentPollMs
      containmentPollMs = Math.min(containmentPollMs * 2, CONTAINMENT_MAX_POLL_MS)
      containmentPoll = setTimeout(() => void finishDuringTermGrace(), delay)
    }
    const terminate = (): void => {
      if (terminating) return
      terminating = true
      void killGroup('SIGTERM')
      forceTimer = setTimeout(() => {
        forceTimer = undefined
        killEscalated = true
        void (async () => {
          await killGroup('SIGKILL')
          if (childClosed || options.containment) await finishWhenContained(null)
          else drainTimer = setTimeout(() => finish(null), PIPE_DRAIN_GRACE_MS)
        })()
      }, KILL_GRACE_MS)
    }
    const onAbort = (): void => {
      clearTimeout(timer)
      terminate()
    }
    const finish = (code: number | null): void => {
      if (settled) return
      streamReader?.end()
      settled = true
      clearTimeout(timer)
      if (forceTimer) clearTimeout(forceTimer)
      if (drainTimer) clearTimeout(drainTimer)
      if (containmentPoll) clearTimeout(containmentPoll)
      signal?.removeEventListener('abort', onAbort)
      const rawStdout = Buffer.concat(stdoutChunks, stdoutBytes)
      const stdoutDecoder = new StringDecoder('utf8')
      // If the boundary is artificial, `write` holds back and discards any incomplete trailing code point.
      const stdout = stdoutTruncated ? stdoutDecoder.write(rawStdout) : stdoutDecoder.end(rawStdout)
      if (!logTruncated) {
        const stdoutLogTail = stdoutLogDecoder.end()
        if (stdoutLogTail !== '') onChunk(stdoutLogTail, 'stdout')
        const stderrLogTail = stderrLogDecoder.end()
        if (stderrLogTail !== '') onChunk(stderrLogTail, 'stderr')
      }
      resolve({code, timedOut, stdout, stdoutTruncated, containmentFailed})
    }

    const streamEvents = options.streamEvents
    const streamReader = streamEvents
      ? createClaudeStreamReader({
        onOutput: (text) => capture(text, 'stdout'),
        onEvent: (event) => {
          // CYAU-285 — Codex events stay in the log: they are its narration, and its errors (a quota limit among
          // them) are read back from there. Never in stdout, which carries only the result.
          if (options.logStreamEvents) capture(`${JSON.stringify(event)}\n`, 'stderr')
          try {
            streamEvents(event)
          } catch {
            // The live narration informs; it never fails the session it accompanies.
          }
        },
      })
      : undefined
    const capture = (chunk: Buffer | string, source: 'stdout' | 'stderr'): void => {
      if (settled) return
      const bytes = Buffer.from(chunk)
      if (source === 'stdout' && stdoutBytes < OUTPUT_MAX_BYTES) {
        const kept = bytes.subarray(0, OUTPUT_MAX_BYTES - stdoutBytes)
        stdoutChunks.push(Buffer.from(kept))
        stdoutBytes += kept.length
        if (kept.length < bytes.length) stdoutTruncated = true
      } else if (source === 'stdout' && bytes.length > 0) {
        stdoutTruncated = true
      }
      if (logBytes < OUTPUT_MAX_BYTES) {
        const kept = bytes.subarray(0, OUTPUT_MAX_BYTES - logBytes)
        const text = source === 'stdout' ? stdoutLogDecoder.write(kept) : stderrLogDecoder.write(kept)
        if (text !== '') onChunk(text, source)
        logBytes += kept.length
        if (kept.length < bytes.length && !truncationWritten) {
          truncationWritten = true
          logTruncated = true
          onChunk(OUTPUT_TRUNCATED, source, true)
        }
      } else if (!truncationWritten) {
        truncationWritten = true
        logTruncated = true
        onChunk(OUTPUT_TRUNCATED, source, true)
      }
    }
    child.stdout?.on('data', (chunk) => {
      if (streamReader) streamReader.push(chunk)
      else capture(chunk, 'stdout')
    })
    child.stderr?.on('data', (chunk) => capture(chunk, 'stderr'))
    // After termination has started, close/error of the leader alone does not prove the process group is finished:
    // always wait for the SIGKILL escalation before resolving and, therefore, before any on_failure.
    child.on('error', () => { if (!terminating) finish(null) }) // e.g. ENOENT (command not found)
    child.on('close', (code) => { void (async () => {
      childClosed = true
      if (options.containment) {
        if (!terminating) {
          try {
            if (await options.containment.empty()) finish(code)
            else {
              terminate()
              await finishDuringTermGrace()
            }
          } catch {
            // A natural close never authorizes ambiguous descendants: try TERM→KILL on the container.
            terminate()
            await finishDuringTermGrace()
          }
        } else if (killEscalated) await finishWhenContained(code)
        else {
          // The wrapper close after TERM does not prove the cgroup is empty. If it is already empty we can avoid
          // KILL; otherwise let the full grace run and the escalation will start the cleanup deadline.
          try { if (await options.containment.empty()) finish(null) } catch { /* attende SIGKILL */ }
        }
      } else if (!terminating || killEscalated) finish(code)
    })() })

    timer = setTimeout(() => {
      timedOut = true
      terminate()
    }, timeoutMs)

    // Cooperative cancellation: the signal abort terminates the child like the timeout (without marking it timedOut).
    if (signal) {
      if (signal.aborted) onAbort()
      else signal.addEventListener('abort', onAbort, {once: true})
    }
  })
}

/**
 * CYAU-285 — where a Codex phase session leaves its result. In the Git administrative directory of the session
 * folder, like the busy marker: never in the working tree, where a commit could stage it, and on the paths a
 * contained session shares with the host. Outside a Git checkout, the temporary directory.
 */
function codexLastMessageFile(cwd: string): string {
  return path.join(gitAdminDirectory(cwd) ?? os.tmpdir(), `closeyourit-codex-result-${randomUUID()}.txt`)
}

/**
 * The result of a Codex `--json` session: the file it wrote, else its last agent message, else whatever non-event
 * text reached stdout. The file is removed once read: it holds the session's output, which belongs in the log.
 */
function codexResult(file: string, lastMessage: string | undefined, stdout: string): {text: string; truncated: boolean} {
  let written = ''
  let truncated = false
  try {
    const bytes = fs.readFileSync(file)
    truncated = bytes.length > OUTPUT_MAX_BYTES
    written = boundUtf8(bytes.toString('utf8'), OUTPUT_MAX_BYTES)
  } catch {
    // No file: the session ended before writing it, or could not write there.
  }
  fs.rmSync(file, {force: true})
  if (written.trim() !== '') return {text: written, truncated}
  if (lastMessage !== undefined && lastMessage.trim() !== '') {
    return {text: boundUtf8(lastMessage, OUTPUT_MAX_BYTES), truncated: Buffer.byteLength(lastMessage) > OUTPUT_MAX_BYTES}
  }
  return {text: stdout, truncated: false}
}

/** The Codex home the agent sessions run with: the one holding the managed rules, where their conversations stay. */
export function agentCodexHome(managed: ReturnType<typeof activeManagedGuardrailPaths> = activeManagedGuardrailPaths()): string {
  return managed.codexRulesPath ? path.dirname(path.dirname(managed.codexRulesPath)) : codexHomeDir()
}

/**
 * Generic engine: builds the argv from `action` (via `buildCommand`, multi-type) and runs it. The downgrade
 * of an exit-0 to failure is driven by the `ctx.isError` predicate (claude: `is_error`) — no knowledge of the
 * claude provider in this module. The guardrail gate and the output interpretation live in ClaudeRuntime.
 */
export async function runAction(name: string, action: Action, ctx: RunContext): Promise<RunResult> {
  const spawnFn = ctx.spawn ?? (nodeSpawn as unknown as SpawnFn)
  const clock = ctx.clock ?? Date.now
  let built: BuiltCommand
  let managedGuardrails: ReturnType<typeof activeManagedGuardrailPaths>
  const stream = action.type === 'claude' && ctx.onStreamEvent !== undefined
  // CYAU-285 — a Codex phase session with a conversation reports in events and leaves its result in a file.
  const codexConversation = action.type === 'codex' && action.skill !== undefined && ctx.conversation !== undefined
  let lastMessageFile: string | undefined
  try {
    managedGuardrails = activeManagedGuardrailPaths()
    if (codexConversation) lastMessageFile = codexLastMessageFile(resolveActionCwd(action, ctx.playbookDir, ctx.authorizedCwd))
    built = buildCommand(
      action,
      ctx.playbookDir,
      managedGuardrails.settingsPath ?? guardrailsSettingsPath(),
      ctx.authorizedCwd,
      {stream, conversation: ctx.conversation, ...(lastMessageFile ? {lastMessageFile} : {})},
    )
    built.cwd = ctx.authorizeCwd
      ? ctx.authorizeCwd(built.cwd)
      : authorizeActionCwd(action, ctx.playbookDir, ctx.authorizedCwd)
    const trustedPath = process.env.PATH
    built = resolveLaunchers(built, ctx.resolveExecutable ?? resolvePinnedExecutable, trustedPath)
  } catch (error) {
    const log = openLog(ctx.logDir, ctx.logName ?? name, ctx.now)
    const reason = error instanceof Error ? error.message : 'cwd o launcher non valido'
    log.header({type: action.type, command: redactSecrets(action.run), cwd: ctx.playbookDir, start: ctx.now})
    log.footer({status: 'failure', error_code: ErrorCodes.Exec.unsafeRuntime, reason})
    return {status: 'failure', exitCode: null, errorCode: ErrorCodes.Exec.unsafeRuntime, durationMs: 0, logPath: log.path, stdout: '', stdoutTruncated: false}
  }

  // Runtime-agnostic command policy (CYAU-25): rejects BEFORE the spawn the forbidden operations (production, destructive
  // DB, protected branches, force-push) on ANY runtime — never a sensitive command run just because
  // the runtime is not claude (where the `--settings` hooks already protect). Defence in depth with claude hooks and
  // codex sandbox, which confine the agents' INTERNAL commands. The gate lives here, the real process wrapper.
  const policy = evaluateAction(action)
  if (!policy.allowed) {
    const log = openLog(ctx.logDir, ctx.logName ?? name, ctx.now)
    log.header({type: action.type, command: built.display, cwd: built.cwd, start: ctx.now})
    log.footer({status: 'failure', error_code: ErrorCodes.Policy.violation, reason: policy.reason ?? 'command policy'})
    return {status: 'failure', exitCode: null, errorCode: ErrorCodes.Policy.violation, durationMs: 0, logPath: log.path, stdout: '', stdoutTruncated: false}
  }

  const env: NodeJS.ProcessEnv = {...process.env, ...action.env?.vars}
  // Managed secrets are never inherited from the terminal/service nor accepted from env.vars: they are first
  // removed and then materialized exclusively by the capability matrix of the current action.
  stripManagedSecretEnv(env)
  Object.assign(env, actionSecretEnv(action, ctx.secrets))
  // CYAU-167 — the run's data space. After the capabilities because it is not one: the playbook's `env.vars`
  // must not be able to overwrite it, and the secret sanitization does not touch it.
  if (ctx.testSlot) env.TEST_SLOT = ctx.testSlot
  // Sanitization AFTER every merge.
  env.PATH = process.env.PATH
  env.CODEX_HOME = agentCodexHome(managedGuardrails)
  // Inside the OS-level sandbox the network goes out through an HTTP proxy with an allowlist (SANDBOX_ALLOWED_DOMAINS).
  // `curl` and `git` honour the environment proxy variables; Node's `fetch` does NOT, unless told
  // to. Without this line `cyi` — which is a Node CLI — fails with `fetch failed` although closeyour.it
  // is allowed, and the skills cannot even read the ticket they must work on.
  env.NODE_USE_ENV_PROXY = '1'
  for (const key of DANGEROUS_ENV) env[key] = ''
  // Also covers unlisted platform-specific loader variants that were already present in the merge.
  for (const key of Object.keys(env)) {
    if (key.startsWith('LD_') || key.startsWith('DYLD_')) env[key] = ''
    if (key === 'GIT_CONFIG_COUNT' || key === 'GIT_CONFIG_PARAMETERS' ||
        key.startsWith('GIT_CONFIG_KEY_') || key.startsWith('GIT_CONFIG_VALUE_')) delete env[key]
    if (['GIT_DIR', 'GIT_WORK_TREE', 'GIT_COMMON_DIR', 'GIT_OBJECT_DIRECTORY',
      'GIT_ALTERNATE_OBJECT_DIRECTORIES', 'GIT_INDEX_FILE', 'GIT_NAMESPACE', 'GIT_SHALLOW_FILE',
      'GIT_REPLACE_REF_BASE'].includes(key)) delete env[key]
  }
  for (const key of REMOVED_GIT_ENV) delete env[key]
  // Fixed Git config not controllable by the action: no local hook/fsmonitor can run helpers.
  env.GIT_CONFIG_COUNT = '4'
  env.GIT_CONFIG_KEY_0 = 'core.hooksPath'
  env.GIT_CONFIG_VALUE_0 = '/dev/null'
  env.GIT_CONFIG_KEY_1 = 'core.fsmonitor'
  env.GIT_CONFIG_VALUE_1 = 'false'
  // CYAU-193 — the global config is off (GIT_CONFIG_GLOBAL='' above), so ~/.gitconfig does not count and
  // `git commit` in the session died with "Author identity unknown": runs succeeded only when
  // the model made up an identity by hand. The same fixed identity of the host's git commands
  // (ticket-delivery.ts) applies here too, and the action's GIT_AUTHOR_*/GIT_COMMITTER_* are already removed
  // from the environment before getting here, so the playbook cannot replace it.
  env.GIT_CONFIG_KEY_2 = 'user.name'
  env.GIT_CONFIG_VALUE_2 = AUTOMATOR_GIT_IDENTITY.name
  env.GIT_CONFIG_KEY_3 = 'user.email'
  env.GIT_CONFIG_VALUE_3 = AUTOMATOR_GIT_IDENTITY.email
  let containment: StrongContainmentHandle | undefined
  if (action.containment === 'strong') {
    // CYAU-302 — on a host with the VM backend installed, agent sessions run in a disposable VM; plain shell
    // actions (sync, playbook steps) keep the systemd scope, where a VM boot would buy nothing.
    const agent = action.type === 'claude' || action.type === 'codex'
    const backend = ctx.strongContainment
      ?? (agent && vmContainmentInstalled() ? sharedVmContainmentBackend() : createStrongContainmentBackend())
    const availability = await backend.available()
    if (!availability.available) {
      const log = openLog(ctx.logDir, ctx.logName ?? name, ctx.now)
      log.header({type: action.type, command: built.display, cwd: built.cwd, start: ctx.now})
      log.footer({
        status: 'failure',
        error_code: ErrorCodes.Exec.containmentUnavailable,
        reason: availability.detail ?? 'strong containment non disponibile',
      })
      return {
        status: 'failure', exitCode: null, errorCode: ErrorCodes.Exec.containmentUnavailable,
        durationMs: 0, logPath: log.path, stdout: '', stdoutTruncated: false,
      }
    }
    try {
      containment = await backend.prepare({cmd: built.cmd, args: built.args, cwd: built.cwd, env})
    } catch (error) {
      const log = openLog(ctx.logDir, ctx.logName ?? name, ctx.now)
      const reason = error instanceof Error ? error.message : 'preparazione strong containment fallita'
      log.header({type: action.type, command: built.display, cwd: built.cwd, start: ctx.now})
      log.footer({status: 'failure', error_code: ErrorCodes.Exec.containmentUnavailable, reason})
      return {
        status: 'failure', exitCode: null, errorCode: ErrorCodes.Exec.containmentUnavailable,
        durationMs: 0, logPath: log.path, stdout: '', stdoutTruncated: false,
      }
    }
  }

  const timeoutMs = (action.timeout ?? DEFAULT_TIMEOUT_S) * 1000

  const log = openLog(ctx.logDir, ctx.logName ?? name, ctx.now)
  log.header({type: action.type, command: built.display, cwd: built.cwd, start: ctx.now})

  const startedAt = clock()
  const executed = containment?.command ?? built
  let codexThread: string | undefined
  let codexLastMessage: string | undefined
  const codexEvents = (event: Record<string, unknown>): void => {
    const read = readCodexEvent(event)
    if (read.lastMessage !== undefined) codexLastMessage = read.lastMessage
    if (read.threadId && !codexThread) {
      codexThread = read.threadId
      ctx.onConversationStarted?.(read.threadId)
    }
  }
  const streamEvents = stream ? ctx.onStreamEvent : lastMessageFile ? codexEvents : undefined
  // A backend that carries the environment itself (VM) spawns its wrapper without the session's secrets.
  const outcome = await spawnCollect(spawnFn, executed, containment?.command.env ?? env, timeoutMs, (chunk, source, truncated) => {
    if (truncated) log.truncate()
    log.write(chunk, source)
  }, ctx.signal, {...ctx, containment, streamEvents, logStreamEvents: lastMessageFile !== undefined})
  const durationMs = clock() - startedAt
  if (lastMessageFile) {
    const result = codexResult(lastMessageFile, codexLastMessage, outcome.stdout)
    outcome.stdout = result.text
    outcome.stdoutTruncated ||= result.truncated
    if (result.text !== '') log.write(result.text.endsWith('\n') ? result.text : `${result.text}\n`, 'stdout')
  }
  const safeStdout = outcome.stdoutTruncated
    ? boundTruncatedStdout(redactSecretsAtTruncation(outcome.stdout), OUTPUT_MAX_BYTES)
    : boundUtf8(redactSecrets(outcome.stdout), OUTPUT_MAX_BYTES)

  let status: RunResult['status']
  let errorCode: string | null = null
  if (outcome.containmentFailed) {
    status = 'failure'
    errorCode = ErrorCodes.Exec.containmentUnverified
  } else if (outcome.timedOut) {
    status = 'timeout'
    errorCode = ErrorCodes.Exec.timeout
  } else if (outcome.code === 0 && !ctx.isError?.(safeStdout)) {
    status = 'success'
  } else {
    status = 'failure'
    errorCode = outcome.code === 127 ? ErrorCodes.Exec.notFound : ErrorCodes.Exec.failed
  }

  log.footer({status, exit_code: outcome.code ?? '-', error_code: errorCode ?? '-', duration_ms: durationMs})

  // On_failure is skipped if the action was cancelled: an explicit abort is not a failure to recover from.
  if (status !== 'success' && action.on_failure && !ctx.signal?.aborted) {
    const failureCwd = built.cwd
    log.footer({on_failure: redactSecrets(action.on_failure.run)})
    const failureEnv = {...env}
    // on_failure is a separate shell action without declarable capabilities: it keeps the parent's non-sensitive
    // vars for compatibility, but does not inherit managed credentials.
    stripManagedSecretEnv(failureEnv)
    await spawnCollect(
      spawnFn,
      {cmd: (ctx.resolveExecutable ?? resolvePinnedExecutable)('sh', process.env.PATH), args: ['-c', action.on_failure.run], cwd: failureCwd},
      failureEnv,
      timeoutMs,
      (chunk, source, truncated) => {
        if (truncated) log.truncate()
        log.write(chunk, source)
      },
      ctx.signal,
      ctx,
    )
    log.flush()
  }

  return {
    status,
    exitCode: outcome.code,
    errorCode,
    durationMs,
    logPath: log.path,
    stdout: safeStdout,
    stdoutTruncated: outcome.stdoutTruncated,
  }
}
