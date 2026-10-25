import {spawnSync} from 'node:child_process'
import {z} from 'zod'
import {type AgentRunResult} from './agent-result'
import {type CyiStatus} from './state-machine'
import {isSafeSegment} from './workspace'
import {redactSecrets} from './secret-redaction'
import {remoteCommandError} from './delivery-errors'
import {GitHubPrUrlSchema, isGitHubPrUrl} from './github-pr-url'
import {AutomatorError, ErrorCodes} from '../errors/error-codes'

// Uniform delivery of the run for human review (CYAU-24). When the work passes implementation,
// tests and cross review — i.e. when all automatic gates are green — the workflow always delivers it
// the same way: it pushes the ALLOWED branch (only `ticket/*`, consistent with the guard-branch-push guardrail),
// opens the PR with `gh` NON-interactively, links ticket ↔ PR (bidirectional link) and moves the ticket to
// "In Review" with an IDEMPOTENT CYI transition. No initial automatic merge (the human gate stays).
//
// The core is PURE and deterministic:
//  - the GUARDS — `assertDeliverableBranch` (push only on ticket/*), `assertDeliverableTicket` (the ticket
//    ends up in the `cyi` argv → validated as a safe segment), `assertGatePassed` (do not deliver if the gates
//    are not green: Scenario 1 "Given all the automatic gates are green");
//  - the COMPOSITION — `composePrTitle`/`composePrBody` produce a PR that ALWAYS contains summary, tests and
//    risks (DoD), with placeholders on missing data, and mention the ticket (PR side of the bidirectional link).
// The real execution (push/PR/link/transition) lives behind the injectable `DeliveryProbe` probe — like
// `workspace`/`quality-gate` — so the orchestration is testable without processes. The probe exposes NO
// merge: "no automatic merge" is a STRUCTURAL property, not just a convention.
//
// Idempotency (DoD "idempotent CYI transition" + "the ticket stays In Review"): the actions repeatable WITHOUT
// side effects are first checked remotely and checkpointed after every step. A retry reuses the existing PR and
// comment and the transition to "In Review" stays an idempotent absolute set. The automator does not go further.

/** Prefix of the only deliverable branches: push is allowed only on `ticket/*` (guard-branch-push guardrail). */
export const DELIVERABLE_BRANCH_PREFIX = 'ticket/'
/** Default PR base (the repository's integration branch). */
export const DEFAULT_BASE_BRANCH = 'main'
/** Default remote to push to. */
export const DEFAULT_REMOTE = 'origin'

// ── Guards (pure) ──────────────────────────────────────────────────────────────────────────────────────────

/**
 * true if `branch` is deliverable: `ticket/<safe segment>` (a single segment, never `.`/`..`/separators/hostile
 * keys). Every other branch — main/master/develop/staging/production/release/hotfix, feature/* … — is excluded,
 * consistent with the guard-branch-push guardrail (which allows only the `ticket/…` branch). Pure.
 */
export function isDeliverableBranch(branch: string): boolean {
  if (!branch.startsWith(DELIVERABLE_BRANCH_PREFIX)) return false
  return isSafeSegment(branch.slice(DELIVERABLE_BRANCH_PREFIX.length))
}

/** Rejects a non-deliverable branch BEFORE any action: never push outside ticket/*. Exit 2. */
export function assertDeliverableBranch(branch: string): void {
  if (!isDeliverableBranch(branch)) {
    throw new AutomatorError(
      ErrorCodes.Deliver.invalidBranch,
      `Branch non consegnabile: "${branch}" — il push è consentito solo su ${DELIVERABLE_BRANCH_PREFIX}<ticket> (mai main/master/develop e simili)`,
      2,
    )
  }
}

/**
 * Rejects an unsafe ticket: the ticket code ends up in the `cyi` argv (comment + state transition)
 * and in the PR body → input defence (untrusted), as `workspace` validates its own segments. Exit 2.
 */
export function assertDeliverableTicket(ticket: string): void {
  if (!isSafeSegment(ticket)) {
    throw new AutomatorError(ErrorCodes.Deliver.invalidInput, `Codice ticket non valido: "${ticket}"`, 2)
  }
}

