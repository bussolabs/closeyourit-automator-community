import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import {spawnSync} from 'node:child_process'
import {afterAll, afterEach, describe, expect, it, vi} from 'vitest'
import {runOnce} from '../src/lib/runner'
import {type RunResult, type SpawnFn} from '../src/lib/executor'
import {type AgentRuntime} from '../src/lib/runtime'
import {acquire} from '../src/lib/lock'
import {loadState, saveState, updateAction, emptyState} from '../src/lib/state'
import {PlaybookSchema} from '../src/lib/schema'
import {AgentRunResultSchema, type AgentRunResult} from '../src/lib/agent-result'

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'automator-runner-'))
spawnSync('git', ['init', '-q', dir])
let counter = 0
afterAll(() => fs.rmSync(dir, {recursive: true, force: true}))
afterEach(() => vi.useRealTimers())

function paths() {
  const base = path.join(dir, `run-${counter++}`)
  return {stateFile: path.join(base, 'state.json'), logDir: path.join(base, 'logs'), lockFile: path.join(base, 'tick.lock')}
}

/** Spawn mock: resolves with the given exit code. */
function spawnWith(code: number): SpawnFn {
  return (_cmd, _args, opts) => {
    void opts
    let closeCb: ((c: number | null, s: NodeJS.Signals | null) => void) | undefined
    return {
      stdout: {on: () => undefined},
      stderr: {on: () => undefined},
      on: (ev, cb) => {
        if (ev === 'close') {
          closeCb = cb as typeof closeCb
          queueMicrotask(() => closeCb?.(code, null))
        }
      },
      kill: () => true,
    }
  }
}

const playbook = PlaybookSchema.parse({
  version: 1,
  actions: {
    fast: {schedule: 'every 1m', type: 'shell', run: 'echo a'},
    slow: {schedule: 'every 1h', type: 'shell', run: 'echo b'},
  },
})
const now = new Date('2026-07-07T09:30:00.000Z')

