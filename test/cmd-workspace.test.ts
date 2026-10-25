import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import {spawnSync} from 'node:child_process'
import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest'
import Workspace from '../src/commands/workspace'
import {saveSecrets} from '../src/lib/config'
import {runCaptured, runExpectingExit} from './helpers/command'

let configDir: string
let dataDir: string
let origin: string
const savedEnv = {...process.env}

interface RemoteTarget {
  key: string
  repo: string | null
}

// Envelope as sent by /api/v1/agent_host/workspace_manifest: the repositories that belong to THIS host.
// A project without a GitHub repo does not appear in the manifest — the server excludes it upstream (CYAU-87).
function stubManifest(targets: RemoteTarget[]): void {
  const manifest = {
    version: 1,
    digest: 'd1',
    workspace_root_hint: 'Lavoro/Github/Personale',
    repositories: targets
      .filter((t) => Boolean(t.repo))
      .map((t) => ({project_key: t.key, path: String(t.repo).split('/').pop(), repo: t.repo, default_branch: 'main'})),
  }
  vi.stubGlobal('fetch', vi.fn(async () => ({ok: true, json: async () => ({data: manifest})}) as unknown as Response))
}

function stubFetchFailed(): void {
  vi.stubGlobal('fetch', vi.fn(async () => ({ok: false, json: async () => ({})}) as unknown as Response))
}

function git(args: string[]): void {
  const res = spawnSync('git', args, {encoding: 'utf8'})
  if (res.status !== 0) throw new Error(`git ${args.join(' ')} → ${res.stderr}`)
}

function branchOf(dir: string): string {
  return spawnSync('git', ['-C', dir, 'rev-parse', '--abbrev-ref', 'HEAD'], {encoding: 'utf8'}).stdout.trim()
}

beforeEach(() => {
  configDir = fs.mkdtempSync(path.join(os.tmpdir(), 'automator-ws-cfg-'))
  dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'automator-ws-data-'))
  origin = fs.mkdtempSync(path.join(os.tmpdir(), 'automator-ws-origin-'))
  process.env.AUTOMATOR_CONFIG_DIR = configDir
  process.env.AUTOMATOR_DATA_DIR = dataDir
  // Local origin with one commit: offline clone source (passed via --url).
  git(['-C', origin, 'init', '-q', '-b', 'main'])
  fs.writeFileSync(path.join(origin, 'README.md'), '# widget\n')
  git(['-C', origin, 'add', '.'])
  git(['-C', origin, '-c', 'user.email=t@e.st', '-c', 'user.name=Test', 'commit', '-qm', 'init'])
})

afterEach(() => {
  process.env = {...savedEnv}
  vi.unstubAllGlobals()
  fs.rmSync(configDir, {recursive: true, force: true})
  fs.rmSync(dataDir, {recursive: true, force: true})
  fs.rmSync(origin, {recursive: true, force: true})
})

