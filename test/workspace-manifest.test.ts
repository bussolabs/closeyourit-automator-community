import {spawnSync} from 'node:child_process'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import {afterEach, beforeEach, describe, expect, it} from 'vitest'
import {
  defaultReplicationGit,
  fetchWorkspaceManifest,
  isSafeRelativePath,
  parseWorkspaceManifest,
  planWorkspaceReplication,
  replicateFromManifest,
  replicateWorkspace,
  resolveWorkspaceRoot,
  type ReplicationGit,
  type WorkspaceManifest,
} from '../src/lib/workspace-manifest'
import {ErrorCodes} from '../src/errors/error-codes'

// Well-formed manifest (server envelope shape), reused by the tests.
const MANIFEST_BODY = {
  data: {
    version: 1,
    digest: 'sha256:abc',
    workspace_root_hint: 'Lavoro/Github/Personale',
    repositories: [
      {project_key: 'CYRA', path: 'apps/closeyourit/closeyourit-rails', repo: 'bussolabs/closeyourit-rails', default_branch: 'main', group: 'CloseYourIt'},
      {project_key: 'CYAU', path: 'apps/closeyourit/closeyourit-automator', repo: 'bussolabs/closeyourit-automator', default_branch: 'main'},
    ],
  },
}

describe('parseWorkspaceManifest', () => {
  it('parses the server {data:{...}} envelope', () => {
    const m = parseWorkspaceManifest(MANIFEST_BODY)
    expect(m).not.toBeNull()
    expect(m?.workspace_root_hint).toBe('Lavoro/Github/Personale')
    expect(m?.repositories).toHaveLength(2)
    expect(m?.repositories[0]).toEqual({project_key: 'CYRA', path: 'apps/closeyourit/closeyourit-rails', repo: 'bussolabs/closeyourit-rails', default_branch: 'main', group: 'CloseYourIt'})
  })

  it('also parses the direct manifest object (without envelope)', () => {
    const m = parseWorkspaceManifest(MANIFEST_BODY.data)
    expect(m?.repositories).toHaveLength(2)
  })

  it('non-object input → null', () => {
    expect(parseWorkspaceManifest(null)).toBeNull()
    expect(parseWorkspaceManifest('nope')).toBeNull()
    expect(parseWorkspaceManifest(42)).toBeNull()
    expect(parseWorkspaceManifest([1, 2])).toBeNull()
  })

  it('non-array repositories → null (unusable manifest)', () => {
    expect(parseWorkspaceManifest({data: {repositories: 'x'}})).toBeNull()
    expect(parseWorkspaceManifest({version: 1})).toBeNull()
  })

  it('discards the malformed entries one by one (missing path/repo/default_branch), tolerant', () => {
    const m = parseWorkspaceManifest({
      repositories: [
        {project_key: 'A', path: 'a', repo: 'o/a', default_branch: 'main'},
        {project_key: 'B', path: '', repo: 'o/b', default_branch: 'main'}, // empty path → discarded
        {project_key: 'C', path: 'c', repo: '', default_branch: 'main'}, // empty repo → discarded
        {project_key: 'D', path: 'd', repo: 'o/d'}, // missing default_branch → discarded
        'non-un-oggetto', // → discarded
        {path: 'e', repo: 'o/e', default_branch: 'dev'}, // missing project_key → OK (degrades to '')
      ],
    })
    expect(m?.repositories.map((r) => r.path)).toEqual(['a', 'e'])
    expect(m?.repositories[1].project_key).toBe('')
  })

  it('missing version/digest/hint degrade to the defaults', () => {
    const m = parseWorkspaceManifest({repositories: []})
    expect(m).toEqual({version: 1, digest: '', workspace_root_hint: '', repositories: []})
  })
})

describe('fetchWorkspaceManifest', () => {
  it('delega a client.getWorkspaceManifest', async () => {
    const manifest = parseWorkspaceManifest(MANIFEST_BODY)
    const client = {getWorkspaceManifest: async () => manifest}
    expect(await fetchWorkspaceManifest(client)).toBe(manifest)
  })

  it('client returning null → null (best-effort)', async () => {
    expect(await fetchWorkspaceManifest({getWorkspaceManifest: async () => null})).toBeNull()
  })
})