/** The PR base and the remote come from the trusted coordinator, but they stay runtime input: no option injection. */
export function assertSafeDeliveryRef(value: string, label: 'base' | 'remote'): void {
  const safeBranch = value !== '' && value === value.trim() && value.length <= 244 &&
    !value.startsWith('-') && !value.startsWith('/') && !value.endsWith('/') && !value.endsWith('.') &&
    !value.includes('..') && !value.includes('//') && !value.includes('@{') &&
    !/[\u0000-\u0020\u007f~^:?*[\\]/u.test(value) &&
    value.split('/').every((part) => part !== '.' && !part.endsWith('.lock'))
  if (label === 'remote' ? !isSafeSegment(value) : !safeBranch) {
    throw new AutomatorError(ErrorCodes.Deliver.invalidInput, `${label} di delivery non valida: "${value}"`, 2)
  }
}

/**
 * Rejects the delivery if the automatic gates are not green (Scenario 1: "Given all the automatic gates are
 * green"). Safe-by-default: without an explicit confirmation nothing is pushed. Dedicated exit 3 (like Gate.failed).
 */
export function assertGatePassed(gatePassed: boolean): void {
  if (!gatePassed) {
    throw new AutomatorError(
      ErrorCodes.Deliver.gateNotPassed,
      'I gate automatici non sono verdi: non consegno (nessun push, nessuna PR). Esegui e supera prima il quality gate',
      3,
    )
  }
}

// ── PR composition (pure) ────────────────────────────────────────────────────────────────────────────

/** Test outcome to show in the PR (the counts can be missing: nullable fields, like AgentRunResult). */
export interface PrTests {
  passed: number | null
  failed: number | null
  summary: string | null
}

/** The content that feeds the PR: what the DoD requires (summary, tests, risks) + the ticket reference. */
export interface PrContent {
  ticket: string
  summary: string | null
  tests: PrTests | null
  risks: string[]
  changedFiles?: string[]
}

/** Derives the PR content from the agent's uniform outcome (CYAU-6): summary, tests, risks, files. */
export function prContentFromResult(ticket: string, result: AgentRunResult): PrContent {
  return {
    ticket,
    summary: result.summary === null ? null : redactSecrets(result.summary),
    tests: {...result.tests, summary: result.tests.summary === null ? null : redactSecrets(result.tests.summary)},
    risks: result.risks.map((risk) => redactSecrets(risk)),
    changedFiles: result.changedFiles.map((file) => redactSecrets(file)),
  }
}

function firstLine(text: string): string {
  return text.split('\n')[0].trim()
}

/** PR title: an explicit override, otherwise `<ticket>: <first line of the summary>` (or a default). */
export function composePrTitle(content: Pick<PrContent, 'ticket' | 'summary'>, override?: string): string {
  const forced = override?.trim()
  if (forced) return forced
  const summary = content.summary?.trim()
  return summary ? `${content.ticket}: ${firstLine(summary)}` : `${content.ticket}: consegna per la review`
}

/** Formats the test outcome for the PR: counts + summary, with a placeholder when there is nothing. */
function formatTests(tests: PrTests | null): string {
  if (!tests || (tests.passed === null && tests.failed === null && !tests.summary?.trim())) {
    return 'Nessun esito di test riportato.'
  }

  const counts: string[] = []
  if (tests.passed !== null) counts.push(`${tests.passed} passati`)
  if (tests.failed !== null) counts.push(`${tests.failed} falliti`)
  const head = counts.join(', ')
  const summary = tests.summary?.trim() ?? ''
  if (head && summary) return `${head} — ${summary}`
  // After the initial guard at least one of head and summary is non-empty → the result is never empty.
  return head || summary
}

/**
 * Composes the PR markdown body. It ALWAYS contains the three DoD sections — summary, tests, risks — even
 * when the agent reported nothing (explicit placeholders): the PR is never "empty" of context. It closes
 * with a reference to the ticket, the PR→ticket side of the bidirectional link. Pure.
 */
export function composePrBody(content: PrContent): string {
  const lines: string[] = []
  lines.push('## Riepilogo', '', content.summary?.trim() || 'Nessun riepilogo fornito.', '')
  lines.push('## Test', '', formatTests(content.tests), '')
  lines.push('## Rischi', '')
  if (content.risks.length > 0) for (const risk of content.risks) lines.push(`- ${risk}`)
  else lines.push('Nessun rischio segnalato.')

  if (content.changedFiles && content.changedFiles.length > 0) {
    lines.push('', '## File modificati', '')
    for (const file of content.changedFiles) lines.push(`- \`${file}\``)
  }

  lines.push('', '---', `Ticket: ${content.ticket}`)
  return lines.join('\n')
}

/** The CYI state the delivery moves the ticket to: "In Review", never beyond (Resolved/Closed = human review). */
export const DELIVERY_CYI_STATUS: CyiStatus = 'in_review'

// ── Delivery plan (pure) ────────────────────────────────────────────────────────────────────────────────

export interface DeliveryPlanInput {
  content: PrContent
  branch: string
  base?: string
  titleOverride?: string
}

/** The delivery plan: what to push and which PR to open. `autoMerge` is ALWAYS false — never an automatic merge. */
export interface DeliveryPlan {
  ticket: string
  branch: string
  base: string
  title: string
  body: string
  autoMerge: false
}

/**
 * Composes the delivery plan: validates branch (only ticket/*) and ticket, resolves the base and composes the PR title and
 * body. It runs nothing and foresees no merge (`autoMerge: false`, structural). Pure and deterministic.
 */
export function planDelivery(input: DeliveryPlanInput): DeliveryPlan {
  assertDeliverableBranch(input.branch)
  assertDeliverableTicket(input.content.ticket)
  const base = input.base ?? DEFAULT_BASE_BRANCH
  assertSafeDeliveryRef(base, 'base')
  return {
    ticket: input.content.ticket,
    branch: input.branch,
    base,
    title: composePrTitle(input.content, input.titleOverride),
    body: composePrBody(input.content),
    autoMerge: false,
  }
}

// ── Execution (injectable probe) ──────────────────────────────────────────────────────────────────────────

export interface PushArgs {
  cwd: string
  branch: string
  remote: string
}

export interface FindPrArgs {
  cwd: string
  branch: string
  /** PR base: filters the search on the same base that would be opened → never reuse a PR towards another base. */
  base: string
}

export interface CreatePrArgs {
  cwd: string
  branch: string
  base: string
  title: string
  body: string
}

export interface LinkTicketArgs {
  ticket: string
  prUrl: string
}

/**
 * The probe that performs the delivery (injectable: mocked in tests, real commands in prod). It exposes NO
 * `merge`: "no automatic merge" is guaranteed structurally — there is no method that could merge.
 */
export interface DeliveryProbe {
  /** NORMAL push of the branch (never force). */
  push(args: PushArgs): void
  /** URL of a PR already open for the branch TOWARDS the base, or null (idempotency: do not open a second one). */
  findPr(args: FindPrArgs): string | null
  /** Opens the PR non-interactively and returns its URL. */
  createPr(args: CreatePrArgs): string
  /** Authoritatively checks whether the link comment already exists; missing keeps compatibility with legacy probes. */
  ticketLinkExists?(args: LinkTicketArgs): boolean
  /** Links the ticket to the PR (ticket→PR side of the bidirectional link). */
  linkTicket(args: LinkTicketArgs): void
  /** Moves the ticket to the given CYI state (In Review). */
}

/** The auditable delivery result (zod schema). `autoMerged` is ALWAYS false. */
export const DeliveryResultSchema = z
  .object({
    ticket: z.string(),
    branch: z.string(),
    base: z.string(),
    prUrl: GitHubPrUrlSchema,
    /** true if the PR was opened now; false if an already open one was reused (idempotency). */
    prCreated: z.boolean(),
    pushed: z.boolean(),
    /** true when the ticket → PR link was (re)done in this run: always attempted, never skipped (DoD). */
    linked: z.boolean(),
    /** The CYI state applied to the ticket: always "In Review" (reconfirmed at every run, no-op server-side). */
    cyiStatus: z.literal('in_review'),
    autoMerged: z.literal(false),
    reasons: z.array(z.string()),
  })
  .strict()
export type DeliveryResult = z.infer<typeof DeliveryResultSchema>

export interface RunDeliveryInput {
  content: PrContent
  branch: string
  cwd: string
  gatePassed: boolean
  base?: string
  remote?: string
  titleOverride?: string
  /** Durable progress of a previous attempt: the confirmed steps are not duplicated. */
  progress?: Partial<DeliveryProgress>
  /** Called right after every confirmed external effect, for the coordinator's crash-safe checkpoint. */
  onProgress?: (progress: DeliveryProgress) => void
  /** Internal use by the async coordinator: yields control after every external checkpoint. */
  pauseAfterProgress?: boolean
}


export interface DeliveryProgress {
  pushed: boolean
  prUrl: string | null
  prCreated: boolean
  linked: boolean
  /**
   * CYAU-174 — no longer written, but the field STAYS optional: the schema is `.strict()`, and removing it
   * would make non-adoptable every run interrupted by the previous version, which wrote it
   * in. It is read and ignored.
   */
  cyiStatusSet?: boolean
}

export class DeliveryProgressPause extends Error {
  constructor(public readonly progress: DeliveryProgress) {
    super('delivery checkpoint pause')
    this.name = 'DeliveryProgressPause'
  }
}

/**
 * Orchestrates the idempotent delivery behind the probe: (1) checks green gates, branch and ticket; (2) pushes the
 * branch; (3) reuses the PR already open towards the same base or opens a new one; (4) ALWAYS links ticket ↔ PR
 * (even on a reused PR: never a missing link after a partial failure); (5) ALWAYS reconfirms the ticket "In
 * Review" (no-op server-side if already there → never a ticket not moved to review because of a diverging local state).
 * NEVER a merge, NEVER beyond "In Review". Returns an auditable record.
 */
export function runDelivery(input: RunDeliveryInput, probe: DeliveryProbe): DeliveryResult {
  assertGatePassed(input.gatePassed)
  const plan = planDelivery({content: input.content, branch: input.branch, base: input.base, titleOverride: input.titleOverride})
  const remote = input.remote ?? DEFAULT_REMOTE
  assertSafeDeliveryRef(remote, 'remote')
  const reasons: string[] = []
  const progress: DeliveryProgress = {
    pushed: input.progress?.pushed ?? false,
    prUrl: input.progress?.prUrl ?? null,
    prCreated: input.progress?.prCreated ?? false,
    linked: input.progress?.linked ?? false,
    // It is carried over as it was, never rewritten: it only serves not to break the adoption of a
    // run interrupted by the previous version.
    cyiStatusSet: input.progress?.cyiStatusSet,
  }
  const persist = (): void => {
    const snapshot = {...progress}
    input.onProgress?.(snapshot)
    if (input.pauseAfterProgress) throw new DeliveryProgressPause(snapshot)
  }

  if (!progress.pushed) {
    probe.push({cwd: input.cwd, branch: plan.branch, remote})
    progress.pushed = true
    persist()
    reasons.push(`Push di ${plan.branch} su ${remote}`)
  } else reasons.push(`Push di ${plan.branch} su ${remote} già attestato dal checkpoint`)

  const existing = progress.prUrl ?? probe.findPr({cwd: input.cwd, branch: plan.branch, base: plan.base})
  let prUrl: string
  let prCreated: boolean
  if (existing) {
    if (!isGitHubPrUrl(existing)) {
      throw new AutomatorError(ErrorCodes.Deliver.commandFailed, 'URL PR GitHub non valido dalla discovery remota', 1)
    }
    prUrl = existing
    prCreated = progress.prUrl ? progress.prCreated : false
    reasons.push(`PR già aperta riusata: ${prUrl}`)
    if (!progress.prUrl) {
      progress.prUrl = prUrl
      progress.prCreated = false
      persist()
    }
  } else {
    prUrl = probe.createPr({cwd: input.cwd, branch: plan.branch, base: plan.base, title: plan.title, body: plan.body})
    if (!isGitHubPrUrl(prUrl)) {
      throw new AutomatorError(ErrorCodes.Deliver.commandFailed, 'URL PR GitHub non valido dalla creazione remota', 1)
    }
    prCreated = true
    progress.prUrl = prUrl
    progress.prCreated = true
    persist()
    reasons.push(`PR aperta: ${prUrl}`)
  }

  // Bidirectional ticket → PR link: ALWAYS, both on a new and on a reused PR. Skipping it on the reused PR would leave the
  // link missing forever after a partial failure (createPr ok but linkTicket failed: on retry `findPr`
  // finds the PR again and the link would never be attempted again). At-least-once: a possible duplicate comment in a
  // retry is authoritatively checked by the probe; the checkpoint also avoids the remote read in healthy retries.
  if (!progress.linked) {
    const alreadyLinked = probe.ticketLinkExists?.({ticket: plan.ticket, prUrl}) ?? false
    if (!alreadyLinked) probe.linkTicket({ticket: plan.ticket, prUrl})
    progress.linked = true
    persist()
    reasons.push(alreadyLinked ? `Link del ticket ${plan.ticket} già presente` : `Ticket ${plan.ticket} collegato alla PR`)
  } else reasons.push(`Link del ticket ${plan.ticket} attestato dal checkpoint`)

  // CYAU-174 — this program NO longer moves the state.
  //
  // Three parties used to move it: the manual the agent follows, this program, and the server when
  // it records the delivery. Three hands on the same lever, and none knew of the others.
  //
  // Why exactly this one must go. The rule forbidding moving the state from the
  // terminal while a run is in progress is about to come in — and this program moved it exactly from there.
  // The day the rule takes effect, EVERY delivery of EVERY machine would fail
  // at the last step: code already pushed, proposal already open, comment already written, and then the
  // delivery turns out failed. The server would never be told the work is there, the run
  // would hang until declared abandoned, and the ticket would go back to the queue to
  // be redone from scratch. Hours paid and thrown away, on every ticket and on every machine.
  //
  // `cyiStatus` in the result STAYS: the vendored contract and typed-workflow require it.
  // It says which state the server must apply, not which one the program applied.

  return DeliveryResultSchema.parse({
    ticket: plan.ticket,
    branch: plan.branch,
    base: plan.base,
    prUrl,
    prCreated,
    pushed: progress.pushed,
    linked: progress.linked,
    cyiStatus: DELIVERY_CYI_STATUS,
    autoMerged: false,
    reasons,
  })
}

// ── Real probe (git/gh/cyi behind an injectable CommandRunner) ────────────────────────────────────────────

export interface CommandOutcome {
  status: number | null
  stdout: string
  stderr: string
}

/** Runs an external command and returns its outcome (injectable: default `spawnSync`, argv array = no shell). */
export type CommandRunner = (cmd: string, args: string[], cwd?: string) => CommandOutcome

function defaultRunner(cmd: string, args: string[], cwd?: string): CommandOutcome {
  const res = spawnSync(cmd, args, {cwd, encoding: 'utf8', timeout: 15_000, killSignal: 'SIGTERM'})
  // spawnSync does NOT throw on a missing binary: the error (e.g. `spawn git ENOENT`) is in `res.error` with `status`
  // null. It is propagated in the detail so the message stays diagnostic instead of an opaque "exit null".
  const stderr = res.error ? `${res.error.message}\n${res.stderr ?? ''}`.trim() : res.stderr ?? ''
  return {status: res.status, stdout: res.stdout ?? '', stderr}
}

/**
 * Operational probe. It no longer resolves any state: it used to read the list of states and require that
 * there be EXACTLY one review state — with two, it stopped with an error. And it stopped BEFORE
 * sending the code, so the session had already been paid in full and had to be redone from scratch because of
 * an organization configuration (CYAU-174).
 */
export function defaultOperationalDeliveryProbe(project: string, run: CommandRunner = defaultRunner): DeliveryProbe {
  let resolved: DeliveryProbe | null = null
  const probe = (): DeliveryProbe => {
    resolved ??= defaultDeliveryProbe({project, run})
    return resolved
  }
  return {
    push: (args) => probe().push(args),
    findPr: (args) => probe().findPr(args),
    createPr: (args) => probe().createPr(args),
    ticketLinkExists: (args) => probe().ticketLinkExists?.(args) ?? false,
    linkTicket: (args) => probe().linkTicket(args),
  }
}

export interface DefaultProbeOptions {
  /** CloseYourIt project key for the `cyi` commands (comment + state transition). */
  project: string
  run?: CommandRunner
}

/**
 * The real probe: push with `git`, PR with `gh` (non-interactive), link and transition with `cyi`. Every command is
 * an argv array (no shell → no injection). The push is NORMAL (never `--force`). `gh pr create` receives
 * all the fields (`--base/--head/--title/--body`) → no prompt. A failure becomes `C502-DELIVER-003`.
 */
export function defaultDeliveryProbe(opts: DefaultProbeOptions): DeliveryProbe {
  const run = opts.run ?? defaultRunner
  const fail = (what: string, outcome: CommandOutcome): never => {
    const detail = outcome.stderr.trim() || outcome.stdout.trim() || `exit ${outcome.status}`
    throw remoteCommandError(ErrorCodes.Deliver.commandFailed, `${what} fallito: ${detail}`, outcome)
  }

  return {
    push({cwd, branch, remote}) {
      // Normal push (never --force): the guard-branch-push guardrail blocks force-push and protected branches anyway.
      const outcome = run('git', ['-C', cwd, 'push', '--set-upstream', remote, branch])
      if (outcome.status !== 0) fail('git push', outcome)
    },
    findPr({cwd, branch, base}) {
      // Filters on branch (--head) AND base (--base): never reuse a PR opened from the same branch towards a different
      // base from the one we would open. gh pr list does not fail when it finds nothing → empty stdout.
      const outcome = run('gh', ['pr', 'list', '--head', branch, '--base', base, '--state', 'open', '--json', 'url', '--jq', '.[0].url // ""'], cwd)
      // A discovery error is not the same as "PR missing": creating blindly could duplicate it.
      if (outcome.status !== 0) return fail('gh pr list', outcome)
      const url = outcome.stdout.trim()
      if (url !== '' && !isGitHubPrUrl(url)) {
        throw new AutomatorError(ErrorCodes.Deliver.commandFailed, 'gh pr list: URL PR GitHub non valido', 1)
      }
      return url.length > 0 ? url : null
    },
    createPr({cwd, branch, base, title, body}) {
      // Non-interactive: all fields provided → gh asks nothing and prints the PR URL on stdout.
      const outcome = run('gh', ['pr', 'create', '--base', base, '--head', branch, '--title', title, '--body', body], cwd)
      if (outcome.status !== 0) fail('gh pr create', outcome)
      const url = outcome.stdout.trim()
      if (!url) return fail('gh pr create', {status: outcome.status, stdout: '(nessun URL restituito)', stderr: outcome.stderr})
      if (!isGitHubPrUrl(url)) {
        throw new AutomatorError(ErrorCodes.Deliver.commandFailed, 'gh pr create: URL PR GitHub non valido', 1)
      }
      return url
    },
    ticketLinkExists({ticket, prUrl}) {
      const outcome = run('cyi', ['tickets', 'comments', ticket, '-p', opts.project, '--json'])
      if (outcome.status !== 0) return fail('cyi tickets comments', outcome)
      try {
        const parsed = JSON.parse(outcome.stdout) as {data?: unknown}
        if (!Array.isArray(parsed.data)) {
          throw new AutomatorError(ErrorCodes.Deliver.commandFailed, 'cyi tickets comments: risposta JSON non valida', 1)
        }
        return parsed.data.some((comment) => {
          if (typeof comment !== 'object' || comment === null) return false
          const body = (comment as {body?: unknown}).body
          return typeof body === 'string' && body.includes(prUrl)
        })
      } catch {
        return fail('cyi tickets comments', {status: 0, stdout: '', stderr: 'risposta JSON non valida'})
      }
    },
    linkTicket({ticket, prUrl}) {
      const outcome = run('cyi', ['tickets', 'comment', ticket, '-p', opts.project, '--body', `PR aperta per la review: ${prUrl}`])
      if (outcome.status !== 0) fail('cyi tickets comment', outcome)
    },
  }
}
