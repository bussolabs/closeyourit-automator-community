import * as fs from 'node:fs'
import * as path from 'node:path'
import {randomUUID} from 'node:crypto'
import {lockProcessIdentity, type ProcessIdentity} from './directory-lock'
import {defaultIsAlive, type IsAlive} from './lock'

/**
 * "Working folder in use" marker (CYAU-168).
 *
 * A working folder was removed while the quality gate was running in it: the check died halfway writing
 * to a path that disappeared. The removal was legitimate — the branch was already integrated — but "already integrated" does not
 * mean "nobody is working on it right now". The marker makes visible who is using it: whoever cleans up (the
 * closeyourit-repo-hygiene skill) reads it and skips those folders.
 *
 * `lock.ts` idiom (pidfile): the marker carries the pid and a marker whose process no longer exists counts
 * as MISSING — otherwise the first crash blocks the folder forever. It also carries the process start
 * identity (`directory-lock.ts`), so a pid REUSED by another process does not make a free folder look
 * busy.
 *
 * The marker INFORMS, it is not a gate: it does not block commands and must never fail what it accompanies. Every
 * operation is therefore best-effort and never throws.
 *
 * It lives in the Git administrative directory (the checkout's `.git`, the gitdir pointed to in linked worktrees), NEVER
 * in the working tree: the review rejects untracked files (`review-execution.ts`) and a `git add -A` must not
 * be able to stage it. It disappears together with the worktree when this is really removed.
 */

/** Name of the marker inside the working folder's Git administrative directory. */
export const BUSY_MARKER_FILE = 'closeyourit-busy.json'

/** Label of the work that caused the bug: the quality gate running inside the working folder. */
export const GATE_BUSY_LABEL = 'quality-gate'

export interface BusyMarker {
  pid: number
  /** Start time of the work (ISO 8601). */
  startedAt: string
  /** What keeps the folder busy, in plain text (e.g. `quality-gate`). */
  label: string
  /** The ticket being worked, `null` when not known (manual use of the command). */
  ticket: string | null
  /** Process start identity: distinguishes a live pid from a reused pid. Missing if not computable. */
  identity?: string
}

/**
 * Git administrative directory of `dir`: `<dir>/.git` in a checkout, the gitdir pointed to in a linked
 * worktree. `null` if `dir` is not a Git checkout or the pointed gitdir does not exist — in that case there is
 * no safe place to write and the marker is simply omitted.
 */
export function gitAdminDirectory(dir: string): string | null {
  const dotGit = path.join(dir, '.git')
  let stats: fs.Stats
  try {
    stats = fs.statSync(dotGit)
  } catch {
    return null
  }

  if (stats.isDirectory()) return dotGit
  if (!stats.isFile()) return null

  let raw: string
  try {
    raw = fs.readFileSync(dotGit, 'utf8')
  } catch {
    return null
  }

  const line = raw.split('\n').map((entry) => entry.trim()).find((entry) => entry.startsWith('gitdir:'))
  const target = line?.slice('gitdir:'.length).trim()
  if (!target) return null
  const resolved = path.resolve(dir, target)
  try {
    return fs.statSync(resolved).isDirectory() ? resolved : null
  } catch {
    return null
  }
}

/** Marker path for the working folder `dir`; `null` if there is no Git administrative directory. */
export function busyMarkerPath(dir: string): string | null {
  const adminDir = gitAdminDirectory(dir)
  return adminDir === null ? null : path.join(adminDir, BUSY_MARKER_FILE)
}

export interface BusyMarkerInput {
  /** What keeps the folder busy (e.g. `quality-gate`). */
  label: string
  /** The ticket being worked, when known. */
  ticket?: string | null
  /** Pid to declare (default: this process). Injectable in tests. */
  pid?: number
  now?: () => Date
  /** Probe of the process start identity (injectable in tests). */
  identify?: ProcessIdentity
  /** Liveness probe used so as not to overwrite the marker of a work still in progress. */
  isAlive?: IsAlive
}

export interface ReadBusyOptions {
  isAlive?: IsAlive
  identify?: ProcessIdentity
}

/** Who marked: pid PLUS start time, so a later marking is not mistaken for one's own. */
export interface BusyMarkerOwner {
  pid: number
  startedAt?: string
}

function parseMarker(raw: string): BusyMarker | null {
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    return null
  }

  const candidate = parsed as Partial<BusyMarker> | null
  if (!candidate || typeof candidate !== 'object') return null
  if (!Number.isSafeInteger(candidate.pid) || (candidate.pid as number) <= 0) return null
  if (typeof candidate.startedAt !== 'string' || typeof candidate.label !== 'string') return null
  const ticket = typeof candidate.ticket === 'string' ? candidate.ticket : null
  const identity = typeof candidate.identity === 'string' ? candidate.identity : undefined
  return {
    label: candidate.label,
    pid: candidate.pid as number,
    startedAt: candidate.startedAt,
    ticket,
    ...(identity === undefined ? {} : {identity}),
  }
}

