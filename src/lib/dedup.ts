import {createHash} from 'node:crypto'
import {z} from 'zod'
import {type DiscoverySignal} from './discovery'
import {type CommandRunner, defaultRunner} from './publish'
import {isSafeSegment} from './workspace'
import {AutomatorError, ErrorCodes} from '../errors/error-codes'

// Signal deduplication before creating tickets (CYAU-30). Discovery (CYAU-29) produces SIGNALS about real
// problems; without dedup every repetition of the same problem (the same recurring error, the same failing
// build) would open a new ticket → backlog flooded with duplicates. This module is the dedup PIPELINE: given
// a signal and its context (repository, stack signature), it computes a deterministic SOURCE KEY
// (fingerprint from source + repository + normalized stack), searches the existing tickets on CloseYourIt (CYI search),
// compares them by fingerprint and similarity and DECIDES:
//  - `create`  → no duplicate: the ticket can be opened (with the fingerprint footer, so the next dedup finds it);
//  - `enrich`  → RELIABLE match (identical fingerprint or strong similarity on a single ticket): do NOT create,
//                enrich the existing ticket with the composed comment (Technical analysis);
//  - `triage`  → AMBIGUOUS match (several tickets with the same fingerprint, or unreliable similarity): stays in
//                triage for human review (DoD: "ambiguous matches stay in triage").
//
// The core is PURE and DETERMINISTIC (fingerprint, normalization, similarity, decision): same input → same
// outcome, so the dedup is repeatable and auditable. The CYI SEARCH lives behind the injectable `TicketSearch` probe,
// which is READ-ONLY by construction (it exposes only `listTickets`, never create/comment/delete → the module cannot
// create or modify tickets: structural, like "no delete" in publish, "no merge" in deliver). The real enrichment
// and creation are performed by the ORCHESTRATOR with the texts this module composes (as clarification composes
// the questions comment and cycle the summary): the decision and the composition are here, the mutating action is downstream.
//
// DoD "no ticket is created without a duplicate search": `runDedup` ALWAYS queries the CYI search before
// deciding, even when the outcome is `create`. The search is NOT best-effort (unlike guidance): if `cyi
// tickets list` fails we stop (`C502-DEDUP-004`) — continuing and creating would violate the DoD.

// ── Normalization (dedup robust to volatile noise) ────────────────────────────────────────────────────────

// VOLATILE parts of an error/stack signature that change between two occurrences of the SAME problem: timestamps,
// request UUIDs, memory addresses, line/column numbers. Removing them is what makes the fingerprint
// stable ("the same error" → "the same key"), avoiding a new ticket at every occurrence.
const ISO_DATETIME = /\d{4}-\d{2}-\d{2}[t ]\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:z|[+-]\d{2}:?\d{2})?/gi
const UUID = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi
const HEX_ADDR = /\b0x[0-9a-f]+\b/gi
const LINE_COL = /:\d+(?::\d+)?/g

/**
 * NORMALIZED stack signature: lowercase, removal of the volatile parts (timestamps, uuids, hex addresses,
 * line/column numbers), collapsed spaces. Deterministic and IDEMPOTENT (`normalizeStack(normalizeStack(x)) ===
 * normalizeStack(x)`), so `computeFingerprint` can normalize internally without depending on whether
 * the input is already normalized. The order matters: the timestamp (which contains `:`) is removed BEFORE the
 * line/column numbers.
 */
export function normalizeStack(raw: string): string {
  return raw
    .toLowerCase()
    .replace(ISO_DATETIME, ' ')
    .replace(UUID, ' ')
    .replace(HEX_ADDR, ' ')
    .replace(LINE_COL, ' ')
    .replace(/\s+/g, ' ')
    .trim()
}

/** Normalized repository (lowercase + trim): `owner/Repo` and `OWNER/repo` give the same source key. */
export function normalizeRepository(raw: string): string {
  return raw.trim().toLowerCase()
}

// ── Source key: the fingerprint (source + repository + normalized stack) ──────────────────────────────────

