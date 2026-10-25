import {spawnSync} from 'node:child_process'
import {createHash} from 'node:crypto'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import {z} from 'zod'
import {isSafeSegment} from './workspace'
import {agentHostTokenRegex, closeYourItTokenRegex, CREDENTIAL_SECRET_PATTERNS, type SecretPattern} from './secret-redaction'
import {remoteCommandError} from './delivery-errors'
import {AutomatorError, ErrorCodes} from '../errors/error-codes'

// Publication of the versioned documentation in the CloseYourIt Knowledge (CYAU-27). It is the WRITE counterpart
// of guidance.ts (CYAU-26, which READS the Knowledge read-only): when a run produces or
// updates canonical documentation and passes review and quality gate, the corresponding Knowledge page is
// created or updated from the VERSIONED FILE (Scenario 1 + DoD "the page derives from a versioned file").
//
// It follows knowledge-publishing.md, with four invariants:
//  - FILE-FIRST: the page body always derives from the content of a (verified) git-tracked file → the
//    page is the "consultable copy" of a versioned source of truth. It is also the primary anti-secret defence:
//    secret files are gitignored, hence not tracked → not publishable.
//  - ATOMIC PUBLICATION → IDEMPOTENCY: a deterministic publication_key identifies project+canonical source;
//    the server performs create/update/adoption with a single `cyi kb publish`, safe even across concurrent workers.
//  - NEVER DELETE: the `KbPublisher` probe exposes ONLY publish. "Forbidding delete" is a STRUCTURAL
//    property (like "no merge" in deliver.ts): no method exists that could delete a page.
//  - PROVENANCE METADATA: the published body carries an auditable footer (source file, commit, ticket, run)
//    → the publication is traceable to its versioned origin (DoD "auditable").
//
// The core is PURE and deterministic (body composition and publication key); the I/O
// (git/fs + `cyi kb`) lives behind two injectable probes — `PublishRepo` (local file + git) and `KbPublisher`
// (Knowledge) — so the orchestration is testable without filesystem, git or processes (like `deliver`/`guidance`).

// ── Knowledge page type ─────────────────────────────────────────────────────────────────────────────────────

/** The type of a Knowledge page, as per `cyi kb` (mapping in knowledge-publishing.md). */
export type KbKind = 'note' | 'decision' | 'guide'
export const KB_KINDS: readonly KbKind[] = ['note', 'decision', 'guide']
/** Default type: a durable note (the most common case). */
export const DEFAULT_KB_KIND: KbKind = 'note'

export function isKbKind(value: string): value is KbKind {
  return (KB_KINDS as readonly string[]).includes(value)
}

/** Helper: builds the invalid input error (exit 2), input defence. */
function invalidInput(message: string): AutomatorError {
  return new AutomatorError(ErrorCodes.Publish.invalidInput, message, 2)
}

/** Rejects a kind outside note|decision|guide (untrusted CLI input). Exit 2. */
export function assertKbKind(value: string): asserts value is KbKind {
  if (!isKbKind(value)) throw invalidInput(`Kind non valido: "${value}" (ammessi: ${KB_KINDS.join('|')})`)
}

// ── Input defence (the values end up in the argv of `cyi kb` or in the metadata) ────────────────────────────

/** The project key ends up in `cyi kb … -p <project>` → safe segment (like guidance/deliver). Exit 2. */
export function assertSafeProject(project: string): void {
  if (!isSafeSegment(project)) throw invalidInput(`Project-key non valida: "${project}"`)
}

/** The ticket code ends up in the provenance footer → safe segment. Exit 2. */
export function assertSafeTicket(ticket: string): void {
  if (!isSafeSegment(ticket)) throw invalidInput(`Codice ticket non valido: "${ticket}"`)
}

/** The run-id (metadata) ends up in the provenance footer → safe segment. Exit 2. */
export function assertSafeRunId(runId: string): void {
  if (!isSafeSegment(runId)) throw invalidInput(`Run-id non valido: "${runId}"`)
}

