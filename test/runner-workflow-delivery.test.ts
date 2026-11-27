import {type BrowserBlock, type BrowserReport} from '../src/lib/browser-tester'
import {type TesterBlock, type TesterReport} from '../src/lib/tester'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import {spawnSync} from 'node:child_process'
import {afterAll, describe, expect, it, vi} from 'vitest'
import {runOnce} from '../src/lib/runner'
import {type RunContext, type RunResult} from '../src/lib/executor'
import {type ConversationStore, conversationFingerprint, recordConversation} from '../src/lib/agent-conversation'
import {type AgentRuntime} from '../src/lib/runtime'
import {type AttemptDelivery, type AttemptDeliveryResult} from '../src/lib/client'
import {emptyState, saveState, updateAction} from '../src/lib/state'
import {PlaybookSchema} from '../src/lib/schema'
import {type ExecutionPhase} from '../src/lib/phase-profile'
import {agentRuntimeReadiness} from '../src/lib/runtime-probe'
import {evaluateTicketAttempts, readTicketAttempts, recordTicketAttempt} from '../src/lib/ticket-attempts'
import {REVIEW_RETRY_WAIT_MS, type ReviewFaultKind} from '../src/lib/review-fault'

// CYAU-105/CYAU-106: the result DELIVERY path (runner.ts, `workflowDelivery` block) was not
// exercised by ANY test — `runner.test.ts` never builds a decision with `workflowDelivery`, and
// `typed-workflow.test.ts` tests the parser on already extracted JSON. It is the piece that in production
// delivered nothing for two days without writing a line: here it is exercised end-to-end with an injected
// `deliver` and a real on-disk log, so the assertions look at the file the operator would go and read.

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'automator-delivery-'))
spawnSync('git', ['init', '-q', dir])
let counter = 0
afterAll(() => fs.rmSync(dir, {recursive: true, force: true}))

const now = new Date('2026-07-07T09:30:00.000Z')

const playbook = PlaybookSchema.parse({
  version: 1,
  actions: {work: {schedule: 'every 1m', type: 'claude', run: 'prompt della fase'}},
})

const TRIAGE_RESULT = {
  code: 'CYRA-199', category: 'backend', capabilities: ['backend'], risk: 'low',
  requires_human_approval: false, reasons: ['Area: backend'], state: 'workable',
}
// A phase that keeps its reviewer session: the tests of the review itself run on it (CYAU-354).
const PLANNER_RESULT = JSON.parse(
  fs.readFileSync(path.join(__dirname, 'contracts/agent-result/v1/fixtures/valid/planner.json'), 'utf8'),
) as Record<string, unknown>
const AUTOPILOT_RESULT = {
  // CYRA-674 — a delivery without security_findings is invalid: the empty list is the answer.
  code: 'CYAU-181', state: 'delivered', gate: {passed: true}, review: {verdict: 'unavailable'}, cycles: 1, security_findings: [],
  delivery: {
    prUrl: 'https://github.com/bussolabs/closeyourit-rails/pull/72',
    cyiStatus: 'in_review', autoMerged: false,
  },
}

function scenario() {
  const base = path.join(dir, `run-${counter++}`)
  const logDir = path.join(base, 'logs')
  fs.mkdirSync(logDir, {recursive: true})
  const stateFile = path.join(base, 'state.json')
  saveState(stateFile, updateAction(emptyState(), 'work', {last_run: '2026-07-07T09:00:00.000Z', last_status: 'success'}))
  // The action log already exists with the `runAction` footer: it is the real situation in which the runner gets to
  // decide the delivery, and it verifies that the terminal outcome is APPENDED to it without rewriting it.
  const logPath = path.join(logDir, 'work-20260707T093000.log')
  fs.writeFileSync(logPath, '# azione: work\n\n\n# status: success\n# exit_code: 0\n')
  return {stateFile, logDir, lockFile: path.join(base, 'tick.lock'), logPath}
}

/** Fake runtime that completes successfully emitting the given stdout (and writing into the given log path). */
function runtimeWith(stdout: string, logPath: string, stdoutTruncated = false, usageStdout?: string | string[]): AgentRuntime {
  return {
    id: 'fake-claude', healthCheck: async () => ({available: true}),
    execute: () => ({
      result: Promise.resolve<RunResult>({
        status: 'success', exitCode: 0, errorCode: null, durationMs: 1, logPath, stdout, stdoutTruncated,
        usageStdout: Array.isArray(usageStdout) ? usageStdout.shift() : usageStdout,
      }),
      cancel: () => undefined,
    }),
  }
}

/** Fake reviewer: always approves, so the delivery gate depends only on the transport outcome. */
function approvingReviewer(seen?: {action?: {cwd?: string}}): AgentRuntime {
  return {
    id: 'fake-codex', healthCheck: async () => ({available: true}),
    execute: (_name: string, action: {cwd?: string}) => (seen && (seen.action = action), {
      result: Promise.resolve<RunResult>({
        status: 'success', exitCode: 0, errorCode: null, durationMs: 1, logPath: '',
        stdout: '{"status":"accepted","summary":"Conforme"}', stdoutTruncated: false,
      }),
      cancel: () => undefined,
    }),
  }
}

async function dispatch(opts: {
  engine?: 'claude' | 'codex'
  model?: string
  recordSessionCost?: (stdout: string, model?: string) => void
  stdout: string
  usageStdout?: string | string[]
  deliver: (payload: AttemptDelivery) => Promise<AttemptDeliveryResult>
  stdoutTruncated?: boolean
  cwd?: string
  seenReviewer?: {action?: {cwd?: string}}
  reviewer?: AgentRuntime
  /** CYRA-921: replaces the implementing Claude runtime (a same-engine review runs on it too). */
  implementer?: AgentRuntime
  reviewMode?: 'cross' | 'same'
  executionPhase?: ExecutionPhase
  /** CYAU-192: the claimed ticket code, with which the host composes the synthetic `blocked`. */
  ticketCode?: string
  /** CYAU-192: closes the local state after an accepted delivery (the synthetic one too). */
  afterAccepted?: () => Promise<{outcome: 'complete'; runStatus: 'success'; errorCode: null}>
  /** CYAU-176: the review that opens the real diff, when the server asked for it for this phase. */
  reviewOnDiff?: (result: Record<string, unknown>) => Promise<AttemptDelivery['review']>
  /** CYAU-335: whose fault it was when the diff review produced no verdict. */
  lastReviewFault?: () => ReviewFaultKind | null
  /** CYAU-335: what the attempt is told when the review never ran. */
  reportFailure?: (reason: string) => Promise<void>
  /** CYAU-335: `true` when the attempt counted at the claim is given back. */
  settleQuotaPause?: (paused: boolean) => void
  /** CYAU-335: the wait between two tries of the review. A no-op by default, so the tests do not wait. */
  sleep?: (ms: number) => Promise<void>
  /** CYAU-178: the MANAGED working copy of the ticket, the one the code sha is measured on. */
  authorizedCwd?: string
  /** CYRA-872: the ticket cycle outcome after every session (a `retry` runs one more session). */
  afterRuntime?: () => Promise<{outcome: 'retry'; retryPrompt: string} | {outcome: 'complete'; runStatus: 'success'; errorCode: null}>
  verify?: (result: Record<string, unknown>) => Promise<
    {status: 'passed'; summary: string; headSha: string} |
    {status: 'failed' | 'unavailable'; summary: string}
  >
  finalize?: (result: Record<string, unknown>, sha: string) => Promise<
    {status: 'passed'; summary: string; headSha: string} |
    {status: 'failed' | 'unavailable'; summary: string}
  >
  /** CYAU-295: the phone test, after the CI and before the cross-review. */
  emulatorTest?: (result: Record<string, unknown>) => Promise<{status: 'passed' | 'failed' | 'unavailable'; summary: string}>
  /** CYAU-329: the Tester, after the phone test and before the cross-review. */
  tester?: (engine: 'claude' | 'codex', ask: (prompt: string) => Promise<string | null>) => Promise<TesterReport>
  /** CYAU-329: the browser proofs on staging, before the session that tags production. */
  browserTester?: (engine: 'claude' | 'codex', ask: (prompt: string) => Promise<string | null>) => Promise<BrowserReport>
  /** CYAU-306: the cycle's answer to a red CI — one more round, or the round limit. */
  afterVerificationFailure?: (summary: string) => Promise<
    {outcome: 'retry'; retryPrompt: string} | {outcome: 'complete'; runStatus: 'failure'; errorCode: string}
  >
}) {
  const s = scenario()
  const release = vi.fn(async () => undefined)
  const result = await runOnce({
    playbook: opts.engine ? PlaybookSchema.parse({version: 1,
      actions: {work: {schedule: 'every 1m', type: opts.engine, run: 'phase prompt', model: opts.model}}}) : opts.cwd
      ? PlaybookSchema.parse({
          version: 1,
          actions: {work: {schedule: 'every 1m', type: 'claude', run: 'prompt della fase', cwd: opts.cwd}},
        })
      : playbook,
    playbookDir: dir, now,
    stateFile: s.stateFile, logDir: s.logDir, lockFile: s.lockFile,
    // On a Codex action Claude is the cross-reviewer: it answers with a verdict, not with the phase result.
    claudeRuntime: opts.implementer ?? (opts.engine === 'codex'
      ? approvingReviewer(opts.seenReviewer)
      : runtimeWith(opts.stdout, s.logPath, opts.stdoutTruncated)),
    codexRuntime: opts.engine === 'codex' ? runtimeWith(opts.stdout, s.logPath, opts.stdoutTruncated, opts.usageStdout) : opts.reviewer ?? approvingReviewer(opts.seenReviewer),
    sleep: opts.sleep ?? (async () => undefined),
    preflight: async () => ({
      outcome: 'admit', state: 'ready', reason: 'ok', audit: [],
      ...(opts.recordSessionCost ? {ticketAttempt: {recordSessionCost: opts.recordSessionCost}} : {}),
      executionLease: {renewEveryMs: 60_000, renew: async () => true, release},
      ...(opts.settleQuotaPause ? {
        ticketAttempt: {recordSessionCost: () => undefined, settleQuotaPause: opts.settleQuotaPause},
      } : {}),
      // CYAU-178: the MANAGED working copy of the ticket, the one the code sha is measured on.
      // Without `ticketRun` the runner has no ticket worktree and does not compose the sha.
      ...(opts.authorizedCwd ? {
        ticketRun: {
          runId: 'run-1', authorizedCwd: opts.authorizedCwd, branch: 'ticket/CYAU-178',
          beforeRuntime: async () => undefined,
          afterRuntime: opts.afterRuntime ?? (async () => ({outcome: 'complete' as const, runStatus: 'success' as const, errorCode: null})),
          block: async () => undefined,
        },
      } : {}),
      workflowDelivery: {
        executionPhase: opts.executionPhase ?? 'triage', attemptId: 'attempt-1', deliver: opts.deliver,
        ...(opts.reviewMode ? {reviewMode: opts.reviewMode} : {}),
        ...(opts.ticketCode ? {ticketCode: opts.ticketCode} : {}),
        ...(opts.afterAccepted ? {afterAccepted: opts.afterAccepted} : {}),
        ...(opts.verify ? {verify: opts.verify} : {}),
        ...(opts.finalize ? {finalize: opts.finalize} : {}),
        ...(opts.emulatorTest ? {emulatorTest: opts.emulatorTest} : {}),
        ...(opts.tester ? {tester: opts.tester} : {}),
        ...(opts.browserTester ? {browserTester: opts.browserTester} : {}),
        ...(opts.afterVerificationFailure ? {afterVerificationFailure: opts.afterVerificationFailure} : {}),
        ...(opts.reviewOnDiff ? {reviewOnDiff: opts.reviewOnDiff} : {}),
        ...(opts.lastReviewFault ? {lastReviewFault: opts.lastReviewFault} : {}),
        ...(opts.reportFailure ? {reportFailure: opts.reportFailure} : {}),
      },
    }),
  })
  return {result, log: fs.readFileSync(s.logPath, 'utf8'), action: result.executed[0]}
}

// Seen on AAC-13: a ticket left before the session started carried no cause on the server.
describe('runOnce — a ticket left before the session', () => {
  it('reports the underlying cause on the attempt, before releasing the lease', async () => {
    const s = scenario()
    const calls: string[] = []
    const reportFailure = vi.fn(async (_reason: string) => { calls.push('report') })
    const result = await runOnce({
      playbook, playbookDir: dir, now,
      stateFile: s.stateFile, logDir: s.logDir, lockFile: s.lockFile,
      claudeRuntime: runtimeWith('{}', s.logPath), codexRuntime: approvingReviewer(),
      preflight: async () => ({
        outcome: 'admit', state: 'ready', reason: 'ok', audit: [],
        executionLease: {renewEveryMs: 60_000, renew: async () => true, release: async () => { calls.push('release') }},
        ticketRun: {
          runId: 'run-1', authorizedCwd: dir, branch: 'ticket/AAC-13',
          beforeRuntime: async () => { throw new Error('ticket branch has local commits missing on GitHub') },
          afterRuntime: async () => ({outcome: 'complete' as const, runStatus: 'success' as const, errorCode: null}),
          block: async () => undefined,
        },
        workflowDelivery: {
          executionPhase: 'autopilot', attemptId: 'attempt-1', reportFailure,
          deliver: async (): Promise<AttemptDeliveryResult> => ({outcome: 'ok', status: 200}),
        },
      }),
    })

    expect(result.executed).toHaveLength(0)
    expect(reportFailure.mock.calls[0]![0]).toContain('ticket branch has local commits missing on GitHub')
    expect(result.preflightStopped[0]!.reason).toContain('ticket branch has local commits missing on GitHub')
    expect(calls).toEqual(['report', 'release'])
  })
})

