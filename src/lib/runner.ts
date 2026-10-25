import * as fs from 'node:fs'
import {type Action, type Playbook} from './schema'
import {selectDue} from './scheduler'
import {quarantineCorruptState, readState, type RunStatus, saveState, updateAction} from './state'
import {type RunResult, type SpawnFn} from './executor'
import {claudeSessionCostUsd, composeRetryRun} from './claude'
import {sessionCostUsd} from './session-cost'
import {CLAUDE_MODEL, CODEX_MODEL} from './models'
import {type AgentRuntime, ClaudeRuntime, CodexRuntime, SpawnRuntime} from './runtime'
import {type AgentRunResult, normalizeAgentResult} from './agent-result'
import {acquire, type IsAlive, release} from './lock'
import {appendLogFooter, boundedExcerpt, prune} from './logger'
import {type SecretCapabilities} from './env-capabilities'
import {type GithubTokenFetcher} from './github-token'
import {ErrorCodes} from '../errors/error-codes'
import {observedHeadSha} from './ticket-delivery'
import {
  type TicketRunAfterResult,
  type TicketRunLifecycle,
  type WorkflowDeliveryVerification,
  testSlotFor,
} from './ticket-cycle'
import {
  type AttemptDelivery,
  type AttemptDeliveryResult,
  type ClaimedTicketCandidate,
  type Lease,
  type QueueDeferralReason,
} from './client'
import {buildWorkflowReviewPrompt, parseWorkflowResultDetailed, parseWorkflowReview} from './typed-workflow'
import {runOpencodeResultReview} from './review-execution'
import {type ReviewerId} from './route'
import {HOST_SYNTHETIC_REVIEW_SUMMARY, syntheticBlockedResult} from './unparsable-result'
import {type ExecutionPhase} from './phase-profile'
import {resolveFlowConcurrency, runFlowPool} from './flow-engine'
import {type PreflightStop} from './heartbeat'
import {skillsModeEnabled} from './paths'
import {describeRuntimeFailure} from './runtime-failure'
import {agentRuntimeReadiness} from './runtime-probe'
import {redactSecrets} from './secret-redaction'
import {type ReviewMode} from './review'

// runOnce(): a single iteration, shared by `tick` (one-shot) and `daemon` (loop).
// Takes the lock (skip if already held), seeds the baselines, runs the due actions in sequence,
// persists the state, prunes old logs, sends the heartbeat.

const DEFAULT_RETENTION_DAYS = 14

/** Callback to report a run's outcome to CloseYourIt (API-driven sync). The normalized contract is
 * authoritative; the raw result stays available only for compatibility of the server output field. */

export type ActionPreflightState = 'ready' | 'waiting' | 'blocked'

/**
 * Intent to defer the queue candidate (CYAU-101). The preflight DECLARES it when it stops
 * already holding a signed selection; the runner executes it. Without it, the head ticket stays there and
 * every tick fishes it out again: a single unworkable ticket stops the project's whole queue.
 */
export interface QueueDeferralIntent {
  selectionToken: string
  reason: QueueDeferralReason
}

/**
 * ATOMIC claim already done (CYAU-169): the dispatch asked the server for work, which picked the
 * candidate and claimed the lease in the same transaction. The preflight receives it this way — lease in hand BEFORE
 * the local gates — and therefore has one more duty compared to the two-step path: if it does not admit, the ticket
 * must be given back (`release`), because the server rejects a deferral on a ticket under lease.
 */
export interface TicketQueueClaim {
  candidate: ClaimedTicketCandidate
  lease: Lease & {attempt_id: string}
  /** The run identity with which the lease was taken: renewal and release must use the same. */
  runId: string
  /** Gives the ticket back to the queue. Best-effort and idempotent: a missed release expires by itself server-side. */
  release(): Promise<void>
}

/**
 * The outcome of the work request to the queue, as it reaches the preflight from the dispatch. `rejected` carries the
 * reason ALREADY readable (status + server code) because whoever talked to the server knows it; `error`
 * is the network's silence, which has a different remedy and must not be confused with a rejection.
 */
export type QueueClaimOutcome =
  | {outcome: 'claimed'; claim: TicketQueueClaim}
  | {outcome: 'empty'}
  | {outcome: 'rejected'; detail: string}
  | {outcome: 'error'}
  /**
   * No work was even requested: this machine is not able to run it (skill bundle missing,
   * write confinement not attested). On the atomic path the request itself marks the phase as
   * started server-side, so asking for it without being able to run it would burn a ticket every round.
   */
  | {outcome: 'unready'; detail: string}

export interface ActionPreflightDecision {
  outcome: 'admit' | 'stop'
  state: ActionPreflightState
  reason: string
  audit: unknown
  /** Present only on stops that already have a queue candidate: without a selection there is nothing to defer. */
  queueDeferral?: QueueDeferralIntent
  /**
   * `true` when the gate has taken over the lease of the atomic claim (CYAU-169): from there the
   * release is its own — together with the local lease record — and the dispatch must not redo it. Missing/`false`: the
   * ticket still belongs to the dispatch, which gives it back if it does not get to work on it.
   */
  queueClaimAdopted?: boolean
  /** Action enriched by the preflight (e.g. ticket detail + Guidance in the prompt), never used on stop. */
  action?: Action
  /** Distributed lease already acquired by the preflight. The runner renews it during the runtime and always releases it. */
  executionLease?: ActionExecutionLease
  /** Attested workspace and durable state of the ticket run. */
  ticketRun?: TicketRunLifecycle
  workflowDelivery?: WorkflowDelivery
  /** Per-ticket counter already incremented by the preflight (CYAU-155): the real session spend arrives here. */
  ticketAttempt?: TicketAttemptSink
}

/**
 * The channel through which the runner hands the per-ticket counter what only it sees: the output of the session
 * just ended, from which its cost is read (CYAU-155). Interpreting the format is NOT the runner's job —
 * here the raw stdout passes and whoever keeps the counter decides whether it yields a cost or nothing.
 */
export interface TicketAttemptSink {
  recordSessionCost(stdout: string): void
}

export interface WorkflowDelivery {
  // Host-first (CYAU-87): the PHASE signed in the claim determines the result schema and the reviewer, not the catalog
  // `command` (not authoritative).
  executionPhase: ExecutionPhase
  attemptId: string
  /**
   * CYAU-192 — the code of the claimed ticket, the one the contract requires on every result. It is needed by the
   * synthetic `blocked` the host delivers in place of an uninterpretable result: without a code
   * no conforming result can be built, and the delivery does not start (`not-attempted`).
   */
  ticketCode?: string
  /** CYRA-921 — `same`: the implementer's engine reviews in a new session. Missing = `cross`. */
  reviewMode?: ReviewMode
  /** CYAU-226 — the reviewing engine by name, from the server. Wins over `reviewMode` when present. */
  reviewer?: ReviewerId
  /** CYAU-228 — the OpenRouter model OpenCode reviews with. */
  reviewerModel?: string
  deliver(payload: AttemptDelivery): Promise<AttemptDeliveryResult>
  /** Authoritative CI gate run after the parse and before spending the cross-review. */
  verify?(result: Record<string, unknown>, signal?: AbortSignal): Promise<WorkflowDeliveryVerification>
  /** Promotes the draft PR only after green CI and cross-review, re-attesting the SHA. */
  finalize?(result: Record<string, unknown>, verifiedSha: string, signal?: AbortSignal): Promise<WorkflowDeliveryVerification>
  /** Brings a red CI back to the implementer cycle without delivering the result to the server. */
  afterVerificationFailure?(summary: string): Promise<TicketRunAfterResult>
  /** Closes the local state only after the server has accepted the delivery. */
  afterAccepted?(): Promise<TicketRunAfterResult>
  /**
   * CYAU-176 — the review that opens the real diff. Present only where the phase writes to the repository AND the
   * server asked for `diff` depth. When present, it REPLACES the session that received only the
   * report: there were two reads and the one that counted was from whoever had seen nothing.
   */
  reviewOnDiff?(result: Record<string, unknown>, signal?: AbortSignal): Promise<AttemptDelivery['review']>
}

/**
 * Record of what happened to the result delivery (CYAU-105).
 *
 * Before, there was only an `errorCode` on the action result, and the branch in which the delivery does not start
 * at all exited without writing anything: from outside a mute run was indistinguishable from a successful one.
 * This record travels in `ExecutedAction`, is printed by the daemon and appended to the action log.
 */
/**
 * The attempt states the server considers CONCLUDED. Only one, today: it is the only outcome an
 * accepted response can carry (`deliver.rb`). Deliberately an allowlist and not a
 * denylist: a new server value falls among the non-concluded ones, which is the safe bucket.
 */
const CONCLUDED_ATTEMPT_STATUSES = new Set(['approved'])

