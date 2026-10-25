import {describe, expect, it} from 'vitest'
import {nextFire, parseSchedule} from '../src/lib/schedule'
import {AutomatorError} from '../src/errors/error-codes'

describe('parseSchedule — interval', () => {
  it('interpreta "every 15m" come 900000ms', () => {
    expect(parseSchedule('every 15m')).toEqual({kind: 'interval', ms: 900_000})
  })

  it('interpreta "every 30s" come 30000ms', () => {
    expect(parseSchedule('every 30s')).toEqual({kind: 'interval', ms: 30_000})
  })

  it('interpreta "every 2h" come 7200000ms', () => {
    expect(parseSchedule('every 2h')).toEqual({kind: 'interval', ms: 7_200_000})
  })

  it('interprets the singular forms "every minute/hour/day"', () => {
    expect(parseSchedule('every minute')).toEqual({kind: 'interval', ms: 60_000})
    expect(parseSchedule('every hour')).toEqual({kind: 'interval', ms: 3_600_000})
    expect(parseSchedule('every day')).toEqual({kind: 'interval', ms: 86_400_000})
  })

  it('accepts long unit forms ("every 5 minutes")', () => {
    expect(parseSchedule('every 5 minutes')).toEqual({kind: 'interval', ms: 300_000})
  })
})

describe('parseSchedule — cron e shorthand calendario', () => {
  it('accepts a 5-field cron', () => {
    expect(parseSchedule('0 8 * * *')).toEqual({kind: 'cron', expr: '0 8 * * *'})
  })

  it('traduce "every day at 8am" in "0 8 * * *"', () => {
    expect(parseSchedule('every day at 8am')).toEqual({kind: 'cron', expr: '0 8 * * *'})
  })

  it('traduce "every day at 14:30" in "30 14 * * *"', () => {
    expect(parseSchedule('every day at 14:30')).toEqual({kind: 'cron', expr: '30 14 * * *'})
  })

  it('traduce "every monday at 8am" in "0 8 * * 1"', () => {
    expect(parseSchedule('every monday at 8am')).toEqual({kind: 'cron', expr: '0 8 * * 1'})
  })

  it('traduce "every sunday at 9pm" in "0 21 * * 0"', () => {
    expect(parseSchedule('every sunday at 9pm')).toEqual({kind: 'cron', expr: '0 21 * * 0'})
  })

  it('traduce "every hour at minute 15" in "15 * * * *"', () => {
    expect(parseSchedule('every hour at minute 15')).toEqual({kind: 'cron', expr: '15 * * * *'})
  })

  it('handles noon/midnight (12am → 0, 12pm → 12)', () => {
    expect(parseSchedule('every day at 12am')).toEqual({kind: 'cron', expr: '0 0 * * *'})
    expect(parseSchedule('every day at 12pm')).toEqual({kind: 'cron', expr: '0 12 * * *'})
  })
})

describe('parseSchedule — invalidi lanciano C400-SCHEDULE-001', () => {
  const cases = [
    'every banana',
    'every 0m',
    'every day at 25:00',
    'every day at 8:99',
    'every hour at minute 99',
    'every 5 parsecs',
    '* * * *',
    'domani',
    '',
  ]

  for (const raw of cases) {
    it(`rejects "${raw}"`, () => {
      expect(() => parseSchedule(raw)).toThrow(AutomatorError)
      try {
        parseSchedule(raw)
      } catch (error) {
        expect((error as AutomatorError).code).toBe('C400-SCHEDULE-001')
      }
    })
  }
})

describe('nextFire', () => {
  it('cron: first fire after `from`', () => {
    const parsed = parseSchedule('0 8 * * *')
    const from = new Date('2026-07-07T09:00:00.000Z')
    expect(nextFire(parsed, from, null)?.toISOString()).toBe('2026-07-08T08:00:00.000Z')
  })

  it('interval without anchor → `from` (first run: immediately)', () => {
    const parsed = parseSchedule('every 15m')
    const from = new Date('2026-07-07T09:00:00.000Z')
    expect(nextFire(parsed, from, null)?.toISOString()).toBe('2026-07-07T09:00:00.000Z')
  })

  it('interval with anchor → first multiple after `from`', () => {
    const parsed = parseSchedule('every 15m')
    const anchor = new Date('2026-07-07T09:00:00.000Z')
    const from = new Date('2026-07-07T09:00:00.000Z')
    expect(nextFire(parsed, from, anchor)?.toISOString()).toBe('2026-07-07T09:15:00.000Z')
  })

  it('interval with future anchor → the anchor itself', () => {
    const parsed = parseSchedule('every 15m')
    const anchor = new Date('2026-07-07T10:00:00.000Z')
    const from = new Date('2026-07-07T09:00:00.000Z')
    expect(nextFire(parsed, from, anchor)?.toISOString()).toBe('2026-07-07T10:00:00.000Z')
  })
})
