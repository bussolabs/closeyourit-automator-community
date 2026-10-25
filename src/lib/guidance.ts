import {spawnSync} from 'node:child_process'
import * as fs from 'node:fs'
import * as path from 'node:path'
import {z} from 'zod'
import {isSafeSegment} from './workspace'
import {AutomatorError, ErrorCodes} from '../errors/error-codes'

// Automatic consultation of the local guidance and of the CloseYourIt Knowledge (CYAU-26). Before an agent
// decides on the ticket, Automator prepares a uniform CONTEXT: the repository's local conventions (the
// CLAUDE.md/AGENTS.md files, looked up climbing the hierarchy up to the git root) and the project's relevant Knowledge
// pages (via `cyi kb search`, read-only). The package is ONE only, runtime-agnostic → Claude and Codex
// receive the SAME applicable guidance (DoD): there is no "runtime" parameter in this module, it is a
// STRUCTURAL property (like "no merge" in deliver.ts), not a convention.
//
// The core is PURE and deterministic: `composeGuidancePack` composes the markdown and the list of consulted sources
// (auditable record, DoD "record consulted sources") from the already collected sources; the I/O lives
// behind two injectable probes — `GuidanceFs` (reading the local files) and `KbProbe` (querying the KB) —
// so the orchestration is testable without filesystem or processes (like `workspace`/`deliver`).
//
// Scope and permissions (DoD "service account permissions and scope honoured", Scenario "without exposing unauthorized
// content"): the real scope is enforced SERVER-SIDE (the service account sees via `cyi kb` only what it has
// access to). The client does its part: it ALWAYS queries filtering by the ticket's project (`-p <project>`) and,
// as defence in depth, DISCARDS from the package every page of a different project. The `KbProbe` probe exposes
// ONLY the search (read-only): there is no method that creates/modifies/deletes pages → never a Knowledge
// mutation, never content outside the project. The consultation is best-effort: a network failure does NOT block the
// context preparation (it degrades to local guidance only, noting it), consistent with "verify the
// conclusions on the code" (the pages are indications, not truth: the package states it explicitly).

/** The local convention files looked up by default in the repository hierarchy (from the root towards the worktree). */
export const LOCAL_GUIDANCE_FILES: readonly string[] = ['CLAUDE.md', 'AGENTS.md']

/** How many levels to climb at most looking for the git root, if it is not met earlier (defensive cap). */
export const DEFAULT_MAX_UP = 8

/** A local guidance source read from the repository: the file path and its content. */
export interface LocalGuidanceSource {
  path: string
  content: string
}

/** A Knowledge page (subset of the `cyi kb` output, camelCase). The body is the actual guidance. */
export interface KbPage {
  id: string
  title: string
  body: string
  kind: string | null
  project: string | null
  projectName: string | null
  updatedAt: string | null
}

/** A consulted source, recorded for the audit (DoD): its origin, the reference and a readable title. */
export interface ConsultedSource {
  origin: 'local' | 'knowledge'
  /** Unique reference: the path for a local source, the page id for the Knowledge. */
  ref: string
  title: string
}

/** The uniform context package for the agents: the markdown + the structured list of consulted sources. */
export interface GuidancePack {
  project: string
  code: string | null
  /** The full context in markdown, identical for every runtime (Claude/Codex). */
  markdown: string
  /** The consulted sources, for the audit (local + Knowledge). */
  sources: ConsultedSource[]
  hasLocal: boolean
  hasKnowledge: boolean
  /** true if the Knowledge was consultable (no network error prevented it entirely). */
  knowledgeAvailable: boolean
  /** Non-fatal diagnostic notes (failed searches, out-of-scope pages ignored, no query). */
  notes: string[]
}

// ── Injectable probes (isolated I/O) ──────────────────────────────────────────────────────────────────────────

/** The filesystem probes for the local guidance: reading a file and recognising a repository root. */
export interface GuidanceFs {
  /** Reads a file's content, or null if missing/unreadable (best-effort, never throws). */
  read: (file: string) => string | null
  /** true if `dir` is the root of a git checkout (contains `.git`, file or directory) → the climb stops here. */
  isRepoRoot: (dir: string) => boolean
}

