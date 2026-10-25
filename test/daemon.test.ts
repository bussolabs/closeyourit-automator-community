import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import {afterAll, describe, expect, it, vi} from 'vitest'
import {defaultSleep, formatIterationLines, runDaemon, runHeartbeatKeepalive} from '../src/lib/daemon'
import {type SpawnFn} from '../src/lib/executor'
import {type DeliveryRecord, type ExecutedAction, type RunOnceResult} from '../src/lib/runner'
import {PlaybookSchema} from '../src/lib/schema'
import {emptyState, saveState, updateAction} from '../src/lib/state'

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'automator-daemon-'))
let counter = 0
afterAll(() => fs.rmSync(dir, {recursive: true, force: true}))

const noopSpawn: SpawnFn = (_c, _a, _o) => ({
  stdout: {on: () => undefined},
  stderr: {on: () => undefined},
  on: (ev, cb) => {
    if (ev === 'close') queueMicrotask(() => (cb as (c: number | null, s: null) => void)(0, null))
  },
  kill: () => true,
})

function scenario(playbookContent: string) {
  const base = path.join(dir, `d-${counter++}`)
  fs.mkdirSync(base, {recursive: true})
  const playbookFile = path.join(base, 'playbook.yml')
  fs.writeFileSync(playbookFile, playbookContent)
  return {
    playbookFile,
    stateFile: path.join(base, 'state.json'),
    logDir: path.join(base, 'logs'),
    lockFile: path.join(base, 'tick.lock'),
  }
}

const VALID = 'version: 1\nactions:\n  a:\n    schedule: "every 1m"\n    type: shell\n    run: "echo x"\n'

