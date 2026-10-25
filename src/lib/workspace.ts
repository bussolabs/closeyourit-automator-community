import {spawnSync} from 'node:child_process'
import {randomUUID} from 'node:crypto'
import * as fs from 'node:fs'
import * as path from 'node:path'
import {repositoriesDir, worktreesDir} from './paths'
import {normalizeGitHubRemote, readGitHubAliases} from './discover'
import {AutomatorError, ErrorCodes} from '../errors/error-codes'

// Management of checkouts and worktrees in an Automator directory (CYAU-11). The automator does NOT work in the
// operator's personal repositories: it keeps its own checkouts in `repositories/<owner>/<repo>` and an
// ISOLATED worktree for each ticket in `worktrees/<project>/<ticket>`. The preparation is additive and
// idempotent: it clones the repo only if missing, adds the worktree only if missing, otherwise REUSES the
// existing ones. It never runs reset/clean/remove → it does not delete work not yet integrated. It prevents
// nested worktrees (never a worktree inside the repository tree). Pure with respect to git/fs: every command
// lives behind `WorkspaceGit`, injectable in tests.

// Segments that, used as a path component (`path.join(base, seg)`), would climb up or mutate the
// prototype. The sources (project key, ticket, owner/repo) come from the server or the git remote WITHOUT
// runtime validation → defence in depth at the entry, like `discover.isUnsafeKey`.
const UNSAFE_SEGMENTS: ReadonlySet<string> = new Set(['', '.', '..', '__proto__', 'prototype', 'constructor'])

/** true if `seg` is a single safe path component: not empty, not `.`/`..`, without separators/null, not hostile. */
export function isSafeSegment(seg: string): boolean {
  return !UNSAFE_SEGMENTS.has(seg) && !/[/\\\0]/.test(seg)
}

function requireSafe(seg: string, kind: string): string {
  if (!isSafeSegment(seg)) {
    throw new AutomatorError(ErrorCodes.Workspace.unsafeSegment, `Segmento di path non sicuro (${kind}): "${seg}"`, 2)
  }

  return seg
}

/** Splits `owner/repo` into the two segments, validating them. Rejects anything that is not exactly two safe segments. */
export function splitRepo(fullName: string): {owner: string; repo: string} {
  const parts = fullName.split('/')
  if (parts.length !== 2) {
    throw new AutomatorError(ErrorCodes.Workspace.unsafeSegment, `Repo non valido (atteso owner/repo): "${fullName}"`, 2)
  }

  return {owner: requireSafe(parts[0], 'owner'), repo: requireSafe(parts[1], 'repo')}
}

/** Path of the managed checkout for `owner/repo`: `<repositoriesDir>/<owner>/<repo>`. */
export function repositoryPath(fullName: string, base: string = repositoriesDir()): string {
  const {owner, repo} = splitRepo(fullName)
  return path.join(base, owner, repo)
}

/** Path of the isolated worktree for a ticket: `<worktreesDir>/<project>/<ticket>`. */
export function worktreePath(projectKey: string, ticket: string, base: string = worktreesDir()): string {
  return path.join(base, requireSafe(projectKey, 'project'), requireSafe(ticket, 'ticket'))
}

/** Worktree branch for a ticket: `ticket/<ticket>` (consistent with the guard-branch-push guardrail). */
export function ticketBranch(ticket: string): string {
  return `ticket/${requireSafe(ticket, 'ticket')}`
}

/** Clone URL derived from `owner/repo` (GitHub HTTPS). The caller can provide an explicit URL (SSH/mirror). */
export function cloneUrl(fullName: string): string {
  const {owner, repo} = splitRepo(fullName)
  return `https://github.com/${owner}/${repo}.git`
}

function comparableExplicitRemote(url: string): string {
  const trimmed = url.trim().replace(/\/$/, '')
  return path.isAbsolute(trimmed) ? path.resolve(trimmed) : trimmed
}