/** Outcome of a Knowledge search: the pages found, or a failure reason (network/HTTP/permissions). */
export type KbSearchOutcome = {ok: true; pages: KbPage[]} | {ok: false; reason: string}

/**
 * The Knowledge probe. It exposes ONLY the search (read-only): no write method → by construction the
 * consultation never mutates the Knowledge nor can it expose pages outside the filtered scope. Injectable: mocked
 * in tests, real `cyi kb` commands in production.
 */
export interface KbProbe {
  /** Searches the pages relevant to the query, ALWAYS filtering by project (scope). Read-only. */
  search(args: {query: string; project: string}): KbSearchOutcome
}

// ── Local guidance (pure with respect to the filesystem: uses GuidanceFs) ─────────────────────────────────────────────

/**
 * The directories where to look for local guidance, from the `cwd` climbing the hierarchy up to the git root INCLUDED
 * (or up to the `maxUp` cap / the filesystem root). Returned in order from the highest (general) to the
 * `cwd` (specific): so the more specific conventions appear LATER in the package and refine the general ones,
 * as Claude Code loads the hierarchical CLAUDE.md files. Pure: the git root lookup goes through `isRepoRoot`.
 */
export function guidanceDirs(cwd: string, isRepoRoot: (dir: string) => boolean, maxUp: number = DEFAULT_MAX_UP): string[] {
  const dirs: string[] = []
  let dir = path.resolve(cwd)
  for (let i = 0; i <= maxUp; i++) {
    dirs.push(dir)
    if (isRepoRoot(dir)) break // repo root included: do not climb beyond the checkout
    const parent = path.dirname(dir)
    if (parent === dir) break // filesystem root
    dir = parent
  }

  return dirs.reverse() // from the root (general) towards the cwd (specific)
}

/**
 * Collects the local guidance sources: for every directory of the hierarchy (root → cwd) it reads the canonical files
 * (`files`), keeping only those present and non-empty. Deduplicates by path. Pure with respect to the real filesystem
 * (uses `fsDeps`). The order reflects the hierarchy (general first, specific after).
 */
export function collectLocalGuidance(
  cwd: string,
  fsDeps: GuidanceFs,
  files: readonly string[] = LOCAL_GUIDANCE_FILES,
  maxUp: number = DEFAULT_MAX_UP,
): LocalGuidanceSource[] {
  const dirs = guidanceDirs(cwd, fsDeps.isRepoRoot, maxUp)
  const out: LocalGuidanceSource[] = []
  const seen = new Set<string>()
  for (const dir of dirs) {
    for (const file of files) {
      const filePath = path.join(dir, file)
      if (seen.has(filePath)) continue
      const content = fsDeps.read(filePath)
      if (content !== null && content.trim() !== '') {
        seen.add(filePath)
        out.push({path: filePath, content})
      }
    }
  }

  return out
}

// ── Parsing of the `cyi kb` output (untrusted input: it comes from the server) ──────────────────────────────────────

// Tolerant schema of a raw Knowledge page (snake_case, like `cyi kb --json`). Only id/title/body are
// required (without them, the page has no useful guidance → discarded); the metadata are optional.
const RawKbPageSchema = z
  .object({
    id: z.string().min(1),
    title: z.string().min(1),
    body: z.string(),
    kind: z.string().nullish(),
    project: z.string().nullish(),
    project_name: z.string().nullish(),
    updated_at: z.string().nullish(),
  })
  .passthrough()

function toKbPage(raw: z.infer<typeof RawKbPageSchema>): KbPage {
  return {
    id: raw.id,
    title: raw.title,
    body: raw.body,
    kind: raw.kind ?? null,
    project: raw.project ?? null,
    projectName: raw.project_name ?? null,
    updatedAt: raw.updated_at ?? null,
  }
}

/**
 * Extracts the pages from the JSON output of `cyi kb search --json` (`{data:[…]}` or a bare array). Tolerant like
 * `readState`: illegal JSON or unexpected shape → no page; malformed entries are discarded one by one without
 * failing the rest. The output comes from the server → never trust it blindly.
 */