describe('runDaemon', () => {
  it('runs N iterations with maxIterations and injected sleep', async () => {
    const s = scenario(VALID)
    let iterations = 0
    await runDaemon({
      ...s,
      spawn: noopSpawn,
      sleep: async () => undefined,
      registerSignals: false,
      maxIterations: 3,
      now: () => new Date('2026-07-07T09:00:00.000Z'),
      onIteration: () => (iterations += 1),
    })
    expect(iterations).toBe(3)
  })

  it('active sync: uses the generated playbook instead of the local file', async () => {
    const s = scenario(VALID)
    const playbook = PlaybookSchema.parse({version: 1, actions: {gen: {schedule: 'every 1m', type: 'shell', run: 'echo y'}}})
    let iterations = 0
    await runDaemon({
      ...s,
      spawn: noopSpawn,
      sleep: async () => undefined,
      registerSignals: false,
      maxIterations: 2,
      now: () => new Date('2026-07-07T09:00:00.000Z'),
      sync: async () => ({playbook, authorizedCwds: {}, ticketQueues: {}}),
      onIteration: () => (iterations += 1),
    })
    expect(iterations).toBe(2)
  })

  it('sync propagates the sidecar queue up to the daemon preflight', async () => {
    const s = scenario(VALID)
    const playbook = PlaybookSchema.parse({version: 1, actions: {gen: {schedule: 'every 1m', type: 'codex', run: 'lavora'}}})
    saveState(s.stateFile, updateAction(emptyState(), 'gen', {last_run: '2026-07-07T08:00:00.000Z'}))
    const preflight = vi.fn(async () => ({outcome: 'stop' as const, state: 'waiting' as const, reason: 'coda vuota', audit: []}))
    const target = {projectKey: 'CYAU', repository: 'closeyourit/automator'}
    await runDaemon({
      ...s, preflight, sleep: async () => undefined, registerSignals: false, maxIterations: 1,
      now: () => new Date('2026-07-07T09:00:00.000Z'),
      sync: async () => ({playbook, authorizedCwds: {gen: '/repo'}, ticketQueues: {gen: target}}),
    })
    expect(preflight).toHaveBeenCalledWith('gen', expect.any(Object), expect.objectContaining({authorizedCwd: '/repo', ticketQueue: target}))
  })

  it('propagates the ticket preflight to runOnce before execution', async () => {
    const s = scenario(VALID)
    saveState(s.stateFile, updateAction(emptyState(), 'a', {last_run: '2026-07-07T08:00:00.000Z'}))
    const preflight = vi.fn(async () => ({
      outcome: 'stop' as const,
      state: 'blocked' as const,
      reason: 'limite raggiunto',
      audit: [{phase: 'limits', state: 'stopped' as const, reason: 'limite raggiunto'}],
    }))
    const logs: string[] = []
    let result

    await runDaemon({
      ...s,
      spawn: noopSpawn,
      preflight,
      log: (message) => logs.push(message),
      sleep: async () => undefined,
      registerSignals: false,
      maxIterations: 1,
      now: () => new Date('2026-07-07T09:00:00.000Z'),
      onIteration: (iteration) => (result = iteration),
    })

    expect(preflight).toHaveBeenCalledTimes(1)
    expect(result).toMatchObject({
      executed: [],
      preflightStopped: [{name: 'a', state: 'blocked', reason: 'limite raggiunto'}],
    })
    expect(logs).toContain('preflight stop "a" [blocked]: limite raggiunto')
  })

  // CYAU-105: the cycle printed ONLY the preflight stops and two counters — a failed action did not appear.
  it('a failed action appears in the cycle log, with the code and the log path', async () => {
    const s = scenario(VALID)
    saveState(s.stateFile, updateAction(emptyState(), 'a', {last_run: '2026-07-07T08:00:00.000Z'}))
    const logs: string[] = []
    const failing: SpawnFn = (_c, _a, _o) => ({
      stdout: {on: () => undefined},
      stderr: {on: () => undefined},
      on: (ev, cb) => {
        if (ev === 'close') queueMicrotask(() => (cb as (c: number | null, s: null) => void)(1, null))
      },
      kill: () => true,
    })

    await runDaemon({
      ...s,
      spawn: failing,
      log: (message) => logs.push(message),
      sleep: async () => undefined,
      registerSignals: false,
      maxIterations: 1,
      now: () => new Date('2026-07-07T09:00:00.000Z'),
    })

    // The line carries state, code and log path: they are the three data used to look at what happened.
    // The specific code depends on the scenario (here the cwd is not a Git checkout → C400-EXEC-004); what
    // the test pins is that A code is there and that the file is indicated.
    expect(logs.filter((l) => l.startsWith('azione '))).toEqual([
      expect.stringMatching(/^azione "a" \[failure\] C\d{3}-[A-Z]+-\d{3} log=.*a-20260707T090000\.log$/u),
    ])
  })

  it('daemon call-site runs the ticket lifecycle in the attested worktree and releases once', async () => {
    const s = scenario(VALID)
    saveState(s.stateFile, updateAction(emptyState(), 'a', {last_run: '2026-07-07T08:00:00.000Z'}))
    const order: string[] = []
    const release = vi.fn(async () => { order.push('release') })
    const renew = vi.fn(async () => { order.push('renew'); return true })
    const cwd = process.cwd()
    const spawn: SpawnFn = (_command, _args, options) => {
      order.push(`runtime:${options.cwd}`)
      return noopSpawn(_command, _args, options)
    }
    let result

    await runDaemon({
      ...s, spawn, sleep: async () => undefined, registerSignals: false, maxIterations: 1,
      now: () => new Date('2026-07-07T09:00:00.000Z'),
      preflight: async () => ({
        outcome: 'admit', state: 'ready', reason: 'ok', audit: [],
        executionLease: {renewEveryMs: 60_000, renew, release},
        ticketRun: {
          runId: 'run-35', authorizedCwd: cwd, branch: 'ticket/CYAU-35',
          beforeRuntime: async () => { order.push('implementing') },
          afterRuntime: async () => { order.push('verifying') },
          block: vi.fn(async () => undefined),
        },
      }),
      onIteration: (iteration) => (result = iteration),
    })

    expect(result).toMatchObject({executed: [expect.objectContaining({name: 'a', status: 'success'})]})
    expect(order).toEqual(['renew', 'implementing', `runtime:${cwd}`, 'verifying', 'release'])
    expect(renew).toHaveBeenCalledTimes(1)
    expect(release).toHaveBeenCalledTimes(1)
  })

  it('sync returns null → skips runOnce (no iteration run)', async () => {
    const s = scenario(VALID)
    let iterations = 0
    await runDaemon({
      ...s,
      spawn: noopSpawn,
      sleep: async () => undefined,
      registerSignals: false,
      maxIterations: 2,
      now: () => new Date('2026-07-07T09:00:00.000Z'),
      sync: async () => null,
      onIteration: () => (iterations += 1),
    })
    expect(iterations).toBe(0)
  })

  it('invalid playbook at runtime → does not bring down the daemon (logs, continues)', async () => {
    const s = scenario('version: 1\nactions: {}\n')
    const logs: string[] = []
    await runDaemon({
      ...s,
      spawn: noopSpawn,
      sleep: async () => undefined,
      registerSignals: false,
      maxIterations: 1,
      log: (m) => logs.push(m),
    })
    expect(logs.some((line) => line.includes('errore iterazione'))).toBe(true)
  })

  it('external abortSignal stops the loop', async () => {
    const s = scenario(VALID)
    const external = new AbortController()
    let iterations = 0
    await runDaemon({
      ...s,
      spawn: noopSpawn,
      registerSignals: false,
      abortSignal: external.signal,
      now: () => new Date('2026-07-07T09:00:00.000Z'),
      onIteration: () => (iterations += 1),
      // Aborts during the sleep of the first iteration.
      sleep: async () => {
        external.abort()
      },
    })
    expect(iterations).toBe(1)
  })

  it('abortSignal already aborted → no iteration', async () => {
    const s = scenario(VALID)
    const external = new AbortController()
    external.abort()
    let iterations = 0
    await runDaemon({
      ...s,
      spawn: noopSpawn,
      registerSignals: false,
      abortSignal: external.signal,
      sleep: async () => undefined,
      onIteration: () => (iterations += 1),
    })
    expect(iterations).toBe(0)
  })

  it('registerSignals=true adds and then removes the handlers', async () => {
    const s = scenario(VALID)
    const before = process.listenerCount('SIGTERM')
    await runDaemon({
      ...s,
      spawn: noopSpawn,
      sleep: async () => undefined,
      registerSignals: true,
      maxIterations: 1,
    })
    expect(process.listenerCount('SIGTERM')).toBe(before)
  })
})

