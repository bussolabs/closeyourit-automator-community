import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import {type Interfaces} from '@oclif/core'
import {afterEach, beforeEach, describe, expect, it} from 'vitest'
import Limits from '../src/commands/limits'
import {
  type LimitsDecision,
  type LimitsPolicy,
  type PolicyFetcher,
  type UsageRecord,
  readUsage,
  usageLockPath,
  UsageLockCleanupPendingError,
  UsageRecordedLockError,
} from '../src/lib/limits'
import {run, runCaptured, runExpectingExit, testConfig} from './helpers/command'

// The `limits` command (CYAU-32) applies budget, concurrency limits and kill switch. Safe-by-default shell gate:
// an admitted run → exit 0; an exceeded dispatch limit (slot/budget/hours/kill switch/fail-closed) → exit 3
// (C409-LIMITS-002, do not start); a running run to bring to a safe checkpoint → exit 3 (C409-LIMITS-003, never a
// brutal kill); invalid input → exit 2 (C400-LIMITS-001). With `--record` it records the daily usage.

const NOW = new Date('2026-07-13T12:00:00.000Z') // Monday 12:00 UTC (deterministic)

let stateDir: string
let configDir: string

beforeEach(() => {
  stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cmd-limits-state-'))
  configDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cmd-limits-config-'))
  process.env.AUTOMATOR_STATE_DIR = stateDir
  process.env.AUTOMATOR_CONFIG_DIR = configDir
})

afterEach(() => {
  delete process.env.AUTOMATOR_STATE_DIR
  delete process.env.AUTOMATOR_CONFIG_DIR
  fs.rmSync(stateDir, {recursive: true, force: true})
  fs.rmSync(configDir, {recursive: true, force: true})
})

// Test subclass: fixed clock (deterministic schedule). The policy comes from --policy in most
// tests → no network.
class TestLimits extends Limits {
  protected clock(): Date {
    return NOW
  }
}

/** Subclass simulating a CONFIGURED but non-retrievable policy (fail-closed) or a non-configured one. */
function withPolicy(policy: LimitsPolicy | null, configured: boolean): typeof Limits {
  return class extends TestLimits {
    protected async loadPolicy(): Promise<{policy: LimitsPolicy | null; configured: boolean}> {
      return {policy, configured}
    }
  }
}

interface LimitsPayload {
  code: string | null
  mode: 'dispatch' | 'continue'
  repository: string | null
  decision: LimitsDecision
  source: string
}

