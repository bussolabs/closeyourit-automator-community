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

/**
 * Successful hold (with the release to run at the end of the update) or refused, with the reason to show. A refusal
 * says why (CYAU-356): `busy` the machine is working, `expired` it worked for the whole wait, `stopped` someone
 * stopped the wait. A refusal with none of them is a lock that could not even be verified.
 */
export type IdleHold =
  | {held: true; release(): void}
  | {held: false; reason: string; busy?: boolean; expired?: boolean; stopped?: boolean}

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
    return {held: false, busy: true, reason: `la macchina sta lavorando${since}: aggiornamento rimandato`}
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

/**
 * CYAU-356 — the longest wait for the free machine. Beyond it a session that never ends would keep the machine
 * without new work forever: the update gives up and leaves the outcome on the panel.
 */
export const IDLE_WAIT_MAX_MS = 6 * 60 * 60 * 1000

/** How often the wait tries the lock again: the daemon frees it between two rounds, and its interval is a minute. */
export const IDLE_WAIT_POLL_MS = 30_000

export interface IdleWaitDeps extends IdleHoldDeps {
  /** Stop of the wait (SIGTERM from systemd, Ctrl-C by hand): it ends right away, without the hold. */
  signal?: AbortSignal
  maxWaitMs?: number
  pollMs?: number
  /** Injectable clock and sleep, so the tests cross six hours without waiting them. */
  now?: () => number
  sleep?: (ms: number, signal?: AbortSignal) => Promise<void>
}

/** Abortable wait: a stop resolves it right away instead of making the update sit it out. */
function abortableSleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal?.aborted) {
      resolve()
      return
    }
    const timer = setTimeout(resolve, ms)
    signal?.addEventListener('abort', () => {
      clearTimeout(timer)
      resolve()
    }, {once: true})
  })
}

/**
 * Tries the cycle lock until the machine is free, the wait expires or someone stops it. Only a BUSY machine is
 * waited for: a lock that cannot even be verified refuses right away, as `holdIdleHost` does — fail-closed. One
 * last try falls exactly on the deadline, so a round ending in the last half minute is not wasted.
 */
export async function waitForIdleHost(deps: IdleWaitDeps = {}): Promise<IdleHold> {
  const now = deps.now ?? Date.now
  const sleep = deps.sleep ?? abortableSleep
  const maxWaitMs = deps.maxWaitMs ?? IDLE_WAIT_MAX_MS
  const pollMs = deps.pollMs ?? IDLE_WAIT_POLL_MS
  const deadline = now() + maxWaitMs
  for (;;) {
    if (deps.signal?.aborted) {
      return {held: false, stopped: true, reason: 'attesa della macchina libera interrotta: aggiornamento rimandato'}
    }
    const hold = holdIdleHost(deps)
    if (hold.held || hold.busy !== true) return hold
    const remaining = deadline - now()
    if (remaining <= 0) {
      const hours = Math.round(maxWaitMs / 3_600_000)
      return {
        held: false,
        expired: true,
        reason: `la macchina ha lavorato per tutta l'attesa massima (${hours} ore): aggiornamento rimandato dopo l'attesa massima`,
      }
    }
    await sleep(Math.min(pollMs, remaining), deps.signal)
  }
}
