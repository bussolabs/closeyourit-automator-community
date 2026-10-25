import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import {afterAll, describe, expect, it} from 'vitest'
import {
  buildCheckCommand,
  type CheckOutcome,
  type CheckResult,
  DEFAULT_GATE_TIMEOUT_S,
  DEFAULT_RUNNER,
  defaultCheckRunner,
  evaluateGate,
  GATE_STAGES,
  type GateChild,
  type GateSpawnFn,
  isGateStage,
  loadQualityGate,
  orderChecks,
  type PlannedCheck,
  planGate,
  QualityGateConfigSchema,
  runGate,
  validateQualityGate,
} from '../src/lib/quality-gate'
import {AutomatorError} from '../src/errors/error-codes'

// Per-repository configurable quality gates (CYAU-23). Each repository declares the repeatable checks
// (setup/unit/integration/lint/typecheck/security/full) that Automator runs with mise and timeout before the
// review and the PR. The DoD core is pure and testable without spawn: `evaluateGate` fails the gate if a
// MANDATORY check does not pass; the results record NEVER contains secrets (neither env nor output).

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'automator-gate-'))
afterAll(() => fs.rmSync(tmp, {recursive: true, force: true}))

let seq = 0
function writeConfig(body: string): string {
  const file = path.join(tmp, `qg-${seq++}.yml`)
  fs.writeFileSync(file, body)
  return file
}

/** A check result for `evaluateGate` (only the recorded fields: never secrets). */
function result(over: Partial<CheckResult>): CheckResult {
  return {stage: 'unit', command: 'sh -c true', required: true, status: 'passed', exitCode: 0, durationMs: 1, ...over}
}

interface SpawnBehavior {
  code?: number | null
  hang?: boolean
  errorEvent?: boolean
}

/** Fake gate spawn: controlled outcome + `pid`, and an injectable killFn that records the signals to the process group. */
function makeGateSpawn(behavior: SpawnBehavior): {
  spawn: GateSpawnFn
  kill: (pid: number, signal: NodeJS.Signals) => void
  signals: () => {pid: number; signal: NodeJS.Signals}[]
  detached: () => boolean
} {
  let closeCb: ((code: number | null, sig: NodeJS.Signals | null) => void) | undefined
  let errorCb: ((e: Error) => void) | undefined
  let detachedFlag = false
  const recorded: {pid: number; signal: NodeJS.Signals}[] = []

  const spawn: GateSpawnFn = (_cmd, _args, opts) => {
    detachedFlag = opts.detached
    const child: GateChild = {
      pid: 4242,
      stdout: {on: () => undefined},
      stderr: {on: () => undefined},
      on: (ev, cb) => {
        if (ev === 'error') errorCb = cb as (e: Error) => void
        if (ev === 'close') {
          closeCb = cb as (code: number | null, sig: NodeJS.Signals | null) => void
          if (behavior.errorEvent) queueMicrotask(() => errorCb?.(new Error('spawn boom')))
          else if (!behavior.hang) queueMicrotask(() => closeCb?.(behavior.code ?? 0, null))
        }
      },
      kill: () => true,
    }
    return child
  }

  // Injected killFn: records the signal and (on SIGTERM to the group) simulates termination → closes the hung child.
  const kill = (pid: number, signal: NodeJS.Signals): void => {
    recorded.push({pid, signal})
    if (signal === 'SIGTERM') closeCb?.(null, 'SIGTERM')
  }

  return {spawn, kill, signals: () => recorded, detached: () => detachedFlag}
}

