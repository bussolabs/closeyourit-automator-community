import * as fs from 'node:fs'
import * as path from 'node:path'
import {spawnSync} from 'node:child_process'
import {makeClient} from './client'
import {hasOperationalHostIdentity, type Secrets} from './config'
import {type FetchFn} from './heartbeat'
import {cloneUrl, isSafeSegment, splitRepo} from './workspace'
import {skillsDir, skillsModeEnabled, skillsPluginDir} from './paths'
import {AutomatorError, ErrorCodes} from '../errors/error-codes'

// Sync of the PINNED skill bundle (C.1), twin of workspace-manifest.ts. The server (B.2,
// GET /api/v1/agent_host/skill_manifest) exposes the AUTHORITATIVE version of the `closeyourit-skills` plugin;
// the host clones it at the pinned ref into `skills/<version>` and points the `skills/current` symlink to the active version
// (`installRoot/current` pattern). The skill-mode runtime (C.2) loads `claude --plugin-dir skills/current`.
// NEVER destructive (like workspace-manifest): an occupied/diverging checkout is preserved, not overwritten.
// Content-addressed: `ref` (tag or sha) + `digest` (sha of the expected commit) → a moved tag or different
// content fail the verification and do NOT promote `current` (fail-closed). Pure with respect to git/fs: every command
// lives behind `SkillsGit`, injectable in tests.
//
// Server contract (GET /api/v1/agent_host/skill_manifest):
//   { data: { version, digest, repo, ref } }  — repo=owner/name, ref=tag|sha, digest=expected sha ('' = unverified)

