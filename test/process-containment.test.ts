import {describe, expect, it} from 'vitest'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import {spawnSync} from 'node:child_process'
import {
  createStrongContainmentBackend,
  createSystemdContainmentBackend,
  defaultSystemdContainmentIo,
  type ContainmentCommand,
  type StrongContainmentBackend,
  type SystemdContainmentIo,
} from '../src/lib/process-containment'
import {runAction} from '../src/lib/executor'
import {PlaybookSchema} from '../src/lib/schema'

const command: ContainmentCommand = {cmd: '/trusted/sh', args: ['-c', 'echo "$HOME"'], cwd: '/repo'}

function fakeIo(overrides: Partial<SystemdContainmentIo> = {}): {io: SystemdContainmentIo; calls: string[][]} {
  const calls: string[][] = []
  const io: SystemdContainmentIo = {
    platform: 'linux',
    cgroupRoot: '/sys/fs/cgroup',
    systemdRun: '/usr/bin/systemd-run',
    systemctl: '/usr/bin/systemctl',
    trustedExecutable: () => true,
    exists: (file) => file === '/sys/fs/cgroup/cgroup.controllers',
    readFile: (file) => file.endsWith('cgroup.procs') ? '' : '',
    run: (cmd, args) => {
      calls.push(args)
      if (cmd.endsWith('systemd-run') && args.includes('--version')) return {status: 0, stdout: 'systemd 254\n'}
      if (args.includes('--property=Version')) return {status: 0, stdout: '254\n'}
      if (args.includes('--property=LoadState')) {
        return {status: 0, stdout: 'LoadState=loaded\nControlGroup=/user.slice/action.scope\n'}
      }
      return {status: 0, stdout: ''}
    },
    randomId: () => '0123456789abcdef0123456789abcdef',
    ...overrides,
  }
  return {io, calls}
}