/** Compares the observed remote with the canonical full_name or, for explicit non-GitHub mirrors, with the requested URL. */
export function remoteMatches(
  observedUrl: string,
  expectedFullName: string,
  explicitUrl?: string,
  githubHosts: ReadonlySet<string> = new Set(),
): boolean {
  const observedRepo = normalizeGitHubRemote(observedUrl, githubHosts)
  const expectedRepo = expectedFullName.trim().toLowerCase()
  if (explicitUrl === undefined) return observedRepo === expectedRepo

  const explicitRepo = normalizeGitHubRemote(explicitUrl, githubHosts)
  if (explicitRepo !== null) return explicitRepo === expectedRepo && observedRepo === expectedRepo

  return observedRepo === null && comparableExplicitRemote(observedUrl) === comparableExplicitRemote(explicitUrl)
}

/** true if one of the two paths is (or contains) the other — the relation to forbid between repository and worktree. */
export function isNested(a: string, b: string): boolean {
  const ra = path.resolve(a)
  const rb = path.resolve(b)
  if (ra === rb) return true
  const contains = (parent: string, child: string): boolean => {
    const rel = path.relative(parent, child)
    return rel !== '' && !rel.startsWith('..') && !path.isAbsolute(rel)
  }

  return contains(ra, rb) || contains(rb, ra)
}

/** Observed state of the two managed paths (existence + whether they are git checkouts). */
export interface WorkspaceState {
  repoExists: boolean
  repoIsGit: boolean
  worktreeExists: boolean
  worktreeIsGit: boolean
}

export type RepoAction = 'clone' | 'reuse'
export type WorktreeAction = 'add' | 'reuse'

export interface WorkspacePlan {
  repoAction: RepoAction
  worktreeAction: WorktreeAction
}

/**
 * Decides the plan from the observed state: clones the repo if missing / reuses if already a checkout; adds the worktree
 * if missing / reuses if already present. A path OCCUPIED by something that is not a git checkout is an error: it
 * is not overwritten (it could contain the operator's work). Pure and deterministic.
 */
export function planWorkspace(state: WorkspaceState): WorkspacePlan {
  if (state.repoExists && !state.repoIsGit) {
    throw new AutomatorError(ErrorCodes.Workspace.occupied, 'Il path del repository è occupato da una directory non-git: non la sovrascrivo', 1)
  }

  if (state.worktreeExists && !state.worktreeIsGit) {
    throw new AutomatorError(ErrorCodes.Workspace.occupied, 'Il path del worktree è occupato da una directory non-git: non la sovrascrivo', 1)
  }

  return {
    repoAction: state.repoExists ? 'reuse' : 'clone',
    worktreeAction: state.worktreeExists ? 'reuse' : 'add',
  }
}

// git/fs probes: isolated behind an interface to test the orchestration with a fake git (or with real
// git on temporary local repos). Every mutating method (clone/addWorktree) throws on failure.
export interface WorkspaceGit {
  /** Absolute path of `gh` for the credential helper, null when missing; `resolveGhBinary` when not given. */
  ghBinary?(): string | null
  exists(p: string): boolean
  isGitCheckout(p: string): boolean
  clone(url: string, dest: string): void
  hasBranch(repoDir: string, branch: string): boolean
  /** Updates the remote-tracking refs. Does not touch worktrees, index or local branches. */
  fetchOrigin(repoDir: string): void
  /** Default branch of the remote in the form `origin/<name>`; null if not resolvable. */
  defaultRemoteBranch(repoDir: string): string | null
  addWorktree(repoDir: string, worktreeDir: string, branch: string, createBranch: boolean, startPoint?: string): void
  /** Raw origin URL; null if missing/not queryable. */
  remoteUrl(checkoutDir: string): string | null
  /** Authoritative registration of worktreeDir in the expected repository. */
  worktreeInfo(repoDir: string, worktreeDir: string): {branch: string | null; detached: boolean} | null
  /** Current symbolic branch; null for detached HEAD or error. */
  currentBranch(worktreeDir: string): string | null
  /**
   * Writes a key in the repository's LOCAL config (`.git/config`). Used for the settings that
   * must survive into the agent session, where `GIT_CONFIG_GLOBAL` is emptied (executor.ts) and
   * `~/.gitconfig` is therefore invisible: the local config is the only one git still reads.
   */
  setLocalConfig(repoDir: string, key: string, value: string): void
  /** Value of a key in the local config, or null if missing. */
  localConfig(repoDir: string, key: string): string | null
  /**
   * Writes/updates the managed ignore block in the repository's `.git/info/exclude` (local to the gitdir,
   * NEVER the tracked `.gitignore` of the target repo). Idempotent. Prevents the output of a dependency-install
   * that ended up in the worktree (bundle/npm/pip…) from being staged by `git add`/`git add -A` (CYAU-142). It also applies to
   * the worktrees because `info/exclude` lives in the repository's COMMON gitdir.
   */
  ensureManagedIgnore(repoDir: string): void
}

