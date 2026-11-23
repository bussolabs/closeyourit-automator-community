import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import {afterEach, beforeEach, describe, expect, it} from 'vitest'
import {
  isSilent,
  openPulseWriter,
  PULSE_MAX_BYTES,
  pulsePath,
  readPulse,
  type SessionPulse,
  silentSeconds,
  STALL_AFTER_MS,
} from '../src/lib/session-pulse'

// CYAU-276 — the session pulse: the last step of a Claude session and when, written at every step and read at every beat.

let dir: string
beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'automator-pulse-'))
})
afterEach(() => fs.rmSync(dir, {recursive: true, force: true}))

const read = {kind: 'file_read' as const, path: 'app.rb'}
const run = {kind: 'command' as const, command: 'pnpm test'}

/** A clock the test moves by hand. */
function manualClock(start: string) {
  let now = new Date(start)
  return {clock: () => now, set: (iso: string) => void (now = new Date(iso))}
}

describe('pulsePath', () => {
  it('one note per run, under the given folder', () => {
    expect(pulsePath('run-1', dir)).toBe(path.join(dir, 'run-1.json'))
  })

  it('a hostile run-id never climbs the path', () => {
    expect(() => pulsePath('../x', dir)).toThrow()
    expect(() => pulsePath('..', dir)).toThrow()
  })
})

describe('openPulseWriter', () => {
  it('opening marks the session open with no step yet', () => {
    const file = pulsePath('run-1', dir)
    const {clock} = manualClock('2026-11-05T10:00:00.000Z')
    openPulseWriter(file, clock).open()
    expect(readPulse(file)).toEqual({session_open: true, opened_at: '2026-11-05T10:00:00.000Z', last_step_kind: null, last_step_at: null})
  })

  it('every step rewrites the note with the LAST kind and its time, nothing else of the step', () => {
    const file = pulsePath('run-1', dir)
    const time = manualClock('2026-11-05T10:00:00.000Z')
    const writer = openPulseWriter(file, time.clock)
    writer.open()
    time.set('2026-11-05T10:01:00.000Z')
    writer.step([read, run])
    expect(readPulse(file)).toMatchObject({session_open: true, last_step_kind: 'command', last_step_at: '2026-11-05T10:01:00.000Z'})
    const raw = fs.readFileSync(file, 'utf8')
    expect(raw).not.toContain('pnpm test')
    expect(raw).not.toContain('app.rb')
  })

  it('a stream event without steps leaves the note as it is', () => {
    const file = pulsePath('run-1', dir)
    const time = manualClock('2026-11-05T10:00:00.000Z')
    const writer = openPulseWriter(file, time.clock)
    writer.open()
    time.set('2026-11-05T10:05:00.000Z')
    writer.step([])
    expect(readPulse(file)?.last_step_at).toBeNull()
  })

  it('a step before any opening writes nothing', () => {
    const file = pulsePath('run-1', dir)
    openPulseWriter(file).step([read])
    expect(fs.existsSync(file)).toBe(false)
  })

  it('closing marks the session closed and keeps the last step; a second close is a no-op', () => {
    const file = pulsePath('run-1', dir)
    const writer = openPulseWriter(file, manualClock('2026-11-05T10:00:00.000Z').clock)
    writer.open()
    writer.step([read])
    writer.close()
    expect(readPulse(file)).toMatchObject({session_open: false, last_step_kind: 'file_read'})
    fs.rmSync(file)
    writer.close()
    expect(fs.existsSync(file)).toBe(false)
  })

  it('a retry reopens: new opening time, the last step of the earlier session kept', () => {
    const file = pulsePath('run-1', dir)
    const time = manualClock('2026-11-05T10:00:00.000Z')
    const writer = openPulseWriter(file, time.clock)
    writer.open()
    writer.step([read])
    writer.close()
    time.set('2026-11-05T10:20:00.000Z')
    writer.open()
    expect(readPulse(file)).toEqual({session_open: true, opened_at: '2026-11-05T10:20:00.000Z', last_step_kind: 'file_read', last_step_at: '2026-11-05T10:00:00.000Z'})
  })

  it('removing deletes the note, and removing it twice is harmless', () => {
    const file = pulsePath('run-1', dir)
    const writer = openPulseWriter(file)
    writer.open()
    writer.remove()
    writer.remove()
    expect(fs.existsSync(file)).toBe(false)
  })

  it('a folder that refuses the write never throws: open, step, close and remove all go on', () => {
    // The pulse folder is a FILE: every write fails as on a full or read-only disk.
    const blocked = path.join(dir, 'pulse')
    fs.writeFileSync(blocked, 'not a folder')
    const writer = openPulseWriter(pulsePath('run-1', blocked))
    expect(() => {
      writer.open()
      writer.step([read])
      writer.close()
      writer.remove()
    }).not.toThrow()
  })
})

