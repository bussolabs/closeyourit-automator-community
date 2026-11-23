import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import {spawnSync} from 'node:child_process'
import {afterAll, describe, expect, it, vi} from 'vitest'
import {runOnce} from '../src/lib/runner'
import {type RunResult, type SpawnFn} from '../src/lib/executor'
import {type AgentRuntime} from '../src/lib/runtime'
import {emptyState, loadState, saveState, updateAction} from '../src/lib/state'
import {PlaybookSchema, type Playbook} from '../src/lib/schema'
import {readPulse, type SessionPulse} from '../src/lib/session-pulse'

// CYAU-69: the dispatch of the due actions uses `runFlowPool` (PER-STEP concurrency) ONLY in skill-mode; in
// prompt-mode it stays SERIAL and unchanged. Here we verify both paths with a "gated" runtime: every
// execute stays in flight until the test resolves it, so we observe how many steps run together.

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'automator-flow-pool-'))
spawnSync('git', ['init', '-q', dir])
let counter = 0
afterAll(() => fs.rmSync(dir, {recursive: true, force: true}))

function paths() {
  const base = path.join(dir, `run-${counter++}`)
  return {stateFile: path.join(base, 'state.json'), logDir: path.join(base, 'logs'), lockFile: path.join(base, 'tick.lock')}
}

const now = new Date('2026-07-07T09:30:00.000Z')

/** Playbook with N shell actions at 1m cadence: all due if `last_run` is old enough. */
function playbookWith(names: string[]): Playbook {
  const actions: Record<string, unknown> = {}
  for (const n of names) actions[n] = {schedule: 'every 1m', type: 'shell', run: `echo ${n}`}
  return PlaybookSchema.parse({version: 1, actions})
}

/** Seeds the state so every action is due (last_run 30m ago, 1m cadence). The due order follows `names`. */
function seedDue(stateFile: string, names: string[]): void {
  let st = emptyState()
  for (const n of names) st = updateAction(st, n, {last_run: '2026-07-07T09:00:00.000Z', last_status: 'success'})
  saveState(stateFile, st)
}

function ok(): RunResult {
  return {status: 'success', exitCode: 0, errorCode: null, durationMs: 1, logPath: '', stdout: ''}
}

interface Deferred<T> {
  promise: Promise<T>
  resolve: (value: T) => void
}
function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((r) => {
    resolve = r
  })
  return {promise, resolve}
}

/** Drains the pending tasks: the pool slot refill and the post-step queue happen over a few ticks. */
async function flush(): Promise<void> {
  for (let i = 0; i < 5; i++) await new Promise((r) => setTimeout(r, 0))
}

/**
 * Fake runtime: every `execute` stays in flight until the test resolves the matching gate, and tracks
 * how many steps are in flight at the same time (`maxInFlight`) and in which order they started (`started`).
 */
function gatedRuntime(): {
  runtime: AgentRuntime
  gates: Map<string, Deferred<RunResult>>
  started: string[]
  maxInFlight: () => number
} {
  const gates = new Map<string, Deferred<RunResult>>()
  const started: string[] = []
  let inFlight = 0
  let maxInFlight = 0
  const runtime: AgentRuntime = {
    id: 'fake',
    healthCheck: async () => ({available: true}),
    execute: (name) => {
      started.push(name)
      inFlight++
      if (inFlight > maxInFlight) maxInFlight = inFlight
      const gate = deferred<RunResult>()
      gates.set(name, gate)
      return {
        result: gate.promise.finally(() => {
          inFlight--
        }),
        cancel: () => undefined,
      }
    },
  }
  return {runtime, gates, started, maxInFlight: () => maxInFlight}
}

