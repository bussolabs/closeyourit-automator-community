import {describe, expect, it} from 'vitest'
import Publish from '../src/commands/publish'
import {type KbPublisher, type PublishRepo} from '../src/lib/publish'
import {runCaptured, runExpectingExit, testConfig} from './helpers/command'

// The `publish` command (CYAU-27) publishes the VERSIONED documentation into the CloseYourIt Knowledge: it reads the
// git-tracked file and uses the server-side atomic publication (idempotent create/update), NEVER delete,
// and appends a provenance footer (source/commit/ticket/run). Safe-by-default shell gate: published → exit 0;
// unversioned file / secret → exit 3; invalid input → exit 2. The probes (git/fs + cyi kb) are injected.

// Fake repository and Knowledge, injected in place of the real probes.
let files: Record<string, string> = {}
let tracked: Set<string> = new Set()
let head: string | null = 'headsha'
let kb: FakeKb

interface FakeKb extends KbPublisher {
  publishes: number
}

function makeFakeKb(result: {id: string; action: 'create' | 'update'; adoptedLegacy: boolean}): FakeKb {
  let publishes = 0
  return {
    get publishes() {
      return publishes
    },
    publish() {
      publishes++
      return result
    },
  }
}

function reset(): void {
  files = {'docs/x.md': '# Doc canonica\n\nCorpo versionato.'}
  tracked = new Set(['docs/x.md'])
  head = 'headsha'
  kb = makeFakeKb({id: 'id-1', action: 'create', adoptedLegacy: false})
}

// Test subclass: injects the fake probes (no real git/fs, no cyi process).
class TestPublish extends Publish {
  protected makeRepo(): PublishRepo {
    return {
      read: ({file}) => files[file] ?? null,
      isTracked: ({file}) => tracked.has(file),
      headCommit: () => head,
    }
  }

  protected makeKb(): KbPublisher {
    return kb
  }
}

interface PublishPayload {
  dryRun: boolean
  action?: 'create' | 'update'
  pageId?: string
  project?: string
  title?: string
  kind?: string
  body?: string
  commit?: string | null
}

const base = ['--project', 'CYAU', '--title', 'Guida deploy', '--source-file', 'docs/x.md', '--ticket', 'CYAU-27']

describe('publish command — Scenario 1: the page derives from the versioned file, idempotent create/update', () => {
  it('no existing page → create, auditable record with provenance', async () => {
    reset()
    const {result} = await runCaptured(TestPublish, [...base, '--kind', 'guide', '--run-id', 'run-1', '--json'])
    const r = result as PublishPayload
    expect(r.action).toBe('create')
    expect(r.pageId).toBe('id-1')
    expect(r.project).toBe('CYAU')
    expect(r.commit).toBe('headsha')
    expect(kb.publishes).toBe(1)
  })

  it('page with the same title already present → update, no second create (idempotent)', async () => {
    reset()
    kb = makeFakeKb({id: 'e7', action: 'update', adoptedLegacy: false})
    const {result} = await runCaptured(TestPublish, [...base, '--json'])
    const r = result as PublishPayload
    expect(r.action).toBe('update')
    expect(r.pageId).toBe('e7')
    expect(kb.publishes).toBe(1)
  })

  it('human output: prints a summary of the publication', async () => {
    reset()
    const {stdout} = await runCaptured(TestPublish, [...base])
    expect(stdout).toContain('publish')
    expect(stdout.toLowerCase()).toContain('create')
  })

  it('unresolvable HEAD commit → fail-closed, no publication without an immutable snapshot', async () => {
    reset()
    head = null
    const {stderr} = await runExpectingExit(TestPublish, [...base], 2)
    expect(stderr).toContain('C400-PUBLISH-001')
    expect(kb.publishes).toBe(0)
  })
})

describe('publish command — dry-run (read-only): composes the body without touching the Knowledge', () => {
  it('shows the composed body and creates/updates NOTHING', async () => {
    reset()
    const {result} = await runCaptured(TestPublish, [...base, '--dry-run', '--json'])
    const r = result as PublishPayload
    expect(r.dryRun).toBe(true)
    expect(r.body).toContain('Corpo versionato.')
    expect(r.body).toContain('docs/x.md')
    expect(kb.publishes).toBe(0)
  })

  it('human output of the dry-run: prints the plan and the body without touching the Knowledge', async () => {
    reset()
    const {stdout} = await runCaptured(TestPublish, [...base, '--dry-run'])
    expect(stdout).toContain('dry-run')
    expect(stdout).toContain('body:')
    expect(stdout).toContain('Corpo versionato.')
    expect(kb.publishes).toBe(0)
  })
})

