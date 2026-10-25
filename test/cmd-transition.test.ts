import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import {spawnSync} from 'node:child_process'
import {afterEach, beforeEach, describe, expect, it} from 'vitest'
import Transition from '../src/commands/transition'
import {type Checkpoint, type RunRecord, readRun, saveRun} from '../src/lib/state'
import {runCaptured, runExpectingExit} from './helpers/command'

let stateDir: string
let dataDir: string
let repo: string
let probeDirs: string[] = []
const savedEnv = {...process.env}

function git(cwd: string, args: string[]): void {
  const res = spawnSync('git', ['-C', cwd, ...args], {encoding: 'utf8'})
  if (res.status !== 0) throw new Error(`git ${args.join(' ')} → ${res.stderr}`)
}

function makeRepo(dir: string, branch: string): void {
  fs.mkdirSync(dir, {recursive: true})
  git(dir, ['init', '-q', '-b', branch])
  fs.writeFileSync(path.join(dir, 'README.md'), '# x\n')
  git(dir, ['add', '.'])
  git(dir, ['-c', 'user.email=t@e.st', '-c', 'user.name=Test', 'commit', '-qm', 'init'])
}

/** Replaces `git` in the PATH with a probe that records every invocation and fails immediately. */
function recordGitProbes(): string {
  const bin = fs.mkdtempSync(path.join(os.tmpdir(), 'automator-tr-git-'))
  probeDirs.push(bin)
  const log = path.join(bin, 'calls.log')
  const executable = path.join(bin, 'git')
  fs.writeFileSync(executable, `#!/bin/sh\nprintf '%s\\n' "$*" >> "${log}"\nexit 1\n`)
  fs.chmodSync(executable, 0o700)
  process.env.PATH = `${bin}:${process.env.PATH ?? ''}`
  return log
}

/** Fake Git probe that reports whether transition invokes it while still holding the run lock. */
function recordProbeUnderStateLock(runId: string): string {
  const bin = fs.mkdtempSync(path.join(os.tmpdir(), 'automator-tr-lock-git-'))
  probeDirs.push(bin)
  const marker = path.join(bin, 'probe-under-lock')
  const lock = `${runFile(runId)}.write.lock`
  const executable = path.join(bin, 'git')
  fs.writeFileSync(executable, `#!/bin/sh
if [ -d "${lock}" ]; then : > "${marker}"; fi
case "$*" in
  *"--abbrev-ref"*) printf '%s\n' 'ticket/CYAU-16' ;;
  *"rev-parse HEAD"*) printf '%s\n' '0123456789012345678901234567890123456789' ;;
esac
exit 0
`)
  fs.chmodSync(executable, 0o700)
  process.env.PATH = `${bin}:${process.env.PATH ?? ''}`
  return marker
}

const runFile = (runId: string): string => path.join(stateDir, 'runs', `${runId}.json`)

function checkpoint(phase: string): Checkpoint {
  return {phase, branch: null, commit: null, worktree: null, dirty: null, artifacts: [], outcome: null, at: '2026-07-12T10:00:00.000Z'}
}

/** Seeds a run with a chain of phases (the last one is the current phase of the state machine). */
function seedRun(runId: string, phases: string[], over: Partial<RunRecord> = {}): void {
  const record: RunRecord = {
    run_id: runId,
    ticket: 'CYAU-16',
    repository: 'acme/widget',
    updated_at: '2026-07-12T10:00:00.000Z',
    checkpoints: phases.map(checkpoint),
    ...over,
  }
  saveRun(runFile(runId), record)
}

beforeEach(() => {
  stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'automator-tr-state-'))
  dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'automator-tr-data-'))
  repo = fs.mkdtempSync(path.join(os.tmpdir(), 'automator-tr-wt-'))
  process.env.AUTOMATOR_STATE_DIR = stateDir
  process.env.AUTOMATOR_DATA_DIR = dataDir
  makeRepo(repo, 'ticket/CYAU-16')
})

afterEach(() => {
  process.env = {...savedEnv}
  fs.rmSync(stateDir, {recursive: true, force: true})
  fs.rmSync(dataDir, {recursive: true, force: true})
  fs.rmSync(repo, {recursive: true, force: true})
  for (const dir of probeDirs) fs.rmSync(dir, {recursive: true, force: true})
  probeDirs = []
})