describe('quality-gate — schema and loader (versioned per-repository config)', () => {
  it('applies the defaults: required=true, runner=mise exec --, global timeout', () => {
    const config = QualityGateConfigSchema.parse({version: 1, checks: [{stage: 'unit', run: 'pnpm test'}]})
    expect(config.checks[0].required).toBe(true)
    expect(config.runner).toEqual(DEFAULT_RUNNER)
    expect(config.timeout).toBe(DEFAULT_GATE_TIMEOUT_S)
  })

  it('the seven canonical stages are those of the technical analysis', () => {
    expect(GATE_STAGES).toEqual(['setup', 'unit', 'integration', 'lint', 'typecheck', 'security', 'full'])
  })

  it('rejects an unknown stage', () => {
    const r = QualityGateConfigSchema.safeParse({version: 1, checks: [{stage: 'e2e', run: 'x'}]})
    expect(r.success).toBe(false)
  })

  it('rejects the empty check list', () => {
    const r = QualityGateConfigSchema.safeParse({version: 1, checks: []})
    expect(r.success).toBe(false)
  })

  it('version 2 declares the remote GitHub gate with mandatory checks and bounded waits', () => {
    const config = QualityGateConfigSchema.parse({
      version: 2,
      checks: [{stage: 'lint', run: 'pnpm lint'}],
      remote: {provider: 'github', required_checks: ['ci / ci-gate', 'migration-versions']},
    })
    expect(config.remote).toEqual({
      provider: 'github', required_checks: ['ci / ci-gate', 'migration-versions'],
      timeout: 1800, poll_interval: 10,
    })
  })

  it('rejects unknown versions and a v2 without remote gate', () => {
    expect(QualityGateConfigSchema.safeParse({version: 3, checks: [{stage: 'unit', run: 'x'}]}).success).toBe(false)
    expect(QualityGateConfigSchema.safeParse({version: 2, checks: [{stage: 'unit', run: 'x'}]}).success).toBe(false)
  })

  it('loadQualityGate reads and validates a valid YAML file', () => {
    const file = writeConfig('version: 1\nchecks:\n  - {stage: lint, run: pnpm lint}\n')
    const config = loadQualityGate(file)
    expect(config.checks[0].stage).toBe('lint')
  })

  it('loadQualityGate on missing file → C404-GATE-003 (exit 2)', () => {
    try {
      loadQualityGate(path.join(tmp, 'non-esiste.yml'))
      expect.unreachable('doveva lanciare')
    } catch (error) {
      expect((error as AutomatorError).code).toBe('C404-GATE-003')
      expect((error as AutomatorError).exitCode).toBe(2)
    }
  })

  it('loadQualityGate on illegal YAML → C400-GATE-001 (exit 2)', () => {
    const file = writeConfig('version: 1\nchecks: [oops: :\n')
    try {
      loadQualityGate(file)
      expect.unreachable('doveva lanciare')
    } catch (error) {
      expect((error as AutomatorError).code).toBe('C400-GATE-001')
    }
  })

  it('loadQualityGate on invalid schema → C400-GATE-001 (exit 2)', () => {
    const file = writeConfig('version: 1\nchecks:\n  - {stage: nope, run: x}\n')
    try {
      loadQualityGate(file)
      expect.unreachable('doveva lanciare')
    } catch (error) {
      expect((error as AutomatorError).code).toBe('C400-GATE-001')
    }
  })

  it('validateQualityGate returns the typed result without throwing', () => {
    const file = writeConfig('version: 1\nchecks:\n  - {stage: unit, run: x, required: false}\n')
    const r = validateQualityGate(file)
    expect(r.ok).toBe(true)
    if (r.ok) expect(r.config.checks[0].required).toBe(false)
  })
})

describe('quality-gate — ordering and command building (mise + timeout)', () => {
  it('isGateStage recognises only the known stages', () => {
    expect(isGateStage('security')).toBe(true)
    expect(isGateStage('deploy')).toBe(false)
  })

  it('orderChecks sorts by canonical stage (setup first, full last)', () => {
    const config = QualityGateConfigSchema.parse({
      version: 1,
      checks: [
        {stage: 'full', run: 'a'},
        {stage: 'setup', run: 'b'},
        {stage: 'lint', run: 'c'},
      ],
    })
    expect(orderChecks(config.checks).map((c) => c.stage)).toEqual(['setup', 'lint', 'full'])
  })

  it('orderChecks preserves the declaration order for the same stage', () => {
    const config = QualityGateConfigSchema.parse({
      version: 1,
      checks: [
        {stage: 'unit', run: 'primo'},
        {stage: 'unit', run: 'secondo'},
      ],
    })
    expect(orderChecks(config.checks).map((c) => c.run)).toEqual(['primo', 'secondo'])
  })

  it('buildCheckCommand with the default runner → mise exec -- sh -c', () => {
    const built = buildCheckCommand({stage: 'unit', run: 'pnpm test', required: true}, DEFAULT_RUNNER)
    expect(built.cmd).toBe('mise')
    expect(built.args).toEqual(['exec', '--', 'sh', '-c', 'pnpm test'])
    expect(built.display).toContain('mise exec -- sh -c')
  })

  it('buildCheckCommand with empty runner → direct sh -c (no wrap)', () => {
    const built = buildCheckCommand({stage: 'unit', run: 'true', required: true}, [])
    expect(built.cmd).toBe('sh')
    expect(built.args).toEqual(['-c', 'true'])
  })

  it('planGate resolves the per-check and global timeout and composes the command', () => {
    const config = QualityGateConfigSchema.parse({
      version: 1,
      timeout: 120,
      checks: [
        {stage: 'unit', run: 'pnpm test', timeout: 60},
        {stage: 'lint', run: 'pnpm lint'},
      ],
    })
    const planned = planGate(config)
    expect(planned[0]).toMatchObject({stage: 'unit', timeout: 60, required: true})
    expect(planned[1].timeout).toBe(120)
    expect(planned[0].command).toContain('mise exec -- sh -c')
  })

  it('planGate with only filters the requested stages (keeping the canonical order)', () => {
    const config = QualityGateConfigSchema.parse({
      version: 1,
      checks: [
        {stage: 'unit', run: 'a'},
        {stage: 'lint', run: 'b'},
        {stage: 'full', run: 'c'},
      ],
    })
    expect(planGate(config, {only: ['full', 'lint']}).map((c) => c.stage)).toEqual(['lint', 'full'])
  })
})

