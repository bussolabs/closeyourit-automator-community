import * as fs from 'node:fs'
import * as path from 'node:path'
import {Worker} from 'node:worker_threads'
import {type HeartbeatConfig} from './config'
import {stateDir} from './paths'
import {redactSecrets} from './secret-redaction'

// CYAU-289 — "a hung machine is not a switched-off machine".
//
// The beat runs in the daemon's own event loop: a synchronous call that never returns stops the round AND the beat,
// and the panel shows the machine as switched off. The watchdog runs in a worker thread, with its own event loop:
// the daemon sends it a tick every 10 seconds, and when ticks are missing for 5 minutes it writes the hang to a
// marker on disk and, for at most 30 minutes, sends a reduced beat that says "hung". The marker survives a kill, so
// a hang that ended with a restart is still told, once.

/** How often the daemon loop tells the watchdog it is alive. */
export const TICK_INTERVAL_MS = 10_000
/** How often the watchdog looks at the last tick. */
export const CHECK_INTERVAL_MS = 10_000
/** Silence after which the daemon counts as hung: a heavy but regular round must not look like a hang. */
export const HANG_THRESHOLD_MS = 5 * 60_000
/** After this the reduced beat stops and the machine looks stopped, as before. */
export const HUNG_BEAT_WINDOW_MS = 30 * 60_000
/** Same pace as the daemon keepalive: the monitor declares the host offline after 2+1 minutes. */
export const HUNG_BEAT_INTERVAL_MS = 60_000
/** A larger marker is not ours: it is ignored, never parsed. */
export const MAX_HANG_MARKER_BYTES = 64 * 1024

const MARKER_FILE = 'hang.json'
const PREVIOUS_MARKER_FILE = 'hang-previous.json'

/** What the beat carries in `hang`. `restarted` = the hang ended with the process killed and started again. */
export interface HangReport {
  state: 'hung' | 'resumed' | 'restarted'
  started_at: string
  duration_seconds: number
  resumed_at?: string
}

interface HangMarker {
  version: 1
  started_at: string
  last_seen_at: string
  resumed_at?: string
}

/** The hang not reported yet (still going on, or ended and waiting for the next beat). */
export function hangMarkerPath(): string {
  return path.join(stateDir(), MARKER_FILE)
}

/** The last hang already handed to the beat: kept for `doctor` until the next start. */
export function previousHangMarkerPath(): string {
  return path.join(stateDir(), PREVIOUS_MARKER_FILE)
}

function seconds(fromIso: string, toIso: string): number {
  return Math.max(0, Math.round((Date.parse(toIso) - Date.parse(fromIso)) / 1000))
}

/** Reads a marker with the 64 KB cap. Missing, oversized or malformed → `null`, never an exception. */
function readMarker(file: string): HangMarker | null {
  let fd: number | undefined
  try {
    fd = fs.openSync(file, 'r')
    if (fs.fstatSync(fd).size > MAX_HANG_MARKER_BYTES) return null
    const buffer = Buffer.alloc(MAX_HANG_MARKER_BYTES + 1)
    const length = fs.readSync(fd, buffer, 0, buffer.length, 0)
    if (length > MAX_HANG_MARKER_BYTES) return null
    const parsed = JSON.parse(buffer.subarray(0, length).toString('utf8')) as Partial<HangMarker>
    const valid = (value: unknown): value is string => typeof value === 'string' && !Number.isNaN(Date.parse(value))
    if (parsed?.version !== 1 || !valid(parsed.started_at) || !valid(parsed.last_seen_at)) return null
    if (parsed.resumed_at !== undefined && !valid(parsed.resumed_at)) return null
    return {version: 1, started_at: parsed.started_at, last_seen_at: parsed.last_seen_at, resumed_at: parsed.resumed_at}
  } catch {
    return null
  } finally {
    if (fd !== undefined) fs.closeSync(fd)
  }
}

function toReport(marker: HangMarker, unfinished: HangReport['state']): HangReport {
  if (marker.resumed_at) {
    return {state: 'resumed', started_at: marker.started_at, duration_seconds: seconds(marker.started_at, marker.resumed_at), resumed_at: marker.resumed_at}
  }
  return {state: unfinished, started_at: marker.started_at, duration_seconds: seconds(marker.started_at, marker.last_seen_at)}
}

/**
 * Takes the unreported hang: the marker is moved aside FIRST and only then read, once. A crash between the two
 * loses a report instead of telling it twice. Unreadable or oversized → `null`, and it stays aside anyway.
 */
export function consumeHangMarker(): HangReport | null {
  const previous = previousHangMarkerPath()
  try {
    fs.rmSync(previous, {force: true})
    fs.renameSync(hangMarkerPath(), previous)
  } catch {
    return null
  }
  const marker = readMarker(previous)
  // Read at start (or after the watchdog said "resumed"): an unfinished marker here was cut by a restart.
  return marker ? toReport(marker, 'restarted') : null
}

/** The last hang for `doctor`, without consuming it: the live marker first (still hung), then the previous one. */
export function readLastHang(): HangReport | null {
  const live = readMarker(hangMarkerPath())
  if (live) return toReport(live, 'hung')
  const previous = readMarker(previousHangMarkerPath())
  return previous ? toReport(previous, 'restarted') : null
}

