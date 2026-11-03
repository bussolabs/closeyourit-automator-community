import {describe, expect, it} from 'vitest'
import {execFileSync} from 'node:child_process'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import {
  createVmContainmentBackend,
  defaultVmContainmentIo,
  parseVmContainmentConfig,
  serializeGuestEnv,
  type VmContainmentConfig,
  type VmContainmentIo,
} from '../src/lib/vm-containment'

const config: VmContainmentConfig = {
  incus: '/usr/bin/incus',
  image: 'automator-guest',
  pool: 'ca-pool',
  networks: ['ca-slot0', 'ca-slot1'],
  proxies: ['http://10.77.0.1:3128', 'http://10.77.1.1:3128'],
  cpu: 4,
  memory_gib: 8,
  disk_gib: 40,
  lease_seconds: 7200,
  uid: 1001,
  gid: 1001,
  launcher: '/opt/automator/run-with-env',
  env_file: '/run/automator/env',
  read_only_paths: ['/home/automator/.local/share/mise', '/home/automator/.config/closeyourit-automator'],
}

const command = {cmd: '/home/automator/.local/bin/claude', args: ['-p', 'hello $HOME'], cwd: '/home/automator/work/repo'}

interface Call {args: string[]; input?: string}

function fakeIo(options: {instances?: Array<Record<string, unknown>>; fail?: (args: string[]) => boolean} = {}) {
  const calls: Call[] = []
  let live = [...(options.instances ?? [])]
  const io: VmContainmentIo = {
    platform: 'linux',
    home: '/home/automator',
    readConfig: () => config,
    trustedExecutable: () => true,
    gitCommonDir: () => '/home/automator/.local/share/closeyourit-automator/repositories/repo/.git',
    run: async (args, input) => {
      calls.push({args, input})
      if (options.fail?.(args)) return {status: 1, stdout: ''}
      if (args[0] === 'list') return {status: 0, stdout: JSON.stringify(live)}
      if (args[0] === 'init') {
        const slot = args.find((arg) => arg.startsWith('user.automator.slot='))?.split('=')[1]
        live.push({name: args[2], config: {'user.automator.managed': 'true', 'user.automator.slot': slot}})
      }
      if (args[0] === 'delete') live = live.filter((item) => item.name !== args[1])
      return {status: 0, stdout: ''}
    },
    withLock: (fn) => fn(),
    randomId: () => '0123456789abcdef0123456789abcdef',
    now: () => 1_000_000,
    sleep: async () => {},
  }
  return {io, calls, live: () => live}
}

const NAME = 'ca-run-0123456789abcdef0123456789abcdef'

describe('vm containment config', () => {
  it('accepts a complete config and rejects unknown keys', () => {
    expect(parseVmContainmentConfig(config)).toEqual(config)
    expect(() => parseVmContainmentConfig({...config, extra: true})).toThrow()
  })

  it('rejects relative paths and an empty slot list', () => {
    expect(() => parseVmContainmentConfig({...config, read_only_paths: ['relative/dir']})).toThrow()
    expect(() => parseVmContainmentConfig({...config, networks: []})).toThrow()
    expect(() => parseVmContainmentConfig({...config, proxies: ['http://10.77.0.1:3128']})).toThrow()
  })
})

describe('guest environment', () => {
  it('serializes variables NUL-separated so values may hold any text', () => {
    expect(serializeGuestEnv({A: 'one two', B: 'x=y\nz', SKIP: undefined})).toBe('A=one two\0B=x=y\nz\0')
  })

  it('rejects a variable name that would break the format', () => {
    expect(() => serializeGuestEnv({'BAD=NAME': 'v'})).toThrow()
  })
})