// ── Anti-secret defence (defence in depth on top of "versioned files only") ────────────────────────────────────

export type {SecretPattern}

/**
 * HIGH-confidence secret patterns (mirror of the command-policy keyword-match style). They look for real
 * VALUES (length/entropy), not the mere references to a token's FORMAT — so the security pages
 * that quote `cyi_a_…` or `ghp_` as an example are NOT blocked (no false positive on legitimate docs).
 * The cloud credential shapes and session tokens (PEM/AWS/Google/Slack/JWT) are defined ONCE in
 * `secret-redaction.ts` (CYAU-113) and shared with the log redaction, so the two lists do not diverge.
 */
export const SECRET_PATTERNS: readonly SecretPattern[] = [
  {name: 'GitHub personal access token', regex: /\bghp_[A-Za-z0-9]{36}\b/},
  {name: 'GitHub fine-grained token', regex: /\bgithub_pat_[A-Za-z0-9_]{50,}\b/},
  {name: 'token CloseYourIt', regex: agentHostTokenRegex()},
  {name: 'token CloseYourIt', regex: closeYourItTokenRegex(24)},
  {name: 'chiave API generica (sk-)', regex: /\bsk-[A-Za-z0-9]{32,}\b/},
  ...CREDENTIAL_SECRET_PATTERNS,
]

/** Returns the NAMES of the secret patterns found in the content (empty = clean). Pure, inspectable. */
export function scanForSecrets(content: string): string[] {
  const hits: string[] = []
  for (const p of SECRET_PATTERNS) {
    if (p.regex.test(content) && !hits.includes(p.name)) hits.push(p.name)
  }
  return hits
}

// ── Body composition (pure, deterministic) ──────────────────────────────────────────────────────────────

/** Marker opening the provenance footer: makes the block recognisable (audit/future maintenance). */
export const PROVENANCE_MARKER = '<!-- automator:knowledge-provenance -->'

/** The page's provenance metadata: its versioned origin (DoD "auditable"). */
export interface PublishMetadata {
  sourceFile: string
  commit: string | null
  ticket: string
  runId: string | null
}

/**
 * Composes the Knowledge page body: the content of the versioned file + a provenance footer with the
 * metadata (source, commit, ticket, run). Deterministic (same input → byte-identical) and without dependencies on
 * time/randomness. The footer makes every page traceable to its versioned origin.
 */
export function composePublishBody(content: string, meta: PublishMetadata): string {
  const commit = meta.commit && meta.commit.trim() !== '' ? `\`${meta.commit.trim()}\`` : '_non disponibile_'
  const runId = meta.runId && meta.runId.trim() !== '' ? `\`${meta.runId.trim()}\`` : '_non disponibile_'
  return [
    content.trimEnd(),
    '',
    PROVENANCE_MARKER,
    '---',
    '> Pagina sincronizzata da Automator dalla documentazione **versionata** del repository: la fonte di verità è il file sorgente, questa ne è la copia consultabile nella Knowledge.',
    '>',
    `> - Fonte: \`${meta.sourceFile}\``,
    `> - Commit: ${commit}`,
    `> - Ticket: \`${meta.ticket}\``,
    `> - Run: ${runId}`,
    '',
  ].join('\n')
}

// ── Injectable probes (isolated I/O) ───────────────────────────────────────────────────────────────────────────

/** Probes on the local repository: file read, "versioned" check (git-tracked), HEAD commit. */
export interface PublishRepo {
  /**
   * Reads the source file content (relative path resolved against `cwd`, NOT the process cwd →
   * consistent with `isTracked`, which uses `git -C cwd`), or null if missing/unreadable (best-effort).
   */
  read(args: {cwd: string; file: string; commit?: string | null}): string | null
  /** true if the path is an exact regular blob in the selected commit (check of the DoD "versioned file"). */
  isTracked(args: {cwd: string; file: string; commit?: string | null}): boolean
  /** Resolves HEAD or an explicit revision to a full immutable commit, or null if not resolvable. */
  headCommit(cwd: string, revision?: string | null): string | null
}

