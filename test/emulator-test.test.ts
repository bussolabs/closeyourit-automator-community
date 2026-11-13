import type {ChildProcess} from 'node:child_process'
import {EventEmitter} from 'node:events'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import {afterEach, beforeEach, describe, expect, it, vi, type Mock} from 'vitest'
import {
  BWRAP,
  EMULATOR_SERIAL,
  buildEnvironment,
  buildLimits,
  composeBuildArgs,
  createToolVersionCache,
  defaultEmulatorIo,
  defaultEvidenceRunner,
  detectCrash,
  emulatorArgs,
  emulatorLockPath,
  emulatorToolRuntimes,
  hiddenPathCandidates,
  isPng,
  publishEmulatorEvidence,
  resolveAndroidTools,
  runEmulatorTest,
  screenshotName,
  selectHiddenPaths,
  toolVersion,
  type EmulatorEvidenceCommand,
  type EmulatorIo,
  type EmulatorRunOptions,
  type EmulatorRunOutcome,
  type KillGroup,
  type SpawnProcess,
} from '../src/lib/emulator-test'
import type {StrongContainmentBackend} from '../src/lib/process-containment'
import {EmulatorTestConfigSchema} from '../src/lib/quality-gate'

const directories: string[] = []
function temporaryDirectory(): string {
  const directory = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'automator-emulator-test-')))
  directories.push(directory)
  return directory
}
afterEach(() => {
  vi.unstubAllEnvs()
  for (const directory of directories.splice(0)) fs.rmSync(directory, {recursive: true, force: true})
})

const HIDDEN = {dirs: ['/home/a/.config', '/home/a/.ssh', '/state'], files: ['/home/a/.netrc']}
const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.from('picture')])
const APP = 'it.example.app'
const config = EmulatorTestConfigSchema.parse({
  platform: 'android', app_id: APP, build: 'flutter build apk --debug',
  artifact: 'build/app/outputs/flutter-apk/app-debug.apk', observe: 5, boot_timeout: 60,
})

type Reply = Partial<Omit<EmulatorRunOutcome, 'stdout'>> & {stdout?: string | Buffer}

/** Fake machine: every adb command is answered by the first key its arguments start with. */
function fakeIo(replies: Record<string, Reply> = {}, overrides: Partial<EmulatorIo> = {}) {
  const calls: Array<{cmd: string; args: string[]; opts: EmulatorRunOptions}> = []
  const stop = vi.fn(async () => undefined)
  let clock = 0
  const defaults: Record<string, Reply> = {
    'shell getprop': {stdout: '1\n'},
    install: {stdout: 'Performing Streamed Install\nSuccess\n'},
    'shell monkey': {stdout: 'Events injected: 1\n'},
    'shell pidof': {stdout: '4242\n'},
    'exec-out': {stdout: PNG},
  }
  const answer = async (cmd: string, args: string[], opts: EmulatorRunOptions): Promise<EmulatorRunOutcome> => {
    calls.push({cmd, args, opts})
    const key = cmd === BWRAP ? 'build' : args.slice(2).join(' ')
    const pick = (table: Record<string, Reply>) => Object.entries(table).find(([prefix]) => key.startsWith(prefix))?.[1]
    const reply = {...pick(defaults), ...pick(replies)}
    const stdout = reply.stdout === undefined ? Buffer.alloc(0) : Buffer.isBuffer(reply.stdout) ? reply.stdout : Buffer.from(reply.stdout)
    return {code: 0, stderr: '', timedOut: false, ...reply, stdout}
  }
  const io: EmulatorIo = {
    run: vi.fn(answer),
    runContained: vi.fn(answer),
    containmentAvailable: vi.fn(async () => ({available: true})),
    start: vi.fn(() => ({stop})),
    sleep: vi.fn(async (ms: number) => {
      clock += ms
    }),
    now: () => clock,
    kvmUsable: () => true,
    resolveTools: () => ({emulator: '/sdk/emulator/emulator', adb: '/sdk/platform-tools/adb'}),
    bwrapAvailable: () => true,
    hiddenPaths: () => HIDDEN,
    fileInside: vi.fn((root: string, relative: string) => path.join(root, relative)),
    makeScratch: vi.fn(() => '/state/emulator-build/CYAU-1'),
    removeScratch: vi.fn(),
    acquireLock: vi.fn(() => true),
    releaseLock: vi.fn(),
    ...overrides,
  }
  const adbCalls = () => calls.filter((call) => call.cmd !== BWRAP).map((call) => call.args.slice(2).join(' '))
  return {io, calls, adbCalls, stop}
}

// Fake credentials assembled from pieces, so the diff carries no token-shaped literal.
const FAKE_GH_TOKEN = ['ghs', 'fake'].join('_')
const FAKE_HOST_TOKEN = ['cyi', 'ah', 'FAKEFAKEFAKEFAKE'].join('_')

const input = {config, cwd: '/worktrees/CYAU/CYAU-1', ticket: 'CYAU-1', env: {PATH: '/usr/bin', ['GH_' + 'TOKEN']: FAKE_GH_TOKEN, HOME: '/home/a'}}

