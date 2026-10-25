import {spawnSync} from 'node:child_process'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest'
import {
  cloneUrl,
  composeManagedIgnore,
  defaultWorkspaceGit,
  type GitSpawnSync,
  isNested,
  isSafeSegment,
  planWorkspace,
  prepareWorkspace,
  remoteMatches,
  repositoryPath,
  resolveGhBinary,
  splitRepo,
  ticketBranch,
  worktreePath,
} from '../src/lib/workspace'
import {AutomatorError, ErrorCodes} from '../src/errors/error-codes'

describe('isSafeSegment', () => {
  it('accepts a simple name / with dots / with dashes', () => {
    expect(isSafeSegment('widget')).toBe(true)
    expect(isSafeSegment('my.repo')).toBe(true)
    expect(isSafeSegment('CYAU-11')).toBe(true)
  })

  it('rejects empty, "." and ".." (path traversal)', () => {
    expect(isSafeSegment('')).toBe(false)
    expect(isSafeSegment('.')).toBe(false)
    expect(isSafeSegment('..')).toBe(false)
  })

  it('rejects path separators and null bytes', () => {
    expect(isSafeSegment('a/b')).toBe(false)
    expect(isSafeSegment('a\\b')).toBe(false)
    expect(isSafeSegment('a\0b')).toBe(false)
  })

  it('rejects hostile keys (prototype pollution)', () => {
    expect(isSafeSegment('__proto__')).toBe(false)
    expect(isSafeSegment('prototype')).toBe(false)
    expect(isSafeSegment('constructor')).toBe(false)
  })
})

describe('splitRepo', () => {
  it('divide owner/repo', () => {
    expect(splitRepo('acme/widget')).toEqual({owner: 'acme', repo: 'widget'})
  })

  it('rejects without slash or with more than two segments', () => {
    expect(() => splitRepo('acme')).toThrow(AutomatorError)
    expect(() => splitRepo('acme/widget/extra')).toThrow(AutomatorError)
  })

  it('rejects a hostile segment (traversal)', () => {
    const err = (() => {
      try {
        splitRepo('acme/..')
      } catch (e) {
        return e
      }
    })()
    expect((err as AutomatorError).code).toBe(ErrorCodes.Workspace.unsafeSegment)
  })
})

describe('repositoryPath / worktreePath / ticketBranch / cloneUrl', () => {
  it('repositoryPath compone <base>/<owner>/<repo>', () => {
    expect(repositoryPath('acme/widget', '/data/repositories')).toBe('/data/repositories/acme/widget')
  })

  it('worktreePath compone <base>/<project>/<ticket>', () => {
    expect(worktreePath('CYAU', 'CYAU-11', '/data/worktrees')).toBe('/data/worktrees/CYAU/CYAU-11')
  })

  it('worktreePath rejects unsafe project/ticket', () => {
    expect(() => worktreePath('..', 'CYAU-11', '/w')).toThrow(AutomatorError)
    expect(() => worktreePath('CYAU', 'a/b', '/w')).toThrow(AutomatorError)
  })

  it('ticketBranch → ticket/<ticket>, rejects unsafe tickets', () => {
    expect(ticketBranch('CYAU-11')).toBe('ticket/CYAU-11')
    expect(() => ticketBranch('..')).toThrow(AutomatorError)
  })

  it('cloneUrl deriva l’URL HTTPS GitHub', () => {
    expect(cloneUrl('acme/widget')).toBe('https://github.com/acme/widget.git')
  })
})

describe('remoteMatches', () => {
  it('canonicalizes GitHub HTTPS and SSH against the expected full_name', () => {
    expect(remoteMatches('https://github.com/Acme/Widget.git', 'acme/widget')).toBe(true)
    expect(remoteMatches('git@github.com:acme/widget.git', 'acme/widget')).toBe(true)
    expect(remoteMatches('git@github.com:other/widget.git', 'acme/widget')).toBe(false)
    expect(remoteMatches('git@github.com:acme/widget.git', 'acme/widget', 'https://github.com/acme/widget.git')).toBe(true)
    expect(remoteMatches('git@github.com:acme/widget.git', 'acme/widget', 'https://github.com/other/widget.git')).toBe(false)
  })

  it('recognizes a declared SSH alias pointing to GitHub', () => {
    expect(remoteMatches('git@github-lavoro:Acme/Widget.git', 'acme/widget', undefined, new Set(['github-lavoro']))).toBe(true)
    expect(remoteMatches('git@github-lavoro:other/widget.git', 'acme/widget', undefined, new Set(['github-lavoro']))).toBe(false)
  })

  it('for an explicit local mirror requires the same URL without confusing it with the full_name', () => {
    expect(remoteMatches('/tmp/mirror.git', 'acme/widget', '/tmp/mirror.git')).toBe(true)
    expect(remoteMatches('/tmp/altro.git', 'acme/widget', '/tmp/mirror.git')).toBe(false)
    expect(remoteMatches('https://github.com/acme/widget.git', 'acme/widget', '/tmp/mirror.git')).toBe(false)
  })
})

