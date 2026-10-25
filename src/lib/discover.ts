import {spawnSync} from 'node:child_process'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import {type HostEntry} from './config'
import {type WorkspaceManifest} from './workspace-manifest'

// Auto-detection of local checkouts from Git remotes (CYAU-10). CloseYourIt associates every project with a
// GitHub repo (full_name owner/repo, exposed by AgentSerializer as project_targets[].repo). The automator
// scans the checkouts on the machine, normalizes their remotes (SSH/HTTPS) and compares them with that map:
// UNIQUE matches are linked automatically in the host map; ambiguities (several checkouts
// for the same repo) and missing repositories (no checkout) are left to resolve by hand — never guessed.

const NO_EXTRA_HOSTS: ReadonlySet<string> = new Set()

/**
 * Canonicalizes a Git remote URL into lowercase `owner/repo`, or null if it is not a recognisable GitHub
 * remote. Handles scp-like SSH (`git@github.com:owner/repo.git`), URLs with a scheme
 * (`ssh://`, `https://`, `http://`, `git://`) with optional credentials/port, trailing `.git` and trailing
 * slash. The comparison is case-insensitive (owner/repo on GitHub are case-insensitive) → lowercase key.
 * Recognises github.com/www.github.com and the **SSH aliases** in `githubHosts` (from `~/.ssh/config`, e.g.
 * `git@github-personale:owner/repo.git` in multi-account setups); other hosts → null.
 */
export function normalizeGitHubRemote(url: string, githubHosts: ReadonlySet<string> = NO_EXTRA_HOSTS): string | null {
  const raw = url.trim()
  if (!raw) return null

  // Scheme://[user[:pass]@]host[:port]/owner/repo  — tried BEFORE scp so as not to mistake the scheme
  // (`https`) for an scp-like host (`https:...`).
  const withScheme = /^[a-z][a-z0-9+.-]*:\/\/(?:[^@/]+@)?([^/:]+)(?::\d+)?\/(.+)$/i
  // scp-like: [user@]host:owner/repo — no `//` after the colon.
  const scpLike = /^(?:[^@/]+@)?([^/:]+):(.+)$/

  let host: string
  let pathPart: string
  const schemeMatch = withScheme.exec(raw)
  if (schemeMatch) {
    ;[, host, pathPart] = schemeMatch
  } else {
    const scpMatch = scpLike.exec(raw)
    if (!scpMatch) return null
    ;[, host, pathPart] = scpMatch
  }

  if (!isGitHubHost(host, githubHosts)) return null

  const segments = pathPart
    .replace(/\.git$/i, '')
    .split('/')
    .filter(Boolean)
  if (segments.length < 2) return null
  return `${segments[0]}/${segments[1]}`.toLowerCase()
}

function isGitHubHost(host: string, githubHosts: ReadonlySet<string>): boolean {
  const h = host.toLowerCase()
  return h === 'github.com' || h === 'www.github.com' || githubHosts.has(h)
}

/**
 * SSH aliases pointing to github.com, read from `~/.ssh/config`. In multi-account setups the remote uses an
 * alias (`Host github-personale` → `HostName github.com`) instead of `github.com`: without this resolution
 * the real checkouts would be discarded and end up (wrongly) among the "missing" ones. Best-effort: missing/
 * unreadable file → no alias. Ignores patterns with wildcards/negation (`*`, `?`, `!`), which are not concrete
 * aliases, and `Match` blocks. `readConfig` is injectable in tests.
 */
export function readGitHubAliases(readConfig: () => string = defaultSshConfigReader): Set<string> {
  const aliases = new Set<string>()
  let text: string
  try {
    text = readConfig()
  } catch {
    return aliases
  }

  let patterns: string[] = []
  let pointsToGitHub = false
  const flush = (): void => {
    if (pointsToGitHub) for (const p of patterns) aliases.add(p.toLowerCase())
    patterns = []
    pointsToGitHub = false
  }

  for (const rawLine of text.split('\n')) {
    const line = rawLine.trim()
    if (!line || line.startsWith('#')) continue
    const [keywordRaw, ...rest] = line.split(/[=\s]+/)
    const keyword = keywordRaw.toLowerCase()
    if (keyword === 'host') {
      flush() // closes the previous block
      patterns = rest.filter((p) => !/[*?!]/.test(p) && p.toLowerCase() !== 'github.com')
    } else if (keyword === 'match') {
      flush() // a Match block ends the current Host block
    } else if (keyword === 'hostname' && rest[0]?.toLowerCase() === 'github.com') {
      pointsToGitHub = true
    }
  }

  flush() // last block at end of file
  return aliases
}

function defaultSshConfigReader(): string {
  return fs.readFileSync(path.join(os.homedir(), '.ssh', 'config'), 'utf8')
}

