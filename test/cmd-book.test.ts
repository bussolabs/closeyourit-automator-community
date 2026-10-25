import {describe, expect, it} from 'vitest'
import Book from '../src/commands/book'
import {type BookRegistry, type KnowledgeBook} from '../src/lib/book'
import {runCaptured, runExpectingExit, testConfig} from './helpers/command'

// The `book` command (CYAU-28) assigns a Knowledge page to an authorized thematic book and verifies its
// position in the table of contents (Scenario 1). Idempotent (page already in the book → no-op), scoped by project (anti-BOLA),
// never removes (structural). Safe-by-default shell gate: assigned/already present → exit 0; missing/ambiguous book →
// exit 3 (flagged); invalid input → exit 2; failed cyi command/verification → exit 1. Injected probe.

// Fake registry, injected in place of the real probe (no cyi process).
let books: KnowledgeBook[] = []
let toc: Record<string, string[]> = {}
let assigns = 0

function reset(): void {
  books = [{id: 'b1', title: 'Deploy & infra', project: 'CYAU'}]
  toc = {b1: ['p0']}
  assigns = 0
}

function fakeRegistry(): BookRegistry {
  return {
    listBooks: () => [...books],
    showBook: ({bookId}) => ({bookId, pageIds: [...(toc[bookId] ?? [])]}),
    assignPage: ({bookId, pageId, position}) => {
      assigns++
      const pages = toc[bookId] ?? []
      if (!pages.includes(pageId)) {
        if (position !== null && position >= 1 && position <= pages.length) pages.splice(position - 1, 0, pageId)
        else pages.push(pageId)
      }
      toc[bookId] = pages
      return {bookId, pageIds: [...pages]}
    },
  }
}

// Test subclass: injects the fake probe (no cyi process).
class TestBook extends Book {
  protected makeRegistry(): BookRegistry {
    return fakeRegistry()
  }
}

interface BookPayload {
  dryRun: boolean
  action?: 'assigned' | 'already-present'
  bookId?: string
  bookTitle?: string
  pageId?: string
  position?: number
  requestedPosition?: number | null
  toc?: string[]
  alreadyPresent?: boolean
}

const base = ['--project', 'CYAU', '--page-id', 'p1', '--book', 'Deploy & infra', '--ticket', 'CYAU-28']

describe('book command — Scenario 1: assigns to the authorized book and verifies the position in the table of contents', () => {
  it('page not yet in the book → assigned, position verified, auditable record', async () => {
    reset()
    const {result} = await runCaptured(TestBook, [...base, '--json'])
    const r = result as BookPayload
    expect(r.action).toBe('assigned')
    expect(r.bookId).toBe('b1')
    expect(r.pageId).toBe('p1')
    expect(r.toc).toEqual(['p0', 'p1'])
    expect(r.position).toBe(2)
    expect(assigns).toBe(1)
  })

  it('explicit position → the page is inserted at that point of the table of contents', async () => {
    reset()
    toc = {b1: ['p0', 'p2']}
    const {result} = await runCaptured(TestBook, [...base, '--position', '2', '--json'])
    const r = result as BookPayload
    expect(r.toc).toEqual(['p0', 'p1', 'p2'])
    expect(r.position).toBe(2)
  })

  it('idempotent: page already in the book → already-present, no new assignment', async () => {
    reset()
    toc = {b1: ['p0', 'p1']}
    const {result} = await runCaptured(TestBook, [...base, '--json'])
    const r = result as BookPayload
    expect(r.action).toBe('already-present')
    expect(r.position).toBe(2)
    expect(assigns).toBe(0)
  })

  it('already present at a position different from --position → already-present, requested position exposed, does not reorder', async () => {
    reset()
    toc = {b1: ['p1', 'p0']} // p1 already at position 1
    const {result} = await runCaptured(TestBook, [...base, '--position', '2', '--json'])
    const r = result as BookPayload
    expect(r.action).toBe('already-present')
    expect(r.position).toBe(1)
    expect(r.requestedPosition).toBe(2)
    expect(assigns).toBe(0)
  })

  it('human output: prints a summary of the assignment', async () => {
    reset()
    const {stdout} = await runCaptured(TestBook, [...base])
    expect(stdout).toContain('book')
    expect(stdout).toContain('Deploy & infra')
  })
})

describe('book command — dry-run (read-only): resolves the book without assigning', () => {
  it('shows the plan (resolved book, whether already present) and assigns NOTHING', async () => {
    reset()
    const {result} = await runCaptured(TestBook, [...base, '--dry-run', '--json'])
    const r = result as BookPayload
    expect(r.dryRun).toBe(true)
    expect(r.bookId).toBe('b1')
    expect(r.alreadyPresent).toBe(false)
    expect(assigns).toBe(0)
  })

  it('human output of the dry-run: prints the plan without touching the book', async () => {
    reset()
    const {stdout} = await runCaptured(TestBook, [...base, '--dry-run'])
    expect(stdout).toContain('dry-run')
    expect(stdout).toContain('Deploy & infra')
    expect(assigns).toBe(0)
  })
})

describe('book command — default real probe (construction)', () => {
  it('default makeRegistry builds the real probe (cyi kb book); "never remove" is structural', async () => {
    const config = await testConfig()
    class ExposeBook extends Book {
      registry(): BookRegistry {
        return this.makeRegistry()
      }
    }
    const cmd = new ExposeBook([], config)
    const reg = cmd.registry()
    expect(typeof reg.listBooks).toBe('function')
    expect(typeof reg.assignPage).toBe('function')
    expect('removePage' in reg).toBe(false)
    expect('delete' in reg).toBe(false)
  })
})

describe('book command — gate safe-by-default e difesa all’ingresso', () => {
  it('missing book → exit 3, C409-BOOK-002 (flagged, does not assign)', async () => {
    reset()
    books = [{id: 'bx', title: 'Altro', project: 'CYAU'}]
    const {stderr} = await runExpectingExit(TestBook, [...base], 3)
    expect(stderr).toContain('C409-BOOK-002')
    expect(assigns).toBe(0)
  })

  it('ambiguous book → exit 3, C409-BOOK-003 (reported, does not assign)', async () => {
    reset()
    books = [
      {id: 'b1', title: 'Deploy & infra', project: 'CYAU'},
      {id: 'b2', title: 'Deploy & infra', project: 'CYAU'},
    ]
    const {stderr} = await runExpectingExit(TestBook, [...base], 3)
    expect(stderr).toContain('C409-BOOK-003')
    expect(assigns).toBe(0)
  })

  it('gate exit 3 in --json → payload with the error on stdout (oclif suppresses stderr in JSON)', async () => {
    reset()
    books = [{id: 'bx', title: 'Altro', project: 'CYAU'}]
    const {stdout} = await runExpectingExit(TestBook, [...base, '--json'], 3)
    expect(stdout).toContain('C409-BOOK-002')
  })

  it('unsafe project-key → exit 2, C400-BOOK-001', async () => {
    reset()
    const {stderr} = await runExpectingExit(TestBook, ['--project', 'a/b', '--page-id', 'p1', '--book', 'Deploy & infra'], 2)
    expect(stderr).toContain('C400-BOOK-001')
  })

  it('non-positive-integer position → exit 2, C400-BOOK-001', async () => {
    reset()
    const {stderr} = await runExpectingExit(TestBook, [...base, '--position', '0'], 2)
    expect(stderr).toContain('C400-BOOK-001')
  })
})