// CYAU-105: composing the lines is pure, so it is verified on the contract instead of running a
// real delivery (which the runner already covers end-to-end in `runner-workflow-delivery.test.ts`).
describe('formatIterationLines', () => {
  const empty = {
    skipped: false, executed: [], seeded: [], scheduleErrors: [], pruned: 0,
    stateQuarantined: null, preflightStopped: [], flowFailures: [],
  } satisfies RunOnceResult

  function executedWith(delivery: DeliveryRecord, overrides: Partial<ExecutedAction> = {}): ExecutedAction {
    return {
      name: 'muta', status: 'failure', errorCode: delivery.errorCode, durationMs: 180_000,
      logPath: '/logs/muta.log', result: {} as never, delivery, ...overrides,
    }
  }

  // Since CYAU-192 a "never started" delivery is possible only outside the queue (no ticket code with
  // which to compose the synthetic blocked): the heartbeat line is the same.
  it('a never-started delivery carries phase, attempt, code and output size', () => {
    const lines = formatIterationLines({...empty, executed: [executedWith({
      phase: 'triage', attemptId: 'attempt-1', outcome: 'not-attempted',
      errorCode: 'C422-WORKFLOW-001', reviewStatus: 'unavailable',
      stdoutBytes: 4210, stdoutTruncated: false, logAppended: true,
    })]})

    expect(lines).toContain('azione "muta" [failure] C422-WORKFLOW-001 log=/logs/muta.log')
    expect(lines).toContain(
      'consegna "muta" [not-attempted] fase=triage attempt=attempt-1 codice=C422-WORKFLOW-001 ' +
      'review=unavailable stdout=4210B log=/logs/muta.log',
    )
  })

  it('an unavailable re-read carries its reason', () => {
    const lines = formatIterationLines({...empty, executed: [executedWith({
      phase: 'triage', attemptId: 'attempt-3', outcome: 'rejected',
      errorCode: 'C409-WORKFLOW-002', httpStatus: 409, serverErrorCode: 'R409-ATTEMPT-003',
      reviewStatus: 'unavailable', reviewDetail: 'codex: autenticazione scaduta o revocata',
      stdoutBytes: 10, stdoutTruncated: false, logAppended: true,
    })]})

    expect(lines.some((line) => line.includes('review=unavailable (codex: autenticazione scaduta o revocata)'))).toBe(true)
  })

  it('a server rejection carries HTTP status and server code, and the truncation', () => {
    const lines = formatIterationLines({...empty, executed: [executedWith({
      phase: 'autopilot', attemptId: 'attempt-2', outcome: 'rejected',
      errorCode: 'C409-WORKFLOW-002', httpStatus: 422, serverErrorCode: 'R422-ATTEMPT-001',
      reviewStatus: 'accepted', stdoutBytes: 12, stdoutTruncated: true, logAppended: true,
    }, {name: 'rifiutata'})]})

    expect(lines[1]).toContain('http=422')
    expect(lines[1]).toContain('server=R422-ATTEMPT-001')
    expect(lines[1]).toContain('stdout=12B troncato')
  })

  it('a log that was not written is declared', () => {
    const lines = formatIterationLines({...empty, executed: [executedWith({
      phase: 'triage', attemptId: 'attempt-3', outcome: 'unavailable',
      errorCode: 'C502-WORKFLOW-003', reviewStatus: 'accepted',
      stdoutBytes: 12, stdoutTruncated: false, logAppended: false,
    })]})
    expect(lines[1]).toContain("ATTENZIONE: esito non scritto nel log dell'azione")
  })

  it('a successful delivery makes no noise: the log stays readable', () => {
    const lines = formatIterationLines({...empty, executed: [executedWith({
      phase: 'triage', attemptId: 'attempt-4', outcome: 'ok', errorCode: null,
      reviewStatus: 'accepted', attemptStatus: 'approved', concluded: true,
      stdoutBytes: 12, stdoutTruncated: false, logAppended: true,
    }, {name: 'consegnata', status: 'success', errorCode: null})]})
    expect(lines).toEqual([])
  })

  // CYAU-171 — the delivery arrived but the answer could not be read: the work is delivered,
  // the outcome is not. It must be said, together with the fact that NOBODY is needed: without that second half, a line
  // that says "not read" looks like a failure to fix, and sends people looking in the wrong place.
  it('a successful delivery whose outcome was not read says so, and declares that nobody is needed', () => {
    const lines = formatIterationLines({...empty, executed: [executedWith({
      phase: 'triage', attemptId: 'attempt-5', outcome: 'ok', errorCode: null,
      reviewStatus: 'accepted', concluded: false,
      stdoutBytes: 12, stdoutTruncated: false, logAppended: true,
    }, {name: 'consegnata', status: 'success', errorCode: null})]})

    expect(lines).toHaveLength(1)
    expect(lines[0]).toContain('esito non letto')
    expect(lines[0]).toContain('non serve nessuna azione')
  })

  it('failed pool steps appear even without a recorded action', () => {
    const lines = formatIterationLines({
      ...empty, flowFailures: [{name: 'a2', detail: 'retry ticket privo di finding strutturati (fail-closed)'}],
    })
    expect(lines).toEqual(['step coda "a2" fallito: retry ticket privo di finding strutturati (fail-closed)'])
  })
})

