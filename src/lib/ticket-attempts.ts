import * as fs from 'node:fs'
import * as path from 'node:path'
import {randomUUID} from 'node:crypto'
import {ticketAttemptsDir} from './paths'

// Attempt and spend counter PER TICKET (CYAU-155). The claim, the lease and the daily usage know everything about
// ONE attempt and nothing about the SERIES: a ticket that always fails the same way was put back in the queue
// forever (real case CYRA-298: 31 attempts, ~5 dollars, nobody had noticed). Here lives the only memory
// that crosses the ticks: how many consecutive attempts the current PHASE received and how much the ticket cost.
//
// One file per ticket under `ticket-attempts/<project>__<code>.json` (same pattern as `leases/`/`runs/`):
// different tickets do not contend for the same file, so no lost update between concurrent runs.
//
// ⚠️ KNOWN BOUNDARY: the count is HOST-scoped, like all the state in this directory. With several hosts on the same
// project, each grants its own share of attempts to the same ticket (N hosts → up to N × threshold). A
// truly per-ticket threshold requires a SERVER-side counter, next to the lease and the attempts: it belongs to the
// queue contract, not to this machine. Until it exists, this cuts the real case — a host that
// resumes the same ticket dozens of times — instead of leaving it unlimited.
//
// FAIL-CLOSED like the rest of the durable state: an unreadable record does NOT become "zero attempts" — the reader
// gets `corrupt` and the upstream gate blocks, because restarting from zero is exactly the fault to avoid.

/** Consecutive attempts allowed on the SAME phase before stopping and reporting. */
export const DEFAULT_MAX_TICKET_ATTEMPTS = 5

/** Operational override of the threshold (machine env, not a secret). */
export const MAX_TICKET_ATTEMPTS_ENV = 'AUTOMATOR_MAX_TICKET_ATTEMPTS'

/**
 * A ticket's durable count. `attempts`/`cost` apply to the current PHASE and restart when the flow
 * advances (a new phase is real progress, not an idle round); `total_attempts`/`total_cost` never restart
 * — they are what the ticket cost overall, the data the operator must be able to see.
 */
export interface TicketAttemptRecord {
  project: string
  ticket: string
  phase: string | null
  attempts: number
  cost: number
  total_attempts: number
  total_cost: number
  first_at: string
  updated_at: string
}

/** Read outcome: `corrupt` distinguishes "no attempt yet" from "I do not know how many" (which blocks). */
export interface TicketAttemptsRead {
  record: TicketAttemptRecord | null
  corrupt: boolean
}

/** Threshold verdict: `exhausted` = enough, the ticket must be reported instead of being put back in the queue. */
export interface TicketAttemptsVerdict {
  outcome: 'admit' | 'exhausted'
  attempts: number
  limit: number
}

/**
 * Effective threshold from the environment. A missing, non-integer, zero or negative value falls back to the default: never
 * "no limit" because of a badly written variable — it is the protection this module exists to give.
 */
export function maxTicketAttempts(env: NodeJS.ProcessEnv = process.env): number {
  const raw = env[MAX_TICKET_ATTEMPTS_ENV]
  if (typeof raw !== 'string' || raw.trim() === '') return DEFAULT_MAX_TICKET_ATTEMPTS
  const parsed = Number(raw.trim())
  return Number.isInteger(parsed) && parsed >= 1 ? parsed : DEFAULT_MAX_TICKET_ATTEMPTS
}

/** Safe file name segment: only alphanumerics, `_` and `-` (no dot → no `..`, no separator). */
function safeSegment(value: string): string {
  return value.trim().replace(/[^A-Za-z0-9_-]/g, '_')
}

/** Path of a ticket's counter: `<dir>/<project>__<code>.json`. Empty identity → error (never a shared file). */
export function ticketAttemptsPath(project: string, ticket: string, dir: string = ticketAttemptsDir()): string {
  const safeProject = safeSegment(project)
  const safeTicket = safeSegment(ticket)
  if (safeProject === '' || safeTicket === '') {
    throw new Error(`identità ticket non usabile come nome file: "${project}"/"${ticket}"`)
  }
  return path.join(dir, `${safeProject}__${safeTicket}.json`)
}

/**
 * Atomic record write: temp + rename, without an inter-process lock. The general state lock is for
 * whoever can have TWO writers on the same file; here it cannot happen — a ticket's counter is touched
 * only by whoever holds its lease (only one, guaranteed by the server) and the local tick is already serialized by the
 * daemon lock. A rename is atomic on the same filesystem: a reader sees the old record or the new one, never
 * half a file, which is the only guarantee the gate needs.
 */
