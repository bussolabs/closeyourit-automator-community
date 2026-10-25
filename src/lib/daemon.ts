import * as path from 'node:path'
import {loadPlaybook} from './playbook'
import {runOnce, type ActionPreflightFn, type RunOnceOptions, type RunOnceResult, type TicketQueueTarget} from './runner'
import {type SpawnFn} from './executor'
import {type IsAlive} from './lock'
import {type Playbook} from './schema'
import {type SyncFn} from './sync'
import {AutomatorError} from '../errors/error-codes'
import {type SecretCapabilities} from './env-capabilities'
import {type PreflightStop} from './heartbeat'

// Self-scheduling, cross-OS loop: reloads the playbook at every iteration (changes apply
// without restart), runs runOnce, then sleeps `intervalMs`. A playbook that became invalid does NOT kill
// the daemon (logged, retried). SIGTERM/SIGINT → clean shutdown (interrupts the sleep, exits 0).

const DEFAULT_INTERVAL_MS = 60_000
// The monitor declares the host offline after `expected_interval + grace` (today 2+1 minutes). The beat must
// therefore arrive more often than that even when the round is long: one minute leaves a two-beat margin.
const DEFAULT_HEARTBEAT_INTERVAL_MS = 60_000

/**
 * Log lines of ONE iteration (CYAU-105).
 *
 * The daemon printed only the preflight stops and two counters: a session that started, ran for three minutes and
 * ended without delivering showed up as "ran 1", indistinguishable from a success — while status,
 * code, log path and the delivery outcome were already in the result. The function is **pure**, so this
 * is verifiable without running a daemon or a real delivery.
 *
 * What is printed and what is not: the preflight **stops** always (operational decisions), the **failed**
 * actions and the **failed** deliveries. A delivery that went well makes no noise: if every outcome spoke
 * the log would become unreadable again, which is the other way of saying nothing.
 */
export function formatIterationLines(result: RunOnceResult): string[] {
  const lines: string[] = []
  for (const stopped of result.preflightStopped) {
    lines.push(`preflight stop "${stopped.name}" [${stopped.state}]: ${stopped.reason}`)
  }
  for (const action of result.executed) {
    if (action.status !== 'success') {
      lines.push(`azione "${action.name}" [${action.status}] ${action.errorCode ?? 'senza codice'} log=${action.logPath}`)
    }
    const delivery = action.delivery
    if (!delivery) continue
    if (delivery.outcome === 'ok') {
      // CYAU-171 — silent on the concluded ones, as always: a delivery that went well is not news. But if
      // the response arrived and could not be read, it must be said — together with the fact that NOBODY
      // is needed. Without that second half, a line saying "not read" looks like a fault to repair.
      if (delivery.attemptStatus === undefined) {
        lines.push(
          `consegna "${action.name}" accettata, esito non letto (fase=${delivery.phase} attempt=${delivery.attemptId}): ` +
          'la risposta del server non era leggibile. Il lavoro è consegnato, non serve nessuna azione.',
        )
      }
      continue
    }
    const parts = [
      `consegna "${action.name}" [${delivery.outcome}]`,
      `fase=${delivery.phase}`,
      `attempt=${delivery.attemptId}`,
      `codice=${delivery.errorCode ?? '-'}`,
    ]
    if (delivery.httpStatus !== undefined) parts.push(`http=${delivery.httpStatus}`)
    if (delivery.serverErrorCode) parts.push(`server=${delivery.serverErrorCode}`)
    parts.push(`review=${delivery.reviewStatus}${delivery.reviewDetail ? ` (${delivery.reviewDetail})` : ''}`, `stdout=${delivery.stdoutBytes}B${delivery.stdoutTruncated ? ' troncato' : ''}`)
    // A log that could not be written must be said HERE, otherwise the old silence comes back.
    if (!delivery.logAppended) parts.push("ATTENZIONE: esito non scritto nel log dell'azione")
    parts.push(`log=${action.logPath}`)
    lines.push(parts.join(' '))
  }
  for (const failure of result.flowFailures) {
    lines.push(`step coda "${failure.name}" fallito: ${failure.detail}`)
  }
  return lines
}