/**
 * The signal's FINGERPRINT: deterministic hash of source + normalized repository + normalized stack. It is the
 * "source key" of the Technical analysis — two occurrences of the same problem (same source, same repo,
 * same error up to the volatile noise) produce the SAME fingerprint. Pure: `createHash` is deterministic
 * (no time, no randomness). Truncated to 16 hex (64 bits): plenty for dedup, shorter marker.
 */
export function computeFingerprint(input: {source: string; repository: string; stack: string}): string {
  const canonical = [input.source.trim().toLowerCase(), normalizeRepository(input.repository), normalizeStack(input.stack)].join('\n')
  return createHash('sha1').update(canonical).digest('hex').slice(0, 16)
}

/** Hidden marker carrying the fingerprint in a ticket's text (like publish's PROVENANCE_MARKER). */
const FINGERPRINT_MARKER_RE = /<!--\s*automator:discovery-fingerprint:([a-f0-9]+)\s*-->/i

/** Composes the HTML-comment marker that wraps the fingerprint (round-trip with `parseFingerprintMarker`). */
export function fingerprintMarker(fp: string): string {
  return `<!-- automator:discovery-fingerprint:${fp} -->`
}

/** Extracts the fingerprint from the FIRST marker present in the text, or null (a hand-created ticket has no fingerprint). */
export function parseFingerprintMarker(text: string): string | null {
  const m = FINGERPRINT_MARKER_RE.exec(text)
  return m ? m[1] : null
}

/**
 * The footer to embed in the DESCRIPTION of a NEW ticket at creation: it carries the fingerprint marker so the
 * next dedup finds it by EXACT match (the search source is the description, which `cyi tickets list`
 * returns; the comments are not). Deterministic.
 */
export function composeFingerprintFooter(fp: string): string {
  return [
    '',
    '---',
    fingerprintMarker(fp),
    '_Impronta di deduplicazione automatica (CYAU-30): non rimuovere — evita ticket duplicati per lo stesso problema._',
  ].join('\n')
}

// ── Title similarity (Jaccard on tokens, deterministic) ──────────────────────────────────────────────────

/** The tokens of a title: lowercase, split on non-alphanumerics, without empties (a set, for Jaccard). */
function tokenize(raw: string): Set<string> {
  return new Set(raw.toLowerCase().split(/[^a-z0-9]+/i).filter((t) => t.length > 0))
}

/**
 * Similarity between two titles as the Jaccard index on tokens (|A∩B| / |A∪B|) in [0,1]: 1 = equivalent titles,
 * 0 = disjoint tokens. Insensitive to case and punctuation, deterministic. An empty title → 0 (never NaN).
 */
export function titleSimilarity(a: string, b: string): number {
  const sa = tokenize(a)
  const sb = tokenize(b)
  if (sa.size === 0 || sb.size === 0) return 0
  let inter = 0
  for (const t of sa) if (sb.has(t)) inter++
  const union = sa.size + sb.size - inter
  return union === 0 ? 0 : inter / union
}

// ── Similarity thresholds (configurable data, like the route policy) ─────────────────────────────────────────

export const SimilarityThresholdsSchema = z
  .object({
    /** ≥ strong = RELIABLE match (enrich if on a single ticket). */
    strong: z.number().min(0).max(1),
    /** [weak, strong) = SUSPECT but unreliable match → triage. Below weak = no duplicate. */
    weak: z.number().min(0).max(1),
  })
  .strict()
export type SimilarityThresholds = z.infer<typeof SimilarityThresholdsSchema>

/** Default thresholds: strong 0.8 (reliable), weak 0.5 (suspect). */
export const DEFAULT_SIMILARITY_THRESHOLDS: SimilarityThresholds = {strong: 0.8, weak: 0.5}

/** Validates the thresholds (untrusted CLI input): strong/weak in [0,1] and weak ≤ strong. Exit 2 otherwise. */
export function assertThresholds(t: SimilarityThresholds): void {
  const ok = (n: number): boolean => Number.isFinite(n) && n >= 0 && n <= 1
  if (!ok(t.strong) || !ok(t.weak)) throw invalidInput(`Soglie di similarità non valide: strong=${t.strong}, weak=${t.weak} (attese in [0,1])`)
  if (t.weak > t.strong) throw invalidInput(`Soglia debole ${t.weak} maggiore della forte ${t.strong}: incoerente`)
}