describe('isNested', () => {
  it('equal paths → nested', () => {
    expect(isNested('/d/a', '/d/a')).toBe(true)
  })

  it('one inside the other (in both directions) → nested', () => {
    expect(isNested('/d/repo', '/d/repo/wt')).toBe(true)
    expect(isNested('/d/repo/wt', '/d/repo')).toBe(true)
  })

  it('siblings or unrelated → not nested', () => {
    expect(isNested('/d/repositories/a/b', '/d/worktrees/x/y')).toBe(false)
    expect(isNested('/d/repo', '/e/wt')).toBe(false)
  })
})

describe('planWorkspace', () => {
  const state = (o: Partial<Parameters<typeof planWorkspace>[0]> = {}): Parameters<typeof planWorkspace>[0] => ({
    repoExists: false,
    repoIsGit: false,
    worktreeExists: false,
    worktreeIsGit: false,
    ...o,
  })

  it('nothing exists → clone + add', () => {
    expect(planWorkspace(state())).toEqual({repoAction: 'clone', worktreeAction: 'add'})
  })

  it('git repo present, worktree missing → reuse + add', () => {
    expect(planWorkspace(state({repoExists: true, repoIsGit: true}))).toEqual({repoAction: 'reuse', worktreeAction: 'add'})
  })

  it('git repo and worktree present → reuse + reuse (idempotent)', () => {
    expect(planWorkspace(state({repoExists: true, repoIsGit: true, worktreeExists: true, worktreeIsGit: true}))).toEqual({
      repoAction: 'reuse',
      worktreeAction: 'reuse',
    })
  })

  it('repository path occupied by non-git → error, not overwritten', () => {
    const err = (() => {
      try {
        planWorkspace(state({repoExists: true, repoIsGit: false}))
      } catch (e) {
        return e
      }
    })()
    expect((err as AutomatorError).code).toBe(ErrorCodes.Workspace.occupied)
  })

  it('worktree path occupied by non-git → error, not overwritten', () => {
    expect(() => planWorkspace(state({worktreeExists: true, worktreeIsGit: false}))).toThrow(AutomatorError)
  })
})

// Fake Git recording the calls: isolates the orchestration (default URL/branch) from the real git.
function fakeGit(
  state: Partial<import('../src/lib/workspace').WorkspaceState> & {
    localConfig?: Record<string, string>
    hasBranch?: boolean
    fetchFails?: boolean
    defaultRemoteBranch?: string | null
    ghBinary?: string | null
  } = {},
): {
  git: import('../src/lib/workspace').WorkspaceGit
  clones: Array<{url: string; dest: string}>
  worktrees: Array<{repoDir: string; worktreeDir: string; branch: string; createBranch: boolean; startPoint?: string}>
  fetched: string[]
  localConfig: Map<string, string>
  managedIgnore: string[]
} {
  const clones: Array<{url: string; dest: string}> = []
  const worktrees: Array<{repoDir: string; worktreeDir: string; branch: string; createBranch: boolean; startPoint?: string}> = []
  const fetched: string[] = []
  const localConfig = new Map<string, string>(Object.entries(state.localConfig ?? {}))
  const managedIgnore: string[] = []
  return {
    clones,
    worktrees,
    fetched,
    localConfig,
    managedIgnore,
    git: {
      ghBinary: () => (state.ghBinary === undefined ? '/usr/bin/gh' : state.ghBinary),
      exists: () => state.repoExists ?? false,
      isGitCheckout: () => state.repoIsGit ?? false,
      clone: (url, dest) => clones.push({url, dest}),
      hasBranch: () => state.hasBranch ?? false,
      fetchOrigin: (repoDir) => {
        if (state.fetchFails) throw new Error('rete giù')
        fetched.push(repoDir)
      },
      defaultRemoteBranch: () => (state.defaultRemoteBranch === undefined ? 'origin/main' : state.defaultRemoteBranch),
      addWorktree: (repoDir, worktreeDir, branch, createBranch, startPoint) =>
        worktrees.push({repoDir, worktreeDir, branch, createBranch, startPoint}),
      remoteUrl: () => 'https://github.com/acme/widget.git',
      worktreeInfo: () => ({branch: 'ticket/CYAU-11', detached: false}),
      currentBranch: () => 'ticket/CYAU-11',
      localConfig: (_repoDir, key) => localConfig.get(key) ?? null,
      setLocalConfig: (_repoDir, key, value) => { localConfig.set(key, value) },
      ensureManagedIgnore: (repoDir) => { managedIgnore.push(repoDir) },
    },
  }
}

