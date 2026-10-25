import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import {afterEach, describe, expect, it} from 'vitest'
import {holdIdleHost} from '../src/lib/host-idle'
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