// ── Existing tickets and candidates (domain) ────────────────────────────────────────────────────────────────────

/** An existing ticket on CloseYourIt (subset for dedup): id + code + title + fingerprint (from the marker) + status. */
export interface ExistingTicket {
  id: string
  code: string
  title: string
  /** The fingerprint extracted from the marker in the description/analysis, or null (ticket without fingerprint). */
  fingerprint: string | null
  status: string | null
}

/** The dedup decision: create, enrich an existing one, or leave in triage for human review. */
export const DEDUP_DECISIONS = ['create', 'enrich', 'triage'] as const
export const DedupDecisionSchema = z.enum(DEDUP_DECISIONS)
export type DedupDecision = z.infer<typeof DedupDecisionSchema>

/** A ticket candidate for the match, with the match type (exact fingerprint or similarity) and the score. */
export const DedupCandidateSchema = z
  .object({
    id: z.string(),
    code: z.string(),
    title: z.string(),
    status: z.string().nullable(),
    matchType: z.enum(['fingerprint', 'similarity']),
    similarity: z.number().min(0).max(1),
  })
  .strict()
export type DedupCandidate = z.infer<typeof DedupCandidateSchema>

// ── findDuplicates: the heart of the decision (pure, deterministic) ────────────────────────────────────────────

export interface DuplicateQuery {
  fingerprint: string
  signalTitle: string
  tickets: ExistingTicket[]
  thresholds: SimilarityThresholds
}

export interface DuplicateOutcome {
  decision: DedupDecision
  candidates: DedupCandidate[]
  reasons: string[]
}

function candidateOf(t: ExistingTicket, matchType: DedupCandidate['matchType'], similarity: number): DedupCandidate {
  return {id: t.id, code: t.code, title: t.title, status: t.status, matchType, similarity}
}

/**
 * Compares the signal (fingerprint + title) with the existing tickets and decides (Scenario 1). Precedence:
 *  1. EXACT MATCH by fingerprint (the source key): 1 ticket → `enrich` (reliable); more than 1 → `triage`
 *     (ambiguous, do not guess which one to enrich). The fingerprint ALWAYS takes precedence over similarity.
 *  2. No exact match → title SIMILARITY: strong candidates (≥ strong) — 1 → `enrich`, more than 1 → `triage`;
 *     otherwise weak candidates ([weak, strong)) present → `triage` (suspect, human review); no
 *     candidate ≥ weak → `create` (no duplicate). The candidates are sorted by descending similarity.
 * Pure: no I/O, no randomness.
 */
export function findDuplicates(query: DuplicateQuery): DuplicateOutcome {
  const {fingerprint, signalTitle, tickets, thresholds} = query

  // 1. Exact match by fingerprint (source key): the most reliable way.
  const exact = tickets
    .filter((t) => t.fingerprint !== null && t.fingerprint === fingerprint)
    .sort((a, b) => a.code.localeCompare(b.code))
  if (exact.length === 1) {
    return {
      decision: 'enrich',
      candidates: [candidateOf(exact[0], 'fingerprint', 1)],
      reasons: [`Match esatto per fingerprint ${fingerprint} sul ticket ${exact[0].code}: duplicato affidabile, arricchisco quello`],
    }
  }

  if (exact.length > 1) {
    return {
      decision: 'triage',
      candidates: exact.map((t) => candidateOf(t, 'fingerprint', 1)),
      reasons: [`${exact.length} ticket con lo stesso fingerprint ${fingerprint}: ambiguo, resta in triage per revisione umana`],
    }
  }

  // 2. No exact match → similarity on the titles.
  const scored = tickets
    .map((t) => ({t, sim: titleSimilarity(signalTitle, t.title)}))
    .filter((s) => s.sim >= thresholds.weak)
    .sort((a, b) => b.sim - a.sim || a.t.code.localeCompare(b.t.code))

  const strong = scored.filter((s) => s.sim >= thresholds.strong)
  if (strong.length === 1) {
    return {
      decision: 'enrich',
      candidates: [candidateOf(strong[0].t, 'similarity', strong[0].sim)],
      reasons: [`Similarità forte ${strong[0].sim.toFixed(2)} col ticket ${strong[0].t.code} (≥ ${thresholds.strong}): duplicato affidabile, arricchisco quello`],
    }
  }

  if (strong.length > 1) {
    return {
      decision: 'triage',
      candidates: strong.map((s) => candidateOf(s.t, 'similarity', s.sim)),
      reasons: [`${strong.length} ticket con similarità forte (≥ ${thresholds.strong}): ambiguo, resta in triage per revisione umana`],
    }
  }

  if (scored.length > 0) {
    return {
      decision: 'triage',
      candidates: scored.map((s) => candidateOf(s.t, 'similarity', s.sim)),
      reasons: [`${scored.length} ticket con similarità debole ([${thresholds.weak}, ${thresholds.strong})): match non affidabile, resta in triage per revisione umana`],
    }
  }

  return {
    decision: 'create',
    candidates: [],
    reasons: ['Nessun ticket duplicato (né per fingerprint né per similarità): si può creare il ticket'],
  }
}

