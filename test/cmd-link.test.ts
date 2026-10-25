import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import {spawnSync} from 'node:child_process'
import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest'
import Link from '../src/commands/link'
import {loadSecrets, saveSecrets, type Secrets} from '../src/lib/config'
import {runCaptured, runExpectingExit} from './helpers/command'

let configDir: string
let workspace: string
const savedEnv = {...process.env}

interface RemoteTarget {
  key: string
  repo: string | null
}

// Envelope as sent by /api/v1/agent_host/workspace_manifest: the repositories that belong to THIS host.
// A project without a GitHub repo does not appear in the manifest — the server excludes it upstream (CYAU-87).
function stubManifest(targets: RemoteTarget[], beforeReply?: () => void): void {
  const manifest = {
    version: 1,
    digest: 'd1',
    workspace_root_hint: 'Lavoro/Github/Personale',
    repositories: targets
      .filter((t) => Boolean(t.repo))
      .map((t) => ({project_key: t.key, path: String(t.repo).split('/').pop(), repo: t.repo, default_branch: 'main'})),
  }
  vi.stubGlobal('fetch', vi.fn(async () => {
    beforeReply?.()
    return {ok: true, json: async () => ({data: manifest})} as unknown as Response
  }))
}

function stubFetchFailed(): void {
  vi.stubGlobal('fetch', vi.fn(async () => ({ok: false, json: async () => ({})}) as unknown as Response))
}

// Creates a real git checkout under the workspace with an origin remote, returns its absolute path.
function checkout(name: string, remote: string): string {
  const repo = path.join(workspace, name)
  fs.mkdirSync(repo, {recursive: true})
  spawnSync('git', ['-C', repo, 'init', '-q'], {encoding: 'utf8'})
  spawnSync('git', ['-C', repo, 'remote', 'add', 'origin', remote], {encoding: 'utf8'})
  return repo
}

beforeEach(() => {
  configDir = fs.mkdtempSync(path.join(os.tmpdir(), 'automator-link-cfg-'))
  workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'automator-link-ws-'))
  process.env.AUTOMATOR_CONFIG_DIR = configDir
})

afterEach(() => {
  process.env = {...savedEnv}
  vi.unstubAllGlobals()
  fs.rmSync(configDir, {recursive: true, force: true})
  fs.rmSync(workspace, {recursive: true, force: true})
})

