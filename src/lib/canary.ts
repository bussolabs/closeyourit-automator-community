import {DEFAULT_API} from './client'
import {isUserToken} from './config'
import {type FetchFn} from './heartbeat'

// Nightly canary (CYAU-205). Every night a harmless ticket is created on the Sandbox project and followed
// until staging; the «collaudo» account approves its plan and its code, and nothing else. Before EVERY
// approval the account tries the very same approval on a decoy ticket outside its perimeter: only a
// permission denial proves the boundary. Any other answer — a success, a state error, a bad request, a
// server error — stops the approvals of the night and raises an alert naming the stage and the reason.
//
// The engine is pure: the server, the observer and the clock are injected, so every outcome is testable
// without a real CloseYourIt. `makeCanaryServer` is the HTTP adapter for the `/cli/v1` user-token API.

const REQUEST_TIMEOUT_MS = 15_000

/**
 * Error codes of the CloseYourIt CLI API. `R403-CLIAUTH-002` is the one `require_permission!` emits: the
 * account is known, the resource is visible, the permission is missing. `R404-SYSTEM-001` is what an account
 * gets on a project it cannot see (anti-BOLA): a denial only if the observer proved the decoy exists, and
 * only when a person opted in (`hiddenDecoyCountsAsDenial`).
 */
export const PERMISSION_DENIED_CODE = 'R403-CLIAUTH-002'
export const HIDDEN_RESOURCE_CODE = 'R404-SYSTEM-001'

/** The workflow phases the canary acts on (closeyourit-rails `Agents::Workflows::PhaseResolver`). */
export const PLAN_PHASE = 'awaiting_approval'
export const CODE_PHASE = 'awaiting_autopilot_approval'

export type ApprovalKind = 'plan' | 'code'

/** One raw answer of the server: HTTP status (0 = no answer), error code, JSON body. */
export interface ApiResponse {
  status: number
  code?: string
  body?: unknown
}

/** What the canary needs to know about a ticket's automation. Missing fields mean «not reported». */
export interface AutomationView {
  code: string
  project: string
  phase: string | null
  /** The ticket status is a review gate: a code approval is accepted there. */
  reviewGate: boolean
  stagingVerified: boolean
}

export type ReadResult = {ok: true; view: AutomationView} | {ok: false; response: ApiResponse}

/** The calls the canary makes. One instance per identity: the «collaudo» account, the read-only observer. */
export interface CanaryServer {
  createTicket(project: string, title: string, description: string): Promise<{ok: true; code: string} | {ok: false; response: ApiResponse}>
  readAutomation(project: string, ticket: string): Promise<ReadResult>
  approve(kind: ApprovalKind, project: string, ticket: string): Promise<ApiResponse>
}

export interface CanaryClock {
  now(): number
  sleep(ms: number): Promise<void>
}

export interface CanaryConfig {
  sandboxProject: string
  decoyProject: string
  decoyTicket: string
  deadlineMs: number
  pollMs: number
  hiddenDecoyCountsAsDenial: boolean
}

/** Where the night stopped. `workflowPhase` is the last phase seen on the night's ticket. */
export type CanaryStage = 'create' | 'read' | 'decoy' | 'boundary' | 'plan-approval' | 'code-approval' | 'deadline'

export interface CanaryAlert {
  stage: CanaryStage
  reason: string
  /** A success on the decoy: the account has powers outside the Sandbox and its key must be revoked. */
  urgent: boolean
  ticket: string | null
  workflowPhase: string | null
}

export interface CanaryReport {
  ok: boolean
  night: string
  ticket: string | null
  approved: ApprovalKind[]
  boundaryChecks: number
  alert: CanaryAlert | null
}

/** Outcome of the boundary probe on the decoy. */
export type BoundaryVerdict =
  | {outcome: 'denied'}
  | {outcome: 'breach'; reason: string}
  | {outcome: 'inconclusive'; reason: string}

function describeResponse(response: ApiResponse): string {
  if (response.status === 0) return `no answer from the server${response.code ? ` (${response.code})` : ''}`
  return `HTTP ${response.status}${response.code ? ` ${response.code}` : ''}`
}

/**
 * Decides what the server's answer to the decoy approval proves. Only a permission denial counts: a
 * request refused for any other reason would be refused anyway, so it says nothing about permissions.
 */
export function classifyBoundaryProbe(response: ApiResponse, hiddenDecoyCountsAsDenial: boolean): BoundaryVerdict {
  if (response.status >= 200 && response.status < 300) {
    return {outcome: 'breach', reason: `the decoy approval was accepted (${describeResponse(response)}): revoke the collaudo key now`}
  }
  if (response.status === 403 && response.code === PERMISSION_DENIED_CODE) return {outcome: 'denied'}
  if (response.status === 404 && response.code === HIDDEN_RESOURCE_CODE) {
    if (hiddenDecoyCountsAsDenial) return {outcome: 'denied'}
    return {outcome: 'inconclusive', reason: `the decoy is hidden from the collaudo account (${describeResponse(response)}) and a hidden decoy is not accepted as a permission denial`}
  }
  return {outcome: 'inconclusive', reason: `the decoy approval was refused for a reason other than permissions (${describeResponse(response)})`}
}

