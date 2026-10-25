import {spawnSync} from 'node:child_process'
import {runProcessProbe, type ProcessProbeOptions} from './process-probe'
import {CLAUDE_LOCAL_AUTH_ENV} from './env-capabilities'
import {orgClaudeCredential} from './org-claude-credential'
import {LOCAL_WORK_ENGINE} from './models'

// SERVICE-equivalent environment for the Claude auth probe. The systemd daemon runs as the user and
// inherits HOME (→ local `claude login` credentials) and PATH, but NOT the ephemeral exports of the installation shell.
// We therefore remove the Claude auth variables possibly exported in the shell before probing: the probe
// answers "will the DAEMON find an active Claude?", not "does my shell have a token?".
// Known tension (conflicting Codex reviews): at install time an ephemeral credential (shell only) and a durable one
// (HOME or Environment= in the unit) are indistinguishable in process.env. FAIL-CLOSED choice: a shell-only one
// that the service will not inherit must NOT declare "ready" (false ready → silent daemon). Durable auth via
// the local credential stays detected (it is not an env). A rare export-in-shell-AND-durable-in-the-unit gives a false not-ready,
// which is safe. actionSecretEnv keeps forwarding to the claude action the DURABLE auth present in the daemon env.
// CYAU-224: the organization's credential is durable (credential store), so it does count.
function serviceEnvWithoutEphemeralClaudeAuth(base: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const env = {...base}
  for (const key of CLAUDE_LOCAL_AUTH_ENV) delete env[key]
  const org = orgClaudeCredential()
  if (org) env[org.env] = org.token
  return env
}

// Automator CLI dependencies, as single DATA (source of truth for doctor + setup).
// `managedBy`: 'bootstrap' = first-contact chain installed by bin/bootstrap.sh (mise→node/pnpm→gh→cyi);
// 'setup' = standalone tools `setup` can install (mise, python, claude, codex).

export interface InstallSpec {
  cmd: string
  sudo: boolean
}

export interface Dep {
  name: string
  bin: string
  versionCmd: string
  required: boolean
  managedBy: 'bootstrap' | 'setup'
  install: InstallSpec
}

export const DEPS: Dep[] = [
  {
    name: 'mise',
    bin: 'mise',
    versionCmd: 'mise --version',
    required: true,
    managedBy: 'setup',
    install: {cmd: 'curl https://mise.run | sh', sudo: false},
  },
  {
    name: 'node',
    bin: 'node',
    versionCmd: 'node --version',
    required: true,
    managedBy: 'bootstrap',
    install: {cmd: 'mise use -g node@24.11.0', sudo: false},
  },
  {
    name: 'python',
    bin: 'python3',
    versionCmd: 'python3 --version',
    required: true,
    managedBy: 'setup',
    install: {cmd: 'mise use -g python@3.13', sudo: false},
  },
  {
    name: 'pnpm',
    bin: 'pnpm',
    versionCmd: 'pnpm --version',
    required: false,
    managedBy: 'bootstrap',
    install: {cmd: "mise use -g 'npm:pnpm@11.28.5'", sudo: false},
  },
  {
    name: 'cyi',
    bin: 'cyi',
    versionCmd: 'cyi --version',
    required: true,
    managedBy: 'bootstrap',
    install: {cmd: 'npm install -g @bussolabs/closeyourit-cli', sudo: false},
  },
  {
    name: 'claude',
    bin: 'claude',
    versionCmd: 'claude --version',
    required: LOCAL_WORK_ENGINE === 'claude',
    managedBy: 'setup',
    install: {cmd: 'curl -fsSL https://claude.ai/install.sh | bash', sudo: false},
  },
  {
    name: 'codex',
    bin: 'codex',
    versionCmd: 'codex --version',
    required: LOCAL_WORK_ENGINE === 'codex',
    managedBy: 'setup',
    install: {cmd: 'npm install -g @openai/codex', sudo: false},
  },
  {
    // CYAU-228: OpenCode only reviews, and only when the server names it for this machine. Optional: a machine
    // that reviews with it and lacks it takes no work, which the server decides from the declared runtimes.
    name: 'opencode',
    bin: 'opencode',
    versionCmd: 'opencode --version',
    required: false,
    managedBy: 'setup',
    install: {cmd: 'npm install -g opencode-ai@1.18.32', sudo: false},
  },
  {
    name: 'gh',
    bin: 'gh',
    versionCmd: 'gh --version',
    required: true,
    managedBy: 'bootstrap',
    install: {cmd: "mise use -g 'github:cli/cli@2.102.0'", sudo: false},
  },
  {
    // CYAU-136: the skill bundle delivery scripts (deliver.sh/lib.sh) use the `jq` binary. Without it,
    // the agent gets to the end (code written and committed) but the delivery stops `blocked` and no
    // procedure installs it. `required` + `managedBy:'setup'` → `setup` provisions it via mise on a
    // new machine and doctor/enroll report it when missing, instead of leaving it to be discovered at delivery.
    // Pinned version (like node/pnpm/gh): 1.8.2 is the one verified working on server-minion-1.
    name: 'jq',
    bin: 'jq',
    versionCmd: 'jq --version',
    required: true,
    managedBy: 'setup',
    install: {cmd: 'mise use -g jq@1.8.2', sudo: false},
  },
]

