import {spawnSync} from 'node:child_process'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import {cloneUrl, isSafeSegment, splitRepo} from './workspace'
import {AutomatorError, ErrorCodes} from '../errors/error-codes'

// Workspace replication from a server MANIFEST (CYAU OneClick), twin of workspace.ts. The server exposes the
// canonical list of repositories a worker machine must have locally (host-scoped, host credential
// `cyi_ah_`); the automator fetches it and clones/updates every repo under a workspace root, WITHOUT ever destroying
// unintegrated work. Pure with respect to git/fs: every command lives behind `ReplicationGit`, injectable in tests.
//
// Server contract (GET /api/v1/agent_host/workspace_manifest):
//   { data: { version, digest, workspace_root_hint, repositories: [{ project_key, path, repo, default_branch, group? }] } }
// `path` is relative to the workspace root; `repo` is `owner/name`; `default_branch` the default branch.

/** A repository as described by the manifest: where it goes (relative path) and where to clone it from (owner/name). */
export interface WorkspaceManifestRepository {
  project_key: string
  path: string // relative to the workspace root (e.g. apps/closeyourit/closeyourit-rails)
  repo: string // owner/name
  default_branch: string
  group?: string
}

/** Workspace manifest: version, digest and the list of repositories with the root hint. */
export interface WorkspaceManifest {
  version: number
  digest: string
  workspace_root_hint: string // relative to $HOME (e.g. Lavoro/Github/Personale)
  repositories: WorkspaceManifestRepository[]
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** Normalizes a raw manifest repository: non-empty `path`/`repo`/`default_branch` are the minimal identity. */
function coerceRepository(raw: unknown): WorkspaceManifestRepository | null {
  if (!isRecord(raw)) return null
  const repoPath = raw.path
  const repo = raw.repo
  const defaultBranch = raw.default_branch
  if (typeof repoPath !== 'string' || repoPath.trim() === '') return null
  if (typeof repo !== 'string' || repo.trim() === '') return null
  if (typeof defaultBranch !== 'string' || defaultBranch.trim() === '') return null
  return {
    project_key: typeof raw.project_key === 'string' ? raw.project_key : '',
    path: repoPath,
    repo,
    default_branch: defaultBranch,
    ...(typeof raw.group === 'string' ? {group: raw.group} : {}),
  }
}

/**
 * TOLERANT manifest parsing (untrusted input from the server, like `readState`/`parseLease`): unexpected
 * shape → `null`; malformed entries are discarded one by one (granular degradation). Accepts both
 * the `{data:{...}}` envelope and the direct manifest object. `version`/`digest`/`workspace_root_hint`
 * degrade to defaults if missing; `repositories` must be an array (otherwise the manifest is unusable).
 */
export function parseWorkspaceManifest(input: unknown): WorkspaceManifest | null {
  if (!isRecord(input)) return null
  // Envelope: if `repositories` is missing at the top level but `data` is an object, go down one level (server shape).
  const root = 'repositories' in input ? input : isRecord(input.data) ? input.data : input
  if (!Array.isArray(root.repositories)) return null

  const repositories: WorkspaceManifestRepository[] = []
  for (const raw of root.repositories) {
    const entry = coerceRepository(raw)
    if (entry) repositories.push(entry)
  }

  return {
    version: typeof root.version === 'number' ? root.version : 1,
    digest: typeof root.digest === 'string' ? root.digest : '',
    workspace_root_hint: typeof root.workspace_root_hint === 'string' ? root.workspace_root_hint : '',
    repositories,
  }
}

/** Host-scoped client that exposes the manifest; injectable in tests. */
export interface WorkspaceManifestClient {
  getWorkspaceManifest(): Promise<WorkspaceManifest | null> // null = network/HTTP error or unparsable manifest
}

/** Fetches the manifest via the HOST credential. Best-effort: `null` on error. */
export function fetchWorkspaceManifest(client: WorkspaceManifestClient): Promise<WorkspaceManifest | null> {
  return client.getWorkspaceManifest()
}

/**
 * true if `relPath` is a safe relative path under the workspace root: non-empty, not absolute, every segment
 * safe (reuses `isSafeSegment`) and never `.git`. Defence in depth against path traversal: dest =
 * join(root, relPath) can never climb above the root nor enter a gitdir.
 */
export function isSafeRelativePath(relPath: string): boolean {
  if (relPath.trim() === '' || path.isAbsolute(relPath)) return false
  return relPath.split(/[/\\]/).every((seg) => isSafeSegment(seg) && seg !== '.git')
}

/**
 * Resolves the workspace root: explicit override from the secret (absolute), otherwise `hint` (relative) under
 * `home`. An empty hint or one with traversal/absolute is ignored → fallback to `home` (never a root outside $HOME
 * for a hostile manifest). The override instead is a local operator choice and is authoritative.
 */
export function resolveWorkspaceRoot(override: string | undefined, hint: string, home: string = os.homedir()): string {
  const trimmedOverride = override?.trim()
  if (trimmedOverride) return path.resolve(trimmedOverride)
  const trimmedHint = (hint ?? '').trim()
  if (!trimmedHint || !isSafeRelativePath(trimmedHint)) return path.resolve(home)
  return path.resolve(home, trimmedHint)
}

/** A resolved replication target: where to clone/update a repo and on which default branch. */
export interface ReplicationEntry {
  projectKey: string
  repo: string // owner/name (validated)
  dest: string // absolute path under the workspace root
  branch: string
}

/** A repository discarded by the planning (unsafe path or owner/repo), with the code and the reason. */
export interface RejectedRepository {
  repo: string
  path: string
  reason: string // ErrorCodes.Manifest.invalidPath
  detail: string
}

export interface ReplicationPlan {
  workspaceRoot: string
  entries: ReplicationEntry[]
  rejected: RejectedRepository[]
}

/**
 * PURE, deterministic plan: for every repo → `{dest: <root>/<path>, repo, branch}`. Validates the `path`
 * segments (never traversal under the root) and the `owner/repo` (it ends up in gh/git clone) — an unsafe entry is
 * DISCARDED with `C400-MANIFEST-001` (best-effort per repo, does not block the others), like the defences of workspace.ts.
 */
export function planWorkspaceReplication(manifest: WorkspaceManifest, workspaceRoot: string): ReplicationPlan {
  const entries: ReplicationEntry[] = []
  const rejected: RejectedRepository[] = []

  for (const repo of manifest.repositories) {
    if (!isSafeRelativePath(repo.path)) {
      rejected.push({repo: repo.repo, path: repo.path, reason: ErrorCodes.Manifest.invalidPath, detail: `path non sicuro (traversal): "${repo.path}"`})
      continue
    }

    try {
      splitRepo(repo.repo) // validates owner/repo as two safe segments; throws otherwise
    } catch {
      rejected.push({repo: repo.repo, path: repo.path, reason: ErrorCodes.Manifest.invalidPath, detail: `repo non valido (atteso owner/repo sicuro): "${repo.repo}"`})
      continue
    }

    entries.push({projectKey: repo.project_key, repo: repo.repo, dest: path.join(workspaceRoot, repo.path), branch: repo.default_branch})
  }

  return {workspaceRoot, entries, rejected}
}

// Injectable git/fs probes: they isolate the orchestration (clone if missing / fetch+pull if present) from real git.
// Every mutating method (clone/fetch) throws on failure → the orchestrator catches it and continues (best-effort).
export interface ReplicationGit {
  exists(p: string): boolean
  isGitCheckout(p: string): boolean
  clone(repo: string, dest: string): void // owner/name → gh repo clone or git clone https
  fetch(dest: string): void // updates the remote-tracking refs
  /** pull --ff-only: `true` if it fast-forwarded, `false` if diverged/dirty (never loses local work). */
  pullFastForward(dest: string): boolean
}

export type ReplicationAction = 'cloned' | 'updated' | 'occupied' | 'failed'

export interface ReplicationOutcome {
  projectKey: string
  repo: string
  dest: string
  branch: string
  action: ReplicationAction
  ok: boolean
  detail: string
}

export interface ReplicationReport {
  workspaceRoot: string
  outcomes: ReplicationOutcome[]
  rejected: RejectedRepository[]
  cloned: number
  updated: number
  failed: number
}

function replicateOne(entry: ReplicationEntry, git: ReplicationGit): ReplicationOutcome {
  const base = {projectKey: entry.projectKey, repo: entry.repo, dest: entry.dest, branch: entry.branch}
  try {
    if (!git.exists(entry.dest)) {
      git.clone(entry.repo, entry.dest)
      return {...base, action: 'cloned', ok: true, detail: 'clonato'}
    }

    // Path taken by something that is NOT a git checkout: do not overwrite (it could be local work).
    if (!git.isGitCheckout(entry.dest)) {
      return {...base, action: 'occupied', ok: false, detail: `${ErrorCodes.Manifest.occupied}: path occupato da una directory non-git`}
    }

    git.fetch(entry.dest)
    const fastForwarded = git.pullFastForward(entry.dest)
    return {
      ...base,
      action: 'updated',
      ok: true,
      detail: fastForwarded ? 'aggiornato (fast-forward)' : 'ref aggiornati (nessun fast-forward: divergente/dirty, preservato)',
    }
  } catch (error) {
    const code = error instanceof AutomatorError ? error.code : ErrorCodes.Manifest.gitFailed
    return {...base, action: 'failed', ok: false, detail: `${code}: ${(error as Error).message}`}
  }
}

/**
 * Replicates the workspace behind the injectable `ReplicationGit` probe: clones the missing repos, updates the
 * present ones (fetch + pull --ff-only). IDEMPOTENT and best-effort per repo — the failure of one repo (failed clone/
 * fetch, taken path) is recorded and does NOT block the others. Never reset/clean/remove → does not delete
 * unintegrated work. Returns an auditable report with the outcomes + the plan's discarded entries.
 */
export function replicateWorkspace(plan: ReplicationPlan, git: ReplicationGit = defaultReplicationGit()): ReplicationReport {
  const outcomes = plan.entries.map((entry) => replicateOne(entry, git))
  return {
    workspaceRoot: plan.workspaceRoot,
    outcomes,
    rejected: plan.rejected,
    cloned: outcomes.filter((o) => o.action === 'cloned').length,
    updated: outcomes.filter((o) => o.action === 'updated').length,
    failed: outcomes.filter((o) => !o.ok).length,
  }
}

/** Injectable probes of the whole replication: fetch the manifest, resolve the root, plan and replicate. */
export interface ReplicateFromManifestDeps {
  client: WorkspaceManifestClient | null // null = host not registered → no replication possible
  workspaceRootOverride?: string // root override from the secret
  home?: string // $HOME (injectable in tests)
  git?: ReplicationGit // git probe (injectable in tests)
}

/**
 * End-to-end orchestration of the replication (used by OneClick's `workspace` stage): missing client or
 * unretrievable manifest → `null` (the stage degrades); otherwise resolves the workspace root (secret
 * override or hint under $HOME) and replicates under it. It is the testable counterpart of the command wiring.
 */
export async function replicateFromManifest(deps: ReplicateFromManifestDeps): Promise<ReplicationReport | null> {
  if (!deps.client) return null
  const manifest = await fetchWorkspaceManifest(deps.client)
  if (manifest === null) return null
  const root = resolveWorkspaceRoot(deps.workspaceRootOverride, manifest.workspace_root_hint, deps.home)
  return replicateWorkspace(planWorkspaceReplication(manifest, root), deps.git)
}

function runGit(args: string[]): {ok: boolean; stderr: string} {
  const res = spawnSync('git', args, {encoding: 'utf8'})
  return {ok: res.status === 0, stderr: res.stderr ?? ''}
}

/**
 * Real git/fs probes (node:fs + git/gh via spawnSync, argv array = no shell). The clone first tries `gh
 * repo clone` (uses the authenticated gh session, also for private repos), then `git clone https` as fallback.
 * clone/fetch throw `AutomatorError` (`C502-MANIFEST-003`) on failure; pull --ff-only is best-effort.
 */
export function defaultReplicationGit(): ReplicationGit {
  return {
    exists(p) {
      return fs.existsSync(p)
    },
    isGitCheckout(p) {
      return fs.existsSync(path.join(p, '.git'))
    },
    clone(repo, dest) {
      fs.mkdirSync(path.dirname(dest), {recursive: true})
      const gh = spawnSync('gh', ['repo', 'clone', repo, dest], {encoding: 'utf8'})
      if (gh.status === 0) return
      // `--` isolates url/dest from the options: a value starting with `-` is never taken for a flag.
      const git = spawnSync('git', ['clone', '--', cloneUrl(repo), dest], {encoding: 'utf8'})
      if (git.status !== 0) {
        const reason = (git.stderr || gh.stderr || '').trim() || repo
        throw new AutomatorError(ErrorCodes.Manifest.gitFailed, `clone di ${repo} fallito: ${reason}`, 1)
      }
    },
    fetch(dest) {
      const r = runGit(['-C', dest, 'fetch', '--all', '--prune'])
      if (!r.ok) throw new AutomatorError(ErrorCodes.Manifest.gitFailed, `git fetch in ${dest} fallito: ${r.stderr.trim() || dest}`, 1)
    },
    pullFastForward(dest) {
      // --ff-only: never a merge commit and never lose local work (it just fails if not fast-forwardable).
      return runGit(['-C', dest, 'pull', '--ff-only']).ok
    },
  }
}