describe('systemd strong containment', () => {
  it('runs the system probes without blocking the daemon event loop', async () => {
    const io = defaultSystemdContainmentIo()
    let timerFired = false
    const probe = io.run('/bin/sh', ['-c', 'sleep 0.05; printf ok'])
    setTimeout(() => { timerFired = true }, 10)
    await new Promise((resolve) => setTimeout(resolve, 20))
    expect(timerFired).toBe(true)
    await expect(probe).resolves.toEqual({status: 0, stdout: 'ok'})

    const uid = process.getuid?.()
    if (uid !== undefined) {
      const environment = await io.run('/usr/bin/env', [])
      expect(environment.stdout).toContain(`XDG_RUNTIME_DIR=/run/user/${uid}\n`)
      expect(environment.stdout).toContain(`DBUS_SESSION_BUS_ADDRESS=unix:path=/run/user/${uid}/bus\n`)
    }
  })

  it('wraps the command in a unique cgroup scope without expanding argv or environment', async () => {
    const {io, calls} = fakeIo()
    const backend = createSystemdContainmentBackend(io)
    await expect(backend.available()).resolves.toEqual({available: true})

    const handle = await backend.prepare(command)
    expect(handle.identity).toBe('automator-action-0123456789abcdef0123456789abcdef.scope')
    expect(handle.command).toEqual({
      cmd: '/usr/bin/systemd-run',
      cwd: '/repo',
      args: [
        '--user', '--scope', '--quiet', '--collect', '--expand-environment=no',
        '--unit=automator-action-0123456789abcdef0123456789abcdef.scope',
        '--property=KillMode=control-group', '--property=SendSIGKILL=yes',
        '--property=TimeoutStopSec=1ms', '--', '/trusted/sh', '-c', 'echo "$HOME"',
      ],
    })
    expect(calls.filter((args) => args.includes('--version'))).toHaveLength(1)
  })

  it('SIGTERM and SIGKILL target the cgroup by unique identity, not a reusable PID', async () => {
    const {io, calls} = fakeIo()
    const handle = await createSystemdContainmentBackend(io).prepare(command)
    await handle.signal('SIGTERM')
    await handle.signal('SIGKILL')

    expect(calls.slice(-3)).toEqual([
      ['--user', 'kill', '--kill-whom=cgroup', '--signal=SIGTERM', handle.identity],
      ['--user', 'kill', '--kill-whom=cgroup', '--signal=SIGKILL', handle.identity],
      ['--user', 'stop', handle.identity],
    ])
  })

  it('proves the cgroup empty and rejects an identity change during the cleanup', async () => {
    let controlGroup = '/user.slice/action.scope'
    const {io} = fakeIo({
      run: (cmd, args) => {
        if (cmd.endsWith('systemd-run')) return {status: 0, stdout: 'systemd 254\n'}
        if (args.includes('--property=Version')) return {status: 0, stdout: '254\n'}
        if (args.includes('--property=LoadState')) return {status: 0, stdout: `LoadState=loaded\nControlGroup=${controlGroup}\n`}
        return {status: 0, stdout: ''}
      },
    })
    const handle = await createSystemdContainmentBackend(io).prepare(command)
    await expect(handle.empty()).resolves.toBe(true)
    controlGroup = '/user.slice/reused.scope'
    await expect(handle.empty()).rejects.toThrow(/identity cgroup cambiata/)
  })

  it('does not approve cgroups with processes, path traversal or ambiguous probes', async () => {
    const running = fakeIo({readFile: () => '123\n'}).io
    const runningHandle = await createSystemdContainmentBackend(running).prepare(command)
    await expect(runningHandle.empty()).resolves.toBe(false)

    const escaped = fakeIo({
      run: (cmd, args) => {
        if (cmd.endsWith('systemd-run')) return {status: 0, stdout: 'systemd 254\n'}
        if (args.includes('--property=Version')) return {status: 0, stdout: '254\n'}
        if (args.includes('--property=LoadState')) return {status: 0, stdout: 'LoadState=loaded\nControlGroup=/../../tmp/evil\n'}
        return {status: 0, stdout: ''}
      },
    }).io
    const escapedHandle = await createSystemdContainmentBackend(escaped).prepare(command)
    await expect(escapedHandle.empty()).rejects.toThrow(/path cgroup non valido/)

    const ambiguous = fakeIo({
      run: (cmd, args) => {
        if (cmd.endsWith('systemd-run')) return {status: 0, stdout: 'systemd 254\n'}
        if (args.includes('--property=Version')) return {status: 0, stdout: '254\n'}
        return {status: 1, stdout: ''}
      },
    }).io
    const ambiguousHandle = await createSystemdContainmentBackend(ambiguous).prepare(command)
    await expect(ambiguousHandle.empty()).rejects.toThrow(/sonda systemd fallita/)
  })

  it.each([
    ['darwin', {platform: 'darwin' as const}],
    ['cgroup v2 missing', {exists: () => false}],
    ['untrusted systemd', {trustedExecutable: () => false}],
    ['user manager not reachable', {run: () => ({status: 1, stdout: ''})}],
  ])('stays fail-closed when strong is required but %s', async (_label, override) => {
    const {io} = fakeIo(override)
    expect((await createSystemdContainmentBackend(io).available()).available).toBe(false)
  })

  it.each([
    ['versione systemd obsoleta', {run: (_cmd: string, args: string[]) => args.includes('--version') ? {status: 0, stdout: 'systemd 253\n'} : {status: 0, stdout: '254\n'}}],
    ['versione systemd non interpretabile', {run: () => ({status: 0, stdout: 'unknown\n'})}],
    ['versione user manager vuota', {run: (_cmd: string, args: string[]) => args.includes('--version') ? {status: 0, stdout: 'systemd 254\n'} : {status: 0, stdout: ''}}],
  ])('rifiuta %s', async (_label, override) => {
    expect((await createSystemdContainmentBackend(fakeIo(override).io).available()).available).toBe(false)
  })

  it('rejects invalid generated identities and incomplete show responses', async () => {
    const invalidIdentity = fakeIo({randomId: () => '../scope'}).io
    await expect(createSystemdContainmentBackend(invalidIdentity).prepare(command)).rejects.toThrow(/identita containment non valida/)

    const invalidShow = fakeIo({
      run: (cmd, args) => {
        if (cmd.endsWith('systemd-run')) return {status: 0, stdout: 'systemd 254\n'}
        if (args.includes('--property=Version')) return {status: 0, stdout: '254\n'}
        return {status: 0, stdout: 'LoadState=loaded\n'}
      },
    }).io
    const invalidShowHandle = await createSystemdContainmentBackend(invalidShow).prepare(command)
    await expect(invalidShowHandle.empty()).rejects.toThrow(/risposta systemd non valida/)
  })

  it('distinguishes an already collected unit from signal and stop errors', async () => {
    const makeIo = (
      loadState: string,
      failures: {kill?: boolean; stop?: boolean; stopTimeout?: boolean} = {},
    ) => fakeIo({
      run: (cmd, args) => {
        if (cmd.endsWith('systemd-run')) return {status: 0, stdout: 'systemd 254\n'}
        if (args.includes('--property=Version')) return {status: 0, stdout: '254\n'}
        if (args.includes('--property=LoadState')) return {status: 0, stdout: `LoadState=${loadState}\nControlGroup=/user.slice/action.scope\n`}
        if (failures.kill && args.includes('kill')) return {status: 1, stdout: ''}
        if (failures.stop && args.includes('stop')) {
          return {status: failures.stopTimeout ? null : 1, stdout: ''}
        }
        return {status: 0, stdout: ''}
      },
    }).io

    const missing = await createSystemdContainmentBackend(makeIo('not-found', {kill: true})).prepare(command)
    await expect(missing.signal('SIGTERM')).resolves.toBe(false)
    const fallbackSignal = await createSystemdContainmentBackend(makeIo('loaded', {kill: true})).prepare(command)
    await expect(fallbackSignal.signal('SIGTERM')).resolves.toBe(true)
    const fallbackKill = await createSystemdContainmentBackend(makeIo('loaded', {kill: true})).prepare(command)
    await expect(fallbackKill.signal('SIGKILL')).resolves.toBe(true)
    const failedSignal = await createSystemdContainmentBackend(makeIo('loaded', {kill: true, stop: true})).prepare(command)
    await expect(failedSignal.signal('SIGTERM')).rejects.toThrow(/stop del cgroup fallito/)
    const timedOutSignal = await createSystemdContainmentBackend(
      makeIo('loaded', {kill: true, stop: true, stopTimeout: true}),
    ).prepare(command)
    await expect(timedOutSignal.signal('SIGTERM')).rejects.toThrow(/status=timeout/)

    const failedStopNotFound = await createSystemdContainmentBackend(makeIo('not-found', {stop: true})).prepare(command)
    await expect(failedStopNotFound.signal('SIGKILL')).resolves.toBe(true)
    const failedStopLoaded = await createSystemdContainmentBackend(makeIo('loaded', {stop: true})).prepare(command)
    await expect(failedStopLoaded.signal('SIGKILL')).rejects.toThrow(/stop del cgroup fallito/)
  })

  it('reconfirms the unit collection when cgroup.procs disappears', async () => {
    let probe = 0
    const io = fakeIo({
      readFile: () => { throw new Error('gone') },
      run: (cmd, args) => {
        if (cmd.endsWith('systemd-run')) return {status: 0, stdout: 'systemd 254\n'}
        if (args.includes('--property=Version')) return {status: 0, stdout: '254\n'}
        if (args.includes('--property=LoadState')) {
          probe += 1
          const state = probe === 1 ? 'loaded' : 'not-found'
          return {status: 0, stdout: `LoadState=${state}\nControlGroup=/user.slice/action.scope\n`}
        }
        return {status: 0, stdout: ''}
      },
    }).io
    const gone = await createSystemdContainmentBackend(io).prepare(command)
    await expect(gone.empty()).resolves.toBe(true)

    const stillLoaded = fakeIo({readFile: () => { throw new Error('permission denied') }}).io
    const stillLoadedHandle = await createSystemdContainmentBackend(stillLoaded).prepare(command)
    await expect(stillLoadedHandle.empty()).rejects.toThrow(/cgroup.procs non verificabile/)
  })
})

