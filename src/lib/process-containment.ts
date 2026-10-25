import {execFile} from 'node:child_process'
import {randomUUID} from 'node:crypto'
import * as fs from 'node:fs'
import * as path from 'node:path'

const MIN_SYSTEMD_VERSION = 254 // --expand-environment=no: an argv with `$` is not reinterpreted by the wrapper.
const SYSTEM_CALL_TIMEOUT_MS = 5000
const SYSTEM_CALL_MAX_BYTES = 4096

export interface ContainmentCommand {
  cmd: string
  args: string[]
  cwd: string
}

export interface StrongContainmentHandle {
  /** Non-PID identity of the container: prevents signalling a reused PID/PGID. */
  readonly identity: string
  readonly command: ContainmentCommand
  /** true if the unit existed and was signalled; false lets the executor fall back to the pre-unit wrapper. */
  signal(signal: 'SIGTERM' | 'SIGKILL'): boolean | Promise<boolean>
  /** true only when the kernel/service manager proves the cgroup contains no processes. */
  empty(): boolean | Promise<boolean>
}

export interface StrongContainmentBackend {
  available(): {available: boolean; detail?: string} | Promise<{available: boolean; detail?: string}>
  prepare(command: ContainmentCommand): StrongContainmentHandle | Promise<StrongContainmentHandle>
}

/** Single backend: systemd/cgroup v2. A platform other than Linux fails in its availability probe. */
export function createStrongContainmentBackend(
  platform: NodeJS.Platform = process.platform,
  systemd?: StrongContainmentBackend,
): StrongContainmentBackend {
  return systemd ?? createSystemdContainmentBackend({...defaultSystemdContainmentIo(), platform})
}

export interface SystemOutcome {status: number | null; stdout: string}

export interface SystemdContainmentIo {
  platform: NodeJS.Platform
  cgroupRoot: string
  systemdRun: string
  systemctl: string
  trustedExecutable(file: string): boolean
  exists(file: string): boolean
  readFile(file: string): string
  run(cmd: string, args: string[]): SystemOutcome | Promise<SystemOutcome>
  randomId(): string
}

function defaultTrustedExecutable(candidate: string): boolean {
  try {
    const canonical = fs.realpathSync(candidate)
    let cursor = canonical
    let executable = true
    while (true) {
      const metadata = fs.statSync(cursor)
      if (metadata.uid !== 0 || (metadata.mode & 0o022) !== 0) return false
      if (executable && (!metadata.isFile() || (metadata.mode & 0o111) === 0)) return false
      if (cursor === '/') return true
      cursor = path.dirname(cursor)
      executable = false
    }
  } catch {
    return false
  }
}

function defaultRun(cmd: string, args: string[]): Promise<SystemOutcome> {
  const uid = process.getuid?.()
  const runtimeDir = uid === undefined ? undefined : `/run/user/${uid}`
  return new Promise((resolve) => {
    execFile(cmd, args, {
      encoding: 'utf8',
      timeout: SYSTEM_CALL_TIMEOUT_MS,
      maxBuffer: SYSTEM_CALL_MAX_BYTES,
      killSignal: 'SIGKILL',
      env: {
        PATH: '/usr/bin:/bin',
        LANG: 'C',
        LC_ALL: 'C',
        ...(runtimeDir ? {
          XDG_RUNTIME_DIR: runtimeDir,
          DBUS_SESSION_BUS_ADDRESS: `unix:path=${runtimeDir}/bus`,
        } : {}),
      },
    }, (error, stdout) => {
      const status = error === null ? 0 : typeof error.code === 'number' ? error.code : null
      resolve({status, stdout})
    })
  })
}

export function defaultSystemdContainmentIo(): SystemdContainmentIo {
  return {
    platform: process.platform,
    cgroupRoot: '/sys/fs/cgroup',
    systemdRun: '/usr/bin/systemd-run',
    systemctl: '/usr/bin/systemctl',
    trustedExecutable: defaultTrustedExecutable,
    exists: fs.existsSync,
    readFile: (file) => fs.readFileSync(file, 'utf8'),
    run: defaultRun,
    randomId: () => randomUUID().replaceAll('-', ''),
  }
}

function parseSystemdVersion(stdout: string): number | null {
  const match = /^systemd\s+(\d+)\b/m.exec(stdout)
  if (!match) return null
  const version = Number(match[1])
  return Number.isSafeInteger(version) ? version : null
}

function parseShow(stdout: string): {loadState: string; controlGroup: string} | null {
  const values = new Map<string, string>()
  for (const line of stdout.split('\n')) {
    const separator = line.indexOf('=')
    if (separator > 0) values.set(line.slice(0, separator), line.slice(separator + 1))
  }
  const loadState = values.get('LoadState')
  const controlGroup = values.get('ControlGroup')
  return loadState === undefined || controlGroup === undefined ? null : {loadState, controlGroup}
}

function cgroupFile(root: string, controlGroup: string): string {
  if (!controlGroup.startsWith('/') || path.posix.normalize(controlGroup) !== controlGroup || controlGroup.includes('..')) {
    throw new Error('path cgroup non valido')
  }
  const canonicalRoot = path.resolve(root)
  const candidate = path.resolve(canonicalRoot, `.${controlGroup}`, 'cgroup.procs')
  if (!candidate.startsWith(`${canonicalRoot}${path.sep}`)) throw new Error('path cgroup fuori root')
  return candidate
}