describe('quality-gate — evaluateGate (the gate fails if a mandatory check does not pass, DoD)', () => {
  it('all checks pass → gate passed', () => {
    const v = evaluateGate([result({stage: 'unit'}), result({stage: 'lint'})])
    expect(v.passed).toBe(true)
    expect(v.failedRequired).toHaveLength(0)
  })

  it('a failed mandatory check → gate failed', () => {
    const v = evaluateGate([result({stage: 'unit', status: 'failed', exitCode: 1})])
    expect(v.passed).toBe(false)
    expect(v.failedRequired[0].stage).toBe('unit')
  })

  it('a timed-out mandatory check → gate failed', () => {
    const v = evaluateGate([result({stage: 'full', status: 'timeout', exitCode: null})])
    expect(v.passed).toBe(false)
    expect(v.failedRequired[0].status).toBe('timeout')
  })

  it('a failed NON-mandatory check → gate passed (advisory, does not block)', () => {
    const v = evaluateGate([result({stage: 'unit'}), result({stage: 'lint', required: false, status: 'failed', exitCode: 1})])
    expect(v.passed).toBe(true)
    expect(v.failedAdvisory[0].stage).toBe('lint')
  })

  it('a skipped mandatory check → gate failed (it did not pass)', () => {
    const v = evaluateGate([result({stage: 'unit', status: 'failed', exitCode: 1}), result({stage: 'full', status: 'skipped', exitCode: null, durationMs: 0})])
    expect(v.passed).toBe(false)
    expect(v.failedRequired.map((f) => f.stage)).toEqual(['unit', 'full'])
  })

  it('carries the auditable reasons', () => {
    const v = evaluateGate([result({stage: 'unit', status: 'failed', exitCode: 1})])
    expect(v.reasons.join(' ')).toContain('unit')
  })
})

describe('quality-gate — runGate (execution with injectable probe, fail-fast)', () => {
  const config = QualityGateConfigSchema.parse({
    version: 1,
    checks: [
      {stage: 'setup', run: 'setup'},
      {stage: 'unit', run: 'unit'},
      {stage: 'lint', run: 'lint'},
    ],
  })

  const pass = (): Promise<CheckOutcome> => Promise.resolve({status: 'passed', exitCode: 0, durationMs: 1})
  const fail = (): Promise<CheckOutcome> => Promise.resolve({status: 'failed', exitCode: 1, durationMs: 1})

  it('runs all checks in order when they pass', async () => {
    const seen: string[] = []
    const report = await runGate(config, {
      runCheck: (p) => {
        seen.push(p.stage)
        return pass()
      },
    })
    expect(seen).toEqual(['setup', 'unit', 'lint'])
    expect(report.verdict.passed).toBe(true)
  })

  it('fail-fast: at the first failed mandatory check the following checks are skipped (not run)', async () => {
    const seen: string[] = []
    const report = await runGate(config, {
      runCheck: (p) => {
        seen.push(p.stage)
        return p.stage === 'setup' ? fail() : pass()
      },
    })
    // setup run and failed → unit/lint NOT run (fail-fast)
    expect(seen).toEqual(['setup'])
    expect(report.checks.map((c) => c.status)).toEqual(['failed', 'skipped', 'skipped'])
    expect(report.verdict.passed).toBe(false)
  })

  it('keepGoing: runs all checks even after a failed mandatory one (complete report)', async () => {
    const seen: string[] = []
    const report = await runGate(config, {
      keepGoing: true,
      runCheck: (p) => {
        seen.push(p.stage)
        return p.stage === 'setup' ? fail() : pass()
      },
    })
    expect(seen).toEqual(['setup', 'unit', 'lint'])
    expect(report.verdict.passed).toBe(false)
  })

  it('a failed advisory check neither stops nor fails the gate', async () => {
    const advisory = QualityGateConfigSchema.parse({
      version: 1,
      checks: [
        {stage: 'lint', run: 'lint', required: false},
        {stage: 'unit', run: 'unit'},
      ],
    })
    const seen: string[] = []
    const report = await runGate(advisory, {
      runCheck: (p) => {
        seen.push(p.stage)
        return p.stage === 'lint' ? fail() : pass()
      },
    })
    expect(seen).toEqual(['unit', 'lint']) // canonical order: unit before lint
    expect(report.verdict.passed).toBe(true)
  })

  it('only runs only the requested stages', async () => {
    const seen: string[] = []
    await runGate(config, {only: ['lint'], runCheck: (p) => {
      seen.push(p.stage)
      return pass()
    }})
    expect(seen).toEqual(['lint'])
  })

  it('the results record does NOT contain secrets (neither env nor output): only command and outcome', async () => {
    const report = await runGate(config, {runCheck: () => pass()})
    for (const check of report.checks) {
      expect(Object.keys(check).sort()).toEqual(['command', 'durationMs', 'exitCode', 'required', 'stage', 'status'])
    }
  })
})