// Keys that, used as bracket properties on a plain object, would mutate the prototype instead of creating
// an own entry (`hosts[key] = …`). The project keys come from the server WITHOUT runtime validation →
// we discard them on input so they never reach the persisted host map.
const UNSAFE_KEYS: ReadonlySet<string> = new Set(['__proto__', 'prototype', 'constructor'])

function isUnsafeKey(key: string): boolean {
  return UNSAFE_KEYS.has(key)
}

// Extracts the project-key → repo map (lowercase owner/repo) from the host-scoped MANIFEST (CYAU-87): the server
// already lists only the repositories this host can work, so they no longer need to be deduced from the
// typed agents' targets. Skips entries without repo or key and keys unsafe for bracket assignment; the first
// one wins (dedup by key). The `repo` comes as owner/repo: lowercasing it is enough for the match.
export function collectRepoTargets(manifest: WorkspaceManifest): Map<string, string> {
  const targets = new Map<string, string>()
  for (const entry of manifest.repositories) {
    const key = entry.project_key.trim()
    if (key === '' || isUnsafeKey(key)) continue
    const repo = entry.repo.trim().toLowerCase()
    if (!repo) continue
    if (!targets.has(key)) targets.set(key, repo)
  }

  return targets
}

/** A local git checkout with its raw remotes (as printed by `git remote -v`). */
export interface Checkout {
  cwd: string
  remotes: string[]
}

/** Unique project ↔ checkout match: linkable automatically. */
export interface RepoMatch {
  projectKey: string
  repo: string
  cwd: string
}

/** Several checkouts for the same repo: no guessing, the user chooses. */
export interface RepoAmbiguity {
  projectKey: string
  repo: string
  cwds: string[]
}

/** No local checkout for the project's repo. */
export interface RepoMissing {
  projectKey: string
  repo: string
}

export interface MatchResult {
  matched: RepoMatch[]
  ambiguous: RepoAmbiguity[]
  missing: RepoMissing[]
}

// Compares the targets (project → repo) with the discovered checkouts. For every target it counts the checkouts whose
// set of normalized GitHub remotes contains that repo: 0 → missing, 1 → matched, ≥2 → ambiguous.
// `githubHosts` = SSH aliases to recognise besides github.com. Deterministic: targets sorted by key,
// ambiguous cwds sorted. Pure: no I/O.
export function matchCheckouts(
  targets: Map<string, string>,
  checkouts: Checkout[],
  githubHosts: ReadonlySet<string> = NO_EXTRA_HOSTS,
): MatchResult {
  const normalized = checkouts.map((checkout) => ({
    cwd: checkout.cwd,
    repos: new Set(checkout.remotes.map((r) => normalizeGitHubRemote(r, githubHosts)).filter((repo): repo is string => repo !== null)),
  }))

  const matched: RepoMatch[] = []
  const ambiguous: RepoAmbiguity[] = []
  const missing: RepoMissing[] = []

  for (const [projectKey, repo] of [...targets.entries()].sort(([a], [b]) => a.localeCompare(b))) {
    const cwds = [...new Set(normalized.filter((c) => c.repos.has(repo)).map((c) => c.cwd))].sort()
    if (cwds.length === 0) missing.push({projectKey, repo})
    else if (cwds.length === 1) matched.push({projectKey, repo, cwd: cwds[0]})
    else ambiguous.push({projectKey, repo, cwds})
  }

  return {matched, ambiguous, missing}
}

/** Directory entry reduced to the essentials for the scan (injectable in tests). */
export interface DirEntry {
  name: string
  isDir: boolean
}

// Scanner filesystem probes: isolated behind an interface to test the algorithm with a virtual fs.
export interface ScanFs {
  readDir: (dir: string) => DirEntry[]
  isCheckout: (dir: string) => boolean
  /** true if `dir` is a LINKED worktree (not the main checkout): it shares the parent repository's remotes. */
  isLinkedWorktree: (dir: string) => boolean
  readRemotes: (dir: string) => string[]
}

// Directories never traversed during the scan: inner `.git` and node_modules (noise + cost). Hidden
// dirs (`.something`, including `.claude/worktrees`) are skipped separately.
const SKIP_DIRS = new Set(['node_modules', '.git'])

/**
 * Scans the `roots` looking for git checkouts. A checkout stops the descent (nested worktrees or
 * submodules are not entered). Skips node_modules and hidden directories. `maxDepth` limits the depth (the
 * root is at depth 0). Deduplicates the checkouts by path. Pure with respect to the real filesystem: uses `fsDeps`.
 *
 * LINKED worktrees are traversed but never collected (CYAU-157): the convention puts them in a sibling folder
 * `<repo>.worktrees/<slug>`, visible to the scan, and a worktree exposes the same remotes as the parent
 * repository → it would be a second "checkout" of the same repo and would make AMBIGUOUS every project with an
 * open run. It is not even a valid location: it is the checkout of someone else's run, on a branch
 * that is not the starting one.
 */