describe('isSafeRelativePath', () => {
  it('normal relative paths → safe', () => {
    expect(isSafeRelativePath('apps/closeyourit/closeyourit-rails')).toBe(true)
    expect(isSafeRelativePath('a')).toBe(true)
  })

  it('empty / absolute → unsafe', () => {
    expect(isSafeRelativePath('')).toBe(false)
    expect(isSafeRelativePath('   ')).toBe(false)
    expect(isSafeRelativePath('/abs/path')).toBe(false)
  })

  it('traversal (..), hostile segments and .git → unsafe', () => {
    expect(isSafeRelativePath('a/../../etc')).toBe(false)
    expect(isSafeRelativePath('..')).toBe(false)
    expect(isSafeRelativePath('a/__proto__/b')).toBe(false)
    expect(isSafeRelativePath('a/.git/config')).toBe(false)
    expect(isSafeRelativePath('a//b')).toBe(false)
    expect(isSafeRelativePath('a\\..\\b')).toBe(false)
  })
})

describe('resolveWorkspaceRoot', () => {
  it('explicit override is authoritative (absolute)', () => {
    expect(resolveWorkspaceRoot('/custom/root', 'Lavoro/x', '/home/tizio')).toBe('/custom/root')
  })

  it('without override: relative hint under $HOME', () => {
    expect(resolveWorkspaceRoot(undefined, 'Lavoro/Github/Personale', '/home/tizio')).toBe('/home/tizio/Lavoro/Github/Personale')
  })

  it('empty hint → $HOME', () => {
    expect(resolveWorkspaceRoot(undefined, '', '/home/tizio')).toBe('/home/tizio')
  })

  it('hint with traversal/absolute → ignored, fallback to $HOME (never outside $HOME)', () => {
    expect(resolveWorkspaceRoot(undefined, '../../etc', '/home/tizio')).toBe('/home/tizio')
    expect(resolveWorkspaceRoot(undefined, '/etc', '/home/tizio')).toBe('/home/tizio')
  })
})

describe('planWorkspaceReplication', () => {
  const manifest = (): WorkspaceManifest => parseWorkspaceManifest(MANIFEST_BODY) as WorkspaceManifest

  it('for every repo composes dest=<root>/<path>, repo and branch', () => {
    const plan = planWorkspaceReplication(manifest(), '/ws')
    expect(plan.entries).toEqual([
      {projectKey: 'CYRA', repo: 'bussolabs/closeyourit-rails', dest: path.join('/ws', 'apps/closeyourit/closeyourit-rails'), branch: 'main'},
      {projectKey: 'CYAU', repo: 'bussolabs/closeyourit-automator', dest: path.join('/ws', 'apps/closeyourit/closeyourit-automator'), branch: 'main'},
    ])
    expect(plan.rejected).toEqual([])
  })

  it('discards a path with traversal with C400-MANIFEST-001 (does not block the others)', () => {
    const m: WorkspaceManifest = {version: 1, digest: '', workspace_root_hint: '', repositories: [
      {project_key: 'X', path: '../escape', repo: 'o/x', default_branch: 'main'},
      {project_key: 'Y', path: 'ok/y', repo: 'o/y', default_branch: 'main'},
    ]}
    const plan = planWorkspaceReplication(m, '/ws')
    expect(plan.entries.map((e) => e.projectKey)).toEqual(['Y'])
    expect(plan.rejected).toHaveLength(1)
    expect(plan.rejected[0].reason).toBe(ErrorCodes.Manifest.invalidPath)
    expect(plan.rejected[0].path).toBe('../escape')
  })

  it('discards an invalid owner/repo repo with C400-MANIFEST-001', () => {
    const m: WorkspaceManifest = {version: 1, digest: '', workspace_root_hint: '', repositories: [
      {project_key: 'X', path: 'ok/x', repo: 'senza-slash', default_branch: 'main'},
      {project_key: 'Z', path: 'ok/z', repo: 'o/../etc', default_branch: 'main'},
    ]}
    const plan = planWorkspaceReplication(m, '/ws')
    expect(plan.entries).toEqual([])
    expect(plan.rejected.map((r) => r.reason)).toEqual([ErrorCodes.Manifest.invalidPath, ErrorCodes.Manifest.invalidPath])
  })

  it('dest cannot climb above the root (the segments are validated)', () => {
    const plan = planWorkspaceReplication(manifest(), '/ws')
    for (const e of plan.entries) expect(e.dest.startsWith(path.join('/ws') + path.sep)).toBe(true)
  })
})

// --- Replication with a FAKE git probe: isolates the orchestration (clone/fetch/pull) from the real git. ---
function fakeGit(over: Partial<ReplicationGit> = {}): {git: ReplicationGit; clones: string[]; fetches: string[]; pulls: string[]} {
  const clones: string[] = []
  const fetches: string[] = []
  const pulls: string[] = []
  return {
    clones,
    fetches,
    pulls,
    git: {
      exists: () => false,
      isGitCheckout: () => true,
      clone: (_repo, dest) => clones.push(dest),
      fetch: (dest) => fetches.push(dest),
      pullFastForward: (dest) => (pulls.push(dest), true),
      ...over,
    },
  }
}

