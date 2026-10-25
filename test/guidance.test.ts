import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import {describe, expect, it} from 'vitest'
import {
  assertSafeProject,
  collectLocalGuidance,
  composeGuidancePack,
  DEFAULT_MAX_UP,
  defaultGuidanceFs,
  defaultKbProbe,
  defaultRunner,
  deriveKbQueries,
  gatherGuidance,
  type GuidanceFs,
  guidanceDirs,
  type KbPage,
  type KbProbe,
  type KbSearchOutcome,
  LOCAL_GUIDANCE_FILES,
  parseKbSearchJson,
  VERIFY_ON_CODE_NOTICE,
} from '../src/lib/guidance'
import {AutomatorError, ErrorCodes} from '../src/errors/error-codes'

// Automatic consultation of the local guidance and of the CloseYourIt Knowledge (CYAU-26): before an agent
// decides, Automator gathers the local conventions (CLAUDE.md/AGENTS.md of the hierarchy) and the relevant Knowledge
// pages (via `cyi kb search`, read-only, filtered by project), and composes ONE uniform package out of them —
// identical for Claude and Codex (DoD). The core is pure (composition, query, parsing); the I/O lives behind the
// `GuidanceFs`/`KbProbe` probes. The scope is respected server-side AND as client-side defence in depth (pages of
// other projects discarded). The KB consultation is best-effort: a failure does not block the preparation.

// ── Virtual filesystem for GuidanceFs ────────────────────────────────────────────────────────────────────────
function fakeFs(files: Record<string, string>, repoRoots: string[] = []): GuidanceFs {
  const roots = new Set(repoRoots)
  return {
    read: (file) => (file in files ? files[file] : null),
    isRepoRoot: (dir) => roots.has(dir),
  }
}

describe('guidanceDirs — climb up to the git root included (root → cwd)', () => {
  it('stops at the git root included and orders from the root towards the cwd', () => {
    const dirs = guidanceDirs('/a/b/c', (dir) => dir === '/a')
    expect(dirs).toEqual(['/a', '/a/b', '/a/b/c'])
  })

  it('includes the cwd even when it is itself the git root', () => {
    expect(guidanceDirs('/a/b', (dir) => dir === '/a/b')).toEqual(['/a/b'])
  })

  it('without git root climbs up to the maxUp cap', () => {
    const dirs = guidanceDirs('/a/b/c/d/e', () => false, 2)
    // cwd + 2 levels = 3 directories, ordered from the highest to the cwd.
    expect(dirs).toEqual(['/a/b/c', '/a/b/c/d', '/a/b/c/d/e'])
  })

  it('stops at the filesystem root without going past it', () => {
    const dirs = guidanceDirs('/', () => false, DEFAULT_MAX_UP)
    expect(dirs).toEqual(['/'])
  })
})

describe('collectLocalGuidance — reads the canonical files in the hierarchy', () => {
  it('gathers CLAUDE.md/AGENTS.md of the hierarchy in general → specific order', () => {
    const files = {
      '/repo/CLAUDE.md': '# root claude',
      '/repo/app/CLAUDE.md': '# app claude',
      '/repo/app/AGENTS.md': '# app agents',
    }
    const sources = collectLocalGuidance('/repo/app', fakeFs(files, ['/repo']))
    expect(sources.map((s) => s.path)).toEqual(['/repo/CLAUDE.md', '/repo/app/CLAUDE.md', '/repo/app/AGENTS.md'])
    expect(sources[0].content).toBe('# root claude')
  })

  it('discards the missing and the empty files (whitespace only)', () => {
    const files = {'/repo/CLAUDE.md': '   \n  ', '/repo/AGENTS.md': 'reale'}
    const sources = collectLocalGuidance('/repo', fakeFs(files, ['/repo']))
    expect(sources.map((s) => s.path)).toEqual(['/repo/AGENTS.md'])
  })

  it('no guidance file → empty list (not an error)', () => {
    expect(collectLocalGuidance('/repo', fakeFs({}, ['/repo']))).toEqual([])
  })

  it('supports additional guidance files beyond the canonical ones', () => {
    const files = {'/repo/CONVENZIONI.md': 'extra'}
    const sources = collectLocalGuidance('/repo', fakeFs(files, ['/repo']), [...LOCAL_GUIDANCE_FILES, 'CONVENZIONI.md'])
    expect(sources.map((s) => s.path)).toEqual(['/repo/CONVENZIONI.md'])
  })

  it('a duplicate file name (extra = canonical) does not produce a double source', () => {
    const files = {'/repo/CLAUDE.md': '# conv'}
    const sources = collectLocalGuidance('/repo', fakeFs(files, ['/repo']), ['CLAUDE.md', 'CLAUDE.md'])
    expect(sources.map((s) => s.path)).toEqual(['/repo/CLAUDE.md'])
  })
})