export interface ShellResult {
  code: number
  stdout: string
  stderr: string
}

export type ShellExec = (script: string, env?: NodeJS.ProcessEnv) => ShellResult

// Security NB: `script` ALWAYS comes from controlled constants in this file (DEPS: official vendor
// commands, hardcoded `dep.bin`/`dep.versionCmd`) — no interpolated user input.
// The shell is needed for the pipes of the official installers (`curl … | sh`) and for `command -v`.
// Optional `env`: defaults to the inherited environment; injected to probe in a service-equivalent environment.
export function defaultShellExec(script: string, env: NodeJS.ProcessEnv = process.env): ShellResult {
  const result = spawnSync('sh', ['-c', script], {encoding: 'utf8', env})
  return {code: result.status ?? 1, stdout: result.stdout ?? '', stderr: result.stderr ?? ''}
}

// GitHub authentication: `gh auth status` exits 0 only if the CLI is present AND there is a valid session.
// Deliberately WITHOUT `--show-token`: we check only the outcome, never the secret (enrollment, CYAU-9).
export function githubAuthenticated(exec: ShellExec = defaultShellExec): boolean {
  return exec('gh auth status').code === 0
}

// CloseYourIt authentication: `cyi whoami` exits 0 only with a valid CLI token (device flow `cyi login`).
// It is the identity the agent self-assigns and comments tickets with. Only the outcome, we never print the output (CYAU-9).
export function cyiAuthenticated(exec: ShellExec = defaultShellExec): boolean {
  return exec('cyi whoami').code === 0
}

// Codex authentication: `codex login status` exits 0 only with a valid session (device flow `codex login`).
// As with gh/cyi we check only the outcome, we never print the output. Codex is an OPTIONAL runtime → a missing
// login is not blocking, but it must be reported (the Claude↔Codex cross review requires it).
export function codexAuthenticated(exec: ShellExec = defaultShellExec): boolean {
  return exec('codex login status').code === 0
}

// Claude authentication: `claude auth status` exits 0 only with a valid LOCAL session. Zero-cost (reads the
// machine credentials, does not call the model). The automator does NOT keep the token: it probes in the
// SERVICE-EQUIVALENT environment (without the shell's ephemeral Claude auth exports) so the outcome reflects what the
// daemon will really have — durable auth via `claude login` (HOME). Only the outcome, never the output.
export function claudeAuthenticated(exec: ShellExec = defaultShellExec): boolean {
  return exec('claude auth status', serviceEnvWithoutEphemeralClaudeAuth()).code === 0
}

export interface ProbeResult {
  name: string
  bin: string
  present: boolean
  version: string | null
  required: boolean
}

export function probe(dep: Dep, exec: ShellExec = defaultShellExec): ProbeResult {
  const found = exec(`command -v ${dep.bin}`)
  const present = found.code === 0
  let version: string | null = null
  if (present) {
    const v = exec(dep.versionCmd)
    version = v.code === 0 ? v.stdout.trim().split('\n')[0] : null
  }
  return {name: dep.name, bin: dep.bin, present, version, required: dep.required}
}

export function probeAll(deps: Dep[] = DEPS, exec: ShellExec = defaultShellExec): ProbeResult[] {
  return deps.map((dep) => probe(dep, exec))
}

