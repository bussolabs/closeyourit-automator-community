import {spawn as nodeSpawn, spawnSync, type ChildProcess} from 'node:child_process'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import {isManagedSecretEnv} from './env-capabilities'
import {SANDBOX_DENIED_READ_PATHS} from './guardrails'
import {acquire, release} from './lock'
import {configDir, dataDir, stateDir} from './paths'
import {
  createStrongContainmentBackend,
  type ContainmentLimits,
  type StrongContainmentBackend,
  type StrongContainmentHandle,
} from './process-containment'
import {type EmulatorTestConfig} from './quality-gate'
import {redactSecrets} from './secret-redaction'

// CYAU-295 — the test on an emulated phone. The agent session is confined and cannot reach the virtualization, so the
// MACHINE runs the test after it: build the test version (confined), boot a headless emulator, install and launch the
// app, read the logs for crashes, take a screenshot, and shut everything down — on success, error, timeout or abort.
//
// Three outcomes, and the difference between them is the point:
//  - `passed`      the app stayed open for `observe` seconds with no crash in the logs, and the screenshot was taken;
//  - `crashed`     the build failed, or the app closed, or the logs carry its crash: the work goes back to the agent;
//  - `unavailable` the machine could not run the test (no KVM, no SDK, no AVD, a slow boot, a missing build tool, an
//                  artifact not where the base branch says).
//                  Never a crash: an emulator that boots slowly must not look like a broken app. With `retry` the
//                  machine CAN run it, just not now (the phone is busy, the screenshot did not come): the delivery
//                  waits for the next round instead of skipping an optional test.
//
// Every log line that leaves this module is redacted and clipped. The real processes live behind `EmulatorIo`, so the
// orchestration is testable without an emulator.

/** The single emulator of the machine listens here; the lock guarantees nobody else uses it at the same time. */
export const EMULATOR_PORT = 5584
export const EMULATOR_SERIAL = `emulator-${EMULATOR_PORT}`
/** System bubblewrap, the same binary the write-confinement probe attests. */
export const BWRAP = '/usr/bin/bwrap'

const INSTALL_TIMEOUT_MS = 300_000
const SHORT_TIMEOUT_MS = 30_000
const BOOT_POLL_MS = 3_000
/** How long a test waits for the phone another ticket of the machine is using, before asking for the next round. */
const LOCK_WAIT_MS = 45 * 60_000
const LOCK_POLL_MS = 15_000
const SCREENSHOT_ATTEMPTS = 2
const MAX_EVIDENCE_LINES = 20
const MAX_LINE_CHARS = 300
const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])
/** Exit codes of a shell that did not find or could not run the build tool: the machine, not the change. */
const MISSING_TOOL_EXIT = new Set([126, 127])

export interface EmulatorRunOptions {
  cwd?: string
  env?: NodeJS.ProcessEnv
  timeoutMs: number
  signal?: AbortSignal
}

export interface EmulatorRunOutcome {
  code: number | null
  stdout: Buffer
  /** Tail of stderr, bounded. */
  stderr: string
  timedOut: boolean
}

export interface BackgroundProcess {
  /** SIGTERM to the whole process group, then SIGKILL after a grace: resolves when the group is gone or killed. */
  stop(): Promise<void>
}

export interface EmulatorTools {
  emulator: string
  adb: string
}

/** What the build must not see: directories become an empty tmpfs, files and sockets `/dev/null`. */
export interface HiddenPaths {
  dirs: string[]
  files: string[]
}

export interface EmulatorIo {
  run(cmd: string, args: string[], opts: EmulatorRunOptions): Promise<EmulatorRunOutcome>
  /**
   * Runs `cmd` in the strong containment of the sessions (systemd scope, process-containment.ts) with memory and CPU
   * limits: the timeout and the abort stop the whole cgroup.
   */
  runContained(cmd: string, args: string[], opts: EmulatorRunOptions): Promise<EmulatorRunOutcome>
  containmentAvailable(): Promise<{available: boolean; detail?: string}>
  start(cmd: string, args: string[], env: NodeJS.ProcessEnv): BackgroundProcess
  sleep(ms: number, signal?: AbortSignal): Promise<void>
  now(): number
  /** true when /dev/kvm can be opened for reading and writing. */
  kvmUsable(): boolean
  /** Resolves the Android tools from ANDROID_SDK_ROOT / ANDROID_HOME, then the PATH. */
  resolveTools(env: NodeJS.ProcessEnv): Partial<EmulatorTools>
  bwrapAvailable(): boolean
  /** The credential and state paths of this machine the build must not read. */
  hiddenPaths(): HiddenPaths
  /** The canonical path of `relative` when it is a regular file INSIDE `root`; otherwise null. */
  fileInside(root: string, relative: string): string | null
  /** A fresh scratch folder for the build of `ticket` (HOME-like caches, temp files). */
  makeScratch(ticket: string): string
  removeScratch(dir: string): void
  /** One emulator per machine. `false` when another test holds it. */
  acquireLock(): boolean
  releaseLock(): void
}

