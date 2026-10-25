import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest'
import {
  type CachedPolicy,
  type LimitsPolicy,
  type LimitsSnapshot,
  DEFAULT_API_LIMITS_PATH,
  countRunningLeases,
  defaultPolicyFetcher,
  evaluateLimits,
  failClosedDecision,
  isWithinSchedule,
  parseLimitsPolicy,
  readCachedPolicy,
  readUsage,
  readUsageResult,
  recordUsage,
  resolveLimitsPolicy,
  UsageLockCleanupPendingError,
  UsageCommitUncertainError,
  UsageRecoveryPendingError,
  UsageRecordedLockError,
  usageDateKey,
  usageLockPath,
  usagePath,
  writeDurableUsageJson,
  writeCachedPolicy,
} from '../src/lib/limits'
import {type LeaseRecord} from '../src/lib/lease'

// CYAU-32: budget, concurrency limits and kill switch. The core is pure and deterministic: same policy + same
// snapshot → same decision. No host exceeds the limits (DoD); the kill switch prevents new runs and brings the
// active ones to a safe checkpoint. Server-side policy with fail-closed local cache.

const NOW = new Date('2026-07-13T12:00:00.000Z') // Monday, 12:00 UTC

function snapshot(over: Partial<LimitsSnapshot> = {}): LimitsSnapshot {
  return {running: 0, runs_today: 0, cost_today: 0, now: NOW, ...over}
}

describe('isWithinSchedule', () => {
  it('missing or empty windows → always allowed (no time restriction)', () => {
    expect(isWithinSchedule(undefined, NOW)).toBe(true)
    expect(isWithinSchedule([], NOW)).toBe(true)
  })

  it('now inside a simple window (08:00–18:00) → true', () => {
    expect(isWithinSchedule([{start: '08:00', end: '18:00'}], NOW)).toBe(true)
  })

  it('now outside the window → false', () => {
    expect(isWithinSchedule([{start: '13:00', end: '18:00'}], NOW)).toBe(false)
  })

  it('start included, end excluded (boundary)', () => {
    const at8 = new Date('2026-07-13T08:00:00.000Z')
    const at18 = new Date('2026-07-13T18:00:00.000Z')
    expect(isWithinSchedule([{start: '08:00', end: '18:00'}], at8)).toBe(true)
    expect(isWithinSchedule([{start: '08:00', end: '18:00'}], at18)).toBe(false)
  })

  it('window crossing midnight (22:00–06:00)', () => {
    const at23 = new Date('2026-07-13T23:00:00.000Z')
    const at3 = new Date('2026-07-13T03:00:00.000Z')
    const at12 = NOW
    expect(isWithinSchedule([{start: '22:00', end: '06:00'}], at23)).toBe(true)
    expect(isWithinSchedule([{start: '22:00', end: '06:00'}], at3)).toBe(true)
    expect(isWithinSchedule([{start: '22:00', end: '06:00'}], at12)).toBe(false)
  })

  it('weekday filter (UTC): Monday included, Tuesday excluded', () => {
    // NOW is Monday (getUTCDay()===1).
    expect(isWithinSchedule([{days: [1], start: '08:00', end: '18:00'}], NOW)).toBe(true)
    expect(isWithinSchedule([{days: [2], start: '08:00', end: '18:00'}], NOW)).toBe(false)
  })

  it('multiple windows: it is enough that one contains now', () => {
    const windows = [
      {start: '00:00', end: '06:00'},
      {start: '11:00', end: '13:00'},
    ]
    expect(isWithinSchedule(windows, NOW)).toBe(true)
  })
})

