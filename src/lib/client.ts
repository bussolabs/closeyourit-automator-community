import {isHostToken, isOrgToken, isUserToken, type SyncConfig} from './config'
import {type FetchFn} from './heartbeat'
import {type SandboxModeT} from './schema'
import {type AgentRunResult} from './agent-result'
import {parseWorkspaceManifest, type WorkspaceManifest} from './workspace-manifest'
import {parseSkillsManifest, type SkillsManifest} from './skills-manifest'
import {isExecutionPhase, type ExecutionPhase} from './phase-profile'
import {isReviewMode, type ReviewFinding, type ReviewMode} from './review'
import {isReviewerId, isRuntimeId, type ReviewerId, type RuntimeId} from './route'

// HTTP client to CloseYourIt: the org token authenticates only the host bootstrap; the revocable host bearer
// authenticates all operations. Best-effort: a network error does NOT bring down the daemon.

export const DEFAULT_API = 'https://app.closeyour.it'

// Hard timeout on every call: without it, a hung server would block the daemon boot (self-registration)
// or a loop iteration indefinitely. On expiry the fetch aborts → handled as a network error.
const REQUEST_TIMEOUT_MS = 15_000

// GitHub repo of the target project (from the AgentSerializer). `repo` = full_name `owner/repo`, or null if the
// project is not linked to a GitHub repo. It is the "CloseYourIt GitHub map" with which the automator detects
// the local checkout by comparing the Git remotes (CYAU-10). `default_branch` is not needed for the checkout
// mapping but is part of the contract (future on-demand auto-clone).
/** A Definition of Done entry: a string in a v1 plan, {id, text} in a v2 plan (CYRA-877). */
export type PlanDone = string | {id: string; text: string}

export interface ProjectTarget {
  key: string
  repo: string | null
  default_branch: string
}


/**
 * The ticket snapshot served by the queue, WITHOUT the selection. CYAU-169: the atomic claim
 * (`claimNextTicket`) delivers the candidate together with the lease, and there the `selection_token` is absent — the selection
 * has already been spent by the claim, and a token returned after the lease would not help to defer anyway.
 * The two-step path adds it (`TicketQueueCandidate`), because there the claim has yet to happen.
 */
export interface ClaimedTicketCandidate {
  id: string
  code: string
  title: string
  description?: string | null
  technical_analysis?: string | null
  kind?: string | null
  weight?: number | null
  due_at?: string | null
  created_at?: string | null
  updated_at?: string | null
  closed_at?: string | null
  project: {id: string; key: string; repo: string; default_branch: string}
  status?: {id?: string; code?: string; label?: string; category?: string} | null
  priority?: {id?: string; code?: string; label?: string} | null
  milestone?: {id?: string; code?: string; label?: string; due_on?: string | null} | null
  assignee?: {id?: string; name?: string} | null
  reporter?: {id?: string; name?: string} | null
  reviewer?: {id?: string; name?: string} | null
  platforms?: Array<{id?: string; code?: string; label?: string}>
  scenarios?: Array<{title?: string | null; step_given?: string | null; step_when?: string | null; step_then?: string | null; step_expected?: string | null}>
  conditions?: Array<{text?: string | null}>
  /** Structured guidance resolved SERVER-side (CYAU-1): references/procedures/rules. Additive, missing on legacy servers. */
  guidance?: Record<string, unknown> | null
  /**
   * Admission decided SERVER-side (CYRA-184): the queue serves only `allowed`. On the host-first path it is
   * the AUTHORITY on admission, not accessory information — the client relies on it instead of repeating
   * the evaluation with its own heuristic. Missing on earlier servers: no authority, so the local gates
   * stay as before (backward compat; never an admission inferred from silence).
   */
  agent_eligibility?: 'pending' | 'allowed' | 'blocked' | null
  comments?: Array<{id?: string; body?: string; author?: {id?: string; name?: string}; created_at?: string; updated_at?: string}>
  /** CYAU-240 — answered clarification questions, oldest first. Missing on older servers. */
  answered_questions?: Array<{question?: string; answer?: string}>
  workflow: {
    id: string
    phase: string
    // Host-first (CYAU-87): the AUTHORITATIVE pre-claim execution_phase (one of the 5 `ExecutionPhase`), aligned with the
    // post-claim lease vocabulary. The host derives runtime/skill/sandbox from it via `phaseProfile`, NOT from the FSM
    // state `phase` (which for the ready planner is `planning`/`review_blocked`, not mappable to an executable phase).
    execution_phase: ExecutionPhase
    snapshot_version: number
    snapshot_digest?: string | null
    current_plan?: {
      version: number
      technical_analysis: string
      scenarios: Array<{given: string; when: string; then: string; expected: string}>
      definition_of_done: PlanDone[]
      mixed_parts?: Record<string, unknown> | null
      notes: string[]
      change_request?: string | null
      // CTO approval (CYRA, additive): distinguishes the APPROVED plan — the spec the autopilot
      // must implement — from one still under discussion. Missing on earlier servers: without
      // observable approval the plan stays untrusted material, as before.
      approved_at?: string | null
      approved_by?: string | null
      /**
       * CYAU-177 — the two decisions frozen when a person approved the plan (CYRA-610).
       * `candidate_items`: on which repository the work can start and from which point. `completion_probe`:
       * which evidence will say "done". Until now the session did not receive them and inferred them by itself —
       * if it picked the wrong place nobody noticed until delivery, with the work round already paid
       * in full. Missing on plans approved before CYRA-610 and on non-configured projects.
       */
      candidate_items?: unknown
      completion_probe?: unknown
    } | null
    /**
     * CYAU-177 — which plan version is the one FROZEN at approval. `current_plan` is
     * `plans.last`, which is not necessarily the frozen one: without this comparison the host would compose the
     * constraint from a plan nobody approved.
     */
    frozen_plan_version?: unknown
    /** CYAU-236 — blocking findings of the latest attempt of the ready phase that the review rejected. */
    rework?: unknown
  }
}