describe('limits command — dispatch (new run start): DoD no host exceeds the limits', () => {
  it('free slots within the budget → admit, exit 0', async () => {
    const {result} = await runCaptured(TestLimits, ['--policy', '{"max_parallel":3}', '--running', '1', '--json'])
    const r = result as LimitsPayload
    expect(r.decision.outcome).toBe('admit')
    expect(r.mode).toBe('dispatch')
  })

  it('slot pieni (running >= max_parallel) → exit 3, C409-LIMITS-002', async () => {
    const {stderr} = await runExpectingExit(TestLimits, ['--policy', '{"max_parallel":2}', '--running', '2'], 3)
    expect(stderr).toContain('C409-LIMITS-002')
  })

  it('active kill switch → exit 3, C409-LIMITS-002 (no new run)', async () => {
    const {stdout} = await runExpectingExit(TestLimits, ['--policy', '{"stop_dispatch":true}', '--json'], 3)
    expect(stdout).toContain('C409-LIMITS-002')
    expect(stdout).toContain('kill-switch')
  })

  it('daily run budget exhausted → exit 3, C409-LIMITS-002', async () => {
    const {stderr} = await runExpectingExit(TestLimits, ['--policy', '{"max_daily_runs":5}', '--runs-today', '5'], 3)
    expect(stderr).toContain('C409-LIMITS-002')
  })

  it('daily cost budget exhausted → exit 3, C409-LIMITS-002', async () => {
    const {stderr} = await runExpectingExit(TestLimits, ['--policy', '{"max_daily_cost":10}', '--cost-today', '12'], 3)
    expect(stderr).toContain('C409-LIMITS-002')
  })

  it('outside the allowed time window → exit 3 (now 12:00 UTC, window 13:00–18:00)', async () => {
    const {stderr} = await runExpectingExit(TestLimits, ['--policy', '{"schedule":[{"start":"13:00","end":"18:00"}]}'], 3)
    expect(stderr).toContain('C409-LIMITS-002')
  })

  it('inside the time window → admit (now 12:00 UTC, window 08:00–18:00)', async () => {
    const {result} = await runCaptured(TestLimits, ['--policy', '{"schedule":[{"start":"08:00","end":"18:00"}]}', '--json'])
    expect((result as LimitsPayload).decision.outcome).toBe('admit')
  })

  it('two dispatches with initial snapshots already read re-evaluate the budget under lock', async () => {
    let arrivals = 0
    let release!: () => void
    const bothReady = new Promise<void>((resolve) => { release = resolve })
    class BarrierLimits extends TestLimits {
      protected async catch(error: Interfaces.CommandError): Promise<never> {
        throw error
      }

      protected async reserveDailyUsage(
        date: string,
        delta: {runs: number; cost: number},
        beforeCommit: (current: UsageRecord) => void,
      ): Promise<UsageRecord> {
        arrivals += 1
        if (arrivals === 2) release()
        await bothReady
        return super.reserveDailyUsage(date, delta, beforeCommit)
      }
    }
    const argv = ['--policy', '{"max_daily_runs":1}', '--json']
    const results = await Promise.allSettled([run(BarrierLimits, argv), run(BarrierLimits, argv)])
    expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1)
    expect(results.filter((result) => result.status === 'rejected')).toHaveLength(1)
    const rejected = results.find((result): result is PromiseRejectedResult => result.status === 'rejected')
    expect(rejected?.reason).toMatchObject({message: expect.stringContaining('budget run giornaliere')})
    expect(readUsage('2026-07-13')).toEqual({date: '2026-07-13', runs: 1, cost: 0})
  })

  it('if the UTC day changes during the lock it repeats the reservation on the new day', async () => {
    class MidnightLimits extends Limits {
      private clockReads = 0

      protected clock(): Date {
        this.clockReads += 1
        return this.clockReads <= 2
          ? new Date('2026-07-13T23:59:59.999Z')
          : new Date('2026-07-14T00:00:00.001Z')
      }
    }

    const {result} = await runCaptured(MidnightLimits, ['--policy', '{"max_daily_runs":1}', '--json'])
    expect((result as {reservation: UsageRecord}).reservation.date).toBe('2026-07-14')
    expect(readUsage('2026-07-13').runs).toBe(0)
    expect(readUsage('2026-07-14').runs).toBe(1)
  })

  it('the reservation considers the projected cost and does not exceed the budget', async () => {
    await runCaptured(TestLimits, ['--record', '--runs', '0', '--cost', '0.75', '--json'])
    await runExpectingExit(TestLimits, [
      '--policy', '{"max_daily_cost":1}', '--cost', '0.5', '--json',
    ], 3)
    expect(readUsage('2026-07-13').runs).toBe(0)
    expect(readUsage('2026-07-13').cost).toBeGreaterThanOrEqual(0.75)
    expect(readUsage('2026-07-13').cost).toBeLessThan(1)
  })
})