describe('composeManagedIgnore (CYAU-142)', () => {
  const BEGIN = '# >>> closeyourit-automator (CYAU-142) — dependency install output, non committare >>>'
  const END = '# <<< closeyourit-automator (CYAU-142) <<<'
  // Only unambiguous patterns: never names a project could version as source (no /gems/,
  // /cache/, /specifications/, /extensions/ — they would hide new legitimate files in same-named dirs).
  const patterns = ['/.bundle/', '/vendor/bundle/', 'node_modules/', '__pycache__/', '*.gem']

  it('on missing file composes the managed block with the unambiguous dependency-install patterns', () => {
    const {content, changed} = composeManagedIgnore(null)
    expect(changed).toBe(true)
    for (const p of patterns) expect(content).toContain(p)
    expect(content).not.toContain('/gems/')
    expect(content).not.toContain('/cache/')
    expect(content.endsWith('\n')).toBe(true)
  })

  it('appends at the end PRESERVING the hand-written lines', () => {
    const {content, changed} = composeManagedIgnore('# mia regola\n*.log\n')
    expect(changed).toBe(true)
    expect(content).toContain('# mia regola')
    expect(content).toContain('*.log')
    expect(content).toContain('node_modules/')
  })

  it('is idempotent: reapplying it on its own output changes nothing', () => {
    const first = composeManagedIgnore(null)
    const second = composeManagedIgnore(first.content)
    expect(second.changed).toBe(false)
    expect(second.content).toBe(first.content)
  })

  it('appends a line break if the existing file does not end with a newline', () => {
    const {content} = composeManagedIgnore('*.log')
    expect(content).toContain('*.log\n')
    expect(content).toContain('node_modules/')
  })

  it('replaces in place a managed block of a previous version, without touching the rest', () => {
    const stale = `coda utente\n${BEGIN}\n/vecchio/\n${END}\n`
    const {content, changed} = composeManagedIgnore(stale)
    expect(changed).toBe(true)
    expect(content).toContain('coda utente')
    expect(content).not.toContain('/vecchio/')
    expect(content).toContain('node_modules/')
  })

  // Regression (Codex review): a TRUNCATED block (start marker without the end one) must not, at the
  // next repair, make the user rules disappear. With the old logic the first marker paired
  // with the end marker of the just-appended block, swallowing everything in between.
  it('a truncated block converges without swallowing the user rules over two passes', () => {
    const troncato = `REGOLA_UTENTE_PRIMA\n*.log\n${BEGIN}\n/orfano/\n`
    const first = composeManagedIgnore(troncato)
    const second = composeManagedIgnore(first.content)
    // idempotent and convergent
    expect(second.changed).toBe(false)
    expect(second.content).toBe(first.content)
    // the rules written BEFORE the marker stay, the block appears only once
    expect(second.content).toContain('REGOLA_UTENTE_PRIMA')
    expect(second.content).toContain('*.log')
    expect(second.content.match(new RegExp(BEGIN.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'g'))?.length).toBe(1)
  })
})