describe('transition command — ingresso (ticket acquisito)', () => {
  it('first transition → validating: persists the state and signals the move to in_progress (Scenario 1)', async () => {
    const {result} = await runCaptured(Transition, ['run-1', 'validating', '--ticket', 'CYAU-16'])

    expect(result).toMatchObject({from: null, to: 'validating', allowed: true, phaseChanged: true, cyiStatus: 'in_progress', cyiStatusChanged: true})
    const run = readRun(runFile('run-1')).run
    expect(run?.checkpoints.map((c) => c.phase)).toEqual(['validating'])
    expect(run?.ticket).toBe('CYAU-16')
  })

  it('from no state one cannot jump to the middle of the flow → exit 3, does not persist', async () => {
    const {stderr} = await runExpectingExit(Transition, ['run-1', 'implementing'], 3)
    expect(stderr).toContain('C409-STATE-005')
    expect(fs.existsSync(runFile('run-1'))).toBe(false)
  })

  it('--runtime persists the runtime at the phase change (shown in the dashboard, CYAU-31)', async () => {
    await runCaptured(Transition, ['run-1', 'validating', '--ticket', 'CYAU-16', '--runtime', 'codex'])
    expect(readRun(runFile('run-1')).run?.runtime).toBe('codex')
  })
})

describe('transition command — only allowed transitions (Scenario 1)', () => {
  it('applies an allowed transition and persists the new state', async () => {
    seedRun('run-1', ['validating'])
    const {result} = await runCaptured(Transition, ['run-1', 'ready'])
    expect(result).toMatchObject({from: 'validating', to: 'ready', allowed: true, phaseChanged: true})
    expect(readRun(runFile('run-1')).run?.checkpoints.map((c) => c.phase)).toEqual(['validating', 'ready'])
  })

  it('rejects a disallowed transition → exit 3 and does NOT persist (history unchanged)', async () => {
    seedRun('run-1', ['validating'])
    const {stderr} = await runExpectingExit(Transition, ['run-1', 'completed'], 3)
    expect(stderr).toContain('C409-STATE-005')
    expect(readRun(runFile('run-1')).run?.checkpoints.map((c) => c.phase)).toEqual(['validating'])
  })

  it('a disallowed transition with --worktree does not probe Git', async () => {
    seedRun('run-1', ['validating'])
    const probeLog = recordGitProbes()

    await runExpectingExit(Transition, ['run-1', 'completed', '--worktree', repo], 3)

    expect(fs.existsSync(probeLog)).toBe(false)
  })

  it('reviewing → in_review promotes the ticket to in_review (external effect)', async () => {
    seedRun('run-1', ['implementing', 'verifying', 'reviewing'])
    const {result} = await runCaptured(Transition, ['run-1', 'in_review'])
    expect(result).toMatchObject({to: 'in_review', cyiStatus: 'in_review', cyiStatusChanged: true, phaseChanged: true})
  })
})

describe('transition command — idempotency (retry / restart do not duplicate external effects, DoD)', () => {
  it('re-applying the current state is a no-op: no new checkpoint, no CYI status change', async () => {
    await runCaptured(Transition, ['run-1', 'validating'])
    const {result} = await runCaptured(Transition, ['run-1', 'validating'])

    expect(result).toMatchObject({from: 'validating', to: 'validating', allowed: true, phaseChanged: false, cyiStatusChanged: false})
    // The history does not double: a single validating checkpoint.
    expect(readRun(runFile('run-1')).run?.checkpoints.map((c) => c.phase)).toEqual(['validating'])
  })

  it('a self-transition with --worktree does not probe Git', async () => {
    seedRun('run-1', ['validating'])
    const probeLog = recordGitProbes()

    const {result} = await runCaptured(Transition, ['run-1', 'validating', '--worktree', repo])

    expect(result).toMatchObject({phaseChanged: false})
    expect(fs.existsSync(probeLog)).toBe(false)
  })

  it('advancing between states with the same CYI status changes the phase but not the external effect (in_review → completed)', async () => {
    seedRun('run-1', ['reviewing', 'in_review'])
    const {result} = await runCaptured(Transition, ['run-1', 'completed'])
    expect(result).toMatchObject({to: 'completed', phaseChanged: true, cyiStatus: 'in_review', cyiStatusChanged: false})
    expect(readRun(runFile('run-1')).run?.checkpoints.map((c) => c.phase)).toEqual(['reviewing', 'in_review', 'completed'])
  })
})