describe('limits command — continue (running run): kill switch → safe checkpoint, never kill', () => {
  it('runtime within the limit → admit, exit 0', async () => {
    const {result} = await runCaptured(TestLimits, [
      '--mode', 'continue', '--policy', '{"max_runtime_seconds":3600}', '--runtime-seconds', '100', '--json',
    ])
    expect((result as LimitsPayload).decision.outcome).toBe('admit')
  })

  it('active kill switch → checkpoint, exit 3, C409-LIMITS-003 (brings to safe checkpoint, DoD)', async () => {
    const {stdout} = await runExpectingExit(TestLimits, ['--mode', 'continue', '--policy', '{"stop_dispatch":true}', '--json'], 3)
    expect(stdout).toContain('C409-LIMITS-003')
    expect(stdout).toContain('checkpoint')
  })

  it('maximum runtime exceeded → checkpoint, exit 3, C409-LIMITS-003', async () => {
    const {stderr} = await runExpectingExit(TestLimits, [
      '--mode', 'continue', '--policy', '{"max_runtime_seconds":3600}', '--runtime-seconds', '4000',
    ], 3)
    expect(stderr).toContain('C409-LIMITS-003')
  })

  it('runtime limit configured but --runtime-seconds omitted → fail-closed checkpoint, exit 3', async () => {
    const {stdout} = await runExpectingExit(TestLimits, ['--mode', 'continue', '--policy', '{"max_runtime_seconds":3600}', '--json'], 3)
    expect(stdout).toContain('C409-LIMITS-003')
    expect(stdout).toContain('max-runtime')
  })
})

describe('limits command — fail-closed (policy configured but not retrievable)', () => {
  it('dispatch → deny policy-unavailable, exit 3, C409-LIMITS-002', async () => {
    const {stdout} = await runExpectingExit(withPolicy(null, true), ['--json'], 3)
    expect(stdout).toContain('C409-LIMITS-002')
    expect(stdout).toContain('policy-unavailable')
  })

  it('continue → checkpoint policy-unavailable, exit 3, C409-LIMITS-003', async () => {
    const {stdout} = await runExpectingExit(withPolicy(null, true), ['--mode', 'continue', '--json'], 3)
    expect(stdout).toContain('C409-LIMITS-003')
    expect(stdout).toContain('policy-unavailable')
  })

  it('auth-denied → explicit fail-closed, without cached policy applied', async () => {
    class AuthDeniedLimits extends TestLimits {
      protected async loadPolicy(): Promise<{policy: null; configured: true; source: 'auth-denied'}> {
        return {policy: null, configured: true, source: 'auth-denied'}
      }
    }
    const {stdout} = await runExpectingExit(AuthDeniedLimits, ['--mode', 'dispatch', '--json'], 3)
    expect(stdout).toContain('auth-denied')
    expect(stdout).toContain('policy-unavailable')
  })

  it('no configured policy → admit, exit 0 (backward compat: no limit)', async () => {
    const {result} = await runCaptured(withPolicy(null, false), ['--json'])
    const r = result as LimitsPayload
    expect(r.decision.outcome).toBe('admit')
    expect(r.source).toBe('none-configured')
  })
})