describe('link command', () => {
  it('sync not configured → exit 2', async () => {
    saveSecrets({})
    await runExpectingExit(Link, [workspace], 2)
  })

  it('pre-registration → exit 2 without contacting the server', async () => {
    saveSecrets({sync: {orgToken: 'cyi_a_x'}})
    const fetch = vi.fn()
    vi.stubGlobal('fetch', fetch)
    await runExpectingExit(Link, [workspace], 2)
    expect(fetch).not.toHaveBeenCalled()
  })

  it('failed agents fetch → exit 1', async () => {
    saveSecrets({sync: {}, host: {id: 'h1', token: 'cyi_ah_host'}})
    stubFetchFailed()
    await runExpectingExit(Link, [workspace], 1)
  })

  it('unique match → links and persists the host map', async () => {
    saveSecrets({sync: {orgToken: 'cyi_a_x'}, host: {id: 'h1', token: 'cyi_ah_host'}})
    const repo = checkout('widget', 'git@github.com:acme/widget.git')
    stubManifest([{key: 'ACME', repo: 'acme/widget'}])

    const {result, stdout} = await runCaptured(Link, [workspace])

    expect((result as {changed: boolean}).changed).toBe(true)
    expect((result as {matched: unknown[]}).matched).toEqual([{projectKey: 'ACME', repo: 'acme/widget', cwd: repo}])
    expect(loadSecrets().hosts).toEqual({ACME: {cwd: repo}})
    expect(stdout).toContain('collegato: ACME')
  })

  it('rerunning it is idempotent: the second time the project is already mapped, host map unchanged', async () => {
    saveSecrets({sync: {orgToken: 'cyi_a_x'}, host: {id: 'h1', token: 'cyi_ah_host'}})
    const repo = checkout('widget', 'git@github.com:acme/widget.git')
    stubManifest([{key: 'ACME', repo: 'acme/widget'}])

    await runCaptured(Link, [workspace])
    const {result, stdout} = await runCaptured(Link, [workspace])

    expect((result as {changed: boolean}).changed).toBe(false)
    expect((result as {alreadyMapped: string[]}).alreadyMapped).toEqual(['ACME'])
    expect(loadSecrets().hosts).toEqual({ACME: {cwd: repo}})
    expect(stdout).toContain('già mappato: ACME')
  })

  it('--dry-run shows the match but does NOT write the host map', async () => {
    saveSecrets({sync: {orgToken: 'cyi_a_x'}, host: {id: 'h1', token: 'cyi_ah_host'}})
    checkout('widget', 'https://github.com/acme/widget.git')
    stubManifest([{key: 'ACME', repo: 'acme/widget'}])

    const {result, stdout} = await runCaptured(Link, [workspace, '--dry-run'])

    expect((result as {changed: boolean}).changed).toBe(false)
    expect(loadSecrets().hosts).toBeUndefined()
    expect(stdout).toContain('collegabile: ACME')
    expect(stdout).toContain('(dry-run)')
  })

  it('several checkouts for the same repo → ambiguous, does not write, clear instructions', async () => {
    saveSecrets({sync: {orgToken: 'cyi_a_x'}, host: {id: 'h1', token: 'cyi_ah_host'}})
    checkout('widget-a', 'git@github.com:acme/widget.git')
    checkout('widget-b', 'https://github.com/acme/widget.git')
    stubManifest([{key: 'ACME', repo: 'acme/widget'}])

    const {result, stdout} = await runCaptured(Link, [workspace])

    expect((result as {ambiguous: unknown[]}).ambiguous).toHaveLength(1)
    expect(loadSecrets().hosts).toBeUndefined()
    expect(stdout).toContain('ambiguo: ACME')
    expect(stdout).toContain('hosts.ACME.cwd')
  })

  it('repository without local checkout → missing, clear instructions', async () => {
    saveSecrets({sync: {orgToken: 'cyi_a_x'}, host: {id: 'h1', token: 'cyi_ah_host'}})
    checkout('altro', 'git@github.com:acme/altro.git')
    stubManifest([{key: 'ACME', repo: 'acme/widget'}])

    const {result, stdout} = await runCaptured(Link, [workspace])

    expect((result as {missing: unknown[]}).missing).toEqual([{projectKey: 'ACME', repo: 'acme/widget'}])
    expect(stdout).toContain('mancante: ACME')
  })

  it('a project without a GitHub repo produces no links', async () => {
    saveSecrets({sync: {orgToken: 'cyi_a_x'}, host: {id: 'h1', token: 'cyi_ah_host'}})
    stubManifest([{key: 'NOREPO', repo: null}])

    const {result, stdout} = await runCaptured(Link, [workspace])

    expect((result as {changed: boolean}).changed).toBe(false)
    expect(stdout).toContain('Nessun progetto con repository GitHub da collegare.')
  })

  it('without root uses the current cwd (no match → no write)', async () => {
    saveSecrets({sync: {orgToken: 'cyi_a_x'}, host: {id: 'h1', token: 'cyi_ah_host'}})
    stubManifest([{key: 'ACME', repo: 'nonesiste/repo'}])

    const {result} = await runCaptured(Link, ['--json'])

    expect((result as {roots: string[]}).roots).toEqual([process.cwd()])
    expect((result as {changed: boolean}).changed).toBe(false)
    expect(loadSecrets().hosts).toBeUndefined()
  })

  it('preserves existing sync and host when updating the host map', async () => {
    const base: Secrets = {sync: {orgToken: 'cyi_a_x'}, host: {id: 'h1', token: 'cyi_ah_s'}}
    saveSecrets(base)
    const repo = checkout('widget', 'git@github.com:acme/widget.git')
    stubManifest([{key: 'ACME', repo: 'acme/widget'}])

    await runCaptured(Link, [workspace])

    const s = loadSecrets()
    expect(s.sync).toEqual({orgToken: 'cyi_a_x'})
    expect(s.host).toEqual({id: 'h1', token: 'cyi_ah_s'})
    expect(s.hosts).toEqual({ACME: {cwd: repo}})
  })

  it('atomic merge: a concurrent rotation during the fetch is neither lost nor reintroduces orgToken', async () => {
    saveSecrets({sync: {orgToken: 'cyi_a_x'}, host: {id: 'h1', token: 'cyi_ah_old'}})
    const repo = checkout('widget', 'git@github.com:acme/widget.git')
    stubManifest([{key: 'ACME', repo: 'acme/widget'}], () => {
      saveSecrets({sync: {apiUrl: 'https://current.example'}, host: {id: 'h1', token: 'cyi_ah_new'}})
    })

    await runCaptured(Link, [workspace])

    expect(loadSecrets()).toEqual({
      sync: {apiUrl: 'https://current.example'},
      host: {id: 'h1', token: 'cyi_ah_new'},
      hosts: {ACME: {cwd: repo}},
    })
  })

  it('checkout deeper than the default → missing (not a silent false clone-the-repo hint)', async () => {
    saveSecrets({sync: {orgToken: 'cyi_a_x'}, host: {id: 'h1', token: 'cyi_ah_host'}})
    checkout('a/b/c/widget', 'git@github.com:acme/widget.git')
    stubManifest([{key: 'ACME', repo: 'acme/widget'}])

    const {result} = await runCaptured(Link, [workspace])

    expect((result as {missing: unknown[]}).missing).toHaveLength(1)
    expect(loadSecrets().hosts).toBeUndefined()
  })

  it('--depth widens the scan and finds the deep checkout', async () => {
    saveSecrets({sync: {orgToken: 'cyi_a_x'}, host: {id: 'h1', token: 'cyi_ah_host'}})
    const repo = checkout('a/b/c/widget', 'git@github.com:acme/widget.git')
    stubManifest([{key: 'ACME', repo: 'acme/widget'}])

    const {result} = await runCaptured(Link, [workspace, '--depth', '4'])

    expect((result as {matched: unknown[]}).matched).toEqual([{projectKey: 'ACME', repo: 'acme/widget', cwd: repo}])
    expect(loadSecrets().hosts).toEqual({ACME: {cwd: repo}})
  })
})
