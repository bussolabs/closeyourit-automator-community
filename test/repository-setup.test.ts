import {spawnSync} from 'node:child_process'
import * as childProcess from 'node:child_process'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import {afterEach, describe, expect, it, vi} from 'vitest'
import {QualityGateConfigSchema} from '../src/lib/quality-gate'
import {compatibleSetup, copySetupDirectory, prepareRepository, setupSandboxArgs, withCacheLock, type RepositorySetupInput} from '../src/lib/repository-setup'
import {loadQualityGateAtRef} from '../src/lib/ticket-cycle'

// Native ESM namespace exports are non-configurable. Provide mutable module
// facades so the two observational spies still call the real filesystem/process APIs.
vi.mock('node:child_process', async (importOriginal) => ({...await importOriginal<typeof import('node:child_process')>()}))
vi.mock('node:fs', async (importOriginal) => ({...await importOriginal<typeof import('node:fs')>()}))

const temporary: string[] = []
function dir(): string {
  const result = fs.mkdtempSync(path.join(os.tmpdir(), 'repository-setup-test-'))
  temporary.push(result)
  return result
}
afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); for (const file of temporary.splice(0)) fs.rmSync(file, {recursive: true, force: true}) })
function barrier(): {promise: Promise<void>; resolve: () => void} {
  let resolve!: () => void
  const promise = new Promise<void>((done) => { resolve = done })
  return {promise, resolve}
}
function git(cwd: string, ...args: string[]): string {
  const result = spawnSync('git', ['-C', cwd, ...args], {encoding: 'utf8', env: {...process.env, GIT_CONFIG_GLOBAL: '/dev/null'}})
  if (result.status !== 0) throw new Error(result.stderr)
  return result.stdout.trim()
}
function fixture(): RepositorySetupInput {
  const repoPath = dir()
  git(repoPath, 'init', '-b', 'main')
  git(repoPath, 'config', 'user.email', 'test@example.invalid')
  git(repoPath, 'config', 'user.name', 'Test')
  fs.writeFileSync(path.join(repoPath, 'package-lock.json'), '{}')
  fs.writeFileSync(path.join(repoPath, '.gitignore'), 'node_modules/\n')
  git(repoPath, 'add', '.')
  git(repoPath, 'commit', '-m', 'fixture')
  return {repository: 'example/repo', repoPath, cwd: repoPath, trustedBase: git(repoPath, 'rev-parse', 'HEAD'),
    setup: {run: 'setup', network: false, timeout: 30}, directories: ['node_modules']}
}
const base = {version: 1, checks: [{stage: 'unit', run: 'test'}]}

describe('repository preparation contract', () => {
  it('preserves legacy defaults and accepts optional preparation in both versions', () => {
    expect(QualityGateConfigSchema.parse(base).setup).toBeUndefined()
    for (const version of [1, 2]) {
      const config = QualityGateConfigSchema.parse({...base, version, setup: {run: 'install'}, shared_directories: ['node_modules', 'vendor/bundle'],
        ...(version === 2 ? {remote: {provider: 'github', required_checks: ['test']}} : {})})
      expect(config.setup).toEqual({run: 'install', timeout: 300, network: false})
    }
  })
  it.each([['../outside'], ['/outside'], ['a/../b'], ['a', 'a'], ['a', 'a/b'], ['.'], ['.git'], ['a//b'], ['a/'], ['a\\b']])('rejects unsafe directories %j', (...shared_directories) => {
    expect(QualityGateConfigSchema.safeParse({...base, shared_directories}).success).toBe(false)
  })
  it.each([{run: ''}, {run: 'ok', timeout: 0}, {run: 'ok', timeout: 3601}, {run: 'ok', network: 'yes'}, {run: 'ok', extra: true}])('rejects invalid setup %j', (setup) => {
    expect(QualityGateConfigSchema.safeParse({...base, setup}).success).toBe(false)
  })
  it('distinguishes an absent trusted config from invalid content or unreadable revision', () => {
    const input = fixture()
    expect(loadQualityGateAtRef(input.repoPath, input.trustedBase)).toBeNull()
    expect(() => loadQualityGateAtRef(input.repoPath, 'missing')).toThrow()
    fs.mkdirSync(path.join(input.repoPath, '.closeyourit'))
    fs.writeFileSync(path.join(input.repoPath, '.closeyourit/quality-gate.yml'), 'invalid: true')
    git(input.repoPath, 'add', '.')
    git(input.repoPath, 'commit', '-m', 'invalid config')
    expect(() => loadQualityGateAtRef(input.repoPath, 'HEAD')).toThrow()
    expect(loadQualityGateAtRef(input.repoPath, input.trustedBase)).toBeNull()
  })
})