describe('limits command — record (daily usage for the budget)', () => {
  it('--record increments the day runs/cost and persists, exit 0', async () => {
    const {result} = await runCaptured(TestLimits, ['--record', '--runs', '1', '--cost', '2.5', '--json'])
    const r = result as {recorded: boolean; usage: {date: string; runs: number; cost: number}}
    expect(r.recorded).toBe(true)
    expect(r.usage).toEqual({date: '2026-07-13', runs: 1, cost: 2.5})
    // persisted in the state dir
    expect(readUsage('2026-07-13')).toEqual({date: '2026-07-13', runs: 1, cost: 2.5})
  })

  it('--record by default records one run (runs=1, cost=0)', async () => {
    await runCaptured(TestLimits, ['--record', '--json'])
    expect(readUsage('2026-07-13')).toEqual({date: '2026-07-13', runs: 1, cost: 0})
  })

  it('due --record accumulano', async () => {
    await runCaptured(TestLimits, ['--record', '--cost', '1', '--json'])
    await runCaptured(TestLimits, ['--record', '--cost', '2', '--json'])
    expect(readUsage('2026-07-13')).toEqual({date: '2026-07-13', runs: 2, cost: 3})
  })

  it('--runs rejects fractions and unsafe integers before writing', async () => {
    await runExpectingExit(TestLimits, ['--record', '--runs', '0.5', '--json'], 2)
    await runExpectingExit(TestLimits, ['--record', '--runs', String(Number.MAX_SAFE_INTEGER + 1), '--json'], 2)
    expect(readUsage('2026-07-13')).toEqual({date: '2026-07-13', runs: 0, cost: 0})
  })

  it('--cost rejects values beyond the safe maximum before writing', async () => {
    await runExpectingExit(TestLimits, ['--record', '--cost', String(Number.MAX_VALUE), '--json'], 2)
    expect(readUsage('2026-07-13')).toEqual({date: '2026-07-13', runs: 0, cost: 0})
  })

  it('--cost conservatively rounds up underflow and lower floats', async () => {
    await runCaptured(TestLimits, ['--record', '--runs', '0', '--cost', '1e-324', '--json'])
    const afterUnderflow = readUsage('2026-07-13').cost
    expect(afterUnderflow).toBe(Number.MIN_VALUE)

    await runCaptured(TestLimits, ['--record', '--runs', '0', '--cost', '0.3', '--json'])
    expect(readUsage('2026-07-13').cost).toBeGreaterThan(0.3)
  })

  it('--cost rejects decimally oversized input before the BigInt', async () => {
    await runExpectingExit(TestLimits, ['--record', '--cost', `0.${'1'.repeat(200)}`, '--json'], 2)
    await runExpectingExit(TestLimits, ['--record', '--cost', '1e-999999999999', '--json'], 2)
  })

  it('successful commit but failed lock cleanup declares recorded:true and requires recovery', async () => {
    class CleanupFailedLimits extends TestLimits {
      protected async recordDailyUsage(_date: string, _delta: {runs: number; cost: number}): Promise<UsageRecord> {
        throw new UsageRecordedLockError({date: '2026-07-13', runs: 3, cost: 1.5})
      }
    }

    const {stdout} = await runExpectingExit(CleanupFailedLimits, ['--record', '--json'], 3)
    expect(stdout).toContain('"recorded": true')
    expect(stdout).toContain('"lock_cleanup_pending": true')
    expect(stdout).toContain('"retryable": false')
    expect(stdout).toContain('C409-LIMITS-004')
  })

  it('lock preserved before the commit declares recorded:false, pending and non-retryable cleanup', async () => {
    class LockPendingLimits extends TestLimits {
      protected async recordDailyUsage(): Promise<UsageRecord> {
        throw new UsageLockCleanupPendingError('lock preservato')
      }
    }

    const {stdout} = await runExpectingExit(LockPendingLimits, ['--record', '--json'], 3)
    expect(stdout).toContain('"recorded": false')
    expect(stdout).toContain('"lock_cleanup_pending": true')
    expect(stdout).toContain('"retryable": false')
  })

  it('dispatch with leftover lock declares pending and non-retryable reservation', async () => {
    const lock = usageLockPath('2026-07-13')
    fs.mkdirSync(path.dirname(lock), {recursive: true})
    fs.writeFileSync(lock, '{"pid":2147483647,"started_at":"2026-07-13T00:00:00Z"}\n')

    const {stdout} = await runExpectingExit(TestLimits, ['--policy', '{}', '--json'], 3)
    expect(stdout).toContain('"reserved": false')
    expect(stdout).toContain('"lock_cleanup_pending": true')
    expect(stdout).toContain('"retryable": false')
  })

  it('corrupted usage → --record fails closed, quarantines once and does not restart from zero', async () => {
    const dir = path.join(stateDir, 'usage')
    const file = path.join(dir, '2026-07-13.json')
    fs.mkdirSync(dir, {recursive: true})
    fs.writeFileSync(file, 'non-json')

    const first = await runExpectingExit(TestLimits, ['--record', '--json'], 3)
    expect(first.stdout).toContain('C409-LIMITS-004')
    expect(fs.existsSync(file)).toBe(false)
    expect(fs.readdirSync(dir).filter((name) => name.startsWith('2026-07-13.json.corrupt-'))).toHaveLength(1)

    const second = await runExpectingExit(TestLimits, ['--record', '--json'], 3)
    expect(second.stdout).toContain('C409-LIMITS-004')
    expect(fs.readdirSync(dir).filter((name) => name.startsWith('2026-07-13.json.corrupt-'))).toHaveLength(1)
  })
})

