import {execFile} from 'node:child_process'
import {randomUUID} from 'node:crypto'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import {z} from 'zod'
import type {ContainmentCommand, StrongContainmentBackend, StrongContainmentHandle, SystemOutcome} from './process-containment'

// CYAU-302 — strong containment in a disposable Incus VM, one per agent session.
//
// The host installer (deploy/ax41) writes a root-owned config; its presence is what opts a host in. The
// VM sees the worktree read-write and the toolchain/guardrail paths read-only AT THE SAME PATHS, so the argv the
// executor built runs unchanged. Secrets never ride an argv: the session environment is pushed into a 0600
// file that the guest launcher loads, deletes and execs from. The guest network reaches only the host egress
// proxy (slot bridge ACL, set up by the installer), which allows an explicit hostname list.
//
// Lifecycle: `prepare` reserves a slot, creates and starts the VM; `signal` stops it; `empty` deletes it and
// is true only once the instance is gone. A daemon crash leaves a lease that the installer's reaper honours.

export const VM_CONTAINMENT_CONFIG_PATH = '/etc/closeyourit-automator/vm-containment.json'
const NAME_PREFIX = 'ca-run-'
const MANAGED_KEY = 'user.automator.managed'
const SLOT_KEY = 'user.automator.slot'
const EXPIRES_KEY = 'user.automator.expires'
const READY_TIMEOUT_MS = 90_000
const READY_POLL_MS = 1000
const INCUS_CALL_TIMEOUT_MS = 120_000
const INCUS_CALL_MAX_BYTES = 4 * 1024 * 1024

const AbsolutePath = z.string().min(2).refine((value) => path.posix.isAbsolute(value) && path.posix.normalize(value) === value)
const IncusName = z.string().regex(/^[a-z][a-z0-9-]{0,62}$/)

const VmContainmentConfigSchema = z.object({
  incus: AbsolutePath,
  image: IncusName,
  pool: IncusName,
  networks: z.array(IncusName).min(1).max(16),
  /** One egress proxy per slot: the gateway of that slot's bridge. Same order as `networks`. */
  proxies: z.array(z.string().regex(/^http:\/\/[0-9.]+:\d{2,5}$/)).min(1).max(16),
  cpu: z.number().int().min(1).max(64),
  memory_gib: z.number().int().min(1).max(256),
  disk_gib: z.number().int().min(8).max(1024),
  lease_seconds: z.number().int().min(300).max(86_400),
  uid: z.number().int().min(1),
  gid: z.number().int().min(1),
  launcher: AbsolutePath,
  env_file: AbsolutePath,
  read_only_paths: z.array(AbsolutePath).max(32),
}).strict().refine((config) => config.proxies.length === config.networks.length, {message: 'one proxy per network'})

export type VmContainmentConfig = z.infer<typeof VmContainmentConfigSchema>

export function parseVmContainmentConfig(raw: unknown): VmContainmentConfig {
  return VmContainmentConfigSchema.parse(raw)
}

export interface VmContainmentIo {
  platform: NodeJS.Platform
  /** Home of the daemon user: the incus client reads its remote config from there. */
  home: string
  /** The trusted host config, or null when this host has not opted in. */
  readConfig(): VmContainmentConfig | null
  trustedExecutable(file: string): boolean
  /**
   * The shared git dir of a linked worktree (`<repo>/.git`), or null for a plain checkout. A ticket worktree
   * keeps its objects and refs there: without it `git commit` inside the VM fails.
   */
  gitCommonDir(cwd: string): string | null
  /** Runs the incus client with `args`; `input` goes to stdin. Never throws for a non-zero exit. */
  run(args: string[], input?: string): Promise<SystemOutcome>
  /** Serializes slot admission across the daemon's parallel sessions. */
  withLock<T>(fn: () => Promise<T>): Promise<T>
  randomId(): string
  now(): number
  sleep(ms: number): Promise<void>
}

/** `KEY=value\0…`: NUL cannot appear in an environment value, so any text round-trips. */
export function serializeGuestEnv(env: NodeJS.ProcessEnv): string {
  let out = ''
  for (const [key, value] of Object.entries(env)) {
    if (value === undefined) continue
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) throw new Error('invalid_environment_name')
    out += `${key}=${value}\0`
  }
  return out
}

interface Instance {name: string; config?: Record<string, string>}

function owned(item: Instance): boolean {
  return item.name.startsWith(NAME_PREFIX) && item.config?.[MANAGED_KEY] === 'true'
}