describe('readPulse', () => {
  const file = (): string => path.join(dir, 'run-1.json')

  it('missing note → no information', () => {
    expect(readPulse(file())).toBeNull()
  })

  it('corrupt JSON → no information, never a throw', () => {
    fs.writeFileSync(file(), '{"session_open": tr')
    expect(readPulse(file())).toBeNull()
  })

  it('not an object, or without the opening → no information', () => {
    fs.writeFileSync(file(), '[1,2]')
    expect(readPulse(file())).toBeNull()
    fs.writeFileSync(file(), JSON.stringify({session_open: true, opened_at: 'ieri'}))
    expect(readPulse(file())).toBeNull()
    fs.writeFileSync(file(), JSON.stringify({session_open: 'yes', opened_at: '2026-11-05T10:00:00.000Z'}))
    expect(readPulse(file())).toBeNull()
  })

  it('too big a note is not ours → no information', () => {
    fs.writeFileSync(file(), JSON.stringify({session_open: true, opened_at: '2026-11-05T10:00:00.000Z', pad: 'x'.repeat(PULSE_MAX_BYTES)}))
    expect(readPulse(file())).toBeNull()
  })

  it('an unknown step kind or a bad time drops the step, never invents one; extra fields never come out', () => {
    fs.writeFileSync(file(), JSON.stringify({session_open: true, opened_at: '2026-11-05T10:00:00.000Z', last_step_kind: 'shell', last_step_at: '2026-11-05T10:01:00.000Z', command: 'rm -rf /'}))
    expect(readPulse(file())).toEqual({session_open: true, opened_at: '2026-11-05T10:00:00.000Z', last_step_kind: null, last_step_at: null})
    fs.writeFileSync(file(), JSON.stringify({session_open: true, opened_at: '2026-11-05T10:00:00.000Z', last_step_kind: 'search', last_step_at: 'dopo'}))
    expect(readPulse(file())).toMatchObject({last_step_kind: null, last_step_at: null})
  })
})

describe('silence', () => {
  const open = (over: Partial<SessionPulse> = {}): SessionPulse => ({
    session_open: true, opened_at: '2026-11-05T10:00:00.000Z', last_step_kind: 'file_read', last_step_at: '2026-11-05T10:02:00.000Z', ...over,
  })
  const at = (iso: string): Date => new Date(iso)

  it('the threshold is 8 minutes', () => {
    expect(STALL_AFTER_MS).toBe(8 * 60 * 1000)
  })

  it('counts from the last step: just under the threshold is working, at the threshold it is silent', () => {
    expect(silentSeconds(open(), at('2026-11-05T10:09:59.000Z'))).toBe(479)
    expect(isSilent(open(), at('2026-11-05T10:09:59.000Z'))).toBe(false)
    expect(isSilent(open(), at('2026-11-05T10:10:00.000Z'))).toBe(true)
  })

  it('without steps it counts from the opening (a session that never started working)', () => {
    const fresh = open({last_step_kind: null, last_step_at: null})
    expect(silentSeconds(fresh, at('2026-11-05T10:08:00.000Z'))).toBe(480)
    expect(isSilent(fresh, at('2026-11-05T10:08:00.000Z'))).toBe(true)
  })

  it('a step of an earlier session does not count: the silence starts at the new opening', () => {
    const reopened = open({opened_at: '2026-11-05T10:30:00.000Z'})
    expect(silentSeconds(reopened, at('2026-11-05T10:31:00.000Z'))).toBe(60)
  })

  it('a closed session is never silent, however long the delivery', () => {
    expect(silentSeconds(open({session_open: false}), at('2026-11-05T11:00:00.000Z'))).toBeNull()
    expect(isSilent(open({session_open: false}), at('2026-11-05T11:00:00.000Z'))).toBe(false)
  })

  it('no note → no silence', () => {
    expect(silentSeconds(null, at('2026-11-05T11:00:00.000Z'))).toBeNull()
    expect(isSilent(null, at('2026-11-05T11:00:00.000Z'))).toBe(false)
  })

  it('a clock behind the note gives zero, never a negative silence', () => {
    expect(silentSeconds(open(), at('2026-11-05T09:00:00.000Z'))).toBe(0)
  })
})