export interface TicketQueueCandidate extends ClaimedTicketCandidate {
  selection_token: string
}

export type TicketQueueResult =
  | {outcome: 'candidate'; candidate: TicketQueueCandidate}
  | {outcome: 'empty' | 'error'}

/**
 * ATOMIC claim request (CYAU-169, server endpoint CYRA-588): "give me work from this queue",
 * not "take THIS ticket". The server picks the candidate and claims it in the same transaction, so
 * two hosts on the same queue get different tickets. No `ttl_seconds`: the timeout belongs to the PhaseProfile
 * of the phase chosen by the server, and the client cannot declare the TTL of a phase it does not know yet.
 */
export interface TicketQueueNextClaimRequest {
  project_key: string
  host_id: string
  run_id: string
}

/**
 * Outcome of the atomic claim:
 * - claimed: the lease is ours and the candidate travels with it (whoever skips the preflight never saw it).
 * - empty: the queue has no work NOW (`data: null`), which is not an error.
 * - rejected: a response arrived but carries no usable claim — a rejection on the merits (403/404/409…)
 *   or a 2xx with an incomplete payload. `status`/`serverCode` say which remedy is needed (CYAU-120).
 * - error: no response (network, timeout, missing host credential) → UNDETERMINED outcome, not a rejection.
 */
export type TicketQueueNextClaimResult =
  | {outcome: 'claimed'; lease: Lease & {attempt_id: string}; candidate: ClaimedTicketCandidate}
  | {outcome: 'empty'}
  | {outcome: 'rejected'; status: number; serverCode?: string}
  | {outcome: 'error'}

export interface TicketQueueClaimRequest {
  selection_token: string
  host_id: string
  run_id: string
  ttl_seconds: number
}

export type TicketQueueClaimResult =
  | {outcome: 'acquired'; lease: Lease & {attempt_id: string}}
  // `status`/`serverCode` are present ONLY when a response arrived (CYAU-120): their absence
  // distinguishes "the server rejected, and here is why" from "no response arrived", which have opposite remedies.
  | {outcome: 'stale' | 'held' | 'invalid' | 'error'; lease: Lease | null; status?: number; serverCode?: string}

/**
 * Deferral request (CYAU-101). `host_id` is MANDATORY as in the claim: the server rejects with 403
 * (`R403-QUEUE-001`) if it does not match the host authenticated by the bearer. It is not redundancy — it is the explicit
 * confirmation that whoever signs the request is the same host for which the deferral will be recorded.
 */
export interface TicketQueueDeferralRequest {
  selection_token: string
  host_id: string
  reason: QueueDeferralReason
}


// Registration of this installation as an Agent Host (POST /api/v1/hosts). `fingerprint` is the stable
// idempotency key: two POSTs with the same fingerprint must return the same host, not two.
export interface HostRegistration {
  fingerprint: string
  hostname: string
  platform: string
  arch: string
  automator_version?: string
}

// Identity returned by the server: canonical host_id + dedicated revocable credential.
export interface RegisteredHost {
  id: string
  token: string
}

// Host-scoped HTTP outcome preserved up to the recovery boundary. Only `unauthorized` derives from an explicit
// 401; 403 (revocation/policy) and network/5xx stay distinct and authorize no rotation.
export type HostCallOutcome = 'ok' | 'unauthorized' | 'forbidden' | 'unavailable'
export type HostCallResult<T> =
  | {outcome: 'ok'; value: T}
  | {outcome: Exclude<HostCallOutcome, 'ok'>}

// Atomic lease request on a ticket (POST /api/v1/leases). Uniqueness — one host at a time —
// is guaranteed SERVER-side by a constraint on `ticket`; the client provides the identity (host_id) and the context
// (run_id, agent) plus the desired expiry (ttl_seconds). The server computes the actual expires_at (avoids
// clock skew between hosts).
export interface LeaseRequest {
  ticket: string
  host_id: string
  run_id: string
  agent: string
  ttl_seconds: number
}

// Lease as returned by the server: who holds it NOW and until when. On successful acquisition host_id is
// ours; on conflict (409) it is the host that already holds it. run_id/agent are optional: on conflict the
// server may expose only the holder + expiry. Host-first (CYAU-86): the claim also carries the signed
// authoritative phase (`execution_phase`) and the profile fingerprint (`profile_digest`) — the automator derives
// runtime/skill from the phase via the `phase-profile` twin (the server does not send the profile). The `agent` slug is
// retired (pure host-first → null). Extracted as optional for parsing robustness (like agent/run_id).
/** CYRA-921 — the engines that can do a machine's work. */
export type WorkEngine = 'claude' | 'codex'

