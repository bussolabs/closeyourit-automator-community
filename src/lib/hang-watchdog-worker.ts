import {parentPort, workerData} from 'node:worker_threads'
import {CHECK_INTERVAL_MS, HangWatchdog, type HangWatchdogWorkerData} from './hang-watchdog'
import {sendHangBeat} from './heartbeat'

// CYAU-289 — the watchdog thread: its own event loop keeps running while the daemon's is stuck. Only glue here;
// the logic lives in `HangWatchdog`.

const data = workerData as HangWatchdogWorkerData
const port = parentPort
const target = data.beat

const watchdog = new HangWatchdog({
  markerFile: data.markerFile,
  beat: target ? async (hang) => {
    await sendHangBeat(target, hang)
  } : undefined,
  onResumed: () => port?.postMessage('resumed'),
  // Delivered when the daemon answers again: while it is hung its log is stuck with it.
  log: (message) => port?.postMessage({log: message}),
})

port?.on('message', (message: unknown) => {
  if (message === 'tick') watchdog.tick()
})

setInterval(() => {
  void watchdog.check()
}, CHECK_INTERVAL_MS)
