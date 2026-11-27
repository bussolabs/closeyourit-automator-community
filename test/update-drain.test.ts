import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import {afterEach, describe, expect, it} from 'vitest'
import {updateDrainPath} from '../src/lib/paths'
import {
  clearUpdateDrain,
  markUpdateDrain,
  readUpdateDrain,
  UPDATE_DRAIN_MAX_AGE_MS,
  updateDrainPending,
} from '../src/lib/update-drain'

// CYAU-356 — "an update is waiting for the free machine". The signal asks the daemon, the tick and the queue to take
// no new work; it never interrupts anything. It counts only while its updater is alive and the wait can still be
// running: an updater killed without cleaning up must not leave the machine without work forever.

const directories: string[] = []

function temporaryDrainFile(): string {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'automator-drain-'))
  directories.push(directory)
  return updateDrainPath(path.join(directory, 'tick.lock'))
}

afterEach(() => {
  for (const directory of directories.splice(0)) fs.rmSync(directory, {recursive: true, force: true})
})

describe('update drain signal', () => {
  it('lives beside the cycle lock', () => {
    expect(updateDrainPath('/state/tick.lock')).toBe(path.join('/state', 'update-drain.json'))
  })

  it('written by a live updater → pending, with who and since when', () => {
    const file = temporaryDrainFile()
    const now = new Date('2026-11-27T10:00:00.000Z')

    const drain = markUpdateDrain(file, {toVersion: '0.70.0', now: () => now, identify: () => null})

    expect(drain).not.toBeNull()
    const read = readUpdateDrain(file, {isAlive: () => true, now: () => now, identify: () => null})
    expect(read?.pid).toBe(process.pid)
    expect(read?.startedAt).toBe(now.toISOString())
    expect(read?.toVersion).toBe('0.70.0')
    expect(read?.label).toBe('automator-update')
  })

  it('orphan: its process no longer exists → counts as missing', () => {
    const file = temporaryDrainFile()
    markUpdateDrain(file, {pid: 999_999, identify: () => null})

    expect(updateDrainPending(file, {isAlive: () => false})).toBe(false)
  })

  it('pid reused by another process → counts as missing', () => {
    const file = temporaryDrainFile()
    markUpdateDrain(file, {identify: () => 'linux:100'})

    expect(updateDrainPending(file, {isAlive: () => true, identify: () => 'linux:200'})).toBe(false)
  })

  it('older than the longest wait → counts as missing, even with a live pid', () => {
    const file = temporaryDrainFile()
    const startedAt = new Date('2026-11-27T00:00:00.000Z')
    markUpdateDrain(file, {now: () => startedAt, identify: () => null})
    const later = new Date(startedAt.getTime() + UPDATE_DRAIN_MAX_AGE_MS + 1)

    expect(updateDrainPending(file, {isAlive: () => true, now: () => later, identify: () => null})).toBe(false)
  })

  it('missing or malformed → no update waiting', () => {
    const file = temporaryDrainFile()
    expect(updateDrainPending(file)).toBe(false)
    fs.writeFileSync(file, '{ non è json')
    expect(updateDrainPending(file)).toBe(false)
  })

  it('cleared only by its owner: a later update keeps its own signal', () => {
    const file = temporaryDrainFile()
    const first = markUpdateDrain(file, {now: () => new Date('2026-11-27T10:00:00.000Z'), identify: () => null})
    markUpdateDrain(file, {now: () => new Date('2026-11-27T11:00:00.000Z'), identify: () => null})

    expect(clearUpdateDrain(file, first!)).toBe(false)
    expect(fs.existsSync(file)).toBe(true)
    expect(clearUpdateDrain(file)).toBe(true)
    expect(fs.existsSync(file)).toBe(false)
  })
})