export interface Lease {
  ticket: string
  host_id: string
  expires_at: string
  run_id?: string
  agent?: string
  attempt_id?: string
  execution_phase?: ExecutionPhase
  profile_digest?: string
  /**
   * CYAU-176 — HOW DEEPLY this phase must be reviewed, decided by the server and delivered with the lease, that is before the
   * phase starts (AgentLeaseSerializer). The host reads it, does not choose it: `diff` means the reviewer
   * must be one who opened the real changes, `result` that only the structured report is reviewed.
   * Until now the field arrived and was thrown away, and the host always asked everyone the same thing.
   */
  review_depth?: ReviewDepth
  /** CYRA-921 — who reviews this machine's work: the other engine (`cross`, default) or the same one. */
  review_mode?: ReviewMode
  /** CYAU-226 — the engine that reviews this machine's work, by name. Missing = decided by `review_mode`. */
  reviewer?: ReviewerId
  /** CYAU-228 — the OpenRouter model OpenCode reviews with; only when `reviewer` is `opencode`. */
  reviewer_model?: string
  /** CYRA-921 — which engine does this machine's work, frozen on the attempt at claim. Missing = the phase default. */
  work_engine?: WorkEngine
  /**
   * CYRA-621 — the version number to publish, and for the final version also the exact
   * point in the code. The SERVER decided them before the phase started.
   *
   * Before, the machine chose them, by itself, a few seconds before publishing: it read the last
   * number and decided on its own which digit to change. Two runs of the same project
   * releasing together picked the same name, and the second publication was rejected.
   */
  release?: {version: string; sha?: string}
}

/** Review depth due to the phase. The server decides it; the host executes it. */
export type ReviewDepth = 'diff' | 'result'

export function isReviewDepth(value: unknown): value is ReviewDepth {
  return value === 'diff' || value === 'result'
}

export interface AttemptDelivery {
  runtime: 'claude' | 'codex'
  reviewer_runtime: ReviewerId
  result: Record<string, unknown>
  /**
   * CYAU-176 — the judgment that decides whether the work moves on, and HOW it was produced.
   *
   * Before, what arrived here was always the verdict of a second session that received only the summary written
   * by the first: a few lines of text, no line of code. The judgment of whoever had really opened the
   * changes stayed on the machine and nobody read it. It erred in both directions — a crooked
   * piece of work passed because the summary was well written, a sound one was rejected because it was terse.
   *
   * With `depth: 'diff'` the verdict is that of whoever read the diff, and the three fingerprints say EXACTLY
   * what they read: if something touches the work after that read the fingerprints do not match and the delivery
   * is not accepted as good.
   */
  review: {
    status: 'accepted' | 'changes_requested' | 'unavailable'
    summary: string
    depth?: ReviewDepth
    /** The three fingerprints of what the reviewer really read. Only with `depth: 'diff'`. */
    reviewed_base_commit?: string
    reviewed_snapshot_tree?: string
    reviewed_diff_sha256?: string
    /** Atomic findings kept besides the summary, so the UI does not have to rebuild them from the prose. */
    findings?: ReviewFinding[]
  }
  /**
   * CYAU-178 — what the host MEASURED on its own working copy at delivery time,
   * not what the agent declares in words. A proposal address pointing to another
   * ticket's work, to an old version, or to work whose last push never went out, look
   * identical from outside: all three pass. With this identifier the three cases are told apart.
   *
   * Present only on the phases that write to the repository, where a working copy exists. The server
   * requires it exactly there, and it is the only one that knows which phase was claimed.
   */
  observed?: {head_sha: string}
  /** CYRA-872 — the known Claude spend of the attempt, in dollars. Missing when unknown (Codex): never a zero. */
  cost_usd?: number
  /** CYRA-872 — the work session's model, to compare costs across models. */
  model?: string
}

/**
 * Outcome of the result delivery (CYAU-105). A boolean is not enough: 401/403/404/409/422/500, timeout and
 * missing token have DIFFERENT remedies and a `false` made them indistinguishable — the same reason why
 * `claimTicketQueue` discriminates 409/422 by reading `errorCode(body)` instead of returning a flag.
 * - ok: the server accepted the delivery (2xx).
 * - rejected: the server rejected it on the merits (4xx with its own code: invalid lease/scope/schema).
 *   Retrying unchanged does not help, look at `code`.
 * - unauthorized/forbidden: host credential superseded (401) or host revoked (403, terminal).
 * - unavailable: network, timeout, 5xx or unconfigured channel → UNDETERMINED outcome, not "rejected".
 */
/**
 * CYAU-171 — what the SERVER decided about the attempt, when it says so. Optional because an
 * unreadable response must not turn a successful delivery into an error: the detail is lost,
 * not the delivery.
 */
export interface DeliveredAttemptState {
  status?: string
  phase?: string
  reviewStatus?: string
}