describe('runEmulatorTest', () => {
  it('builds confined, boots, installs, launches, reads the logs, takes the screenshot and shuts down', async () => {
    const {io, calls, adbCalls, stop} = fakeIo()

    const report = await runEmulatorTest(input, io)

    expect(report).toEqual({
      status: 'passed', summary: expect.stringContaining(`l'app ${APP} è rimasta aperta 5 s`), screenshot: PNG,
    })
    const build = calls[0]
    expect(build.cmd).toBe(BWRAP)
    // The build runs in the sessions' containment, with the credentials hidden and no network by default.
    expect(io.runContained).toHaveBeenCalledTimes(1)
    expect(build.args).toEqual(composeBuildArgs({
      worktree: input.cwd, scratch: '/state/emulator-build/CYAU-1', script: config.build, hidden: HIDDEN, network: false,
    }))
    expect(build.args).toContain('--unshare-net')
    expect(build.opts.timeoutMs).toBe(1800 * 1000)
    // The build never sees a managed credential.
    expect(build.opts.env?.GH_TOKEN).toBeUndefined()
    expect(io.start).toHaveBeenCalledWith('/sdk/emulator/emulator', emulatorArgs('closeyourit'), expect.not.objectContaining({['GH_' + 'TOKEN']: expect.anything()}))
    expect(io.run).not.toHaveBeenCalledWith(BWRAP, expect.anything(), expect.anything())
    expect(adbCalls()).toEqual([
      'emu kill', 'wait-for-device', 'shell getprop sys.boot_completed',
      `install -r -g ${input.cwd}/${config.artifact}`, 'logcat -c',
      `shell monkey -p ${APP} -c android.intent.category.LAUNCHER 1`,
      'logcat -d -b main,system,crash', `shell pidof ${APP}`, 'exec-out screencap -p', 'emu kill',
    ])
    expect(calls.filter((call) => call.cmd !== BWRAP).every((call) => call.args[0] === '-s' && call.args[1] === EMULATOR_SERIAL)).toBe(true)
    expect(io.sleep).toHaveBeenCalledWith(5000, undefined)
    expect(stop).toHaveBeenCalledTimes(1)
    expect(io.removeScratch).toHaveBeenCalledWith('/state/emulator-build/CYAU-1')
    expect(io.releaseLock).toHaveBeenCalledTimes(1)
  })

  it('a crash in the logs is a crash, with redacted evidence and the screenshot', async () => {
    const logcat = [
      'I ActivityManager: Start proc 4242:it.example.app/u0a1',
      'E AndroidRuntime: FATAL EXCEPTION: main',
      `E AndroidRuntime: Process: ${APP}, PID: 4242`,
      `E AndroidRuntime: java.lang.IllegalStateException: token ${FAKE_HOST_TOKEN}`,
    ].join('\n')
    const {io, stop} = fakeIo({'logcat -d': {stdout: logcat}})

    const report = await runEmulatorTest(input, io)

    expect(report.status).toBe('crashed')
    if (report.status !== 'crashed') throw new Error('unreachable')
    expect(report.summary).toContain('si è chiusa con un errore')
    expect(report.evidence).toHaveLength(3)
    expect(report.evidence.join('\n')).not.toContain(FAKE_HOST_TOKEN)
    expect(report.screenshot).toEqual(PNG)
    expect(stop).toHaveBeenCalledTimes(1)
  })

  it('an app that is no longer running after the observation is a crash', async () => {
    const {io} = fakeIo({'shell pidof': {code: 1, stdout: ''}, 'exec-out': {stdout: 'error: closed'}})
    const report = await runEmulatorTest(input, io)
    expect(report).toMatchObject({status: 'crashed', summary: expect.stringContaining('non è più in esecuzione'), evidence: [], screenshot: null})
  })

  it('an install refused by the phone is the app\'s fault', async () => {
    const {io} = fakeIo({install: {code: 1, stdout: 'Failure [INSTALL_PARSE_FAILED_NO_CERTIFICATES]'}})
    await expect(runEmulatorTest(input, io)).resolves.toMatchObject({status: 'crashed', summary: expect.stringContaining('non si installa')})
  })

  it('an install exit 0 without "Success" is refused too', async () => {
    const {io} = fakeIo({install: {stdout: 'Failure'}})
    await expect(runEmulatorTest(input, io)).resolves.toMatchObject({status: 'crashed'})
  })

  it('an app without a launcher activity does not open', async () => {
    const {io} = fakeIo({'shell monkey': {stdout: '** No activities found to run, monkey aborted.'}})
    await expect(runEmulatorTest(input, io)).resolves.toMatchObject({status: 'crashed', summary: expect.stringContaining('non si apre')})
  })

  it('a failed launch command does not open the app', async () => {
    const {io} = fakeIo({'shell monkey': {code: 252}})
    await expect(runEmulatorTest(input, io)).resolves.toMatchObject({status: 'crashed'})
  })

  it('an install beyond its time is the machine, not the app', async () => {
    const {io} = fakeIo({install: {timedOut: true, code: null}})
    await expect(runEmulatorTest(input, io)).resolves.toMatchObject({status: 'unavailable'})
  })

  it('a red build is the change\'s to fix: back to the agent with the redacted tail of the build', async () => {
    const stderr = ['Running Gradle task', `token ${FAKE_HOST_TOKEN}`, 'lib/main.dart:3:1: Error: Expected a declaration'].join('\n')
    const {io} = fakeIo({build: {code: 1, stderr}})
    const report = await runEmulatorTest(input, io)
    expect(report).toMatchObject({status: 'crashed', summary: expect.stringContaining('costruzione dell\'app non è riuscita (exit 1)'), screenshot: null})
    if (report.status !== 'crashed') throw new Error('unreachable')
    expect(report.evidence.at(-1)).toContain('Expected a declaration')
    expect(report.evidence.join('\n')).not.toContain(FAKE_HOST_TOKEN)
    // Closed network by default: the summary says how the base branch opens it.
    expect(report.summary).toContain('network: true')
    expect(io.start).not.toHaveBeenCalled()
    expect(io.releaseLock).toHaveBeenCalledTimes(1)
  })

  it('with the network opened by the base branch the build runs online, and a red build does not blame the network', async () => {
    const online = EmulatorTestConfigSchema.parse({...config, network: true})
    const {io, calls} = fakeIo({build: {code: 1, stderr: 'FAILURE: Build failed'}})
    const report = await runEmulatorTest({...input, config: online}, io)
    expect(calls[0].args).not.toContain('--unshare-net')
    expect(report).toMatchObject({status: 'crashed'})
    expect(report.summary).not.toContain('network: true')
  })

  it('waits for the phone another ticket is using, then runs', async () => {
    const acquireLock = vi.fn().mockReturnValueOnce(false).mockReturnValueOnce(false).mockReturnValue(true)
    const {io} = fakeIo({}, {acquireLock})
    await expect(runEmulatorTest(input, io)).resolves.toMatchObject({status: 'passed'})
    expect(acquireLock).toHaveBeenCalledTimes(3)
    expect(io.sleep).toHaveBeenNthCalledWith(1, 15_000, undefined)
    expect(io.releaseLock).toHaveBeenCalledTimes(1)
  })

  it('a phone busy for too long asks for the next round, it is never a skip', async () => {
    const {io, calls} = fakeIo({}, {acquireLock: vi.fn(() => false)})
    const report = await runEmulatorTest(input, io)
    expect(report).toEqual({status: 'unavailable', retry: true, summary: expect.stringContaining('occupato da un\'altra prova')})
    expect(io.now()).toBeGreaterThanOrEqual(45 * 60_000)
    expect(calls).toHaveLength(0)
    // The lock is released only by whoever took it.
    expect(io.releaseLock).not.toHaveBeenCalled()
  })

  it('an abort while waiting for the phone stops waiting', async () => {
    const controller = new AbortController()
    const {io} = fakeIo({}, {acquireLock: vi.fn(() => false), sleep: vi.fn(async () => controller.abort())})
    await expect(runEmulatorTest({...input, signal: controller.signal}, io)).resolves.toMatchObject({retry: true})
    expect(io.sleep).toHaveBeenCalledTimes(1)
  })

  it('takes the screenshot again when the first one is not a picture', async () => {
    const {io, adbCalls} = fakeIo()
    const run = vi.mocked(io.run)
    const original = run.getMockImplementation()!
    let shots = 0
    run.mockImplementation(async (cmd: string, args: string[], opts: EmulatorRunOptions) => {
      const outcome = await original(cmd, args, opts)
      if (args.includes('screencap') && shots++ === 0) return {...outcome, stdout: Buffer.from('error: closed')}
      return outcome
    })
    await expect(runEmulatorTest(input, io)).resolves.toMatchObject({status: 'passed', screenshot: PNG})
    expect(adbCalls().filter((call) => call.includes('screencap'))).toHaveLength(2)
  })

  it('an app that stayed open but left no screenshot is not passed: the next round retries', async () => {
    const {io, stop} = fakeIo({'exec-out': {code: 1, stdout: ''}})
    const report = await runEmulatorTest(input, io)
    expect(report).toEqual({status: 'unavailable', retry: true, summary: expect.stringContaining('la foto dello schermo non è riuscita')})
    expect(stop).toHaveBeenCalledTimes(1)
  })

  describe('the machine cannot run the test: unavailable, never a crash', () => {
    it.each([
      ['no KVM', {kvmUsable: () => false}, '/dev/kvm'],
      ['no emulator', {resolveTools: () => ({adb: '/adb'})}, 'emulatore Android non trovato'],
      ['no adb', {resolveTools: () => ({emulator: '/emulator'})}, 'adb non trovato'],
      ['no bubblewrap', {bwrapAvailable: () => false}, 'bubblewrap'],
      ['no containment', {containmentAvailable: async () => ({available: false, detail: 'cgroup v2 non disponibile'})}, 'cgroup v2 non disponibile'],
      ['no containment, no detail', {containmentAvailable: async () => ({available: false})}, 'motivo non disponibile'],
    ] as Array<[string, Partial<EmulatorIo>, string]>)('%s', async (_name, overrides, reason) => {
      const {io, calls} = fakeIo({}, {...overrides, releaseLock: vi.fn()})
      const report = await runEmulatorTest(input, io)
      expect(report).toEqual({status: 'unavailable', summary: expect.stringContaining(reason)})
      expect(calls).toHaveLength(0)
      expect(io.start).not.toHaveBeenCalled()
      // The lock is released only by whoever took it.
      expect(io.releaseLock).not.toHaveBeenCalled()
    })

    it.each([126, 127])('a build tool this machine cannot run (exit %i) does not start the emulator', async (code) => {
      const {io} = fakeIo({build: {code, stderr: 'sh: 1: flutter: not found\n'}})
      const report = await runEmulatorTest(input, io)
      expect(report).toEqual({status: 'unavailable', summary: expect.stringContaining('flutter: not found')})
      expect(io.start).not.toHaveBeenCalled()
      expect(io.releaseLock).toHaveBeenCalledTimes(1)
    })

    it('a build killed by a signal says so', async () => {
      const {io} = fakeIo({build: {code: null, stderr: 'Killed'}})
      await expect(runEmulatorTest(input, io)).resolves.toMatchObject({status: 'unavailable', summary: expect.stringContaining('interrotta prima di finire: Killed')})
    })

    it('a containment that cannot be prepared is unavailable, with the lock released', async () => {
      const {io} = fakeIo({}, {runContained: vi.fn(async () => { throw new Error('limite MemoryMax non valido') })})
      await expect(runEmulatorTest(input, io)).resolves.toMatchObject({status: 'unavailable', summary: expect.stringContaining('MemoryMax')})
      expect(io.releaseLock).toHaveBeenCalledTimes(1)
      expect(io.removeScratch).toHaveBeenCalledTimes(1)
    })

    it('a build beyond its time', async () => {
      const {io} = fakeIo({build: {timedOut: true, code: null}})
      await expect(runEmulatorTest(input, io)).resolves.toMatchObject({status: 'unavailable', summary: expect.stringContaining('1800 s')})
    })

    it('a missing artifact', async () => {
      const {io} = fakeIo({}, {fileInside: () => null})
      await expect(runEmulatorTest(input, io)).resolves.toMatchObject({status: 'unavailable', summary: expect.stringContaining(config.artifact)})
      expect(io.start).not.toHaveBeenCalled()
    })

    it('a phone that never shows up is shut down anyway', async () => {
      const {io, stop, adbCalls} = fakeIo({'wait-for-device': {timedOut: true, code: null}})
      const report = await runEmulatorTest(input, io)
      expect(report).toMatchObject({status: 'unavailable', summary: expect.stringContaining('non si è avviato')})
      expect(stop).toHaveBeenCalledTimes(1)
      expect(adbCalls().at(-1)).toBe('emu kill')
    })

    it('a slow boot is unavailable, not a crash', async () => {
      const {io, stop} = fakeIo({'shell getprop': {stdout: '\n'}})
      const report = await runEmulatorTest(input, io)
      expect(report).toMatchObject({status: 'unavailable', summary: expect.stringContaining('non ha completato l\'avvio')})
      expect(stop).toHaveBeenCalledTimes(1)
    })

    it('an aborted test shuts everything down', async () => {
      const controller = new AbortController()
      const {io, stop} = fakeIo({}, {
        sleep: vi.fn(async () => controller.abort()),
      })
      const report = await runEmulatorTest({...input, signal: controller.signal}, io)
      expect(report).toMatchObject({status: 'unavailable', summary: expect.stringContaining('annullata')})
      expect(stop).toHaveBeenCalledTimes(1)
      expect(io.releaseLock).toHaveBeenCalledTimes(1)
    })

    it('an unexpected error is unavailable, and the lock is released', async () => {
      const {io} = fakeIo({}, {makeScratch: () => { throw new Error('disk full') }})
      await expect(runEmulatorTest(input, io)).resolves.toMatchObject({status: 'unavailable', summary: expect.stringContaining('disk full')})
      expect(io.releaseLock).toHaveBeenCalledTimes(1)
      expect(io.removeScratch).not.toHaveBeenCalled()
    })

    it('a non-Error throw is described too', async () => {
      const {io} = fakeIo({}, {makeScratch: () => { throw 'boom' as unknown as Error }})
      await expect(runEmulatorTest(input, io)).resolves.toMatchObject({summary: expect.stringContaining('boom')})
    })
  })

  it('a stuck shutdown or cleanup never changes the outcome', async () => {
    const {io, stop} = fakeIo({}, {removeScratch: () => { throw new Error('busy') }})
    stop.mockRejectedValueOnce(new Error('already gone'))
    const run = vi.mocked(io.run)
    const original = run.getMockImplementation()!
    run.mockImplementation(async (cmd: string, args: string[], opts: EmulatorRunOptions) => {
      if (args.includes('emu')) throw new Error('adb gone')
      return original(cmd, args, opts)
    })
    await expect(runEmulatorTest(input, io)).resolves.toMatchObject({status: 'passed'})
    expect(io.releaseLock).toHaveBeenCalledTimes(1)
  })

  it('uses the process environment when none is given', async () => {
    const {io, calls} = fakeIo()
    await runEmulatorTest({config, cwd: '/w', ticket: 'CYAU-1'}, io)
    expect(calls[0].opts.env?.PATH).toBe(process.env.PATH)
  })
})

