import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import {spawnSync} from 'node:child_process'
import {afterEach, beforeEach, describe, expect, it} from 'vitest'
import {
  autoLink,
  collectRepoTargets,
  defaultScanFs,
  matchCheckouts,
  normalizeGitHubRemote,
  readGitHubAliases,
  readGitRemotes,
  scanCheckouts,
  type Checkout,
  type ScanFs,
} from '../src/lib/discover'
import {type WorkspaceManifest, type WorkspaceManifestRepository} from '../src/lib/workspace-manifest'

// CYAU-87: the project → repo map comes from the host-scoped manifest, no longer from the agent targets.
function manifest(repositories: WorkspaceManifestRepository[]): WorkspaceManifest {
  return {version: 1, digest: 'd1', workspace_root_hint: 'Lavoro/Github/Personale', repositories}
}

const entry = (key: string, repo: string): WorkspaceManifestRepository =>
  ({project_key: key, path: repo.split('/').pop() ?? repo, repo, default_branch: 'main'})

describe('normalizeGitHubRemote', () => {
  it('SSH scp-like (git@github.com:owner/repo.git) → owner/repo', () => {
    expect(normalizeGitHubRemote('git@github.com:bussolabs/closeyourit-automator.git')).toBe('bussolabs/closeyourit-automator')
  })

  it('HTTPS with .git → owner/repo', () => {
    expect(normalizeGitHubRemote('https://github.com/bussolabs/closeyourit-automator.git')).toBe('bussolabs/closeyourit-automator')
  })

  it('HTTPS without .git and with trailing slash → owner/repo', () => {
    expect(normalizeGitHubRemote('https://github.com/acme/widget/')).toBe('acme/widget')
  })

  it('HTTPS with embedded credentials → owner/repo (no secret in the result)', () => {
    expect(normalizeGitHubRemote('https://user:ghp_secret@github.com/acme/widget.git')).toBe('acme/widget')
  })

  it('ssh:// with explicit port → owner/repo', () => {
    expect(normalizeGitHubRemote('ssh://git@github.com:22/acme/widget.git')).toBe('acme/widget')
  })

  it('git:// protocol → owner/repo', () => {
    expect(normalizeGitHubRemote('git://github.com/acme/widget.git')).toBe('acme/widget')
  })

  it('www.github.com is accepted', () => {
    expect(normalizeGitHubRemote('https://www.github.com/acme/widget')).toBe('acme/widget')
  })

  it('case-insensitive → lowercase key', () => {
    expect(normalizeGitHubRemote('git@github.com:Acme/Widget.GIT')).toBe('acme/widget')
  })

  it('extra segments beyond owner/repo are ignored', () => {
    expect(normalizeGitHubRemote('https://github.com/acme/widget/tree/main')).toBe('acme/widget')
  })

  it('host non-GitHub (gitlab) → null', () => {
    expect(normalizeGitHubRemote('git@gitlab.com:acme/widget.git')).toBeNull()
  })

  it('HTTPS non-GitHub → null', () => {
    expect(normalizeGitHubRemote('https://bitbucket.org/acme/widget.git')).toBeNull()
  })

  it('repo missing (owner only) → null', () => {
    expect(normalizeGitHubRemote('https://github.com/acme')).toBeNull()
  })

  it('empty string or only spaces → null', () => {
    expect(normalizeGitHubRemote('   ')).toBeNull()
    expect(normalizeGitHubRemote('')).toBeNull()
  })

  it('string not recognizable as a URL → null', () => {
    expect(normalizeGitHubRemote('non-un-remote')).toBeNull()
  })

  it('scp-like without owner/repo (host: repo only) → null', () => {
    expect(normalizeGitHubRemote('git@github.com:widget')).toBeNull()
  })
})

