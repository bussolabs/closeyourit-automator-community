import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import {spawnSync} from 'node:child_process'
import {afterEach, beforeEach, describe, expect, it} from 'vitest'
import Recovery from '../src/commands/recovery'
import {saveSecrets} from '../src/lib/config'
import {saveLease} from '../src/lib/lease'
import {type Checkpoint, type RunRecord, saveRun} from '../src/lib/state'
import {runCaptured, runExpectingExit} from './helpers/command'

let stateDir: string
const savedEnv = {...process.env}

function gitIn(cwd: string, args: string[]): string {
  const res = spawnSync('git', ['-C', cwd, ...args], {encoding: 'utf8'})
  if (res.status !== 0) throw new Error(`git ${args.join(' ')} → ${res.stderr}`)
  return res.stdout.trim()
}

/** Clone (with a bare remote) that already has a commit pushed on the ticket branch. Returns the path and the pushed sha. */
function makeCloneWithRemote(): {clone: string; remote: string; pushed: string} {
  const remote = fs.mkdtempSync(path.join(os.tmpdir(), 'automator-reccmd-remote-'))
  const clone = fs.mkdtempSync(path.join(os.tmpdir(), 'automator-reccmd-clone-'))
  spawnSync('git', ['init', '-q', '--bare', '-b', 'ticket/CYAU-15', remote], {encoding: 'utf8'})
  spawnSync('git', ['clone', '-q', remote, clone], {encoding: 'utf8'})
  fs.writeFileSync(path.join(clone, 'README.md'), '# x\n')
  gitIn(clone, ['add', '.'])
  gitIn(clone, ['-c', 'user.email=t@e.st', '-c', 'user.name=Test', 'commit', '-qm', 'init'])
  gitIn(clone, ['push', '-q', 'origin', 'ticket/CYAU-15'])
  return {clone, remote, pushed: gitIn(clone, ['rev-parse', 'HEAD'])}
}

function checkpoint(over: Partial<Checkpoint> = {}): Checkpoint {
  return {
    phase: 'implement',
    branch: 'ticket/CYAU-15',
    commit: 'abc123',
    worktree: null,
    dirty: false,
    artifacts: [],
    outcome: null,
    at: '2026-07-12T10:00:00.000Z',
    ...over,
  }
}

function seedRun(runId: string, checkpoints: Checkpoint[], over: Partial<RunRecord> = {}): void {
  const record: RunRecord = {
    run_id: runId,
    ticket: 'CYAU-15',
    repository: 'acme/widget',
    updated_at: '2026-07-12T10:00:00.000Z',
    checkpoints,
    ...over,
  }
  saveRun(path.join(stateDir, 'runs', `${runId}.json`), record)
}

const FUTURE = '2099-01-01T00:00:00.000Z' // lease non scaduto rispetto all'orologio reale
const PAST = '2000-01-01T00:00:00.000Z' // lease scaduto rispetto all'orologio reale

beforeEach(() => {
  stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'automator-reccmd-'))
  process.env.AUTOMATOR_STATE_DIR = stateDir
  process.env.AUTOMATOR_CONFIG_DIR = stateDir
  process.env.AUTOMATOR_DATA_DIR = stateDir
  saveSecrets({host: {id: 'h1', token: 'cyi_ah_s'}})
})

afterEach(() => {
  process.env = {...savedEnv}
  fs.rmSync(stateDir, {recursive: true, force: true})
})

describe('recovery command — missing checkpoint', () => {
  it('no run with that run-id → manual, exit 3 (flagged for intervention)', async () => {
    const {stderr} = await runExpectingExit(Recovery, ['run-ignoto'], 3)
    expect(stderr).toContain('C409-RECOVERY-001')
  })
})

describe('recovery command — stesso host torna online', () => {
  it('our lease (h1) → resume from the correct phase, exit 0', async () => {
    saveLease({ticket: 'CYAU-15', host_id: 'h1', run_id: 'run-1', agent: 'triage', ttl_seconds: 3600, expires_at: FUTURE, acquired_at: 'x', updated_at: 'x'})
    seedRun('run-1', [checkpoint({phase: 'setup'}), checkpoint({phase: 'implement'})])

    const {result, stdout} = await runCaptured(Recovery, ['run-1'])
    expect((result as {decision: string}).decision).toBe('resume')
    expect((result as {reason: string}).reason).toBe('same-host-resume')
    expect((result as {resumePhase: string}).resumePhase).toBe('implement')
    expect(stdout.toLowerCase()).toContain('resume')
  })
})

describe('recovery command — another host holds the lease', () => {
  it('unexpired h2 lease → blocked, exit 3', async () => {
    saveLease({ticket: 'CYAU-15', host_id: 'h2', run_id: 'run-1', agent: 'triage', ttl_seconds: 3600, expires_at: FUTURE, acquired_at: 'x', updated_at: 'x'})
    seedRun('run-1', [checkpoint()])

    const {stderr} = await runExpectingExit(Recovery, ['run-1'], 3)
    expect(stderr).toContain('C409-RECOVERY-002')
  })

  it('lease re-acquired by another run (different run_id) on the same host → blocked, exit 3', async () => {
    // The ticket lease now belongs to run-2 (new run); the recovery of run-1 must not take it over.
    saveLease({ticket: 'CYAU-15', host_id: 'h1', run_id: 'run-2', agent: 'triage', ttl_seconds: 3600, expires_at: FUTURE, acquired_at: 'x', updated_at: 'x'})
    seedRun('run-1', [checkpoint()])

    const {stderr} = await runExpectingExit(Recovery, ['run-1'], 3)
    expect(stderr).toContain('C409-RECOVERY-002')
  })
})