describe('runOnce', () => {
  it('lock held by a live process → skipped', async () => {
    const p = paths()
    acquire(p.lockFile, 'other')
    const result = await runOnce({playbook, playbookDir: dir, now, ...p, isAlive: () => true})
    expect(result.skipped).toBe(true)
    expect(result.executed).toHaveLength(0)
  })

  it('first run → seeds all the baselines, no execution', async () => {
    const p = paths()
    const result = await runOnce({playbook, playbookDir: dir, now, ...p, spawn: spawnWith(0)})
    expect(result.executed).toHaveLength(0)
    expect(result.seeded.sort()).toEqual(['fast', 'slow'])
    const state = loadState(p.stateFile)
    expect(state.actions.fast.last_status).toBe('skipped')
  })

  it('due action → run and state updated to success', async () => {
    const p = paths()
    saveState(p.stateFile, updateAction(emptyState(), 'fast', {last_run: '2026-07-07T09:00:00.000Z', last_status: 'success'}))
    const result = await runOnce({playbook, playbookDir: dir, now, ...p, spawn: spawnWith(0)})
    expect(result.executed.map((e) => e.name)).toContain('fast')
    expect(loadState(p.stateFile).actions.fast.last_status).toBe('success')
  })

  it('preflight stop → does not start the runtime and records auditable state and reason', async () => {
    const p = paths()
    saveState(p.stateFile, updateAction(emptyState(), 'fast', {last_run: '2026-07-07T09:00:00.000Z'}))
    const execute = vi.fn()
    const runtime: AgentRuntime = {
      id: 'fake',
      healthCheck: async () => ({available: true}),
      execute,
    }

    const result = await runOnce({
      playbook, playbookDir: dir, now, ...p, runtime,
      preflight: async () => ({
        outcome: 'stop',
        state: 'waiting',
        reason: 'chiarimento pendente',
        audit: [{phase: 'clarification', state: 'stopped', reason: 'chiarimento pendente'}],
      }),
    })

    expect(execute).not.toHaveBeenCalled()
    expect(result.executed).toEqual([])
    expect(result.preflightStopped).toEqual([{
      name: 'fast',
      state: 'waiting',
      reason: 'chiarimento pendente',
      audit: [{phase: 'clarification', state: 'stopped', reason: 'chiarimento pendente'}],
    }])
    expect(loadState(p.stateFile).actions.fast).toMatchObject({last_run: now.toISOString(), last_status: 'skipped'})
  })

  it('stop with deferral intent → puts the candidate on hold (CYAU-101)', async () => {
    const p = paths()
    saveState(p.stateFile, updateAction(emptyState(), 'fast', {last_run: '2026-07-07T09:00:00.000Z'}))
    const deferQueue = vi.fn(async () => true)

    const result = await runOnce({
      playbook, playbookDir: dir, now, ...p, deferQueue,
      preflight: async () => ({
        outcome: 'stop', state: 'blocked', reason: 'alto rischio', audit: [],
        queueDeferral: {selectionToken: 'opaque', reason: 'preflight_blocked'},
      }),
    })

    expect(deferQueue).toHaveBeenCalledWith({selectionToken: 'opaque', reason: 'preflight_blocked'})
    // The deferral outcome does not alter the already recorded stop.
    expect(result.preflightStopped).toEqual([expect.objectContaining({name: 'fast', state: 'blocked'})])
  })

  it('stop without intent, or failing deferral: the tick continues anyway (CYAU-101)', async () => {
    const p = paths()
    saveState(p.stateFile, updateAction(emptyState(), 'fast', {last_run: '2026-07-07T09:00:00.000Z'}))
    const deferQueue = vi.fn(async () => {
      throw new Error('rete giù')
    })

    // Without intent the probe is not even consulted.
    const silent = await runOnce({
      playbook, playbookDir: dir, now, ...p, deferQueue,
      preflight: async () => ({outcome: 'stop', state: 'blocked', reason: 'coda vuota', audit: []}),
    })
    expect(deferQueue).not.toHaveBeenCalled()
    expect(silent.preflightStopped).toHaveLength(1)

    // With intent, a probe error stays best-effort: the stop is recorded and the tick does not break.
    const q = paths()
    saveState(q.stateFile, updateAction(emptyState(), 'fast', {last_run: '2026-07-07T09:00:00.000Z'}))
    const failed = await runOnce({
      playbook, playbookDir: dir, now, ...q, deferQueue,
      preflight: async () => ({
        outcome: 'stop', state: 'blocked', reason: 'alto rischio', audit: [],
        queueDeferral: {selectionToken: 'opaque', reason: 'preflight_blocked'},
      }),
    })
    expect(deferQueue).toHaveBeenCalledTimes(1)
    expect(failed.preflightStopped).toEqual([expect.objectContaining({state: 'blocked'})])
    expect(loadState(q.stateFile).actions.fast).toMatchObject({last_status: 'skipped'})
  })

  it('preflight admit → starts the runtime', async () => {
    const p = paths()
    saveState(p.stateFile, updateAction(emptyState(), 'fast', {last_run: '2026-07-07T09:00:00.000Z'}))
    const preflight = vi.fn(async () => ({outcome: 'admit' as const, state: 'ready' as const, reason: 'ok', audit: []}))

    const result = await runOnce({playbook, playbookDir: dir, now, ...p, spawn: spawnWith(0), preflight})

    expect(preflight).toHaveBeenCalledTimes(1)
    expect(preflight).toHaveBeenCalledWith('fast', expect.any(Object), {playbookDir: dir, authorizedCwd: undefined, signal: undefined, ticketQueue: undefined})
    expect(result.executed.map((entry) => entry.name)).toContain('fast')
    expect(result.preflightStopped).toEqual([])
  })

  it('propagates to the preflight the queue sidecar of the action only', async () => {
    const p = paths()
    saveState(p.stateFile, updateAction(emptyState(), 'fast', {last_run: '2026-07-07T09:00:00.000Z'}))
    const preflight = vi.fn(async () => ({outcome: 'admit' as const, state: 'ready' as const, reason: 'ok', audit: []}))
    const target = {projectKey: 'CYAU', repository: 'closeyourit/automator'}
    await runOnce({playbook, playbookDir: dir, now, ...p, spawn: spawnWith(0), preflight, ticketQueues: {fast: target}})
    expect(preflight).toHaveBeenCalledWith('fast', expect.any(Object), expect.objectContaining({ticketQueue: target}))
  })

  it('preflight admit with enriched action → the runtime receives the Guidance, not the original action', async () => {
    const p = paths()
    saveState(p.stateFile, updateAction(emptyState(), 'fast', {last_run: '2026-07-07T09:00:00.000Z'}))
    const runs: string[] = []
    const stub: RunResult = {status: 'success', exitCode: 0, errorCode: null, durationMs: 1, logPath: '/x', stdout: ''}
    const runtime: AgentRuntime = {
      id: 'fake',
      healthCheck: async () => ({available: true}),
      execute(_name, action) {
        runs.push(action.run)
        return {result: Promise.resolve(stub), cancel: () => undefined}
      },
    }

    await runOnce({
      playbook, playbookDir: dir, now, ...p, runtime,
      preflight: async (_name, action) => ({
        outcome: 'admit', state: 'ready', reason: 'ok', audit: [], action: {...action, run: 'guidance + ticket'},
      }),
    })

    expect(runs).toEqual(['guidance + ticket'])
  })

  // CYAU-155: only the session knows the spend, and it ends after the preflight. The runner relays it.
  it('preflight admit with ticket counter → hands over the spend of the just concluded session', async () => {
    const p = paths()
    saveState(p.stateFile, updateAction(emptyState(), 'fast', {last_run: '2026-07-07T09:00:00.000Z'}))
    const spese: string[] = []
    const stub: RunResult = {
      status: 'success', exitCode: 0, errorCode: null, durationMs: 1, logPath: '/x',
      stdout: '{"type":"result","is_error":false,"total_cost_usd":0.42}',
    }
    const runtime: AgentRuntime = {
      id: 'fake',
      healthCheck: async () => ({available: true}),
      execute: () => ({result: Promise.resolve(stub), cancel: () => undefined}),
    }

    await runOnce({
      playbook, playbookDir: dir, now, ...p, runtime,
      preflight: async () => ({
        outcome: 'admit', state: 'ready', reason: 'ok', audit: [],
        ticketAttempt: {recordSessionCost: (stdout: string) => spese.push(stdout)},
      }),
    })

    expect(spese).toEqual(['{"type":"result","is_error":false,"total_cost_usd":0.42}'])
  })

  // CYAU-155: with a retry TWO sessions run. Counting only one underestimates exactly the runs that cost
  // the most — the ones redone after a review that asked for changes.
  it('ticket cycle retry → the spend of EVERY session ends up on the ticket account', async () => {
    const p = paths()
    saveState(p.stateFile, updateAction(emptyState(), 'fast', {last_run: '2026-07-07T09:00:00.000Z'}))
    const spese: string[] = []
    const stdout = ['{"total_cost_usd":0.40}', '{"total_cost_usd":0.60}']
    let sessione = 0
    const runtime: AgentRuntime = {
      id: 'fake', healthCheck: async () => ({available: true}),
      execute: () => ({
        result: Promise.resolve({
          status: 'success' as const, exitCode: 0, errorCode: null, durationMs: 1, logPath: '/x',
          stdout: stdout[sessione++] ?? '',
        }),
        cancel: () => undefined,
      }),
    }
    const afterRuntime = vi.fn()
      .mockImplementationOnce(async () => ({outcome: 'retry', retryPrompt: '# Finding\nManca il test'}))
      .mockImplementationOnce(async () => ({outcome: 'complete'}))

    await runOnce({
      playbook, playbookDir: dir, now, ...p, runtime,
      preflight: async () => ({
        outcome: 'admit', state: 'ready', reason: 'ok', audit: [],
        executionLease: {renewEveryMs: 60_000, renew: async () => true, release: async () => undefined},
        ticketRun: {
          runId: 'same-run', branch: 'ticket/CYAU-155', authorizedCwd: dir,
          beforeRuntime: vi.fn(), afterRuntime, block: vi.fn(async () => undefined),
        },
        ticketAttempt: {recordSessionCost: (out: string) => spese.push(out)},
      }),
    })

    expect(spese).toEqual(['{"total_cost_usd":0.40}', '{"total_cost_usd":0.60}'])
  })

  it('throwing ticket counter → the run stays recorded (the spend is a measure, not a gate)', async () => {
    const p = paths()
    saveState(p.stateFile, updateAction(emptyState(), 'fast', {last_run: '2026-07-07T09:00:00.000Z'}))

    const result = await runOnce({
      playbook, playbookDir: dir, now, ...p, spawn: spawnWith(0),
      preflight: async () => ({
        outcome: 'admit', state: 'ready', reason: 'ok', audit: [],
        ticketAttempt: {recordSessionCost: () => { throw new Error('disco pieno') }},
      }),
    })

    expect(result.executed.map((entry) => [entry.name, entry.status])).toContainEqual(['fast', 'success'])
  })

  it('throwing preflight → stops fail-closed without exposing the error', async () => {
    const p = paths()
    saveState(p.stateFile, updateAction(emptyState(), 'fast', {last_run: '2026-07-07T09:00:00.000Z'}))

    const result = await runOnce({
      playbook, playbookDir: dir, now, ...p, spawn: spawnWith(0),
      preflight: async () => {
        throw new Error('dettaglio sensibile')
      },
    })

    expect(result.executed).toEqual([])
    expect(result.preflightStopped).toEqual([
      expect.objectContaining({state: 'blocked', reason: 'preflight non completabile (fail-closed)'}),
    ])
    expect(JSON.stringify(result.preflightStopped)).not.toContain('dettaglio sensibile')
  })

  it('operational preflight stop does not mark the host as broken', async () => {
    const p = paths()
    saveState(p.stateFile, updateAction(emptyState(), 'fast', {last_run: '2026-07-07T09:00:00.000Z'}))
    const heartbeat = vi.fn().mockResolvedValue(undefined)

    await runOnce({
      playbook, playbookDir: dir, now, ...p, spawn: spawnWith(0), heartbeat,
      preflight: async () => ({outcome: 'stop', state: 'waiting', reason: 'risposta attesa', audit: []}),
    })

    expect(heartbeat).toHaveBeenCalledWith(true, expect.any(Array))
  })

  it('the heartbeat receives the preflight stops mapped to {action,state,reason} (CYAU-116)', async () => {
    const p = paths()
    saveState(p.stateFile, updateAction(emptyState(), 'fast', {last_run: '2026-07-07T09:00:00.000Z'}))
    const heartbeat = vi.fn().mockResolvedValue(undefined)

    await runOnce({
      playbook, playbookDir: dir, now, ...p, spawn: spawnWith(0), heartbeat,
      preflight: async () => ({
        outcome: 'stop', state: 'waiting', reason: 'chiarimento pendente',
        audit: [{phase: 'clarification', state: 'stopped', reason: 'chiarimento pendente'}],
      }),
    })

    // The reason of the last block travels with the beat, without the internal audit.
    expect(heartbeat).toHaveBeenCalledWith(true, [{action: 'fast', state: 'waiting', reason: 'chiarimento pendente'}])
  })

  it('round without due actions (seed only) → heartbeat receives undefined, does not reset the previous stops (CYAU-116)', async () => {
    const p = paths()
    // Empty state → the first round seeds the baselines, no action is due: the preflight is not consulted.
    const heartbeat = vi.fn().mockResolvedValue(undefined)
    const result = await runOnce({playbook, playbookDir: dir, now, ...p, spawn: spawnWith(0), heartbeat})
    expect(result.executed).toEqual([])
    expect(result.preflightStopped).toEqual([])
    // No preflight outcome to report: emitting [] would clear a still valid block, so
    // the field must not be touched (the CYAU-120 keepalive keeps re-proposing the last real reason).
    expect(heartbeat).toHaveBeenCalledWith(true, undefined)
  })

  it('technical preflight failure marks the heartbeat as unhealthy', async () => {
    const p = paths()
    saveState(p.stateFile, updateAction(emptyState(), 'fast', {last_run: '2026-07-07T09:00:00.000Z'}))
    const heartbeat = vi.fn().mockResolvedValue(undefined)

    await runOnce({
      playbook, playbookDir: dir, now, ...p, spawn: spawnWith(0), heartbeat,
      preflight: async () => ({
        outcome: 'stop', state: 'blocked', reason: 'policy non disponibile',
        audit: [{phase: 'limits', state: 'failed', reason: 'policy non disponibile'}],
      }),
    })

    expect(heartbeat).toHaveBeenCalledWith(false, expect.any(Array))
  })

  it('the preflight lease is released after the runtime', async () => {
    const p = paths()
    saveState(p.stateFile, updateAction(emptyState(), 'fast', {last_run: '2026-07-07T09:00:00.000Z'}))
    const release = vi.fn().mockResolvedValue(undefined)
    const renew = vi.fn().mockResolvedValue(true)

    await runOnce({
      playbook, playbookDir: dir, now, ...p, spawn: spawnWith(0),
      preflight: async () => ({
        outcome: 'admit', state: 'ready', reason: 'ok', audit: [],
        executionLease: {renewEveryMs: 60_000, renew, release},
      }),
    })

    expect(renew).not.toHaveBeenCalled()
    expect(release).toHaveBeenCalledTimes(1)
  })

  it('ticket cycle attests the phase before the runtime, uses the worktree and persists the terminal state', async () => {
    const p = paths()
    saveState(p.stateFile, updateAction(emptyState(), 'fast', {last_run: '2026-07-07T09:00:00.000Z'}))
    const order: string[] = []
    const release = vi.fn(async () => { order.push('release') })
    const renew = vi.fn(async () => { order.push('renew'); return true })
    const runtime: AgentRuntime = {
      id: 'fake', healthCheck: async () => ({available: true}),
      execute(_name, action, context) {
        order.push('runtime')
        expect(action.cwd).toBe('/managed/worktrees/CYAU/CYAU-35')
        expect(context.authorizedCwd).toBe('/managed/worktrees/CYAU/CYAU-35')
        return {
          result: Promise.resolve({status: 'success', exitCode: 0, errorCode: null, durationMs: 1, logPath: '/x', stdout: ''}),
          cancel: () => undefined,
        }
      },
    }
    const beforeRuntime = vi.fn(async () => { order.push('implementing') })
    const afterRuntime = vi.fn(async () => { order.push('verifying') })

    const result = await runOnce({
      playbook, playbookDir: dir, now, ...p, runtime,
      preflight: async () => ({
        outcome: 'admit', state: 'ready', reason: 'ok', audit: [],
        executionLease: {renewEveryMs: 60_000, renew, release},
        ticketRun: {
          runId: 'run-35', branch: 'ticket/CYAU-35', authorizedCwd: '/managed/worktrees/CYAU/CYAU-35',
          beforeRuntime, afterRuntime, block: vi.fn(async () => undefined),
        },
      }),
    })

    expect(result.executed).toHaveLength(1)
    expect(order).toEqual(['renew', 'implementing', 'runtime', 'verifying', 'release'])
    expect(renew).toHaveBeenCalledTimes(1)
    expect(beforeRuntime).toHaveBeenCalledTimes(1)
    expect(afterRuntime).toHaveBeenCalledWith(
      expect.objectContaining({status: 'success'}),
      expect.objectContaining({outcome: 'success'}),
      expect.any(AbortSignal),
    )
  })

  it('changes_requested really reruns the implementer with findings, same lifecycle and lease', async () => {
    const p = paths()
    saveState(p.stateFile, updateAction(emptyState(), 'fast', {last_run: '2026-07-07T09:00:00.000Z'}))
    const order: string[] = []
    const prompts: string[] = []
    const renew = vi.fn(async () => { order.push('renew'); return true })
    const release = vi.fn(async () => { order.push('release') })
    const beforeRuntime = vi.fn(async () => { order.push('implementing') })
    const afterRuntime = vi.fn()
      .mockImplementationOnce(async () => {
        order.push('review-changes')
        return {outcome: 'retry', retryPrompt: '# Finding\nManca il test restart'}
      })
      .mockImplementationOnce(async () => {
        order.push('review-approved')
        return {outcome: 'complete'}
      })
    const runtime: AgentRuntime = {
      id: 'fake', healthCheck: async () => ({available: true}),
      execute(_name, action) {
        order.push('runtime')
        prompts.push(action.run)
        return {
          result: Promise.resolve({status: 'success', exitCode: 0, errorCode: null, durationMs: 1, logPath: '/x', stdout: ''}),
          cancel: () => undefined,
        }
      },
    }

    const result = await runOnce({
      playbook, playbookDir: dir, now, ...p, runtime,
      preflight: async () => ({
        outcome: 'admit', state: 'ready', reason: 'ok', audit: [],
        executionLease: {renewEveryMs: 60_000, renew, release},
        ticketRun: {
          runId: 'same-run', branch: 'ticket/CYAU-36', authorizedCwd: dir,
          beforeRuntime, afterRuntime, block: vi.fn(async () => undefined),
        },
      }),
    })

    expect(result.executed).toHaveLength(1)
    expect(prompts).toHaveLength(2)
    expect(prompts[0]).not.toContain('Manca il test restart')
    expect(prompts[1]).toContain('Manca il test restart')
    expect(prompts[1].lastIndexOf('# Istruzione originale autoritativa')).toBeGreaterThan(prompts[1].lastIndexOf('Manca il test restart'))
    expect(beforeRuntime).toHaveBeenCalledTimes(2)
    expect(afterRuntime).toHaveBeenCalledTimes(2)
    expect(order.at(-1)).toBe('release')
    expect(renew).toHaveBeenCalledTimes(2)
  })

  it('retry without findings/prompt is a fail-closed error and releases the lease', async () => {
    const p = paths()
    saveState(p.stateFile, updateAction(emptyState(), 'fast', {last_run: '2026-07-07T09:00:00.000Z'}))
    const release = vi.fn(async () => undefined)
    const block = vi.fn(async () => undefined)
    await expect(runOnce({
      playbook, playbookDir: dir, now, ...p,
      runtime: {
        id: 'fake', healthCheck: async () => ({available: true}),
        execute: () => ({
          result: Promise.resolve({status: 'success', exitCode: 0, errorCode: null, durationMs: 1, logPath: '/x', stdout: ''}),
          cancel: () => undefined,
        }),
      },
      preflight: async () => ({
        outcome: 'admit', state: 'ready', reason: 'ok', audit: [],
        executionLease: {renewEveryMs: 60_000, renew: vi.fn(async () => true), release},
        ticketRun: {
          runId: 'run', branch: 'ticket/CYAU-36', authorizedCwd: dir,
          beforeRuntime: vi.fn(async () => undefined),
          afterRuntime: vi.fn(async () => ({outcome: 'retry'})),
          block,
        },
      }),
    })).rejects.toThrow(/retry.*finding/i)
    expect(block).toHaveBeenCalledTimes(1)
    expect(release).toHaveBeenCalledTimes(1)
  })

  it('lease loss before the retry blocks and does not start a second runtime', async () => {
    const p = paths()
    saveState(p.stateFile, updateAction(emptyState(), 'fast', {last_run: '2026-07-07T09:00:00.000Z'}))
    const renew = vi.fn().mockResolvedValueOnce(true).mockResolvedValueOnce(false)
    const release = vi.fn(async () => undefined)
    const block = vi.fn(async () => undefined)
    const execute = vi.fn(() => ({
      result: Promise.resolve({status: 'success' as const, exitCode: 0, errorCode: null, durationMs: 1, logPath: '/x', stdout: ''}),
      cancel: () => undefined,
    }))
    const result = await runOnce({
      playbook, playbookDir: dir, now, ...p,
      runtime: {id: 'fake', healthCheck: async () => ({available: true}), execute},
      preflight: async () => ({
        outcome: 'admit', state: 'ready', reason: 'ok', audit: [],
        executionLease: {renewEveryMs: 60_000, renew, release},
        ticketRun: {
          runId: 'run', branch: 'ticket/CYAU-36', authorizedCwd: dir,
          beforeRuntime: vi.fn(async () => undefined),
          afterRuntime: vi.fn(async () => ({outcome: 'retry', retryPrompt: 'finding'})),
          block,
        },
      }),
    })
    expect(execute).toHaveBeenCalledTimes(1)
    expect(block).toHaveBeenCalledTimes(1)
    expect(result.executed[0]).toMatchObject({status: 'failure', errorCode: 'C409-LEASE-005'})
  })

  it('recovery from verifying completes gate/review without rerunning the implementer', async () => {
    const p = paths()
    saveState(p.stateFile, updateAction(emptyState(), 'fast', {last_run: '2026-07-07T09:00:00.000Z'}))
    const execute = vi.fn()
    const release = vi.fn(async () => undefined)
    const heartbeat = vi.fn(async () => undefined)
    const beforeRuntime = vi.fn()
    const resumeAfterInterruption = vi.fn(async () => ({outcome: 'complete' as const}))
    const result = await runOnce({
      playbook, playbookDir: dir, now, ...p, heartbeat,
      runtime: {id: 'fake', healthCheck: async () => ({available: true}), execute},
      preflight: async () => ({
        outcome: 'admit', state: 'ready', reason: 'ok', audit: [],
        executionLease: {renewEveryMs: 60_000, renew: vi.fn(async () => true), release},
        ticketRun: {
          runId: 'run', branch: 'ticket/CYAU-36', authorizedCwd: dir,
          resumeAfterInterruption, beforeRuntime,
          afterRuntime: vi.fn(async () => ({outcome: 'complete'})), block: vi.fn(async () => undefined),
        },
      }),
    })
    expect(resumeAfterInterruption).toHaveBeenCalledTimes(1)
    expect(beforeRuntime).not.toHaveBeenCalled()
    expect(execute).not.toHaveBeenCalled()
    expect(release).toHaveBeenCalledTimes(1)
    expect(result.executed).toEqual([expect.objectContaining({name: 'fast', status: 'success', errorCode: null})])
    expect(result.executed[0].result).toMatchObject({outcome: 'success', metadata: {runtime: 'ticket-recovery'}})
    expect(heartbeat).toHaveBeenCalledWith(true, expect.any(Array))
  })

  it('blocked recovery turns executed, report and heartbeat red without rerunning the implementer', async () => {
    const p = paths()
    saveState(p.stateFile, updateAction(emptyState(), 'fast', {last_run: '2026-07-07T09:00:00.000Z'}))
    const execute = vi.fn()
    const heartbeat = vi.fn(async () => undefined)
    const release = vi.fn(async () => undefined)
    const result = await runOnce({
      playbook, playbookDir: dir, now, ...p, heartbeat,
      runtime: {id: 'fake', healthCheck: async () => ({available: true}), execute},
      preflight: async () => ({
        outcome: 'admit', state: 'ready', reason: 'ok', audit: [],
        executionLease: {renewEveryMs: 60_000, renew: vi.fn(async () => true), release},
        ticketRun: {
          runId: 'run', branch: 'ticket/CYAU-36', authorizedCwd: dir,
          resumeAfterInterruption: vi.fn(async () => ({
            outcome: 'complete' as const, runStatus: 'failure' as const, errorCode: 'C409-GATE-002',
          })),
          beforeRuntime: vi.fn(), afterRuntime: vi.fn(async () => ({outcome: 'complete'})),
          block: vi.fn(async () => undefined),
        },
      }),
    })

    expect(execute).not.toHaveBeenCalled()
    expect(release).toHaveBeenCalledTimes(1)
    expect(result.executed).toEqual([expect.objectContaining({status: 'failure', errorCode: 'C409-GATE-002'})])
    expect(result.preflightStopped).toEqual([expect.objectContaining({state: 'blocked'})])
    expect(result.executed[0].result).toMatchObject({outcome: 'failure'})
    expect(heartbeat).toHaveBeenCalledWith(false, expect.any(Array))
  })

  it('changes_requested recovery starts the implementer with the recovered findings', async () => {
    const p = paths()
    saveState(p.stateFile, updateAction(emptyState(), 'fast', {last_run: '2026-07-07T09:00:00.000Z'}))
    const prompts: string[] = []
    const execute = vi.fn((_name, action: {run: string}) => {
      prompts.push(action.run)
      return {
        result: Promise.resolve({status: 'success' as const, exitCode: 0, errorCode: null, durationMs: 1, logPath: '/x', stdout: ''}),
        cancel: () => undefined,
      }
    })
    const beforeRuntime = vi.fn(async () => undefined)
    const result = await runOnce({
      playbook, playbookDir: dir, now, ...p,
      runtime: {id: 'fake', healthCheck: async () => ({available: true}), execute},
      preflight: async () => ({
        outcome: 'admit', state: 'ready', reason: 'ok', audit: [],
        executionLease: {renewEveryMs: 60_000, renew: vi.fn(async () => true), release: vi.fn(async () => undefined)},
        ticketRun: {
          runId: 'run', branch: 'ticket/CYAU-36', authorizedCwd: dir,
          resumeAfterInterruption: vi.fn(async () => ({outcome: 'retry', retryPrompt: 'Finding recuperato'})),
          beforeRuntime,
          afterRuntime: vi.fn(async () => ({outcome: 'complete'})), block: vi.fn(async () => undefined),
        },
      }),
    })
    expect(result.executed).toHaveLength(1)
    expect(beforeRuntime).toHaveBeenCalledTimes(1)
    expect(prompts[0]).toContain('Finding recuperato')
  })

  it('changes_requested recovery without findings blocks fail-closed', async () => {
    const p = paths()
    saveState(p.stateFile, updateAction(emptyState(), 'fast', {last_run: '2026-07-07T09:00:00.000Z'}))
    const block = vi.fn(async () => undefined)
    const release = vi.fn(async () => undefined)
    const result = await runOnce({
      playbook, playbookDir: dir, now, ...p,
      runtime: {id: 'fake', healthCheck: async () => ({available: true}), execute: vi.fn()},
      preflight: async () => ({
        outcome: 'admit', state: 'ready', reason: 'ok', audit: [],
        executionLease: {renewEveryMs: 60_000, renew: vi.fn(async () => true), release},
        ticketRun: {
          runId: 'run', branch: 'ticket/CYAU-36', authorizedCwd: dir,
          resumeAfterInterruption: vi.fn(async () => ({outcome: 'retry'})),
          beforeRuntime: vi.fn(async () => undefined),
          afterRuntime: vi.fn(async () => ({outcome: 'complete'})), block,
        },
      }),
    })
    expect(block).toHaveBeenCalledTimes(1)
    expect(release).toHaveBeenCalledTimes(1)
    expect(result.preflightStopped).toEqual([expect.objectContaining({state: 'blocked'})])
  })

  it('lease lost in-flight right after approved forces in_review → blocked before the release', async () => {
    vi.useFakeTimers()
    const p = paths()
    saveState(p.stateFile, updateAction(emptyState(), 'fast', {last_run: '2026-07-07T09:00:00.000Z'}))
    const order: string[] = []
    let finishRuntime!: (value: RunResult) => void
    let loseLease!: (value: boolean) => void
    const renew = vi.fn()
      .mockResolvedValueOnce(true)
      .mockImplementationOnce(() => new Promise<boolean>((resolve) => { loseLease = resolve }))
    const block = vi.fn(async () => { order.push('blocked') })
    const release = vi.fn(async () => { order.push('release') })
    const running = runOnce({
      playbook, playbookDir: dir, now, ...p,
      runtime: {
        id: 'fake', healthCheck: async () => ({available: true}),
        execute: () => ({
          result: new Promise<RunResult>((resolve) => { finishRuntime = resolve }), cancel: () => undefined,
        }),
      },
      preflight: async () => ({
        outcome: 'admit', state: 'ready', reason: 'ok', audit: [],
        executionLease: {renewEveryMs: 10, renewTimeoutMs: 100, renew, release},
        ticketRun: {
          runId: 'run', branch: 'ticket/CYAU-36', authorizedCwd: dir,
          beforeRuntime: vi.fn(async () => undefined),
          afterRuntime: vi.fn(async () => { order.push('approved'); return {outcome: 'complete'} }),
          block,
        },
      }),
    })
    await vi.advanceTimersByTimeAsync(10)
    finishRuntime({status: 'success', exitCode: 0, errorCode: null, durationMs: 10, logPath: '/x', stdout: ''})
    await vi.advanceTimersByTimeAsync(0)
    expect(order).toEqual(['approved'])
    loseLease(false)
    await vi.advanceTimersByTimeAsync(0)
    const result = await running
    expect(order).toEqual(['approved', 'blocked', 'release'])
    expect(result.executed[0]).toMatchObject({status: 'failure', errorCode: 'C409-LEASE-005'})
  })

  it('lifecycle blocked turns executed, report and heartbeat red', async () => {
    const p = paths()
    saveState(p.stateFile, updateAction(emptyState(), 'fast', {last_run: '2026-07-07T09:00:00.000Z'}))
    const heartbeat = vi.fn(async () => undefined)
    const result = await runOnce({
      playbook, playbookDir: dir, now, ...p, heartbeat,
      runtime: {
        id: 'fake', healthCheck: async () => ({available: true}),
        execute: () => ({
          result: Promise.resolve({status: 'success', exitCode: 0, errorCode: null, durationMs: 1, logPath: '/x', stdout: ''}),
          cancel: () => undefined,
        }),
      },
      preflight: async () => ({
        outcome: 'admit', state: 'ready', reason: 'ok', audit: [],
        executionLease: {renewEveryMs: 60_000, renew: vi.fn(async () => true), release: vi.fn(async () => undefined)},
        ticketRun: {
          runId: 'run', branch: 'ticket/CYAU-36', authorizedCwd: dir,
          beforeRuntime: vi.fn(async () => undefined),
          afterRuntime: vi.fn(async () => ({outcome: 'complete', runStatus: 'failure', errorCode: 'C409-GATE-002'})),
          block: vi.fn(async () => undefined),
        },
      }),
    })
    expect(result.executed[0]).toMatchObject({status: 'failure', errorCode: 'C409-GATE-002', result: {outcome: 'failure'}})
    expect(heartbeat).toHaveBeenCalledWith(false, expect.any(Array))
  })

  it('lease loss stays the authoritative cause even if the lifecycle was already blocked', async () => {
    vi.useFakeTimers()
    const p = paths()
    saveState(p.stateFile, updateAction(emptyState(), 'fast', {last_run: '2026-07-07T09:00:00.000Z'}))
    let finishRuntime!: (value: RunResult) => void
    let loseLease!: (value: boolean) => void
    const renew = vi.fn().mockResolvedValueOnce(true)
      .mockImplementationOnce(() => new Promise<boolean>((resolve) => { loseLease = resolve }))
    const running = runOnce({
      playbook, playbookDir: dir, now, ...p,
      runtime: {
        id: 'fake', healthCheck: async () => ({available: true}),
        execute: () => ({result: new Promise<RunResult>((resolve) => { finishRuntime = resolve }), cancel: () => undefined}),
      },
      preflight: async () => ({
        outcome: 'admit', state: 'ready', reason: 'ok', audit: [],
        executionLease: {renewEveryMs: 10, renewTimeoutMs: 100, renew, release: vi.fn(async () => undefined)},
        ticketRun: {
          runId: 'run', branch: 'ticket/CYAU-36', authorizedCwd: dir,
          beforeRuntime: vi.fn(async () => undefined),
          afterRuntime: vi.fn(async () => ({outcome: 'complete', runStatus: 'failure', errorCode: 'C409-REVIEW-003'})),
          block: vi.fn(async () => undefined),
        },
      }),
    })
    await vi.advanceTimersByTimeAsync(10)
    finishRuntime({status: 'success', exitCode: 0, errorCode: null, durationMs: 10, logPath: '/x', stdout: ''})
    await vi.advanceTimersByTimeAsync(0)
    loseLease(false)
    await vi.advanceTimersByTimeAsync(0)
    const result = await running
    expect(result.executed[0]).toMatchObject({status: 'failure', errorCode: 'C409-LEASE-005', result: {outcome: 'cancelled'}})
  })

  it('failure of the immediate attestation does not start the runtime and releases the lease once', async () => {
    const p = paths()
    saveState(p.stateFile, updateAction(emptyState(), 'fast', {last_run: '2026-07-07T09:00:00.000Z'}))
    const release = vi.fn(async () => undefined)
    const block = vi.fn(async () => undefined)
    const execute = vi.fn()
    const runtime: AgentRuntime = {id: 'fake', healthCheck: async () => ({available: true}), execute}

    const result = await runOnce({
      playbook, playbookDir: dir, now, ...p, runtime,
      preflight: async () => ({
        outcome: 'admit', state: 'ready', reason: 'ok', audit: [],
        executionLease: {renewEveryMs: 60_000, renew: vi.fn(async () => true), release},
        ticketRun: {
          runId: 'run-35', branch: 'ticket/CYAU-35', authorizedCwd: '/managed/worktrees/CYAU/CYAU-35',
          beforeRuntime: async () => { throw new Error('branch cambiato') },
          afterRuntime: vi.fn(async () => undefined), block,
        },
      }),
    })

    expect(execute).not.toHaveBeenCalled()
    expect(release).toHaveBeenCalledTimes(1)
    expect(block).toHaveBeenCalledTimes(1)
    expect(result.preflightStopped).toEqual([expect.objectContaining({state: 'blocked', reason: expect.stringContaining('fail-closed')})])
  })

  it('ticket lifecycle without lease is blocked without starting the runtime', async () => {
    const p = paths()
    saveState(p.stateFile, updateAction(emptyState(), 'fast', {last_run: '2026-07-07T09:00:00.000Z'}))
    const block = vi.fn(async () => undefined)
    const execute = vi.fn()

    const result = await runOnce({
      playbook, playbookDir: dir, now, ...p,
      runtime: {id: 'fake', healthCheck: async () => ({available: true}), execute},
      preflight: async () => ({
        outcome: 'admit', state: 'ready', reason: 'ok', audit: [],
        ticketRun: {
          runId: 'run-35', branch: 'ticket/CYAU-35', authorizedCwd: '/managed/worktrees/CYAU/CYAU-35',
          beforeRuntime: vi.fn(async () => undefined), afterRuntime: vi.fn(async () => undefined), block,
        },
      }),
    })

    expect(execute).not.toHaveBeenCalled()
    expect(block).toHaveBeenCalledTimes(1)
    expect(result.preflightStopped).toEqual([expect.objectContaining({reason: expect.stringContaining('privo di lease')})])
  })

  it('terminal persistence error stops the cycle after releasing the lease once', async () => {
    const p = paths()
    saveState(p.stateFile, updateAction(emptyState(), 'fast', {last_run: '2026-07-07T09:00:00.000Z'}))
    const release = vi.fn(async () => undefined)
    const block = vi.fn(async () => undefined)
    const execute = vi.fn(() => ({
      result: Promise.resolve({status: 'success' as const, exitCode: 0, errorCode: null, durationMs: 1, logPath: '/x', stdout: ''}),
      cancel: () => undefined,
    }))

    await expect(runOnce({
      playbook, playbookDir: dir, now, ...p,
      runtime: {id: 'fake', healthCheck: async () => ({available: true}), execute},
      preflight: async () => ({
        outcome: 'admit', state: 'ready', reason: 'ok', audit: [],
        executionLease: {renewEveryMs: 60_000, renew: vi.fn(async () => true), release},
        ticketRun: {
          runId: 'run-35', branch: 'ticket/CYAU-35', authorizedCwd: dir,
          beforeRuntime: vi.fn(async () => undefined),
          afterRuntime: async () => { throw new Error('checkpoint non persistibile') },
          block,
        },
      }),
    })).rejects.toThrow(/checkpoint non persistibile/)

    expect(execute).toHaveBeenCalledTimes(1)
    expect(block).toHaveBeenCalledTimes(1)
    expect(release).toHaveBeenCalledTimes(1)
    expect(loadState(p.stateFile).actions.fast.last_status).not.toBe('success')
  })

  it('lease not re-attested before the spawn blocks without starting the runtime', async () => {
    const p = paths()
    saveState(p.stateFile, updateAction(emptyState(), 'fast', {last_run: '2026-07-07T09:00:00.000Z'}))
    const renew = vi.fn(async () => false)
    const release = vi.fn(async () => undefined)
    const beforeRuntime = vi.fn(async () => undefined)
    const block = vi.fn(async () => undefined)
    const execute = vi.fn()

    const result = await runOnce({
      playbook, playbookDir: dir, now, ...p,
      runtime: {id: 'fake', healthCheck: async () => ({available: true}), execute},
      preflight: async () => ({
        outcome: 'admit', state: 'ready', reason: 'ok', audit: [],
        executionLease: {renewEveryMs: 1000, renewTimeoutMs: 10, renew, release},
        ticketRun: {
          runId: 'run-35', branch: 'ticket/CYAU-35', authorizedCwd: dir,
          beforeRuntime, afterRuntime: vi.fn(async () => undefined), block,
        },
      }),
    })

    expect(renew).toHaveBeenCalledTimes(1)
    expect(beforeRuntime).not.toHaveBeenCalled()
    expect(execute).not.toHaveBeenCalled()
    expect(block).toHaveBeenCalledTimes(1)
    expect(release).toHaveBeenCalledTimes(1)
    expect(result.preflightStopped).toEqual([expect.objectContaining({reason: expect.stringContaining('lease')})])
  })

  it('hanging lease re-attestation expires bounded and aborts the request without spawn', async () => {
    vi.useFakeTimers()
    const p = paths()
    saveState(p.stateFile, updateAction(emptyState(), 'fast', {last_run: '2026-07-07T09:00:00.000Z'}))
    let renewSignal: AbortSignal | undefined
    const release = vi.fn(async () => undefined)
    const block = vi.fn(async () => undefined)
    const execute = vi.fn()
    const running = runOnce({
      playbook, playbookDir: dir, now, ...p,
      runtime: {id: 'fake', healthCheck: async () => ({available: true}), execute},
      preflight: async () => ({
        outcome: 'admit', state: 'ready', reason: 'ok', audit: [],
        executionLease: {
          renewEveryMs: 1000, renewTimeoutMs: 50, release,
          renew: vi.fn((signal?: AbortSignal) => {
            renewSignal = signal
            return new Promise<boolean>(() => undefined)
          }),
        },
        ticketRun: {
          runId: 'run-35', branch: 'ticket/CYAU-35', authorizedCwd: dir,
          beforeRuntime: vi.fn(async () => undefined), afterRuntime: vi.fn(async () => undefined), block,
        },
      }),
    })

    await vi.advanceTimersByTimeAsync(49)
    expect(execute).not.toHaveBeenCalled()
    await vi.advanceTimersByTimeAsync(1)
    const result = await running

    expect(renewSignal?.aborted).toBe(true)
    expect(execute).not.toHaveBeenCalled()
    expect(block).toHaveBeenCalledTimes(1)
    expect(release).toHaveBeenCalledTimes(1)
    expect(result.preflightStopped).toHaveLength(1)
  })

  it('shutdown during beforeRuntime blocks and releases without reaching the spawn', async () => {
    const p = paths()
    saveState(p.stateFile, updateAction(emptyState(), 'fast', {last_run: '2026-07-07T09:00:00.000Z'}))
    const controller = new AbortController()
    const release = vi.fn(async () => undefined)
    const block = vi.fn(async () => undefined)
    const execute = vi.fn()

    const result = await runOnce({
      playbook, playbookDir: dir, now, ...p, signal: controller.signal,
      runtime: {id: 'fake', healthCheck: async () => ({available: true}), execute},
      preflight: async () => ({
        outcome: 'admit', state: 'ready', reason: 'ok', audit: [],
        executionLease: {renewEveryMs: 1000, renew: vi.fn(async () => true), release},
        ticketRun: {
          runId: 'run-35', branch: 'ticket/CYAU-35', authorizedCwd: dir,
          beforeRuntime: async () => { controller.abort() },
          afterRuntime: vi.fn(async () => undefined), block,
        },
      }),
    })

    expect(execute).not.toHaveBeenCalled()
    expect(block).toHaveBeenCalledTimes(1)
    expect(release).toHaveBeenCalledTimes(1)
    expect(result.executed).toHaveLength(0)
    expect(result.preflightStopped).toEqual([expect.objectContaining({reason: expect.stringContaining('shutdown')})])
  })

  it('unexpected runtime reject persists blocked before releasing the lease', async () => {
    const p = paths()
    saveState(p.stateFile, updateAction(emptyState(), 'fast', {last_run: '2026-07-07T09:00:00.000Z'}))
    const order: string[] = []
    const block = vi.fn(async () => { order.push('blocked') })
    const release = vi.fn(async () => { order.push('release') })

    await expect(runOnce({
      playbook, playbookDir: dir, now, ...p,
      runtime: {
        id: 'fake', healthCheck: async () => ({available: true}),
        execute: () => ({result: Promise.reject(new Error('runtime reject')), cancel: () => undefined}),
      },
      preflight: async () => ({
        outcome: 'admit', state: 'ready', reason: 'ok', audit: [],
        executionLease: {renewEveryMs: 1000, renew: vi.fn(async () => true), release},
        ticketRun: {
          runId: 'run-35', branch: 'ticket/CYAU-35', authorizedCwd: dir,
          beforeRuntime: vi.fn(async () => undefined), afterRuntime: vi.fn(async () => undefined), block,
        },
      }),
    })).rejects.toThrow(/runtime reject/)

    expect(order).toEqual(['blocked', 'release'])
    expect(block).toHaveBeenCalledTimes(1)
    expect(release).toHaveBeenCalledTimes(1)
  })

  it('renews in parallel before and beyond the original expiry (TTL-1 / TTL / TTL+1)', async () => {
    vi.useFakeTimers()
    const p = paths()
    saveState(p.stateFile, updateAction(emptyState(), 'fast', {last_run: '2026-07-07T09:00:00.000Z'}))
    const renew = vi.fn().mockResolvedValue(true)
    const release = vi.fn().mockResolvedValue(undefined)
    let finish!: (result: RunResult) => void
    const runtime: AgentRuntime = {
      id: 'fake', healthCheck: async () => ({available: true}),
      execute: () => ({
        result: new Promise<RunResult>((resolve) => { finish = resolve }),
        cancel: () => undefined,
      }),
    }

    const running = runOnce({
      playbook, playbookDir: dir, now, ...p, runtime,
      preflight: async () => ({
        outcome: 'admit', state: 'ready', reason: 'ok', audit: [],
        executionLease: {renewEveryMs: 1000, renewTimeoutMs: 500, renew, release},
      }),
    })
    await vi.advanceTimersByTimeAsync(0)
    await vi.advanceTimersByTimeAsync(2999) // TTL - 1 ms
    expect(renew).toHaveBeenCalledTimes(2)
    await vi.advanceTimersByTimeAsync(1) // TTL
    expect(renew).toHaveBeenCalledTimes(3)
    await vi.advanceTimersByTimeAsync(1) // TTL + 1 ms
    expect(renew).toHaveBeenCalledTimes(3)

    finish({status: 'success', exitCode: 0, errorCode: null, durationMs: 3001, logPath: '/x', stdout: ''})
    await running
    expect(release).toHaveBeenCalledTimes(1)
  })

  it('non-attested lease renewal cancels the runtime, prevents later phases and records cancelled', async () => {
    vi.useFakeTimers()
    const two = PlaybookSchema.parse({
      version: 1,
      actions: {
        a: {schedule: 'every 1m', type: 'shell', run: 'echo a'},
        b: {schedule: 'every 1m', type: 'shell', run: 'echo b'},
      },
    })
    const p = paths()
    let state = updateAction(emptyState(), 'a', {last_run: '2026-07-07T09:00:00.000Z'})
    state = updateAction(state, 'b', {last_run: '2026-07-07T09:00:00.000Z'})
    saveState(p.stateFile, state)
    const release = vi.fn().mockResolvedValue(undefined)
    const renew = vi.fn().mockResolvedValue(false)
    const cancel = vi.fn()
    const seen: string[] = []
    const runtime: AgentRuntime = {
      id: 'fake',
      healthCheck: async () => ({available: true}),
      execute(name) {
        seen.push(name)
        let finish!: (result: RunResult) => void
        const result = new Promise<RunResult>((resolve) => { finish = resolve })
        cancel.mockImplementation(() => finish({
          status: 'failure', exitCode: null, errorCode: 'C001-EXEC-003', durationMs: 1, logPath: '/x', stdout: '',
        }))
        return {result, cancel}
      },
    }

    const running = runOnce({
      playbook: two, playbookDir: dir, now, ...p, runtime,
      preflight: async () => ({
        outcome: 'admit', state: 'ready', reason: 'ok', audit: [],
        executionLease: {renewEveryMs: 1000, renewTimeoutMs: 500, renew, release},
      }),
    })
    await vi.advanceTimersByTimeAsync(1000)
    const result = await running

    expect(renew).toHaveBeenCalledTimes(1)
    expect(cancel).toHaveBeenCalledTimes(1)
    expect(release).toHaveBeenCalledTimes(1)
    expect(seen).toEqual(['a'])
    expect(result.executed).toHaveLength(1)
    expect(result.executed[0].result.outcome).toBe('cancelled')
    expect(result.executed[0].errorCode).toBe('C409-LEASE-005')
  })

  it('hanging HTTP renew expires within the lease timeout and does not wait for the general runtime timeout', async () => {
    vi.useFakeTimers()
    const p = paths()
    saveState(p.stateFile, updateAction(emptyState(), 'fast', {last_run: '2026-07-07T09:00:00.000Z'}))
    let renewSignal: AbortSignal | undefined
    const renew = vi.fn((signal?: AbortSignal) => {
      renewSignal = signal
      return new Promise<boolean>(() => undefined)
    })
    const release = vi.fn().mockResolvedValue(undefined)
    const cancel = vi.fn()
    const runtime: AgentRuntime = {
      id: 'fake', healthCheck: async () => ({available: true}),
      execute() {
        let finish!: (result: RunResult) => void
        const result = new Promise<RunResult>((resolve) => { finish = resolve })
        cancel.mockImplementation(() => finish({
          status: 'failure', exitCode: null, errorCode: 'C001-EXEC-003', durationMs: 1500, logPath: '/x', stdout: '',
        }))
        return {result, cancel}
      },
    }

    const running = runOnce({
      playbook, playbookDir: dir, now, ...p, runtime,
      preflight: async () => ({
        outcome: 'admit', state: 'ready', reason: 'ok', audit: [],
        executionLease: {renewEveryMs: 1000, renewTimeoutMs: 500, renew, release},
      }),
    })
    await vi.advanceTimersByTimeAsync(1499)
    expect(cancel).not.toHaveBeenCalled()
    await vi.advanceTimersByTimeAsync(1)
    await running

    expect(renewSignal?.aborted).toBe(true)
    expect(cancel).toHaveBeenCalledTimes(1)
    expect(release).toHaveBeenCalledTimes(1)
  })

  it('failed synchronous renew uses the period as timeout and loses the lease fail-closed', async () => {
    vi.useFakeTimers()
    const p = paths()
    saveState(p.stateFile, updateAction(emptyState(), 'fast', {last_run: '2026-07-07T09:00:00.000Z'}))
    const renew = vi.fn(() => { throw new Error('renew sincrono fallito') })
    const release = vi.fn().mockResolvedValue(undefined)
    const cancel = vi.fn()
    const runtime: AgentRuntime = {
      id: 'fake', healthCheck: async () => ({available: true}),
      execute() {
        let finish!: (result: RunResult) => void
        const result = new Promise<RunResult>((resolve) => { finish = resolve })
        cancel.mockImplementation(() => finish({
          status: 'failure', exitCode: null, errorCode: 'C001-EXEC-003', durationMs: 1000, logPath: '/x', stdout: '',
        }))
        return {result, cancel}
      },
    }

    const running = runOnce({
      playbook, playbookDir: dir, now, ...p, runtime,
      preflight: async () => ({
        outcome: 'admit', state: 'ready', reason: 'ok', audit: [],
        executionLease: {renewEveryMs: 1000, renew, release},
      }),
    })
    await vi.advanceTimersByTimeAsync(1000)
    const result = await running

    expect(renew).toHaveBeenCalledTimes(1)
    expect(cancel).toHaveBeenCalledTimes(1)
    expect(release).toHaveBeenCalledTimes(1)
    expect(result.executed[0].result.outcome).toBe('cancelled')
    expect(result.executed[0].errorCode).toBe('C409-LEASE-005')
  })

  it('blocked remote heartbeat stays independent of the renewal and the lease is already released', async () => {
    vi.useFakeTimers()
    const p = paths()
    saveState(p.stateFile, updateAction(emptyState(), 'fast', {last_run: '2026-07-07T09:00:00.000Z'}))
    const renew = vi.fn().mockResolvedValue(true)
    const release = vi.fn().mockResolvedValue(undefined)
    let finish!: (result: RunResult) => void
    let finishHeartbeat!: () => void
    const heartbeat = vi.fn(() => new Promise<void>((resolve) => { finishHeartbeat = resolve }))
    const runtime: AgentRuntime = {
      id: 'fake', healthCheck: async () => ({available: true}),
      execute: () => ({
        result: new Promise<RunResult>((resolve) => { finish = resolve }), cancel: () => undefined,
      }),
    }
    const running = runOnce({
      playbook, playbookDir: dir, now, ...p, runtime, heartbeat,
      preflight: async () => ({
        outcome: 'admit', state: 'ready', reason: 'ok', audit: [],
        executionLease: {renewEveryMs: 1000, renewTimeoutMs: 500, renew, release},
      }),
    })

    await vi.advanceTimersByTimeAsync(1000)
    expect(renew).toHaveBeenCalledTimes(1)
    finish({status: 'success', exitCode: 0, errorCode: null, durationMs: 1000, logPath: '/x', stdout: ''})
    await vi.advanceTimersByTimeAsync(0)
    expect(heartbeat).toHaveBeenCalledTimes(1)
    expect(release).toHaveBeenCalledTimes(1)
    finishHeartbeat()
    await running
  })

  it('shutdown with renewal in flight aborts it, does not reschedule and releases only once', async () => {
    vi.useFakeTimers()
    const p = paths()
    saveState(p.stateFile, updateAction(emptyState(), 'fast', {last_run: '2026-07-07T09:00:00.000Z'}))
    const controller = new AbortController()
    let renewSignal: AbortSignal | undefined
    const renew = vi.fn((signal?: AbortSignal) => {
      renewSignal = signal
      return new Promise<boolean>(() => undefined)
    })
    const release = vi.fn().mockResolvedValue(undefined)
    const runtime: AgentRuntime = {
      id: 'fake', healthCheck: async () => ({available: true}),
      execute: (_name, _action, context) => {
        let finish!: (result: RunResult) => void
        const result = new Promise<RunResult>((resolve) => { finish = resolve })
        const cancel = () => finish({
          status: 'failure', exitCode: null, errorCode: 'C001-EXEC-003', durationMs: 1000, logPath: '/x', stdout: '',
        })
        context.signal?.addEventListener('abort', cancel, {once: true})
        return {result, cancel}
      },
    }
    const running = runOnce({
      playbook, playbookDir: dir, now, ...p, runtime, signal: controller.signal,
      preflight: async () => ({
        outcome: 'admit', state: 'ready', reason: 'ok', audit: [],
        executionLease: {renewEveryMs: 1000, renewTimeoutMs: 500, renew, release},
      }),
    })

    await vi.advanceTimersByTimeAsync(1000)
    expect(renew).toHaveBeenCalledTimes(1)
    controller.abort()
    await vi.advanceTimersByTimeAsync(0)
    await running
    expect(renewSignal?.aborted).toBe(true)
    expect(release).toHaveBeenCalledTimes(1)
    await vi.advanceTimersByTimeAsync(5000)
    expect(renew).toHaveBeenCalledTimes(1)
  })

  it('natural completion waits for the in-flight renewal and a lost answer blocks the next phase', async () => {
    vi.useFakeTimers()
    const two = PlaybookSchema.parse({
      version: 1,
      actions: {
        a: {schedule: 'every 1m', type: 'shell', run: 'echo a'},
        b: {schedule: 'every 1m', type: 'shell', run: 'echo b'},
      },
    })
    const p = paths()
    let state = updateAction(emptyState(), 'a', {last_run: '2026-07-07T09:00:00.000Z'})
    state = updateAction(state, 'b', {last_run: '2026-07-07T09:00:00.000Z'})
    saveState(p.stateFile, state)
    let finishRuntime!: (result: RunResult) => void
    let finishRenew!: (held: boolean) => void
    const renew = vi.fn(() => new Promise<boolean>((resolve) => { finishRenew = resolve }))
    const release = vi.fn().mockResolvedValue(undefined)
    const seen: string[] = []
    const runtime: AgentRuntime = {
      id: 'fake', healthCheck: async () => ({available: true}),
      execute: (name) => {
        seen.push(name)
        if (name === 'b') {
          return {
            result: Promise.resolve({status: 'success', exitCode: 0, errorCode: null, durationMs: 1, logPath: '/b', stdout: ''}),
            cancel: () => undefined,
          }
        }
        return {
          result: new Promise<RunResult>((resolve) => { finishRuntime = resolve }),
          cancel: () => undefined,
        }
      },
    }
    const running = runOnce({
      playbook: two, playbookDir: dir, now, ...p, runtime,
      preflight: async () => ({
        outcome: 'admit', state: 'ready', reason: 'ok', audit: [],
        executionLease: {renewEveryMs: 1000, renewTimeoutMs: 500, renew, release},
      }),
    })

    await vi.advanceTimersByTimeAsync(1000)
    expect(renew).toHaveBeenCalledTimes(1)
    finishRuntime({status: 'success', exitCode: 0, errorCode: null, durationMs: 1000, logPath: '/a', stdout: ''})
    await vi.advanceTimersByTimeAsync(0)
    finishRenew(false)
    await vi.advanceTimersByTimeAsync(0)
    const result = await running

    expect(seen).toEqual(['a'])
    expect(result.executed).toHaveLength(1)
    expect(result.executed[0].result.outcome).toBe('cancelled')
    expect(result.executed[0].errorCode).toBe('C409-LEASE-005')
    expect(release).toHaveBeenCalledTimes(1)
  })

  it('shutdown after the runtime completion immediately interrupts the wait for the in-flight renewal', async () => {
    vi.useFakeTimers()
    const p = paths()
    saveState(p.stateFile, updateAction(emptyState(), 'fast', {last_run: '2026-07-07T09:00:00.000Z'}))
    const controller = new AbortController()
    let finishRuntime!: (result: RunResult) => void
    let renewSignal: AbortSignal | undefined
    const renew = vi.fn((signal?: AbortSignal) => {
      renewSignal = signal
      return new Promise<boolean>(() => undefined)
    })
    const release = vi.fn().mockResolvedValue(undefined)
    const runtime: AgentRuntime = {
      id: 'fake', healthCheck: async () => ({available: true}),
      execute: () => ({
        result: new Promise<RunResult>((resolve) => { finishRuntime = resolve }),
        cancel: () => undefined,
      }),
    }
    const running = runOnce({
      playbook, playbookDir: dir, now, ...p, runtime, signal: controller.signal,
      preflight: async () => ({
        outcome: 'admit', state: 'ready', reason: 'ok', audit: [],
        executionLease: {renewEveryMs: 1000, renewTimeoutMs: 20 * 60_000, renew, release},
      }),
    })

    await vi.advanceTimersByTimeAsync(1000)
    finishRuntime({status: 'success', exitCode: 0, errorCode: null, durationMs: 1000, logPath: '/x', stdout: ''})
    await vi.advanceTimersByTimeAsync(0)
    controller.abort()
    await vi.advanceTimersByTimeAsync(0)
    const result = await running

    expect(renewSignal?.aborted).toBe(true)
    expect(release).toHaveBeenCalledTimes(1)
    expect(result.executed[0].result.outcome).toBe('cancelled')
    expect(result.executed[0].errorCode).not.toBe('C409-LEASE-005')
  })

  it('shutdown during the preflight releases the admitted lease without starting the runtime', async () => {
    const p = paths()
    saveState(p.stateFile, updateAction(emptyState(), 'fast', {last_run: '2026-07-07T09:00:00.000Z'}))
    const controller = new AbortController()
    const release = vi.fn().mockResolvedValue(undefined)
    const execute = vi.fn()
    const runtime: AgentRuntime = {id: 'fake', healthCheck: async () => ({available: true}), execute}

    const result = await runOnce({
      playbook, playbookDir: dir, now, ...p, runtime, signal: controller.signal,
      preflight: async () => {
        controller.abort()
        return {
          outcome: 'admit', state: 'ready', reason: 'ok', audit: [],
          executionLease: {renewEveryMs: 1000, renew: vi.fn(async () => true), release},
        }
      },
    })

    expect(execute).not.toHaveBeenCalled()
    expect(release).toHaveBeenCalledTimes(1)
    expect(result.executed).toEqual([])
  })

  // CYAU-87: the per-agent report channel disappeared with the typed-agent catalogue, but the invariant that test
  // guarded stays and is more important than the report: an action outcome is DURABLE before the next one
  // starts. Here it is observed from the point of view of the following action, instead of the removed spy.
  it('the outcome is durable before the next action starts', async () => {
    const two = PlaybookSchema.parse({
      version: 1,
      actions: {
        a: {schedule: 'every 1m', type: 'shell', run: 'echo a'},
        b: {schedule: 'every 1m', type: 'shell', run: 'echo b'},
      },
    })
    const p = paths()
    let state = updateAction(emptyState(), 'a', {last_run: '2026-07-07T09:00:00.000Z'})
    state = updateAction(state, 'b', {last_run: '2026-07-07T09:00:00.000Z'})
    saveState(p.stateFile, state)
    const aPersistedWhenBStarted: boolean[] = []
    const runtime: AgentRuntime = {
      id: 'spawn', healthCheck: async () => ({available: true}),
      execute: (name) => {
        if (name === 'b') aPersistedWhenBStarted.push(loadState(p.stateFile).actions.a.last_result !== null)
        return {result: Promise.resolve({status: 'success', exitCode: 0, errorCode: null, durationMs: 1, logPath: '/x', stdout: ''}), cancel: () => undefined}
      },
    }

    await runOnce({playbook: two, playbookDir: dir, now, ...p, runtime})

    expect(aPersistedWhenBStarted).toEqual([true])
  })

  it('a persistence failure is fail-closed: it does not start the next actions', async () => {
    const two = PlaybookSchema.parse({
      version: 1,
      actions: {
        a: {schedule: 'every 1m', type: 'shell', run: 'echo a'},
        b: {schedule: 'every 1m', type: 'shell', run: 'echo b'},
      },
    })
    const p = paths()
    let state = updateAction(emptyState(), 'a', {last_run: '2026-07-07T09:00:00.000Z'})
    state = updateAction(state, 'b', {last_run: '2026-07-07T09:00:00.000Z'})
    saveState(p.stateFile, state)
    const seen: string[] = []
    const runtime: AgentRuntime = {
      id: 'spawn', healthCheck: async () => ({available: true}),
      execute: (name) => {
        seen.push(name)
        return {result: Promise.resolve({status: 'success', exitCode: 0, errorCode: null, durationMs: 1, logPath: '/x', stdout: ''}), cancel: () => undefined}
      },
    }

    await expect(runOnce({
      playbook: two, playbookDir: dir, now, ...p, runtime,
      persistState: () => { throw new Error('disco pieno') },
    })).rejects.toThrow('disco pieno')

    expect(seen).toEqual(['a'])
  })

  it('heartbeat called with ok=true when all succeed', async () => {
    const p = paths()
    saveState(p.stateFile, updateAction(emptyState(), 'fast', {last_run: '2026-07-07T09:00:00.000Z'}))
    const heartbeat = vi.fn().mockResolvedValue(undefined)
    await runOnce({playbook, playbookDir: dir, now, ...p, spawn: spawnWith(0), heartbeat})
    expect(heartbeat).toHaveBeenCalledWith(true, expect.any(Array))
  })

  it('heartbeat called with ok=false if an action fails', async () => {
    const p = paths()
    saveState(p.stateFile, updateAction(emptyState(), 'fast', {last_run: '2026-07-07T09:00:00.000Z'}))
    const heartbeat = vi.fn().mockResolvedValue(undefined)
    await runOnce({playbook, playbookDir: dir, now, ...p, spawn: spawnWith(1), heartbeat})
    expect(heartbeat).toHaveBeenCalledWith(false, expect.any(Array))
  })

  it('releases the lock at the end of the iteration', async () => {
    const p = paths()
    await runOnce({playbook, playbookDir: dir, now, ...p, spawn: spawnWith(0)})
    expect(fs.existsSync(p.lockFile)).toBe(false)
  })

  it('uses the injected runtime instead of the default (common contract, interchangeable provider)', async () => {
    const p = paths()
    saveState(p.stateFile, updateAction(emptyState(), 'fast', {last_run: '2026-07-07T09:00:00.000Z'}))
    const seen: string[] = []
    const stub: RunResult = {status: 'success', exitCode: 0, errorCode: null, durationMs: 1, logPath: '/x', stdout: ''}
    const runtime: AgentRuntime = {
      id: 'fake',
      healthCheck: async () => ({available: true}),
      execute(name) {
        seen.push(name)
        return {result: Promise.resolve(stub), cancel: () => undefined}
      },
    }
    const result = await runOnce({playbook, playbookDir: dir, now, ...p, runtime})
    expect(seen).toContain('fast')
    expect(result.executed.map((e) => e.name)).toContain('fast')
    expect(loadState(p.stateFile).actions.fast.last_status).toBe('success')
  })

  it('routes by type: claude actions → claudeRuntime, shell actions → runtime', async () => {
    const mixed = PlaybookSchema.parse({
      version: 1,
      actions: {
        cl: {schedule: 'every 1m', type: 'claude', run: '/x'},
        sh: {schedule: 'every 1m', type: 'shell', run: 'echo x'},
      },
    })
    const p = paths()
    let state = updateAction(emptyState(), 'cl', {last_run: '2026-07-07T09:00:00.000Z'})
    state = updateAction(state, 'sh', {last_run: '2026-07-07T09:00:00.000Z'})
    saveState(p.stateFile, state)
    const stub: RunResult = {status: 'success', exitCode: 0, errorCode: null, durationMs: 1, logPath: '/x', stdout: ''}
    const claudeSeen: string[] = []
    const shellSeen: string[] = []
    const claudeRuntime: AgentRuntime = {
      id: 'claude-fake',
      healthCheck: async () => ({available: true}),
      execute: (name) => {
        claudeSeen.push(name)
        return {result: Promise.resolve(stub), cancel: () => undefined}
      },
    }
    const runtime: AgentRuntime = {
      id: 'shell-fake',
      healthCheck: async () => ({available: true}),
      execute: (name) => {
        shellSeen.push(name)
        return {result: Promise.resolve(stub), cancel: () => undefined}
      },
    }
    await runOnce({playbook: mixed, playbookDir: dir, now, ...p, runtime, claudeRuntime})
    expect(claudeSeen).toEqual(['cl'])
    expect(shellSeen).toEqual(['sh'])
  })

  it('routes by type: codex actions → codexRuntime', async () => {
    const mixed = PlaybookSchema.parse({
      version: 1,
      actions: {
        cx: {schedule: 'every 1m', type: 'codex', run: 'analizza'},
        sh: {schedule: 'every 1m', type: 'shell', run: 'echo x'},
      },
    })
    const p = paths()
    let state = updateAction(emptyState(), 'cx', {last_run: '2026-07-07T09:00:00.000Z'})
    state = updateAction(state, 'sh', {last_run: '2026-07-07T09:00:00.000Z'})
    saveState(p.stateFile, state)
    const stub: RunResult = {status: 'success', exitCode: 0, errorCode: null, durationMs: 1, logPath: '/x', stdout: ''}
    const codexSeen: string[] = []
    const shellSeen: string[] = []
    const codexRuntime: AgentRuntime = {
      id: 'codex-fake',
      healthCheck: async () => ({available: true}),
      execute: (name) => {
        codexSeen.push(name)
        return {result: Promise.resolve(stub), cancel: () => undefined}
      },
    }
    const runtime: AgentRuntime = {
      id: 'shell-fake',
      healthCheck: async () => ({available: true}),
      execute: (name) => {
        shellSeen.push(name)
        return {result: Promise.resolve(stub), cancel: () => undefined}
      },
    }
    await runOnce({playbook: mixed, playbookDir: dir, now, ...p, runtime, codexRuntime})
    expect(codexSeen).toEqual(['cx'])
    expect(shellSeen).toEqual(['sh'])
  })

  it('opts.runtime without claudeRuntime is a global override: the claude actions use it too', async () => {
    const onlyClaude = PlaybookSchema.parse({
      version: 1,
      actions: {cl: {schedule: 'every 1m', type: 'claude', run: '/x'}},
    })
    const p = paths()
    saveState(p.stateFile, updateAction(emptyState(), 'cl', {last_run: '2026-07-07T09:00:00.000Z'}))
    const stub: RunResult = {status: 'success', exitCode: 0, errorCode: null, durationMs: 1, logPath: '/x', stdout: ''}
    const seen: string[] = []
    const runtime: AgentRuntime = {
      id: 'fake',
      healthCheck: async () => ({available: true}),
      execute: (name) => {
        seen.push(name)
        return {result: Promise.resolve(stub), cancel: () => undefined}
      },
    }
    await runOnce({playbook: onlyClaude, playbookDir: dir, now, ...p, runtime})
    expect(seen).toEqual(['cl'])
  })

  it('every recorded action carries an AgentRunResult validated with the same schema (claude/codex/shell)', async () => {
    const mixed = PlaybookSchema.parse({
      version: 1,
      actions: {
        cl: {schedule: 'every 1m', type: 'claude', run: '/x'},
        cx: {schedule: 'every 1m', type: 'codex', run: 'analizza'},
        sh: {schedule: 'every 1m', type: 'shell', run: 'echo x'},
      },
    })
    const p = paths()
    let state = updateAction(emptyState(), 'cl', {last_run: '2026-07-07T09:00:00.000Z'})
    state = updateAction(state, 'cx', {last_run: '2026-07-07T09:00:00.000Z'})
    state = updateAction(state, 'sh', {last_run: '2026-07-07T09:00:00.000Z'})
    saveState(p.stateFile, state)
    const okReport = JSON.stringify({summary: 'fatto', changed_files: ['a.ts'], confidence: 0.9})
    const mk = (id: string, res: RunResult): AgentRuntime => ({
      id,
      healthCheck: async () => ({available: true}),
      execute: () => ({result: Promise.resolve(res), cancel: () => undefined}),
    })
    const claudeRuntime = mk('claude', {status: 'success', exitCode: 0, errorCode: null, durationMs: 5, logPath: '/l/cl', stdout: okReport})
    const codexRuntime = mk('codex', {status: 'timeout', exitCode: null, errorCode: 'C124-EXEC-001', durationMs: 9, logPath: '/l/cx', stdout: ''})
    const runtime = mk('spawn', {status: 'failure', exitCode: 1, errorCode: 'C001-EXEC-003', durationMs: 2, logPath: '/l/sh', stdout: ''})

    const result = await runOnce({playbook: mixed, playbookDir: dir, now, ...p, runtime, claudeRuntime, codexRuntime})

    const byName: Record<string, AgentRunResult> = {}
    for (const e of result.executed) byName[e.name] = e.result
    for (const name of ['cl', 'cx', 'sh']) {
      expect(AgentRunResultSchema.safeParse(byName[name]).success).toBe(true)
      expect(Object.keys(byName[name]).sort()).toEqual(Object.keys(byName.cl).sort())
    }
    expect(byName.cl.outcome).toBe('success')
    expect(byName.cl.summary).toBe('fatto')
    expect(byName.cl.metadata.runtime).toBe('claude')
    expect(byName.cx.outcome).toBe('timeout')
    expect(byName.cx.metadata.runtime).toBe('codex')
    expect(byName.sh.outcome).toBe('failure')

    // The returned value is not only transient: it survives the load from disk (simulates the restart).
    const restarted = loadState(p.stateFile)
    expect(restarted.actions.cl.last_result).toEqual(byName.cl)
    expect(restarted.actions.cx.last_result).toEqual(byName.cx)
    expect(restarted.actions.sh.last_result).toEqual(byName.sh)
  })

  it('invalid output persists the error and the log path without inventing summary/tests/files', async () => {
    const one = PlaybookSchema.parse({version: 1, actions: {a: {schedule: 'every 1m', type: 'shell', run: 'echo x'}}})
    const p = paths()
    saveState(p.stateFile, updateAction(emptyState(), 'a', {last_run: '2026-07-07T09:00:00.000Z'}))
    const raw: RunResult = {
      status: 'failure', exitCode: 1, errorCode: 'C001-EXEC-003', durationMs: 7,
      logPath: '/logs/runtime-failure.log', stdout: '{json non valido',
    }
    const runtime: AgentRuntime = {
      id: 'spawn', healthCheck: async () => ({available: true}),
      execute: () => ({result: Promise.resolve(raw), cancel: () => undefined}),
    }

    await runOnce({playbook: one, playbookDir: dir, now, ...p, runtime})

    expect(loadState(p.stateFile).actions.a.last_result).toEqual({
      outcome: 'failure', summary: null, changedFiles: [],
      tests: {passed: null, failed: null, summary: null}, risks: [], commit: null, confidence: null,
      metadata: {
        runtime: 'spawn', action: 'a', exitCode: 1, errorCode: 'C001-EXEC-003', durationMs: 7,
        logPath: '/logs/runtime-failure.log', reportParsed: false,
      },
    })
  })

  it('propagates the signal to the runtimes (end-to-end cooperative cancellation)', async () => {
    const one = PlaybookSchema.parse({version: 1, actions: {a: {schedule: 'every 1m', type: 'shell', run: 'echo x'}}})
    const p = paths()
    saveState(p.stateFile, updateAction(emptyState(), 'a', {last_run: '2026-07-07T09:00:00.000Z'}))
    const controller = new AbortController()
    let captured: AbortSignal | undefined
    const stub: RunResult = {status: 'success', exitCode: 0, errorCode: null, durationMs: 1, logPath: '/x', stdout: ''}
    const runtime: AgentRuntime = {
      id: 'spawn',
      healthCheck: async () => ({available: true}),
      execute: (_name, _action, ctx) => {
        captured = ctx.signal
        return {result: Promise.resolve(stub), cancel: () => undefined}
      },
    }
    await runOnce({playbook: one, playbookDir: dir, now, ...p, runtime, signal: controller.signal})
    expect(captured).toBe(controller.signal)
  })

  it('signal aborted during an action → outcome cancelled and the next actions do not start', async () => {
    const two = PlaybookSchema.parse({
      version: 1,
      actions: {
        a: {schedule: 'every 1m', type: 'shell', run: 'echo a'},
        b: {schedule: 'every 1m', type: 'shell', run: 'echo b'},
      },
    })
    const p = paths()
    let state = updateAction(emptyState(), 'a', {last_run: '2026-07-07T09:00:00.000Z'})
    state = updateAction(state, 'b', {last_run: '2026-07-07T09:00:00.000Z'})
    saveState(p.stateFile, state)
    const controller = new AbortController()
    const stub: RunResult = {status: 'success', exitCode: 0, errorCode: null, durationMs: 1, logPath: '/x', stdout: ''}
    const seen: string[] = []
    const runtime: AgentRuntime = {
      id: 'spawn',
      healthCheck: async () => ({available: true}),
      execute: (name) => {
        seen.push(name)
        controller.abort() // abort while the first action is running
        return {result: Promise.resolve(stub), cancel: () => undefined}
      },
    }
    const result = await runOnce({playbook: two, playbookDir: dir, now, ...p, runtime, signal: controller.signal})
    expect(seen).toHaveLength(1) // break: the second action does not start
    expect(result.executed).toHaveLength(1)
    expect(result.executed[0].result.outcome).toBe('cancelled')
  })
})

