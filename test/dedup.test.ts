import {describe, expect, it} from 'vitest'
import {
  assertThresholds,
  composeEnrichmentComment,
  composeFingerprintFooter,
  computeFingerprint,
  DedupResultSchema,
  DEFAULT_SIMILARITY_THRESHOLDS,
  defaultTicketSearch,
  type ExistingTicket,
  fingerprintMarker,
  findDuplicates,
  normalizeRepository,
  normalizeStack,
  parseFingerprintMarker,
  parseTicketsPage,
  runDedup,
  type SimilarityThresholds,
  type TicketSearch,
  titleSimilarity,
} from '../src/lib/dedup'
import {type DiscoverySignal} from '../src/lib/discovery'
import {AutomatorError, ErrorCodes} from '../src/errors/error-codes'

// Deduplicate the signals before creating tickets (CYAU-30): the discovery (CYAU-29) must NOT fill the backlog with
// repeated reports of the same problem. Dedup pipeline with CYI search, source key (fingerprint from
// normalized source/repository/stack) and similarity; a reliable match enriches the existing ticket with the
// composed comment instead of creating a new one; an ambiguous match stays in triage for human review. The core is
// PURE and DETERMINISTIC (fingerprint, similarity, decision), the I/O (CYI search) lives behind a read-only probe.
// The tests cover Scenario 1 (compares fingerprint/repository/normalized stack and existing tickets; no
// ticket created without duplicate search) and the DoD (no creation without search; ambiguous matches in triage).

/** Helper: captures a thrown AutomatorError (without failing the test on the throw). */
function caught(fn: () => unknown): AutomatorError | undefined {
  try {
    fn()
    return undefined
  } catch (e) {
    return e as AutomatorError
  }
}

/** A convenient valid signal (as in discovery.test), overridable field by field. */
function signal(over: Partial<DiscoverySignal> = {}): DiscoverySignal {
  return {
    source: 'errors',
    title: 'Errore 500 ricorrente al checkout',
    evidence: '42 occorrenze in 24h nel gruppo CHECKOUT_TIMEOUT',
    impact: 'high',
    confidence: 0.8,
    detail: null,
    ...over,
  }
}

describe('normalizeStack — normalized stack signature (dedup robust to volatile noise)', () => {
  it('lowercase, collapses spaces, trim', () => {
    expect(normalizeStack('  Foo   Bar\tBAZ ')).toBe('foo bar baz')
  })

  it('removes line/column numbers, hex addresses, uuids and timestamps: two occurrences of the SAME error → same signature', () => {
    const a = 'app/models/order.rb:142:in `charge` at 0x00007fa8 2026-07-13T04:00:00Z req 3f1c9b2a-1111-2222-3333-444455556666'
    const b = 'app/models/order.rb:987:in `charge` at 0x00001bd2 2026-07-12T09:31:12Z req 9a8b7c6d-9999-8888-7777-666655554444'
    expect(normalizeStack(a)).toBe(normalizeStack(b))
  })

  it('DIFFERENT errors produce different signatures (not everything collapses to empty)', () => {
    expect(normalizeStack('app/models/order.rb:142 charge')).not.toBe(normalizeStack('app/models/user.rb:12 login'))
  })
})

describe('normalizeRepository — normalized repository (part of the source key)', () => {
  it('lowercase and trim, so owner/Repo and OWNER/repo coincide', () => {
    expect(normalizeRepository('  Bussolabs/CloseYourIt  ')).toBe('bussolabs/closeyourit')
  })
})

describe('computeFingerprint — deterministic source key (source + repository + normalized stack)', () => {
  const base = {source: 'errors', repository: 'bussolabs/closeyourit', stack: 'app/models/order.rb:142 charge'}

  it('deterministic: same input → same fingerprint (hex)', () => {
    const fp = computeFingerprint(base)
    expect(fp).toBe(computeFingerprint(base))
    expect(fp).toMatch(/^[a-f0-9]+$/)
  })

  it('robust to noise: the same error with different line/timestamp → SAME fingerprint', () => {
    expect(computeFingerprint({...base, stack: 'app/models/order.rb:142 charge at 0xdead 2026-07-13T04:00:00Z'})).toBe(
      computeFingerprint({...base, stack: 'app/models/order.rb:999 charge at 0xbeef 2026-07-12T01:02:03Z'}),
    )
  })

  it('sensitive to source, repository and stack: changing one changes the fingerprint', () => {
    const fp = computeFingerprint(base)
    expect(computeFingerprint({...base, source: 'ci'})).not.toBe(fp)
    expect(computeFingerprint({...base, repository: 'bussolabs/altro'})).not.toBe(fp)
    expect(computeFingerprint({...base, stack: 'app/models/user.rb login'})).not.toBe(fp)
  })

  it('the repository enters normalized: case differences do NOT change the fingerprint', () => {
    expect(computeFingerprint({...base, repository: 'Bussolabs/CloseYourIt'})).toBe(computeFingerprint(base))
  })
})