export interface EmulatorTestInput {
  config: EmulatorTestConfig
  /** The ticket worktree: the build runs here and may write only here (and in its scratch folder). */
  cwd: string
  ticket: string
  env?: NodeJS.ProcessEnv
  signal?: AbortSignal
}

export type EmulatorTestReport =
  | {status: 'passed'; summary: string; screenshot: Buffer}
  | {status: 'crashed'; summary: string; evidence: string[]; screenshot: Buffer | null}
  | {status: 'unavailable'; summary: string; retry?: true}

function clipLine(line: string): string {
  const flat = redactSecrets(line).replace(/\s+/g, ' ').trim()
  return flat.length > MAX_LINE_CHARS ? `${flat.slice(0, MAX_LINE_CHARS - 1)}…` : flat
}

function tailLines(text: string, lines = 5): string[] {
  return text.split(/\r?\n/).map((line) => line.trim()).filter(Boolean).slice(-lines).map(clipLine)
}

function tail(text: string, lines = 5): string {
  return tailLines(text, lines).join(' | ')
}

/**
 * The crash evidence of `appId` in a logcat dump, redacted. Empty when the app did not crash. Only lines that name the
 * app decide: a system process dying in the same minutes is not this app's crash.
 */
export function detectCrash(logcat: string, appId: string): string[] {
  const lines = logcat.split(/\r?\n/)
  const names = (line: string): boolean => line.includes(appId)
  const crashed = lines.some((line) =>
    (line.includes('AndroidRuntime') && line.includes('Process:') && names(line)) ||
    (line.includes('ANR in') && names(line)) ||
    (line.includes('Fatal signal') && names(line)))
  if (!crashed) return []
  return lines
    .filter((line) => /AndroidRuntime|ANR in|Fatal signal|FATAL EXCEPTION/.test(line))
    .slice(0, MAX_EVIDENCE_LINES)
    .map(clipLine)
}

/** true when the buffer starts like a PNG: anything else from `screencap` is an error message, not a picture. */
export function isPng(data: Buffer): boolean {
  return data.length > PNG_SIGNATURE.length && data.subarray(0, PNG_SIGNATURE.length).equals(PNG_SIGNATURE)
}

export interface BuildConfinement {
  worktree: string
  scratch: string
  script: string
  hidden: HiddenPaths
  network: boolean
}

/**
 * The confinement of the build, the same perimeter as the sessions' sandbox (guardrails.ts): the filesystem read-only,
 * the credential and state paths hidden, writable only the ticket worktree and its scratch folder, no network unless
 * the base branch opens it, its own pid namespace (killing bwrap ends every descendant) and death with the parent.
 * Order is the substance: the hiding mounts come after the read-only root and before the writable binds, so a hidden
 * ancestor of the worktree (the managed data folder) is masked and the worktree alone is reopened inside it.
 */
export function composeBuildArgs(confinement: BuildConfinement): string[] {
  const {worktree, scratch, script, hidden, network} = confinement
  for (const target of [worktree, scratch, ...hidden.dirs, ...hidden.files]) {
    if (!path.isAbsolute(target)) throw new Error('build confinement: non-absolute path')
  }
  return [
    '--ro-bind', '/', '/',
    // A fresh /dev: the device nodes of the read-only root cannot be opened from inside the cage (CYAU-329), so
    // without it `2>/dev/null` fails and nothing reads /dev/urandom.
    '--dev', '/dev',
    '--unshare-pid',
    '--proc', '/proc',
    ...(network ? [] : ['--unshare-net']),
    '--die-with-parent',
    ...hidden.dirs.flatMap((dir) => ['--tmpfs', dir]),
    ...hidden.files.flatMap((file) => ['--ro-bind', '/dev/null', file]),
    '--bind', worktree, worktree,
    '--bind', scratch, scratch,
    '--chdir', worktree,
    '--', 'sh', '-c', script,
  ]
}