describe('parseKbSearchJson — tolerant parsing of the cyi kb output (untrusted input)', () => {
  it('extracts the pages from {data:[…]} and maps snake_case → camelCase', () => {
    const raw = JSON.stringify({
      data: [
        {id: 'p1', title: 'Guida', body: 'testo', kind: 'guide', project: 'CYAU', project_name: 'automator', updated_at: '2026-07-07'},
      ],
      meta: {total: 1},
    })
    const pages = parseKbSearchJson(raw)
    expect(pages).toHaveLength(1)
    expect(pages[0]).toEqual({
      id: 'p1',
      title: 'Guida',
      body: 'testo',
      kind: 'guide',
      project: 'CYAU',
      projectName: 'automator',
      updatedAt: '2026-07-07',
    })
  })

  it('also accepts a bare array of pages', () => {
    const pages = parseKbSearchJson(JSON.stringify([{id: 'p1', title: 't', body: 'b'}]))
    expect(pages).toHaveLength(1)
    expect(pages[0].kind).toBeNull()
  })

  it('illegal JSON → no page (never throws)', () => {
    expect(parseKbSearchJson('non-json')).toEqual([])
  })

  it('unexpected shape (neither array nor data[]) → no page', () => {
    expect(parseKbSearchJson(JSON.stringify({items: []}))).toEqual([])
  })

  it('discards the single malformed entries without failing the valid ones', () => {
    const raw = JSON.stringify({data: [{id: 'ok', title: 't', body: 'b'}, {title: 'senza id'}, {id: 'x'}]})
    const pages = parseKbSearchJson(raw)
    expect(pages.map((p) => p.id)).toEqual(['ok'])
  })
})

describe('deriveKbQueries — derives the search query from the ticket', () => {
  it('uses the title as a targeted query', () => {
    expect(deriveKbQueries({title: 'Command policy runtime-agnostica'})).toEqual(['Command policy runtime-agnostica'])
  })

  it('falls back on the technical analysis only if the title is missing', () => {
    expect(deriveKbQueries({technicalAnalysis: 'integrare la KB'})).toEqual(['integrare la KB'])
    expect(deriveKbQueries({title: 'T', technicalAnalysis: 'A'})).toEqual(['T'])
  })

  it('empty/whitespace title → no query (or the fallback)', () => {
    expect(deriveKbQueries({title: '   '})).toEqual([])
    expect(deriveKbQueries({title: '  ', technicalAnalysis: 'A'})).toEqual(['A'])
    expect(deriveKbQueries({})).toEqual([])
  })
})

