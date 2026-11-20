import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import {randomUUID} from 'node:crypto'
import {ticketAttemptsDir} from './paths'
import {quarantineCorruptState, syncDirectoryBestEffort} from './state'

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
// CYAU-324 — the only way out of `corrupt` is a person: a Retry pressed after the file went bad sets it aside
// (`…​.corrupt-<stamp>`, never deleted) and the series restarts from one. Without it the ticket stays stopped.

/** Consecutive attempts allowed on the SAME phase before stopping and reporting. */
export const DEFAULT_MAX_TICKET_ATTEMPTS = 5

/** Consecutive quota pauses whose attempt is given back; past it, the attempt counts like any failure. */
export const DEFAULT_MAX_QUOTA_PAUSES = 3

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
  /**
   * CYAU-275 — consecutive quota pauses of the current phase whose attempt was given back. Absent = none. It
   * caps the refunds: a failure mistaken for a quota limit must not retry a ticket forever.
   */
  quota_pauses?: number
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

/** File operations of the durable write: injectable so a test can prove their order. */
export interface TicketAttemptsWriteIo {
  /** Recursive mkdir. */
  makeDirectory: (directory: string) => void
  /** Whether this machine may have created `directory`: the parent of every such directory is flushed on each write. */
  ownsDirectory: (directory: string) => boolean
  open: (file: string) => number
  write: (fd: number, data: string) => void
  sync: (fd: number) => void
  close: (fd: number) => void
  rename: (from: string, to: string) => void
  syncDirectory: (directory: string) => void
}

const defaultWriteIo: TicketAttemptsWriteIo = {
  makeDirectory: (directory) => { fs.mkdirSync(directory, {recursive: true}) },
  ownsDirectory: ownedByThisUser,
  open: (file) => fs.openSync(file, 'wx', 0o600),
  write: (fd, data) => fs.writeFileSync(fd, data, 'utf8'),
  sync: (fd) => fs.fsyncSync(fd),
  close: (fd) => fs.closeSync(fd),
  rename: (from, to) => fs.renameSync(from, to),
  syncDirectory: syncDirectoryStrict,
}

/**
 * Directory fsync that PROPAGATES its error. `syncDirectoryBestEffort` swallows it because, for the general state, the
 * commit already happened; here a swallowed EIO would let a counter whose directory entry may vanish at the next power
 * loss count as written — and a vanished counter reads as "no attempt yet", the restart from zero this module exists to
 * prevent.
 */
export function syncDirectoryStrict(directory: string): void {
  const fd = fs.openSync(directory, 'r')
  try {
    fs.fsyncSync(fd)
  } finally {
    fs.closeSync(fd)
  }
}

/**
 * A directory this process could have created: owned by its user, and not the home directory or the filesystem root
 * (they exist before any automator, and their parents may not even be readable). Without a uid (not POSIX) nothing is
 * claimed: no parent flush.
 */
export function ownedByThisUser(directory: string): boolean {
  const uid = process.getuid?.()
  if (uid === undefined) return false
  const resolved = path.resolve(directory)
  if (resolved === path.resolve(os.homedir()) || path.dirname(resolved) === resolved) return false
  return fs.statSync(resolved).uid === uid
}

/**
 * Durable record write: temp + fsync + rename + directory fsync, without an inter-process lock. The general state lock
 * is for whoever can have TWO writers on the same file; here it cannot happen — a ticket's counter is touched
 * only by whoever holds its lease (only one, guaranteed by the server) and the local tick is already serialized by the
 * daemon lock. A rename is atomic on the same filesystem: a reader sees the old record or the new one, never
 * half a file.
 *
 * CYAU-324 — the rename alone is not enough after a power loss: ext4 with default options protects the rename that
 * REPLACES a file, not the first creation, so the first attempt of every ticket could come back empty. The content is
 * therefore flushed BEFORE the rename and the directory entry after it — the same method as `state.ts`. A directory
 * this machine created is a new entry of its parent: every such parent is flushed too, before the file is published,
 * otherwise a power loss could take away the whole counters directory and the count would read as absent. The flush
 * runs on EVERY write, not only when `mkdir` reports a creation: after a failed parent flush the directory is already
 * there, and a retry that trusted `mkdir` would publish a count whose directory entry was never made durable.
 * Every flush error propagates: one before the rename leaves the old count in place (nothing is published); the one
 * after the rename throws even though the new count is already visible, because it is not yet durable. The caller
 * denies the dispatch either way (fail-closed): at worst an attempt is counted that never ran, never one forgotten.
 */