/**
 * The paths the build must not read, among `candidates` that exist: the sessions' denied list (credentials, agent
 * homes, escape sockets) plus the operator's keys and the automator's own state, config and managed checkouts. A path
 * inside another hidden directory is already masked and is dropped.
 */
export function selectHiddenPaths(candidates: string[], kind: (target: string) => 'dir' | 'file' | null): HiddenPaths {
  const present = [...new Set(candidates.map((candidate) => path.resolve(candidate)))]
    .map((target) => ({target, type: kind(target)}))
    .filter((entry): entry is {target: string; type: 'dir' | 'file'} => entry.type !== null)
  const dirs = present.filter((entry) => entry.type === 'dir').map((entry) => entry.target)
  const masked = (target: string): boolean => dirs.some((dir) => dir !== target && target.startsWith(`${dir}${path.sep}`))
  return {
    dirs: dirs.filter((dir) => !masked(dir)).sort(),
    files: present.filter((entry) => entry.type === 'file' && !masked(entry.target)).map((entry) => entry.target).sort(),
  }
}

/** The candidate hidden paths of a machine whose home is `home`. */
export function hiddenPathCandidates(home: string): string[] {
  const expand = (entry: string): string => (entry.startsWith('~/') ? path.join(home, entry.slice(2)) : entry)
  return [
    ...SANDBOX_DENIED_READ_PATHS.map(expand),
    ...['.ssh', '.gnupg', '.config', '.aws', '.docker', '.kube', '.netrc', '.git-credentials', '.npmrc', '.pypirc']
      .map((entry) => path.join(home, entry)),
    stateDir(),
    configDir(),
    dataDir(),
  ]
}

/** Memory and CPU of the build: half of the machine, so the daemon and the other tickets keep running. */
export function buildLimits(cpus: number): ContainmentLimits {
  return {memoryMax: '50%', cpuQuota: `${Math.max(1, Math.floor(cpus / 2)) * 100}%`}
}

/** The build environment: no managed credential, caches and temp files redirected to the scratch folder. */
export function buildEnvironment(inherited: NodeJS.ProcessEnv, scratch: string): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {}
  for (const [key, value] of Object.entries(inherited)) if (!isManagedSecretEnv(key)) env[key] = value
  return {
    ...env,
    TMPDIR: path.join(scratch, 'tmp'),
    XDG_CACHE_HOME: path.join(scratch, 'cache'),
    GRADLE_USER_HOME: path.join(scratch, 'gradle'),
    PUB_CACHE: path.join(scratch, 'pub-cache'),
    ANDROID_USER_HOME: path.join(scratch, 'android'),
    FLUTTER_SUPPRESS_ANALYTICS: 'true',
    CI: 'true',
  }
}

/** The emulator argv: headless, no audio, no snapshot written back, changes discarded at shutdown. */
export function emulatorArgs(avd: string): string[] {
  return [
    '-avd', avd, '-port', String(EMULATOR_PORT),
    '-no-window', '-no-audio', '-no-boot-anim', '-no-snapshot', '-read-only',
    '-gpu', 'swiftshader_indirect',
  ]
}

function withoutSecrets(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const clean: NodeJS.ProcessEnv = {}
  for (const [key, value] of Object.entries(env)) if (!isManagedSecretEnv(key)) clean[key] = value
  return clean
}

class Unavailable extends Error {}