/**
 * WRITE probe of the Knowledge. It exposes ONLY the atomic publication: no separate list/create/update and
 * no delete. The server decides create/update/adoption through the stable publication_key.
 */
export interface KbPublisher {
  publish(args: {
    project: string
    publicationKey: string
    title: string
    kind: KbKind
    body: string
  }): {id: string; action: 'create' | 'update'; adoptedLegacy: boolean}
}

/** Handles an ephemeral body file: the content never enters the argv or the process listing. */
export interface PublishBodyFiles {
  use<T>(body: string, callback: (file: string) => T): T
}

// ── Publication plan (pure + PublishRepo, read-only) ────────────────────────────────────────────────────

export interface PublishInput {
  project: string
  title: string
  kind: KbKind
  /** Path of the versioned source file (relative to the worktree or absolute inside the repo). */
  sourceFile: string
  /** Worktree on which to check git (tracked + HEAD). */
  cwd: string
  ticket: string
  runId?: string | null
  /** Explicit source commit; missing → HEAD. It is resolved and used both for the blob and for the provenance. */
  commit?: string | null
}

function assertSafeCommit(commit: string): void {
  if (!/^(?:[0-9a-fA-F]{7,64})$/.test(commit)) throw invalidInput('Commit di provenienza non valido')
}

export interface PublishPlan {
  project: string
  title: string
  kind: KbKind
  sourceFile: string
  cwd: string
  ticket: string
  runId: string | null
  commit: string | null
  /** Stable server-side identity of project + canonical source. */
  publicationKey: string
  /** The body ready for the Knowledge: versioned file content + provenance footer. */
  body: string
}

/** POSIX path relative to the worktree, without `.`/`..`; workers in different checkouts get the same source. */
export function canonicalSourceFile(cwd: string, sourceFile: string): string {
  if (sourceFile.trim() === '') throw invalidInput('File sorgente vuoto')
  const root = path.resolve(cwd)
  const absolute = path.resolve(root, sourceFile)
  const relative = path.relative(root, absolute)
  if (relative === '' || relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
    throw invalidInput(`File sorgente fuori dal worktree: ${sourceFile}`)
  }
  return relative.split(path.sep).join('/')
}

/** Opaque, URI-safe key: contains only version + SHA-256 of the normalized project and canonical source. */
export function publicationKeyFor(project: string, canonicalSource: string): string {
  const identity = `${project.trim().toLowerCase()}\n${canonicalSource}`
  return `automator:knowledge:v1:${createHash('sha256').update(identity, 'utf8').digest('hex')}`
}

/**
 * File names that, by policy, must be neither read nor published even if accidentally tracked.
 * The check is intentionally based on the name/path, before any I/O on the content.
 */
export function isSensitiveSourceFile(sourceFile: string): boolean {
  const segments = sourceFile.toLowerCase().split('/')
  const basename = segments.at(-1) ?? ''
  if (basename === '.env' || basename.startsWith('.env.')) return true
  if (/^id_(?:rsa|dsa|ecdsa|ed25519)(?:\.[^.]+)?$/.test(basename)) return true
  if (/^(?:credentials?|secrets?)(?:\.(?:json|ya?ml))?$/.test(basename)) return true
  return /\.(?:key|pem|p12|pfx)$/.test(basename)
}

/**
 * Validates the input, checks the gates (non-sensitive path → versioned → readable file → no secrets) and composes the body. Read-only:
 * it does not touch the Knowledge (also used by `--dry-run`). Order: first the input defences (never I/O on hostile
 * input), then path policy and "is it versioned?" (both without reading), then a read confined to the worktree and
 * finally "no secrets?" (defence in depth).
 */