/** Asynchronous, bounded probe used by doctor/enroll: every command runs in a cleanable process group. */
export async function probeAsync(dep: Dep, options: ProcessProbeOptions = {}): Promise<ProbeResult> {
  const found = await runProcessProbe('sh', ['-c', `command -v ${dep.bin}`], options)
  const present = !found.timedOut && !found.error && found.code === 0
  if (!present) return {name: dep.name, bin: dep.bin, present: false, version: null, required: dep.required}

  const version = await runProcessProbe('sh', ['-c', dep.versionCmd], options)
  return {
    name: dep.name,
    bin: dep.bin,
    present: true,
    version: !version.timedOut && !version.error && version.code === 0 ? version.stdout.trim().split('\n')[0] || null : null,
    required: dep.required,
  }
}

/** Isolates all probes: a timeout/exception of one CLI does not prevent diagnosing the others. */
export async function probeAllAsync(deps: Dep[] = DEPS, options: ProcessProbeOptions = {}): Promise<ProbeResult[]> {
  const outcomes = await Promise.allSettled(deps.map((dep) => probeAsync(dep, options)))
  return outcomes.map((outcome, index) => outcome.status === 'fulfilled'
    ? outcome.value
    : {name: deps[index].name, bin: deps[index].bin, present: false, version: null, required: deps[index].required})
}

export async function githubAuthenticatedAsync(options: ProcessProbeOptions = {}): Promise<boolean> {
  const result = await runProcessProbe('gh', ['auth', 'status'], options)
  return !result.timedOut && !result.error && result.code === 0
}

export async function cyiAuthenticatedAsync(options: ProcessProbeOptions = {}): Promise<boolean> {
  const result = await runProcessProbe('cyi', ['whoami'], options)
  return !result.timedOut && !result.error && result.code === 0
}

export async function codexAuthenticatedAsync(options: ProcessProbeOptions = {}): Promise<boolean> {
  const result = await runProcessProbe('codex', ['login', 'status'], options)
  return !result.timedOut && !result.error && result.code === 0
}

export async function claudeAuthenticatedAsync(options: ProcessProbeOptions = {}): Promise<boolean> {
  // Probes in the service-equivalent environment (without the shell's ephemeral Claude auth credentials): avoids
  // the false ready when the systemd daemon will not inherit those variables. Override via options.env in tests.
  const result = await runProcessProbe('claude', ['auth', 'status'], {
    ...options,
    env: options.env ?? serviceEnvWithoutEphemeralClaudeAuth(),
  })
  return !result.timedOut && !result.error && result.code === 0
}

export type Outcome = 'already-present' | 'installed' | 'failed' | 'skipped'

export interface SetupResult {
  name: string
  outcome: Outcome
  detail?: string
}

export interface SetupOptions {
  dryRun?: boolean
  optional?: boolean // also install the optional deps (default: only required + managedBy setup)
}

/** Installs (idempotently) a single dependency on the supported Linux system. */
export function setupDep(dep: Dep, exec: ShellExec, opts: SetupOptions = {}): SetupResult {
  // already-present only if present AND usable (`--version` OK). Present but NOT usable
  // (version null: broken/incompatible binary) → it must be (re)installed, so the fix doctor
  // suggests ("automator setup") is really practicable for a runtime that is present but not working (CYAU-5).
  const status = probe(dep, exec)
  if (status.present && status.version !== null) return {name: dep.name, outcome: 'already-present'}

  if (dep.managedBy === 'bootstrap') {
    return {name: dep.name, outcome: 'skipped', detail: 'gestita da bin/bootstrap.sh (catena Node)'}
  }
  if (!dep.required && !opts.optional) {
    return {name: dep.name, outcome: 'skipped', detail: 'optional (usa --optional per installarla)'}
  }

  const spec = dep.install
  if (opts.dryRun) return {name: dep.name, outcome: 'skipped', detail: spec.cmd}

  const res = exec(spec.cmd)
  if (res.code !== 0) return {name: dep.name, outcome: 'failed', detail: res.stderr.trim().split('\n').pop() ?? ''}
  const installed = probe(dep, exec)
  return installed.present && installed.version !== null
    ? {name: dep.name, outcome: 'installed'}
    : {name: dep.name, outcome: 'failed', detail: 'installato ma non utilizzabile dal PATH'}
}