describe('collectRepoTargets', () => {
  it('extracts project → repo (lowercase) from the manifest entries', () => {
    const map = collectRepoTargets(manifest([entry('CYAU', 'bussolabs/closeyourit-automator')]))
    expect(map.get('CYAU')).toBe('bussolabs/closeyourit-automator')
  })

  it('skips the entries without project-key', () => {
    const map = collectRepoTargets(manifest([entry('CYAU', 'bussolabs/repo'), entry('   ', 'bussolabs/senza-key')]))
    expect([...map.keys()]).toEqual(['CYAU'])
  })

  it('dedup by key: the first entry wins if the key repeats', () => {
    const map = collectRepoTargets(manifest([entry('CYAU', 'bussolabs/repo'), entry('CYAU', 'bussolabs/altro')]))
    expect(map.get('CYAU')).toBe('bussolabs/repo')
    expect(map.size).toBe(1)
  })

  it('manifest without repositories → no target, no crash', () => {
    expect(collectRepoTargets(manifest([])).size).toBe(0)
  })

  it('discards the keys unsafe for bracket assignment', () => {
    const map = collectRepoTargets(manifest([entry('__proto__', 'bussolabs/ostile'), entry('CYAU', 'bussolabs/repo')]))
    expect([...map.keys()]).toEqual(['CYAU'])
  })

  it('repo with surrounding spaces is normalized', () => {
    const map = collectRepoTargets(manifest([{project_key: 'CYAU', path: 'repo', repo: '  Bussolabs/Repo  ', default_branch: 'main'}]))
    expect(map.get('CYAU')).toBe('bussolabs/repo')
  })
})

describe('matchCheckouts', () => {
  const checkout = (cwd: string, remotes: string[]): Checkout => ({cwd, remotes})

  it('unique match → matched', () => {
    const targets = new Map([['CYAU', 'bussolabs/repo']])
    const res = matchCheckouts(targets, [checkout('/repos/repo', ['git@github.com:bussolabs/repo.git'])])
    expect(res.matched).toEqual([{projectKey: 'CYAU', repo: 'bussolabs/repo', cwd: '/repos/repo'}])
    expect(res.ambiguous).toEqual([])
    expect(res.missing).toEqual([])
  })

  it('no checkout for the repo → missing', () => {
    const targets = new Map([['CYAU', 'bussolabs/repo']])
    const res = matchCheckouts(targets, [checkout('/repos/altro', ['git@github.com:bussolabs/altro.git'])])
    expect(res.missing).toEqual([{projectKey: 'CYAU', repo: 'bussolabs/repo'}])
    expect(res.matched).toEqual([])
  })

  it('several checkouts for the same repo → ambiguous with the sorted cwds (no guessing)', () => {
    const targets = new Map([['CYAU', 'bussolabs/repo']])
    const res = matchCheckouts(targets, [
      checkout('/repos/b-clone', ['https://github.com/bussolabs/repo.git']),
      checkout('/repos/a-clone', ['git@github.com:bussolabs/repo.git']),
    ])
    expect(res.matched).toEqual([])
    expect(res.ambiguous).toEqual([{projectKey: 'CYAU', repo: 'bussolabs/repo', cwds: ['/repos/a-clone', '/repos/b-clone']}])
  })

  it('SSH and HTTPS of the same repo in the same checkout → a single cwd (not ambiguous)', () => {
    const targets = new Map([['CYAU', 'bussolabs/repo']])
    const res = matchCheckouts(targets, [
      checkout('/repos/repo', ['git@github.com:bussolabs/repo.git', 'https://github.com/bussolabs/repo.git']),
    ])
    expect(res.matched).toEqual([{projectKey: 'CYAU', repo: 'bussolabs/repo', cwd: '/repos/repo'}])
  })

  it('non-GitHub remotes in the checkout are ignored', () => {
    const targets = new Map([['CYAU', 'bussolabs/repo']])
    const res = matchCheckouts(targets, [checkout('/repos/repo', ['git@gitlab.com:bussolabs/repo.git'])])
    expect(res.missing).toEqual([{projectKey: 'CYAU', repo: 'bussolabs/repo'}])
  })

  it('multiple targets → sorted by key', () => {
    const targets = new Map([
      ['ZED', 'bussolabs/zed'],
      ['ABC', 'bussolabs/abc'],
    ])
    const res = matchCheckouts(targets, [
      checkout('/repos/abc', ['git@github.com:bussolabs/abc.git']),
      checkout('/repos/zed', ['git@github.com:bussolabs/zed.git']),
    ])
    expect(res.matched.map((m) => m.projectKey)).toEqual(['ABC', 'ZED'])
  })
})