describe('detectCrash', () => {
  it('finds an ANR and a native crash of the app', () => {
    expect(detectCrash(`E ActivityManager: ANR in ${APP} (it.example.app/.Main)`, APP)).toHaveLength(1)
    expect(detectCrash(`F libc: Fatal signal 11 (SIGSEGV), pid 4242 (${APP})`, APP)).toHaveLength(1)
  })

  it('ignores the crash of another process and a clean log', () => {
    expect(detectCrash('E AndroidRuntime: Process: com.android.systemui, PID: 1', APP)).toEqual([])
    expect(detectCrash('I ActivityManager: Displayed it.example.app/.Main', APP)).toEqual([])
  })

  it('bounds and clips the evidence', () => {
    const lines = [`E AndroidRuntime: Process: ${APP}, PID: 1`, ...Array.from({length: 40}, () => `E AndroidRuntime: at ${'x'.repeat(400)}`)]
    const evidence = detectCrash(lines.join('\r\n'), APP)
    expect(evidence).toHaveLength(20)
    expect(evidence[1].length).toBe(300)
  })
})

describe('pure helpers', () => {
  it('isPng recognizes only a picture', () => {
    expect(isPng(PNG)).toBe(true)
    expect(isPng(Buffer.from('error: device offline'))).toBe(false)
    expect(isPng(PNG.subarray(0, 8))).toBe(false)
  })

  it('confines the build: read-only root, credentials hidden, no network, writable only worktree and scratch', () => {
    const confinement = {worktree: '/data/worktrees/P/P-1', scratch: '/state/b', script: 'make apk', hidden: {dirs: ['/data', '/state'], files: ['/home/a/.netrc']}, network: false}
    const args = composeBuildArgs(confinement)
    expect(args).toEqual([
      '--ro-bind', '/', '/', '--dev', '/dev', '--unshare-pid', '--proc', '/proc', '--unshare-net', '--die-with-parent',
      '--tmpfs', '/data', '--tmpfs', '/state', '--ro-bind', '/dev/null', '/home/a/.netrc',
      // After the masks: the worktree and the scratch folder are reopened inside their hidden parents.
      '--bind', '/data/worktrees/P/P-1', '/data/worktrees/P/P-1', '--bind', '/state/b', '/state/b',
      '--chdir', '/data/worktrees/P/P-1', '--', 'sh', '-c', 'make apk',
    ])
    expect(composeBuildArgs({...confinement, network: true})).not.toContain('--unshare-net')
    expect(() => composeBuildArgs({...confinement, worktree: 'w'})).toThrow()
    expect(() => composeBuildArgs({...confinement, scratch: 's'})).toThrow()
    expect(() => composeBuildArgs({...confinement, hidden: {dirs: ['.ssh'], files: []}})).toThrow()
    expect(() => composeBuildArgs({...confinement, hidden: {dirs: [], files: ['.netrc']}})).toThrow()
  })

  it('hides the sessions\' denied paths plus the operator keys and the automator\'s own folders', () => {
    vi.stubEnv('AUTOMATOR_STATE_DIR', '/st')
    vi.stubEnv('AUTOMATOR_CONFIG_DIR', '/cf')
    vi.stubEnv('AUTOMATOR_DATA_DIR', '/dt')
    const candidates = hiddenPathCandidates('/home/a')
    for (const expected of ['/home/a/.config/gh', '/home/a/.claude', '/home/a/.codex', '/run/user', '/var/run/docker.sock',
      '/home/a/.ssh', '/home/a/.netrc', '/home/a/.git-credentials', '/st', '/cf', '/dt']) {
      expect(candidates).toContain(expected)
    }
  })

  it('keeps only the paths that exist, and drops what a hidden folder already masks', () => {
    const kinds: Record<string, 'dir' | 'file'> = {
      '/home/a/.config': 'dir', '/home/a/.config/gh': 'dir', '/home/a/.ssh': 'dir', '/home/a/.netrc': 'file',
      '/home/a/.config/hub': 'file', '/run/docker.sock': 'file',
    }
    const hidden = selectHiddenPaths(
      ['/home/a/.ssh', '/home/a/.config/gh', '/home/a/.config', '/home/a/.netrc', '/home/a/.config/hub', '/home/a/.missing', '/run/docker.sock', '/home/a/.ssh/'],
      (target) => kinds[target] ?? null,
    )
    expect(hidden).toEqual({dirs: ['/home/a/.config', '/home/a/.ssh'], files: ['/home/a/.netrc', '/run/docker.sock']})
  })

  it('the build gets half of the machine, never less than one CPU', () => {
    expect(buildLimits(8)).toEqual({memoryMax: '50%', cpuQuota: '400%'})
    expect(buildLimits(1)).toEqual({memoryMax: '50%', cpuQuota: '100%'})
  })

  it('the build environment drops managed credentials and redirects the caches', () => {
    const env = buildEnvironment({PATH: '/bin', ['CLOSEYOURIT_' + 'TOKEN']: 'fake', ['GH_' + 'TOKEN']: 'fake', ['ANTHROPIC_' + 'API_KEY']: 'fake'}, '/s')
    expect(env.PATH).toBe('/bin')
    expect(env.GH_TOKEN).toBeUndefined()
    expect(env.ANTHROPIC_API_KEY).toBeUndefined()
    expect(env).toMatchObject({TMPDIR: '/s/tmp', GRADLE_USER_HOME: '/s/gradle', PUB_CACHE: '/s/pub-cache'})
  })

  it('names the screenshot after the commit', () => {
    expect(screenshotName('0123456789abcdef0123')).toBe('emulatore-0123456789ab.png')
    expect(screenshotName('../..')).toBe('emulatore-head.png')
  })

  it('resolves the Android tools from the SDK, then the PATH', () => {
    const executables = new Set(['/sdk/emulator/emulator', '/sdk/platform-tools/adb'])
    expect(resolveAndroidTools({ANDROID_SDK_ROOT: '/sdk'}, (file) => executables.has(file)))
      .toEqual({emulator: '/sdk/emulator/emulator', adb: '/sdk/platform-tools/adb'})
    expect(resolveAndroidTools({ANDROID_HOME: ' ', PATH: ''}, () => false)).toEqual({emulator: undefined, adb: undefined})

    const bin = temporaryDirectory()
    fs.writeFileSync(path.join(bin, 'adb'), '#!/bin/sh\n', {mode: 0o755})
    expect(resolveAndroidTools({PATH: `${path.join(bin, 'missing')}::${bin}`})).toEqual({emulator: undefined, adb: path.join(bin, 'adb')})
    expect(resolveAndroidTools({})).toEqual({emulator: undefined, adb: undefined})
  })
})

