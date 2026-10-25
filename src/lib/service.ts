import {spawnSync} from 'node:child_process'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import {AutomatorError, ErrorCodes} from '../errors/error-codes'

// The self-scheduling daemon is kept alive exclusively by systemd --user (Restart=always).
// The renders are pure functions; install/uninstall/status spawn systemctl through an injectable ExecFn.

export type OsPlatform = 'linux'

export const SYSTEMD_UNIT = 'closeyourit-automator.service'

export interface InstallOptions {
  nodePath: string
  entrypoint: string
  args: string[]
  pathEnv: string
  workingDir: string
  env?: Record<string, string>
}

export interface ServiceStatus {
  installed: boolean
  running: boolean
  pid?: number
  detail?: string
}

export interface ManagedServiceRuntime {
  installRoot: string
  nodePath: string
  entrypoint: string
  daemonArgs: string[]
  configDir: string
  codexHome: string
}

export type ServiceRuntimeKind = 'managed' | 'legacy'

/** Attestable definition of the Automator unit, both managed and legacy checkout. */
export interface ServiceRuntime {
  kind: ServiceRuntimeKind
  platform: OsPlatform
  installRoot: string | null
  nodePath: string
  entrypoint: string
  daemonArgs: string[]
  pathEnv: string
  homeDir: string
  workingDir: string
  env: Record<string, string>
  configDir: string
  codexHome: string
}

export interface ExecResult {
  code: number
  stdout: string
  stderr: string
}

export type ExecFn = (cmd: string, args: string[]) => ExecResult

export interface ServiceManager {
  install(opts: InstallOptions): void
  uninstall(): void
  status(): ServiceStatus
  logsPath(): string
  unitPath(): string
  /** Full definition on disk; null for a missing, symlinked, ambiguous or non-attestable file. */
  runtime(): ServiceRuntime | null
  /** Definition actually loaded by the service manager, overrides/drop-ins included. */
  loadedRuntime(): ServiceRuntime | null
  /** Identity read from the actually installed unit; null for a missing, invalid legacy or unmanaged unit. */
  managedRuntime(): ManagedServiceRuntime | null
  /** Identity actually loaded by the service manager, overrides/drop-ins included. */
  loadedManagedRuntime(): ManagedServiceRuntime | null
  /** Reloads the definition on disk and restarts the unit. */
  restart(): void
}

export function defaultExec(cmd: string, args: string[]): ExecResult {
  const result = spawnSync(cmd, args, {encoding: 'utf8'})
  return {code: result.status ?? 1, stdout: result.stdout ?? '', stderr: result.stderr ?? ''}
}

/**
 * Explicit PATH for the service unit: mise shims first (node/pnpm/cyi), then ~/.local/bin
 * (native claude), then /usr/local/bin, finally the system paths. Needed
 * even with absolute-path binaries, because `claude`'s subshells inherit the process PATH.
 */
/**
 * Skill-mode AS THE DAEMON SEES IT, not the shell of whoever runs the command (CYAU-95). `skillsModeEnabled()`
 * reads `process.env`, which in an interactive shell does NOT contain `AUTOMATOR_SKILLS_ENABLED`: that variable
 * lives in the unit, injected by `install --skills-enabled`. Asking the process would give "off" on
 * a machine whose daemon is instead in skill-mode — and the prerequisites of that mode (the skill bundle)
 * would be declared unnecessary exactly where they are needed.
 *
 * It prefers the ACTUALLY loaded definition (`loadedRuntime`, includes overrides/drop-ins), falls back to
 * the one on disk. ORed with the process env: an operator exporting the variable by hand stays covered,
 * and the direction of the OR can never HIDE a prerequisite (at most it requires it more).
 */
/**
 * The guardrail inputs AS THE DAEMON SEES THEM (CYRA-914 B9): copied from the unit into a shell that lacks them, so
 * doctor checks the guardrails the daemon builds instead of reporting the installed ones as broken. A value the
 * operator exported by hand wins.
 */
