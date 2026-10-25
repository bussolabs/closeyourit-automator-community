import {describe, expect, it} from 'vitest'
import {computeDue, selectDue} from '../src/lib/scheduler'
import {parseSchedule} from '../src/lib/schedule'
import {PlaybookSchema} from '../src/lib/schema'
import {type ActionState, type State} from '../src/lib/state'

function stateAt(iso: string): ActionState {
  return {last_run: iso, last_status: 'success', last_duration_ms: 10, last_exit_code: 0, last_error_code: null, last_result: null}
}

describe('computeDue — primo run (no state)', () => {
  const parsed = parseSchedule('every 15m')
  const now = new Date('2026-07-07T09:00:00.000Z')

  it('catch_up=false → seeds the baseline, does not run', () => {
    expect(computeDue(parsed, undefined, now, false)).toMatchObject({due: false, seed: true})
  })

  it('catch_up=true → runs immediately (bootstrap)', () => {
    expect(computeDue(parsed, undefined, now, true)).toMatchObject({due: true, seed: false})
  })
})

describe('computeDue — interval, confini X-1 / X / X+1', () => {
  const parsed = parseSchedule('every 15m') // 900000ms
  const last = '2026-07-07T09:00:00.000Z'

  it('at T+ms-1ms it is not due', () => {
    const now = new Date('2026-07-07T09:14:59.999Z')
    expect(computeDue(parsed, stateAt(last), now, false).due).toBe(false)
  })

  it('exactly at T+ms it is due', () => {
    const now = new Date('2026-07-07T09:15:00.000Z')
    expect(computeDue(parsed, stateAt(last), now, false).due).toBe(true)
  })

  it('at T+ms+1ms it is due', () => {
    const now = new Date('2026-07-07T09:15:00.001Z')
    expect(computeDue(parsed, stateAt(last), now, false).due).toBe(true)
  })
})

describe('computeDue — cron, boundary on the fire', () => {
  const parsed = parseSchedule('0 8 * * *') // every day 08:00 UTC
  const last = '2026-07-07T07:00:00.000Z'

  it('1s before the fire it is not due', () => {
    expect(computeDue(parsed, stateAt(last), new Date('2026-07-07T07:59:59.000Z'), false).due).toBe(false)
  })

  it('at the fire it is due', () => {
    expect(computeDue(parsed, stateAt(last), new Date('2026-07-07T08:00:00.000Z'), false).due).toBe(true)
  })

  it('1s after the fire it is due', () => {
    expect(computeDue(parsed, stateAt(last), new Date('2026-07-07T08:00:01.000Z'), false).due).toBe(true)
  })

  it('already run past today fire → not due', () => {
    expect(computeDue(parsed, stateAt('2026-07-07T08:30:00.000Z'), new Date('2026-07-07T09:00:00.000Z'), false).due).toBe(false)
  })

  it('many missed fires → coalesce into ONE single run (due)', () => {
    // last_run 6 days ago, daily schedule → a single due run, not six
    const decision = computeDue(parsed, stateAt('2026-07-01T07:00:00.000Z'), new Date('2026-07-07T09:00:00.000Z'), false)
    expect(decision.due).toBe(true)
  })
})

describe('selectDue', () => {
  const playbook = PlaybookSchema.parse({
    version: 1,
    actions: {
      fast: {schedule: 'every 1m', type: 'shell', run: 'echo a'},
      slow: {schedule: 'every 1h', type: 'shell', run: 'echo b'},
      off: {schedule: 'every 1m', type: 'shell', run: 'echo c', enabled: false},
      broken: {schedule: 'domani mattina', type: 'shell', run: 'echo d'},
    },
  })
  const now = new Date('2026-07-07T09:30:00.000Z')

  it('skips the disabled actions', () => {
    const state: State = {version: 1, actions: {}}
    const result = selectDue(playbook, state, now)
    const seededNames = result.seed.map((entry) => entry.name)
    expect(seededNames).not.toContain('off')
  })

  it('collects invalid schedules in errors (excluded, no crash)', () => {
    const result = selectDue(playbook, {version: 1, actions: {}}, now)
    expect(result.errors.map((e) => e.name)).toContain('broken')
  })

  it('first run: seeds all valid enabled ones, none due', () => {
    const result = selectDue(playbook, {version: 1, actions: {}}, now)
    expect(result.due).toHaveLength(0)
    expect(result.seed.map((entry) => entry.name).sort()).toEqual(['fast', 'slow'])
  })

  it('with an old last_run, "fast" becomes due', () => {
    const state: State = {version: 1, actions: {fast: stateAt('2026-07-07T09:00:00.000Z')}}
    const result = selectDue(playbook, state, now)
    expect(result.due.map((entry) => entry.name)).toContain('fast')
  })
})