export function planPublish(input: PublishInput, repo: PublishRepo): PublishPlan {
  assertSafeProject(input.project)
  assertSafeTicket(input.ticket)
  const runId = input.runId ?? null
  if (runId !== null) assertSafeRunId(runId)
  if (input.title.trim() === '') throw invalidInput('Titolo pagina vuoto')

  const sourceFile = canonicalSourceFile(input.cwd, input.sourceFile)
  if (isSensitiveSourceFile(sourceFile)) {
    throw new AutomatorError(
      ErrorCodes.Publish.secretDetected,
      `Il file "${sourceFile}" è un percorso sensibile e non può essere letto o pubblicato nella Knowledge`,
      3,
    )
  }

  if (input.commit !== undefined && input.commit !== null) assertSafeCommit(input.commit)
  // Resolves HEAD or the explicit override once: gate, body and provenance must use the same immutable commit.
  const observedCommit = repo.headCommit(input.cwd, input.commit ?? null)
  if (observedCommit === null) throw invalidInput('Commit sorgente non risolvibile')

  // DoD: the page derives from a regular file present EXACTLY in the selected commit. The mutable index does not
  // take part in the gate: staged add/delete and concurrent changes cannot make gate and published blob diverge.
  if (!repo.isTracked({cwd: input.cwd, file: sourceFile, commit: observedCommit})) {
    throw new AutomatorError(
      ErrorCodes.Publish.notVersioned,
      `Il file "${sourceFile}" non è un file regolare nel commit selezionato: committalo prima di pubblicarlo nella Knowledge`,
      3,
    )
  }

  const content = repo.read({cwd: input.cwd, file: sourceFile, commit: observedCommit})
  if (content === null) throw invalidInput(`File sorgente illeggibile o fuori dal worktree: ${sourceFile}`)

  const commit = observedCommit
  const body = composePublishBody(content, {sourceFile, commit, ticket: input.ticket, runId})

  // Defence in depth on the FINAL payload: besides the versioned blob it includes project, title and composed
  // provenance (source path, commit, ticket, run). No metadata destined for the Knowledge or the argv can
  // bypass the gate.
  const secrets = scanForSecrets(`${input.project}\n${input.title}\n${body}`)
  if (secrets.length > 0) {
    throw new AutomatorError(
      ErrorCodes.Publish.secretDetected,
      `Il contenuto contiene possibili secret (${secrets.join(', ')}): non lo pubblico nella Knowledge`,
      3,
    )
  }

  return {
    project: input.project,
    title: input.title,
    kind: input.kind,
    sourceFile,
    cwd: input.cwd,
    ticket: input.ticket,
    runId,
    commit,
    publicationKey: publicationKeyFor(input.project, sourceFile),
    body,
  }
}

// ── Auditable record and orchestration ────────────────────────────────────────────────────────────────────────

export const PublishResultSchema = z
  .object({
    project: z.string(),
    title: z.string(),
    kind: z.enum(['note', 'decision', 'guide']),
    /** The action actually performed: idempotent (update if the page already existed). */
    action: z.enum(['create', 'update']),
    pageId: z.string(),
    publicationKey: z.string(),
    adoptedLegacy: z.boolean(),
    sourceFile: z.string(),
    commit: z.string().nullable(),
    ticket: z.string(),
    runId: z.string().nullable(),
    reasons: z.array(z.string()),
  })
  .strict()
export type PublishResult = z.infer<typeof PublishResultSchema>

/**
 * Orchestrates the idempotent publication behind the probes: (1) plan (validations + gate + body + key);
 * (2) a single atomic server-side publish. Retry and concurrency converge because the key does not depend on
 * content/commit/ticket/run. If a gate
 * fails (unversioned file / secret) the Knowledge is NOT touched (the exception precedes every KB call).
 * Returns an auditable record.
 */
