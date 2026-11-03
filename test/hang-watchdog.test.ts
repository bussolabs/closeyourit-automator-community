import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import {afterEach, beforeEach, describe, expect, it} from 'vitest'
import {
  consumeHangMarker,
  createHangReportQueue,
  HANG_THRESHOLD_MS,
  hangMarkerPath,
  HangWatchdog,
  HUNG_BEAT_WINDOW_MS,
  MAX_HANG_MARKER_BYTES,
  previousHangMarkerPath,
  readLastHang,
  type HangReport,
} from '../src/lib/hang-watchdog'

// CYAU-289 — a watchdog with its own event loop notices when the daemon stops answering, writes the hang to disk and
// tells the server, so the panel can tell a hung machine from a switched-off one.

const directories: string[] = []
let savedStateDir: string | undefined

beforeEach(() => {
  savedStateDir = process.env.AUTOMATOR_STATE_DIR
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'automator-hang-'))
  directories.push(directory)
  process.env.AUTOMATOR_STATE_DIR = directory
})

afterEach(() => {
  if (savedStateDir === undefined) delete process.env.AUTOMATOR_STATE_DIR
  else process.env.AUTOMATOR_STATE_DIR = savedStateDir
  for (const directory of directories.splice(0)) fs.rmSync(directory, {recursive: true, force: true})
})

const T0 = Date.parse('2026-11-03T10:00:00.000Z')
const minutes = (count: number) => count * 60_000

function harness() {
  const beats: HangReport[] = []
  const resumed: number[] = []
  const logs: string[] = []
  let clock = T0
  const watchdog = new HangWatchdog({
    markerFile: hangMarkerPath(),
    now: () => clock,
    beat: async (hang) => {
      beats.push(hang)
    },
    onResumed: () => resumed.push(clock),
    log: (message) => logs.push(message),
  })
  return {
    watchdog,
    beats,
    resumed,
    logs,
    at: (ms: number) => {
      clock = T0 + ms
    },
  }
}

function marker(): Record<string, unknown> {
  return JSON.parse(fs.readFileSync(hangMarkerPath(), 'utf8'))
}

describe('HangWatchdog', () => {
  it('a slow round of 2 minutes is not a hang: no marker, no beat', async () => {
    const h = harness()
    h.watchdog.tick()
    h.at(minutes(2))
    await h.watchdog.check()
    h.watchdog.tick()

    expect(fs.existsSync(hangMarkerPath())).toBe(false)
    expect(h.beats).toEqual([])
    expect(h.resumed).toEqual([])
  })

  it('a silence over 5 minutes writes the marker and sends a hung beat', async () => {
    const h = harness()
    h.watchdog.tick()
    h.at(HANG_THRESHOLD_MS + 1_000)
    await h.watchdog.check()

    expect(marker()).toMatchObject({version: 1, started_at: '2026-11-03T10:00:00.000Z'})
    expect(marker().resumed_at).toBeUndefined()
    expect(h.beats).toEqual([{state: 'hung', started_at: '2026-11-03T10:00:00.000Z', duration_seconds: 301}])
  })

  it('beats at most once a minute while hung', async () => {
    const h = harness()
    h.watchdog.tick()
    h.at(minutes(6))
    await h.watchdog.check()
    h.at(minutes(6) + 10_000)
    await h.watchdog.check()
    h.at(minutes(7))
    await h.watchdog.check()

    expect(h.beats.map((beat) => beat.duration_seconds)).toEqual([360, 420])
  })

  it('stops the hung beat after 30 minutes, so the machine looks stopped as before', async () => {
    const h = harness()
    h.watchdog.tick()
    for (let minute = 6; minute <= 40; minute += 1) {
      h.at(minutes(minute))
      await h.watchdog.check()
    }

    expect(h.beats.length).toBeGreaterThan(0)
    for (const beat of h.beats) expect(beat.duration_seconds * 1000).toBeLessThan(HUNG_BEAT_WINDOW_MS)
  })

  it('on resume completes the marker with resume time and duration and notifies the daemon', async () => {
    const h = harness()
    h.watchdog.tick()
    h.at(minutes(6))
    await h.watchdog.check()
    h.watchdog.tick()

    expect(marker()).toMatchObject({started_at: '2026-11-03T10:00:00.000Z', resumed_at: '2026-11-03T10:06:00.000Z'})
    expect(h.resumed).toEqual([T0 + minutes(6)])
  })

  it('a failing beat or disk never escapes the watchdog', async () => {
    const logs: string[] = []
    let clock = T0
    const watchdog = new HangWatchdog({
      markerFile: path.join(hangMarkerPath(), 'not-a-dir', 'hang.json'),
      now: () => clock,
      beat: async () => {
        throw new Error('network down')
      },
      log: (message) => logs.push(message),
    })
    fs.writeFileSync(hangMarkerPath(), 'file blocks the directory')
    watchdog.tick()
    clock = T0 + minutes(6)
    await expect(watchdog.check()).resolves.toBeUndefined()
    expect(() => watchdog.tick()).not.toThrow()
    expect(logs.join('\n')).toContain('hang watchdog')
  })
})