describe('transition command — punto di lavoro (worktree)', () => {
  it('assigns the commit a timestamp after the last phase revalidated under lock', async () => {
    const previousAt = '2099-01-01T00:00:00.000Z'
    seedRun('run-1', ['ready'], {
      updated_at: previousAt,
      checkpoints: [{...checkpoint('ready'), at: previousAt}],
    })

    await runCaptured(Transition, ['run-1', 'implementing'])

    const committedAt = readRun(runFile('run-1')).run?.checkpoints.at(-1)?.at as string
    expect(Date.parse(committedAt)).toBeGreaterThan(Date.parse(previousAt))
  })

  it('runs the Git probes outside the lock and revalidates the state only before publishing', async () => {
    seedRun('run-1', ['ready'])
    const probeUnderLock = recordProbeUnderStateLock('run-1')

    await runCaptured(Transition, ['run-1', 'implementing', '--worktree', repo])

    expect(fs.existsSync(probeUnderLock)).toBe(false)
    expect(readRun(runFile('run-1')).run?.checkpoints.map((c) => c.phase)).toEqual(['ready', 'implementing'])
  })

  it('with --worktree probes branch/commit and records them in the checkpoint', async () => {
    seedRun('run-1', ['ready'])
    await runCaptured(Transition, ['run-1', 'implementing', '--worktree', repo, '--ticket', 'CYAU-16', '--repository', 'acme/widget'])
    const cp = readRun(runFile('run-1')).run?.checkpoints.at(-1)
    expect(cp?.phase).toBe('implementing')
    expect(cp?.branch).toBe('ticket/CYAU-16')
    expect(cp?.commit).toMatch(/^[0-9a-f]{40}$/)
    expect(cp?.worktree).toBe(repo)
  })

  it('without worktree still records the phase with null git fields', async () => {
    seedRun('run-1', ['ready'])
    await runCaptured(Transition, ['run-1', 'implementing'])
    const cp = readRun(runFile('run-1')).run?.checkpoints.at(-1)
    expect(cp?.phase).toBe('implementing')
    expect(cp?.branch).toBeNull()
    expect(cp?.commit).toBeNull()
  })

  it('without worktree but with explicit --commit records the commit reported by the agent', async () => {
    seedRun('run-1', ['ready'])
    await runCaptured(Transition, ['run-1', 'implementing', '--commit', 'deadbeef'])
    const cp = readRun(runFile('run-1')).run?.checkpoints.at(-1)
    expect(cp?.commit).toBe('deadbeef')
    expect(cp?.worktree).toBeNull()
  })

  it('derives the managed worktree from --project and --ticket', async () => {
    const wt = path.join(dataDir, 'worktrees', 'CYAU', 'CYAU-16')
    makeRepo(wt, 'ticket/CYAU-16')
    seedRun('run-1', ['ready'])

    await runCaptured(Transition, ['run-1', 'implementing', '--project', 'CYAU', '--ticket', 'CYAU-16'])
    const cp = readRun(runFile('run-1')).run?.checkpoints.at(-1)
    expect(cp?.worktree).toBe(wt)
    expect(cp?.branch).toBe('ticket/CYAU-16')
  })
})

describe('transition command — validation and robustness', () => {
  it('unrecognised state → exit 2 (C400-STATE-004)', async () => {
    const {stderr} = await runExpectingExit(Transition, ['run-1', 'pippo'], 2)
    expect(stderr).toContain('C400-STATE-004')
  })

  it('hostile run-id (prototype) → exit 2 without touching the disk', async () => {
    const {stderr} = await runExpectingExit(Transition, ['__proto__', 'validating'], 2)
    expect(stderr).toContain('C400-STATE-002')
    expect(fs.existsSync(path.join(stateDir, 'runs'))).toBe(false)
  })

  it('run-id with a path separator → exit 2 (never path traversal)', async () => {
    const {stderr} = await runExpectingExit(Transition, ['../evasione', 'validating'], 2)
    expect(stderr).toContain('C400-STATE-002')
  })

  it('corrupt previous state file → preserved in quarantine and treated as a new run', async () => {
    fs.mkdirSync(path.dirname(runFile('run-1')), {recursive: true})
    fs.writeFileSync(runFile('run-1'), '{ questo non è json')

    const {result} = await runCaptured(Transition, ['run-1', 'validating'])
    expect((result as {quarantined: string | null}).quarantined).toBeTruthy()
    expect((result as {from: string | null}).from).toBeNull()
    const quarantined = fs.readdirSync(path.join(stateDir, 'runs')).find((f) => f.includes('.corrupt-'))
    expect(quarantined).toBeTruthy()
    expect(fs.readFileSync(path.join(stateDir, 'runs', quarantined as string), 'utf8')).toBe('{ questo non è json')
  })

  it('--dry-run shows the plan without persisting', async () => {
    seedRun('run-1', ['validating'])
    const {result} = await runCaptured(Transition, ['run-1', 'ready', '--dry-run'])
    expect((result as {dryRun: boolean}).dryRun).toBe(true)
    expect(readRun(runFile('run-1')).run?.checkpoints.map((c) => c.phase)).toEqual(['validating'])
  })

  it('--json does not print the human-readable lines', async () => {
    seedRun('run-1', ['validating'])
    const {result, stdout} = await runCaptured(Transition, ['run-1', 'ready', '--json'])
    expect((result as {to: string}).to).toBe('ready')
    expect(stdout).not.toContain('transition run-1')
  })
})
