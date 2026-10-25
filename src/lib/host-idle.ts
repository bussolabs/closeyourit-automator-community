import {acquire, defaultIsAlive, type IsAlive, readLock, release} from './lock'
import {lockPath} from './paths'

// CYAU-202 — "is the machine free?" for the automatic update.
//
// The signal is not the leases nor the action scopes, but the CYCLE LOCK: `runOnce` holds it for the whole
// round (ticket run included) and releases it only at the end. A lease without a live cycle is
// an orphan run — restarting the service there interrupts nothing, because no process is running.
//
// Taking it, instead of just reading it, also closes the race: while the updater holds it no new round
// can start, so between the check and the service restart no run can start. The
// daemon that finds the lock taken skips the round, exactly as it does with an overlapping tick.

/** Successful hold (with the release to run at the end of the update) or refused, with the reason to show. */
export type IdleHold = {held: true; release(): void} | {held: false; reason: string}

/** Label written in the lock: whoever reads the pidfile must understand it is the updater, not a cycle. */
export const IDLE_HOLD_LABEL = 'automator-update'

export interface IdleHoldDeps {
  lockFile?: string
  isAlive?: IsAlive
}

/**
 * Takes the cycle lock for the duration of the update. Fail-closed: if the lock state is not
 * even verifiable (unreadable pidfile, non-writable directory) the machine does NOT update — better
 * an update postponed by an hour than an interrupted run.
 */
export function holdIdleHost(deps: IdleHoldDeps = {}): IdleHold {
  const lockFile = deps.lockFile ?? lockPath()
  const isAlive = deps.isAlive ?? defaultIsAlive
  let acquired: boolean
  try {
    acquired = acquire(lockFile, IDLE_HOLD_LABEL, isAlive)
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error)
    return {held: false, reason: `stato della macchina non verificabile: ${detail}`}
  }
  if (!acquired) {
    const holder = readLock(lockFile)
    const since = holder?.startedAt ? ` dalle ${holder.startedAt}` : ''
    return {held: false, reason: `la macchina sta lavorando${since}: aggiornamento rimandato`}
  }

  let releasedByUs = false
  return {
    held: true,
    release() {
      // Idempotent and limited to its OWN hold: a second call must not delete the lock of a
      // cycle that restarted in the meantime.
      if (releasedByUs) return
      releasedByUs = true
      release(lockFile)
    },
  }
}