describe('replicateWorkspace (orchestration with fake git)', () => {
  const plan = (dests = ['/ws/a', '/ws/b']): ReturnType<typeof planWorkspaceReplication> => ({
    workspaceRoot: '/ws',
    entries: dests.map((dest, i) => ({projectKey: `P${i}`, repo: `o/r${i}`, dest, branch: 'main'})),
    rejected: [],
  })

  it('missing destination → clones (best-effort, idempotent)', () => {
    const f = fakeGit({exists: () => false})
    const report = replicateWorkspace(plan(), f.git)
    expect(f.clones).toEqual(['/ws/a', '/ws/b'])
    expect(report.cloned).toBe(2)
    expect(report.updated).toBe(0)
    expect(report.failed).toBe(0)
    expect(report.outcomes.every((o) => o.action === 'cloned' && o.ok)).toBe(true)
  })

  it('destination present and git → fetch + pull --ff-only (updated)', () => {
    const f = fakeGit({exists: () => true, isGitCheckout: () => true})
    const report = replicateWorkspace(plan(['/ws/a']), f.git)
    expect(f.fetches).toEqual(['/ws/a'])
    expect(f.pulls).toEqual(['/ws/a'])
    expect(report.updated).toBe(1)
    expect(report.outcomes[0].action).toBe('updated')
    expect(report.outcomes[0].detail).toContain('fast-forward')
  })

  it('present but not fast-forwardable → updated with the refs, local work preserved (ok)', () => {
    const f = fakeGit({exists: () => true, isGitCheckout: () => true, pullFastForward: () => false})
    const report = replicateWorkspace(plan(['/ws/a']), f.git)
    expect(report.updated).toBe(1)
    expect(report.outcomes[0].ok).toBe(true)
    expect(report.outcomes[0].detail).toContain('preservato')
  })

  it('destination occupied by non-git → occupied, does not overwrite (C409-MANIFEST-002)', () => {
    const f = fakeGit({exists: () => true, isGitCheckout: () => false})
    const report = replicateWorkspace(plan(['/ws/a']), f.git)
    expect(f.clones).toEqual([])
    expect(report.outcomes[0].action).toBe('occupied')
    expect(report.outcomes[0].ok).toBe(false)
    expect(report.outcomes[0].detail).toContain(ErrorCodes.Manifest.occupied)
    expect(report.failed).toBe(1)
  })

  it('best-effort: the clone of one repo fails, the others continue', () => {
    let n = 0
    const f = fakeGit({
      exists: () => false,
      clone: (_repo, dest) => {
        n += 1
        if (n === 1) throw new Error('boom di rete')
        return undefined as unknown as void
      },
    })
    const report = replicateWorkspace(plan(['/ws/a', '/ws/b']), f.git)
    expect(report.outcomes[0]).toMatchObject({action: 'failed', ok: false})
    expect(report.outcomes[0].detail).toContain(ErrorCodes.Manifest.gitFailed)
    expect(report.outcomes[1]).toMatchObject({action: 'cloned', ok: true})
    expect(report.failed).toBe(1)
    expect(report.cloned).toBe(1)
  })

  it('propagates the plan discards into the report', () => {
    const p = plan(['/ws/a'])
    p.rejected = [{repo: 'o/x', path: '../escape', reason: ErrorCodes.Manifest.invalidPath, detail: 'x'}]
    const report = replicateWorkspace(p, fakeGit().git)
    expect(report.rejected).toHaveLength(1)
  })
})

describe('replicateFromManifest (injectable end-to-end orchestration)', () => {
  it('null client → null (host not registered)', async () => {
    expect(await replicateFromManifest({client: null})).toBeNull()
  })

  it('unretrievable manifest → null', async () => {
    expect(await replicateFromManifest({client: {getWorkspaceManifest: async () => null}})).toBeNull()
  })

  it('fetches the manifest, resolves the root under $HOME and replicates', async () => {
    const manifest = parseWorkspaceManifest(MANIFEST_BODY)
    const f = fakeGit({exists: () => false})
    const report = await replicateFromManifest({
      client: {getWorkspaceManifest: async () => manifest},
      home: '/home/tizio',
      git: f.git,
    })
    expect(report?.workspaceRoot).toBe('/home/tizio/Lavoro/Github/Personale')
    expect(report?.cloned).toBe(2)
    expect(f.clones[0]).toBe(path.join('/home/tizio/Lavoro/Github/Personale', 'apps/closeyourit/closeyourit-rails'))
  })

  it('root override from the secret is authoritative', async () => {
    const manifest = parseWorkspaceManifest(MANIFEST_BODY)
    const f = fakeGit({exists: () => false})
    const report = await replicateFromManifest({
      client: {getWorkspaceManifest: async () => manifest},
      workspaceRootOverride: '/srv/ws',
      git: f.git,
    })
    expect(report?.workspaceRoot).toBe('/srv/ws')
  })
})