describe('runOnce — dispatch skill-mode via flow-pool (CYAU-69)', () => {
  it('skill-mode ON: the dispatch uses the bounded pool (≥2 steps in flight, max_parallel cap respected)', async () => {
    const p = paths()
    const names = ['a1', 'a2', 'a3']
    seedDue(p.stateFile, names)
    const {runtime, gates, started, maxInFlight} = gatedRuntime()

    const run = runOnce({
      playbook: playbookWith(names), playbookDir: dir, now, ...p,
      runtime, skillsMode: true, flowMaxParallel: 2,
    })

    await flush()
    // Two slots → two steps in flight TOGETHER; the 3rd waits for a slot to free up. Real concurrency, not serial.
    expect(started).toEqual(['a1', 'a2'])

    gates.get('a1')!.resolve(ok())
    await flush()
    // ONE slot freed → the 3rd starts, no more: the cap stays 2.
    expect(started).toEqual(['a1', 'a2', 'a3'])

    gates.get('a2')!.resolve(ok())
    gates.get('a3')!.resolve(ok())
    const result = await run

    expect(result.executed.map((e) => e.name).sort()).toEqual(['a1', 'a2', 'a3'])
    expect(result.executed.every((e) => e.status === 'success')).toBe(true)
    expect(maxInFlight()).toBe(2) // the cap is reached (real concurrency) but NEVER exceeded
    expect(loadState(p.stateFile).actions.a1.last_status).toBe('success')
  })

  it('skill-mode OFF: the dispatch stays serial (one step at a time, due order preserved)', async () => {
    const p = paths()
    const names = ['a1', 'a2', 'a3']
    seedDue(p.stateFile, names)
    const {runtime, gates, started, maxInFlight} = gatedRuntime()

    const run = runOnce({
      playbook: playbookWith(names), playbookDir: dir, now, ...p,
      runtime, skillsMode: false, flowMaxParallel: 2, // cap ignored in prompt-mode
    })

    await flush()
    expect(started).toEqual(['a1']) // serial: only one step in flight
    gates.get('a1')!.resolve(ok())
    await flush()
    expect(started).toEqual(['a1', 'a2']) // the 2nd starts only after the 1st has finished
    gates.get('a2')!.resolve(ok())
    await flush()
    expect(started).toEqual(['a1', 'a2', 'a3'])
    gates.get('a3')!.resolve(ok())
    const result = await run

    expect(result.executed.map((e) => e.name)).toEqual(['a1', 'a2', 'a3']) // serial order preserved
    expect(maxInFlight()).toBe(1) // never more than one step in flight
  })

  it('skill-mode ON without resolvable cap: 1-slot pool (serial, fail-closed, never unlimited)', async () => {
    const p = paths()
    const names = ['a1', 'a2']
    seedDue(p.stateFile, names)
    const {runtime, gates, started, maxInFlight} = gatedRuntime()

    // `flowMaxParallel` omitted → resolveFlowConcurrency(undefined) = 1: the pool runs one step at a time.
    const run = runOnce({
      playbook: playbookWith(names), playbookDir: dir, now, ...p,
      runtime, skillsMode: true,
    })

    await flush()
    expect(started).toEqual(['a1']) // cap 1: only one step in flight
    gates.get('a1')!.resolve(ok())
    await flush()
    expect(started).toEqual(['a1', 'a2'])
    gates.get('a2')!.resolve(ok())
    await run
    expect(maxInFlight()).toBe(1)
  })

  it('skill-mode ON: the cap can come from an async resolver (host-scoped max_parallel), resolved once per dispatch', async () => {
    const p = paths()
    const names = ['a1', 'a2', 'a3']
    seedDue(p.stateFile, names)
    const {runtime, gates, started, maxInFlight} = gatedRuntime()
    let resolverCalls = 0

    const run = runOnce({
      playbook: playbookWith(names), playbookDir: dir, now, ...p,
      runtime, skillsMode: true,
      flowMaxParallel: async () => {
        resolverCalls++
        return 2
      },
    })

    await flush()
    expect(resolverCalls).toBe(1) // the resolver is invoked only once per dispatch
    expect(started).toEqual(['a1', 'a2'])
    gates.get('a1')!.resolve(ok())
    await flush()
    expect(started).toEqual(['a1', 'a2', 'a3'])
    gates.get('a2')!.resolve(ok())
    gates.get('a3')!.resolve(ok())
    await run
    expect(maxInFlight()).toBe(2)
  })

  it('skill-mode OFF: the cap resolver is NOT invoked (no policy call in prompt-mode)', async () => {
    const p = paths()
    const names = ['a1']
    seedDue(p.stateFile, names)
    const {runtime, gates, started} = gatedRuntime()
    let resolverCalls = 0

    const run = runOnce({
      playbook: playbookWith(names), playbookDir: dir, now, ...p,
      runtime, skillsMode: false,
      flowMaxParallel: () => {
        resolverCalls++
        return 2
      },
    })

    await flush()
    gates.get('a1')!.resolve(ok())
    await run
    expect(resolverCalls).toBe(0) // prompt-mode: the cap is never resolved
    expect(started).toEqual(['a1'])
  })

  // CYAU-105: `runFlowPool` catches every `runStep` throw into a `failed` disposition so as not to take down the
  // other steps — correct — but its return value was DISCARDED. A dispatch failure appeared neither in
  // `executed` (the action does not get to record itself) nor in a log: in skill-mode it was completely invisible.
  it('skill-mode: a step throw surfaces in flowFailures instead of disappearing in the pool', async () => {
    const p = paths()
    const names = ['a1', 'a2']
    seedDue(p.stateFile, names)
    const {runtime, gates} = gatedRuntime()

    const run = runOnce({
      playbook: playbookWith(names), playbookDir: dir, now, ...p,
      runtime, skillsMode: true, flowMaxParallel: 2,
      preflight: async (name) => ({
        outcome: 'admit', state: 'ready', reason: 'ok', audit: [],
        executionLease: {renewEveryMs: 60_000, renew: async () => true, release: async () => undefined},
        // On `a2` the lifecycle asks for a retry without findings: the runner throws fail-closed (already
        // existing contract). It is the most direct way to make the step fail AFTER the admission.
        ticketRun: {
          runId: `run-${name}`, branch: `ticket/${name}`, authorizedCwd: dir,
          beforeRuntime: async () => undefined,
          afterRuntime: async () => (name === 'a2' ? {outcome: 'retry' as const} : {outcome: 'complete' as const}),
          block: async () => undefined,
        },
      }),
    })

    await flush()
    gates.get('a1')!.resolve(ok())
    gates.get('a2')!.resolve(ok())
    const result = await run

    // The tick was not taken down: `a1` completed.
    expect(result.executed.map((e) => e.name)).toEqual(['a1'])
    // And the `a2` failure is no longer a silence.
    expect(result.flowFailures).toEqual([
      {name: 'a2', detail: expect.stringContaining('retry ticket privo di finding strutturati')},
    ])
  })

  it('prompt-mode: flowFailures stays empty (there a throw surfaces to the caller)', async () => {
    const p = paths()
    const names = ['a1']
    seedDue(p.stateFile, names)
    const {runtime, gates} = gatedRuntime()

    const run = runOnce({playbook: playbookWith(names), playbookDir: dir, now, ...p, runtime, skillsMode: false})
    await flush()
    gates.get('a1')!.resolve(ok())
    expect((await run).flowFailures).toEqual([])
  })
})