export function parseKbSearchJson(raw: string): KbPage[] {
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    return []
  }

  const entries = Array.isArray(parsed)
    ? parsed
    : typeof parsed === 'object' && parsed !== null && Array.isArray((parsed as {data?: unknown}).data)
      ? ((parsed as {data: unknown[]}).data)
      : []

  const pages: KbPage[] = []
  for (const entry of entries) {
    const result = RawKbPageSchema.safeParse(entry)
    if (result.success) pages.push(toKbPage(result.data))
  }

  return pages
}

// ── Package composition (pure) ─────────────────────────────────────────────────────────────────────────

/** Guide line always at the top of the package: the sources are INDICATIONS, not truth — verify on the code (DoD). */
export const VERIFY_ON_CODE_NOTICE =
  'Contesto uniforme per Claude e Codex. Queste sono INDICAZIONI: verifica sempre le conclusioni sul codice sorgente prima di agire.'

/** Sorts the Knowledge pages stably (project, title, id) → deterministic package regardless of cyi. */
function sortPages(pages: KbPage[]): KbPage[] {
  return [...pages].sort(
    (a, b) => (a.project ?? '').localeCompare(b.project ?? '') || a.title.localeCompare(b.title) || a.id.localeCompare(b.id),
  )
}

function labelForCode(code: string | null): string {
  return code && code.trim() !== '' ? code.trim() : 'il ticket'
}

function fence(content: string): string[] {
  // Adaptive fence: if the content already contains ``` a longer fence is used so the markdown does not break.
  const ticks = content.includes('```') ? '````' : '```'
  return [ticks, content.trimEnd(), ticks]
}

export interface ComposeGuidanceInput {
  project: string
  code?: string | null
  local: LocalGuidanceSource[]
  knowledge: KbPage[]
  knowledgeAvailable: boolean
  notes?: string[]
}

/**
 * Composes the uniform context package. It does NOT receive any "runtime": the output is identical for Claude and Codex
 * (DoD, structural property). Deterministic: no dependency on time/randomness, pages sorted
 * stably. It always includes the three sections — local conventions, Knowledge, consulted sources — with explicit
 * placeholders when one is empty (the context is never "silent"), and at the top the warning to verify on the code.
 */
export function composeGuidancePack(input: ComposeGuidanceInput): GuidancePack {
  const code = input.code ?? null
  const notes = input.notes ?? []
  const knowledge = sortPages(input.knowledge)

  const lines: string[] = []
  lines.push(`# Guidance per ${labelForCode(code)} — progetto ${input.project}`, '')
  lines.push(`> ${VERIFY_ON_CODE_NOTICE}`, '')

  // Local conventions (CLAUDE.md/AGENTS.md of the hierarchy).
  lines.push('## Convenzioni locali', '')
  if (input.local.length === 0) {
    lines.push(`Nessuna convenzione locale trovata (${LOCAL_GUIDANCE_FILES.join(', ')}).`, '')
  } else {
    for (const source of input.local) {
      lines.push(`### ${source.path}`, '', ...fence(source.content), '')
    }
  }

  // The project's CloseYourIt Knowledge.
  lines.push(`## Knowledge CloseYourIt — progetto ${input.project}`, '')
  if (!input.knowledgeAvailable) {
    lines.push('Knowledge non consultabile in questo momento: procedi con le sole convenzioni locali e il codice sorgente.', '')
  } else if (knowledge.length === 0) {
    lines.push(`Nessuna pagina Knowledge pertinente per il progetto ${input.project}.`, '')
  } else {
    for (const page of knowledge) {
      const meta = [page.kind, `id ${page.id}`].filter((x): x is string => typeof x === 'string' && x !== '')
      lines.push(`### ${page.title} · ${meta.join(' · ')}`, '', ...fence(page.body), '')
    }
  }

  // Consulted sources (auditable record).
  const sources = buildSources(input.local, knowledge)
  lines.push('## Fonti consultate', '')
  if (sources.length === 0) {
    lines.push('Nessuna fonte disponibile: procedi verificando direttamente il codice sorgente.')
  } else {
    for (const s of sources) {
      lines.push(s.origin === 'local' ? `- [locale] ${s.ref}` : `- [knowledge] ${s.title} — id ${s.ref} (progetto ${input.project})`)
    }
  }

  if (notes.length > 0) {
    lines.push('', '## Note', '')
    for (const note of notes) lines.push(`- ${note}`)
  }

  return {
    project: input.project,
    code,
    markdown: lines.join('\n'),
    sources,
    hasLocal: input.local.length > 0,
    hasKnowledge: knowledge.length > 0,
    knowledgeAvailable: input.knowledgeAvailable,
    notes,
  }
}

