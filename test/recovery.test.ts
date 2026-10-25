import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import {spawnSync} from 'node:child_process'
import {afterEach, beforeEach, describe, expect, it} from 'vitest'
import {auditRecovery, defaultRecoveryGit, type RecoveryInput} from '../src/lib/recovery'
import {type Checkpoint, type RunRecord} from '../src/lib/state'
import {type LeaseRecord} from '../src/lib/lease'

// ── Fixture: compact builders for RunRecord/Checkpoint/LeaseRecord ─────────────────────────────────────

/** Builds a checkpoint with sensible defaults, overridable field by field. */
function checkpoint(over: Partial<Checkpoint> = {}): Checkpoint {
  return {
    phase: 'implement',
    branch: 'ticket/CYAU-15',
    commit: 'abc123',
    worktree: '/w/CYAU/CYAU-15',
    dirty: false,
    artifacts: [],
    outcome: null,
    at: '2026-07-12T10:00:00.000Z',
    ...over,
  }
}

/** Builds a RunRecord with the given checkpoint history (default: a single 'implement' checkpoint). */
function run(checkpoints: Checkpoint[] = [checkpoint()], over: Partial<RunRecord> = {}): RunRecord {
  return {
    run_id: 'run-42',
    ticket: 'CYAU-15',
    repository: 'acme/widget',
    updated_at: '2026-07-12T10:00:00.000Z',
    checkpoints,
    ...over,
  }
}

/** Builds a LeaseRecord (held by h1 by default, expiry 15:00). */
function lease(over: Partial<LeaseRecord> = {}): LeaseRecord {
  return {
    ticket: 'CYAU-15',
    host_id: 'h1',
    run_id: 'run-42',
    agent: 'triage',
    ttl_seconds: 3600,
    expires_at: '2026-07-12T15:00:00.000Z',
    acquired_at: '2026-07-12T09:00:00.000Z',
    updated_at: '2026-07-12T09:00:00.000Z',
    ...over,
  }
}

// An instant between the acquisition (09:00) and the default expiry (15:00) → lease not expired.
const NOW = new Date('2026-07-12T12:00:00.000Z')
// Beyond the default expiry → lease expired.
const AFTER_EXPIRY = new Date('2026-07-12T16:00:00.000Z')

function audit(over: Partial<RecoveryInput>): ReturnType<typeof auditRecovery> {
  return auditRecovery({run: run(), lease: null, hostId: 'h1', branchPushed: null, now: NOW, ...over})
}

describe('auditRecovery — missing checkpoint', () => {
  it('missing run (never started) → manual, no-checkpoint', () => {
    const plan = audit({run: null})
    expect(plan.decision).toBe('manual')
    expect(plan.reason).toBe('no-checkpoint')
    expect(plan.resumePhase).toBeNull()
    expect(plan.signals.hasCheckpoint).toBe(false)
  })

  it('run without checkpoint (empty history) → manual, no-checkpoint', () => {
    const plan = audit({run: run([])})
    expect(plan.decision).toBe('manual')
    expect(plan.reason).toBe('no-checkpoint')
  })
})

describe('auditRecovery — same host comes back online', () => {
  it('our lease not expired → resume from the phase of the last checkpoint (local worktree intact)', () => {
    const plan = audit({run: run([checkpoint({phase: 'setup'}), checkpoint({phase: 'implement'})]), lease: lease(), hostId: 'h1'})
    expect(plan.decision).toBe('resume')
    expect(plan.reason).toBe('same-host-resume')
    expect(plan.resumePhase).toBe('implement')
    expect(plan.signals.sameHost).toBe(true)
    expect(plan.signals.leaseOwner).toBe('ours')
  })

  it('our lease even with dirty worktree and local commit → resume (the work is all on our disk)', () => {
    const plan = audit({
      run: run([checkpoint({dirty: true})]),
      lease: lease(),
      hostId: 'h1',
      branchPushed: false,
    })
    expect(plan.decision).toBe('resume')
    expect(plan.reason).toBe('same-host-resume')
  })

  it('our lease but expired → resume anyway (the worktree is ours; the lease will be re-acquired downstream)', () => {
    const plan = audit({lease: lease(), hostId: 'h1', now: AFTER_EXPIRY})
    expect(plan.decision).toBe('resume')
    expect(plan.reason).toBe('same-host-resume')
    expect(plan.signals.sameHost).toBe(true)
    expect(plan.signals.leaseExpired).toBe(true)
  })
})

describe('auditRecovery — another host still holds the lease', () => {
  it('lease of another host not expired → blocked, lease-held (live work elsewhere, do not recover)', () => {
    const plan = audit({lease: lease({host_id: 'h2'}), hostId: 'h1'})
    expect(plan.decision).toBe('blocked')
    expect(plan.reason).toBe('lease-held')
    expect(plan.signals.sameHost).toBe(false)
    expect(plan.signals.leaseOwner).toBe('other')
  })

  it('lease of another host with unknown expiry → blocked (conservative: I do not declare it dead)', () => {
    const plan = audit({lease: lease({host_id: 'h2', expires_at: null}), hostId: 'h1'})
    expect(plan.decision).toBe('blocked')
    expect(plan.reason).toBe('lease-held')
    expect(plan.signals.leaseExpired).toBeNull()
  })
})