describe('publish command — default real probes (construction)', () => {
  it('default makeRepo/makeKb build the real probes (fs/git + cyi kb)', async () => {
    const config = await testConfig()
    class ExposePublish extends Publish {
      repo(): PublishRepo {
        return this.makeRepo()
      }
      kb(): KbPublisher {
        return this.makeKb()
      }
    }
    const cmd = new ExposePublish([], config)
    expect(typeof cmd.repo().isTracked).toBe('function')
    expect(typeof cmd.kb().publish).toBe('function')
    expect('listPages' in cmd.kb()).toBe(false)
    expect('create' in cmd.kb()).toBe(false)
    expect('update' in cmd.kb()).toBe(false)
    // "Forbid delete" stays structural even on the real probe built by the command.
    expect('delete' in cmd.kb()).toBe(false)
  })
})

describe('publish command — gate safe-by-default e difesa all’ingresso', () => {
  it('unsafe project-key → exit 2, C400-PUBLISH-001', async () => {
    reset()
    const {stderr} = await runExpectingExit(TestPublish, ['--project', 'a/b', '--title', 'T', '--source-file', 'docs/x.md', '--ticket', 'CYAU-27'], 2)
    expect(stderr).toContain('C400-PUBLISH-001')
  })

  it('kind sconosciuto → exit 2, C400-PUBLISH-001', async () => {
    reset()
    const {stderr} = await runExpectingExit(TestPublish, [...base, '--kind', 'runbook'], 2)
    expect(stderr).toContain('C400-PUBLISH-001')
  })

  it('NON-versioned file → exit 3, C409-PUBLISH-002 (not public)', async () => {
    reset()
    tracked = new Set() // docs/x.md is no longer tracked
    const {stderr} = await runExpectingExit(TestPublish, [...base], 3)
    expect(stderr).toContain('C409-PUBLISH-002')
    expect(kb.publishes).toBe(0)
  })

  it('content with a secret → exit 3, C412-PUBLISH-004 (never published)', async () => {
    reset()
    files['docs/secret.md'] = `config\n\ntoken: ghp_${'a'.repeat(36)}\n`
    tracked.add('docs/secret.md')
    const {stderr} = await runExpectingExit(
      TestPublish,
      ['--project', 'CYAU', '--title', 'T', '--source-file', 'docs/secret.md', '--ticket', 'CYAU-27'],
      3,
    )
    expect(stderr).toContain('C412-PUBLISH-004')
    expect(kb.publishes).toBe(0)
  })

  it('gate exit 3 in --json → payload with the error on stdout (oclif suppresses stderr in JSON)', async () => {
    reset()
    tracked = new Set()
    const {stdout} = await runExpectingExit(TestPublish, [...base, '--json'], 3)
    expect(stdout).toContain('C409-PUBLISH-002')
  })

  it('an Agent Host token in the title is not reflected in the error JSON payload', async () => {
    reset()
    const token = `cyi_ah_${'T'.repeat(24)}`
    const {stdout} = await runExpectingExit(
      TestPublish,
      ['--project', 'CYAU', '--title', `Guida ${token}`, '--source-file', 'docs/x.md', '--ticket', 'CYAU-27', '--json'],
      3,
    )
    expect(stdout).toContain('[REDACTED]')
    expect(stdout).not.toContain(token)
  })

  it('an Agent Host token in the project is blocked and not reflected in the JSON payload', async () => {
    reset()
    const token = `cyi_ah_${'J'.repeat(24)}`
    const {stdout} = await runExpectingExit(
      TestPublish,
      ['--project', `archive_${token}`, '--title', 'Guida', '--source-file', 'docs/x.md', '--ticket', 'CYAU-27', '--json'],
      3,
    )
    expect(stdout).toContain('[REDACTED]')
    expect(stdout).not.toContain(token)
    expect(kb.publishes).toBe(0)
  })

  it('an Agent Host token in the source path is not reflected even if the tracked gate fails before the scan', async () => {
    reset()
    const token = `cyi_ah_${'P'.repeat(24)}`
    const sourceFile = `docs/${token}.md`
    const {stderr} = await runExpectingExit(
      TestPublish,
      ['--project', 'CYAU', '--title', 'T', '--source-file', sourceFile, '--ticket', 'CYAU-27'],
      3,
    )
    expect(stderr).toContain('[REDACTED]')
    expect(stderr).not.toContain(token)
  })
})