/** The structured list of the consulted sources: first the local ones (in hierarchical order), then the Knowledge (sorted). */
function buildSources(local: LocalGuidanceSource[], knowledge: KbPage[]): ConsultedSource[] {
  const sources: ConsultedSource[] = []
  for (const source of local) sources.push({origin: 'local', ref: source.path, title: source.path})
  for (const page of knowledge) sources.push({origin: 'knowledge', ref: page.id, title: page.title})
  return sources
}

// ── Search queries (pure) ───────────────────────────────────────────────────────────────────────────────────

/** The ticket content from which to derive the Knowledge search queries. */
export interface TicketQueryContent {
  title?: string
  technicalAnalysis?: string
}

/**
 * Derives the Knowledge search queries from the ticket content: the title (most targeted query) and, if the title
 * is missing, the technical analysis as fallback. Deduplicates and discards empty strings. Pure. The command can add
 * explicit queries (`--query`) to these.
 */
export function deriveKbQueries(content: TicketQueryContent): string[] {
  const candidates: string[] = []
  const title = content.title?.trim()
  const analysis = content.technicalAnalysis?.trim()
  if (title) candidates.push(title)
  else if (analysis) candidates.push(analysis) // fallback only if the title is missing (the analysis is noisier as a query)

  return dedupeStrings(candidates)
}

function dedupeStrings(values: string[]): string[] {
  const seen = new Set<string>()
  const out: string[] = []
  for (const value of values) {
    const trimmed = value.trim()
    if (trimmed === '' || seen.has(trimmed)) continue
    seen.add(trimmed)
    out.push(trimmed)
  }

  return out
}

// ── Orchestration (behind the probes) ──────────────────────────────────────────────────────────────────────────

export interface GatherGuidanceInput {
  project: string
  code?: string
  cwd: string
  /** The Knowledge search queries (explicit + derived from the ticket). If empty, the KB is not queried. */
  queries: string[]
  /** Additional local guidance file names besides CLAUDE.md/AGENTS.md. */
  extraFiles?: string[]
  maxUp?: number
}

export interface GuidanceDeps {
  fs: GuidanceFs
  kb: KbProbe
}

/**
 * Prepares the context package: collects the local guidance (hierarchy) and queries the Knowledge (one
 * search per query, ALWAYS filtered by project), then composes the uniform package. Best-effort on the KB:
 * a failed search is noted (no exception), and if EVERY search fails the Knowledge is marked not
 * consultable → it degrades to local guidance only. Defence in depth on the scope: the pages of a
 * different project are DISCARDED (never expose out-of-scope content). It does not receive a "runtime": a single
 * package for all agents (DoD).
 */
export function gatherGuidance(input: GatherGuidanceInput, deps: GuidanceDeps): GuidancePack {
  const files = [...LOCAL_GUIDANCE_FILES, ...(input.extraFiles ?? [])]
  const local = collectLocalGuidance(input.cwd, deps.fs, files, input.maxUp ?? DEFAULT_MAX_UP)

  const pagesById = new Map<string, KbPage>()
  const notes: string[] = []
  let attempted = 0
  let failed = 0
  let foreignDropped = 0

  for (const query of dedupeStrings(input.queries)) {
    attempted++
    const outcome = deps.kb.search({query, project: input.project})
    if (!outcome.ok) {
      failed++
      notes.push(`Ricerca Knowledge fallita per "${query}": ${outcome.reason}`)
      continue
    }

    for (const page of outcome.pages) {
      // Scope (defence in depth on top of the server-side filter): never include a page of a different project.
      // CASE-INSENSITIVE comparison: CloseYourIt project keys are case-insensitive (`cyi kb` accepts both
      // `cyau` and `CYAU` and returns the canonical key) → a different casing in the input must NOT discard the legitimate
      // pages of the right project (otherwise the defence in depth would wipe out ALL the Knowledge).
      if (page.project && page.project.toLowerCase() !== input.project.toLowerCase()) {
        foreignDropped++
        continue
      }

      if (!pagesById.has(page.id)) pagesById.set(page.id, page)
    }
  }

  if (foreignDropped > 0) {
    notes.push(`${foreignDropped} pagine di altri progetti ignorate (scope del progetto ${input.project})`)
  }

  if (attempted === 0) notes.push('Nessuna query di ricerca Knowledge (nessun titolo/argomento fornito)')

  // Knowledge "not consultable" only if we tried and EVERY search failed: a network blip must not
  // look like "no page", but "not consultable now" → the agent knows to proceed with local guidance only.
  const knowledgeAvailable = attempted === 0 ? true : failed < attempted

  return composeGuidancePack({
    project: input.project,
    code: input.code,
    local,
    knowledge: [...pagesById.values()],
    knowledgeAvailable,
    notes,
  })
}