// The ticket is unique but the runs are not: after a run was interrupted, the lease may have been
// re-acquired by a DIFFERENT run (same ticket, different run_id). The recovery of the old run must not
// confuse that lease with its own (otherwise it would resume a superseded run → duplicated work).
describe('auditRecovery — lease re-acquired by a different run (run_id)', () => {
  it('lease of the same host but another run_id, still active → blocked (does not resume the old run)', () => {
    const plan = audit({
      run: run([checkpoint()], {run_id: 'run-1'}),
      lease: lease({host_id: 'h1', run_id: 'run-2'}),
      hostId: 'h1',
    })
    expect(plan.decision).toBe('blocked')
    expect(plan.reason).toBe('lease-held')
    expect(plan.signals.sameHost).toBe(false)
    expect(plan.signals.leaseRunMatches).toBe(false)
  })

  it('lease of the same host and same run_id → resume (it really is our run)', () => {
    const plan = audit({
      run: run([checkpoint()], {run_id: 'run-1'}),
      lease: lease({host_id: 'h1', run_id: 'run-1'}),
      hostId: 'h1',
    })
    expect(plan.decision).toBe('resume')
    expect(plan.reason).toBe('same-host-resume')
    expect(plan.signals.sameHost).toBe(true)
    expect(plan.signals.leaseRunMatches).toBe(true)
  })
})

describe('auditRecovery — recovery from another host (lease expired or missing)', () => {
  it('branch pushed, clean worktree → resume, remote-resume (recoverable from remote)', () => {
    const plan = audit({
      run: run([checkpoint({phase: 'commit', dirty: false})]),
      lease: lease({host_id: 'h2'}),
      hostId: 'h1',
      now: AFTER_EXPIRY,
      branchPushed: true,
    })
    expect(plan.decision).toBe('resume')
    expect(plan.reason).toBe('remote-resume')
    expect(plan.resumePhase).toBe('commit')
  })

  it('dirty worktree → manual, local-only-work (uncommitted changes, not recoverable elsewhere)', () => {
    const plan = audit({
      run: run([checkpoint({dirty: true})]),
      lease: lease({host_id: 'h2'}),
      hostId: 'h1',
      now: AFTER_EXPIRY,
      branchPushed: true,
    })
    expect(plan.decision).toBe('manual')
    expect(plan.reason).toBe('local-only-work')
    expect(plan.signals.localOnlyWork).toBe(true)
  })

  it('unpushed local commit → manual, local-only-work (the commit lives only on the dead host)', () => {
    const plan = audit({
      run: run([checkpoint({commit: 'localsha', dirty: false})]),
      lease: null,
      hostId: 'h1',
      now: AFTER_EXPIRY,
      branchPushed: false,
    })
    expect(plan.decision).toBe('manual')
    expect(plan.reason).toBe('local-only-work')
  })

  it('undetermined branch pushed (git not verifiable) with commit → manual (conservative)', () => {
    const plan = audit({
      run: run([checkpoint({commit: 'somesha', dirty: false})]),
      lease: null,
      branchPushed: null,
    })
    expect(plan.decision).toBe('manual')
    expect(plan.reason).toBe('local-only-work')
  })

  it('checkpoint without commit (e.g. setup only) and clean → resume, remote-resume (no work to lose)', () => {
    const plan = audit({
      run: run([checkpoint({phase: 'setup', commit: null, dirty: false})]),
      lease: null,
      branchPushed: null,
    })
    expect(plan.decision).toBe('resume')
    expect(plan.reason).toBe('remote-resume')
    expect(plan.resumePhase).toBe('setup')
    expect(plan.signals.localOnlyWork).toBe(false)
  })

  it('no lease, branch pushed, clean → resume, remote-resume', () => {
    const plan = audit({lease: null, branchPushed: true})
    expect(plan.decision).toBe('resume')
    expect(plan.reason).toBe('remote-resume')
    expect(plan.signals.leaseOwner).toBe('none')
  })
})

describe('auditRecovery — unregistered host (unknown identity)', () => {
  it('hostId null with active lease → blocked (cannot recognise "same host", stays conservative)', () => {
    const plan = audit({lease: lease(), hostId: null})
    expect(plan.decision).toBe('blocked')
    expect(plan.signals.sameHost).toBe(false)
  })

  it('hostId null without lease, branch pushed → resume, remote-resume', () => {
    const plan = audit({lease: null, hostId: null, branchPushed: true})
    expect(plan.decision).toBe('resume')
    expect(plan.reason).toBe('remote-resume')
  })
})

