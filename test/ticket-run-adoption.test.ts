import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import {afterEach, describe, expect, it, vi} from 'vitest'
import {normalizeAgentResult} from '../src/lib/agent-result'
import {type Secrets} from '../src/lib/config'
import {evaluateCycle} from '../src/lib/cycle'
import {decideVerdict} from '../src/lib/review'
import {readRun, runPath, saveRun, type RunRecord} from '../src/lib/state'
import {makeTicketCycleProvider} from '../src/lib/ticket-cycle'
import {makeTicketLeaseProvider} from '../src/lib/ticket-preflight'
import {adoptRecoverableTicketRun} from '../src/lib/ticket-run-adoption'
import {type TicketAutomationEvidence} from '../src/lib/ticket-evidence'
import {ticketBranch, worktreePath, type PrepareResult} from '../src/lib/workspace'

const directories: string[] = []

function temporaryDirectory(): string {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'automator-run-adoption-'))
  directories.push(directory)
  return directory
}

afterEach(() => {
  for (const directory of directories.splice(0)) fs.rmSync(directory, {recursive: true, force: true})
})

const snapshot = {baseCommit: 'a'.repeat(40), snapshotTree: 'b'.repeat(40), diffSha256: 'c'.repeat(64)}
const result = normalizeAgentResult({
  runtime: 'codex',
  action: 'worker',
  result: {status: 'success', exitCode: 0, errorCode: null, durationMs: 1, logPath: '/log', stdout: ''},
})
const automation: TicketAutomationEvidence = {
  gate: {
    checks: [{stage: 'unit', command: 'test', required: true, status: 'passed', exitCode: 0, durationMs: 1}],
    verdict: {passed: true, total: 1, passedCount: 1, skipped: 0, failedRequired: [], failedAdvisory: [], reasons: ['ok']},
  },
  gatedSnapshot: snapshot,
  reviewExecution: {
    status: 'completed', reviewer: 'claude', findings: [], detail: null,
    attestation: {
      reviewedBaseCommit: snapshot.baseCommit,
      reviewedSnapshotTree: snapshot.snapshotTree,
      reviewedDiffSha256: snapshot.diffSha256,
    },
  },
  reviewVerdict: decideVerdict({implementer: 'codex', reviewer: 'claude', executionStatus: 'completed', findings: []}),
  cycleDecision: evaluateCycle({verdict: 'approved', cycle: 1}),
  delivery: {
    commit: 'd'.repeat(40), branch: 'ticket/CYAU-37', base: 'main',
    delivery: {
      pushed: true, prUrl: 'https://github.test/closeyourit/automator/pull/37', prCreated: true, linked: false, cyiStatusSet: false,
    },
    publications: [{
      sourceFile: 'docs/recovery.md', pageId: 'page-1', publicationKey: 'pub-1', action: 'create',
    }],
  },
}

function inReviewRun(runId: string, worktree: string, adoptedFrom?: string): RunRecord {
  return {
    run_id: runId,
    ...(adoptedFrom ? {adopted_from: adoptedFrom} : {}),
    ticket: 'CYAU-37',
    repository: 'closeyourit/automator',
    runtime: 'codex',
    updated_at: '2026-07-14T10:00:00.000Z',
    result,
    checkpoints: [{
      phase: 'in_review', branch: 'ticket/CYAU-37', commit: 'd'.repeat(40), worktree, dirty: false,
      artifacts: [
        `commit:${'d'.repeat(40)}`,
        'branch:ticket/CYAU-37',
        'pr:https://github.test/closeyourit/automator/pull/37',
        'knowledge:page-1',
      ],
      outcome: 'success', at: '2026-07-14T10:00:00.000Z', result, automation,
    }],
  }
}