export function writeTicketAttemptsFile(file: string, record: TicketAttemptRecord, io: TicketAttemptsWriteIo = defaultWriteIo): void {
  const directory = path.dirname(file)
  io.makeDirectory(directory)
  syncOwnedDirectoryParents(directory, io)
  const temporary = `${file}.tmp-${process.pid}-${randomUUID()}`
  let fd: number | null = null
  try {
    fd = io.open(temporary)
    io.write(fd, `${JSON.stringify(record, null, 2)}\n`)
    io.sync(fd)
    io.close(fd)
    fd = null
    io.rename(temporary, file)
  } catch (error) {
    if (fd !== null) {
      try { io.close(fd) } catch { /* the temp cleanup continues */ }
    }
    try { fs.rmSync(temporary, {force: true}) } catch { /* the orphan temp is not the count: it stays ignorable */ }
    throw error
  }
  io.syncDirectory(directory)
}

/** Flushes the parent of every directory this machine may have created, from the deepest up to the first it does not own. */
function syncOwnedDirectoryParents(directory: string, io: TicketAttemptsWriteIo): void {
  let current = path.resolve(directory)
  while (io.ownsDirectory(current)) {
    const parent = path.dirname(current)
    if (parent === current) return
    io.syncDirectory(parent)
    current = parent
  }
}

function writeRecord(file: string, record: TicketAttemptRecord): void {
  writeTicketAttemptsFile(file, record)
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
  if (value.quota_pauses !== undefined && !safeCount(value.quota_pauses)) return null
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
    ...(typeof value.quota_pauses === 'number' && value.quota_pauses > 0 ? {quota_pauses: value.quota_pauses} : {}),
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
    // The pause count belongs to the phase, like the attempts.
    ...(samePhase && previous.quota_pauses ? {quota_pauses: previous.quota_pauses} : {}),
  }
  writeRecord(file, record)
  return record
}

export interface SettleQuotaPauseInput {
  project: string
  ticket: string
  /** The session stopped on a clear quota limit, or its review never ran because of the machine (CYAU-335). */
  quotaHit: boolean
  maxPauses?: number
  now?: Date
}

/**
 * CYAU-275 — settles the attempt counted at the claim once the session is over. A quota limit gives it back:
 * the account ran out, the ticket did not fail. Only up to `maxPauses` consecutive pauses, then the attempt
 * stays counted and the usual threshold reports the ticket to a person. Any other outcome restarts the pause
 * count. Without a readable record nothing is given back (`counted`).
 *
 * CYAU-335 — the same counter settles a review the MACHINE could not run (quota, reviewer down, diff not
 * acquirable): the work was never judged, so it does not pay for it. Same cap, for the same reason — a fault
 * mistaken for a pause must not retry a ticket forever.
 */
