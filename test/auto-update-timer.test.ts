import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import {afterEach, describe, expect, it} from 'vitest'
import {
  AUTO_UPDATE_SERVICE_UNIT,
  AUTO_UPDATE_TIMER_UNIT,
  autoUpdateUnitPath,
  installAutoUpdate,
  removeAutoUpdate,
  renderAutoUpdateService,
  renderAutoUpdateTimer,
} from '../src/lib/auto-update-timer'

// CYAU-202 — the machine stayed three weeks behind because the update was launched only by hand.
// It is launched by a user systemd timer next to the service: it runs on the host, retries by itself when the
// machine is busy and restarts by itself after a reboot. The oneshot unit must carry the SAME environment as the
// daemon — above all the same state folder, because that is where the lock saying "I am working" lives.

const directories: string[] = []

function temporaryHome(): string {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'automator-timer-'))
  directories.push(directory)
  return directory
}

const FIELDS = {
  nodePath: '/usr/bin/node',
  entrypoint: '/opt/automator/current/bin/run.js',
  pathEnv: '/usr/local/bin:/usr/bin',
  homeDir: '/home/automator',
  runtimeDir: '/run/user/1001',
  env: {
    AUTOMATOR_STATE_DIR: '/home/automator/.local/state/closeyourit-automator',
    AUTOMATOR_CONFIG_DIR: '/home/automator/.config/closeyourit-automator',
    AUTOMATOR_INSTALL_ROOT: '/opt/automator',
    CODEX_HOME: '/home/automator/.codex',
  },
}

afterEach(() => {
  for (const directory of directories.splice(0)) fs.rmSync(directory, {recursive: true, force: true})
})

describe('unit dell aggiornamento automatico', () => {
  it('the oneshot service runs update from the current symlink, with the daemon environment', () => {
    const unit = renderAutoUpdateService(FIELDS)

    expect(unit).toContain('Type=oneshot')
    expect(unit).toContain('ExecStart="/usr/bin/node" "/opt/automator/current/bin/run.js" "update"')
    expect(unit).toContain('AUTOMATOR_STATE_DIR=/home/automator/.local/state/closeyourit-automator')
    expect(unit).toContain('AUTOMATOR_INSTALL_ROOT=/opt/automator')
    expect(unit).toContain('XDG_RUNTIME_DIR=/run/user/1001')
    // A oneshot that restarts by itself after a refusal would fight with the timer: it retries at the next round.
    expect(unit).not.toContain('Restart=')
  })

  it('the timer tries every hour, spread out, and catches up the chance missed while the machine was off', () => {
    const unit = renderAutoUpdateTimer()

    expect(unit).toContain('OnCalendar=hourly')
    expect(unit).toContain('RandomizedDelaySec=')
    expect(unit).toContain('Persistent=true')
    expect(unit).toContain(`Unit=${AUTO_UPDATE_SERVICE_UNIT}`)
    expect(unit).toContain('WantedBy=timers.target')
  })

  it('install writes the two units and enables the timer', () => {
    const homeDir = temporaryHome()
    const calls: Array<{cmd: string; args: string[]}> = []
    const exec = (cmd: string, args: string[]) => {
      calls.push({cmd, args})
      return {code: 0, stdout: '', stderr: ''}
    }

    installAutoUpdate(homeDir, FIELDS, exec)

    expect(fs.existsSync(autoUpdateUnitPath(homeDir, AUTO_UPDATE_SERVICE_UNIT))).toBe(true)
    expect(fs.existsSync(autoUpdateUnitPath(homeDir, AUTO_UPDATE_TIMER_UNIT))).toBe(true)
    expect(calls.map((call) => call.args.join(' '))).toEqual([
      '--user daemon-reload',
      `--user enable --now ${AUTO_UPDATE_TIMER_UNIT}`,
    ])
  })

  it('a timer that does not start is an error: without it, the machine silently falls behind', () => {
    const homeDir = temporaryHome()
    const exec = (_cmd: string, args: string[]) =>
      args.includes('enable') ? {code: 1, stdout: '', stderr: 'unit non caricata'} : {code: 0, stdout: '', stderr: ''}

    expect(() => installAutoUpdate(homeDir, FIELDS, exec)).toThrow(/unit non caricata/)
  })

  it('remove disables the timer and deletes the two units', () => {
    const homeDir = temporaryHome()
    const calls: string[] = []
    const exec = (_cmd: string, args: string[]) => {
      calls.push(args.join(' '))
      return {code: 0, stdout: '', stderr: ''}
    }
    installAutoUpdate(homeDir, FIELDS, exec)
    calls.length = 0

    removeAutoUpdate(homeDir, exec)

    expect(fs.existsSync(autoUpdateUnitPath(homeDir, AUTO_UPDATE_SERVICE_UNIT))).toBe(false)
    expect(fs.existsSync(autoUpdateUnitPath(homeDir, AUTO_UPDATE_TIMER_UNIT))).toBe(false)
    expect(calls).toEqual([`--user disable --now ${AUTO_UPDATE_TIMER_UNIT}`, '--user daemon-reload'])
  })

  it('remove on a machine without timer does not fail (idempotent uninstall)', () => {
    const homeDir = temporaryHome()
    const exec = () => ({code: 1, stdout: '', stderr: 'Unit closeyourit-automator-update.timer not loaded.'})

    expect(() => removeAutoUpdate(homeDir, exec)).not.toThrow()
  })
})