/** The decoy accepts the approval being probed: otherwise a refusal would not be about permissions. */
export function decoyAccepts(kind: ApprovalKind, view: AutomationView): boolean {
  return kind === 'plan' ? view.phase === PLAN_PHASE : view.reviewGate
}

/** UTC date of the night, the tag that makes every run recognisable. */
export function nightOf(ms: number): string {
  return new Date(ms).toISOString().slice(0, 10)
}

export function canaryTicketTitle(night: string): string {
  return `Nightly canary ${night}`
}

export function canaryTicketDescription(night: string): string {
  return [
    `Harmless change for the nightly canary of ${night}.`,
    '',
    `Append the line \`canary ${night}\` to \`CANARY.md\` at the root of the repository, creating the file if it is missing.`,
    'Change nothing else.',
  ].join('\n')
}

/**
 * Runs one night. The night's ticket is the only one ever approved: the code returned by the creation
 * is kept, and every read and approval names it. Before each approval the observer confirms the decoy
 * accepts that approval and the collaudo account must be denied on it.
 */
export async function runCanary(
  config: CanaryConfig,
  collaudo: CanaryServer,
  observer: CanaryServer,
  clock: CanaryClock,
): Promise<CanaryReport> {
  const started = clock.now()
  const night = nightOf(started)
  const report: CanaryReport = {ok: false, night, ticket: null, approved: [], boundaryChecks: 0, alert: null}
  let lastPhase: string | null = null

  const stop = (stage: CanaryStage, reason: string, urgent = false): CanaryReport => {
    report.alert = {stage, reason, urgent, ticket: report.ticket, workflowPhase: lastPhase}
    return report
  }

  const created = await collaudo.createTicket(config.sandboxProject, canaryTicketTitle(night), canaryTicketDescription(night))
  if (!created.ok) return stop('create', `creating the night's ticket failed (${describeResponse(created.response)})`)
  const ticket = created.code
  report.ticket = ticket
  if (!ticket.toUpperCase().startsWith(`${config.sandboxProject.toUpperCase()}-`)) {
    return stop('create', `the created ticket ${ticket} is not on the ${config.sandboxProject} project`)
  }

  // Returns a reason to stop, or null when the decoy denied the account as it must.
  const probeBoundary = async (kind: ApprovalKind): Promise<{stage: CanaryStage; reason: string; urgent: boolean} | null> => {
    const decoy = await observer.readAutomation(config.decoyProject, config.decoyTicket)
    if (!decoy.ok) {
      return {stage: 'decoy', reason: `the observer could not read the decoy ${config.decoyTicket} (${describeResponse(decoy.response)})`, urgent: false}
    }
    if (decoy.view.code.toUpperCase() !== config.decoyTicket.toUpperCase() || !decoyAccepts(kind, decoy.view)) {
      return {stage: 'decoy', reason: `the decoy ${config.decoyTicket} does not accept a ${kind} approval (phase ${decoy.view.phase ?? 'none'}, review gate ${decoy.view.reviewGate})`, urgent: false}
    }
    report.boundaryChecks++
    const verdict = classifyBoundaryProbe(await collaudo.approve(kind, config.decoyProject, config.decoyTicket), config.hiddenDecoyCountsAsDenial)
    if (verdict.outcome === 'denied') return null
    return {stage: 'boundary', reason: verdict.reason, urgent: verdict.outcome === 'breach'}
  }

  let lastReadFailure: string | null = null
  for (;;) {
    const read = await collaudo.readAutomation(config.sandboxProject, ticket)
    if (read.ok) {
      lastReadFailure = null
      const view = read.view
      if (view.code.toUpperCase() !== ticket.toUpperCase() || view.project.toUpperCase() !== config.sandboxProject.toUpperCase()) {
        return stop('read', `the server answered for ${view.project}/${view.code} instead of ${config.sandboxProject}/${ticket}`)
      }
      lastPhase = view.phase
      if (view.stagingVerified) {
        report.ok = true
        return report
      }
      const kind: ApprovalKind | null =
        view.phase === PLAN_PHASE && !report.approved.includes('plan') ? 'plan'
          : view.phase === CODE_PHASE && !report.approved.includes('code') ? 'code'
            : null
      if (kind) {
        const blocked = await probeBoundary(kind)
        if (blocked) return stop(blocked.stage, blocked.reason, blocked.urgent)
        const approval = await collaudo.approve(kind, config.sandboxProject, ticket)
        if (approval.status < 200 || approval.status >= 300) {
          return stop(kind === 'plan' ? 'plan-approval' : 'code-approval', `approving the ${kind} of ${ticket} failed (${describeResponse(approval)})`)
        }
        report.approved.push(kind)
        continue
      }
    } else {
      // A slow or briefly unreachable server is not yet a failure: the deadline decides.
      lastReadFailure = describeResponse(read.response)
    }
    const elapsed = clock.now() - started
    if (elapsed >= config.deadlineMs) {
      const minutes = Math.round(config.deadlineMs / 60_000)
      const detail = lastReadFailure ? `; last read failed (${lastReadFailure})` : ''
      return stop('deadline', `${ticket} did not reach staging within ${minutes} minutes, stuck in phase ${lastPhase ?? 'unknown'}${detail}`)
    }
    await clock.sleep(Math.min(config.pollMs, config.deadlineMs - elapsed))
  }
}