describe('vm strong containment', () => {
  it('is unavailable off Linux or without a host config', async () => {
    const off = fakeIo()
    await expect(createVmContainmentBackend({...off.io, platform: 'darwin'}).available())
      .resolves.toMatchObject({available: false})
    const missing = fakeIo()
    await expect(createVmContainmentBackend({...missing.io, readConfig: () => null}).available())
      .resolves.toMatchObject({available: false})
  })

  it('creates a dedicated VM on a free slot with the workspace and read-only mounts', async () => {
    const {io, calls} = fakeIo({instances: [{name: 'ca-run-other', config: {'user.automator.managed': 'true', 'user.automator.slot': '0'}}]})
    await createVmContainmentBackend(io).prepare({...command, env: {GH_TOKEN: 'ghs_secret'}})

    const init = calls.find((call) => call.args[0] === 'init')!.args
    expect(init.slice(0, 4)).toEqual(['init', 'automator-guest', NAME, '--vm'])
    // The user project cannot name a default-project network: the NIC sits on the slot bridge directly.
    expect(init.some((arg) => arg.startsWith('--network'))).toBe(false)
    expect(init).toContain('limits.memory=8GiB')
    // The worktree reaches the guest through virtiofsd: without a 1:1 map the daemon user's files show as nobody.
    expect(init).toContain(`raw.idmap=both ${process.getuid!()} ${process.getuid!()}`)
    expect(init).toContain('user.automator.slot=1')
    expect(init).toContain(`user.automator.expires=${1_000_000 / 1000 + 7200}`)
    const devices = calls.filter((call) => call.args[0] === 'config' && call.args[2] === 'add').map((call) => call.args)
    expect(devices).toContainEqual(['config', 'device', 'add', NAME, 'eth0', 'nic', 'nictype=bridged', 'parent=ca-slot1'])
    expect(devices).toContainEqual(['config', 'device', 'add', NAME, 'workspace', 'disk',
      'source=/home/automator/work/repo', 'path=/home/automator/work/repo'])
    expect(devices).toContainEqual(['config', 'device', 'add', NAME, 'ro0', 'disk',
      'source=/home/automator/.local/share/mise', 'path=/home/automator/.local/share/mise', 'readonly=true'])
  })

  it('shares the git common dir of a worktree read-write, and nothing for a plain checkout', async () => {
    const {io, calls} = fakeIo()
    await createVmContainmentBackend(io).prepare(command)
    expect(calls.map((call) => call.args)).toContainEqual(['config', 'device', 'add', NAME, 'gitdir', 'disk',
      'source=/home/automator/.local/share/closeyourit-automator/repositories/repo/.git',
      'path=/home/automator/.local/share/closeyourit-automator/repositories/repo/.git'])

    const plain = fakeIo()
    plain.io.gitCommonDir = () => null
    await createVmContainmentBackend(plain.io).prepare(command)
    expect(plain.calls.some((call) => call.args.includes('gitdir'))).toBe(false)
  })

  it('refuses a new VM when every slot is taken', async () => {
    const taken = config.networks.map((_, slot) => ({name: `ca-run-${slot}`, config: {'user.automator.managed': 'true', 'user.automator.slot': String(slot)}}))
    const {io, calls} = fakeIo({instances: taken})
    await expect(createVmContainmentBackend(io).prepare(command)).rejects.toThrow('vm_capacity_reached')
    expect(calls.some((call) => call.args[0] === 'init')).toBe(false)
  })

  it('keeps secrets off every argv: they reach the guest through a 0600 file', async () => {
    const {io, calls} = fakeIo()
    const handle = await createVmContainmentBackend(io).prepare({...command, env: {GH_TOKEN: 'ghs_secret', PATH: '/x'}})

    expect(calls.flatMap((call) => call.args).join(' ')).not.toContain('ghs_secret')
    expect(handle.command.args.join(' ')).not.toContain('ghs_secret')
    expect(JSON.stringify(handle.command.env)).not.toContain('ghs_secret')
    const push = calls.find((call) => call.args[0] === 'file')!
    expect(push.args).toEqual(['file', 'push', '-', `${NAME}/run/automator/env`, '--mode=0600', '--uid=1001', '--gid=1001', '--create-dirs'])
    expect(push.input).toContain('GH_TOKEN=ghs_secret\0')
    expect(push.input).toContain('HTTPS_PROXY=http://10.77.0.1:3128\0')

    // The second slot sits on its own bridge: its proxy is that bridge's gateway.
    const second = fakeIo({instances: [{name: 'ca-run-other', config: {'user.automator.managed': 'true', 'user.automator.slot': '0'}}]})
    await createVmContainmentBackend(second.io).prepare(command)
    expect(second.calls.find((call) => call.args[0] === 'file')!.input).toContain('HTTPS_PROXY=http://10.77.1.1:3128\0')
  })

  it('runs the unchanged argv inside the VM through the launcher', async () => {
    const {io} = fakeIo()
    const handle = await createVmContainmentBackend(io).prepare(command)
    expect(handle.identity).toBe(NAME)
    expect(handle.command).toEqual({
      cmd: '/usr/bin/incus',
      cwd: '/home/automator/work/repo',
      env: {PATH: '/usr/bin:/bin', LANG: 'C.UTF-8', HOME: '/home/automator'},
      args: ['exec', NAME, '--user=1001', '--group=1001', '--cwd=/home/automator/work/repo', '--',
        '/opt/automator/run-with-env', '/run/automator/env', '/home/automator/.local/bin/claude', '-p', 'hello $HOME'],
    })
  })

  it('deletes the VM when any setup step fails', async () => {
    const {io, live} = fakeIo({fail: (args) => args[0] === 'start'})
    await expect(createVmContainmentBackend(io).prepare(command)).rejects.toThrow()
    expect(live().map((item) => item.name)).not.toContain(NAME)
  })

  it('stops the VM on a signal and proves emptiness only once it is deleted', async () => {
    const {io, calls, live} = fakeIo()
    const handle = await createVmContainmentBackend(io).prepare(command)

    await expect(handle.signal('SIGTERM')).resolves.toBe(true)
    expect(calls.at(-1)!.args).toEqual(['stop', NAME, '--force'])
    await expect(handle.empty()).resolves.toBe(true)
    expect(live()).toHaveLength(0)
    await expect(handle.signal('SIGKILL')).resolves.toBe(false)
  })

  it('never deletes an instance it does not own', async () => {
    const {io} = fakeIo()
    const handle = await createVmContainmentBackend(io).prepare(command)
    const foreign = fakeIo({instances: [{name: NAME, config: {}}]})
    io.run = foreign.io.run
    await expect(handle.empty()).rejects.toThrow('ownership_not_confirmed')
  })
})

