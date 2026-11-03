import {type LiveEventsSendResult} from './client'
import {type LiveRecord} from './live-spool'

// Sends a session's live steps to the app (CYAU-282) in batches, in the background. Nothing here can fail or
// slow the session: an outage keeps the steps for the next round, a refusal stops sending for this session.
// The first, empty batch asks the app whether the project keeps code; until it answers, steps carry no code.

export interface LiveSender {
  /** What the app last said about the project's code view; false until it answers. */
  readonly includeCode: boolean
  push(records: LiveRecord[]): void
  flush(): Promise<void>
  /**
   * Sends what is left, giving up after `closeTimeoutMs`. Called when a session ends and BEFORE the delivery:
   * the app takes steps only while the attempt runs.
   */
  drain(): Promise<void>
  /** Stops the timer, drains, and sends nothing more. */
  close(): Promise<void>
}

export interface LiveSenderOptions {
  send(records: LiveRecord[]): Promise<LiveEventsSendResult>
  intervalMs?: number
  closeTimeoutMs?: number
  /** The app takes at most 200 events and 512 KB per request; the byte cap leaves room for the envelope. */
  maxBatchEvents?: number
  maxBatchBytes?: number
  /** Steps kept while the app is away; past this the sender gives up rather than grow. */
  maxPending?: number
}

function batchOf(pending: LiveRecord[], maxEvents: number, maxBytes: number): LiveRecord[] {
  const batch: LiveRecord[] = []
  let bytes = 0
  for (const record of pending) {
    const size = Buffer.byteLength(JSON.stringify(record)) + 1
    if (batch.length > 0 && (batch.length >= maxEvents || bytes + size > maxBytes)) break
    batch.push(record)
    bytes += size
  }

  return batch
}

export function openLiveSender(options: LiveSenderOptions): LiveSender {
  const intervalMs = options.intervalMs ?? 2000
  const closeTimeoutMs = options.closeTimeoutMs ?? 10_000
  const maxBatchEvents = options.maxBatchEvents ?? 200
  const maxBatchBytes = options.maxBatchBytes ?? 400 * 1024
  const maxPending = options.maxPending ?? 5000
  let pending: LiveRecord[] = []
  let includeCode = false
  let answered = false
  let stopped = false
  let inFlight: Promise<void> | undefined

  const stop = (): void => {
    stopped = true
    pending = []
  }

  const sendAll = async (): Promise<void> => {
    while (!stopped && (pending.length > 0 || !answered)) {
      const batch = batchOf(pending, maxBatchEvents, maxBatchBytes)
      let result: LiveEventsSendResult
      try {
        result = await options.send(batch)
      } catch {
        result = {outcome: 'unavailable'}
      }

      if (result.outcome === 'unavailable') return
      if (result.outcome === 'rejected') {
        stop()
        return
      }

      answered = true
      includeCode = result.includeCode
      pending = pending.slice(batch.length)
    }
  }

  const flush = (): Promise<void> => {
    inFlight ??= sendAll().finally(() => {
      inFlight = undefined
    })
    return inFlight
  }

  const drain = async (): Promise<void> => {
    let timeout: ReturnType<typeof setTimeout> | undefined
    await Promise.race([
      (async () => {
        // A round already running may have started before the last steps arrived: wait for it, then send the rest.
        await inFlight
        await flush()
      })(),
      new Promise<void>((resolve) => {
        timeout = setTimeout(resolve, closeTimeoutMs)
        timeout.unref?.()
      }),
    ])
    clearTimeout(timeout)
  }

  const timer = setInterval(() => void flush(), intervalMs)
  timer.unref?.()
  const first = setTimeout(() => void flush(), 0)
  first.unref?.()

  return {
    get includeCode() {
      return includeCode
    },
    push(records) {
      if (stopped || records.length === 0) return
      if (pending.length + records.length > maxPending) {
        stop()
        return
      }

      pending.push(...records)
    },
    flush,
    drain,
    async close() {
      clearInterval(timer)
      clearTimeout(first)
      await drain()
      stop()
    },
  }
}
