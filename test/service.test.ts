import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import {afterAll, afterEach, describe, expect, it} from 'vitest'
import {
  buildPathEnv,
  describeRuntimeDivergences,
  detectPlatform,
  diffManagedServiceRuntime,
  diffServiceRuntime,
  type ExecFn,
  type ExecResult,
  type InstallOptions,
  type ManagedServiceRuntime,
  parseSystemdWords,
  quoteSystemdWord,
  renderSystemdCommand,
  renderSystemdUnit,
  type ServiceRuntime,
  serviceManager,
  serviceSkillsModeEnabled,
  adoptServiceGuardrailEnv,
} from '../src/lib/service'
import {AutomatorError} from '../src/errors/error-codes'

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'automator-svc-'))
let counter = 0
const home = (): string => {
  const h = path.join(dir, `home-${counter++}`)
  fs.mkdirSync(h, {recursive: true})
  return h
}
afterAll(() => fs.rmSync(dir, {recursive: true, force: true}))

function recordingExec(handler?: (cmd: string, args: string[]) => ExecResult): {
  exec: ExecFn
  calls: Array<{cmd: string; args: string[]}>
} {
  const calls: Array<{cmd: string; args: string[]}> = []
  const exec: ExecFn = (cmd, args) => {
    calls.push({cmd, args})
    return handler?.(cmd, args) ?? {code: 0, stdout: '', stderr: ''}
  }
  return {exec, calls}
}

const opts: InstallOptions = {
  nodePath: '/n/node',
  entrypoint: '/e/run.js',
  args: ['daemon', '--playbook', '/p/pb.yml'],
  pathEnv: '/shims:/usr/bin',
  workingDir: '/w',
  env: {AUTOMATOR_STATE_DIR: '/s'},
}

describe('detectPlatform', () => {
  const original = process.platform
  afterEach(() => Object.defineProperty(process, 'platform', {value: original, configurable: true}))

  it('riconosce Linux', () => {
    Object.defineProperty(process, 'platform', {value: 'linux', configurable: true})
    expect(detectPlatform()).toBe('linux')
  })

  it.each(['darwin', 'win32'] as const)('OS %s not supported → C000-SVC-001', (platform) => {
    Object.defineProperty(process, 'platform', {value: platform, configurable: true})
    try { detectPlatform() } catch (error) {
      expect(error).toBeInstanceOf(AutomatorError)
      expect((error as AutomatorError).code).toBe('C000-SVC-001')
      expect((error as Error).message).toContain('esclusivamente Linux')
    }
  })
})

describe('buildPathEnv', () => {
  it('puts the mise shims first and includes the Linux paths', () => {
    expect(buildPathEnv('/home/me')).toBe('/home/me/.local/share/mise/shims:/home/me/.local/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin')
  })
})