describe('composeGuidancePack — uniform package, always complete (Scenario 1 / DoD)', () => {
  const localSource = {path: '/repo/CLAUDE.md', content: '# convenzioni'}
  const page: KbPage = {id: 'p1', title: 'Guida deploy', body: 'come si fa', kind: 'guide', project: 'CYAU', projectName: 'a', updatedAt: null}

  it('includes local guidance, Knowledge and the notice to verify against the code', () => {
    const pack = composeGuidancePack({project: 'CYAU', code: 'CYAU-26', local: [localSource], knowledge: [page], knowledgeAvailable: true})
    expect(pack.markdown).toContain('# Guidance per CYAU-26 — progetto CYAU')
    expect(pack.markdown).toContain(VERIFY_ON_CODE_NOTICE)
    expect(pack.markdown).toContain('## Convenzioni locali')
    expect(pack.markdown).toContain('/repo/CLAUDE.md')
    expect(pack.markdown).toContain('# convenzioni')
    expect(pack.markdown).toContain('## Knowledge CloseYourIt — progetto CYAU')
    expect(pack.markdown).toContain('Guida deploy')
    expect(pack.markdown).toContain('come si fa')
    expect(pack.hasLocal).toBe(true)
    expect(pack.hasKnowledge).toBe(true)
  })

  it('records the consulted sources (audit): local and Knowledge with their references (DoD)', () => {
    const pack = composeGuidancePack({project: 'CYAU', local: [localSource], knowledge: [page], knowledgeAvailable: true})
    expect(pack.sources).toEqual([
      {origin: 'local', ref: '/repo/CLAUDE.md', title: '/repo/CLAUDE.md'},
      {origin: 'knowledge', ref: 'p1', title: 'Guida deploy'},
    ])
    expect(pack.markdown).toContain('## Fonti consultate')
    expect(pack.markdown).toContain('- [locale] /repo/CLAUDE.md')
    expect(pack.markdown).toContain('- [knowledge] Guida deploy — id p1 (progetto CYAU)')
  })

  it('without code it uses the generic ticket label', () => {
    const pack = composeGuidancePack({project: 'CYAU', local: [], knowledge: [], knowledgeAvailable: true})
    expect(pack.markdown).toContain('# Guidance per il ticket — progetto CYAU')
    expect(pack.code).toBeNull()
  })

  it('explicit placeholders when the local guidance or the Knowledge is missing', () => {
    const pack = composeGuidancePack({project: 'CYAU', local: [], knowledge: [], knowledgeAvailable: true})
    expect(pack.markdown).toContain(`Nessuna convenzione locale trovata (${LOCAL_GUIDANCE_FILES.join(', ')}).`)
    expect(pack.markdown).toContain('Nessuna pagina Knowledge pertinente per il progetto CYAU')
    expect(pack.markdown).toContain('Nessuna fonte disponibile: procedi verificando direttamente il codice sorgente.')
  })

  it('Knowledge not consultable → declares it and suggests proceeding with the local conventions only', () => {
    const pack = composeGuidancePack({project: 'CYAU', local: [localSource], knowledge: [], knowledgeAvailable: false})
    expect(pack.markdown).toContain('Knowledge non consultabile in questo momento')
    expect(pack.knowledgeAvailable).toBe(false)
  })

  it('orders the Knowledge pages stably (project, title, id) → deterministic', () => {
    const p = (id: string, title: string): KbPage => ({id, title, body: 'b', kind: null, project: 'CYAU', projectName: null, updatedAt: null})
    const pack = composeGuidancePack({
      project: 'CYAU',
      local: [],
      knowledge: [p('z', 'Beta'), p('a', 'Alfa'), p('b', 'Alfa')],
      knowledgeAvailable: true,
    })
    expect(pack.sources.filter((s) => s.origin === 'knowledge').map((s) => s.ref)).toEqual(['a', 'b', 'z'])
  })

  it('adaptive fence: a body already containing ``` does not break the markdown', () => {
    const page2: KbPage = {id: 'p', title: 't', body: 'testo con ```blocco``` dentro', kind: null, project: 'CYAU', projectName: null, updatedAt: null}
    const pack = composeGuidancePack({project: 'CYAU', local: [], knowledge: [page2], knowledgeAvailable: true})
    expect(pack.markdown).toContain('````') // longer fence
  })

  it('reports the non-fatal diagnostic notes', () => {
    const pack = composeGuidancePack({project: 'CYAU', local: [], knowledge: [], knowledgeAvailable: true, notes: ['una nota']})
    expect(pack.markdown).toContain('## Note')
    expect(pack.markdown).toContain('- una nota')
    expect(pack.notes).toEqual(['una nota'])
  })
})

// ── Fake Knowledge probe ──────────────────────────────────────────────────────────────────────────────────
function recordingKb(byQuery: Record<string, KbSearchOutcome> = {}, fallback: KbSearchOutcome = {ok: true, pages: []}): {
  kb: KbProbe
  calls: Array<{query: string; project: string}>
} {
  const calls: Array<{query: string; project: string}> = []
  return {
    calls,
    kb: {
      search(args) {
        calls.push(args)
        return byQuery[args.query] ?? fallback
      },
    },
  }
}

