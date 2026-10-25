import {spawnSync} from 'node:child_process'
import {type Checkpoint, type RunStatus} from './state'

// Derivation of a phase checkpoint from the run's worktree (CYAU-12). The state of
// "where the work is" — branch, HEAD commit, dirty state — lives in git, not in the agent report: here it is
// probed from the worktree and composed into a `CheckpointInput` ready for `recordCheckpoint`. Pure with respect
// to git: every command lives behind `CheckpointGit`, injectable in tests (fake git or real temporary repo).

/** Read-only git probes on the worktree. Every method returns `null` if git is not available or the path is not a checkout. */
export interface CheckpointGit {
  currentBranch(worktree: string): string | null
  headCommit(worktree: string): string | null
  isDirty(worktree: string): boolean | null
}

export interface DeriveInput {
  phase: string
  worktree: string
  artifacts?: string[]
  /** Explicit commit (e.g. the one reported by the agent): takes precedence over the probed HEAD. */
  commit?: string | null
  outcome?: RunStatus | null
  at: string // ISO 8601
}

/**
 * Composes a phase checkpoint by probing the worktree via `git`: current branch, commit and dirty state.
 * An explicit `commit` (reported by the agent) takes precedence over HEAD; a non-git worktree degrades to `null` on the
 * git fields without ever failing. The result (all fields populated) is ready for `recordCheckpoint`.
 */
export function deriveCheckpoint(input: DeriveInput, git: CheckpointGit): Checkpoint {
  const explicit = input.commit?.trim()
  const commit = explicit && explicit !== '' ? explicit : git.headCommit(input.worktree)
  return {
    phase: input.phase,
    branch: git.currentBranch(input.worktree),
    commit,
    worktree: input.worktree,
    dirty: git.isDirty(input.worktree),
    artifacts: input.artifacts ?? [],
    outcome: input.outcome ?? null,
    at: input.at,
  }
}

/** Trimmed stdout of `git -C <worktree> <args>`, or `null` if the command fails (git missing / not a repo). */
function gitOut(worktree: string, args: string[]): string | null {
  const res = spawnSync('git', ['-C', worktree, ...args], {encoding: 'utf8'})
  if (res.status !== 0) return null
  const out = res.stdout.trim()
  return out === '' ? null : out
}

/** Real git probes (spawnSync, argv array = no shell). Read-only: never mutates the worktree. */
export function defaultCheckpointGit(): CheckpointGit {
  return {
    currentBranch(worktree) {
      return gitOut(worktree, ['rev-parse', '--abbrev-ref', 'HEAD'])
    },
    headCommit(worktree) {
      return gitOut(worktree, ['rev-parse', 'HEAD'])
    },
    isDirty(worktree) {
      const res = spawnSync('git', ['-C', worktree, 'status', '--porcelain'], {encoding: 'utf8'})
      if (res.status !== 0) return null
      return res.stdout.trim() !== ''
    },
  }
}
