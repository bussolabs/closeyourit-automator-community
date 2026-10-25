import {z} from 'zod'
import {isSafeSegment} from './workspace'
import {type CommandOutcome, type CommandRunner, defaultRunner} from './publish'
import {AutomatorError, ErrorCodes} from '../errors/error-codes'

// Management of Knowledge pages in thematic books (CYAU-28). It is the "membership" counterpart of publish.ts
// (CYAU-27, which CREATES/UPDATES the page): when the policy indicates a thematic book, Automator assigns the page to it
// and VERIFIES its position in the table of contents (TOC). It implements steps 4 and 6 of knowledge-publishing.md — assignment
// to the book + check of the order in the TOC — leaving out the book CREATION (step 5): creating a book is
// a human/policy decision, so a missing or ambiguous book is REPORTED, never guessed (DoD "the documentation
// task clearly reports a missing or ambiguous book").
//
// Four invariants, mirror of publish:
//  - SCOPE / ANTI-BOLA: books are ALWAYS listed filtered by project (`-p <project>`), and as defence in
//    depth a book of a different project is never a match → assignment only to a book of the authorized
//    project. The real authorization is enforced server-side (service account scope).
//  - IDEMPOTENCY: if the page is already in the book's TOC → no-op (`already-present`), it is not added again.
//    Re-running the assignment does NOT create duplicates in the TOC.
//  - NEVER REMOVE: the `BookRegistry` probe exposes ONLY list/show/assign — no removal method → "removing
//    a page from a book" is STRUCTURALLY impossible (like "no delete" in publish, "no merge" in deliver).
//  - POSITION CHECK: after the assignment the TOC is re-read and the page is confirmed to appear (Scenario
//    1 "Then"); the position (1-based) is reported in the auditable record.
//
// The core is PURE and deterministic (book resolution, assign/no-op decision, check); the I/O (`cyi kb book`)
// lives behind the injectable `BookRegistry` probe, so the orchestration is testable without processes or network.

// ── Domain types ───────────────────────────────────────────────────────────────────────────────────────────

/** A thematic Knowledge book (subset for the resolution): id + title + project. */
export interface KnowledgeBook {
  id: string
  title: string
  project: string | null
}

/** A book's table of contents (TOC): the page ids in TOC order. */
export interface BookContents {
  bookId: string
  pageIds: string[]
}

// ── Input defence (the values end up in the argv of `cyi kb book` or in the metadata) ───────────────────────

/** Helper: builds the invalid input error (exit 2), input defence. */
function invalidInput(message: string): AutomatorError {
  return new AutomatorError(ErrorCodes.Book.invalidInput, message, 2)
}

export interface BookAssignmentInput {
  /** CloseYourIt project key: scope of the book search (`cyi kb book list -p <project>`). */
  project: string
  /** id of the Knowledge page to assign (normally returned by `publish`, CYAU-27). */
  pageId: string
  /** title of the thematic book indicated by the policy (resolution key). */
  bookTitle: string
  /** ticket code (provenance metadata, optional). */
  ticket?: string | null
  /** 1-based position in the TOC where to insert the page; null → append at the end (default). */
  position?: number | null
}

/**
 * Validates the input BEFORE any I/O (never a `cyi kb book …` on hostile input): project/page-id/ticket are
 * safe segments (they end up in the argv), the book title is not empty, the position — if given — is a positive
 * integer (the TOC is 1-based). Exit 2 on the first problem.
 */
export function assertBookInput(input: BookAssignmentInput): void {
  if (!isSafeSegment(input.project)) throw invalidInput(`Project-key non valida: "${input.project}"`)
  if (!isSafeSegment(input.pageId)) throw invalidInput(`Page-id non valido: "${input.pageId}"`)
  const ticket = input.ticket ?? null
  if (ticket !== null && !isSafeSegment(ticket)) throw invalidInput(`Codice ticket non valido: "${ticket}"`)
  if (input.bookTitle.trim() === '') throw invalidInput('Titolo del book vuoto')
  const position = input.position ?? null
  if (position !== null && (!Number.isInteger(position) || position < 1)) {
    throw invalidInput(`Posizione non valida: ${position} (dev'essere un intero positivo, il sommario è 1-based)`)
  }
}

// ── Book resolution (pure, deterministic) ───────────────────────────────────────────────────────────────