describe('prepareWorkspace (orchestration with fake git)', () => {
  it('applies the managed ignore to the repository (DoD CYAU-142)', () => {
    const f = fakeGit()
    prepareWorkspace(
      {fullName: 'acme/widget', projectKey: 'ACME', ticket: 'CYAU-11', reposBase: '/r', worktreesBase: '/w'},
      f.git,
    )
    expect(f.managedIgnore).toEqual(['/r/acme/widget'])
  })

  it('without explicit URL derives the HTTPS URL from owner/repo; without branch uses ticket/<ticket>', () => {
    const f = fakeGit()
    const res = prepareWorkspace(
      {fullName: 'acme/widget', projectKey: 'ACME', ticket: 'CYAU-11', reposBase: '/data/repositories', worktreesBase: '/data/worktrees'},
      f.git,
    )

    expect(f.clones).toEqual([{url: 'https://github.com/acme/widget.git', dest: '/data/repositories/acme/widget'}])
    expect(f.worktrees).toEqual([
      {
        repoDir: '/data/repositories/acme/widget',
        worktreeDir: '/data/worktrees/ACME/CYAU-11',
        branch: 'ticket/CYAU-11',
        createBranch: true,
        startPoint: 'origin/main',
      },
    ])
    expect(res.branch).toBe('ticket/CYAU-11')
  })

  // The defect: `git worktree add -b <branch> <dir>` without a start point uses the repository HEAD,
  // which in the reference clone is the LOCAL `main` — and nobody advances that one. When it was
  // discovered it was four days and 165 commits behind, and realigning it by hand is not enough: after a single
  // release it is behind again. The assistant thus worked on an old snapshot.
  describe('the ticket branch starts from the remote, not from the local HEAD', () => {
    it('updates the refs and starts from the remote default branch', () => {
      const f = fakeGit()
      prepareWorkspace(
        {fullName: 'acme/widget', projectKey: 'ACME', ticket: 'CYAU-11', reposBase: '/r', worktreesBase: '/w'},
        f.git,
      )

      expect(f.fetched).toEqual(['/r/acme/widget'])
      expect(f.worktrees[0].startPoint).toBe('origin/main')
    })

    it('respects a default branch other than main', () => {
      const f = fakeGit({defaultRemoteBranch: 'origin/trunk'})
      prepareWorkspace(
        {fullName: 'acme/widget', projectKey: 'ACME', ticket: 'CYAU-11', reposBase: '/r', worktreesBase: '/w'},
        f.git,
      )

      expect(f.worktrees[0].startPoint).toBe('origin/trunk')
    })

    // Fail-closed: without a start point it would silently fall back on exactly the behaviour this
    // change exists to remove, and it is a defect that is invisible until it does damage.
    it('without a resolvable default branch it stops instead of guessing', () => {
      const f = fakeGit({defaultRemoteBranch: null})

      expect(() => prepareWorkspace(
        {fullName: 'acme/widget', projectKey: 'ACME', ticket: 'CYAU-11', reposBase: '/r', worktreesBase: '/w'},
        f.git,
      )).toThrow(AutomatorError)
      expect(f.worktrees).toEqual([])
    })

    // The fetch instead is tolerant: falling back on slightly old refs stays much better than the local `main`,
    // and stopping every run for a network blip would be worse than the disease.
    it('a network outage does not block the run: it still starts from the remote-tracking ref', () => {
      const f = fakeGit({fetchFails: true})
      prepareWorkspace(
        {fullName: 'acme/widget', projectKey: 'ACME', ticket: 'CYAU-11', reposBase: '/r', worktreesBase: '/w'},
        f.git,
      )

      expect(f.fetched).toEqual([])
      expect(f.worktrees[0].startPoint).toBe('origin/main')
    })

    // Resuming a run: the branch already exists and must be reused as is. A start point here
    // would be an error, not an improvement — it would move work already done.
    it('an already existing branch is reused, without start point nor fetch', () => {
      const f = fakeGit({hasBranch: true})
      prepareWorkspace(
        {fullName: 'acme/widget', projectKey: 'ACME', ticket: 'CYAU-11', reposBase: '/r', worktreesBase: '/w'},
        f.git,
      )

      expect(f.worktrees[0]).toMatchObject({createBranch: false, startPoint: undefined})
      expect(f.fetched).toEqual([])
    })
  })

  it('explicit branch is propagated to addWorktree', () => {
    const f = fakeGit()
    prepareWorkspace(
      {fullName: 'acme/widget', projectKey: 'ACME', ticket: 'CYAU-11', branch: 'ticket/custom', url: 'file:///x', reposBase: '/r', worktreesBase: '/w'},
      f.git,
    )

    expect(f.clones[0].url).toBe('file:///x')
    expect(f.worktrees[0].branch).toBe('ticket/custom')
  })

  // In agent sessions `GIT_CONFIG_GLOBAL` is emptied, so `~/.gitconfig` — where the credential
  // helper lives — is invisible: the agent implemented and committed, then "git push has no working credential" and the
  // delivery was lost. The LOCAL config is the only one git still reads in there.
  it('leaves the repository able to publish: helper and postBuffer in the local config', () => {
    const f = fakeGit({repoExists: false, repoIsGit: false})

    prepareWorkspace(
      {fullName: 'acme/widget', projectKey: 'ACME', ticket: 'CYAU-11', reposBase: '/data/repositories', worktreesBase: '/data/worktrees'},
      f.git,
    )

    expect(f.localConfig.get('credential.https://github.com.helper')).toMatch(/^!\S*gh auth git-credential$/)
    expect(f.localConfig.get('http.postBuffer')).toBe(String(512 * 1024 * 1024))
  })

  // CYRA-914 D5: the lookup of `gh` is injected, so the test no longer depends on the machine running it.
  it('writes no credential helper when gh cannot be found, rather than a broken one', () => {
    const f = fakeGit({repoExists: false, repoIsGit: false, ghBinary: null})

    prepareWorkspace(
      {fullName: 'acme/widget', projectKey: 'ACME', ticket: 'CYAU-11', reposBase: '/data/repositories', worktreesBase: '/data/worktrees'},
      f.git,
    )

    expect(f.localConfig.has('credential.https://github.com.helper')).toBe(false)
    expect(f.localConfig.get('http.postBuffer')).toBe(String(512 * 1024 * 1024))
  })

  // Older releases followed the mise shim to the mise binary and wrote this helper: it answers
  // nothing, so every push failed. It is ours and broken, never a hand-made choice: repair it.
  it('repairs the helper an older release wrote through the mise shim', () => {
    const f = fakeGit({
      repoExists: true, repoIsGit: true,
      localConfig: {'credential.https://github.com.helper': '!/home/u/.local/bin/mise auth git-credential'},
    })

    prepareWorkspace(
      {fullName: 'acme/widget', projectKey: 'ACME', ticket: 'CYAU-11', reposBase: '/data/repositories', worktreesBase: '/data/worktrees'},
      f.git,
    )

    expect(f.localConfig.get('credential.https://github.com.helper')).toBe('!/usr/bin/gh auth git-credential')
  })

  it('does not overwrite a configuration already chosen by hand', () => {
    const f = fakeGit({
      repoExists: true, repoIsGit: true,
      localConfig: {'credential.https://github.com.helper': '!custom-helper'},
    })

    prepareWorkspace(
      {fullName: 'acme/widget', projectKey: 'ACME', ticket: 'CYAU-11', reposBase: '/data/repositories', worktreesBase: '/data/worktrees'},
      f.git,
    )

    expect(f.localConfig.get('credential.https://github.com.helper')).toBe('!custom-helper')
    // The keys not yet present are completed anyway.
    expect(f.localConfig.get('http.postBuffer')).toBe(String(512 * 1024 * 1024))
  })
})