export interface DaemonOptions {
  playbookFile: string
  stateFile: string
  logDir: string
  lockFile: string
  intervalMs?: number
  label?: string
  secrets?: SecretCapabilities
  spawn?: SpawnFn
  isAlive?: IsAlive
  heartbeat?: (ok: boolean, stops?: PreflightStop[]) => Promise<void>
  /** Interval of the cycle-independent beat (CYAU-120); default `DEFAULT_HEARTBEAT_INTERVAL_MS`. */
  heartbeatIntervalMs?: number
  /** Ticket-level coordinator/gate: propagated to runOnce before any runtime start. */
  preflight?: ActionPreflightFn
  /** Queue deferral probe (CYAU-101): forwarded to runOnce, which uses it best-effort on the stops. */
  deferQueue?: RunOnceOptions['deferQueue']
  /** Atomic queue claim (CYAU-169): forwarded to runOnce, which uses it to fill the slots. */
  claimQueue?: RunOnceOptions['claimQueue']
  githubToken?: RunOnceOptions['githubToken']
  /** Skill-mode (CYAU-69): forwarded to runOnce → dispatch via bounded pool; default `skillsModeEnabled()`. */
  skillsMode?: RunOnceOptions['skillsMode']
  /** Per-step concurrency cap in skill-mode (`limits.max_parallel`); resolver invoked by runOnce only in skill-mode. */
  flowMaxParallel?: RunOnceOptions['flowMaxParallel']
  // API-driven sync: when present, at every round it fetches the agents from CloseYourIt and uses the playbook
  // generated from the host-scoped manifest instead of the local file. null from sync() = nothing to run (skip the round).
  sync?: SyncFn
  /** CYAU-235 — one supporter pass per round, before the work: answers an open question round if there is one. */
  supporter?: (signal: AbortSignal) => Promise<void>
  // Injectable for tests / control:
  now?: () => Date
  sleep?: (ms: number, signal: AbortSignal) => Promise<void>
  maxIterations?: number
  registerSignals?: boolean // default true; false in tests so as not to install global handlers
  abortSignal?: AbortSignal // external programmatic stop (besides SIGTERM/SIGINT)
  log?: (message: string) => void
  onIteration?: (result: RunOnceResult) => void
}

export function defaultSleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal.aborted) {
      resolve()
      return
    }
    const timer = setTimeout(resolve, ms)
    signal.addEventListener(
      'abort',
      () => {
        clearTimeout(timer)
        resolve()
      },
      {once: true},
    )
  })
}

export interface HeartbeatKeepaliveOptions {
  beat: (ok: boolean, stops?: PreflightStop[]) => Promise<void>
  /** Outcome of the last completed round: the beat says the machine is alive, not that all is well. */
  lastOk: () => boolean
  /** Last preflight blocks seen by the last round (CYAU-116): the independent beat repeats them so
   *  the reason stays on the panel even between ticks. Optional/undefined = no round completed. */
  lastStops?: () => PreflightStop[] | undefined
  intervalMs: number
  signal: AbortSignal
  sleep: (ms: number, signal: AbortSignal) => Promise<void>
}

/**
 * Cycle-independent beat (CYAU-120).
 *
 * `runOnce` beats as the LAST line of the round: during a Claude session — which lasts minutes — nobody beats,
 * the monitor declares the host offline after three minutes and the server denies every later claim with
 * `403 R403-AGENT-006` (`Agents::Hosts::Eligibility` requires `heartbeat_online?`). The result observed on
 * minion-1: the first project of the map worked, the others stayed stopped for days with thousands of stops
 * the log attributed to the lease instead of to liveness.
 *
 * The keepalive beats RIGHT AWAY (at boot the first round can last minutes: the machine is alive before having
 * completed anything) and then at every interval, until the abort arrives. It is best-effort by construction: a
 * lost beat stops neither the keepalive nor the daemon, like every other beat.
 */
export async function runHeartbeatKeepalive(opts: HeartbeatKeepaliveOptions): Promise<void> {
  while (!opts.signal.aborted) {
    try {
      await opts.beat(opts.lastOk(), opts.lastStops?.())
    } catch {
      // Network down or server hung: retry at the next beat. Never kill the loop over a ping.
    }

    if (opts.signal.aborted) break
    await opts.sleep(opts.intervalMs, opts.signal)
  }
}

