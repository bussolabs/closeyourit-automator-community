import {describe, expect, it} from 'vitest'
import Guidance from '../src/commands/guidance'
import {type GuidanceDeps, type GuidanceFs, type KbProbe, type KbSearchOutcome} from '../src/lib/guidance'
import {runCaptured, runExpectingExit} from './helpers/command'

// The `guidance` command (CYAU-26) prepares the uniform context for the agents: it collects the local conventions
// (CLAUDE.md/AGENTS.md) and the project's relevant Knowledge pages (cyi kb search, read-only, filtered by
// project), and composes ONE identical package for Claude and Codex. Best-effort on the KB (a blip does not block):
// prepares the context → exit 0; invalid project key → exit 2. The probes (fs + cyi kb) are injected in tests.

// Virtual filesystem + fake Knowledge, injected in place of the real probes.
let files: Record<string, string> = {}
let repoRoots: string[] = []
let kbByQuery: Record<string, KbSearchOutcome> = {}
let kbCalls: Array<{query: string; project: string}> = []

function reset(): void {
  files = {'/wt/CLAUDE.md': '# convenzioni locali del progetto'}
  repoRoots = ['/wt']
  kbByQuery = {}
  kbCalls = []
}

const fakeFs = (): GuidanceFs => ({
  read: (file) => (file in files ? files[file] : null),
  isRepoRoot: (dir) => repoRoots.includes(dir),
})

const fakeKb = (): KbProbe => ({
  search(args) {
    kbCalls.push(args)
    return kbByQuery[args.query] ?? {ok: true, pages: []}
  },
})

// Test subclass: injects the fake probes (no real filesystem, no cyi process).
class TestGuidance extends Guidance {
  protected makeDeps(): GuidanceDeps {
    return {fs: fakeFs(), kb: fakeKb()}
  }
}

interface GuidancePayload {
  project: string
  code: string | null
  markdown: string
  sources: Array<{origin: string; ref: string; title: string}>
  hasLocal: boolean
  hasKnowledge: boolean
  knowledgeAvailable: boolean
  notes: string[]
}

describe('guidance command — Scenario 1: context with local guidance + Knowledge (DoD)', () => {
  it('includes local guidance and relevant Knowledge pages, with the sources recorded', async () => {
    reset()
    kbByQuery['Consultare KB'] = {
      ok: true,
      pages: [{id: 'p1', title: 'Guida deploy', body: 'contenuto kb', kind: 'guide', project: 'CYAU', projectName: 'a', updatedAt: null}],
    }
    const {result} = await runCaptured(TestGuidance, [
      '--project', 'CYAU', '--code', 'CYAU-26', '--title', 'Consultare KB', '--cwd', '/wt', '--json',
    ])
    const r = result as GuidancePayload
    expect(r.hasLocal).toBe(true)
    expect(r.hasKnowledge).toBe(true)
    expect(r.markdown).toContain('# convenzioni locali del progetto')
    expect(r.markdown).toContain('contenuto kb')
    expect(r.sources.map((s) => s.origin)).toContain('local')
    expect(r.sources.map((s) => s.origin)).toContain('knowledge')
    // The search query is derived from the title and filtered on the project (scope).
    expect(kbCalls).toEqual([{query: 'Consultare KB', project: 'CYAU'}])
  })

  it('human output: prints the markdown package and a summary of the sources', async () => {
    reset()
    const {stdout} = await runCaptured(TestGuidance, ['--project', 'CYAU', '--title', 'X', '--cwd', '/wt'])
    expect(stdout).toContain('# Guidance per il ticket — progetto CYAU')
    expect(stdout).toContain('convenzioni locali:')
  })

  it('merges the explicit queries (--query) with the one derived from the title', async () => {
    reset()
    await runCaptured(TestGuidance, [
      '--project', 'CYAU', '--title', 'Titolo', '--query', 'esplicita', '--cwd', '/wt', '--json',
    ])
    expect(kbCalls.map((c) => c.query)).toEqual(['esplicita', 'Titolo'])
  })
})

describe('guidance command — scope e best-effort', () => {
  it('discards the pages of another project (without exposing unauthorized content)', async () => {
    reset()
    kbByQuery.q = {
      ok: true,
      pages: [
        {id: 'mine', title: 'Mia', body: 'ok', kind: null, project: 'CYAU', projectName: null, updatedAt: null},
        {id: 'other', title: 'Altrui', body: 'SEGRETO', kind: null, project: 'CYRA', projectName: null, updatedAt: null},
      ],
    }
    const {result} = await runCaptured(TestGuidance, ['--project', 'CYAU', '--query', 'q', '--cwd', '/wt', '--json'])
    const r = result as GuidancePayload
    expect(r.markdown).not.toContain('SEGRETO')
    expect(r.sources.filter((s) => s.origin === 'knowledge').map((s) => s.ref)).toEqual(['mine'])
  })

  it('unreachable Knowledge → exit 0, degrades to the local guidance only (does not block)', async () => {
    reset()
    kbByQuery.q = {ok: false, reason: 'rete non disponibile'}
    const {result} = await runCaptured(TestGuidance, ['--project', 'CYAU', '--query', 'q', '--cwd', '/wt', '--json'])
    const r = result as GuidancePayload
    expect(r.knowledgeAvailable).toBe(false)
    expect(r.hasLocal).toBe(true)
    expect(r.notes.some((n) => n.includes('rete non disponibile'))).toBe(true)
  })

  it('without title/analysis/query the Knowledge is not queried (local guidance only)', async () => {
    reset()
    const {result} = await runCaptured(TestGuidance, ['--project', 'CYAU', '--cwd', '/wt', '--json'])
    const r = result as GuidancePayload
    expect(kbCalls).toHaveLength(0)
    expect(r.hasKnowledge).toBe(false)
    expect(r.hasLocal).toBe(true)
  })
})

describe('guidance command — difesa all’ingresso', () => {
  it('unsafe project-key → exit 2, dedicated code', async () => {
    reset()
    const {stderr} = await runExpectingExit(TestGuidance, ['--project', 'a/b', '--title', 'X'], 2)
    expect(stderr).toContain('C400-GUIDANCE-001')
  })
})
