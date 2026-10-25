import {Cron} from 'croner'
import {AutomatorError, ErrorCodes} from '../errors/error-codes'

// Schedule parsing. Two forms:
//  - interval: "every 15m", "every 30s", "every minute" → fixed period in ms
//  - cron: "0 8 * * *" (5 fields) or calendar shorthand ("every day at 8am", "every monday at 8am")
// The "which action is due" logic lives in scheduler.ts; here only parse + previous/next fire.

export type Parsed = {kind: 'interval'; ms: number} | {kind: 'cron'; expr: string}

// Cron schedules are interpreted in UTC (predictable on servers, deterministic in tests).
// A per-playbook configurable timezone is a possible follow-up.
const CRON_TZ = 'UTC'

const UNIT_MS: Record<string, number> = {
  s: 1000,
  sec: 1000,
  secs: 1000,
  second: 1000,
  seconds: 1000,
  m: 60_000,
  min: 60_000,
  mins: 60_000,
  minute: 60_000,
  minutes: 60_000,
  h: 3_600_000,
  hr: 3_600_000,
  hrs: 3_600_000,
  hour: 3_600_000,
  hours: 3_600_000,
  d: 86_400_000,
  day: 86_400_000,
  days: 86_400_000,
}

const SINGLE_MS: Record<string, number> = {second: 1000, minute: 60_000, hour: 3_600_000, day: 86_400_000}

const WEEKDAY: Record<string, number> = {
  sunday: 0,
  monday: 1,
  tuesday: 2,
  wednesday: 3,
  thursday: 4,
  friday: 5,
  saturday: 6,
}

const CRON_TOKEN = /^[\d*/,-]+$/

function invalid(raw: string): never {
  throw new AutomatorError(ErrorCodes.Schedule.invalid, `Schedule non valido: "${raw}"`)
}

/** "8am" | "8pm" | "12am" | "8:30am" | "08:00" | "14:30" | "8" → {h, m} in 24h, or null. */
function parseTime(text: string): {h: number; m: number} | null {
  const match = /^(\d{1,2})(?::(\d{2}))?\s*(am|pm)?$/.exec(text.trim())
  if (!match) return null
  let h = Number(match[1])
  const m = match[2] === undefined ? 0 : Number(match[2])
  const meridiem = match[3]
  if (m > 59) return null
  if (meridiem) {
    if (h < 1 || h > 12) return null
    if (meridiem === 'am') h = h === 12 ? 0 : h
    else h = h === 12 ? 12 : h + 12
  } else if (h > 23) return null

  return {h, m}
}

function toCron(raw: string, expr: string): Parsed {
  try {
    // Building a Cron validates the syntax; croner throws on a malformed expression.
    // eslint-disable-next-line no-new
    new Cron(expr, {timezone: CRON_TZ})
  } catch {
    invalid(raw)
  }

  return {kind: 'cron', expr}
}

export function parseSchedule(raw: string): Parsed {
  const text = raw.trim().toLowerCase().replace(/\s+/g, ' ')

  // Cron with 5 numeric fields.
  const fields = text.split(' ')
  if (fields.length === 5 && fields.every((field) => CRON_TOKEN.test(field))) {
    return toCron(raw, text)
  }

  // every <N><unit>
  const everyN = /^every (\d+) ?([a-z]+)$/.exec(text)
  if (everyN) {
    const n = Number(everyN[1])
    const unit = UNIT_MS[everyN[2]]
    if (n <= 0 || unit === undefined) invalid(raw)
    return {kind: 'interval', ms: n * unit}
  }

  // every <single> (second/minute/hour/day)
  const everySingle = /^every (second|minute|hour|day)$/.exec(text)
  if (everySingle) {
    return {kind: 'interval', ms: SINGLE_MS[everySingle[1]]}
  }

  // every hour at minute M
  const everyHourMin = /^every hour at minute (\d{1,2})$/.exec(text)
  if (everyHourMin) {
    const min = Number(everyHourMin[1])
    if (min > 59) invalid(raw)
    return toCron(raw, `${min} * * * *`)
  }

  // every day at <time>
  const everyDay = /^every day at (.+)$/.exec(text)
  if (everyDay) {
    const time = parseTime(everyDay[1])
    if (!time) invalid(raw)
    return toCron(raw, `${time.m} ${time.h} * * *`)
  }

  // every <weekday> at <time>
  const everyDow = /^every (\w+) at (.+)$/.exec(text)
  if (everyDow && WEEKDAY[everyDow[1]] !== undefined) {
    const time = parseTime(everyDow[2])
    if (!time) invalid(raw)
    return toCron(raw, `${time.m} ${time.h} * * ${WEEKDAY[everyDow[1]]}`)
  }

  return invalid(raw)
}

/**
 * Next fire strictly after `from`.
 * - cron: `croner.nextRun(from)` (croner.previousRun() does not accept an injected instant → we use
 *   only nextRun, deterministic; computeDue compares nextRun(last_run) ≤ now).
 * - interval: without `anchor` → `from` (first run: immediately); with anchor → first multiple > from.
 */
export function nextFire(parsed: Parsed, from: Date, anchor: Date | null): Date | null {
  if (parsed.kind === 'cron') {
    return new Cron(parsed.expr, {timezone: CRON_TZ}).nextRun(from) ?? null
  }
  if (!anchor) return new Date(from.getTime())
  if (anchor.getTime() > from.getTime()) return new Date(anchor.getTime())
  const k = Math.floor((from.getTime() - anchor.getTime()) / parsed.ms) + 1
  return new Date(anchor.getTime() + k * parsed.ms)
}