describe('fingerprintMarker / parseFingerprintMarker — the fingerprint travels in the ticket text (round-trip)', () => {
  it('round-trip: the fingerprint written in the marker is read back identical', () => {
    const fp = computeFingerprint({source: 'errors', repository: 'a/b', stack: 'x'})
    const marker = fingerprintMarker(fp)
    expect(parseFingerprintMarker(`Testo del ticket.\n\n${marker}\n`)).toBe(fp)
  })

  it('text without marker → null (a hand-created ticket has no fingerprint)', () => {
    expect(parseFingerprintMarker('Un ticket qualsiasi senza impronta')).toBeNull()
  })

  it('extracts the FIRST marker if present among other text', () => {
    expect(parseFingerprintMarker(`prima <!-- automator:discovery-fingerprint:abc123 --> dopo`)).toBe('abc123')
  })
})

describe('titleSimilarity — title similarity (Jaccard on tokens, deterministic) [0,1]', () => {
  it('identical titles → 1; disjoint tokens → 0', () => {
    expect(titleSimilarity('Errore 500 al checkout', 'Errore 500 al checkout')).toBe(1)
    expect(titleSimilarity('Errore login social', 'Lentezza export PDF')).toBe(0)
  })

  it('insensitive to case and punctuation', () => {
    expect(titleSimilarity('Errore 500 al Checkout!', 'errore 500 al checkout')).toBe(1)
  })

  it('partial in (0,1): overlapping but not total', () => {
    const s = titleSimilarity('Timeout al checkout del carrello', 'Timeout al checkout')
    expect(s).toBeGreaterThan(0)
    expect(s).toBeLessThan(1)
  })

  it('empty strings → 0 (no token, never NaN)', () => {
    expect(titleSimilarity('', '')).toBe(0)
    expect(titleSimilarity('qualcosa', '')).toBe(0)
  })
})

describe('DEFAULT_SIMILARITY_THRESHOLDS — configurable strong/weak thresholds', () => {
  it('default: forte 0.8, debole 0.5 (weak ≤ strong)', () => {
    expect(DEFAULT_SIMILARITY_THRESHOLDS.strong).toBe(0.8)
    expect(DEFAULT_SIMILARITY_THRESHOLDS.weak).toBe(0.5)
    expect(DEFAULT_SIMILARITY_THRESHOLDS.weak).toBeLessThanOrEqual(DEFAULT_SIMILARITY_THRESHOLDS.strong)
  })
})

// ── findDuplicates: the heart of the decision (create / enrich / triage) ────────────────────────────────────────
const th: SimilarityThresholds = DEFAULT_SIMILARITY_THRESHOLDS

function ticket(over: Partial<ExistingTicket> = {}): ExistingTicket {
  return {id: 't1', code: 'CYAU-1', title: 'Titolo', fingerprint: null, status: 'Open', ...over}
}