export interface PrepareInput {
  fullName: string // owner/repo
  projectKey: string
  ticket: string
  url?: string // explicit clone URL (default: cloneUrl(fullName))
  branch?: string // worktree branch (default: ticketBranch(ticket))
  reposBase?: string // override of the repositories base (test)
  worktreesBase?: string // override of the worktrees base (test)
  githubHosts?: ReadonlySet<string> // already resolved GitHub SSH aliases (test/integration)
}

export interface PrepareResult {
  repoPath: string
  worktreePath: string
  branch: string
  repoAction: RepoAction
  worktreeAction: WorktreeAction
}

/** Inspects and validates what would be reused, without creating, resetting or cleaning any path. */
export function inspectWorkspace(input: PrepareInput, git: WorkspaceGit = defaultWorkspaceGit()): PrepareResult {
  const repoPath = repositoryPath(input.fullName, input.reposBase)
  const wtPath = worktreePath(input.projectKey, input.ticket, input.worktreesBase)
  const branch = input.branch ?? ticketBranch(input.ticket)

  if (isNested(repoPath, wtPath)) {
    throw new AutomatorError(ErrorCodes.Workspace.nested, `Worktree e repository si annidano (${wtPath} vs ${repoPath}): layout non valido`, 1)
  }

  const plan = planWorkspace({
    repoExists: git.exists(repoPath),
    repoIsGit: git.isGitCheckout(repoPath),
    worktreeExists: git.exists(wtPath),
    worktreeIsGit: git.isGitCheckout(wtPath),
  })

  if (plan.repoAction === 'reuse') {
    const remote = git.remoteUrl(repoPath)
    const aliases = input.githubHosts ?? readGitHubAliases()
    if (remote === null || !remoteMatches(remote, input.fullName, input.url, aliases)) {
      throw new AutomatorError(
        ErrorCodes.Workspace.mismatch,
        `Il checkout esistente in ${repoPath} non appartiene al repository atteso ${input.fullName}: riuso rifiutato`,
        1,
      )
    }
  }

  if (plan.worktreeAction === 'reuse') {
    const registered = git.worktreeInfo(repoPath, wtPath)
    const current = git.currentBranch(wtPath)
    if (registered === null || registered.detached || registered.branch !== branch || current !== branch) {
      throw new AutomatorError(
        ErrorCodes.Workspace.mismatch,
        `Il checkout esistente in ${wtPath} non è il worktree del branch atteso ${branch}: riuso rifiutato`,
        1,
      )
    }
  }

  return {repoPath, worktreePath: wtPath, branch, repoAction: plan.repoAction, worktreeAction: plan.worktreeAction}
}

/**
 * Prepares (idempotently) the managed checkout and the isolated worktree for a ticket. Clones the repo only if
 * missing, adds the worktree only if missing; otherwise reuses. Never deletes anything. Rejects layouts in
 * which worktree and repository nest. Returns the ready paths and what was done.
 */
export function prepareWorkspace(input: PrepareInput, git: WorkspaceGit = defaultWorkspaceGit()): PrepareResult {
  const inspected = inspectWorkspace(input, git)
  const {repoPath, worktreePath: wtPath, branch} = inspected

  if (inspected.repoAction === 'clone') git.clone(input.url ?? cloneUrl(input.fullName), repoPath)
  if (inspected.worktreeAction === 'add') createTicketWorktree(repoPath, wtPath, branch, git)
  ensurePushableRepo(repoPath, git)
  // The output of a dependency-install must never be stageable (CYAU-142): managed ignore in the gitdir,
  // always (re)applied — idempotent, additive, never destructive — so a repo cloned before the fix receives it on reuse.
  git.ensureManagedIgnore(repoPath)

  return inspected
}