describe('emulatorToolRuntimes (heartbeat)', () => {
  it('declares emulator and adb as optional, the emulator present only with KVM', () => {
    const version = vi.fn((bin: string) => `${bin} 1.0`)
    expect(emulatorToolRuntimes({}, {kvmUsable: () => true, resolveTools: () => ({emulator: '/e', adb: '/a'})}, version)).toEqual([
      {name: 'android-emulator', present: true, version: '/e 1.0', required: false},
      {name: 'adb', present: true, version: '/a 1.0', required: false},
    ])
    expect(emulatorToolRuntimes({}, {kvmUsable: () => false, resolveTools: () => ({emulator: '/e'})}, version)).toEqual([
      {name: 'android-emulator', present: false, version: null, required: false},
      {name: 'adb', present: false, version: null, required: false},
    ])
  })

  it('asks each binary its version once, and again only when the binary changes', () => {
    const probe = vi.fn((bin: string) => `${bin} 1.0`)
    const stamps: Record<string, number> = {'/e': 1, '/a': 1}
    const cached = createToolVersionCache(probe, (bin) => {
      if (!(bin in stamps)) throw new Error('ENOENT')
      return stamps[bin]
    })
    const io = {kvmUsable: () => true, resolveTools: () => ({emulator: '/e', adb: '/a'})}
    for (let beat = 0; beat < 5; beat++) emulatorToolRuntimes({}, io, cached)
    expect(probe).toHaveBeenCalledTimes(2)

    stamps['/e'] = 2
    expect(emulatorToolRuntimes({}, io, cached)[0].version).toBe('/e 1.0')
    expect(probe).toHaveBeenCalledTimes(3)
    // A binary that vanished between the probe and the stat has no version, and is not probed.
    expect(cached('/gone', ['version'])).toBeNull()
    expect(probe).toHaveBeenCalledTimes(3)
    // A failed probe is remembered too: a broken tool is not re-run at every beat.
    const failing = vi.fn(() => null)
    const remembered = createToolVersionCache(failing, () => 1)
    expect(remembered('/x', [])).toBeNull()
    expect(remembered('/x', [])).toBeNull()
    expect(failing).toHaveBeenCalledTimes(1)
  })

  it('the default cache reads the real binary', () => {
    const bin = temporaryDirectory()
    const tool = path.join(bin, 'tool')
    fs.writeFileSync(tool, '#!/bin/sh\necho tool 9\n', {mode: 0o755})
    const cached = createToolVersionCache()
    expect(cached(tool, [])).toBe('tool 9')
    expect(cached(path.join(bin, 'missing'), [])).toBeNull()
  })

  it('toolVersion reads the first line, null on failure', () => {
    expect(toolVersion('sh', ['-c', 'echo v1; echo more'])).toBe('v1')
    expect(toolVersion('sh', ['-c', 'exit 3'])).toBeNull()
    expect(toolVersion('sh', ['-c', 'true'])).toBeNull()
  })
})