/**
 * Writes the marker and returns the one written, `null` if there was nowhere to write it, the write failed or the
 * folder is already declared by ANOTHER work still alive. Not overwriting is the `lock.ts` rule ("a lock
 * held by a LIVE process → acquire fails"): replacing the marker of whoever was there before would make
 * the folder look free as soon as the second work ends, while the first is still working on it. A
 * stale marker — or one's own, re-marked — is instead replaced.
 *
 * Atomic publication (write to a temporary + rename): a concurrent reader can never see a half-written
 * marker and conclude from it that the folder is free.
 */
export function markBusy(dir: string, input: BusyMarkerInput): BusyMarker | null {
  const file = busyMarkerPath(dir)
  if (file === null) return null
  const pid = input.pid ?? process.pid
  const held = readBusyMarker(dir, {identify: input.identify, isAlive: input.isAlive})
  if (held !== null && held.pid !== pid) return null
  const identity = (input.identify ?? lockProcessIdentity)(pid)
  const marker: BusyMarker = {
    label: input.label,
    pid,
    startedAt: (input.now ?? (() => new Date()))().toISOString(),
    ticket: input.ticket ?? null,
    ...(identity === null ? {} : {identity}),
  }

  const temporary = `${file}.${process.pid}-${randomUUID()}`
  try {
    fs.writeFileSync(temporary, `${JSON.stringify(marker, null, 2)}\n`, {mode: 0o600})
    fs.renameSync(temporary, file)
    return marker
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
 * Reads the marker of folder `dir`. `null` means "nobody is using it": marker missing,
 * unreadable, malformed or STALE — the process that wrote it no longer exists, or that pid now belongs
 * to another process (different start identity).
 */
export function readBusyMarker(dir: string, options: ReadBusyOptions = {}): BusyMarker | null {
  const file = busyMarkerPath(dir)
  if (file === null) return null
  let raw: string
  try {
    raw = fs.readFileSync(file, 'utf8')
  } catch {
    return null
  }

  const marker = parseMarker(raw)
  if (marker === null) return null
  if (!(options.isAlive ?? defaultIsAlive)(marker.pid)) return null
  if (marker.identity !== undefined) {
    const current = (options.identify ?? lockProcessIdentity)(marker.pid)
    // Identity not computable: no proof of pid reuse, stay with the lock.ts semantics (pid only).
    if (current !== null && current !== marker.identity) return null
  }

  return marker
}

/**
 * Removes the marker, but only if it is `owner`'s: the marker of another work in progress must not be
 * deleted by mistake, as for the release of `directory-lock.ts`. Ownership is decided on pid AND start
 * time, so not even a LATER marking by the same pid is mistaken for one's own. Returns
 * `true` if the folder was left without a marker.
 *
 * Read and removal are not an atomic filesystem operation: there remains the theoretical window in which a
 * marker published between the two is removed. `markBusy` closes it in practice — whoever finds a live
 * marker does not replace it, so the successor can appear only when the owner is already dead and not
 * running any release — and the worst outcome is a folder that looks free: the marker
 * informs, it does not authorize.
 */
export function clearBusyMarker(dir: string, owner: BusyMarkerOwner = {pid: process.pid}): boolean {
  const file = busyMarkerPath(dir)
  if (file === null) return true
  let raw: string
  try {
    raw = fs.readFileSync(file, 'utf8')
  } catch {
    return true
  }

  const marker = parseMarker(raw)
  // A malformed marker protects nothing (`readBusyMarker` ignores it) and belongs to nobody:
  // leaving it there would only be residue in the gitdir, so it is removed together with one's own.
  const mine = marker === null
    || (marker.pid === owner.pid && (owner.startedAt === undefined || marker.startedAt === owner.startedAt))
  if (!mine) return false
  try {
    fs.rmSync(file, {force: true})
  } catch {
    return false
  }

  return true
}

/**
 * Marks the folder busy for the whole duration of `run` and ALWAYS releases its own marking at the end —
 * success, failure, timeout or cancellation (the `finally` also fires on the promise rejected by the abort).
 * A SIGKILL leaves the marker on disk, but its process no longer exists: `readBusyMarker` treats it as
 * missing. If nothing was marked — non-Git folder, failed write or already declared by another live
 * work — nothing is released: the declaration of whoever was there before stays theirs. `run` runs anyway: the marker
 * accompanies the work, it does not authorize it.
 */
export async function withBusyMarker<T>(dir: string, input: BusyMarkerInput, run: () => Promise<T>): Promise<T> {
  const marked = markBusy(dir, input)
  try {
    return await run()
  } finally {
    if (marked !== null) clearBusyMarker(dir, marked)
  }
}