export function scanCheckouts(roots: string[], fsDeps: ScanFs, maxDepth = 3): Checkout[] {
  const found = new Map<string, Checkout>()

  const visit = (dir: string, depth: number): void => {
    if (found.has(dir)) return
    if (fsDeps.isCheckout(dir)) {
      if (!fsDeps.isLinkedWorktree(dir)) found.set(dir, {cwd: dir, remotes: fsDeps.readRemotes(dir)})
      return
    }

    if (depth >= maxDepth) return
    for (const entry of fsDeps.readDir(dir)) {
      if (!entry.isDir || SKIP_DIRS.has(entry.name) || entry.name.startsWith('.')) continue
      visit(path.join(dir, entry.name), depth + 1)
    }
  }

  for (const root of roots) visit(root, 0)
  return [...found.values()]
}

export interface AutoLinkInput {
  targets: Map<string, string>
  checkouts: Checkout[]
  hosts: Record<string, HostEntry>
  githubHosts?: ReadonlySet<string> // SSH aliases → github.com (from readGitHubAliases); default none
}

export interface AutoLinkResult {
  matched: RepoMatch[]
  ambiguous: RepoAmbiguity[]
  missing: RepoMissing[]
  alreadyMapped: string[] // project keys already in the host map → left unchanged (respects the existing choice)
  hosts: Record<string, HostEntry> // host map updated with the new unique links
  changed: boolean
}

// Automatically links the unique matches NOT yet mapped. Projects already present in the
// host map stay unchanged (an existing choice is not overwritten): they end up in `alreadyMapped` and
// are excluded from matching. Pure: returns a NEW host map, does not mutate the input.
export function autoLink(input: AutoLinkInput): AutoLinkResult {
  const alreadyMapped: string[] = []
  const toResolve = new Map<string, string>()
  for (const [key, repo] of input.targets) {
    if (isUnsafeKey(key)) continue // defence: never a hostile key reaching the bracket assignment
    if (input.hosts[key]) alreadyMapped.push(key)
    else toResolve.set(key, repo)
  }

  const {matched, ambiguous, missing} = matchCheckouts(toResolve, input.checkouts, input.githubHosts)
  const hosts = {...input.hosts}
  for (const m of matched) hosts[m.projectKey] = {cwd: m.cwd}

  return {matched, ambiguous, missing, alreadyMapped: alreadyMapped.sort(), hosts, changed: matched.length > 0}
}

/**
 * Reads a checkout's remote URLs via `git -C <dir> remote -v` (dedup fetch/push). Arguments
 * passed as an array (no shell) and `dir` always comes from the filesystem scan. Any error
 * (git missing, non-repo dir) → no remote.
 */
export function readGitRemotes(dir: string): string[] {
  try {
    const res = spawnSync('git', ['-C', dir, 'remote', '-v'], {encoding: 'utf8'})
    if (res.status !== 0 || !res.stdout) return []
    const urls = new Set<string>()
    for (const line of res.stdout.split('\n')) {
      const parts = line.trim().split(/\s+/)
      if (parts.length >= 2) urls.add(parts[1])
    }

    return [...urls]
  } catch {
    return []
  }
}

/** Real filesystem probes for the scanner (node:fs + git). Every I/O is best-effort → error = empty result. */
export function defaultScanFs(): ScanFs {
  return {
    readDir(dir) {
      try {
        return fs.readdirSync(dir, {withFileTypes: true}).map((entry) => ({name: entry.name, isDir: entry.isDirectory()}))
      } catch {
        return []
      }
    },
    isCheckout(dir) {
      try {
        return fs.existsSync(path.join(dir, '.git'))
      } catch {
        return false
      }
    },
    isLinkedWorktree,
    readRemotes: readGitRemotes,
  }
}

/**
 * true if `dir` is a LINKED worktree. The test is not "`.git` is a file" — it is one in a submodule too, which
 * instead is a repository of its own with its own remotes: it is `--git-dir` differing from `--git-common-dir`, which only a
 * secondary worktree produces (`<repo>/.git/worktrees/<slug>` versus `<repo>/.git`). Arguments as an array
 * (no shell) and `dir` always comes from the filesystem scan. Any error → false: the worst
 * consequence is an ambiguity reported to the operator, which is already the previous behaviour.
 */
export function isLinkedWorktree(dir: string): boolean {
  try {
    const res = spawnSync('git', ['-C', dir, 'rev-parse', '--git-dir', '--git-common-dir'], {encoding: 'utf8'})
    if (res.status !== 0 || !res.stdout) return false
    const [gitDir, commonDir] = res.stdout.trim().split('\n')
    if (!gitDir || !commonDir) return false
    return path.resolve(dir, gitDir.trim()) !== path.resolve(dir, commonDir.trim())
  } catch {
    return false
  }
}