describe('runHeartbeatKeepalive', () => {
  it('beats immediately and then at every interval, until the abort arrives', async () => {
    const c = new AbortController()
    const beats: boolean[] = []
    let waits = 0
    await runHeartbeatKeepalive({
      beat: async (ok) => {
        beats.push(ok)
      },
      lastOk: () => true,
      intervalMs: 60_000,
      signal: c.signal,
      sleep: async (ms) => {
        expect(ms).toBe(60_000)
        waits += 1
        if (waits >= 3) c.abort()
      },
    })
    expect(beats).toEqual([true, true, true])
  })

  it('carries the outcome of the last round, not a fixed ok', async () => {
    const c = new AbortController()
    const beats: boolean[] = []
    let ok = true
    await runHeartbeatKeepalive({
      beat: async (value) => {
        beats.push(value)
        ok = false
      },
      lastOk: () => ok,
      intervalMs: 1000,
      signal: c.signal,
      sleep: async () => {
        if (beats.length >= 2) c.abort()
      },
    })
    expect(beats).toEqual([true, false])
  })

  it('also carries the last observed stops to the heartbeat (CYAU-116)', async () => {
    const c = new AbortController()
    const seen: Array<Array<{action: string; state: string; reason: string}> | undefined> = []
    const stops = [{action: 'cyau', state: 'blocked', reason: 'limite'}]
    await runHeartbeatKeepalive({
      beat: async (_ok, s) => {
        seen.push(s)
      },
      lastOk: () => true,
      lastStops: () => stops,
      intervalMs: 1000,
      signal: c.signal,
      sleep: async () => {
        if (seen.length >= 1) c.abort()
      },
    })
    expect(seen[0]).toEqual(stops)
  })

  it('a failed heartbeat does not stop the keepalive', async () => {
    const c = new AbortController()
    let attempts = 0
    await runHeartbeatKeepalive({
      beat: async () => {
        attempts += 1
        throw new Error('rete giù')
      },
      lastOk: () => true,
      intervalMs: 1000,
      signal: c.signal,
      sleep: async () => {
        if (attempts >= 2) c.abort()
      },
    })
    expect(attempts).toBe(2)
  })

  it('signal already aborted → does not beat at all', async () => {
    const c = new AbortController()
    c.abort()
    let attempts = 0
    await runHeartbeatKeepalive({
      beat: async () => {
        attempts += 1
      },
      lastOk: () => true,
      intervalMs: 1000,
      signal: c.signal,
      sleep: async () => undefined,
    })
    expect(attempts).toBe(0)
  })
})