const localFs = (): GuidanceFs => fakeFs({'/wt/CLAUDE.md': '# conv locali'}, ['/wt'])

describe('gatherGuidance — Scenario 1: context with local guidance + relevant Knowledge', () => {
  it('composes a package with both sources and records them', () => {
    const page: KbPage = {id: 'p1', title: 'Guida', body: 'kb body', kind: 'guide', project: 'CYAU', projectName: 'a', updatedAt: null}
    const {kb, calls} = recordingKb({'Consultare KB': {ok: true, pages: [page]}})
    const pack = gatherGuidance({project: 'CYAU', code: 'CYAU-26', cwd: '/wt', queries: ['Consultare KB']}, {fs: localFs(), kb})

    expect(pack.hasLocal).toBe(true)
    expect(pack.hasKnowledge).toBe(true)
    expect(pack.markdown).toContain('# conv locali')
    expect(pack.markdown).toContain('kb body')
    // The search is ALWAYS filtered by project (scope).
    expect(calls).toEqual([{query: 'Consultare KB', project: 'CYAU'}])
    expect(pack.sources.map((s) => s.origin)).toEqual(['local', 'knowledge'])
  })

  it('DoD: the same guidance for both runtimes — no "runtime" parameter, identical output', () => {
    const page: KbPage = {id: 'p1', title: 'G', body: 'x', kind: null, project: 'CYAU', projectName: null, updatedAt: null}
    const input = {project: 'CYAU', code: 'CYAU-26', cwd: '/wt', queries: ['q']}
    const forClaude = gatherGuidance(input, {fs: localFs(), kb: recordingKb({q: {ok: true, pages: [page]}}).kb})
    const forCodex = gatherGuidance(input, {fs: localFs(), kb: recordingKb({q: {ok: true, pages: [page]}}).kb})
    expect(forClaude.markdown).toBe(forCodex.markdown)
    expect(forClaude.sources).toEqual(forCodex.sources)
  })

  it('deduplicates the pages by id across multiple queries', () => {
    const page: KbPage = {id: 'dup', title: 'G', body: 'x', kind: null, project: 'CYAU', projectName: null, updatedAt: null}
    const {kb} = recordingKb({a: {ok: true, pages: [page]}, b: {ok: true, pages: [page]}})
    const pack = gatherGuidance({project: 'CYAU', cwd: '/wt', queries: ['a', 'b']}, {fs: localFs(), kb})
    expect(pack.sources.filter((s) => s.origin === 'knowledge')).toHaveLength(1)
  })
})

describe('gatherGuidance — scope and permissions (without exposing unauthorized contents)', () => {
  it('discards the pages of a different project (defence in depth on top of the server-side scope)', () => {
    const mine: KbPage = {id: 'mine', title: 'Mia', body: 'x', kind: null, project: 'CYAU', projectName: null, updatedAt: null}
    const other: KbPage = {id: 'other', title: 'Altrui', body: 'segreto', kind: null, project: 'CYRA', projectName: null, updatedAt: null}
    const {kb} = recordingKb({q: {ok: true, pages: [mine, other]}})
    const pack = gatherGuidance({project: 'CYAU', cwd: '/wt', queries: ['q']}, {fs: localFs(), kb})
    expect(pack.markdown).not.toContain('segreto')
    expect(pack.markdown).not.toContain('Altrui')
    expect(pack.sources.filter((s) => s.origin === 'knowledge').map((s) => s.ref)).toEqual(['mine'])
    expect(pack.notes.some((n) => n.includes('altri progetti'))).toBe(true)
  })

  it('a page without explicit project is kept (already filtered server-side by -p)', () => {
    const page: KbPage = {id: 'p', title: 'G', body: 'x', kind: null, project: null, projectName: null, updatedAt: null}
    const {kb} = recordingKb({q: {ok: true, pages: [page]}})
    const pack = gatherGuidance({project: 'CYAU', cwd: '/wt', queries: ['q']}, {fs: localFs(), kb})
    expect(pack.hasKnowledge).toBe(true)
  })

  it('project-key with different casing does NOT discard the pages (CloseYourIt keys are case-insensitive)', () => {
    // The orchestrator passes lowercase `cyau`; `cyi kb` accepts it case-insensitively and returns the canonical `CYAU` key.
    const page: KbPage = {id: 'p', title: 'G', body: 'x', kind: null, project: 'CYAU', projectName: null, updatedAt: null}
    const {kb} = recordingKb({q: {ok: true, pages: [page]}})
    const pack = gatherGuidance({project: 'cyau', cwd: '/wt', queries: ['q']}, {fs: localFs(), kb})
    expect(pack.hasKnowledge).toBe(true)
    expect(pack.notes.some((n) => n.includes('altri progetti'))).toBe(false)
  })
})