// Every case here REALLY runs git (clone + worktree + fetch, some twice): in isolation it stays under 2.5s,
// but in the full suite it runs together with about ten files and nearly hits the 5s default. A wider timeout
// hides nothing — these tests verify git's behaviour, not its speed.
describe('workspace command', {timeout: 30_000}, () => {
  it('sync not configured → exit 2', async () => {
    saveSecrets({})
    await runExpectingExit(Workspace, ['CYAU', 'CYAU-11'], 2)
  })

  it('pre-registration → exit 2 without contacting the server', async () => {
    saveSecrets({sync: {orgToken: 'cyi_a_x'}})
    const fetch = vi.fn()
    vi.stubGlobal('fetch', fetch)
    await runExpectingExit(Workspace, ['CYAU', 'CYAU-11'], 2)
    expect(fetch).not.toHaveBeenCalled()
  })

  it('failed agents fetch → exit 1', async () => {
    saveSecrets({sync: {}, host: {id: 'h1', token: 'cyi_ah_host'}})
    stubFetchFailed()
    await runExpectingExit(Workspace, ['CYAU', 'CYAU-11'], 1)
  })

  it('project without a GitHub repository → exit 1 (nothing to clone)', async () => {
    saveSecrets({sync: {orgToken: 'cyi_a_x'}, host: {id: 'h1', token: 'cyi_ah_host'}})
    stubManifest([{key: 'CYAU', repo: null}])
    const {stderr} = await runExpectingExit(Workspace, ['CYAU', 'CYAU-11'], 1)
    expect(stderr).toContain('C404-WORKSPACE-005')
  })

  it('missing checkout → clones the managed repo and creates the ticket isolated worktree', async () => {
    saveSecrets({sync: {orgToken: 'cyi_a_x'}, host: {id: 'h1', token: 'cyi_ah_host'}})
    stubManifest([{key: 'CYAU', repo: 'acme/widget'}])

    const {result, stdout} = await runCaptured(Workspace, ['CYAU', 'CYAU-11', '--url', origin])

    const repoPath = path.join(dataDir, 'repositories', 'acme', 'widget')
    const wtPath = path.join(dataDir, 'worktrees', 'CYAU', 'CYAU-11')
    expect((result as {repoAction: string}).repoAction).toBe('clone')
    expect((result as {worktreeAction: string}).worktreeAction).toBe('add')
    expect((result as {worktreePath: string}).worktreePath).toBe(wtPath)
    expect(fs.existsSync(path.join(repoPath, '.git'))).toBe(true)
    expect(fs.existsSync(path.join(wtPath, 'README.md'))).toBe(true)
    expect(branchOf(wtPath)).toBe('ticket/CYAU-11')
    expect(stdout).toContain('worktree add')
  })

  it('idempotent: rerun reuses repo and worktree, preserves the unintegrated work', async () => {
    saveSecrets({sync: {orgToken: 'cyi_a_x'}, host: {id: 'h1', token: 'cyi_ah_host'}})
    stubManifest([{key: 'CYAU', repo: 'acme/widget'}])

    await runCaptured(Workspace, ['CYAU', 'CYAU-11', '--url', origin])
    const wtPath = path.join(dataDir, 'worktrees', 'CYAU', 'CYAU-11')
    fs.writeFileSync(path.join(wtPath, 'wip.txt'), 'work in progress\n')

    const {result} = await runCaptured(Workspace, ['CYAU', 'CYAU-11', '--url', origin])

    expect((result as {repoAction: string}).repoAction).toBe('reuse')
    expect((result as {worktreeAction: string}).worktreeAction).toBe('reuse')
    expect(fs.readFileSync(path.join(wtPath, 'wip.txt'), 'utf8')).toBe('work in progress\n')
  })

  it('--dry-run rejects an existing worktree on the wrong branch without modifying it', async () => {
    saveSecrets({sync: {orgToken: 'cyi_a_x'}, host: {id: 'h1', token: 'cyi_ah_host'}})
    stubManifest([{key: 'CYAU', repo: 'acme/widget'}])
    await runCaptured(Workspace, ['CYAU', 'CYAU-11', '--url', origin])
    const wtPath = path.join(dataDir, 'worktrees', 'CYAU', 'CYAU-11')
    git(['-C', wtPath, 'switch', '-c', 'ticket/OTHER'])
    fs.writeFileSync(path.join(wtPath, 'wip.txt'), 'preserva\n')

    const {stderr} = await runExpectingExit(Workspace, ['CYAU', 'CYAU-11', '--url', origin, '--dry-run'], 1)

    expect(stderr).toContain('C409-WORKSPACE-006')
    expect(branchOf(wtPath)).toBe('ticket/OTHER')
    expect(fs.readFileSync(path.join(wtPath, 'wip.txt'), 'utf8')).toBe('preserva\n')
  })

  it('--dry-run shows the plan without cloning or creating the worktree', async () => {
    saveSecrets({sync: {orgToken: 'cyi_a_x'}, host: {id: 'h1', token: 'cyi_ah_host'}})
    stubManifest([{key: 'CYAU', repo: 'acme/widget'}])

    const {result, stdout} = await runCaptured(Workspace, ['CYAU', 'CYAU-11', '--url', origin, '--dry-run'])

    expect((result as {dryRun: boolean}).dryRun).toBe(true)
    expect((result as {repoAction: string}).repoAction).toBe('clone')
    expect(fs.existsSync(path.join(dataDir, 'repositories'))).toBe(false)
    expect(fs.existsSync(path.join(dataDir, 'worktrees'))).toBe(false)
    expect(stdout).toContain('(dry-run)')
  })

  it('--branch customizes the worktree branch', async () => {
    saveSecrets({sync: {orgToken: 'cyi_a_x'}, host: {id: 'h1', token: 'cyi_ah_host'}})
    stubManifest([{key: 'CYAU', repo: 'acme/widget'}])

    const {result} = await runCaptured(Workspace, ['CYAU', 'CYAU-11', '--url', origin, '--branch', 'ticket/custom'])

    expect((result as {branch: string}).branch).toBe('ticket/custom')
    expect(branchOf(path.join(dataDir, 'worktrees', 'CYAU', 'CYAU-11'))).toBe('ticket/custom')
  })

  it('--json does not print the human-readable lines (prepares and returns the result)', async () => {
    saveSecrets({sync: {orgToken: 'cyi_a_x'}, host: {id: 'h1', token: 'cyi_ah_host'}})
    stubManifest([{key: 'CYAU', repo: 'acme/widget'}])

    const {result, stdout} = await runCaptured(Workspace, ['CYAU', 'CYAU-11', '--url', origin, '--json'])

    expect((result as {repoAction: string}).repoAction).toBe('clone')
    expect(stdout).not.toContain('repository clone:')
    expect(fs.existsSync(path.join(dataDir, 'worktrees', 'CYAU', 'CYAU-11'))).toBe(true)
  })

  it('--dry-run --json returns the plan without human-readable lines or writes', async () => {
    saveSecrets({sync: {orgToken: 'cyi_a_x'}, host: {id: 'h1', token: 'cyi_ah_host'}})
    stubManifest([{key: 'CYAU', repo: 'acme/widget'}])

    const {result, stdout} = await runCaptured(Workspace, ['CYAU', 'CYAU-11', '--url', origin, '--dry-run', '--json'])

    expect((result as {dryRun: boolean; repoAction: string}).dryRun).toBe(true)
    expect((result as {repoAction: string}).repoAction).toBe('clone')
    expect(stdout).not.toContain('(dry-run) repository')
    expect(fs.existsSync(path.join(dataDir, 'repositories'))).toBe(false)
  })
})