// ── Composition of the enrichment comment (the orchestrator posts it with `cyi tickets comment`) ────────────

export interface EnrichmentInput {
  signal: DiscoverySignal
  repository: string
  fingerprint: string
  ticketCode: string
}

/**
 * Composes the comment with which the orchestrator ENRICHES the existing ticket instead of opening a duplicate
 * (Technical analysis "enrich the existing ticket via comment when the match is reliable"). It reports the
 * new occurrence of the signal — source, impact, confidence, repository, evidence — and the fingerprint for the audit.
 * Deterministic. The module posts NOTHING (the probe is read-only): it returns the text.
 */
export function composeEnrichmentComment(input: EnrichmentInput): string {
  const {signal, repository, fingerprint} = input
  const lines = [
    '**Nuova occorrenza rilevata dalla discovery automatica (CYAU-30)**',
    '',
    'Un segnale con la stessa impronta di questo ticket è stato rilevato di nuovo: invece di aprire un duplicato, lo riporto qui.',
    '',
    `- Fonte: \`${signal.source}\``,
    `- Impatto: **${signal.impact}**`,
    `- Confidenza: ${signal.confidence}`,
    `- Repository: \`${repository}\``,
    `- Impronta: \`${fingerprint}\``,
    '',
    'Evidenza:',
    `> ${signal.evidence}`,
  ]
  if (signal.detail !== null && signal.detail.trim() !== '') {
    lines.push('', signal.detail.trim())
  }

  return lines.join('\n')
}

// ── Auditable record and orchestration ────────────────────────────────────────────────────────────────────────

export const DedupResultSchema = z
  .object({
    project: z.string(),
    decision: DedupDecisionSchema,
    fingerprint: z.string(),
    /** Normalized repository (part of the source key, exposed for the audit — Scenario 1). */
    repository: z.string(),
    /** Normalized stack signature (part of the source key, exposed for the audit — Scenario 1). */
    normalizedStack: z.string(),
    signalTitle: z.string(),
    candidates: z.array(DedupCandidateSchema),
    /** The code of the ticket to enrich (only `enrich`), otherwise null. */
    target: z.string().nullable(),
    /** The comment composed for the enrichment (only `enrich`), otherwise null. The orchestrator posts it. */
    enrichmentComment: z.string().nullable(),
    /** The fingerprint footer to embed in the new ticket (only `create`), otherwise null. */
    newTicketFooter: z.string().nullable(),
    reasons: z.array(z.string()),
  })
  .strict()
export type DedupResult = z.infer<typeof DedupResultSchema>

export interface DedupInput {
  /** CloseYourIt project key: scope of the CYI search (`cyi tickets list -p <project>`). */
  project: string
  /** The discovery signal (CYAU-29) to deduplicate. */
  signal: DiscoverySignal
  /** The repository where the signal was detected (part of the source key). */
  repository: string
  /** The raw stack signature (to normalize); missing → falls back to the signal's evidence. */
  stack?: string | null
  /** Similarity thresholds (default `DEFAULT_SIMILARITY_THRESHOLDS`). */
  thresholds?: SimilarityThresholds
}

/**
 * Validates the input BEFORE any I/O (never a `cyi tickets list` on hostile input): the project key is a safe
 * segment (it ends up in the `cyi` argv), the repository is not empty, the thresholds are consistent. Exit 2 on the first problem.
 */