export function runPublish(input: PublishInput, repo: PublishRepo, kb: KbPublisher): PublishResult {
  const plan = planPublish(input, repo)
  const published = kb.publish({
    project: plan.project,
    publicationKey: plan.publicationKey,
    title: plan.title,
    kind: plan.kind,
    body: plan.body,
  })
  const reasons: string[] = [
    published.action === 'create'
      ? `Pubblicazione «${plan.title}» creata server-side (id ${published.id})`
      : published.adoptedLegacy
        ? `Pagina legacy «${plan.title}» adottata e aggiornata server-side (id ${published.id})`
        : `Pubblicazione «${plan.title}» aggiornata server-side (id ${published.id})`,
  ]

  reasons.push(`Fonte: ${plan.sourceFile}${plan.commit ? ` @ ${plan.commit}` : ''} · ticket ${plan.ticket}`)

  return PublishResultSchema.parse({
    project: plan.project,
    title: plan.title,
    kind: plan.kind,
    action: published.action,
    pageId: published.id,
    publicationKey: plan.publicationKey,
    adoptedLegacy: published.adoptedLegacy,
    sourceFile: plan.sourceFile,
    commit: plan.commit,
    ticket: plan.ticket,
    runId: plan.runId,
    reasons,
  })
}

// ── Strict parsing of the atomic `cyi kb publish` output (untrusted input, fail-closed) ─────────────────────

const RawKbPublishResponseSchema = z
  .object({
    data: z.object({id: z.string().min(1)}).passthrough(),
    meta: z
      .object({operation: z.enum(['created', 'updated']), adopted_legacy: z.boolean()})
      .passthrough(),
  })
  .passthrough()

export function parseKbPublishResponse(
  raw: string,
): {id: string; action: 'create' | 'update'; adoptedLegacy: boolean} | null {
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    return null
  }

  const result = RawKbPublishResponseSchema.safeParse(parsed)
  if (!result.success) return null
  return {
    id: result.data.data.id,
    action: result.data.meta.operation === 'created' ? 'create' : 'update',
    adoptedLegacy: result.data.meta.adopted_legacy,
  }
}

// ── Real probes (fs/git + `cyi kb` behind an injectable CommandRunner) ────────────────────────────────────────

export interface CommandOutcome {
  status: number | null
  stdout: string
  stderr: string
}

/** Runs an external command and returns its outcome (injectable: default `spawnSync`, argv array = no shell). */
export type CommandRunner = (cmd: string, args: string[]) => CommandOutcome

export function defaultRunner(cmd: string, args: string[]): CommandOutcome {
  const res = spawnSync(cmd, args, {encoding: 'utf8', timeout: 15_000, killSignal: 'SIGTERM'})
  // spawnSync does NOT throw on a missing binary: the error (e.g. `spawn cyi ENOENT`) is in `res.error`, status null.
  const stderr = res.error ? `${res.error.message}\n${res.stderr ?? ''}`.trim() : res.stderr ?? ''
  return {status: res.status, stdout: res.stdout ?? '', stderr}
}

/** Extracts a single regular blob from the NUL-delimited response of `git ls-tree -z`. Symlinks and ambiguous shapes fail. */
function parseTreeBlob(raw: string, expectedFile: string): string | null {
  const entries = raw.split('\0').filter((entry) => entry !== '')
  if (entries.length !== 1) return null
  const tab = entries[0].indexOf('\t')
  if (tab < 0 || entries[0].slice(tab + 1) !== expectedFile) return null
  const [mode, type, oid, ...extra] = entries[0].slice(0, tab).split(' ')
  if (extra.length > 0 || (mode !== '100644' && mode !== '100755') || type !== 'blob') return null
  return /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/.test(oid) ? oid : null
}

function treeBlobOid(run: CommandRunner, cwd: string, commit: string | null | undefined, file: string): string | null {
  if (!commit || !/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/.test(commit)) return null
  const tree = run('git', [
    '-C', cwd, '--literal-pathspecs', 'ls-tree', '-rz', '--full-tree', commit, '--', file,
  ])
  return tree.status === 0 ? parseTreeBlob(tree.stdout, file) : null
}