export function createVmContainmentBackend(io: VmContainmentIo = defaultVmContainmentIo()): StrongContainmentBackend {
  const incus = async (args: string[], input?: string): Promise<string> => {
    const outcome = await io.run(args, input)
    if (outcome.status !== 0) throw new Error(`incus_${args[0]}_failed`)
    return outcome.stdout
  }
  const instances = async (): Promise<Instance[]> => JSON.parse(await incus(['list', '--format=json'])) as Instance[]
  const find = async (name: string): Promise<Instance | undefined> => (await instances()).find((item) => item.name === name)

  const destroy = async (name: string): Promise<void> => {
    const current = await find(name)
    if (current === undefined) return
    if (!owned(current)) throw new Error('ownership_not_confirmed')
    await incus(['delete', name, '--force'])
    if (await find(name)) throw new Error('cleanup_not_confirmed')
  }

  const reserve = (config: VmContainmentConfig, name: string): Promise<number> => io.withLock(async () => {
    const used = new Set((await instances()).filter(owned).map((item) => item.config?.[SLOT_KEY]))
    const slot = config.networks.findIndex((_, index) => !used.has(String(index)))
    if (slot < 0) throw new Error('vm_capacity_reached')
    const expires = Math.floor(io.now() / 1000) + config.lease_seconds
    await incus([
      'init', config.image, name, '--vm', '--no-profiles', `--storage=${config.pool}`,
      '-c', `limits.cpu=${config.cpu}`, '-c', `limits.memory=${config.memory_gib}GiB`, '-c', 'boot.autostart=false',
      '-c', `${MANAGED_KEY}=true`, '-c', `${SLOT_KEY}=${slot}`, '-c', `${EXPIRES_KEY}=${expires}`,
      // virtiofsd shows the worktree through the VM idmap, where the daemon user does not exist (its files read as
      // nobody, writes fail): map exactly that uid/gid onto itself. The installer allows only this id.
      '-c', `raw.idmap=both ${process.getuid!()} ${process.getuid!()}`,
    ])
    // Bridge networks live in the default project, which the daemon's restricted project cannot name: the NIC
    // joins the slot bridge directly, and the bridge's own ACL and missing NAT still keep the guest in.
    await incus(['config', 'device', 'add', name, 'eth0', 'nic', 'nictype=bridged', `parent=${config.networks[slot]}`])
    return slot
  })

  const waitReady = async (name: string): Promise<void> => {
    const deadline = io.now() + READY_TIMEOUT_MS
    while ((await io.run(['exec', name, '--', '/bin/true'])).status !== 0) {
      if (io.now() >= deadline) throw new Error('guest_agent_unavailable')
      await io.sleep(READY_POLL_MS)
    }
  }

  let availabilityProbe: Promise<{available: boolean; detail?: string}> | undefined
  const detectAvailability = async (): Promise<{available: boolean; detail?: string}> => {
    if (io.platform !== 'linux') return {available: false, detail: 'vm containment is Linux only'}
    let config: VmContainmentConfig | null
    try {
      config = io.readConfig()
    } catch {
      return {available: false, detail: 'vm containment config unreadable or untrusted'}
    }
    if (config === null) return {available: false, detail: 'vm containment not installed on this host'}
    if (!io.trustedExecutable(config.incus)) return {available: false, detail: 'incus client missing or untrusted'}
    if ((await io.run(['info'])).status !== 0) return {available: false, detail: 'incus not reachable'}
    return {available: true}
  }

  const backend: StrongContainmentBackend = {
    available() {
      availabilityProbe ??= detectAvailability()
      return availabilityProbe
    },

    async prepare(command: ContainmentCommand): Promise<StrongContainmentHandle> {
      const availability = await backend.available()
      if (!availability.available) throw new Error(availability.detail ?? 'vm containment unavailable')
      const config = io.readConfig()
      if (config === null) throw new Error('vm containment not installed on this host')
      const id = io.randomId()
      if (!/^[a-f0-9]{32}$/.test(id)) throw new Error('invalid containment identity')
      const name = `${NAME_PREFIX}${id}`
      // Validated before a VM exists: a bad variable name must not cost a boot.
      serializeGuestEnv(command.env ?? {})

      const slot = await reserve(config, name)
      try {
        // Proxy variables come last: the session cannot route around the egress allowlist.
        const proxy = config.proxies[slot]
        const guestEnv = serializeGuestEnv({
          ...command.env,
          HTTPS_PROXY: proxy, HTTP_PROXY: proxy, https_proxy: proxy, http_proxy: proxy,
          NO_PROXY: 'localhost,127.0.0.1', no_proxy: 'localhost,127.0.0.1', NODE_USE_ENV_PROXY: '1',
        })
        await incus(['config', 'device', 'set', name, 'root', `size=${config.disk_gib}GiB`])
        await incus(['config', 'device', 'add', name, 'workspace', 'disk', `source=${command.cwd}`, `path=${command.cwd}`])
        // Only this repository's git dir, never the data dir with the other tickets' worktrees.
        const gitDir = io.gitCommonDir(command.cwd)
        if (gitDir !== null) await incus(['config', 'device', 'add', name, 'gitdir', 'disk', `source=${gitDir}`, `path=${gitDir}`])
        for (const [index, dir] of config.read_only_paths.entries()) {
          await incus(['config', 'device', 'add', name, `ro${index}`, 'disk', `source=${dir}`, `path=${dir}`, 'readonly=true'])
        }
        await incus(['start', name])
        await waitReady(name)
        await incus(['file', 'push', '-', `${name}${config.env_file}`, '--mode=0600',
          `--uid=${config.uid}`, `--gid=${config.gid}`, '--create-dirs'], guestEnv)
      } catch (error) {
        await destroy(name).catch(() => { /* the lease and the reaper cover a failed cleanup */ })
        throw error
      }

      return {
        identity: name,
        command: {
          cmd: config.incus,
          cwd: command.cwd,
          env: {PATH: '/usr/bin:/bin', LANG: 'C.UTF-8', HOME: io.home},
          args: ['exec', name, `--user=${config.uid}`, `--group=${config.gid}`, `--cwd=${command.cwd}`, '--',
            config.launcher, config.env_file, command.cmd, ...command.args],
        },
        async signal() {
          const current = await find(name)
          if (current === undefined) return false
          if (!owned(current)) throw new Error('ownership_not_confirmed')
          await incus(['stop', name, '--force'])
          return true
        },
        async empty() {
          await destroy(name)
          return true
        },
      }
    },
  }
  return backend
}