export interface DeliveryRecord {
  phase: ExecutionPhase
  attemptId: string
  /**
   * - ok: delivered and accepted. Since CYAU-192 also for an UNINTERPRETABLE result: the host delivers a
   *   synthetic `blocked` with the reason, and `errorCode` stays C422-WORKFLOW-001 to state the local cause.
   * - not-attempted: no PUT — the result is not interpretable and there is no ticket code with which to
   *   build the synthetic `blocked` (outside the queue).
   * - rejected: the server rejected it on the merits, or the cross-review did not approve.
   * - unauthorized/forbidden/unavailable: like `AttemptDeliveryResult` (credential, revocation, undetermined).
   */
  outcome: 'ok' | 'not-attempted' | 'rejected' | 'unauthorized' | 'forbidden' | 'unavailable'
  errorCode: string | null
  httpStatus?: number
  /** Server `R…` code, when the response exposes it: it says WHY it rejected. */
  serverErrorCode?: string
  reviewStatus: 'accepted' | 'changes_requested' | 'unavailable'
  /** Reason for an unavailable review, already cleaned of secrets. */
  reviewDetail?: string
  /**
   * CYAU-171 — what the SERVER said about the attempt, not what the machine inferred from the
   * fact that the connection answered. Missing when the response did not carry it or was not readable.
   */
  attemptStatus?: string
  /**
   * The attempt is CONCLUDED according to the server. An allowlist of a single value, the opposite
   * of what would come naturally: "concluded" is written only in front of a precise word, and any other
   * response — including those that do not exist yet today — ends up among the non-concluded. So the
   * day the server learns to say "accepted, still looking", the machine will handle it
   * correctly right away, without waiting for its own update.
   */
  concluded: boolean
  stdoutBytes: number
  stdoutTruncated: boolean
  /** `false` = not even the log succeeded: never a silence, the daemon prints it. */
  logAppended: boolean
}

export interface ActionExecutionLease {
  /** Renewal interval, always lower than the server-side TTL. */
  renewEveryMs: number
  /** Dedicated deadline of the single call, lower than the margin left before the TTL. */
  renewTimeoutMs?: number
  /** true only if the server attests the lease is still ours; false/throw interrupts the runtime. */
  renew(signal?: AbortSignal): Promise<boolean>
  /** Best-effort and idempotent release; it must also stop the locally persisted renewal. */
  release(): Promise<void>
}
export interface TicketQueueTarget {
  // Host-first (CYAU-90): the queue target carries ONLY the claim's project/repository attestation. Phase, profile,
  // TTL and attempt all come from the server candidate (getTicketQueue) — never from the agent. A single target per
  // project (dedup in materialize): the host claims the next ready phase, without per-agent fan-out. The legacy
  // agentId/command/timeoutSeconds fields were inert on the host-first path and have been removed.
  projectKey: string
  repository: string
}
export interface ActionPreflightContext {
  playbookDir: string
  authorizedCwd?: string
  signal?: AbortSignal
  /** Trusted metadata from the sync, separate from the materialized action and never controlled by the remote prompt. */
  ticketQueue?: TicketQueueTarget
  /**
   * The outcome of the work request to the queue, when it is the DISPATCH asking (CYAU-169): the atomic claim
   * delivers candidate and lease together, so two concurrent requests on the same queue take different tickets.
   * Missing = two-step path, where the preflight reads the head of the queue and claims it.
   */
  queueClaim?: QueueClaimOutcome
}
export type ActionPreflightFn = (
  name: string,
  action: Action,
  context: ActionPreflightContext,
) => Promise<ActionPreflightDecision> | ActionPreflightDecision

export interface RunOnceOptions {
  playbook: Playbook
  playbookDir: string
  now: Date
  stateFile: string
  logDir: string
  lockFile: string
  label?: string
  retentionDays?: number
  spawn?: SpawnFn
  secrets?: SecretCapabilities
  isAlive?: IsAlive
  clock?: () => number
  /** Cooperative cancellation (daemon shutdown): propagated to the runtimes; an abort terminates the running
   *  action (SIGTERM→SIGKILL) and records it with outcome `cancelled`, then skips the remaining actions. */
  signal?: AbortSignal
  /** Heartbeat to CloseYourIt: `ok=false` if at least one action failed (Phase 4). `stops` carries this round's
   *  preflight stops (CYAU-116) so the reason for the last block reaches the panel with the beat. */
  heartbeat?: (ok: boolean, stops?: PreflightStop[]) => Promise<void>
  /** Injectable state writer to verify the fail-closed durability boundary. */
  persistState?: typeof saveState
  /** Runtime for non-claude/shell actions (default `SpawnRuntime`): abstracts the provider behind the common contract. */
  runtime?: AgentRuntime
  /** Runtime for claude actions (default `ClaudeRuntime`): guardrail gate + claude output interpretation. */
  claudeRuntime?: AgentRuntime
  /** Runtime for codex actions (default `CodexRuntime`): sandboxed `codex exec`, outcome via exit code. */
  codexRuntime?: AgentRuntime
  authorizedCwds?: Record<string, string>
  ticketQueues?: Record<string, TicketQueueTarget>
  /** Ticket-level gate run immediately before the runtime. Every stop is recorded and does not start the action. */
  preflight?: ActionPreflightFn
  /**
   * Executes the deferral intent declared by a preflight stop (CYAU-101). BEST-EFFORT: the outcome does not
   * change the stop nor the rest of the tick — a missed defer offers the ticket again at the next round, which is the
   * current state. Missing = channel not configured: the stops stay as they are and the queue does not advance.
   */
  deferQueue?: (intent: QueueDeferralIntent) => Promise<boolean>
  /**
   * Asks a project's queue for work with the ATOMIC claim (CYAU-169): the server picks the
   * candidate and claims the lease in a single transaction, so concurrent requests on the same queue
   * take DIFFERENT tickets. It is what makes the `max_parallel` cap real even with a single project.
   * Missing = channel not configured: the dispatch stays the two-step one, where the preflight reads
   * the head of the queue and claims it (and a single queue occupies a single slot per round).
   */
  claimQueue?: (target: TicketQueueTarget) => Promise<QueueClaimOutcome>
  /**
   * CYAU-248 — asks the server for the GitHub token of the claimed ticket, before each of its sessions.
   * Missing or refused = the session runs without one (the push then fails as it would anyway).
   */
  githubToken?: GithubTokenFetcher
  /**
   * Skill-mode (CYAU-69): with `true` the dispatch of the due actions uses the bounded `runFlowPool` pool (PER-STEP
   * concurrency, cap = `resolveFlowConcurrency(flowMaxParallel)`); with `false` the unchanged inline SERIAL path
   * stays (prompt mode). Default = `skillsModeEnabled()` (env `AUTOMATOR_SKILLS_ENABLED`, off by default →
   * additive). Injectable for tests (deterministic, without touching the env).
   */
  skillsMode?: boolean
  /**
   * Per-step concurrency cap in skill-mode = `limits.max_parallel` (authoritative). An already resolved number or
   * a resolver invoked ONLY in skill-mode (avoids policy calls in prompt mode). `undefined`/error → cap 1
   * (serial, fail-closed: never unlimited). Ignored when `skillsMode` is false.
   */
  flowMaxParallel?: number | (() => number | undefined | Promise<number | undefined>)
}

export interface ExecutedAction {
  name: string
  status: RunStatus
  errorCode: string | null
  durationMs: number
  logPath: string
  /** Uniform and validated run outcome (same schema for every runtime): the "recorded" result. */
  result: AgentRunResult
  /** Present only for actions with a host-first delivery: how it went (CYAU-105). */
  delivery?: DeliveryRecord
}

export interface RunOnceResult {
  skipped: boolean // lock held by another live process
  executed: ExecutedAction[]
  seeded: string[]
  scheduleErrors: Array<{name: string; message: string}>
  pruned: number
  /** Path of the state file quarantined because corrupt/partial (preserved, never overwritten), or
   *  `null` if the state was intact. The cycle restarts from an empty state without losing the previous file. */
  stateQuarantined: string | null
  /** Actions stopped by the preflight, with state/reason/audit; they do not count as executed. */
  preflightStopped: Array<{name: string; state: ActionPreflightState; reason: string; audit: unknown}>
  /**
   * Skill-mode pool steps ended with an exception (CYAU-105). `runFlowPool` catches every throw of
   * `runStep` into a `failed` disposition so as not to bring down the pool, but its return was discarded: a
   * dispatch failure was thus invisible both in the result and in the log. On the serial path it stays empty
   * (there a throw goes up to the caller).
   */
  flowFailures: Array<{name: string; detail: string}>
}

/** Filesystem-safe timestamp for the quarantine file name (the ISO `:`/`.` are not portable). */
function quarantineStamp(now: Date): string {
  return now.toISOString().replace(/[:.]/g, '-')
}

function auditHasTechnicalFailure(audit: unknown): boolean {
  return Array.isArray(audit) && audit.some((entry) =>
    typeof entry === 'object' && entry !== null && (entry as {state?: unknown}).state === 'failed',
  )
}