describe('publishEmulatorEvidence', () => {
  function runner(replies: Record<string, Partial<EmulatorEvidenceCommand>> = {}) {
    const seen: string[][] = []
    const files: string[] = []
    const run = vi.fn((cmd: string, args: string[]) => {
      seen.push([cmd, ...args])
      const fileIndex = args.indexOf('--file')
      if (fileIndex >= 0) {
        files.push(args[fileIndex + 1])
        expect(fs.readFileSync(args[fileIndex + 1])).toEqual(PNG)
      }
      const reply = replies[args[1]] ?? {}
      return {status: 0, stdout: '{"data":[]}', stderr: '', ...reply}
    })
    return {run, seen, files}
  }
  const evidence = {project: 'CYAU', ticket: 'CYAU-1', headSha: 'a'.repeat(40), comment: 'Prova su telefono superata.', screenshot: PNG}

  it('attaches the screenshot once and writes the outcome', () => {
    const {run, seen, files} = runner()
    publishEmulatorEvidence(evidence, run)
    expect(seen.map((args) => args[2])).toEqual(['attachments', 'attach', 'comments', 'comment'])
    expect(path.basename(files[0])).toBe('emulatore-aaaaaaaaaaaa.png')
    // The temporary copy does not outlive the upload.
    expect(fs.existsSync(files[0])).toBe(false)
    expect(seen[3]).toEqual(['cyi', 'tickets', 'comment', 'CYAU-1', '-p', 'CYAU', '--body', 'Prova su telefono superata. Foto dello schermo: emulatore-aaaaaaaaaaaa.png'])
  })

  it('a picture already attached and commented for the same commit is not sent again', () => {
    const {run, seen} = runner({
      attachments: {stdout: '{"data":[{"filename":"emulatore-aaaaaaaaaaaa.png"}]}'},
      comments: {stdout: '{"data":[{"body":"… Foto dello schermo: emulatore-aaaaaaaaaaaa.png"}]}'},
    })
    publishEmulatorEvidence(evidence, run)
    expect(seen.map((args) => args[2])).toEqual(['attachments', 'comments'])
  })

  it('without a screenshot only the comment is written', () => {
    const {run, seen} = runner()
    publishEmulatorEvidence({...evidence, screenshot: null, comment: 'Non disponibile.'}, run)
    expect(seen.map((args) => args[2])).toEqual(['comments', 'comment'])
    expect(seen[1].at(-1)).toBe('Non disponibile.')
  })

  it.each([
    ['attachments', 'elenco allegati'],
    ['attach', 'caricamento della foto'],
    ['comments', 'lettura dei commenti'],
    ['comment', 'commento sul ticket'],
  ])('a refused %s stops with its reason', (step, reason) => {
    const {run} = runner({[step]: {status: 1, stderr: 'R403 forbidden'}})
    expect(() => publishEmulatorEvidence(evidence, run)).toThrow(new RegExp(`${reason}.*R403 forbidden`))
  })

  it('an empty failure falls back to stdout, then to the exit status', () => {
    expect(() => publishEmulatorEvidence(evidence, runner({attach: {status: 2, stdout: 'quota'}}).run)).toThrow(/quota/)
    expect(() => publishEmulatorEvidence(evidence, runner({attach: {status: null, stdout: ''}}).run)).toThrow(/exit null/)
  })

  it('the default runner runs the command without a shell', () => {
    expect(defaultEvidenceRunner('sh', ['-c', 'printf ok'], 5000)).toEqual({status: 0, stdout: 'ok', stderr: ''})
    const missing = defaultEvidenceRunner('/nonexistent/cyi', [], 5000)
    expect(missing.status).toBeNull()
    expect(missing.stderr).toContain('ENOENT')
  })
})

