import {spawn as nodeSpawn, spawnSync} from 'node:child_process'
import {readdirSync, readFileSync, realpathSync, statSync} from 'node:fs'
import {dirname} from 'node:path'
import {performance} from 'node:perf_hooks'
import {type ChildLike, type SpawnFn} from './executor'
import {redactSecrets} from './secret-redaction'

export const DEFAULT_PROBE_TIMEOUT_MS = 5000
export const DEFAULT_PROBE_KILL_GRACE_MS = 250
export const DEFAULT_PROBE_CLEANUP_POLL_MS = 10
export const DEFAULT_PROBE_CLEANUP_TIMEOUT_MS = 250
const MAX_CAPTURE_BYTES = 8192
const MAX_SUPERVISOR_CONTROL_BYTES = 1024

// The supervisor stays leader of the process group until the cleanup. It reports the command's exit on fd 3 (which the
// command does not inherit), then atomically SIGKILLs its own group, itself included: the PGID cannot be
// reused between the command's close and the cleanup.
const PROCESS_GROUP_SUPERVISOR = String.raw`
trap ':' TERM INT
# The payload uses fd 4: POSIX may connect fd 0 of an async list to /dev/null when job control is off.
# The command also closes the control fds, so a descendant cannot keep the supervisor's pipes alive.
"$@" <&4 4<&- 3>&- >&1 2>&2 &
child=$!
wait "$child"
code=$?
if [ "$code" -eq 127 ]; then
  printf '{"code":null,"error":"spawn"}' >&3
else
  printf '{"code":%s}' "$code" >&3
fi
/bin/kill -KILL -- "-$$" 2>/dev/null || exit 125
`

export type ProbeKillFn = (pid: number, signal: NodeJS.Signals) => void
export type ProbeGroupAliveFn = (pgid: number) => boolean

function resolveTrustedSystemExecutable(candidate: string): string {
  const canonical = realpathSync(candidate)
  let cursor = canonical
  let executable = true
  while (true) {
    const metadata = statSync(cursor)
    if (metadata.uid !== 0 || (metadata.mode & 0o022) !== 0) {
      throw new Error(`eseguibile di sistema non fidato: ${candidate}`)
    }
    if (executable && (!metadata.isFile() || (metadata.mode & 0o111) === 0)) {
      throw new Error(`eseguibile di sistema non valido: ${candidate}`)
    }
    if (cursor === '/') return canonical
    cursor = dirname(cursor)
    executable = false
  }
}

function linuxGroupHasExecutableMembers(pgid: number): boolean {
  let entries: string[]
  try {
    entries = readdirSync('/proc')
  } catch {
    return true
  }
  for (const entry of entries) {
    if (!/^\d+$/.test(entry)) continue
    try {
      // /proc/<pid>/stat: pid (comm) state ppid pgrp ...; `comm` can contain spaces and parentheses.
      const match = /^\d+ \(.*\) (\S) \d+ (\d+) /.exec(readFileSync(`/proc/${entry}/stat`, 'utf8'))
      if (match && Number(match[2]) === pgid && match[1] !== 'Z' && match[1] !== 'X') return true
    } catch {
      // The process may have disappeared between readdir and readFile.
    }
  }
  return false
}

function defaultGroupHasExecutableMembers(pgid: number, remainingMs = 1000): boolean {
  if (remainingMs <= 0) throw new Error('deadline bonifica process group scaduta')
  if (process.platform === 'win32') return false
  try {
    process.kill(-pgid, 0)
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code
    if (code === 'ESRCH') return false
    // EPERM proves the group exists; reading the states below stays fail-closed if it is not allowed.
    if (code !== 'EPERM') throw error
  }

  // After SIGKILL the kernel may briefly keep in the group only zombies that are already unschedulable. `kill(..., 0)`
  // still considers them existing: on Linux we read only state/pgrp from procfs, never cmdline or environment.
  if (process.platform === 'linux') return linuxGroupHasExecutableMembers(pgid)

  // ps reads only the state column, never command line or environment.
  const ps = spawnSync(resolveTrustedSystemExecutable('/bin/ps'), ['-o', 'state=', '-g', String(pgid)], {
    encoding: 'utf8',
    timeout: Math.max(1, Math.min(1000, Math.floor(remainingMs))),
    maxBuffer: 8192,
    env: {PATH: '/usr/bin:/bin', LANG: 'C', LC_ALL: 'C'},
  })
  if (ps.status === 0) {
    const states = ps.stdout.split(/\s+/).filter(Boolean)
    return states.some((state) => state[0] !== 'Z')
  }

  // The group may have disappeared between the first probe and ps; reconfirm without approving on ambiguous errors.
  try {
    process.kill(-pgid, 0)
    return true
  } catch (error) {
    return (error as NodeJS.ErrnoException).code !== 'ESRCH'
  }
}