describe('scanCheckouts', () => {
  // virtual fs: map dir → {checkout?, linkedWorktree?, remotes?, children?}
  interface VNode {
    checkout?: boolean
    linkedWorktree?: boolean
    remotes?: string[]
    children?: string[]
  }
  const makeFs = (tree: Record<string, VNode>): ScanFs => ({
    readDir: (dir) => (tree[dir]?.children ?? []).map((name) => ({name, isDir: true})),
    isCheckout: (dir) => Boolean(tree[dir]?.checkout),
    isLinkedWorktree: (dir) => Boolean(tree[dir]?.linkedWorktree),
    readRemotes: (dir) => tree[dir]?.remotes ?? [],
  })

  it('the root itself is a checkout → found, without descending', () => {
    const fsDeps = makeFs({'/repo': {checkout: true, remotes: ['git@github.com:acme/repo.git'], children: ['dovrebbe-essere-ignorato']}})
    const res = scanCheckouts(['/repo'], fsDeps)
    expect(res).toEqual([{cwd: '/repo', remotes: ['git@github.com:acme/repo.git']}])
  })

  it('finds the child checkouts under a non-checkout root', () => {
    const fsDeps = makeFs({
      '/root': {children: ['a', 'b', 'node_modules']},
      '/root/a': {checkout: true, remotes: ['git@github.com:acme/a.git']},
      '/root/b': {checkout: true, remotes: ['git@github.com:acme/b.git']},
    })
    const res = scanCheckouts(['/root'], fsDeps)
    expect(res.map((c) => c.cwd).sort()).toEqual(['/root/a', '/root/b'])
  })

  it('does not enter a checkout (nested worktrees/submodules ignored)', () => {
    const fsDeps = makeFs({
      '/root': {children: ['repo']},
      '/root/repo': {checkout: true, remotes: ['git@github.com:acme/repo.git'], children: ['nested']},
      '/root/repo/nested': {checkout: true, remotes: ['git@github.com:acme/nested.git']},
    })
    const res = scanCheckouts(['/root'], fsDeps)
    expect(res.map((c) => c.cwd)).toEqual(['/root/repo'])
  })

  it('skips node_modules and the hidden directories', () => {
    const fsDeps = makeFs({
      '/root': {children: ['node_modules', '.hidden', 'ok']},
      '/root/node_modules': {checkout: true, remotes: ['git@github.com:x/nm.git']},
      '/root/.hidden': {checkout: true, remotes: ['git@github.com:x/hidden.git']},
      '/root/ok': {checkout: true, remotes: ['git@github.com:x/ok.git']},
    })
    const res = scanCheckouts(['/root'], fsDeps)
    expect(res.map((c) => c.cwd)).toEqual(['/root/ok'])
  })

  it('does not exceed maxDepth', () => {
    const fsDeps = makeFs({
      '/root': {children: ['l1']},
      '/root/l1': {children: ['l2']},
      '/root/l1/l2': {checkout: true, remotes: ['git@github.com:x/deep.git']},
    })
    expect(scanCheckouts(['/root'], fsDeps, 1)).toEqual([])
    expect(scanCheckouts(['/root'], fsDeps, 2).map((c) => c.cwd)).toEqual(['/root/l1/l2'])
  })

  it('deduplicates a checkout reachable from several roots', () => {
    const fsDeps = makeFs({
      '/root': {children: ['repo']},
      '/root/repo': {checkout: true, remotes: ['git@github.com:x/repo.git']},
    })
    const res = scanCheckouts(['/root', '/root/repo'], fsDeps)
    expect(res).toHaveLength(1)
  })

  it('ignores the non-directory entries', () => {
    const fsDeps: ScanFs = {
      readDir: () => [{name: 'file.txt', isDir: false}],
      isCheckout: () => false,
      isLinkedWorktree: () => false,
      readRemotes: () => [],
    }
    expect(scanCheckouts(['/root'], fsDeps)).toEqual([])
  })

  // CYAU-157: the convention puts the worktrees in a SIBLING folder (`<repo>.worktrees/<slug>`), no longer
  // hidden inside the repository. A worktree shares the remotes of the parent repository: counted as a checkout
  // it would make every project with an open run ambiguous. It is not a location of the repository, it is the
  // checkout of a run (someone else's branch, HEAD on another ticket) → it is skipped, without descending into it.
  it('the sibling worktree does not enter the checkouts and is not traversed', () => {
    const fsDeps = makeFs({
      '/root': {children: ['repo', 'repo.worktrees']},
      '/root/repo': {checkout: true, remotes: ['git@github.com:acme/repo.git']},
      '/root/repo.worktrees': {children: ['CYX-1']},
      '/root/repo.worktrees/CYX-1': {
        checkout: true,
        linkedWorktree: true,
        remotes: ['git@github.com:acme/repo.git'],
        children: ['annidato'],
      },
      '/root/repo.worktrees/CYX-1/annidato': {checkout: true, remotes: ['git@github.com:acme/annidato.git']},
    })
    expect(scanCheckouts(['/root'], fsDeps).map((c) => c.cwd)).toEqual(['/root/repo'])
  })

  it('root that IS a linked worktree → no checkout (never the repository location)', () => {
    const fsDeps = makeFs({
      '/root/repo.worktrees/CYX-1': {checkout: true, linkedWorktree: true, remotes: ['git@github.com:acme/repo.git']},
    })
    expect(scanCheckouts(['/root/repo.worktrees/CYX-1'], fsDeps)).toEqual([])
  })

  it('with an open worktree the project stays linkable, not ambiguous (CYAU-157)', () => {
    const fsDeps = makeFs({
      '/root': {children: ['repo', 'repo.worktrees']},
      '/root/repo': {checkout: true, remotes: ['git@github.com:acme/repo.git']},
      '/root/repo.worktrees': {children: ['CYX-1']},
      '/root/repo.worktrees/CYX-1': {checkout: true, linkedWorktree: true, remotes: ['git@github.com:acme/repo.git']},
    })
    const res = autoLink({targets: new Map([['ACME', 'acme/repo']]), checkouts: scanCheckouts(['/root'], fsDeps), hosts: {}})
    expect(res.ambiguous).toEqual([])
    expect(res.matched).toEqual([{projectKey: 'ACME', repo: 'acme/repo', cwd: '/root/repo'}])
  })
})