/** How much uninterpretable output ends up in the action log: enough to recognize its shape. */
// CYAU-186 — how much of the unreadable result ends up in the log. High on purpose: 4096 kept
// head and tail and threw away the MIDDLE, which on a delivery result is the work report —
// that is, the only part that explains why it was rejected. Seen live on 30/08: 5901 characters of
// result, 1805 gone from the middle, cause not determinable on a run that had done the
// work and opened the proposal.
//
// Cutting a structured text in half is moreover the worst cut: it breaks the shape and makes
// it impossible to rebuild the rest from what remains.
//
// The cap stays, and the reason it exists does not change: a megabyte of stdout in every log at
// every failure helps nobody. But a real result fits in a few tens of thousands of
// characters — the largest seen in production is 19 KB — so with this limit it fits WHOLE, and
// the cut goes back to concerning only the pathological case it was designed for.
export const UNPARSABLE_EXCERPT_CHARS = 262_144
/** CYAU-192 — cap of the `issues` line in the footer: the zod issues quote the received values, and a pathological
 * output produces dozens of them; the full excerpt is already in the delimited block below. */
export const ISSUES_FOOTER_CHARS = 4096

/**
 * CYAU-187 — does the result declare changes to review?
 *
 * Only `blocked` declares none: the agent stopped without touching anything. Listing that instead of
 * listing `delivered` is the prudent choice: a new state that writes code goes through the full review
 * without anyone having to remember it. CYRA-1004 — `already-delivered` is reviewed on the diff too: its
 * commits sit in the ticket's working copy and the earlier diff review may never have happened.
 */
const STATI_SENZA_DIFF = new Set(['blocked'])

export function hasDiffToReview(result: Record<string, unknown>): boolean {
  const state = result.state
  return typeof state !== 'string' || !STATI_SENZA_DIFF.has(state)
}

/**
 * Composes the `DeliveryRecord` and writes it into the action log (CYAU-105).
 *
 * The `runAction` footer has already been written when we get here, and declares the PROCESS outcome; this
 * appends the DELIVERY outcome, which is what matters to know whether the run ended up
 * somewhere. The record is returned even when the write fails (`logAppended: false`), so the
 * daemon can say so: a log mute about being mute would be the same failure as before.
 */
/**
 * CYRA-872 — cost and model of the attempt for the delivery. The cost is the Claude spend already summed plus that
 * of the session just ended (which is summed after the delivery); for Codex, or if no session declares it, there is none.
 */
function deliveryUsage(
  runtime: 'claude' | 'codex', model: string | undefined, knownCost: number | null, currentStdout: string,
): Pick<AttemptDelivery, 'cost_usd' | 'model'> {
  const usage = {model: model ?? (runtime === 'claude' ? CLAUDE_MODEL : CODEX_MODEL)}
  if (runtime !== 'claude') return usage
  const current = claudeSessionCostUsd(currentStdout)
  const cost = current === null ? knownCost : (knownCost ?? 0) + current
  return cost === null ? usage : {...usage, cost_usd: cost}
}

function recordDelivery(
  delivery: {executionPhase: ExecutionPhase; attemptId: string},
  fields: {
    outcome: DeliveryRecord['outcome']
    errorCode: string | null
    reviewStatus: DeliveryRecord['reviewStatus']
    reviewDetail?: string
    attemptStatus?: string
    raw: RunResult
    httpStatus?: number
    serverErrorCode?: string
    excerpt?: {label: string; text: string}
    /** CYAU-192 — the parse issues, one line in the footer: WHY it was not interpretable. */
    issues?: string[]
    /** CYAU-192 — the delivered result was composed by the host, not the session. */
    syntheticResult?: string
  },
): DeliveryRecord {
  const {raw, excerpt, issues, syntheticResult, ...rest} = fields
  const record = {
    phase: delivery.executionPhase,
    attemptId: delivery.attemptId,
    ...rest,
    concluded: CONCLUDED_ATTEMPT_STATUSES.has(fields.attemptStatus ?? ''),
    stdoutBytes: Buffer.byteLength(raw.stdout),
    stdoutTruncated: raw.stdoutTruncated,
  }
  const logAppended = appendLogFooter(raw.logPath, {
    delivery: record.outcome,
    phase: record.phase,
    attempt_id: record.attemptId,
    error_code: record.errorCode ?? '-',
    http_status: record.httpStatus ?? '-',
    server_error_code: record.serverErrorCode ?? '-',
    review_status: record.reviewStatus,
    // Three possible lines instead of one. "Concluded" only when the server says so in its own words;
    // "accepted, outcome not yet decided" in all other cases; "delivered, outcome not read"
    // when the response arrived but was not readable — and that one also says nobody is needed.
    attempt_status: record.attemptStatus ?? (record.outcome === 'ok' ? 'non letto' : '-'),
    concluded: record.concluded,
    stdout_bytes: record.stdoutBytes,
    stdout_truncated: record.stdoutTruncated,
    ...(issues ? {issues: boundedLine(issues.join(' | '), ISSUES_FOOTER_CHARS)} : {}),
    ...(syntheticResult ? {synthetic_result: syntheticResult} : {}),
  }, excerpt)
  return {...record, logAppended}
}

/** A line with a cap and an explicit cut marker: the reader knows a piece is missing. */
function boundedLine(text: string, maxChars: number): string {
  if (text.length <= maxChars) return text
  const omitted = text.length - maxChars
  return `${text.slice(0, maxChars)} … [${omitted} caratteri omessi]`
}

/** Re-attests the ownership (bounded) right before the spawn: an old claim does not authorize a new runtime. */
async function attestExecutionLease(lease: ActionExecutionLease, signal?: AbortSignal): Promise<boolean> {
  if (signal?.aborted) return false
  const controller = new AbortController()
  const timeoutMs = Math.max(1, Math.floor(lease.renewTimeoutMs ?? lease.renewEveryMs))
  let timeout: ReturnType<typeof setTimeout> | undefined
  let onAbort: (() => void) | undefined
  try {
    const deadline = new Promise<boolean>((resolve) => {
      timeout = setTimeout(() => {
        controller.abort()
        resolve(false)
      }, timeoutMs)
      timeout.unref?.()
    })
    const aborted = new Promise<boolean>((resolve) => {
      if (!signal) return
      onAbort = () => {
        controller.abort()
        resolve(false)
      }
      signal.addEventListener('abort', onAbort, {once: true})
    })
    return await Promise.race([
      lease.renew(controller.signal).catch(() => false),
      deadline,
      aborted,
    ])
  } catch {
    return false
  } finally {
    if (timeout) clearTimeout(timeout)
    if (onAbort) signal?.removeEventListener('abort', onAbort)
  }
}

/** Runs the runtime under lease, renews before expiry and cancels as soon as the ownership is not attested. */
async function executeRuntime(
  runtime: AgentRuntime,
  name: string,
  action: Action,
  context: Parameters<AgentRuntime['execute']>[2],
  lease?: ActionExecutionLease,
  finalize?: (result: RunResult, signal: AbortSignal | undefined, leaseLost: () => boolean) => Promise<void>,
): Promise<{result: RunResult; leaseLost: boolean}> {
  if (!lease) {
    const result = await runtime.execute(name, action, context).result
    await finalize?.(result, context.signal, () => false)
    return {result, leaseLost: false}
  }

  let execution: ReturnType<AgentRuntime['execute']> | undefined
  let timer: ReturnType<typeof setTimeout> | undefined
  let stopping = false
  let runtimeDone = false
  let leaseLost = false
  let renewal: Promise<void> | undefined
  let renewalController: AbortController | undefined
  const leaseAbort = new AbortController()
  const effectiveController = new AbortController()
  const abortEffective = (): void => effectiveController.abort()
  const combinedSignals = context.signal ? [context.signal, leaseAbort.signal] : [leaseAbort.signal]
  for (const signal of combinedSignals) {
    if (signal.aborted) abortEffective()
    else signal.addEventListener('abort', abortEffective, {once: true})
  }
  const effectiveSignal = effectiveController.signal
  const effectiveContext = {...context, signal: effectiveSignal}
  let stopRenewal: (() => void) | undefined
  const loseLease = (): void => {
    if (stopping || leaseLost) return
    leaseLost = true
    leaseAbort.abort()
    execution?.cancel()
  }
  const scheduleRenewal = (): void => {
    timer = setTimeout(() => {
      renewal = (async () => {
        const controller = new AbortController()
        renewalController = controller
        const timeoutMs = Math.max(1, Math.floor(lease.renewTimeoutMs ?? lease.renewEveryMs))
        let timeout: ReturnType<typeof setTimeout> | undefined
        let stopCurrent!: () => void
        const stopped = new Promise<boolean>((resolve) => { stopCurrent = () => resolve(false) })
        stopRenewal = stopCurrent
        let held = false
        try {
          const deadline = new Promise<boolean>((resolve) => {
            timeout = setTimeout(() => {
              controller.abort()
              resolve(false)
            }, timeoutMs)
            timeout.unref?.()
          })
          held = await Promise.race([
            lease.renew(controller.signal).catch(() => false),
            deadline,
            stopped,
          ])
        } catch {
          held = false
        } finally {
          if (timeout) clearTimeout(timeout)
          if (renewalController === controller) renewalController = undefined
          if (stopRenewal === stopCurrent) stopRenewal = undefined
        }
        // A shutdown is not a lease loss: the external signal is already the gate that cancels the runtime and forbids
        // the later phases. So do not overwrite its outcome with C409-LEASE-005.
        if (stopping || context.signal?.aborted) return
        if (!held) loseLease()
        else if (!runtimeDone) scheduleRenewal()
      })()
    }, Math.max(1, Math.floor(lease.renewEveryMs)))
    timer.unref?.()
  }

  try {
    execution = runtime.execute(name, action, effectiveContext)
    scheduleRenewal()
    const result = await execution.result
    await finalize?.(result, effectiveSignal, () => leaseLost)
    runtimeDone = true
    // The runtime can end naturally while an already sent renew is about to attest a loss: block new
    // timers but wait (bounded) for the in-flight response. Only the shutdown can abort it without interpreting its outcome,
    // because the external signal prevents any later phase anyway.
    if (timer) clearTimeout(timer)
    if (renewal && !context.signal?.aborted) {
      const abortRenewal = (): void => {
        renewalController?.abort()
        stopRenewal?.()
      }
      context.signal?.addEventListener('abort', abortRenewal, {once: true})
      try {
        // Also covers the window between the check above and the listener registration.
        if (context.signal?.aborted) abortRenewal()
        await renewal
      } finally {
        context.signal?.removeEventListener('abort', abortRenewal)
      }
    }
    return {
      result: leaseLost ? {...result, status: 'failure', errorCode: ErrorCodes.Lease.lost} : result,
      leaseLost,
    }
  } finally {
    for (const signal of combinedSignals) signal.removeEventListener('abort', abortEffective)
    stopping = true
    if (timer) clearTimeout(timer)
    renewalController?.abort()
    stopRenewal?.()
    if (renewal) await renewal.catch(() => undefined)
  }
}