export type AttemptDeliveryResult =
  | {outcome: 'ok'; status: number; attempt?: DeliveredAttemptState}
  | {outcome: 'rejected'; status: number; code?: string}
  | {outcome: 'unauthorized'; status: number}
  | {outcome: 'forbidden'; status: number}
  | {outcome: 'unavailable'; status?: number}

/**
 * The attempt state inside a 2xx response. No interpretation here: the fields are extracted
 * as they are and the reader decides what they mean — reading and judging in two different places is what
 * allows changing the judgment without touching the transport.
 */
async function deliveredAttemptState(res: Response): Promise<DeliveredAttemptState | undefined> {
  const body = await res.json().catch(() => null)
  const data = (body as {data?: unknown} | null)?.data

  // CYAU-191 — the attempt sits FLAT under `data`: the server answers `render_ok(AgentAttemptSerializer
  // .new(...))`, and that envelope nests no `attempt` key. Looking for it only one level
  // lower it was never found: every successful delivery ended up in the log as "outcome not read", and the
  // check "concluded only if the server says so" never had anything to read. Both
  // shapes are accepted because the nested key stays legitimate and keeping it costs one line.
  const annidato = (data as {attempt?: unknown} | null | undefined)?.attempt
  const attempt = annidato && typeof annidato === 'object' ? annidato : data
  if (!attempt || typeof attempt !== 'object' || Array.isArray(attempt)) return undefined

  const row = attempt as Record<string, unknown>
  const testo = (value: unknown): string | undefined => (typeof value === 'string' && value !== '' ? value : undefined)
  const state: DeliveredAttemptState = {
    status: testo(row.status),
    phase: testo(row.phase),
    reviewStatus: testo(row.review_status),
  }
  return state.status || state.phase || state.reviewStatus ? state : undefined
}

// Release body (POST /api/v1/leases/:ticket/release): the server verifies that whoever releases is the
// holder (host_id + run_id) before freeing the ticket.
export interface LeaseReleaseRequest {
  ticket: string
  host_id: string
  run_id: string
}

// Renewal request (POST /api/v1/leases/:ticket/renew): extends the expiry of an ALREADY held lease,
// without changing owner. The server verifies that whoever renews is the holder (host_id + run_id) and
// recomputes expires_at with its OWN clock (server time, no clock skew between hosts). Idempotent: several
// close renewals only move the expiry forward.
export interface LeaseRenewRequest {
  ticket: string
  host_id: string
  run_id: string
  ttl_seconds: number
}

// Renewal outcome (union on `outcome`):
// - renewed: the expiry was extended, owner unchanged (2xx) → `lease` with the new expires_at.
// - held: the lease is NO longer ours, another host holds it (409) → stop renewing it.
// - expired: the lease already expired/is missing server-side (404) → not renewable (server-side recovery).
// - error: unexpected network/HTTP (best-effort) → undetermined, retry at the next beat.
export type LeaseRenewOutcome = 'renewed' | 'held' | 'expired' | 'error'
export interface LeaseRenewResult {
  outcome: LeaseRenewOutcome
  lease: Lease | null
}

// Acquisition outcome (discriminated union on `outcome`):
// - acquired: the lease is ours (2xx).
// - held: already held by another host (409) → do NOT proceed; `lease` = holder if the server exposes it.
// - error: unexpected network/HTTP (best-effort) → undetermined outcome, assume neither won nor lost.
export type LeaseOutcome = 'acquired' | 'held' | 'error'
export interface LeaseResult {
  outcome: LeaseOutcome
  lease: Lease | null
}

/**
 * Ticket queue deferral reasons. The BACKOFFS are decided by the SERVER (5 minutes / 30 minutes / 6 hours):
 * the client declares only WHY it stopped, not for how long — so the waiting policy stays a
 * single one and does not have to be kept aligned in two repositories.
 */
export type QueueDeferralReason = 'temporary_failure' | 'preflight_blocked' | 'needs_clarification'

export interface AutomatorClient {
  getWorkspaceManifest(): Promise<WorkspaceManifest | null> // null = network/HTTP error or unparsable manifest
  getSkillsManifest(): Promise<SkillsManifest | null> // null = network/HTTP error or unparsable manifest
  registerHost(reg: HostRegistration): Promise<RegisteredHost | null> // null = network/HTTP error or invalid contract
  acquireLease(req: LeaseRequest): Promise<LeaseResult>
  releaseLease(req: LeaseReleaseRequest): Promise<boolean> // true = released or already missing (idempotent)
  renewLease(req: LeaseRenewRequest, signal?: AbortSignal): Promise<LeaseRenewResult>
  getTicketQueue(projectKey: string): Promise<TicketQueueResult>
  /**
   * Defers the queue candidate (CYAU-101). The SERVER decides the backoff from the `reason`; the client
   * declares only why it stopped. Idempotent server-side (replay by selection digest), so
   * a retry does not accumulate waits. Returns true only on acceptance: the outcome is informative, the caller
   * stays best-effort — a missed defer offers the ticket again at the next tick, it breaks nothing.
   */
  deferTicketQueue(req: TicketQueueDeferralRequest): Promise<boolean>
  claimTicketQueue(req: TicketQueueClaimRequest): Promise<TicketQueueClaimResult>
  /**
   * ATOMIC claim of the next ready phase of the queue (CYAU-169): selection and claim in a single
   * request. It is what makes the parallel-run cap real on a SINGLE queue — with the pair
   * `getTicketQueue` + `claimTicketQueue` two concurrent claims re-read the same head and one stays stale.
   */
  claimNextTicket(req: TicketQueueNextClaimRequest): Promise<TicketQueueNextClaimResult>
  /**
   * Delivers the attempt's structured result. Returns a DISCRIMINATED outcome (CYAU-105): the caller
   * must be able to say in the log whether the delivery was rejected (and with which code) or simply
   * did not arrive — a single `false` made the two the same silence.
   */
  deliverAttempt(attemptId: string, payload: AttemptDelivery): Promise<AttemptDeliveryResult>
}