/**
 * Real repository probes. The body is never read from the mutable checkout: `ls-tree` resolves path and mode
 * in the already observed HEAD commit and `cat-file` reads the immutable blob. Static symlinks and races on any
 * pathname component therefore cannot divert the read to external or sensitive files.
 */
export function defaultPublishRepo(run: CommandRunner = defaultRunner): PublishRepo {
  return {
    read({cwd, file, commit}) {
      const oid = treeBlobOid(run, cwd, commit, file)
      if (!oid) return null
      const blob = run('git', ['-C', cwd, 'cat-file', 'blob', oid])
      return blob.status === 0 ? blob.stdout : null
    },
    isTracked({cwd, file, commit}) {
      const selected = commit ?? this.headCommit(cwd)
      return treeBlobOid(run, cwd, selected, file) !== null
    },
    headCommit(cwd, revision) {
      const requested = revision ?? 'HEAD'
      const outcome = run('git', ['-C', cwd, 'rev-parse', '--verify', '--end-of-options', `${requested}^{commit}`])
      if (outcome.status !== 0) return null
      const sha = outcome.stdout.trim()
      return /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/.test(sha) ? sha : null
    },
  }
}

/** Private, ephemeral body file; cleanup guaranteed even when the `cyi` process fails. */
export function defaultPublishBodyFiles(): PublishBodyFiles {
  return {
    use(body, callback) {
      const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'closeyourit-automator-publish-'))
      const file = path.join(directory, 'body.md')
      try {
        fs.writeFileSync(file, body, {encoding: 'utf8', mode: 0o600})
        fs.chmodSync(file, 0o600)
        return callback(file)
      } finally {
        fs.rmSync(directory, {recursive: true, force: true})
      }
    },
  }
}

function parseCyiError(raw: string): {code: string} | null {
  try {
    const parsed = z
      .object({
        error: z.object({
          code: z.string().min(5).max(96).regex(/^[A-Z][0-9]{3}-[A-Z0-9]+(?:-[A-Z0-9]+)*$/),
        }).passthrough(),
      })
      .passthrough()
      .safeParse(JSON.parse(raw))
    return parsed.success ? parsed.data.error : null
  } catch {
    return null
  }
}

/**
 * The real Knowledge probe: a single `cyi kb publish --body-file … --json` (argv array = no shell).
 * NO list/create/update/delete: atomicity and legacy adoption belong to the server. The backend's JSON error codes
 * stay visible without echoing arbitrary output (which could contain the body).
 */
export function defaultKbPublisher(
  run: CommandRunner = defaultRunner,
  bodyFiles: PublishBodyFiles = defaultPublishBodyFiles(),
): KbPublisher {
  return {
    publish({project, publicationKey, title, kind, body}) {
      return bodyFiles.use(body, (bodyFile) => {
        const outcome = run('cyi', [
          'kb',
          'publish',
          '-p',
          project,
          '--publication-key',
          publicationKey,
          '--title',
          title,
          '--kind',
          kind,
          '--body-file',
          bodyFile,
          '--json',
        ])
        if (outcome.status !== 0) {
          // With `--json` CYCL-8 emits the authoritative envelope on stdout; stderr is only a compatibility fallback.
          // We extract only an error.code with constrained shape and length, never arbitrary message/body.
          const error = parseCyiError(outcome.stdout) ?? parseCyiError(outcome.stderr)
          // The remote process's message is not reliable: it could reflect parts of the payload/body.
          const detail = error ? error.code : `exit ${outcome.status ?? 'unknown'}`
          throw remoteCommandError(
            ErrorCodes.Publish.commandFailed,
            `cyi kb publish fallito: ${detail}`,
            outcome,
          )
        }
        const parsed = parseKbPublishResponse(outcome.stdout)
        if (parsed === null) {
          throw new AutomatorError(ErrorCodes.Publish.invalidResponse, 'cyi kb publish: risposta JSON non valida', 1)
        }
        return parsed
      })
    },
  }
}