describe('evaluateLimits · dispatch (new run start)', () => {
  it('empty policy → admit (no binding limit)', () => {
    const d = evaluateLimits({}, snapshot(), 'dispatch')
    expect(d.outcome).toBe('admit')
    expect(d.limit).toBeNull()
    expect(d.mode).toBe('dispatch')
  })

  it('active kill switch → deny kill-switch (no new run)', () => {
    const d = evaluateLimits({stop_dispatch: true}, snapshot(), 'dispatch')
    expect(d.outcome).toBe('deny')
    expect(d.limit).toBe('kill-switch')
  })

  it('kill switch takes precedence over everything (even with free slots and budget)', () => {
    const d = evaluateLimits({stop_dispatch: true, max_parallel: 10}, snapshot({running: 0}), 'dispatch')
    expect(d.limit).toBe('kill-switch')
  })

  it('outside the time window → deny schedule', () => {
    const d = evaluateLimits({schedule: [{start: '13:00', end: '18:00'}]}, snapshot(), 'dispatch')
    expect(d.outcome).toBe('deny')
    expect(d.limit).toBe('schedule')
  })

  it('slot pieni (running >= max_parallel) → deny max-parallel', () => {
    const d = evaluateLimits({max_parallel: 2}, snapshot({running: 2}), 'dispatch')
    expect(d.outcome).toBe('deny')
    expect(d.limit).toBe('max-parallel')
  })

  it('available slots (running < max_parallel) → does not block on the slot', () => {
    const d = evaluateLimits({max_parallel: 2}, snapshot({running: 1}), 'dispatch')
    expect(d.outcome).toBe('admit')
  })

  it('daily run budget exhausted (runs_today >= max_daily_runs) → deny daily-runs', () => {
    const d = evaluateLimits({max_daily_runs: 5}, snapshot({runs_today: 5}), 'dispatch')
    expect(d.outcome).toBe('deny')
    expect(d.limit).toBe('daily-runs')
  })

  it('daily cost budget exhausted (cost_today >= max_daily_cost) → deny daily-cost', () => {
    const d = evaluateLimits({max_daily_cost: 10}, snapshot({cost_today: 10.5}), 'dispatch')
    expect(d.outcome).toBe('deny')
    expect(d.limit).toBe('daily-cost')
  })

  it('budget configured but usage unreadable (budget_readable false) → deny usage-unavailable (fail-closed)', () => {
    const d = evaluateLimits({max_daily_runs: 5}, snapshot({budget_readable: false}), 'dispatch')
    expect(d.outcome).toBe('deny')
    expect(d.limit).toBe('usage-unavailable')
  })

  it('unreadable usage without explicit budget → deny anyway: the gate cannot attest the usage', () => {
    const d = evaluateLimits({max_parallel: 2}, snapshot({running: 0, budget_readable: false}), 'dispatch')
    expect(d.outcome).toBe('deny')
    expect(d.limit).toBe('usage-unavailable')
  })

  it('continue with unreadable usage → fail-closed checkpoint, never blind continuation', () => {
    const d = evaluateLimits({}, snapshot({budget_readable: false}), 'continue')
    expect(d.outcome).toBe('checkpoint')
    expect(d.limit).toBe('usage-unavailable')
  })

  it('all limits configured but none exceeded → admit', () => {
    const policy: LimitsPolicy = {
      scope: 'host',
      max_parallel: 3,
      max_daily_runs: 20,
      max_daily_cost: 50,
      schedule: [{start: '00:00', end: '23:59'}],
    }
    const d = evaluateLimits(policy, snapshot({running: 1, runs_today: 4, cost_today: 12}), 'dispatch')
    expect(d.outcome).toBe('admit')
    expect(d.scope).toBe('host')
  })

  it('precedence: schedule before slot/budget', () => {
    const d = evaluateLimits(
      {schedule: [{start: '13:00', end: '18:00'}], max_parallel: 1, max_daily_runs: 1},
      snapshot({running: 5, runs_today: 5}),
      'dispatch',
    )
    expect(d.limit).toBe('schedule')
  })
})

describe('evaluateLimits · continue (run already started → safe checkpoint, never a brutal kill)', () => {
  it('empty policy → admit (the run can continue)', () => {
    expect(evaluateLimits({}, snapshot(), 'continue').outcome).toBe('admit')
  })

  it('active kill switch → checkpoint kill-switch (brings the run to a safe checkpoint, DoD)', () => {
    const d = evaluateLimits({stop_dispatch: true}, snapshot(), 'continue')
    expect(d.outcome).toBe('checkpoint')
    expect(d.limit).toBe('kill-switch')
  })

  it('maximum runtime exceeded → checkpoint max-runtime', () => {
    const d = evaluateLimits({max_runtime_seconds: 3600}, snapshot({run_runtime_seconds: 4000}), 'continue')
    expect(d.outcome).toBe('checkpoint')
    expect(d.limit).toBe('max-runtime')
  })

  it('runtime limit configured but UNKNOWN runtime → checkpoint (fail-closed: does not admit forever)', () => {
    // run_runtime_seconds undefined: I cannot confirm the run is within the limit → conservative checkpoint.
    const d = evaluateLimits({max_runtime_seconds: 3600}, snapshot(), 'continue')
    expect(d.outcome).toBe('checkpoint')
    expect(d.limit).toBe('max-runtime')
  })

  it('no runtime limit + unknown runtime → admit (nothing to verify)', () => {
    expect(evaluateLimits({}, snapshot(), 'continue').outcome).toBe('admit')
  })

  it('runtime within the limit → admit', () => {
    const d = evaluateLimits({max_runtime_seconds: 3600}, snapshot({run_runtime_seconds: 1200}), 'continue')
    expect(d.outcome).toBe('admit')
  })

  it('outside window → checkpoint schedule (the running run stops cleanly)', () => {
    const d = evaluateLimits({schedule: [{start: '13:00', end: '18:00'}]}, snapshot(), 'continue')
    expect(d.outcome).toBe('checkpoint')
    expect(d.limit).toBe('schedule')
  })

  it('slot/budget do NOT apply to an already started run (high running but continue → admit)', () => {
    const d = evaluateLimits(
      {max_parallel: 1, max_daily_runs: 1, max_daily_cost: 1},
      snapshot({running: 99, runs_today: 99, cost_today: 999}),
      'continue',
    )
    expect(d.outcome).toBe('admit')
  })

  it('the continue outcome is never a kill: only admit or checkpoint (never deny)', () => {
    const killed = evaluateLimits({stop_dispatch: true}, snapshot(), 'continue')
    expect(['admit', 'checkpoint']).toContain(killed.outcome)
    expect(killed.outcome).not.toBe('deny')
  })
})

describe('failClosedDecision · policy configured but not retrievable', () => {
  it('dispatch → deny policy-unavailable (do not start)', () => {
    const d = failClosedDecision('dispatch', 'organization')
    expect(d.outcome).toBe('deny')
    expect(d.limit).toBe('policy-unavailable')
    expect(d.scope).toBe('organization')
  })

  it('continue → checkpoint policy-unavailable (brings to safe checkpoint, never kill)', () => {
    const d = failClosedDecision('continue')
    expect(d.outcome).toBe('checkpoint')
    expect(d.limit).toBe('policy-unavailable')
    expect(d.scope).toBeNull()
  })
})