describe('findDuplicates — Scenario 1: compares fingerprint and similarity with the existing tickets', () => {
  const fp = 'fingerprint-x'

  it('no existing ticket → CREATE (no duplicate)', () => {
    const out = findDuplicates({fingerprint: fp, signalTitle: 'Errore 500 al checkout', tickets: [], thresholds: th})
    expect(out.decision).toBe('create')
    expect(out.candidates).toEqual([])
  })

  it('EXACT fingerprint match on ONE ticket only → ENRICH (reliable match)', () => {
    const tickets = [ticket({code: 'CYAU-9', fingerprint: fp, title: 'Tutt’altro titolo'})]
    const out = findDuplicates({fingerprint: fp, signalTitle: 'Errore 500 al checkout', tickets, thresholds: th})
    expect(out.decision).toBe('enrich')
    expect(out.candidates).toHaveLength(1)
    expect(out.candidates[0].code).toBe('CYAU-9')
    expect(out.candidates[0].matchType).toBe('fingerprint')
    expect(out.candidates[0].similarity).toBe(1)
  })

  it('the fingerprint takes PRECEDENCE over similarity (exact match even with a different title)', () => {
    const tickets = [
      ticket({code: 'CYAU-9', fingerprint: fp, title: 'Nulla a che vedere'}),
      ticket({code: 'CYAU-10', fingerprint: null, title: 'Errore 500 al checkout'}), // identical title but no fingerprint
    ]
    const out = findDuplicates({fingerprint: fp, signalTitle: 'Errore 500 al checkout', tickets, thresholds: th})
    expect(out.decision).toBe('enrich')
    expect(out.candidates[0].code).toBe('CYAU-9')
    expect(out.candidates[0].matchType).toBe('fingerprint')
  })

  it('exact fingerprint match on SEVERAL tickets → TRIAGE (ambiguous: I do not guess which to enrich)', () => {
    const tickets = [ticket({code: 'CYAU-9', fingerprint: fp}), ticket({code: 'CYAU-10', fingerprint: fp})]
    const out = findDuplicates({fingerprint: fp, signalTitle: 'x', tickets, thresholds: th})
    expect(out.decision).toBe('triage')
    expect(out.candidates.map((c) => c.code).sort()).toEqual(['CYAU-10', 'CYAU-9'])
  })

  it('no fingerprint, STRONG similarity on a single ticket → ENRICH', () => {
    const tickets = [ticket({code: 'CYAU-9', title: 'Errore 500 ricorrente checkout'})]
    const out = findDuplicates({
      fingerprint: fp,
      signalTitle: 'Errore 500 ricorrente al checkout', // Jaccard 4/5 = 0.8 ≥ strong
      tickets,
      thresholds: th,
    })
    expect(out.decision).toBe('enrich')
    expect(out.candidates[0].matchType).toBe('similarity')
    expect(out.candidates[0].similarity).toBeGreaterThanOrEqual(th.strong)
  })

  it('STRONG similarity on several tickets → TRIAGE (several reliable candidates)', () => {
    const tickets = [
      ticket({code: 'CYAU-9', title: 'Errore 500 ricorrente al checkout'}),
      ticket({code: 'CYAU-10', title: 'Errore 500 ricorrente al checkout'}),
    ]
    const out = findDuplicates({fingerprint: fp, signalTitle: 'Errore 500 ricorrente al checkout', tickets, thresholds: th})
    expect(out.decision).toBe('triage')
    expect(out.candidates).toHaveLength(2)
  })

  it('WEAK similarity (between weak and strong) → TRIAGE (unreliable match: human review)', () => {
    const tickets = [ticket({code: 'CYAU-9', title: 'Timeout al checkout'})] // vs the 5-token signal title = 0.6
    const out = findDuplicates({fingerprint: fp, signalTitle: 'Timeout al checkout del carrello', tickets, thresholds: th})
    expect(out.decision).toBe('triage')
    expect(out.candidates[0].matchType).toBe('similarity')
    expect(out.candidates[0].similarity).toBeGreaterThanOrEqual(th.weak)
    expect(out.candidates[0].similarity).toBeLessThan(th.strong)
  })

  it('similarity BELOW the weak threshold → CREATE (no reliable nor suspect duplicate)', () => {
    const tickets = [ticket({code: 'CYAU-9', title: 'Lentezza export PDF del report'})]
    const out = findDuplicates({fingerprint: fp, signalTitle: 'Errore login con account social', tickets, thresholds: th})
    expect(out.decision).toBe('create')
    expect(out.candidates).toEqual([])
  })

  it('the similarity candidates are sorted by decreasing similarity (the most similar first)', () => {
    const tickets = [
      ticket({code: 'CYAU-9', title: 'Timeout al checkout'}), // 3/5 = 0.6 (weak)
      ticket({code: 'CYAU-10', title: 'Timeout al checkout del pagamento'}), // 4/6 = 0.667 (weak, more similar)
    ]
    const out = findDuplicates({fingerprint: fp, signalTitle: 'Timeout al checkout del carrello', tickets, thresholds: th})
    expect(out.decision).toBe('triage')
    expect(out.candidates[0].code).toBe('CYAU-10')
    expect(out.candidates[0].similarity).toBeGreaterThanOrEqual(out.candidates[1].similarity)
  })
})