export function adoptServiceGuardrailEnv(manager: ServiceManager, processEnv: NodeJS.ProcessEnv = process.env): void {
  const unit = manager.loadedRuntime() ?? manager.runtime()
  for (const key of ['AUTOMATOR_PRODUCTION_HOSTS', 'AUTOMATOR_SANDBOX_DOMAINS']) {
    const value = unit?.env[key]
    if (!processEnv[key] && value) processEnv[key] = value
  }
}

export function serviceSkillsModeEnabled(manager: ServiceManager, processEnv: NodeJS.ProcessEnv = process.env): boolean {
  const truthy = (value: string | undefined): boolean => {
    const normalized = value?.trim().toLowerCase()
    return normalized === '1' || normalized === 'true'
  }
  const unit = manager.loadedRuntime() ?? manager.runtime()
  return truthy(unit?.env.AUTOMATOR_SKILLS_ENABLED) || truthy(processEnv.AUTOMATOR_SKILLS_ENABLED)
}

export function buildPathEnv(homeDir: string): string {
  return [
    path.join(homeDir, '.local', 'share', 'mise', 'shims'),
    path.join(homeDir, '.local', 'bin'),
    '/usr/local/bin',
    '/usr/bin',
    '/bin',
    '/usr/sbin',
    '/sbin',
  ].join(':')
}

export function detectPlatform(): OsPlatform {
  if (process.platform === 'linux') return 'linux'
  throw new AutomatorError(
    ErrorCodes.Service.unsupportedOs,
    `Piattaforma non supportata: ${process.platform}. Automator supporta esclusivamente Linux.`,
  )
}

// ---- pure renders ----

export interface SystemdFields {
  description: string
  execStart: string | string[]
  workingDir: string
  pathEnv: string
  homeDir: string
  env: Record<string, string>
  /**
   * Runtime directory of the service user (`/run/user/<uid>`), from which the D-Bus variables
   * are derived. The RESOLVED value is passed and not the `%t` specifier: `quoteSystemdWord` renders `%` literally
   * as `%%`, so a specifier would end up in the unit as text and the path would not exist.
   * Missing ⇒ the variables are not emitted (the render stays usable without them).
   */
  runtimeDir?: string
}

/**
 * `WorkingDirectory=` must NOT be quoted (CYAU-125). Quoting is correct for `ExecStart`, where systemd
 * applies the rules of a command line and quotes delimit the arguments; here the value is a
 * single path, and systemd 255 reads literally a value starting with `"` — so it rejects the unit
 * with "path is not absolute" and marks it `bad-setting`. The service does not start, on any Linux host.
 *
 * A path with spaces stays correct without quotes: systemd takes everything following `=` up to the
 * end of the line. Only the characters that would break the FILE remain to neutralize — newline and carriage
 * return — which in a path are pathological anyway: better to reject than to emit a corrupt unit.
 */
function renderWorkingDirectory(workingDir: string): string {
  // Same characters `quoteSystemdWord` rejects, for the same reason: they would break the FILE.
  // `\0` included — dropping it from the check when moving to the literal value would have been a silent
  // regression compared to the quoted version.
  if (/[\0\n\r]/.test(workingDir)) throw new Error('working dir non valida: carattere non rappresentabile')
  // A backslash is NOT representable outside quotes: at the end of a line systemd reads it as a
  // CONTINUATION, so `WorkingDirectory=/path\` would absorb the following `Environment=` line and
  // produce a corrupt but syntactically accepted unit — the worst of failures, silent.
  // Elsewhere it would stay ambiguous anyway. A Linux path with a backslash is pathological: better to fail here.
  if (workingDir.includes('\\')) throw new Error('working dir non valida: contiene un backslash')
  // Spaces/tabs at the edges: systemd discards them and our parser does `.trim()`, so a path containing them
  // would be WRITTEN one way and READ BACK as a different directory — the unit would look
  // correct and the daemon would work elsewhere. Not representable without quotes: rejected.
  if (workingDir !== workingDir.trim()) throw new Error('working dir non valida: spazi ai bordi')
  // `%` stays special outside quotes too: without doubling it systemd would read it as a
  // specifier and the working dir would point elsewhere.
  return `WorkingDirectory=${workingDir.replaceAll('%', '%%')}`
}