export interface SkillsManifest {
  version: string // directory name under skills/ (e.g. "0.1.0")
  digest: string // sha of the expected commit (content-addressed verification); '' = unverified
  repo: string // owner/name (e.g. bussolabs/closeyourit-skills)
  ref: string // tag or sha to check out
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function str(value: unknown): string | null {
  return typeof value === 'string' && value.trim() !== '' ? value : null
}

/**
 * TOLERANT parsing of the manifest (untrusted input from the server, like `parseWorkspaceManifest`): accepts both
 * the `{data:{...}}` envelope and the direct object. `version`/`repo`/`ref` are the minimum identity (missing →
 * `null`, unusable manifest); `digest` degrades to '' (bundle not content-address verified).
 */
export function parseSkillsManifest(input: unknown): SkillsManifest | null {
  if (!isRecord(input)) return null
  const root = 'repo' in input || 'version' in input ? input : isRecord(input.data) ? input.data : input
  const version = str(root.version)
  const repo = str(root.repo)
  const ref = str(root.ref)
  if (!version || !repo || !ref) return null
  return {version, digest: str(root.digest) ?? '', repo, ref}
}

/** true if `version` is a safe segment (it ends up as the directory name `skills/<version>`, never traversal/.git). */
export function isSafeVersion(version: string): boolean {
  return isSafeSegment(version) && version !== '.git'
}

/** Resolved sync plan: where to clone the bundle (`dest`), at which ref/digest, and the base for the `current` symlink. */
export interface SkillsSyncPlan {
  base: string // skills dir (contains <version>/ and the current symlink)
  version: string
  repo: string // owner/name (validated)
  ref: string
  digest: string
  dest: string // base/<version>
}

/**
 * PURE and deterministic plan. Validates `version` (safe segment → directory name) and `repo` (safe owner/repo,
 * it ends up in gh/git clone): unsafe input → `AutomatorError` `C400-MANIFEST-001` (fail-closed, as
 * planWorkspaceReplication discards the entries). `base` injectable (default `skillsDir()`) for tests.
 */
export function planSkillsSync(manifest: SkillsManifest, base: string = skillsDir()): SkillsSyncPlan {
  if (!isSafeVersion(manifest.version)) {
    throw new AutomatorError(ErrorCodes.Manifest.invalidPath, `versione skill non sicura: "${manifest.version}"`, 2)
  }
  try {
    splitRepo(manifest.repo) // validates owner/repo as two safe segments; throws otherwise
  } catch {
    throw new AutomatorError(ErrorCodes.Manifest.invalidPath, `repo skill non valido (atteso owner/repo): "${manifest.repo}"`, 2)
  }
  return {base, version: manifest.version, repo: manifest.repo, ref: manifest.ref, digest: manifest.digest, dest: path.join(base, manifest.version)}
}

// Injectable git/fs probes (mirror of ReplicationGit). The mutating methods throw on failure → the orchestrator
// catches them and returns a `failed` outcome (best-effort, never an escaping exception).
export interface SkillsGit {
  exists(p: string): boolean
  isGitCheckout(p: string): boolean
  clone(repo: string, dest: string): void
  fetch(dest: string): void
  checkout(dest: string, ref: string): void
  /** Commit `ref` points to AFTER the fetch, without touching the worktree: used to verify before mutating. */
  resolveRef(dest: string, ref: string): string
  headSha(dest: string): string
  /** Atomically points `base/current` → `version` (relative symlink). */
  setCurrent(base: string, version: string): void
  /** Active version = target of the `base/current` symlink; missing/unreadable → `null` (never throws). */
  currentVersion(base: string): string | null
  /**
   * Removes a path best-effort (never throws): the `current` symlink to bring back to prompt mode BEFORE
   * cloning into its own (broken) target, or a just-cloned unverified directory to discard. On a
   * symlink it removes the link, never the target. Never on valid pre-existing content.
   */
  remove(target: string): void
  /**
   * Tags the REMOTE publishes, queried without downloading or writing anything. Not the local refs: after a successful
   * sync those are stuck at the pin exactly as much as the host, so they would never say that a
   * new version arrived. Best-effort: unreachable or without remote → empty list, never an exception.
   */
  remoteTags(dest: string): string[]
}

/**
 * Gap between the server pin and what the repo has already published (CYAU-135). Versions normalized without the
 * leading `v`, as the manifest writes them (`version`).
 */
export interface PinLag {
  pinned: string // version pinned by the server (the one the hosts are running)
  latest: string // latest tagged version in the bundle repo
}

/**
 * Canary outcome, with the state ALWAYS explicit. `unknown` is the case that matters to model: a failing probe
 * must not be able to look like "pin up to date", otherwise the canary stays silent exactly when it has not
 * looked — the same silence this check exists to remove.
 */
export type PinCheck =
  | {state: 'behind'; lag: PinLag} // the pin is stuck at an already superseded version
  | {state: 'aligned'} // the pin is on the latest published version
  | {state: 'unknown'} // the published versions could not be read
  | {state: 'skipped'} // check not requested, or sync failed (there was nothing to compare)

/** Only `X.Y.Z` (with or without `v`): a test tag or a prerelease is not a publication to chase. */
const RELEASE_TAG = /^v?(\d+)\.(\d+)\.(\d+)$/

function releaseVersion(value: string): [number, number, number] | null {
  const m = RELEASE_TAG.exec(value.trim())
  return m ? [Number(m[1]), Number(m[2]), Number(m[3])] : null
}

function compareVersions(a: [number, number, number], b: [number, number, number]): number {
  return a[0] - b[0] || a[1] - b[1] || a[2] - b[2]
}

/**
 * The pin canary (CYAU-135): the pin belongs to the server and is written by the bundle publication. If that
 * write does not happen (expired token, missing settings on the repo) the release LOOKS successful and every host
 * stays on the old instructions — without anything, anywhere, signalling the gap. Here the gap is seen
 * from two facts the host already has: the pin the server gave it and the tags the bundle repo
 * publishes. No database to look at.
 *
 * `null` when there is nothing to say: pin on the latest version, no comparable tag, or a pin that does not
 * declare a version (neither numeric `ref` nor `version`) — a canary that rings for nothing would be ignored.
 * The comparison is NUMERIC, not alphabetical: `v0.10.0` comes after `v0.9.0`.
 */
export function comparePinToTags(pin: {ref: string; version: string}, tags: string[]): PinLag | null {
  const pinned = releaseVersion(pin.ref) ?? releaseVersion(pin.version)
  if (!pinned) return null
  let latest: [number, number, number] | null = null
  for (const tag of tags) {
    const v = releaseVersion(tag)
    if (v && (latest === null || compareVersions(v, latest) > 0)) latest = v
  }
  if (!latest || compareVersions(latest, pinned) <= 0) return null
  return {pinned: pinned.join('.'), latest: latest.join('.')}
}

export type SkillsSyncAction = 'cloned' | 'updated' | 'current' | 'occupied' | 'mismatch' | 'failed'

export interface SkillsSyncReport {
  version: string
  repo: string
  ref: string
  action: SkillsSyncAction
  ok: boolean
  /** Path of the active plugin (`base/current`) when the sync promoted the version; otherwise null. */
  pluginDir: string | null
  detail: string
  /**
   * Comparison between the pin and the versions published in the bundle repo (CYAU-135). A `behind` is not a sync
   * error — the host IS aligned with the pin: it is the PIN that fell behind.
   */
  pinCheck: PinCheck
}

export interface SkillsSyncOptions {
  /**
   * Compares the pin with the published versions. It costs a SYNCHRONOUS network call, which in the beat also stops
   * heartbeat and lease renewal until it returns: it is therefore explicit and never implicit. It is requested by
   * `automator skill sync` and OneClick (explicit paths, the operator is watching), and by the beat periodically.
   */
  checkPinLag?: boolean
}

/**
 * Is the active bundle already the pinned one? Decided on two observable facts, not on a remembered state: the target
 * of the `current` symlink and the checkout sha. Needed because the reconciliation runs at EVERY beat
 * (`makeSkillsReconciler`): without it, every minute a pointless `fetch --all --tags` and `checkout` would start.
 * Conservative: any doubt (no `current`, missing checkout, unreadable sha) → sync.
 * The digest comparison catches the case the version alone does not see: a **moved pin** (same name, different
 * commit). With an empty `digest` (unverified manifest) only the version comparison remains.
 */
export function needsSkillSync(plan: SkillsSyncPlan, git: SkillsGit = defaultSkillsGit()): boolean {
  const active = git.currentVersion(plan.base)
  if (active === null) return true
  const activeDir = path.join(plan.base, active)
  if (!git.exists(activeDir) || !git.isGitCheckout(activeDir)) return true
  // With the digest the right question is not "which version is active" but "is the active commit the pinned one":
  // the directory name may carry a suffix (see `materializationDir`) and comparing the names
  // would say "to be synced" forever.
  if (plan.digest !== '') {
    try {
      return git.headSha(activeDir) !== plan.digest
    } catch {
      return true
    }
  }
  // Without digest only the name remains: it is all the manifest declares.
  return active !== plan.version
}

/** What this machine is REALLY running: the active version and the commit underneath. */
export interface ActiveBundleIdentity {
  /** Logical version, without the commit suffix `materializationDir` may add. */
  version: string
  sha: string
  /** Name of the directory under `skills/`, as it is on disk. Useful to whoever has to go and look. */
  directory: string
}

/**
 * The fingerprint of the active bundle, read from the facts: the target of the `current` symlink and the sha of that
 * checkout. `null` when there is nothing to read — no `current`, missing checkout, unreadable
 * sha — and that `null` must be treated as "I do not know", never as "fine".
 *
 * THE FINGERPRINT IS THE SHA, not the directory name. A moved pin keeps the same version name
 * and changes commit: whoever compares names sees two equal things that are not equal. It is the same reason
 * why `materializationDir` creates `skills/<version>-<sha>` instead of rewriting the directory.
 *
 * Pure with respect to git and the filesystem: the probes are injectable, as in this whole file.
 */
export function activeBundleIdentity(base: string = skillsDir(), git: SkillsGit = defaultSkillsGit()): ActiveBundleIdentity | null {
  const version = git.currentVersion(base)
  if (version === null) return null

  const dir = path.join(base, version)
  if (!git.exists(dir) || !git.isGitCheckout(dir)) return null

  try {
    const sha = git.headSha(dir)
    // `version` is the directory NAME, which after a moved pin carries the commit suffix
    // (`materializationDir` → `1.0.0-abc123def456`). Whoever compares with the number declared by the server
    // would see two different things and would block the machine forever: the path name is kept
    // to tell the reader, and next to it the LOGICAL version, which is the one to compare.
    return sha ? {version: logicalVersion(version, sha), sha, directory: version} : null
  } catch {
    return null
  }
}

/**
 * The logical version behind a directory name. `materializationDir` appends `-<sha 12>` when
 * the pin moves under the same number: that suffix is a detail of how the bundle was
 * materialized, not a different version.
 */
function logicalVersion(directory: string, sha: string): string {
  const suffisso = `-${sha.slice(0, 12)}`
  return directory.endsWith(suffisso) ? directory.slice(0, -suffisso.length) : directory
}

/**
 * Where to materialize the pinned commit. `skills/<version>` as long as it contains that commit; if the pin has
 * moved, a NEW directory `skills/<version>-<sha>` — never a rewrite of the existing one.
 *
 * It is the property that makes automatic reconciliation safe: `ticket-preflight` does `realpath` of the plugin
 * dir at spawn, so a session keeps the VERSIONED directory it resolved and can read it for a
 * quarter of an hour. Addressing by content, a different commit is by construction a different directory: whoever
 * is working does not notice, whoever starts later takes the new one, and `current` can switch immediately.
 * Without digest the expected commit is not known here yet: start from the version directory and the
 * same choice is redone in `syncSkillBundle` after the fetch, when the ref is resolved.
 */
export function materializationDir(plan: SkillsSyncPlan, git: SkillsGit = defaultSkillsGit()): string {
  if (plan.digest === '') return plan.dest
  if (!git.exists(plan.dest) || !git.isGitCheckout(plan.dest)) return plan.dest
  let head: string
  try {
    head = git.headSha(plan.dest)
  } catch {
    return plan.dest // unreadable sha: the second decision, after the fetch, has the last word anyway
  }
  return head === plan.digest ? plan.dest : suffixedDir(plan, plan.digest)
}

/**
 * Makes `dir` exist as a checkout of the repo: clones if missing, otherwise updates refs and objects (the fetch
 * does not touch the worktree). It does not check out: the worktree mutation stays a single step, downstream of the
 * verifications. `occupied` if the path is something that is not a git checkout — never overwritten.
 */
function materialize(plan: SkillsSyncPlan, git: SkillsGit, dir: string): 'cloned' | 'updated' | 'occupied' {
  if (!git.exists(dir)) {
    git.clone(plan.repo, dir)
    return 'cloned'
  }
  if (!git.isGitCheckout(dir)) return 'occupied'
  git.fetch(dir)
  return 'updated'
}

/** `base/<version>-<sha>`: the name carries the content, so a different commit is a different directory. */
function suffixedDir(plan: SkillsSyncPlan, commit: string): string {
  const name = `${plan.version}-${commit.slice(0, 12)}`
  // Composed of already validated parts (safe version + commit), but the result ends up as a directory
  // name and as the symlink target: revalidate, do not assume.
  if (!isSafeVersion(name)) {
    throw new AutomatorError(ErrorCodes.Manifest.invalidPath, `nome directory skill non sicuro: "${name}"`, 2)
  }
  return path.join(plan.base, name)
}

/**
 * Runs the canary from a bundle checkout (needed only to know which remote to query; it is neither
 * read nor written). It NEVER throws: it is diagnostics, it must not be able to make the sync fail, which is the
 * real work. But a failure stays distinct from a success: `unknown`, never `aligned`.
 */
function probePinCheck(plan: SkillsSyncPlan, git: SkillsGit, dir: string): PinCheck {
  let tags: string[]
  try {
    tags = git.remoteTags(dir)
  } catch {
    return {state: 'unknown'}
  }
  // `aligned` can be said only if the comparison was POSSIBLE: without a readable pinned version or without
  // even one published version to compare, the canary looked at nothing — and must say so.
  const pinnedReadable = releaseVersion(plan.ref) !== null || releaseVersion(plan.version) !== null
  if (!pinnedReadable || !tags.some((tag) => releaseVersion(tag) !== null)) return {state: 'unknown'}
  const lag = comparePinToTags(plan, tags)
  return lag ? {state: 'behind', lag} : {state: 'aligned'}
}

/**
 * Syncs the bundle behind the injectable probe: clones if missing (never on an occupied non-git path), fetch +
 * checkout at the pinned `ref`, VERIFIES the digest (commit sha) if provided, and only then promotes `current` →
 * `version`. IDEMPOTENT (rerun = fetch+checkout, no destruction). A digest that does not match does NOT promote
 * `current` (fail-closed): the active bundle stays the previously verified one.
 * If the active bundle is already the pinned one it exits immediately with `action: 'current'` without touching git.
 */
export function syncSkillBundle(
  plan: SkillsSyncPlan,
  git: SkillsGit = defaultSkillsGit(),
  opts: SkillsSyncOptions = {},
): SkillsSyncReport {
  const base = {version: plan.version, repo: plan.repo, ref: plan.ref, pinCheck: {state: 'skipped'} as PinCheck}
  try {
    if (!needsSkillSync(plan, git)) {
      // It is the ticket's case: the host is aligned with the pin and precisely for this it no longer touches git. If nobody
      // looks at the published versions, nobody sees the gap with the pin any more.
      const active = git.currentVersion(plan.base)
      const pinCheck: PinCheck = opts.checkPinLag
        ? (active ? probePinCheck(plan, git, path.join(plan.base, active)) : {state: 'unknown'})
        : {state: 'skipped'}
      return {...base, action: 'current', ok: true, pluginDir: path.join(plan.base, 'current'), pinCheck, detail: `bundle ${plan.version} già attivo`}
    }

    // With the digest the pinned commit goes straight into a directory representing it: if the version's one
    // already contains something else, a new one is used instead of rewriting it (`materializationDir`).
    let dest = materializationDir(plan, git)
    const existed = git.exists(dest) && git.isGitCheckout(dest)

    // Structural fail-closed. `git clone` checks out the default branch INSIDE `dest` before we can
    // verify it: if `dest` is exactly what `current` resolves, that unverified content becomes active for
    // the whole duration of the clone (seconds) — visible to concurrent sessions too — and would stay so if the
    // verification or checkout then fail. `!exists(dest) && current === basename(dest)` means exactly that
    // `current` is a BROKEN symlink to `dest` (the dir is missing): removing it first is always safe and brings
    // the host back to prompt mode. From here to the post-verification `setCurrent` there is no active bundle; on success `setCurrent`
    // restores `current`, on failure it stays removed (safe degradation). Safety no longer depends on a
    // cleanup AFTERWARDS — which might not happen (crash) or fail (rmSync) — but on never activating the unverified.
    if (!git.exists(dest) && git.currentVersion(plan.base) === path.basename(dest)) {
      git.remove(path.join(plan.base, 'current'))
    }

    let action = materialize(plan, git, dest)
    if (action === 'occupied') {
      return {...base, action, ok: false, pluginDir: null, detail: `${ErrorCodes.Manifest.occupied}: path occupato da una directory non-git`}
    }

    // The ref's commit is resolved BEFORE any worktree mutation. Verifying it after the checkout (as it was)
    // means having already made unverified content active when `dest` is the directory `current`
    // points to: the `mismatch` did not promote `current`, but `current` was already on it — fail-closed only in appearance.
    const target = git.resolveRef(dest, plan.ref)
    if (plan.digest !== '' && target !== plan.digest) {
      // `current` is already in prompt mode if `dest` was its target (above): the unverified bundle is NOT active, and
      // does not become so. We also discard the just-cloned dir (best-effort, only ours): it is disk cleanup,
      // safety does NOT depend on this removal.
      if (action === 'cloned') git.remove(dest)
      return {...base, action: 'mismatch', ok: false, pluginDir: null,
        detail: `${ErrorCodes.Manifest.gitFailed}: digest non combacia (atteso ${plan.digest}, ottenuto ${target}); bundle non verificato non attivo`}
    }

    // Without digest the expected commit is known only now, so the directory choice is redone here with the
    // same criterion: if the existing one contains something else, the new commit goes into its own. The fetch meanwhile has
    // been harmless — it touches refs and objects, not the worktree. This way even the manifest without digest converges by
    // itself, and no case is left that requires a person.
    if (existed && git.headSha(dest) !== target) {
      dest = suffixedDir(plan, target)
      action = materialize(plan, git, dest)
      if (action === 'occupied') {
        return {...base, action, ok: false, pluginDir: null, detail: `${ErrorCodes.Manifest.occupied}: path occupato da una directory non-git`}
      }
    }

    const dirName = path.basename(dest)
    git.checkout(dest, plan.ref)
    git.setCurrent(plan.base, dirName)
    // Even after a successful sync the pin can be behind (0.1.3 published while the pin has just
    // moved to 0.1.2): whoever asked for the check gets it on both branches, and only whoever asked.
    const pinCheck: PinCheck = opts.checkPinLag ? probePinCheck(plan, git, dest) : {state: 'skipped'}
    return {...base, action, ok: true, pluginDir: path.join(plan.base, 'current'), pinCheck, detail: `bundle ${plan.version} pronto in current (${dirName})`}
  } catch (error) {
    const code = error instanceof AutomatorError ? error.code : ErrorCodes.Manifest.gitFailed
    return {...base, action: 'failed', ok: false, pluginDir: null, detail: `${code}: ${(error as Error).message}`}
  }
}

/** Outcome of the comparison between the manual this machine runs and the one the server pinned. */
export interface BundlePinCheck {
  aligned: boolean
  detail: string
}

/**
 * CYAU-170 — is the active manual the pinned one?
 *
 * Until recently only that the `current` link resolved was verified. A machine left
 * behind — expired `gh` session, sync silently failed — kept taking work
 * and delivering results produced by old instructions, and the server accepted them all: the result
 * does not say which manual it comes from. The only signal was a line in the machine's local log.
 *
 * The pin is asked of the server at every check, not remembered: a remembered state survives its
 * cause, and would say "aligned" for a pin changed ten minutes ago.
 *
 * Fail-closed in the three cases, with DISTINCT reasons because they are three different failures:
 *   · different fingerprint → the sync did not promote: look at why.
 *   · unreadable fingerprint → the manual is missing or unreadable: reinstall.
 *   · pin not read          → the server did not answer: wait, touch nothing.
 *
 * Without digest in the manifest (unverified manifest) the name comparison remains: it is all the
 * server declares, and requiring more would block every machine for a datum that does not exist.
 */
export async function compareBundleToPin(
  client: SkillsManifestClient,
  base: string = skillsDir(),
  git: SkillsGit = defaultSkillsGit(),
  // The default derives from the base, not from `skillsPluginDir()`: deriving it from the environment would send
  // into the forced-path branch every call with a base different from the production one — that is
  // every test. The REAL path is passed by the caller.
  pluginDir: string = path.join(base, 'current'),
): Promise<BundlePinCheck> {
  // `AUTOMATOR_SKILLS_DIR` replaces the WHOLE path of the executed bundle, not its root: with
  // that variable set, checking `skillsDir()/current` would mean giving the green light
  // looking at a manual different from the one the session then runs. The gate must look at
  // exactly what runs, or it is not a gate.
  if (pluginDir !== path.join(base, 'current')) {
    return bundleAtPath(pluginDir, git, client)
  }
  let manifest: SkillsManifest | null
  try {
    manifest = await client.getSkillsManifest()
  } catch {
    manifest = null
  }
  if (manifest === null) {
    return {aligned: false, detail: 'manuale delle istruzioni: il server non ha detto quale versione è quella buona'}
  }

  const active = activeBundleIdentity(base, git)
  if (active === null) {
    return {aligned: false, detail: 'manuale delle istruzioni: non risulta installato, o la sua versione non è leggibile'}
  }

  const atteso = manifest.digest !== '' ? manifest.digest : null
  if (atteso === null) {
    return active.version === manifest.version
      ? {aligned: true, detail: ''}
      : {aligned: false, detail: `manuale delle istruzioni disallineato: questa macchina esegue ${active.version}, il pin dice ${manifest.version}`}
  }

  if (active.sha !== atteso) {
    return {
      aligned: false,
      detail: `manuale delle istruzioni disallineato: questa macchina esegue ${active.version} (${active.sha.slice(0, 12)}), il pin dice ${manifest.version} (${atteso.slice(0, 12)})`,
    }
  }

  return {aligned: true, detail: ''}
}

/**
 * The forced-path case (`AUTOMATOR_SKILLS_DIR`): there is no `current` symlink to read there,
 * the bundle is there directly. Verify it is a checkout and compare its commit.
 */
async function bundleAtPath(dir: string, git: SkillsGit, client: SkillsManifestClient): Promise<BundlePinCheck> {
  let manifest: SkillsManifest | null
  try {
    manifest = await client.getSkillsManifest()
  } catch {
    manifest = null
  }
  if (manifest === null) {
    return {aligned: false, detail: 'manuale delle istruzioni: il server non ha detto quale versione è quella buona'}
  }
  if (!git.exists(dir) || !git.isGitCheckout(dir)) {
    return {aligned: false, detail: 'manuale delle istruzioni: non risulta installato, o la sua versione non è leggibile'}
  }
  if (manifest.digest === '') {
    // No commit declared by the server and no name to compare (the path is forced): there is
    // nothing to base a judgment on, and pretending it is fine is the defect we are removing.
    return {aligned: false, detail: 'manuale delle istruzioni: percorso forzato e nessuna impronta dichiarata dal server, impossibile verificarlo'}
  }
  try {
    const sha = git.headSha(dir)
    return sha === manifest.digest
      ? {aligned: true, detail: ''}
      : {aligned: false, detail: `manuale delle istruzioni disallineato: il percorso forzato esegue ${sha.slice(0, 12)}, il pin dice ${manifest.digest.slice(0, 12)}`}
  } catch {
    return {aligned: false, detail: 'manuale delle istruzioni: non risulta installato, o la sua versione non è leggibile'}
  }
}

/** Host-scoped client exposing the skill manifest (mirror of WorkspaceManifestClient); injectable in tests. */
export interface SkillsManifestClient {
  getSkillsManifest(): Promise<SkillsManifest | null>
}

export interface SyncFromSkillsManifestDeps {
  client: SkillsManifestClient | null // null = host not registered → no sync
  base?: string // override of the skills dir (default skillsDir())
  git?: SkillsGit
  checkPinLag?: boolean // see SkillsSyncOptions: pin ↔ tag comparison even with nothing to sync
}

/**
 * End-to-end orchestration of the skill sync (`skills` stage of OneClick / heartbeat): missing client or
 * unretrievable manifest → `null` (the stage degrades); otherwise it plans and syncs. Testable
 * counterpart of the wiring.
 */
export async function syncFromSkillsManifest(deps: SyncFromSkillsManifestDeps): Promise<SkillsSyncReport | null> {
  if (!deps.client) return null
  const manifest = await deps.client.getSkillsManifest()
  if (manifest === null) return null
  return syncSkillBundle(planSkillsSync(manifest, deps.base ?? skillsDir()), deps.git, {checkPinLag: deps.checkPinLag})
}

export interface SkillsReconcilerOptions {
  fetchFn?: FetchFn
  base?: string // override of the skills dir (default skillsDir())
  git?: SkillsGit
  /** Notifies only CHANGES (successful promotion or sync attempted and failed), never idle rounds. */
  log?: (message: string) => void
  /** Every how many beats to compare the pin with the published tags (default 60 ≈ one hour with a one-minute beat). */
  pinLagEveryBeats?: number
}

/** A fetch per minute for a canary would be disproportionate: one hour is the cadence of a problem that lasts days. */
const DEFAULT_PIN_LAG_EVERY_BEATS = 60

/**
 * Skill bundle reconciliation callback to compose into the host beat (CYAU-129), twin of
 * `makeLeaseRenewer`. The pin belongs to the SERVER and changes when the server wants, not when the automator updates:
 * chasing it from the beat is the only point that sees it change. Before this, the bundle arrived only from
 * a manual `automator skill sync` — a machine with skill-mode on and no bundle stayed mute, and an already
 * provisioned one stayed forever on the first day's version.
 *
 * `undefined` (→ no cost, not even a GET per minute) when reconciliation makes no sense: channel not
 * configured, incomplete host identity, or skill-mode off — whoever stays in prompt mode does not use the bundle.
 * Best-effort like the other beats: it never throws and ignores `ok` (the pin does not depend on the actions' outcome).
 */
export function makeSkillsReconciler(secrets: Secrets, opts: SkillsReconcilerOptions = {}): ((ok: boolean) => Promise<void>) | undefined {
  if (!secrets.sync || !hasOperationalHostIdentity(secrets) || !skillsModeEnabled()) return undefined
  const git = opts.git ?? defaultSkillsGit()
  const pinLagEvery = opts.pinLagEveryBeats ?? DEFAULT_PIN_LAG_EVERY_BEATS
  let beats = 0
  return async () => {
    // As in `makeLeaseRenewer`: `secrets` is the same object the 401 recovery updates atomically,
    // so client and token are resolved at EVERY beat. Capturing them outside would leave the daemon on the superseded token.
    if (!secrets.sync || !hasOperationalHostIdentity(secrets)) return
    // The pin canary (CYAU-135) costs a fetch: it runs at the first beat — the snapshot of a just-started
    // machine — and then periodically. The counter advances only on beats really executed.
    const checkPinLag = beats % pinLagEvery === 0
    beats++
    const client = makeClient(secrets.sync, opts.fetchFn, secrets.host.token)
    const report = await syncFromSkillsManifest({client, base: opts.base ?? skillsDir(), git, checkPinLag})
    if (report === null) return // no server-side pin: prompt mode, not an error
    if (report.action !== 'current') {
      opts.log?.(report.ok
        ? `skill: bundle ${report.version} promosso (${report.action})`
        : `skill: bundle ${report.version} non promosso — ${report.detail}`)
    }
    // The bundle is fine (it is aligned with the pin) but the pin fell behind: without this line the skills
    // release would look successful while the machine still runs the old instructions. A FAILED check
    // is written as well: a mute log reads as "all good".
    if (report.pinCheck.state === 'behind') {
      opts.log?.(
        `skill: pin fermo alla ${report.pinCheck.lag.pinned} ma ${report.repo} ha già pubblicato la ${report.pinCheck.lag.latest} — `
          + 'la pubblicazione non ha aggiornato il pin: finché non viene aggiornato gli host restano sulle istruzioni vecchie',
      )
    } else if (report.pinCheck.state === 'unknown') {
      opts.log?.(`skill: pin non verificato — le versioni pubblicate da ${report.repo} non sono leggibili in questo momento`)
    }
  }
}

/**
 * Every git command here is SYNCHRONOUS and runs inside the daemon beat, where beats follow each other in a row:
 * until it returns, not even heartbeat and lease renewal advance. Without a cap, a network that does not answer or
 * a waiting credential helper do not "slow down" the service — they stop it, forever. The timeout kills the
 * process and the caller simply sees a failed command, which each one handles as it already handles errors.
 */
const GIT_TIMEOUT_MS = 120_000
/** The canary probe is pure diagnostics: if it does not answer quickly it is postponed, not waited for. */
const REMOTE_PROBE_TIMEOUT_MS = 20_000
/** An initial clone downloads the whole history: it is legitimately longer than a fetch, but not infinite. */
const GIT_CLONE_TIMEOUT_MS = 600_000

/**
 * The test seam: the shape of `spawnSync` reduced to what is needed here. Injecting it allows verifying
 * that every command starts with a time cap and without interactive prompts, without touching the real network.
 */
export type GitSpawnSync = (
  file: string,
  args: string[],
  options: {encoding: 'utf8'; env: NodeJS.ProcessEnv; timeout: number},
) => {status: number | null; stderr: string | null; stdout: string | null}

/** `GIT_TERMINAL_PROMPT=0`: without credentials git fails immediately instead of waiting for a password nobody will type. */
function gitEnvironment(): NodeJS.ProcessEnv {
  return {...process.env, GIT_TERMINAL_PROMPT: '0'}
}

/**
 * Real git/fs probes (node:fs + git/gh via spawnSync, argv array = no shell). The clone first tries `gh repo
 * clone` (authenticated gh session, private repos too), then `git clone https`. checkout is detached on the pinned
 * ref. `setCurrent` writes an atomic relative symlink (temp + rename). clone/fetch/checkout throw
 * `AutomatorError` (`C502-MANIFEST-003`) on failure.
 */
export function defaultSkillsGit(spawn: GitSpawnSync = spawnSync as unknown as GitSpawnSync): SkillsGit {
  const run = (
    file: string,
    args: string[],
    timeoutMs: number = GIT_TIMEOUT_MS,
  ): {ok: boolean; stdout: string; stderr: string} => {
    const res = spawn(file, args, {encoding: 'utf8', env: gitEnvironment(), timeout: timeoutMs})
    return {ok: res.status === 0, stdout: res.stdout ?? '', stderr: res.stderr ?? ''}
  }

  const runGit = (args: string[], timeoutMs?: number) => run('git', args, timeoutMs)

  return {
    exists(p) {
      return fs.existsSync(p)
    },
    isGitCheckout(p) {
      return fs.existsSync(path.join(p, '.git'))
    },
    clone(repo, dest) {
      fs.mkdirSync(path.dirname(dest), {recursive: true})
      // Like every other command here: through the wrapper, so with a time cap and without prompts. The clone runs in the
      // beat (materializing a new pin, not only at first start): a silent remote would stop it forever.
      const gh = run('gh', ['repo', 'clone', repo, dest], GIT_CLONE_TIMEOUT_MS)
      if (gh.ok) return
      const git = run('git', ['clone', '--', cloneUrl(repo), dest], GIT_CLONE_TIMEOUT_MS)
      if (!git.ok) {
        const reason = (git.stderr || gh.stderr || '').trim() || repo
        throw new AutomatorError(ErrorCodes.Manifest.gitFailed, `clone di ${repo} fallito: ${reason}`, 1)
      }
    },
    fetch(dest) {
      // `clone` goes through `gh repo clone` (authenticated session → private repos ok) but the remote it leaves is
      // plain HTTPS: a bare `git fetch`, without credential helper and without tty, dies with "could not read
      // Username for https://github.com". Verified on `server-minion-1`: the initial clone succeeds and every
      // later update does not — that is, the pin could never have been updated. The `gh` helper applies
      // only to this invocation (argv, no shell) and writes nothing in the user's config; if `gh`
      // is missing or not authenticated it falls back exactly to the previous error, without regressions.
      //
      // `--force --prune-tags`: a tag that already exists locally is NOT updated by `--tags`, not even if the
      // remote moved it — git answers `! [rejected] v0.1.0 -> v0.1.0 (would clobber existing tag)` and the
      // local ref stays at the old commit (verified). It is exactly the **repinned pin** case: without
      // force, `resolveRef` would resolve to the previous commit, the digest would never match and the manual
      // remedy would fail in the only case it exists for. Forcing here is safe: the directory is a managed,
      // disposable checkout of the pinned bundle, no work lives in it, and the digest comparison still
      // protects the promotion.
      const r = runGit(['-C', dest, '-c', 'credential.helper=!gh auth git-credential', 'fetch', '--all', '--tags', '--prune', '--prune-tags', '--force'])
      if (!r.ok) throw new AutomatorError(ErrorCodes.Manifest.gitFailed, `git fetch in ${dest} fallito: ${r.stderr.trim() || dest}`, 1)
    },
    checkout(dest, ref) {
      const r = runGit(['-C', dest, 'checkout', '--detach', ref])
      if (!r.ok) throw new AutomatorError(ErrorCodes.Manifest.gitFailed, `checkout di ${ref} in ${dest} fallito: ${r.stderr.trim() || ref}`, 1)
    },
    resolveRef(dest, ref) {
      // `^{commit}` disambiguates an annotated tag (which points to the tag object, not the commit) → comparable with
      // the digest and with `headSha`. Read-only: no write in the worktree.
      const r = runGit(['-C', dest, 'rev-parse', '--verify', `${ref}^{commit}`])
      if (!r.ok) throw new AutomatorError(ErrorCodes.Manifest.gitFailed, `rev-parse di ${ref} in ${dest} fallito: ${r.stderr.trim() || ref}`, 1)
      return r.stdout.trim()
    },
    headSha(dest) {
      const r = runGit(['-C', dest, 'rev-parse', 'HEAD'])
      if (!r.ok) throw new AutomatorError(ErrorCodes.Manifest.gitFailed, `rev-parse HEAD in ${dest} fallito`, 1)
      return r.stdout.trim()
    },
    setCurrent(base, version) {
      fs.mkdirSync(base, {recursive: true})
      const link = path.join(base, 'current')
      const tmp = path.join(base, `.current.tmp-${process.pid}`)
      try {
        fs.rmSync(tmp, {force: true})
      } catch {
        /* best-effort */
      }
      fs.symlinkSync(version, tmp) // RELATIVE target: current → <version> (moves together with the skills dir)
      fs.renameSync(tmp, link) // atomic rename: never a half current
    },
    currentVersion(base) {
      try {
        // `readlink` (not `realpath`): the declared TARGET is needed, which `setCurrent` writes relative (= the
        // version). A missing, non-symlink or unreadable `current` is not an anomaly to report here —
        // it is simply "no active version", and the caller treats it as "sync".
        return fs.readlinkSync(path.join(base, 'current'))
      } catch {
        return null
      }
    },
    remove(target) {
      // Best-effort (like currentVersion): brings `current` back to prompt mode before a clone into its broken target,
      // or discards an unverified cloned dir. `recursive` covers the dir; on a symlink `rmSync` removes the link
      // (does not follow it), never the target. An error here must not propagate.
      try {
        fs.rmSync(target, {recursive: true, force: true})
      } catch {
        /* best-effort */
      }
    },
    remoteTags(dest) {
      // `ls-remote` ASKS the remote for the refs without downloading objects and without writing anything locally: the
      // checkout stays exactly as it was (property verified in the tests). Same credential helper as the
      // fetch — it applies to this invocation only, private repos included. Short timeout: it is diagnostics, if it does not
      // answer retry at the next round.
      const r = runGit(
        ['-C', dest, '-c', 'credential.helper=!gh auth git-credential', 'ls-remote', '--tags', '--refs', 'origin'],
        REMOTE_PROBE_TIMEOUT_MS,
      )
      if (!r.ok) return [] // unreachable remote, no remote, timeout: "I could not look"
      const tags = new Set<string>()
      for (const line of r.stdout.split('\n')) {
        // `<sha>\trefs/tags/<name>`; `--refs` already discards the `^{}` of annotated tags, the Set covers the duplicates.
        const ref = line.split('\t')[1]?.trim()
        if (ref?.startsWith('refs/tags/')) tags.add(ref.slice('refs/tags/'.length))
      }
      return [...tags]
    },
  }
}
