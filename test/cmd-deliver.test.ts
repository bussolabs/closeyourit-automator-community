import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import {afterEach, beforeEach, describe, expect, it} from 'vitest'
import Deliver from '../src/commands/deliver'
import {
  type CreatePrArgs,
  type DeliveryProbe,
  type FindPrArgs,
  type LinkTicketArgs,
  type PushArgs,
} from '../src/lib/deliver'
import {runCaptured, runExpectingExit} from './helpers/command'

// The `deliver` command (CYAU-24) delivers the run for human review: it pushes the allowed branch
// (ticket/*), opens the PR (with summary/tests/risks) and links ticket ↔ PR — never a merge, never an automatic
// resolution, and since CYAU-174 not even a status transition: the server does that when it records the
// delivery. Safe-by-default shell gate: delivered → exit 0; non-green gates →
// exit 3; invalid branch/ticket/input → exit 2. The real execution (git/gh/cyi) is injected in tests by a
// fake probe that records the calls (no process, no network).

interface Recorded {
  push: PushArgs[]
  findPr: FindPrArgs[]
  createPr: CreatePrArgs[]
  linkTicket: LinkTicketArgs[]
}

let recorded: Recorded
let existingPr: string | null

function resetRecorded(): void {
  recorded = {push: [], findPr: [], createPr: [], linkTicket: []}
  existingPr = null
}

// Test subclass: injects a fake probe in place of the real one (git/gh/cyi), recording the calls.
class TestDeliver extends Deliver {
  protected makeProbe(): DeliveryProbe {
    return {
      push: (a) => recorded.push.push(a),
      findPr: (a) => {
        recorded.findPr.push(a)
        return existingPr
      },
      createPr: (a) => {
        recorded.createPr.push(a)
        return 'https://github.com/acme/widget/pull/7'
      },
      linkTicket: (a) => recorded.linkTicket.push(a),
    }
  }
}

interface DeliverPayload {
  dryRun: boolean
  ticket?: string
  branch?: string
  base?: string
  title?: string
  body?: string
  autoMerge?: boolean
  prUrl?: string
  prCreated?: boolean
  pushed?: boolean
  linked?: boolean
  cyiStatus?: string
  autoMerged?: boolean
  reasons?: string[]
  error?: {code: string; message: string}
}

const base = ['--ticket', 'CYAU-24', '--branch', 'ticket/CYAU-24', '--project', 'CYAU', '--cwd', '/wt']

beforeEach(() => {
  resetRecorded()
})

describe('deliver command — Scenario 1: gate verdi → push, PR aperta, ticket In Review', () => {
  it('runs push + PR + link + transition and returns the record (exit 0)', async () => {
    const {result} = await runCaptured(TestDeliver, [
      ...base,
      '--gate-passed',
      '--summary',
      'Consegna uniforme',
      '--risk',
      'dipende da gh/cyi',
      '--tests-passed',
      '9',
      '--tests-failed',
      '0',
      '--json',
    ])
    const p = result as DeliverPayload

    expect(recorded.push).toEqual([{cwd: '/wt', branch: 'ticket/CYAU-24', remote: 'origin'}])
    expect(recorded.findPr).toEqual([{cwd: '/wt', branch: 'ticket/CYAU-24', base: 'main'}])
    expect(recorded.createPr).toHaveLength(1)
    expect(recorded.createPr[0].body).toContain('## Riepilogo')
    expect(recorded.createPr[0].body).toContain('## Test')
    expect(recorded.createPr[0].body).toContain('## Rischi')
    expect(recorded.linkTicket).toEqual([{ticket: 'CYAU-24', prUrl: 'https://github.com/acme/widget/pull/7'}])

    expect(p.pushed).toBe(true)
    expect(p.prCreated).toBe(true)
    expect(p.prUrl).toBe('https://github.com/acme/widget/pull/7')
    expect(p.cyiStatus).toBe('in_review')
    expect(p.autoMerged).toBe(false)
  })

  // CYAU-174 — the command no longer has the status flag, and the probe no longer has the verb to apply it.
  it('does not merge and does not move the ticket: neither the flag nor the probe exist any more', async () => {
    const {result} = await runCaptured(TestDeliver, [...base, '--gate-passed', '--summary', 'x', '--json'])
    const p = result as DeliverPayload
    expect(p.autoMerged).toBe(false)
    expect('setCyiStatus' in new TestDeliver([], {} as never)['makeProbe']()).toBe(false)
    // `cyiStatus` in the payload stays: it says which status the server must apply, not which one was applied.
    expect(p.cyiStatus).toBe('in_review')
  })
})

describe('deliver command — idempotenza', () => {
  it('PR already open → reuses the URL, does not recreate it but reconfirms the link', async () => {
    existingPr = 'https://github.com/acme/widget/pull/3'
    const {result} = await runCaptured(TestDeliver, [...base, '--gate-passed', '--summary', 'x', '--json'])
    const p = result as DeliverPayload
    expect(recorded.createPr).toHaveLength(0)
    expect(recorded.linkTicket).toEqual([{ticket: 'CYAU-24', prUrl: 'https://github.com/acme/widget/pull/3'}])
    expect(p.prCreated).toBe(false)
    expect(p.prUrl).toBe('https://github.com/acme/widget/pull/3')
  })
})

