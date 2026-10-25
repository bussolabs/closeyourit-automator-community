import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import {spawnSync} from 'node:child_process'
import {afterEach, beforeEach, describe, expect, it} from 'vitest'
import {type CheckpointGit, defaultCheckpointGit, deriveCheckpoint} from '../src/lib/checkpoint'

/** Fake git probe: returns fixed values without touching a real repo. */
function fakeGit(over: Partial<CheckpointGit> = {}): CheckpointGit {
  return {
    currentBranch: () => 'ticket/CYAU-12',
    headCommit: () => 'abc123',
    isDirty: () => false,
    ...over,
  }
}

describe('deriveCheckpoint', () => {
  it('derives branch, commit, worktree and dirty from the worktree via the git probe', () => {
    const cp = deriveCheckpoint({phase: 'implement', worktree: '/w/CYAU/CYAU-12', at: '2026-07-12T10:00:00.000Z'}, fakeGit())
    expect(cp).toEqual({
      phase: 'implement',
      branch: 'ticket/CYAU-12',
      commit: 'abc123',
      worktree: '/w/CYAU/CYAU-12',
      dirty: false,
      artifacts: [],
      outcome: null,
      at: '2026-07-12T10:00:00.000Z',
    })
  })

  it('an explicit commit (reported by the agent) wins over HEAD', () => {
    const cp = deriveCheckpoint(
      {phase: 'commit', worktree: '/w', commit: 'deadbeef', at: '2026-07-12T10:00:00.000Z'},
      fakeGit({headCommit: () => 'headsha'}),
    )
    expect(cp.commit).toBe('deadbeef')
  })

  it('empty explicit commit → falls back to HEAD', () => {
    const cp = deriveCheckpoint({phase: 'commit', worktree: '/w', commit: '  ', at: 'x'}, fakeGit({headCommit: () => 'headsha'}))
    expect(cp.commit).toBe('headsha')
  })

  it('non-git worktree (null probes) → null branch/commit/dirty, no crash', () => {
    const cp = deriveCheckpoint(
      {phase: 'setup', worktree: '/not/a/repo', at: 'x'},
      fakeGit({currentBranch: () => null, headCommit: () => null, isDirty: () => null}),
    )
    expect(cp.branch).toBeNull()
    expect(cp.commit).toBeNull()
    expect(cp.dirty).toBeNull()
  })

  it('propaga artefatti e outcome', () => {
    const cp = deriveCheckpoint(
      {phase: 'test', worktree: '/w', artifacts: ['a.ts', 'b.ts'], outcome: 'success', at: 'x'},
      fakeGit(),
    )
    expect(cp.artifacts).toEqual(['a.ts', 'b.ts'])
    expect(cp.outcome).toBe('success')
  })
})

describe('defaultCheckpointGit (git reale)', () => {
  let repo: string
  const git = (args: string[]): void => {
    const res = spawnSync('git', ['-C', repo, ...args], {encoding: 'utf8'})
    if (res.status !== 0) throw new Error(`git ${args.join(' ')} → ${res.stderr}`)
  }

  beforeEach(() => {
    repo = fs.mkdtempSync(path.join(os.tmpdir(), 'automator-cp-git-'))
    git(['init', '-q', '-b', 'ticket/CYAU-12'])
    fs.writeFileSync(path.join(repo, 'README.md'), '# x\n')
    git(['add', '.'])
    git(['-c', 'user.email=t@e.st', '-c', 'user.name=Test', 'commit', '-qm', 'init'])
  })

  afterEach(() => fs.rmSync(repo, {recursive: true, force: true}))

  it('reads branch, commit and dirty from a clean checkout', () => {
    const probe = defaultCheckpointGit()
    expect(probe.currentBranch(repo)).toBe('ticket/CYAU-12')
    expect(probe.headCommit(repo)).toMatch(/^[0-9a-f]{40}$/)
    expect(probe.isDirty(repo)).toBe(false)
  })

  it('detects the dirty state with uncommitted changes', () => {
    fs.writeFileSync(path.join(repo, 'wip.txt'), 'work\n')
    expect(defaultCheckpointGit().isDirty(repo)).toBe(true)
  })

  it('non-git worktree → null probes (no crash)', () => {
    const notRepo = fs.mkdtempSync(path.join(os.tmpdir(), 'automator-cp-nogit-'))
    const probe = defaultCheckpointGit()
    expect(probe.currentBranch(notRepo)).toBeNull()
    expect(probe.headCommit(notRepo)).toBeNull()
    expect(probe.isDirty(notRepo)).toBeNull()
    fs.rmSync(notRepo, {recursive: true, force: true})
  })
})