/**
 * Reads `WorkingDirectory=` from a unit on disk accepting BOTH formats: the literal value
 * we write from CYAU-125 onwards, and the quoted one of the already installed units. Without the second
 * form, an updated host would no longer recognise its own unit and the update would fail closed
 * exactly on the machines the fix must save.
 *
 * `parseSystemdWords` is not used: it splits on spaces, so an unquoted path containing them
 * would come back as several words and the unit would be discarded. systemd instead takes everything
 * following `=` up to the end of the line.
 */
function parseWorkingDirectoryValue(raw: string): string | null {
  const trimmed = raw.trim()
  if (trimmed.length === 0) return null
  if (trimmed.startsWith('"')) {
    const words = parseSystemdWords(trimmed)
    return words && words.length === 1 ? words[0] : null
  }
  return trimmed.replaceAll('%%', '%')
}

export function renderSystemdUnit(f: SystemdFields): string {
  // CYAU-126: the credentials live in the Secret Service, which is reached ONLY via the session D-Bus
  // (`secret-tool`). A systemd --user service does not inherit that address, so without these two
  // variables the daemon does not read its own host token: every host-scoped call fails and the queue
  // stops on "snapshot not available", which looks like a network problem and is not.
  // The value is the ALREADY RESOLVED runtime directory, not the `%t` specifier: `quoteSystemdWord` renders
  // `%` literally as `%%`, so a specifier would end up in the unit as text and the path would not
  // exist. The price is a hardwired uid — acceptable, since the unit already has absolute paths
  // everywhere and is machine-specific anyway.
  const dbusEnv = f.runtimeDir
    ? {XDG_RUNTIME_DIR: f.runtimeDir, DBUS_SESSION_BUS_ADDRESS: `unix:path=${f.runtimeDir}/bus`}
    : {}
  let environment = ''
  for (const [key, value] of Object.entries({PATH: f.pathEnv, HOME: f.homeDir, ...dbusEnv, ...f.env})) {
    environment += `${environment ? ' ' : ''}${quoteSystemdWord(`${key}=${value}`)}`
  }
  const execStart = Array.isArray(f.execStart) ? renderSystemdCommand(f.execStart) : f.execStart
  // CYAU-127: StartLimit* belong to [Unit], not to [Service] — since systemd 229 start rate limiting
  // is a property of the unit. In the wrong section systemd ignores them with a simple
  // warning, so the restart cap does not exist and a crash loop restarts forever.
  return `[Unit]
Description=${f.description}
Wants=network-online.target
After=network-online.target
StartLimitIntervalSec=60
StartLimitBurst=5

[Service]
Type=simple
ExecStart=${execStart}
${renderWorkingDirectory(f.workingDir)}
Environment=${environment}
Restart=always
RestartSec=5
KillSignal=SIGTERM
TimeoutStopSec=30

[Install]
WantedBy=default.target
`
}

const SAFE_SERVICE_ENV = new Set([
  'AUTOMATOR_STATE_DIR',
  'AUTOMATOR_CONFIG_DIR',
  'AUTOMATOR_PLAYBOOK',
  'AUTOMATOR_INSTALL_ROOT',
  'CODEX_HOME',
  // D-Bus session (CYAU-126): without these the daemon does not reach the Secret Service and does not read its
  // own host token. They must be allowed here because the validation is fail-closed on an allowlist: without them,
  // the unit we generate ourselves would be rejected as non-attestable. They are not secrets — they are
  // the path of a socket — and they loosen nothing: the keyring content stays protected by the OS.
  'XDG_RUNTIME_DIR',
  'DBUS_SESSION_BUS_ADDRESS',
  // Daemon skill-mode toggle (CYAU-90): enables host-first execution via the closeyourit-skills skills.
  // It must be allowed in the unit — otherwise the fail-closed validation would reject it; `install
  // --skills-enabled` sets it. Missing = prompt-mode (additive default).
  'AUTOMATOR_SKILLS_ENABLED',
  // Hosts and domains of this installation (CYRA-914): the guardrails read them, so the daemon, the update timer and
  // doctor must see what `install` saw. Validated by command-policy and guardrails, which throw on a malformed entry.
  'AUTOMATOR_PRODUCTION_HOSTS',
  'AUTOMATOR_SANDBOX_DOMAINS',
])

