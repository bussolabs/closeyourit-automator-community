import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import {afterEach, beforeEach, describe, expect, it} from 'vitest'
import Gate from '../src/commands/gate'
import {BUSY_MARKER_FILE} from '../src/lib/busy-marker'
import {runCaptured, runExpectingExit} from './helpers/command'

// The `gate` command (CYAU-23) is the quality gate: the orchestrator invokes it after the implementation, before the
// review and the PR. It reads the repository's VERSIONED config (`.closeyourit/quality-gate.yml`), runs the
// declared checks (here with `runner: []` → direct `sh -c`, so the tests do not depend on mise) and FAILS if
// a MANDATORY check does not pass (DoD). Safe-by-default shell gate (like cycle/lease): passed → exit 0;
// a mandatory one does not pass → exit 3; invalid/missing config → exit 2. The record contains NO secrets.

let repo: string

interface Check {
  stage: string
  run: string
  required?: boolean
  timeout?: number
}

/** Writes `.closeyourit/quality-gate.yml` in the temporary repo, with `runner: []` (direct `sh -c` execution). */
function writeGate(checks: Check[], extra: Record<string, unknown> = {}): void {
  const config = {version: 1, runner: [], checks, ...extra}
  fs.mkdirSync(path.join(repo, '.closeyourit'), {recursive: true})
  fs.writeFileSync(path.join(repo, '.closeyourit', 'quality-gate.yml'), JSON.stringify(config))
}

interface GatePayload {
  config: string
  cwd: string
  dryRun: boolean
  passed?: boolean
  checks?: {stage: string; command: string; required: boolean; status: string; exitCode: number | null; durationMs: number}[]
  planned?: {stage: string; required: boolean; timeout: number; command: string}[]
  failedRequired?: {stage: string}[]
  failedAdvisory?: {stage: string}[]
  reasons?: string[]
  error?: {code: string; message: string}
}

beforeEach(() => {
  repo = fs.mkdtempSync(path.join(os.tmpdir(), 'automator-cmd-gate-'))
})

afterEach(() => {
  fs.rmSync(repo, {recursive: true, force: true})
})

describe('gate command — Scenario 1: the gate fails if a mandatory check does not pass (DoD)', () => {
  it('all checks pass → exit 0, gate passed', async () => {
    writeGate([
      {stage: 'setup', run: 'true'},
      {stage: 'unit', run: 'true'},
    ])
    const {result} = await runCaptured(Gate, ['--cwd', repo, '--json'])
    const p = result as GatePayload
    expect(p.passed).toBe(true)
    expect(p.checks?.map((c) => c.status)).toEqual(['passed', 'passed'])
  })

  it('a failed mandatory check → exit 3, dedicated code (do not proceed to review/PR)', async () => {
    writeGate([
      {stage: 'setup', run: 'true'},
      {stage: 'unit', run: 'exit 1'},
    ])
    const {stderr, stdout} = await runExpectingExit(Gate, ['--cwd', repo, '--json'], 3)
    const p = JSON.parse(stdout) as GatePayload
    expect(p.passed).toBe(false)
    expect(p.failedRequired?.[0].stage).toBe('unit')
    expect(p.error?.code).toBe('C409-GATE-002')
    expect(stderr).toBe('')
  })

  it('a failed NON-mandatory check → exit 0 (advisory, does not block the gate)', async () => {
    writeGate([
      {stage: 'unit', run: 'true'},
      {stage: 'lint', run: 'exit 1', required: false},
    ])
    const {result} = await runCaptured(Gate, ['--cwd', repo, '--json'])
    const p = result as GatePayload
    expect(p.passed).toBe(true)
    expect(p.failedAdvisory?.[0].stage).toBe('lint')
  })
})

describe('gate command — fail-fast e keep-going', () => {
  it('fail-fast by default: after a failed mandatory one the following ones are skipped', async () => {
    writeGate([
      {stage: 'setup', run: 'exit 1'},
      {stage: 'unit', run: 'true'},
      {stage: 'lint', run: 'true'},
    ])
    const {stdout} = await runExpectingExit(Gate, ['--cwd', repo, '--json'], 3)
    const p = JSON.parse(stdout) as GatePayload
    expect(p.checks?.map((c) => c.status)).toEqual(['failed', 'skipped', 'skipped'])
  })

  it('--keep-going runs all checks even after a failed mandatory one (full report)', async () => {
    writeGate([
      {stage: 'setup', run: 'exit 1'},
      {stage: 'unit', run: 'true'},
    ])
    const {stdout} = await runExpectingExit(Gate, ['--cwd', repo, '--keep-going', '--json'], 3)
    const p = JSON.parse(stdout) as GatePayload
    expect(p.checks?.map((c) => c.status)).toEqual(['failed', 'passed'])
  })
})