/** Runs the whole test. It never throws: an unexpected error is `unavailable` with its reason. */
export async function runEmulatorTest(input: EmulatorTestInput, io: EmulatorIo = defaultEmulatorIo()): Promise<EmulatorTestReport> {
  const {config, signal} = input
  const env = input.env ?? process.env
  const unavailable = (summary: string): EmulatorTestReport => ({status: 'unavailable', summary: `Prova su telefono non disponibile: ${summary}.`})
  const retryLater = (summary: string): EmulatorTestReport => ({status: 'unavailable', summary: `Prova su telefono rimandata: ${summary}.`, retry: true})
  const crashed = (summary: string, evidence: string[], screenshot: Buffer | null): EmulatorTestReport =>
    ({status: 'crashed', summary: `Prova su telefono fallita: ${summary}.`, evidence, screenshot})

  if (!io.kvmUsable()) return unavailable('la virtualizzazione (/dev/kvm) non è utilizzabile su questa macchina')
  const tools = io.resolveTools(env)
  if (!tools.emulator) return unavailable('emulatore Android non trovato (ANDROID_SDK_ROOT/emulator)')
  if (!tools.adb) return unavailable('adb non trovato (ANDROID_SDK_ROOT/platform-tools)')
  if (!io.bwrapAvailable()) return unavailable('bubblewrap non disponibile: la costruzione non può girare confinata')
  const containment = await io.containmentAvailable()
  if (!containment.available) return unavailable(`contenimento delle sessioni non disponibile (${containment.detail ?? 'motivo non disponibile'})`)

  // One emulator per machine: a phone busy with another ticket is waited for, never a reason to skip the test.
  let locked = io.acquireLock()
  const lockDeadline = io.now() + LOCK_WAIT_MS
  while (!locked && !signal?.aborted && io.now() < lockDeadline) {
    await io.sleep(LOCK_POLL_MS, signal)
    locked = io.acquireLock()
  }
  if (!locked) return retryLater('il telefono simulato di questa macchina è occupato da un\'altra prova')

  const adb = tools.adb
  const adbRun = (args: string[], timeoutMs = SHORT_TIMEOUT_MS) =>
    io.run(adb, ['-s', EMULATOR_SERIAL, ...args], {env: withoutSecrets(env), timeoutMs, signal})
  const checkAbort = (): void => {
    if (signal?.aborted) throw new Unavailable('prova annullata')
  }
  let scratch: string | null = null
  let emulator: BackgroundProcess | null = null
  try {
    scratch = io.makeScratch(input.ticket)
    const buildArgs = composeBuildArgs({
      worktree: input.cwd, scratch, script: config.build, hidden: io.hiddenPaths(), network: config.network,
    })
    const build = await io.runContained(BWRAP, buildArgs, {
      cwd: input.cwd, env: buildEnvironment(env, scratch), timeoutMs: config.build_timeout * 1000, signal,
    })
    checkAbort()
    if (build.timedOut) return unavailable(`la costruzione ha superato ${config.build_timeout} s`)
    if (build.code === null) return unavailable(`la costruzione è stata interrotta prima di finire: ${tail(build.stderr)}`)
    if (MISSING_TOOL_EXIT.has(build.code)) return unavailable(`il comando di costruzione non è eseguibile su questa macchina (exit ${build.code}): ${tail(build.stderr)}`)
    if (build.code !== 0) {
      // The build runs the change itself: a red build is the change's to fix, like a red check.
      const offline = config.network ? '' : ' (la costruzione gira senza rete: se deve scaricare dipendenze, il ramo principale deve dichiarare network: true)'
      return crashed(`la costruzione dell'app non è riuscita (exit ${build.code})${offline}`, tailLines(build.stderr, 10), null)
    }
    const artifact = io.fileInside(input.cwd, config.artifact)
    if (!artifact) return unavailable(`file prodotto non trovato: ${config.artifact}`)

    // A leftover emulator of a crashed run would hold the port: ask it to go first (best-effort).
    await adbRun(['emu', 'kill']).catch(() => undefined)
    emulator = io.start(tools.emulator, emulatorArgs(config.avd), withoutSecrets(env))

    const deadline = io.now() + config.boot_timeout * 1000
    const waited = await adbRun(['wait-for-device'], config.boot_timeout * 1000)
    checkAbort()
    if (waited.timedOut || waited.code !== 0) return unavailable(`il telefono simulato non si è avviato in ${config.boot_timeout} s`)
    let booted = false
    while (io.now() < deadline) {
      const prop = await adbRun(['shell', 'getprop', 'sys.boot_completed'])
      checkAbort()
      if (prop.code === 0 && prop.stdout.toString('utf8').trim() === '1') {
        booted = true
        break
      }
      await io.sleep(BOOT_POLL_MS, signal)
    }
    if (!booted) return unavailable(`il telefono simulato non ha completato l'avvio in ${config.boot_timeout} s`)

    const installed = await adbRun(['install', '-r', '-g', artifact], INSTALL_TIMEOUT_MS)
    checkAbort()
    if (installed.timedOut) return unavailable('installazione dell\'app oltre il tempo massimo')
    if (installed.code !== 0 || !installed.stdout.toString('utf8').includes('Success')) {
      return crashed(`l'app non si installa: ${tail(`${installed.stdout.toString('utf8')}\n${installed.stderr}`)}`, [], null)
    }

    await adbRun(['logcat', '-c'])
    const launched = await adbRun(['shell', 'monkey', '-p', config.app_id, '-c', 'android.intent.category.LAUNCHER', '1'])
    checkAbort()
    const launchOut = launched.stdout.toString('utf8')
    if (launched.code !== 0 || /No activities found|monkey aborted/i.test(launchOut)) {
      return crashed(`l'app non si apre: ${tail(`${launchOut}\n${launched.stderr}`)}`, [], null)
    }

    await io.sleep(config.observe * 1000, signal)
    checkAbort()
    const logs = await adbRun(['logcat', '-d', '-b', 'main,system,crash'])
    const running = await adbRun(['shell', 'pidof', config.app_id])
    let screenshot: Buffer | null = null
    for (let attempt = 0; attempt < SCREENSHOT_ATTEMPTS && !screenshot; attempt++) {
      const shot = await adbRun(['exec-out', 'screencap', '-p'])
      if (shot.code === 0 && isPng(shot.stdout)) screenshot = shot.stdout
    }

    const evidence = detectCrash(logs.stdout.toString('utf8'), config.app_id)
    const alive = running.code === 0 && running.stdout.toString('utf8').trim() !== ''
    if (evidence.length > 0) return crashed(`l'app ${config.app_id} si è chiusa con un errore dopo l'avvio`, evidence, screenshot)
    if (!alive) return crashed(`l'app ${config.app_id} non è più in esecuzione dopo ${config.observe} s`, [], screenshot)
    // The picture is part of the proof: without it the ticket would read "tested" with nothing to look at.
    if (!screenshot) return retryLater(`l'app ${config.app_id} è rimasta aperta ma la foto dello schermo non è riuscita`)
    return {
      status: 'passed',
      summary: `Prova su telefono superata: l'app ${config.app_id} è rimasta aperta ${config.observe} s senza chiusure.`,
      screenshot,
    }
  } catch (error) {
    if (error instanceof Unavailable) return unavailable(error.message)
    return unavailable(`errore imprevisto (${clipLine(error instanceof Error ? error.message : String(error))})`)
  } finally {
    // Shutdown is guaranteed on every exit: success, crash, unavailable, timeout, abort, exception.
    if (emulator) {
      await io.run(adb, ['-s', EMULATOR_SERIAL, 'emu', 'kill'], {env: withoutSecrets(env), timeoutMs: SHORT_TIMEOUT_MS}).catch(() => undefined)
      await emulator.stop().catch(() => undefined)
    }
    if (scratch) {
      try {
        io.removeScratch(scratch)
      } catch {
        // a leftover cache folder is not a reason to change the outcome
      }
    }
    io.releaseLock()
  }
}