/** Real client with detailed auth outcomes; the other methods stay best-effort for the non-recovery call sites. */
export interface RecoverableAutomatorClient extends AutomatorClient {
  getWorkspaceManifestResult(): Promise<HostCallResult<WorkspaceManifest>>
  registerHostResult(reg: HostRegistration): Promise<HostCallResult<RegisteredHost>>
}

// Extracts the lease from the {data:{...}} envelope. Tolerant: requires only the useful identity (ticket, host_id,
// expires_at); run_id/agent/execution_phase/profile_digest are included if present. Minimum contract not
// respected → null (like registerHost). Host-first (CYAU-86): `execution_phase` is accepted only if it is one
// of the 5 known phases (the phase-profile twin derives runtime/skill from it); an unknown phase is discarded (fail-closed).
function parseLease(body: unknown): Lease | null {
  const data = (body as {data?: unknown} | null)?.data
  if (!data || typeof data !== 'object') return null
  const d = data as Record<string, unknown>
  const str = (v: unknown): v is string => typeof v === 'string'
  if (!str(d.ticket) || !str(d.host_id) || !str(d.expires_at)) return null
  const lease: Lease = {ticket: d.ticket, host_id: d.host_id, expires_at: d.expires_at}
  if (str(d.run_id)) lease.run_id = d.run_id
  if (str(d.agent)) lease.agent = d.agent
  if (str(d.attempt_id)) lease.attempt_id = d.attempt_id
  if (isExecutionPhase(d.execution_phase)) lease.execution_phase = d.execution_phase
  if (str(d.profile_digest)) lease.profile_digest = d.profile_digest
  // CYAU-176 — a value outside the two known ones is discarded, not guessed: the host would be deciding
  // the depth by itself, which is exactly what this field exists to take away from it.
  if (isReviewDepth(d.review_depth)) lease.review_depth = d.review_depth
  // CYRA-921 — an unknown value is dropped: the host falls back to cross review, the strictest.
  if (isReviewMode(d.review_mode)) lease.review_mode = d.review_mode
  // CYAU-226 — same rule: an engine this host does not know is dropped and `review_mode` decides.
  if (isReviewerId(d.reviewer)) lease.reviewer = d.reviewer
  if (typeof d.reviewer_model === 'string' && d.reviewer_model.trim()) lease.reviewer_model = d.reviewer_model.trim()
  // CYRA-921 — same rule: an unknown engine is dropped, never guessed.
  if (d.work_engine === 'claude' || d.work_engine === 'codex') lease.work_engine = d.work_engine
  // CYRA-621 — checked shape: a number that is not a number is not passed to the session as if
  // it were, and an abbreviated identifier identifies nothing.
  const release = d.release as {version?: unknown; sha?: unknown} | null | undefined
  const versione = release && typeof release.version === 'string' ? release.version : null
  if (versione && /^v\d+\.\d+\.\d+(-[0-9A-Za-z.-]+)?$/u.test(versione)) {
    lease.release = {version: versione}
    const sha = release?.sha
    if (typeof sha === 'string' && /^[0-9a-f]{40}$/u.test(sha)) lease.release.sha = sha
  }
  return lease
}

function nonEmpty(value: unknown): value is string {
  return typeof value === 'string' && value.trim() !== ''
}

/**
 * Validates the candidate snapshot (untrusted input). `selectionToken: 'required'` on the two-step path,
 * where the selection has yet to be spent; `'absent'` on the atomic claim (CYAU-169), which delivers
 * the candidate once the claim has happened. The whole rest of the contract — identity, project, executable phase — is
 * required identically on both paths: atomicity changes where the candidate comes from, not what it must carry.
 */
function parseCandidate(data: unknown, selectionToken: 'required' | 'absent'): ClaimedTicketCandidate | null {
  if (!data || typeof data !== 'object' || Array.isArray(data)) return null
  const d = data as Record<string, unknown>
  const project = d.project
  if (!project || typeof project !== 'object' || Array.isArray(project)) return null
  const p = project as Record<string, unknown>
  const required = [d.id, d.code, d.title, p.id, p.key, p.repo, p.default_branch]
  if (selectionToken === 'required') required.push(d.selection_token)
  if (!required.every(nonEmpty)) return null
  // Host-first (CYAU-87): the candidate MUST carry a valid execution_phase (one of the 5 phases). Without it, the host
  // cannot derive the PhaseProfile (runtime/skill/sandbox) → fail-closed. Vocabulary B (`*_queued` of `phase`)
  // is not a valid phase: a candidate carrying `phase` but not `execution_phase` is discarded.
  const workflow = d.workflow
  if (!workflow || typeof workflow !== 'object' || Array.isArray(workflow)) return null
  if (!isExecutionPhase((workflow as Record<string, unknown>).execution_phase)) return null
  return d as unknown as ClaimedTicketCandidate
}

