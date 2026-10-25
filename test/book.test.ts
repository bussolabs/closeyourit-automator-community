import {describe, expect, it} from 'vitest'
import {
  assignPageToBook,
  type BookContents,
  BookAssignmentResultSchema,
  type BookRegistry,
  type KnowledgeBook,
  matchBookByTitle,
  parseBookContentsJson,
  parseBookListJson,
  planBookAssignment,
  resolveBookTarget,
} from '../src/lib/book'
import {AutomatorError, ErrorCodes} from '../src/errors/error-codes'

// Management of the Knowledge pages in the thematic books (CYAU-28): "membership" counterpart of publish.ts (CYAU-27,
// which creates/updates the page). It implements steps 4 and 6 of knowledge-publishing.md — assigns the page to the
// authorized book and verifies its position in the table of contents (TOC) — leaving the book CREATION (step 5, human/policy
// decision) out: a missing or ambiguous book is REPORTED (DoD), not guessed. Invariants (mirror of
// publish): SCOPE/anti-BOLA (books always filtered by project), IDEMPOTENCE (page already in the TOC → no-op),
// NEVER remove (the probe exposes no removal → structural), POSITION CHECK (Scenario 1 "Then").

// ── Helper: captures a thrown AutomatorError (without failing the test on the throw). ──────────────────────────
function caught(fn: () => unknown): AutomatorError | undefined {
  try {
    fn()
    return undefined
  } catch (e) {
    return e as AutomatorError
  }
}

describe('matchBookByTitle — book resolution by exact title within the project scope (anti-BOLA)', () => {
  const books: KnowledgeBook[] = [
    {id: 'b1', title: 'Deploy & infra', project: 'CYAU'},
    {id: 'b2', title: 'Altro', project: 'CYAU'},
    {id: 'b3', title: 'deploy & infra', project: 'CYAU'}, // same title, different case
    {id: 'b4', title: 'Deploy & infra', project: 'CYRA'}, // same title, OTHER project → excluded (anti-BOLA)
  ]

  it('filters by exact title (case-insensitive, trim) and by project (case-insensitive)', () => {
    expect(matchBookByTitle(books, 'Deploy & infra', 'CYAU').map((b) => b.id)).toEqual(['b1', 'b3'])
    expect(matchBookByTitle(books, '  deploy & INFRA  ', 'cyau').map((b) => b.id)).toEqual(['b1', 'b3'])
    expect(matchBookByTitle(books, 'Inesistente', 'CYAU')).toEqual([])
  })

  it('defence in depth: a book of a different project is never a match (anti-BOLA)', () => {
    expect(matchBookByTitle(books, 'Deploy & infra', 'CYRA').map((b) => b.id)).toEqual(['b4'])
  })

  it('project missing on the book (list already filtered by the server) → considered of the right project', () => {
    const serverFiltered: KnowledgeBook[] = [{id: 'bx', title: 'Deploy & infra', project: null}]
    expect(matchBookByTitle(serverFiltered, 'Deploy & infra', 'CYAU').map((b) => b.id)).toEqual(['bx'])
  })
})

describe('resolveBookTarget — 0/1/N → absence / book / ambiguity (DoD: reports absence or ambiguity)', () => {
  it('a single match → that book', () => {
    const book = {id: 'b1', title: 'Deploy', project: 'CYAU'}
    expect(resolveBookTarget([book], 'Deploy', 'CYAU')).toEqual(book)
  })

  it('no match → C409-BOOK-002 (exit 3): the book is MISSING, it must be reported (not created)', () => {
    const err = caught(() => resolveBookTarget([], 'Deploy', 'CYAU'))
    expect(err?.code).toBe(ErrorCodes.Book.absent)
    expect(err?.exitCode).toBe(3)
    expect(err?.message).toContain('Deploy')
  })

  it('several matches → C409-BOOK-003 (exit 3): AMBIGUITY, I do not guess which to assign to', () => {
    const err = caught(() =>
      resolveBookTarget(
        [
          {id: 'a', title: 'Deploy', project: 'CYAU'},
          {id: 'b', title: 'Deploy', project: 'CYAU'},
        ],
        'Deploy',
        'CYAU',
      ),
    )
    expect(err?.code).toBe(ErrorCodes.Book.ambiguous)
    expect(err?.exitCode).toBe(3)
  })
})