describe('gate command — only e dry-run', () => {
  it('--only narrows to the requested stages (an excluded mandatory one does not make the gate fail)', async () => {
    writeGate([
      {stage: 'unit', run: 'exit 1'},
      {stage: 'lint', run: 'true'},
    ])
    const {result} = await runCaptured(Gate, ['--cwd', repo, '--only', 'lint', '--json'])
    const p = result as GatePayload
    expect(p.passed).toBe(true)
    expect(p.checks?.map((c) => c.stage)).toEqual(['lint'])
  })

  it('--dry-run plans without executing (a check that would fail is NOT executed → exit 0)', async () => {
    writeGate([{stage: 'unit', run: 'exit 1'}])
    const {result, stdout} = await runCaptured(Gate, ['--cwd', repo, '--dry-run'])
    const p = result as GatePayload
    expect(p.dryRun).toBe(true)
    expect(p.planned?.[0].stage).toBe('unit')
    expect(p.checks).toBeUndefined()
    expect(stdout).toContain('sh -c')
  })

  it('--dry-run in --json lists the planned commands (recorded without secrets: only the argv)', async () => {
    writeGate([{stage: 'unit', run: 'pnpm test'}], {runner: ['mise', 'exec', '--']})
    const {result} = await runCaptured(Gate, ['--cwd', repo, '--dry-run', '--json'])
    const p = result as GatePayload
    expect(p.planned?.[0].command).toContain('mise exec -- sh -c')
  })

  it('--dry-run masks command, config and cwd in the JSON payload and in the human output', async () => {
    const commandToken = 'cyi_ah_G'
    const cwdToken = `cyi_h_${'H'.repeat(24)}`
    const sensitiveRepo = fs.mkdtempSync(path.join(os.tmpdir(), `gate_archive_${cwdToken}_`))
    fs.rmSync(repo, {recursive: true, force: true})
    repo = sensitiveRepo
    writeGate([{stage: 'unit', run: `true # backup_${commandToken}`}])

    const json = await runCaptured(Gate, ['--cwd', repo, '--dry-run', '--json'])
    const dump = JSON.stringify(json.result)
    expect(dump).toContain('[REDACTED]')
    expect(dump).not.toContain(commandToken)
    expect(dump).not.toContain(cwdToken)

    const human = await runCaptured(Gate, ['--cwd', repo, '--dry-run'])
    expect(human.stdout).toContain('[REDACTED]')
    expect(human.stdout).not.toContain(commandToken)
  })

  it('non-dry-run report and reasons do not reflect the raw command', async () => {
    const token = 'cyi_ah_R'
    writeGate([{stage: 'unit', run: `false # archive_${token}`}])
    const {stdout} = await runExpectingExit(Gate, ['--cwd', repo, '--json'], 3)
    expect(stdout).toContain('[REDACTED]')
    expect(stdout).not.toContain(token)
  })
})