describe('parseLimitsPolicy · untrusted input (from the server or the CLI)', () => {
  it('complete valid policy → parsed', () => {
    const raw = {
      scope: 'repository',
      max_parallel: 3,
      max_daily_runs: 20,
      max_daily_cost: 50,
      max_runtime_seconds: 7200,
      stop_dispatch: false,
      schedule: [{days: [1, 2, 3, 4, 5], start: '08:00', end: '20:00'}],
      max_age_seconds: 3600,
    }
    const policy = parseLimitsPolicy(raw)
    expect(policy).not.toBeNull()
    expect(policy?.max_parallel).toBe(3)
    expect(policy?.scope).toBe('repository')
  })

  it('empty policy {} → valid (no limit)', () => {
    expect(parseLimitsPolicy({})).toEqual({})
  })

  it('unknown extra fields → ignored (evolving server contract)', () => {
    const policy = parseLimitsPolicy({max_parallel: 2, future_field: 'x'})
    expect(policy).not.toBeNull()
    expect(policy?.max_parallel).toBe(2)
    expect((policy as Record<string, unknown>).future_field).toBeUndefined()
  })

  it('non-object → null', () => {
    expect(parseLimitsPolicy(null)).toBeNull()
    expect(parseLimitsPolicy('policy')).toBeNull()
    expect(parseLimitsPolicy(42)).toBeNull()
  })

  it('negative numeric value → null (nonsensical limit)', () => {
    expect(parseLimitsPolicy({max_parallel: -1})).toBeNull()
    expect(parseLimitsPolicy({max_daily_cost: -5})).toBeNull()
  })

  it('non-integer max_parallel → null', () => {
    expect(parseLimitsPolicy({max_parallel: 2.5})).toBeNull()
  })

  it('scope outside the known values → null', () => {
    expect(parseLimitsPolicy({scope: 'galaxy'})).toBeNull()
  })

  it('time window with invalid hour format → null', () => {
    expect(parseLimitsPolicy({schedule: [{start: '25:00', end: '26:00'}]})).toBeNull()
    expect(parseLimitsPolicy({schedule: [{start: 'nope', end: '10:00'}]})).toBeNull()
  })

  it('weekday outside 0..6 → null', () => {
    expect(parseLimitsPolicy({schedule: [{days: [7], start: '08:00', end: '18:00'}]})).toBeNull()
  })
})

describe('local policy cache (fail-closed)', () => {
  let dir: string
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'limits-cache-'))
  })
  afterEach(() => {
    fs.rmSync(dir, {recursive: true, force: true})
  })
  const cacheFile = (): string => path.join(dir, 'limits-policy.json')

  it('round-trip: writeCachedPolicy then readCachedPolicy → the same policy', () => {
    const policy: LimitsPolicy = {max_parallel: 4, stop_dispatch: false}
    writeCachedPolicy(policy, NOW, cacheFile())
    expect(readCachedPolicy(NOW, cacheFile())).toEqual(policy)
  })

  it('missing cache → null (fail-closed)', () => {
    expect(readCachedPolicy(NOW, cacheFile())).toBeNull()
  })

  it('corrupted cache (illegal JSON) → null', () => {
    fs.writeFileSync(cacheFile(), 'non-json')
    expect(readCachedPolicy(NOW, cacheFile())).toBeNull()
  })

  it('cache with policy not conforming to the schema → null', () => {
    fs.writeFileSync(cacheFile(), JSON.stringify({policy: {max_parallel: -1}, fetched_at: NOW.toISOString()}))
    expect(readCachedPolicy(NOW, cacheFile())).toBeNull()
  })

  it('expired cache (max_age_seconds exceeded relative to fetched_at) → null (fail-closed)', () => {
    const policy: LimitsPolicy = {max_parallel: 2, max_age_seconds: 60}
    const fetchedAt = new Date('2026-07-13T11:00:00.000Z') // 1h before NOW, max_age 60s → expired
    const cached: CachedPolicy = {policy, fetched_at: fetchedAt.toISOString()}
    fs.writeFileSync(cacheFile(), JSON.stringify(cached))
    expect(readCachedPolicy(NOW, cacheFile())).toBeNull()
  })

  it('non-expired cache (max_age_seconds still valid) → policy', () => {
    const policy: LimitsPolicy = {max_parallel: 2, max_age_seconds: 7200}
    writeCachedPolicy(policy, new Date('2026-07-13T11:00:00.000Z'), cacheFile())
    expect(readCachedPolicy(NOW, cacheFile())).toEqual(policy)
  })

  it('policy without max_age_seconds but FRESH cache (within the default) → valid', () => {
    const policy: LimitsPolicy = {max_parallel: 2}
    writeCachedPolicy(policy, NOW, cacheFile())
    expect(readCachedPolicy(NOW, cacheFile())).toEqual(policy)
  })

  it('policy without max_age_seconds but VERY OLD cache → null (expires with the default, fail-closed after a long outage)', () => {
    const policy: LimitsPolicy = {max_parallel: 2}
    writeCachedPolicy(policy, new Date('2020-01-01T00:00:00.000Z'), cacheFile())
    expect(readCachedPolicy(NOW, cacheFile())).toBeNull()
  })

  it('policy with max_age_seconds but missing/broken fetched_at → null (conservative fail-closed)', () => {
    fs.writeFileSync(cacheFile(), JSON.stringify({policy: {max_parallel: 2, max_age_seconds: 60}, fetched_at: 'non-una-data'}))
    expect(readCachedPolicy(NOW, cacheFile())).toBeNull()
  })
})