describe('runOnce · corrupted state (CYAU-12)', () => {

  it('corrupted state.json → quarantined (preserved) and restarts, without overwriting it', async () => {

    const p = paths()

    fs.mkdirSync(path.dirname(p.stateFile), {recursive: true})

    fs.writeFileSync(p.stateFile, '{ questo non è json valido')



    const result = await runOnce({playbook, playbookDir: dir, now, ...p, spawn: spawnWith(0)})



    // The corrupted file is preserved in quarantine (never lost, never overwritten).

    expect(result.stateQuarantined).toBeTruthy()

    const quar = result.stateQuarantined as string

    expect(quar.startsWith(`${p.stateFile}.corrupt-`)).toBe(true)

    expect(fs.readFileSync(quar, 'utf8')).toBe('{ questo non è json valido')



    // A new valid state.json was written: the cycle restarted, it did not crash.

    expect(fs.existsSync(p.stateFile)).toBe(true)

    expect(loadState(p.stateFile).version).toBe(1)

  })



  it('valid state → no quarantine', async () => {

    const p = paths()

    saveState(p.stateFile, emptyState())

    const result = await runOnce({playbook, playbookDir: dir, now, ...p, spawn: spawnWith(0)})

    expect(result.stateQuarantined).toBeNull()

  })

})
