import {spawnSync} from 'node:child_process'

/**
 * Triage and planner run read-only in the managed checkout itself, not in a ticket worktree. Nothing else
 * advances that checkout (only the worktree path fetches), so it drifted weeks behind and the planner refused
 * to plan on code that no longer existed (CYRA-873). This brings it forward before those phases run.
 *
 * Fast-forward only: a local change or a diverged branch is kept as is and reported, never reset.
 */
export type CheckoutRefreshOutcome = 'fast-forwarded' | 'up-to-date' | 'fetch-failed' | 'no-default' | 'not-on-default' | 'not-fast-forwardable'

type RunGit = (args: string[]) => {ok: boolean; stdout: string}

// Runs inside the daemon tick: a remote that accepts and then hangs must not stall heartbeat and lease renewals.
const GIT_TIMEOUT_MS = 120_000

function defaultRunGit(repoDir: string): RunGit {
  return (args) => {
    const res = spawnSync('git', ['-C', repoDir, ...args], {
      encoding: 'utf8',
      env: {...process.env, GIT_TERMINAL_PROMPT: '0'},
      timeout: GIT_TIMEOUT_MS,
    })
    return {ok: res.status === 0, stdout: (res.stdout ?? '').trim()}
  }
}

export function refreshReadOnlyCheckout(repoDir: string, runGit: RunGit = defaultRunGit(repoDir)): {outcome: CheckoutRefreshOutcome} {
  if (!runGit(['fetch', 'origin', '--prune']).ok) return {outcome: 'fetch-failed'}

  const remoteDefault = runGit(['symbolic-ref', '--short', 'refs/remotes/origin/HEAD'])
  if (!remoteDefault.ok || !remoteDefault.stdout.startsWith('origin/')) return {outcome: 'no-default'}

  const current = runGit(['symbolic-ref', '--quiet', '--short', 'HEAD'])
  if (!current.ok || current.stdout !== remoteDefault.stdout.slice('origin/'.length)) return {outcome: 'not-on-default'}

  const before = runGit(['rev-parse', 'HEAD']).stdout
  if (!runGit(['merge', '--ff-only', '--quiet', remoteDefault.stdout]).ok) return {outcome: 'not-fast-forwardable'}

  return {outcome: runGit(['rev-parse', 'HEAD']).stdout === before ? 'up-to-date' : 'fast-forwarded'}
}