describe('composeEnrichmentComment — enriches the existing ticket with the new occurrence (Technical analysis)', () => {
  it('reports source, impact, confidence, evidence and fingerprint (audit)', () => {
    const fp = 'abcdef01'
    const body = composeEnrichmentComment({
      signal: signal({impact: 'critical', evidence: '99 occorrenze in 1h'}),
      repository: 'bussolabs/closeyourit',
      fingerprint: fp,
      ticketCode: 'CYAU-9',
    })
    expect(body).toContain('critical')
    expect(body).toContain('99 occorrenze in 1h')
    expect(body).toContain('errors')
    expect(body).toContain(fp)
    expect(body).toContain('bussolabs/closeyourit')
  })
})

describe('composeFingerprintFooter — the marker to embed in the NEW ticket (for the next dedup)', () => {
  it('contains the marker readable by parseFingerprintMarker (round-trip)', () => {
    const fp = 'abcdef01'
    const footer = composeFingerprintFooter(fp)
    expect(parseFingerprintMarker(footer)).toBe(fp)
  })
})

// ── parseTicketsPage: output of `cyi tickets list --json` (STRICT envelope: illegal/unexpected → null = fail-closed) ─
describe('parseTicketsPage — extracts tickets + total_pages; invalid envelope → null (never "no ticket" from a broken one)', () => {
  it('extracts id/code/title/status, the fingerprint from the marker in the description, and total_pages from meta', () => {
    const raw = JSON.stringify({
      data: [
        {
          id: 't1',
          code: 'CYAU-9',
          title: 'Errore 500 al checkout',
          description: `Testo\n\n${fingerprintMarker('abcdef01')}`,
          technical_analysis: 'analisi',
          status: 'Open',
        },
      ],
      meta: {page: 1, per: 10, total: 33, total_pages: 4},
    })
    expect(parseTicketsPage(raw)).toEqual({
      tickets: [{id: 't1', code: 'CYAU-9', title: 'Errore 500 al checkout', fingerprint: 'abcdef01', status: 'Open'}],
      totalPages: 4,
    })
  })

  it('also reads the marker from the technical_analysis; missing in both → fingerprint null', () => {
    const raw = JSON.stringify({
      data: [
        {id: 't2', code: 'CYAU-10', title: 'A', description: 'x', technical_analysis: fingerprintMarker('abcdef02'), status: 'Open'},
        {id: 't3', code: 'CYAU-11', title: 'B', description: 'niente', technical_analysis: 'niente', status: 'Open'},
      ],
    })
    const page = parseTicketsPage(raw)
    expect(page?.tickets[0].fingerprint).toBe('abcdef02')
    expect(page?.tickets[1].fingerprint).toBeNull()
    expect(page?.totalPages).toBeNull() // missing meta → not paginated
  })

  it('bare array → totalPages null; malformed entries inside a valid envelope discarded one by one', () => {
    expect(parseTicketsPage('[{"id":"t1","code":"CYAU-1","title":"T"}]')).toEqual({
      tickets: [{id: 't1', code: 'CYAU-1', title: 'T', fingerprint: null, status: null}],
      totalPages: null,
    })
    expect(parseTicketsPage('{"data":[{"bad":1},{"id":"t9","code":"CYAU-9","title":"Buono"}]}')).toEqual({
      tickets: [{id: 't9', code: 'CYAU-9', title: 'Buono', fingerprint: null, status: null}],
      totalPages: null,
    })
  })

  it('FAIL-CLOSED: illegal JSON or unexpected shape → null (never "no ticket" deduced from a broken answer)', () => {
    expect(parseTicketsPage('non-json')).toBeNull()
    expect(parseTicketsPage('{"nope":1}')).toBeNull()
    expect(parseTicketsPage('42')).toBeNull()
  })
})

// ── runDedup: orchestration with the read-only probe (CYI search) ──────────────────────────────────────────────
/** Fake read-only probe: holds the project tickets and counts the calls → verifies "always searched". */
function fakeSearch(tickets: ExistingTicket[]): TicketSearch & {listCalls: number} {
  const state = {listCalls: 0}
  return {
    get listCalls() {
      return state.listCalls
    },
    listTickets() {
      state.listCalls++
      return [...tickets]
    },
  }
}

const baseInput = {project: 'CYAU', signal: signal(), repository: 'bussolabs/closeyourit', stack: 'app/models/order.rb:142 charge'}