// CYAU-169: the cap of parallel runs on a SINGLE queue. Before, every queue emitted ONE claim per tick —
// with more free slots the next tickets waited for the next round — because the snapshot+claim pair re-read
// the same head and the concurrent claims became stale. With the atomic take-over (endpoint CYRA-588)
// every request takes a different ticket, so the pool can really fill the slots.
describe('runOnce — atomic queue take-over (CYAU-169)', () => {
  const target = {projectKey: 'CYAU', repository: 'closeyourit/automator'}

  /** Gated runtime with several CONCURRENT executions for the same name: a queue dispatches its action several times. */
  function queueRuntime(): {runtime: AgentRuntime; gates: Array<Deferred<RunResult>>; maxInFlight: () => number} {
    const gates: Array<Deferred<RunResult>> = []
    let inFlight = 0
    let maxInFlight = 0
    const runtime: AgentRuntime = {
      id: 'fake',
      healthCheck: async () => ({available: true}),
      execute: () => {
        inFlight++
        if (inFlight > maxInFlight) maxInFlight = inFlight
        const gate = deferred<RunResult>()
        gates.push(gate)
        return {result: gate.promise.finally(() => { inFlight-- }), cancel: () => undefined}
      },
    }
    return {runtime, gates, maxInFlight: () => maxInFlight}
  }

  /** Source of atomic claims: `codes` in order, then "no work". Tracks the handed tickets. */
  function claimSource(codes: string[]) {
    const released: string[] = []
    const handed: string[] = []
    let i = 0
    const claimQueue = vi.fn(async () => {
      if (i >= codes.length) return {outcome: 'empty' as const}
      const code = codes[i++]
      handed.push(code)
      return {
        outcome: 'claimed' as const,
        claim: {
          candidate: {code} as never,
          lease: {ticket: code, host_id: 'h1', run_id: `run-${code}`, attempt_id: `at-${code}`, expires_at: 'z'} as never,
          runId: `run-${code}`,
          release: async () => void released.push(code),
        },
      }
    })
    return {claimQueue, released, handed}
  }

  /** Preflight that admits the successful claims and stops the others, as the real one does with the ticket in hand. */
  function claimAwarePreflight(seen: Array<string | undefined>) {
    return async (_name: string, _action: unknown, context: {queueClaim?: {outcome: string; claim?: {lease: {ticket: string}}}}) => {
      seen.push(context.queueClaim?.outcome === 'claimed' ? context.queueClaim.claim!.lease.ticket : context.queueClaim?.outcome)
      if (context.queueClaim && context.queueClaim.outcome !== 'claimed') {
        return {outcome: 'stop' as const, state: 'waiting' as const, reason: 'niente lavoro', audit: []}
      }
      return {outcome: 'admit' as const, state: 'ready' as const, reason: 'ok', audit: []}
    }
  }

  it.each(['empty', 'timeout', 'ready'])('checks the queue once before any claim: %s', async (mode) => {
    const p = paths()
    seedDue(p.stateFile, ['q'])
    const pb = playbookWith(['q'])
    pb.actions.q.precondition = {run: 'true', timeout: 1}
    const {claimQueue} = claimSource([])
    const preflight = vi.fn(claimAwarePreflight([]))
    const execute = vi.fn()
    const heartbeat = vi.fn(async (_ok: boolean) => undefined)
    const spawn: SpawnFn = vi.fn(() => {
      let close: ((code: number | null, signal: NodeJS.Signals | null) => void) | undefined
      return {
        stdout: {on: () => undefined}, stderr: {on: () => undefined},
        on: (event, cb) => {
          if (event === 'close') {
            close = cb as typeof close
            if (mode !== 'timeout') queueMicrotask(() => close?.(mode === 'ready' ? 0 : 1, null))
          }
        },
        kill: () => { close?.(null, 'SIGTERM'); return true },
      }
    })
    vi.useFakeTimers()
    try {
      const pending = runOnce({playbook: pb, playbookDir: dir, now, ...p, spawn,
        runtime: {id: 'agent', healthCheck: async () => ({available: true}), execute},
        skillsMode: true, flowMaxParallel: 3, ticketQueues: {q: target}, claimQueue, preflight, heartbeat,
      })
      // A hung check gets TERM at its 1 s deadline and KILL after the 5 s grace: step through both.
      let settled = false
      void pending.then(() => { settled = true }, () => { settled = true })
      for (let step = 0; step < 10 && !settled; step++) await vi.advanceTimersByTimeAsync(1000)
      const result = await pending
      expect(spawn).toHaveBeenCalledTimes(1)
      expect(claimQueue).toHaveBeenCalledTimes(mode === 'ready' ? 1 : 0)
      expect(preflight).toHaveBeenCalledTimes(mode === 'ready' ? 1 : 0)
      expect(execute).not.toHaveBeenCalled()
      expect(heartbeat.mock.calls[0][0]).toBe(true)
      if (mode !== 'ready') {
        expect(result.executed[0]).toMatchObject({status: 'skipped',
          errorCode: mode === 'timeout' ? 'C124-ACTION-003' : 'C000-ACTION-002'})
        expect(loadState(p.stateFile).actions.q.last_run).toBe(now.toISOString())
      }
    } finally { vi.useRealTimers() }
  })

  it('a single queue fills the slots: as many DIFFERENT tickets as there are, in flight together', async () => {
    const p = paths()
    seedDue(p.stateFile, ['q'])
    const {runtime, gates, maxInFlight} = queueRuntime()
    const {claimQueue, handed} = claimSource(['CYAU-1', 'CYAU-2', 'CYAU-3', 'CYAU-4'])
    const seen: Array<string | undefined> = []

    const run = runOnce({
      playbook: playbookWith(['q']), playbookDir: dir, now, ...p,
      runtime, skillsMode: true, flowMaxParallel: 3,
      ticketQueues: {q: target}, claimQueue, preflight: claimAwarePreflight(seen),
    })

    await flush()
    // Three slots → three runs of the SAME queue together, not a single one with two empty slots until the next tick.
    expect(handed).toEqual(['CYAU-1', 'CYAU-2', 'CYAU-3'])
    expect(maxInFlight()).toBe(3)
    for (const gate of gates) gate.resolve(ok())
    const result = await run

    // The cap is also the number of take-overs of the round: the tick stays finite and the queue is not drained
    // in one go — the server requeues the continuation for the next tick.
    expect(claimQueue).toHaveBeenCalledTimes(3)
    expect(result.executed).toHaveLength(3)
    expect(seen).toEqual(['CYAU-1', 'CYAU-2', 'CYAU-3'])
  })

  // Seen on AAC-13: a machine took the ticket and gave it back at once, three times, and the ticket never said why.
  it('a claimed ticket stopped by the gate says why on the attempt, before it is given back', async () => {
    const p = paths()
    seedDue(p.stateFile, ['q'])
    const {runtime} = queueRuntime()
    const calls: string[] = []
    const reportFailure = vi.fn(async (_reason: string) => { calls.push('report') })
    let handed = false
    const claimQueue = vi.fn(async () => {
      if (handed) return {outcome: 'empty' as const}
      handed = true
      return {
        outcome: 'claimed' as const,
        claim: {
          candidate: {code: 'AAC-13'} as never,
          lease: {ticket: 'AAC-13', host_id: 'h1', run_id: 'run-1', attempt_id: 'at-1', expires_at: 'z'} as never,
          runId: 'run-1',
          release: async () => { calls.push('release') },
          reportFailure,
        },
      }
    })

    await runOnce({
      playbook: playbookWith(['q']), playbookDir: dir, now, ...p,
      runtime, skillsMode: true, flowMaxParallel: 1,
      ticketQueues: {q: target}, claimQueue,
      preflight: async () => ({outcome: 'stop' as const, state: 'blocked' as const, reason: 'repository non attestato', audit: []}),
    })

    expect(reportFailure).toHaveBeenCalledWith('repository non attestato')
    expect(calls).toEqual(['report', 'release'])
  })

  it('a claimed ticket dropped because the service is stopping says so on the attempt', async () => {
    const p = paths()
    seedDue(p.stateFile, ['q'])
    const {runtime} = queueRuntime()
    const calls: string[] = []
    const stop = new AbortController()
    const reportFailure = vi.fn(async (_reason: string) => { calls.push('report') })
    let handed = false
    const claimQueue = vi.fn(async () => {
      if (handed) return {outcome: 'empty' as const}
      handed = true
      stop.abort()
      return {
        outcome: 'claimed' as const,
        claim: {
          candidate: {code: 'AAC-13'} as never,
          lease: {ticket: 'AAC-13', host_id: 'h1', run_id: 'run-1', attempt_id: 'at-1', expires_at: 'z'} as never,
          runId: 'run-1',
          release: async () => { calls.push('release') },
          reportFailure,
        },
      }
    })

    await runOnce({
      playbook: playbookWith(['q']), playbookDir: dir, now, ...p,
      runtime, skillsMode: true, flowMaxParallel: 1, signal: stop.signal,
      ticketQueues: {q: target}, claimQueue,
      preflight: async () => ({outcome: 'stop' as const, state: 'blocked' as const, reason: 'unused', audit: []}),
    })

    expect(reportFailure).toHaveBeenCalledWith(expect.stringMatching(/stopping/))
    expect(calls).toEqual(['report', 'release'])
  })

  it('queue exhausted mid-round: asking stops and the draining does not end up in the log as a wait', async () => {
    const p = paths()
    seedDue(p.stateFile, ['q'])
    const {runtime, gates} = queueRuntime()
    const {claimQueue} = claimSource(['CYAU-1', 'CYAU-2'])
    const seen: Array<string | undefined> = []

    const run = runOnce({
      playbook: playbookWith(['q']), playbookDir: dir, now, ...p,
      runtime, skillsMode: true, flowMaxParallel: 4,
      ticketQueues: {q: target}, claimQueue, preflight: claimAwarePreflight(seen),
    })

    await flush()
    for (const gate of gates) gate.resolve(ok())
    const result = await run

    expect(claimQueue).toHaveBeenCalledTimes(3) // two claims + the "no work" that closes the queue
    expect(result.executed).toHaveLength(2)
    // The "no work" after having worked is normal draining: it must be neither dispatched nor reported as a block.
    expect(seen).toEqual(['CYAU-1', 'CYAU-2'])
    expect(result.preflightStopped).toEqual([])
  })

  it('queue empty from the start: a single round, and the wait stays visible in the log', async () => {
    const p = paths()
    seedDue(p.stateFile, ['q'])
    const {runtime} = queueRuntime()
    const {claimQueue} = claimSource([])
    const seen: Array<string | undefined> = []

    const result = await runOnce({
      playbook: playbookWith(['q']), playbookDir: dir, now, ...p,
      runtime, skillsMode: true, flowMaxParallel: 3,
      ticketQueues: {q: target}, claimQueue, preflight: claimAwarePreflight(seen),
    })

    expect(claimQueue).toHaveBeenCalledTimes(1)
    expect(seen).toEqual(['empty'])
    expect(result.preflightStopped).toMatchObject([{name: 'q', state: 'waiting'}])
  })

  it('a server rejection closes the queue for this round and stays logged', async () => {
    const p = paths()
    seedDue(p.stateFile, ['q'])
    const {runtime} = queueRuntime()
    const claimQueue = vi.fn(async () => ({outcome: 'rejected' as const, detail: '403 R403-AGENT-006'}))
    const seen: Array<string | undefined> = []

    const result = await runOnce({
      playbook: playbookWith(['q']), playbookDir: dir, now, ...p,
      runtime, skillsMode: true, flowMaxParallel: 3,
      ticketQueues: {q: target}, claimQueue, preflight: claimAwarePreflight(seen),
    })

    // Fail-closed: do not insist on a queue that has just said no, otherwise a non-eligible host
    // would spend one rejection per slot at every tick.
    expect(claimQueue).toHaveBeenCalledTimes(1)
    expect(seen).toEqual(['rejected'])
    expect(result.preflightStopped).toHaveLength(1)
  })

  it('shutdown: no new take-over, and the one already in hand goes back to the queue', async () => {
    const p = paths()
    seedDue(p.stateFile, ['q'])
    const {runtime} = queueRuntime()
    const {claimQueue, released} = claimSource(['CYAU-1', 'CYAU-2', 'CYAU-3'])
    const controller = new AbortController()
    // The service stops between the take-over and the dispatch: the ticket is already ours but nobody will work on it.
    const abortingClaim = vi.fn(async (queueTarget: {projectKey: string; repository: string}) => {
      const claim = await claimQueue(queueTarget)
      controller.abort()
      return claim
    })

    const result = await runOnce({
      playbook: playbookWith(['q']), playbookDir: dir, now, ...p,
      runtime, skillsMode: true, flowMaxParallel: 3,
      ticketQueues: {q: target}, claimQueue: abortingClaim,
      signal: controller.signal,
      preflight: async () => ({outcome: 'admit' as const, state: 'ready' as const, reason: 'ok', audit: []}),
    })

    expect(result.executed).toHaveLength(0)
    expect(released).toEqual(['CYAU-1']) // given back, not left occupied until expiry
    expect(abortingClaim).toHaveBeenCalledTimes(1) // after the abort no more work is asked for
  })

  it('non-queue actions stay unchanged: no take-over, no claim in the context', async () => {
    const p = paths()
    seedDue(p.stateFile, ['a1', 'q'])
    const {runtime, gates} = queueRuntime()
    const {claimQueue} = claimSource(['CYAU-1'])
    const seen: Array<string | undefined> = []

    const run = runOnce({
      playbook: playbookWith(['a1', 'q']), playbookDir: dir, now, ...p,
      runtime, skillsMode: true, flowMaxParallel: 2,
      ticketQueues: {q: target}, claimQueue, preflight: claimAwarePreflight(seen),
    })

    await flush()
    for (const gate of gates) gate.resolve(ok())
    await run

    expect(seen).toEqual([undefined, 'CYAU-1']) // `a1` is not a queue: no claim, no work request
    expect(claimQueue).toHaveBeenCalledTimes(2) // only for `q`: one ticket and then "no work"
  })

  it('prompt-mode: the atomic take-over does not enter the serial path', async () => {
    const p = paths()
    seedDue(p.stateFile, ['q'])
    const {runtime, gates} = queueRuntime()
    const {claimQueue} = claimSource(['CYAU-1'])
    const seen: Array<string | undefined> = []

    const run = runOnce({
      playbook: playbookWith(['q']), playbookDir: dir, now, ...p,
      runtime, skillsMode: false, flowMaxParallel: 3,
      ticketQueues: {q: target}, claimQueue, preflight: claimAwarePreflight(seen),
    })
    await flush()
    for (const gate of gates) gate.resolve(ok())
    await run

    expect(claimQueue).not.toHaveBeenCalled()
    expect(seen).toEqual([undefined]) // the preflight reads the queue head by itself, as it always did
  })

  // The take-over marks the phase as started server-side: a released ticket does NOT go back to the queue by itself
  // (the recovery of interrupted phases reopens it), and the planner — which instead stays ready — would be taken again
  // immediately, creating one attempt after another in the same round. So a queue that has just handed a
  // non-workable ticket closes until the next round.
  it('a non-workable ticket closes the queue for this round, instead of asking for another one', async () => {
    const p = paths()
    seedDue(p.stateFile, ['q'])
    const {runtime} = queueRuntime()
    const {claimQueue, released, handed} = claimSource(['CYAU-1', 'CYAU-2', 'CYAU-3', 'CYAU-4', 'CYAU-5', 'CYAU-6'])

    const result = await runOnce({
      playbook: playbookWith(['q']), playbookDir: dir, now, ...p,
      runtime, skillsMode: true, flowMaxParallel: 6,
      ticketQueues: {q: target}, claimQueue,
      preflight: async () => ({outcome: 'stop' as const, state: 'blocked' as const, reason: 'troppi tentativi', audit: []}),
    })

    // The queue closes at the first non-workable ticket: the remaining places are not spent on other
    // take-overs. The cap stays the number of places anyway — whoever had already started when the stop became known is not
    // cancelled — but the queue does not consume one ticket per slot at every round.
    expect(handed.length).toBeLessThan(6)
    expect(released).toEqual(handed) // every taken ticket is given back, none stays occupied
    expect(result.preflightStopped).toHaveLength(handed.length)
  })

  it('if the preflight throws, the already taken-over ticket goes back anyway', async () => {
    const p = paths()
    seedDue(p.stateFile, ['q'])
    const {runtime} = queueRuntime()
    const {claimQueue, released, handed} = claimSource(['CYAU-1', 'CYAU-2'])

    const result = await runOnce({
      playbook: playbookWith(['q']), playbookDir: dir, now, ...p,
      runtime, skillsMode: true, flowMaxParallel: 3,
      ticketQueues: {q: target}, claimQueue,
      preflight: async () => {
        throw new Error('preflight esploso')
      },
    })

    expect(handed.length).toBeGreaterThan(0)
    expect(released).toEqual(handed) // the gate blew up, but no ticket stays occupied
    expect(result.preflightStopped[0]).toMatchObject({name: 'q', state: 'blocked'})
  })

  it('without a configured ticket gate nothing is taken over (fail-closed)', async () => {
    const p = paths()
    seedDue(p.stateFile, ['q'])
    const {runtime, gates} = queueRuntime()
    const {claimQueue} = claimSource(['CYAU-1'])

    const run = runOnce({
      playbook: playbookWith(['q']), playbookDir: dir, now, ...p,
      runtime, skillsMode: true, flowMaxParallel: 3,
      ticketQueues: {q: target}, claimQueue,
    })
    await flush()
    for (const gate of gates) gate.resolve(ok())
    await run

    // A ticket taken over and never subjected to a gate would stay occupied without anyone evaluating it.
    expect(claimQueue).not.toHaveBeenCalled()
  })

  it('every run of the same queue writes to its own log, never to the same file', async () => {
    const p = paths()
    seedDue(p.stateFile, ['q'])
    const gates: Array<Deferred<RunResult>> = []
    const logNames: Array<string | undefined> = []
    // The log name is decided by the runner and travels in the execution context: without it, three runs
    // of the same action at the same instant would all open the same file.
    const runtime: AgentRuntime = {
      id: 'fake',
      healthCheck: async () => ({available: true}),
      execute: (_name, _action, ctx) => {
        logNames.push((ctx as {logName?: string}).logName)
        const gate = deferred<RunResult>()
        gates.push(gate)
        return {result: gate.promise, cancel: () => undefined}
      },
    }
    const {claimQueue} = claimSource(['CYAU-1', 'CYAU-2', 'CYAU-3'])

    const run = runOnce({
      playbook: playbookWith(['q']), playbookDir: dir, now, ...p,
      runtime, skillsMode: true, flowMaxParallel: 3,
      ticketQueues: {q: target},
      claimQueue,
      preflight: async () => ({outcome: 'admit' as const, state: 'ready' as const, reason: 'ok', audit: []}),
    })
    await flush()
    for (const gate of gates) gate.resolve(ok())
    await run

    expect(logNames).toHaveLength(3)
    expect(new Set(logNames).size).toBe(3) // three tickets, three logs: nobody reads another one's run
    expect(logNames.sort()).toEqual(['q-CYAU-1', 'q-CYAU-2', 'q-CYAU-3'])
  })

  // CYAU-248 — each ticket session gets the GitHub token the server minted for THAT ticket, never another's.
  it('hands each ticket session the GitHub token of its own ticket', async () => {
    const p = paths()
    seedDue(p.stateFile, ['q'])
    const seen: Array<{logName?: string; githubToken?: string; cyiAuth?: string}> = []
    const runtime: AgentRuntime = {
      id: 'fake',
      healthCheck: async () => ({available: true}),
      execute: (_name, _action, ctx) => {
        const {logName, secrets} = ctx as {logName?: string; secrets?: {githubToken?: string; cyiAuth?: string}}
        seen.push({logName, githubToken: secrets?.githubToken, cyiAuth: secrets?.cyiAuth})
        return {result: Promise.resolve(ok()), cancel: () => undefined}
      },
    }
    const {claimQueue} = claimSource(['CYAU-1', 'CYAU-2'])
    const githubToken = vi.fn(async (ticket: string) => (ticket === 'CYAU-2' ? undefined : `token-of-${ticket}`))

    await runOnce({
      playbook: playbookWith(['q']), playbookDir: dir, now, ...p,
      runtime, skillsMode: true, flowMaxParallel: 2,
      ticketQueues: {q: target}, claimQueue, githubToken, secrets: {cyiAuth: 'cyi_u_service'},
      preflight: async () => ({outcome: 'admit' as const, state: 'ready' as const, reason: 'ok', audit: []}),
    })

    expect(githubToken.mock.calls.map(([ticket]) => ticket).sort()).toEqual(['CYAU-1', 'CYAU-2'])
    expect(seen.sort((a, b) => String(a.logName).localeCompare(String(b.logName)))).toEqual([
      {logName: 'q-CYAU-1', githubToken: 'token-of-CYAU-1', cyiAuth: 'cyi_u_service'},
      {logName: 'q-CYAU-2', githubToken: undefined, cyiAuth: 'cyi_u_service'},
    ])
  })

  it('a take-over failure does not take down the tick and does not stay a silence', async () => {
    const p = paths()
    seedDue(p.stateFile, ['q'])
    const {runtime} = queueRuntime()
    const claimQueue = vi.fn(async () => {
      throw new Error('canale coda non disponibile')
    })

    const result = await runOnce({
      playbook: playbookWith(['q']), playbookDir: dir, now, ...p,
      runtime, skillsMode: true, flowMaxParallel: 3,
      ticketQueues: {q: target}, claimQueue: claimQueue as never,
      preflight: async () => ({outcome: 'admit' as const, state: 'ready' as const, reason: 'ok', audit: []}),
    })

    expect(result.executed).toHaveLength(0)
    expect(result.flowFailures).toEqual([
      {name: 'q', detail: expect.stringContaining('canale coda non disponibile')},
    ])
  })

  // CYAU-282 — a ticket's Claude session narrates its steps into a local queue next to its log.
  it('a claimed Claude ticket session records its live events in a local queue', async () => {
    const p = paths()
    seedDue(p.stateFile, ['q'])
    const contexts: Array<{onStreamEvent?: (event: Record<string, unknown>) => void}> = []
    const runtime: AgentRuntime = {
      id: 'fake',
      healthCheck: async () => ({available: true}),
      execute: (_name, _action, context) => {
        contexts.push(context)
        context.onStreamEvent?.({type: 'assistant', message: {content: [{type: 'tool_use', id: 't', name: 'Read', input: {file_path: path.join(dir, 'app.rb')}}]}})
        return {result: Promise.resolve(ok()), cancel: () => undefined}
      },
    }
    const {claimQueue} = claimSource(['CYAU-7'])

    await runOnce({
      playbook: PlaybookSchema.parse({version: 1, actions: {q: {schedule: 'every 1m', type: 'claude', run: 'work'}}}),
      playbookDir: dir, now, ...p, runtime, skillsMode: true, flowMaxParallel: 1,
      ticketQueues: {q: target}, claimQueue, preflight: claimAwarePreflight([]), authorizedCwds: {q: dir},
    })

    expect(contexts[0].onStreamEvent).toBeTypeOf('function')
    const spool = fs.readdirSync(p.logDir).find((file) => file.endsWith('.live.jsonl'))
    expect(spool).toMatch(/^q-CYAU-7-.*\.live\.jsonl$/)
    const [line] = fs.readFileSync(path.join(p.logDir, spool!), 'utf8').trim().split('\n').map((text) => JSON.parse(text))
    expect(line).toMatchObject({seq: 1, event: {kind: 'file_read', path: 'app.rb'}})
  })

  // CYAU-276 — next to the queue, the session pulse: open at the start, the last step at every step, closed when the
  // session ends (delivery is not silence), gone with the run. Under the lease's run identity, next to the state file.
  it('a Claude ticket session keeps a pulse note: open with the last step, closed before the delivery, removed at the end', async () => {
    const p = paths()
    seedDue(p.stateFile, ['q'])
    const pulseFile = path.join(path.dirname(p.stateFile), 'pulse', 'run-CYAU-11.json')
    const seen: Array<SessionPulse | null> = []
    const runtime: AgentRuntime = {
      id: 'fake',
      healthCheck: async () => ({available: true}),
      execute: (_name, _action, context) => {
        seen.push(readPulse(pulseFile)) // opened, no step yet
        context.onStreamEvent?.({type: 'assistant', message: {content: [{type: 'tool_use', id: 't', name: 'Bash', input: {command: 'pnpm test'}}]}})
        seen.push(readPulse(pulseFile)) // the step, by kind only
        return {result: Promise.resolve(ok()), cancel: () => undefined}
      },
    }
    const {claimQueue} = claimSource(['CYAU-11'])
    const workflowDelivery = {
      executionPhase: 'triage' as const, attemptId: 'at11', ticketCode: 'CYAU-11',
      deliver: vi.fn(async () => {
        seen.push(readPulse(pulseFile)) // the session is over while delivering
        return {outcome: 'ok' as const, status: 200}
      }),
    }

    await runOnce({
      playbook: PlaybookSchema.parse({version: 1, actions: {q: {schedule: 'every 1m', type: 'claude', run: 'work'}}}),
      playbookDir: dir, now, ...p, runtime, skillsMode: true, flowMaxParallel: 1,
      ticketQueues: {q: target}, claimQueue, authorizedCwds: {q: dir},
      preflight: async () => ({outcome: 'admit' as const, state: 'ready' as const, reason: 'ok', audit: [], workflowDelivery}),
    })

    expect(seen[0]).toMatchObject({session_open: true, last_step_kind: null, last_step_at: null})
    expect(seen[1]).toMatchObject({session_open: true, last_step_kind: 'command', last_step_at: expect.any(String)})
    expect(seen[2]).toMatchObject({session_open: false, last_step_kind: 'command'})
    expect(workflowDelivery.deliver).toHaveBeenCalledTimes(1)
    expect(fs.existsSync(pulseFile)).toBe(false)
  })

  it('a pulse note that cannot be written never stops the session nor changes its delivery', async () => {
    const p = paths()
    seedDue(p.stateFile, ['q'])
    // The pulse folder is a FILE: every write fails, as on a full or read-only disk.
    fs.mkdirSync(path.dirname(p.stateFile), {recursive: true})
    fs.writeFileSync(path.join(path.dirname(p.stateFile), 'pulse'), 'not a folder')
    const runtime: AgentRuntime = {
      id: 'fake',
      healthCheck: async () => ({available: true}),
      execute: (_name, _action, context) => {
        context.onStreamEvent?.({type: 'assistant', message: {content: [{type: 'tool_use', id: 't', name: 'Read', input: {file_path: path.join(dir, 'app.rb')}}]}})
        return {result: Promise.resolve(ok()), cancel: () => undefined}
      },
    }
    const {claimQueue} = claimSource(['CYAU-12'])
    const deliver = vi.fn(async () => ({outcome: 'ok' as const, status: 200}))
    const workflowDelivery = {executionPhase: 'triage' as const, attemptId: 'at12', ticketCode: 'CYAU-12', deliver}

    const result = await runOnce({
      playbook: PlaybookSchema.parse({version: 1, actions: {q: {schedule: 'every 1m', type: 'claude', run: 'work'}}}),
      playbookDir: dir, now, ...p, runtime, skillsMode: true, flowMaxParallel: 1,
      ticketQueues: {q: target}, claimQueue, authorizedCwds: {q: dir},
      preflight: async () => ({outcome: 'admit' as const, state: 'ready' as const, reason: 'ok', audit: [], workflowDelivery}),
    })

    expect(deliver).toHaveBeenCalledTimes(1)
    expect(result.executed).toHaveLength(1)
    // The live queue still has the step: only the pulse was lost.
    const spool = fs.readdirSync(p.logDir).find((file) => file.endsWith('.live.jsonl'))
    expect(fs.readFileSync(path.join(p.logDir, spool!), 'utf8')).toContain('"file_read"')
  })

  it('a Codex ticket session writes no pulse note', async () => {
    const p = paths()
    seedDue(p.stateFile, ['q'])
    const pulseDir = path.join(path.dirname(p.stateFile), 'pulse')
    const existed: boolean[] = []
    const runtime: AgentRuntime = {
      id: 'fake',
      healthCheck: async () => ({available: true}),
      execute: () => {
        existed.push(fs.existsSync(pulseDir))
        return {result: Promise.resolve(ok()), cancel: () => undefined}
      },
    }
    const {claimQueue} = claimSource(['CYAU-13'])

    await runOnce({
      playbook: PlaybookSchema.parse({version: 1, actions: {q: {schedule: 'every 1m', type: 'codex', run: 'work'}}}),
      playbookDir: dir, now, ...p, runtime, codexRuntime: runtime, skillsMode: true, flowMaxParallel: 1,
      ticketQueues: {q: target}, claimQueue, preflight: claimAwarePreflight([]), authorizedCwds: {q: dir},
    })

    expect(existed).toEqual([false])
  })

  it('sends the live steps to the attempt, the last ones before the delivery closes it', async () => {
    const p = paths()
    seedDue(p.stateFile, ['q'])
    const order: string[] = []
    const sent: unknown[][] = []
    const runtime: AgentRuntime = {
      id: 'fake',
      healthCheck: async () => ({available: true}),
      execute: (_name, _action, context) => {
        context.onStreamEvent?.({type: 'assistant', message: {content: [{type: 'tool_use', id: 't', name: 'Read', input: {file_path: path.join(dir, 'app.rb')}}]}})
        return {result: Promise.resolve(ok()), cancel: () => undefined}
      },
    }
    const {claimQueue} = claimSource(['CYAU-9'])
    const workflowDelivery = {
      executionPhase: 'triage' as const,
      attemptId: 'at1',
      ticketCode: 'CYAU-9',
      deliver: vi.fn(async () => {
        order.push('deliver')
        return {outcome: 'ok' as const, status: 200}
      }),
      sendLiveEvents: vi.fn(async (records: unknown[]) => {
        order.push('send')
        sent.push(records)
        return {outcome: 'ok' as const, acceptedThrough: records.length, includeCode: false}
      }),
    }

    await runOnce({
      playbook: PlaybookSchema.parse({version: 1, actions: {q: {schedule: 'every 1m', type: 'claude', run: 'work'}}}),
      playbookDir: dir, now, ...p, runtime, skillsMode: true, flowMaxParallel: 1,
      ticketQueues: {q: target}, claimQueue, authorizedCwds: {q: dir},
      preflight: async () => ({outcome: 'admit' as const, state: 'ready' as const, reason: 'ok', audit: [], workflowDelivery}),
    })

    expect(sent.flat()).toEqual([expect.objectContaining({seq: 1, event: {kind: 'file_read', path: 'app.rb'}})])
    expect(order.indexOf('send')).toBeLessThan(order.indexOf('deliver'))
  })

  it('a session whose live sending fails still delivers', async () => {
    const p = paths()
    seedDue(p.stateFile, ['q'])
    const runtime: AgentRuntime = {
      id: 'fake',
      healthCheck: async () => ({available: true}),
      execute: (_name, _action, context) => {
        context.onStreamEvent?.({type: 'assistant', message: {content: [{type: 'tool_use', id: 't', name: 'Read', input: {file_path: path.join(dir, 'app.rb')}}]}})
        return {result: Promise.resolve(ok()), cancel: () => undefined}
      },
    }
    const {claimQueue} = claimSource(['CYAU-10'])
    const deliver = vi.fn(async () => ({outcome: 'ok' as const, status: 200}))
    const workflowDelivery = {
      executionPhase: 'triage' as const, attemptId: 'at2', ticketCode: 'CYAU-10', deliver,
      sendLiveEvents: vi.fn(async () => {
        throw new Error('network down')
      }),
    }

    await runOnce({
      playbook: PlaybookSchema.parse({version: 1, actions: {q: {schedule: 'every 1m', type: 'claude', run: 'work'}}}),
      playbookDir: dir, now, ...p, runtime, skillsMode: true, flowMaxParallel: 1,
      ticketQueues: {q: target}, claimQueue, authorizedCwds: {q: dir},
      preflight: async () => ({outcome: 'admit' as const, state: 'ready' as const, reason: 'ok', audit: [], workflowDelivery}),
    })

    expect(deliver).toHaveBeenCalledTimes(1)
  })

  it('a shell queue action gets no live narration', async () => {
    const p = paths()
    seedDue(p.stateFile, ['q'])
    const contexts: Array<{onStreamEvent?: unknown}> = []
    const runtime: AgentRuntime = {
      id: 'fake',
      healthCheck: async () => ({available: true}),
      execute: (_name, _action, context) => {
        contexts.push(context)
        return {result: Promise.resolve(ok()), cancel: () => undefined}
      },
    }
    const {claimQueue} = claimSource(['CYAU-8'])

    await runOnce({
      playbook: playbookWith(['q']), playbookDir: dir, now, ...p, runtime, skillsMode: true, flowMaxParallel: 1,
      ticketQueues: {q: target}, claimQueue, preflight: claimAwarePreflight([]), authorizedCwds: {q: dir},
    })

    expect(contexts[0].onStreamEvent).toBeUndefined()
    expect(fs.existsSync(p.logDir) ? fs.readdirSync(p.logDir).filter((file) => file.endsWith('.live.jsonl')) : []).toEqual([])
  })
})