describe('consumeHangMarker', () => {
  it('moves the marker aside before reading it, so the same hang is reported once', () => {
    fs.writeFileSync(hangMarkerPath(), JSON.stringify({
      version: 1, started_at: '2026-11-03T10:00:00.000Z', last_seen_at: '2026-11-03T10:07:00.000Z',
    }))

    expect(consumeHangMarker()).toEqual({state: 'restarted', started_at: '2026-11-03T10:00:00.000Z', duration_seconds: 420})
    expect(fs.existsSync(hangMarkerPath())).toBe(false)
    expect(fs.existsSync(previousHangMarkerPath())).toBe(true)
    expect(consumeHangMarker()).toBeNull()
  })

  it('reports a resumed hang with its resume time', () => {
    fs.writeFileSync(hangMarkerPath(), JSON.stringify({
      version: 1, started_at: '2026-11-03T10:00:00.000Z', last_seen_at: '2026-11-03T10:05:50.000Z',
      resumed_at: '2026-11-03T10:06:00.000Z',
    }))

    expect(consumeHangMarker()).toEqual({
      state: 'resumed', started_at: '2026-11-03T10:00:00.000Z', duration_seconds: 360, resumed_at: '2026-11-03T10:06:00.000Z',
    })
  })

  it('an unreadable marker is ignored and still moved aside', () => {
    fs.writeFileSync(hangMarkerPath(), '{not json')

    expect(consumeHangMarker()).toBeNull()
    expect(fs.existsSync(hangMarkerPath())).toBe(false)
  })

  it('a marker over 64 KB is ignored and still moved aside', () => {
    const padding = 'x'.repeat(MAX_HANG_MARKER_BYTES)
    fs.writeFileSync(hangMarkerPath(), JSON.stringify({
      version: 1, started_at: '2026-11-03T10:00:00.000Z', last_seen_at: '2026-11-03T10:07:00.000Z', padding,
    }))

    expect(consumeHangMarker()).toBeNull()
    expect(fs.existsSync(hangMarkerPath())).toBe(false)
  })

  it('no marker → null', () => {
    expect(consumeHangMarker()).toBeNull()
  })
})

describe('readLastHang', () => {
  it('reads the last recorded hang without consuming it', () => {
    fs.writeFileSync(previousHangMarkerPath(), JSON.stringify({
      version: 1, started_at: '2026-11-03T10:00:00.000Z', last_seen_at: '2026-11-03T10:05:50.000Z',
      resumed_at: '2026-11-03T10:06:00.000Z',
    }))

    expect(readLastHang()?.state).toBe('resumed')
    expect(readLastHang()?.state).toBe('resumed')
  })

  it('prefers the live marker, still hung, over the previous one', () => {
    fs.writeFileSync(previousHangMarkerPath(), JSON.stringify({
      version: 1, started_at: '2026-11-01T10:00:00.000Z', last_seen_at: '2026-11-01T10:07:00.000Z',
    }))
    fs.writeFileSync(hangMarkerPath(), JSON.stringify({
      version: 1, started_at: '2026-11-03T10:00:00.000Z', last_seen_at: '2026-11-03T10:09:00.000Z',
    }))

    expect(readLastHang()).toEqual({state: 'hung', started_at: '2026-11-03T10:00:00.000Z', duration_seconds: 540})
  })

  it('no hang recorded → null', () => {
    expect(readLastHang()).toBeNull()
  })
})

describe('createHangReportQueue', () => {
  it('hands a report out once', () => {
    const queue = createHangReportQueue({state: 'restarted', started_at: '2026-11-03T10:00:00.000Z', duration_seconds: 60})
    expect(queue.take()?.state).toBe('restarted')
    expect(queue.take()).toBeNull()
    queue.push({state: 'resumed', started_at: '2026-11-03T11:00:00.000Z', duration_seconds: 360, resumed_at: '2026-11-03T11:06:00.000Z'})
    expect(queue.take()?.state).toBe('resumed')
    expect(queue.take()).toBeNull()
  })
})
