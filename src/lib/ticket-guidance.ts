import {type CommandRunner, defaultRunner, parseKbSearchJson} from './guidance'

// Structured guidance from the ticket detail (CYAU-1). Before the clarity gate and the claim, the worker must
// consume the resolved CONVENTIONS the backend attaches to the ticket: references (documents to consult),
// procedures (to apply according to `application_mode`) and rules (indications to follow). The shape is the one already
// defined by the `closeyourit-cli` client (CYCL-2): `guidance = {references, procedures}` with uniform entries
// {key, origin, level, required, application_mode}; the automator adds the additive `rules` list (Scenario
// 3, "rules as data") with the SAME shape. The contract is deliberately loose (extra fields allowed): the
// hierarchy is already resolved SERVER-side, the worker renders the values VERBATIM without special logic for single
// keys — no hardcoding for TDD/KB/Advenias (Scenario 3, "no special condition in the code").
//
// The core is PURE and deterministic (parse/compose/select); the CONSULTATION of a reference (the channel through which
// its content is accessed) lives behind the injectable `ReferenceProbe` — read-only by construction,
// like guidance.ts's `KbProbe`: it exposes ONLY `consult`, no method that mutates the Knowledge. A required
// reference that cannot be consulted is FAIL-CLOSED (DoD "inaccessible required produces a clean stop"): better to stop
// and report than to proceed without the required convention.

/** The `application_mode` values attested in the CLI contract; the field stays a free string anyway (additive). */
export const GUIDANCE_APPLICATION_MODES = ['always', 'on_demand'] as const

/**
 * A guidance entry (reference/procedure/rule), uniform shape of the CYCL-2 contract. The five known fields
 * are normalized (snake_case wire → internal camelCase); extra fields are preserved verbatim (loose
 * `Record`), so an attribute added by the backend is neither lost nor requires a client change.
 */
export interface GuidanceEntry {
  key?: string
  origin?: string
  level?: string
  required?: boolean
  applicationMode?: string
  [extra: string]: unknown
}