describe('gatherGuidance — best-effort on the Knowledge (does not block the preparation)', () => {
  it('a failed search does not throw: it degrades to the local guidance only, noting it', () => {
    const {kb} = recordingKb({q: {ok: false, reason: 'rete non disponibile'}})
    const pack = gatherGuidance({project: 'CYAU', cwd: '/wt', queries: ['q']}, {fs: localFs(), kb})
    expect(pack.hasLocal).toBe(true)
    expect(pack.knowledgeAvailable).toBe(false)
    expect(pack.markdown).toContain('Knowledge non consultabile in questo momento')
    expect(pack.notes.some((n) => n.includes('rete non disponibile'))).toBe(true)
  })

  it('if one query fails but another succeeds, the Knowledge stays consultable', () => {
    const page: KbPage = {id: 'p', title: 'G', body: 'x', kind: null, project: 'CYAU', projectName: null, updatedAt: null}
    const {kb} = recordingKb({a: {ok: false, reason: 'timeout'}, b: {ok: true, pages: [page]}})
    const pack = gatherGuidance({project: 'CYAU', cwd: '/wt', queries: ['a', 'b']}, {fs: localFs(), kb})
    expect(pack.knowledgeAvailable).toBe(true)
    expect(pack.hasKnowledge).toBe(true)
  })

  it('no query → the Knowledge is not queried (local guidance only), noted', () => {
    const {kb, calls} = recordingKb()
    const pack = gatherGuidance({project: 'CYAU', cwd: '/wt', queries: []}, {fs: localFs(), kb})
    expect(calls).toHaveLength(0)
    expect(pack.knowledgeAvailable).toBe(true)
    expect(pack.hasKnowledge).toBe(false)
    expect(pack.notes.some((n) => n.includes('Nessuna query'))).toBe(true)
  })

  it('deduplicates the queries before querying (no repeated search)', () => {
    const {kb, calls} = recordingKb()
    gatherGuidance({project: 'CYAU', cwd: '/wt', queries: ['stessa', 'stessa']}, {fs: localFs(), kb})
    expect(calls).toHaveLength(1)
  })

  it('ignores the empty/whitespace queries (no search on an empty query)', () => {
    const {kb, calls} = recordingKb()
    gatherGuidance({project: 'CYAU', cwd: '/wt', queries: ['', '  ', 'valida']}, {fs: localFs(), kb})
    expect(calls.map((c) => c.query)).toEqual(['valida'])
  })
})

describe('assertSafeProject — input defence (the project-key ends up in the cyi argv)', () => {
  it('accepts a safe project-key', () => {
    expect(() => assertSafeProject('CYAU')).not.toThrow()
  })

  it('rejects empty/separators/hostile keys → C400-GUIDANCE-001 (exit 2)', () => {
    for (const bad of ['', 'a/b', '..', '__proto__']) {
      const err = (() => {
        try {
          assertSafeProject(bad)
        } catch (e) {
          return e as AutomatorError
        }
      })()
      expect(err?.code).toBe(ErrorCodes.Guidance.invalidInput)
      expect(err?.exitCode).toBe(2)
    }
  })
})