describe('private dependency copies', () => {
  it('copies files with different inodes and preserves internal symlinks', () => {
    const source = dir()
    const target = path.join(dir(), 'copy')
    fs.writeFileSync(path.join(source, 'data'), 'original')
    fs.symlinkSync('data', path.join(source, 'link'))
    copySetupDirectory(source, target)
    fs.writeFileSync(path.join(target, 'data'), 'changed')
    expect(fs.readFileSync(path.join(source, 'data'), 'utf8')).toBe('original')
    expect(fs.readFileSync(path.join(target, 'link'), 'utf8')).toBe('changed')
    expect(fs.statSync(path.join(source, 'data')).ino).not.toBe(fs.statSync(path.join(target, 'data')).ino)
  })
  it('rejects escaping symlinks', () => {
    const source = dir()
    fs.symlinkSync('/outside', path.join(source, 'escape'))
    expect(() => copySetupDirectory(source, path.join(dir(), 'copy'))).toThrow(/symlink/)
  })
  it('serializes concurrent trusted builds, restores private copies, and prepares every launch', async () => {
    const first = fixture()
    const second = {...first, cwd: path.join(dir(), 'ticket')}
    git(first.repoPath, 'worktree', 'add', '--detach', second.cwd, first.trustedBase)
    const root = dir()
    let trustedBuilds = 0
    const started = barrier()
    const release = barrier()
    const run = async (input: RepositorySetupInput): Promise<void> => {
      if (input.cwd !== first.cwd && input.cwd !== second.cwd) {
        trustedBuilds++
        started.resolve()
        await release.promise
      }
      fs.mkdirSync(path.join(input.cwd, 'node_modules'), {recursive: true})
      fs.writeFileSync(path.join(input.cwd, 'node_modules/data'), 'prepared')
    }
    const options = {root, run, resolveTools: () => []}
    const firstPreparation = prepareRepository(first, options)
    await started.promise
    const secondPreparation = prepareRepository(second, options)
    release.resolve()
    await Promise.all([firstPreparation, secondPreparation])
    expect(trustedBuilds).toBe(1)
    fs.writeFileSync(path.join(first.cwd, 'node_modules/data'), 'ticket modification')
    expect(fs.readFileSync(path.join(second.cwd, 'node_modules/data'), 'utf8')).toBe('prepared')
    await prepareRepository(first, options)
    expect(trustedBuilds).toBe(1)
    expect(fs.readFileSync(path.join(first.cwd, 'node_modules/data'), 'utf8')).toBe('prepared')
    fs.writeFileSync(path.join(first.cwd, 'package-lock.json'), '{"changed":true}')
    expect(compatibleSetup(first)).toBe(false)
    await prepareRepository(first, options)
    expect(trustedBuilds).toBe(1)
    expect(fs.readFileSync(path.join(second.cwd, 'node_modules/data'), 'utf8')).toBe('prepared')
  })
  it('cancels a waiting lock without releasing the active builder and can resume', async () => {
    const file = path.join(dir(), 'cache.lock')
    const started = barrier()
    const release = barrier()
    const first = withCacheLock(file, undefined, async () => { started.resolve(); await release.promise })
    await started.promise
    const controller = new AbortController()
    const task = vi.fn(async () => undefined)
    const waiting = withCacheLock(file, controller.signal, task)
    const rejected = expect(waiting).rejects.toThrow(/cancelled/)
    controller.abort()
    try {
      await rejected
      expect(task).not.toHaveBeenCalled()
    } finally { release.resolve(); await first }
    await withCacheLock(file, undefined, task)
    expect(task).toHaveBeenCalledTimes(1)
  })
  it('keeps compatible waiters queued beyond 60 seconds without a native flock deadline', async () => {
    const spawn = vi.spyOn(childProcess, 'spawn')
    vi.useFakeTimers({toFake: ['setTimeout', 'clearTimeout']})
    const file = path.join(dir(), 'cache.lock')
    const started = barrier()
    const release = barrier()
    const first = withCacheLock(file, undefined, async () => { started.resolve(); await release.promise })
    await started.promise
    const task = vi.fn(async () => undefined)
    const second = withCacheLock(file, undefined, task)
    try {
      await vi.advanceTimersByTimeAsync(120_000)
      expect(task).not.toHaveBeenCalled()
      // Virtual time cannot advance flock's kernel clock: also verify no native deadline is set.
      for (const call of spawn.mock.calls) expect(call[1]).not.toContain('--timeout')
    } finally { release.resolve(); await Promise.all([first, second]) }
    expect(task).toHaveBeenCalledTimes(1)
  })
  it('rebuilds a cache modified with the same size and restored mtime', async () => {
    const input = fixture()
    const root = dir()
    let builds = 0
    const options = {root, resolveTools: () => [], run: async (entry: RepositorySetupInput) => {
      if (entry.cwd !== input.cwd) builds++
      fs.mkdirSync(path.join(entry.cwd, 'node_modules'), {recursive: true})
      fs.writeFileSync(path.join(entry.cwd, 'node_modules/data'), 'good')
    }}
    await prepareRepository(input, options)
    const cache = fs.readdirSync(root).find((name) => fs.statSync(path.join(root, name)).isDirectory())!
    const file = path.join(root, cache, 'node_modules/data')
    const stat = fs.statSync(file)
    fs.writeFileSync(file, 'evil')
    fs.utimesSync(file, stat.atime, stat.mtime)
    await prepareRepository(input, options)
    expect(builds).toBe(2)
    expect(fs.readFileSync(file, 'utf8')).toBe('good')
  })
  it('does not reread unchanged runtime or dependency contents and invalidates changed tools', async () => {
    const input = fixture()
    const root = dir()
    const tools = dir()
    const binary = path.join(tools, 'runtime')
    fs.writeFileSync(binary, 'first')
    const reads = vi.spyOn(fs, 'readFileSync')
    let builds = 0
    const options = {root, resolveTools: () => [tools], run: async (entry: RepositorySetupInput) => {
      if (entry.cwd !== input.cwd) builds++
      fs.mkdirSync(path.join(entry.cwd, 'node_modules'), {recursive: true})
      fs.writeFileSync(path.join(entry.cwd, 'node_modules/data'), 'prepared')
    }}
    await prepareRepository(input, options)
    await prepareRepository(input, options)
    expect(builds).toBe(1)
    expect(reads.mock.calls.filter(([file]) => file === binary)).toHaveLength(1)
    expect(reads.mock.calls.filter(([file]) => String(file).endsWith('/node_modules/data'))).toHaveLength(0)
    const stat = fs.statSync(binary)
    fs.writeFileSync(binary, 'other')
    fs.utimesSync(binary, stat.atime, stat.mtime)
    await prepareRepository(input, options)
    expect(builds).toBe(2)
    expect(reads.mock.calls.filter(([file]) => file === binary)).toHaveLength(2)
  })
  it('uses private preparation without a known lockfile', async () => {
    const input = fixture()
    fs.rmSync(path.join(input.repoPath, 'package-lock.json'))
    git(input.repoPath, 'add', '.')
    git(input.repoPath, 'commit', '-m', 'no lock')
    input.trustedBase = git(input.repoPath, 'rev-parse', 'HEAD')
    let calls = 0
    await prepareRepository(input, {root: dir(), resolveTools: () => [], run: async (entry) => {
      expect(entry.cwd).toBe(input.cwd)
      calls++
      fs.mkdirSync(path.join(entry.cwd, 'node_modules'))
    }})
    expect(calls).toBe(1)
  })
  it('does not publish a failed preparation and retries it', async () => {
    const input = fixture()
    const root = dir()
    await expect(prepareRepository(input, {root, resolveTools: () => [], run: async () => { throw new Error('failed') }})).rejects.toThrow(/failed/)
    expect(fs.readdirSync(root).filter((name) => !name.endsWith('.lock'))).toEqual([])
    let calls = 0
    await prepareRepository(input, {root, resolveTools: () => [], run: async (entry) => {
      calls++
      fs.mkdirSync(path.join(entry.cwd, 'node_modules'), {recursive: true})
    }})
    expect(calls).toBe(2)
  })
  it('blocks when strong isolation is unavailable', async () => {
    const input = {...fixture(), directories: []}
    await expect(prepareRepository(input, {root: dir(), resolveTools: () => [], backend: {
      available: () => ({available: false}), prepare: () => { throw new Error('must not spawn') },
    }})).rejects.toThrow(/isolation/)
  })
  it('does not publish cancelled output and prepares again on resume', async () => {
    const input = fixture()
    const root = dir()
    const controller = new AbortController()
    await expect(prepareRepository({...input, signal: controller.signal}, {root, resolveTools: () => [], run: async (entry) => {
      fs.mkdirSync(path.join(entry.cwd, 'node_modules'))
      controller.abort()
    }})).rejects.toThrow(/cancelled/)
    expect(fs.readdirSync(root).filter((name) => !name.endsWith('.lock'))).toEqual([])
    let calls = 0
    await prepareRepository(input, {root, resolveTools: () => [], run: async (entry) => {
      calls++
      fs.mkdirSync(path.join(entry.cwd, 'node_modules'), {recursive: true})
    }})
    expect(calls).toBe(2)
  })
  it('does not trust assume-unchanged to prove compatibility', () => {
    const input = fixture()
    git(input.cwd, 'update-index', '--assume-unchanged', 'package-lock.json')
    fs.writeFileSync(path.join(input.cwd, 'package-lock.json'), 'changed')
    expect(compatibleSetup(input)).toBe(false)
  })
  it('excludes declared output from commits', async () => {
    const input = {...fixture(), directories: ['custom-dependencies']}
    await prepareRepository(input, {root: dir(), resolveTools: () => [], run: async (entry) => {
      fs.mkdirSync(path.join(entry.cwd, 'custom-dependencies'), {recursive: true})
      fs.writeFileSync(path.join(entry.cwd, 'custom-dependencies/data'), 'installed')
    }})
    expect(git(input.cwd, 'ls-files', '--others', '--exclude-standard')).toBe('')
  })
  it('builds an allowlist sandbox without inherited environment or host home', () => {
    const args = setupSandboxArgs('/work', '/scratch', 'true', false, [])
    expect(args).toContain('--clearenv')
    expect(args).toContain('--unshare-all')
    expect(args).not.toContain('--share-net')
    expect(args).not.toContain(os.homedir())
    expect(args).not.toContain('/')
    expect(setupSandboxArgs('/work', '/scratch', 'true', true, [])).toContain('--share-net')
  })
})