describe('runDedup — DoD: no ticket is created without duplicate search; ambiguous matches in triage', () => {
  it('Scenario 1: ALWAYS evaluates the CYI search before deciding (even when the outcome is create)', () => {
    const search = fakeSearch([])
    const result = runDedup(baseInput, search)
    expect(search.listCalls).toBe(1) // the search happened
    expect(result.decision).toBe('create')
    expect(result.fingerprint).toMatch(/^[a-f0-9]+$/)
  })

  it('create: no duplicate → decision create, footer with the marker for the new ticket, no comment', () => {
    const result = runDedup(baseInput, fakeSearch([]))
    expect(result.decision).toBe('create')
    expect(result.target).toBeNull()
    expect(result.enrichmentComment).toBeNull()
    expect(result.newTicketFooter).not.toBeNull()
    expect(parseFingerprintMarker(result.newTicketFooter as string)).toBe(result.fingerprint)
    expect(() => DedupResultSchema.parse(result)).not.toThrow()
  })

  it('enrich: a ticket carries THE SAME fingerprint → decision enrich, target = that ticket, composed comment', () => {
    const fp = computeFingerprint({source: 'errors', repository: 'bussolabs/closeyourit', stack: normalizeStack('app/models/order.rb:142 charge')})
    const existing = ticket({code: 'CYAU-7', fingerprint: fp, title: 'Vecchio titolo'})
    const result = runDedup(baseInput, fakeSearch([existing]))
    expect(result.decision).toBe('enrich')
    expect(result.target).toBe('CYAU-7')
    expect(result.enrichmentComment).toContain('CHECKOUT_TIMEOUT')
    expect(result.newTicketFooter).toBeNull()
    expect(() => DedupResultSchema.parse(result)).not.toThrow()
  })

  it('triage: several tickets with the same fingerprint → decision triage (human review)', () => {
    const fp = computeFingerprint({source: 'errors', repository: 'bussolabs/closeyourit', stack: normalizeStack('app/models/order.rb:142 charge')})
    const result = runDedup(baseInput, fakeSearch([ticket({code: 'CYAU-7', fingerprint: fp}), ticket({code: 'CYAU-8', fingerprint: fp})]))
    expect(result.decision).toBe('triage')
    expect(result.target).toBeNull()
    expect(result.enrichmentComment).toBeNull()
    expect(result.candidates).toHaveLength(2)
  })

  it('the missing stack falls back on the signal evidence (the signature always exists)', () => {
    const withStack = runDedup({...baseInput, stack: signal().evidence}, fakeSearch([]))
    const withoutStack = runDedup({project: 'CYAU', signal: signal(), repository: 'bussolabs/closeyourit'}, fakeSearch([]))
    expect(withoutStack.fingerprint).toBe(withStack.fingerprint)
  })

  it('input defence: unsafe project-key → C400-DEDUP-001 (exit 2), BEFORE any search', () => {
    const search = fakeSearch([])
    const err = caught(() => runDedup({...baseInput, project: 'a/b'}, search))
    expect(err?.code).toBe(ErrorCodes.Dedup.invalidInput)
    expect(err?.exitCode).toBe(2)
    expect(search.listCalls).toBe(0) // defence BEFORE any I/O
  })

  it('input defence: empty repository → C400-DEDUP-001 (exit 2)', () => {
    const err = caught(() => runDedup({...baseInput, repository: '   '}, fakeSearch([])))
    expect(err?.code).toBe(ErrorCodes.Dedup.invalidInput)
    expect(err?.exitCode).toBe(2)
  })

  it('the record is auditable: exposes normalized fingerprint, repository and stack (Scenario 1)', () => {
    const result = runDedup(baseInput, fakeSearch([]))
    expect(result.repository).toBe('bussolabs/closeyourit')
    expect(result.normalizedStack).toBe(normalizeStack('app/models/order.rb:142 charge'))
    expect(result.reasons.length).toBeGreaterThan(0)
  })
})

describe('TicketSearch — the probe is READ-ONLY (it neither creates nor modifies tickets: structural, like publish no-delete)', () => {
  it('exposes no creation/comment/modification method', () => {
    const search = fakeSearch([])
    expect(typeof search.listTickets).toBe('function')
    expect('createTicket' in search).toBe(false)
    expect('comment' in search).toBe(false)
    expect('update' in search).toBe(false)
    expect('delete' in search).toBe(false)
  })
})