/** Deterministic quoting of the systemd subset emitted by Automator. `%` is always made literal. */
export function quoteSystemdWord(value: string): string {
  if (/[\0\n\r]/.test(value)) throw new Error('valore systemd non rappresentabile')
  const escaped = value.replaceAll('%', '%%').replaceAll('\\', '\\\\').replaceAll('"', '\\"')
  return `"${escaped}"`
}

export function renderSystemdCommand(argv: string[]): string {
  if (argv.length === 0) throw new Error('comando systemd vuoto')
  let rendered = ''
  for (const argument of argv) rendered += `${rendered ? ' ' : ''}${quoteSystemdWord(argument)}`
  return rendered
}

/** Fail-closed inverse parser: accepts double/backslash quoting and only literal `%%` percent signs. */
export function parseSystemdWords(value: string, allowLiteralPercent = false): string[] | null {
  const words: string[] = []
  let current = ''
  let quoted = false
  let escaped = false
  let started = false
  for (let index = 0; index < value.length; index += 1) {
    const char = value[index]
    if (escaped) {
      if (char !== '\\' && char !== '"') return null
      current += char
      escaped = false
      started = true
      continue
    }
    if (char === '\\') {
      escaped = true
      started = true
      continue
    }
    if (char === '"') {
      quoted = !quoted
      started = true
      continue
    }
    if (char === "'") return null
    if (char === '%') {
      if (value[index + 1] !== '%') {
        if (!allowLiteralPercent) return null
        current += '%'
        started = true
        continue
      }
      current += '%'
      index += 1
      started = true
      continue
    }
    if (/\s/.test(char) && !quoted) {
      if (started) {
        words.push(current)
        current = ''
        started = false
      }
      continue
    }
    current += char
    started = true
  }
  if (escaped || quoted) return null
  if (started) words.push(current)
  return words
}

function readRegularUnit(file: string): string | null {
  try {
    const stat = fs.lstatSync(file)
    if (!stat.isFile() || stat.isSymbolicLink()) return null
    return fs.readFileSync(file, 'utf8')
  } catch {
    return null
  }
}

function validDaemonArguments(args: string[]): boolean {
  if (args.length !== 3 && args.length !== 5) return false
  if (args[0] !== 'daemon' || args[1] !== '--playbook' || !path.isAbsolute(args[2])) return false
  return args.length === 3 || (args[3] === '--interval' && /^[1-9]\d*$/.test(args[4]))
}

interface RuntimeParts {
  platform: OsPlatform
  nodePath: string
  entrypoint: string
  daemonArgs: string[]
  pathEnv: string
  homeDir: string
  workingDir: string
  env: Record<string, string>
  legacyCodexHome: string
}

function validatedRuntime(parts: RuntimeParts): ServiceRuntime | null {
  const {env} = parts
  if (Object.keys(env).some((key) => !SAFE_SERVICE_ENV.has(key))) return null
  const configDir = env.AUTOMATOR_CONFIG_DIR
  const codexHome = env.CODEX_HOME ?? parts.legacyCodexHome
  if (
    !path.isAbsolute(parts.nodePath) || !path.isAbsolute(parts.entrypoint) ||
    !path.isAbsolute(parts.homeDir) || !path.isAbsolute(parts.workingDir) ||
    !configDir || !path.isAbsolute(configDir) || !path.isAbsolute(codexHome) ||
    !validDaemonArguments(parts.daemonArgs)
  ) return null

  const rootValue = env.AUTOMATOR_INSTALL_ROOT
  if (rootValue) {
    if (!path.isAbsolute(rootValue)) return null
    const root = path.resolve(rootValue)
    if (path.resolve(parts.entrypoint) !== path.join(root, 'current', 'bin', 'run.js')) return null
    return {
      kind: 'managed', platform: parts.platform, installRoot: root,
      nodePath: parts.nodePath, entrypoint: path.resolve(parts.entrypoint), daemonArgs: [...parts.daemonArgs],
      pathEnv: parts.pathEnv, homeDir: path.resolve(parts.homeDir), workingDir: path.resolve(parts.workingDir),
      env: {...env}, configDir: path.resolve(configDir), codexHome: path.resolve(codexHome),
    }
  }

  const entrypoint = path.resolve(parts.entrypoint)
  if (path.basename(entrypoint) !== 'run.js' || path.basename(path.dirname(entrypoint)) !== 'bin') return null
  return {
    kind: 'legacy', platform: parts.platform, installRoot: null,
    nodePath: parts.nodePath, entrypoint, daemonArgs: [...parts.daemonArgs], pathEnv: parts.pathEnv,
    homeDir: path.resolve(parts.homeDir), workingDir: path.resolve(parts.workingDir), env: {...env},
    configDir: path.resolve(configDir), codexHome: path.resolve(codexHome),
  }
}

