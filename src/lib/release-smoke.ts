import {spawn, spawnSync, type ChildProcess} from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import {pathToFileURL} from 'node:url'

import {
  assertReleaseChannel,
  computeSha256,
  currentLinkFor,
  defaultUpdateProbe,
  parseSemver,
  runUpdate,
  type ReleaseChannel,
  type UpdateOutcome,
  type UpdateProbe,
  type UpdateResult,
} from './update'

const BASELINE_VERSION = '0.0.0'

export interface ReleaseSmokeInput {
  artifact: string
  version: string
  channel: ReleaseChannel
  workspace?: string
}

export interface ReleaseSmokeResult {
  version: string
  channel: ReleaseChannel
  freshInstall: UpdateOutcome
  upgrade: UpdateOutcome
  rollback: UpdateOutcome
  rollbackTarget: string | null
  restartCount: number
}

function requireFile(file: string, label: string): string {
  const resolved = path.resolve(file)
  if (!fs.statSync(resolved, {throwIfNoEntry: false})?.isFile()) throw new Error(`${label} non trovato: ${resolved}`)
  return resolved
}

function packBaseline(workspace: string, candidate: string): string {
  const stageName = `automator-${BASELINE_VERSION}`
  const stage = path.join(workspace, stageName)
  fs.mkdirSync(stage, {recursive: true})
  const extracted = spawnSync('tar', ['-xzf', candidate, '-C', stage, '--strip-components=1'], {encoding: 'utf8'})
  if (extracted.status !== 0) throw new Error(`estrazione baseline fallita: ${extracted.stderr.trim()}`)
  const packageFile = requireFile(path.join(stage, 'package.json'), 'package baseline')
  const metadata = JSON.parse(fs.readFileSync(packageFile, 'utf8')) as Record<string, unknown>
  metadata.version = BASELINE_VERSION
  fs.writeFileSync(packageFile, `${JSON.stringify(metadata)}\n`)
  const archive = path.join(workspace, `${stageName}.tgz`)
  const result = spawnSync('tar', ['-czf', archive, stageName], {cwd: workspace, encoding: 'utf8'})
  if (result.status !== 0) throw new Error(`creazione baseline fallita: ${result.stderr.trim()}`)
  return archive
}

function writeHealthHarness(workspace: string): {script: string; serviceScript: string; failVersion: string} {
  const failVersion = path.join(workspace, 'fail-version')
  const script = path.join(workspace, 'health.mjs')
  fs.writeFileSync(script, `
import {spawnSync} from 'node:child_process'
import fs from 'node:fs'
const [entrypoint, failFile, serviceState] = process.argv.slice(2)
const result = spawnSync(process.execPath, [entrypoint, '--version'], {encoding: 'utf8'})
process.stdout.write(result.stdout || '')
process.stderr.write(result.stderr || '')
if (result.status !== 0) process.exit(result.status || 1)
const state = JSON.parse(fs.readFileSync(serviceState, 'utf8'))
if (!Number.isSafeInteger(state.pid) || state.pid <= 0 || state.output !== (result.stdout || '').trim()) process.exit(43)
try { process.kill(state.pid, 0) } catch { process.exit(44) }
const fail = fs.existsSync(failFile) ? fs.readFileSync(failFile, 'utf8').trim() : ''
if (fail && (result.stdout || '').startsWith('@bussolabs/closeyourit-automator/' + fail + ' ')) process.exit(42)
`)
  const serviceScript = path.join(workspace, 'service.mjs')
  fs.writeFileSync(serviceScript, `
import {spawnSync} from 'node:child_process'
import fs from 'node:fs'
const [entrypoint, serviceState] = process.argv.slice(2)
const result = spawnSync(process.execPath, [entrypoint, '--version'], {encoding: 'utf8'})
if (result.status !== 0) process.exit(result.status || 1)
fs.writeFileSync(serviceState, JSON.stringify({pid: process.pid, output: (result.stdout || '').trim()}))
const stop = () => { try { fs.rmSync(serviceState, {force: true}) } finally { process.exit(0) } }
process.on('SIGTERM', stop)
process.on('SIGINT', stop)
setInterval(() => undefined, 1000)
`)
  return {script, serviceScript, failVersion}
}