/** A child process that does only what the test tells it to: no real process, no real clock. */
class FakeChild extends EventEmitter {
  pid: number | undefined = 4242
  stdout = new EventEmitter()
  stderr = new EventEmitter()
  exitCode: number | null = null
  signalCode: NodeJS.Signals | null = null
}

describe('defaultEmulatorIo (process layer, fake clock)', () => {
  const GRACE = 200
  let child: FakeChild
  let spawn: Mock<SpawnProcess>
  let kill: Mock<KillGroup>
  beforeEach(() => {
    vi.useFakeTimers()
    child = new FakeChild()
    spawn = vi.fn<SpawnProcess>(() => child as unknown as ChildProcess)
    kill = vi.fn<KillGroup>()
  })
  afterEach(() => {
    vi.useRealTimers()
  })
  const io = (containment?: StrongContainmentBackend) => defaultEmulatorIo({killGraceMs: GRACE, spawn, kill, containment, cpus: 4})

  it('runs a bounded command in its own group and captures stdout and stderr', async () => {
    const pending = io().run('adb', ['devices'], {timeoutMs: 10_000, cwd: '/w', env: {PATH: '/bin'}})
    expect(spawn).toHaveBeenCalledWith('adb', ['devices'], {cwd: '/w', env: {PATH: '/bin'}, stdio: ['ignore', 'pipe', 'pipe'], detached: true})
    child.stdout.emit('data', Buffer.from('hi'))
    child.stderr.emit('data', Buffer.from('err'))
    child.emit('close', 3)
    child.emit('close', 0)
    await expect(pending).resolves.toEqual({code: 3, stdout: Buffer.from('hi'), stderr: 'err', timedOut: false})
    // The timeout of a finished command never fires.
    await vi.advanceTimersByTimeAsync(10_000)
    expect(kill).not.toHaveBeenCalled()
  })

  it('bounds the captured stdout', async () => {
    const pending = io().run('adb', [], {timeoutMs: 10_000})
    child.stdout.emit('data', Buffer.alloc(32 * 1024 * 1024))
    child.stdout.emit('data', Buffer.from('beyond'))
    child.emit('close', 0)
    expect((await pending).stdout.length).toBe(32 * 1024 * 1024)
  })

  it('a timeout ends the whole group: SIGTERM, then SIGKILL after the grace', async () => {
    const pending = io().run('sh', ['-c', 'sleep 30 & sleep 30'], {timeoutMs: 100})
    await vi.advanceTimersByTimeAsync(99)
    expect(kill).not.toHaveBeenCalled()
    await vi.advanceTimersByTimeAsync(1)
    expect(kill).toHaveBeenCalledWith(4242, 'SIGTERM')
    await vi.advanceTimersByTimeAsync(GRACE)
    expect(kill).toHaveBeenLastCalledWith(4242, 'SIGKILL')
    child.emit('close', null)
    await expect(pending).resolves.toMatchObject({code: null, timedOut: true})
  })

  it('an abort ends the command, already-aborted included', async () => {
    const controller = new AbortController()
    const pending = io().run('sh', [], {timeoutMs: 10_000, signal: controller.signal})
    controller.abort()
    expect(kill).toHaveBeenCalledWith(4242, 'SIGTERM')
    child.emit('close', null)
    await expect(pending).resolves.toMatchObject({code: null, timedOut: false})

    child = new FakeChild()
    const aborted = io().run('sh', [], {timeoutMs: 10_000, signal: AbortSignal.abort()})
    expect(kill).toHaveBeenCalledTimes(2)
    child.emit('close', null)
    await expect(aborted).resolves.toMatchObject({code: null})
  })

  it('a missing binary is an outcome, not an exception', async () => {
    const pending = io().run('/nonexistent/adb', [], {timeoutMs: 1000})
    child.emit('error', new Error('spawn /nonexistent/adb ENOENT'))
    const outcome = await pending
    expect(outcome.code).toBeNull()
    expect(outcome.stderr).toContain('ENOENT')
  })

  it('stops a polite background process with SIGTERM alone', async () => {
    const polite = io().start('emulator', ['-avd', 'x'], {PATH: '/bin'})
    expect(spawn).toHaveBeenCalledWith('emulator', ['-avd', 'x'], {env: {PATH: '/bin'}, stdio: 'ignore', detached: true})
    const stopping = polite.stop()
    expect(kill).toHaveBeenCalledWith(4242, 'SIGTERM')
    child.exitCode = 0
    child.emit('exit', 0)
    await stopping
    expect(kill).toHaveBeenCalledTimes(1)
    // Already gone: nothing more to signal.
    await polite.stop()
    expect(kill).toHaveBeenCalledTimes(1)
  })

  it('stops one that ignores SIGTERM with SIGKILL after the grace', async () => {
    const stubborn = io().start('emulator', [], {})
    const stopping = stubborn.stop()
    await vi.advanceTimersByTimeAsync(GRACE)
    expect(kill).toHaveBeenLastCalledWith(4242, 'SIGKILL')
    child.emit('exit', null)
    await stopping
  })

  it('does not hang on one that survives even SIGKILL', async () => {
    const stuck = io().start('emulator', [], {})
    const stopping = stuck.stop()
    await vi.advanceTimersByTimeAsync(GRACE + 2_000)
    await stopping
    expect(kill.mock.calls.map((call) => call[1])).toEqual(['SIGTERM', 'SIGKILL'])
  })

  it('a background process that does not start is not an exception', async () => {
    const missing = io().start('/nonexistent/emulator', [], {})
    child.emit('error', new Error('ENOENT'))
    child.signalCode = 'SIGTERM'
    await missing.stop()
    expect(kill).not.toHaveBeenCalled()
  })

  it('the real group signal tolerates a missing pid and a group already gone', async () => {
    const machine = defaultEmulatorIo({killGraceMs: GRACE, spawn})
    child.pid = undefined
    const noPid = machine.run('x', [], {timeoutMs: 10})
    await vi.advanceTimersByTimeAsync(10 + GRACE)
    child.emit('close', null)
    await expect(noPid).resolves.toMatchObject({timedOut: true})

    child = new FakeChild()
    child.pid = 2 ** 30
    const gone = machine.run('x', [], {timeoutMs: 10})
    await vi.advanceTimersByTimeAsync(10 + GRACE)
    child.emit('close', null)
    await expect(gone).resolves.toMatchObject({timedOut: true})
  })

  it('sleeps on the clock, and wakes up on abort', async () => {
    let woke = false
    const sleeping = io().sleep(5_000).then(() => {
      woke = true
    })
    await vi.advanceTimersByTimeAsync(4_999)
    expect(woke).toBe(false)
    await vi.advanceTimersByTimeAsync(1)
    await sleeping
    expect(woke).toBe(true)

    const controller = new AbortController()
    const pending = io().sleep(30_000, controller.signal)
    controller.abort()
    await pending
    await io().sleep(30_000, AbortSignal.abort())
  })

  describe('the contained build', () => {
    function backend(overrides: {empty?: () => Promise<boolean>; signal?: () => Promise<boolean>} = {}) {
      const handle = {
        identity: 'automator-action-x.scope',
        command: {cmd: '/usr/bin/systemd-run', args: ['--scope', '--', BWRAP, '--ro-bind', '/', '/'], cwd: '/w'},
        signal: vi.fn(overrides.signal ?? (async () => true)),
        empty: vi.fn(overrides.empty ?? (async () => true)),
      }
      const containment: StrongContainmentBackend = {
        available: vi.fn(async () => ({available: true})),
        prepare: vi.fn(async () => handle),
      }
      return {containment, handle}
    }

    it('runs in the sessions\' cgroup with half of the machine, and finds it empty at the end', async () => {
      const {containment, handle} = backend()
      const machine = io(containment)
      await expect(machine.containmentAvailable()).resolves.toEqual({available: true})
      const pending = machine.runContained(BWRAP, ['--ro-bind', '/', '/'], {timeoutMs: 1000, cwd: '/w', env: {PATH: '/bin'}})
      await vi.advanceTimersByTimeAsync(0)
      expect(containment.prepare).toHaveBeenCalledWith({
        cmd: BWRAP, args: ['--ro-bind', '/', '/'], cwd: '/w', limits: {memoryMax: '50%', cpuQuota: '200%'},
      })
      expect(spawn).toHaveBeenCalledWith('/usr/bin/systemd-run', handle.command.args, expect.objectContaining({env: {PATH: '/bin'}}))
      child.emit('close', 0)
      await expect(pending).resolves.toMatchObject({code: 0, timedOut: false})
      expect(handle.empty).toHaveBeenCalledTimes(1)
      expect(handle.signal).not.toHaveBeenCalled()
    })

    it('a timeout kills the whole cgroup, and a cgroup still alive at the end is killed again', async () => {
      const {containment, handle} = backend({empty: async () => false})
      const pending = io(containment).runContained(BWRAP, [], {timeoutMs: 100})
      await vi.advanceTimersByTimeAsync(0)
      await vi.advanceTimersByTimeAsync(100)
      expect(kill).toHaveBeenCalledWith(4242, 'SIGTERM')
      child.emit('close', null)
      await expect(pending).resolves.toMatchObject({timedOut: true})
      // Once with the group signals, once more because the cgroup was not empty at the end.
      expect(handle.signal.mock.calls).toEqual([['SIGKILL'], ['SIGKILL']])
      expect(containment.prepare).toHaveBeenCalledWith(expect.objectContaining({cwd: process.cwd()}))
    })

    it('a cgroup that cannot be probed or signalled does not throw', async () => {
      const {containment, handle} = backend({
        empty: async () => { throw new Error('sonda systemd fallita') },
        signal: async () => { throw new Error('user manager gone') },
      })
      const controller = new AbortController()
      const pending = io(containment).runContained(BWRAP, [], {timeoutMs: 1000, signal: controller.signal})
      await vi.advanceTimersByTimeAsync(0)
      controller.abort()
      child.emit('close', null)
      await expect(pending).resolves.toMatchObject({code: null})
      expect(handle.signal).toHaveBeenCalledTimes(2)
    })

    it('a containment that cannot be prepared throws to the caller', async () => {
      const containment: StrongContainmentBackend = {
        available: async () => ({available: false, detail: 'cgroup v2 non disponibile'}),
        prepare: async () => { throw new Error('cgroup v2 non disponibile') },
      }
      await expect(io(containment).containmentAvailable()).resolves.toEqual({available: false, detail: 'cgroup v2 non disponibile'})
      await expect(io(containment).runContained(BWRAP, [], {timeoutMs: 10})).rejects.toThrow('cgroup v2')
      expect(spawn).not.toHaveBeenCalled()
    })
  })
})