/** One-shot holder: each report reaches exactly one beat. */
export function createHangReportQueue(initial: HangReport | null = null): {push(report: HangReport | null): void; take(): HangReport | null} {
  let pending = initial
  return {
    push(report) {
      if (report) pending = report
    },
    take() {
      const report = pending
      pending = null
      return report
    },
  }
}

export interface HangWatchdogOptions {
  markerFile: string
  now?: () => number
  /** Reduced beat while hung; omitted when the heartbeat is not configured. */
  beat?: (hang: HangReport) => Promise<void>
  /** The daemon answers again after a recorded hang. */
  onResumed?: () => void
  log?: (message: string) => void
}

/** Watchdog logic, free of threads and timers so it can be tested with a fake clock. */
export class HangWatchdog {
  private lastTickAt: number
  private hangStartedAt: number | null = null
  private lastBeatAt: number | null = null
  private readonly now: () => number

  constructor(private readonly opts: HangWatchdogOptions) {
    this.now = opts.now ?? Date.now
    this.lastTickAt = this.now()
  }

  tick(): void {
    const at = this.now()
    this.lastTickAt = at
    if (this.hangStartedAt === null) return
    const startedAt = this.hangStartedAt
    this.hangStartedAt = null
    this.lastBeatAt = null
    const resumed = new Date(at).toISOString()
    this.write({version: 1, started_at: new Date(startedAt).toISOString(), last_seen_at: resumed, resumed_at: resumed})
    try {
      this.opts.onResumed?.()
    } catch (error) {
      this.report('resume notice failed', error)
    }
  }

  async check(): Promise<void> {
    const now = this.now()
    if (this.hangStartedAt === null) {
      if (now - this.lastTickAt < HANG_THRESHOLD_MS) return
      this.hangStartedAt = this.lastTickAt
      this.opts.log?.(`hang watchdog: no answer from the daemon since ${new Date(this.lastTickAt).toISOString()}`)
    }
    const startedAt = new Date(this.hangStartedAt).toISOString()
    const seenAt = new Date(now).toISOString()
    this.write({version: 1, started_at: startedAt, last_seen_at: seenAt})

    if (!this.opts.beat || now - this.hangStartedAt >= HUNG_BEAT_WINDOW_MS) return
    if (this.lastBeatAt !== null && now - this.lastBeatAt < HUNG_BEAT_INTERVAL_MS) return
    this.lastBeatAt = now
    try {
      await this.opts.beat({state: 'hung', started_at: startedAt, duration_seconds: seconds(startedAt, seenAt)})
    } catch (error) {
      this.report('hung beat failed', error)
    }
  }

  private write(marker: HangMarker): void {
    try {
      fs.mkdirSync(path.dirname(this.opts.markerFile), {recursive: true})
      fs.writeFileSync(this.opts.markerFile, `${JSON.stringify(marker)}\n`)
    } catch (error) {
      this.report('marker not written', error)
    }
  }

  private report(what: string, error: unknown): void {
    this.opts.log?.(`hang watchdog: ${what}: ${redactSecrets(error instanceof Error ? error.message : String(error))}`)
  }
}

/** What the worker receives in memory (never argv or env) to send the reduced beat. */
export interface HangBeatTarget {
  heartbeat: HeartbeatConfig
  hostToken: string | undefined
  hostId: string
  version?: string
}

export interface HangWatchdogWorkerData {
  markerFile: string
  beat?: HangBeatTarget
}

export interface HangWatchdogHandle {
  tick(): void
  stop(): Promise<void>
}

/**
 * Starts the watchdog thread. Any failure — the thread cannot start or dies later — is logged and the daemon goes on
 * without a watchdog: a broken watchdog must never stop the service it watches.
 */
export function startHangWatchdog(opts: {
  beat?: HangBeatTarget
  onResumed: () => void
  log: (message: string) => void
  workerFile?: string
}): HangWatchdogHandle | undefined {
  const data: HangWatchdogWorkerData = {markerFile: hangMarkerPath(), beat: opts.beat}
  let worker: Worker
  try {
    worker = new Worker(opts.workerFile ?? path.join(__dirname, 'hang-watchdog-worker.js'), {workerData: data})
  } catch (error) {
    opts.log(`hang watchdog: not started, continuing without it: ${redactSecrets(error instanceof Error ? error.message : String(error))}`)
    return undefined
  }
  let alive = true
  worker.unref()
  worker.on('error', (error) => {
    alive = false
    opts.log(`hang watchdog: stopped, continuing without it: ${redactSecrets(error.message)}`)
  })
  worker.on('exit', () => {
    alive = false
  })
  worker.on('message', (message: unknown) => {
    if (message === 'resumed') opts.onResumed()
    else if (typeof message === 'object' && message !== null && typeof (message as {log?: unknown}).log === 'string') {
      opts.log((message as {log: string}).log)
    }
  })
  return {
    tick() {
      if (alive) worker.postMessage('tick')
    },
    async stop() {
      alive = false
      await worker.terminate()
    },
  }
}