// ── Ticket evidence (screenshot + comment) ──────────────────────────────────────────────────────────────────

export interface EmulatorEvidenceInput {
  project: string
  ticket: string
  /** The commit the test ran on: it names the screenshot, so the same picture is never attached twice. */
  headSha: string
  /** One short sentence for the ticket. */
  comment: string
  screenshot: Buffer | null
}

export interface EmulatorEvidenceCommand {
  status: number | null
  stdout: string
  stderr: string
}

export type EmulatorEvidenceRunner = (cmd: string, args: string[], timeoutMs: number) => EmulatorEvidenceCommand

/** The attachment name: one per commit. */
export function screenshotName(headSha: string): string {
  const safe = headSha.replace(/[^0-9A-Za-z]/g, '').slice(0, 12) || 'head'
  return `emulatore-${safe}.png`
}

export function defaultEvidenceRunner(cmd: string, args: string[], timeoutMs: number): EmulatorEvidenceCommand {
  const res = spawnSync(cmd, args, {encoding: 'utf8', timeout: timeoutMs, killSignal: 'SIGTERM'})
  const stderr = res.error ? `${res.error.message}\n${res.stderr ?? ''}`.trim() : res.stderr ?? ''
  return {status: res.status, stdout: res.stdout ?? '', stderr}
}

/**
 * Attaches the screenshot and writes the outcome on the ticket with `cyi`. Throws when either fails: the caller stops
 * the delivery and the next round retries. Idempotent per commit: a picture already attached (same name) is not
 * uploaded again, and a comment already naming it is not written again.
 */
