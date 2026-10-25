import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import {spawnSync} from 'node:child_process'
import {afterEach, describe, expect, it, vi} from 'vitest'
import {normalizeAgentResult} from '../src/lib/agent-result'
import {type DeliveryProbe} from '../src/lib/deliver'
import {
  assertChangesetWithinLimits,
  defaultTicketDeliveryGit,
  knowledgeArtifactsFromResult,
  measureChangeset,
  observedHeadSha,
  runTicketDelivery,
  trustedPrBase,
  type TicketDeliveryInput,
} from '../src/lib/ticket-delivery'
import {type TicketAutomationEvidence, type TicketDeliveryEvidence} from '../src/lib/ticket-evidence'
import {type KbPublisher, type PublishRepo} from '../src/lib/publish'

const dirs: string[] = []
afterEach(() => {
  vi.restoreAllMocks()
  for (const dir of dirs.splice(0)) fs.rmSync(dir, {recursive: true, force: true})
})

const snapshot = {baseCommit: 'a'.repeat(40), snapshotTree: 'b'.repeat(40), diffSha256: 'c'.repeat(64)}
const automation: TicketAutomationEvidence = {
  gate: {checks: [], verdict: {passed: true, total: 0, passedCount: 0, skipped: 0, failedRequired: [], failedAdvisory: [], reasons: []}},
  gatedSnapshot: snapshot,
  reviewExecution: {
    status: 'completed', reviewer: 'claude', findings: [], detail: null,
    attestation: {reviewedBaseCommit: snapshot.baseCommit, reviewedSnapshotTree: snapshot.snapshotTree, reviewedDiffSha256: snapshot.diffSha256},
  },
  reviewVerdict: {verdict: 'approved', reviewer: 'claude', crossReviewed: true, findings: [], reasons: []},
  cycleDecision: {next: 'in_review', cycle: 1, limit: 2, limitReached: false, requiresHuman: true, reasons: []},
}

const raw = {status: 'success' as const, exitCode: 0, errorCode: null, durationMs: 1, logPath: '/log', stdout: JSON.stringify({
  summary: 'Delivery completa', changed_files: ['docs/a.md', 'docs/adr/b.md', 'src/a.ts', 'docs/a.md'],
  tests: {passed: 2, failed: 0, summary: 'ok'}, risks: [],
})}
const result = normalizeAgentResult({runtime: 'codex', action: 'ticket', result: raw})

function input(overrides: Partial<TicketDeliveryInput> = {}): TicketDeliveryInput {
  return {
    project: 'CYAU', ticket: 'CYAU-37', runId: 'run-37', cwd: '/wt', branch: 'ticket/CYAU-37',
    trustedBase: 'origin/main', authorized: true, automation, result,
    knowledgeArtifacts: knowledgeArtifactsFromResult(result), ...overrides,
  }
}

function harness(options: {failLinkOnce?: boolean; failPublishAt?: number} = {}) {
  const calls = {commit: 0, attest: 0, push: 0, find: 0, create: 0, link: 0, status: 0, publish: [] as string[]}
  let linkFailed = false
  let publishCount = 0
  const persisted: TicketDeliveryEvidence[] = []
  const delivery: DeliveryProbe = {
    push: () => { calls.push++ },
    findPr: () => { calls.find++; return null },
    createPr: () => { calls.create++; return 'https://github.test/acme/repo/pull/37' },
    ticketLinkExists: () => false,
    linkTicket: () => {
      calls.link++
      if (options.failLinkOnce && !linkFailed) { linkFailed = true; throw new Error('link outage') }
    },
    setCyiStatus: () => { calls.status++ },
  }
  const publishRepo: PublishRepo = {
    headCommit: () => 'd'.repeat(40),
    isTracked: () => true,
    read: ({file}) => `# ${file}\n`,
  }
  const kb: KbPublisher = {
    publish: ({publicationKey, title}) => {
      publishCount++
      calls.publish.push(title)
      if (options.failPublishAt === publishCount) throw new Error('kb outage')
      return {id: `page-${title}`, action: 'create', adoptedLegacy: false}
    },
  }
  return {
    calls, persisted,
    deps: {
      git: {
        commitApproved: () => { calls.commit++; return 'd'.repeat(40) },
        attestCommit: () => { calls.attest++ },
      },
      delivery, publishRepo, kb,
      persist: (evidence: TicketDeliveryEvidence) => persisted.push(structuredClone(evidence)),
    },
  }
}