function trustedRootFile(file: string): boolean {
  try {
    let cursor = fs.realpathSync(file)
    while (true) {
      const metadata = fs.statSync(cursor)
      if (metadata.uid !== 0 || (metadata.mode & 0o022) !== 0) return false
      if (cursor === '/') return true
      cursor = path.dirname(cursor)
    }
  } catch {
    return false
  }
}

function linkedWorktreeCommonDir(cwd: string): string | null {
  const marker = path.join(cwd, '.git')
  if (!fs.lstatSync(marker).isFile()) return null
  const match = /^gitdir: (.+)$/m.exec(fs.readFileSync(marker, 'utf8'))
  if (!match) throw new Error('unreadable worktree git link')
  const worktreeGitDir = path.resolve(cwd, match[1].trim())
  const common = path.resolve(worktreeGitDir, fs.readFileSync(path.join(worktreeGitDir, 'commondir'), 'utf8').trim())
  return fs.realpathSync(common)
}

function readTrustedConfig(file: string = VM_CONTAINMENT_CONFIG_PATH): VmContainmentConfig | null {
  if (!fs.existsSync(file)) return null
  // Only root may decide which image, mounts and network a session gets.
  if (!trustedRootFile(file)) throw new Error('vm containment config is not root-owned')
  return parseVmContainmentConfig(JSON.parse(fs.readFileSync(file, 'utf8')))
}

export function defaultVmContainmentIo(): VmContainmentIo {
  const home = os.homedir()
  let chain: Promise<unknown> = Promise.resolve()
  return {
    platform: process.platform,
    home,
    readConfig: () => readTrustedConfig(),
    trustedExecutable: trustedRootFile,
    gitCommonDir: linkedWorktreeCommonDir,
    run(args, input) {
      const config = readTrustedConfig()
      if (config === null) return Promise.resolve({status: null, stdout: ''})
      return new Promise((resolve) => {
        const child = execFile(config.incus, args, {
          encoding: 'utf8',
          timeout: INCUS_CALL_TIMEOUT_MS,
          maxBuffer: INCUS_CALL_MAX_BYTES,
          killSignal: 'SIGKILL',
          env: {PATH: '/usr/bin:/bin', LANG: 'C.UTF-8', HOME: home},
        }, (error, stdout) => {
          resolve({status: error === null ? 0 : typeof error.code === 'number' ? error.code : null, stdout})
        })
        child.stdin?.end(input ?? '')
      })
    },
    withLock(fn) {
      const next = chain.then(fn, fn)
      chain = next.catch(() => undefined)
      return next
    },
    randomId: () => randomUUID().replaceAll('-', ''),
    now: () => Date.now(),
    sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  }
}

export function vmContainmentInstalled(file: string = VM_CONTAINMENT_CONFIG_PATH): boolean {
  return fs.existsSync(file)
}

let shared: StrongContainmentBackend | undefined

/** One backend per daemon: parallel sessions must share the slot lock and the availability probe. */
export function sharedVmContainmentBackend(): StrongContainmentBackend {
  shared ??= createVmContainmentBackend()
  return shared
}