describe('defaultEmulatorIo (machine probes)', () => {
  const io = () => defaultEmulatorIo()

  it('probes the machine without throwing', async () => {
    expect(typeof io().kvmUsable()).toBe('boolean')
    expect(typeof io().bwrapAvailable()).toBe('boolean')
    expect(io().now()).toBeGreaterThan(0)
    expect(io().resolveTools({})).toEqual({emulator: undefined, adb: undefined})
    const hidden = io().hiddenPaths()
    expect([...hidden.dirs, ...hidden.files].every((target) => path.isAbsolute(target))).toBe(true)
    expect(typeof (await io().containmentAvailable()).available).toBe('boolean')
  })

  it('finds the artifact only inside the worktree', () => {
    const root = temporaryDirectory()
    fs.mkdirSync(path.join(root, 'build'))
    fs.writeFileSync(path.join(root, 'build', 'app.apk'), 'apk')
    expect(io().fileInside(root, 'build/app.apk')).toBe(path.join(root, 'build', 'app.apk'))
    expect(io().fileInside(root, 'build')).toBeNull()
    expect(io().fileInside(root, 'missing.apk')).toBeNull()
    const outside = temporaryDirectory()
    fs.writeFileSync(path.join(outside, 'x.apk'), 'apk')
    fs.symlinkSync(path.join(outside, 'x.apk'), path.join(root, 'link.apk'))
    expect(io().fileInside(root, 'link.apk')).toBeNull()
  })

  it('keeps scratch folder and lock in the state directory', () => {
    const state = temporaryDirectory()
    vi.stubEnv('AUTOMATOR_STATE_DIR', state)
    const machine = io()
    const scratch = machine.makeScratch('CYAU/../1')
    expect(scratch).toBe(path.join(state, 'emulator-build', 'CYAU____1'))
    expect(fs.existsSync(path.join(scratch, 'gradle'))).toBe(true)
    machine.removeScratch(scratch)
    expect(fs.existsSync(scratch)).toBe(false)

    expect(emulatorLockPath()).toBe(path.join(state, 'emulator.lock'))
    expect(machine.acquireLock()).toBe(true)
    // One emulator per machine: the same live process cannot take it twice.
    expect(machine.acquireLock()).toBe(false)
    machine.releaseLock()
    expect(machine.acquireLock()).toBe(true)
    machine.releaseLock()
  })
})