describe('usage store giornaliero (budget)', () => {
  let dir: string
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'limits-usage-'))
  })
  afterEach(() => {
    fs.rmSync(dir, {recursive: true, force: true})
  })

  it('usageDateKey → data UTC YYYY-MM-DD', () => {
    expect(usageDateKey(NOW)).toBe('2026-07-13')
  })

  it('readUsage on missing file → zeros', () => {
    expect(readUsage('2026-07-13', dir)).toEqual({date: '2026-07-13', runs: 0, cost: 0})
  })

  it('recordUsage increments and persists (additive append)', async () => {
    const u = await recordUsage('2026-07-13', {runs: 1, cost: 2.5}, dir)
    expect(u).toEqual({date: '2026-07-13', runs: 1, cost: 2.5})
    expect(readUsage('2026-07-13', dir)).toEqual({date: '2026-07-13', runs: 1, cost: 2.5})
  })

  it('the durable persistence syncs temp and directory around the rename', () => {
    const file = usagePath('2026-07-13', dir)
    const events: string[] = []
    writeDurableUsageJson(file, {date: '2026-07-13', runs: 1, cost: 0}, {
      open: ((target: fs.PathLike, flags: fs.OpenMode, mode?: fs.Mode) => {
        events.push(target === path.dirname(file) ? 'open-dir' : target === path.dirname(path.dirname(file)) ? 'open-parent' : 'open-file')
        return fs.openSync(target, flags, mode)
      }) as typeof fs.openSync,
      write: ((fd: number, data: string) => {
        events.push('write')
        fs.writeFileSync(fd, data)
      }) as typeof fs.writeFileSync,
      sync: (fd: number) => {
        events.push('sync')
        fs.fsyncSync(fd)
      },
      close: (fd: number) => {
        events.push('close')
        fs.closeSync(fd)
      },
      rename: (source: fs.PathLike, destination: fs.PathLike) => {
        events.push('rename')
        fs.renameSync(source, destination)
      },
    })
    expect(events).toEqual([
      'open-parent', 'sync', 'close',
      'open-file', 'write', 'sync', 'close', 'rename',
      'open-dir', 'sync', 'close',
    ])
    expect(fs.existsSync(`${file}.tmp`)).toBe(false)
    expect(JSON.parse(fs.readFileSync(file, 'utf8')).runs).toBe(1)
  })

  it('makes the lock directory durable before reading and mutating the canonical file', async () => {
    const events: string[] = []
    await recordUsage('2026-07-13', {runs: 1}, dir, {
      writeLock: (fd, contents) => {
        events.push('write-lock')
        fs.writeFileSync(fd, contents)
      },
      syncLock: (fd) => {
        events.push('sync-lock')
        fs.fsyncSync(fd)
      },
      syncLockDirectory: (directory) => {
        events.push('sync-lock-directory')
        const fd = fs.openSync(directory, 'r')
        try {
          fs.fsyncSync(fd)
        } finally {
          fs.closeSync(fd)
        }
      },
      beforeCommit: () => events.push('read-and-validate'),
      durableWrite: (file, data) => {
        events.push('commit-canonical')
        writeDurableUsageJson(file, data)
      },
    })

    expect(events).toEqual([
      'write-lock',
      'sync-lock',
      'sync-lock-directory',
      'read-and-validate',
      'commit-canonical',
    ])
  })

  it('failed directory fsync after rename is an uncertain, non-retryable commit', async () => {
    let syncs = 0
    const error = await recordUsage('2026-07-13', {runs: 1}, dir, {
      durableWrite: (file, data) => writeDurableUsageJson(file, data, {
        sync: (fd) => {
          syncs += 1
          if (syncs === 3) throw new Error('fsync directory fallita')
          fs.fsyncSync(fd)
        },
      }),
    }).catch((caught: unknown) => caught)

    expect(error).toBeInstanceOf(UsageRecordedLockError)
    expect(error).not.toBeInstanceOf(UsageCommitUncertainError)
    expect(error).toMatchObject({usage: {date: '2026-07-13', runs: 1, cost: 0}})
    expect(JSON.parse(fs.readFileSync(usagePath('2026-07-13', dir), 'utf8')).runs).toBe(1)
    expect(fs.existsSync(usageLockPath('2026-07-13', dir))).toBe(false)
  })

  it('pre-rename error preserves the temp and requires recovery without retry', async () => {
    const file = usagePath('2026-07-13', dir)
    const error = await recordUsage('2026-07-13', {runs: 1}, dir, {
      durableWrite: (target, data) => writeDurableUsageJson(target, data, {
        write: (() => { throw new Error('write interrotta') }) as typeof fs.writeFileSync,
      }),
    }).catch((caught: unknown) => caught)

    expect(error).toBeInstanceOf(UsageRecoveryPendingError)
    expect(fs.existsSync(`${file}.tmp`)).toBe(true)
    expect(fs.existsSync(usageLockPath('2026-07-13', dir))).toBe(false)
    expect(readUsageResult('2026-07-13', dir)).toMatchObject({
      corrupt: true,
      lock_cleanup_pending: true,
      retryable: false,
    })
  })

  it('recordUsage twice accumulates', async () => {
    await recordUsage('2026-07-13', {runs: 1, cost: 2}, dir)
    const u = await recordUsage('2026-07-13', {runs: 1, cost: 3}, dir)
    expect(u).toEqual({date: '2026-07-13', runs: 2, cost: 5})
  })

  it('different dates → different files (no lost-update between days)', async () => {
    await recordUsage('2026-07-13', {runs: 1}, dir)
    await recordUsage('2026-07-14', {runs: 1}, dir)
    expect(readUsage('2026-07-13', dir).runs).toBe(1)
    expect(readUsage('2026-07-14', dir).runs).toBe(1)
  })

  it('recordUsage without delta → numeric no-op (0)', async () => {
    const u = await recordUsage('2026-07-13', {}, dir)
    expect(u).toEqual({date: '2026-07-13', runs: 0, cost: 0})
  })

  it('rejects unrepresentable deltas and totals without altering the canonical file', async () => {
    await expect(recordUsage('2026-07-13', {runs: 0.5}, dir)).rejects.toMatchObject({code: 'C409-LIMITS-004'})
    await expect(recordUsage('2026-07-13', {runs: Number.MAX_SAFE_INTEGER + 1}, dir)).rejects.toMatchObject({
      code: 'C409-LIMITS-004',
    })

    const file = usagePath('2026-07-13', dir)
    fs.writeFileSync(file, `${JSON.stringify({date: '2026-07-13', runs: Number.MAX_SAFE_INTEGER, cost: Number.MAX_SAFE_INTEGER})}\n`)
    await expect(recordUsage('2026-07-13', {runs: 1}, dir)).rejects.toMatchObject({code: 'C409-LIMITS-004'})
    await expect(recordUsage('2026-07-13', {cost: 1}, dir)).rejects.toMatchObject({code: 'C409-LIMITS-004'})
    expect(JSON.parse(fs.readFileSync(file, 'utf8'))).toEqual({
      date: '2026-07-13', runs: Number.MAX_SAFE_INTEGER, cost: Number.MAX_SAFE_INTEGER,
    })
  })

  it('rejects a positive cost increment that IEEE-754 would absorb in the total', async () => {
    const file = usagePath('2026-07-13', dir)
    fs.writeFileSync(file, `${JSON.stringify({date: '2026-07-13', runs: 1, cost: 2 ** 52})}\n`)

    await expect(recordUsage('2026-07-13', {cost: 0.25}, dir)).rejects.toMatchObject({code: 'C409-LIMITS-004'})
    await expect(recordUsage('2026-07-13', {cost: 1.25}, dir)).rejects.toMatchObject({code: 'C409-LIMITS-004'})
    expect(JSON.parse(fs.readFileSync(file, 'utf8')).cost).toBe(2 ** 52)
  })

  it('usagePath rejects a date unsafe as a segment (never path traversal)', () => {
    expect(() => usagePath('../etc', dir)).toThrow()
  })

  it('corrupted usage file → degrades to zeros (never crash)', () => {
    fs.writeFileSync(usagePath('2026-07-13', dir), 'non-json')
    expect(readUsage('2026-07-13', dir)).toEqual({date: '2026-07-13', runs: 0, cost: 0})
  })

  it('usage file with negative/non-numeric values → coerced to zeros (granular tolerance)', () => {
    fs.writeFileSync(usagePath('2026-07-13', dir), JSON.stringify({date: '2026-07-13', runs: -5, cost: 'x'}))
    expect(readUsage('2026-07-13', dir)).toEqual({date: '2026-07-13', runs: 0, cost: 0})
  })

  it('record on corrupted JSON → quarantines the previous one, fails closed and does not create a reset to zero', async () => {
    const file = usagePath('2026-07-13', dir)
    const original = '{"runs": 9'
    fs.writeFileSync(file, original)

    await expect(recordUsage('2026-07-13', {runs: 1}, dir)).rejects.toMatchObject({
      code: 'C409-LIMITS-004',
      exitCode: 3,
    })

    expect(fs.existsSync(file)).toBe(false)
    const quarantines = fs.readdirSync(dir).filter((name) => name.startsWith('2026-07-13.json.corrupt-'))
    expect(quarantines).toHaveLength(1)
    expect(fs.readFileSync(path.join(dir, quarantines[0]), 'utf8')).toBe(original)
    expect(readUsageResult('2026-07-13', dir).corrupt).toBe(true)
    await expect(recordUsage('2026-07-13', {runs: 1}, dir)).rejects.toMatchObject({code: 'C409-LIMITS-004'})
    expect(fs.readdirSync(dir).filter((name) => name.startsWith('2026-07-13.json.corrupt-'))).toHaveLength(1)
  })

  it('record on partial state → fail-closed and quarantine, never fills the missing fields with zero', async () => {
    const file = usagePath('2026-07-13', dir)
    fs.writeFileSync(file, JSON.stringify({date: '2026-07-13', runs: 7}))

    await expect(recordUsage('2026-07-13', {cost: 1}, dir)).rejects.toMatchObject({code: 'C409-LIMITS-004'})
    expect(fs.existsSync(file)).toBe(false)
    expect(readUsageResult('2026-07-13', dir).corrupt).toBe(true)
  })

  it('concurrent records on the same day are serialized without lost-update', async () => {
    const updates = Array.from({length: 20}, () => recordUsage('2026-07-13', {runs: 1, cost: 0.5}, dir))
    await expect(Promise.all(updates)).resolves.toHaveLength(20)
    expect(readUsage('2026-07-13', dir)).toEqual({date: '2026-07-13', runs: 20, cost: 10})
  })

  it('quarantine of the previous day does not block the UTC rollover of the new day', async () => {
    fs.writeFileSync(usagePath('2026-07-13', dir), 'non-json')
    await expect(recordUsage('2026-07-13', {runs: 1}, dir)).rejects.toMatchObject({code: 'C409-LIMITS-004'})

    await expect(recordUsage('2026-07-14', {runs: 1}, dir)).resolves.toEqual({date: '2026-07-14', runs: 1, cost: 0})
    expect(readUsageResult('2026-07-13', dir).corrupt).toBe(true)
    expect(readUsageResult('2026-07-14', dir).corrupt).toBe(false)
  })

  it('explicit recovery: a manually restored valid canonical file unblocks the record and keeps the audit', async () => {
    const file = usagePath('2026-07-13', dir)
    fs.writeFileSync(file, 'non-json')
    await expect(recordUsage('2026-07-13', {runs: 1}, dir)).rejects.toMatchObject({code: 'C409-LIMITS-004'})
    const quarantines = fs.readdirSync(dir).filter((name) => name.startsWith('2026-07-13.json.corrupt-'))

    fs.writeFileSync(file, `${JSON.stringify({date: '2026-07-13', runs: 9, cost: 4})}\n`)
    await expect(recordUsage('2026-07-13', {runs: 1, cost: 1}, dir)).resolves.toEqual({
      date: '2026-07-13', runs: 10, cost: 5,
    })
    expect(fs.readdirSync(dir).filter((name) => name.startsWith('2026-07-13.json.corrupt-'))).toEqual(quarantines)
  })

  it('leftover lock from crash → gate/record stay blocked until the recovery is explicit', async () => {
    fs.mkdirSync(dir, {recursive: true})
    fs.writeFileSync(usageLockPath('2026-07-13', dir), '{"pid":999999,"started_at":"audit"}\n')

    expect(readUsageResult('2026-07-13', dir).corrupt).toBe(true)
    await expect(recordUsage('2026-07-13', {runs: 1}, dir, {lockTimeoutMs: 2, pollMs: 1})).rejects.toMatchObject({
      code: 'C409-LIMITS-004',
    })
    expect(fs.existsSync(usageLockPath('2026-07-13', dir))).toBe(true)
  })

  it('a leftover .tmp keeps gate and record fail-closed and is preserved', async () => {
    const file = usagePath('2026-07-13', dir)
    const temporary = `${file}.tmp`
    fs.writeFileSync(file, `${JSON.stringify({date: '2026-07-13', runs: 4, cost: 2})}\n`)
    fs.writeFileSync(temporary, `${JSON.stringify({date: '2026-07-13', runs: 5, cost: 2})}\n`)

    expect(readUsageResult('2026-07-13', dir).corrupt).toBe(true)
    await expect(recordUsage('2026-07-13', {runs: 1}, dir)).rejects.toMatchObject({code: 'C409-LIMITS-004'})
    expect(fs.readFileSync(temporary, 'utf8')).toContain('"runs":5')
  })

  it('the read holds the same exclusive lock as the writer while observing the canonical file', async () => {
    await recordUsage('2026-07-13', {runs: 2}, dir)
    expect(readUsageResult('2026-07-13', dir, {
      onLockedRead: () => expect(fs.existsSync(usageLockPath('2026-07-13', dir))).toBe(true),
    }).usage.runs).toBe(2)
  })

  it('failed cleanup after a read exposes pending, non-retryable recovery', () => {
    const lock = usageLockPath('2026-07-13', dir)
    const result = readUsageResult('2026-07-13', dir, {
      removeLock: () => { throw new Error('remove fallita') },
    })
    expect(result).toMatchObject({corrupt: true, lock_cleanup_pending: true, retryable: false})
    expect(fs.existsSync(lock)).toBe(true)
    expect(JSON.parse(fs.readFileSync(lock, 'utf8'))).toMatchObject({pid: process.pid})
    expect(JSON.parse(fs.readFileSync(`${lock}.recovery`, 'utf8'))).toMatchObject({recovery_pending: true})
    expect(readUsageResult('2026-07-13', dir)).toMatchObject({
      corrupt: true,
      lock_cleanup_pending: true,
      retryable: false,
    })
  })

  it('just-created lock without metadata is transient; recycled PID is leftover', () => {
    const lock = usageLockPath('2026-07-13', dir)
    fs.writeFileSync(lock, '')
    expect(readUsageResult('2026-07-13', dir)).toMatchObject({
      corrupt: true,
      lock_cleanup_pending: false,
      retryable: true,
    })

    fs.writeFileSync(lock, `${JSON.stringify({
      pid: process.pid,
      started_at: new Date().toISOString(),
      process_started_at: 'identità-di-un-processo-precedente',
    })}\n`)
    const staleTimestamp = new Date(Date.now() - 10_000)
    fs.utimesSync(lock, staleTimestamp, staleTimestamp)
    expect(readUsageResult('2026-07-13', dir)).toMatchObject({
      corrupt: true,
      lock_cleanup_pending: true,
      retryable: false,
    })
  })

  it('successful commit + failed lock close stays recorded and keeps the lock fail-closed', async () => {
    const error = await recordUsage('2026-07-13', {runs: 1}, dir, {
      closeLock: () => { throw new Error('close indeterminata') },
    }).catch((caught: unknown) => caught)
    expect(error).toBeInstanceOf(UsageRecordedLockError)
    expect(error).toMatchObject({usage: {date: '2026-07-13', runs: 1, cost: 0}})
    expect(JSON.parse(fs.readFileSync(usagePath('2026-07-13', dir), 'utf8')).runs).toBe(1)
    const lock = usageLockPath('2026-07-13', dir)
    expect(JSON.parse(fs.readFileSync(lock, 'utf8'))).toMatchObject({pid: process.pid})
    expect(JSON.parse(fs.readFileSync(`${lock}.recovery`, 'utf8'))).toMatchObject({recovery_pending: true})
  })

  it('failed initialization + lock cleanup produce a structured error and preserve the lock', async () => {
    const error = await recordUsage('2026-07-13', {runs: 1}, dir, {
      syncLock: () => { throw new Error('fsync fallita') },
      closeLock: () => { throw new Error('close indeterminata') },
    }).catch((caught: unknown) => caught)

    expect(error).toBeInstanceOf(UsageLockCleanupPendingError)
    expect(error).toMatchObject({code: 'C409-LIMITS-004', exitCode: 3})
    expect(fs.existsSync(usageLockPath('2026-07-13', dir))).toBe(true)
    expect(fs.existsSync(usagePath('2026-07-13', dir))).toBe(false)
  })
})