describe('limits command — snapshot read from disk (lease + usage) when the flags do not provide it', () => {
  it('runs_today read from the usage store: record 3 runs, then budget 3 → exit 3', async () => {
    // records 3 runs today
    await runCaptured(TestLimits, ['--record', '--runs', '3', '--json'])
    const {stderr} = await runExpectingExit(TestLimits, ['--policy', '{"max_daily_runs":3}'], 3)
    expect(stderr).toContain('C409-LIMITS-002')
  })

  it('corrupted usage + configured budget → fail-closed (usage-unavailable), exit 3 (never reopen the budget)', async () => {
    fs.mkdirSync(path.join(stateDir, 'usage'), {recursive: true})
    fs.writeFileSync(path.join(stateDir, 'usage', '2026-07-13.json'), 'non-json')
    const {stdout} = await runExpectingExit(TestLimits, ['--policy', '{"max_daily_runs":5}', '--json'], 3)
    expect(stdout).toContain('C409-LIMITS-002')
    expect(stdout).toContain('usage-unavailable')
  })

  it('both overrides do not bypass a corrupted backing store', async () => {
    fs.mkdirSync(path.join(stateDir, 'usage'), {recursive: true})
    fs.writeFileSync(path.join(stateDir, 'usage', '2026-07-13.json.tmp'), '{"parziale":true}')

    const {stdout} = await runExpectingExit(TestLimits, [
      '--policy', '{"max_daily_runs":5,"max_daily_cost":10}',
      '--runs-today', '0',
      '--cost-today', '0',
      '--json',
    ], 3)
    expect(stdout).toContain('usage-unavailable')
  })

  it('corrupted usage without explicit budget → deny anyway (non-attestable state)', async () => {
    fs.mkdirSync(path.join(stateDir, 'usage'), {recursive: true})
    fs.writeFileSync(path.join(stateDir, 'usage', '2026-07-13.json'), 'non-json')
    const {stdout} = await runExpectingExit(TestLimits, ['--policy', '{"max_parallel":3}', '--running', '0', '--json'], 3)
    expect(stdout).toContain('usage-unavailable')
  })

  it('corrupted usage in continue → fail-closed checkpoint', async () => {
    fs.mkdirSync(path.join(stateDir, 'usage'), {recursive: true})
    fs.writeFileSync(path.join(stateDir, 'usage', '2026-07-13.json'), 'non-json')
    const {stdout} = await runExpectingExit(TestLimits, ['--mode', 'continue', '--policy', '{}', '--json'], 3)
    expect(stdout).toContain('C409-LIMITS-003')
    expect(stdout).toContain('usage-unavailable')
  })
})

describe('limits command — scope repository (policy repo-specific, cache keyed)', () => {
  it('valid --repository enters the payload', async () => {
    const {result} = await runCaptured(TestLimits, ['--policy', '{"max_parallel":3}', '--running', '0', '--repository', 'acme/widget', '--json'])
    expect((result as LimitsPayload).repository).toBe('acme/widget')
  })

  it('invalid --repository (not owner/repo) → exit 2, C400-LIMITS-001', async () => {
    const {stderr} = await runExpectingExit(TestLimits, ['--policy', '{}', '--repository', 'non-un-repo'], 2)
    expect(stderr).toContain('C400-LIMITS-001')
  })
})