export async function runDaemon(opts: DaemonOptions): Promise<void> {
  const intervalMs = opts.intervalMs ?? DEFAULT_INTERVAL_MS
  const now = opts.now ?? (() => new Date())
  const sleep = opts.sleep ?? defaultSleep
  const log = opts.log ?? (() => undefined)
  const controller = new AbortController()

  const stop = (): void => controller.abort()
  const register = opts.registerSignals ?? true
  if (register) {
    process.on('SIGTERM', stop)
    process.on('SIGINT', stop)
  }
  if (opts.abortSignal) {
    if (opts.abortSignal.aborted) controller.abort()
    else opts.abortSignal.addEventListener('abort', stop, {once: true})
  }

  log(`daemon avviato (intervallo ${intervalMs}ms)`)

  // `runOnce` decides the outcome (the only definition of "round went well"): here only the last value seen
  // is observed, so the keepalive neither invents its own `ok` nor masks a failed round. Same treatment
  // for the preflight stops (CYAU-116): the keepalive repeats them between ticks with their last value.
  let lastOk = true
  let lastStops: PreflightStop[] | undefined
  const beat = opts.heartbeat
  const observedBeat = beat
    ? async (ok: boolean, stops?: PreflightStop[]): Promise<void> => {
        lastOk = ok
        lastStops = stops
        await beat(ok, stops)
      }
    : undefined
  // Deliberately not awaited: it lives as long as the loop and ends with the abort (SIGTERM/SIGINT or programmatic stop).
  const keepalive = beat
    ? runHeartbeatKeepalive({
        beat,
        lastOk: () => lastOk,
        lastStops: () => lastStops,
        intervalMs: opts.heartbeatIntervalMs ?? DEFAULT_HEARTBEAT_INTERVAL_MS,
        signal: controller.signal,
        sleep,
      })
    : undefined

  let iterations = 0
  try {
    while (!controller.signal.aborted) {
      try {
        let playbook: Playbook | null
        let authorizedCwds: Record<string, string> | undefined
        let ticketQueues: Record<string, TicketQueueTarget> | undefined
        if (opts.sync) {
          const synced = await opts.sync()
          playbook = synced?.playbook ?? null
          authorizedCwds = synced?.authorizedCwds
          ticketQueues = synced?.ticketQueues
        } else {
          playbook = loadPlaybook(opts.playbookFile)
        }

        // A supporter pass never stops the round: it only proposes answers the server judges.
        if (opts.supporter) await opts.supporter(controller.signal)

        if (playbook) {
          const result = await runOnce({
            playbook,
            playbookDir: path.dirname(opts.playbookFile),
            now: now(),
            stateFile: opts.stateFile,
            logDir: opts.logDir,
            lockFile: opts.lockFile,
            label: opts.label,
            spawn: opts.spawn,
            secrets: opts.secrets,
            isAlive: opts.isAlive,
            heartbeat: observedBeat,
            authorizedCwds,
            ticketQueues,
            preflight: opts.preflight,
            deferQueue: opts.deferQueue,
            claimQueue: opts.claimQueue,
            githubToken: opts.githubToken,
            // Skill-mode (CYAU-69): forwards gate and cap; runOnce resolves the cap ONLY in skill-mode (no
            // policy call in prompt-mode). The resolver is re-evaluated at every iteration (the policy can change).
            skillsMode: opts.skillsMode,
            flowMaxParallel: opts.flowMaxParallel,
            // Cooperative shutdown: the loop abort ends the running action and records its cancel,
            // instead of letting it complete while the service is stopping.
            signal: controller.signal,
          })
          opts.onIteration?.(result)
          for (const line of formatIterationLines(result)) log(line)
          if (result.executed.length > 0 || result.seeded.length > 0) {
            log(`iterazione: eseguite ${result.executed.length}, seminate ${result.seeded.length}`)
          }
        }
      } catch (error) {
        // Invalid playbook at runtime or unexpected error: do not kill the daemon.
        const message = error instanceof AutomatorError ? `${error.code}: ${error.message}` : String(error)
        log(`errore iterazione (continuo): ${message}`)
      }

      iterations += 1
      if (opts.maxIterations !== undefined && iterations >= opts.maxIterations) break
      if (controller.signal.aborted) break
      await sleep(intervalMs, controller.signal)
    }
  } finally {
    // The loop can exit because of `maxIterations` without anyone aborting: without this, the keepalive
    // would hang on its own sleep and keep the process alive.
    controller.abort()
    await keepalive
    if (register) {
      process.off('SIGTERM', stop)
      process.off('SIGINT', stop)
    }
    log('daemon fermato')
  }
}