/**
 * Filters the books with EXACT title (case-insensitive, trimmed) in the project. The list arrives already filtered by project
 * from the server (`cyi kb book list -p …`): a missing `project` on the book is therefore considered the right project's
 * (never lose a match), while a different explicit `project` is excluded (anti-BOLA defence in depth:
 * never assign to another project's book). Pure.
 */
export function matchBookByTitle(books: KnowledgeBook[], title: string, project: string): KnowledgeBook[] {
  const wantTitle = title.trim().toLowerCase()
  const wantProject = project.toLowerCase()
  return books.filter((b) => {
    if (b.title.trim().toLowerCase() !== wantTitle) return false
    if (b.project === null) return true // list already filtered by project → missing project = ours
    return b.project.toLowerCase() === wantProject
  })
}

/**
 * Decides the outcome from the book search: 1 match → that book; 0 → book MISSING (`C409-BOOK-002`, exit 3: it must be
 * reported, not created — creating a book is a human/policy decision); more than one → AMBIGUITY (`C409-BOOK-003`,
 * exit 3: do not guess which one to assign to). Both gate outcomes are legitimate (like Publish.notVersioned) and use
 * a dedicated exit 3 so a shell gate does not assign to a non-existent or guessed book.
 */
export function resolveBookTarget(matches: KnowledgeBook[], title: string, project: string): KnowledgeBook {
  if (matches.length === 1) return matches[0]
  if (matches.length === 0) {
    throw new AutomatorError(
      ErrorCodes.Book.absent,
      `Nessun book «${title}» nel progetto ${project}: crea prima il book (dalla UI Knowledge) o correggi il nome nella policy`,
      3,
    )
  }
  throw new AutomatorError(
    ErrorCodes.Book.ambiguous,
    `${matches.length} book «${title}» nel progetto ${project}: ambiguità, risolvi il doppione prima di assegnare la pagina`,
    3,
  )
}

// ── Assignment plan (pure + read-only BookRegistry) ───────────────────────────────────────────────

export interface BookAssignmentPlan {
  project: string
  pageId: string
  bookId: string
  bookTitle: string
  ticket: string | null
  /** true if the page is ALREADY in the book's TOC (idempotency: it will be a no-op). */
  alreadyPresent: boolean
  /** CURRENT 1-based position of the page in the TOC, or null if not yet present. */
  position: number | null
  /** the book's current TOC (pageIds in order). */
  toc: string[]
}

/**
 * Validates the input, resolves the book in the project (`listBooks` → `matchBookByTitle` → `resolveBookTarget`) and reads
 * its TOC to tell whether the page is already present and at which position. Read-only (only list + show): it does not mutate the
 * book → also used by `--dry-run`. The input defence precedes every call to the probe.
 */
export function planBookAssignment(input: BookAssignmentInput, registry: BookRegistry): BookAssignmentPlan {
  assertBookInput(input)
  const book = resolveBookTarget(
    matchBookByTitle(registry.listBooks({project: input.project}), input.bookTitle, input.project),
    input.bookTitle,
    input.project,
  )
  const contents = registry.showBook({bookId: book.id})
  const idx = contents.pageIds.indexOf(input.pageId)
  return {
    project: input.project,
    pageId: input.pageId,
    bookId: book.id,
    bookTitle: book.title,
    ticket: input.ticket ?? null,
    alreadyPresent: idx >= 0,
    position: idx >= 0 ? idx + 1 : null,
    toc: contents.pageIds,
  }
}

// ── Auditable record and orchestration ────────────────────────────────────────────────────────────────────────

export const BookAssignmentResultSchema = z
  .object({
    project: z.string(),
    bookId: z.string(),
    bookTitle: z.string(),
    pageId: z.string(),
    ticket: z.string().nullable(),
    /** The action actually performed: idempotent (`already-present` if the page was already in the TOC). */
    action: z.enum(['assigned', 'already-present']),
    /** ACTUAL 1-based position of the page in the TOC, VERIFIED after the operation (Scenario 1 "Then"). */
    position: z.number().int().positive(),
    /**
     * REQUESTED 1-based position (`--position`), or null if not specified. Exposed next to the actual one
     * so a deviation (page already present elsewhere, or server clamp) is auditable and never silent.
     */
    requestedPosition: z.number().int().positive().nullable(),
    /** the book's resulting TOC (pageIds in order): the check is auditable. */
    toc: z.array(z.string()),
    reasons: z.array(z.string()),
  })
  .strict()