describe('auditRecovery — exposed ticket and signals', () => {
  it('exposes the ticket from the run record', () => {
    expect(audit({run: run(), lease: null}).ticket).toBe('CYAU-15')
  })

  it('falls back on the lease ticket if the run does not carry it', () => {
    const plan = audit({run: run([checkpoint()], {ticket: null}), lease: lease({host_id: 'h1'}), hostId: 'h1'})
    expect(plan.ticket).toBe('CYAU-15')
  })

  it('exposes dirty and branchPushed observed in the signals', () => {
    const plan = audit({run: run([checkpoint({dirty: true})]), lease: lease(), hostId: 'h1', branchPushed: false})
    expect(plan.signals.dirty).toBe(true)
    expect(plan.signals.branchPushed).toBe(false)
  })
})

// ── Real git probe: is the last checkpoint commit reachable from a remote branch? ───────────────────────

describe('defaultRecoveryGit.remoteContains (real git)', () => {
  let remote: string
  let clone: string
  const gitIn = (cwd: string, args: string[]): string => {
    const res = spawnSync('git', ['-C', cwd, ...args], {encoding: 'utf8'})
    if (res.status !== 0) throw new Error(`git ${args.join(' ')} → ${res.stderr}`)
    return res.stdout.trim()
  }

  beforeEach(() => {
    remote = fs.mkdtempSync(path.join(os.tmpdir(), 'automator-rec-remote-'))
    clone = fs.mkdtempSync(path.join(os.tmpdir(), 'automator-rec-clone-'))
    // Bare remote + clone with an initial pushed commit.
    spawnSync('git', ['init', '-q', '--bare', '-b', 'ticket/CYAU-15', remote], {encoding: 'utf8'})
    spawnSync('git', ['clone', '-q', remote, clone], {encoding: 'utf8'})
    fs.writeFileSync(path.join(clone, 'README.md'), '# x\n')
    gitIn(clone, ['add', '.'])
    gitIn(clone, ['-c', 'user.email=t@e.st', '-c', 'user.name=Test', 'commit', '-qm', 'init'])
    gitIn(clone, ['push', '-q', 'origin', 'ticket/CYAU-15'])
  })

  afterEach(() => {
    fs.rmSync(remote, {recursive: true, force: true})
    fs.rmSync(clone, {recursive: true, force: true})
  })

  it('pushed commit → true', () => {
    const pushed = gitIn(clone, ['rev-parse', 'HEAD'])
    expect(defaultRecoveryGit().remoteContains(clone, pushed)).toBe(true)
  })

  it('local commit not yet pushed → false', () => {
    fs.writeFileSync(path.join(clone, 'wip.txt'), 'work\n')
    gitIn(clone, ['add', '.'])
    gitIn(clone, ['-c', 'user.email=t@e.st', '-c', 'user.name=Test', 'commit', '-qm', 'wip'])
    const local = gitIn(clone, ['rev-parse', 'HEAD'])
    expect(defaultRecoveryGit().remoteContains(clone, local)).toBe(false)
  })

  it('commit pushed by ANOTHER clone → true after updating the remote refs (never rely on stale refs)', () => {
    // A second clone pushes a new commit: `clone` does not know it locally yet. The probe must
    // update the remote refs (fetch) and recognise it as pushed — otherwise a stale ref would give a wrong
    // outcome (false negative here, but the same staleness can produce false positives in other scenarios).
    const clone2 = fs.mkdtempSync(path.join(os.tmpdir(), 'automator-rec-clone2-'))
    try {
      spawnSync('git', ['clone', '-q', remote, clone2], {encoding: 'utf8'})
      fs.writeFileSync(path.join(clone2, 'f2.txt'), 'x\n')
      gitIn(clone2, ['add', '.'])
      gitIn(clone2, ['-c', 'user.email=t@e.st', '-c', 'user.name=Test', 'commit', '-qm', 'from clone2'])
      gitIn(clone2, ['push', '-q', 'origin', 'ticket/CYAU-15'])
      const sha = gitIn(clone2, ['rev-parse', 'HEAD'])

      // `clone` has never seen this commit: without updating the remote refs it would be unknown.
      expect(defaultRecoveryGit().remoteContains(clone, sha)).toBe(true)
    } finally {
      fs.rmSync(clone2, {recursive: true, force: true})
    }
  })

  it('unknown commit → null (not verifiable, never crash)', () => {
    expect(defaultRecoveryGit().remoteContains(clone, 'deadbeefdeadbeefdeadbeefdeadbeefdeadbeef')).toBeNull()
  })

  it('non-git worktree → null (no crash)', () => {
    const notGit = fs.mkdtempSync(path.join(os.tmpdir(), 'automator-rec-nogit-'))
    try {
      expect(defaultRecoveryGit().remoteContains(notGit, 'abc123')).toBeNull()
    } finally {
      fs.rmSync(notGit, {recursive: true, force: true})
    }
  })
})