describe('ticket delivery integrata', () => {
  it('starts only with a green gate and an attested approved review', async () => {
    const h = harness()
    await expect(runTicketDelivery(input({automation: {...automation, reviewVerdict: {...automation.reviewVerdict!, verdict: 'changes_requested'}}}), h.deps))
      .rejects.toThrow(/gate\/review attestati/i)
    expect(h.calls.commit).toBe(0)
    expect(h.calls.push).toBe(0)
  })

  it('commits, pushes, reuses the PR modules and publishes 0/1/N versioned files with auditable artifacts', async () => {
    for (const count of [0, 1, 2]) {
      const h = harness()
      const artifacts = knowledgeArtifactsFromResult(result).slice(0, count)
      const output = await runTicketDelivery(input({knowledgeArtifacts: artifacts}), h.deps)
      // CYAU-174 — the fake probe still OFFERS `setCyiStatus`: zero calls is the proof that the delivery
      // does not use it even when it has it at hand. The server writes the status.
      expect(h.calls).toMatchObject({commit: 1, push: 1, create: 1, link: 1, status: 0})
      expect(output.evidence.publications).toHaveLength(count)
      expect(output.artifacts).toEqual(expect.arrayContaining([
        `commit:${'d'.repeat(40)}`, 'branch:ticket/CYAU-37', 'pr:https://github.test/acme/repo/pull/37',
      ]))
      expect(output.artifacts.filter((entry) => entry.startsWith('knowledge:'))).toHaveLength(count)
    }
  })

  it('if the remote capability is missing persists the local commit and stays suspended without push/PR/Knowledge', async () => {
    const h = harness()
    const output = await runTicketDelivery(input({authorized: false}), h.deps)
    expect(output.status).toBe('suspended')
    expect(output.delivery).toBeNull()
    expect(h.calls.commit).toBe(1)
    expect(h.persisted.at(-1)?.commit).toBe('d'.repeat(40))
    expect(h.calls.push).toBe(0)
    expect(h.calls.publish).toEqual([])
  })

  it('resumes after PR created/link failed without duplicating commit, push or PR', async () => {
    const h = harness({failLinkOnce: true})
    await expect(runTicketDelivery(input({knowledgeArtifacts: []}), h.deps)).rejects.toThrow(/link outage/)
    const checkpoint = h.persisted.at(-1)!
    expect(checkpoint).toMatchObject({commit: 'd'.repeat(40), delivery: {pushed: true, prUrl: 'https://github.test/acme/repo/pull/37'}})
    const output = await runTicketDelivery(input({knowledgeArtifacts: []}), h.deps, checkpoint)
    expect(output.evidence.delivery.linked).toBe(true)
    expect(h.calls).toMatchObject({commit: 1, attest: 1, push: 1, create: 1, link: 2, status: 0})
  })

  it('resumes a partial publish without republishing the already checkpointed page', async () => {
    const h = harness({failPublishAt: 2})
    await expect(runTicketDelivery(input(), h.deps)).rejects.toThrow(/kb outage/)
    const checkpoint = h.persisted.at(-1)!
    expect(checkpoint.publications).toHaveLength(1)
    const output = await runTicketDelivery(input(), h.deps, checkpoint)
    expect(output.evidence.publications).toHaveLength(2)
    expect(h.calls.publish.filter((title) => title === 'a')).toHaveLength(1)
    expect(h.calls).toMatchObject({commit: 1, attest: 1, push: 1, create: 1, link: 1, status: 0})
  })

  it('derives only canonical documents, deduplicated and with ADR as decision', () => {
    expect(knowledgeArtifactsFromResult(result)).toEqual([
      {sourceFile: 'docs/a.md', title: 'a', kind: 'guide'},
      {sourceFile: 'docs/adr/b.md', title: 'b', kind: 'decision'},
    ])
    expect(trustedPrBase('origin/main')).toBe('main')
    expect(trustedPrBase('origin/release/next')).toBe('release/next')
    expect(() => trustedPrBase('origin/HEAD')).toThrow(/non risolta/i)
    expect(() => trustedPrBase('origin/--evil')).toThrow(/Base trusted/i)
    expect(() => trustedPrBase('--upload-pack=evil')).toThrow(/Base trusted/)
  })

  it('rejects inconsistent branch-ticket and checkpoint-base before the effects', async () => {
    const h = harness()
    await expect(runTicketDelivery(input({branch: 'ticket/CYAU-99'}), h.deps)).rejects.toThrow(/non corrisponde/i)
    const recovered: TicketDeliveryEvidence = {
      commit: 'd'.repeat(40), branch: 'ticket/CYAU-37', base: 'develop',
      delivery: {pushed: false, prUrl: null, prCreated: false, linked: false, cyiStatusSet: false}, publications: [],
    }
    await expect(runTicketDelivery(input(), h.deps, recovered)).rejects.toThrow(/checkpoint.*branch\/base/i)
    expect(h.calls.push).toBe(0)
  })

  it('deduplicates repeated explicit artifacts and skips those already published in the checkpoint', async () => {
    const h = harness()
    const artifact = {sourceFile: 'docs/a.md', title: 'a', kind: 'guide' as const}
    const first = await runTicketDelivery(input({knowledgeArtifacts: [artifact, artifact]}), h.deps)
    expect(h.calls.publish).toEqual(['a'])
    const second = await runTicketDelivery(input({knowledgeArtifacts: [artifact]}), h.deps, first.evidence)
    expect(second.publications).toEqual([])
    expect(h.calls.publish).toEqual(['a'])
  })

  it('observes shutdown between push and PR and does not start the next effect', async () => {
    const h = harness()
    const controller = new AbortController()
    const persist = h.deps.persist
    h.deps.persist = (evidence) => {
      persist(evidence)
      if (evidence.delivery.pushed) controller.abort()
    }
    await expect(runTicketDelivery(input({signal: controller.signal, knowledgeArtifacts: []}), h.deps))
      .rejects.toThrow(/annullata/i)
    expect(h.calls).toMatchObject({push: 1, create: 0, link: 0, status: 0})
  })

  it('redacts the summary in the commit and discards Knowledge paths containing secrets', async () => {
    const token = `ghp_${'a'.repeat(36)}`
    const h = harness()
    let message = ''
    h.deps.git.commitApproved = (args) => { message = args.message; return 'd'.repeat(40) }
    const unsafeResult = {...result, summary: `fix ${token}`, changedFiles: [`docs/${token}.md`, 'docs/safe.md']}
    await runTicketDelivery(input({authorized: false, result: unsafeResult}), h.deps)
    expect(message).not.toContain(token)
    expect(message).toContain('[REDACTED]')
    expect(knowledgeArtifactsFromResult(unsafeResult).map((entry) => entry.sourceFile)).toEqual(['docs/safe.md'])
  })
})