describe('runOnce — phase result delivery (CYAU-105)', () => {
  it('attests the CI before the cross-review and makes the PR ready only before the server delivery', async () => {
    const verify = vi.fn(async () => ({status: 'passed' as const, summary: 'CI verde', headSha: 'a'.repeat(40)}))
    const finalize = vi.fn(async () => ({status: 'passed' as const, summary: 'PR ready', headSha: 'a'.repeat(40)}))
    const deliver = vi.fn(async (): Promise<AttemptDeliveryResult> => ({outcome: 'ok', status: 200}))

    await dispatch({
      stdout: JSON.stringify(AUTOPILOT_RESULT), executionPhase: 'autopilot', verify, finalize, deliver,
    })

    expect(verify).toHaveBeenCalledWith(AUTOPILOT_RESULT, expect.anything())
    expect(finalize).toHaveBeenCalledWith(AUTOPILOT_RESULT, 'a'.repeat(40), expect.anything())
    expect(deliver).toHaveBeenCalledTimes(1)
    expect(verify.mock.invocationCallOrder[0]).toBeLessThan(finalize.mock.invocationCallOrder[0])
    expect(finalize.mock.invocationCallOrder[0]).toBeLessThan(deliver.mock.invocationCallOrder[0])
  })

  it('red CI: no cross-review, promotion or delivery', async () => {
    const verify = vi.fn(async () => ({status: 'failed' as const, summary: 'CI rossa: ci / ci-gate'}))
    const finalize = vi.fn()
    const deliver = vi.fn<[AttemptDelivery], Promise<AttemptDeliveryResult>>()

    const {action} = await dispatch({
      stdout: JSON.stringify(AUTOPILOT_RESULT), executionPhase: 'autopilot', verify, finalize, deliver,
    })

    expect(finalize).not.toHaveBeenCalled()
    expect(deliver).not.toHaveBeenCalled()
    expect(action.status).toBe('failure')
    expect(action.errorCode).toBe('C409-GATE-002')
  })

  // CYAU-339 — an agent that declares it could not deliver has no proposal to check. Asking the CI gate for
  // one turned its own reason into «red checks»: every round was spent on a missing PR and the server received
  // a block about the CI, with the real reason (seen: a merge conflict with main) lost.
  describe('the agent declares a block (CYAU-339)', () => {
    const DECLARED_BLOCK = {
      contract_version: 2, code: 'CYAU-339', state: 'blocked', security_findings: [],
      failure: {
        category: 'merge_conflict', summary: 'Conflitti aperti in CHANGELOG.md con il ramo principale.',
        retryable: false, human_action: 'Risolvere il conflitto.',
      },
    }

    it('delivers the block with the agent\'s own reason, without asking the CI gate for a proposal', async () => {
      const verify = vi.fn(async () => ({status: 'failed' as const, summary: 'risultato senza consegna PR attestabile'}))
      const emulatorTest = vi.fn()
      const finalize = vi.fn()
      const afterVerificationFailure = vi.fn()
      const deliver = vi.fn(async (): Promise<AttemptDeliveryResult> => ({outcome: 'ok', status: 200, attempt: {status: 'blocked'}}))

      await dispatch({
        stdout: JSON.stringify(DECLARED_BLOCK), executionPhase: 'autopilot', ticketCode: 'CYAU-339',
        verify, emulatorTest, finalize, afterVerificationFailure, deliver,
      })

      expect(verify).not.toHaveBeenCalled()
      expect(emulatorTest).not.toHaveBeenCalled()
      expect(afterVerificationFailure).not.toHaveBeenCalled()
      expect(finalize).not.toHaveBeenCalled()
      expect(deliver).toHaveBeenCalledTimes(1)
      const sent = deliver.mock.calls[0][0].result as {state: string; failure: {summary: string}}
      expect(sent.state).toBe('blocked')
      expect(sent.failure.summary).toBe('Conflitti aperti in CHANGELOG.md con il ramo principale.')
    })
  })

  // CYAU-306 — red checks at the round limit. Before, the local cycle closed `blocked` and the server heard
  // nothing: the attempt went stale and the phase came back to the queue on the same red checks.
  describe('red CI and the round limit (CYAU-306)', () => {
    const limitReached = async () => ({outcome: 'complete' as const, runStatus: 'failure' as const, errorCode: 'C409-CYCLE-002'})

    it('last allowed round still red: the server receives a blocked that must not be retried, with the reason', async () => {
      const token = `cyi_ah_${'E'.repeat(24)}`
      const verify = vi.fn(async () => ({status: 'failed' as const, summary: `CI rossa: ci / ci-gate (${token})`}))
      const finalize = vi.fn()
      const reviewOnDiff = vi.fn()
      const afterAccepted = vi.fn(async () => ({outcome: 'complete' as const, runStatus: 'success' as const, errorCode: null}))
      const afterVerificationFailure = vi.fn(limitReached)
      const deliver = vi.fn(async (): Promise<AttemptDeliveryResult> => ({outcome: 'ok', status: 200, attempt: {status: 'blocked'}}))

      const {log, action} = await dispatch({
        stdout: JSON.stringify(AUTOPILOT_RESULT), executionPhase: 'autopilot', ticketCode: 'CYAU-306',
        verify, finalize, reviewOnDiff, afterAccepted, afterVerificationFailure, deliver,
      })

      expect(afterVerificationFailure).toHaveBeenCalledTimes(1)
      expect(deliver).toHaveBeenCalledTimes(1)
      const payload = deliver.mock.calls[0][0] as AttemptDelivery
      expect(payload).toMatchObject({
        runtime: 'claude', reviewer_runtime: 'codex',
        review: {status: 'accepted', depth: 'result'},
        result: {
          contract_version: 2, code: 'CYAU-306', state: 'blocked', security_findings: [],
          failure: {
            category: 'quality_gate', retryable: false,
            summary: expect.stringMatching(/^Controlli rossi anche all'ultimo giro di correzione: CI rossa: ci \/ ci-gate/u),
            human_action: expect.stringContaining('non riprova da sola'),
          },
        },
      })
      expect(JSON.stringify(payload)).not.toContain(token)
      // No promotion, no reviewer, and the local cycle is NOT reopened: it stays blocked.
      expect(finalize).not.toHaveBeenCalled()
      expect(reviewOnDiff).not.toHaveBeenCalled()
      expect(afterAccepted).not.toHaveBeenCalled()
      expect(action.status).toBe('failure')
      expect(action.errorCode).toBe('C409-CYCLE-002')
      expect(action.delivery).toMatchObject({
        outcome: 'ok', phase: 'autopilot', errorCode: 'C409-CYCLE-002', reviewStatus: 'accepted', attemptStatus: 'blocked',
      })
      expect(log).toContain('# synthetic_result: blocked-cycle-limit')
    })

    it('a rejected block keeps its own cause in the record', async () => {
      const deliver = vi.fn(async (): Promise<AttemptDeliveryResult> => ({outcome: 'rejected', status: 422, code: 'R422'}))
      const {action} = await dispatch({
        stdout: JSON.stringify(AUTOPILOT_RESULT), executionPhase: 'autopilot', ticketCode: 'CYAU-306', deliver,
        verify: async () => ({status: 'failed' as const, summary: 'CI rossa'}), afterVerificationFailure: limitReached,
      })
      expect(deliver).toHaveBeenCalledTimes(1)
      expect(action.errorCode).toBe('C409-CYCLE-002')
      expect(action.delivery).toMatchObject({outcome: 'rejected', errorCode: 'C409-WORKFLOW-002', serverErrorCode: 'R422'})
    })

    it('rounds left: retries the fix as today, without telling the server about a block', async () => {
      const verify = vi.fn()
        .mockResolvedValueOnce({status: 'failed', summary: 'CI rossa: ci / ci-gate'})
        .mockResolvedValueOnce({status: 'passed', summary: 'CI verde', headSha: 'a'.repeat(40)})
      const finalize = vi.fn(async () => ({status: 'passed' as const, summary: 'PR ready', headSha: 'a'.repeat(40)}))
      const afterVerificationFailure = vi.fn(async () => ({outcome: 'retry' as const, retryPrompt: 'Correggi la CI'}))
      const deliver = vi.fn(async (): Promise<AttemptDeliveryResult> => ({outcome: 'ok', status: 200}))

      await dispatch({
        stdout: JSON.stringify(AUTOPILOT_RESULT), executionPhase: 'autopilot', ticketCode: 'CYAU-306',
        verify, finalize, afterVerificationFailure, deliver,
      })

      expect(afterVerificationFailure).toHaveBeenCalledTimes(1)
      expect(verify).toHaveBeenCalledTimes(2)
      // One delivery only, the real result of the second round: no block reached the server.
      expect(deliver).toHaveBeenCalledTimes(1)
      expect(deliver.mock.calls[0][0].result).toMatchObject({state: 'delivered'})
      expect(deliver.mock.calls[0][0].result).not.toHaveProperty('failure')
    })

    it('unreadable checks on the last round: no limit block, and the cycle is not asked to consume a round', async () => {
      const afterVerificationFailure = vi.fn(limitReached)
      const deliver = vi.fn<[AttemptDelivery], Promise<AttemptDeliveryResult>>()

      const {action} = await dispatch({
        stdout: JSON.stringify(AUTOPILOT_RESULT), executionPhase: 'autopilot', ticketCode: 'CYAU-306',
        verify: async () => ({status: 'unavailable' as const, summary: 'GitHub non raggiungibile'}),
        afterVerificationFailure, deliver,
      })

      expect(afterVerificationFailure).not.toHaveBeenCalled()
      expect(deliver).not.toHaveBeenCalled()
      expect(action.status).toBe('failure')
      expect(action.errorCode).toBe('C503-GATE-004')
    })
  })

  // CYAU-295 — the phone test sits between the CI and the cross-review.
  describe('emulator test (CYAU-295)', () => {
    const passedCi = () => vi.fn(async () => ({status: 'passed' as const, summary: 'CI verde', headSha: 'a'.repeat(40)}))

    it('runs after the CI and before the promotion and the delivery', async () => {
      const verify = passedCi()
      const emulatorTest = vi.fn(async () => ({status: 'passed' as const, summary: 'Prova su telefono superata.'}))
      const finalize = vi.fn(async () => ({status: 'passed' as const, summary: 'PR ready', headSha: 'a'.repeat(40)}))
      const deliver = vi.fn(async (): Promise<AttemptDeliveryResult> => ({outcome: 'ok', status: 200}))

      const {action} = await dispatch({
        stdout: JSON.stringify(AUTOPILOT_RESULT), executionPhase: 'autopilot', verify, emulatorTest, finalize, deliver,
      })

      expect(emulatorTest).toHaveBeenCalledWith(AUTOPILOT_RESULT, expect.anything())
      expect(verify.mock.invocationCallOrder[0]).toBeLessThan(emulatorTest.mock.invocationCallOrder[0])
      expect(emulatorTest.mock.invocationCallOrder[0]).toBeLessThan(finalize.mock.invocationCallOrder[0])
      expect(deliver).toHaveBeenCalledTimes(1)
      expect(action.status).toBe('success')
    })

    it('a red CI does not even turn the phone on', async () => {
      const emulatorTest = vi.fn()
      await dispatch({
        stdout: JSON.stringify(AUTOPILOT_RESULT), executionPhase: 'autopilot', deliver: vi.fn(), emulatorTest,
        verify: vi.fn(async () => ({status: 'failed' as const, summary: 'CI rossa'})),
      })
      expect(emulatorTest).not.toHaveBeenCalled()
    })

    it('a crash goes back to the agent: no review, no promotion, no delivery', async () => {
      const emulatorTest = vi.fn(async () => ({status: 'failed' as const, summary: 'Prova su telefono fallita: crash.'}))
      const afterVerificationFailure = vi.fn(async () => ({outcome: 'complete' as const, runStatus: 'failure' as const, errorCode: 'C409-CYCLE-001'}))
      const finalize = vi.fn()
      const deliver = vi.fn<[AttemptDelivery], Promise<AttemptDeliveryResult>>()

      const {action} = await dispatch({
        stdout: JSON.stringify(AUTOPILOT_RESULT), executionPhase: 'autopilot',
        verify: passedCi(), emulatorTest, afterVerificationFailure, finalize, deliver,
      })

      expect(afterVerificationFailure).toHaveBeenCalledWith('Prova su telefono fallita: crash.')
      expect(finalize).not.toHaveBeenCalled()
      expect(deliver).not.toHaveBeenCalled()
      expect(action.status).toBe('failure')
      expect(action.errorCode).toBe('C409-CYCLE-001')
    })

    it('after a crash the agent works again and the next green test delivers once', async () => {
      const emulatorTest = vi.fn()
        .mockResolvedValueOnce({status: 'failed' as const, summary: 'crash'})
        .mockResolvedValueOnce({status: 'passed' as const, summary: 'ok'})
      const afterVerificationFailure = vi.fn(async () => ({outcome: 'retry' as const, retryPrompt: 'Correggi il crash.'}))
      const deliver = vi.fn(async (): Promise<AttemptDeliveryResult> => ({outcome: 'ok', status: 200}))

      await dispatch({
        stdout: JSON.stringify(AUTOPILOT_RESULT), executionPhase: 'autopilot', authorizedCwd: dir,
        emulatorTest, afterVerificationFailure, deliver,
      })

      expect(emulatorTest).toHaveBeenCalledTimes(2)
      expect(deliver).toHaveBeenCalledTimes(1)
    })

    it('a crash without a way back is a failed gate', async () => {
      const deliver = vi.fn<[AttemptDelivery], Promise<AttemptDeliveryResult>>()
      const {action} = await dispatch({
        stdout: JSON.stringify(AUTOPILOT_RESULT), executionPhase: 'autopilot', deliver,
        emulatorTest: vi.fn(async () => ({status: 'failed' as const, summary: 'crash'})),
      })
      expect(deliver).not.toHaveBeenCalled()
      expect(action.errorCode).toBe('C409-GATE-002')
    })

    it('a machine that cannot run a required test stops the delivery as unavailable, never as a crash', async () => {
      const afterVerificationFailure = vi.fn()
      const deliver = vi.fn<[AttemptDelivery], Promise<AttemptDeliveryResult>>()
      const {action} = await dispatch({
        stdout: JSON.stringify(AUTOPILOT_RESULT), executionPhase: 'autopilot', deliver, afterVerificationFailure,
        emulatorTest: vi.fn(async () => ({status: 'unavailable' as const, summary: 'niente KVM'})),
      })
      expect(afterVerificationFailure).not.toHaveBeenCalled()
      expect(deliver).not.toHaveBeenCalled()
      expect(action.status).toBe('failure')
      expect(action.errorCode).toBe('C503-GATE-004')
    })
  })

  it('non-attestable draft→ready promotion: does not deliver to the server', async () => {
    const verify = vi.fn(async () => ({status: 'passed' as const, summary: 'CI verde', headSha: 'a'.repeat(40)}))
    const finalize = vi.fn(async () => ({status: 'unavailable' as const, summary: 'GitHub non raggiungibile'}))
    const deliver = vi.fn<[AttemptDelivery], Promise<AttemptDeliveryResult>>()

    const {action} = await dispatch({
      stdout: JSON.stringify(AUTOPILOT_RESULT), executionPhase: 'autopilot', verify, finalize, deliver,
    })

    expect(deliver).not.toHaveBeenCalled()
    expect(action.status).toBe('failure')
    expect(action.errorCode).toBe('C503-GATE-004')
  })

  it('non-interpretable result WITHOUT ticket code: no delivery, and the reason ends up in the action log', async () => {
    const deliver = vi.fn<[AttemptDelivery], Promise<AttemptDeliveryResult>>()
    const {log, action} = await dispatch({
      // It is the case observed on minion-1 on 2026-07-30: the skill stops in prose instead of emitting the JSON.
      stdout: 'Since the interactive question tool isn\'t available here, I\'ll lay out the options in text and stop.',
      deliver,
    })

    // Outside the queue there is no ticket code, so no contract-conforming `blocked` can be
    // built: a result that does not respect the contract is not delivered, the fail-closed stays.
    expect(deliver).not.toHaveBeenCalled()
    expect(action.status).toBe('failure')
    expect(action.errorCode).toBe('C422-WORKFLOW-001')
    expect(action.delivery).toMatchObject({
      outcome: 'not-attempted', phase: 'triage', attemptId: 'attempt-1',
      errorCode: 'C422-WORKFLOW-001', reviewStatus: 'unavailable', logAppended: true,
    })
    // The point of CYAU-105: before this the system was SILENT. Now the file says what went wrong...
    expect(log).toContain('# delivery: not-attempted')
    expect(log).toContain('# error_code: C422-WORKFLOW-001')
    expect(log).toContain('# attempt_id: attempt-1')
    // ...the WHY (CYAU-192)...
    expect(log).toContain('# issues: nessun oggetto JSON riconosciuto nell\'output')
    // ...and shows what the output looked like, which is the only way to understand WHY it was not interpretable.
    expect(log).toContain('lay out the options in text and stop')
    // Append-only: the runAction footer stays, the terminal verdict follows it.
    expect(log.indexOf('# status: success')).toBeLessThan(log.indexOf('# delivery: not-attempted'))
  })

  // CYAU-192 — an out-of-contract result does NOT stay on the machine. Before, no PUT left from here: the
  // server marked the run "interrupted" after the stall and stopped it after two times, and whoever looked at the
  // ticket knew nothing. Now the host delivers a synthetic `blocked` with the reason.
  describe('non-interpretable result with a claimed ticket: delivers a synthetic blocked (CYAU-192)', () => {
    const ENUM_INVENTATO = {
      contract_version: 2, code: 'CYAU-192', state: 'blocked', security_findings: [],
      // CYRA-1197 — an invented failure category is now read as `unknown`: the invented value sits in another closed list.
      review: {verdict: 'git_auth'},
      failure: {category: 'authentication', summary: 'Git non si autentica.', retryable: false, human_action: 'Ruotare.'},
    }

    it('autopilot: contract v2, retryable failure with the reason, review declared by the host, no gate nor reviewer', async () => {
      const deliver = vi.fn(async (): Promise<AttemptDeliveryResult> => ({outcome: 'ok', status: 200, attempt: {status: 'blocked'}}))
      const verify = vi.fn()
      const finalize = vi.fn()
      const reviewOnDiff = vi.fn()
      const afterAccepted = vi.fn(async () => ({outcome: 'complete' as const, runStatus: 'success' as const, errorCode: null}))
      const seenReviewer: {action?: {cwd?: string}} = {}
      const token = `cyi_ah_${'A'.repeat(24)}`

      const {log, action} = await dispatch({
        stdout: `Ho finito. Token usato: ${token}\n\`\`\`json\n${JSON.stringify(ENUM_INVENTATO, null, 2)}\n\`\`\`\n`,
        executionPhase: 'autopilot', ticketCode: 'CYAU-192',
        deliver, verify, finalize, reviewOnDiff, afterAccepted, seenReviewer,
      })

      expect(deliver).toHaveBeenCalledTimes(1)
      const payload = deliver.mock.calls[0][0] as AttemptDelivery
      expect(payload).toMatchObject({
        runtime: 'claude', reviewer_runtime: 'codex',
        review: {status: 'accepted', depth: 'result', summary: 'Generata dall\'host: nessun risultato da rileggere'},
        result: {
          contract_version: 2, code: 'CYAU-192', state: 'blocked', security_findings: [],
          failure: {
            category: 'unknown', retryable: true,
            summary: expect.stringMatching(/^Risultato non interpretabile: review\.verdict: .*received "git_auth"/u),
            human_action: 'Se si ripete, rileggere le istruzioni della skill: il modello non ha rispettato il formato del risultato',
          },
        },
      })
      // The stdout excerpt travels redacted: the token does not leave the machine.
      const detail = (payload.result.failure as {technical_detail: string}).technical_detail
      expect(detail).toContain('"verdict": "git_auth"')
      expect(detail).not.toContain(token)
      // No review fingerprint: there is no diff that was read.
      expect(payload.review).not.toHaveProperty('reviewed_diff_sha256')
      // No CI, no PR promotion, no reviewer (neither on the diff nor on the report): there is
      // nothing to verify, and paying for a session to say so would be a waste.
      expect(verify).not.toHaveBeenCalled()
      expect(finalize).not.toHaveBeenCalled()
      expect(reviewOnDiff).not.toHaveBeenCalled()
      expect(seenReviewer.action).toBeUndefined()
      // The local state is closed as for every accepted delivery.
      expect(afterAccepted).toHaveBeenCalledTimes(1)
      // The action outcome stays the failure with its cause; the disposition is that of a delivery.
      expect(action.status).toBe('failure')
      expect(action.errorCode).toBe('C422-WORKFLOW-001')
      expect(action.delivery).toMatchObject({
        outcome: 'ok', phase: 'autopilot', attemptId: 'attempt-1', errorCode: 'C422-WORKFLOW-001',
        reviewStatus: 'accepted', attemptStatus: 'blocked', concluded: false, logAppended: true,
      })
      expect(log).toContain('# delivery: ok')
      expect(log).toContain('# error_code: C422-WORKFLOW-001')
      expect(log).toContain('# synthetic_result: blocked')
      expect(log).toMatch(/# issues: review\.verdict: .*received "git_auth"/u)
      expect(log).toContain('# ---- risultato non interpretabile (fase autopilot) ----')
      expect(log).not.toContain(token)
    })

    it('the footer issues line has a cap with a marker: a pathological output does not bloat the log', async () => {
      const deliver = vi.fn(async (): Promise<AttemptDeliveryResult> => ({outcome: 'ok', status: 200}))
      // Hundreds of wrong keys inside `failure` (strict): one finding for each.
      const failure = Object.fromEntries(Array.from({length: 400}, (_, index) => [`chiave_inventata_${index}`, 'x']))
      const {log} = await dispatch({
        stdout: JSON.stringify({...ENUM_INVENTATO, failure}), executionPhase: 'autopilot', ticketCode: 'CYAU-192', deliver,
      })
      const line = log.split('\n').find((row) => row.startsWith('# issues: '))!
      expect(line).toBeDefined()
      expect(line.length).toBeLessThan(4096 + 100)
      expect(line).toMatch(/ … \[\d+ caratteri omessi\]$/u)
    })

    it('planner: same v2 shape of the contract', async () => {
      const deliver = vi.fn(async (): Promise<AttemptDeliveryResult> => ({outcome: 'ok', status: 200}))
      await dispatch({
        stdout: JSON.stringify({code: 'CYRA-1', state: 'submitted-for-approval', plan: 'in prosa'}),
        executionPhase: 'planner', ticketCode: 'CYRA-1', deliver,
      })
      expect(deliver.mock.calls[0][0].result).toMatchObject({
        contract_version: 2, code: 'CYRA-1', state: 'blocked', failure: {category: 'unknown', retryable: true},
      })
    })

    it('triage (contract v1, without blocked): escalated with unreachable cause and the reason among the reasons', async () => {
      const deliver = vi.fn(async (): Promise<AttemptDeliveryResult> => ({outcome: 'ok', status: 200}))
      await dispatch({
        stdout: JSON.stringify({...TRIAGE_RESULT, category: 'frontend'}),
        executionPhase: 'triage', ticketCode: 'CYRA-199', deliver,
      })
      expect(deliver.mock.calls[0][0].result).toMatchObject({
        code: 'CYRA-199', state: 'escalated', causa: 'unreachable', requires_human_approval: true,
        reasons: [expect.stringMatching(/^Risultato non interpretabile: category: .*received "frontend"/u)],
      })
    })

    it.each(['closer_staging', 'closer_production'] as ExecutionPhase[])('%s (contract v1): blocked, tag null, unreachable cause', async (phase) => {
      const deliver = vi.fn(async (): Promise<AttemptDeliveryResult> => ({outcome: 'ok', status: 200}))
      await dispatch({
        stdout: JSON.stringify({code: 'CYRA-2', state: 'released', tag: 'v1.2.3'}),
        executionPhase: phase, ticketCode: 'CYRA-2', deliver,
      })
      expect(deliver.mock.calls[0][0].result).toMatchObject({
        code: 'CYRA-2', state: 'blocked', tag: null, causa: 'unreachable',
        reason: expect.stringMatching(/^Risultato non interpretabile: state: /u),
      })
    })

    it('the server rejects the synthetic blocked: rejection logged with its code, the local state is not closed', async () => {
      const deliver = vi.fn(async (): Promise<AttemptDeliveryResult> => ({outcome: 'rejected', status: 422, code: 'R422-ATTEMPT-001'}))
      const afterAccepted = vi.fn()
      const {log, action} = await dispatch({stdout: 'prosa', executionPhase: 'autopilot', ticketCode: 'CYAU-192', deliver, afterAccepted})

      expect(afterAccepted).not.toHaveBeenCalled()
      expect(action.status).toBe('failure')
      expect(action.errorCode).toBe('C422-WORKFLOW-001')
      expect(action.delivery).toMatchObject({
        outcome: 'rejected', errorCode: 'C409-WORKFLOW-002', httpStatus: 422, serverErrorCode: 'R422-ATTEMPT-001',
        reviewStatus: 'accepted',
      })
      expect(log).toContain('# delivery: rejected')
      expect(log).toContain('# server_error_code: R422-ATTEMPT-001')
    })

    it('the delivery does not arrive: indeterminate outcome, not a rejection', async () => {
      const deliver = vi.fn(async (): Promise<AttemptDeliveryResult> => ({outcome: 'unavailable', status: 503}))
      const {action} = await dispatch({stdout: 'prosa', executionPhase: 'autopilot', ticketCode: 'CYAU-192', deliver})
      expect(action.delivery).toMatchObject({outcome: 'unavailable', errorCode: 'C502-WORKFLOW-003', httpStatus: 503})
    })

    // `retryable: true` without a limit would be a loop: the server puts the phase back in the queue, and the host
    // picks it again. The local per-ticket cap trips at CLAIM (before the session), not at delivery: here it is
    // tested that this branch does not touch it — it neither resets nor skips the count — so after N discards the
    // phase is `exhausted` exactly as today.
    it('after N consecutive discards the per-ticket counter says exhausted: the synthetic blocked does not reset it', async () => {
      const attemptsDir = fs.mkdtempSync(path.join(os.tmpdir(), 'automator-attempts-'))
      const deliver = vi.fn(async (): Promise<AttemptDeliveryResult> => ({outcome: 'ok', status: 200}))
      const limit = 3
      for (let round = 0; round < limit; round++) {
        // What the preflight does at the claim of every session.
        recordTicketAttempt({project: 'CYAU', ticket: 'CYAU-192', phase: 'autopilot', now}, attemptsDir)
        expect(evaluateTicketAttempts(readTicketAttempts('CYAU', 'CYAU-192', attemptsDir).record, limit, 'autopilot').outcome)
          .toBe(round + 1 < limit ? 'admit' : 'exhausted')
        await dispatch({stdout: 'prosa', executionPhase: 'autopilot', ticketCode: 'CYAU-192', deliver})
      }
      expect(deliver).toHaveBeenCalledTimes(limit)
      const record = readTicketAttempts('CYAU', 'CYAU-192', attemptsDir).record
      expect(record).toMatchObject({attempts: limit, phase: 'autopilot'})
      expect(evaluateTicketAttempts(record, limit, 'autopilot')).toEqual({outcome: 'exhausted', attempts: limit, limit})
      fs.rmSync(attemptsDir, {recursive: true, force: true})
    })
  })

  // CYAU-104: under the service the session died in two seconds (exit 2, C001-EXEC-003) because the launcher
  // started as mise; the first defect (argv0) fixes it. For the RESIDUAL execution failures (timeout, crash)
  // the automator must NOT deliver a `review_failed`: it would be the only outcome the PUT produces, but it would consume
  // the two-cycle review budget — meant for rejections of delivered work — and would block the phase
  // after two possibly transient failures. It must instead release the lease and let the server stale
  // fallback (orphaned_at, CYRA-201) close the attempt without budget and requeue the phase. This test locks that
  // invariant: the regression to avoid is re-introducing a failure delivery that spends the review budget.
  it('failed execution: no review_failed delivery, the lease is released for the stale fallback (CYAU-104)', async () => {
    const s = scenario()
    const deliver = vi.fn<[AttemptDelivery], Promise<AttemptDeliveryResult>>()
    const release = vi.fn(async () => undefined)
    const failingRuntime: AgentRuntime = {
      id: 'fake-claude', healthCheck: async () => ({available: true}),
      execute: () => ({
        result: Promise.resolve<RunResult>({
          status: 'failure', exitCode: 2, errorCode: 'C001-EXEC-003', durationMs: 1,
          logPath: s.logPath, stdout: '', stdoutTruncated: false,
        }),
        cancel: () => undefined,
      }),
    }
    const result = await runOnce({
      playbook, playbookDir: dir, now,
      stateFile: s.stateFile, logDir: s.logDir, lockFile: s.lockFile,
      claudeRuntime: failingRuntime,
      codexRuntime: approvingReviewer(),
      preflight: async () => ({
        outcome: 'admit', state: 'ready', reason: 'ok', audit: [],
        executionLease: {renewEveryMs: 60_000, renew: async () => true, release},
        workflowDelivery: {executionPhase: 'triage', attemptId: 'attempt-1', deliver},
      }),
    })

    const action = result.executed[0]
    // NO delivery: an execution failure does not spend the review budget (which is for rejections of delivered
    // work). No DeliveryRecord.
    expect(deliver).not.toHaveBeenCalled()
    expect(action.delivery).toBeUndefined()
    expect(action.status).toBe('failure')
    expect(action.errorCode).toBe('C001-EXEC-003')
    // The lease IS released: it is what makes the attempt orphan and hands it to the server stale fallback,
    // which closes it without budget and requeues the phase.
    expect(release).toHaveBeenCalled()
  })

  it('stdout truncation: logged, not guessed', async () => {
    const {action, log} = await dispatch({
      stdout: '{"type":"result","result":"{\\"code\\":\\"CYRA-199\\"',
      stdoutTruncated: true,
      deliver: vi.fn<[AttemptDelivery], Promise<AttemptDeliveryResult>>(),
    })
    expect(action.delivery).toMatchObject({outcome: 'not-attempted', stdoutTruncated: true})
    expect(log).toContain('# stdout_truncated: true')
  })

  it('delivery rejected by the server: reports the HTTP status and the code, not a yes/no', async () => {
    const deliver = vi.fn(async (): Promise<AttemptDeliveryResult> => ({
      outcome: 'rejected', status: 422, code: 'R422-ATTEMPT-001',
    }))
    const {action, log} = await dispatch({stdout: JSON.stringify(TRIAGE_RESULT), deliver})

    expect(deliver).toHaveBeenCalledTimes(1)
    expect(action.status).toBe('failure')
    expect(action.errorCode).toBe('C409-WORKFLOW-002')
    expect(action.delivery).toMatchObject({
      outcome: 'rejected', httpStatus: 422, serverErrorCode: 'R422-ATTEMPT-001',
      errorCode: 'C409-WORKFLOW-002', reviewStatus: 'accepted',
    })
    expect(log).toContain('# http_status: 422')
    expect(log).toContain('# server_error_code: R422-ATTEMPT-001')
  })

  // CYAU-171 — the log writes what the SERVER decided, not what the network answered.
  // Today the two coincide, but by luck: the day the server says "accepted, still
  // looking", the machine would write the green line anyway, and whoever opens the log to understand
  // why a run is stuck would read that it went fine.
  it('with the server declaring the attempt concluded, the log writes it', async () => {
    const deliver = vi.fn(async (): Promise<AttemptDeliveryResult> => ({
      outcome: 'ok', status: 200, attempt: {status: 'approved'},
    }))
    const {action, log} = await dispatch({stdout: JSON.stringify(TRIAGE_RESULT), deliver})

    expect(action.delivery).toMatchObject({outcome: 'ok', attemptStatus: 'approved', concluded: true})
    expect(log).toContain('# attempt_status: approved')
    expect(log).toContain('# concluded: true')
  })

  // The answer that does not exist yet today, and the reason this ticket exists: the white
  // list puts it among the NOT concluded ones without the host having to be updated.
  it('a new server state does not become "concluded" by oversight', async () => {
    const deliver = vi.fn(async (): Promise<AttemptDeliveryResult> => ({
      outcome: 'ok', status: 200, attempt: {status: 'awaiting_review'},
    }))
    const {action, log} = await dispatch({stdout: JSON.stringify(TRIAGE_RESULT), deliver})

    expect(action.delivery).toMatchObject({outcome: 'ok', attemptStatus: 'awaiting_review', concluded: false})
    expect(log).toContain('# attempt_status: awaiting_review')
    expect(log).toContain('# concluded: false')
  })

  // Successful delivery but unreadable answer: the work is delivered, the outcome is not. And the log must
  // say the second thing without suggesting the first.
  it('with the unreadable answer the log says "not read", not "concluded"', async () => {
    const deliver = vi.fn(async (): Promise<AttemptDeliveryResult> => ({outcome: 'ok', status: 200}))
    const {action, log} = await dispatch({stdout: JSON.stringify(TRIAGE_RESULT), deliver})

    expect(action.delivery).toMatchObject({outcome: 'ok', concluded: false})
    expect(action.delivery?.attemptStatus).toBeUndefined()
    expect(log).toContain('# attempt_status: non letto')
    expect(log).not.toContain('# concluded: true')
  })

  it('undelivered delivery (network/5xx): INDETERMINATE outcome, distinct from a rejection', async () => {
    const deliver = vi.fn(async (): Promise<AttemptDeliveryResult> => ({outcome: 'unavailable', status: 503}))
    const {action, log} = await dispatch({stdout: JSON.stringify(TRIAGE_RESULT), deliver})

    // A 5xx is not "rejected": the server may have applied it without the answer coming back. Different code.
    expect(action.errorCode).toBe('C502-WORKFLOW-003')
    expect(action.delivery).toMatchObject({outcome: 'unavailable', httpStatus: 503})
    expect(log).toContain('# delivery: unavailable')
  })

  it('outdated host credential: 401 stays 401, not a generic failure', async () => {
    const deliver = vi.fn(async (): Promise<AttemptDeliveryResult> => ({outcome: 'unauthorized', status: 401}))
    const {action} = await dispatch({stdout: JSON.stringify(TRIAGE_RESULT), deliver})
    expect(action.delivery).toMatchObject({outcome: 'unauthorized', httpStatus: 401, errorCode: 'C502-WORKFLOW-003'})
  })

  it('successful delivery: the payload carries result and review, and the log records it', async () => {
    const deliver = vi.fn(async (): Promise<AttemptDeliveryResult> => ({outcome: 'ok', status: 200}))
    const {action, log} = await dispatch({executionPhase: 'planner', 
      // Real CLI envelope: the result arrives nested in `result` as a string.
      stdout: JSON.stringify({type: 'result', subtype: 'success', is_error: false, result: JSON.stringify(PLANNER_RESULT)}),
      deliver,
    })

    expect(deliver).toHaveBeenCalledWith({
      runtime: 'claude',
      reviewer_runtime: 'codex',
      result: PLANNER_RESULT,
      // CYAU-176 — the host declares `depth` on EVERY delivery: a report that does not say how it was
      // reviewed is a report missing the part that matters, and the server no longer accepts it.
      review: {status: 'accepted', summary: 'Conforme', depth: 'result'},
      // CYRA-872 — the model always travels; the cost only when the CLI declares it (not here).
      model: 'claude-opus-5-5',
    })
    expect(action.status).toBe('success')
    expect(action.errorCode).toBeNull()
    expect(action.delivery).toMatchObject({outcome: 'ok', errorCode: null, reviewStatus: 'accepted', logAppended: true})
    // A completed delivery is also a fact to record: without it, "no line" would stay ambiguous.
    expect(log).toContain('# delivery: ok')
  })

  // CYAU-106: the shape observed on minion-1 — the result framed in markdown inside `result`. Before,
  // the parser did not recognize it, so the delivery did not start at all. This closes the loop end-to-end:
  // not only does the parser extract it, the result really reaches the server.
  it('result in a code block: it is now delivered', async () => {
    const deliver = vi.fn(async (): Promise<AttemptDeliveryResult> => ({outcome: 'ok', status: 200}))
    const {action, log} = await dispatch({
      stdout: JSON.stringify({
        type: 'result', subtype: 'success', is_error: false, num_turns: 18,
        result: `Ho classificato il ticket.\n\n\`\`\`json\n${JSON.stringify(TRIAGE_RESULT, null, 2)}\n\`\`\`\n`,
      }),
      deliver,
    })

    expect(deliver).toHaveBeenCalledWith(expect.objectContaining({result: TRIAGE_RESULT}))
    expect(action.status).toBe('success')
    expect(action.delivery).toMatchObject({outcome: 'ok', errorCode: null})
    expect(log).toContain('# delivery: ok')
  })

  // CYAU-335 — a reviewer that died says nothing about the work: before, this delivered `review: unavailable`,
  // which the server reads exactly like a rejection. Now the delivery is held and the work keeps its attempt.
  it('a reviewer that died holds the delivery instead of rejecting the work', async () => {
    const deliver = vi.fn<[AttemptDelivery], Promise<AttemptDeliveryResult>>()
      .mockResolvedValue({outcome: 'ok', status: 200})
    const reportFailure = vi.fn(async (_reason: string) => undefined)
    const settled: boolean[] = []
    const sessions: number[] = []
    const waits: number[] = []
    const brokenReviewer: AgentRuntime = {
      id: 'fake-codex', healthCheck: async () => ({available: true}),
      execute: () => (sessions.push(1), {
        result: Promise.resolve<RunResult>({
          status: 'failure', exitCode: 1, errorCode: 'C001-EXEC-003', durationMs: 1,
          logPath: '', stdout: '', stdoutTruncated: false,
        }),
        cancel: () => undefined,
      }),
    }

    const {action, log} = await dispatch({executionPhase: 'planner', 
      stdout: JSON.stringify(PLANNER_RESULT), deliver, reviewer: brokenReviewer, reportFailure,
      settleQuotaPause: (paused) => settled.push(paused),
      sleep: async (ms) => { waits.push(ms) },
    })

    // AC-4: tried again by itself, after a wait, and only once — never a loop.
    expect(sessions).toHaveLength(2)
    expect(waits).toEqual([REVIEW_RETRY_WAIT_MS])
    expect(log).toContain('# review_retry: 2')
    // AC-2/AC-3: nothing delivered, so the server never reads it as a rejection, and the attempt goes back.
    expect(deliver).not.toHaveBeenCalled()
    expect(settled).toEqual([true])
    expect(action.errorCode).toBe('C503-REVIEW-004')
    expect(action.delivery).toMatchObject({outcome: 'not-attempted', reviewStatus: 'unavailable', errorCode: 'C503-REVIEW-004'})
    // AC-5: the ticket's history says it was a fault, not a judgement on the work.
    expect(reportFailure.mock.calls[0]![0]).toContain('technical fault')
    expect(reportFailure.mock.calls[0]![0]).toContain('not a rejection of the work')
  })

  it('a reviewer whose sign-in expired is not asked twice: a second session meets the same wall', async () => {
    const reviewLog = path.join(dir, `revoked-${counter}.log`)
    fs.writeFileSync(reviewLog, 'ERROR: refresh token was revoked (token_revoked)\n')
    const sessions: number[] = []
    const revokedReviewer: AgentRuntime = {
      id: 'fake-codex', healthCheck: async () => ({available: true}),
      execute: () => (sessions.push(1), {
        result: Promise.resolve<RunResult>({
          status: 'failure', exitCode: 1, errorCode: 'C001-EXEC-003', durationMs: 1,
          logPath: reviewLog, stdout: '', stdoutTruncated: false,
        }),
        cancel: () => undefined,
      }),
    }
    const deliver = vi.fn<[AttemptDelivery], Promise<AttemptDeliveryResult>>()
      .mockResolvedValue({outcome: 'ok', status: 200})
    const waits: number[] = []

    const {action} = await dispatch({executionPhase: 'planner', 
      stdout: JSON.stringify(PLANNER_RESULT), deliver, reviewer: revokedReviewer,
      sleep: async (ms) => { waits.push(ms) },
    })

    expect(sessions).toHaveLength(1)
    expect(waits).toEqual([])
    expect(deliver).not.toHaveBeenCalled()
    expect(action.errorCode).toBe('C503-REVIEW-004')
  })

  // Seen on AAC-13: three machines took the ticket and their session died within a minute. The lease was
  // released with no word, and the card only said «lease released».
  it('a session that dies without delivering says so on the attempt', async () => {
    const s = scenario()
    const deliver = vi.fn(async (): Promise<AttemptDeliveryResult> => ({outcome: 'ok', status: 200}))
    const reportFailure = vi.fn(async (_reason: string) => undefined)
    const dead: AgentRuntime = {
      id: 'fake-claude', healthCheck: async () => ({available: true}),
      execute: () => ({
        result: Promise.resolve<RunResult>({
          status: 'failure', exitCode: 137, errorCode: 'C001-EXEC-003', durationMs: 1,
          logPath: '', stdout: '', stdoutTruncated: false,
        }),
        cancel: () => undefined,
      }),
    }

    await runOnce({
      playbook, playbookDir: dir, now,
      stateFile: s.stateFile, logDir: s.logDir, lockFile: s.lockFile,
      claudeRuntime: dead,
      preflight: async () => ({
        outcome: 'admit', state: 'ready', reason: 'ok', audit: [],
        executionLease: {renewEveryMs: 60_000, renew: async () => true, release: async () => undefined},
        workflowDelivery: {executionPhase: 'triage', attemptId: 'attempt-1', deliver, reportFailure},
      }),
    })

    expect(deliver).not.toHaveBeenCalled()
    expect(reportFailure).toHaveBeenCalledTimes(1)
    expect(reportFailure.mock.calls[0][0]).toMatch(/C001-EXEC-003/)
    expect(reportFailure.mock.calls[0][0]).toMatch(/137/)
  })

  it('a non-writable log is declared, not hidden', async () => {
    const s = scenario()
    const deliver = vi.fn<[AttemptDelivery], Promise<AttemptDeliveryResult>>()
    const result = await runOnce({
      playbook, playbookDir: dir, now,
      stateFile: s.stateFile, logDir: s.logDir, lockFile: s.lockFile,
      // logPath in a non-existent directory: the append fails.
      claudeRuntime: runtimeWith('prosa', path.join(s.logDir, 'nessuna-directory', 'work.log')),
      codexRuntime: approvingReviewer(),
      preflight: async () => ({
        outcome: 'admit', state: 'ready', reason: 'ok', audit: [],
        executionLease: {renewEveryMs: 60_000, renew: async () => true, release: async () => undefined},
        workflowDelivery: {executionPhase: 'triage', attemptId: 'attempt-1', deliver},
      }),
    })

    // The tick does not go down for a missed log, but the log failure is in the result: the daemon
    // prints it. A log silent about being silent would be the same original failure.
    expect(result.executed[0].delivery).toMatchObject({outcome: 'not-attempted', logAppended: false})
  })

  it('shell action: no delivery, the branch stays host-first', async () => {
    const s = scenario()
    const deliver = vi.fn<[AttemptDelivery], Promise<AttemptDeliveryResult>>()
    const shellPlaybook = PlaybookSchema.parse({
      version: 1, actions: {work: {schedule: 'every 1m', type: 'shell', run: 'echo x'}},
    })
    const result = await runOnce({
      playbook: shellPlaybook, playbookDir: dir, now,
      stateFile: s.stateFile, logDir: s.logDir, lockFile: s.lockFile,
      runtime: runtimeWith(JSON.stringify(TRIAGE_RESULT), s.logPath),
      preflight: async () => ({
        outcome: 'admit', state: 'ready', reason: 'ok', audit: [],
        executionLease: {renewEveryMs: 60_000, renew: async () => true, release: async () => undefined},
        workflowDelivery: {executionPhase: 'triage', attemptId: 'attempt-1', deliver},
      }),
    })

    expect(deliver).not.toHaveBeenCalled()
    expect(result.executed[0].delivery).toBeUndefined()
    expect(result.executed[0].status).toBe('success')
  })

  // CYAU-110: under the queue the action receives the AUTHORIZED ticket cwd, and the executor rejects before the
  // spawn a session whose cwd does not match (C400-EXEC-004). The reviewer was born without cwd, so it
  // NEVER started and every delivery was rejected for unavailable review: the triage succeeded, the work did not.
  // The failure of 23/09: Codex disconnected, and the daemon wrote only `review=unavailable`.
  it('a failed review records its reason, delivering nothing', async () => {
    const reviewLog = path.join(dir, `review-${counter}.log`)
    fs.writeFileSync(reviewLog, 'ERROR: refresh token was revoked (token_revoked)\n')
    const brokenReviewer: AgentRuntime = {
      id: 'fake-codex', healthCheck: async () => ({available: true}),
      execute: () => ({
        result: Promise.resolve<RunResult>({
          status: 'failure', exitCode: 1, errorCode: 'C001-EXEC-003', durationMs: 1, logPath: reviewLog,
          stdout: '', stdoutTruncated: false,
        }),
        cancel: () => undefined,
      }),
    }
    const deliver = vi.fn<[AttemptDelivery], Promise<AttemptDeliveryResult>>()
      .mockResolvedValue({outcome: 'rejected', status: 409, code: 'R409-ATTEMPT-003'})

    const invalidate = vi.spyOn(agentRuntimeReadiness, 'invalidate')

    const {action} = await dispatch({executionPhase: 'planner', stdout: JSON.stringify(PLANNER_RESULT), deliver, reviewer: brokenReviewer})

    // CYAU-335 — the reason stays on the record even though nothing was delivered: it is the only place the
    // operator reads why the review did not happen.
    expect(deliver).not.toHaveBeenCalled()
    expect(action.delivery?.reviewDetail).toBe('codex: autenticazione scaduta o revocata')
    // CYAU-208 — at the next round the machine re-probes the runtimes instead of trusting the probe from an hour ago.
    expect(invalidate).toHaveBeenCalled()
    invalidate.mockRestore()
  })

  // CYRA-921
  it('a machine set to same-engine review is reviewed by its own engine in a second session', async () => {
    const actions: Array<{type: string; permission_mode?: string}> = []
    const s = scenario()
    const implementer: AgentRuntime = {
      id: 'fake-claude', healthCheck: async () => ({available: true}),
      execute: (_name: string, action: {type: string; permission_mode?: string}) => {
        actions.push(action)
        const stdout = actions.length === 1 ? JSON.stringify(PLANNER_RESULT) : '{"status":"accepted","summary":"Conforme"}'
        return {
          result: Promise.resolve<RunResult>({
            status: 'success', exitCode: 0, errorCode: null, durationMs: 1, logPath: s.logPath, stdout, stdoutTruncated: false,
          }),
          cancel: () => undefined,
        }
      },
    }
    const codex = {...approvingReviewer(), execute: vi.fn(approvingReviewer().execute)}
    const deliver = vi.fn<[AttemptDelivery], Promise<AttemptDeliveryResult>>().mockResolvedValue({outcome: 'ok', status: 200})

    await dispatch({executionPhase: 'planner', stdout: '', deliver, implementer, reviewer: codex, reviewMode: 'same'})

    expect(codex.execute).not.toHaveBeenCalled()
    expect(actions).toHaveLength(2)
    expect(actions[1]).toMatchObject({type: 'claude', permission_mode: 'plan'})
    expect(deliver.mock.calls[0][0]).toMatchObject({runtime: 'claude', reviewer_runtime: 'claude', review: {status: 'accepted'}})
  })

  it('keeps the other engine as reviewer by default', async () => {
    const deliver = vi.fn<[AttemptDelivery], Promise<AttemptDeliveryResult>>().mockResolvedValue({outcome: 'ok', status: 200})

    await dispatch({stdout: JSON.stringify(TRIAGE_RESULT), deliver})

    expect(deliver.mock.calls[0][0]).toMatchObject({runtime: 'claude', reviewer_runtime: 'codex'})
  })

  it('the reviewer runs in the same authorized directory as the phase', async () => {
    const seenReviewer: {action?: {cwd?: string}} = {}
    const deliver = vi.fn<[AttemptDelivery], Promise<AttemptDeliveryResult>>()
      .mockResolvedValue({outcome: 'ok', status: 200})

    await dispatch({executionPhase: 'planner', stdout: JSON.stringify(PLANNER_RESULT), deliver, cwd: dir, seenReviewer})

    expect(seenReviewer.action?.cwd).toBe(dir)
    expect(deliver).toHaveBeenCalled()
  })
  // ── CYAU-176 ────────────────────────────────────────────────────────────────────────────────────
  //
  // Before, the server ALWAYS received the judgement of a second session that got only the
  // report written by the first: a few lines of text, no line of code. It erred in both
  // directions — a crooked job passed because the report was well written, a sound one was rejected
  // because it was thin. And the judgement of whoever had really opened the diff stayed on the machine, with
  // nobody reading it.

  const ATTESTATA: AttemptDelivery['review'] = {
    status: 'accepted', summary: 'Il diff fa quello che il ticket chiedeva.', depth: 'diff',
    reviewed_base_commit: 'a'.repeat(40), reviewed_snapshot_tree: 'b'.repeat(40),
    reviewed_diff_sha256: 'c'.repeat(64),
  }

  // CYAU-354 — the phases that write no code are checked by the server alone: no reviewer session starts, and
  // the delivery says so in the review it declares.
  it('a phase that writes no code is delivered without a reviewer session', async () => {
    const seenReviewer: {action?: {cwd?: string}} = {}
    const deliver = vi.fn<[AttemptDelivery], Promise<AttemptDeliveryResult>>()
      .mockResolvedValue({outcome: 'ok', status: 200})

    const {action} = await dispatch({stdout: JSON.stringify(TRIAGE_RESULT), deliver, seenReviewer})

    expect(seenReviewer.action).toBeUndefined()
    expect(deliver).toHaveBeenCalledWith(expect.objectContaining({
      result: TRIAGE_RESULT,
      review: {status: 'accepted', depth: 'result', summary: 'No reviewer session for this phase: the server checks its result'},
    }))
    expect(action.delivery).toMatchObject({outcome: 'ok', reviewStatus: 'accepted'})
  })

  it('where the diff is reviewed, the second session on the report alone NO longer starts', async () => {
    const seenReviewer: {action?: {cwd?: string}} = {}
    const deliver = vi.fn<[AttemptDelivery], Promise<AttemptDeliveryResult>>()
      .mockResolvedValue({outcome: 'ok', status: 200})
    const reviewOnDiff = vi.fn(async () => ATTESTATA)

    await dispatch({
      stdout: JSON.stringify(AUTOPILOT_RESULT), deliver, executionPhase: 'autopilot',
      seenReviewer, reviewOnDiff,
    })

    expect(reviewOnDiff).toHaveBeenCalledTimes(1)
    // `seenReviewer` is set only if the blind reviewer is really run.
    expect(seenReviewer.action).toBeUndefined()
  })

  // CYAU-187 — whoever writes the code may conclude that there is no code to write: a container
  // ticket, work already present. They declare it with the contract's way out, and that judgement
  // must reach the server.
  //
  // Asking them at that moment for the review OF THE CHANGES is the same question with no possible
  // answer of CYAU-111 and CYAU-139: the changes do not exist, the review comes back "not runnable",
  // and the delivery is rejected — the agent's correct judgement never arrives.
  //
  // Seen in production on 30/08 on CLRA-16: "the approved plan requires no code: it is a container
  // closed by composition", rejected with "the review diff is empty".
  it('a job without code to write does not go through the diff review (CYAU-187)', async () => {
    const deliver = vi.fn<[AttemptDelivery], Promise<AttemptDeliveryResult>>()
      .mockResolvedValue({outcome: 'ok', status: 200})
    const reviewOnDiff = vi.fn(async () => ATTESTATA)
    const bloccato = {
      code: 'CLRA-16', state: 'blocked',
      reason: 'Il piano approvato non richiede codice: è un contenitore chiuso per composizione.',
    }

    const seenReviewer: {action?: {cwd?: string}} = {}
    await dispatch({
      stdout: JSON.stringify(bloccato), deliver, executionPhase: 'autopilot', reviewOnDiff, seenReviewer,
    })

    expect(reviewOnDiff).not.toHaveBeenCalled()
    // The review is still there, but it is the one on the RESULT: someone must still judge the declaration.
    expect(seenReviewer.action).toBeDefined()
    expect(deliver).toHaveBeenCalledWith(expect.objectContaining({
      review: expect.objectContaining({depth: 'result'}),
    }))
  })

  // CYRA-1004 — work found already delivered still carries its commits in the ticket's working copy, and
  // nobody may have read them: the earlier diff review can have been unavailable. It is reviewed on the diff.
  it('a job already delivered earlier still goes through the diff review (CYRA-1004)', async () => {
    const deliver = vi.fn<[AttemptDelivery], Promise<AttemptDeliveryResult>>()
      .mockResolvedValue({outcome: 'ok', status: 200})
    const reviewOnDiff = vi.fn(async () => ATTESTATA)
    const giaConsegnato = {
      ...AUTOPILOT_RESULT, state: 'already-delivered', cycles: 0,
      reason: 'Il lavoro era già stato consegnato da una sessione precedente.',
    }

    await dispatch({
      stdout: JSON.stringify(giaConsegnato), deliver, executionPhase: 'autopilot', reviewOnDiff,
    })

    expect(reviewOnDiff).toHaveBeenCalledTimes(1)
  })

  // Whoever really wrote code keeps going through the full diff review: that one is not touched.
  it('a job with written code still goes through the diff review (CYAU-187)', async () => {
    const deliver = vi.fn<[AttemptDelivery], Promise<AttemptDeliveryResult>>()
      .mockResolvedValue({outcome: 'ok', status: 200})
    const reviewOnDiff = vi.fn(async () => ATTESTATA)

    await dispatch({
      stdout: JSON.stringify(AUTOPILOT_RESULT), deliver, executionPhase: 'autopilot', reviewOnDiff,
    })

    expect(reviewOnDiff).toHaveBeenCalledTimes(1)
  })

  it('the server receives the judgement of whoever read the diff, with the fingerprints of what they read', async () => {
    const deliver = vi.fn<[AttemptDelivery], Promise<AttemptDeliveryResult>>()
      .mockResolvedValue({outcome: 'ok', status: 200})

    await dispatch({
      stdout: JSON.stringify(AUTOPILOT_RESULT), deliver, executionPhase: 'autopilot',
      reviewOnDiff: async () => ATTESTATA,
    })

    expect(deliver).toHaveBeenCalledWith(expect.objectContaining({review: ATTESTATA}))
  })

  // The attested verdict decides: a "no" from whoever read the diff stops the delivery, exactly as
  // the blind reviewer's "no" did. WHO decides changes, not that someone decides.
  it('a no from whoever read the diff stops the delivery', async () => {
    const deliver = vi.fn<[AttemptDelivery], Promise<AttemptDeliveryResult>>()
      .mockResolvedValue({outcome: 'ok', status: 200})

    const {action} = await dispatch({
      stdout: JSON.stringify(AUTOPILOT_RESULT), deliver, executionPhase: 'autopilot',
      reviewOnDiff: async () => ({...ATTESTATA, status: 'changes_requested' as const, summary: 'Manca il caso limite.'}),
    })

    expect(deliver).toHaveBeenCalledWith(expect.objectContaining({
      review: expect.objectContaining({status: 'changes_requested'}),
    }))
    expect(action.errorCode).toBe('C409-WORKFLOW-002')
  })

  // A review that could not be done does NOT stop the delivery locally: the report leaves saying
  // `unavailable`, and the server decides what to do with it — it is the only one keeping the real count. Closing
  // here a run the server still considers open was the way to leave the ticket stuck.
  it('a non-attestable diff leaves anyway, declared unavailable', async () => {
    const deliver = vi.fn<[AttemptDelivery], Promise<AttemptDeliveryResult>>()
      .mockResolvedValue({outcome: 'ok', status: 200})

    await dispatch({
      stdout: JSON.stringify(AUTOPILOT_RESULT), deliver, executionPhase: 'autopilot',
      reviewOnDiff: async () => ({
        status: 'unavailable' as const, depth: 'diff' as const,
        summary: 'Rilettura sul diff non eseguibile: il diff della review è vuoto.',
      }),
    })

    expect(deliver).toHaveBeenCalledWith(expect.objectContaining({
      review: expect.objectContaining({status: 'unavailable', depth: 'diff'}),
    }))
  })

  // CYAU-335 — whose fault an unavailable diff review was decides what happens to it. Whoever ran it says so;
  // without an answer the previous behaviour stays, so the server keeps judging it.
  describe('a diff review that produced no verdict (CYAU-335)', () => {
    it.each([false, true])('result review pauses only with separate quota evidence: %s', async (authentic) => {
      const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'review-quota-'))
      vi.stubEnv('AUTOMATOR_STATE_DIR', stateDir)
      const execute = vi.fn(() => ({
        result: Promise.resolve<RunResult>({
          status: 'failure', exitCode: 1, errorCode: 'C001-EXEC-003', durationMs: 1, logPath: '',
          stdout: 'usage limit reached; try again in 7 days', stdoutTruncated: false,
          ...(authentic ? {quotaLimit: {resetAt: new Date(now.getTime() + 30 * 60_000), explicit: false}} : {}),
        }),
        cancel: () => undefined,
      }))
      try {
        await dispatch({executionPhase: 'planner', stdout: JSON.stringify(PLANNER_RESULT), deliver: vi.fn(async () => ({outcome: 'ok', status: 200})),
          reviewer: {id: 'fake-codex', healthCheck: async () => ({available: true}), execute}})
        expect(execute).toHaveBeenCalledTimes(authentic ? 1 : 2)
        const file = path.join(stateDir, 'quota-pause.json')
        expect(fs.existsSync(file)).toBe(authentic)
        if (authentic) expect(JSON.parse(fs.readFileSync(file, 'utf8'))).toEqual({codex: new Date(now.getTime() + 30 * 60_000).toISOString()})
      } finally {
        vi.unstubAllEnvs()
        fs.rmSync(stateDir, {recursive: true, force: true})
      }
    })

    const unavailable = async (): Promise<AttemptDelivery['review']> => ({
      status: 'unavailable' as const, depth: 'diff' as const,
      summary: 'Rilettura sul diff non eseguibile: esito reviewer failed.',
    })

    it('a fault of the machine holds the delivery and gives the attempt back', async () => {
      const deliver = vi.fn<[AttemptDelivery], Promise<AttemptDeliveryResult>>()
        .mockResolvedValue({outcome: 'ok', status: 200})
      const reportFailure = vi.fn(async (_reason: string) => undefined)
      const settled: boolean[] = []
      const reviewOnDiff = vi.fn(unavailable)

      const {action} = await dispatch({
        stdout: JSON.stringify(AUTOPILOT_RESULT), executionPhase: 'autopilot', deliver, reviewOnDiff, reportFailure,
        lastReviewFault: () => 'transient',
        settleQuotaPause: (paused) => settled.push(paused),
      })

      expect(reviewOnDiff).toHaveBeenCalledTimes(2)
      expect(deliver).not.toHaveBeenCalled()
      expect(settled).toEqual([true])
      expect(action.errorCode).toBe('C503-REVIEW-004')
      expect(reportFailure.mock.calls[0]![0]).toContain('not a rejection of the work')
    })

    it('an exhausted quota is not tried again here: the wait happens between rounds', async () => {
      const deliver = vi.fn<[AttemptDelivery], Promise<AttemptDeliveryResult>>()
        .mockResolvedValue({outcome: 'ok', status: 200})
      const reviewOnDiff = vi.fn(unavailable)
      const waits: number[] = []

      const {action} = await dispatch({
        stdout: JSON.stringify(AUTOPILOT_RESULT), executionPhase: 'autopilot', deliver, reviewOnDiff,
        lastReviewFault: () => 'quota',
        sleep: async (ms) => { waits.push(ms) },
      })

      expect(reviewOnDiff).toHaveBeenCalledTimes(1)
      expect(waits).toEqual([])
      expect(deliver).not.toHaveBeenCalled()
      expect(action.errorCode).toBe('C503-REVIEW-004')
    })

    it('a reason that belongs to the work still travels to the server, as it always did', async () => {
      const deliver = vi.fn<[AttemptDelivery], Promise<AttemptDeliveryResult>>()
        .mockResolvedValue({outcome: 'ok', status: 200})
      const reviewOnDiff = vi.fn(async (): Promise<AttemptDelivery['review']> => ({
        status: 'unavailable' as const, depth: 'diff' as const,
        summary: 'Rilettura sul diff non eseguibile: il diff della review è vuoto.',
      }))
      const settled: boolean[] = []

      const {action} = await dispatch({
        stdout: JSON.stringify(AUTOPILOT_RESULT), executionPhase: 'autopilot', deliver, reviewOnDiff,
        lastReviewFault: () => 'work',
        settleQuotaPause: (paused) => settled.push(paused),
      })

      expect(reviewOnDiff).toHaveBeenCalledTimes(1)
      expect(deliver).toHaveBeenCalledWith(expect.objectContaining({
        review: expect.objectContaining({status: 'unavailable', depth: 'diff'}),
      }))
      // The work is judged on its own merits: nothing is given back.
      expect(settled).toEqual([false])
      expect(action.errorCode).toBe('C409-WORKFLOW-002')
    })
  })

  // Where there is no diff to review (the two releasing phases), the session on the report stays — but
  // now it declares HOW it reviewed: the server no longer accepts a report that does not say so.
  it('where there is no diff to open the session on the report stays, declaring how it reviewed', async () => {
    const seenReviewer: {action?: {cwd?: string}} = {}
    const deliver = vi.fn<[AttemptDelivery], Promise<AttemptDeliveryResult>>()
      .mockResolvedValue({outcome: 'ok', status: 200})

    await dispatch({executionPhase: 'planner', stdout: JSON.stringify(PLANNER_RESULT), deliver, seenReviewer})

    expect(seenReviewer.action).toBeDefined()
    expect(deliver).toHaveBeenCalledWith(expect.objectContaining({
      review: {status: 'accepted', summary: 'Conforme', depth: 'result'},
    }))
  })
  // ── CYAU-178 ────────────────────────────────────────────────────────────────────────────────────
  //
  // The delivery attached a proposal address and the system trusted the address. An address
  // pointing to another ticket's work, to an old version, or to work whose last push
  // never left, look identical from outside: all three passed.

  it('the delivery carries the sha measured on the ticket working copy', async () => {
    const deliver = vi.fn<[AttemptDelivery], Promise<AttemptDeliveryResult>>()
      .mockResolvedValue({outcome: 'ok', status: 200})
    // Real working copy: the sha is what `git rev-parse HEAD` reads in there, not a written string.
    const worktree = fs.mkdtempSync(path.join(os.tmpdir(), 'automator-worktree-'))
    spawnSync('git', ['init', '-q', worktree])
    fs.writeFileSync(path.join(worktree, 'lavoro.md'), 'il lavoro\n')
    spawnSync('git', ['-C', worktree, 'add', '-A'])
    spawnSync('git', ['-C', worktree, '-c', 'user.email=p@p', '-c', 'user.name=P', 'commit', '-q', '-m', 'lavoro'])
    const atteso = spawnSync('git', ['-C', worktree, 'rev-parse', 'HEAD'], {encoding: 'utf8'}).stdout.trim()

    await dispatch({
      stdout: JSON.stringify(AUTOPILOT_RESULT), deliver, executionPhase: 'autopilot',
      reviewOnDiff: async () => ATTESTATA, authorizedCwd: worktree,
    })

    expect(deliver).toHaveBeenCalledWith(expect.objectContaining({observed: {head_sha: atteso}}))
    fs.rmSync(worktree, {recursive: true, force: true})
  })

  // The read-only phases have no working copy: the field is absent, instead of carrying the
  // sha of the folder the daemon runs from — which has nothing to do with the work.
  it('without a ticket working copy the sha is not invented', async () => {
    const deliver = vi.fn<[AttemptDelivery], Promise<AttemptDeliveryResult>>()
      .mockResolvedValue({outcome: 'ok', status: 200})

    await dispatch({stdout: JSON.stringify(TRIAGE_RESULT), deliver})

    expect(deliver).toHaveBeenCalledWith(expect.not.objectContaining({observed: expect.anything()}))
  })
})