// --- Real probes with real git on temporary local repositories (no network, no mock). ---
describe('prepareWorkspace / defaultWorkspaceGit (real git)', () => {
  let root: string
  let origin: string
  let reposBase: string
  let worktreesBase: string

  function git(args: string[]): void {
    const res = spawnSync('git', args, {encoding: 'utf8'})
    if (res.status !== 0) throw new Error(`git ${args.join(' ')} → ${res.stderr}`)
  }

  function currentBranch(dir: string): string {
    return spawnSync('git', ['-C', dir, 'rev-parse', '--abbrev-ref', 'HEAD'], {encoding: 'utf8'}).stdout.trim()
  }

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'automator-workspace-'))
    reposBase = path.join(root, 'repositories')
    worktreesBase = path.join(root, 'worktrees')
    // Local "origin" with a commit on the main branch: offline clone source.
    origin = path.join(root, 'origin')
    fs.mkdirSync(origin, {recursive: true})
    git(['-C', origin, 'init', '-q', '-b', 'main'])
    fs.writeFileSync(path.join(origin, 'README.md'), '# widget\n')
    git(['-C', origin, 'add', '.'])
    git(['-C', origin, '-c', 'user.email=t@e.st', '-c', 'user.name=Test', 'commit', '-qm', 'init'])
  })

  afterEach(() => {
    fs.rmSync(root, {recursive: true, force: true})
  })

  const prepare = (ticket: string, projectKey = 'ACME'): ReturnType<typeof prepareWorkspace> =>
    prepareWorkspace({fullName: 'acme/widget', projectKey, ticket, url: origin, reposBase, worktreesBase})

  it('missing checkout → clones the repo and creates the isolated worktree on the ticket branch', () => {
    const res = prepare('CYAU-11')

    expect(res.repoAction).toBe('clone')
    expect(res.worktreeAction).toBe('add')
    expect(res.repoPath).toBe(path.join(reposBase, 'acme', 'widget'))
    expect(res.worktreePath).toBe(path.join(worktreesBase, 'ACME', 'CYAU-11'))
    expect(res.branch).toBe('ticket/CYAU-11')
    expect(fs.existsSync(path.join(res.repoPath, '.git'))).toBe(true)
    expect(fs.existsSync(path.join(res.worktreePath, '.git'))).toBe(true)
    expect(fs.existsSync(path.join(res.worktreePath, 'README.md'))).toBe(true)
    expect(currentBranch(res.worktreePath)).toBe('ticket/CYAU-11')
  })

  // DoD CYAU-142: a `bundle install`/`npm install` with a path inside the worktree must not be
  // stageable, while legitimate code must. The managed `info/exclude` ignores only UNTRACKED files → no
  // false positive on the real work.
  it('the output of a dependency-install in the worktree is not stageable, the code is (managed info/exclude)', () => {
    const res = prepare('CYAU-142')

    const rel = spawnSync('git', ['-C', res.repoPath, 'rev-parse', '--git-path', 'info/exclude'], {encoding: 'utf8'}).stdout.trim()
    const excludePath = path.isAbsolute(rel) ? rel : path.join(res.repoPath, rel)
    expect(fs.readFileSync(excludePath, 'utf8')).toContain('node_modules/')

    fs.mkdirSync(path.join(res.worktreePath, 'vendor', 'bundle', 'ruby'), {recursive: true})
    fs.writeFileSync(path.join(res.worktreePath, 'vendor', 'bundle', 'ruby', 'lib.rb'), 'x\n')
    fs.mkdirSync(path.join(res.worktreePath, 'node_modules', 'pkg'), {recursive: true})
    fs.writeFileSync(path.join(res.worktreePath, 'node_modules', 'pkg', 'index.js'), 'x\n')
    fs.writeFileSync(path.join(res.worktreePath, 'app.rb'), 'puts 1\n')

    git(['-C', res.worktreePath, 'add', '-A'])
    const staged = spawnSync('git', ['-C', res.worktreePath, 'diff', '--cached', '--name-only'], {encoding: 'utf8'}).stdout
    expect(staged).toContain('app.rb')
    expect(staged).not.toContain('vendor/bundle/')
    expect(staged).not.toContain('node_modules/')
  })

  it('ensureManagedIgnore is best-effort on a non-git dir: it does not throw and writes nothing', () => {
    const plain = fs.mkdtempSync(path.join(os.tmpdir(), 'automator-nongit-'))
    expect(() => defaultWorkspaceGit().ensureManagedIgnore(plain)).not.toThrow()
    expect(fs.readdirSync(plain)).toEqual([])
    fs.rmSync(plain, {recursive: true, force: true})
  })

  it('ensureManagedIgnore is idempotent: the second application does not rewrite info/exclude', () => {
    const res = prepare('CYAU-11')
    const rel = spawnSync('git', ['-C', res.repoPath, 'rev-parse', '--git-path', 'info/exclude'], {encoding: 'utf8'}).stdout.trim()
    const excludePath = path.isAbsolute(rel) ? rel : path.join(res.repoPath, rel)
    const before = fs.readFileSync(excludePath, 'utf8')
    defaultWorkspaceGit().ensureManagedIgnore(res.repoPath)
    expect(fs.readFileSync(excludePath, 'utf8')).toBe(before)
  })

  it('ensureManagedIgnore recreates info/exclude if missing', () => {
    const res = prepare('CYAU-11')
    const rel = spawnSync('git', ['-C', res.repoPath, 'rev-parse', '--git-path', 'info/exclude'], {encoding: 'utf8'}).stdout.trim()
    const excludePath = path.isAbsolute(rel) ? rel : path.join(res.repoPath, rel)
    fs.rmSync(excludePath, {force: true})
    defaultWorkspaceGit().ensureManagedIgnore(res.repoPath)
    expect(fs.readFileSync(excludePath, 'utf8')).toContain('node_modules/')
  })

  it('rerun for the same ticket is idempotent and PRESERVES the unmerged work', () => {
    const first = prepare('CYAU-11')
    // Uncommitted work in the worktree: it must never be deleted.
    fs.writeFileSync(path.join(first.worktreePath, 'wip.txt'), 'work in progress\n')
    const probe = defaultWorkspaceGit()
    expect(probe.worktreeInfo(first.repoPath, first.worktreePath)).toEqual({branch: 'ticket/CYAU-11', detached: false})
    expect(probe.currentBranch(first.worktreePath)).toBe('ticket/CYAU-11')

    const second = prepare('CYAU-11')

    expect(second.repoAction).toBe('reuse')
    expect(second.worktreeAction).toBe('reuse')
    expect(fs.readFileSync(path.join(second.worktreePath, 'wip.txt'), 'utf8')).toBe('work in progress\n')
  })

  it('rejects the reuse if origin belongs to a different repository and preserves the work', () => {
    const first = prepare('CYAU-11')
    fs.writeFileSync(path.join(first.worktreePath, 'wip.txt'), 'preserva\n')
    git(['-C', first.repoPath, 'remote', 'set-url', 'origin', path.join(root, 'altro-origin')])

    expect(() => prepare('CYAU-11')).toThrowError(expect.objectContaining({code: ErrorCodes.Workspace.mismatch}))
    expect(fs.readFileSync(path.join(first.worktreePath, 'wip.txt'), 'utf8')).toBe('preserva\n')
  })

  it('rejects a worktree on the OTHER branch without reset or clean', () => {
    const first = prepare('CYAU-11')
    git(['-C', first.worktreePath, 'switch', '-c', 'ticket/OTHER'])
    fs.writeFileSync(path.join(first.worktreePath, 'wip.txt'), 'branch sbagliato\n')

    expect(() => prepare('CYAU-11')).toThrowError(expect.objectContaining({code: ErrorCodes.Workspace.mismatch}))
    expect(currentBranch(first.worktreePath)).toBe('ticket/OTHER')
    expect(fs.readFileSync(path.join(first.worktreePath, 'wip.txt'), 'utf8')).toBe('branch sbagliato\n')
  })

  it('rejects a detached HEAD worktree without modifying it', () => {
    const first = prepare('CYAU-11')
    git(['-C', first.worktreePath, 'checkout', '--detach', 'HEAD'])

    expect(() => prepare('CYAU-11')).toThrowError(expect.objectContaining({code: ErrorCodes.Workspace.mismatch}))
    expect(currentBranch(first.worktreePath)).toBe('HEAD')
  })

  it('rejects a valid Git checkout not registered as a worktree of the expected repository', () => {
    const repoPath = repositoryPath('acme/widget', reposBase)
    const wtPath = worktreePath('ACME', 'CYAU-11', worktreesBase)
    defaultWorkspaceGit().clone(origin, repoPath)
    fs.mkdirSync(path.dirname(wtPath), {recursive: true})
    git(['clone', '--', origin, wtPath])

    expect(() => prepare('CYAU-11')).toThrowError(expect.objectContaining({code: ErrorCodes.Workspace.mismatch}))
    expect(fs.existsSync(path.join(wtPath, 'README.md'))).toBe(true)
  })

  it('second ticket → reuses the already cloned repo, adds a distinct worktree', () => {
    prepare('CYAU-11')
    const res = prepare('CYAU-12')

    expect(res.repoAction).toBe('reuse')
    expect(res.worktreeAction).toBe('add')
    expect(res.worktreePath).toBe(path.join(worktreesBase, 'ACME', 'CYAU-12'))
    expect(currentBranch(res.worktreePath)).toBe('ticket/CYAU-12')
    // The two worktrees coexist, each isolated.
    expect(fs.existsSync(path.join(worktreesBase, 'ACME', 'CYAU-11'))).toBe(true)
  })

  it('an already existing ticket branch is reused (checkout, not recreated)', () => {
    const repoPath = repositoryPath('acme/widget', reposBase)
    prepareWorkspace({fullName: 'acme/widget', projectKey: 'ACME', ticket: 'CYAU-11', url: origin, reposBase, worktreesBase})
    // Remove only the worktree dir (simulates a cleaned-up worktree) leaving the branch in the repo.
    git(['-C', repoPath, 'worktree', 'remove', '--force', path.join(worktreesBase, 'ACME', 'CYAU-11')])
    expect(defaultWorkspaceGit().hasBranch(repoPath, 'ticket/CYAU-11')).toBe(true)

    const res = prepareWorkspace({fullName: 'acme/widget', projectKey: 'ACME', ticket: 'CYAU-11', url: origin, reposBase, worktreesBase})

    expect(res.worktreeAction).toBe('add')
    expect(currentBranch(res.worktreePath)).toBe('ticket/CYAU-11')
  })

  it('repository path occupied by a non-git directory → error, folder preserved', () => {
    const repoPath = repositoryPath('acme/widget', reposBase)
    fs.mkdirSync(repoPath, {recursive: true})
    fs.writeFileSync(path.join(repoPath, 'personale.txt'), 'roba dell’operatore\n')

    expect(() => prepare('CYAU-11')).toThrow(AutomatorError)
    expect(fs.existsSync(path.join(repoPath, 'personale.txt'))).toBe(true)
  })

  it('nested layout (worktree inside the repository) → rejected before touching git', () => {
    expect(() =>
      prepareWorkspace({
        fullName: 'acme/widget',
        projectKey: 'ACME',
        ticket: 'CYAU-11',
        url: origin,
        reposBase,
        worktreesBase: path.join(reposBase, 'acme', 'widget', 'nested'),
      }),
    ).toThrow(AutomatorError)
    expect(fs.existsSync(path.join(reposBase, 'acme', 'widget'))).toBe(false)
  })

  it('defaultWorkspaceGit: exists/isGitCheckout recognize a real clone', () => {
    const res = prepare('CYAU-11')
    const g = defaultWorkspaceGit()
    expect(g.exists(res.repoPath)).toBe(true)
    expect(g.isGitCheckout(res.repoPath)).toBe(true)
    expect(g.isGitCheckout(root)).toBe(false)
  })

  it('defaultWorkspaceGit.clone su URL inesistente → AutomatorError gitFailed', () => {
    const g = defaultWorkspaceGit()
    const err = (() => {
      try {
        g.clone(path.join(root, 'non-esiste'), path.join(reposBase, 'x', 'y'))
      } catch (e) {
        return e
      }
    })()
    expect((err as AutomatorError).code).toBe(ErrorCodes.Workspace.gitFailed)
  })

  it('defaultWorkspaceGit.addWorktree on a path already in use → AutomatorError gitFailed', () => {
    const res = prepare('CYAU-11')
    const g = defaultWorkspaceGit()
    // Re-adding a worktree on the same (already registered) path fails on the git side.
    expect(() => g.addWorktree(res.repoPath, res.worktreePath, 'ticket/CYAU-11', false)).toThrow(AutomatorError)
  })
})