interface ServiceAdapter {
  restart(): void
  healthCommand(): {cmd: string; args: string[]}
  stop(): void
}

function serviceAdapter(
  installRoot: string,
  health: {script: string; serviceScript: string; failVersion: string},
  onRestart: () => void,
): ServiceAdapter {
  let generation = 0
  let serviceState = path.join(installRoot, 'service-state-0.json')
  let child: ChildProcess | null = null
  const sleeper = new Int32Array(new SharedArrayBuffer(4))
  return {
    restart() {
      child?.kill('SIGTERM')
      generation += 1
      serviceState = path.join(installRoot, `service-state-${generation}.json`)
      fs.rmSync(serviceState, {force: true})
      const entrypoint = path.join(installRoot, 'current', 'bin', 'run.js')
      child = spawn(process.execPath, [health.serviceScript, entrypoint, serviceState], {stdio: 'ignore'})
      // The full suite runs many Git/CLI subprocesses in parallel: the service adapter stays bounded but
      // grants enough time to the real process even on contended CI runners.
      const deadline = Date.now() + 20_000
      while (!fs.existsSync(serviceState) && child.exitCode === null && Date.now() < deadline) {
        Atomics.wait(sleeper, 0, 0, 10)
      }
      if (!fs.existsSync(serviceState) || child.exitCode !== null) throw new Error('service adapter non avviato')
      onRestart()
    },
    healthCommand: () => ({
      cmd: process.execPath,
      args: [health.script, path.join(installRoot, 'current', 'bin', 'run.js'), health.failVersion, serviceState],
    }),
    stop() {
      child?.kill('SIGKILL')
      child = null
      fs.rmSync(serviceState, {force: true})
    },
  }
}

function writeManifest(
  workspace: string,
  channel: ReleaseChannel,
  artifacts: Array<{version: string; file: string}>,
): string {
  const manifestRoot = path.join(workspace, 'manifest')
  fs.mkdirSync(manifestRoot, {recursive: true})
  const releases = artifacts.map(({version, file}) => ({
    version,
    channel,
    url: pathToFileURL(file).href,
    sha256: computeSha256(fs.readFileSync(file)),
  }))
  fs.writeFileSync(path.join(manifestRoot, `${channel}.json`), `${JSON.stringify({channel, releases})}\n`)
  return pathToFileURL(manifestRoot).href.replace(/\/$/, '')
}

function probeFor(
  installRoot: string,
  manifestBaseUrl: string,
  health: {script: string; failVersion: string},
  service: ServiceAdapter,
  installed: boolean,
): UpdateProbe {
  return defaultUpdateProbe({
    installRoot,
    manifestBaseUrl,
    restartCommand: {cmd: process.execPath, args: ['-e', 'process.exit(99)']},
    restartService: service.restart,
    healthCommand: installed
      ? service.healthCommand
      : () => ({cmd: process.execPath, args: [path.join(installRoot, 'current', 'bin', 'run.js'), '--version']}),
    candidateHealthCommand: (releaseDir) => ({
      cmd: process.execPath,
      args: [path.join(releaseDir, 'bin', 'run.js'), '--version'],
    }),
    serviceInstalled: () => installed,
    serviceRunning: () => true,
    installGuardrails: () => ({hooksDir: '', settingsPath: '', codexRulesPath: '', hooks: []}),
  })
}

function updateTo(installRoot: string, channel: ReleaseChannel, version: string, probe: UpdateProbe): UpdateResult {
  return runUpdate({installRoot, channel, targetVersion: version, allowDowngrade: true}, probe)
}

function unexpectedUpdate(label: string, result: UpdateResult): Error {
  return new Error(`${label}: ${result.outcome}; ${result.reason}; ${result.reasons.join(' | ')}`)
}