describe('runDaemon — heartbeat independent of the cycle (CYAU-120)', () => {
  it('beats at startup and waits on its own interval, without waiting for the end of the round', async () => {
    const s = scenario(VALID)
    const beats: boolean[] = []
    let keepaliveWaits = 0
    let iterationDone = false
    let beatsBeforeIterationEnd = 0
    await runDaemon({
      ...s,
      spawn: noopSpawn,
      registerSignals: false,
      maxIterations: 1,
      now: () => new Date('2026-07-07T09:00:00.000Z'),
      heartbeatIntervalMs: 60_000,
      heartbeat: async (ok) => {
        beats.push(ok)
        if (!iterationDone) beatsBeforeIterationEnd += 1
      },
      onIteration: () => (iterationDone = true),
      sleep: async (ms) => {
        if (ms === 60_000) keepaliveWaits += 1
      },
    })
    // The keepalive started (it waits on its OWN interval) and beat before the round finished,
    // in addition to the end-of-round heartbeat of runOnce.
    expect(keepaliveWaits).toBeGreaterThan(0)
    expect(beatsBeforeIterationEnd).toBeGreaterThan(0)
    expect(beats.length).toBeGreaterThanOrEqual(2)
  })

  it('without a configured heartbeat it starts no keepalive', async () => {
    const s = scenario(VALID)
    let sleeps = 0
    await runDaemon({
      ...s,
      spawn: noopSpawn,
      registerSignals: false,
      maxIterations: 1,
      now: () => new Date('2026-07-07T09:00:00.000Z'),
      heartbeatIntervalMs: 60_000,
      sleep: async (ms) => {
        if (ms === 60_000) sleeps += 1
      },
    })
    expect(sleeps).toBe(0)
  })
})

describe('defaultSleep', () => {
  it('signal already aborted → resolves immediately', async () => {
    const c = new AbortController()
    c.abort()
    await expect(defaultSleep(10_000, c.signal)).resolves.toBeUndefined()
  })

  it('resolves on the timer', async () => {
    vi.useFakeTimers()
    const c = new AbortController()
    const p = defaultSleep(1000, c.signal)
    await vi.advanceTimersByTimeAsync(1000)
    await expect(p).resolves.toBeUndefined()
    vi.useRealTimers()
  })

  it('abort during the sleep → resolves immediately', async () => {
    const c = new AbortController()
    const p = defaultSleep(10_000, c.signal)
    c.abort()
    await expect(p).resolves.toBeUndefined()
  })
})