describe('defaultWorkspaceGit(): network commands with a time cap', () => {
  let base: string

  const fakeSpawn = (stdout = '') =>
    vi.fn(() => ({status: 0, stdout, stderr: ''})) as unknown as GitSpawnSync

  const callsOf = (spawn: GitSpawnSync) =>
    (spawn as unknown as {mock: {calls: [string, string[], {timeout?: number; env?: NodeJS.ProcessEnv}][]}}).mock.calls

  beforeEach(() => {
    base = fs.mkdtempSync(path.join(os.tmpdir(), 'cyau-net-'))
  })

  afterEach(() => {
    fs.rmSync(base, {recursive: true, force: true})
  })

  it('clone passes a timeout and forbids credential prompts', () => {
    const spawn = fakeSpawn()
    defaultWorkspaceGit(spawn).clone('https://example.invalid/x.git', path.join(base, 'repo'))
    const [, , options] = callsOf(spawn)[0]
    expect(options.timeout).toBeGreaterThan(0)
    expect(options.env?.GIT_TERMINAL_PROMPT).toBe('0')
  })

  it('fetchOrigin passes a timeout and forbids credential prompts', () => {
    const spawn = fakeSpawn()
    defaultWorkspaceGit(spawn).fetchOrigin(base)
    const [, , options] = callsOf(spawn)[0]
    expect(options.timeout).toBeGreaterThan(0)
    expect(options.env?.GIT_TERMINAL_PROMPT).toBe('0')
  })

  it('defaultRemoteBranch also caps the repair round towards the remote', () => {
    // The first read fails → `remote set-head --auto` queries the remote: that is the network call.
    const spawn = vi.fn((_file: string, args: string[]) =>
      args.includes('set-head') || args.includes('symbolic-ref')
        ? {status: args.includes('symbolic-ref') ? 1 : 0, stdout: '', stderr: ''}
        : {status: 0, stdout: '', stderr: ''},
    ) as unknown as GitSpawnSync
    defaultWorkspaceGit(spawn).defaultRemoteBranch(base)
    expect(callsOf(spawn).length).toBeGreaterThanOrEqual(2)
    for (const [, , options] of callsOf(spawn)) {
      expect(options.timeout).toBeGreaterThan(0)
      expect(options.env?.GIT_TERMINAL_PROMPT).toBe('0')
    }
  })

  it('the time cap is configurable', () => {
    const spawn = fakeSpawn()
    defaultWorkspaceGit(spawn, 4_242).fetchOrigin(base)
    expect(callsOf(spawn)[0][2].timeout).toBe(4_242)
  })
})