describe('render puri', () => {
  it('renderSystemdUnit include ExecStart, Restart=always e WantedBy', () => {
    const unit = renderSystemdUnit({
      description: 'x',
      execStart: '/node /run.js daemon',
      workingDir: '/w',
      pathEnv: '/shims',
      homeDir: '/home',
      env: {AUTOMATOR_STATE_DIR: '/s'},
    })
    expect(unit).toContain('ExecStart=/node /run.js daemon')
    expect(unit).toContain('Restart=always')
    expect(unit).toContain('WantedBy=default.target')
    expect(unit).toContain('"AUTOMATOR_STATE_DIR=/s"')
  })

  it('systemd round-trip preserves spaces, backslashes, percent signs and quotes without specifier expansion', () => {
    const argv = ['/node path/node', '/checkout\\dir/bin/run.js', 'daemon', '--playbook', '/p/100% "quoted".yml']
    const rendered = renderSystemdCommand(argv)
    expect(rendered).toContain('100%%')
    expect(parseSystemdWords(rendered)).toEqual(argv)
    expect(parseSystemdWords('/node /run.js daemon --playbook /p/100%file.yml')).toBeNull()
    expect(parseSystemdWords('"unterminated')).toBeNull()
  })

  it('does NOT quote WorkingDirectory: systemd would reject it and the service would not start (CYAU-125)', () => {
    const unit = renderSystemdUnit({
      description: 'x',
      execStart: ['/node path/node', '/run path/run.js', 'daemon'],
      workingDir: '/work dir/100%',
      pathEnv: '/mise shims:/usr/bin',
      homeDir: '/home/user',
      env: {AUTOMATOR_STATE_DIR: '/state dir'},
    })
    // The path stays intact without quotes (systemd reads up to the end of the line, spaces do not split it),
    // but `%` must still be doubled or it would be interpreted as a specifier.
    expect(unit).toContain('WorkingDirectory=/work dir/100%%')
    expect(unit).not.toContain('WorkingDirectory="')
    expect(unit.match(/^Environment=/gm)).toHaveLength(1)
  })

  it('rejects the working dirs that would corrupt the file, not only those with a line break', () => {
    const base = {
      description: 'x',
      execStart: ['/node', '/run.js', 'daemon'],
      pathEnv: '/usr/bin',
      homeDir: '/home/user',
      env: {},
    }
    // `\0` and line breaks split the file. The backslash is worse: at the end of a line systemd reads it as a
    // CONTINUATION, so the next Environment= line would be absorbed into the working dir and
    // the unit would be syntactically valid but wrong — a silent failure.
    for (const workingDir of [
      '/work\0dir', '/work\ndir', '/work\rdir',
      '/work\\', '/work\\dir',
      // Surrounding spaces: systemd drops them and the parser trims, so the round-trip would lead to a
      // DIFFERENT directory from the written one, with the unit looking correct.
      '/work ', ' /work', '/work\t',
    ]) {
      expect(() => renderSystemdUnit({...base, workingDir})).toThrow(/non valida/)
    }
  })

  it('puts StartLimit* in [Unit], where systemd really reads them (CYAU-127)', () => {
    const unit = renderSystemdUnit({
      description: 'x',
      execStart: ['/node', '/run.js', 'daemon'],
      workingDir: '/work',
      pathEnv: '/usr/bin',
      homeDir: '/home/user',
      env: {},
    })
    // In [Service] systemd ignores them with a warning: the restart cap would not exist and a crash
    // loop would restart forever.
    const unitSection = unit.slice(unit.indexOf('[Unit]'), unit.indexOf('[Service]'))
    expect(unitSection).toContain('StartLimitIntervalSec=60')
    expect(unitSection).toContain('StartLimitBurst=5')
    expect(unit.slice(unit.indexOf('[Service]'))).not.toContain('StartLimit')
  })

  it('passes the D-Bus session, without which the daemon does not read the keyring (CYAU-126)', () => {
    const unit = renderSystemdUnit({
      description: 'x',
      execStart: ['/node', '/run.js', 'daemon'],
      workingDir: '/work',
      pathEnv: '/usr/bin',
      homeDir: '/home/user',
      env: {},
      runtimeDir: '/run/user/1000',
    })
    expect(unit).toContain('"XDG_RUNTIME_DIR=/run/user/1000"')
    expect(unit).toContain('"DBUS_SESSION_BUS_ADDRESS=unix:path=/run/user/1000/bus"')
  })

  it('without runtime dir does not emit the D-Bus variables instead of inventing one', () => {
    const unit = renderSystemdUnit({
      description: 'x',
      execStart: ['/node', '/run.js', 'daemon'],
      workingDir: '/work',
      pathEnv: '/usr/bin',
      homeDir: '/home/user',
      env: {},
    })
    expect(unit).not.toContain('DBUS_SESSION_BUS_ADDRESS')
  })

  it('rejects systemd values and grammars that cannot be attested without ambiguity', () => {
    for (const value of ['nul\0byte', 'line\nbreak', 'carriage\rreturn']) {
      expect(() => quoteSystemdWord(value)).toThrow(/non rappresentabile/)
    }
    expect(() => renderSystemdCommand([])).toThrow(/vuoto/)
    expect(parseSystemdWords('"bad\\q"')).toBeNull()
    expect(parseSystemdWords("'single-quoted'")).toBeNull()
    expect(parseSystemdWords('trailing\\')).toBeNull()
    expect(parseSystemdWords('/p/100%file', true)).toEqual(['/p/100%file'])
  })
})