/** Validates a persisted runtime with the same semantic contract used by the disk/live parsers. */
export function isServiceRuntimeSemanticallyValid(runtime: ServiceRuntime): boolean {
  const validated = validatedRuntime({
    platform: runtime.platform,
    nodePath: runtime.nodePath,
    entrypoint: runtime.entrypoint,
    daemonArgs: runtime.daemonArgs,
    pathEnv: runtime.pathEnv,
    homeDir: runtime.homeDir,
    workingDir: runtime.workingDir,
    env: runtime.env,
    legacyCodexHome: path.join(runtime.homeDir, '.codex'),
  })
  if (validated === null) return false
  return validated.kind === runtime.kind && validated.installRoot === runtime.installRoot &&
    validated.nodePath === runtime.nodePath && validated.entrypoint === runtime.entrypoint &&
    validated.pathEnv === runtime.pathEnv && validated.homeDir === runtime.homeDir &&
    validated.workingDir === runtime.workingDir && validated.configDir === runtime.configDir &&
    validated.codexHome === runtime.codexHome &&
    validated.daemonArgs.length === runtime.daemonArgs.length &&
    validated.daemonArgs.every((argument, index) => argument === runtime.daemonArgs[index]) &&
    JSON.stringify(Object.entries(validated.env).sort()) === JSON.stringify(Object.entries(runtime.env).sort())
}

/** A diverging field of the service identity, with the expected (on disk) and the actual (live) value. */
export interface RuntimeDivergence {
  field: string
  expected: string
  actual: string
}

/** A "missing" placeholder for an absent value (e.g. `installRoot` of a legacy unit), otherwise the raw string. */
const ABSENT = '(assente)'
const showRuntimeValue = (value: string | null): string => (value === null ? ABSENT : value)

/**
 * daemonArgs divergence with EXACT element-by-element comparison (never on `join`, which would lose the argument
 * boundaries: `['a b','c']` and `['a','b c']` would collapse into the same string). The `join` stays only the
 * readable representation shown when there is already a real divergence.
 */
function daemonArgsDivergence(observed: string[], expected: string[]): RuntimeDivergence | null {
  const equal = observed.length === expected.length && observed.every((argument, index) => argument === expected[index])
  return equal ? null : {field: 'daemonArgs', expected: expected.join(' '), actual: observed.join(' ')}
}

/**
 * DIAGNOSTIC comparison of two managed identities: returns the list of diverging fields with expected and actual
 * instead of a simple boolean (CYAU-102). Empty ⇒ they match. A null `observed` (live definition not readable
 * or not managed) is an explicit divergence, not a silent mismatch on every field.
 */
export function diffManagedServiceRuntime(
  observed: ManagedServiceRuntime | null,
  expected: ManagedServiceRuntime,
): RuntimeDivergence[] {
  if (observed === null) {
    return [{field: 'definizione live', expected: 'unit gestita leggibile e coerente', actual: 'assente o non interpretabile'}]
  }
  const divergences: RuntimeDivergence[] = []
  const check = (field: string, actual: string, wanted: string): void => {
    if (actual !== wanted) divergences.push({field, expected: wanted, actual})
  }
  check('installRoot', showRuntimeValue(observed.installRoot), showRuntimeValue(expected.installRoot))
  check('nodePath', showRuntimeValue(observed.nodePath), showRuntimeValue(expected.nodePath))
  check('entrypoint', showRuntimeValue(observed.entrypoint), showRuntimeValue(expected.entrypoint))
  const argsDivergence = daemonArgsDivergence(observed.daemonArgs, expected.daemonArgs)
  if (argsDivergence) divergences.push(argsDivergence)
  check('configDir', showRuntimeValue(observed.configDir), showRuntimeValue(expected.configDir))
  check('codexHome', showRuntimeValue(observed.codexHome), showRuntimeValue(expected.codexHome))
  return divergences
}

