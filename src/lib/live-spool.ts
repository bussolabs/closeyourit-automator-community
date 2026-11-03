import * as fs from 'node:fs'
import * as path from 'node:path'
import {type LiveEvent} from './live-events'
import {formatTimestamp} from './logger'
import {redactSecrets} from './secret-redaction'

// Local queue of a session's live events (CYAU-282): one JSONL file next to the action log, one numbered line
// per event. The numbers make delivery to the app ordered and idempotent, and the file keeps the events while
// the machine is offline. Nothing here touches the network.

/** A runaway session must not fill the disk: past this size the queue stops and records it once. */
export const LIVE_SPOOL_MAX_BYTES = 32 * 1024 * 1024

/** One numbered line of the queue: a step, or the marker that the queue stopped at its size cap. */
export type LiveRecord =
  | {seq: number; at: string; event: LiveEvent}
  | {seq: number; at: string; truncated: true}

export interface LiveSpool {
  path: string
  /** Returns the lines as written, secrets already covered: the same ones the app receives. */
  append(events: LiveEvent[]): LiveRecord[]
}

export function openLiveSpool(
  dir: string,
  name: string,
  now: Date,
  options: {clock?: () => Date; maxBytes?: number} = {},
): LiveSpool {
  const file = path.join(dir, `${name}-${formatTimestamp(now)}.live.jsonl`)
  const clock = options.clock ?? (() => new Date())
  const maxBytes = options.maxBytes ?? LIVE_SPOOL_MAX_BYTES
  let seq = 0
  let bytes = 0
  let full = false

  const write = (record: LiveRecord): LiveRecord => {
    const line = `${redactSecrets(JSON.stringify(record))}\n`
    fs.mkdirSync(dir, {recursive: true, mode: 0o700})
    fs.appendFileSync(file, line, {mode: 0o600})
    bytes += Buffer.byteLength(line)
    return JSON.parse(line) as LiveRecord
  }

  return {
    path: file,
    append(events) {
      const written: LiveRecord[] = []
      for (const event of events) {
        if (full) break
        const record = {seq: seq + 1, at: clock().toISOString(), event}
        if (bytes + Buffer.byteLength(JSON.stringify(record)) + 1 > maxBytes) {
          full = true
          seq += 1
          written.push(write({seq, at: clock().toISOString(), truncated: true}))
          break
        }

        seq += 1
        written.push(write(record))
      }

      return written
    },
  }
}