export type BookAssignmentResult = z.infer<typeof BookAssignmentResultSchema>

/**
 * Orchestrates the idempotent assignment behind the probe: (1) plan (validations + book resolution + current
 * TOC); (2) if the page is already in the TOC → no-op (`already-present`); (3) otherwise `assignPage` and then
 * VERIFIES the page appears in the updated TOC (Scenario 1). A missing/ambiguous book interrupts before
 * any mutation (the exception precedes `assignPage`). Returns an auditable record.
 */
export function assignPageToBook(input: BookAssignmentInput, registry: BookRegistry): BookAssignmentResult {
  const plan = planBookAssignment(input, registry)
  const requested = input.position ?? null
  const reasons: string[] = []

  if (plan.alreadyPresent) {
    const current = plan.position as number // invariant: alreadyPresent ⇒ position ≠ null
    reasons.push(
      `La pagina ${plan.pageId} è già nel sommario del book «${plan.bookTitle}» (posizione ${current}): nessuna nuova assegnazione (idempotente)`,
    )
    // "Never remove/reorder" is structural: an already present page is NOT moved. The deviation from the
    // requested position is however made EXPLICIT (Scenario 1 "check the position"), never silent.
    if (requested !== null && requested !== current) {
      reasons.push(
        `Posizione richiesta ${requested} non applicata: la pagina è già presente in posizione ${current} e non viene spostata (riordino a carico della review umana)`,
      )
    }
    return build(plan, 'already-present', current, requested, plan.toc, reasons)
  }

  const after = registry.assignPage({bookId: plan.bookId, pageId: plan.pageId, position: requested})
  const idx = after.pageIds.indexOf(plan.pageId)
  if (idx < 0) {
    // Scenario 1 "check the position in the TOC": if after the addition the page does not appear, the assignment
    // is not confirmed → it stops (like publish, the membership does not stay undetermined).
    throw new AutomatorError(
      ErrorCodes.Book.commandFailed,
      `Assegnazione al book «${plan.bookTitle}» non verificabile: la pagina ${plan.pageId} non compare nel sommario dopo l'aggiunta`,
      1,
    )
  }

  const effective = idx + 1
  reasons.push(
    `Pagina ${plan.pageId} assegnata al book «${plan.bookTitle}» (id ${plan.bookId}) in posizione ${effective} del sommario`,
  )
  // Position check: if the actual one differs from the requested one (e.g. the server clamped it to the end)
  // it is noted, without failing (the page IS in the authorized book → DoD satisfied, the position is a trifle).
  if (requested !== null && requested !== effective) {
    reasons.push(`Posizione richiesta ${requested}, effettiva ${effective} (il server ha collocato la pagina in posizione ${effective})`)
  }
  if (plan.ticket) reasons.push(`Provenienza: ticket ${plan.ticket}`)
  return build(plan, 'assigned', effective, requested, after.pageIds, reasons)
}

/** Composes the auditable record validated by the schema (single source of the fields common to the two outcomes). */
function build(
  plan: BookAssignmentPlan,
  action: BookAssignmentResult['action'],
  position: number,
  requestedPosition: number | null,
  toc: string[],
  reasons: string[],
): BookAssignmentResult {
  return BookAssignmentResultSchema.parse({
    project: plan.project,
    bookId: plan.bookId,
    bookTitle: plan.bookTitle,
    pageId: plan.pageId,
    ticket: plan.ticket,
    action,
    position,
    requestedPosition,
    toc,
    reasons,
  })
}

// ── Injectable probe (isolated I/O) ───────────────────────────────────────────────────────────────────────────

/**
 * Knowledge probe for the books. It exposes ONLY list/show/assign: no removal method → "removing a
 * page from a book" is STRUCTURALLY impossible (like "no delete" in publish). Injectable: mocked in tests,
 * real `cyi kb book` commands in production.
 */
export interface BookRegistry {
  /** Lists the project's books (resolution scope). Read-only. */
  listBooks(args: {project: string}): KnowledgeBook[]
  /** Reads a book's TOC: the page ids in order. Read-only. */
  showBook(args: {bookId: string}): BookContents
  /** Adds the page to the book (optional position) and returns the UPDATED TOC (for the check). */
  assignPage(args: {bookId: string; pageId: string; position: number | null}): BookContents
}

// ── Tolerant parsing of the `cyi kb book` output (untrusted input; contract independent of publish) ─────