describe('readUsageResult (tells missing from corrupted → fail-closed on the budget)', () => {
  let dir: string
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'limits-usageres-'))
  })
  afterEach(() => {
    fs.rmSync(dir, {recursive: true, force: true})
  })

  it('missing file → corrupt false (no usage yet today, legitimate)', () => {
    expect(readUsageResult('2026-07-13', dir)).toEqual({usage: {date: '2026-07-13', runs: 0, cost: 0}, corrupt: false})
  })

  it('valid file → corrupt false with the record', async () => {
    await recordUsage('2026-07-13', {runs: 2, cost: 1.5}, dir)
    expect(readUsageResult('2026-07-13', dir)).toEqual({usage: {date: '2026-07-13', runs: 2, cost: 1.5}, corrupt: false})
  })

  it('illegal JSON file → corrupt true (present but unreadable)', () => {
    fs.writeFileSync(usagePath('2026-07-13', dir), 'non-json')
    expect(readUsageResult('2026-07-13', dir).corrupt).toBe(true)
  })

  it('file with out-of-range values (negative/non-numeric) → corrupt true (malformed)', () => {
    fs.writeFileSync(usagePath('2026-07-13', dir), JSON.stringify({runs: -1, cost: 'x'}))
    expect(readUsageResult('2026-07-13', dir).corrupt).toBe(true)
  })

  it('non-object file (array) → corrupt true', () => {
    fs.writeFileSync(usagePath('2026-07-13', dir), JSON.stringify([1, 2, 3]))
    expect(readUsageResult('2026-07-13', dir).corrupt).toBe(true)
  })

  it('partial file or with inconsistent date → corrupt true', () => {
    fs.writeFileSync(usagePath('2026-07-13', dir), JSON.stringify({date: '2026-07-13', runs: 1}))
    expect(readUsageResult('2026-07-13', dir).corrupt).toBe(true)
    fs.writeFileSync(usagePath('2026-07-13', dir), JSON.stringify({date: '2026-07-12', runs: 1, cost: 0}))
    expect(readUsageResult('2026-07-13', dir).corrupt).toBe(true)
  })
})