function initRepo(): {repo: string; git: (args: string[]) => string; base: string} {
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'automator-delivery-git-'))
  dirs.push(repo)
  const git = (args: string[]): string => {
    const output = spawnSync('git', ['-C', repo, ...args], {encoding: 'utf8'})
    if (output.status !== 0) throw new Error(output.stderr)
    return output.stdout.trim()
  }
  git(['init', '-q', '-b', 'ticket/CYAU-37'])
  git(['config', 'user.name', 'Test'])
  git(['config', 'user.email', 'test@example.test'])
  fs.writeFileSync(path.join(repo, '.gitignore'), 'ignored.txt\n')
  fs.writeFileSync(path.join(repo, 'tracked.txt'), 'base\n')
  git(['add', '.'])
  git(['commit', '-qm', 'base'])
  return {repo, git, base: git(['rev-parse', 'HEAD'])}
}

describe('local commit of the approved snapshot', () => {
  it('includes staged and dirty tracked, excludes ignored, and attests tree/branch/base', () => {
    const {repo, git, base} = initRepo()
    fs.writeFileSync(path.join(repo, 'tracked.txt'), 'changed\n')
    fs.writeFileSync(path.join(repo, 'added.txt'), 'added\n')
    fs.writeFileSync(path.join(repo, 'ignored.txt'), 'secret local only\n')
    git(['add', 'added.txt'])
    const snapshotCommit = git(['stash', 'create', 'approved'])
    const snapshotTree = git(['rev-parse', `${snapshotCommit}^{tree}`])
    const commit = defaultTicketDeliveryGit().commitApproved({
      cwd: repo, branch: 'ticket/CYAU-37', baseCommit: base, snapshotTree, message: 'CYAU-37: delivery',
    })
    expect(git(['rev-parse', `${commit}^{tree}`])).toBe(snapshotTree)
    expect(git(['ls-tree', '-r', '--name-only', commit])).not.toContain('ignored.txt')
    expect(fs.readFileSync(path.join(repo, 'ignored.txt'), 'utf8')).toContain('secret local only')
  })

  it('rejects untracked files appeared after review and TOCTOU mismatch without creating a commit', () => {
    const first = initRepo()
    fs.writeFileSync(path.join(first.repo, 'untracked.txt'), 'race\n')
    expect(() => defaultTicketDeliveryGit().commitApproved({
      cwd: first.repo, branch: 'ticket/CYAU-37', baseCommit: first.base, snapshotTree: 'b'.repeat(40), message: 'x',
    })).toThrow(/TOCTOU/i)
    expect(first.git(['rev-parse', 'HEAD'])).toBe(first.base)

    const second = initRepo()
    fs.writeFileSync(path.join(second.repo, 'tracked.txt'), 'mutated\n')
    expect(() => defaultTicketDeliveryGit().commitApproved({
      cwd: second.repo, branch: 'ticket/CYAU-37', baseCommit: second.base, snapshotTree: 'b'.repeat(40), message: 'x',
    })).toThrow(/TOCTOU/i)
    expect(second.git(['rev-parse', 'HEAD'])).toBe(second.base)
  })

  it('includes a new not yet staged file when it belongs exactly to the approved tree', () => {
    const {repo, git, base} = initRepo()
    fs.writeFileSync(path.join(repo, 'new-file.txt'), 'approved new file\n')
    git(['add', '--all'])
    const snapshotTree = git(['write-tree'])
    git(['reset', '-q', '--', 'new-file.txt'])
    const commit = defaultTicketDeliveryGit().commitApproved({
      cwd: repo, branch: 'ticket/CYAU-37', baseCommit: base, snapshotTree, message: 'new file',
    })
    expect(git(['ls-tree', '-r', '--name-only', commit])).toContain('new-file.txt')
  })

  it('reuses HEAD if the tree is already the approved one and rejects mutated recovered branch/commit', () => {
    const {repo, git, base} = initRepo()
    const tree = git(['rev-parse', 'HEAD^{tree}'])
    const deliveryGit = defaultTicketDeliveryGit()
    expect(deliveryGit.commitApproved({
      cwd: repo, branch: 'ticket/CYAU-37', baseCommit: base, snapshotTree: tree, message: 'noop',
    })).toBe(base)
    expect(() => deliveryGit.commitApproved({
      cwd: repo, branch: 'ticket/OTHER', baseCommit: base, snapshotTree: tree, message: 'noop',
    })).toThrow(/Branch corrente mutato/i)
    expect(() => deliveryGit.attestCommit({
      cwd: repo, branch: 'ticket/CYAU-37', baseCommit: base, snapshotTree: 'b'.repeat(40), commit: base, message: 'x',
    })).toThrow(/non più attestabile/i)
  })

  it('normalizes a Git error without stderr using the exit code', () => {
    const git = defaultTicketDeliveryGit(() => ({status: 7, stdout: '', stderr: ''}))
    expect(() => git.commitApproved({
      cwd: '/', branch: 'ticket/CYAU-37', baseCommit: 'a'.repeat(40), snapshotTree: 'b'.repeat(40), message: 'x',
    })).toThrow(/exit 7/i)
  })

  it('rejects locally configured clean filters before add/commit', () => {
    const {repo, git, base} = initRepo()
    git(['config', 'filter.evil.clean', '/bin/false'])
    const tree = git(['rev-parse', 'HEAD^{tree}'])
    expect(() => defaultTicketDeliveryGit().commitApproved({
      cwd: repo, branch: 'ticket/CYAU-37', baseCommit: base, snapshotTree: tree, message: 'x',
    })).toThrow(/clean filter/i)
  })
})