export function assertDedupInput(input: DedupInput): void {
  if (!isSafeSegment(input.project)) throw invalidInput(`Project-key non valida: "${input.project}"`)
  if (input.repository.trim() === '') throw invalidInput('Repository vuoto: serve per la chiave sorgente')
  if (input.thresholds !== undefined) assertThresholds(input.thresholds)
}

/**
 * Orchestrates the dedup pipeline behind the read-only probe: (1) validates the input; (2) computes the fingerprint from the
 * source key (source + repository + normalized stack — a missing stack falls back to the evidence); (3) ALWAYS searches
 * the existing tickets on CYI (DoD: no decision without a duplicate search); (4) `findDuplicates` decides;
 * (5) composes the comment (enrich) or the fingerprint footer (create). Returns an auditable record: the DECISION is here,
 * the mutating action (create/comment) belongs to the orchestrator. It does NOT throw for enrich/triage — the gate belongs to the command.
 */
export function runDedup(input: DedupInput, search: TicketSearch): DedupResult {
  assertDedupInput(input)

  const thresholds = input.thresholds ?? DEFAULT_SIMILARITY_THRESHOLDS
  const repository = normalizeRepository(input.repository)
  // A missing stack falls back to the signal's evidence: the signature always exists (never a fingerprint on empty input).
  const rawStack = input.stack ?? input.signal.evidence
  const normalizedStack = normalizeStack(rawStack)
  const fingerprint = computeFingerprint({source: input.signal.source, repository, stack: rawStack})

  // CYI search: ALWAYS run before deciding (DoD). The real probe fails with C502 on a failed command
  // (not best-effort): continuing and creating would violate "no ticket without a duplicate search".
  const tickets = search.listTickets({project: input.project})
  const outcome = findDuplicates({fingerprint, signalTitle: input.signal.title, tickets, thresholds})

  const reasons = [
    `Chiave sorgente: fonte ${input.signal.source} · repository ${repository} · stack normalizzato «${normalizedStack}» → fingerprint ${fingerprint}`,
    `Ricerca CYI: ${tickets.length} ticket esaminati nel progetto ${input.project}`,
    ...outcome.reasons,
  ]

  let target: string | null = null
  let enrichmentComment: string | null = null
  let newTicketFooter: string | null = null

  if (outcome.decision === 'enrich') {
    target = outcome.candidates[0].code
    enrichmentComment = composeEnrichmentComment({signal: input.signal, repository, fingerprint, ticketCode: target})
  } else if (outcome.decision === 'create') {
    newTicketFooter = composeFingerprintFooter(fingerprint)
  }

  return DedupResultSchema.parse({
    project: input.project,
    decision: outcome.decision,
    fingerprint,
    repository,
    normalizedStack,
    signalTitle: input.signal.title,
    candidates: outcome.candidates,
    target,
    enrichmentComment,
    newTicketFooter,
    reasons,
  })
}

// ── Injectable probe (CYI search, READ-ONLY) ────────────────────────────────────────────────────────────────

/**
 * Probe of the ticket search on CloseYourIt. It exposes ONLY `listTickets`: no create/comment/delete
 * method → the dedup module CANNOT create or modify tickets (STRUCTURAL property, like "no delete" in
 * publish). It reinforces the DoD "no ticket created without a duplicate search": the search is the only thing the probe
 * can do. Injectable: mocked in tests, real `cyi tickets list` in production.
 */
export interface TicketSearch {
  listTickets(args: {project: string}): ExistingTicket[]
}

// ── Parsing of the `cyi tickets list --json` output (STRICT envelope for fail-closedness) ──────────────────

const RawTicketSchema = z
  .object({
    id: z.string().min(1),
    code: z.string().min(1),
    title: z.string().min(1),
    description: z.string().nullish(),
    technical_analysis: z.string().nullish(),
    status: z.string().nullish(),
  })
  .passthrough()