describe('countRunningLeases (slot occupati)', () => {
  function lease(over: Partial<LeaseRecord>): LeaseRecord {
    return {
      ticket: 'CYAU-1',
      host_id: 'h1',
      run_id: 'r1',
      agent: 'A',
      ttl_seconds: 3600,
      expires_at: '2026-07-13T13:00:00.000Z',
      acquired_at: '2026-07-13T11:00:00.000Z',
      updated_at: '2026-07-13T11:30:00.000Z',
      ...over,
    }
  }

  it('counts the live leases of this host, excludes the expired ones', () => {
    const leases = [
      lease({ticket: 'A', expires_at: '2026-07-13T13:00:00.000Z'}), // futura → viva
      lease({ticket: 'B', expires_at: '2026-07-13T11:00:00.000Z'}), // passata → scaduta
      lease({ticket: 'C', expires_at: null}), // scadenza sconosciuta → conservativo, conta
    ]
    expect(countRunningLeases(leases, 'h1', NOW)).toBe(2)
  })

  it('excludes the leases of another host identity', () => {
    const leases = [lease({host_id: 'h1'}), lease({ticket: 'X', host_id: 'h2'})]
    expect(countRunningLeases(leases, 'h1', NOW)).toBe(1)
  })

  it('null hostId → counts all live leases (no identity filter)', () => {
    const leases = [lease({host_id: 'h1'}), lease({ticket: 'X', host_id: 'h2'})]
    expect(countRunningLeases(leases, null, NOW)).toBe(2)
  })
})