// ── Input defence ───────────────────────────────────────────────────────────────────────────────────────

/**
 * Rejects an unsafe project key: it ends up in the argv of `cyi kb search -p <project>` → input defence
 * (untrusted input), as `deliver`/`workspace` validate their own segments. Exit 2.
 */
export function assertSafeProject(project: string): void {
  if (!isSafeSegment(project)) {
    throw new AutomatorError(ErrorCodes.Guidance.invalidInput, `Project-key non valida: "${project}"`, 2)
  }
}

// ── Real probes (filesystem + `cyi kb` behind an injectable CommandRunner) ───────────────────────────────────

export interface CommandOutcome {
  status: number | null
  stdout: string
  stderr: string
}

/** Runs an external command and returns its outcome (injectable: default `spawnSync`, argv array = no shell). */
export type CommandRunner = (cmd: string, args: string[]) => CommandOutcome

/**
 * Default real runner: `spawnSync` with argv array (no shell) and hard timeout. The Guidance is collected
 * in the daemon loop: no external CLI can therefore block scheduler, heartbeat or shutdown indefinitely.
 * `timeoutMs` is exposed only for deterministic tests; production uses 15 seconds.
 */
export function defaultRunner(cmd: string, args: string[], timeoutMs: number = 15_000): CommandOutcome {
  const res = spawnSync(cmd, args, {encoding: 'utf8', timeout: timeoutMs, maxBuffer: 1024 * 1024})
  // spawnSync does not throw on a missing binary: the error (e.g. `spawn cyi ENOENT`) is in `res.error`, status null.
  const stderr = res.error ? `${res.error.message}\n${res.stderr ?? ''}`.trim() : res.stderr ?? ''
  return {status: res.status, stdout: res.stdout ?? '', stderr}
}

/** Real filesystem probes for the local guidance (node:fs). Every I/O is best-effort → error = missing. */
export function defaultGuidanceFs(): GuidanceFs {
  return {
    read(file) {
      try {
        return fs.readFileSync(file, 'utf8')
      } catch {
        return null
      }
    },
    isRepoRoot(dir) {
      try {
        // `.git` can be a directory (checkout) or a file (worktree gitdir link): `existsSync` covers both.
        return fs.existsSync(path.join(dir, '.git'))
      } catch {
        return false
      }
    },
  }
}

/**
 * The real Knowledge probe: `cyi kb search <query> -p <project> --json` (read-only, argv array = no
 * shell). exit 0 → tolerant parse of the output; any other outcome (network/HTTP/permissions/missing cyi) →
 * `ok:false` with the reason from the command (best-effort, the caller degrades without blocking). It exposes ONLY the search.
 */
export function defaultKbProbe(run: CommandRunner = defaultRunner): KbProbe {
  return {
    search({query, project}) {
      const outcome = run('cyi', ['kb', 'search', query, '-p', project, '--json'])
      if (outcome.status !== 0) {
        const reason = outcome.stderr.trim() || outcome.stdout.trim() || `exit ${outcome.status}`
        return {ok: false, reason}
      }

      return {ok: true, pages: parseKbSearchJson(outcome.stdout)}
    },
  }
}