describe('resolveGhBinary', () => {
  // Fake spawn: answers the three lookups resolveGhBinary makes, by the command it receives.
  function fakeSpawn(answers: Record<string, string | null>) {
    return ((cmd: string, args: readonly string[]) => {
      const key = cmd === 'sh' ? args[1] : `${cmd} ${args.join(' ')}`
      const out = answers[key]
      return {status: out === null || out === undefined ? 1 : 0, stdout: out ? `${out}\n` : ''}
    }) as unknown as typeof spawnSync
  }

  it('follows a plain symlink to the real gh', () => {
    const spawn = fakeSpawn({'command -v gh': '/usr/local/bin/gh', 'readlink -f /usr/local/bin/gh': '/opt/gh/bin/gh'})
    expect(resolveGhBinary(spawn)).toBe('/opt/gh/bin/gh')
  })

  it('asks mise for the real gh when the shim resolves to the mise binary', () => {
    // mise shims are symlinks to mise itself: following them gave `!mise auth git-credential`,
    // a helper that answers nothing, and every push failed with "could not read Username".
    const spawn = fakeSpawn({
      'command -v gh': '/home/u/.local/share/mise/shims/gh',
      'readlink -f /home/u/.local/share/mise/shims/gh': '/home/u/.local/bin/mise',
      'mise which gh': '/home/u/.local/share/mise/installs/gh/2.96.0/bin/gh',
    })
    expect(resolveGhBinary(spawn)).toBe('/home/u/.local/share/mise/installs/gh/2.96.0/bin/gh')
  })

  it('returns null rather than a helper that is not gh', () => {
    const spawn = fakeSpawn({
      'command -v gh': '/home/u/.local/share/mise/shims/gh',
      'readlink -f /home/u/.local/share/mise/shims/gh': '/home/u/.local/bin/mise',
      'mise which gh': null,
    })
    expect(resolveGhBinary(spawn)).toBeNull()
  })
})