describe('resolveLimitsPolicy (server → cache → none, updates the cache)', () => {
  let dir: string
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'limits-resolve-'))
  })
  afterEach(() => {
    fs.rmSync(dir, {recursive: true, force: true})
  })
  const cacheFile = (): string => path.join(dir, 'limits-policy.json')

  it('server answers with a valid policy → used and written to cache', async () => {
    const fetcher = {fetch: async () => ({outcome: 'success', data: {max_parallel: 5}} as const)}
    const res = await resolveLimitsPolicy(fetcher, NOW, cacheFile())
    expect(res.source).toBe('server')
    expect(res.policy).toEqual({max_parallel: 5})
    // the cache was updated → a later read finds it again
    expect(readCachedPolicy(NOW, cacheFile())).toEqual({max_parallel: 5})
  })

  it('unreachable server but cache present → uses the cache', async () => {
    writeCachedPolicy({max_parallel: 3}, NOW, cacheFile())
    const fetcher = {fetch: async () => ({outcome: 'unavailable'} as const)}
    const res = await resolveLimitsPolicy(fetcher, NOW, cacheFile())
    expect(res.source).toBe('cache')
    expect(res.policy).toEqual({max_parallel: 3})
  })

  it('auth denied ignores even a fresh cache and fails closed', async () => {
    writeCachedPolicy({max_parallel: 3}, NOW, cacheFile())
    const fetcher = {fetch: async () => ({outcome: 'auth-denied'} as const)}
    const res = await resolveLimitsPolicy(fetcher, NOW, cacheFile())
    expect(res.source).toBe('auth-denied')
    expect(res.policy).toBeNull()
  })

  it('server returns an invalid policy → discards it and falls back to the cache', async () => {
    writeCachedPolicy({max_parallel: 3}, NOW, cacheFile())
    const fetcher = {fetch: async () => ({outcome: 'success', data: {max_parallel: -1}} as const)}
    const res = await resolveLimitsPolicy(fetcher, NOW, cacheFile())
    expect(res.source).toBe('cache')
  })

  it('neither server nor cache → none (fail-closed downstream)', async () => {
    const fetcher = {fetch: async () => ({outcome: 'unavailable'} as const)}
    const res = await resolveLimitsPolicy(fetcher, NOW, cacheFile())
    expect(res.source).toBe('none')
    expect(res.policy).toBeNull()
  })
})