/** One line for the job log and the alert channel. */
export function formatCanaryAlert(report: CanaryReport): string {
  const alert = report.alert
  if (!alert) return `canary ${report.night}: ${report.ticket} reached staging (approved: ${report.approved.join(', ')})`
  const level = alert.urgent ? 'URGENT canary alert' : 'canary alert'
  return `${level} ${report.night}: stage ${alert.stage}, phase ${alert.workflowPhase ?? 'none'}, ticket ${alert.ticket ?? 'none'}: ${alert.reason}`
}

// ── HTTP adapter (CLI API, user token) ──────────────────────────────────────────────────────────────────────

/**
 * Paths of the CLI API. `review/approval` exists today. ⚠️ Server dependency: `automation` (read the
 * workflow phase) and `automation/approval` (approve the plan) are not exposed to user tokens yet — the
 * plan approval lives only in the web member area — and must be added to closeyourit-rails before the
 * canary can run against the real server.
 */
export const CANARY_PATHS = {
  tickets: (project: string) => `/cli/v1/projects/${encodeURIComponent(project)}/tickets`,
  automation: (project: string, ticket: string) => `/cli/v1/projects/${encodeURIComponent(project)}/tickets/${encodeURIComponent(ticket)}/automation`,
  planApproval: (project: string, ticket: string) => `/cli/v1/projects/${encodeURIComponent(project)}/tickets/${encodeURIComponent(ticket)}/automation/approval`,
  codeApproval: (project: string, ticket: string) => `/cli/v1/projects/${encodeURIComponent(project)}/tickets/${encodeURIComponent(ticket)}/review/approval`,
} as const

function errorCodeOf(body: unknown): string | undefined {
  if (!body || typeof body !== 'object') return undefined
  const error = (body as {error?: unknown}).error
  if (error && typeof error === 'object') {
    const code = (error as {code?: unknown}).code
    if (typeof code === 'string' && code.trim() !== '') return code
  }
  return undefined
}

function dataOf(body: unknown): Record<string, unknown> | null {
  const data = (body as {data?: unknown} | null)?.data
  return data && typeof data === 'object' && !Array.isArray(data) ? (data as Record<string, unknown>) : null
}

/** Reads the automation view tolerantly: a field of the wrong type is «not reported», never guessed. */
export function parseAutomationView(body: unknown): AutomationView | null {
  const data = dataOf(body)
  if (!data) return null
  const code = data.ticket_code ?? data.code
  const project = data.project_key
  if (typeof code !== 'string' || typeof project !== 'string') return null
  return {
    code,
    project,
    phase: typeof data.phase === 'string' ? data.phase : null,
    reviewGate: data.review_gate === true,
    stagingVerified: typeof data.closer_staging_verified_at === 'string' && data.closer_staging_verified_at !== '',
  }
}

export function makeCanaryServer(token: string, apiUrl: string = DEFAULT_API, fetchFn: FetchFn = globalThis.fetch): CanaryServer {
  if (!isUserToken(token)) throw new Error('the canary needs a CloseYourIt user token')
  const headers = {Authorization: `Bearer ${token}`, 'Content-Type': 'application/json', Accept: 'application/json'}

  const call = async (method: 'GET' | 'POST', path: string, body?: unknown): Promise<ApiResponse> => {
    try {
      const res = await fetchFn(`${apiUrl}${path}`, {
        method,
        headers,
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      })
      const json = await res.json().catch(() => null)
      return {status: res.status, code: res.ok ? undefined : errorCodeOf(json), body: json}
    } catch (error) {
      return {status: 0, code: error instanceof Error && error.name === 'TimeoutError' ? 'timeout' : 'network'}
    }
  }
  const ok = (response: ApiResponse): boolean => response.status >= 200 && response.status < 300

  return {
    async createTicket(project, title, description) {
      const response = await call('POST', CANARY_PATHS.tickets(project), {title, description})
      const code = dataOf(response.body)?.code
      if (!ok(response) || typeof code !== 'string') return {ok: false, response}
      return {ok: true, code}
    },
    async readAutomation(project, ticket) {
      const response = await call('GET', CANARY_PATHS.automation(project, ticket))
      const view = ok(response) ? parseAutomationView(response.body) : null
      return view ? {ok: true, view} : {ok: false, response}
    },
    approve(kind, project, ticket) {
      const path = kind === 'plan' ? CANARY_PATHS.planApproval(project, ticket) : CANARY_PATHS.codeApproval(project, ticket)
      return call('POST', path, {})
    },
  }
}

export const systemClock: CanaryClock = {
  now: () => Date.now(),
  sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
}
