import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import {afterEach, describe, expect, it} from 'vitest'
import {holdIdleHost, IDLE_WAIT_MAX_MS, IDLE_WAIT_POLL_MS, waitForIdleHost} from '../src/lib/host-idle'
import {acquire, readLock} from '../src/lib/lock'

// CYAU-202: the automatic update must NEVER interrupt a run. The "machine busy" signal
// is the cycle lock (`runOnce` holds it for the whole round, ticket run included):
// taking it for the duration of the update also closes the race — while the updater holds it no new round
// can start, so between the check and the service restart no run is born.

const directories: string[] = []

function temporaryLockFile(): string {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'automator-idle-'))
  directories.push(directory)
  return path.join(directory, 'automator.lock')
}

afterEach(() => {
  for (const directory of directories.splice(0)) fs.rmSync(directory, {recursive: true, force: true})
})

describe('holdIdleHost — the idle machine lends itself, the working one does not', () => {
  it('no cycle running → successful hold and lock written on behalf of the update', () => {
    const lockFile = temporaryLockFile()
    const hold = holdIdleHost({lockFile})
    expect(hold.held).toBe(true)
    expect(readLock(lockFile)?.label).toBe('automator-update')
    if (hold.held) hold.release()
    expect(fs.existsSync(lockFile)).toBe(false)
  })

  it('cycle running from a live process → hold rejected with the reason', () => {
    const lockFile = temporaryLockFile()
    acquire(lockFile, 'automator', () => true)
    const hold = holdIdleHost({lockFile, isAlive: () => true})
    expect(hold.held).toBe(false)
    if (!hold.held) expect(hold.reason).toContain('sta lavorando')
  })

  it('lock left by a dead process → the machine is free (a crash does not block it forever)', () => {
    const lockFile = temporaryLockFile()
    acquire(lockFile, 'automator', () => true)
    const hold = holdIdleHost({lockFile, isAlive: () => false})
    expect(hold.held).toBe(true)
  })

  it('lock not writable → fail-closed: the update is given up, no proceeding in the dark', () => {
    const lockFile = path.join(temporaryLockFile(), 'sottocartella', 'automator.lock')
    fs.writeFileSync(path.dirname(path.dirname(lockFile)), '')
    const hold = holdIdleHost({lockFile})
    expect(hold.held).toBe(false)
    if (!hold.held) expect(hold.reason).toContain('non verificabile')
  })

  it('CYAU-356: a busy refusal says so, an unverifiable one does not (only the first is waited for)', () => {
    const lockFile = temporaryLockFile()
    acquire(lockFile, 'automator', () => true)
    const busy = holdIdleHost({lockFile, isAlive: () => true})
    expect(busy.held === false && busy.busy).toBe(true)

    const unwritable = path.join(temporaryLockFile(), 'sottocartella', 'automator.lock')
    fs.writeFileSync(path.dirname(path.dirname(unwritable)), '')
    const unverifiable = holdIdleHost({lockFile: unwritable})
    expect(unverifiable.held === false && unverifiable.busy === undefined).toBe(true)
  })

  it('a repeated release is harmless and does not touch another one lock (idempotent release)', () => {
    const lockFile = temporaryLockFile()
    const hold = holdIdleHost({lockFile})
    expect(hold.held).toBe(true)
    if (!hold.held) return
    hold.release()
    acquire(lockFile, 'automator', () => true)
    hold.release()
    expect(readLock(lockFile)?.label).toBe('automator')
  })
})

// CYAU-356 — with the queue full the lock was never free at the hourly check. With a new version the update now
// waits for the round to end, trying the lock every 30 seconds, for at most 6 hours. The clock and the sleep are
// simulated: the six hours pass in a few milliseconds.
describe('waitForIdleHost — waits for the free machine, up to the longest wait', () => {
  function simulatedClock(): {now: () => number; sleep: (ms: number) => Promise<void>; slept: number[]} {
    let current = 0
    const slept: number[] = []
    return {
      now: () => current,
      sleep: async (ms: number) => {
        slept.push(ms)
        current += ms
      },
      slept,
    }
  }

  it('the round ends during the wait → hold taken, the restart can happen only now', async () => {
    const lockFile = temporaryLockFile()
    acquire(lockFile, 'automator', () => true)
    const clock = simulatedClock()
    let alive = true
    const sleep = async (ms: number): Promise<void> => {
      await clock.sleep(ms)
      // The session ends after two minutes: the round releases the lock.
      if (clock.now() >= 120_000) alive = false
    }

    const hold = await waitForIdleHost({lockFile, isAlive: () => alive, now: clock.now, sleep})

    expect(hold.held).toBe(true)
    expect(clock.slept.every((ms) => ms === IDLE_WAIT_POLL_MS)).toBe(true)
    expect(clock.now()).toBe(120_000)
    expect(readLock(lockFile)?.label).toBe('automator-update')
    if (hold.held) hold.release()
  })

  it('the session never ends → after 6 hours it gives up, says so, and the lock stays the round one', async () => {
    const lockFile = temporaryLockFile()
    acquire(lockFile, 'automator', () => true)
    const clock = simulatedClock()

    const hold = await waitForIdleHost({lockFile, isAlive: () => true, now: clock.now, sleep: clock.sleep})

    expect(hold.held).toBe(false)
    if (!hold.held) {
      expect(hold.expired).toBe(true)
      expect(hold.reason).toContain('6 ore')
    }
    expect(clock.now()).toBe(IDLE_WAIT_MAX_MS)
    expect(IDLE_WAIT_MAX_MS).toBe(6 * 60 * 60 * 1000)
    expect(readLock(lockFile)?.label).toBe('automator')
  })

  it('stopped during the wait → it ends right away without the hold', async () => {
    const lockFile = temporaryLockFile()
    acquire(lockFile, 'automator', () => true)
    const clock = simulatedClock()
    const controller = new AbortController()
    const sleep = async (ms: number): Promise<void> => {
      await clock.sleep(ms)
      if (clock.slept.length === 3) controller.abort()
    }

    const hold = await waitForIdleHost({lockFile, isAlive: () => true, now: clock.now, sleep, signal: controller.signal})

    expect(hold.held).toBe(false)
    if (!hold.held) expect(hold.stopped).toBe(true)
    expect(clock.slept).toHaveLength(3)
    expect(readLock(lockFile)?.label).toBe('automator')
  })

  it('lock not verifiable → no wait at all: fail-closed as the single try', async () => {
    const lockFile = path.join(temporaryLockFile(), 'sottocartella', 'automator.lock')
    fs.writeFileSync(path.dirname(path.dirname(lockFile)), '')
    const clock = simulatedClock()

    const hold = await waitForIdleHost({lockFile, now: clock.now, sleep: clock.sleep})

    expect(hold.held).toBe(false)
    if (!hold.held) expect(hold.reason).toContain('non verificabile')
    expect(clock.slept).toEqual([])
  })
})