describe('quality-gate — defaultCheckRunner (spawn in process group + timeout SIGTERM→SIGKILL)', () => {
  const planned: PlannedCheck = {stage: 'unit', run: 'x', required: true, timeout: 5, cmd: 'sh', args: ['-c', 'x'], command: 'sh -c x'}

  it('exit 0 → passed', async () => {
    const {spawn, kill} = makeGateSpawn({code: 0})
    const outcome = await defaultCheckRunner({cwd: tmp, spawn, kill})(planned)
    expect(outcome.status).toBe('passed')
    expect(outcome.exitCode).toBe(0)
  })

  it('exit non-zero → failed', async () => {
    const {spawn, kill} = makeGateSpawn({code: 1})
    const outcome = await defaultCheckRunner({cwd: tmp, spawn, kill})(planned)
    expect(outcome.status).toBe('failed')
    expect(outcome.exitCode).toBe(1)
  })

  it('spawns in a new process group (detached) and on timeout kills the WHOLE group (-pid), not only the child', async () => {
    const {spawn, kill, signals, detached} = makeGateSpawn({hang: true})
    const outcome = await defaultCheckRunner({cwd: tmp, spawn, kill})({...planned, timeout: 0.01})
    expect(outcome.status).toBe('timeout')
    // detached:true → the child leads its process group; the kill goes to the group (negative leader PID),
    // so the descendants (mise→sh→pnpm→node…) die, no orphan processes after the timeout.
    expect(detached()).toBe(true)
    expect(signals().some((s) => s.pid === -4242 && s.signal === 'SIGTERM')).toBe(true)
  })

  it('cooperative cancellation (abort) terminates the group like the timeout (without marking it timeout)', async () => {
    const controller = new AbortController()
    const {spawn, kill, signals} = makeGateSpawn({hang: true})
    const promise = defaultCheckRunner({cwd: tmp, spawn, kill, signal: controller.signal})(planned)
    controller.abort()
    const outcome = await promise
    expect(outcome.status).toBe('failed') // closed by SIGTERM, not a timeout
    expect(signals().some((s) => s.pid === -4242)).toBe(true)
  })

  it('spawn error (command not found) → failed, exitCode null', async () => {
    const {spawn, kill} = makeGateSpawn({errorEvent: true})
    const outcome = await defaultCheckRunner({cwd: tmp, spawn, kill})(planned)
    expect(outcome.status).toBe('failed')
    expect(outcome.exitCode).toBeNull()
  })

  it('does not record the command output (the outcome carries NO secrets): CheckOutcome has only status/exitCode/durationMs', async () => {
    const {spawn, kill} = makeGateSpawn({code: 0})
    const outcome = await defaultCheckRunner({cwd: tmp, spawn, kill, env: {SECRET: 'topsecret'}})(planned)
    expect(JSON.stringify(outcome)).not.toContain('topsecret')
    expect(Object.keys(outcome).sort()).toEqual(['durationMs', 'exitCode', 'status'])
  })
})