// CYAU-142 — the automator is the only one committing (the agent cannot: guard-branch-push blocks every `git commit` of its own),
// so "a too big save stopped BEFORE, not after" lives in the delivery commit.
describe('gate on the delivery changeset (CYAU-142)', () => {
  it('within the thresholds does not throw', () => {
    expect(() => assertChangesetWithinLimits({files: 4, bytes: 1000})).not.toThrow()
  })

  it('troppi file → fail-closed exit 3 (C409-DELIVER-005)', () => {
    expect(() => assertChangesetWithinLimits({files: 5, bytes: 0}, {maxFiles: 4, maxBytes: 1e9}))
      .toThrow(/changeset abnorme: 5 file/i)
  })

  it('troppo peso → fail-closed', () => {
    expect(() => assertChangesetWithinLimits({files: 1, bytes: 2 * 1024 * 1024}, {maxFiles: 100, maxBytes: 1024 * 1024}))
      .toThrow(/changeset abnorme.*mib/i)
  })

  it('measureChangeset counts the changeset files and sums the blob sizes (real git)', () => {
    const {repo, git, base} = initRepo()
    fs.writeFileSync(path.join(repo, 'a.txt'), 'x'.repeat(100))
    fs.writeFileSync(path.join(repo, 'b.txt'), 'y'.repeat(50))
    git(['add', '--all'])
    const tree = git(['write-tree'])
    const exec = (cwd: string, args: string[]): string => {
      const r = spawnSync('git', ['-C', cwd, ...args], {encoding: 'utf8'})
      if (r.status !== 0) throw new Error(r.stderr)
      return r.stdout.trim()
    }
    const measured = measureChangeset(repo, base, tree, exec)
    expect(measured.files).toBe(2)
    expect(measured.bytes).toBe(150)
  })

  it('commitApproved rejects an abnormal changeset BEFORE committing (fail-closed, HEAD intact)', () => {
    const {repo, git, base} = initRepo()
    for (let i = 0; i < 1001; i += 1) fs.writeFileSync(path.join(repo, `lib-${i}.rb`), 'x\n')
    git(['add', '--all'])
    const tree = git(['write-tree'])
    expect(() => defaultTicketDeliveryGit().commitApproved({
      cwd: repo, branch: 'ticket/CYAU-37', baseCommit: base, snapshotTree: tree, message: 'CYAU-37: troppi file',
    })).toThrow(/changeset abnorme/i)
    expect(git(['rev-parse', 'HEAD'])).toBe(base)
  })
})
// ── CYAU-178 ──────────────────────────────────────────────────────────────────────────────────────
//
// The identifier of the code the host REALLY has in hand. A wrong identifier is worse than a missing
// one, because it would pass the checks: here it is measured, and when it cannot be measured nothing is answered.
describe('observedHeadSha', () => {
  it('reads the identifier from the working copy', () => {
    const worktree = fs.mkdtempSync(path.join(os.tmpdir(), 'automator-observed-'))
    dirs.push(worktree)
    spawnSync('git', ['init', '-q', worktree])
    fs.writeFileSync(path.join(worktree, 'a.md'), 'a\n')
    spawnSync('git', ['-C', worktree, 'add', '-A'])
    spawnSync('git', ['-C', worktree, '-c', 'user.email=p@p', '-c', 'user.name=P', 'commit', '-q', '-m', 'a'])
    const atteso = spawnSync('git', ['-C', worktree, 'rev-parse', 'HEAD'], {encoding: 'utf8'}).stdout.trim()

    expect(observedHeadSha(worktree)).toBe(atteso)
  })

  // An abbreviation, a symbolic ref, an error message that ended up on stdout: none of the three is an
  // identifier, and accepting them would mean writing on the attempt a datum the reader would believe measured.
  it('discards everything that is not an identifier, instead of passing it on', () => {
    for (const risposta of ['3f2a91c', 'HEAD', '', 'fatal: not a git repository', 'Z'.repeat(40), 'A'.repeat(40)]) {
      expect(observedHeadSha('/qualsiasi', () => ({status: 0, stdout: `${risposta}\n`, stderr: ''})))
        .toBeUndefined()
    }
  })

  it('does not answer when git fails or does not start', () => {
    expect(observedHeadSha('/qualsiasi', () => ({status: 128, stdout: 'a'.repeat(40), stderr: 'fatal'})))
      .toBeUndefined()
    expect(observedHeadSha('/qualsiasi', () => { throw new Error('git assente') })).toBeUndefined()
  })
})