describe('deliver command — guardie safe-by-default e difesa all’ingresso', () => {
  it('without --gate-passed does not deliver (default false) → exit 3, dedicated code, nothing executed', async () => {
    const {stdout} = await runExpectingExit(TestDeliver, [...base, '--summary', 'x', '--json'], 3)
    const p = JSON.parse(stdout) as DeliverPayload
    expect(p.error?.code).toBe('C409-DELIVER-002')
    expect(recorded.push).toHaveLength(0)
    expect(recorded.createPr).toHaveLength(0)
  })

  it('non-deliverable branch (main) → exit 2, nothing run', async () => {
    const argv = ['--ticket', 'CYAU-24', '--branch', 'main', '--project', 'CYAU', '--cwd', '/wt', '--gate-passed']
    const {stderr} = await runExpectingExit(TestDeliver, argv, 2)
    expect(stderr).toContain('C400-DELIVER-001')
    expect(recorded.push).toHaveLength(0)
  })

  it('unsafe ticket → exit 2, nothing run', async () => {
    const argv = ['--ticket', 'a/b', '--branch', 'ticket/CYAU-24', '--project', 'CYAU', '--cwd', '/wt', '--gate-passed']
    const {stderr} = await runExpectingExit(TestDeliver, argv, 2)
    expect(stderr).toContain('C400-DELIVER-004')
    expect(recorded.push).toHaveLength(0)
  })

  it('negative test counts → exit 2 (invalid input)', async () => {
    const {stderr} = await runExpectingExit(TestDeliver, [...base, '--gate-passed', '--tests-passed=-1'], 2)
    expect(stderr).toContain('C400-DELIVER-004')
    expect(recorded.push).toHaveLength(0)
  })
})

describe('deliver command — dry-run (plan without executing)', () => {
  it('shows branch, title and body (summary/tests/risks) without pushing or opening the PR', async () => {
    const {result, stdout} = await runCaptured(TestDeliver, [...base, '--summary', 'Apre la PR', '--risk', 'nessuno', '--dry-run'])
    const p = result as DeliverPayload
    expect(p.dryRun).toBe(true)
    expect(p.branch).toBe('ticket/CYAU-24')
    expect(p.title).toBe('CYAU-24: Apre la PR')
    expect(p.body).toContain('## Riepilogo')
    expect(p.body).toContain('## Test')
    expect(p.body).toContain('## Rischi')
    expect(p.autoMerge).toBe(false)
    expect(recorded.push).toHaveLength(0)
    expect(recorded.createPr).toHaveLength(0)
    expect(stdout.toLowerCase()).toContain('riepilogo')
  })

  it('dry-run on a non-deliverable branch → exit 2 (the plan cannot be composed)', async () => {
    const argv = ['--ticket', 'CYAU-24', '--branch', 'develop', '--project', 'CYAU', '--dry-run']
    const {stderr} = await runExpectingExit(TestDeliver, argv, 2)
    expect(stderr).toContain('C400-DELIVER-001')
  })
})

describe('deliver command — contenuto da --result-file (esito uniforme dell’agente)', () => {
  let dir: string
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'automator-cmd-deliver-'))
  })
  afterEach(() => {
    fs.rmSync(dir, {recursive: true, force: true})
  })

  const resultFile = (obj: unknown): string => {
    const f = path.join(dir, 'result.json')
    fs.writeFileSync(f, JSON.stringify(obj))
    return f
  }

  it('extracts summary, tests and risks from the AgentRunResult for the PR body', async () => {
    const file = resultFile({
      outcome: 'success',
      summary: 'Implementata la consegna',
      changedFiles: ['src/lib/deliver.ts'],
      tests: {passed: 34, failed: 0, summary: 'deliver verde'},
      risks: ['richiede gh autenticato'],
      commit: 'abc',
      confidence: 0.95,
      metadata: {runtime: 'claude', action: 'impl', exitCode: 0, errorCode: null, durationMs: 5, logPath: '/l', reportParsed: true},
    })
    const {result} = await runCaptured(TestDeliver, [...base, '--gate-passed', '--result-file', file, '--json'])
    const p = result as DeliverPayload
    const body = recorded.createPr[0].body
    expect(body).toContain('Implementata la consegna')
    expect(body).toContain('34 passati, 0 falliti — deliver verde')
    expect(body).toContain('- richiede gh autenticato')
    expect(p.prCreated).toBe(true)
  })

  it('--result-file with invalid JSON → exit 2', async () => {
    const f = path.join(dir, 'bad.json')
    fs.writeFileSync(f, '{ non json')
    const {stderr} = await runExpectingExit(TestDeliver, [...base, '--gate-passed', '--result-file', f], 2)
    expect(stderr).toContain('C400-DELIVER-004')
  })

  it('--result-file with valid JSON not conforming to AgentRunResult → exit 2', async () => {
    const {stderr} = await runExpectingExit(TestDeliver, [...base, '--gate-passed', '--result-file', resultFile({not: 'un esito agente'})], 2)
    expect(stderr).toContain('C400-DELIVER-004')
  })

  it('non-existent --result-file (not readable) → exit 2', async () => {
    const {stderr} = await runExpectingExit(TestDeliver, [...base, '--gate-passed', '--result-file', path.join(dir, 'missing.json')], 2)
    expect(stderr).toContain('C400-DELIVER-004')
  })
})

describe('deliver command — output', () => {
  it('human output summarizes the delivery; --json does not print the human-readable lines', async () => {
    const human = await runCaptured(TestDeliver, [...base, '--gate-passed', '--summary', 'x'])
    expect(human.stdout.toLowerCase()).toContain('pr')
    // CYAU-174 — the output no longer declares a status this program did not set.
    expect(human.stdout).not.toContain('In Review')
    expect(human.stdout).toContain('merge automatico: no')
    resetRecorded()
    const json = await runCaptured(TestDeliver, [...base, '--gate-passed', '--summary', 'x', '--json'])
    expect(json.stdout).not.toContain('deliver ·')
  })
})