describe('recovery command — local-only work', () => {
  it('dirty worktree (uncommitted changes) → manual, exit 3', async () => {
    saveLease({ticket: 'CYAU-15', host_id: 'h2', run_id: 'run-1', agent: 'triage', ttl_seconds: 3600, expires_at: PAST, acquired_at: 'x', updated_at: 'x'})
    seedRun('run-1', [checkpoint({dirty: true})])

    const {stderr} = await runExpectingExit(Recovery, ['run-1'], 3)
    expect(stderr).toContain('C409-RECOVERY-001')
  })

  it('unpushed local commit → manual, exit 3 (the work lives only on the offline host)', async () => {
    const {clone} = makeCloneWithRemote()
    try {
      // Extra local commit, NEVER pushed.
      fs.writeFileSync(path.join(clone, 'wip.txt'), 'work\n')
      gitIn(clone, ['add', '.'])
      gitIn(clone, ['-c', 'user.email=t@e.st', '-c', 'user.name=Test', 'commit', '-qm', 'wip'])
      const local = gitIn(clone, ['rev-parse', 'HEAD'])
      seedRun('run-1', [checkpoint({phase: 'commit', commit: local, worktree: clone, dirty: false})])

      const {stderr} = await runExpectingExit(Recovery, ['run-1'], 3)
      expect(stderr).toContain('C409-RECOVERY-001')
    } finally {
      fs.rmSync(clone, {recursive: true, force: true})
    }
  })
})

describe('recovery command — recupero da remoto', () => {
  it('pushed branch and clean worktree (no lease) → resume, remote-resume, exit 0', async () => {
    const {clone} = makeCloneWithRemote()
    try {
      const pushed = gitIn(clone, ['rev-parse', 'HEAD'])
      seedRun('run-1', [checkpoint({phase: 'commit', commit: pushed, worktree: clone, dirty: false})])

      const {result} = await runCaptured(Recovery, ['run-1'])
      expect((result as {decision: string}).decision).toBe('resume')
      expect((result as {reason: string}).reason).toBe('remote-resume')
      expect((result as {resumePhase: string}).resumePhase).toBe('commit')
    } finally {
      fs.rmSync(clone, {recursive: true, force: true})
    }
  })

  it('explicit --worktree takes precedence to probe the remote branch', async () => {
    const {clone} = makeCloneWithRemote()
    try {
      const pushed = gitIn(clone, ['rev-parse', 'HEAD'])
      // The checkpoint carries no worktree: the flag provides it.
      seedRun('run-1', [checkpoint({phase: 'commit', commit: pushed, worktree: null, dirty: false})])

      const {result} = await runCaptured(Recovery, ['run-1', '--worktree', clone])
      expect((result as {reason: string}).reason).toBe('remote-resume')
    } finally {
      fs.rmSync(clone, {recursive: true, force: true})
    }
  })
})

describe('recovery command — robustezza e output', () => {
  it('hostile run-id (prototype) → exit 2, never I/O', async () => {
    const {stderr} = await runExpectingExit(Recovery, ['__proto__'], 2)
    expect(stderr).toContain('C400-STATE-002')
  })

  it('run-id with a path separator → exit 2 (never path traversal)', async () => {
    const {stderr} = await runExpectingExit(Recovery, ['../evasione'], 2)
    expect(stderr).toContain('C400-STATE-002')
  })

  it('corrupt checkpoint file → preserved in quarantine and treated as not resumable (manual)', async () => {
    const runFile = path.join(stateDir, 'runs', 'run-1.json')
    fs.mkdirSync(path.dirname(runFile), {recursive: true})
    fs.writeFileSync(runFile, '{ questo non è json')

    const {stderr} = await runExpectingExit(Recovery, ['run-1'], 3)
    expect(stderr).toContain('C409-RECOVERY-001')
    const quarantined = fs.readdirSync(path.join(stateDir, 'runs')).find((f) => f.includes('.corrupt-'))
    expect(quarantined).toBeTruthy()
    expect(fs.readFileSync(path.join(stateDir, 'runs', quarantined as string), 'utf8')).toBe('{ questo non è json')
  })

  it('--json returns the decision and does not print the human-readable lines', async () => {
    saveLease({ticket: 'CYAU-15', host_id: 'h1', run_id: 'run-1', agent: 'triage', ttl_seconds: 3600, expires_at: FUTURE, acquired_at: 'x', updated_at: 'x'})
    seedRun('run-1', [checkpoint({phase: 'implement'})])

    const {result, stdout} = await runCaptured(Recovery, ['run-1', '--json'])
    expect((result as {decision: string}).decision).toBe('resume')
    expect(stdout).not.toContain('resume dalla fase')
  })
})