// ── Fake probes ────────────────────────────────────────────────────────────────────────────────────────────
const baseInput = {project: 'CYAU', pageId: 'p1', bookTitle: 'Deploy & infra', ticket: 'CYAU-28', position: null}

/** Stateful fake registry: holds the project books and the TOC per book → verifiable idempotence. */
function statefulRegistry(
  books: KnowledgeBook[],
  toc: Record<string, string[]> = {},
): BookRegistry & {toc: Record<string, string[]>; assigns: number; listCalls: number} {
  const state = {toc: {...toc}, assigns: 0, listCalls: 0}
  return {
    get toc() {
      return state.toc
    },
    get assigns() {
      return state.assigns
    },
    get listCalls() {
      return state.listCalls
    },
    listBooks() {
      state.listCalls++
      return [...books]
    },
    showBook({bookId}) {
      return {bookId, pageIds: [...(state.toc[bookId] ?? [])]}
    },
    assignPage({bookId, pageId, position}) {
      state.assigns++
      const pages = state.toc[bookId] ?? []
      if (!pages.includes(pageId)) {
        if (position !== null && position >= 1 && position <= pages.length) pages.splice(position - 1, 0, pageId)
        else pages.push(pageId)
      }
      state.toc[bookId] = pages
      return {bookId, pageIds: [...pages]}
    },
  }
}

describe('planBookAssignment — read-only book resolution (also used by the dry-run)', () => {
  it('validates the input, resolves the book and reports whether the page is already in the TOC and at which position', () => {
    const reg = statefulRegistry([{id: 'b1', title: 'Deploy & infra', project: 'CYAU'}], {b1: ['p0', 'p1']})
    const plan = planBookAssignment(baseInput, reg)
    expect(plan.bookId).toBe('b1')
    expect(plan.bookTitle).toBe('Deploy & infra')
    expect(plan.alreadyPresent).toBe(true)
    expect(plan.position).toBe(2)
    expect(reg.assigns).toBe(0) // read-only: non muta
  })

  it('page not yet in the book → alreadyPresent false, position null', () => {
    const reg = statefulRegistry([{id: 'b1', title: 'Deploy & infra', project: 'CYAU'}], {b1: ['p0']})
    const plan = planBookAssignment(baseInput, reg)
    expect(plan.alreadyPresent).toBe(false)
    expect(plan.position).toBeNull()
  })

  it('missing book → C409-BOOK-002 (exit 3): reports, no mutation', () => {
    const reg = statefulRegistry([{id: 'b1', title: 'Altro', project: 'CYAU'}])
    const err = caught(() => planBookAssignment(baseInput, reg))
    expect(err?.code).toBe(ErrorCodes.Book.absent)
    expect(err?.exitCode).toBe(3)
    expect(reg.assigns).toBe(0)
  })
})

describe('planBookAssignment — input defence (values in the cyi argv / in the metadata), BEFORE any I/O', () => {
  it('unsafe project/page-id/ticket or empty book title → C400-BOOK-001 (exit 2)', () => {
    const reg = statefulRegistry([{id: 'b1', title: 'Deploy & infra', project: 'CYAU'}], {b1: []})
    for (const bad of [
      {...baseInput, project: 'a/b'},
      {...baseInput, pageId: '..'},
      {...baseInput, ticket: 'a/b'},
      {...baseInput, bookTitle: '   '},
    ]) {
      const err = caught(() => planBookAssignment(bad, reg))
      expect(err?.code).toBe(ErrorCodes.Book.invalidInput)
      expect(err?.exitCode).toBe(2)
    }
    expect(reg.listCalls).toBe(0) // defence BEFORE any I/O
  })

  it('missing ticket is allowed (optional metadata)', () => {
    const reg = statefulRegistry([{id: 'b1', title: 'Deploy & infra', project: 'CYAU'}], {b1: []})
    expect(() => planBookAssignment({...baseInput, ticket: null}, reg)).not.toThrow()
  })

  it('position not a positive integer → C400-BOOK-001 (exit 2)', () => {
    const reg = statefulRegistry([{id: 'b1', title: 'Deploy & infra', project: 'CYAU'}], {b1: []})
    for (const bad of [0, -1, 1.5]) {
      const err = caught(() => planBookAssignment({...baseInput, position: bad}, reg))
      expect(err?.code).toBe(ErrorCodes.Book.invalidInput)
      expect(err?.exitCode).toBe(2)
    }
  })
})