describe('autoLink', () => {
  const checkout = (cwd: string, remotes: string[]): Checkout => ({cwd, remotes})

  it('unique match not yet mapped → added to the host map, changed=true', () => {
    const res = autoLink({
      targets: new Map([['CYAU', 'bussolabs/repo']]),
      checkouts: [checkout('/repos/repo', ['git@github.com:bussolabs/repo.git'])],
      hosts: {},
    })
    expect(res.hosts).toEqual({CYAU: {cwd: '/repos/repo'}})
    expect(res.matched).toEqual([{projectKey: 'CYAU', repo: 'bussolabs/repo', cwd: '/repos/repo'}])
    expect(res.changed).toBe(true)
  })

  it('project already in the host map → unchanged, alreadyMapped, excluded from the matching', () => {
    const hosts = {CYAU: {cwd: '/scelta/manuale'}}
    const res = autoLink({
      targets: new Map([['CYAU', 'bussolabs/repo']]),
      checkouts: [checkout('/repos/repo', ['git@github.com:bussolabs/repo.git'])],
      hosts,
    })
    expect(res.alreadyMapped).toEqual(['CYAU'])
    expect(res.matched).toEqual([])
    expect(res.hosts.CYAU).toEqual({cwd: '/scelta/manuale'})
    expect(res.changed).toBe(false)
  })

  it('ambiguity → does not link, changed=false', () => {
    const res = autoLink({
      targets: new Map([['CYAU', 'bussolabs/repo']]),
      checkouts: [
        checkout('/repos/a', ['git@github.com:bussolabs/repo.git']),
        checkout('/repos/b', ['git@github.com:bussolabs/repo.git']),
      ],
      hosts: {},
    })
    expect(res.ambiguous).toHaveLength(1)
    expect(res.changed).toBe(false)
    expect(res.hosts).toEqual({})
  })

  it('missing repository → missing, changed=false', () => {
    const res = autoLink({
      targets: new Map([['CYAU', 'bussolabs/repo']]),
      checkouts: [],
      hosts: {},
    })
    expect(res.missing).toEqual([{projectKey: 'CYAU', repo: 'bussolabs/repo'}])
    expect(res.changed).toBe(false)
  })

  it('does not mutate the input host map (returns a new copy)', () => {
    const hosts = {}
    const res = autoLink({
      targets: new Map([['CYAU', 'bussolabs/repo']]),
      checkouts: [checkout('/repos/repo', ['git@github.com:bussolabs/repo.git'])],
      hosts,
    })
    expect(hosts).toEqual({})
    expect(res.hosts).not.toBe(hosts)
  })
})

