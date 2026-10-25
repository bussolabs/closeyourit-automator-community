import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import {afterEach, beforeEach, describe, expect, it} from 'vitest'
import Cycle from '../src/commands/cycle'
import {type Checkpoint, type RunRecord, saveRun} from '../src/lib/state'
import {runCaptured, runExpectingExit} from './helpers/command'

// The `cycle` command (CYAU-21) is the budget gate: the orchestrator passes it the current review verdict and
// the run-id, and gets back whether the run can continue automatically (another round / advancement) or requires
// human intervention because it exceeded the two cycles. The counters are derived from the persisted history
// (runs/<run-id>.json) → they do NOT reset at restart (re-reading the file is the only state). Safe-by-default shell gate
// (like review/lease): can continue → exit 0; human intervention needed → exit 3; invalid input → exit 2.

let stateDir: string
const savedEnv = {...process.env}

const runFile = (runId: string): string => path.join(stateDir, 'runs', `${runId}.json`)

function checkpoint(phase: string): Checkpoint {
  return {phase, branch: null, commit: null, worktree: null, dirty: null, artifacts: [], outcome: null, at: '2026-07-12T10:00:00.000Z'}
}

/** Seeds a run with a chain of phases (the orchestrator records reviewing/implementing via transition). */
function seedRun(runId: string, phases: string[], over: Partial<RunRecord> = {}): void {
  const record: RunRecord = {
    run_id: runId,
    ticket: 'CYAU-21',
    repository: 'acme/widget',
    updated_at: '2026-07-12T10:00:00.000Z',
    checkpoints: phases.map(checkpoint),
    ...over,
  }
  saveRun(runFile(runId), record)
}

const ONE_CYCLE = ['implementing', 'verifying', 'reviewing']
const TWO_CYCLES = ['implementing', 'verifying', 'reviewing', 'implementing', 'verifying', 'reviewing']

const majorTests = JSON.stringify({severity: 'major', aspect: 'tests', title: 'manca test per il caso N'})
const majorDiff = JSON.stringify({severity: 'major', aspect: 'diff', title: 'errore non gestito'})

interface CyclePayload {
  runId: string
  ticket: string | null
  verdict: string
  cycle: number
  limit: number
  attempts: number
  reviewCycles: number
  limitReached: boolean
  requiresHuman: boolean
  next: string
  reasons: string[]
  summary: string
  outstandingFindings: {severity: string; title: string}[]
  error?: {code: string; message: string}
}

beforeEach(() => {
  stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'automator-cycle-state-'))
  process.env.AUTOMATOR_STATE_DIR = stateDir
})

afterEach(() => {
  process.env = {...savedEnv}
  fs.rmSync(stateDir, {recursive: true, force: true})
})

describe('cycle command — Scenario 1: after two unapproved cycles human intervention is needed', () => {
  it('second cycle with change requests → exit 3, the workflow does not exceed two cycles (DoD)', async () => {
    seedRun('run-1', TWO_CYCLES)
    const {stderr, stdout} = await runExpectingExit(
      Cycle,
      ['run-1', '--verdict', 'changes_requested', '--finding', majorTests, '--finding', majorDiff],
      3,
    )
    expect(stderr).toContain('C409-CYCLE-002')
    // The unresolved findings stay visible (kept in the ticket).
    expect(stdout).toContain('manca test per il caso N')
    expect(stdout).toContain('errore non gestito')
  })

  it('first cycle with change requests (under the limit) → exit 0, goes back to implementing', async () => {
    seedRun('run-1', ONE_CYCLE)
    const {result} = await runCaptured(Cycle, ['run-1', '--verdict', 'changes_requested', '--finding', majorTests, '--json'])
    const p = result as CyclePayload
    expect(p.next).toBe('implementing')
    expect(p.requiresHuman).toBe(false)
    expect(p.limitReached).toBe(false)
    expect(p.cycle).toBe(1)
  })

  it('review approvata → exit 0, avanza a in_review', async () => {
    seedRun('run-1', ONE_CYCLE)
    const {result} = await runCaptured(Cycle, ['run-1', '--verdict', 'approved', '--json'])
    const p = result as CyclePayload
    expect(p.next).toBe('in_review')
    expect(p.requiresHuman).toBe(false)
  })

  it('a blocker finding → exit 3 even at the first cycle', async () => {
    seedRun('run-1', ONE_CYCLE)
    const blocker = JSON.stringify({severity: 'blocker', aspect: 'requirements', title: 'requisito ambiguo'})
    const {stderr} = await runExpectingExit(Cycle, ['run-1', '--verdict', 'blocked', '--finding', blocker], 3)
    expect(stderr).toContain('C409-CYCLE-002')
  })
})

describe('cycle command — persisted counters (they do not reset at restart, Technical analysis)', () => {
  it('derives cycles and attempts from the persisted history: two invocations on the same file give the same count', async () => {
    seedRun('run-1', TWO_CYCLES)
    // First invocation (before the "restart"): approved → exit 0, counts the history on disk.
    const first = (await runCaptured(Cycle, ['run-1', '--verdict', 'approved', '--json'])).result as CyclePayload
    expect(first).toMatchObject({attempts: 2, reviewCycles: 2, cycle: 2})
    // Second invocation: a new process would re-read the same runs/<run-id>.json → identical count
    // (no in-memory state to reset: the count is always re-derived from the file).
    const {result} = await runCaptured(Cycle, ['run-1', '--verdict', 'approved', '--json'])
    expect(result).toMatchObject({attempts: 2, reviewCycles: 2, cycle: 2})
  })

  it('without history (no reviewing checkpoint) the current cycle counts at least 1', async () => {
    // No seeded file: evaluating a verdict implies that at least the current review happened.
    const {result} = await runCaptured(Cycle, ['run-1', '--verdict', 'changes_requested', '--json'])
    const p = result as CyclePayload
    expect(p.cycle).toBe(1)
    expect(p.next).toBe('implementing')
  })
})