describe('Linux setup sandbox', () => {
  it('kills a real preparation process on timeout and never records success', async () => {
    const input = {...fixture(), directories: [], setup: {run: 'unused', network: false, timeout: 1}}
    const root = dir()
    const pidFile = path.join(root, 'pid')
    const ready = barrier()
    const watcher = fs.watch(root, (_event, file) => {
      if (file === 'pid' && fs.existsSync(pidFile) && fs.readFileSync(pidFile, 'utf8').trim()) ready.resolve()
    })
    vi.useFakeTimers({toFake: ['setTimeout', 'clearTimeout']})
    let killed = false
    const preparation = prepareRepository(input, {root, resolveTools: () => [], backend: {
      available: () => ({available: true}),
      prepare: () => ({
        identity: 'test-process-group',
        command: {cmd: '/bin/sh', args: ['-c', `echo $$ > '${pidFile}'; sleep 60 & wait`], cwd: input.cwd},
        signal: () => {
          killed = true
          if (fs.existsSync(pidFile)) {
            const pid = Number(fs.readFileSync(pidFile, 'utf8').trim())
            try { process.kill(-pid, 'SIGKILL') } catch { /* Already gone. */ }
          }
          return true
        },
        empty: () => true,
      }),
    }})
    const rejected = expect(preparation).rejects.toThrow(/timeout/)
    try {
      await ready.promise
      await vi.advanceTimersByTimeAsync(1000)
      await rejected
    } finally { watcher.close() }
    expect(killed).toBe(true)
    const pid = Number(fs.readFileSync(pidFile, 'utf8').trim())
    expect(() => process.kill(pid, 0)).toThrow()
    expect(fs.readdirSync(root).filter((name) => name.endsWith('.json'))).toEqual([])
  })
  it('cannot read outside credentials, inherit tokens, or write outside the checkout', (context) => {
    const cwd = dir()
    const scratch = dir()
    const outside = dir()
    const secret = path.join(outside, 'credential')
    fs.writeFileSync(secret, 'synthetic-secret')
    const probe = spawnSync('/usr/bin/bwrap', setupSandboxArgs(cwd, scratch, 'true', false, []), {encoding: 'utf8'})
    if (probe.status !== 0) {
      context.skip(`Linux user namespaces/bubblewrap unavailable: ${probe.stderr || probe.error?.message}`)
      return
    }
    const script = `test -z "$SETUP_TEST_TOKEN" && test ! -r '${secret}' && ! touch /usr/forbidden && echo ready > ready`
    const result = spawnSync('/usr/bin/bwrap', setupSandboxArgs(cwd, scratch, script, false, []), {
      encoding: 'utf8', env: {...process.env, SETUP_TEST_TOKEN: 'synthetic-token'},
    })
    expect(result.status).toBe(0)
    expect(fs.readFileSync(path.join(cwd, 'ready'), 'utf8').trim()).toBe('ready')
    expect(fs.readFileSync(secret, 'utf8')).toBe('synthetic-secret')
  })
})