function currentTarget(installRoot: string): string | null {
  const target = fs.readlinkSync(currentLinkFor(installRoot), {encoding: 'utf8'})
  return target ? path.basename(target) : null
}

export function runReleaseSmoke(input: ReleaseSmokeInput): ReleaseSmokeResult {
  assertReleaseChannel(input.channel)
  if (parseSemver(input.version) === null) throw new Error(`versione non SemVer: ${input.version}`)
  const artifact = requireFile(input.artifact, 'artifact')
  const workspace = path.resolve(input.workspace ?? fs.mkdtempSync(path.join(os.tmpdir(), 'automator-release-smoke-')))
  fs.mkdirSync(workspace, {recursive: true})

  const baseline = packBaseline(workspace, artifact)
  const health = writeHealthHarness(workspace)
  const manifestBaseUrl = writeManifest(workspace, input.channel, [
    {version: BASELINE_VERSION, file: baseline},
    {version: input.version, file: artifact},
  ])
  let restartCount = 0
  const services: ServiceAdapter[] = []
  const makeProbe = (installRoot: string, installed = true): {probe: UpdateProbe; service: ServiceAdapter} => {
    const service = serviceAdapter(installRoot, health, () => { restartCount += 1 })
    services.push(service)
    return {probe: probeFor(installRoot, manifestBaseUrl, health, service, installed), service}
  }

  try {
    const freshRoot = path.join(workspace, 'fresh')
    const fresh = makeProbe(freshRoot, false)
    const freshResult = updateTo(freshRoot, input.channel, input.version, fresh.probe)
    const freshInstall = freshResult.outcome
    if (freshInstall !== 'updated') throw unexpectedUpdate('fresh install fallita', freshResult)
    fresh.service.restart()
    const freshHealth = spawnSync(fresh.service.healthCommand().cmd, fresh.service.healthCommand().args)
    if (freshHealth.status !== 0) throw new Error(`servizio fresh non sano: exit ${String(freshHealth.status)}`)

    const upgradeRoot = path.join(workspace, 'upgrade')
    const upgradeProbe = makeProbe(upgradeRoot).probe
    const baselineResult = updateTo(upgradeRoot, input.channel, BASELINE_VERSION, upgradeProbe)
    const baselineInstall = baselineResult.outcome
    if (baselineInstall !== 'updated') throw unexpectedUpdate('bootstrap upgrade inatteso', baselineResult)
    const upgradeResult = updateTo(upgradeRoot, input.channel, input.version, upgradeProbe)
    const upgrade = upgradeResult.outcome
    if (upgrade !== 'updated') throw unexpectedUpdate('upgrade fallito', upgradeResult)

    const rollbackRoot = path.join(workspace, 'rollback')
    const rollbackProbe = makeProbe(rollbackRoot).probe
    const rollbackBaselineResult = updateTo(rollbackRoot, input.channel, BASELINE_VERSION, rollbackProbe)
    const rollbackBaseline = rollbackBaselineResult.outcome
    if (rollbackBaseline !== 'updated') throw unexpectedUpdate('bootstrap rollback inatteso', rollbackBaselineResult)
    fs.writeFileSync(health.failVersion, `${input.version}\n`)
    const rollbackResult = updateTo(rollbackRoot, input.channel, input.version, rollbackProbe)
    const rollback = rollbackResult.outcome
    if (rollback !== 'rolled-back') throw unexpectedUpdate('rollback fallito', rollbackResult)
    const rollbackTarget = currentTarget(rollbackRoot)
    if (rollbackTarget !== BASELINE_VERSION) throw new Error(`target rollback inatteso: ${String(rollbackTarget)}`)

    return {
      version: input.version,
      channel: input.channel,
      freshInstall,
      upgrade,
      rollback,
      rollbackTarget,
      restartCount,
    }
  } finally {
    services.forEach((service) => service.stop())
  }
}