// --- Real probes with real git on temporary local repositories (no network). ---
describe('defaultReplicationGit (real git, offline)', () => {
  let root: string
  let origin: string
  let clone: string

  const git = (args: string[]): void => {
    const res = spawnSync('git', args, {encoding: 'utf8'})
    if (res.status !== 0) throw new Error(`git ${args.join(' ')} → ${res.stderr}`)
  }

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'automator-manifest-'))
    origin = path.join(root, 'origin')
    fs.mkdirSync(origin, {recursive: true})
    git(['-C', origin, 'init', '-q', '-b', 'main'])
    fs.writeFileSync(path.join(origin, 'README.md'), '# x\n')
    git(['-C', origin, 'add', '.'])
    git(['-C', origin, '-c', 'user.email=t@e.st', '-c', 'user.name=Test', 'commit', '-qm', 'init'])
    // Local clone (origin = local path): offline source for fetch/pull.
    clone = path.join(root, 'clone')
    git(['clone', '-q', origin, clone])
  })

  afterEach(() => fs.rmSync(root, {recursive: true, force: true}))

  it('exists / isGitCheckout recognize a real clone', () => {
    const g = defaultReplicationGit()
    expect(g.exists(clone)).toBe(true)
    expect(g.isGitCheckout(clone)).toBe(true)
    expect(g.isGitCheckout(root)).toBe(false)
    expect(g.exists(path.join(root, 'non-esiste'))).toBe(false)
  })

  it('fetch updates the refs from a local origin (offline)', () => {
    // New commit on origin, then fetch from the clone.
    fs.writeFileSync(path.join(origin, 'B.md'), '# b\n')
    git(['-C', origin, 'add', '.'])
    git(['-C', origin, '-c', 'user.email=t@e.st', '-c', 'user.name=Test', 'commit', '-qm', 'b'])
    const g = defaultReplicationGit()
    expect(() => g.fetch(clone)).not.toThrow()
    // The remote-tracking ref now contains the new commit.
    const contains = spawnSync('git', ['-C', clone, 'branch', '-r', '--contains', 'origin/main'], {encoding: 'utf8'})
    expect(contains.status).toBe(0)
  })

  it('fetch on a non-git dir → AutomatorError gitFailed', () => {
    const g = defaultReplicationGit()
    expect(() => g.fetch(root)).toThrowError(expect.objectContaining({code: ErrorCodes.Manifest.gitFailed}))
  })

  it('pullFastForward → true when it is fast-forwardable', () => {
    fs.writeFileSync(path.join(origin, 'C.md'), '# c\n')
    git(['-C', origin, 'add', '.'])
    git(['-C', origin, '-c', 'user.email=t@e.st', '-c', 'user.name=Test', 'commit', '-qm', 'c'])
    const g = defaultReplicationGit()
    g.fetch(clone)
    expect(g.pullFastForward(clone)).toBe(true)
    expect(fs.existsSync(path.join(clone, 'C.md'))).toBe(true)
  })

  it('pullFastForward → false when the history diverges (never loses local work)', () => {
    // Local commit in the clone diverging from origin.
    fs.writeFileSync(path.join(clone, 'local.md'), '# local\n')
    git(['-C', clone, 'add', '.'])
    git(['-C', clone, '-c', 'user.email=t@e.st', '-c', 'user.name=Test', 'commit', '-qm', 'local'])
    // Commit divergente su origin.
    fs.writeFileSync(path.join(origin, 'remote.md'), '# remote\n')
    git(['-C', origin, 'add', '.'])
    git(['-C', origin, '-c', 'user.email=t@e.st', '-c', 'user.name=Test', 'commit', '-qm', 'remote'])
    const g = defaultReplicationGit()
    g.fetch(clone)
    expect(g.pullFastForward(clone)).toBe(false)
    // The local work is preserved.
    expect(fs.existsSync(path.join(clone, 'local.md'))).toBe(true)
  })
})