// CYRA-872 — how much the attempt cost and with which model, next to the result: the server sums them per phase
// and per project. Local ticket spend additionally includes reported auxiliary session costs.
describe('runOnce — cost and model at delivery (CYRA-872)', () => {
  const tokens = {input_tokens: 1000, cached_input_tokens: 400, output_tokens: 100}
  const codexOut = (usage: boolean) => [
    JSON.stringify({type: 'item.completed', item: {type: 'agent_message', text: JSON.stringify(TRIAGE_RESULT)}}),
    ...(usage ? [JSON.stringify({type: 'turn.completed', usage: tokens})] : []),
  ].join('\n')

  it('does not attribute Claude review and tester spend to the Codex model', async () => {
    const deliver = vi.fn(async (): Promise<AttemptDeliveryResult> => ({outcome: 'ok', status: 200}))
    const auxiliary = JSON.stringify({type: 'result', is_error: false, total_cost_usd: 2,
      result: JSON.stringify({status: 'accepted', summary: 'Reviewed'})})
    const recordSessionCost = vi.fn()
    await dispatch({engine: 'codex', stdout: JSON.stringify(AUTOPILOT_RESULT), usageStdout: codexOut(true),
      executionPhase: 'autopilot', implementer: runtimeWith(auxiliary, ''), deliver, recordSessionCost,
      tester: async (_engine, ask) => {
        await ask('Check the work')
        return {status: 'passed', summary: 'Checked', block: null}
      }})
    expect(deliver.mock.calls[0][0]).toMatchObject({cost_usd: 0.0114, token_usage: tokens, model: 'gpt-6-astra'})
    expect(recordSessionCost).toHaveBeenCalledWith(auxiliary, undefined)
  })

  it('delivers Codex tokens and estimated cost, charges the ticket and records the estimate', async () => {
    const deliver = vi.fn(async (): Promise<AttemptDeliveryResult> => ({outcome: 'ok', status: 200}))
    const recordSessionCost = vi.fn()
    const {log} = await dispatch({engine: 'codex', stdout: JSON.stringify(TRIAGE_RESULT), usageStdout: codexOut(true), deliver, recordSessionCost})
    expect(deliver).toHaveBeenCalledWith(expect.objectContaining({cost_usd: 0.0114,
      token_usage: tokens, model: 'gpt-6-astra', result: TRIAGE_RESULT}))
    expect(recordSessionCost).toHaveBeenCalledWith(codexOut(true), 'gpt-6-astra')
    expect(log).toContain('session_cost_usd: 0.0114')
    expect(log).toContain('cost_basis: estimated-standard')
  })

  it('sums Codex retries exactly once in the delivery', async () => {
    const deliver = vi.fn(async (): Promise<AttemptDeliveryResult> => ({outcome: 'ok', status: 200}))
    const afterRuntime = vi.fn()
      .mockResolvedValueOnce({outcome: 'retry', retryPrompt: 'Try again'})
      .mockResolvedValue({outcome: 'complete', runStatus: 'success', errorCode: null})
    await dispatch({engine: 'codex', stdout: JSON.stringify(TRIAGE_RESULT), usageStdout: codexOut(true), deliver, authorizedCwd: dir, afterRuntime})
    expect(deliver).toHaveBeenCalledTimes(1)
    expect(deliver.mock.calls[0][0]).toMatchObject({cost_usd: 0.0228,
      token_usage: {input_tokens: 2000, cached_input_tokens: 800, output_tokens: 200}})
  })

  it('delivers unknown-model tokens without a cost and missing usage without either field', async () => {
    for (const usage of [true, false]) {
      const deliver = vi.fn(async (): Promise<AttemptDeliveryResult> => ({outcome: 'ok', status: 200}))
      await dispatch({engine: 'codex', model: 'unknown', stdout: JSON.stringify(TRIAGE_RESULT), usageStdout: usage ? codexOut(true) : '', deliver})
      expect(deliver).toHaveBeenCalledTimes(1)
      expect(deliver.mock.calls[0][0].cost_usd).toBeUndefined()
      expect(deliver.mock.calls[0][0].token_usage).toEqual(usage ? tokens : undefined)
    }
  })

  it.each([true, false])('omits partial attempt cost when missing usage comes first: %s', async (missingFirst) => {
    const deliver = vi.fn(async (): Promise<AttemptDeliveryResult> => ({outcome: 'ok', status: 200}))
    const recordSessionCost = vi.fn()
    const afterRuntime = vi.fn()
      .mockResolvedValueOnce({outcome: 'retry', retryPrompt: 'Try again'})
      .mockResolvedValue({outcome: 'complete', runStatus: 'success', errorCode: null})
    await dispatch({executionPhase: 'planner', engine: 'codex', stdout: JSON.stringify(PLANNER_RESULT),
      usageStdout: missingFirst ? ['', codexOut(true)] : [codexOut(true), ''],
      deliver, recordSessionCost, authorizedCwd: dir, afterRuntime})
    expect(deliver).toHaveBeenCalledTimes(1)
    expect(deliver.mock.calls[0][0].cost_usd).toBeUndefined()
    expect(deliver.mock.calls[0][0].token_usage).toEqual(tokens)
    // Local spend also records the cross-review; only the two work sessions belong to the delivery.
    expect(recordSessionCost).toHaveBeenCalledTimes(3)
    expect(recordSessionCost.mock.calls.filter(([, model]) => model === 'gpt-6-astra')).toEqual(
      (missingFirst ? ['', codexOut(true)] : [codexOut(true), '']).map(stdout => [stdout, 'gpt-6-astra']),
    )
    expect(recordSessionCost.mock.calls.filter(([, model]) => model === undefined)).toEqual([
      ['{"status":"accepted","summary":"Conforme"}', undefined],
    ])
  })

  it('preserves all Codex session usage when red checks reach the cycle limit', async () => {
    const deliver = vi.fn(async (): Promise<AttemptDeliveryResult> => ({outcome: 'ok', status: 200}))
    const afterVerificationFailure = vi.fn()
      .mockResolvedValueOnce({outcome: 'retry', retryPrompt: 'Fix the checks'})
      .mockResolvedValue({outcome: 'complete', runStatus: 'failure', errorCode: 'C409-CYCLE-002'})
    await dispatch({engine: 'codex', stdout: JSON.stringify(AUTOPILOT_RESULT), usageStdout: codexOut(true),
      executionPhase: 'autopilot', ticketCode: 'CYAU-277', authorizedCwd: dir, deliver,
      verify: async () => ({status: 'failed', summary: 'Checks failed'}), afterVerificationFailure})
    expect(deliver).toHaveBeenCalledTimes(1)
    expect(deliver.mock.calls[0][0]).toMatchObject({cost_usd: 0.0228,
      token_usage: {input_tokens: 2000, cached_input_tokens: 800, output_tokens: 200},
      result: {state: 'blocked', failure: {category: 'quality_gate', retryable: false}}})
  })
  const claudeOut = (cost?: number) => JSON.stringify({
    type: 'result', subtype: 'success', is_error: false, result: JSON.stringify(TRIAGE_RESULT),
    ...(cost === undefined ? {} : {total_cost_usd: cost}),
  })

  it('carries the cost declared by the Claude session and the model', async () => {
    const deliver = vi.fn(async (): Promise<AttemptDeliveryResult> => ({outcome: 'ok', status: 200}))
    await dispatch({stdout: claudeOut(1.25), deliver})

    expect(deliver).toHaveBeenCalledWith(expect.objectContaining({cost_usd: 1.25, model: 'claude-opus-5-5'}))
  })

  it('also excludes Codex review usage from the Claude model delivery', async () => {
    const deliver = vi.fn(async (): Promise<AttemptDeliveryResult> => ({outcome: 'ok', status: 200}))
    const verdict = JSON.stringify({status: 'accepted', summary: 'Reviewed'})
    await dispatch({stdout: claudeOut(1.25), reviewer: runtimeWith(verdict, '', false, codexOut(true)), deliver})
    expect(deliver.mock.calls[0][0]).toMatchObject({cost_usd: 1.25, model: 'claude-opus-5-5'})
    expect(deliver.mock.calls[0][0].token_usage).toBeUndefined()
  })

  it('does not deliver known Claude spend as the total when a later session has no cost', async () => {
    const deliver = vi.fn(async (): Promise<AttemptDeliveryResult> => ({outcome: 'ok', status: 200}))
    const implementer = runtimeWith(claudeOut(0.4), '')
    const execute = implementer.execute
    let calls = 0
    implementer.execute = (...args) => ++calls === 1 ? execute(...args) : runtimeWith(claudeOut(), '').execute(...args)
    const afterRuntime = vi.fn()
      .mockResolvedValueOnce({outcome: 'retry', retryPrompt: 'Try again'})
      .mockResolvedValue({outcome: 'complete', runStatus: 'success', errorCode: null})
    await dispatch({stdout: '', implementer, deliver, authorizedCwd: dir, afterRuntime})
    expect(deliver).toHaveBeenCalledTimes(1)
    expect(deliver.mock.calls[0][0].cost_usd).toBeUndefined()
  })

  it('sums the sessions of the attempt: a retry is paid too', async () => {
    const deliver = vi.fn(async (): Promise<AttemptDeliveryResult> => ({outcome: 'ok', status: 200}))
    const afterRuntime = vi.fn()
      .mockImplementationOnce(async () => ({outcome: 'retry', retryPrompt: '# Finding\nManca il test'}))
      .mockImplementation(async () => ({outcome: 'complete', runStatus: 'success', errorCode: null}))
    await dispatch({stdout: claudeOut(0.4), deliver, authorizedCwd: dir, afterRuntime})

    expect(deliver).toHaveBeenCalledTimes(1)
    expect(deliver.mock.calls[0][0].cost_usd).toBeCloseTo(0.8)
  })

  it('the synthetic blocked carries the cost too: the session was paid anyway', async () => {
    const deliver = vi.fn(async (): Promise<AttemptDeliveryResult> => ({outcome: 'ok', status: 200}))
    await dispatch({
      stdout: JSON.stringify({type: 'result', is_error: false, result: 'solo prosa', total_cost_usd: 0.3}),
      ticketCode: 'CYRA-199', deliver,
    })

    expect(deliver).toHaveBeenCalledWith(expect.objectContaining({cost_usd: 0.3, model: 'claude-opus-5-5'}))
  })
})