/** Same as above but for the full definition (legacy/managed unit on disk vs live), envs included. */
export function diffServiceRuntime(observed: ServiceRuntime | null, expected: ServiceRuntime): RuntimeDivergence[] {
  if (observed === null) {
    return [{field: 'definizione live', expected: 'unit leggibile e coerente', actual: 'assente o non interpretabile'}]
  }
  const divergences: RuntimeDivergence[] = []
  const check = (field: string, actual: string, wanted: string): void => {
    if (actual !== wanted) divergences.push({field, expected: wanted, actual})
  }
  check('kind', observed.kind, expected.kind)
  check('platform', observed.platform, expected.platform)
  check('installRoot', showRuntimeValue(observed.installRoot), showRuntimeValue(expected.installRoot))
  check('nodePath', showRuntimeValue(observed.nodePath), showRuntimeValue(expected.nodePath))
  check('entrypoint', showRuntimeValue(observed.entrypoint), showRuntimeValue(expected.entrypoint))
  check('pathEnv', showRuntimeValue(observed.pathEnv), showRuntimeValue(expected.pathEnv))
  check('homeDir', showRuntimeValue(observed.homeDir), showRuntimeValue(expected.homeDir))
  check('workingDir', showRuntimeValue(observed.workingDir), showRuntimeValue(expected.workingDir))
  check('configDir', showRuntimeValue(observed.configDir), showRuntimeValue(expected.configDir))
  check('codexHome', showRuntimeValue(observed.codexHome), showRuntimeValue(expected.codexHome))
  const argsDivergence = daemonArgsDivergence(observed.daemonArgs, expected.daemonArgs)
  if (argsDivergence) divergences.push(argsDivergence)
  const serializeEnv = (env: Record<string, string>): string =>
    JSON.stringify(Object.entries(env).sort(([a], [b]) => a.localeCompare(b)))
  check('env', serializeEnv(observed.env), serializeEnv(expected.env))
  return divergences
}

/** Renders the divergences in a readable line for the error message: `field atteso X effettivo Y; …`. */
export function describeRuntimeDivergences(divergences: RuntimeDivergence[]): string {
  return divergences.map((d) => `${d.field} atteso ${d.expected} effettivo ${d.actual}`).join('; ')
}

function validatedManagedRuntime(
  installRoot: string,
  nodePath: string,
  entrypoint: string,
  daemonArgs: string[],
  configDir: string,
  codexHome: string,
): ManagedServiceRuntime | null {
  if (
    !path.isAbsolute(installRoot) || !path.isAbsolute(nodePath) || !path.isAbsolute(entrypoint) ||
    !path.isAbsolute(configDir) || !path.isAbsolute(codexHome)
  ) return null
  const root = path.resolve(installRoot)
  if (path.resolve(entrypoint) !== path.join(root, 'current', 'bin', 'run.js')) return null
  if (!validDaemonArguments(daemonArgs)) return null
  return {
    installRoot: root,
    nodePath,
    entrypoint: path.resolve(entrypoint),
    daemonArgs: [...daemonArgs],
    configDir: path.resolve(configDir),
    codexHome: path.resolve(codexHome),
  }
}

function systemdEnvironments(content: string, loaded: boolean): Record<string, string> | null {
  const values: Record<string, string> = {}
  const lines = [...content.matchAll(/^Environment=(.*)$/gm)]
  if (lines.length !== 1 || /\\\r?\n/.test(content)) return null
  for (const line of lines) {
    const words = parseSystemdWords(line[1], loaded)
    if (!words) return null
    for (const word of words) {
      const separator = word.indexOf('=')
      if (separator <= 0) return null
      const key = word.slice(0, separator)
      if (key in values) return null
      if (key !== 'PATH' && key !== 'HOME' && !SAFE_SERVICE_ENV.has(key)) return null
      values[key] = word.slice(separator + 1)
    }
  }
  return values
}