/** Maps the raw entries to ExistingTicket (fingerprint from the marker in description/analysis); malformed ones discarded one by one. */
function entriesToTickets(entries: unknown[]): ExistingTicket[] {
  const tickets: ExistingTicket[] = []
  for (const entry of entries) {
    const result = RawTicketSchema.safeParse(entry)
    if (!result.success) continue
    const {id, code, title, description, technical_analysis, status} = result.data
    const haystack = `${description ?? ''}\n${technical_analysis ?? ''}`
    tickets.push({id, code, title, fingerprint: parseFingerprintMarker(haystack), status: status ?? null})
  }

  return tickets
}

/** A page of tickets + the total number of pages from the envelope (`meta.total_pages`), or null if not exposed. */
export interface TicketsPage {
  tickets: ExistingTicket[]
  totalPages: number | null
}

/**
 * Parses ONE page of the `cyi tickets list --json` output. Unlike a TOLERANT parser (which would degrade
 * to "no ticket"), here the envelope MUST be valid: illegal JSON or unexpected shape (neither a bare array nor
 * `{data:[…]}`) → `null`, which the probe translates into `C502-DEDUP-004`. In the duplicate search, "no ticket" deduced
 * from a broken response would create a duplicate → fail-closed. Malformed entries INSIDE a valid envelope are
 * discarded (untrusted granular data). `meta.total_pages` (integer ≥ 1) drives the full pagination.
 */
export function parseTicketsPage(raw: string): TicketsPage | null {
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    return null
  }

  if (Array.isArray(parsed)) return {tickets: entriesToTickets(parsed), totalPages: null}

  if (typeof parsed === 'object' && parsed !== null && Array.isArray((parsed as {data?: unknown}).data)) {
    const obj = parsed as {data: unknown[]; meta?: unknown}
    const meta = obj.meta as {total_pages?: unknown} | undefined
    const tp = meta && Number.isInteger(meta.total_pages) ? (meta.total_pages as number) : null
    return {tickets: entriesToTickets(obj.data), totalPages: tp !== null && tp >= 1 ? tp : null}
  }

  return null // unexpected shape (neither array nor {data:[…]}): broken envelope → the probe fails (fail-closed)
}

// ── Real probe (`cyi tickets list` behind an injectable CommandRunner) ───────────────────────────────────────

/**
 * The real CYI search probe: `cyi tickets list -p <project> --page N --json` (argv array = no shell).
 * FULL PAGINATION via `meta.total_pages` — it reads ALL the pages, without a silent cap (a cap would truncate the
 * search and miss a duplicate beyond the limit → duplicate; and a "until empty page" loop is unreliable
 * because `--page` beyond the range does not necessarily return empty). READ-ONLY. A failed command OR an invalid
 * response (illegal JSON/unexpected envelope, even with exit 0) becomes `C502-DEDUP-004` (exit 1): the duplicate
 * search is NOT best-effort — deducing "no ticket" from a broken response would create a duplicate → stop.
 */
export function defaultTicketSearch(run: CommandRunner = defaultRunner): TicketSearch {
  const fail = (detail: string): never => {
    throw new AutomatorError(ErrorCodes.Dedup.searchFailed, `cyi tickets list fallito: ${detail}`, 1)
  }

  const fetchPage = (project: string, page: number): TicketsPage => {
    const outcome = run('cyi', ['tickets', 'list', '-p', project, '--page', String(page), '--json'])
    if (outcome.status !== 0) return fail(outcome.stderr.trim() || outcome.stdout.trim() || `exit ${outcome.status}`)
    const parsed = parseTicketsPage(outcome.stdout)
    if (parsed === null) return fail(`risposta non valida a pagina ${page} (JSON illegale o envelope inatteso)`)
    return parsed
  }

  return {
    listTickets({project}) {
      const first = fetchPage(project, 1)
      const all = [...first.tickets]
      // `meta.total_pages` missing (non-paginated endpoint) → a single page; present → read them all, in order.
      const totalPages = first.totalPages ?? 1
      for (let page = 2; page <= totalPages; page++) {
        all.push(...fetchPage(project, page).tickets)
      }

      return all
    },
  }
}

/** Helper: builds the invalid input error (exit 2), input defence (untrusted CLI/agent input). */
function invalidInput(message: string): AutomatorError {
  return new AutomatorError(ErrorCodes.Dedup.invalidInput, message, 2)
}