export async function runOnce(opts: RunOnceOptions): Promise<RunOnceResult> {
  const label = opts.label ?? 'automator'
  const persistState = opts.persistState ?? saveState
  if (!acquire(opts.lockFile, label, opts.isAlive)) {
    return {skipped: true, executed: [], seeded: [], scheduleErrors: [], pruned: 0, stateQuarantined: null, preflightStopped: [], flowFailures: []}
  }

  // One runtime per provider: claude actions go through ClaudeRuntime (guardrail gate + is_error), codex
  // actions through CodexRuntime (native sandbox, outcome via exit code), the others through SpawnRuntime. The action type
  // routes — the rest of the cycle is identical. An `opts.runtime` injected without `claudeRuntime`/`codexRuntime` is
  // a GLOBAL override (it also applies to claude/codex): single provider.
  const shellRuntime = opts.runtime ?? new SpawnRuntime()
  const claudeRuntime = opts.claudeRuntime ?? opts.runtime ?? new ClaudeRuntime()
  const codexRuntime = opts.codexRuntime ?? opts.runtime ?? new CodexRuntime()

  try {
    // Corrupt/partial state detection: if the file is not interpretable it is PRESERVED (quarantine)
    // instead of being overwritten with the new state — never lose the checkpoints. The cycle restarts from an empty state.
    const read = readState(opts.stateFile)
    const stateQuarantined = read.corrupt ? quarantineCorruptState(opts.stateFile, quarantineStamp(opts.now)) : null
    const state = read.state
    const selection = selectDue(opts.playbook, state, opts.now)
    const nowIso = opts.now.toISOString()

    for (const {name} of selection.seed) {
      updateAction(state, name, {last_run: nowIso, last_status: 'skipped'})
    }

    const executed: ExecutedAction[] = []
    const preflightStopped: RunOnceResult['preflightStopped'] = []
    const flowFailures: RunOnceResult['flowFailures'] = []
    // A due action to dispatch, plus — on the queues — the claim the pool has already obtained (CYAU-169).
    type DueEntry = (typeof selection.due)[number] & {queueClaim?: QueueClaimOutcome}
    // Queues that have no more work to give for this round: exhausted, or they just delivered a ticket
    // that could not be worked on. It lives here because `dispatchDueEntry` decides it and the pool consults it.
    const closedQueues = new Set<string>()
    // CYAU-69: the processing of ONE due action (preflight → lease → runtime → normalize → save → report),
    // extracted from the body of the serial `for` so the dispatch can compose it both in series (prompt mode,
    // UNCHANGED) and inside `runFlowPool` (skill-mode). Returns 'continue' (move to the next) or 'stop' (stop
    // the dispatch: shutdown or lost lease) — the former `continue`/`break` of the loop. Closes over `executed`/`preflightStopped`/`state`.
    const dispatchDueEntry = async ({name, action, queueClaim}: DueEntry): Promise<'continue' | 'stop'> => {
      // Cancellation (shutdown): skip the actions not yet started. The running action has already been killed
      // by the signal in the executor; here we only avoid starting the next ones. CYAU-169: if the dispatch
      // had already claimed a ticket, it must be given back — nobody will work on it in this round.
      if (opts.signal?.aborted) {
        if (queueClaim?.outcome === 'claimed') await queueClaim.claim.release().catch(() => undefined)
        return 'stop'
      }
      // CYAU-169: the same queue action runs several times in the same round, one per ticket. The log therefore takes
      // the name of the ticket being worked on, otherwise the runs would all write into the same file
      // (same action name, same round instant) and none would be readable any more. The code comes from the
      // server: it enters the file name only for the part that is already a legal file name.
      const claimedTicket = queueClaim?.outcome === 'claimed'
        ? queueClaim.claim.lease.ticket.replace(/[^A-Za-z0-9_-]/g, '')
        : ''
      const logName = claimedTicket ? `${name}-${claimedTicket}` : name
      let effectiveAction = action
      let executionLease: ActionExecutionLease | undefined
      let ticketRun: TicketRunLifecycle | undefined
      let workflowDelivery: WorkflowDelivery | undefined
      let ticketAttempt: TicketAttemptSink | undefined
      let recoveredRetryPrompt: string | undefined
      if (opts.preflight) {
        let decision: ActionPreflightDecision
        try {
          decision = await opts.preflight(name, action, {
            playbookDir: opts.playbookDir,
            authorizedCwd: opts.authorizedCwds?.[name],
            signal: opts.signal,
            ticketQueue: opts.ticketQueues?.[name],
            // CYAU-169: the ticket has already been claimed by the dispatch; the preflight receives it instead of
            // re-reading the head of the queue, and on a stop gives it back.
            ...(queueClaim ? {queueClaim} : {}),
          })
        } catch {
          // The gate blew up without deciding: the stop below gives back the ticket possibly already
          // claimed (the lease cannot have changed hands if the gate did not get to declare it).
          decision = {
            outcome: 'stop',
            state: 'blocked',
            reason: 'preflight non completabile (fail-closed)',
            audit: [{phase: 'preflight', state: 'failed', reason: 'preflight non completabile (fail-closed)'}],
          }
        }
        if (decision.outcome === 'stop') {
          // CYAU-169: the ticket claimed by the dispatch goes back to the queue if it is not worked on. The release belongs
          // to WHOEVER TOOK IT — here — and not to the gate: a gate that did not cooperate (or a path that stops
          // before consulting it) would otherwise leave the ticket occupied until expiry. The exception is
          // the lease already adopted by the gate, which releases it together with its own local record.
          if (queueClaim?.outcome === 'claimed' && !decision.queueClaimAdopted) {
            await queueClaim.claim.release().catch(() => undefined)
          }
          // This queue is not asked for another one in this round. The claim already marked the phase
          // as started server-side, so the released ticket does not go back to the queue by itself (the
          // recovery of interrupted phases reopens it); the planner, which instead stays ready, would be offered again immediately and
          // every resumption would open one more attempt — the same idle loop that the attempt threshold
          // exists to break. At the next round the queue starts clean.
          if (queueClaim) closedQueues.add(name)
          preflightStopped.push({name, state: decision.state, reason: decision.reason, audit: decision.audit})
          // CYAU-101: the unworkable candidate must be put on hold server-side, otherwise at the next tick
          // it goes back to the head of the queue and the whole project stays stuck behind it. Best-effort by contract:
          // a rejection or a network error does not alter the stop just recorded nor stop the later actions.
          if (decision.queueDeferral && opts.deferQueue) {
            await opts.deferQueue(decision.queueDeferral).catch(() => false)
          }
          // The stop is still a scheduled attempt: without this timestamp the action stays continuously
          // overdue and the daemon repeats the preflight at every polling, ignoring the configured cadence.
          updateAction(state, name, {last_run: nowIso, last_status: 'skipped'})
          return 'continue'
        }
        effectiveAction = decision.action ?? action
        executionLease = decision.executionLease
        ticketRun = decision.ticketRun
        workflowDelivery = decision.workflowDelivery
        ticketAttempt = decision.ticketAttempt
      }
      // Shutdown can arrive while the preflight waits for I/O. Do not start a new process after the abort;
      // any lease already acquired must be released explicitly because the runtime will not take charge of it.
      if (opts.signal?.aborted) {
        if (ticketRun) await ticketRun.block().catch(() => undefined)
        if (executionLease) await executionLease.release().catch(() => undefined)
        return 'stop'
      }
      if (ticketRun) {
        if (!executionLease) {
          await ticketRun.block().catch(() => undefined)
          preflightStopped.push({
            name,
            state: 'blocked',
            reason: 'ciclo ticket privo di lease valido (fail-closed)',
            audit: [{phase: 'lease', state: 'failed', reason: 'ciclo ticket privo di lease valido (fail-closed)'}],
          })
          updateAction(state, name, {last_run: nowIso, last_status: 'skipped'})
          return 'continue'
        }
        if (!(await attestExecutionLease(executionLease, opts.signal))) {
          await ticketRun.block().catch(() => undefined)
          await executionLease.release().catch(() => undefined)
          preflightStopped.push({
            name,
            state: 'blocked',
            reason: 'lease ticket non riattestabile prima del runtime (fail-closed)',
            audit: [{phase: 'lease', state: 'failed', reason: 'lease ticket non riattestabile prima del runtime (fail-closed)'}],
          })
          updateAction(state, name, {last_run: nowIso, last_status: 'skipped'})
          return 'continue'
        }
        try {
          let resumed: TicketRunAfterResult | null | undefined
          if (ticketRun.resumeAfterInterruption) {
            const recoveryRuntime: AgentRuntime = {
              id: 'ticket-recovery',
              healthCheck: async () => ({available: true}),
              execute: () => ({
                result: Promise.resolve({
                  status: 'success', exitCode: 0, errorCode: null, durationMs: 0,
                  logPath: '', stdout: '', stdoutTruncated: false,
                }),
                cancel: () => undefined,
              }),
            }
            const recovery = await executeRuntime(recoveryRuntime, name, effectiveAction, {
              playbookDir: opts.playbookDir,
              logDir: opts.logDir,
              logName,
              // CYAU-167 — this run's data space, from the same ticket code as the log.
              testSlot: claimedTicket ? testSlotFor(claimedTicket) : undefined,
              now: opts.now,
              clock: opts.clock,
              signal: opts.signal,
              authorizedCwd: ticketRun.authorizedCwd,
            }, executionLease, async (_raw, recoverySignal) => {
              resumed = await ticketRun?.resumeAfterInterruption?.(recoverySignal)
            })
            if (recovery.leaseLost) {
              await ticketRun.block().catch(() => undefined)
              await executionLease.release().catch(() => undefined)
              preflightStopped.push({
                name,
                state: 'blocked',
                reason: 'lease ticket persa durante il recovery gate/review (fail-closed)',
                audit: [{phase: 'lease', state: 'failed', reason: 'lease ticket persa durante il recovery gate/review (fail-closed)'}],
              })
              updateAction(state, name, {last_run: nowIso, last_status: 'skipped'})
              return 'continue'
            }
          }
          if (resumed?.outcome === 'complete') {
            await executionLease.release().catch(() => undefined)
            const recoveryStatus = resumed.runStatus ?? 'success'
            const recoveryRaw: RunResult = {
              status: recoveryStatus,
              exitCode: recoveryStatus === 'success' ? 0 : 1,
              errorCode: recoveryStatus === 'success' ? null : (resumed.errorCode ?? ErrorCodes.Review.blocked),
              durationMs: 0,
              logPath: '',
              stdout: '',
              stdoutTruncated: false,
            }
            const recoveryResult = normalizeAgentResult({
              runtime: 'ticket-recovery', action: name, result: recoveryRaw,
            })
            updateAction(state, name, {
              last_run: nowIso,
              last_status: recoveryRaw.status,
              last_duration_ms: recoveryRaw.durationMs,
              last_exit_code: recoveryRaw.exitCode,
              last_error_code: recoveryRaw.errorCode,
              last_result: recoveryResult,
            })
            executed.push({
              name,
              status: recoveryRaw.status,
              errorCode: recoveryRaw.errorCode,
              durationMs: recoveryRaw.durationMs,
              logPath: recoveryRaw.logPath,
              result: recoveryResult,
            })
            // Same guarantee as the normal path: the recovery outcome is made durable before continuing.
            persistState(opts.stateFile, state)
            if (recoveryStatus === 'failure') {
              preflightStopped.push({
                name,
                state: 'blocked',
                reason: 'recovery gate/review concluso blocked (fail-closed)',
                audit: [{phase: 'recovery', state: 'failed', reason: 'recovery gate/review concluso blocked (fail-closed)'}],
              })
            }
            return 'continue'
          }
          if (resumed?.outcome === 'retry') {
            if (!resumed.retryPrompt) throw new Error('recovery retry privo di finding strutturati')
            recoveredRetryPrompt = resumed.retryPrompt
          }
          await ticketRun.beforeRuntime()
          // `beforeRuntime` may do I/O: a shutdown arriving during the wait must not reach the spawn.
          if (opts.signal?.aborted) {
            await ticketRun.block().catch(() => undefined)
            await executionLease.release().catch(() => undefined)
            preflightStopped.push({
              name,
              state: 'blocked',
              reason: 'shutdown durante la preparazione ticket: runtime annullato',
              audit: [{phase: 'workspace', state: 'stopped', reason: 'shutdown durante la preparazione ticket: runtime annullato'}],
            })
            updateAction(state, name, {last_run: nowIso, last_status: 'skipped'})
            return 'stop'
          }
          effectiveAction = {...effectiveAction, cwd: ticketRun.authorizedCwd}
        } catch {
          await ticketRun.block().catch(() => undefined)
          await executionLease.release().catch(() => undefined)
          preflightStopped.push({
            name,
            state: 'blocked',
            reason: 'workspace o stato ticket non attestabile prima del runtime (fail-closed)',
            audit: [{phase: 'workspace', state: 'failed', reason: 'workspace o stato ticket non attestabile prima del runtime (fail-closed)'}],
          })
          updateAction(state, name, {last_run: nowIso, last_status: 'skipped'})
          return 'continue'
        }
      }
      // CYAU-155: what EVERY session cost goes on the TICKET's account, not only in the day's budget — the
      // case that opened the ticket (5 dollars burned on work already done by hand) was invisible precisely
      // because nobody summed per ticket. It must be called once per session: with retries (changes_requested)
      // more than one runs, and recording only the last would underestimate exactly the runs that cost the most.
      // Best-effort: the spend is a measurement, not a gate — a counter that cannot be updated invalidates nothing.
      // CYRA-872 — the same spend summed on the attempt, which travels with the delivery.
      let attemptCostUsd: number | null = null
      const chargeSession = (stdout: string): void => {
        const cost = sessionCostUsd(stdout)
        if (cost !== null) attemptCostUsd = (attemptCostUsd ?? 0) + cost
        if (!ticketAttempt) return
        try {
          ticketAttempt.recordSessionCost(stdout)
        } catch {
          // No effect on the outcome: a lost measurement cannot make a successful run fail.
        }
      }
      const runtime = effectiveAction.type === 'claude' ? claudeRuntime : effectiveAction.type === 'codex' ? codexRuntime : shellRuntime
      let execution!: {result: RunResult; leaseLost: boolean}
      let result!: RunResult
      let agentResult!: AgentRunResult
      let deliveryRecord: DeliveryRecord | undefined
      try {
        let retryPrompt = recoveredRetryPrompt ?? ticketRun?.retryPrompt
        const originalRun = effectiveAction.run
        while (true) {
          const attemptAction = retryPrompt
            ? {...effectiveAction, run: composeRetryRun(retryPrompt, originalRun)}
            : effectiveAction
          let lifecycleResult: Awaited<ReturnType<TicketRunLifecycle['afterRuntime']>> | undefined
          // A fresh token per session: it lasts one hour, the same as the phase cap.
          const githubToken = claimedTicket && opts.githubToken ? await opts.githubToken(claimedTicket) : undefined
          execution = await executeRuntime(runtime, name, attemptAction, {
            playbookDir: opts.playbookDir,
            logDir: opts.logDir,
            logName,
            // CYAU-167 — this run's data space, from the same ticket code as the log.
            testSlot: claimedTicket ? testSlotFor(claimedTicket) : undefined,
            now: opts.now,
            spawn: opts.spawn,
            secrets: githubToken ? {...opts.secrets, githubToken} : opts.secrets,
            clock: opts.clock,
            signal: opts.signal,
            authorizedCwd: ticketRun?.authorizedCwd ?? opts.authorizedCwds?.[name],
          }, executionLease, async (raw, lifecycleSignal, leaseLost) => {
            result = raw
            agentResult = normalizeAgentResult({
              runtime: runtime.id,
              action: name,
              result: raw,
              cancelled: leaseLost() || (lifecycleSignal?.aborted ?? false),
            })
            if (ticketRun) lifecycleResult = await ticketRun.afterRuntime(raw, agentResult, lifecycleSignal)
            // The delivery starts ONLY on a successful session. An EXECUTION failure — execution
            // died/timeout/non-zero exit (e.g. the shim that started mise, CYAU-104) — is NOT delivered on
            // purpose: the only outcome the `deliverAttempt` PUT can produce is `review_failed`, which consumes
            // the two-cycle review budget (AGENTS_PHASE_REVIEW_LIMIT) — meant for rejections of a
            // DELIVERED piece of work, not for an execution failure — and would block the phase after two possibly
            // transient failures. The failed attempt is instead closed server-side by the stale fallback
            // (orphaned_at, CYRA-201): the automator releases the lease in the `finally`, the attempt stays without
            // delivery or lease and the periodic round (every 5 min) marks it `stale` — no review budget,
            // phase requeued. Closing it IMMEDIATELY without consuming the budget would require a dedicated
            // execution-failure server outcome (Rails-side follow-up), which the current PUT contract does not offer.
            //
            // An UNINTERPRETABLE output is a different case (CYAU-192): the session ended fine, it is the
            // result format that does not match, and the reason goes on the ticket — see the branch below.
            if (workflowDelivery && effectiveAction.type !== 'shell' && raw.status === 'success' && lifecycleResult?.outcome !== 'retry') {
              const parsedResult = parseWorkflowResultDetailed(raw.stdout, workflowDelivery.executionPhase)
              const structured = parsedResult.value
              // The reviewer is the engine the server names (CYAU-226), on both paths (the diff review is run by the
              // cycle with the same selection). Without a name: the other runtime, or the same one when the machine
              // is set to same-engine review (CYRA-921).
              const reviewerRuntimeId: ReviewerId = workflowDelivery.reviewer ?? (workflowDelivery.reviewMode === 'same'
                ? effectiveAction.type
                : effectiveAction.type === 'claude' ? 'codex' : 'claude')
              if (!structured) {
                // The session ended without a result readable against the phase schema. The local
                // outcome stays a failure with its cause (C422-WORKFLOW-001), and the output excerpt
                // ends up in the action log with the parse issues (CYAU-105).
                //
                // CYAU-192 — but it is NO longer silent. Before, no PUT started from here: the server marked the
                // run "interrupted" after the stall and stopped it after two times, and whoever looked at the
                // ticket knew nothing. The delivery is the only channel to the ticket, so the host
                // delivers a synthetic `blocked` with the reason — `retryable`/`unreachable`, so the server
                // puts the phase back in the queue under its cap — with a review declared by the host:
                // there is no result to review, and paying a reviewer to say so would be a waste.
                // No CI gate nor PR promotion: there is nothing to verify. The local per-ticket
                // cap (`ticket-attempts.ts`) triggers at the next claim as for every session.
                lifecycleResult = {outcome: 'complete', runStatus: 'failure', errorCode: ErrorCodes.Workflow.unparsable}
                const excerpt = {
                  label: `risultato non interpretabile (fase ${workflowDelivery.executionPhase})`,
                  text: boundedExcerpt(raw.stdout, UNPARSABLE_EXCERPT_CHARS),
                }
                const ticketCode = workflowDelivery.ticketCode ?? claimedTicket
                if (!ticketCode) {
                  // Without a ticket code no contract-conforming result can be built: the previous
                  // behaviour remains, and the server's stale fallback closes the attempt.
                  deliveryRecord = recordDelivery(workflowDelivery, {
                    outcome: 'not-attempted', errorCode: ErrorCodes.Workflow.unparsable, reviewStatus: 'unavailable',
                    raw, excerpt, issues: parsedResult.issues,
                  })
                  return
                }
                const synthetic = syntheticBlockedResult({
                  phase: workflowDelivery.executionPhase, code: ticketCode, issues: parsedResult.issues, stdout: raw.stdout,
                })
                const observed = ticketRun ? observedHeadSha(ticketRun.authorizedCwd) : undefined
                const delivered = await workflowDelivery.deliver({
                  runtime: effectiveAction.type,
                  reviewer_runtime: reviewerRuntimeId,
                  result: synthetic,
                  review: {status: 'accepted', depth: 'result', summary: HOST_SYNTHETIC_REVIEW_SUMMARY},
                  ...(observed ? {observed: {head_sha: observed}} : {}),
                  ...deliveryUsage(effectiveAction.type, 'model' in effectiveAction ? effectiveAction.model : undefined,
                                   attemptCostUsd, raw.stdout),
                })
                deliveryRecord = recordDelivery(workflowDelivery, {
                  outcome: delivered.outcome,
                  // The local cause stays C422 when the server accepted: the block IS the result of an
                  // unreadable output. A rejection or a failed transport have their own code, as always.
                  errorCode: delivered.outcome === 'ok'
                    ? ErrorCodes.Workflow.unparsable
                    : delivered.outcome === 'rejected'
                    ? ErrorCodes.Workflow.rejected
                    : ErrorCodes.Workflow.undelivered,
                  reviewStatus: 'accepted',
                  attemptStatus: delivered.outcome === 'ok' ? delivered.attempt?.status : undefined,
                  httpStatus: delivered.status,
                  serverErrorCode: delivered.outcome === 'rejected' ? delivered.code : undefined,
                  raw, excerpt, issues: parsedResult.issues, syntheticResult: 'blocked',
                })
                // The local state is closed as for every accepted delivery; the action outcome stays the
                // failure with its cause, which is what the log and the beat must say.
                if (delivered.outcome === 'ok' && workflowDelivery.afterAccepted) await workflowDelivery.afterAccepted()
                return
              }
              // CYAU-181 — the agent's result proves only that a PR exists, not that the remote suite is
              // green on the delivered commit. The deterministic check precedes the cross-review: a red CI
              // goes back to the implementer without paying a reviewer, while an outage stays distinct from a defect.
              let verifiedSha: string | undefined
              if (workflowDelivery.verify) {
                const verification = await workflowDelivery.verify(structured, lifecycleSignal)
                if (verification.status === 'passed') {
                  verifiedSha = verification.headSha
                } else {
                  if (verification.status === 'failed' && workflowDelivery.afterVerificationFailure) {
                    lifecycleResult = await workflowDelivery.afterVerificationFailure(verification.summary)
                  } else {
                    lifecycleResult = {
                      outcome: 'complete', runStatus: 'failure',
                      errorCode: verification.status === 'failed' ? ErrorCodes.Gate.failed : ErrorCodes.Gate.unavailable,
                    }
                  }
                  return
                }
              }
              // CYAU-176 — who reviews, and on what.
              //
              // Before, a second session always started that received ONLY the report written by the
              // first: a few lines of text, no line of code. Its judgment was the one that reached
              // the server and decided whether the work moved on. It erred in both directions — a
              // crooked piece of work passed because the report was well written, a sound one was rejected because
              // it was terse. And on the two release phases it always happened: they write no code and
              // run no tests, so their report is a few lines, and the reviewer was asked
              // to require the tests run and the files touched — which cannot exist there.
              //
              // Now the depth is decided by the server and travels on the lease. Where it is `diff` the reviewer is whoever
              // really opens the changes, and that single read remains. Where there are no changes to open
              // the session on the report remains, but with criteria asking for what a release can
              // really show.
              let payloadReview: AttemptDelivery['review']
              // The WHY of an unavailable review: without it, the daemon wrote only `review=unavailable`
              // and to find a revoked login one had to open the review log on the server.
              let reviewDetail: string | undefined
              // CYAU-187 — the review OF THE CHANGES is asked only of whoever wrote the
              // changes. Whoever writes the code may conclude there is no code to write (a
              // container ticket) or that the work was already delivered by a previous session: in
              // both cases there is nothing to compare in the working copy, the diff review
              // comes back as not runnable and the delivery is rejected — that is, the agent's correct
              // judgment never reaches the server, and the ticket stays where it is.
              //
              // It is the same unanswerable question of CYAU-111 and CYAU-139, here decided by the
              // STATE instead of the phase. Seen in production on 30/08 on CLRA-16: the plan needed
              // no code because it was a container, rejected because the review diff was empty.
              //
              // The review does not disappear: the one on the RESULT stays, because a declaration must
              // be judged anyway — and its criteria for these two states already exist
              // (`reviewCriteria`). Whoever really wrote code keeps going through the diff.
              if (workflowDelivery.reviewOnDiff && hasDiffToReview(structured)) {
                payloadReview = await workflowDelivery.reviewOnDiff(structured, lifecycleSignal)
                if (payloadReview.status === 'unavailable') reviewDetail = redactSecrets(payloadReview.summary).slice(0, 200)
              } else if (reviewerRuntimeId === 'opencode') {
                // CYAU-228 — OpenCode is not an action runtime: it judges the result in its confined session,
                // with no tools, from the same prompt the Claude and Codex sessions receive.
                const reviewed = await runOpencodeResultReview({
                  prompt: buildWorkflowReviewPrompt(workflowDelivery.executionPhase, structured),
                  model: workflowDelivery.reviewerModel,
                  cwd: ticketRun?.authorizedCwd ?? effectiveAction.cwd ?? process.cwd(),
                  timeoutMs: (effectiveAction.timeout ?? 300) * 1000,
                  signal: lifecycleSignal,
                })
                // The review too is a session paid on the ticket (CYAU-155).
                if (reviewed.ok) chargeSession(reviewed.stdout)
                const review = reviewed.ok ? parseWorkflowReview(reviewed.text, workflowDelivery.executionPhase) : null
                if (!review) reviewDetail = reviewed.ok ? 'invalid reviewer output' : reviewed.detail
                payloadReview = {
                  ...(review ?? {status: 'unavailable', summary: `Reviewer unavailable: ${reviewDetail}.`}),
                  depth: 'result',
                }
              } else {
                const reviewerRuntime = reviewerRuntimeId === 'codex' ? codexRuntime : claudeRuntime
                const reviewPrompt = buildWorkflowReviewPrompt(workflowDelivery.executionPhase, structured)
                // `cwd` must be copied like schedule/timeout/containment: under the queue the action receives the ticket's
                // authorized cwd (line ~624) and the executor rejects before the spawn a session whose
                // cwd does not match the authorized one (C400-EXEC-004). Without it, the reviewer started from the playbook
                // root, did not start at all, and EVERY delivery was rejected for an unavailable review.
                const reviewerAction: Action = reviewerRuntimeId === 'codex'
                  ? {type: 'codex', run: reviewPrompt, schedule: effectiveAction.schedule, sandbox: 'read-only',
                      cwd: effectiveAction.cwd, timeout: effectiveAction.timeout, enabled: true, catch_up: false,
                      containment: effectiveAction.containment}
                  : {type: 'claude', run: reviewPrompt, schedule: effectiveAction.schedule, permission_mode: 'plan',
                      allowed_tools: ['Read', 'Glob', 'Grep'], cwd: effectiveAction.cwd, timeout: effectiveAction.timeout,
                      enabled: true, catch_up: false, containment: effectiveAction.containment}
                const reviewed = await reviewerRuntime.execute(`${name}review`, reviewerAction, {
                  playbookDir: opts.playbookDir, logDir: opts.logDir, logName: `${logName}review`,
                  now: opts.now, spawn: opts.spawn,
                  secrets: opts.secrets, clock: opts.clock, signal: lifecycleSignal,
                  authorizedCwd: ticketRun?.authorizedCwd ?? opts.authorizedCwds?.[name],
                }).result
                // The review too is a session paid on the ticket (CYAU-155). A reviewer that does not expose its
                // own cost simply adds nothing: never an inferred cost.
                chargeSession(reviewed.stdout)
                const review = reviewed.status === 'success' ? parseWorkflowReview(reviewed.stdout, workflowDelivery.executionPhase) : null
                if (!review) {
                  reviewDetail = describeRuntimeFailure(
                    reviewerAction.type === 'codex' ? 'codex' : 'claude',
                    reviewed.status === 'success' ? '' : readLogTail(reviewed.logPath),
                    reviewed.errorCode,
                  )
                }
                // The host declares `depth` on EVERY delivery: a report that does not say how it was
                // reviewed is a report missing the part that matters, and the server no longer accepts it.
                payloadReview = {
                  ...(review ?? {status: 'unavailable', summary: `Reviewer non disponibile: ${reviewDetail}.`}),
                  depth: 'result',
                }
              }
              // CYAU-178 — the identifier is measured on the ticket's MANAGED working copy, never on the host's
              // cwd: that is the folder the daemon runs from, and its HEAD has nothing to
              // do with the work just produced. Without `ticketRun` a working copy does not
              // exist — they are the read-only phases — and the field is simply absent.
              const observed = ticketRun ? observedHeadSha(ticketRun.authorizedCwd) : undefined
              const payload: AttemptDelivery = {
                runtime: effectiveAction.type,
                reviewer_runtime: reviewerRuntimeId,
                result: structured,
                review: payloadReview,
                ...(observed ? {observed: {head_sha: observed}} : {}),
                ...deliveryUsage(effectiveAction.type, 'model' in effectiveAction ? effectiveAction.model : undefined,
                                 attemptCostUsd, raw.stdout),
              }
              // CYAU-208 — a missed review may mean a broken runtime: at the next round the claim
              // re-probes Claude and Codex instead of trusting the probe from an hour ago.
              if (reviewDetail) agentRuntimeReadiness.invalidate()
              const reviewAccepted = payload.review.status === 'accepted'
              // The PR stays draft during CI and review. Only the cross approval allows
              // promoting it; the finalization re-attests the same SHA before any server write.
              if (reviewAccepted && workflowDelivery.finalize && verifiedSha) {
                const finalized = await workflowDelivery.finalize(structured, verifiedSha, lifecycleSignal)
                if (finalized.status !== 'passed') {
                  lifecycleResult = {
                    outcome: 'complete', runStatus: 'failure',
                    errorCode: finalized.status === 'failed' ? ErrorCodes.Gate.failed : ErrorCodes.Gate.unavailable,
                  }
                  return
                }
              }
              const delivered = await workflowDelivery.deliver(payload)
              // A rejection on the merits (the server decided) and a delivery that did not arrive (network, timeout,
              // 5xx, credential) have opposite remedies and no longer share the same code. A non-approved
              // review stays a local failure regardless of what the transport says.
              const errorCode = delivered.outcome === 'ok'
                ? (reviewAccepted ? null : ErrorCodes.Workflow.rejected)
                : delivered.outcome === 'rejected'
                ? ErrorCodes.Workflow.rejected
                : ErrorCodes.Workflow.undelivered
              deliveryRecord = recordDelivery(workflowDelivery, {
                outcome: delivered.outcome,
                errorCode,
                reviewStatus: payload.review.status,
                ...(reviewDetail ? {reviewDetail} : {}),
                attemptStatus: delivered.outcome === 'ok' ? delivered.attempt?.status : undefined,
                httpStatus: delivered.status,
                serverErrorCode: delivered.outcome === 'rejected' ? delivered.code : undefined,
                raw,
              })
              // CYAU-175 — faced with a "no" from the review the machine does NOT redo the work by itself.
              //
              // It used to, and that second session was thrown away entirely: the server closes the round the
              // very moment it says no, so the redelivery was told that the
              // delivery was already recorded. Meanwhile the server had already put the phase back in the queue, but
              // could not give it to anyone until this machine let go — the ticket stayed
              // stuck for the whole time of the second useless piece of work. On the day that behaviour
              // was born, 20 deliveries out of 67 sessions were rejected exactly this way.
              //
              // Whoever decides whether to retry is the server, the only one keeping the real count: it puts the phase
              // back in the queue if there is room, and at the second rejection in a row it stops the run and calls a
              // person. There were two counts and they did not say the same thing; the server's one remains, which is
              // also the only one visible on the card and the only one that survives a restart.
              //
              // The cost, declared: the next attempt restarts without knowing what it was challenged on.
              // Before, it lost it at every restart too. Carrying it over is a separate piece of work.
              if (delivered.outcome === 'ok' && reviewAccepted && workflowDelivery.afterAccepted) {
                lifecycleResult = await workflowDelivery.afterAccepted()
              } else if (errorCode) {
                lifecycleResult = {outcome: 'complete', runStatus: 'failure', errorCode}
              }
            }
          })
          result = execution.leaseLost
            ? execution.result
            : lifecycleResult?.runStatus === 'failure'
            ? {
                ...execution.result,
                status: 'failure',
                errorCode: lifecycleResult.errorCode ?? execution.result.errorCode,
              }
            : execution.result
          // One session per cycle round: the spend is summed here, not after the loop, otherwise the attempts
          // before a retry would disappear from the ticket's account.
          chargeSession(execution.result.stdout)
          // The lease can be lost while the post-runtime callback ends; the recorded result must reflect
          // the supervisor's final outcome, not the snapshot taken before the in-flight renew's response.
          agentResult = normalizeAgentResult({
            runtime: runtime.id,
            action: name,
            result,
            cancelled: execution.leaseLost || (opts.signal?.aborted ?? false),
          })
          if (execution.leaseLost) await ticketRun?.block().catch(() => undefined)
          if (execution.leaseLost || lifecycleResult?.outcome !== 'retry') break
          retryPrompt = lifecycleResult.retryPrompt
          if (!retryPrompt) throw new Error('retry ticket privo di finding strutturati (fail-closed)')
          if (!executionLease || !(await attestExecutionLease(executionLease, opts.signal))) {
            execution = {result: {...result, status: 'failure', errorCode: ErrorCodes.Lease.lost}, leaseLost: true}
            result = execution.result
            agentResult = normalizeAgentResult({runtime: runtime.id, action: name, result, cancelled: true})
            await ticketRun?.block().catch(() => undefined)
            break
          }
          await ticketRun?.beforeRuntime()
        }
      } catch (error) {
        if (ticketRun) await ticketRun.block().catch(() => undefined)
        throw error
      } finally {
        // The terminal checkpoint (or the fail-closed blocked attempt) always precedes the ownership release.
        if (executionLease) await executionLease.release().catch(() => undefined)
      }
      updateAction(state, name, {
        last_run: nowIso,
        last_status: result.status,
        last_duration_ms: result.durationMs,
        last_exit_code: result.exitCode,
        last_error_code: result.errorCode,
        last_result: agentResult,
      })
      executed.push({
        name,
        status: result.status,
        errorCode: result.errorCode,
        durationMs: result.durationMs,
        logPath: result.logPath,
        result: agentResult,
        ...(deliveryRecord ? {delivery: deliveryRecord} : {}),
      })
      // Durability BEFORE continuing: if the disk does not accept the record of what just happened, the
      // cycle stops here instead of starting the next action. Deliberate fail-closed — a result
      // executed but not recoverable is worse than an interrupted iteration.
      //
      // CYAU-87: before, this save lived inside `if (opts.reportRun)`, because it protected the per-agent
      // network report; with the typed-agent catalog that channel disappeared too (the host-first outcome travels on
      // `deliverAttempt` while the lease is still held). The guarantee however did not depend on the network: now it applies
      // always, not only when the sync was configured.
      persistState(opts.stateFile, state)
      // Ownership lost: the cancelled result is first made durable/reported, then the cycle stops.
      // Another ticket/phase cannot start under a lease that can no longer be attested.
      if (execution.leaseLost) return 'stop'
      return 'continue'
    }

    // Dispatch of the due actions. SKILL-MODE (CYAU-69): bounded pool for PER-STEP concurrency — every due action
    // is ONE claim/step and `runFlowPool` keeps at most `cap` in flight (cap = resolveFlowConcurrency(max_parallel),
    // fail-closed to 1 if not resolvable: never unlimited). `dispatchDueEntry` composes the existing preflight+lease;
    // a 'stop' outcome closes the admission (like the serial `break`: shutdown or lost lease) letting
    // the steps already in flight finish. PROMPT-MODE (skill-mode off): UNCHANGED inline SERIAL path.
    if (opts.skillsMode ?? skillsModeEnabled()) {
      let rawCap: number | undefined
      try {
        rawCap = typeof opts.flowMaxParallel === 'function' ? await opts.flowMaxParallel() : opts.flowMaxParallel
      } catch {
        rawCap = undefined // policy not resolvable → serial cap (fail-closed), never unlimited.
      }
      let cap: number
      try {
        cap = resolveFlowConcurrency(rawCap)
      } catch {
        cap = 1 // corrupt max_parallel (should not happen: the schema validates it) → serial, never an unlimited pool.
      }
      // Host-first (CYAU-90): the pool claims ONE step at a time, bounded by `cap` (= max_parallel). Every claim
      // claims the next ready phase of a queue; the continuation (next phase or next ticket) is
      // re-queued by the SERVER for the following tick (flow-engine model). The per-agent fan-out is removed in
      // materialize: the pool parallelism serves more QUEUES and more tickets of the SAME queue in flight together.
      //
      // CYAU-169: a queue can be presented to the pool up to `cap` times per round, because the claim
      // is ATOMIC (`claimQueue`, endpoint CYRA-588): the server picks and claims under lock, so concurrent
      // requests take DIFFERENT tickets instead of re-reading the same head and finding it stale. The per-queue
      // cap is the same as the pool's: the slots really fill up, but the round stays finite — the queue is not drained
      // entirely in one tick, and the pace is still set by the daemon interval. Without `claimQueue` (channel not
      // configured or prompt mode) the two-step path remains: one presentation per queue, as before.
      // The claim is requested only if there is a gate that can evaluate it: a claimed ticket never submitted
      // to the preflight would stay occupied without anyone deciding whether to work on it (fail-closed).
      const claimQueue = opts.preflight ? opts.claimQueue : undefined
      const queueEntries = claimQueue ? selection.due.filter((entry) => opts.ticketQueues?.[entry.name]) : []
      const attempts: DueEntry[] = [...selection.due]
      for (let round = 1; round < cap; round++) attempts.push(...queueEntries)
      // Queues that already delivered at least one ticket in this round: for them the following "no work" is
      // normal draining, not the wait to report to the beat.
      const servedQueues = new Set<string>()
      let nextIndex = 0
      let stopDispatch = false
      const pool = await runFlowPool<DueEntry>({
        maxParallel: cap,
        claimNext: async () => {
          while (!stopDispatch && !opts.signal?.aborted && nextIndex < attempts.length) {
            const entry = attempts[nextIndex++]
            const target = claimQueue ? opts.ticketQueues?.[entry.name] : undefined
            if (!target) return entry
            if (closedQueues.has(entry.name)) continue
            const claim = await claimQueue!(target)
            if (claim.outcome === 'claimed') {
              servedQueues.add(entry.name)
              return {...entry, queueClaim: claim}
            }
            closedQueues.add(entry.name)
            if (claim.outcome === 'empty' && servedQueues.has(entry.name)) continue
            // Empty queue at the first round, rejection or silence: the dispatch proceeds anyway, so the preflight
            // records it and explains it as it always did (`waiting`/`blocked` stop, the beat's `last_stops`).
            return {...entry, queueClaim: claim}
          }
          return null
        },
        runStep: async (entry) => {
          const flow = await dispatchDueEntry(entry)
          if (flow === 'stop') stopDispatch = true
          // Disposition only for the pool trace: the real outcome is already in `executed`/`preflightStopped`, written
          // by `dispatchDueEntry`. 'blocked' = it asked to stop; 'advanced' = it can continue.
          return {disposition: flow === 'stop' ? 'blocked' : 'advanced'}
        },
      })
      // The pool's return was DISCARDED (CYAU-105): `runFlowPool` catches every throw of `runStep` into a
      // `failed` disposition so as not to bring down the other steps, so a dispatch failure appeared neither
      // in `executed` (the action did not get to record itself) nor in a log. Now it goes up to the caller.
      for (const entry of pool.entries) {
        if (entry.outcome.disposition !== 'failed') continue
        flowFailures.push({name: entry.claim.name, detail: entry.outcome.detail ?? 'step del pool fallito senza dettaglio'})
      }
      // CYAU-169: since the claim lives in the admission, `claimNext` does I/O and can throw — the pool stops
      // admitting (fail-closed) and drains. A host that can no longer take work must not look
      // idle: the failure goes up with the name of the queue that produced it.
      if (pool.claimError) {
        const pending = attempts[Math.max(0, nextIndex - 1)]
        flowFailures.push({name: pending?.name ?? '(coda)', detail: pool.claimError})
      }
    } else {
      for (const entry of selection.due) {
        if ((await dispatchDueEntry(entry)) === 'stop') break
      }
    }

    persistState(opts.stateFile, state)
    const pruned = prune(opts.logDir, opts.retentionDays ?? DEFAULT_RETENTION_DAYS, opts.now)

    if (opts.heartbeat) {
      // A preflight stop is an expected operational decision (e.g. ticket waiting/limit), not a host failure.
      // A stop with a `failed` audit instead signals an unavailable technical dependency and must turn the
      // beat red: `every([])` alone would mask a host unable to load tickets/Guidance/policy.
      const ok = executed.every((entry) => entry.status === 'success') &&
        !preflightStopped.some((entry) => auditHasTechnicalFailure(entry.audit))
      // The reason of the last block travels with the beat (CYAU-116): without it, a host stuck because it cannot
      // take a ticket is indistinguishable on the panel from an idle one. Only action/state/reason, never the internal
      // audit; the sanitization (last 5 + reason redaction) belongs to the heartbeat consumer.
      //
      // `last_stops` must be emitted ONLY when this round really consulted the preflight (at least one due
      // action dispatched): an array — even empty — is an observed fact ("no block / block resolved"). A
      // round WITHOUT due actions (schedule not expired, coalescing queue) evaluated nothing: emitting `[]`
      // would erase a still valid block. `undefined` is passed → the field is not touched and the keepalive
      // (CYAU-120) keeps offering the last real reason until a round with dispatch updates it.
      const stops = selection.due.length > 0
        ? preflightStopped.map((entry): PreflightStop => ({action: entry.name, state: entry.state, reason: entry.reason}))
        : undefined
      await opts.heartbeat(ok, stops)
    }

    return {skipped: false, executed, seeded: selection.seed.map((entry) => entry.name), scheduleErrors: selection.errors, pruned, stateQuarantined, preflightStopped, flowFailures}
  } finally {
    release(opts.lockFile)
  }
}

/** Tail of a session's log, to recognize its failure. An unreadable log counts as empty. */
function readLogTail(logPath: string): string {
  try {
    return fs.readFileSync(logPath, 'utf8').slice(-65_536)
  } catch {
    return ''
  }
}