function parseTicketQueueCandidate(body: unknown): TicketQueueCandidate | null {
  const candidate = parseCandidate((body as {data?: unknown} | null)?.data, 'required')
  return candidate as TicketQueueCandidate | null
}

function errorCode(body: unknown): string | undefined {
  if (!body || typeof body !== 'object') return undefined
  const root = body as Record<string, unknown>
  const error = root.error
  if (error && typeof error === 'object' && nonEmpty((error as Record<string, unknown>).code)) {
    return (error as {code: string}).code
  }
  return nonEmpty(root.code) ? root.code : undefined
}

function httpFailure(status: number): HostCallResult<never> {
  if (status === 401) return {outcome: 'unauthorized'}
  if (status === 403) return {outcome: 'forbidden'}
  return {outcome: 'unavailable'}
}

export function makeClient(cfg: SyncConfig, fetchFn: FetchFn = globalThis.fetch, hostToken?: string, registrationToken?: string): RecoverableAutomatorClient {
  const base = cfg.apiUrl ?? DEFAULT_API
  const json = 'application/json'
  // registerHost creates the host: the machine presents itself with the token of ITS service account (cyi_u_, the identity
  // decided by the admin with its scope). Fallback to the cyi_a_ org token for backward compat with the old bootstrap.
  // Every other operation instead requires the revocable host credential cyi_ah_: before registration
  // it fails closed, without downgrade.
  const registrationHeaders = isUserToken(registrationToken)
    ? {Authorization: `Bearer ${registrationToken}`, 'Content-Type': json}
    : isOrgToken(cfg.orgToken) ? {Authorization: `Bearer ${cfg.orgToken}`, 'Content-Type': json} : null
  const opHeaders = isHostToken(hostToken) ? {Authorization: `Bearer ${hostToken}`, 'Content-Type': json} : null

  // Detailed auth outcomes on the host-scoped manifest: it is the operational call that opens every tick, so it is the one on
  // which the bounded 401 recovery lives (host token superseded by a concurrent registration). The validation
  // stays tolerant (`parseWorkspaceManifest`): an unparsable manifest is `unavailable`, not a 401.
  const getWorkspaceManifestResult = async (): Promise<HostCallResult<WorkspaceManifest>> => {
    if (!opHeaders) return {outcome: 'unavailable'}
    try {
      const res = await fetchFn(`${base}/api/v1/agent_host/workspace_manifest`, {method: 'GET', headers: opHeaders, signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS)})
      if (!res.ok) return httpFailure(res.status)
      const manifest = parseWorkspaceManifest(await res.json().catch(() => null))
      return manifest ? {outcome: 'ok', value: manifest} : {outcome: 'unavailable'}
    } catch {
      return {outcome: 'unavailable'}
    }
  }

  const registerHostResult = async (reg: HostRegistration): Promise<HostCallResult<RegisteredHost>> => {
    if (!registrationHeaders) return {outcome: 'unavailable'}
    try {
      const res = await fetchFn(`${base}/api/v1/hosts`, {
        method: 'POST',
        headers: registrationHeaders,
        body: JSON.stringify(reg),
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      })
      if (!res.ok) return httpFailure(res.status)
      const body = (await res.json()) as {data?: {id?: unknown; token?: unknown}}
      const data = body.data
      if (!data || typeof data.id !== 'string' || !isHostToken(data.token)) return {outcome: 'unavailable'}
      return {outcome: 'ok', value: {id: data.id, token: data.token}}
    } catch {
      return {outcome: 'unavailable'}
    }
  }

  // Release of a held lease: the server verifies that whoever releases is the holder (host_id + run_id).
  // Extracted because `claimNextTicket` also needs it to give back a claim born unusable, before
  // the caller even sees it. `true` = released or already missing (idempotent).
  const releaseHeldLease = async (req: LeaseReleaseRequest): Promise<boolean> => {
    if (!opHeaders) return false
    try {
      const res = await fetchFn(`${base}/api/v1/leases/${encodeURIComponent(req.ticket)}/release`, {
        method: 'POST',
        headers: opHeaders,
        body: JSON.stringify(req),
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      })
      return res.ok || res.status === 404
    } catch {
      return false
    }
  }

  return {
    getWorkspaceManifestResult,
    registerHostResult,

    // Host-scoped workspace manifest: the host credential `cyi_ah_` authenticates, the response is validated
    // TOLERANTLY by parseWorkspaceManifest (untrusted input). null = failed network/HTTP or unparsable manifest
    // (best-effort): the caller degrades without serving any queue.
    async getWorkspaceManifest() {
      const result = await getWorkspaceManifestResult()
      return result.outcome === 'ok' ? result.value : null
    },

    // Host-scoped skill bundle manifest (twin of getWorkspaceManifest): the host credential `cyi_ah_`
    // authenticates, the response is validated TOLERANTLY by parseSkillsManifest. null = failed network/HTTP, 404 (no
    // pinned bundle → the host stays in prompt mode) or unparsable manifest — best-effort, the caller degrades.
    async getSkillsManifest() {
      if (!opHeaders) return null
      try {
        const res = await fetchFn(`${base}/api/v1/agent_host/skill_manifest`, {method: 'GET', headers: opHeaders, signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS)})
        if (!res.ok) return null
        return parseSkillsManifest(await res.json().catch(() => null))
      } catch {
        return null
      }
    },


    async getTicketQueue(projectKey) {
      if (!opHeaders) return {outcome: 'error'}
      try {
        // Host-first (CYAU-84/86): flattened queue and host-scoped client — the host is the cyi_ah_ bearer, no
        // agent_id either in the URL or in the signature. The server returns the next ready phase (workflow.phase).
        const query = new URLSearchParams({project_key: projectKey})
        const res = await fetchFn(`${base}/api/v1/ticket_queue?${query}`, {
          method: 'GET', headers: opHeaders, signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
        })
        if (!res.ok) return {outcome: 'error'}
        const body = await res.json().catch(() => null) as {data?: unknown} | null
        if (body?.data === null) return {outcome: 'empty'}
        const candidate = parseTicketQueueCandidate(body)
        return candidate ? {outcome: 'candidate', candidate} : {outcome: 'error'}
      } catch {
        return {outcome: 'error'}
      }
    },

    async deferTicketQueue(req) {
      if (!opHeaders) return false
      // A missing or empty `host_id` means a certain 403 server-side: better not to spend a request.
      if (!nonEmpty(req.selection_token) || !nonEmpty(req.host_id)) return false
      try {
        // 201 on the first registration, 200 on the replay of the same digest: both mean
        // "the server has taken charge of the wait", so `res.ok` applies and not a specific code.
        const res = await fetchFn(`${base}/api/v1/ticket_queue/deferrals`, {
          method: 'POST',
          headers: opHeaders,
          body: JSON.stringify(req),
          signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
        })
        return res.ok
      } catch {
        return false
      }
    },

    async claimTicketQueue(req) {
      if (!opHeaders) return {outcome: 'error', lease: null}
      try {
        // Host-first (CYAU-84/86): flattened claim and host-scoped client — no agent_id (authority = host-bound
        // token + selection_token signed host+execution_phase+profile_digest).
        const res = await fetchFn(`${base}/api/v1/ticket_queue/claims`, {
          method: 'POST', headers: opHeaders, body: JSON.stringify(req), signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
        })
        const body = await res.json().catch(() => null)
        const lease = parseLease(body)
        // CYAU-120: the HTTP status and the server code are kept UP TO THE CALLER, as in
        // `deliverAttempt` (CYAU-105). Without them, a `403 R403-AGENT-006` — the host deemed not eligible — is
        // indistinguishable from an unreachable server: opposite remedies, same log line. The code is
        // omitted when the body carries none: `undefined` means "the server did not say".
        const code = errorCode(body)
        const seen = {status: res.status, ...(code ? {serverCode: code} : {})}
        if (res.ok) {
          return lease?.attempt_id
            ? {outcome: 'acquired', lease: lease as Lease & {attempt_id: string}}
            : {outcome: 'error', lease: null, ...seen}
        }

        if (res.status === 409 && code === 'R409-QUEUE-001') return {outcome: 'stale', lease, ...seen}
        if (res.status === 409 && code === 'R409-LEASE-001') return {outcome: 'held', lease, ...seen}
        if (res.status === 422) return {outcome: 'invalid', lease, ...seen}
        return {outcome: 'error', lease, ...seen}
      } catch {
        return {outcome: 'error', lease: null}
      }
    },

    // Atomic claim (CYAU-169): a single round instead of snapshot + claim, so two concurrent claims
    // on the same queue get DIFFERENT tickets (the server picks under lock). The claim and the
    // candidate travel together: whoever skips the preflight never saw the snapshot and without it would not work.
    // An incomplete 2xx is a rejection, not a half claim — the lease would stay taken without knowing on what.
    async claimNextTicket(req) {
      if (!opHeaders) return {outcome: 'error'}
      try {
        const res = await fetchFn(`${base}/api/v1/ticket_queue/next_claim`, {
          method: 'POST', headers: opHeaders, body: JSON.stringify(req), signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
        })
        const body = await res.json().catch(() => null)
        const code = errorCode(body)
        if (!res.ok) return {outcome: 'rejected', status: res.status, ...(code ? {serverCode: code} : {})}
        const data = (body as {data?: unknown} | null)?.data
        // `data: null` is the same shape with which the preflight says "no work": drained queue, not a failure.
        if (data === null) return {outcome: 'empty'}
        const lease = parseLease(body)
        const candidate = parseCandidate((data as {candidate?: unknown} | null)?.candidate, 'absent')
        if (!lease?.attempt_id || !candidate) {
          // The claim is unusable but the ticket was already taken: if the response says at least which one, it is
          // given back immediately. Leaving it occupied until expiry because of a server error would mean the
          // queue stuck on a ticket nobody is working on.
          if (lease?.ticket) {
            await releaseHeldLease({ticket: lease.ticket, host_id: req.host_id, run_id: req.run_id}).catch(() => false)
          }
          return {outcome: 'rejected', status: res.status, ...(code ? {serverCode: code} : {})}
        }
        return {outcome: 'claimed', lease: lease as Lease & {attempt_id: string}, candidate}
      } catch {
        return {outcome: 'error'}
      }
    },

    // Host-scoped result delivery. The HTTP status is kept UP TO THE CALLER (CYAU-105) because it is
    // the only information that says what to do: a 422 is a schema to fix, a 409 a lease no longer
    // ours, a 401 a credential to rotate, a 5xx/timeout an attempt whose outcome is unknown. The
    // server code (`errorCode`) is read as in `claimTicketQueue`, the single interpretation of the contract.
    async deliverAttempt(attemptId, payload) {
      if (!opHeaders) return {outcome: 'unavailable'}
      try {
        const res = await fetchFn(`${base}/api/v1/agent_attempts/${encodeURIComponent(attemptId)}/result`, {
          method: 'PUT', headers: opHeaders, body: JSON.stringify(payload), signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
        })
        // The response already carries the server's decision on the attempt, and until now it was thrown away without
        // reading it: the machine wrote "concluded" because the connection had answered, not because
        // the server had said so. Today the two coincide — the server closes the attempt at the
        // same instant it accepts — but by luck, not by check. They will stop coinciding
        // the day the server answers "accepted, still looking".
        //
        // An unreadable body does not affect the delivery outcome: the detail is lost, and the reader
        // will know it, instead of being told a conclusion nobody declared.
        if (res.ok) return {outcome: 'ok', status: res.status, attempt: await deliveredAttemptState(res)}
        if (res.status === 401) return {outcome: 'unauthorized', status: res.status}
        if (res.status === 403) return {outcome: 'forbidden', status: res.status}
        // 5xx: the server did not decide on the merits → undetermined, not a rejection. The body is not read
        // (an error page is not the contract): only the status remains.
        if (res.status >= 500) return {outcome: 'unavailable', status: res.status}
        const code = errorCode(await res.json().catch(() => null))
        return code ? {outcome: 'rejected', status: res.status, code} : {outcome: 'rejected', status: res.status}
      } catch {
        return {outcome: 'unavailable'}
      }
    },

    async registerHost(reg) {
      const result = await registerHostResult(reg)
      return result.outcome === 'ok' ? result.value : null
    },

    // Atomic acquisition: the server grants the lease to ONE host only (uniqueness constraint). The HTTP status
    // distinguishes the outcomes — 2xx acquired, 409 conflict, other/network undetermined. On 409 compare the holder:
    // if the lease is already OURS (same host_id + run_id) it is an idempotent retry (acquisition succeeded, response
    // lost) → acquired; otherwise another one holds it → held. Host-scoped (opHeaders): lease bound to the host identity.
    async acquireLease(req) {
      if (!opHeaders) return {outcome: 'error', lease: null}
      try {
        const res = await fetchFn(`${base}/api/v1/leases`, {
          method: 'POST',
          headers: opHeaders,
          body: JSON.stringify(req),
          signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
        })
        if (res.ok) return {outcome: 'acquired', lease: parseLease(await res.json().catch(() => null))}
        if (res.status === 409) {
          const lease = parseLease(await res.json().catch(() => null))
          // The existing lease is ours (same host + same run) → we had already acquired it.
          if (lease && lease.host_id === req.host_id && lease.run_id === req.run_id) return {outcome: 'acquired', lease}
          return {outcome: 'held', lease}
        }

        return {outcome: 'error', lease: null}
      } catch {
        return {outcome: 'error', lease: null}
      }
    },

    // Idempotent release: 2xx or 404 (lease already expired/released) → true; any other outcome → false
    // (best-effort, like postRun). The ticket goes in the path encoded so as not to produce an ambiguous URL segment.
    releaseLease: releaseHeldLease,

    // Host-scoped renewal: the server extends the expiry ONLY if we remain the holder (owner unchanged)
    // and with its own clock. The HTTP status distinguishes the outcomes — 2xx renewed, 409 lost (other host), 404
    // expired/missing, other/network undetermined. Best-effort like the other calls of the automator channel.
    async renewLease(req, signal) {
      if (!opHeaders) return {outcome: 'error', lease: null}
      try {
        const res = await fetchFn(`${base}/api/v1/leases/${encodeURIComponent(req.ticket)}/renew`, {
          method: 'POST',
          headers: opHeaders,
          body: JSON.stringify(req),
          signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(REQUEST_TIMEOUT_MS)]) : AbortSignal.timeout(REQUEST_TIMEOUT_MS),
        })
        if (res.ok) return {outcome: 'renewed', lease: parseLease(await res.json().catch(() => null))}
        if (res.status === 409) return {outcome: 'held', lease: parseLease(await res.json().catch(() => null))}
        if (res.status === 404) return {outcome: 'expired', lease: null}
        return {outcome: 'error', lease: null}
      } catch {
        return {outcome: 'error', lease: null}
      }
    },
  }
}
