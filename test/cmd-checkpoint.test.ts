import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import {spawnSync} from 'node:child_process'
import {afterEach, beforeEach, describe, expect, it} from 'vitest'
import Checkpoint from '../src/commands/checkpoint'
import {type Checkpoint as CheckpointData, readRun, saveRun} from '../src/lib/state'
import {runCaptured, runExpectingExit} from './helpers/command'

let stateDir: string
let dataDir: string
let repo: string
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

const runFile = (runId: string): string => path.join(stateDir, 'runs', `${runId}.json`)

beforeEach(() => {
  stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'automator-cp-state-'))
  dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'automator-cp-data-'))
  repo = fs.mkdtempSync(path.join(os.tmpdir(), 'automator-cp-wt-'))
  process.env.AUTOMATOR_STATE_DIR = stateDir
  process.env.AUTOMATOR_DATA_DIR = dataDir
  makeRepo(repo, 'ticket/CYAU-12')
})

afterEach(() => {
  process.env = {...savedEnv}
  fs.rmSync(stateDir, {recursive: true, force: true})
  fs.rmSync(dataDir, {recursive: true, force: true})
  fs.rmSync(repo, {recursive: true, force: true})
})

describe('checkpoint command', () => {
  it('assigns the commit a timestamp after the last checkpoint observed under lock', async () => {
    const previousAt = '2099-01-01T00:00:00.000Z'
    const previous: CheckpointData = {
      phase: 'setup', branch: null, commit: null, worktree: repo, dirty: false, artifacts: [], outcome: null, at: previousAt,
    }
    saveRun(runFile('run-1'), {
      run_id: 'run-1', ticket: 'CYAU-12', repository: 'acme/widget', updated_at: previousAt, checkpoints: [previous],
    })

    await runCaptured(Checkpoint, ['run-1', 'implement', '--worktree', repo])

    const committedAt = readRun(runFile('run-1')).run?.checkpoints.at(-1)?.at as string
    expect(Date.parse(committedAt)).toBeGreaterThan(Date.parse(previousAt))
  })

  it('records the phase checkpoint with branch, commit, worktree and artifacts (Scenario 1)', async () => {
    const {result, stdout} = await runCaptured(Checkpoint, [
      'run-1', 'implement',
      '--worktree', repo,
      '--ticket', 'CYAU-12',
      '--repository', 'acme/widget',
      '--artifact', 'src/lib/state.ts',
      '--outcome', 'success',
    ])

    const run = readRun(runFile('run-1')).run
    const cp = run?.checkpoints[0]
    expect(cp?.phase).toBe('implement')
    expect(cp?.branch).toBe('ticket/CYAU-12')
    expect(cp?.commit).toMatch(/^[0-9a-f]{40}$/)
    expect(cp?.worktree).toBe(repo)
    expect(cp?.dirty).toBe(false)
    expect(cp?.artifacts).toEqual(['src/lib/state.ts'])
    expect(cp?.outcome).toBe('success')
    expect(cp?.at).toMatch(/^\d{4}-\d{2}-\d{2}T/)
    expect(run?.ticket).toBe('CYAU-12')
    expect(run?.repository).toBe('acme/widget')
    expect((result as {runId: string}).runId).toBe('run-1')
    expect(stdout).toContain('checkpoint run-1')
  })

  it('--runtime persists the run runtime (shown in the dashboard, CYAU-31)', async () => {
    await runCaptured(Checkpoint, ['run-1', 'implementing', '--worktree', repo, '--ticket', 'CYAU-12', '--runtime', 'claude'])
    expect(readRun(runFile('run-1')).run?.runtime).toBe('claude')
  })

  it('without --runtime → runtime omitted (backward compat)', async () => {
    await runCaptured(Checkpoint, ['run-1', 'implementing', '--worktree', repo, '--ticket', 'CYAU-12'])
    expect(readRun(runFile('run-1')).run).not.toHaveProperty('runtime')
  })

  it('does NOT write the daemon state.json: the checkpoints live in a separate file (no lost update)', async () => {
    await runCaptured(Checkpoint, ['run-1', 'setup', '--worktree', repo])
    expect(fs.existsSync(runFile('run-1'))).toBe(true)
    expect(fs.existsSync(path.join(stateDir, 'state.json'))).toBe(false)
  })

  it('records the dirty state when the worktree has uncommitted changes', async () => {
    fs.writeFileSync(path.join(repo, 'wip.txt'), 'work\n')
    await runCaptured(Checkpoint, ['run-1', 'implement', '--worktree', repo])
    expect(readRun(runFile('run-1')).run?.checkpoints[0].dirty).toBe(true)
  })

  it('every phase appends a checkpoint (persistent history, does not overwrite)', async () => {
    await runCaptured(Checkpoint, ['run-1', 'setup', '--worktree', repo])
    await runCaptured(Checkpoint, ['run-1', 'implement', '--worktree', repo])
    await runCaptured(Checkpoint, ['run-1', 'commit', '--worktree', repo])
    expect(readRun(runFile('run-1')).run?.checkpoints.map((c) => c.phase)).toEqual(['setup', 'implement', 'commit'])
  })

  it('derives the managed worktree from --project and --ticket', async () => {
    const wt = path.join(dataDir, 'worktrees', 'CYAU', 'CYAU-12')
    makeRepo(wt, 'ticket/CYAU-12')

    await runCaptured(Checkpoint, ['run-1', 'setup', '--project', 'CYAU', '--ticket', 'CYAU-12'])

    expect(readRun(runFile('run-1')).run?.checkpoints[0].worktree).toBe(wt)
  })

  it('--dry-run derives and shows the checkpoint without persisting it', async () => {
    const {result} = await runCaptured(Checkpoint, ['run-1', 'setup', '--worktree', repo, '--dry-run'])
    expect((result as {dryRun: boolean}).dryRun).toBe(true)
    expect((result as {branch: string}).branch).toBe('ticket/CYAU-12')
    expect(fs.existsSync(runFile('run-1'))).toBe(false)
  })

  it('corrupt previous state file → preserved in quarantine and the new checkpoint is recorded', async () => {
    fs.mkdirSync(path.dirname(runFile('run-1')), {recursive: true})
    fs.writeFileSync(runFile('run-1'), '{ questo non è json')

    const {result} = await runCaptured(Checkpoint, ['run-1', 'setup', '--worktree', repo])

    const quarantined = (result as {quarantined: string | null}).quarantined
    expect(quarantined).toBeTruthy()
    expect(fs.readFileSync(quarantined as string, 'utf8')).toBe('{ questo non è json')
    expect(readRun(runFile('run-1')).run?.checkpoints).toHaveLength(1)
  })

  it('non-git worktree → null git fields, checkpoint recorded and shown with placeholders', async () => {
    const notGit = fs.mkdtempSync(path.join(os.tmpdir(), 'automator-cp-nogit-'))
    try {
      const {stdout} = await runCaptured(Checkpoint, ['run-1', 'setup', '--worktree', notGit])
      const cp = readRun(runFile('run-1')).run?.checkpoints[0]
      expect(cp?.branch).toBeNull()
      expect(cp?.commit).toBeNull()
      expect(cp?.dirty).toBeNull()
      expect(stdout).toContain('checkpoint run-1')
      expect(stdout).toContain('@ -')
    } finally {
      fs.rmSync(notGit, {recursive: true, force: true})
    }
  })

  it('run-id that is an inherited property (toString) → no crash, records in runs/toString.json', async () => {
    await runCaptured(Checkpoint, ['toString', 'setup', '--worktree', repo])
    expect(readRun(runFile('toString')).run?.run_id).toBe('toString')
  })

  it('hostile run-id (prototype) → exit 2 without touching the disk', async () => {
    const {stderr} = await runExpectingExit(Checkpoint, ['__proto__', 'setup', '--worktree', repo], 2)
    expect(stderr).toContain('C400-STATE-002')
    expect(fs.existsSync(path.join(stateDir, 'runs'))).toBe(false)
  })

  it('run-id with a path separator → exit 2 (never path traversal)', async () => {
    const {stderr} = await runExpectingExit(Checkpoint, ['../evasione', 'setup', '--worktree', repo], 2)
    expect(stderr).toContain('C400-STATE-002')
  })

  it('no worktree target (neither --worktree nor --project/--ticket) → exit 2', async () => {
    const {stderr} = await runExpectingExit(Checkpoint, ['run-1', 'setup'], 2)
    expect(stderr).toContain('C400-STATE-003')
  })

  it('--json does not print the human-readable lines', async () => {
    const {result, stdout} = await runCaptured(Checkpoint, ['run-1', 'implement', '--worktree', repo, '--json'])
    expect((result as {runId: string}).runId).toBe('run-1')
    expect(stdout).not.toContain('checkpoint run-1')
    expect(readRun(runFile('run-1')).run).toBeTruthy()
  })
})