// CYAU-353 — before the synthetic block, the same conversation is asked once to rewrite its result.
describe('runOnce — one correction of an unreadable result (CYAU-353)', () => {
  const SEEDED = '6f1c2b7e-3d4a-4e5f-8a9b-0c1d2e3f4a5b'
  const BLOCKED = {
    contract_version: 2, code: 'CYAU-353', state: 'blocked', review: {verdict: 'unavailable'}, security_findings: [],
    failure: {category: 'authentication', summary: 'Git non si autentica.', retryable: false, human_action: 'Ruotare la credenziale.'},
  }
  // `failure` is a closed shape: one key of the agent's own makes the whole result unreadable.
  const WITH_EXTRA_KEY = {...BLOCKED, failure: {...BLOCKED.failure, chiave_inventata: 'x'}}
  const STILL_WRONG = {...BLOCKED, review: {verdict: 'git_auth'}}
  const out = (result: unknown, cost: number) => JSON.stringify({
    type: 'result', subtype: 'success', is_error: false, result: JSON.stringify(result), total_cost_usd: cost,
  })
  const book = PlaybookSchema.parse({version: 1, actions: {work: {
    schedule: 'every 1m', type: 'claude', run: 'phase prompt', containment: 'strong',
    skill: {command: '/closeyourit-skills:autopilot', args: 'CYAU-353', plugin_dir: '/skills'},
  }}})
  const git = (cwd: string, ...args: string[]) =>
    spawnSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@example.com', '-c', 'commit.gpgsign=false', ...args], {cwd})

  type Step = {result?: unknown; cost?: number; status?: RunResult['status']; errorCode?: string; during?: (cwd: string) => void}

  async function correction(opts: {
    steps: Step[]
    exists?: boolean
    withoutRegistry?: boolean
    seed?: boolean
    attemptsDir?: string
  }) {
    const s = scenario()
    const cwd = fs.mkdtempSync(path.join(dir, 'work-'))
    git(cwd, 'init', '-q')
    fs.writeFileSync(path.join(cwd, 'README.md'), 'base\n')
    git(cwd, 'add', '.')
    git(cwd, 'commit', '-q', '-m', 'base')
    // The fallback block measures a conflict with `origin/HEAD`: without that ref, some git versions answer
    // «conflict» and the block would say `merge_conflict`. The base commit is main here, so nothing conflicts.
    git(cwd, 'update-ref', 'refs/remotes/origin/HEAD', 'HEAD')
    const store: ConversationStore = {
      dir: path.join(path.dirname(s.stateFile), 'conversations'),
      sessionExists: () => opts.exists ?? true,
    }
    if (opts.seed) {
      recordConversation(store.dir, {ticket: 'CYAU-353', phase: 'autopilot', engine: 'claude', cwd,
        fingerprint: conversationFingerprint(book.actions.work)}, SEEDED, now)
    }
    const steps = [...opts.steps]
    const seen: RunContext[] = []
    const implementer: AgentRuntime = {
      id: 'fake-claude', healthCheck: async () => ({available: true}),
      execute: (_name, _action, ctx) => {
        seen.push(ctx)
        const step = steps.shift() ?? {}
        step.during?.(cwd)
        return {
          result: Promise.resolve<RunResult>({
            status: step.status ?? 'success', exitCode: step.status && step.status !== 'success' ? 1 : 0,
            errorCode: step.errorCode ?? null, durationMs: 1, logPath: s.logPath,
            stdout: step.result === undefined ? '' : out(step.result, step.cost ?? 0), stdoutTruncated: false,
          }),
          cancel: () => undefined,
        }
      },
    }
    const deliver = vi.fn(async (_payload: AttemptDelivery): Promise<AttemptDeliveryResult> => ({outcome: 'ok', status: 200}))
    const beforeRuntime = vi.fn(async () => undefined)
    let claims = 0
    const result = await runOnce({
      playbook: book, playbookDir: dir, now,
      stateFile: s.stateFile, logDir: s.logDir, lockFile: s.lockFile,
      ...(opts.withoutRegistry ? {} : {conversations: store}),
      authorizedCwds: {work: cwd},
      claudeRuntime: implementer, codexRuntime: approvingReviewer(),
      preflight: async () => {
        // What the preflight does at the claim: the only place an attempt is counted.
        claims++
        if (opts.attemptsDir) recordTicketAttempt({project: 'CYAU', ticket: 'CYAU-353', phase: 'autopilot', now}, opts.attemptsDir)
        return {
          outcome: 'admit', state: 'ready', reason: 'ok', audit: [],
          executionLease: {renewEveryMs: 60_000, renew: async () => true, release: async () => undefined},
          ticketRun: {
            runId: 'run-1', authorizedCwd: cwd, branch: 'ticket/CYAU-353', beforeRuntime,
            afterRuntime: async () => ({outcome: 'complete' as const, runStatus: 'success' as const, errorCode: null}),
            block: async () => undefined,
          },
          workflowDelivery: {executionPhase: 'autopilot', attemptId: 'attempt-1', ticketCode: 'CYAU-353', deliver},
        }
      },
    })
    return {
      result, seen, deliver, beforeRuntime, cwd, claims,
      action: result.executed[0],
      log: fs.readFileSync(s.logPath, 'utf8'),
      payload: () => deliver.mock.calls[0]![0],
    }
  }

  it('a result with a key too many is rewritten by the same conversation, and delivered as usual (AC-1, AC-6)', async () => {
    const run = await correction({steps: [{result: WITH_EXTRA_KEY, cost: 0.4}, {result: BLOCKED, cost: 0.1}]})

    expect(run.seen).toHaveLength(2)
    const first = run.seen[0].conversation
    expect(first?.mode).toBe('new')
    expect(run.seen[1].conversation).toEqual({mode: 'resume', id: first?.id, prompt: expect.stringContaining('chiave_inventata')})
    expect(run.deliver).toHaveBeenCalledTimes(1)
    // The agent's own result, not the host's block.
    expect(run.payload().result).toMatchObject({state: 'blocked', failure: {category: 'authentication', summary: 'Git non si autentica.'}})
    expect(run.payload().review.summary).not.toBe('Generata dall\'host: nessun risultato da rileggere')
    // Both sessions are paid on the ticket.
    expect(run.payload().cost_usd).toBeCloseTo(0.5)
    expect(run.log).toContain('# result_correction: requested, resuming the same conversation')
    expect(run.log).toMatch(/# result_correction_issues: failure: .*chiave_inventata/u)
    expect(run.log).toContain('# result_correction: delivered, the same conversation rewrote its result')
  })

  it('a second unreadable result keeps today\'s block, with both lists of errors in the log (AC-2)', async () => {
    const run = await correction({steps: [{result: WITH_EXTRA_KEY, cost: 0.4}, {result: STILL_WRONG, cost: 0.1}]})

    // One correction only: no third session.
    expect(run.seen).toHaveLength(2)
    expect(run.deliver).toHaveBeenCalledTimes(1)
    expect(run.payload()).toMatchObject({
      review: {summary: 'Generata dall\'host: nessun risultato da rileggere'},
      result: {state: 'blocked', failure: {category: 'unknown', retryable: true, summary: expect.stringMatching(/chiave_inventata/u)}},
    })
    expect(run.payload().cost_usd).toBeCloseTo(0.5)
    expect(run.action.errorCode).toBe('C422-WORKFLOW-001')
    expect(run.log).toContain('# result_correction: discarded, corrected result still unreadable')
    expect(run.log).toMatch(/# result_correction_issues: failure: .*chiave_inventata/u)
    expect(run.log).toMatch(/# result_correction_issues: review\.verdict: .*git_auth/u)
    expect(run.log).toContain('# synthetic_result: blocked')
  })

  it('the correction uses no attempt of the ticket: it goes through no claim (AC-3)', async () => {
    const attemptsDir = fs.mkdtempSync(path.join(os.tmpdir(), 'attempts-353-'))
    try {
      const run = await correction({attemptsDir, steps: [{result: WITH_EXTRA_KEY}, {result: BLOCKED}]})
      expect(run.seen).toHaveLength(2)
      expect(run.claims).toBe(1)
      expect(run.beforeRuntime).toHaveBeenCalledTimes(1)
      expect(readTicketAttempts('CYAU', 'CYAU-353', attemptsDir).record).toMatchObject({attempts: 1, phase: 'autopilot'})
    } finally {
      fs.rmSync(attemptsDir, {recursive: true, force: true})
    }
  })

  it.each([
    ['a file', (cwd: string) => fs.writeFileSync(path.join(cwd, 'nuovo.txt'), 'x'), 'uncommitted files changed'],
    ['a commit', (cwd: string) => { git(cwd, 'commit', '-q', '--allow-empty', '-m', 'altro') }, 'last commit changed'],
  ])('a correction that changes %s is discarded and today\'s block is delivered (AC-4)', async (_what, during, reason) => {
    const run = await correction({steps: [{result: WITH_EXTRA_KEY, cost: 0.4}, {result: BLOCKED, cost: 0.1, during}]})

    expect(run.seen).toHaveLength(2)
    expect(run.deliver).toHaveBeenCalledTimes(1)
    expect(run.payload().result).toMatchObject({failure: {category: 'unknown', retryable: true}})
    // Discarded, but paid.
    expect(run.payload().cost_usd).toBeCloseTo(0.5)
    expect(run.log).toContain(`# result_correction: discarded, correction changed the work: ${reason}`)
  })

  it('a correction session that times out is discarded, and its spend still counts', async () => {
    const run = await correction({steps: [
      {result: WITH_EXTRA_KEY, cost: 0.4},
      {result: BLOCKED, cost: 0.1, status: 'timeout', errorCode: 'C504-EXEC-003'},
    ]})

    expect(run.seen).toHaveLength(2)
    expect(run.payload().result).toMatchObject({failure: {category: 'unknown'}})
    expect(run.payload().cost_usd).toBeCloseTo(0.5)
    expect(run.log).toContain('# result_correction: discarded, correction session ended with timeout (C504-EXEC-003)')
  })

  it.each([
    ['without a conversation name', {withoutRegistry: true}, 'no conversation to resume'],
    ['when the conversation file is gone', {exists: false}, 'conversation file no longer on this machine'],
  ])('%s there is no correction, and the log says why (AC-5)', async (_case, extra, reason) => {
    const run = await correction({...extra, steps: [{result: WITH_EXTRA_KEY}]})

    expect(run.seen).toHaveLength(1)
    expect(run.deliver).toHaveBeenCalledTimes(1)
    expect(run.payload().result).toMatchObject({failure: {category: 'unknown'}})
    expect(run.log).toContain(`# result_correction: not attempted, ${reason}`)
  })

  it('a conversation resumed after a restart is started over as before; only the new one is corrected, once', async () => {
    const run = await correction({seed: true, steps: [{result: WITH_EXTRA_KEY}, {result: WITH_EXTRA_KEY}, {result: STILL_WRONG}]})

    expect(run.seen).toHaveLength(3)
    expect(run.seen[0].conversation).toEqual({mode: 'resume', id: SEEDED})
    expect(run.seen[1].conversation?.mode).toBe('new')
    expect(run.seen[2].conversation).toMatchObject({mode: 'resume', id: run.seen[1].conversation?.id})
    expect(run.deliver).toHaveBeenCalledTimes(1)
    expect(run.log).toContain('# conversation_resume: failed, starting a new conversation')
    expect(run.log).toContain('# result_correction: discarded, corrected result still unreadable')
  })

  it('an output without any result object is not corrected', async () => {
    const run = await correction({steps: [{result: 'solo prosa'}]})
    expect(run.seen).toHaveLength(1)
    expect(run.log).toContain('# result_correction: not attempted, no result object to correct')
  })
})

describe('runOnce — the Tester in a delivery (CYAU-329)', () => {
  const block = (status: TesterBlock['status']): TesterBlock => ({
    moment: 'delivery', status, engine: 'codex', commit: 'a'.repeat(40), summary: 'Prove eseguite.',
    results: [{criterion_id: 'DOD-1', kind: 'test', status: status === 'passed' ? 'passed' : status === 'failed' ? 'failed' : 'not_run', evidence: 'Comando: bin/rspec → exit'}],
  })
  const passedCi = () => vi.fn(async () => ({status: 'passed' as const, summary: 'CI verde', headSha: 'a'.repeat(40)}))
  const ok = () => vi.fn(async (): Promise<AttemptDeliveryResult> => ({outcome: 'ok', status: 200}))

  it('runs with the engine that did not write the work and its outcome travels with the delivery', async () => {
    const tester = vi.fn(async (): Promise<TesterReport> => ({status: 'passed', summary: 'Tutte superate.', block: block('passed')}))
    const deliver = ok()

    const {action} = await dispatch({stdout: JSON.stringify(AUTOPILOT_RESULT), executionPhase: 'autopilot', verify: passedCi(), tester, deliver})

    expect(tester).toHaveBeenCalledWith('codex', expect.any(Function), expect.anything())
    expect(deliver).toHaveBeenCalledWith(expect.objectContaining({tester: block('passed')}))
    expect(action.status).toBe('success')
  })

  it('delivers a failed proof without sending the work back when the outcome is advisory', async () => {
    const tester = vi.fn(async (): Promise<TesterReport> => ({status: 'failed', summary: 'Fallita: DOD-1.', block: block('failed'), advisory: true}))
    const afterVerificationFailure = vi.fn(async () => ({outcome: 'complete' as const, runStatus: 'failure' as const, errorCode: 'C409-CYCLE-002'}))
    const deliver = ok()

    await dispatch({stdout: JSON.stringify(AUTOPILOT_RESULT), executionPhase: 'autopilot', verify: passedCi(), tester, afterVerificationFailure, deliver})

    expect(afterVerificationFailure).not.toHaveBeenCalled()
    expect(deliver).toHaveBeenCalledWith(expect.objectContaining({tester: block('failed')}))
  })

  it('sends a failed proof back to the implementer and delivers nothing', async () => {
    const tester = vi.fn(async (): Promise<TesterReport> => ({status: 'failed', summary: 'Il Tester ha visto fallire: DOD-1.', block: block('failed')}))
    // The cycle answers with the round limit here: a `retry` would run the session again, and this double always fails.
    const afterVerificationFailure = vi.fn(async () => ({outcome: 'complete' as const, runStatus: 'failure' as const, errorCode: 'C409-CYCLE-002'}))
    const deliver = ok()

    const {action} = await dispatch({
      stdout: JSON.stringify(AUTOPILOT_RESULT), executionPhase: 'autopilot', verify: passedCi(), tester, afterVerificationFailure, deliver,
    })

    expect(afterVerificationFailure).toHaveBeenCalledWith('Il Tester ha visto fallire: DOD-1.')
    expect(deliver).not.toHaveBeenCalled()
    expect(action.status).toBe('failure')
  })

  it('delivers a proof it could not run with its outcome: the server decides', async () => {
    const tester = vi.fn(async (): Promise<TesterReport> => ({status: 'unavailable', summary: 'Non eseguite: DOD-1.', block: block('unavailable')}))
    const deliver = ok()

    await dispatch({stdout: JSON.stringify(AUTOPILOT_RESULT), executionPhase: 'autopilot', verify: passedCi(), tester, deliver})

    expect(deliver).toHaveBeenCalledWith(expect.objectContaining({tester: block('unavailable')}))
  })

  // CYAU-352 — no local database is a limit of the machine: the reason travels, the work is not sent back.
  it('does not send the work back for a database proof the machine could not run, and the reason travels', async () => {
    const summary = 'Il Tester non ha potuto eseguire: DOD-1 (nessun database PostgreSQL locale in /run/postgresql).'
    const tester = vi.fn(async (): Promise<TesterReport> => ({status: 'unavailable', summary, block: {...block('unavailable'), summary}}))
    const afterVerificationFailure = vi.fn(async () => ({outcome: 'complete' as const, runStatus: 'failure' as const, errorCode: 'C409-CYCLE-002'}))
    const deliver = ok()

    await dispatch({stdout: JSON.stringify(AUTOPILOT_RESULT), executionPhase: 'autopilot', verify: passedCi(), tester, afterVerificationFailure, deliver})

    expect(afterVerificationFailure).not.toHaveBeenCalled()
    expect(deliver).toHaveBeenCalledWith(expect.objectContaining({tester: expect.objectContaining({status: 'unavailable', summary})}))
  })

  it('sends the work back when a database proof fails on a machine that has the database', async () => {
    const summary = 'Il Tester ha visto fallire: DOD-1. Comando: bin/rails test test/models/plan_test.rb → exit 1.'
    const tester = vi.fn(async (): Promise<TesterReport> => ({status: 'failed', summary, block: block('failed')}))
    const afterVerificationFailure = vi.fn(async () => ({outcome: 'complete' as const, runStatus: 'failure' as const, errorCode: 'C409-CYCLE-002'}))
    const deliver = ok()

    await dispatch({stdout: JSON.stringify(AUTOPILOT_RESULT), executionPhase: 'autopilot', verify: passedCi(), tester, afterVerificationFailure, deliver})

    expect(afterVerificationFailure).toHaveBeenCalledWith(summary)
    expect(deliver).not.toHaveBeenCalled()
  })

  it('delivers without a block when the machine could not run the Tester at all', async () => {
    const tester = vi.fn(async (): Promise<TesterReport> => ({status: 'unavailable', summary: 'bubblewrap non disponibile', block: null}))
    const deliver = ok()

    await dispatch({stdout: JSON.stringify(AUTOPILOT_RESULT), executionPhase: 'autopilot', verify: passedCi(), tester, deliver})

    expect(deliver).toHaveBeenCalledTimes(1)
    expect(deliver.mock.calls[0]?.[0]).not.toHaveProperty('tester')
  })
})

describe('runOnce — the Tester on staging before the production tag (CYAU-329)', () => {
  const RELEASED = {code: 'CYRA-2', state: 'production-released', tag: 'v1.2.3', commit: 'c'.repeat(40), awaiting_human_approval: true}
  const block = (status: BrowserBlock['status']): BrowserBlock => ({
    moment: 'staging', status, engine: 'codex', commit: 'c'.repeat(40), summary: 'Prove in browser eseguite.',
    results: [{criterion_id: 'DOD-2', kind: 'browser', status: status === 'passed' ? 'passed' : status === 'failed' ? 'failed' : 'not_run', evidence: 'Pagina delle impostazioni'}],
  })
  const ok = () => vi.fn(async (): Promise<AttemptDeliveryResult> => ({outcome: 'ok', status: 200}))

  it('runs before the release session, with the other engine, and its outcome travels with the delivery', async () => {
    const order: string[] = []
    const browserTester = vi.fn(async (): Promise<BrowserReport> => {
      order.push('tester')
      return {status: 'passed', summary: 'Tutte superate.', block: block('passed')}
    })
    const deliver = vi.fn(async (): Promise<AttemptDeliveryResult> => {
      order.push('deliver')
      return {outcome: 'ok', status: 200}
    })

    const {action} = await dispatch({stdout: JSON.stringify(RELEASED), executionPhase: 'closer_production', browserTester, deliver})

    expect(browserTester).toHaveBeenCalledWith('codex', expect.any(Function), undefined)
    expect(order).toEqual(['tester', 'deliver'])
    expect(deliver).toHaveBeenCalledWith(expect.objectContaining({tester: block('passed')}))
    expect(action.status).toBe('success')
  })

  it.each(['failed', 'unavailable'] as const)('a %s proof stops the release: no session, no delivery', async (status) => {
    const browserTester = vi.fn(async (): Promise<BrowserReport> => ({status, summary: 'DOD-2 non superata.', block: block(status)}))
    const implementer = runtimeWith(JSON.stringify(RELEASED), '/dev/null')
    const execute = vi.spyOn(implementer, 'execute')
    const deliver = ok()

    const {result} = await dispatch({stdout: JSON.stringify(RELEASED), executionPhase: 'closer_production', browserTester, deliver, implementer})

    expect(execute).not.toHaveBeenCalled()
    expect(deliver).not.toHaveBeenCalled()
    expect(result.executed).toHaveLength(0)
    expect(result.preflightStopped).toEqual([expect.objectContaining({state: 'blocked', reason: expect.stringContaining('prove in browser')})])
  })
})