describe('defaultPolicyFetcher', () => {
  it('without configured sync/token → unavailable (not configured)', async () => {
    const fetcher = defaultPolicyFetcher({})
    expect(await fetcher.fetch()).toEqual({outcome: 'unavailable'})
  })

  it('with only the org token it does not contact the server and does not fall back', async () => {
    const fakeFetch = vi.fn()
    const fetcher = defaultPolicyFetcher({sync: {orgToken: 'cyi_a_org'}}, fakeFetch as unknown as typeof globalThis.fetch)
    expect(await fetcher.fetch()).toEqual({outcome: 'unavailable'})
    expect(fakeFetch).not.toHaveBeenCalled()
  })

  it('calls the host-scoped endpoint with the host token bearer and returns data', async () => {
    let calledUrl = ''
    let calledAuth = ''
    const fakeFetch = (async (url: string, init: {headers: Record<string, string>}) => {
      calledUrl = url
      calledAuth = init.headers.Authorization
      return {ok: true, json: async () => ({data: {max_parallel: 7}})}
    }) as unknown as typeof globalThis.fetch
    const fetcher = defaultPolicyFetcher(
      {sync: {}, host: {id: 'h1', token: 'cyi_ah_tok'}},
      fakeFetch,
    )
    const raw = await fetcher.fetch()
    expect(raw).toEqual({outcome: 'success', data: {max_parallel: 7}})
    expect(calledUrl).toContain(DEFAULT_API_LIMITS_PATH)
    expect(calledAuth).toBe('Bearer cyi_ah_tok')
  })

  it('HTTP 5xx → unavailable', async () => {
    const fakeFetch = (async () => ({ok: false, status: 500, json: async () => ({})})) as unknown as typeof globalThis.fetch
    const fetcher = defaultPolicyFetcher({sync: {orgToken: 'cyi_a_org'}, host: {id: 'h1', token: 'cyi_ah_tok'}}, fakeFetch)
    expect(await fetcher.fetch()).toEqual({outcome: 'unavailable'})
  })

  it('network error → unavailable (best-effort, then cache/fail-closed)', async () => {
    const fakeFetch = (async () => {
      throw new Error('rete giù')
    }) as unknown as typeof globalThis.fetch
    const fetcher = defaultPolicyFetcher({sync: {orgToken: 'cyi_a_org'}, host: {id: 'h1', token: 'cyi_ah_tok'}}, fakeFetch)
    expect(await fetcher.fetch()).toEqual({outcome: 'unavailable'})
  })

  it.each([401, 403])('HTTP %s → auth-denied, without retry or token fallback', async (status) => {
    const fakeFetch = vi.fn(async () => ({ok: false, status}) as Response)
    const fetcher = defaultPolicyFetcher({sync: {}, host: {id: 'h1', token: 'cyi_ah_tok'}}, fakeFetch as unknown as typeof globalThis.fetch)
    expect(await fetcher.fetch()).toEqual({outcome: 'auth-denied'})
    expect(fakeFetch).toHaveBeenCalledTimes(1)
    expect((fakeFetch.mock.calls[0][1] as RequestInit).headers).toMatchObject({Authorization: 'Bearer cyi_ah_tok'})
  })
})