function systemdRuntime(content: string, legacyCodexHome: string): ServiceRuntime | null {
  if (/\\\r?\n/.test(content)) return null
  const environment = systemdEnvironments(content, false)
  const execStarts = [...content.matchAll(/^ExecStart=(.*)$/gm)]
  const workingDirectories = [...content.matchAll(/^WorkingDirectory=(.*)$/gm)]
  const execStart = execStarts.length === 1 ? execStarts[0][1] : undefined
  const workingRaw = workingDirectories.length === 1 ? workingDirectories[0][1] : undefined
  const args = execStart === undefined ? null : parseSystemdWords(execStart)
  const working = workingRaw === undefined ? null : parseWorkingDirectoryValue(workingRaw)
  if (!environment || !args || args.length < 2 || !working) return null
  const {PATH: pathEnv = '', HOME: homeDir = path.dirname(legacyCodexHome), ...env} = environment
  return validatedRuntime({platform: 'linux', nodePath: args[0], entrypoint: args[1], daemonArgs: args.slice(2), pathEnv, homeDir, workingDir: working, env, legacyCodexHome})
}

function systemdManagedRuntime(content: string, legacyCodexHome: string): ManagedServiceRuntime | null {
  const runtime = systemdRuntime(content, legacyCodexHome)
  return runtime?.kind === 'managed'
    ? validatedManagedRuntime(runtime.installRoot!, runtime.nodePath, runtime.entrypoint, runtime.daemonArgs, runtime.configDir, runtime.codexHome)
    : null
}