describe('readGitRemotes / defaultScanFs (git reale)', () => {
  let dir: string
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'automator-discover-'))
  })
  afterEach(() => {
    fs.rmSync(dir, {recursive: true, force: true})
  })

  function gitInit(repo: string, remote?: string): void {
    fs.mkdirSync(repo, {recursive: true})
    spawnSync('git', ['-C', repo, 'init', '-q'], {encoding: 'utf8'})
    if (remote) spawnSync('git', ['-C', repo, 'remote', 'add', 'origin', remote], {encoding: 'utf8'})
  }

  it('reads the remotes of a real checkout (fetch/push dedup)', () => {
    const repo = path.join(dir, 'repo')
    gitInit(repo, 'git@github.com:acme/widget.git')
    expect(readGitRemotes(repo)).toEqual(['git@github.com:acme/widget.git'])
  })

  it('directory without git → no remote', () => {
    const plain = path.join(dir, 'plain')
    fs.mkdirSync(plain)
    expect(readGitRemotes(plain)).toEqual([])
  })

  it('defaultScanFs recognizes the checkout, lists the dirs and reads the remotes', () => {
    const repo = path.join(dir, 'repo')
    gitInit(repo, 'https://github.com/acme/widget.git')
    const scanFs = defaultScanFs()
    expect(scanFs.isCheckout(repo)).toBe(true)
    expect(scanFs.isCheckout(dir)).toBe(false)
    expect(scanFs.readDir(dir).map((e) => e.name)).toContain('repo')
    expect(scanFs.readRemotes(repo)).toEqual(['https://github.com/acme/widget.git'])
  })

  it('defaultScanFs.readDir on non-existent directory → empty (best-effort)', () => {
    expect(defaultScanFs().readDir(path.join(dir, 'non-esiste'))).toEqual([])
  })

  it('scanCheckouts end-to-end with real fs finds the child checkout', () => {
    const repo = path.join(dir, 'repo')
    gitInit(repo, 'git@github.com:acme/widget.git')
    const res = scanCheckouts([dir], defaultScanFs())
    expect(res).toEqual([{cwd: repo, remotes: ['git@github.com:acme/widget.git']}])
  })

  // Repository with a worktree in the sibling folder `<repo>.worktrees/<slug>`, as the convention wants.
  function repoWithSiblingWorktree(): {repo: string; worktree: string} {
    const repo = path.join(dir, 'repo')
    gitInit(repo, 'git@github.com:acme/widget.git')
    spawnSync('git', ['-C', repo, '-c', 'user.email=t@e.st', '-c', 'user.name=Test', 'commit', '-q', '--allow-empty', '-m', 'init'], {
      encoding: 'utf8',
    })
    const worktree = path.join(dir, 'repo.worktrees', 'CYX-1')
    const added = spawnSync('git', ['-C', repo, 'worktree', 'add', '-q', '-b', 'ticket/CYX-1', worktree], {encoding: 'utf8'})
    if (added.status !== 0) throw new Error(`git worktree add → ${added.stderr}`)
    return {repo, worktree}
  }

  it('defaultScanFs tells the linked worktree apart from the real checkout (real git)', () => {
    const {repo, worktree} = repoWithSiblingWorktree()
    const scanFs = defaultScanFs()

    expect(scanFs.isCheckout(worktree)).toBe(true) // the `.git` is there: it is a pointer file, not a directory
    expect(scanFs.isLinkedWorktree(worktree)).toBe(true)
    expect(scanFs.isLinkedWorktree(repo)).toBe(false)
    expect(scanFs.readRemotes(worktree)).toEqual(['git@github.com:acme/widget.git']) // same remotes as the parent
  })

  it('scanCheckouts end-to-end: the sibling worktree does not appear among the checkouts (CYAU-157)', () => {
    const {repo} = repoWithSiblingWorktree()
    expect(scanCheckouts([dir], defaultScanFs()).map((c) => c.cwd)).toEqual([repo])
  })

  it('defaultScanFs.isLinkedWorktree on non-git directory → false (best-effort)', () => {
    expect(defaultScanFs().isLinkedWorktree(dir)).toBe(false)
  })
})

describe('normalizeGitHubRemote with SSH aliases (githubHosts)', () => {
  const hosts = new Set(['github-personale'])

  it('alias scp-like riconosciuto come github', () => {
    expect(normalizeGitHubRemote('git@github-personale:bussolabs/repo.git', hosts)).toBe('bussolabs/repo')
  })

  it('alias in ssh:// URL', () => {
    expect(normalizeGitHubRemote('ssh://git@github-personale/bussolabs/repo.git', hosts)).toBe('bussolabs/repo')
  })

  it('without the set the alias is not github → null (regression: real checkouts were false missing)', () => {
    expect(normalizeGitHubRemote('git@github-personale:bussolabs/repo.git')).toBeNull()
  })
})

