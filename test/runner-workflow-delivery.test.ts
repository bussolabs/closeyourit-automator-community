import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import {spawnSync} from 'node:child_process'
import {afterAll, describe, expect, it, vi} from 'vitest'
import {runOnce} from '../src/lib/runner'
import {type RunResult} from '../src/lib/executor'
import {type AgentRuntime} from '../src/lib/runtime'
import {type AttemptDelivery, type AttemptDeliveryResult} from '../src/lib/client'
import {emptyState, saveState, updateAction} from '../src/lib/state'
import {PlaybookSchema} from '../src/lib/schema'
import {type ExecutionPhase} from '../src/lib/phase-profile'
import {agentRuntimeReadiness} from '../src/lib/runtime-probe'
import {evaluateTicketAttempts, readTicketAttempts, recordTicketAttempt} from '../src/lib/ticket-attempts'

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
function runtimeWith(stdout: string, logPath: string, stdoutTruncated = false): AgentRuntime {
  return {
    id: 'fake-claude', healthCheck: async () => ({available: true}),
    execute: () => ({
      result: Promise.resolve<RunResult>({
        status: 'success', exitCode: 0, errorCode: null, durationMs: 1, logPath, stdout, stdoutTruncated,
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
  stdout: string
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
}) {
  const s = scenario()
  const release = vi.fn(async () => undefined)
  const result = await runOnce({
    playbook: opts.cwd
      ? PlaybookSchema.parse({
          version: 1,
          actions: {work: {schedule: 'every 1m', type: 'claude', run: 'prompt della fase', cwd: opts.cwd}},
        })
      : playbook,
    playbookDir: dir, now,
    stateFile: s.stateFile, logDir: s.logDir, lockFile: s.lockFile,
    claudeRuntime: opts.implementer ?? runtimeWith(opts.stdout, s.logPath, opts.stdoutTruncated),
    codexRuntime: opts.reviewer ?? approvingReviewer(opts.seenReviewer),
    preflight: async () => ({
      outcome: 'admit', state: 'ready', reason: 'ok', audit: [],
      executionLease: {renewEveryMs: 60_000, renew: async () => true, release},
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
        ...(opts.reviewOnDiff ? {reviewOnDiff: opts.reviewOnDiff} : {}),
      },
    }),
  })
  return {result, log: fs.readFileSync(s.logPath, 'utf8'), action: result.executed[0]}
}

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
      failure: {category: 'git_auth', summary: 'Git non si autentica.', retryable: false, human_action: 'Ruotare.'},
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
            summary: expect.stringMatching(/^Risultato non interpretabile: failure\.category: .*'git_auth'/u),
            human_action: 'Se si ripete, rileggere le istruzioni della skill: il modello non ha rispettato il formato del risultato',
          },
        },
      })
      // The stdout excerpt travels redacted: the token does not leave the machine.
      const detail = (payload.result.failure as {technical_detail: string}).technical_detail
      expect(detail).toContain('"category": "git_auth"')
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
      expect(log).toMatch(/# issues: failure\.category: .*'git_auth'/u)
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
        reasons: [expect.stringMatching(/^Risultato non interpretabile: category: .*'frontend'/u)],
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
    const {action, log} = await dispatch({
      // Real CLI envelope: the result arrives nested in `result` as a string.
      stdout: JSON.stringify({type: 'result', subtype: 'success', is_error: false, result: JSON.stringify(TRIAGE_RESULT)}),
      deliver,
    })

    expect(deliver).toHaveBeenCalledWith({
      runtime: 'claude',
      reviewer_runtime: 'codex',
      result: TRIAGE_RESULT,
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

  it('review not approved: the run does not advance even if the transport went fine', async () => {
    const s = scenario()
    const deliver = vi.fn(async (): Promise<AttemptDeliveryResult> => ({outcome: 'ok', status: 200}))
    const unavailableReviewer: AgentRuntime = {
      id: 'fake-codex', healthCheck: async () => ({available: true}),
      execute: () => ({
        result: Promise.resolve<RunResult>({
          status: 'failure', exitCode: 1, errorCode: 'C001-EXEC-003', durationMs: 1,
          logPath: '', stdout: '', stdoutTruncated: false,
        }),
        cancel: () => undefined,
      }),
    }

    const result = await runOnce({
      playbook, playbookDir: dir, now,
      stateFile: s.stateFile, logDir: s.logDir, lockFile: s.lockFile,
      claudeRuntime: runtimeWith(JSON.stringify(TRIAGE_RESULT), s.logPath),
      codexRuntime: unavailableReviewer,
      preflight: async () => ({
        outcome: 'admit', state: 'ready', reason: 'ok', audit: [],
        executionLease: {renewEveryMs: 60_000, renew: async () => true, release: async () => undefined},
        workflowDelivery: {executionPhase: 'triage', attemptId: 'attempt-1', deliver},
      }),
    })

    const action = result.executed[0]
    expect(action.errorCode).toBe('C409-WORKFLOW-002')
    // The transport said ok, the review did not: both go into the record, so it is known which of the two stopped it.
    expect(action.delivery).toMatchObject({outcome: 'ok', reviewStatus: 'unavailable', errorCode: 'C409-WORKFLOW-002'})
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
  it('a failed review delivers and records its reason', async () => {
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

    const {action} = await dispatch({stdout: JSON.stringify(TRIAGE_RESULT), deliver, reviewer: brokenReviewer})

    expect(deliver.mock.calls[0][0].review.summary).toContain('codex: autenticazione scaduta o revocata')
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
        const stdout = actions.length === 1 ? JSON.stringify(TRIAGE_RESULT) : '{"status":"accepted","summary":"Conforme"}'
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

    await dispatch({stdout: '', deliver, implementer, reviewer: codex, reviewMode: 'same'})

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

    await dispatch({stdout: JSON.stringify(TRIAGE_RESULT), deliver, cwd: dir, seenReviewer})

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

  // Where there is no diff to review (the two releasing phases), the session on the report stays — but
  // now it declares HOW it reviewed: the server no longer accepts a report that does not say so.
  it('where there is no diff to open the session on the report stays, declaring how it reviewed', async () => {
    const seenReviewer: {action?: {cwd?: string}} = {}
    const deliver = vi.fn<[AttemptDelivery], Promise<AttemptDeliveryResult>>()
      .mockResolvedValue({outcome: 'ok', status: 200})

    await dispatch({stdout: JSON.stringify(TRIAGE_RESULT), deliver, seenReviewer})

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
// and per project. It is the same spend `automator activity` sums per ticket, so the two totals match.
describe('runOnce — cost and model at delivery (CYRA-872)', () => {
  const claudeOut = (cost?: number) => JSON.stringify({
    type: 'result', subtype: 'success', is_error: false, result: JSON.stringify(TRIAGE_RESULT),
    ...(cost === undefined ? {} : {total_cost_usd: cost}),
  })

  it('carries the cost declared by the Claude session and the model', async () => {
    const deliver = vi.fn(async (): Promise<AttemptDeliveryResult> => ({outcome: 'ok', status: 200}))
    await dispatch({stdout: claudeOut(1.25), deliver})

    expect(deliver).toHaveBeenCalledWith(expect.objectContaining({cost_usd: 1.25, model: 'claude-opus-5-5'}))
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