/** The ticket's structured guidance: three independent lists of uniform entries. */
export interface TicketGuidance {
  references: GuidanceEntry[]
  procedures: GuidanceEntry[]
  rules: GuidanceEntry[]
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

// A reference `key` is a Knowledge path/slug (`global/git.md`, `advenias-care-md-docs`): it allows
// alphanumerics, `.`, `/`, `-`, `_`, but MUST start with an alphanumeric. Input defence: the key ends up
// in the argv of `cyi kb` → a key with a leading `-` would be interpreted as a CLI option (option injection), and
// `..` would open traversal. A non-conforming key is rejected (not safely consultable → fail-closed).
const SAFE_REFERENCE_KEY = /^[A-Za-z0-9][A-Za-z0-9._/-]*$/

/** true if the reference key is safe to pass as an argument to `cyi kb` (no option injection, no traversal). */
export function isSafeReferenceKey(key: string): boolean {
  return SAFE_REFERENCE_KEY.test(key) && !key.includes('..')
}

/** Normalizes a raw entry: the five known fields typed, the rest preserved verbatim. */
function normalizeEntry(raw: Record<string, unknown>): GuidanceEntry {
  const {key, origin, level, required, application_mode: applicationMode, ...rest} = raw
  const entry: GuidanceEntry = {...rest}
  if (typeof key === 'string') entry.key = key
  if (typeof origin === 'string') entry.origin = origin
  if (typeof level === 'string') entry.level = level
  // Only the real boolean counts as required: a "true" string does not make a reference required (input
  // defence, fail-closed on doubt → we do not treat an ambiguous entry as required by mistake).
  if (typeof required === 'boolean') entry.required = required
  if (typeof applicationMode === 'string') entry.applicationMode = applicationMode
  return entry
}

/** Parses a list of raw entries, tolerantly: non-array → empty, non-object entries discarded one by one. */
function parseEntries(raw: unknown): GuidanceEntry[] {
  if (!Array.isArray(raw)) return []
  const out: GuidanceEntry[] = []
  for (const item of raw) if (isRecord(item)) out.push(normalizeEntry(item))
  return out
}

/**
 * Defensive parser of the guidance from the ticket detail (UNTRUSTED input: it comes from the server). Tolerant like
 * `parseKbSearchJson`: unexpected shape → nothing, malformed entries discarded without dropping the valid ones. If there is
 * NO useful entry it returns `null` (guidance missing) → backward compat: a legacy server that does not attach the
 * guidance does not change the worker's behaviour.
 */
export function parseTicketGuidance(raw: unknown): TicketGuidance | null {
  if (!isRecord(raw)) return null
  const references = parseEntries(raw.references)
  const procedures = parseEntries(raw.procedures)
  const rules = parseEntries(raw.rules)
  if (references.length === 0 && procedures.length === 0 && rules.length === 0) return null
  return {references, procedures, rules}
}

const KNOWN_ENTRY_FIELDS = new Set(['key', 'origin', 'level', 'required', 'applicationMode'])

/** Renders an entry as a readable markdown line: key + metadata (required/mode/origin/level + extra). */
function renderEntry(entry: GuidanceEntry): string {
  const meta: string[] = []
  if (entry.required === true) meta.push('obbligatoria')
  if (entry.applicationMode) meta.push(entry.applicationMode)
  if (entry.origin) meta.push(entry.origin)
  if (entry.level) meta.push(entry.level)
  for (const [field, value] of Object.entries(entry)) {
    if (KNOWN_ENTRY_FIELDS.has(field) || value === null || value === undefined) continue
    meta.push(`${field}=${typeof value === 'object' ? JSON.stringify(value) : String(value)}`)
  }
  const label = entry.key && entry.key.trim() !== '' ? entry.key : '(senza chiave)'
  return meta.length > 0 ? `- ${label} — ${meta.join(' · ')}` : `- ${label}`
}

function section(lines: string[], title: string, entries: GuidanceEntry[]): void {
  if (entries.length === 0) return
  lines.push('', `### ${title}`, '')
  for (const entry of entries) lines.push(renderEntry(entry))
}

/** Adaptive markdown fence for a content (like guidance.ts): lengthens the backticks if the body already contains some. */
function fenceContent(content: string): string[] {
  const ticks = content.includes('```') ? '````' : '```'
  return [ticks, content.trimEnd(), ticks]
}

/**
 * Composes the structured guidance in markdown for the agent's context. Renders the entries VERBATIM as data
 * (Scenario 3): no interpretation of single keys. If the CONTENTS of the already consulted required references
 * are provided (`consulted`), it includes them in full — so the agent receives the reference's text,
 * not just its pointer (Scenario 2 "consults it before tests or code"). Deterministic
 * (no time/randomness, backend order preserved); only the non-empty sections appear.
 */
export function composeTicketGuidanceMarkdown(guidance: TicketGuidance, consulted: ConsultedReference[] = []): string {
  const lines: string[] = [
    '## Guidance del progetto (dal ticket)',
    'Convenzioni già risolte dal backend, da applicare secondo application_mode. Sono INDICAZIONI: verifica sempre sul codice.',
  ]
  section(lines, 'Procedure', guidance.procedures)
  section(lines, 'Reference', guidance.references)
  section(lines, 'Regole', guidance.rules)
  const withContent = consulted.filter((ref) => typeof ref.content === 'string' && ref.content.trim() !== '')
  if (withContent.length > 0) {
    lines.push('', '### Contenuto delle reference obbligatorie consultate', '')
    for (const ref of withContent) {
      lines.push(`#### ${ref.title && ref.title.trim() !== '' ? ref.title : ref.key}`, '', ...fenceContent(ref.content ?? ''), '')
    }
  }
  return lines.join('\n')
}

/** The REQUIRED references (required === true): those to consult before the claim (Scenario 2). */
export function requiredReferences(guidance: TicketGuidance): GuidanceEntry[] {
  return guidance.references.filter((reference) => reference.required === true)
}

/** Outcome of consulting a reference: accessible (with the content) or not (with the reason). Read-only. */
export interface ReferenceConsultation {
  accessible: boolean
  reason?: string
  title?: string
  content?: string
}

/**
 * Probe to consult a reference's content. Read-only by construction (it exposes ONLY `consult`): there is no
 * method that mutates the Knowledge. Injectable: mocked in tests, real `cyi kb` in production.
 */
export interface ReferenceProbe {
  consult(args: {key: string; project: string}): ReferenceConsultation
}

/** A required reference consulted successfully: its key and the retrieved content/title. */
export interface ConsultedReference {
  key: string
  title?: string
  content?: string
}

/** Report of the pre-claim check: the consulted references (with the content) and the inaccessible ones (with the reason). */
export interface RequiredReferenceReport {
  consulted: ConsultedReference[]
  inaccessible: Array<{key: string; reason: string}>
}

/**
 * Checks that every REQUIRED reference is consultable BEFORE the claim (Scenario 2), retrieving its
 * content. A required one without a key, or with a key unsafe for the `cyi kb` argv, is inaccessible by
 * construction → fail-closed. Non-required references are NOT consulted here: they stay available
 * to the agent (application_mode on_demand). The `project` always travels to the probe to enforce the scope.
 */
export function consultRequiredReferences(
  guidance: TicketGuidance,
  project: string,
  probe: ReferenceProbe,
): RequiredReferenceReport {
  const consulted: ConsultedReference[] = []
  const inaccessible: Array<{key: string; reason: string}> = []
  for (const reference of guidance.references) {
    if (reference.required !== true) continue
    const key = typeof reference.key === 'string' ? reference.key.trim() : ''
    if (key === '') {
      inaccessible.push({key: '(senza chiave)', reason: 'reference obbligatoria senza chiave: non consultabile'})
      continue
    }
    if (!isSafeReferenceKey(key)) {
      inaccessible.push({key, reason: 'chiave della reference non valida: non consultabile in sicurezza'})
      continue
    }
    const outcome = probe.consult({key, project})
    if (outcome.accessible) consulted.push({key, title: outcome.title, content: outcome.content})
    else inaccessible.push({key, reason: outcome.reason ?? 'non consultabile'})
  }
  return {consulted, inaccessible}
}

/** Hidden marker of the block comment for an inaccessible reference: makes the comment IDEMPOTENT (no spam). */
export const REFERENCE_BLOCKED_MARKER = '<!-- automator:reference-blocked:v1 -->'

/**
 * Character cap of a comment, enforced by the server (`App::Constants::COMMENT_MAX_CHARS`, CYRA-222): beyond
 * this threshold `cyi tickets comment` answers 422 and the publication fails. A comment is a short message,
 * not a document — long text has its own place (the run report).
 */
const COMMENT_MAX_CHARS = 240

const STOP_INTRO = 'Lavorazione sospesa: documenti indispensabili non consultabili —'
const STOP_OUTRO = 'Rendeteli disponibili e la lavorazione riprende.'

/**
 * Comment (customer-friendly, without technical jargon) to post on the ticket when a required reference cannot be
 * consulted: it explains the block in an understandable way and asks to make the documents available (DoD "comments
 * and stops without claim"). At the end it carries the hidden marker for idempotency (`hasReferenceStopComment`).
 *
 * It ALWAYS stays under the server cap: the two fixed sentences plus the marker take a known share and the list of
 * keys consumes only what remains — beyond that point it becomes "+N more". Before CYRA-221 the body started at
 * ~310 characters BEFORE the list: with the cap active every publication would have been rejected, and this is
 * the only channel through which the preflight says why it stopped.
 */
export function composeReferenceStopComment(inaccessible: Array<{key: string; reason: string}>): string {
  const overhead = STOP_INTRO.length + STOP_OUTRO.length + REFERENCE_BLOCKED_MARKER.length + 4
  const budget = COMMENT_MAX_CHARS - overhead

  const keys = inaccessible.map((entry) => entry.key).filter((key) => key.length > 0)
  const shown: string[] = []
  let used = 0
  for (const key of keys) {
    // The placeholder for the omitted ones must fit too: the worst-case space is reserved before accepting.
    const omittedHint = keys.length - shown.length - 1
    const reserve = omittedHint > 0 ? `, +${omittedHint} altri`.length : 0
    const cost = (shown.length === 0 ? 0 : 2) + key.length
    if (used + cost + reserve > budget) break
    shown.push(key)
    used += cost
  }

  const omitted = keys.length - shown.length
  const list = shown.length === 0
    ? `${keys.length} documenti`
    : `${shown.join(', ')}${omitted > 0 ? `, +${omitted} altri` : ''}`

  return `${STOP_INTRO} ${list}. ${STOP_OUTRO}\n${REFERENCE_BLOCKED_MARKER}`
}

/** true if the ticket ALREADY has a reference block comment (marker present): avoids republishing it at every preflight. */
export function hasReferenceStopComment(comments: ReadonlyArray<{body?: string | null}>): boolean {
  return comments.some((comment) => typeof comment.body === 'string' && comment.body.includes(REFERENCE_BLOCKED_MARKER))
}

/**
 * Real read-only probe: `cyi kb search <key> -p <project> --json`. The search is the channel that (a) accepts any
 * string as a query — not only a page id like `cyi kb show` — (b) filters by project (scope), (c)
 * returns the pages' body (the content to bring to the agent). As defence in depth on top of the server-side
 * scope, it discards the pages of a different project. ≥1 page → accessible with the content; 0 pages or error
 * (permissions/network/missing cyi) → inaccessible with the reason. Argv array (no shell); the key is validated upstream
 * (`isSafeReferenceKey`) against option injection. ⚠️ cli/server dependency: the precise mapping of a
 * reference `key` to a Knowledge page is on the backend side; while it is approximated by the search, a required
 * reference not found blocks fail-closed — exactly the DoD.
 */
export function defaultReferenceProbe(run: CommandRunner = defaultRunner): ReferenceProbe {
  return {
    consult({key, project}) {
      const outcome = run('cyi', ['kb', 'search', key, '-p', project, '--json'])
      if (outcome.status !== 0) {
        const reason = outcome.stderr.trim() || outcome.stdout.trim() || `exit ${outcome.status}`
        return {accessible: false, reason}
      }
      const pages = parseKbSearchJson(outcome.stdout).filter(
        (page) => !page.project || page.project.toLowerCase() === project.toLowerCase(),
      )
      if (pages.length === 0) return {accessible: false, reason: 'nessuna pagina Knowledge consultabile per la reference'}
      return {accessible: true, title: pages[0].title, content: pages.map((page) => page.body).join('\n\n')}
    },
  }
}
