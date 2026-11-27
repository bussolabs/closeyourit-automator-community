import * as fs from 'node:fs'
import * as path from 'node:path'
import {randomUUID} from 'node:crypto'
import {lockProcessIdentity, type ProcessIdentity} from './directory-lock'
import {IDLE_WAIT_MAX_MS} from './host-idle'
import {defaultIsAlive, type IsAlive} from './lock'

// CYAU-356 — "an update is waiting for the free machine".
//
// With the queue full the cycle lock was never free at the hourly check: the update postponed itself every hour
// and the machine stayed on the old version for days. When a new version exists the updater writes this signal
// and waits for the lock; the daemon, the tick and the queue read it and take NO new work, so the sessions in
// progress end and the lock frees up. The signal only asks: it interrupts nothing, and the lock stays the only
// guarantee — the update restarts the service only when it holds it.
//
// `busy-marker.ts` idiom: the signal carries pid and start identity of who wrote it, and a signal whose process no
// longer exists (or whose pid now belongs to another process) counts as MISSING. Otherwise an updater killed
// without cleaning up would leave the machine without new work forever. A signal older than the longest wait
// counts as missing too: no live updater can still be waiting behind it.

/** Who wrote the signal: the updater, not a cycle. */
export const UPDATE_DRAIN_LABEL = 'automator-update'

/** The longest wait plus a margin: beyond it the signal belongs to no updater still in its wait. */
export const UPDATE_DRAIN_MAX_AGE_MS = IDLE_WAIT_MAX_MS + 30 * 60 * 1000

export interface UpdateDrain {
  pid: number
  /** When the wait started (ISO 8601). */
  startedAt: string
  label: string
  /** The version the update is waiting to install, `null` when not known. */
  toVersion: string | null
  /** Process start identity: distinguishes a live pid from a reused pid. Missing if not computable. */
  identity?: string
}

export interface UpdateDrainOptions {
  isAlive?: IsAlive
  identify?: ProcessIdentity
  now?: () => Date
}

export interface MarkUpdateDrainInput extends UpdateDrainOptions {
  toVersion?: string | null
  /** Pid to declare (default: this process). Injectable in tests. */
  pid?: number
}

function parseDrain(raw: string): UpdateDrain | null {
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    return null
  }

  const candidate = parsed as Partial<UpdateDrain> | null
  if (!candidate || typeof candidate !== 'object') return null
  if (!Number.isSafeInteger(candidate.pid) || (candidate.pid as number) <= 0) return null
  if (typeof candidate.startedAt !== 'string' || typeof candidate.label !== 'string') return null
  const toVersion = typeof candidate.toVersion === 'string' ? candidate.toVersion : null
  const identity = typeof candidate.identity === 'string' ? candidate.identity : undefined
  return {
    pid: candidate.pid as number,
    startedAt: candidate.startedAt,
    label: candidate.label,
    toVersion,
    ...(identity === undefined ? {} : {identity}),
  }
}

/**
 * Writes the signal and returns the one written, `null` if the write failed. Atomic publication (temporary +
 * rename): a reader never sees half a signal. It throws nothing — without a signal the update just waits as it
 * always did, with the machine still taking work.
 */
export function markUpdateDrain(file: string, input: MarkUpdateDrainInput = {}): UpdateDrain | null {
  const pid = input.pid ?? process.pid
  const identity = (input.identify ?? lockProcessIdentity)(pid)
  const drain: UpdateDrain = {
    pid,
    startedAt: (input.now ?? (() => new Date()))().toISOString(),
    label: UPDATE_DRAIN_LABEL,
    toVersion: input.toVersion ?? null,
    ...(identity === null ? {} : {identity}),
  }

  const temporary = `${file}.${process.pid}-${randomUUID()}`
  try {
    fs.mkdirSync(path.dirname(file), {recursive: true})
    fs.writeFileSync(temporary, `${JSON.stringify(drain, null, 2)}\n`, {mode: 0o600})
    fs.renameSync(temporary, file)
    return drain
  } catch {
    try {
      fs.rmSync(temporary, {force: true})
    } catch {
      // nothing to clean up: the write never reached the filesystem
    }

    return null
  }
}

/**
 * Reads the signal. `null` means "no update is waiting": signal missing, unreadable, malformed, too old or
 * ORPHAN — the process that wrote it no longer exists, or that pid now belongs to another process.
 */
export function readUpdateDrain(file: string, options: UpdateDrainOptions = {}): UpdateDrain | null {
  let raw: string
  try {
    raw = fs.readFileSync(file, 'utf8')
  } catch {
    return null
  }

  const drain = parseDrain(raw)
  if (drain === null) return null
  const startedAt = Date.parse(drain.startedAt)
  const now = (options.now ?? (() => new Date()))().getTime()
  if (Number.isNaN(startedAt) || now - startedAt > UPDATE_DRAIN_MAX_AGE_MS) return null
  if (!(options.isAlive ?? defaultIsAlive)(drain.pid)) return null
  if (drain.identity !== undefined) {
    const current = (options.identify ?? lockProcessIdentity)(drain.pid)
    // Identity not computable: no proof of pid reuse, stay with the lock.ts semantics (pid only).
    if (current !== null && current !== drain.identity) return null
  }

  return drain
}

/** true when a live update is waiting for the free machine: no new work is to be taken. */
export function updateDrainPending(file: string, options: UpdateDrainOptions = {}): boolean {
  return readUpdateDrain(file, options) !== null
}

/**
 * Removes the signal, but only if it is `owner`'s (pid AND start time), as for `clearBusyMarker`: a later update
 * waiting in its turn keeps its own. A malformed signal belongs to nobody and goes away with it. Never throws.
 */
export function clearUpdateDrain(file: string, owner: {pid: number; startedAt?: string} = {pid: process.pid}): boolean {
  let raw: string
  try {
    raw = fs.readFileSync(file, 'utf8')
  } catch {
    return true
  }

  const drain = parseDrain(raw)
  const mine = drain === null
    || (drain.pid === owner.pid && (owner.startedAt === undefined || drain.startedAt === owner.startedAt))
  if (!mine) return false
  try {
    fs.rmSync(file, {force: true})
  } catch {
    return false
  }

  return true
}
