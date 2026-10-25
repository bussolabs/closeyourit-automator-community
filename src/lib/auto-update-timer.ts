import * as fs from 'node:fs'
import * as path from 'node:path'
import {AutomatorError, ErrorCodes} from '../errors/error-codes'
import {defaultExec, type ExecFn, quoteSystemdWord, renderSystemdCommand} from './service'

// CYAU-202 — who launches the update.
//
// `automator update` already existed and worked; what was missing was someone to run it, and a machine stayed three
// weeks on an old version. A systemd user timer installed next to the daemon launches it: it lives
// on the host, retries by itself when the machine is busy and restarts after a reboot without anyone logging
// into the server. A GitHub Actions job reaching the hosts would have had to retry for hours on
// a working machine anyway, and doing so needed keys and an inventory that are not here.
//
// The oneshot unit receives THE SAME environment as the daemon: without the same `AUTOMATOR_STATE_DIR` the update
// would look at another lock and the "machine free" gate would see nothing.

export const AUTO_UPDATE_SERVICE_UNIT = 'closeyourit-automator-update.service'
export const AUTO_UPDATE_TIMER_UNIT = 'closeyourit-automator-update.timer'

/**
 * An hour, not a day: when the machine is working the update is postponed, and with a single daily
 * attempt a host busy at that moment would skip the whole day. The spread keeps all
 * the hosts from calling the manifest at the same instant.
 */
const ON_CALENDAR = 'hourly'
const RANDOMIZED_DELAY_SEC = 900

export interface AutoUpdateFields {
  nodePath: string
  /** `installRoot/current/bin/run.js`: the SYMLINK path, so the timer always uses the active release. */
  entrypoint: string
  pathEnv: string
  homeDir: string
  env: Record<string, string>
  /** Runtime directory of the service user, already resolved (the D-Bus variables derive from it). */
  runtimeDir?: string
}

/** Path of the user unit, under the same directory as the service. */
export function autoUpdateUnitPath(homeDir: string, unit: string): string {
  return path.join(homeDir, '.config', 'systemd', 'user', unit)
}

export function renderAutoUpdateService(f: AutoUpdateFields): string {
  const dbusEnv = f.runtimeDir
    ? {XDG_RUNTIME_DIR: f.runtimeDir, DBUS_SESSION_BUS_ADDRESS: `unix:path=${f.runtimeDir}/bus`}
    : {}
  let environment = ''
  for (const [key, value] of Object.entries({PATH: f.pathEnv, HOME: f.homeDir, ...dbusEnv, ...f.env})) {
    environment += `${environment ? ' ' : ''}${quoteSystemdWord(`${key}=${value}`)}`
  }
  // No `Restart=`: the command deliberately refuses when the machine is working, and restarting it right away
  // would fight the timer instead of waiting for the next round.
  return `[Unit]
Description=CloseYourIt automator self-update
Wants=network-online.target
After=network-online.target

[Service]
Type=oneshot
ExecStart=${renderSystemdCommand([f.nodePath, f.entrypoint, 'update'])}
Environment=${environment}
`
}

export function renderAutoUpdateTimer(): string {
  // `Persistent=true`: a machine switched off at the timer's hour catches up the missed occasion when it comes back on,
  // instead of waiting for the next one.
  return `[Unit]
Description=CloseYourIt automator self-update (ogni ora)

[Timer]
OnCalendar=${ON_CALENDAR}
RandomizedDelaySec=${RANDOMIZED_DELAY_SEC}
Persistent=true
Unit=${AUTO_UPDATE_SERVICE_UNIT}

[Install]
WantedBy=timers.target
`
}

/** Writes the two units and turns on the timer. A timer that does not turn on is an error: silently the machine would fall behind. */
export function installAutoUpdate(homeDir: string, fields: AutoUpdateFields, exec: ExecFn = defaultExec): void {
  const servicePath = autoUpdateUnitPath(homeDir, AUTO_UPDATE_SERVICE_UNIT)
  fs.mkdirSync(path.dirname(servicePath), {recursive: true})
  fs.writeFileSync(servicePath, renderAutoUpdateService(fields))
  fs.writeFileSync(autoUpdateUnitPath(homeDir, AUTO_UPDATE_TIMER_UNIT), renderAutoUpdateTimer())
  exec('systemctl', ['--user', 'daemon-reload'])
  const enabled = exec('systemctl', ['--user', 'enable', '--now', AUTO_UPDATE_TIMER_UNIT])
  if (enabled.code !== 0) {
    throw new AutomatorError(
      ErrorCodes.Service.installFailed,
      `abilitazione del timer di aggiornamento fallita: ${enabled.stderr.trim()}`,
    )
  }
}

/** Turns off the timer and removes the units. Idempotent: it does not fail on a machine that never had it. */
export function removeAutoUpdate(homeDir: string, exec: ExecFn = defaultExec): void {
  exec('systemctl', ['--user', 'disable', '--now', AUTO_UPDATE_TIMER_UNIT])
  fs.rmSync(autoUpdateUnitPath(homeDir, AUTO_UPDATE_TIMER_UNIT), {force: true})
  fs.rmSync(autoUpdateUnitPath(homeDir, AUTO_UPDATE_SERVICE_UNIT), {force: true})
  exec('systemctl', ['--user', 'daemon-reload'])
}