/**
 * The ticket branch starts from the REMOTE default branch, updated now.
 *
 * `git worktree add -b <branch> <dir>` without a starting point uses the repository HEAD, which in the reference
 * clone is the LOCAL `main` — and nobody advances that one. There was not even a fetch in
 * here: the remote-tracking refs were updated only by chance, when someone else fetched inside
 * a session. On a project that releases several times a day the copy slides behind by itself: at the
 * time of discovery the local `main` was four days and 165 commits behind the real one, and
 * realigning it by hand is not enough — after a single release it is already behind again.
 *
 * What it implies: the assistant decides looking at an old snapshot. It does not see the work done in the
 * meantime, it may redo it, and the comparison of its proposal with the main branch becomes unreadable
 * (445 files and 16,891 deletions for a piece of work that changed 4). The final release stays correct,
 * because the merge is built on `origin/main`: the damage is all upstream, in the context.
 *
 * Fail-closed on the default branch: without it, we would silently fall back to exactly the behaviour that
 * this function exists to remove. The fetch instead is tolerant: if the network does not answer, falling back
 * to slightly old remote-tracking refs is still vastly better than the local `main`, and blocking every
 * piece of work for a blip would be worse than the disease.
 */
function createTicketWorktree(repoPath: string, wtPath: string, branch: string, git: WorkspaceGit): void {
  const createBranch = !git.hasBranch(repoPath, branch)
  if (!createBranch) {
    // The branch already exists (resumed work): it is reused as is, the starting point does not apply.
    git.addWorktree(repoPath, wtPath, branch, false)
    return
  }

  try {
    git.fetchOrigin(repoPath)
  } catch {
    // Deliberately swallowed: continue with the remote-tracking refs already present (see above).
  }

  const startPoint = git.defaultRemoteBranch(repoPath)
  if (!startPoint) {
    throw new AutomatorError(
      ErrorCodes.Workspace.gitFailed,
      `Branch di default del remoto non risolvibile in ${repoPath}: il branch del ticket nascerebbe da un HEAD arbitrario`,
      1,
    )
  }

  git.addWorktree(repoPath, wtPath, branch, true, startPoint)
}

/**
 * The credential helper and the HTTP buffer in the LOCAL config of the managed repository.
 *
 * Why the global config is not enough: the executor empties `GIT_CONFIG_GLOBAL` in agent sessions
 * (`DANGEROUS_ENV`), so `~/.gitconfig` — where `gh auth setup-git` writes its helper — is invisible
 * in there. The agent implemented, committed and then could not publish: "git push has no working
 * credential", with the delivery lost and the ticket put back in the queue to redo everything. The local config is the only one
 * git still reads, and it is written HERE, outside the sandbox, where the credentials are already in place.
 *
 * It is not a loosening of the isolation: the session gains no access to `~/.gitconfig` nor to other
 * operator secrets — only the repository that must publish knows how to authenticate, for its own host.
 *
 * `http.postBuffer` at 512 MB fixes `unable to rewind rpc post data` / `RPC failed` on large pushes:
 * on a branch with many objects the push failed halfway, and the work stayed unpublished.
 *
 * Idempotent: it does not rewrite a value already present, so a different choice made by hand survives.
 */
const PUSH_CONFIG: ReadonlyArray<readonly [string, (git: WorkspaceGit) => string | null]> = [
  ['credential.https://github.com.helper', (git) => {
    const gh = git.ghBinary ? git.ghBinary() : resolveGhBinary()
    return gh ? `!${gh} auth git-credential` : null
  }],
  ['http.postBuffer', () => String(512 * 1024 * 1024)],
]

/**
 * ABSOLUTE and real path of `gh`. The agent session PATH does not contain the shim dir, so a helper
 * written as `!gh auth git-credential` dies with `gh: not found` and git falls back to "could not read Username"
 * — indistinguishable from a missing credential. The path is resolved HERE, outside the sandbox, where `gh` exists.
 *
 * `realpath` is not enough with mise: its shims are symlinks to the mise binary itself, so following
 * them wrote `!mise auth git-credential`, a helper that answers nothing. When the link does not end
 * in `gh`, mise is asked for the installed binary; if that fails too, null (no helper beats a broken one).
 */