function writeRecord(file: string, record: TicketAttemptRecord): void {
  fs.mkdirSync(path.dirname(file), {recursive: true})
  const temporary = `${file}.tmp-${process.pid}-${randomUUID()}`
  try {
    fs.writeFileSync(temporary, `${JSON.stringify(record, null, 2)}\n`, {mode: 0o600})
    fs.renameSync(temporary, file)
  } catch (error) {
    try { fs.rmSync(temporary, {force: true}) } catch { /* the orphan temp is not the count: it stays ignorable */ }
    throw error
  }
}

function finiteNonNegative(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= Number.MAX_SAFE_INTEGER
}

function safeCount(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0
}

/** Coerce of a record read from disk: a single field outside the contract invalidates the whole record (never partial data). */
function coerceRecord(raw: unknown, project: string, ticket: string): TicketAttemptRecord | null {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return null
  const value = raw as Record<string, unknown>
  const phase = value.phase
  if (typeof value.project !== 'string' || typeof value.ticket !== 'string') return null
  // The identity must be the requested one: a file about another ticket is not our count.
  if (value.project !== project || value.ticket.toLowerCase() !== ticket.toLowerCase()) return null
  if (phase !== null && typeof phase !== 'string') return null
  if (!safeCount(value.attempts) || !safeCount(value.total_attempts)) return null
  if (!finiteNonNegative(value.cost) || !finiteNonNegative(value.total_cost)) return null
  if (typeof value.first_at !== 'string' || typeof value.updated_at !== 'string') return null
  return {
    project: value.project,
    ticket: value.ticket,
    phase,
    attempts: value.attempts,
    cost: value.cost,
    total_attempts: value.total_attempts,
    total_cost: value.total_cost,
    first_at: value.first_at,
    updated_at: value.updated_at,
  }
}

/** Reads a ticket's count. Missing file = no attempt (legitimate); unreadable = `corrupt` (blocks). */
export function readTicketAttempts(
  project: string,
  ticket: string,
  dir: string = ticketAttemptsDir(),
): TicketAttemptsRead {
  const file = ticketAttemptsPath(project, ticket, dir)
  let raw: string
  try {
    raw = fs.readFileSync(file, 'utf8')
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return {record: null, corrupt: false}
    return {record: null, corrupt: true}
  }

  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    return {record: null, corrupt: true}
  }
  const record = coerceRecord(parsed, project, ticket)
  return record ? {record, corrupt: false} : {record: null, corrupt: true}
}

/**
 * Threshold verdict on the current phase's count. An invalid threshold falls back to the default instead of
 * allowing forever: the caller cannot disable the limit by passing a wrong number.
 */
export function evaluateTicketAttempts(
  record: TicketAttemptRecord | null,
  limit: number,
  phase: string | null,
): TicketAttemptsVerdict {
  const effective = Number.isInteger(limit) && limit >= 1 ? limit : DEFAULT_MAX_TICKET_ATTEMPTS
  // The count belongs to the PHASE it accumulated in: claiming a different phase means the flow
  // advanced — real progress — and the ticket cannot stay stuck because of the idle rounds of a finished phase.
  // `recordTicketAttempt` makes the same comparison when it resets: if it diverged here, a ticket that advanced phase
  // would stay blocked by a counter the first claim would have brought back to one anyway.
  const attempts = record !== null && record.phase === phase ? record.attempts : 0
  return {outcome: attempts >= effective ? 'exhausted' : 'admit', attempts, limit: effective}
}

export interface RecordTicketAttemptInput {
  project: string
  ticket: string
  /** Claimed phase; `null`/missing for the playbook path, which has no flow phases. */
  phase?: string | null
  now?: Date
}

/**
 * Records an attempt JUST claimed, before the session starts: an attempt that then crashes must count
 * anyway, otherwise exactly the loop we want to break (fails → restarts) would stay invisible.
 * A phase different from the previous one resets the consecutive count — the flow really advanced.
 */