export function publishEmulatorEvidence(
  input: EmulatorEvidenceInput,
  run: EmulatorEvidenceRunner = defaultEvidenceRunner,
  tempDir: () => string = () => fs.mkdtempSync(path.join(os.tmpdir(), 'automator-emulator-')),
): void {
  const fail = (what: string, outcome: EmulatorEvidenceCommand): never => {
    const detail = clipLine(outcome.stderr.trim() || outcome.stdout.trim() || `exit ${outcome.status}`)
    throw new Error(`${what} non riuscito: ${detail}`)
  }
  const name = screenshotName(input.headSha)
  const body = input.screenshot ? `${input.comment} Foto dello schermo: ${name}` : input.comment

  if (input.screenshot) {
    const listed = run('cyi', ['tickets', 'attachments', input.ticket, '-p', input.project, '--json'], 30_000)
    if (listed.status !== 0) fail('elenco allegati del ticket', listed)
    if (!listed.stdout.includes(name)) {
      const dir = tempDir()
      try {
        const file = path.join(dir, name)
        fs.writeFileSync(file, input.screenshot, {mode: 0o600})
        const attached = run('cyi', ['tickets', 'attach', input.ticket, '-p', input.project, '--file', file], 120_000)
        if (attached.status !== 0) fail('caricamento della foto dello schermo', attached)
      } finally {
        fs.rmSync(dir, {recursive: true, force: true})
      }
    }
  }

  const comments = run('cyi', ['tickets', 'comments', input.ticket, '-p', input.project, '--json'], 30_000)
  if (comments.status !== 0) fail('lettura dei commenti del ticket', comments)
  if (input.screenshot && comments.stdout.includes(name)) return
  const commented = run('cyi', ['tickets', 'comment', input.ticket, '-p', input.project, '--body', redactSecrets(body)], 30_000)
  if (commented.status !== 0) fail('commento sul ticket', commented)
}

// ── Real IO ──────────────────────────────────────────────────────────────────────────────────────────────

const DEFAULT_KILL_GRACE_MS = 10_000
const MAX_STDOUT_BYTES = 32 * 1024 * 1024
const MAX_STDERR_CHARS = 64 * 1024

export type SpawnProcess = (cmd: string, args: string[], options: {cwd?: string; env?: NodeJS.ProcessEnv; stdio: 'ignore' | ['ignore', 'pipe', 'pipe']; detached: true}) => ChildProcess
export type KillGroup = (pid: number | undefined, signal: NodeJS.Signals) => void

function killGroup(pid: number | undefined, signal: NodeJS.Signals): void {
  if (typeof pid !== 'number') return
  try {
    process.kill(-pid, signal)
  } catch {
    // group already gone
  }
}

function executable(file: string): boolean {
  try {
    fs.accessSync(file, fs.constants.X_OK)
    return fs.statSync(file).isFile()
  } catch {
    return false
  }
}

function onPath(name: string, env: NodeJS.ProcessEnv): string | undefined {
  for (const dir of (env.PATH ?? '').split(path.delimiter)) {
    if (!dir) continue
    const candidate = path.join(dir, name)
    if (executable(candidate)) return candidate
  }
  return undefined
}

/** Resolves `emulator` and `adb` the way the Android SDK lays them out, then the PATH. Pure on its inputs. */
export function resolveAndroidTools(env: NodeJS.ProcessEnv, isExecutable: (file: string) => boolean = executable): Partial<EmulatorTools> {
  const roots = [env.ANDROID_SDK_ROOT, env.ANDROID_HOME].filter((root): root is string => Boolean(root && root.trim()))
  const fromSdk = (relative: string): string | undefined => {
    for (const root of roots) {
      const candidate = path.join(root, relative)
      if (isExecutable(candidate)) return candidate
    }
    return undefined
  }
  return {
    emulator: fromSdk(path.join('emulator', 'emulator')) ?? onPath('emulator', env),
    adb: fromSdk(path.join('platform-tools', 'adb')) ?? onPath('adb', env),
  }
}

interface ProcessLayer {
  spawn: SpawnProcess
  kill: KillGroup
  killGraceMs: number
}

/**
 * Runs one bounded command in its own process group: the timeout and the abort end the whole tree. `terminate`, when
 * given, is the stronger stop of a contained command (the whole cgroup), called with the group signals.
 */