/**
 * Strong Linux backend: `systemd-run --scope` places the command and its descendants in a cgroup v2, independent of
 * session/PGID. Termination uses the unit's random identity and `systemctl kill --kill-whom=cgroup`; the
 * conclusion is approved only after an empty `cgroup.procs` (or a unit already collected/not-found).
 */
export function createSystemdContainmentBackend(
  io: SystemdContainmentIo = defaultSystemdContainmentIo(),
): StrongContainmentBackend {
  let availabilityProbe: Promise<{available: boolean; detail?: string}> | undefined
  const detectAvailability = async (): Promise<{available: boolean; detail?: string}> => {
      if (io.platform !== 'linux') return {available: false, detail: 'strong containment disponibile solo su Linux/systemd'}
      if (!io.exists(path.join(io.cgroupRoot, 'cgroup.controllers'))) {
        return {available: false, detail: 'cgroup v2 non disponibile'}
      }
      if (!io.trustedExecutable(io.systemdRun) || !io.trustedExecutable(io.systemctl)) {
        return {available: false, detail: 'launcher systemd non fidati o assenti'}
      }
      const version = await io.run(io.systemdRun, ['--version'])
      const parsed = version.status === 0 ? parseSystemdVersion(version.stdout) : null
      if (parsed === null || parsed < MIN_SYSTEMD_VERSION) {
        return {available: false, detail: `systemd >= ${MIN_SYSTEMD_VERSION} richiesto`}
      }
      const manager = await io.run(io.systemctl, ['--user', 'show', '--property=Version', '--value'])
      if (manager.status !== 0 || manager.stdout.trim() === '') {
        return {available: false, detail: 'user manager systemd non raggiungibile'}
      }
      return {available: true}
  }
  const backend: StrongContainmentBackend = {
    available() {
      availabilityProbe ??= detectAvailability()
      return availabilityProbe
    },

    async prepare(command) {
      const availability = await backend.available()
      if (!availability.available) throw new Error(availability.detail ?? 'strong containment non disponibile')
      const id = io.randomId()
      if (!/^[a-f0-9]{32}$/.test(id)) throw new Error('identita containment non valida')
      const unit = `automator-action-${id}.scope`
      let observedControlGroup: string | null = null

      const show = async (): Promise<{loadState: string; controlGroup: string}> => {
        const outcome = await io.run(io.systemctl, ['--user', 'show', '--property=LoadState', '--property=ControlGroup', unit])
        if (outcome.status !== 0) throw new Error('sonda systemd fallita')
        const parsed = parseShow(outcome.stdout)
        if (!parsed) throw new Error('risposta systemd non valida')
        return parsed
      }

      const stop = async (): Promise<boolean> => {
        const stopped = await io.run(io.systemctl, ['--user', 'stop', unit])
        if (stopped.status === 0) return true
        const state = await show()
        if (state.loadState === 'not-found') return false
        throw new Error(`stop del cgroup fallito (status=${stopped.status ?? 'timeout'})`)
      }

      return {
        identity: unit,
        command: {
          cmd: io.systemdRun,
          cwd: command.cwd,
          args: [
            '--user', '--scope', '--quiet', '--collect', '--expand-environment=no', `--unit=${unit}`,
            '--property=KillMode=control-group', '--property=SendSIGKILL=yes',
            '--property=TimeoutStopSec=1ms', '--', command.cmd, ...command.args,
          ],
        },
        async signal(signal) {
          const outcome = await io.run(io.systemctl, ['--user', 'kill', '--kill-whom=cgroup', `--signal=${signal}`, unit])
          if (outcome.status !== 0) {
            // Some user managers reject `kill` on transient scopes while allowing their stop. After ruling out
            // an already collected unit, delegate the cleanup to the KillMode=control-group lifecycle.
            const state = await show()
            if (state.loadState === 'not-found') return false
            return stop()
          }
          if (signal === 'SIGKILL') {
            // `kill` delivers SIGKILL to the current members right away; `stop` also applies the lifecycle policy
            // KillMode=control-group and prevents concurrent forks from leaving the scope active.
            await stop()
          }
          return true
        },
        async empty() {
          const state = await show()
          if (state.loadState === 'not-found') return true
          if (state.loadState !== 'loaded' || state.controlGroup === '') throw new Error('identity cgroup non verificabile')
          if (observedControlGroup !== null && observedControlGroup !== state.controlGroup) {
            throw new Error('identity cgroup cambiata durante cleanup')
          }
          observedControlGroup = state.controlGroup
          const procs = cgroupFile(io.cgroupRoot, state.controlGroup)
          try {
            return io.readFile(procs).trim() === ''
          } catch {
            // Collection may remove the cgroup after `show`: reconfirm exclusively as not-found.
            const after = await show()
            if (after.loadState === 'not-found') return true
            throw new Error('cgroup.procs non verificabile')
          }
        },
      }
    },
  }
  return backend
}