describe('cycle command — budget configurabile', () => {
  it('--limit 3 grants a third cycle (threshold moved)', async () => {
    seedRun('run-1', TWO_CYCLES)
    const {result} = await runCaptured(Cycle, ['run-1', '--verdict', 'changes_requested', '--limit', '3', '--json'])
    const p = result as CyclePayload
    expect(p.limit).toBe(3)
    expect(p.next).toBe('implementing')
    expect(p.limitReached).toBe(false)
  })

  it('--limit not a positive integer → exit 2', async () => {
    seedRun('run-1', ONE_CYCLE)
    const {stderr} = await runExpectingExit(Cycle, ['run-1', '--verdict', 'approved', '--limit', '0'], 2)
    expect(stderr).toContain('C400-CYCLE-001')
  })
})

describe('cycle command — output and summary (unresolved findings kept in the ticket, DoD)', () => {
  it('--json espone verdetto, contatori, prossima fase e riepilogo', async () => {
    seedRun('run-1', TWO_CYCLES)
    const {stdout} = await runExpectingExit(
      Cycle,
      ['run-1', '--verdict', 'changes_requested', '--finding', majorTests, '--json'],
      3,
    )
    const p = JSON.parse(stdout) as CyclePayload
    expect(p.verdict).toBe('changes_requested')
    expect(p.limitReached).toBe(true)
    expect(p.requiresHuman).toBe(true)
    expect(p.next).toBe('blocked')
    expect(p.outstandingFindings).toHaveLength(1)
    expect(p.summary).toContain('manca test per il caso N')
    expect(p.error?.code).toBe('C409-CYCLE-002')
  })

  it('human output shows the next phase, the cycles and the reasons', async () => {
    seedRun('run-1', ONE_CYCLE)
    const {stdout} = await runCaptured(Cycle, ['run-1', '--verdict', 'changes_requested', '--code', 'CYAU-21'])
    const low = stdout.toLowerCase()
    expect(low).toContain('cyau-21')
    expect(low).toContain('implementing')
    expect(low).toContain('motivazioni')
  })
})

describe('cycle command — difesa all’ingresso e robustezza', () => {
  it('unrecognised verdict → exit 2, dedicated code', async () => {
    seedRun('run-1', ONE_CYCLE)
    const {stderr} = await runExpectingExit(Cycle, ['run-1', '--verdict', 'rejected'], 2)
    expect(stderr).toContain('C400-CYCLE-001')
  })

  it('non-JSON finding → exit 2', async () => {
    seedRun('run-1', ONE_CYCLE)
    const {stderr} = await runExpectingExit(Cycle, ['run-1', '--verdict', 'changes_requested', '--finding', 'non-json'], 2)
    expect(stderr).toContain('C400-CYCLE-001')
  })

  it('finding with unknown severity → exit 2', async () => {
    seedRun('run-1', ONE_CYCLE)
    const bad = JSON.stringify({severity: 'critical', title: 'x'})
    const {stderr} = await runExpectingExit(Cycle, ['run-1', '--verdict', 'changes_requested', '--finding', bad], 2)
    expect(stderr).toContain('C400-CYCLE-001')
  })

  it('hostile run-id (prototype) → exit 2 without touching the disk', async () => {
    const {stderr} = await runExpectingExit(Cycle, ['__proto__', '--verdict', 'approved'], 2)
    expect(stderr).toContain('C400-STATE-002')
    expect(fs.existsSync(path.join(stateDir, 'runs'))).toBe(false)
  })

  it('run-id with a path separator → exit 2 (never path traversal)', async () => {
    const {stderr} = await runExpectingExit(Cycle, ['../evasione', '--verdict', 'approved'], 2)
    expect(stderr).toContain('C400-STATE-002')
  })

  it('corrupt history → preserved in quarantine and treated as a new run (cycle 1)', async () => {
    fs.mkdirSync(path.dirname(runFile('run-1')), {recursive: true})
    fs.writeFileSync(runFile('run-1'), '{ questo non è json')

    // Human mode: reports the quarantine and does not lose the corrupt file.
    const {result, stdout} = await runCaptured(Cycle, ['run-1', '--verdict', 'changes_requested'])
    const p = result as CyclePayload & {quarantined: string | null}
    expect(p.quarantined).toBeTruthy()
    expect(p.cycle).toBe(1)
    expect(stdout).toContain('preservato in')
    const quarantined = fs.readdirSync(path.join(stateDir, 'runs')).find((f) => f.includes('.corrupt-'))
    expect(quarantined).toBeTruthy()
    expect(fs.readFileSync(path.join(stateDir, 'runs', quarantined as string), 'utf8')).toBe('{ questo non è json')
  })

  it('--json does not print the human-readable lines', async () => {
    seedRun('run-1', ONE_CYCLE)
    const {stdout} = await runCaptured(Cycle, ['run-1', '--verdict', 'approved', '--json'])
    expect(stdout).not.toContain('cycle run-1 ·')
  })
})