function runBounded(cmd: string, args: string[], opts: EmulatorRunOptions, procs: ProcessLayer, terminate?: () => void): Promise<EmulatorRunOutcome> {
  return new Promise((resolve) => {
    const chunks: Buffer[] = []
    let size = 0
    let stderr = ''
    let timedOut = false
    let settled = false
    const child = procs.spawn(cmd, args, {cwd: opts.cwd, env: opts.env, stdio: ['ignore', 'pipe', 'pipe'], detached: true})
    const stop = (): void => {
      procs.kill(child.pid, 'SIGTERM')
      terminate?.()
      setTimeout(() => procs.kill(child.pid, 'SIGKILL'), procs.killGraceMs).unref()
    }
    const onAbort = (): void => stop()
    const timer = setTimeout(() => {
      timedOut = true
      stop()
    }, opts.timeoutMs)
    const finish = (code: number | null): void => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      opts.signal?.removeEventListener('abort', onAbort)
      resolve({code, stdout: Buffer.concat(chunks), stderr, timedOut})
    }
    child.stdout?.on('data', (chunk: Buffer) => {
      if (size >= MAX_STDOUT_BYTES) return
      chunks.push(chunk)
      size += chunk.length
    })
    child.stderr?.on('data', (chunk: Buffer) => {
      stderr = `${stderr}${chunk.toString('utf8')}`.slice(-MAX_STDERR_CHARS)
    })
    child.on('error', (error) => {
      stderr = `${stderr}\n${error.message}`
      finish(null)
    })
    child.on('close', (code) => finish(code))
    if (opts.signal) {
      if (opts.signal.aborted) stop()
      else opts.signal.addEventListener('abort', onAbort, {once: true})
    }
  })
}

/** The bounded run inside a cgroup of the sessions' backend; the cgroup is emptied whatever the outcome. */
async function runInContainment(
  backend: StrongContainmentBackend, limits: ContainmentLimits, cmd: string, args: string[], opts: EmulatorRunOptions, procs: ProcessLayer,
): Promise<EmulatorRunOutcome> {
  const handle: StrongContainmentHandle = await backend.prepare({cmd, args, cwd: opts.cwd ?? process.cwd(), limits})
  const killCgroup = (): void => {
    Promise.resolve().then(() => handle.signal('SIGKILL')).catch(() => undefined)
  }
  const outcome = await runBounded(handle.command.cmd, handle.command.args, opts, procs, killCgroup)
  const empty = await Promise.resolve().then(() => handle.empty()).catch(() => false)
  if (!empty) await Promise.resolve().then(() => handle.signal('SIGKILL')).catch(() => undefined)
  return outcome
}

export function emulatorLockPath(): string {
  return path.join(stateDir(), 'emulator.lock')
}

function pathKind(target: string): 'dir' | 'file' | null {
  try {
    return fs.statSync(target).isDirectory() ? 'dir' : 'file'
  } catch {
    return null
  }
}

export interface DefaultEmulatorIoOptions {
  killGraceMs?: number
  spawn?: SpawnProcess
  kill?: KillGroup
  containment?: StrongContainmentBackend
  cpus?: number
}

