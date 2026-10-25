import {execFile} from 'node:child_process'
import * as fs from 'node:fs'
import {constants as fsConstants} from 'node:fs'
import {createStrongContainmentBackend} from './process-containment'
import {attestWriteConfinement, type WriteConfinementAttestation} from './write-confinement'

const SECRET_TOOL = '/usr/bin/secret-tool'
const PROBE_TIMEOUT_MS = 5000
const PROBE_MAX_BYTES = 4096

export type LinuxHostCheckId = 'linux' | 'systemd-cgroup-v2' | 'bubblewrap' | 'secret-service'

export interface LinuxHostCheck {
  id: LinuxHostCheckId
  ok: boolean
  detail?: string
}

interface Availability {
  available: boolean
  detail?: string
}

export interface LinuxHostProbeIo {
  platform: NodeJS.Platform
  strongContainmentAvailable(): Availability | Promise<Availability>
  attestWriteConfinement(): WriteConfinementAttestation | Promise<WriteConfinementAttestation>
  secretServiceAvailable(): Availability | Promise<Availability>
}

function runtimeDir(): string | undefined {
  const configured = process.env.XDG_RUNTIME_DIR?.trim()
  if (configured) return configured
  const uid = process.getuid?.()
  return uid === undefined ? undefined : `/run/user/${uid}`
}

function probeSecretService(): Promise<Availability> {
  const dir = runtimeDir()
  if (!dir || !fs.existsSync(`${dir}/bus`)) {
    return Promise.resolve({available: false, detail: 'sessione D-Bus utente non raggiungibile'})
  }
  try {
    fs.accessSync(SECRET_TOOL, fsConstants.X_OK)
  } catch {
    return Promise.resolve({available: false, detail: `${SECRET_TOOL} assente o non eseguibile`})
  }

  return new Promise((resolve) => {
    execFile(SECRET_TOOL, ['search', '--all', 'service', 'it.closeyour.automator.probe'], {
      encoding: 'utf8',
      timeout: PROBE_TIMEOUT_MS,
      maxBuffer: PROBE_MAX_BYTES,
      killSignal: 'SIGKILL',
      env: {
        PATH: '/usr/bin:/bin',
        LANG: 'C',
        LC_ALL: 'C',
        XDG_RUNTIME_DIR: dir,
        DBUS_SESSION_BUS_ADDRESS: `unix:path=${dir}/bus`,
      },
    }, (error) => {
      resolve(error === null
        ? {available: true}
        : {available: false, detail: 'Secret Service assente, bloccato o non sbloccato'})
    })
  })
}

function defaultIo(): LinuxHostProbeIo {
  const strong = createStrongContainmentBackend()
  return {
    platform: process.platform,
    strongContainmentAvailable: () => strong.available(),
    attestWriteConfinement,
    secretServiceAvailable: probeSecretService,
  }
}

export async function probeLinuxHost(io: LinuxHostProbeIo = defaultIo()): Promise<LinuxHostCheck[]> {
  if (io.platform !== 'linux') {
    return [{id: 'linux', ok: false, detail: 'Automator supporta esclusivamente Linux'}]
  }

  const [strong, write, secrets] = await Promise.all([
    io.strongContainmentAvailable(),
    io.attestWriteConfinement(),
    io.secretServiceAvailable(),
  ])
  return [
    {id: 'linux', ok: true},
    {id: 'systemd-cgroup-v2', ok: strong.available, ...(strong.detail ? {detail: strong.detail} : {})},
    {id: 'bubblewrap', ok: write.attested, ...(write.detail ? {detail: write.detail} : {})},
    {id: 'secret-service', ok: secrets.available, ...(secrets.detail ? {detail: secrets.detail} : {})},
  ]
}

export function requireLinuxHost(checks: LinuxHostCheck[]): void {
  const missing = checks.filter((check) => !check.ok)
  if (missing.length === 0) return
  throw new Error(missing.map((check) => `${check.id}: ${check.detail ?? 'requisito non disponibile'}`).join('; '))
}