describe('gate command — CYAU-168: the folder shows as in use while the gate works', () => {
  /** The marker exists only while the gate runs: the check itself takes its snapshot. */
  function gitCheckoutWithProbe(): {marker: string; seen: string} {
    fs.mkdirSync(path.join(repo, '.git'))
    const seen = path.join(repo, 'marcatore-visto.json')
    return {marker: path.join(repo, '.git', BUSY_MARKER_FILE), seen}
  }

  it('during the checks the marker declares pid, start time and ticket; once the gate passes it disappears', async () => {
    const {marker, seen} = gitCheckoutWithProbe()
    writeGate([{stage: 'unit', run: `cp .git/${BUSY_MARKER_FILE} ${seen}`}])

    const {result} = await runCaptured(Gate, ['--cwd', repo, '--ticket', 'CYAU-168', '--json'])
    expect((result as GatePayload).passed).toBe(true)

    const observed = JSON.parse(fs.readFileSync(seen, 'utf8'))
    expect(observed).toMatchObject({label: 'quality-gate', pid: process.pid, ticket: 'CYAU-168'})
    expect(Number.isNaN(Date.parse(observed.startedAt))).toBe(false)
    expect(fs.existsSync(marker)).toBe(false)
  })

  it('the marker disappears even when a mandatory check fails', async () => {
    const {marker, seen} = gitCheckoutWithProbe()
    writeGate([{stage: 'unit', run: `cp .git/${BUSY_MARKER_FILE} ${seen} && false`}])

    await runExpectingExit(Gate, ['--cwd', repo, '--json'], 3)
    expect(fs.existsSync(seen)).toBe(true)
    expect(fs.existsSync(marker)).toBe(false)
  })

  it('without ticket the marker stays valid; --dry-run marks nothing', async () => {
    const {marker, seen} = gitCheckoutWithProbe()
    writeGate([{stage: 'unit', run: `cp .git/${BUSY_MARKER_FILE} ${seen}`}])

    await runCaptured(Gate, ['--cwd', repo, '--json'])
    expect(JSON.parse(fs.readFileSync(seen, 'utf8'))).toMatchObject({ticket: null})

    fs.rmSync(seen)
    await runCaptured(Gate, ['--cwd', repo, '--dry-run', '--json'])
    expect(fs.existsSync(seen)).toBe(false)
    expect(fs.existsSync(marker)).toBe(false)
  })

  it('a folder without .git receives no markers and the gate runs anyway', async () => {
    writeGate([{stage: 'unit', run: 'true'}])
    const {result} = await runCaptured(Gate, ['--cwd', repo, '--ticket', 'CYAU-168', '--json'])

    expect((result as GatePayload).passed).toBe(true)
    expect(fs.existsSync(path.join(repo, BUSY_MARKER_FILE))).toBe(false)
  })

  it('--ticket is not trusted: a hostile value exits cleanly (exit 2) instead of ending up in the marker', async () => {
    fs.mkdirSync(path.join(repo, '.git'))
    writeGate([{stage: 'unit', run: 'true'}])

    const {stderr} = await runExpectingExit(Gate, ['--cwd', repo, '--ticket', '../../fuori'], 2)
    expect(stderr).toContain('C400-GATE-001')
    expect(fs.existsSync(path.join(repo, '.git', BUSY_MARKER_FILE))).toBe(false)
  })
})

describe('gate command — difesa all’ingresso e config', () => {
  it('config not found → exit 2, dedicated code', async () => {
    const {stderr} = await runExpectingExit(Gate, ['--cwd', repo], 2)
    expect(stderr).toContain('C404-GATE-003')
  })

  it('config with an unknown stage → exit 2', async () => {
    writeGate([{stage: 'e2e', run: 'true'}])
    const {stderr} = await runExpectingExit(Gate, ['--cwd', repo], 2)
    expect(stderr).toContain('C400-GATE-001')
  })

  it('--only with an unknown stage → exit 2 (untrusted CLI override)', async () => {
    writeGate([{stage: 'unit', run: 'true'}])
    const {stderr} = await runExpectingExit(Gate, ['--cwd', repo, '--only', 'nope'], 2)
    expect(stderr).toContain('C400-GATE-001')
  })

  it('--only selecting no configured check → exit 2 (no fail-open: never a "passed" gate without checking)', async () => {
    writeGate([{stage: 'unit', run: 'true'}])
    const {stderr} = await runExpectingExit(Gate, ['--cwd', repo, '--only', 'security'], 2)
    expect(stderr).toContain('C400-GATE-001')
  })

  it('explicit --config takes precedence over the repository default', async () => {
    const custom = path.join(repo, 'custom-gate.yml')
    fs.writeFileSync(custom, JSON.stringify({version: 1, runner: [], checks: [{stage: 'security', run: 'true'}]}))
    const {result} = await runCaptured(Gate, ['--cwd', repo, '--config', custom, '--json'])
    const p = result as GatePayload
    expect(p.passed).toBe(true)
    expect(p.checks?.[0].stage).toBe('security')
  })

  it('human output shows the stages, the outcome and the reasons; --json does not print the human-readable lines', async () => {
    writeGate([{stage: 'unit', run: 'true'}])
    const human = await runCaptured(Gate, ['--cwd', repo])
    expect(human.stdout.toLowerCase()).toContain('unit')
    expect(human.stdout.toLowerCase()).toContain('quality gate')

    const json = await runCaptured(Gate, ['--cwd', repo, '--json'])
    expect(json.stdout).not.toContain('quality gate ·')
  })
})