export function recordTicketAttempt(
  input: RecordTicketAttemptInput,
  dir: string = ticketAttemptsDir(),
): TicketAttemptRecord {
  const file = ticketAttemptsPath(input.project, input.ticket, dir)
  const current = readTicketAttempts(input.project, input.ticket, dir)
  if (current.corrupt) {
    throw new Error(`contatore tentativi del ticket ${input.ticket} non leggibile: nessun conteggio attendibile`)
  }
  const at = (input.now ?? new Date()).toISOString()
  const phase = input.phase ?? null
  const previous = current.record
  const samePhase = previous !== null && previous.phase === phase
  const record: TicketAttemptRecord = {
    project: input.project,
    ticket: input.ticket,
    phase,
    attempts: samePhase ? previous.attempts + 1 : 1,
    cost: samePhase ? previous.cost : 0,
    total_attempts: (previous?.total_attempts ?? 0) + 1,
    total_cost: previous?.total_cost ?? 0,
    first_at: previous?.first_at ?? at,
    updated_at: at,
  }
  writeRecord(file, record)
  return record
}

export interface AddTicketAttemptCostInput {
  project: string
  ticket: string
  cost: number
  now?: Date
}

/**
 * Accumulates a session's REAL spend on the ticket (DoD "the cost spent per ticket is visible"). Without an
 * already recorded attempt there is nothing to update: a cost without a run would be invented data.
 * A non-representable cost is ignored — better an underestimated spend than a corrupt counter.
 */
export function addTicketAttemptCost(
  input: AddTicketAttemptCostInput,
  dir: string = ticketAttemptsDir(),
): TicketAttemptRecord | null {
  if (!finiteNonNegative(input.cost) || input.cost === 0) return null
  const current = readTicketAttempts(input.project, input.ticket, dir)
  if (current.corrupt || !current.record) return null
  const cost = current.record.cost + input.cost
  const totalCost = current.record.total_cost + input.cost
  if (!finiteNonNegative(cost) || !finiteNonNegative(totalCost)) return null
  const record: TicketAttemptRecord = {
    ...current.record,
    cost,
    total_cost: totalCost,
    updated_at: (input.now ?? new Date()).toISOString(),
  }
  writeRecord(ticketAttemptsPath(input.project, input.ticket, dir), record)
  return record
}

/**
 * CYAU-249 — true when a person restarted the server's attempt budget (`budget_from`) AFTER our last recorded
 * attempt. Anything unreadable is false: the gate stays as strict as before.
 */
export function restartedByPerson(record: TicketAttemptRecord | null | undefined, budgetFrom: unknown): boolean {
  if (!record || record.attempts === 0 || typeof budgetFrom !== 'string') return false
  const from = Date.parse(budgetFrom)
  const last = Date.parse(record.updated_at)
  return Number.isFinite(from) && Number.isFinite(last) && from > last
}

/**
 * Resets a ticket's attempts KEEPING the totals: used when the ticket turns out concluded, so a reopened
 * code restarts clean on the threshold. The file is deliberately NOT deleted — it would be exactly the spend of the
 * just finished ticket that disappears from `automator activity`, i.e. the data we wanted to make visible.
 * Idempotent: no record (or unreadable record) → `null`, no invented write.
 */
export function resetTicketAttempts(
  project: string,
  ticket: string,
  dir: string = ticketAttemptsDir(),
  now: Date = new Date(),
): TicketAttemptRecord | null {
  const current = readTicketAttempts(project, ticket, dir)
  if (current.corrupt || !current.record || current.record.attempts === 0) return current.record
  const record: TicketAttemptRecord = {
    ...current.record,
    phase: null,
    attempts: 0,
    cost: 0,
    updated_at: now.toISOString(),
  }
  try {
    writeRecord(ticketAttemptsPath(project, ticket, dir), record)
  } catch {
    // The leftover counter is conservative (at most it stops an already concluded ticket earlier): not worth a failure.
    return current.record
  }
  return record
}

/** All known counts, sorted by ticket: the "how much each ticket cost" view of the read-only commands. */
export function listTicketAttempts(dir: string = ticketAttemptsDir()): TicketAttemptRecord[] {
  let entries: string[]
  try {
    entries = fs.readdirSync(dir)
  } catch {
    return []
  }
  const records: TicketAttemptRecord[] = []
  for (const entry of entries) {
    if (!entry.endsWith('.json')) continue
    let parsed: unknown
    try {
      parsed = JSON.parse(fs.readFileSync(path.join(dir, entry), 'utf8'))
    } catch {
      continue // an unreadable file must not hide the spend of all the others
    }
    const raw = parsed as {project?: unknown; ticket?: unknown}
    if (typeof raw?.project !== 'string' || typeof raw?.ticket !== 'string') continue
    const record = coerceRecord(parsed, raw.project, raw.ticket)
    if (record) records.push(record)
  }
  return records.sort((left, right) =>
    left.project === right.project ? left.ticket.localeCompare(right.ticket) : left.project.localeCompare(right.project))
}