describe('crash-safe adoption of an in_review delivery', () => {
  it('two claims with different run-ids adopt the leaf and the delivery restarts without duplicating the effects', async () => {
    const root = temporaryDirectory()
    const runsBase = path.join(root, 'runs')
    const worktreesBase = path.join(root, 'worktrees')
    const expectedWorktree = worktreePath('CYAU', 'CYAU-37', worktreesBase)
    fs.mkdirSync(expectedWorktree, {recursive: true})
    const ids = ['run-1', 'run-2']
    const requests: string[] = []
    const client = {
      acquireLease: vi.fn(async (request: {ticket: string; host_id: string; run_id: string}) => {
        requests.push(request.run_id)
        return {
          outcome: 'acquired' as const,
          lease: {...request, expires_at: '2026-07-14T11:00:00.000Z'},
        }
      }),
      claimTicketQueue: vi.fn(),
      renewLease: vi.fn(),
      releaseLease: vi.fn(async () => true),
    }
    const provider = makeTicketLeaseProvider(
      {sync: {}, host: {id: 'host-1', token: 'cyi_ah_valid'}} as Secrets,
      {
        client,
        store: {save: vi.fn(), update: vi.fn(), remove: vi.fn()},
        runId: () => ids.shift()!,
        runsBase,
        worktreesBase,
      },
    )
    const ticket = {project: 'CYAU', code: 'CYAU-37', cwd: '/repo', title: 'Delivery', comments: []}

    const first = await provider.acquire('worker', ticket, undefined, 'closeyourit/automator')
    expect(first).toMatchObject({outcome: 'acquired', runId: 'run-1'})
    fs.mkdirSync(runsBase, {recursive: true})
    saveRun(runPath('run-1', runsBase), inReviewRun('run-1', expectedWorktree))
    if (first.outcome !== 'acquired') throw new Error('primo claim non acquisito')
    await first.lease.release()

    const second = await provider.acquire('worker', ticket, undefined, 'closeyourit/automator')
    expect(second).toMatchObject({outcome: 'acquired', runId: 'run-2'})
    expect(requests).toEqual(['run-1', 'run-2'])
    const adopted = readRun(runPath('run-2', runsBase)).run
    expect(adopted).toMatchObject({
      run_id: 'run-2', adopted_from: 'run-1',
      checkpoints: [{phase: 'in_review', automation: {delivery: {publications: [{publicationKey: 'pub-1'}]}}}],
    })

    const workspace: PrepareResult = {
      repoPath: path.join(root, 'repositories', 'closeyourit', 'automator'),
      worktreePath: expectedWorktree,
      branch: ticketBranch('CYAU-37'),
      repoAction: 'reuse',
      worktreeAction: 'reuse',
    }
    const effects = {push: 0, pr: 0, link: 0, status: 0, publish: 0, attest: 0}
    const cycle = makeTicketCycleProvider({
      runsBase,
      prepareWorkspace: () => workspace,
      inspectWorkspace: () => workspace,
      checkpointGit: {currentBranch: () => workspace.branch, headCommit: () => 'd'.repeat(40), isDirty: () => false},
      resolveReviewDiff: vi.fn(async () => ({...snapshot, diff: 'diff'})),
      delivery: {
        authorized: true,
        git: {commitApproved: () => { throw new Error('commit duplicato') }, attestCommit: () => { effects.attest++ }},
        probe: {
          push: () => { effects.push++ }, findPr: () => { effects.pr++; return null },
          createPr: () => { effects.pr++; return 'https://duplicate' }, ticketLinkExists: () => false,
          linkTicket: () => { effects.link++ }, setCyiStatus: () => { effects.status++ },
        },
        kb: {publish: () => { effects.publish++; throw new Error('pubblicazione duplicata') }},
        knowledgeArtifacts: () => [{sourceFile: 'docs/recovery.md', title: 'Recovery', kind: 'guide'}],
      },
    })
    const lifecycle = await cycle.prepare({
      runId: 'run-2', project: 'CYAU', ticket: 'CYAU-37', repository: 'closeyourit/automator',
      runtime: 'codex', base: 'origin/main', requirements: 'delivery recovery',
    })
    await expect(lifecycle.resumeAfterInterruption?.()).resolves.toMatchObject({runStatus: 'success'})
    // CYAU-174 — the fake probe still OFFERS `setCyiStatus`: zero calls is the proof that not even the
    // delivery adopted after a crash touches the status. The server writes it.
    expect(effects).toEqual({push: 0, pr: 0, link: 1, status: 0, publish: 0, attest: 1})
    expect(readRun(runPath('run-2', runsBase)).run).toMatchObject({
      adopted_from: 'run-1', checkpoints: expect.arrayContaining([expect.objectContaining({phase: 'completed'})]),
    })
  })

  it('preserves the ancestors for audit, selects only the leaf and fails closed on a real fork', () => {
    const root = temporaryDirectory()
    const runsBase = path.join(root, 'runs')
    const worktree = path.join(root, 'worktree')
    fs.mkdirSync(worktree, {recursive: true})
    fs.mkdirSync(runsBase, {recursive: true})
    saveRun(runPath('old', runsBase), inReviewRun('old', worktree))

    expect(adoptRecoverableTicketRun({
      runId: 'next', ticket: 'CYAU-37', repository: 'closeyourit/automator',
      expectedBranch: 'ticket/CYAU-37', expectedWorktree: worktree, runsBase,
    })).toEqual({outcome: 'adopted', sourceRunId: 'old'})
    expect(readRun(runPath('old', runsBase)).run?.adopted_from).toBeUndefined()

    // Simulates the crash right after the single write of the new record: the ancestor is still `in_review`, but the
    // resolver must follow the lineage and choose exclusively the `next` leaf.
    expect(adoptRecoverableTicketRun({
      runId: 'third', ticket: 'CYAU-37', repository: 'closeyourit/automator',
      expectedBranch: 'ticket/CYAU-37', expectedWorktree: worktree, runsBase,
    })).toEqual({outcome: 'adopted', sourceRunId: 'next'})

    saveRun(runPath('fork', runsBase), inReviewRun('fork', worktree, 'old'))
    expect(() => adoptRecoverableTicketRun({
      runId: 'fourth', ticket: 'CYAU-37', repository: 'closeyourit/automator',
      expectedBranch: 'ticket/CYAU-37', expectedWorktree: worktree, runsBase,
    })).toThrow(/biforcata|ambigua/i)
  })

  it('without recoverable state creates no file and the same run-id already a leaf is reusable', () => {
    const root = temporaryDirectory()
    const runsBase = path.join(root, 'runs')
    const worktree = path.join(root, 'worktree')
    fs.mkdirSync(worktree, {recursive: true})
    expect(adoptRecoverableTicketRun({
      runId: 'new', ticket: 'CYAU-37', repository: 'closeyourit/automator',
      expectedBranch: 'ticket/CYAU-37', expectedWorktree: worktree, runsBase,
    })).toEqual({outcome: 'none', sourceRunId: null})
    expect(fs.existsSync(runPath('new', runsBase))).toBe(false)

    fs.mkdirSync(runsBase, {recursive: true})
    saveRun(runPath('same', runsBase), inReviewRun('same', worktree))
    expect(adoptRecoverableTicketRun({
      runId: 'same', ticket: 'CYAU-37', repository: 'closeyourit/automator',
      expectedBranch: 'ticket/CYAU-37', expectedWorktree: worktree, runsBase,
    })).toEqual({outcome: 'reused', sourceRunId: 'same'})
  })

  it('rejects invalid identity, lineage, attestation and workspace', () => {
    const cases = [
      {
        name: 'file/run mismatch',
        prepare(base: string, worktree: string) { saveRun(runPath('named', base), inReviewRun('other', worktree)) },
        expected: /file\/run/,
      },
      {
        name: 'source lineage assente',
        prepare(base: string, worktree: string) { saveRun(runPath('leaf', base), inReviewRun('leaf', worktree, 'missing')) },
        expected: /lineage.*incompleta/,
      },
      {
        name: 'lineage ciclica',
        prepare(base: string, worktree: string) {
          saveRun(runPath('one', base), inReviewRun('one', worktree, 'two'))
          saveRun(runPath('two', base), inReviewRun('two', worktree, 'one'))
        },
        expected: /ciclica/,
      },
      {
        name: 'figlio con identità differente',
        prepare(base: string, worktree: string) {
          saveRun(runPath('parent', base), inReviewRun('parent', worktree))
          const child = inReviewRun('child', worktree, 'parent')
          child.ticket = 'OTHER-1'
          saveRun(runPath('child', base), child)
        },
        expected: /identità.*differenti/,
      },
      {
        name: 'lineage malformata',
        prepare(base: string, worktree: string) {
          saveRun(runPath('parent', base), inReviewRun('parent', worktree))
          const malformed = {...inReviewRun('child', worktree), adopted_from: '../escape'}
          fs.writeFileSync(runPath('child', base), JSON.stringify(malformed))
        },
        expected: /lineage.*corrotto|corrotto.*lineage/,
      },
      {
        name: 'figlio corrotto',
        prepare(base: string, worktree: string) {
          saveRun(runPath('parent', base), inReviewRun('parent', worktree))
          const child = {...inReviewRun('child', worktree, 'parent'), checkpoints: [42]}
          fs.writeFileSync(runPath('child', base), JSON.stringify(child))
        },
        expected: /corrotto/,
      },
      {
        name: 'attestazione mancante',
        prepare(base: string, worktree: string) {
          const invalid = inReviewRun('leaf', worktree)
          delete invalid.checkpoints[0].automation
          saveRun(runPath('leaf', base), invalid)
        },
        expected: /attestazione/,
      },
      {
        name: 'workspace inatteso',
        prepare(base: string, worktree: string) { saveRun(runPath('leaf', base), inReviewRun('leaf', worktree)) },
        expected: /workspace\/branch/,
        wrongWorktree: true,
      },
    ]
    for (const fixture of cases) {
      const root = temporaryDirectory()
      const runsBase = path.join(root, 'runs')
      const worktree = path.join(root, 'worktree')
      fs.mkdirSync(worktree, {recursive: true})
      fs.mkdirSync(runsBase, {recursive: true})
      fixture.prepare(runsBase, worktree)
      const expectedWorktree = fixture.wrongWorktree ? path.join(root, 'missing') : worktree
      expect(() => adoptRecoverableTicketRun({
        runId: 'new', ticket: 'CYAU-37', repository: 'closeyourit/automator',
        expectedBranch: 'ticket/CYAU-37', expectedWorktree, runsBase,
      }), fixture.name).toThrow(fixture.expected)
    }
  })

  it('rejects multiple independent leaves and a new file already occupied by an incompatible state', () => {
    const root = temporaryDirectory()
    const runsBase = path.join(root, 'runs')
    const worktree = path.join(root, 'worktree')
    fs.mkdirSync(worktree, {recursive: true})
    fs.mkdirSync(runsBase, {recursive: true})
    saveRun(runPath('one', runsBase), inReviewRun('one', worktree))
    saveRun(runPath('two', runsBase), inReviewRun('two', worktree))
    expect(() => adoptRecoverableTicketRun({
      runId: 'new', ticket: 'CYAU-37', repository: 'closeyourit/automator',
      expectedBranch: 'ticket/CYAU-37', expectedWorktree: worktree, runsBase,
    })).toThrow(/più run|ambigua/i)

    fs.rmSync(runPath('two', runsBase))
    const occupied = inReviewRun('new', worktree)
    occupied.ticket = 'OTHER-1'
    saveRun(runPath('new', runsBase), occupied)
    expect(() => adoptRecoverableTicketRun({
      runId: 'new', ticket: 'CYAU-37', repository: 'closeyourit/automator',
      expectedBranch: 'ticket/CYAU-37', expectedWorktree: worktree, runsBase,
    })).toThrow(/stato incompatibile/i)
  })

  it('rejects a hostile destination run-id before reading the state', () => {
    expect(() => adoptRecoverableTicketRun({
      runId: '../escape', ticket: 'CYAU-37', repository: 'closeyourit/automator',
      expectedBranch: 'ticket/CYAU-37', expectedWorktree: '/tmp',
    })).toThrow(/run-id.*non valido/i)
  })

  it('a corrupt JSON without identity or relevant edge does not block a fresh claim without recovery', () => {
    const root = temporaryDirectory()
    const runsBase = path.join(root, 'runs')
    const worktree = path.join(root, 'worktree')
    fs.mkdirSync(runsBase, {recursive: true})
    fs.mkdirSync(worktree, {recursive: true})
    fs.writeFileSync(runPath('unrelated', runsBase), '{')
    fs.writeFileSync(path.join(runsBase, 'ignore.txt'), 'x')
    fs.writeFileSync(path.join(runsBase, 'constructor.json'), '{}')
    fs.mkdirSync(path.join(runsBase, 'directory.json'))
    expect(adoptRecoverableTicketRun({
      runId: 'fresh', ticket: 'CYAU-37', repository: 'closeyourit/automator',
      expectedBranch: 'ticket/CYAU-37', expectedWorktree: worktree, runsBase,
    })).toEqual({outcome: 'none', sourceRunId: null})
  })

  it('does not let run/checkpoint fields discarded by the permissive read hide a child', () => {
    type Raw = Record<string, unknown>
    const mutations: Array<[string, (raw: Raw) => void]> = [
      ['run_id', (raw) => { raw.run_id = 42 }],
      ['ticket', (raw) => { raw.ticket = 42 }],
      ['repository', (raw) => { raw.repository = 42 }],
      ['updated_at', (raw) => { raw.updated_at = 42 }],
      ['checkpoints', (raw) => { raw.checkpoints = 'no' }],
      ['result run', (raw) => { raw.result = {status: 'invented'} }],
      ['checkpoint non object', (raw) => { raw.checkpoints = [42] }],
      ['phase', (raw) => { (raw.checkpoints as Raw[])[0].phase = 42 }],
      ['branch', (raw) => { (raw.checkpoints as Raw[])[0].branch = 42 }],
      ['commit', (raw) => { (raw.checkpoints as Raw[])[0].commit = 42 }],
      ['worktree', (raw) => { (raw.checkpoints as Raw[])[0].worktree = 42 }],
      ['dirty', (raw) => { (raw.checkpoints as Raw[])[0].dirty = 'yes' }],
      ['artifacts shape', (raw) => { (raw.checkpoints as Raw[])[0].artifacts = 'no' }],
      ['artifact item', (raw) => { (raw.checkpoints as Raw[])[0].artifacts = [42] }],
      ['outcome', (raw) => { (raw.checkpoints as Raw[])[0].outcome = 'invented' }],
      ['at', (raw) => { (raw.checkpoints as Raw[])[0].at = 42 }],
      ['result checkpoint', (raw) => { (raw.checkpoints as Raw[])[0].result = {status: 'invented'} }],
      ['automation', (raw) => { (raw.checkpoints as Raw[])[0].automation = {gate: 'invented'} }],
    ]
    for (const [name, mutate] of mutations) {
      const root = temporaryDirectory()
      const runsBase = path.join(root, 'runs')
      const worktree = path.join(root, 'worktree')
      fs.mkdirSync(runsBase, {recursive: true})
      fs.mkdirSync(worktree, {recursive: true})
      saveRun(runPath('parent', runsBase), inReviewRun('parent', worktree))
      const raw = structuredClone(inReviewRun('child', worktree, 'parent')) as unknown as Raw
      mutate(raw)
      fs.writeFileSync(runPath('child', runsBase), JSON.stringify(raw))
      expect(() => adoptRecoverableTicketRun({
        runId: 'new', ticket: 'CYAU-37', repository: 'closeyourit/automator',
        expectedBranch: 'ticket/CYAU-37', expectedWorktree: worktree, runsBase,
      }), name).toThrow(/corrotto/i)
    }
  })

  it('ignores free-phase legacy checkpoints and adopts only the canonical in_review leaf', () => {
    const root = temporaryDirectory()
    const runsBase = path.join(root, 'runs')
    const worktree = path.join(root, 'worktree')
    fs.mkdirSync(runsBase, {recursive: true})
    fs.mkdirSync(worktree, {recursive: true})
    for (const phase of ['setup', 'commit', 'x'.repeat(97)]) {
      const legacy = inReviewRun(`legacy-${phase}`, worktree)
      legacy.checkpoints[0].phase = phase
      saveRun(runPath(`legacy-${phase}`, runsBase), legacy)
    }
    saveRun(runPath('candidate', runsBase), inReviewRun('candidate', worktree))

    expect(adoptRecoverableTicketRun({
      runId: 'new', ticket: 'CYAU-37', repository: 'closeyourit/automator',
      expectedBranch: 'ticket/CYAU-37', expectedWorktree: worktree, runsBase,
    })).toEqual({outcome: 'adopted', sourceRunId: 'candidate'})
  })
})