describe('limits command — input defence (exit 2, C400-LIMITS-001)', () => {
  it('--policy JSON illegale → exit 2', async () => {
    const {stderr} = await runExpectingExit(TestLimits, ['--policy', 'non-json'], 2)
    expect(stderr).toContain('C400-LIMITS-001')
  })

  it('--policy with non-conforming policy (negative max_parallel) → exit 2', async () => {
    const {stderr} = await runExpectingExit(TestLimits, ['--policy', '{"max_parallel":-1}'], 2)
    expect(stderr).toContain('C400-LIMITS-001')
  })

  it('--mode sconosciuto → exit 2', async () => {
    const {stderr} = await runExpectingExit(TestLimits, ['--mode', 'bogus', '--policy', '{}'], 2)
    expect(stderr).toContain('C400-LIMITS-001')
  })

  it('--running negativo → exit 2', async () => {
    const {stderr} = await runExpectingExit(TestLimits, ['--policy', '{}', '--running', '-1'], 2)
    expect(stderr).toContain('C400-LIMITS-001')
  })

  it('non-numeric --running → exit 2', async () => {
    const {stderr} = await runExpectingExit(TestLimits, ['--policy', '{}', '--running', 'x'], 2)
    expect(stderr).toContain('C400-LIMITS-001')
  })

  it('--cost negativo in record → exit 2', async () => {
    const {stderr} = await runExpectingExit(TestLimits, ['--record', '--cost', '-3'], 2)
    expect(stderr).toContain('C400-LIMITS-001')
  })
})

describe('limits command — policy resolution from the real channel (default loadPolicy)', () => {
  it('no configured sync (empty secret) → admit, real clock, source none-configured', async () => {
    // Base Limits (real clock, real loadPolicy): empty configDir → loadSecrets {} → not configured → admit.
    const {result} = await runCaptured(Limits, ['--json'])
    const r = result as LimitsPayload
    expect(r.decision.outcome).toBe('admit')
    expect(r.source).toBe('none-configured')
  })

  it('configured sync + fetcher answering with a policy → gate evaluated, source server', async () => {
    fs.writeFileSync(path.join(configDir, 'secrets.json'), JSON.stringify({sync: {orgToken: 'cyi_a_x'}}))
    class ServerLimits extends TestLimits {
      protected makePolicyFetcher(): PolicyFetcher {
        return {fetch: async () => ({outcome: 'success', data: {max_parallel: 5}})}
      }
    }
    const {result} = await runCaptured(ServerLimits, ['--running', '0', '--json'])
    const r = result as LimitsPayload
    expect(r.decision.outcome).toBe('admit')
    expect(r.source).toBe('server')
  })

  it('loadPolicy returning a policy without source → gate evaluated, source resolved', async () => {
    const {result} = await runCaptured(withPolicy({max_parallel: 3}, true), ['--running', '1', '--json'])
    const r = result as LimitsPayload
    expect(r.decision.outcome).toBe('admit')
    expect(r.source).toBe('resolved')
  })
})

describe('limits command — human output and real probe', () => {
  it('human output prints the decision and the reason', async () => {
    const {stdout} = await runCaptured(TestLimits, ['--policy', '{"max_parallel":3}', '--running', '1'])
    expect(stdout.toLowerCase()).toContain('admit')
  })

  it('default makePolicyFetcher builds the real probe (read-only: only fetch, no write)', async () => {
    const config = await testConfig()
    class ExposeLimits extends Limits {
      fetcher(): PolicyFetcher {
        return this.makePolicyFetcher()
      }
    }
    const cmd = new ExposeLimits([], config)
    const f = cmd.fetcher()
    expect(typeof f.fetch).toBe('function')
    expect('update' in f).toBe(false)
    expect('write' in f).toBe(false)
  })
})