describe('SystemdManager', () => {
  it('install writes the unit and calls daemon-reload + enable --now', () => {
    const h = home()
    const {exec, calls} = recordingExec()
    const mgr = serviceManager('linux', exec, h)
    mgr.install(opts)
    expect(fs.readFileSync(mgr.unitPath(), 'utf8')).toContain('ExecStart=')
    expect(calls.some((c) => c.args.includes('daemon-reload'))).toBe(true)
    expect(calls.some((c) => c.args.includes('enable'))).toBe(true)
  })

  it('tells the managed unit apart from a non-managed unit or one inconsistent with the root', () => {
    const h = home()
    const {exec} = recordingExec()
    const mgr = serviceManager('linux', exec, h)
    mgr.install({...opts, entrypoint: '/checkout/bin/run.js'})
    expect(mgr.managedRuntime()).toBeNull()

    mgr.install({
      ...opts,
      nodePath: '/service/node',
      entrypoint: '/opt/automator/current/bin/run.js',
      env: {
        ...opts.env,
        AUTOMATOR_INSTALL_ROOT: '/opt/automator',
        AUTOMATOR_CONFIG_DIR: '/opt/config',
        CODEX_HOME: '/opt/codex',
      },
    })
    expect(mgr.managedRuntime()).toEqual({
      installRoot: '/opt/automator',
      nodePath: '/service/node',
      entrypoint: '/opt/automator/current/bin/run.js',
      daemonArgs: ['daemon', '--playbook', '/p/pb.yml'],
      configDir: '/opt/config',
      codexHome: '/opt/codex',
    })
  })

  it('classifies disk and live legacy checkout with the same identity', () => {
    const h = home()
    const live = 'ExecStart={ path=/service/node ; argv[]=/service/node /checkout/automator/bin/run.js daemon --playbook /p/pb.yml --interval 30 ; ignore_errors=no ; start_time=[n/a] ; }\nEnvironment=HOME=/home PATH=/shims AUTOMATOR_STATE_DIR=/state AUTOMATOR_CONFIG_DIR=/config AUTOMATOR_PLAYBOOK=/p/pb.yml CODEX_HOME=/codex'
    const {exec} = recordingExec((_cmd, args) => args.includes('ExecStart')
      ? {code: 0, stdout: live, stderr: ''}
      : {code: 0, stdout: '', stderr: ''})
    const mgr = serviceManager('linux', exec, h)
    mgr.install({
      ...opts,
      nodePath: '/service/node',
      entrypoint: '/checkout/automator/bin/run.js',
      args: ['daemon', '--playbook', '/p/pb.yml', '--interval', '30'],
      env: {
        AUTOMATOR_STATE_DIR: '/state',
        AUTOMATOR_CONFIG_DIR: '/config',
        AUTOMATOR_PLAYBOOK: '/p/pb.yml',
        CODEX_HOME: '/codex',
      },
    })

    expect(mgr.runtime()).toMatchObject({kind: 'legacy', entrypoint: '/checkout/automator/bin/run.js'})
    expect(mgr.loadedRuntime()).toMatchObject({
      kind: 'legacy',
      nodePath: '/service/node',
      entrypoint: '/checkout/automator/bin/run.js',
      daemonArgs: ['daemon', '--playbook', '/p/pb.yml', '--interval', '30'],
      configDir: '/config',
      codexHome: '/codex',
    })
  })

  it('rejects a legacy unit containing unauthorized environment', () => {
    const h = home()
    const {exec} = recordingExec()
    const mgr = serviceManager('linux', exec, h)
    mgr.install({...opts, entrypoint: '/checkout/bin/run.js', env: {...opts.env, AUTOMATOR_CONFIG_DIR: '/c', API_TOKEN: 'secret'}})
    expect(mgr.runtime()).toBeNull()
  })

  it('rejects duplicate systemd directives, continuation or incomplete quoting', () => {
    const h = home()
    const {exec} = recordingExec()
    const mgr = serviceManager('linux', exec, h)
    mgr.install({...opts, entrypoint: '/checkout/bin/run.js', env: {...opts.env, AUTOMATOR_CONFIG_DIR: '/config'}})
    const valid = fs.readFileSync(mgr.unitPath(), 'utf8')

    for (const ambiguous of [
      valid.replace('ExecStart=', 'ExecStart=/other\nExecStart='),
      valid.replace('WorkingDirectory=', 'WorkingDirectory=/other\nWorkingDirectory='),
      valid.replace('Environment=', 'Environment="HOME=/other"\nEnvironment='),
      valid.replace('ExecStart=', 'ExecStart="/node" \\\n "/run"\nExecStart='),
      valid.replace('ExecStart=', 'ExecStart="unterminated\n# '),
    ]) {
      fs.writeFileSync(mgr.unitPath(), ambiguous)
      expect(mgr.runtime()).toBeNull()
    }
  })

  it('still adopts the legacy units with quoted WorkingDirectory (CYAU-125)', () => {
    // The fix changes what we WRITE, not what we can READ: the already installed hosts have
    // the quoted path, and if we stopped recognizing it the update would fail closed exactly on the
    // machines the fix must save.
    const h = home()
    const {exec} = recordingExec()
    const mgr = serviceManager('linux', exec, h)
    mgr.install({...opts, nodePath: '/service/node', entrypoint: '/opt/automator/current/bin/run.js',
      env: {AUTOMATOR_INSTALL_ROOT: '/opt/automator', AUTOMATOR_CONFIG_DIR: '/opt/config', CODEX_HOME: '/opt/codex'}})
    const current = fs.readFileSync(mgr.unitPath(), 'utf8')
    const legacy = current.replace(/^WorkingDirectory=(.*)$/m, (_m, dir) => `WorkingDirectory="${dir}"`)
    fs.writeFileSync(mgr.unitPath(), legacy)

    const adopted = mgr.runtime()
    expect(adopted).not.toBeNull()
    expect(adopted?.workingDir).toBe(opts.workingDir)
  })

  it('keeps the production hosts and sandbox domains in an attestable unit (CYRA-914 B9)', () => {
    // install saves them in the unit: the daemon, the update timer and doctor read the same values instead of a
    // shell environment the daemon never sees.
    const h = home()
    const {exec} = recordingExec()
    const mgr = serviceManager('linux', exec, h)
    mgr.install({...opts, nodePath: '/service/node', entrypoint: '/opt/automator/current/bin/run.js',
      env: {AUTOMATOR_INSTALL_ROOT: '/opt/automator', AUTOMATOR_CONFIG_DIR: '/opt/config', CODEX_HOME: '/opt/codex',
        AUTOMATOR_PRODUCTION_HOSTS: 'prod.example.com', AUTOMATOR_SANDBOX_DOMAINS: 'cyi.example.com'}})

    const adopted = mgr.runtime()
    expect(adopted).not.toBeNull()
    expect(adopted?.env.AUTOMATOR_PRODUCTION_HOSTS).toBe('prod.example.com')
    expect(adopted?.env.AUTOMATOR_SANDBOX_DOMAINS).toBe('cyi.example.com')
  })

  it('rejects non-attestable systemd environment and paths', () => {
    const h = home()
    const {exec} = recordingExec()
    const mgr = serviceManager('linux', exec, h)
    const managed = {
      ...opts,
      nodePath: '/service/node',
      entrypoint: '/opt/automator/current/bin/run.js',
      env: {AUTOMATOR_INSTALL_ROOT: '/opt/automator', AUTOMATOR_CONFIG_DIR: '/opt/config', CODEX_HOME: '/opt/codex'},
    }
    mgr.install(managed)
    const valid = fs.readFileSync(mgr.unitPath(), 'utf8')
    const invalid = [
      valid.replace(/^Environment=.*$/m, 'Environment="HOME=/home" "BROKEN"'),
      valid.replace('"HOME=', '"UNSAFE_TOKEN=x" "HOME='),
      valid.replace('"/service/node"', '"node"'),
      // WorkingDirectory is no longer quoted (CYAU-125): a relative path must still be rejected.
      valid.replace(/^WorkingDirectory=.*$/m, 'WorkingDirectory=relative'),
      // And it stays rejected also in the old quoted form, which the legacy units still have.
      valid.replace(/^WorkingDirectory=.*$/m, 'WorkingDirectory="relative"'),
      valid.replace('"AUTOMATOR_CONFIG_DIR=/opt/config"', '"AUTOMATOR_CONFIG_DIR=relative"'),
      valid.replace('"AUTOMATOR_INSTALL_ROOT=/opt/automator"', '"AUTOMATOR_INSTALL_ROOT=relative"'),
      valid.replace('/opt/automator/current/bin/run.js', '/opt/other/current/bin/run.js'),
    ]

    for (const content of invalid) {
      fs.writeFileSync(mgr.unitPath(), content)
      expect(mgr.runtime()).toBeNull()
    }
  })

  it('systemd restart runs daemon-reload before the restart and propagates the failure', () => {
    const recorded = recordingExec((_cmd, args) =>
      args.includes('daemon-reload') ? {code: 1, stdout: '', stderr: 'reload boom'} : {code: 0, stdout: '', stderr: ''},
    )
    const mgr = serviceManager('linux', recorded.exec, home())

    expect(() => mgr.restart()).toThrow(/daemon-reload.*reload boom/i)
  })

  it('reads the effective ExecStart and environment loaded by systemd', () => {
    const {exec} = recordingExec((_cmd, args) => args.includes('ExecStart') ? {
      code: 0,
      stdout: 'ExecStart={ path=/service/node ; argv[]=/service/node /opt/automator/current/bin/run.js daemon --playbook /p/pb.yml ; ignore_errors=no ; start_time=[n/a] ; }\nEnvironment=HOME=/home AUTOMATOR_INSTALL_ROOT=/opt/automator AUTOMATOR_CONFIG_DIR=/opt/config CODEX_HOME=/opt/codex',
      stderr: '',
    } : {code: 0, stdout: '', stderr: ''})
    const mgr = serviceManager('linux', exec, home())

    expect(mgr.loadedManagedRuntime()).toEqual({
      installRoot: '/opt/automator',
      nodePath: '/service/node',
      entrypoint: '/opt/automator/current/bin/run.js',
      daemonArgs: ['daemon', '--playbook', '/p/pb.yml'],
      configDir: '/opt/config',
      codexHome: '/opt/codex',
    })
  })

  it('rejects a live systemd ExecStart whose executable path diverges from argv[0]', () => {
    const {exec} = recordingExec((_cmd, args) => args.includes('ExecStart') ? {
      code: 0,
      stdout: 'ExecStart={ path=/attacker/node ; argv[]=/service/node /opt/automator/current/bin/run.js daemon --playbook /p/pb.yml ; ignore_errors=no ; start_time=[n/a] ; }\nEnvironment=HOME=/home AUTOMATOR_INSTALL_ROOT=/opt/automator AUTOMATOR_CONFIG_DIR=/opt/config CODEX_HOME=/opt/codex',
      stderr: '',
    } : {code: 0, stdout: '', stderr: ''})
    const mgr = serviceManager('linux', exec, home())

    expect(mgr.loadedRuntime()).toBeNull()
    expect(mgr.loadedManagedRuntime()).toBeNull()
  })

  it('adopts the historical CODEX_HOME for a legacy managed systemd unit, on disk and live', () => {
    const h = home()
    const {exec} = recordingExec((_cmd, args) => args.includes('ExecStart') ? {
      code: 0,
      stdout: 'ExecStart={ path=/service/node ; argv[]=/service/node /opt/automator/current/bin/run.js daemon --playbook /p/pb.yml ; ignore_errors=no ; start_time=[n/a] ; }\nEnvironment=HOME=/home AUTOMATOR_INSTALL_ROOT=/opt/automator AUTOMATOR_CONFIG_DIR=/opt/config',
      stderr: '',
    } : {code: 0, stdout: '', stderr: ''})
    const mgr = serviceManager('linux', exec, h)
    mgr.install({
      ...opts,
      nodePath: '/service/node',
      entrypoint: '/opt/automator/current/bin/run.js',
      env: {AUTOMATOR_INSTALL_ROOT: '/opt/automator', AUTOMATOR_CONFIG_DIR: '/opt/config'},
    })

    expect(mgr.managedRuntime()?.codexHome).toBe(path.join(h, '.codex'))
    expect(mgr.loadedManagedRuntime()?.codexHome).toBe(path.join(h, '.codex'))
  })

  it('a missing or incomplete live definition is not managed', () => {
    const failed = recordingExec(() => ({code: 1, stdout: '', stderr: 'not loaded'}))
    expect(serviceManager('linux', failed.exec, home()).loadedManagedRuntime()).toBeNull()

    const incomplete = recordingExec(() => ({code: 0, stdout: 'ExecStart=\nEnvironment=', stderr: ''}))
    expect(serviceManager('linux', incomplete.exec, home()).loadedManagedRuntime()).toBeNull()
  })

  it('complete systemd restart succeeds and propagates a failed restart', () => {
    const success = recordingExec()
    serviceManager('linux', success.exec, home()).restart()
    expect(success.calls.map((call) => call.args[1])).toEqual(['daemon-reload', 'restart'])

    const failed = recordingExec((_cmd, args) => args.includes('restart')
      ? {code: 1, stdout: '', stderr: 'restart boom'}
      : {code: 0, stdout: '', stderr: ''})
    expect(() => serviceManager('linux', failed.exec, home()).restart()).toThrow(/restart boom/)
  })

  it('systemd install propagates the enable failure', () => {
    const {exec} = recordingExec((_cmd, args) => args.includes('enable')
      ? {code: 1, stdout: '', stderr: 'enable boom'}
      : {code: 0, stdout: '', stderr: ''})
    expect(() => serviceManager('linux', exec, home()).install(opts)).toThrow(/enable boom/)
  })

  it('status active da systemctl show', () => {
    const h = home()
    const {exec} = recordingExec((_c, args) => (args.includes('show') ? {code: 0, stdout: 'ActiveState=active\nMainPID=99', stderr: ''} : {code: 0, stdout: '', stderr: ''}))
    const mgr = serviceManager('linux', exec, h)
    mgr.install(opts)
    const status = mgr.status()
    expect(status.running).toBe(true)
    expect(status.pid).toBe(99)
    expect(mgr.logsPath()).toContain('journalctl')
  })

  it('inactive status does not expose PID zero', () => {
    const {exec} = recordingExec(() => ({code: 0, stdout: 'ActiveState=inactive\nMainPID=0', stderr: ''}))
    expect(serviceManager('linux', exec, home()).status()).toMatchObject({running: false, pid: undefined, detail: 'inattivo'})
  })

  it('uninstall disables and removes the unit', () => {
    const h = home()
    const {exec, calls} = recordingExec()
    const mgr = serviceManager('linux', exec, h)
    mgr.install(opts)
    mgr.uninstall()
    expect(fs.existsSync(mgr.unitPath())).toBe(false)
    expect(calls.some((c) => c.args.includes('disable'))).toBe(true)
  })

  it('missing or unloaded disk/live systemd units are not managed runtimes', () => {
    const h = home()
    const failed = recordingExec(() => ({code: 1, stdout: '', stderr: 'not loaded'}))
    const mgr = serviceManager('linux', failed.exec, h)
    expect(mgr.runtime()).toBeNull()
    expect(mgr.managedRuntime()).toBeNull()
    expect(mgr.loadedRuntime()).toBeNull()
    expect(mgr.loadedManagedRuntime()).toBeNull()
  })

  it('rejects a live systemd definition with continuation or duplicate WorkingDirectory', () => {
    const definitions = [
      'ExecStart={ path=/node ; argv[]=/node /checkout/bin/run.js daemon --playbook /p/p.yml ; ignore_errors=no ; }\\\n continued\nEnvironment=HOME=/home AUTOMATOR_CONFIG_DIR=/config',
      'ExecStart={ path=/node ; argv[]=/node /checkout/bin/run.js daemon --playbook /p/p.yml ; ignore_errors=no ; }\nEnvironment=HOME=/home AUTOMATOR_CONFIG_DIR=/config\nWorkingDirectory=/one\nWorkingDirectory=/two',
    ]
    for (const stdout of definitions) {
      const {exec} = recordingExec(() => ({code: 0, stdout, stderr: ''}))
      expect(serviceManager('linux', exec, home()).loadedRuntime()).toBeNull()
    }
  })

  it('systemd install accepts the missing optional environment', () => {
    const {exec} = recordingExec()
    expect(() => serviceManager('linux', exec, home()).install({...opts, env: undefined})).not.toThrow()
  })
})