describe('readGitHubAliases', () => {
  it('maps the aliases with HostName github.com', () => {
    const cfg = 'Host github-personale\n  HostName github.com\n  User git\n'
    expect(readGitHubAliases(() => cfg).has('github-personale')).toBe(true)
  })

  it('block with several patterns → all the aliases', () => {
    const cfg = 'Host gh-a gh-b\n  HostName github.com\n'
    expect([...readGitHubAliases(() => cfg)].sort()).toEqual(['gh-a', 'gh-b'])
  })

  it('alias towards another host → excluded', () => {
    const cfg = 'Host gl\n  HostName gitlab.com\nHost gh\n  HostName github.com\n'
    const aliases = readGitHubAliases(() => cfg)
    expect(aliases.has('gl')).toBe(false)
    expect(aliases.has('gh')).toBe(true)
  })

  it('wildcard/negation patterns and literal github.com excluded', () => {
    const cfg = 'Host * !nope github.com real\n  HostName github.com\n'
    expect([...readGitHubAliases(() => cfg)]).toEqual(['real'])
  })

  it('keyword case-insensitive e separatore =', () => {
    const cfg = 'HOST=gh\n  HostName=github.com\n'
    expect(readGitHubAliases(() => cfg).has('gh')).toBe(true)
  })

  it('a Match block ends the current Host block', () => {
    const cfg = 'Host gh\n  HostName github.com\nMatch host x\n  HostName github.com\n'
    const aliases = readGitHubAliases(() => cfg)
    expect(aliases.has('gh')).toBe(true)
    expect(aliases.size).toBe(1)
  })

  it('comments and empty lines ignored', () => {
    const cfg = '# commento\n\nHost gh\n  HostName github.com\n'
    expect(readGitHubAliases(() => cfg).has('gh')).toBe(true)
  })

  it('throwing reader (missing file) → empty set', () => {
    expect(
      readGitHubAliases(() => {
        throw new Error('ENOENT')
      }).size,
    ).toBe(0)
  })

  it('default reader does not throw (uses the real ~/.ssh/config)', () => {
    expect(readGitHubAliases()).toBeInstanceOf(Set)
  })
})

describe('SSH aliases and unsafe keys (end-to-end)', () => {
  const checkout = (cwd: string, remotes: string[]): Checkout => ({cwd, remotes})

  it('matchCheckouts riconosce i checkout via alias SSH', () => {
    const res = matchCheckouts(
      new Map([['CYAU', 'bussolabs/repo']]),
      [checkout('/repos/repo', ['git@github-personale:bussolabs/repo.git'])],
      new Set(['github-personale']),
    )
    expect(res.matched).toEqual([{projectKey: 'CYAU', repo: 'bussolabs/repo', cwd: '/repos/repo'}])
  })

  it('autoLink propagates githubHosts (aliases) to the matching', () => {
    const res = autoLink({
      targets: new Map([['CYAU', 'bussolabs/repo']]),
      checkouts: [checkout('/repos/repo', ['git@gh-alias:bussolabs/repo.git'])],
      hosts: {},
      githubHosts: new Set(['gh-alias']),
    })
    expect(res.matched).toEqual([{projectKey: 'CYAU', repo: 'bussolabs/repo', cwd: '/repos/repo'}])
  })

  it('collectRepoTargets discards the unsafe keys (__proto__ etc.)', () => {
    const map = collectRepoTargets(manifest([entry('__proto__', 'x/y'), entry('CYAU', 'bussolabs/repo')]))
    expect(map.has('__proto__')).toBe(false)
    expect(map.has('CYAU')).toBe(true)
  })

  it('autoLink: a __proto__ key pollutes neither the host map nor the prototype', () => {
    const res = autoLink({
      targets: new Map([['__proto__', 'bussolabs/repo']]),
      checkouts: [checkout('/repos/repo', ['git@github.com:bussolabs/repo.git'])],
      hosts: {},
    })
    expect(Object.keys(res.hosts)).toEqual([])
    expect(res.changed).toBe(false)
    expect(({} as Record<string, unknown>).cwd).toBeUndefined()
  })
})