describe('defaultKbProbe — real read-only probe (cyi kb search)', () => {
  it('builds the `cyi kb search <query> -p <project> --json` argv and parses on exit 0', () => {
    const calls: Array<{cmd: string; args: string[]}> = []
    const run = (cmd: string, args: string[]) => {
      calls.push({cmd, args})
      return {status: 0, stdout: JSON.stringify({data: [{id: 'p', title: 't', body: 'b'}]}), stderr: ''}
    }
    const outcome = defaultKbProbe(run).search({query: 'deploy', project: 'CYAU'})
    expect(calls[0]).toEqual({cmd: 'cyi', args: ['kb', 'search', 'deploy', '-p', 'CYAU', '--json']})
    expect(outcome).toEqual({ok: true, pages: [{id: 'p', title: 't', body: 'b', kind: null, project: null, projectName: null, updatedAt: null}]})
  })

  it('exit ≠ 0 → ok:false with the reason (best-effort, the caller degrades)', () => {
    const run = () => ({status: 1, stdout: '', stderr: 'C401 unauthorized'})
    expect(defaultKbProbe(run).search({query: 'x', project: 'CYAU'})).toEqual({ok: false, reason: 'C401 unauthorized'})
  })

  it('exit ≠ 0 without stderr → reason from stdout or from the exit code', () => {
    expect(defaultKbProbe(() => ({status: 2, stdout: 'boom', stderr: ''})).search({query: 'x', project: 'CYAU'})).toEqual({
      ok: false,
      reason: 'boom',
    })
    expect(defaultKbProbe(() => ({status: null, stdout: '', stderr: ''})).search({query: 'x', project: 'CYAU'})).toEqual({
      ok: false,
      reason: 'exit null',
    })
  })

  it('is read-only by construction: exposes no write method', () => {
    const probe = defaultKbProbe(() => ({status: 0, stdout: '{"data":[]}', stderr: ''}))
    expect('create' in probe).toBe(false)
    expect('update' in probe).toBe(false)
    expect('delete' in probe).toBe(false)
    expect(Object.keys(probe)).toEqual(['search'])
  })
})

describe('defaultRunner / defaultGuidanceFs — real probes (offline, deterministic)', () => {
  it('defaultRunner: a non-existent binary → status null + reason (never throws)', () => {
    const outcome = defaultRunner('automator-binario-inesistente-xyz', ['--x'])
    expect(outcome.status).toBeNull()
    expect(outcome.stderr).not.toBe('')
  })

  it('defaultRunner: a real command exiting 0 captures the stdout', () => {
    const outcome = defaultRunner(process.execPath, ['-e', 'process.stdout.write("ok")'])
    expect(outcome.status).toBe(0)
    expect(outcome.stdout).toBe('ok')
    expect(outcome.stderr).toBe('')
  })

  it('defaultRunner: a hanging command is terminated by the hard timeout', () => {
    const outcome = defaultRunner(process.execPath, ['-e', 'setInterval(() => undefined, 1000)'], 20)
    expect(outcome.status).toBeNull()
    expect(outcome.stderr).toContain('ETIMEDOUT')
  })

  it('defaultGuidanceFs: reads a real file and recognizes the repo root (.git)', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'automator-guidance-'))
    try {
      fs.writeFileSync(path.join(dir, 'CLAUDE.md'), '# reale')
      fs.mkdirSync(path.join(dir, '.git'))
      const probe = defaultGuidanceFs()
      expect(probe.read(path.join(dir, 'CLAUDE.md'))).toBe('# reale')
      expect(probe.read(path.join(dir, 'assente.md'))).toBeNull()
      expect(probe.isRepoRoot(dir)).toBe(true)
      expect(probe.isRepoRoot(path.join(dir, 'sub'))).toBe(false)
    } finally {
      fs.rmSync(dir, {recursive: true, force: true})
    }
  })

  it('gatherGuidance with the real probes: gathers the local guidance from a repo on disk', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'automator-guidance-'))
    try {
      fs.writeFileSync(path.join(dir, 'AGENTS.md'), '# agenti')
      fs.mkdirSync(path.join(dir, '.git'))
      // No query → the KB is not queried: the test stays offline.
      const pack = gatherGuidance({project: 'CYAU', cwd: dir, queries: []}, {fs: defaultGuidanceFs(), kb: defaultKbProbe()})
      expect(pack.hasLocal).toBe(true)
      expect(pack.markdown).toContain('# agenti')
    } finally {
      fs.rmSync(dir, {recursive: true, force: true})
    }
  })
})