// CYAU-95: the skill-mode must be read from the UNIT, not from the shell of whoever runs the command. `enroll` runs in an
// interactive shell, where AUTOMATOR_SKILLS_ENABLED does not exist: asking process.env would yield
// "off" on a machine whose daemon is in skill-mode, and its prerequisites would be declared
// unnecessary exactly where they are needed.
describe('serviceSkillsModeEnabled', () => {
  const manager = (env: Record<string, string> | null, loaded: Record<string, string> | null = null) => ({
    runtime: () => (env === null ? null : ({env} as never)),
    loadedRuntime: () => (loaded === null ? null : ({env: loaded} as never)),
  }) as never

  it('reads the skill-mode from the unit even with a clean shell', () => {
    expect(serviceSkillsModeEnabled(manager({AUTOMATOR_SKILLS_ENABLED: 'true'}), {})).toBe(true)
  })

  it('unit without skill-mode and clean shell → off', () => {
    expect(serviceSkillsModeEnabled(manager({}), {})).toBe(false)
  })

  it('prefers the loaded definition (override/drop-in) over the on-disk one', () => {
    expect(serviceSkillsModeEnabled(manager({}, {AUTOMATOR_SKILLS_ENABLED: '1'}), {})).toBe(true)
  })

  it('missing unit but variable exported by hand → on (the OR never hides a prerequisite)', () => {
    expect(serviceSkillsModeEnabled(manager(null), {AUTOMATOR_SKILLS_ENABLED: 'true'})).toBe(true)
  })

  it('missing unit and clean shell → off', () => {
    expect(serviceSkillsModeEnabled(manager(null), {})).toBe(false)
  })
})