export function defaultEmulatorIo(options: DefaultEmulatorIoOptions = {}): EmulatorIo {
  const lock = emulatorLockPath()
  const procs: ProcessLayer = {
    spawn: options.spawn ?? ((cmd, args, spawnOptions) => nodeSpawn(cmd, args, spawnOptions)),
    kill: options.kill ?? killGroup,
    killGraceMs: options.killGraceMs ?? DEFAULT_KILL_GRACE_MS,
  }
  let backend = options.containment
  const containment = (): StrongContainmentBackend => (backend ??= createStrongContainmentBackend())
  const limits = buildLimits(options.cpus ?? os.availableParallelism())
  return {
    run: (cmd, args, opts) => runBounded(cmd, args, opts, procs),
    runContained: (cmd, args, opts) => runInContainment(containment(), limits, cmd, args, opts, procs),
    containmentAvailable: async () => containment().available(),
    start(cmd, args, env) {
      const child = procs.spawn(cmd, args, {env, stdio: 'ignore', detached: true})
      child.on('error', () => undefined)
      const exited = new Promise<void>((resolve) => child.once('exit', () => resolve()))
      return {
        async stop() {
          if (child.exitCode !== null || child.signalCode !== null) return
          procs.kill(child.pid, 'SIGTERM')
          const grace = new Promise<'grace'>((resolve) => setTimeout(() => resolve('grace'), procs.killGraceMs).unref())
          if (await Promise.race([exited.then(() => 'exited' as const), grace]) === 'grace') {
            procs.kill(child.pid, 'SIGKILL')
            await Promise.race([exited, new Promise((resolve) => setTimeout(resolve, 2_000).unref())])
          }
        },
      }
    },
    sleep: (ms, signal) => new Promise<void>((resolve) => {
      if (signal?.aborted) {
        resolve()
        return
      }
      const timer = setTimeout(done, ms)
      function done(): void {
        clearTimeout(timer)
        signal?.removeEventListener('abort', done)
        resolve()
      }
      signal?.addEventListener('abort', done, {once: true})
    }),
    now: Date.now,
    kvmUsable() {
      try {
        fs.accessSync('/dev/kvm', fs.constants.R_OK | fs.constants.W_OK)
        return true
      } catch {
        return false
      }
    },
    resolveTools: (env) => resolveAndroidTools(env),
    bwrapAvailable: () => executable(BWRAP),
    hiddenPaths: () => selectHiddenPaths(hiddenPathCandidates(os.homedir()), pathKind),
    fileInside(root, relative) {
      try {
        const canonicalRoot = fs.realpathSync(root)
        const file = fs.realpathSync(path.resolve(canonicalRoot, relative))
        if (!file.startsWith(`${canonicalRoot}${path.sep}`)) return null
        return fs.statSync(file).isFile() ? file : null
      } catch {
        return null
      }
    },
    makeScratch(ticket) {
      const dir = path.join(stateDir(), 'emulator-build', ticket.replace(/[^A-Za-z0-9_-]/g, '_'))
      fs.rmSync(dir, {recursive: true, force: true})
      for (const sub of ['tmp', 'cache', 'gradle', 'pub-cache', 'android']) fs.mkdirSync(path.join(dir, sub), {recursive: true})
      return fs.realpathSync(dir)
    },
    removeScratch: (dir) => fs.rmSync(dir, {recursive: true, force: true}),
    acquireLock: () => acquire(lock, 'emulator-test'),
    releaseLock: () => release(lock),
  }
}

// ── Heartbeat ────────────────────────────────────────────────────────────────────────────────────────────

export type ToolVersionProbe = (bin: string, args: string[]) => string | null

/**
 * The version of a tool, asked once per binary: the heartbeat beats every few seconds and `emulator -version` is slow.
 * The key carries the binary's modification time, so an SDK update is seen at the next beat.
 */
export function createToolVersionCache(
  probe: ToolVersionProbe = toolVersion,
  stamp: (bin: string) => number = (bin) => fs.statSync(bin).mtimeMs,
): ToolVersionProbe {
  const cache = new Map<string, string | null>()
  return (bin, args) => {
    let key: string
    try {
      key = `${bin}\0${stamp(bin)}\0${args.join('\0')}`
    } catch {
      return null
    }
    if (!cache.has(key)) cache.set(key, probe(bin, args))
    return cache.get(key) ?? null
  }
}

const cachedToolVersion = createToolVersionCache()

/** CYAU-295 — what the heartbeat declares: the machine can run the phone test only with KVM, emulator and adb. */
export function emulatorToolRuntimes(
  env: NodeJS.ProcessEnv = process.env,
  io: Pick<EmulatorIo, 'kvmUsable' | 'resolveTools'> = defaultEmulatorIo(),
  version: ToolVersionProbe = cachedToolVersion,
): Array<{name: string; present: boolean; version: string | null; required: boolean}> {
  const tools = io.resolveTools(env)
  const emulatorPresent = Boolean(tools.emulator) && io.kvmUsable()
  return [
    {
      name: 'android-emulator',
      present: emulatorPresent,
      version: emulatorPresent && tools.emulator ? version(tools.emulator, ['-version']) : null,
      required: false,
    },
    {
      name: 'adb',
      present: Boolean(tools.adb),
      version: tools.adb ? version(tools.adb, ['version']) : null,
      required: false,
    },
  ]
}

export function toolVersion(bin: string, args: string[]): string | null {
  const res = spawnSync(bin, args, {encoding: 'utf8', timeout: 10_000})
  if (res.status !== 0) return null
  return (res.stdout ?? '').trim().split('\n')[0] || null
}