describe('assignPageToBook — assigns to the authorized book and verifies the position in the TOC (Scenario 1)', () => {
  it('page not in the book → ASSIGNED, the page appears in the TOC, position verified, auditable record', () => {
    const reg = statefulRegistry([{id: 'b1', title: 'Deploy & infra', project: 'CYAU'}], {b1: ['p0']})
    const result = assignPageToBook(baseInput, reg)
    expect(result.action).toBe('assigned')
    expect(result.bookId).toBe('b1')
    expect(result.pageId).toBe('p1')
    expect(result.toc).toEqual(['p0', 'p1'])
    expect(result.position).toBe(2) // 1-based, verified in the updated TOC
    expect(result.requestedPosition).toBeNull() // no requested position → append at the end
    expect(reg.assigns).toBe(1)
    expect(() => BookAssignmentResultSchema.parse(result)).not.toThrow()
  })

  it('explicit position honoured → the page is inserted at that point of the TOC (policy-driven ordering)', () => {
    const reg = statefulRegistry([{id: 'b1', title: 'Deploy & infra', project: 'CYAU'}], {b1: ['p0', 'p2']})
    const result = assignPageToBook({...baseInput, position: 2}, reg)
    expect(result.toc).toEqual(['p0', 'p1', 'p2'])
    expect(result.position).toBe(2)
    expect(result.requestedPosition).toBe(2)
    // requested === actual → no deviation finding among the reasons
    expect(result.reasons.join(' ')).not.toContain('richiesta 2,')
  })

  it('requested position beyond the length → append at the end + explicit deviation reason (exit 0)', () => {
    // "Verify the position in the TOC" (Scenario 1): the actual position is compared with the requested one
    // and a deviation (here a server clamp at the end) is made EXPLICIT, not silent — but it is not an error.
    const reg = statefulRegistry([{id: 'b1', title: 'Deploy & infra', project: 'CYAU'}], {b1: ['p0']})
    const result = assignPageToBook({...baseInput, position: 9}, reg)
    expect(result.action).toBe('assigned')
    expect(result.position).toBe(2) // append in coda
    expect(result.requestedPosition).toBe(9)
    expect(result.reasons.join(' ')).toContain('richiesta 9')
  })

  it('IDEMPOTENCE: page already in the TOC → ALREADY-PRESENT, no new assignment', () => {
    const reg = statefulRegistry([{id: 'b1', title: 'Deploy & infra', project: 'CYAU'}], {b1: ['p0', 'p1']})
    const result = assignPageToBook(baseInput, reg)
    expect(result.action).toBe('already-present')
    expect(result.position).toBe(2)
    expect(reg.assigns).toBe(0) // does not call assignPage again: no-op
  })

  it('already present but at a position different from the requested one → already-present + reason, does NOT reorder', () => {
    // Idempotence + structural "never remove/reorder": a page already in the book is not moved; the
    // deviation from the requested position is however made EXPLICIT (not silent) for the audit and the human review.
    const reg = statefulRegistry([{id: 'b1', title: 'Deploy & infra', project: 'CYAU'}], {b1: ['p1', 'p0']})
    const result = assignPageToBook({...baseInput, position: 2}, reg) // p1 is at position 1, position 2 is requested
    expect(result.action).toBe('already-present')
    expect(result.position).toBe(1)
    expect(result.requestedPosition).toBe(2)
    expect(result.reasons.join(' ')).toContain('non applicata')
    expect(reg.assigns).toBe(0) // does not reorder: no mutation
  })

  it('IDEMPOTENCE: two consecutive assignments → assigned then already-present, a single assign, no duplicate', () => {
    const reg = statefulRegistry([{id: 'b1', title: 'Deploy & infra', project: 'CYAU'}], {b1: []})
    const first = assignPageToBook(baseInput, reg)
    const second = assignPageToBook(baseInput, reg)
    expect(first.action).toBe('assigned')
    expect(second.action).toBe('already-present')
    expect(reg.toc.b1).toEqual(['p1']) // a single occurrence
    expect(reg.assigns).toBe(1)
  })

  it('missing book → C409-BOOK-002 (exit 3): does NOT assign, the registry is not mutated', () => {
    const reg = statefulRegistry([{id: 'b1', title: 'Altro', project: 'CYAU'}])
    const err = caught(() => assignPageToBook(baseInput, reg))
    expect(err?.code).toBe(ErrorCodes.Book.absent)
    expect(err?.exitCode).toBe(3)
    expect(reg.assigns).toBe(0)
  })

  it('ambiguous book → C409-BOOK-003 (exit 3): does NOT assign', () => {
    const reg = statefulRegistry([
      {id: 'a', title: 'Deploy & infra', project: 'CYAU'},
      {id: 'b', title: 'Deploy & infra', project: 'CYAU'},
    ])
    const err = caught(() => assignPageToBook(baseInput, reg))
    expect(err?.code).toBe(ErrorCodes.Book.ambiguous)
    expect(reg.assigns).toBe(0)
  })

  it('failed TOC check: the page does not appear after the assignment → C502-BOOK-004 (exit 1)', () => {
    // "Broken" registry: assignPage does not really record the page (inconsistent server) → the check must fail.
    const reg: BookRegistry = {
      listBooks: () => [{id: 'b1', title: 'Deploy & infra', project: 'CYAU'}],
      showBook: ({bookId}) => ({bookId, pageIds: []}),
      assignPage: ({bookId}) => ({bookId, pageIds: []}), // adds nothing
    }
    const err = caught(() => assignPageToBook(baseInput, reg))
    expect(err?.code).toBe(ErrorCodes.Book.commandFailed)
    expect(err?.exitCode).toBe(1)
  })
})

