import {spawnSync} from 'node:child_process'
import {afterEach, describe, expect, it, vi} from 'vitest'
import {type ChildLike, type SpawnFn} from '../src/lib/executor'
import {runProcessProbe} from '../src/lib/process-probe'

afterEach(() => {
  vi.useRealTimers()
  vi.restoreAllMocks()
})

describe('runProcessProbe — process group escalation after timeout', () => {
  it('does not consult the wall clock for the default deadlines', async () => {
    const wallClock = vi.spyOn(Date, 'now').mockReturnValueOnce(10_000).mockReturnValue(-10_000)
    const spawn: SpawnFn = () => ({
      stdout: null,
      stderr: null,
      on: (event, cb) => {
        if (event === 'close') queueMicrotask(() => (cb as (code: number) => void)(0))
      },
      kill: () => false,
    })

    expect(await runProcessProbe('tool', [], {spawn})).toMatchObject({code: 0, timedOut: false})
    expect(wallClock).not.toHaveBeenCalled()
  })

  it.runIf(process.platform !== 'win32')(
    'real timeout and OS cleanup stay within the absolute deadline with a scheduling margin',
    async () => {
      const startedAt = performance.now()
      const result = await runProcessProbe(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], {
        timeoutMs: 3000,
        killGraceMs: 250,
        cleanupTimeoutMs: 1000,
      })
      const elapsed = performance.now() - startedAt

      expect(result).toMatchObject({timedOut: true})
      expect(elapsed).toBeLessThan(3500)
    },
    5000,
  )

  it('sends the payload via stdin without putting it in the argv', async () => {
    let written = ''
    let stdinMode: string | undefined
    const spawn: SpawnFn = (_cmd, args, options) => {
      expect(args).toEqual(['review'])
      stdinMode = options.stdio[0]
      return {
        stdin: {end: (data = '', callback) => { written = data; callback?.() }},
        stdout: null,
        stderr: null,
        on: (event, cb) => {
          if (event === 'close') queueMicrotask(() => (cb as (code: number) => void)(0))
        },
        kill: () => true,
      }
    }

    await runProcessProbe('tool', ['review'], {spawn, input: 'diff riservato'})
    expect(stdinMode).toBe('pipe')
    expect(written).toBe('diff riservato')
  })

  it('the non-POSIX backend uses the default Node spawn even without an injected function', async () => {
    const result = await runProcessProbe(process.execPath, ['-e', 'process.stdout.write("backend-default")'], {
      platform: 'win32',
      timeoutMs: 3000,
    })

    expect(result).toMatchObject({code: 0, stdout: 'backend-default', timedOut: false})
  })

  it('caps stdout in raw bytes and always reports the truncation before the redaction', async () => {
    const spawn: SpawnFn = () => ({
      stdout: {on: (_event, cb) => cb(Buffer.from('€€'))},
      stderr: null,
      on: (event, cb) => {
        if (event === 'close') queueMicrotask(() => (cb as (code: number) => void)(0))
      },
      kill: () => true,
    })

    const result = await runProcessProbe('tool', [], {spawn, maxCaptureBytes: 4})
    expect(result.truncated).toBe(true)
    expect(result.capturedBytes).toBe(4)
  })

  it('can return reversible latin1 stdout without losing non-UTF-8 bytes', async () => {
    const bytes = Buffer.from([0x61, 0xff, 0x62])
    const spawn: SpawnFn = () => ({
      stdout: {on: (_event, cb) => cb(bytes)},
      stderr: null,
      on: (event, cb) => {
        if (event === 'close') queueMicrotask(() => (cb as (code: number) => void)(0))
      },
      kill: () => true,
    })

    const result = await runProcessProbe('tool', [], {spawn, outputEncoding: 'latin1', redactOutput: false})
    expect(Buffer.from(result.stdout, 'latin1')).toEqual(bytes)
  })

  it('turns an asynchronous EPIPE on stdin into a failed outcome without unhandled exceptions', async () => {
    vi.useFakeTimers()
    let stdinError: ((error: Error) => void) | undefined
    const signals: Array<{pid: number; signal: NodeJS.Signals}> = []
    const spawn: SpawnFn = () => ({
      pid: 505,
      stdin: {
        on: (_event, cb) => { stdinError = cb },
        end: () => queueMicrotask(() => stdinError?.(Object.assign(new Error('broken pipe'), {code: 'EPIPE'}))),
      },
      stdout: null,
      stderr: null,
      on: () => undefined,
      kill: () => true,
    })

    const pending = runProcessProbe('tool', [], {
      spawn,
      input: 'payload grande',
      killGraceMs: 20,
      kill: (pid, signal) => signals.push({pid, signal}),
    })
    await vi.advanceTimersByTimeAsync(0)
    expect(signals).toEqual([{pid: -505, signal: 'SIGTERM'}])
    await vi.advanceTimersByTimeAsync(20)
    expect(await pending).toMatchObject({code: null, timedOut: false, error: 'broken pipe'})
    expect(signals).toEqual([
      {pid: -505, signal: 'SIGTERM'},
      {pid: -505, signal: 'SIGKILL'},
    ])
  })

  it('does not accept close zero before the complete write on stdin is confirmed', async () => {
    let stdinError: ((error: Error) => void) | undefined
    let close: ((code: number | null, signal: NodeJS.Signals | null) => void) | undefined
    let settled = false
    const spawn: SpawnFn = () => ({
      stdin: {
        on: (_event, cb) => { stdinError = cb },
        end: () => undefined,
      },
      stdout: null,
      stderr: null,
      on: (event, cb) => {
        if (event === 'close') close = cb as typeof close
      },
      kill: () => true,
    })

    const pending = runProcessProbe('tool', [], {spawn, input: 'payload completo'}).then((result) => {
      settled = true
      return result
    })
    close?.(0, null)
    await Promise.resolve()
    expect(settled).toBe(false)
    stdinError?.(new Error('pipe chiusa prima del payload completo'))

    expect(await pending).toMatchObject({code: null, error: 'pipe chiusa prima del payload completo'})
  })

  it('terminates the process group if stdin.end throws synchronously', async () => {
    vi.useFakeTimers()
    const signals: Array<{pid: number; signal: NodeJS.Signals}> = []
    const spawn: SpawnFn = () => ({
      pid: 507,
      stdin: {
        end: () => { throw new Error('write sincrona fallita') },
      },
      stdout: null,
      stderr: null,
      on: () => undefined,
      kill: () => true,
    })

    const pending = runProcessProbe('tool', [], {
      spawn,
      input: 'payload completo',
      killGraceMs: 20,
      kill: (pid, signal) => signals.push({pid, signal}),
    })

    expect(signals).toEqual([{pid: -507, signal: 'SIGTERM'}])
    await vi.advanceTimersByTimeAsync(20)
    expect(await pending).toMatchObject({code: null, error: 'write sincrona fallita'})
    expect(signals).toEqual([
      {pid: -507, signal: 'SIGTERM'},
      {pid: -507, signal: 'SIGKILL'},
    ])
  })

  it.each([0, 1])('does not signal a PGID already gone after close with exit code %i', async (exitCode) => {
    const signals: Array<{pid: number; signal: NodeJS.Signals}> = []
    const spawn: SpawnFn = () => ({
      pid: 508,
      stdout: null,
      stderr: null,
      on: (event, cb) => {
        if (event === 'close') queueMicrotask(() => (cb as (code: number) => void)(exitCode))
      },
      kill: () => true,
    })

    expect(await runProcessProbe('tool', [], {
      spawn,
      killGraceMs: 20,
      kill: (pid, signal) => signals.push({pid, signal}),
    })).toMatchObject({code: exitCode, timedOut: false})
    expect(signals).toEqual([])
  })

  it('after close no longer signals the PGID and waits for the supervisor to prove its cleanup', async () => {
    vi.useFakeTimers()
    const signals: Array<{pid: number; signal: NodeJS.Signals}> = []
    let alive = true
    let settled = false
    const spawn: SpawnFn = () => ({
      pid: 508,
      stdout: null,
      stderr: null,
      on: (event, cb) => {
        if (event === 'close') queueMicrotask(() => (cb as (code: number) => void)(0))
      },
      kill: () => true,
    })

    const pending = runProcessProbe('tool', [], {
      spawn,
      cleanupPollMs: 5,
      groupAlive: () => alive,
      kill: (pid, signal) => signals.push({pid, signal}),
    }).then((result) => {
      settled = true
      return result
    })
    await vi.advanceTimersByTimeAsync(0)
    expect(signals).toEqual([])
    expect(settled).toBe(false)

    alive = false
    await vi.advanceTimersByTimeAsync(5)
    expect(await pending).toMatchObject({code: 0, timedOut: false})
  })

  it('fails closed within a separate budget if the group check stays always ambiguous', async () => {
    vi.useFakeTimers()
    let cleanupClock = 0
    let alive = true
    let failStopTriggered = false
    const spawn: SpawnFn = () => ({
      pid: 510,
      stdout: null,
      stderr: null,
      on: (event, cb) => {
        if (event === 'close') queueMicrotask(() => (cb as (code: number) => void)(0))
      },
      kill: () => true,
    })

    const pending = runProcessProbe('tool', [], {
      spawn,
      groupAlive: () => alive,
      now: () => cleanupClock,
      cleanupPollMs: 5,
      cleanupTimeoutMs: 20,
      onCleanupFailure: () => {
        failStopTriggered = true
        alive = false
      },
    })
    await vi.advanceTimersByTimeAsync(0)
    cleanupClock = 20
    await vi.advanceTimersByTimeAsync(5)

    expect(await pending).toMatchObject({
      code: 0,
      timedOut: false,
      error: 'bonifica process group non verificabile entro il limite',
    })
    expect(failStopTriggered).toBe(true)
  })

  it('at the global timeout skips the remaining grace and ends fail-closed without passing the deadline', async () => {
    vi.useFakeTimers()
    let clock = 0
    let alive = true
    let failStopTriggered = false
    const signals: NodeJS.Signals[] = []
    const spawn: SpawnFn = () => ({
      pid: 511,
      stdout: null,
      stderr: null,
      on: () => undefined,
      kill: () => true,
    })
    const pending = runProcessProbe('tool', [], {
      spawn,
      now: () => clock,
      timeoutMs: 30,
      killGraceMs: 20,
      cleanupTimeoutMs: 10,
      groupAlive: () => alive,
      kill: (_pid, signal) => signals.push(signal),
      onCleanupFailure: () => {
        failStopTriggered = true
        alive = false
      },
    })

    await vi.advanceTimersByTimeAsync(20)
    expect(signals).toEqual(['SIGTERM', 'SIGKILL'])
    clock = 30
    await vi.advanceTimersByTimeAsync(10)
    expect(await pending).toMatchObject({
      timedOut: true,
      error: 'bonifica process group non verificabile entro il limite',
    })
    expect(signals).toEqual(['SIGTERM', 'SIGKILL'])
    expect(failStopTriggered).toBe(true)
  })

  it('masks multi-letter CloseYourIt namespaces both from stdout and from errors', async () => {
    const stdoutToken = `cyi_ah_${'A'.repeat(24)}`
    const errorToken = `cyi_agent_host_${'B'.repeat(24)}`
    const spawn: SpawnFn = () => ({
      stdout: {on: (_event, cb) => cb(`version ${stdoutToken}`)},
      stderr: null,
      on: (event, cb) => {
        if (event === 'error') queueMicrotask(() => (cb as (error: Error) => void)(new Error(`errore ${errorToken}`)))
      },
      kill: () => true,
    })

    const result = await runProcessProbe('tool', ['--version'], {spawn})
    expect(result.stdout).toContain('[REDACTED]')
    expect(result.error).toContain('[REDACTED]')
    expect(JSON.stringify(result)).not.toContain(stdoutToken)
    expect(JSON.stringify(result)).not.toContain(errorToken)
  })

  it('does not send SIGKILL to a vanished PGID if the leader closes after SIGTERM', async () => {
    vi.useFakeTimers()
    const signals: Array<{pid: number; signal: NodeJS.Signals}> = []
    let close: ((code: number | null, signal: NodeJS.Signals | null) => void) | undefined
    const spawn: SpawnFn = () => {
      const child: ChildLike = {
        pid: 501,
        stdout: null,
        stderr: null,
        on: (event, callback) => {
          if (event === 'close') close = callback as typeof close
        },
        kill: () => true,
      }
      return child
    }

    const pending = runProcessProbe('tool', ['--version'], {
      spawn,
      timeoutMs: 30,
      killGraceMs: 20,
      cleanupTimeoutMs: 0,
      kill: (pid, signal) => {
        signals.push({pid, signal})
        if (signal === 'SIGTERM') queueMicrotask(() => close?.(0, null))
      },
    })

    await vi.advanceTimersByTimeAsync(10)
    expect(await pending).toMatchObject({timedOut: true})
    expect(signals).toEqual([{pid: -501, signal: 'SIGTERM'}])

    await vi.advanceTimersByTimeAsync(20)
    expect(signals).toEqual([{pid: -501, signal: 'SIGTERM'}])
  })

  it('a close during the grace neither approves nor re-signals a PGID still alive', async () => {
    vi.useFakeTimers()
    const signals: Array<{pid: number; signal: NodeJS.Signals}> = []
    let close: ((code: number | null, signal: NodeJS.Signals | null) => void) | undefined
    let alive = true
    let settled = false
    let failStopTriggered = false
    const spawn: SpawnFn = () => ({
      pid: 512,
      stdout: null,
      stderr: null,
      on: (event, callback) => {
        if (event === 'close') close = callback as typeof close
      },
      kill: () => true,
    })

    const pending = runProcessProbe('tool', [], {
      spawn,
      timeoutMs: 30,
      killGraceMs: 20,
      cleanupTimeoutMs: 0,
      groupAlive: () => alive,
      kill: (pid, signal) => signals.push({pid, signal}),
      onCleanupFailure: () => {
        failStopTriggered = true
        alive = false
      },
    }).then((result) => {
      settled = true
      return result
    })

    await vi.advanceTimersByTimeAsync(10)
    expect(signals).toEqual([{pid: -512, signal: 'SIGTERM'}])
    close?.(null, 'SIGTERM')
    await vi.advanceTimersByTimeAsync(0)

    expect(failStopTriggered).toBe(true)
    expect(settled).toBe(true)
    expect(await pending).toMatchObject({timedOut: true, error: 'bonifica process group non verificabile entro il limite'})
    expect(signals).toEqual([{pid: -512, signal: 'SIGTERM'}])
  })

  it('keeps the grace timer referenced until the SIGKILL escalation is complete', async () => {
    vi.useFakeTimers()
    const setTimeoutSpy = vi.spyOn(globalThis, 'setTimeout')
    const controller = new AbortController()
    const spawn: SpawnFn = () => ({
      pid: 502,
      stdout: null,
      stderr: null,
      on: () => undefined,
      kill: () => true,
    })

    const pending = runProcessProbe('tool', ['--version'], {
      spawn,
      signal: controller.signal,
      timeoutMs: 100,
      killGraceMs: 20,
      cleanupTimeoutMs: 10,
      kill: () => undefined,
    })
    controller.abort()
    await vi.advanceTimersByTimeAsync(0)
    const graceCall = setTimeoutSpy.mock.calls.findIndex(([, delay]) => delay === 20)
    const graceTimer = setTimeoutSpy.mock.results[graceCall]?.value as {hasRef?: () => boolean} | undefined
    expect(graceTimer?.hasRef?.()).toBe(true)
    await vi.advanceTimersByTimeAsync(20)
    expect(await pending).toMatchObject({timedOut: false, aborted: true})
  })

  it('a close after the already consumed grace does not send a second SIGKILL', async () => {
    vi.useFakeTimers()
    const signals: Array<{pid: number; signal: NodeJS.Signals}> = []
    let close: ((code: number | null, signal: NodeJS.Signals | null) => void) | undefined
    const spawn: SpawnFn = () => ({
      pid: 509,
      stdout: null,
      stderr: null,
      on: (event, callback) => {
        if (event === 'close') close = callback as typeof close
      },
      kill: () => true,
    })

    const pending = runProcessProbe('tool', [], {
      spawn,
      timeoutMs: 30,
      killGraceMs: 20,
      cleanupTimeoutMs: 0,
      kill: (pid, signal) => signals.push({pid, signal}),
    })
    await vi.advanceTimersByTimeAsync(10)
    await vi.advanceTimersByTimeAsync(20)
    expect(await pending).toMatchObject({timedOut: true})
    expect(signals).toEqual([
      {pid: -509, signal: 'SIGTERM'},
      {pid: -509, signal: 'SIGKILL'},
    ])

    close?.(null, 'SIGKILL')
    expect(signals).toEqual([
      {pid: -509, signal: 'SIGTERM'},
      {pid: -509, signal: 'SIGKILL'},
    ])
  })

  it('AbortSignal distinguishes the cancellation from the timeout and terminates the whole process group', async () => {
    vi.useFakeTimers()
    const controller = new AbortController()
    const signals: Array<{pid: number; signal: NodeJS.Signals}> = []
    const spawn: SpawnFn = () => ({
      pid: 503,
      stdout: null,
      stderr: null,
      on: () => undefined,
      kill: () => true,
    })

    const pending = runProcessProbe('tool', ['review'], {
      spawn,
      signal: controller.signal,
      timeoutMs: 1000,
      killGraceMs: 20,
      kill: (pid, signal) => signals.push({pid, signal}),
    })
    controller.abort()
    await vi.advanceTimersByTimeAsync(0)

    expect(signals).toEqual([{pid: -503, signal: 'SIGTERM'}])
    await vi.advanceTimersByTimeAsync(20)
    expect(await pending).toMatchObject({aborted: true, timedOut: false})
    expect(signals).toEqual([
      {pid: -503, signal: 'SIGTERM'},
      {pid: -503, signal: 'SIGKILL'},
    ])
  })

  it('does not lose an abort happening during the spawn before the listener registration', async () => {
    vi.useFakeTimers()
    const controller = new AbortController()
    const signals: Array<{pid: number; signal: NodeJS.Signals}> = []
    const spawn: SpawnFn = () => {
      controller.abort()
      return {
        pid: 504,
        stdout: null,
        stderr: null,
        on: () => undefined,
        kill: () => true,
      }
    }

    const pending = runProcessProbe('tool', ['review'], {
      spawn,
      signal: controller.signal,
      timeoutMs: 1000,
      killGraceMs: 20,
      kill: (pid, signal) => signals.push({pid, signal}),
    })

    expect(signals).toEqual([{pid: -504, signal: 'SIGTERM'}])
    await vi.advanceTimersByTimeAsync(20)
    expect(await pending).toMatchObject({aborted: true, timedOut: false})
    expect(signals.at(-1)).toEqual({pid: -504, signal: 'SIGKILL'})
  })

  it('rejects a successful close observed past the deadline even if the timer has not fired yet', async () => {
    vi.useFakeTimers()
    let now = 100
    let close: ((code: number | null, signal: NodeJS.Signals | null) => void) | undefined
    const signals: Array<{pid: number; signal: NodeJS.Signals}> = []
    const spawn: SpawnFn = () => ({
      pid: 506,
      stdout: null,
      stderr: null,
      on: (event, callback) => {
        if (event === 'close') close = callback as typeof close
      },
      kill: () => true,
    })

    const pending = runProcessProbe('tool', ['review'], {
      spawn,
      timeoutMs: 10,
      killGraceMs: 0,
      cleanupTimeoutMs: 0,
      now: () => now,
      kill: (pid, signal) => signals.push({pid, signal}),
    })
    now = 111
    close?.(0, null)

    expect(await pending).toMatchObject({code: null, timedOut: true})
    expect(signals).toEqual([])
    await vi.advanceTimersByTimeAsync(20)
    expect(signals).toHaveLength(0)
  })

  it.runIf(process.platform !== 'win32')(
    'does not resolve a natural close until a real descendant of the process group has terminated',
    async () => {
      const source = [
        "const {spawn} = require('node:child_process')",
        "const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], {stdio: 'ignore'})",
        'process.stdout.write(String(child.pid))',
        'child.unref()',
        'setTimeout(() => process.exit(0), 20)',
      ].join(';')
      let descendantPid: number | undefined
      try {
        const result = await runProcessProbe(process.execPath, ['-e', source], {
          timeoutMs: 8000,
          cleanupPollMs: 5,
        })
        descendantPid = Number(result.stdout)
        expect(result).toMatchObject({code: 0, timedOut: false})
        expect(Number.isSafeInteger(descendantPid)).toBe(true)
        const state = spawnSync('/bin/ps', ['-o', 'state=', '-p', String(descendantPid)], {
          encoding: 'utf8',
          env: {PATH: '/usr/bin:/bin', LANG: 'C', LC_ALL: 'C'},
        })
        expect(state.status !== 0 || state.stdout.trim().startsWith('Z')).toBe(true)
      } finally {
        if (descendantPid) {
          try { process.kill(descendantPid, 'SIGKILL') } catch { /* già bonificato */ }
        }
      }
    },
    15_000,
  )

  it.runIf(process.platform !== 'win32')(
    'the real supervisor preserves explicit stdin for the background command',
    async () => {
      const source = "process.stdin.setEncoding('utf8'); let data=''; process.stdin.on('data', c => data += c); process.stdin.on('end', () => process.stdout.write(data))"
      const result = await runProcessProbe(process.execPath, ['-e', source], {
        input: 'payload-review-completo',
        timeoutMs: 8000,
      })
      expect(result).toMatchObject({code: 0, stdout: 'payload-review-completo', timedOut: false})
    },
    15_000,
  )

  it('with an already expired deadline starts no process', async () => {
    const spawn = vi.fn<SpawnFn>()
    const result = await runProcessProbe('tool', ['review'], {spawn, timeoutMs: 0})
    expect(result).toMatchObject({timedOut: true})
    expect(spawn).not.toHaveBeenCalled()
  })
})