// CYAU-102: DIAGNOSTIC comparison of the service identities — instead of a boolean, the list of the diverging
// fields with expected and actual, so the `automator update` gate can say WHAT does not match.
describe('diagnostic diff of the service runtimes', () => {
  const managed: ManagedServiceRuntime = {
    installRoot: '/opt/a', nodePath: '/service/node', entrypoint: '/opt/a/current/bin/run.js',
    daemonArgs: ['daemon', '--playbook', '/p/pb.yml'], configDir: '/opt/config', codexHome: '/opt/codex',
  }

  it('identical managed runtimes → no divergence', () => {
    expect(diffManagedServiceRuntime({...managed}, managed)).toEqual([])
  })

  it('managed observed null → an explicit divergence on the live definition', () => {
    expect(diffManagedServiceRuntime(null, managed)).toEqual([
      {field: 'definizione live', expected: 'unit gestita leggibile e coerente', actual: 'assente o non interpretabile'},
    ])
  })

  it('managed: reports each diverging field with expected and actual (daemonArgs join)', () => {
    const observed: ManagedServiceRuntime = {
      ...managed, nodePath: '/shim/node', daemonArgs: ['daemon', '--playbook', '/altro/pb.yml'],
    }
    expect(diffManagedServiceRuntime(observed, managed)).toEqual([
      {field: 'nodePath', expected: '/service/node', actual: '/shim/node'},
      {field: 'daemonArgs', expected: 'daemon --playbook /p/pb.yml', actual: 'daemon --playbook /altro/pb.yml'},
    ])
  })

  it('managed: daemonArgs compared element by element, not by join (boundaries preserved)', () => {
    // The two arrays have the SAME join ('daemon --playbook /p a') but a different number of arguments: a comparison
    // via join would wrongly consider them equal. The divergence must emerge anyway.
    const observed: ManagedServiceRuntime = {...managed, daemonArgs: ['daemon', '--playbook', '/p', 'a']}
    const expected: ManagedServiceRuntime = {...managed, daemonArgs: ['daemon', '--playbook', '/p a']}
    expect(diffManagedServiceRuntime(observed, expected)).toEqual([
      {field: 'daemonArgs', expected: 'daemon --playbook /p a', actual: 'daemon --playbook /p a'},
    ])
  })

  const definition: ServiceRuntime = {
    kind: 'managed', platform: 'linux', installRoot: '/opt/a', nodePath: '/service/node',
    entrypoint: '/opt/a/current/bin/run.js', daemonArgs: ['daemon', '--playbook', '/p/pb.yml'],
    pathEnv: '/shims:/usr/bin', homeDir: '/home/agent', workingDir: '/p',
    env: {AUTOMATOR_INSTALL_ROOT: '/opt/a', AUTOMATOR_CONFIG_DIR: '/opt/config'},
    configDir: '/opt/config', codexHome: '/opt/codex',
  }

  it('identical complete definition → no divergence', () => {
    expect(diffServiceRuntime({...definition, env: {...definition.env}}, definition)).toEqual([])
  })

  it('observed definition null → explicit divergence', () => {
    expect(diffServiceRuntime(null, definition)).toEqual([
      {field: 'definizione live', expected: 'unit leggibile e coerente', actual: 'assente o non interpretabile'},
    ])
  })

  it('definition: diverging envs are a single serialized and sorted divergence', () => {
    const observed: ServiceRuntime = {...definition, env: {AUTOMATOR_CONFIG_DIR: '/opt/config', AUTOMATOR_INSTALL_ROOT: '/altro'}}
    const divergences = diffServiceRuntime(observed, definition)
    expect(divergences).toHaveLength(1)
    expect(divergences[0].field).toBe('env')
  })

  it('definition: a missing installRoot (legacy unit) is rendered with the missing marker', () => {
    const observed: ServiceRuntime = {...definition, kind: 'legacy', installRoot: null, env: {...definition.env}}
    const divergences = diffServiceRuntime(observed, definition)
    expect(divergences).toContainEqual({field: 'installRoot', expected: '/opt/a', actual: '(assente)'})
  })

  it('describeRuntimeDivergences composes a readable line for multiple fields', () => {
    const text = describeRuntimeDivergences([
      {field: 'nodePath', expected: '/service/node', actual: '/shim/node'},
      {field: 'codexHome', expected: '/opt/codex', actual: '/altro/codex'},
    ])
    expect(text).toBe('nodePath atteso /service/node effettivo /shim/node; codexHome atteso /opt/codex effettivo /altro/codex')
  })
})