// ── Tolerant parsing of the `cyi kb book` output (untrusted input; contract independent from publish). ────
describe('parseBookListJson — untrusted cyi output, granular tolerance', () => {
  it('extracts the books from {data:[…]} or from a bare array; optional project', () => {
    expect(parseBookListJson('{"data":[{"id":"b1","title":"Deploy","project":"CYAU"}]}')).toEqual([
      {id: 'b1', title: 'Deploy', project: 'CYAU'},
    ])
    expect(parseBookListJson('[{"id":"b2","title":"Altro"}]')).toEqual([{id: 'b2', title: 'Altro', project: null}])
  })

  it('illegal JSON or unexpected shape → no book; the malformed entries are discarded one by one', () => {
    expect(parseBookListJson('non-json')).toEqual([])
    expect(parseBookListJson('{"nope":1}')).toEqual([])
    expect(parseBookListJson('{"data":[{"bad":1},{"id":"b9","title":"Buono"}]}')).toEqual([
      {id: 'b9', title: 'Buono', project: null},
    ])
  })
})

describe('parseBookContentsJson — the book TOC: pageIds in order, tolerant', () => {
  it('extracts the page ids from data.pages[].id, in order', () => {
    const raw = '{"data":{"id":"b1","pages":[{"id":"p1"},{"id":"p2"},{"id":"p3"}]}}'
    expect(parseBookContentsJson('b1', raw)).toEqual({bookId: 'b1', pageIds: ['p1', 'p2', 'p3']})
  })

  it('also supports page_ids:[…] as an alternative shape', () => {
    expect(parseBookContentsJson('b1', '{"page_ids":["p1","p2"]}')).toEqual({bookId: 'b1', pageIds: ['p1', 'p2']})
  })

  it('illegal JSON or unexpected shape → empty TOC; the malformed entries are discarded one by one', () => {
    expect(parseBookContentsJson('b1', 'non-json')).toEqual({bookId: 'b1', pageIds: []})
    expect(parseBookContentsJson('b1', '{"data":{"pages":[{"bad":1},{"id":"p7"}]}}')).toEqual({
      bookId: 'b1',
      pageIds: ['p7'],
    })
  })
})

describe('BookRegistry — "never remove a page" is structural (like publish: no delete)', () => {
  it('the probe exposes no removal method', () => {
    const reg = statefulRegistry([{id: 'b1', title: 'Deploy & infra', project: 'CYAU'}])
    expect('removePage' in reg).toBe(false)
    expect('delete' in reg).toBe(false)
    expect('deleteBook' in reg).toBe(false)
  })
})

// Marks the use of the BookContents type (probe contract) — executable documentation.
const _contentsShape: BookContents = {bookId: 'b1', pageIds: []}
void _contentsShape