export function resolveGhBinary(spawn: typeof spawnSync = spawnSync): string | null {
  const which = spawn('sh', ['-lc', 'command -v gh'], {encoding: 'utf8'})
  const found = (which.stdout ?? '').trim()
  if (which.status !== 0 || found.length === 0) return null
  const real = spawn('readlink', ['-f', found], {encoding: 'utf8'})
  const resolved = (real.stdout ?? '').trim() || found
  if (path.basename(resolved) === 'gh') return resolved
  const viaMise = spawn('mise', ['which', 'gh'], {encoding: 'utf8'})
  const installed = (viaMise.stdout ?? '').trim()
  return viaMise.status === 0 && path.basename(installed) === 'gh' ? installed : null
}

// The helper older releases wrote by following the mise shim (see resolveGhBinary): ours, and broken.
const BROKEN_MISE_HELPER = /^!\S*\/mise auth git-credential$/

function ensurePushableRepo(repoPath: string, git: WorkspaceGit): void {
  for (const [key, compute] of PUSH_CONFIG) {
    const current = git.localConfig(repoPath, key)
    if (current !== null && !BROKEN_MISE_HELPER.test(current)) continue
    const value = compute(git)
    // `gh` unresolvable: leave the repository as is instead of writing a broken helper, which
    // would mask the failure behind a missing-credentials error.
    if (value !== null) git.setLocalConfig(repoPath, key, value)
  }
}

/**
 * Output patterns of dependency-installs that must NEVER end up in a commit (CYAU-142).
 *
 * A piece of work ran a `bundle install` with a path inside the worktree and staged 15,608 files /
 * 372 MB: removing them afterwards is not enough — the blobs stay in the history and the push drops halfway through the transfer,
 * repeatedly. These patterns live in the managed repository's `.git/info/exclude`, so `git add`/
 * `git add -A` no longer stages them.
 *
 * ONLY unambiguous tool-output names, NEVER directories that a real project could version as
 * source: generic names (`/gems/`, `/specifications/`, `/extensions/`, `/cache/`) are avoided because
 * `info/exclude` ignores every UNTRACKED file under a matching name — a legitimate new file inside an
 * already versioned directory with the same name would disappear from `git add -A`. The non-idiomatic bundler layout (gems at the root)
 * and any other abnormal output stay covered by the changeset gate at commit (§Delivery, CYAU-142).
 * `info/exclude` applies to all the worktrees (common gitdir) and never touches the target's tracked `.gitignore`.
 */
const MANAGED_IGNORE_PATTERNS: readonly string[] = [
  '/.bundle/',
  '/vendor/bundle/',
  '/.yardoc/',
  '*.gem',
  'node_modules/',
  '/.venv/',
  '__pycache__/',
]
const MANAGED_IGNORE_BEGIN = '# >>> closeyourit-automator (CYAU-142) — dependency install output, non committare >>>'
const MANAGED_IGNORE_END = '# <<< closeyourit-automator (CYAU-142) <<<'

/**
 * Composes the content of `info/exclude` with the managed block, PRESERVING what the user wrote BEFORE
 * the marker. Idempotent: an already identical block → `changed:false`. Robust to corrupt/duplicate markers:
 * replaces from the FIRST start marker to the LAST end marker (or to end of file if it is missing entirely),
 * so a truncated block neither accumulates a second marker nor, on the later repair, swallows the lines
 * between the two (bug observed in review). The managed zone hosts no user rules: those go before
 * the marker and stay intact. Pure → merge testable without a filesystem.
 */
export function composeManagedIgnore(existing: string | null): {content: string; changed: boolean} {
  const block = [MANAGED_IGNORE_BEGIN, ...MANAGED_IGNORE_PATTERNS, MANAGED_IGNORE_END].join('\n')
  const current = existing ?? ''
  const begin = current.indexOf(MANAGED_IGNORE_BEGIN)
  if (begin >= 0) {
    const lastEnd = current.lastIndexOf(MANAGED_IGNORE_END)
    const cut = lastEnd >= begin ? lastEnd + MANAGED_IGNORE_END.length : current.length
    let rebuilt = `${current.slice(0, begin)}${block}${current.slice(cut)}`
    if (!rebuilt.endsWith('\n')) rebuilt += '\n'
    return {content: rebuilt, changed: rebuilt !== current}
  }
  if (current === '') return {content: `${block}\n`, changed: true}
  return {content: `${current}${current.endsWith('\n') ? '' : '\n'}${block}\n`, changed: true}
}