function systemdLoadedRuntime(content: string, legacyCodexHome: string): ServiceRuntime | null {
  if (/\\\r?\n/.test(content)) return null
  const environment = systemdEnvironments(content, true)
  const execStarts = [...content.matchAll(/^ExecStart=(.*)$/gm)]
  const workingDirectories = [...content.matchAll(/^WorkingDirectory=(.*)$/gm)]
  if (execStarts.length !== 1 || workingDirectories.length > 1) return null
  const execStart = execStarts[0][1]
  const executable = /^\{\s*path=(.*?)\s*;\s*argv\[\]=/.exec(execStart)?.[1]?.trim()
  const argv = /(?:^|;\s*)argv\[\]=(.+?)\s*;\s*(?:ignore_errors|start_time)=/.exec(execStart)?.[1]?.trim()
  const args = argv === undefined ? null : parseSystemdWords(argv, true)
  if (!environment || !args || args.length < 2 || executable !== args[0]) return null
  const {PATH: pathEnv = '', HOME: homeDir = path.dirname(legacyCodexHome), ...env} = environment
  const workingDir = workingDirectories[0]?.[1]?.trim() || path.dirname(args[args.indexOf('--playbook') + 1] ?? homeDir)
  return validatedRuntime({platform: 'linux', nodePath: args[0], entrypoint: args[1], daemonArgs: args.slice(2), pathEnv, homeDir, workingDir, env, legacyCodexHome})
}

function systemdLoadedManagedRuntime(content: string, legacyCodexHome: string): ManagedServiceRuntime | null {
  const runtime = systemdLoadedRuntime(content, legacyCodexHome)
  return runtime?.kind === 'managed'
    ? validatedManagedRuntime(runtime.installRoot!, runtime.nodePath, runtime.entrypoint, runtime.daemonArgs, runtime.configDir, runtime.codexHome)
    : null
}

/**
 * Runtime directory of the user owning the service. `XDG_RUNTIME_DIR` if present; otherwise
 * it is composed from the real uid, because the unit is written now but read by systemd in a session that
 * may not have that variable. Exported because the update timer (CYAU-202) must also
 * receive EXACTLY the same value as the daemon.
 */
export function userRuntimeDir(): string | undefined {
  const fromEnv = process.env.XDG_RUNTIME_DIR?.trim()
  if (fromEnv) return fromEnv
  const uid = typeof process.getuid === 'function' ? process.getuid() : undefined
  return uid === undefined ? undefined : `/run/user/${uid}`
}

// ---- SystemdManager (Linux, user service) ----

class SystemdManager implements ServiceManager {
  constructor(private readonly exec: ExecFn, private readonly homeDir: string) {}

  unitPath(): string {
    return path.join(this.homeDir, '.config', 'systemd', 'user', SYSTEMD_UNIT)
  }

  logsPath(): string {
    return `journalctl --user -u ${SYSTEMD_UNIT} -f`
  }

  runtime(): ServiceRuntime | null {
    const content = readRegularUnit(this.unitPath())
    return content === null ? null : systemdRuntime(content, path.join(this.homeDir, '.codex'))
  }

  loadedRuntime(): ServiceRuntime | null {
    const result = this.exec('systemctl', [
      '--user', 'show', '-p', 'ExecStart', '-p', 'Environment', '-p', 'WorkingDirectory', SYSTEMD_UNIT,
    ])
    return result.code === 0 ? systemdLoadedRuntime(result.stdout, path.join(this.homeDir, '.codex')) : null
  }

  managedRuntime(): ManagedServiceRuntime | null {
    const content = readRegularUnit(this.unitPath())
    return content === null ? null : systemdManagedRuntime(content, path.join(this.homeDir, '.codex'))
  }

  loadedManagedRuntime(): ManagedServiceRuntime | null {
    const result = this.exec('systemctl', [
      '--user', 'show', '-p', 'ExecStart', '-p', 'Environment', SYSTEMD_UNIT,
    ])
    return result.code === 0 ? systemdLoadedManagedRuntime(result.stdout, path.join(this.homeDir, '.codex')) : null
  }

  restart(): void {
    const reload = this.exec('systemctl', ['--user', 'daemon-reload'])
    if (reload.code !== 0) {
      throw new AutomatorError(ErrorCodes.Service.installFailed, `systemctl daemon-reload fallito: ${reload.stderr.trim()}`)
    }
    const result = this.exec('systemctl', ['--user', 'restart', SYSTEMD_UNIT])
    if (result.code !== 0) {
      throw new AutomatorError(ErrorCodes.Service.installFailed, `systemctl restart fallito: ${result.stderr.trim()}`)
    }
  }

  install(opts: InstallOptions): void {
    const unit = renderSystemdUnit({
      description: 'CloseYourIt automator daemon',
      execStart: [opts.nodePath, opts.entrypoint, ...opts.args],
      workingDir: opts.workingDir,
      pathEnv: opts.pathEnv,
      homeDir: this.homeDir,
      env: opts.env ?? {},
      runtimeDir: userRuntimeDir(),
    })
    fs.mkdirSync(path.dirname(this.unitPath()), {recursive: true})
    fs.writeFileSync(this.unitPath(), unit)
    this.exec('systemctl', ['--user', 'daemon-reload'])
    const res = this.exec('systemctl', ['--user', 'enable', '--now', SYSTEMD_UNIT])
    if (res.code !== 0) {
      throw new AutomatorError(ErrorCodes.Service.installFailed, `systemctl enable fallito: ${res.stderr.trim()}`)
    }
  }

  uninstall(): void {
    this.exec('systemctl', ['--user', 'disable', '--now', SYSTEMD_UNIT])
    fs.rmSync(this.unitPath(), {force: true})
    this.exec('systemctl', ['--user', 'daemon-reload'])
  }

  status(): ServiceStatus {
    const installed = fs.existsSync(this.unitPath())
    const res = this.exec('systemctl', ['--user', 'show', '-p', 'ActiveState', '-p', 'MainPID', SYSTEMD_UNIT])
    const active = /ActiveState=active/.test(res.stdout)
    const pidMatch = /MainPID=(\d+)/.exec(res.stdout)
    const pid = pidMatch && Number(pidMatch[1]) > 0 ? Number(pidMatch[1]) : undefined
    return {installed, running: active, pid, detail: active ? 'active (running)' : 'inattivo'}
  }
}

export function serviceManager(
  _platform: OsPlatform = detectPlatform(),
  exec: ExecFn = defaultExec,
  homeDir: string = os.homedir(),
): ServiceManager {
  return new SystemdManager(exec, homeDir)
}
