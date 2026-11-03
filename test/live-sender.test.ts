import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest'
import {type LiveEventsSendResult} from '../src/lib/client'
import {openLiveSender} from '../src/lib/live-sender'
import {type LiveRecord} from '../src/lib/live-spool'

function record(seq: number, path = `file-${seq}.rb`): LiveRecord {
  return {seq, at: '2026-11-02T15:00:00.000Z', event: {kind: 'file_read', path}}
}

function fakeSend(...answers: LiveEventsSendResult[]) {
  const batches: LiveRecord[][] = []
  const send = vi.fn(async (records: LiveRecord[]): Promise<LiveEventsSendResult> => {
    batches.push(records)
    return answers.length > 1 ? answers.shift()! : answers[0] ?? {outcome: 'ok', acceptedThrough: 0, includeCode: false}
  })
  return {send, batches}
}

const ok = (includeCode = false): LiveEventsSendResult => ({outcome: 'ok', acceptedThrough: 1, includeCode})

describe('openLiveSender', () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('asks the app at once whether the project keeps code, with an empty batch', async () => {
    const {send, batches} = fakeSend(ok(true))
    const sender = openLiveSender({send})
    expect(sender.includeCode).toBe(false)
    await vi.advanceTimersByTimeAsync(0)
    expect(batches).toEqual([[]])
    expect(sender.includeCode).toBe(true)
    await sender.close()
  })

  it('sends the queued steps every interval, once each', async () => {
    const {send, batches} = fakeSend(ok())
    const sender = openLiveSender({send, intervalMs: 2000})
    await vi.advanceTimersByTimeAsync(0)
    sender.push([record(1), record(2)])
    await vi.advanceTimersByTimeAsync(2000)
    sender.push([record(3)])
    await vi.advanceTimersByTimeAsync(2000)
    await vi.advanceTimersByTimeAsync(2000)
    expect(batches.slice(1)).toEqual([[record(1), record(2)], [record(3)]])
    await sender.close()
  })

  it('splits a large queue into batches the app accepts', async () => {
    const {send, batches} = fakeSend(ok())
    const sender = openLiveSender({send, maxBatchEvents: 2, maxBatchBytes: 10_000})
    await vi.advanceTimersByTimeAsync(0)
    sender.push([record(1), record(2), record(3)])
    await sender.flush()
    expect(batches.slice(1).map((batch) => batch.map((item) => item.seq))).toEqual([[1, 2], [3]])

    const bySize = fakeSend(ok())
    const small = openLiveSender({send: bySize.send, maxBatchBytes: 150})
    await vi.advanceTimersByTimeAsync(0)
    small.push([record(1, 'a'.repeat(60)), record(2, 'b'.repeat(60))])
    await small.flush()
    expect(bySize.batches.slice(1).map((batch) => batch.length)).toEqual([1, 1])
    await sender.close()
    await small.close()
  })

  it('keeps the steps and tries again when the app cannot be reached', async () => {
    const {send, batches} = fakeSend(ok(), {outcome: 'unavailable'}, ok())
    const sender = openLiveSender({send})
    await vi.advanceTimersByTimeAsync(0)
    sender.push([record(1)])
    await sender.flush()
    await sender.flush()
    expect(batches.slice(1)).toEqual([[record(1)], [record(1)]])
    await sender.flush()
    expect(batches).toHaveLength(3)
    await sender.close()
  })

  it('stops for good when the app refuses, and never blocks the session', async () => {
    const {send, batches} = fakeSend(ok(), {outcome: 'rejected', status: 409, code: 'R409-LIVE-002'})
    const sender = openLiveSender({send})
    await vi.advanceTimersByTimeAsync(0)
    sender.push([record(1)])
    await sender.flush()
    sender.push([record(2)])
    await vi.advanceTimersByTimeAsync(10_000)
    await sender.close()
    expect(batches.slice(1)).toEqual([[record(1)]])
  })

  it('gives up instead of growing without bound while the app is away', async () => {
    const {send, batches} = fakeSend({outcome: 'unavailable'})
    const sender = openLiveSender({send, maxPending: 2})
    sender.push([record(1), record(2), record(3)])
    await vi.advanceTimersByTimeAsync(10_000)
    expect(batches.every((batch) => batch.length === 0)).toBe(true)
    await sender.close()
  })

  it('treats a send that throws as an outage', async () => {
    const send = vi.fn(async () => {
      throw new Error('boom')
    })
    const sender = openLiveSender({send})
    sender.push([record(1)])
    await expect(sender.flush()).resolves.toBeUndefined()
    await sender.close()
  })

  it('sends what is left when the session ends, within a time limit', async () => {
    const {send, batches} = fakeSend(ok())
    const sender = openLiveSender({send, intervalMs: 60_000})
    await vi.advanceTimersByTimeAsync(0)
    sender.push([record(1)])
    await sender.close()
    expect(batches.slice(1)).toEqual([[record(1)]])

    const hanging = openLiveSender({send: () => new Promise<never>(() => undefined), closeTimeoutMs: 5000})
    const closing = hanging.close()
    await vi.advanceTimersByTimeAsync(5000)
    await expect(closing).resolves.toBeUndefined()
  })
})