/**
 * The test seam: the shape of `spawnSync` reduced to what is needed here. Injecting it allows verifying
 * that every command starts with a time cap and without interactive prompts, without touching the real network.
 */
export type GitSpawnSync = (
  file: string,
  args: string[],
  options: {encoding: 'utf8'; env: NodeJS.ProcessEnv; timeout: number},
) => {status: number | null; stderr: string | null; stdout: string | null}

/**
 * These commands are SYNCHRONOUS and some (clone, fetchOrigin, defaultRemoteBranch) talk to the network inside
 * the daemon beat: without a cap, a remote that accepts the connection and then goes silent also stops heartbeat
 * and lease renewal, forever. The timeout kills the process and the caller sees a failed command, which
 * it handles as it already handles errors.
 */
const GIT_TIMEOUT_MS = 120_000

/** `GIT_TERMINAL_PROMPT=0`: without credentials git fails immediately instead of waiting for a password nobody will type. */
function gitEnvironment(): NodeJS.ProcessEnv {
  return {...process.env, GIT_TERMINAL_PROMPT: '0'}
}

function parseWorktreeInfo(raw: string, expectedPath: string): {branch: string | null; detached: boolean} | null {
  const canonicalExpected = fs.realpathSync(expectedPath)
  for (const record of raw.split('\0\0')) {
    const fields = record.split('\0')
    const worktree = fields.find((field) => field.startsWith('worktree '))?.slice('worktree '.length)
    if (worktree === undefined) continue
    let canonicalWorktree: string
    try {
      canonicalWorktree = fs.realpathSync(worktree)
    } catch {
      continue
    }
    if (canonicalWorktree !== canonicalExpected) continue
    const branchRef = fields.find((field) => field.startsWith('branch '))?.slice('branch '.length) ?? null
    return {
      branch: branchRef?.startsWith('refs/heads/') ? branchRef.slice('refs/heads/'.length) : null,
      detached: fields.includes('detached') || branchRef === null,
    }
  }
  return null
}

/**
 * Real git/fs probes (node:fs + git via spawnSync, argv array = no shell). A checkout is one if it has
 * `.git` (a directory in the clone, a file in worktrees). clone/addWorktree create the parent dirs and throw
 * `AutomatorError` on failure (git stderr in the message).
 */