export interface ProcessProbeOptions {
  spawn?: SpawnFn
  kill?: ProbeKillFn
  /** Testable override of the check for group members still runnable. Receives a positive PGID. */
  groupAlive?: ProbeGroupAliveFn
  /** Interval between the checks that the group no longer contains schedulable members after SIGKILL. */
  cleanupPollMs?: number
  /** Fail-closed limit of the post-SIGKILL check: avoids infinite waits if the OS probe stays ambiguous. */
  cleanupTimeoutMs?: number
  /** Test-only override: in production a cleanup not proven within the budget fail-stops the Automator. */
  onCleanupFailure?: () => void
  /** Platform override to test the non-POSIX backend without depending on the suite's host. */
  platform?: NodeJS.Platform
  timeoutMs?: number
  killGraceMs?: number
  cwd?: string
  env?: NodeJS.ProcessEnv
  /** Payload written to stdin and never exposed in argv/process list. */
  input?: string
  /** Only for immutable internal payloads (e.g. Git diffs): keeps redaction from changing their bytes. Default true. */
  redactOutput?: boolean
  /** Cooperative cancellation: ends the whole process group like the timeout, but distinguishes it in the outcome. */
  signal?: AbortSignal
  /** Stdout limit for probes that return a structured payload (default 8 KiB). */
  maxCaptureBytes?: number
  /** Opt-in: keep only the last N bytes of stderr (redacted) so a caller can explain a nonzero exit. Default 0. */
  stderrTailBytes?: number
  /** Final stdout decoding; `latin1` lets the caller rebuild every byte exactly. */
  outputEncoding?: BufferEncoding
  /** Monotonic clock that tests can simulate; also used to reject close/error arriving past the deadline. */
  now?: () => number
  /** Absolute monotonic deadline shared by the caller; avoids extending it by rebuilding it from the remaining time. */
  deadlineMs?: number
}

export interface ProcessProbeResult {
  code: number | null
  stdout: string
  timedOut: boolean
  /** true if at least one stdout byte was not captured: the caller must never trust the prefix. */
  truncated: boolean
  /** Raw bytes actually captured before decoding/redaction. */
  capturedBytes: number
  aborted?: boolean
  error?: string
  /** Redacted tail of stderr, present only when `stderrTailBytes` was requested. */
  stderrTail?: string
}

interface SupervisorOutcome {
  code: number | null
  signal?: string | null
  error?: 'spawn'
}

/**
 * Runs a short probe in a dedicated process group. Timeout and cancellation end the whole group
 * SIGTERM→SIGKILL and the result is resolved only after no schedulable members remain in the group.
 * stdout is bounded and stays for the caller's use, never used as runtime diagnostics.
 */
