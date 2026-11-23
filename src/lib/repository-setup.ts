import {spawn, spawnSync} from 'node:child_process'
import {createHash} from 'node:crypto'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import {buildLimits} from './emulator-test'
import {stateDir} from './paths'
import {createStrongContainmentBackend, type StrongContainmentBackend} from './process-containment'
import {type RepositorySetup} from './quality-gate'
import {redactSecrets} from './secret-redaction'
import {excludeSetupDirectories} from './workspace'

export interface RepositorySetupInput {
  repository: string
  repoPath: string
  cwd: string
  trustedBase: string
  setup: RepositorySetup
  directories: string[]
  signal?: AbortSignal
}

export class RepositorySetupError extends Error {
  constructor(category: string, detail: string) {
    super(`Repository setup ${category}: ${redactSecrets(detail).replace(/\s+/g, ' ').slice(0, 400)}`)
  }
}

function git(cwd: string, args: string[]): string {
  const result = spawnSync('/usr/bin/git', ['-c', 'core.fsmonitor=false', '-C', cwd, ...args], {
    encoding: 'utf8', timeout: 30_000, maxBuffer: 16 * 1024 * 1024,
    env: {PATH: '/usr/bin:/bin', HOME: '/nonexistent', GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null'},
  })
  if (result.error || result.status !== 0) throw new RepositorySetupError('read', 'Cannot read repository objects')
  return result.stdout
}

const hash = (text: string): string => createHash('sha256').update(text).digest('hex')
const TOOL_FILES = ['mise.toml', '.mise.toml', '.tool-versions']
const LOCK_FILES = ['pnpm-lock.yaml', 'package-lock.json', 'yarn.lock', 'Gemfile.lock', 'pubspec.lock', 'Cargo.lock', 'uv.lock', 'poetry.lock', 'composer.lock', 'go.sum']

/** A deliberately conservative proof: all tracked inputs must match, including scripts and local dependencies.
 * Unknown dependency managers, submodules and extra ticket files always get a private preparation. */
export function compatibleSetup(input: RepositorySetupInput): boolean {
  const tree = git(input.repoPath, ['ls-tree', '-r', input.trustedBase])
  if (tree.split('\n').some((line) => line.startsWith('160000 '))) return false
  const names = git(input.repoPath, ['ls-tree', '-r', '--name-only', input.trustedBase]).trim().split('\n')
  if (!LOCK_FILES.some((file) => names.includes(file))) return false
  const managers: Array<[string, string[]]> = [
    ['package.json', ['pnpm-lock.yaml', 'package-lock.json', 'yarn.lock']],
    ['Gemfile', ['Gemfile.lock']], ['pubspec.yaml', ['pubspec.lock']], ['Cargo.toml', ['Cargo.lock']],
    ['pyproject.toml', ['uv.lock', 'poetry.lock']], ['composer.json', ['composer.lock']], ['go.mod', ['go.sum']],
  ]
  if (managers.some(([manifest, locks]) => names.includes(manifest) && !locks.some((lock) => names.includes(lock)))) return false
  // Root lockfiles cannot attest independent nested projects or an unpinned requirements install.
  if (names.some((name) => name.endsWith('requirements.txt') ||
    managers.some(([manifest]) => name.endsWith(`/${manifest}`)))) return false
  // Read actual bytes rather than trusting index flags, clean filters, or assume-unchanged.
  const entries = git(input.repoPath, ['ls-tree', '-rz', input.trustedBase]).split('\0').filter(Boolean)
  for (const entry of entries) {
    const match = /^(\d+) blob ([a-f0-9]+)\t([\s\S]+)$/.exec(entry)
    if (!match) return false
    const [, mode, object, file] = match
    const parent = path.dirname(file)
    try {
      if (parent !== '.') assertDirectory(input.cwd, parent, true)
      const absolute = path.join(input.cwd, file)
      const stat = fs.lstatSync(absolute)
      if (mode === '120000' ? !stat.isSymbolicLink() : !stat.isFile()) return false
      const bytes = mode === '120000' ? Buffer.from(fs.readlinkSync(absolute)) : fs.readFileSync(absolute)
      const actual = createHash(object.length === 64 ? 'sha256' : 'sha1').update(`blob ${bytes.length}\0`).update(bytes).digest('hex')
      if (actual !== object || (mode !== '120000' && ((stat.mode & 0o111) !== 0) !== (mode === '100755'))) return false
    } catch { return false }
  }
  if (git(input.cwd, ['ls-files', '--others', '--exclude-standard']).trim()) return false
  // Ignored files outside declared dependency outputs may also influence scripts.
  const ignored = git(input.cwd, ['ls-files', '--others', '--ignored', '--exclude-standard']).trim().split('\n').filter(Boolean)
  return ignored.every((file) => input.directories.some((dir) => file.startsWith(`${dir}/`)))
}

function assertDirectory(root: string, relative: string, required = false): void {
  let cursor = root
  for (const segment of relative.split('/')) {
    cursor = path.join(cursor, segment)
    try {
      const stat = fs.lstatSync(cursor)
      if (!stat.isDirectory() || stat.isSymbolicLink()) throw new RepositorySetupError('configuration', 'Shared directory is not a private directory')
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT' && !required) return
      throw error
    }
  }
}

/** Reflinks are private inodes, unlike hard links; ordinary copy is the filesystem fallback. */
export function copySetupDirectory(source: string, destination: string): void {
  const root = fs.realpathSync(source)
  function validate(dir: string): void {
    for (const entry of fs.readdirSync(dir, {withFileTypes: true})) {
      const file = path.join(dir, entry.name)
      if (entry.isDirectory()) validate(file)
      else if (entry.isSymbolicLink()) {
        const link = fs.readlinkSync(file)
        if (path.isAbsolute(link)) throw new RepositorySetupError('isolation', 'Absolute dependency symlink is not portable')
        const target = path.resolve(path.dirname(file), link)
        if (target !== root && !target.startsWith(`${root}/`)) throw new RepositorySetupError('isolation', 'Dependency symlink escapes its shared directory')
      } else if (!entry.isFile()) throw new RepositorySetupError('isolation', 'Unsupported dependency file type')
    }
  }
  validate(root)
  fs.cpSync(root, destination, {recursive: true, mode: fs.constants.COPYFILE_FICLONE, verbatimSymlinks: true})
}

/** No host home, root filesystem, sockets, or ambient environment is visible to project code. */
export function setupSandboxArgs(cwd: string, scratch: string, script: string, network: boolean, tools: string[]): string[] {
  const system = ['/usr', '/bin', '/lib', '/lib64', '/etc/ssl/certs', '/etc/ld.so.cache', '/etc/resolv.conf', '/etc/hosts', '/etc/passwd', '/etc/alternatives']
    .filter((file) => fs.existsSync(file))
  return [
    '--unshare-all', ...(network ? ['--share-net'] : []), '--die-with-parent', '--new-session',
    ...system.flatMap((file) => ['--ro-bind', file, file]),
    ...tools.flatMap((file) => {
      const root = path.basename(file) === 'bin' ? path.dirname(file) : file
      return ['--ro-bind', root, root]
    }),
    '--proc', '/proc', '--dev', '/dev', '--tmpfs', '/tmp',
    '--bind', cwd, cwd, '--bind', scratch, scratch,
    // Linked worktrees contain an administrative pointer. Hide it even though its target is not mounted.
    ...(fs.existsSync(path.join(cwd, '.git')) ? (fs.lstatSync(path.join(cwd, '.git')).isDirectory()
      ? ['--tmpfs', path.join(cwd, '.git')] : ['--ro-bind', '/dev/null', path.join(cwd, '.git')]) : []),
    '--chdir', cwd, '--clearenv',
    '--setenv', 'PATH', [...tools, '/usr/bin', '/bin'].join(':'),
    '--setenv', 'HOME', scratch, '--setenv', 'TMPDIR', '/tmp',
    '--setenv', 'CI', 'true', '--setenv', 'LANG', 'C.UTF-8',
    '--', '/bin/sh', '-c', script,
  ]
}

/** Resolve installed tool paths from a clean copy of trusted configuration, never from the ticket. */
function toolPaths(input: RepositorySetupInput, scratch: string): string[] {
  const names = git(input.repoPath, ['ls-tree', '--name-only', input.trustedBase]).trim().split('\n')
  let hasTools = false
  for (const file of TOOL_FILES) {
    if (!names.includes(file)) continue
    fs.writeFileSync(path.join(scratch, file), git(input.repoPath, ['show', `${input.trustedBase}:${file}`]))
    hasTools = true
  }
  if (!hasTools) return []
  const result = spawnSync('mise', ['env', '--json'], {
    cwd: scratch, encoding: 'utf8', timeout: 30_000,
    env: {PATH: process.env.PATH, HOME: os.homedir(), MISE_TRUSTED_CONFIG_PATHS: scratch, MISE_YES: '1'},
  })
  if (result.status !== 0) throw new RepositorySetupError('installation', 'Cannot resolve trusted installed tools')
  const env = JSON.parse(result.stdout) as {PATH?: string}
  // Only installed mise runtimes are exposed. Shims would load the ticket's mise configuration.
  const installs = fs.realpathSync(path.join(os.homedir(), '.local/share/mise/installs'))
  return [...new Set((env.PATH ?? '').split(':').filter((dir) => dir.startsWith(`${installs}/`)))]
}

const toolHashes = new Map<string, {identity: string; digest: string}>()

function fileIdentity(stat: fs.BigIntStats): string {
  return [stat.dev, stat.ino, stat.mode, stat.size, stat.mtimeNs, stat.ctimeNs].join(':')
}

/** Hash runtime bytes only when their kernel metadata changes; bound the process-local memo. */
function toolsDigest(tools: string[]): string {
  const digest = createHash('sha256').update(JSON.stringify({platform: process.platform, arch: process.arch, node: process.versions}))
  for (const dir of tools) {
    digest.update(dir)
    for (const name of fs.readdirSync(dir).sort()) {
      const file = path.join(dir, name)
      const stat = fs.statSync(file, {bigint: true})
      if (stat.isFile()) {
        const identity = fileIdentity(stat)
        let cached = toolHashes.get(file)
        if (!cached || cached.identity !== identity) {
          cached = {identity, digest: createHash('sha256').update(fs.readFileSync(file)).digest('hex')}
          if (toolHashes.size >= 128) toolHashes.clear()
          toolHashes.set(file, cached)
        }
        digest.update(name).update(cached.digest)
      }
    }
  }
  return digest.digest('hex')
}

function cacheDigest(root: string, directories: string[]): string {
  const digest = createHash('sha256')
  function visit(relative: string): void {
    const file = path.join(root, relative)
    const stat = fs.lstatSync(file, {bigint: true})
    digest.update(JSON.stringify([relative, String(stat.mode)]))
    if (stat.isSymbolicLink()) digest.update(fs.readlinkSync(file))
    else if (stat.isDirectory()) for (const name of fs.readdirSync(file).sort()) visit(path.join(relative, name))
    // The cache is host-owned and never mounted into project code. ctime cannot be restored by
    // a ticket; inventory + inode/size/nanosecond timestamps detect replacement or modification
    // without reading every dependency byte again. Directory renames do not change file identity.
    else if (stat.isFile()) digest.update(fileIdentity(stat))
    else throw new RepositorySetupError('cache', 'Unsupported cached file')
  }
  for (const dir of directories) { assertDirectory(root, dir, true); visit(dir) }
  return digest.digest('hex')
}

export interface SetupOptions {
  root?: string
  backend?: StrongContainmentBackend
  run?: (input: RepositorySetupInput, scratch: string, tools: string[]) => Promise<void>
  resolveTools?: typeof toolPaths
}

async function executeSetup(input: RepositorySetupInput, scratch: string, tools: string[], backend: StrongContainmentBackend): Promise<void> {
  if (input.signal?.aborted) throw new RepositorySetupError('cancelled', 'Preparation cancelled')
  const available = await backend.available()
  if (!available.available) throw new RepositorySetupError('isolation', 'Strong containment is unavailable')
  // Mount entire runtime roots to make relative libraries available, while PATH contains only their bin folders.
  const args = setupSandboxArgs(input.cwd, scratch, input.setup.run, input.setup.network, tools)
  const handle = await backend.prepare({cmd: '/usr/bin/bwrap', args, cwd: input.cwd, limits: buildLimits(os.availableParallelism())})
  let timedOut = false
  let diagnostic = ''
  let code: number | null = null
  try {
    code = await new Promise<number | null>((resolve, reject) => {
      const child = spawn(handle.command.cmd, handle.command.args, {
        cwd: input.cwd, detached: true, stdio: ['ignore', 'pipe', 'pipe'],
        env: handle.command.env ?? {
          PATH: '/usr/bin:/bin', XDG_RUNTIME_DIR: `/run/user/${process.getuid?.()}`,
          DBUS_SESSION_BUS_ADDRESS: `unix:path=/run/user/${process.getuid?.()}/bus`,
        },
      })
      const stop = (): void => {
        void Promise.resolve(handle.signal('SIGKILL')).catch(() => undefined)
        try { if (child.pid) process.kill(-child.pid, 'SIGKILL') } catch { /* Already gone. */ }
      }
      const timer = setTimeout(() => { timedOut = true; stop() }, input.setup.timeout * 1000)
      const finish = (): void => { clearTimeout(timer); input.signal?.removeEventListener('abort', stop) }
      child.stdout.on('data', () => undefined)
      child.stderr.on('data', (data: Buffer) => { diagnostic = (diagnostic + data.toString()).slice(-4096) })
      child.on('error', (error) => { finish(); reject(error) })
      child.on('close', (exit) => { finish(); resolve(exit) })
      if (input.signal?.aborted) stop()
      else input.signal?.addEventListener('abort', stop, {once: true})
    })
  } finally {
    await handle.signal('SIGKILL')
    let empty = false
    for (let i = 0; i < 50; i++) {
      if (await handle.empty()) { empty = true; break }
      await new Promise((resolve) => setTimeout(resolve, 100))
    }
    if (!empty) throw new RepositorySetupError('isolation', 'Cannot attest that all preparation processes stopped')
  }
  if (input.signal?.aborted) throw new RepositorySetupError('cancelled', 'Preparation cancelled')
  if (timedOut) throw new RepositorySetupError('timeout', `Exceeded ${input.setup.timeout} seconds`)
  if (code !== 0) throw new RepositorySetupError('command', `Exit ${code}: ${diagnostic}`)
}

/** A kernel lock releases on crash; closing stdin releases it after the callback. No stale success marker. */
export async function withCacheLock<T>(file: string, signal: AbortSignal | undefined, task: () => Promise<T>): Promise<T> {
  if (signal?.aborted) throw new RepositorySetupError('cancelled', 'Preparation cancelled')
  // No fixed deadline: a valid preparation can take an hour. Waiting is cancellable instead.
  const child = spawn('/usr/bin/flock', ['--exclusive', file, '/bin/sh', '-c', 'echo locked; cat >/dev/null'], {
    detached: true, stdio: ['pipe', 'pipe', 'pipe'], env: {PATH: '/usr/bin:/bin'},
  })
  child.stdin.on('error', () => undefined)
  child.stderr.on('data', () => undefined)
  const stop = (): void => { child.stdin.end() }
  const cancelWait = (): void => {
    try { if (child.pid) process.kill(-child.pid, 'SIGKILL') } catch { /* Already exited. */ }
  }
  const closed = new Promise<void>((resolve) => child.once('close', () => resolve()))
  try {
    await new Promise<void>((resolve, reject) => {
      child.once('error', reject)
      child.once('exit', () => reject(new RepositorySetupError(signal?.aborted ? 'cancelled' : 'cache',
        signal?.aborted ? 'Preparation cancelled' : 'Exclusive cache lock unavailable')))
      child.stdout.once('data', () => resolve())
      signal?.addEventListener('abort', cancelWait, {once: true})
      if (signal?.aborted) cancelWait()
    })
    // Once acquired, keep the lock until task cleanup completes, including cancellation.
    signal?.removeEventListener('abort', cancelWait)
    if (signal?.aborted) throw new RepositorySetupError('cancelled', 'Preparation cancelled')
    return await task()
  } finally {
    signal?.removeEventListener('abort', cancelWait)
    stop()
    await closed
  }
}

export async function prepareRepository(input: RepositorySetupInput, options: SetupOptions = {}): Promise<void> {
  if (input.signal?.aborted) throw new RepositorySetupError('cancelled', 'Preparation cancelled')
  const root = options.root ?? path.join(stateDir(), 'repository-setup')
  fs.mkdirSync(root, {recursive: true, mode: 0o700})
  const scratch = fs.mkdtempSync(path.join(root, 'attempt-'))
  const record = path.join(root, `${hash(input.cwd)}.json`)
  fs.rmSync(record, {force: true})
  const run: NonNullable<SetupOptions['run']> = options.run ?? ((entry, home, tools) => executeSetup(entry, home, tools, options.backend ?? createStrongContainmentBackend()))
  try {
    for (const dir of input.directories) {
      assertDirectory(input.cwd, dir)
      if (git(input.cwd, ['ls-files', '--', dir]).trim()) throw new RepositorySetupError('configuration', 'Shared directory contains tracked source files')
    }
    excludeSetupDirectories(input.repoPath, input.directories)
    const tools = (options.resolveTools ?? toolPaths)(input, scratch)
    const compatible = input.directories.length > 0 && compatibleSetup(input)
    const key = hash(JSON.stringify({repository: input.repository, base: input.trustedBase, setup: input.setup, dirs: input.directories, tools: toolsDigest(tools)}))
    if (!compatible) {
      await run(input, scratch, tools)
    } else {
      await withCacheLock(path.join(root, `${key}.lock`), input.signal, async () => {
        const cache = path.join(root, key)
        let complete = false
        try {
          complete = fs.readFileSync(path.join(cache, 'complete'), 'utf8') === `${key}:${cacheDigest(cache, input.directories)}`
        } catch { /* An incomplete or damaged cache is rebuilt from trusted source. */ }
        if (!complete) {
          fs.rmSync(cache, {recursive: true, force: true})
          const build = path.join(scratch, 'source')
          fs.mkdirSync(build)
          // git archive cannot execute checkout filters or hooks; the source comes exclusively from the pinned commit.
          const archive = path.join(scratch, 'source.tar')
          git(input.repoPath, ['archive', '--format=tar', `--output=${archive}`, input.trustedBase])
          const extracted = spawnSync('/usr/bin/tar', ['-xf', archive, '-C', build], {timeout: 30_000})
          if (extracted.status !== 0) throw new RepositorySetupError('read', 'Cannot materialize trusted preparation source')
          await run({...input, cwd: build}, scratch, tools)
          const staged = path.join(scratch, 'cache')
          fs.mkdirSync(staged)
          for (const dir of input.directories) {
            assertDirectory(build, dir, true)
            fs.mkdirSync(path.dirname(path.join(staged, dir)), {recursive: true})
            copySetupDirectory(path.join(build, dir), path.join(staged, dir))
          }
          if (input.signal?.aborted) throw new RepositorySetupError('cancelled', 'Preparation cancelled')
          fs.writeFileSync(path.join(staged, 'complete'), `${key}:${cacheDigest(staged, input.directories)}`)
          fs.renameSync(staged, cache)
        }
        for (const dir of input.directories) {
          assertDirectory(input.cwd, dir)
          assertDirectory(cache, dir, true)
          fs.rmSync(path.join(input.cwd, dir), {recursive: true, force: true})
          fs.mkdirSync(path.dirname(path.join(input.cwd, dir)), {recursive: true})
          copySetupDirectory(path.join(cache, dir), path.join(input.cwd, dir))
        }
      })
      // Setup may generate files beyond the reusable directories. Run it privately on every launch,
      // with restored dependencies as input, and never publish these ticket-side writes.
      await run(input, scratch, tools)
    }
    for (const dir of input.directories) assertDirectory(input.cwd, dir, true)
    if (input.signal?.aborted) throw new RepositorySetupError('cancelled', 'Preparation cancelled')
    // Outside the mutable checkout; a new attempt always revalidates and prepares again.
    fs.writeFileSync(record, JSON.stringify({key, compatible, completedAt: new Date().toISOString()}), {mode: 0o600})
  } catch (error) {
    if (error instanceof RepositorySetupError) throw error
    throw new RepositorySetupError('failed', error instanceof Error ? error.message : String(error))
  } finally {
    fs.rmSync(scratch, {recursive: true, force: true})
  }
}
