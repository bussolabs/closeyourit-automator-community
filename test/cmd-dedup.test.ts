import {describe, expect, it} from 'vitest'
import Dedup from '../src/commands/dedup'
import {computeFingerprint, type ExistingTicket, normalizeStack, type TicketSearch} from '../src/lib/dedup'
import {runCaptured, runExpectingExit, testConfig} from './helpers/command'

// The `dedup` command (CYAU-30) deduplicates a discovery signal before creating a ticket: source key
// (fingerprint), CYI search, similarity → decides. Safe-by-default shell gate: no duplicate → exit 0 (it can
// create); reliable duplicate → exit 3 (enrich the existing one, do not create); ambiguous match → exit 3 (triage);
// invalid input → exit 2; failed CYI search → exit 1. Injected CYI search probe (no cyi process).

// Fake search probe, injected in place of the real one.
let tickets: ExistingTicket[] = []
let listCalls = 0

function reset(): void {
  tickets = []
  listCalls = 0
}

function fakeSearch(): TicketSearch {
  return {
    listTickets: () => {
      listCalls++
      return [...tickets]
    },
  }
}

// Test subclass: injects the fake probe (no cyi process).
class TestDedup extends Dedup {
  protected makeSearch(): TicketSearch {
    return fakeSearch()
  }
}

interface DedupPayload {
  decision: 'create' | 'enrich' | 'triage'
  fingerprint: string
  repository: string
  target: string | null
  enrichmentComment: string | null
  newTicketFooter: string | null
  candidates: {code: string}[]
}

const signalJson = JSON.stringify({
  source: 'errors',
  title: 'Errore 500 al checkout',
  evidence: '42 occorrenze in 24h nel gruppo CHECKOUT_TIMEOUT',
  impact: 'high',
  confidence: 0.8,
})
const base = ['--project', 'CYAU', '--repository', 'bussolabs/closeyourit', '--signal', signalJson, '--stack', 'app/models/order.rb:142 charge']

/** The expected fingerprint for the `base` signal/context (to build matching existing tickets). */
function baseFingerprint(): string {
  return computeFingerprint({source: 'errors', repository: 'bussolabs/closeyourit', stack: normalizeStack('app/models/order.rb:142 charge')})
}

describe('dedup command — DoD: no ticket decided without a duplicate search; safe-by-default gate', () => {
  it('create: no duplicate → exit 0, decision create, fingerprint footer, CYI search done', async () => {
    reset()
    const {result} = await runCaptured(TestDedup, [...base, '--json'])
    const r = result as DedupPayload
    expect(r.decision).toBe('create')
    expect(r.newTicketFooter).not.toBeNull()
    expect(r.enrichmentComment).toBeNull()
    expect(listCalls).toBe(1) // the search ALWAYS happened (DoD)
  })

  it('enrich: ticket with the SAME fingerprint → exit 3, C409-DEDUP-002; payload with target and comment on stdout', async () => {
    reset()
    tickets = [{id: 't7', code: 'CYAU-7', title: 'Vecchio titolo', fingerprint: baseFingerprint(), status: 'Open'}]
    const {stdout} = await runExpectingExit(TestDedup, [...base, '--json'], 3)
    expect(stdout).toContain('C409-DEDUP-002')
    expect(stdout).toContain('CYAU-7') // the enrichment target
    expect(stdout).toContain('CHECKOUT_TIMEOUT') // the enrichment comment reports the evidence
  })

  it('triage: several tickets with the same fingerprint → exit 3, C409-DEDUP-003 (human review)', async () => {
    reset()
    const fp = baseFingerprint()
    tickets = [
      {id: 't7', code: 'CYAU-7', title: 'A', fingerprint: fp, status: 'Open'},
      {id: 't8', code: 'CYAU-8', title: 'B', fingerprint: fp, status: 'Open'},
    ]
    const {stderr} = await runExpectingExit(TestDedup, [...base], 3)
    expect(stderr).toContain('C409-DEDUP-003')
  })

  it('human output on enrich: prints the candidates (status placeholder if missing) and the enrichment comment', async () => {
    reset()
    tickets = [{id: 't7', code: 'CYAU-7', title: 'Vecchio titolo', fingerprint: baseFingerprint(), status: null}]
    const {stdout} = await runExpectingExit(TestDedup, [...base], 3)
    expect(stdout).toContain('CYAU-7')
    expect(stdout).toContain('stato n/d')
    expect(stdout).toContain('commento di arricchimento')
    expect(stdout).toContain('CHECKOUT_TIMEOUT')
  })

  it('human output: prints the decision, the fingerprint and the reasons', async () => {
    reset()
    const {stdout} = await runCaptured(TestDedup, [...base])
    expect(stdout).toContain('dedup')
    expect(stdout).toContain('CREATE')
  })
})

describe('dedup command — signal composition and input defence', () => {
  it('signal via single flags (without --signal) → works', async () => {
    reset()
    const {result} = await runCaptured(TestDedup, [
      '--project', 'CYAU', '--repository', 'owner/repo',
      '--source', 'errors', '--title', 'X', '--evidence', 'Y', '--impact', 'high', '--confidence', '0.7', '--json',
    ])
    const r = result as DedupPayload
    expect(r.decision).toBe('create')
    expect(r.fingerprint).toMatch(/^[a-f0-9]+$/)
  })

  it('--signal JSON illegale → exit 2, C400-DEDUP-001', async () => {
    reset()
    const {stderr} = await runExpectingExit(TestDedup, ['--project', 'CYAU', '--repository', 'r/r', '--signal', 'non-json'], 2)
    expect(stderr).toContain('C400-DEDUP-001')
  })

  it('incomplete signal (impact missing) → exit 2, C400-DEDUP-001 (remapped from the discovery domain)', async () => {
    reset()
    const {stderr} = await runExpectingExit(
      TestDedup,
      ['--project', 'CYAU', '--repository', 'r/r', '--source', 'errors', '--title', 'X', '--evidence', 'Y', '--confidence', '0.7'],
      2,
    )
    expect(stderr).toContain('C400-DEDUP-001')
  })

  it('unsafe project key → exit 2, C400-DEDUP-001 (it ends up in the cyi argv)', async () => {
    reset()
    const {stderr} = await runExpectingExit(
      TestDedup,
      ['--project', 'a/b', '--repository', 'r/r', '--source', 'errors', '--title', 'X', '--evidence', 'Y', '--impact', 'high', '--confidence', '0.7'],
      2,
    )
    expect(stderr).toContain('C400-DEDUP-001')
    expect(listCalls).toBe(0) // defence BEFORE the search
  })

  it('soglie incoerenti (weak > strong) → exit 2, C400-DEDUP-001', async () => {
    reset()
    const {stderr} = await runExpectingExit(TestDedup, [...base, '--strong', '0.3', '--weak', '0.7'], 2)
    expect(stderr).toContain('C400-DEDUP-001')
  })
})

describe('dedup command — sonda reale di default (read-only, strutturale come publish no-delete)', () => {
  it('default makeSearch builds the real probe (cyi tickets list); does not expose create/comment/delete', async () => {
    const config = await testConfig()
    class ExposeDedup extends Dedup {
      search(): TicketSearch {
        return this.makeSearch()
      }
    }
    const cmd = new ExposeDedup([], config)
    const s = cmd.search()
    expect(typeof s.listTickets).toBe('function')
    expect('createTicket' in s).toBe(false)
    expect('comment' in s).toBe(false)
    expect('delete' in s).toBe(false)
  })
})