describe('worktree git dir discovery', () => {
  it('finds the shared git dir of a real linked worktree and null for the main checkout', () => {
    const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'vm-gitdir-')))
    const repo = path.join(root, 'repo')
    const git = (...args: string[]) => execFileSync('git', args, {cwd: repo, stdio: 'ignore'})
    fs.mkdirSync(repo)
    git('init', '-q', '-b', 'main')
    git('-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-q', '--allow-empty', '-m', 'init')
    git('worktree', 'add', '-q', path.join(root, 'wt'), '-b', 'ticket/x')

    const io = defaultVmContainmentIo()
    expect(io.gitCommonDir(path.join(root, 'wt'))).toBe(path.join(repo, '.git'))
    expect(io.gitCommonDir(repo)).toBeNull()
    fs.rmSync(root, {recursive: true, force: true})
  })
})

describe('guest launcher', () => {
  it('loads the env file, deletes it, and execs the command with exactly those variables', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vm-launcher-'))
    const envFile = path.join(dir, 'env')
    fs.writeFileSync(envFile, serializeGuestEnv({GH_TOKEN: 'ghs_launch', MULTI: 'a\nb', HOME: dir}), {mode: 0o600})
    const launcher = path.resolve('deploy/ax41/run-with-env')

    const out = execFileSync('python3', ['-I', launcher, envFile, '/usr/bin/env'], {encoding: 'utf8', env: {PATH: '/usr/bin:/bin'}})

    expect(out).toContain('GH_TOKEN=ghs_launch\n')
    expect(out).toContain('MULTI=a\nb\n')
    expect(out).toContain(`BUNDLE_PATH=${dir}/.cache/bundle\n`)
    expect(out).not.toContain('PATH=/usr/bin:/bin')
    expect(fs.existsSync(envFile)).toBe(false)
    fs.rmSync(dir, {recursive: true, force: true})
  })
  it('starts a copy of the binary when the read-only share cannot exec it (EFAULT)', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vm-launcher-'))
    const tool = path.join(dir, 'tool')
    fs.writeFileSync(tool, '#!/bin/sh\necho real\n', {mode: 0o755})
    const launcher = path.resolve('deploy/ax41/run-with-env')
    // The share's exec failure cannot be reproduced on a test host: the first execve fails with EFAULT, the
    // second one is recorded instead of replacing the process.
    const probe = [
      'import errno, importlib.machinery, importlib.util, os, sys',
      `loader = importlib.machinery.SourceFileLoader('launcher', ${JSON.stringify(launcher)})`,
      'spec = importlib.util.spec_from_loader(loader.name, loader)',
      'module = importlib.util.module_from_spec(spec)',
      'loader.exec_module(module)',
      'calls = []',
      'def fake(path, argv, env):',
      '    calls.append(path)',
      '    if len(calls) == 1:',
      '        raise OSError(errno.EFAULT, "Bad address")',
      '    print("EXEC", path, argv, open(path).read() == open(sys.argv[1]).read(), oct(os.stat(path).st_mode & 0o777))',
      'module.exec_agent(sys.argv[1], [sys.argv[1], "--version"], {"PATH": "/usr/bin:/bin"}, execve=fake)',
    ].join('\n')

    const out = execFileSync('python3', ['-I', '-c', probe, tool], {encoding: 'utf8'})

    expect(out).toMatch(/^EXEC (\S+) \['(\S+)', '--version'\] True 0o700\n$/)
    const copied = out.split(' ')[1]
    expect(copied).not.toBe(tool)
    expect(out).toContain(`['${tool}', '--version']`)
    fs.rmSync(dir, {recursive: true, force: true})
  })
})