// CYRA-914 B9: doctor runs in a shell without the guardrail inputs the unit carries, and would report the installed
// guardrails as broken while the daemon accepts them.
describe('adoptServiceGuardrailEnv', () => {
  const manager = (env: Record<string, string> | null) => ({
    runtime: () => (env === null ? null : ({env} as never)),
    loadedRuntime: () => null,
  }) as never

  it('copies the hosts and domains of the unit into a shell that lacks them', () => {
    const shell: NodeJS.ProcessEnv = {}
    adoptServiceGuardrailEnv(manager({AUTOMATOR_PRODUCTION_HOSTS: 'prod.example.com', AUTOMATOR_SANDBOX_DOMAINS: 'cyi.example.com'}), shell)
    expect(shell).toEqual({AUTOMATOR_PRODUCTION_HOSTS: 'prod.example.com', AUTOMATOR_SANDBOX_DOMAINS: 'cyi.example.com'})
  })

  it('keeps what the operator exported by hand', () => {
    const shell: NodeJS.ProcessEnv = {AUTOMATOR_PRODUCTION_HOSTS: 'mine.example.com'}
    adoptServiceGuardrailEnv(manager({AUTOMATOR_PRODUCTION_HOSTS: 'prod.example.com'}), shell)
    expect(shell.AUTOMATOR_PRODUCTION_HOSTS).toBe('mine.example.com')
  })

  it('does nothing without an installed unit', () => {
    const shell: NodeJS.ProcessEnv = {}
    adoptServiceGuardrailEnv(manager(null), shell)
    expect(shell).toEqual({})
  })
})