describe('assertThresholds — threshold validation (untrusted CLI input)', () => {
  it('accepts consistent thresholds (weak ≤ strong, in [0,1])', () => {
    expect(() => assertThresholds({strong: 0.8, weak: 0.5})).not.toThrow()
    expect(() => assertThresholds({strong: 0.5, weak: 0.5})).not.toThrow()
  })

  it('rejects thresholds outside [0,1] or weak > strong → C400-DEDUP-001 (exit 2)', () => {
    for (const bad of [
      {strong: 1.2, weak: 0.5},
      {strong: 0.8, weak: -0.1},
      {strong: 0.3, weak: 0.7},
      {strong: Number.NaN, weak: 0.5},
    ]) {
      const err = caught(() => assertThresholds(bad))
      expect(err?.code).toBe(ErrorCodes.Dedup.invalidInput)
      expect(err?.exitCode).toBe(2)
    }
  })
})

describe('defaultTicketSearch — real CYI search: COMPLETE pagination via meta.total_pages, read-only, fail-closed', () => {
  it('reads EXACTLY meta.total_pages pages (no silent cap, no unreliable "until empty" loop)', () => {
    const pages: Record<number, string> = {
      1: '{"data":[{"id":"t1","code":"CYAU-1","title":"A"}],"meta":{"total_pages":3}}',
      2: '{"data":[{"id":"t2","code":"CYAU-2","title":"B"}],"meta":{"total_pages":3}}',
      3: '{"data":[{"id":"t3","code":"CYAU-3","title":"C"}],"meta":{"total_pages":3}}',
    }
    const seen: number[] = []
    const run = (_cmd: string, args: string[]): {status: number; stdout: string; stderr: string} => {
      const page = Number(args[args.indexOf('--page') + 1])
      seen.push(page)
      // Regression: a page beyond the range is NOT empty (it returns page 1) → an "until empty" loop would spin forever.
      return {status: 0, stdout: pages[page] ?? pages[1], stderr: ''}
    }
    const tickets = defaultTicketSearch(run).listTickets({project: 'CYAU'})
    expect(tickets.map((t) => t.code)).toEqual(['CYAU-1', 'CYAU-2', 'CYAU-3'])
    expect(seen).toEqual([1, 2, 3]) // only the 3 declared pages, not one more
  })

  it('missing meta.total_pages (non-paginated endpoint) → reads only page 1', () => {
    const run = (): {status: number; stdout: string; stderr: string} => ({
      status: 0,
      stdout: '{"data":[{"id":"t1","code":"CYAU-1","title":"A"}]}',
      stderr: '',
    })
    expect(defaultTicketSearch(run).listTickets({project: 'CYAU'}).map((t) => t.code)).toEqual(['CYAU-1'])
  })

  it('failed command → C502-DEDUP-004 (exit 1): the search is NOT best-effort (stop, do not create duplicates)', () => {
    const run = (): {status: number; stdout: string; stderr: string} => ({status: 1, stdout: '', stderr: 'boom'})
    const err = caught(() => defaultTicketSearch(run).listTickets({project: 'CYAU'}))
    expect(err?.code).toBe(ErrorCodes.Dedup.searchFailed)
    expect(err?.exitCode).toBe(1)
  })

  it('FAIL-CLOSED (regression): exit 0 but INVALID answer → C502-DEDUP-004, never "no ticket" deduced', () => {
    for (const stdout of ['garbage-non-json', '{"nope":1}']) {
      const run = (): {status: number; stdout: string; stderr: string} => ({status: 0, stdout, stderr: ''})
      const err = caught(() => defaultTicketSearch(run).listTickets({project: 'CYAU'}))
      expect(err?.code).toBe(ErrorCodes.Dedup.searchFailed)
      expect(err?.exitCode).toBe(1)
    }
  })

  it('FAIL-CLOSED: broken envelope on a LATER page (not the first) → C502, not a partial result', () => {
    const run = (_cmd: string, args: string[]): {status: number; stdout: string; stderr: string} => {
      const page = Number(args[args.indexOf('--page') + 1])
      if (page === 1) return {status: 0, stdout: '{"data":[{"id":"t1","code":"CYAU-1","title":"A"}],"meta":{"total_pages":2}}', stderr: ''}
      return {status: 0, stdout: 'rotto', stderr: ''} // illegal page 2
    }
    const err = caught(() => defaultTicketSearch(run).listTickets({project: 'CYAU'}))
    expect(err?.code).toBe(ErrorCodes.Dedup.searchFailed)
  })
})