const RawBookListEntrySchema = z
  .object({
    id: z.string().min(1),
    title: z.string().min(1),
    project: z.string().nullish(),
  })
  .passthrough()

/**
 * Extracts the books from the output of `cyi kb book list --json` (`{data:[…]}` or bare array). Tolerant like `readState`:
 * illegal JSON/unexpected shape → no book; malformed entries are discarded one by one.
 */
export function parseBookListJson(raw: string): KnowledgeBook[] {
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    return []
  }

  const entries = Array.isArray(parsed)
    ? parsed
    : typeof parsed === 'object' && parsed !== null && Array.isArray((parsed as {data?: unknown}).data)
      ? (parsed as {data: unknown[]}).data
      : []

  const books: KnowledgeBook[] = []
  for (const entry of entries) {
    const result = RawBookListEntrySchema.safeParse(entry)
    if (result.success) books.push({id: result.data.id, title: result.data.title, project: result.data.project ?? null})
  }

  return books
}

const RawBookPageSchema = z.object({id: z.string().min(1)}).passthrough()

/**
 * Extracts the TOC from the output of `cyi kb book show --json`. Supports two contract shapes:
 * `{data:{pages:[{id},…]}}` (or `{pages:[…]}`) and `{page_ids:[…]}` (or `{data:{page_ids:[…]}}`). Tolerant like
 * `parseBookListJson`: illegal JSON/unexpected shape → empty TOC; malformed entries are discarded one by one.
 */
export function parseBookContentsJson(bookId: string, raw: string): BookContents {
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    return {bookId, pageIds: []}
  }

  const isObject = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null
  const root = isObject(parsed) && isObject(parsed.data) ? parsed.data : parsed

  const pageIds: string[] = []
  if (isObject(root) && Array.isArray(root.pages)) {
    for (const entry of root.pages) {
      const result = RawBookPageSchema.safeParse(entry)
      if (result.success) pageIds.push(result.data.id)
    }
  } else if (isObject(root) && Array.isArray(root.page_ids)) {
    for (const id of root.page_ids) if (typeof id === 'string' && id !== '') pageIds.push(id)
  }

  return {bookId, pageIds}
}

// ── Real probe (`cyi kb book` behind an injectable CommandRunner) ───────────────────────────────────────────

/**
 * The real Knowledge probe for the books: `cyi kb book list/show/add-page --json` (argv array = no shell).
 * NO removal — "removing a page" is structurally impossible. A failed command becomes
 * `C502-BOOK-004` (exit 1): the assignment is NOT best-effort (failing it and continuing would leave the membership
 * undetermined → stop). `assignPage` re-reads the TOC after the addition for the CHECK (Scenario 1).
 *
 * ⚠️ cli/server dependency: the `cyi kb book list/show/add-page` commands (with server-side scope and anti-BOLA) must
 * exist. Today `cyi kb` handles only pages, not books (residual limit noted in CYAU-27): this probe
 * is the automator counterpart ready to hook them.
 */
export function defaultBookRegistry(run: CommandRunner = defaultRunner): BookRegistry {
  const fail = (what: string, outcome: CommandOutcome): never => {
    const detail = outcome.stderr.trim() || outcome.stdout.trim() || `exit ${outcome.status}`
    throw new AutomatorError(ErrorCodes.Book.commandFailed, `${what} fallito: ${detail}`, 1)
  }

  const show = (bookId: string): BookContents => {
    const outcome = run('cyi', ['kb', 'book', 'show', bookId, '--json'])
    if (outcome.status !== 0) fail('cyi kb book show', outcome)
    return parseBookContentsJson(bookId, outcome.stdout)
  }

  return {
    listBooks({project}) {
      const outcome = run('cyi', ['kb', 'book', 'list', '-p', project, '--per', '100', '--json'])
      if (outcome.status !== 0) fail('cyi kb book list', outcome)
      return parseBookListJson(outcome.stdout)
    },
    showBook({bookId}) {
      return show(bookId)
    },
    assignPage({bookId, pageId, position}) {
      const args = ['kb', 'book', 'add-page', bookId, '--page', pageId]
      if (position !== null) args.push('--position', String(position))
      args.push('--json')
      const outcome = run('cyi', args)
      if (outcome.status !== 0) fail('cyi kb book add-page', outcome)
      // Re-reads the updated TOC: the position CHECK (Scenario 1) compares this TOC.
      return show(bookId)
    },
  }
}