describe('Linux strong containment selection', () => {
  const unavailable: StrongContainmentBackend = {
    available: async () => ({available: false, detail: 'systemd-sentinel'}),
    prepare: () => { throw new Error('systemd-sentinel') },
  }

  it('uses only the injected systemd backend', async () => {
    await expect(createStrongContainmentBackend('linux', unavailable).available())
      .resolves.toMatchObject({detail: 'systemd-sentinel'})
  })

  it('a non-Linux platform fails closed through the systemd probe', async () => {
    await expect(createStrongContainmentBackend('darwin').available())
      .resolves.toMatchObject({available: false, detail: expect.stringMatching(/solo su Linux/)})
  })
})

const realSystemd = createSystemdContainmentBackend()
const realStrongAvailable = (await realSystemd.available()).available
const requireRealStrong = process.env.AUTOMATOR_REQUIRE_STRONG_CONTAINMENT_TEST === '1'

it.runIf(requireRealStrong)('Linux CI really exposes systemd --user for the strong test', () => {
  expect(realStrongAvailable).toBe(true)
})

describe.runIf(realStrongAvailable)('systemd strong containment reale', () => {
  it('also kills a descendant escaping the PGID with setsid', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'automator-strong-setsid-'))
    expect(spawnSync('git', ['init', '-q', root]).status).toBe(0)
    const source = [
      "const {spawn}=require('node:child_process')",
      "const escaped=spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{detached:true,stdio:'ignore'})",
      "process.stdout.write(JSON.stringify({pid:escaped.pid,cwd:process.cwd(),marker:process.env.AUTOMATOR_STRONG_MARKER})+'\\n')",
      'escaped.unref()',
      'setInterval(()=>{},1000)',
    ].join(';')
    fs.writeFileSync(path.join(root, 'escape.cjs'), source)
    const action = PlaybookSchema.parse({
      version: 1,
      actions: {a: {
        type: 'shell', schedule: 'every 1m', run: 'node escape.cjs',
        timeout: 3, containment: 'strong', env: {vars: {AUTOMATOR_STRONG_MARKER: 'preserved'}},
      }},
    }).actions.a
    let escapedPid: number | undefined
    try {
      const result = await runAction('setsid', action, {
        playbookDir: root,
        logDir: root,
        now: new Date('2026-07-14T00:00:00Z'),
        resolveExecutable: (command) => command === 'sh' ? '/bin/sh' : command,
      })
      expect(result).toMatchObject({status: 'timeout', errorCode: 'C124-EXEC-001'})
      expect(result.stdout.trim()).not.toBe('')
      const observed = JSON.parse(result.stdout.trim()) as {pid: number; cwd: string; marker: string}
      escapedPid = observed.pid
      expect(Number.isSafeInteger(escapedPid)).toBe(true)
      expect(observed).toMatchObject({cwd: fs.realpathSync(root), marker: 'preserved'})
      expect(() => process.kill(escapedPid!, 0)).toThrow()
    } finally {
      if (escapedPid) {
        try { process.kill(escapedPid, 'SIGKILL') } catch { /* gia bonificato */ }
      }
      fs.rmSync(root, {recursive: true, force: true})
    }
  }, 30_000)
})
