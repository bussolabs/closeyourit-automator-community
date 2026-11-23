import * as fs from 'node:fs'
import {type LiveEvent} from './live-events'
import {pulseDir} from './paths'
import {isRecord, runPath, writeAtomicJson} from './state'

// Session pulse (CYAU-276): a small note per run with the last step a Claude session narrated and when. The
// heartbeat reads it every minute instead of the live queue (which can reach 32 MB) and marks the run stopped
// after STALL_AFTER_MS of silence while the session is open. Only the step kind and the time are kept: never a
// path, a command or an argument, because the note travels with the beat. Writing and reading are best-effort:
// a note that cannot be written never stops the session, one that cannot be read means "no information".

/**
 * Silence after which an open Claude session counts as stopped. The only place to raise it: a long command (a
 * ten-minute test suite) narrates no step and would look stopped below its duration.
 */
export const STALL_AFTER_MS = 8 * 60 * 1000

/** A note bigger than this is not ours: it is read as missing. */
export const PULSE_MAX_BYTES = 4096

export type PulseStepKind = LiveEvent['kind']

const STEP_KINDS: ReadonlySet<string> = new Set<PulseStepKind>(['file_change', 'file_read', 'search', 'command'])

export interface SessionPulse {
  /** True between the start and the end of the Claude session: delivery and review do not count as silence. */
  session_open: boolean
  /** When the current session opened: the silence counts from here until the first step. */
  opened_at: string
  last_step_kind: PulseStepKind | null
  last_step_at: string | null
}

/** Path of a run's note: `<pulseDir>/<run-id>.json`, the run-id validated as for the checkpoints (never path traversal). */
export function pulsePath(runId: string, base: string = pulseDir()): string {
  return runPath(runId, base)
}

export interface PulseWriter {
  /** A session starts: open, silence counted from now. */
  open(): void
  /** The session narrated steps: the last one is the one kept. */
  step(events: LiveEvent[]): void
  /** The session ended: from here the silence no longer counts. */
  close(): void
  /** The run is over: the note goes away with it. */
  remove(): void
}

export function openPulseWriter(file: string, clock: () => Date = () => new Date()): PulseWriter {
  let pulse: SessionPulse | null = null
  const save = (next: SessionPulse): void => {
    pulse = next
    try {
      writeAtomicJson(file, next)
    } catch {
      // A full disk or a read-only folder costs the signal, never the session.
    }
  }

  return {
    open() {
      save({session_open: true, opened_at: clock().toISOString(), last_step_kind: pulse?.last_step_kind ?? null, last_step_at: pulse?.last_step_at ?? null})
    },
    step(events) {
      const last = events.at(-1)
      if (!last || !pulse) return
      save({...pulse, last_step_kind: last.kind, last_step_at: clock().toISOString()})
    },
    close() {
      if (pulse?.session_open) save({...pulse, session_open: false})
    },
    remove() {
      try {
        fs.rmSync(file, {force: true})
      } catch {
        // A note left behind is ignored: no lease points at its run any more.
      }
    },
  }
}

function isTimestamp(value: unknown): value is string {
  return typeof value === 'string' && !Number.isNaN(Date.parse(value))
}

/** Reads a note. Missing, unreadable, too big, corrupt or partial → `null` (no information), never a throw. */
export function readPulse(file: string): SessionPulse | null {
  try {
    if (fs.statSync(file).size > PULSE_MAX_BYTES) return null
    const parsed: unknown = JSON.parse(fs.readFileSync(file, 'utf8'))
    if (!isRecord(parsed)) return null
    const sessionOpen = parsed.session_open
    const openedAt = parsed.opened_at
    if (typeof sessionOpen !== 'boolean' || !isTimestamp(openedAt)) return null
    const rawKind = parsed.last_step_kind
    const kind = typeof rawKind === 'string' && STEP_KINDS.has(rawKind) ? rawKind as PulseStepKind : null
    const rawAt = parsed.last_step_at
    const at = isTimestamp(rawAt) ? rawAt : null
    // Kind and time travel together: half a step is no step.
    return {
      session_open: sessionOpen,
      opened_at: openedAt,
      last_step_kind: kind && at ? kind : null,
      last_step_at: kind && at ? at : null,
    }
  } catch {
    return null
  }
}

/**
 * Seconds of silence of an OPEN session: since the last step, or since the opening when there is none yet (or
 * the last step belongs to an earlier session). `null` when the session is closed or there is no note.
 */
export function silentSeconds(pulse: SessionPulse | null, now: Date): number | null {
  if (!pulse?.session_open) return null
  const opened = Date.parse(pulse.opened_at)
  const stepped = pulse.last_step_at === null ? Number.NEGATIVE_INFINITY : Date.parse(pulse.last_step_at)
  return Math.max(0, Math.floor((now.getTime() - Math.max(opened, stepped)) / 1000))
}

/** An open session silent for at least the threshold. */
export function isSilent(pulse: SessionPulse | null, now: Date): boolean {
  const seconds = silentSeconds(pulse, now)
  return seconds !== null && seconds * 1000 >= STALL_AFTER_MS
}