export function runProcessProbe(
  cmd: string,
  args: string[],
  options: ProcessProbeOptions = {},
): Promise<ProcessProbeResult> {
  const kill = options.kill ?? ((pid, signal) => process.kill(pid, signal))
  const timeoutMs = options.timeoutMs ?? DEFAULT_PROBE_TIMEOUT_MS
  const killGraceMs = options.killGraceMs ?? DEFAULT_PROBE_KILL_GRACE_MS
  const cleanupPollMs = options.cleanupPollMs ?? DEFAULT_PROBE_CLEANUP_POLL_MS
  const cleanupTimeoutMs = options.cleanupTimeoutMs ?? Math.min(
    DEFAULT_PROBE_CLEANUP_TIMEOUT_MS,
    Math.max(0, (timeoutMs - killGraceMs) / 2),
  )
  const maxCaptureBytes = options.maxCaptureBytes ?? MAX_CAPTURE_BYTES
  const now = options.now ?? (() => performance.now())
  const deadline = options.deadlineMs ?? now() + timeoutMs
  const platform = options.platform ?? process.platform

  return new Promise((resolve) => {
    const stdoutChunks: Buffer[] = []
    let stdoutBytes = 0
    const stderrTailBytes = options.stderrTailBytes ?? 0
    let stderrTail = Buffer.alloc(0)
    let truncated = false
    let settled = false
    let timeout: ReturnType<typeof setTimeout> | undefined
    let forceKill: ReturnType<typeof setTimeout> | undefined
    let cleanupPoll: ReturnType<typeof setTimeout> | undefined
    let cleanupDeadline: number | undefined
    let onAbort: (() => void) | undefined
    let stdinCompleted = options.input === undefined
    let successfulClosePending = false
    let terminating = false
    let completingTermination = false
    let leaderClosed = false
    let supervisorControl = ''
    let supervisorControlTruncated = false
    let cleanupFailureTriggered = false
    let terminationResult: Omit<ProcessProbeResult, 'truncated' | 'capturedBytes'> | undefined

    const capturedStdout = (): string => {
      const output = Buffer.concat(stdoutChunks, stdoutBytes).toString(options.outputEncoding ?? 'utf8')
      return options.redactOutput === false ? output : redactSecrets(output)
    }
    const finish = (result: Omit<ProcessProbeResult, 'truncated' | 'capturedBytes'>): void => {
      // After a timeout the result is already settled, but the process group can contain descendants still alive:
      // the close of the leader alone must NOT cancel the SIGKILL escalation scheduled for the group.
      if (settled) return
      settled = true
      if (timeout) clearTimeout(timeout)
      if (forceKill) clearTimeout(forceKill)
      if (cleanupPoll) clearTimeout(cleanupPoll)
      if (onAbort) options.signal?.removeEventListener('abort', onAbort)
      resolve({
        ...result,
        truncated,
        capturedBytes: stdoutBytes,
        ...(stderrTailBytes > 0 ? {stderrTail: redactSecrets(stderrTail.toString('utf8'))} : {}),
      })
    }

    try {
      if (options.signal?.aborted) {
        finish({code: null, stdout: '', timedOut: false, aborted: true})
        return
      }
      if (timeoutMs <= 0 || now() >= deadline) {
        finish({code: null, stdout: '', timedOut: true})
        return
      }

      const spawnOptions = {
        cwd: options.cwd ?? process.cwd(),
        env: options.env ?? process.env,
        detached: true,
      }
      const supervised = options.spawn === undefined && platform !== 'win32'
      let child: ReturnType<SpawnFn>
      let inputStream: ChildLike['stdin']
      if (supervised) {
        const trustedShell = resolveTrustedSystemExecutable('/bin/sh')
        resolveTrustedSystemExecutable('/bin/kill')
        const actualChild = nodeSpawn(
          trustedShell,
          ['-c', PROCESS_GROUP_SUPERVISOR, 'automator-probe-supervisor', cmd, ...args],
          {
            ...spawnOptions,
            stdio: ['ignore', 'pipe', 'pipe', 'pipe', 'pipe'],
          },
        )
        const control = actualChild.stdio[3]
        control?.on('data', (chunk: Buffer | string) => {
          const value = Buffer.isBuffer(chunk) ? chunk.toString('utf8') : chunk
          const remaining = Math.max(0, MAX_SUPERVISOR_CONTROL_BYTES - Buffer.byteLength(supervisorControl))
          if (Buffer.byteLength(value) > remaining) supervisorControlTruncated = true
          if (remaining > 0) supervisorControl += Buffer.from(value).subarray(0, remaining).toString('utf8')
        })
        control?.on('error', () => { supervisorControlTruncated = true })
        child = actualChild as unknown as ReturnType<SpawnFn>
        inputStream = actualChild.stdio[4] as ChildLike['stdin']
      } else {
        const spawn = options.spawn ?? (nodeSpawn as unknown as SpawnFn)
        child = spawn(cmd, args, {
          ...spawnOptions,
          stdio: [options.input === undefined ? 'ignore' : 'pipe', 'pipe', 'pipe'],
        })
        inputStream = child.stdin
      }

      const readSupervisorOutcome = (): SupervisorOutcome | null => {
        if (!supervised || supervisorControlTruncated) return null
        try {
          const parsed = JSON.parse(supervisorControl) as Partial<SupervisorOutcome>
          if (!Object.prototype.hasOwnProperty.call(parsed, 'code')) return null
          if (parsed.code !== null && !Number.isSafeInteger(parsed.code)) return null
          if (parsed.error !== undefined && parsed.error !== 'spawn') return null
          if (parsed.signal !== undefined && parsed.signal !== null && typeof parsed.signal !== 'string') return null
          return {code: parsed.code as number | null, signal: parsed.signal, error: parsed.error}
        } catch {
          return null
        }
      }

      const groupAlive = options.groupAlive ?? (options.kill || options.spawn
        // Injected dependencies indicate a fake process: do not probe by mistake a real PGID with the same number.
        ? (() => false)
        : ((pgid) => defaultGroupHasExecutableMembers(pgid, deadline - now())))

      const isGroupAlive = (): boolean => {
        const pid = child.pid
        return pid !== undefined && pid > 0 && platform !== 'win32' && groupAlive(pid)
      }

      const signal = (value: NodeJS.Signals, allowDirectFallback = !leaderClosed): boolean => {
        const pid = child.pid
        if (!leaderClosed && pid && pid > 0 && platform !== 'win32') {
          try {
            kill(-pid, value)
            return true
          } catch {
            // The group may already have ended; the direct kill is the best-effort fallback.
          }
        }
        if (!allowDirectFallback) return false
        try {
          return child.kill(value)
        } catch {
          // The process already closed: the probe is concluded anyway.
          return false
        }
      }

      const finishWhenGroupIsGone = (): void => {
        if (settled || !terminationResult) return
        cleanupDeadline ??= Math.min(deadline, now() + cleanupTimeoutMs)
        try {
          if (!isGroupAlive()) {
            finish(terminationResult)
            return
          }
        } catch {
          // A transient check cannot turn into an approval: retry until the disappearance is proven.
        }
        if (now() >= cleanupDeadline) {
          if (!cleanupFailureTriggered) {
            cleanupFailureTriggered = true
            ;(options.onCleanupFailure ?? (() => { process.kill(process.pid, 'SIGKILL') }))()
          }
          // The default does not return. A test override must make the liveness false before returning.
          if (!isGroupAlive()) {
            finish({
              ...terminationResult,
              error: terminationResult.error ?? 'bonifica process group non verificabile entro il limite',
            })
            return
          }
        }
        cleanupPoll = setTimeout(finishWhenGroupIsGone, cleanupPollMs)
      }

      const completeTermination = (): void => {
        if (settled || completingTermination || !terminationResult) return
        completingTermination = true
        if (forceKill) {
          clearTimeout(forceKill)
          forceKill = undefined
        }
        signal('SIGKILL', !leaderClosed)
        // Sending is not terminating: wait until no schedulable members remain (zombies are dead).
        finishWhenGroupIsGone()
      }

      const terminate = (
        result: Omit<ProcessProbeResult, 'truncated' | 'capturedBytes'>,
        immediate = false,
      ): void => {
        if (settled || terminating) return
        // Record the authoritative outcome first: a synchronous close caused by the SIGTERM cannot replace it.
        terminating = true
        terminationResult = result
        if (immediate) {
          // After close no signal is ever sent: in production the supervisor already cleaned up the group
          // while keeping its PGID anchored. It only remains to prove there are no schedulable members.
          completingTermination = true
          finishWhenGroupIsGone()
          return
        }

        // Timeout/cancellation wait for a bounded grace. The Promise resolves only after SIGKILL or
        // after the synchronous confirmation that no reachable process exists any more.
        const killDeadline = deadline - cleanupTimeoutMs
        const graceRemaining = killDeadline - now()
        forceKill = graceRemaining > 0 ? setTimeout(completeTermination, Math.min(killGraceMs, graceRemaining)) : undefined
        const reachedProcess = signal('SIGTERM')
        if (graceRemaining <= 0) {
          completeTermination()
        } else if (!reachedProcess) {
          clearTimeout(forceKill)
          forceKill = undefined
          try {
            if (isGroupAlive()) completeTermination()
            else finish(result)
          } catch {
            completeTermination()
          }
        }
      }

      const failStdin = (error: Error): void => {
        if (now() >= deadline) {
          terminate({code: null, stdout: '', timedOut: true})
          return
        }
        terminate({
          code: null,
          stdout: capturedStdout(),
          timedOut: false,
          error: redactSecrets(error.message),
        })
      }
      inputStream?.on?.('error', failStdin)
      if (supervised && options.input === undefined) inputStream?.end()
      if (options.input !== undefined) {
        if (!inputStream) {
          terminate({code: null, stdout: '', timedOut: false, error: 'stdin reviewer non disponibile'})
        } else {
          try {
            inputStream.end(options.input, (error) => {
              if (error) {
                failStdin(error)
                return
              }
              stdinCompleted = true
              if (successfulClosePending) {
                if (now() >= deadline) terminate({code: null, stdout: '', timedOut: true})
                else terminate({code: 0, stdout: capturedStdout(), timedOut: false}, true)
              }
            })
          } catch (error) {
            failStdin(error instanceof Error ? error : new Error(String(error)))
          }
        }
      }
      if (settled) return

      child.stdout?.on('data', (chunk) => {
        const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
        const remaining = Math.max(0, maxCaptureBytes - stdoutBytes)
        if (buffer.length > remaining) truncated = true
        if (remaining > 0) {
          const accepted = buffer.subarray(0, remaining)
          stdoutChunks.push(accepted)
          stdoutBytes += accepted.length
        }
      })
      // stderr is drained but not kept: it must not enter the diagnostic output.
      // Exception: an explicit opt-in keeps a bounded tail, redacted before it leaves the probe.
      child.stderr?.on('data', (chunk) => {
        if (stderrTailBytes <= 0) return
        const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
        const joined = Buffer.concat([stderrTail, buffer])
        stderrTail = joined.subarray(Math.max(0, joined.length - stderrTailBytes))
      })
      child.on('error', (error) => {
        if (now() >= deadline) {
          terminate({code: null, stdout: '', timedOut: true})
          return
        }
        terminate({
          code: null,
          stdout: capturedStdout(),
          timedOut: false,
          error: redactSecrets(error.message),
        })
      })
      child.on('close', (code) => {
        leaderClosed = true
        if (terminating) {
          if (completingTermination) return
          if (supervised) {
            const supervisorOutcome = readSupervisorOutcome()
            if (supervisorOutcome !== null && !supervisorOutcome.error) {
              completingTermination = true
              finishWhenGroupIsGone()
              return
            }
            // Without the supervisor we can no longer safely signal the PGID, which the kernel may reuse.
            // The fail-stop prevents the Automator from continuing while unverified group members are alive.
            cleanupDeadline = now()
            finishWhenGroupIsGone()
            return
          }
          try {
            if (!isGroupAlive()) {
              if (forceKill) clearTimeout(forceKill)
              forceKill = undefined
              finish(terminationResult as Omit<ProcessProbeResult, 'truncated' | 'capturedBytes'>)
            } else {
              if (forceKill) clearTimeout(forceKill)
              forceKill = undefined
              cleanupDeadline = now()
              finishWhenGroupIsGone()
            }
          } catch {
            if (forceKill) clearTimeout(forceKill)
            forceKill = undefined
            cleanupDeadline = now()
            finishWhenGroupIsGone()
          }
          return
        }
        if (settled) {
          return
        }
        if (now() >= deadline) {
          terminate({code: null, stdout: '', timedOut: true}, true)
          return
        }
        const supervisorOutcome = supervised ? readSupervisorOutcome() : {code}
        const effectiveCode = supervisorOutcome?.code ?? null
        if (supervised && (supervisorOutcome === null || supervisorOutcome.error)) {
          terminate({code: null, stdout: capturedStdout(), timedOut: false, error: 'supervisor probe non valido'}, true)
          return
        }
        if (effectiveCode === 0 && !stdinCompleted) {
          successfulClosePending = true
          return
        }
        // Even after the leader's close, descendants can remain in the group. The uniform cleanup also makes safe
        // the outcomes that will be downgraded after the probe (malformed output or failed cleanup).
        terminate({code: effectiveCode, stdout: capturedStdout(), timedOut: false}, true)
      })
      if (settled) return

      const expire = (): void => {
        terminate({code: null, stdout: '', timedOut: true})
      }

      onAbort = () => {
        terminate({code: null, stdout: '', timedOut: false, aborted: true})
      }
      options.signal?.addEventListener('abort', onAbort, {once: true})
      // Covers the abort that happened between the pre-spawn check and the listener registration.
      if (options.signal?.aborted) {
        onAbort()
        return
      }
      // Reserve both the grace and the post-SIGKILL check inside the absolute deadline.
      const remaining = deadline - killGraceMs - cleanupTimeoutMs - now()
      if (remaining <= 0) expire()
      else timeout = setTimeout(expire, remaining)
    } catch (error) {
      finish({
        code: null,
        stdout: '',
        timedOut: false,
        error: redactSecrets(error instanceof Error ? error.message : String(error)),
      })
    }
  })
}