export function settleQuotaPause(
  input: SettleQuotaPauseInput,
  dir: string = ticketAttemptsDir(),
): 'refunded' | 'cap_reached' | 'counted' {
  const current = readTicketAttempts(input.project, input.ticket, dir)
  if (current.corrupt || !current.record) return 'counted'
  const {quota_pauses: pauses = 0, ...rest} = current.record
  const updatedAt = (input.now ?? new Date()).toISOString()
  const file = ticketAttemptsPath(input.project, input.ticket, dir)
  if (!input.quotaHit) {
    if (pauses > 0) writeRecord(file, {...rest, updated_at: updatedAt})
    return 'counted'
  }
  const max = Number.isInteger(input.maxPauses) && input.maxPauses! >= 1 ? input.maxPauses! : DEFAULT_MAX_QUOTA_PAUSES
  if (pauses >= max) return 'cap_reached'
  writeRecord(file, {...rest, attempts: Math.max(0, rest.attempts - 1), quota_pauses: pauses + 1, updated_at: updatedAt})
  return 'refunded'
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
 * CYAU-324 — twin of `restartedByPerson` for an UNREADABLE count, which has no `updated_at` to compare: the file's
 * last write stands in for it. A Retry (`budget_from`) later than that write sets the file aside — renamed, never
 * deleted, so the lost spend can still be read by hand — and the next read finds no record: the series restarts from
 * one. Anything else (readable count, no Retry, Retry older than the damage, failed rename) returns `null` and leaves
 * the ticket stopped: the machine never resets the count by itself.
 */
export function setAsideCorruptTicketAttempts(
  project: string,
  ticket: string,
  budgetFrom: unknown,
  dir: string = ticketAttemptsDir(),
  now: Date = new Date(),
): string | null {
  if (typeof budgetFrom !== 'string') return null
  const from = Date.parse(budgetFrom)
  if (!Number.isFinite(from)) return null
  if (!readTicketAttempts(project, ticket, dir).corrupt) return null
  const file = ticketAttemptsPath(project, ticket, dir)
  let damagedAt: number
  try {
    damagedAt = fs.statSync(file).mtimeMs
  } catch {
    return null
  }
  if (!(from > damagedAt)) return null
  const quarantined = quarantineCorruptState(file, `${now.toISOString().replace(/[:.]/g, '-')}-${randomUUID()}`)
  // Best effort on purpose: if this flush fails and the rename is lost, the damaged file comes back and the ticket is
  // stopped again (fail-closed). The first attempt after the Retry writes in this same directory with a flush that
  // must succeed before the dispatch goes ahead, and that flush makes this rename durable too.
  if (quarantined) syncDirectoryBestEffort(dir)
  return quarantined
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
  const {quota_pauses: _pauses, ...kept} = current.record
  const record: TicketAttemptRecord = {
    ...kept,
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

/** A count file that cannot be read: identity taken from the file name, the only thing still trustworthy. */
export interface UnreadableTicketAttempts {
  /** `null` when the name does not follow `<project>__<code>.json`. */
  project: string | null
  ticket: string
  file: string
}

/** Every count file of the store: the readable records and, apart, the unreadable ones (CYAU-324). */
export interface TicketAttemptsScan {
  records: TicketAttemptRecord[]
  unreadable: UnreadableTicketAttempts[]
}

function unreadableEntry(dir: string, entry: string): UnreadableTicketAttempts {
  const base = entry.slice(0, -'.json'.length)
  const separator = base.indexOf('__')
  return separator > 0
    ? {project: base.slice(0, separator), ticket: base.slice(separator + 2), file: path.join(dir, entry)}
    : {project: null, ticket: base, file: path.join(dir, entry)}
}

/**
 * All the count files, sorted by ticket. An unreadable file does not hide the spend of the others, and does not
 * disappear either (CYAU-324): it is listed apart, so the operator sees which ticket is stopped on it.
 */
export function scanTicketAttempts(dir: string = ticketAttemptsDir()): TicketAttemptsScan {
  let entries: string[]
  try {
    entries = fs.readdirSync(dir)
  } catch {
    return {records: [], unreadable: []}
  }
  const records: TicketAttemptRecord[] = []
  const unreadable: UnreadableTicketAttempts[] = []
  for (const entry of entries) {
    if (!entry.endsWith('.json')) continue
    let parsed: unknown
    try {
      parsed = JSON.parse(fs.readFileSync(path.join(dir, entry), 'utf8'))
    } catch {
      unreadable.push(unreadableEntry(dir, entry))
      continue
    }
    const raw = parsed as {project?: unknown; ticket?: unknown}
    const record = typeof raw?.project === 'string' && typeof raw?.ticket === 'string'
      ? coerceRecord(parsed, raw.project, raw.ticket)
      : null
    if (record) records.push(record)
    else unreadable.push(unreadableEntry(dir, entry))
  }
  const byTicket = (left: {project: string | null; ticket: string}, right: {project: string | null; ticket: string}) =>
    left.project === right.project
      ? left.ticket.localeCompare(right.ticket)
      : (left.project ?? '').localeCompare(right.project ?? '')
  return {records: records.sort(byTicket), unreadable: unreadable.sort(byTicket)}
}

/** All readable counts, sorted by ticket: the "how much each ticket cost" view of the read-only commands. */
export function listTicketAttempts(dir: string = ticketAttemptsDir()): TicketAttemptRecord[] {
  return scanTicketAttempts(dir).records
}