export function defaultWorkspaceGit(
  spawn: GitSpawnSync = spawnSync as unknown as GitSpawnSync,
  timeoutMs: number = GIT_TIMEOUT_MS,
): WorkspaceGit {
  const runGit = (args: string[]): {ok: boolean; stdout: string; stderr: string} => {
    const res = spawn('git', args, {encoding: 'utf8', env: gitEnvironment(), timeout: timeoutMs})
    return {ok: res.status === 0, stdout: res.stdout ?? '', stderr: res.stderr ?? ''}
  }

  return {
    exists(p) {
      return fs.existsSync(p)
    },
    isGitCheckout(p) {
      // `.git` is a directory in a clone, a file in a worktree: both count as a checkout.
      return fs.existsSync(path.join(p, '.git'))
    },
    clone(url, dest) {
      fs.mkdirSync(path.dirname(dest), {recursive: true})
      // `--` separates the options from the operands: a url/dest starting with `-` is NEVER taken for a flag.
      const r = runGit(['clone', '--', url, dest])
      if (!r.ok) throw new AutomatorError(ErrorCodes.Workspace.gitFailed, `git clone fallito: ${r.stderr.trim() || url}`, 1)
    },
    hasBranch(repoDir, branch) {
      // The ref is namespaced (`refs/heads/…`) → never interpretable as an option even with anomalous branches.
      return runGit(['-C', repoDir, 'rev-parse', '--verify', '--quiet', `refs/heads/${branch}`]).ok
    },
    fetchOrigin(repoDir) {
      // Only refs and objects: worktrees, index and local branches stay intact.
      const r = runGit(['-C', repoDir, 'fetch', 'origin', '--tags', '--prune'])
      if (!r.ok) throw new AutomatorError(ErrorCodes.Workspace.gitFailed, `git fetch fallito: ${r.stderr.trim()}`, 1)
    },
    defaultRemoteBranch(repoDir) {
      // `refs/remotes/origin/HEAD` is written by `git clone`; if missing (old clone, or removed by a
      // prune) it is rebuilt by querying the remote once, instead of guessing "main".
      const read = () => runGit(['-C', repoDir, 'symbolic-ref', '--short', 'refs/remotes/origin/HEAD'])
      let r = read()
      if (!r.ok) {
        runGit(['-C', repoDir, 'remote', 'set-head', 'origin', '--auto'])
        r = read()
      }
      const ref = r.ok ? r.stdout.trim() : ''
      return ref === '' ? null : ref
    },
    addWorktree(repoDir, worktreeDir, branch, createBranch, startPoint) {
      fs.mkdirSync(path.dirname(worktreeDir), {recursive: true})
      // `--` isolates the path (and the commit-ish) from the options; `-b <branch>` stays before the separator.
      // The starting point follows the path, as in the signature `git worktree add <path> [<commit-ish>]`.
      const args = createBranch
        ? ['-C', repoDir, 'worktree', 'add', '-b', branch, '--', worktreeDir, ...(startPoint ? [startPoint] : [])]
        : ['-C', repoDir, 'worktree', 'add', '--', worktreeDir, branch]
      const r = runGit(args)
      if (!r.ok) throw new AutomatorError(ErrorCodes.Workspace.gitFailed, `git worktree add fallito: ${r.stderr.trim() || branch}`, 1)
    },
    remoteUrl(checkoutDir) {
      const result = runGit(['-C', checkoutDir, 'remote', 'get-url', 'origin'])
      const remote = result.stdout.trim()
      return result.ok && remote.length > 0 ? remote : null
    },
    worktreeInfo(repoDir, worktreeDir) {
      const result = runGit(['-C', repoDir, 'worktree', 'list', '--porcelain', '-z'])
      return result.ok ? parseWorktreeInfo(result.stdout, worktreeDir) : null
    },
    currentBranch(worktreeDir) {
      const result = runGit(['-C', worktreeDir, 'symbolic-ref', '--quiet', '--short', 'HEAD'])
      const branch = result.stdout.trim()
      return result.ok && branch.length > 0 ? branch : null
    },
    setLocalConfig(repoDir, key, value) {
      runGit(['-C', repoDir, 'config', '--local', key, value])
    },
    localConfig(repoDir, key) {
      const result = runGit(['-C', repoDir, 'config', '--local', '--get', key])
      const value = result.stdout.trim()
      return result.ok && value.length > 0 ? value : null
    },
    ensureManagedIgnore(repoDir) {
      // `rev-parse --git-path info/exclude` resolves the correct path even for non-standard layouts; for a
      // clone it is `<repoDir>/.git/info/exclude`, common to all worktrees. Best-effort like `fetchOrigin`: a
      // non-queryable repo must not make the preparation fail (prepareWorkspace would already fail elsewhere).
      const resolved = runGit(['-C', repoDir, 'rev-parse', '--git-path', 'info/exclude'])
      if (!resolved.ok) return
      const raw = resolved.stdout.trim()
      if (raw === '') return
      const excludePath = path.isAbsolute(raw) ? raw : path.join(repoDir, raw)
      let existing: string | null = null
      try {
        existing = fs.readFileSync(excludePath, 'utf8')
      } catch {
        existing = null
      }
      const {content, changed} = composeManagedIgnore(existing)
      if (!changed) return
      const dir = path.dirname(excludePath)
      fs.mkdirSync(dir, {recursive: true})
      // Atomic write (unique temp + rename): an interruption halfway never leaves a truncated `info/exclude`
      // — which on the next repair would risk swallowing the user rules between the markers.
      const tmp = path.join(dir, `.exclude.${process.pid}.${randomUUID()}.tmp`)
      try {
        fs.writeFileSync(tmp, content)
        fs.renameSync(tmp, excludePath)
      } finally {
        fs.rmSync(tmp, {force: true})
      }
    },
  }
}
