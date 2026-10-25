import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import {spawnSync} from 'node:child_process'
import {afterAll, describe, expect, it, vi} from 'vitest'
import {actionSecretEnv, buildCommand, type ChildLike, resolveActionCwd, runAction, type SpawnFn} from '../src/lib/executor'
import {isManagedSecretEnv} from '../src/lib/env-capabilities'
import {type Action, PlaybookSchema} from '../src/lib/schema'
import {saveManagedServiceConfig} from '../src/lib/managed-service'
import {type StrongContainmentBackend, type StrongContainmentHandle} from '../src/lib/process-containment'
import {normalizeAgentResult} from '../src/lib/agent-result'
import {resetOrgClaudeCredential} from '../src/lib/org-claude-credential'

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'automator-exec-'))
const now = new Date('2026-07-07T00:00:00.000Z')
afterAll(() => fs.rmSync(dir, {recursive: true, force: true}))

/** Builds a typed Action with the defaults applied (via zod). */
function action(partial: Record<string, unknown>): Action {
  return PlaybookSchema.parse({version: 1, actions: {a: {schedule: 'every 1m', ...partial}}}).actions.a
}

interface Behavior {
  stdout?: string
  code?: number | null
  hang?: boolean
  errorEvent?: boolean
  pid?: number
}

function makeSpawn(behaviors: Behavior | Behavior[]): {spawn: SpawnFn; calls: Array<{cmd: string; args: string[]; opts: {cwd: string; env: NodeJS.ProcessEnv; argv0?: string}}>} {
  const queue = Array.isArray(behaviors) ? [...behaviors] : [behaviors]
  const calls: Array<{cmd: string; args: string[]; opts: {cwd: string; env: NodeJS.ProcessEnv; detached?: boolean; argv0?: string}}> = []
  const spawn: SpawnFn = (cmd, args, opts) => {
    calls.push({cmd, args, opts})
    const b = queue.shift() ?? {code: 0}
    let dataCb: ((c: string) => void) | undefined
    let errorCb: ((e: Error) => void) | undefined
    let closeCb: ((code: number | null, sig: NodeJS.Signals | null) => void) | undefined
    const child: ChildLike = {
      pid: b.pid,
      stdout: {on: (_e, cb) => (dataCb = cb)},
      stderr: {on: () => undefined},
      on: (ev, cb) => {
        if (ev === 'error') errorCb = cb as (e: Error) => void
        if (ev === 'close') {
          closeCb = cb as (code: number | null, sig: NodeJS.Signals | null) => void
          if (b.errorEvent) queueMicrotask(() => errorCb?.(new Error('spawn boom')))
          else if (!b.hang)
            queueMicrotask(() => {
              if (b.stdout) dataCb?.(b.stdout)
              closeCb?.(b.code ?? 0, null)
            })
        }
      },
      kill: () => {
        if (b.stdout) dataCb?.(b.stdout)
        closeCb?.(null, 'SIGTERM')
        return true
      },
    }
    return child
  }
  return {spawn, calls}
}

function makeInterleavedSpawn(events: Array<{source: 'stdout' | 'stderr'; chunk: string}>): SpawnFn {
  return () => {
    let stdout: ((chunk: string) => void) | undefined
    let stderr: ((chunk: string) => void) | undefined
    return {
      stdout: {on: (_event, callback) => { stdout = callback }},
      stderr: {on: (_event, callback) => { stderr = callback }},
      on: (event, callback) => {
        if (event === 'close') {
          queueMicrotask(() => {
            for (const item of events) (item.source === 'stdout' ? stdout : stderr)?.(item.chunk)
            ;(callback as (code: number | null, signal: NodeJS.Signals | null) => void)(0, null)
          })
        }
      },
      kill: () => true,
    }
  }
}

describe('buildCommand', () => {
  it('azione shell → sh -c', () => {
    const built = buildCommand(action({type: 'shell', run: 'echo x'}), '/pb')
    expect(built.cmd).toBe('sh')
    expect(built.args).toEqual(['-c', 'echo x'])
  })

  it('claude action → argv with -p, output-format, permission-mode, allowed-tools, model', () => {
    const built = buildCommand(
      action({type: 'claude', run: '/audit', permission_mode: 'plan', allowed_tools: ['Read', 'Bash(cyi:*)'], model: 'sonnet'}),
      '/pb',
    )
    expect(built.cmd).toBe('claude')
    expect(built.args).toEqual([
      '-p',
      '/audit',
      '--output-format',
      'json',
      '--tools',
      'Read,Glob,Grep,Edit,Write,MultiEdit,NotebookEdit',
      '--permission-mode',
      'plan',
      '--allowed-tools',
      'Read',
      '--model',
      'sonnet',
      '--settings',
      expect.stringMatching(/guardrails\/settings\.json$/),
      '--setting-sources',
      '',
    ])
  })

  it('cwd confined in the playbookDir and traversal/absolute rejected', () => {
    expect(buildCommand(action({type: 'shell', run: 'x', cwd: 'rails'}), '/pb').cwd).toBe('/pb/rails')
    expect(() => buildCommand(action({type: 'shell', run: 'x', cwd: '../rails'}), '/pb/sub')).toThrow(/traversal/)
    expect(() => buildCommand(action({type: 'shell', run: 'x', cwd: '/tmp/evil'}), '/pb')).toThrow(/assoluta/)
  })

  it('the synced absolute cwd is accepted only if it matches the authorized host value', () => {
    const synced = action({type: 'codex', run: 'x', cwd: '/repos/authorized', sandbox: 'workspace-write'})
    expect(buildCommand(synced, '/pb', '/g/settings.json', '/repos/authorized').cwd).toBe('/repos/authorized')
    expect(() => buildCommand(synced, '/pb', '/g/settings.json', '/repos/other')).toThrow(/autorizzata/)
  })

  it('claude bypassPermissions → injects authoritative settings and isolates the setting sources', () => {
    const built = buildCommand(
      action({type: 'claude', run: '/x', permission_mode: 'bypassPermissions'}),
      '/pb',
      '/g/settings.json',
    )
    expect(built.args).toContain('--settings')
    expect(built.args[built.args.indexOf('--settings') + 1]).toBe('/g/settings.json')
    expect(built.args.slice(-2)).toEqual(['--setting-sources', ''])
  })

  it('claude non-bypass → still uses the authoritative settings', () => {
    const built = buildCommand(action({type: 'claude', run: '/x', permission_mode: 'plan'}), '/pb', '/g/settings.json')
    expect(built.args).toContain('--settings')
    expect(built.args[built.args.indexOf('--settings') + 1]).toBe('/g/settings.json')
  })

  it('codex action → argv `codex exec` with sandbox, model and prompt after `--`', () => {
    const built = buildCommand(action({type: 'codex', run: 'sistema i test', sandbox: 'workspace-write', model: 'gpt-5-codex'}), '/pb')
    expect(built.cmd).toBe('codex')
    expect(built.args).toContain('workspace-write')
    expect(built.args).toContain('gpt-5-codex')
    expect(built.args.some((arg) => arg.includes('shell_command|exec_command'))).toBe(true)
    expect(built.args.slice(-2)).toEqual(['--', 'sistema i test'])
  })

  it('codex without sandbox → read-only default always passed', () => {
    const built = buildCommand(action({type: 'codex', run: 'x'}), '/pb')
    expect(built.args).toContain('read-only')
    expect(built.args).toContain('features.hooks=true')
    expect(built.args.slice(-2)).toEqual(['--', 'x'])
  })

})

// The cwd of an action has a single boundary, shared by runtime and preflight: either it matches the
// authorized one, or it is a relative path that does not leave the playbook folder. CYAU-71 — these
// branches stayed uncovered while the rest of the file changed.
describe('resolveActionCwd', () => {
  it('with an authorized cwd accepts only that one', () => {
    expect(resolveActionCwd(action({type: 'shell', run: 'x', cwd: '/repo'}), '/pb', '/repo')).toBe(path.resolve('/repo'))
    expect(() => resolveActionCwd(action({type: 'shell', run: 'x', cwd: '/altro'}), '/pb', '/repo'))
      .toThrow(/diversa dalla directory autorizzata/)
  })

  it('without authorization rejects absolute and traversal, and resolves the rest on the playbook', () => {
    expect(() => resolveActionCwd(action({type: 'shell', run: 'x', cwd: '/fuori'}), '/pb')).toThrow(/assoluta o con traversal/)
    expect(() => resolveActionCwd(action({type: 'shell', run: 'x', cwd: '../fuori'}), '/pb')).toThrow(/assoluta o con traversal/)
    expect(resolveActionCwd(action({type: 'shell', run: 'x', cwd: 'sotto'}), '/pb')).toBe(path.resolve('/pb', 'sotto'))
  })
})

describe('runAction', () => {
  const ctx = (spawn: SpawnFn, extra?: Record<string, unknown>) => ({
    playbookDir: '/pb', logDir: dir, now, spawn,
    authorizeCwd: (cwd: string) => cwd,
    resolveExecutable: (cmd: string) => `/trusted/${cmd}`,
    ...extra,
  })

  function strongBackend(handle: StrongContainmentHandle): StrongContainmentBackend {
    return {available: () => ({available: true}), prepare: () => handle}
  }

  it('polymorphic shim: the launcher starts with the original NAME, not the binary one', async () => {
    // Reproduces the real case: in the service PATH `claude` is `shims/claude -> mise`. The pinning
    // resolves the symlink and returns the mise binary; without argv0 mise would start as
    // itself and would not know which tool to launch ("unexpected argument '-p'").
    const {spawn, calls} = makeSpawn({code: 0, stdout: '{"is_error":false}'})
    await runAction('a', action({type: 'claude', run: 'ciao'}), ctx(spawn, {
      resolveExecutable: (cmd: string) => (cmd === 'claude' ? '/opt/mise/bin/mise' : `/trusted/${cmd}`),
      guardrailsInstalled: () => true,
    }))

    expect(calls[0].cmd).toBe('/opt/mise/bin/mise')
    expect(calls[0].opts.argv0).toBe('claude')
  })

  // CYAU-167 — a project suite is run by the SESSION, not the gate: on a repository without a
  // trusted policy the local gate does not even apply. Without the data space here, two runs
  // on the same project keep writing into the same test databases.
  it('the session receives the run data space', async () => {
    const {spawn, calls} = makeSpawn({code: 0, stdout: '{"is_error":false}'})
    await runAction('a', action({type: 'claude', run: 'ciao'}), ctx(spawn, {
      guardrailsInstalled: () => true,
      testSlot: '_cyau_167',
    }))

    expect(calls[0].opts.env.TEST_SLOT).toBe('_cyau_167')
  })

  it('without a declared data space the environment stays as it was', async () => {
    const {spawn, calls} = makeSpawn({code: 0, stdout: 'ok'})
    await runAction('a', action({type: 'shell', run: 'echo ok'}), ctx(spawn))

    expect(calls[0].opts.env.TEST_SLOT).toBeUndefined()
  })

  it('normal binary: argv0 matches the name and nothing changes', async () => {
    const {spawn, calls} = makeSpawn({code: 0, stdout: 'ok'})
    await runAction('a', action({type: 'shell', run: 'echo ok'}), ctx(spawn))

    expect(calls[0].opts.argv0).toBe('sh')
  })

  it('shell exit 0 → success', async () => {
    const {spawn} = makeSpawn({code: 0, stdout: 'ok'})
    const res = await runAction('a', action({type: 'shell', run: 'echo ok'}), ctx(spawn))
    expect(res.status).toBe('success')
    expect(res.exitCode).toBe(0)
    expect(fs.existsSync(res.logPath)).toBe(true)
  })

  // CYAU-169: the same action can run several times in the same round (one per queue ticket). The log
  // name then comes from the context: without it, two concurrent runs would write into the same file.
  it('a log name in the context replaces the action one', async () => {
    const {spawn} = makeSpawn({code: 0, stdout: 'ok'})
    const primo = await runAction('q', action({type: 'shell', run: 'echo ok'}), {...ctx(spawn), logName: 'q-CYAU-1'})
    const secondo = await runAction('q', action({type: 'shell', run: 'echo ok'}), {...ctx(spawn), logName: 'q-CYAU-2'})

    expect(path.basename(primo.logPath).startsWith('q-CYAU-1-')).toBe(true)
    expect(path.basename(secondo.logPath).startsWith('q-CYAU-2-')).toBe(true)
    expect(primo.logPath).not.toBe(secondo.logPath)
  })

  it('unavailable strong containment → fail-closed before the spawn, without degrading to PGID', async () => {
    const {spawn, calls} = makeSpawn({code: 0})
    const strongContainment: StrongContainmentBackend = {
      available: () => ({available: false, detail: 'helper nativo assente'}),
      prepare: () => { throw new Error('non deve preparare') },
    }
    const res = await runAction(
      'strong-unavailable',
      action({type: 'shell', run: 'true', containment: 'strong'}),
      ctx(spawn, {strongContainment}),
    )
    expect(res).toMatchObject({status: 'failure', exitCode: null, errorCode: 'C412-EXEC-005'})
    expect(calls).toHaveLength(0)
    expect(fs.readFileSync(res.logPath, 'utf8')).toContain('helper nativo assente')
  })

  it('strong containment signals the kernel identity with TERM→KILL and approves only after empty', async () => {
    vi.useFakeTimers()
    const signals: NodeJS.Signals[] = []
    const wrapped = {cmd: '/usr/bin/systemd-run', args: ['--scope', '--', '/trusted/sh'], cwd: '/pb'}
    const handle: StrongContainmentHandle = {
      identity: 'automator-action-fixed.scope',
      command: wrapped,
      signal: (signal) => { signals.push(signal); return true },
      empty: () => true,
    }
    const {spawn, calls} = makeSpawn({hang: true, pid: 9090})
    const promise = runAction(
      'strong-timeout',
      action({type: 'shell', run: 'sleep 999', timeout: 1, containment: 'strong'}),
      ctx(spawn, {strongContainment: strongBackend(handle)}),
    )
    await vi.advanceTimersByTimeAsync(1000)
    expect(signals).toEqual(['SIGTERM'])
    await vi.advanceTimersByTimeAsync(5000)
    expect(await promise).toMatchObject({status: 'timeout', errorCode: 'C124-EXEC-001'})
    expect(signals).toEqual(['SIGTERM', 'SIGKILL'])
    expect(calls[0]).toMatchObject({cmd: wrapped.cmd, args: wrapped.args})
    expect(calls[0].opts.detached).toBe(false)
    vi.useRealTimers()
  })

  it('strong containment cleans up the descendants left after a natural close and does not approve the success', async () => {
    vi.useFakeTimers()
    let empty = false
    const signals: NodeJS.Signals[] = []
    let close: ((code: number | null, signal: NodeJS.Signals | null) => void) | undefined
    const spawn: SpawnFn = () => ({
      pid: 9091,
      stdout: null,
      stderr: null,
      on: (event, cb) => { if (event === 'close') close = cb as typeof close },
      kill: () => true,
    })
    const handle: StrongContainmentHandle = {
      identity: 'automator-action-fixed.scope',
      command: {cmd: '/usr/bin/systemd-run', args: [], cwd: '/pb'},
      signal: (signal) => {
        signals.push(signal)
        if (signal === 'SIGTERM') setTimeout(() => { empty = true }, 50)
        return true
      },
      empty: () => empty,
    }
    let settled = false
    const pending = runAction(
      'strong-natural',
      action({type: 'shell', run: 'true', containment: 'strong'}),
      ctx(spawn, {strongContainment: strongBackend(handle)}),
    ).then((result) => { settled = true; return result })
    await vi.advanceTimersByTimeAsync(0)
    expect(close).toBeTypeOf('function')
    close?.(0, null)
    await vi.advanceTimersByTimeAsync(25)
    expect(settled).toBe(false)
    await vi.advanceTimersByTimeAsync(50)
    expect(await pending).toMatchObject({status: 'failure', errorCode: 'C001-EXEC-003'})
    expect(signals).toEqual(['SIGTERM'])
    vi.useRealTimers()
  })

  it('ambiguous strong containment past the deadline stays fail-closed without killing the daemon', async () => {
    vi.useFakeTimers()
    let failStop = false
    const handle: StrongContainmentHandle = {
      identity: 'automator-action-fixed.scope',
      command: {cmd: '/usr/bin/systemd-run', args: [], cwd: '/pb'},
      signal: () => true,
      empty: () => false,
    }
    const {spawn} = makeSpawn({code: 0})
    const pending = runAction(
      'strong-unverified',
      action({type: 'shell', run: 'true', containment: 'strong'}),
      ctx(spawn, {
        strongContainment: strongBackend(handle),
        containmentCleanupMs: 50,
        containmentMaxCleanupMs: 100,
        onContainmentFailure: () => { failStop = true },
      }),
    )
    await vi.advanceTimersByTimeAsync(5150)
    expect(await pending).toMatchObject({status: 'failure', errorCode: 'C500-EXEC-006'})
    expect(failStop).toBe(true)
    vi.useRealTimers()
  })

  it('strong containment cleaned up late keeps a sticky failure outcome', async () => {
    vi.useFakeTimers()
    let empty = false
    const handle: StrongContainmentHandle = {
      identity: 'automator-action-fixed.scope',
      command: {cmd: '/usr/bin/systemd-run', args: [], cwd: '/pb'},
      signal: () => true,
      empty: () => empty,
    }
    const {spawn} = makeSpawn({code: 0})
    const pending = runAction(
      'strong-late-cleanup',
      action({type: 'shell', run: 'true', containment: 'strong'}),
      ctx(spawn, {
        strongContainment: strongBackend(handle),
        containmentCleanupMs: 50,
        containmentMaxCleanupMs: 200,
        onContainmentFailure: () => { empty = true },
      }),
    )
    await vi.advanceTimersByTimeAsync(5150)
    expect(await pending).toMatchObject({status: 'failure', errorCode: 'C500-EXEC-006'})
    vi.useRealTimers()
  })

  it('strong cancel stays distinct from the timeout and cleans up the same cgroup', async () => {
    vi.useFakeTimers()
    const controller = new AbortController()
    const signals: NodeJS.Signals[] = []
    const handle: StrongContainmentHandle = {
      identity: 'automator-action-fixed.scope',
      command: {cmd: '/usr/bin/systemd-run', args: [], cwd: '/pb'},
      signal: (signal) => { signals.push(signal); return true },
      empty: () => signals.includes('SIGKILL'),
    }
    const {spawn} = makeSpawn({hang: true})
    const pending = runAction(
      'strong-cancel',
      action({type: 'shell', run: 'sleep 999', containment: 'strong'}),
      ctx(spawn, {strongContainment: strongBackend(handle), signal: controller.signal}),
    )
    controller.abort()
    await vi.advanceTimersByTimeAsync(5000)
    const result = await pending
    expect(result).toMatchObject({status: 'failure', errorCode: 'C001-EXEC-003'})
    expect(normalizeAgentResult({runtime: 'test', action: 'strong-cancel', result, cancelled: true}).outcome).toBe('cancelled')
    expect(signals).toEqual(['SIGTERM', 'SIGKILL'])
    vi.useRealTimers()
  })

  it('wrapper close after TERM does not bring forward the cleanup deadline before SIGKILL', async () => {
    vi.useFakeTimers()
    const signals: NodeJS.Signals[] = []
    let close: ((code: number | null, signal: NodeJS.Signals | null) => void) | undefined
    let failStop = false
    const spawn: SpawnFn = () => ({
      pid: 9092,
      stdout: null,
      stderr: null,
      on: (event, cb) => { if (event === 'close') close = cb as typeof close },
      kill: () => true,
    })
    const handle: StrongContainmentHandle = {
      identity: 'automator-action-fixed.scope',
      command: {cmd: '/usr/bin/systemd-run', args: [], cwd: '/pb'},
      signal: (signal) => {
        signals.push(signal)
        if (signal === 'SIGTERM') queueMicrotask(() => close?.(null, 'SIGTERM'))
        return true
      },
      empty: () => signals.includes('SIGKILL'),
    }
    const pending = runAction(
      'strong-wrapper-close',
      action({type: 'shell', run: 'sleep 999', timeout: 1, containment: 'strong'}),
      ctx(spawn, {
        strongContainment: strongBackend(handle),
        containmentCleanupMs: 50,
        onContainmentFailure: () => { failStop = true },
      }),
    )
    await vi.advanceTimersByTimeAsync(1000)
    await vi.advanceTimersByTimeAsync(4999)
    expect(failStop).toBe(false)
    expect(signals).toEqual(['SIGTERM'])
    await vi.advanceTimersByTimeAsync(1)
    expect(await pending).toMatchObject({status: 'timeout'})
    expect(signals).toEqual(['SIGTERM', 'SIGKILL'])
    expect(failStop).toBe(false)
    vi.useRealTimers()
  })

  it('rejects a lexically internal local cwd that leaves the playbook via symlink', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'automator-cwd-symlink-'))
    const playbookDir = path.join(root, 'playbook')
    const outsideRepo = path.join(root, 'outside-repo')
    fs.mkdirSync(playbookDir)
    fs.mkdirSync(outsideRepo)
    expect(spawnSync('git', ['init', '-q', outsideRepo]).status).toBe(0)
    fs.symlinkSync(outsideRepo, path.join(playbookDir, 'escape'))
    try {
      const {spawn, calls} = makeSpawn({code: 0})
      const res = await runAction('symlink-cwd', action({type: 'shell', run: 'true', cwd: 'escape'}), {
        playbookDir,
        logDir: dir,
        now,
        spawn,
        resolveExecutable: (cmd: string) => `/trusted/${cmd}`,
      })
      expect(res.status).toBe('failure')
      expect(res.errorCode).toBe('C400-EXEC-004')
      expect(calls).toHaveLength(0)
    } finally {
      fs.rmSync(root, {recursive: true, force: true})
    }
  })

  it('does not rebuild an artificial token by concatenating distinct stdout and stderr', async () => {
    const payload = 'Z'.repeat(24)
    const spawn: SpawnFn = () => {
      let stdout: ((chunk: string) => void) | undefined
      let stderr: ((chunk: string) => void) | undefined
      return {
        stdout: {on: (_event, callback) => { stdout = callback }},
        stderr: {on: (_event, callback) => { stderr = callback }},
        on: (event, callback) => {
          if (event === 'close') {
            queueMicrotask(() => {
              stdout?.('inizio cyi_ah_')
              stderr?.(`${payload} fine`)
              ;(callback as (code: number | null, signal: NodeJS.Signals | null) => void)(0, null)
            })
          }
        },
        kill: () => true,
      }
    }

    const result = await runAction('split-secret', action({type: 'shell', run: 'x'}), ctx(spawn))
    const log = fs.readFileSync(result.logPath, 'utf8')
    expect(log).toContain('inizio ')
    expect(log).toContain('cyi_ah_')
    expect(log).toContain(`${payload} fine`)
    expect(log).not.toContain('[REDACTED]')
  })

  it('redacts a stdout token even when stderr interleaves between its chunks', async () => {
    const token = 'cyi_ah_ABCDEF'
    const spawn = makeInterleavedSpawn([
      {source: 'stdout', chunk: 'stdout-before:cyi_ah_'},
      {source: 'stderr', chunk: 'stderr-event\n'},
      {source: 'stdout', chunk: 'ABCDEF:stdout-after\n'},
    ])

    const result = await runAction('interleaved-secret', action({type: 'shell', run: 'x'}), ctx(spawn))
    const log = fs.readFileSync(result.logPath, 'utf8')
    expect(log).toContain('stdout-before:[REDACTED]stderr-event\n:stdout-after\n')
    expect(log).not.toContain(token)
  })

  it('preserves the exact order when stdout interleaves into a split stderr token', async () => {
    const token = 'cyi_ah_ABCDEF'
    const spawn = makeInterleavedSpawn([
      {source: 'stderr', chunk: 'stderr-before:cyi_ah_'},
      {source: 'stdout', chunk: 'stdout-event\n'},
      {source: 'stderr', chunk: 'ABCDEF:stderr-after\n'},
    ])

    const result = await runAction('reverse-interleaved-secret', action({type: 'shell', run: 'x'}), ctx(spawn))
    const log = fs.readFileSync(result.logPath, 'utf8')
    expect(log).toContain('stderr-before:[REDACTED]stdout-event\n:stderr-after\n')
    expect(log).not.toContain(token)
  })

  it('preserves UTF-8 characters split across successive Buffers', async () => {
    const euro = Buffer.from('€')
    const spawn: SpawnFn = () => {
      let stdout: ((chunk: Buffer) => void) | undefined
      return {
        stdout: {on: (_event, callback) => { stdout = callback as (chunk: Buffer) => void }},
        stderr: {on: () => undefined},
        on: (event, callback) => {
          if (event === 'close') {
            queueMicrotask(() => {
              stdout?.(euro.subarray(0, 2))
              stdout?.(euro.subarray(2))
              ;(callback as (code: number | null, signal: NodeJS.Signals | null) => void)(0, null)
            })
          }
        },
        kill: () => true,
      }
    }

    const result = await runAction('utf8', action({type: 'shell', run: 'x'}), ctx(spawn))
    expect(result.stdout).toBe('€')
    expect(fs.readFileSync(result.logPath, 'utf8')).toContain('€')
  })

  it('downgrades an exit-0 to failure when ctx.isError flags it (generic predicate, e.g. claude is_error)', async () => {
    const {spawn} = makeSpawn({code: 0, stdout: 'BAD'})
    const res = await runAction('a', action({type: 'claude', run: '/x'}), ctx(spawn, {isError: (s) => s.includes('BAD')}))
    expect(res.status).toBe('failure')
  })

  it('without ctx.isError an exit-0 stays success (generic engine, no coupling to claude)', async () => {
    const {spawn} = makeSpawn({code: 0, stdout: '{"is_error":true}'})
    const res = await runAction('a', action({type: 'claude', run: '/x'}), ctx(spawn))
    expect(res.status).toBe('success')
  })

  it('exit 1 → failure e on_failure eseguito', async () => {
    const {spawn, calls} = makeSpawn([{code: 1}, {code: 0}])
    const res = await runAction('a', action({type: 'shell', run: 'false', on_failure: {run: 'cyi report'}}), ctx(spawn))
    expect(res.status).toBe('failure')
    expect(res.errorCode).toBe('C001-EXEC-003')
    expect(calls).toHaveLength(2)
    expect(calls[1].args).toEqual(['-c', 'cyi report'])
  })

  it('flushes the harmless tail produced by on_failure', async () => {
    const {spawn} = makeSpawn([{code: 1}, {code: 0, stdout: 'diagnostic'}])
    const result = await runAction(
      'on-failure-tail',
      action({type: 'shell', run: 'false', on_failure: {run: 'true'}}),
      ctx(spawn),
    )

    expect(fs.readFileSync(result.logPath, 'utf8')).toContain('diagnostic')
  })

  it('exit 127 → failure C127 (command not found)', async () => {
    const {spawn} = makeSpawn({code: 127})
    const res = await runAction('a', action({type: 'shell', run: 'inesistente'}), ctx(spawn))
    expect(res.errorCode).toBe('C127-EXEC-002')
  })

  it("spawn 'error' event → failure with code null", async () => {
    const {spawn} = makeSpawn({errorEvent: true})
    const res = await runAction('a', action({type: 'shell', run: 'x'}), ctx(spawn))
    expect(res.status).toBe('failure')
    expect(res.exitCode).toBeNull()
  })

  it('timeout → status timeout + C124', async () => {
    vi.useFakeTimers()
    const {spawn} = makeSpawn({hang: true})
    const promise = runAction('a', action({type: 'shell', run: 'sleep 999', timeout: 2}), ctx(spawn))
    await vi.advanceTimersByTimeAsync(2000)
    await vi.advanceTimersByTimeAsync(5000)
    const res = await promise
    expect(res.status).toBe('timeout')
    expect(res.errorCode).toBe('C124-EXEC-001')
    vi.useRealTimers()
  })

  describe('secret capability per runtime and action', () => {
    const cases: Array<{
      label: string
      spec: Record<string, unknown>
      claude: boolean
    }> = [
      {label: 'shell', spec: {type: 'shell', run: 'true'}, claude: false},
      {label: 'Claude', spec: {type: 'claude', run: 'x'}, claude: true},
      {label: 'Codex', spec: {type: 'codex', run: 'x'}, claude: false},
    ]

    for (const row of cases) {
      it(`${row.label}: only the claude action inherits the local Claude auth, never the others`, async () => {
        // LOCAL Claude auth in the service environment (subscription setup-token or API key): it goes ONLY to claude.
        process.env.CLAUDE_CODE_OAUTH_TOKEN = 'sk-inherited-claude'
        process.env.ANTHROPIC_API_KEY = 'sk-ant-inherited'
        const retiredTokenEnv = ['DOP', 'PLER_TOKEN'].join('')
        process.env[retiredTokenEnv] = 'inherited-retired-secret'
        process.env.claude_code_oauth_token = 'sk-inherited-lowercase'
        process.env[retiredTokenEnv.toLowerCase()] = 'inherited-lowercase'
        try {
          const {spawn, calls} = makeSpawn({code: 0})
          await runAction('a', action({...row.spec, env: {vars: {FOO: 'bar'}}}), ctx(spawn))
          expect(calls[0].opts.env.FOO).toBe('bar')
          // claude receives the inherited auth (consistent with `claude auth status`); shell/codex see it stripped.
          expect(calls[0].opts.env.CLAUDE_CODE_OAUTH_TOKEN).toBe(row.claude ? 'sk-inherited-claude' : undefined)
          expect(calls[0].opts.env.ANTHROPIC_API_KEY).toBe(row.claude ? 'sk-ant-inherited' : undefined)
          expect(calls[0].opts.env[retiredTokenEnv]).toBeUndefined()
          expect(calls[0].opts.env.claude_code_oauth_token).toBeUndefined()
          expect(calls[0].opts.env[retiredTokenEnv.toLowerCase()]).toBeUndefined()
        } finally {
          // The Vitest worker is isolated: do not read or keep any credentials inherited from the launcher.
          delete process.env.CLAUDE_CODE_OAUTH_TOKEN
          delete process.env.ANTHROPIC_API_KEY
          delete process.env[retiredTokenEnv]
          delete process.env.claude_code_oauth_token
          delete process.env[retiredTokenEnv.toLowerCase()]
        }
      })
    }

    it('the organization Claude credential replaces the machine one, for the claude action only (CYAU-224)', async () => {
      process.env.ANTHROPIC_API_KEY = 'sk-ant-inherited'
      resetOrgClaudeCredential({load: () => 'sk-ant-oat01-organization', save: () => true, clear: () => true})
      try {
        const {spawn, calls} = makeSpawn([{code: 0}, {code: 0}, {code: 0}])
        await runAction('a', action({type: 'claude', run: 'x'}), ctx(spawn))
        await runAction('a', action({type: 'codex', run: 'x', sandbox: 'read-only'}), ctx(spawn))
        await runAction('a', action({type: 'shell', run: 'true'}), ctx(spawn))
        expect(calls[0].opts.env.CLAUDE_CODE_OAUTH_TOKEN).toBe('sk-ant-oat01-organization')
        expect(calls[0].opts.env.ANTHROPIC_API_KEY).toBeUndefined()
        for (const call of calls.slice(1)) {
          expect(JSON.stringify(call.opts.env)).not.toContain('sk-ant-')
        }
      } finally {
        delete process.env.ANTHROPIC_API_KEY
        resetOrgClaudeCredential()
      }
    })

    it('on_failure inherits no capability of the main runtime, not even the Claude auth', async () => {
      process.env.CLAUDE_CODE_OAUTH_TOKEN = 'sk-inherited-claude'
      process.env.ANTHROPIC_API_KEY = 'sk-ant-inherited'
      try {
        const {spawn, calls} = makeSpawn([{code: 1}, {code: 0}])
        await runAction(
          'a',
          action({
            type: 'claude',
            run: 'x',
            env: {vars: {FOO: 'bar'}},
            on_failure: {run: 'true'},
          }),
          ctx(spawn),
        )
        // The claude action inherits the local auth...
        expect(calls[0].opts.env.CLAUDE_CODE_OAUTH_TOKEN).toBe('sk-inherited-claude')
        expect(calls[0].opts.env.ANTHROPIC_API_KEY).toBe('sk-ant-inherited')
        // ...but on_failure (shell) does not inherit the Claude auth.
        expect(calls[1].opts.env.CLAUDE_CODE_OAUTH_TOKEN).toBeUndefined()
        expect(calls[1].opts.env.ANTHROPIC_API_KEY).toBeUndefined()
        expect(calls[1].opts.env.FOO).toBe('bar')
      } finally {
        delete process.env.CLAUDE_CODE_OAUTH_TOKEN
        delete process.env.ANTHROPIC_API_KEY
      }
    })
  })

  it('display and log do not expose tokens present in the command or in the recovery', async () => {
    const claudeToken = 'sk-ant-oat01-fake-command-token'
    const retiredToken = 'dp.st.fake_service_token'
    const {spawn} = makeSpawn([{code: 1}, {code: 0}])
    const a = action({
      type: 'shell',
      run: `echo ${retiredToken}`,
      on_failure: {run: `echo ${claudeToken}`},
    })
    expect(buildCommand(a, '/pb').display).not.toContain(retiredToken)
    const result = await runAction('display-redaction', a, ctx(spawn))
    const log = fs.readFileSync(result.logPath, 'utf8')
    expect(log).not.toContain(retiredToken)
    expect(log).not.toContain(claudeToken)
  })

  // CYAU-193 — the global config is turned off on purpose (GIT_CONFIG_GLOBAL=''), so ~/.gitconfig
  // does not count: without an injected identity `git commit` in the session dies with "Author identity
  // unknown" and the run depends on an identity improvised by the model. The same fixed identity
  // the host uses for its own git commands also applies inside the session, and cannot be overridden.
  it('injects a fixed git identity into the session, not overridable by the playbook', async () => {
    const {spawn, calls} = makeSpawn({code: 0})
    await runAction('a', action({
      type: 'claude', run: 'x',
      env: {vars: {GIT_AUTHOR_EMAIL: 'evil@example.com', GIT_COMMITTER_NAME: 'Evil'}},
    }), ctx(spawn))
    const env = calls[0].opts.env
    expect(env.GIT_CONFIG_KEY_2).toBe('user.name')
    expect(env.GIT_CONFIG_VALUE_2).toBe('CloseYourIt Automator')
    expect(env.GIT_CONFIG_KEY_3).toBe('user.email')
    expect(env.GIT_CONFIG_VALUE_3).toBe('automator@localhost')
    expect(env.GIT_AUTHOR_EMAIL).toBeUndefined()
    expect(env.GIT_COMMITTER_NAME).toBeUndefined()
  })

  it('resolves the launcher on the trusted PATH and sanitizes env after all merges', async () => {
    const previousPath = process.env.PATH
    process.env.PATH = '/trusted/bin'
    try {
      const resolved: Array<{cmd: string; path: string | undefined}> = []
      const {spawn, calls} = makeSpawn({code: 0})
      await runAction('a', action({
        type: 'codex', run: 'x',
        env: {vars: {
          PATH: '/evil', CODEX_HOME: '/evil', NODE_OPTIONS: '--require evil',
          LD_PRELOAD: '/evil.so', DYLD_INSERT_LIBRARIES: '/evil.dylib', RUBYOPT: '-revil',
          PYTHONPATH: '/evil/python', PERL5OPT: '-Mevil',
          GIT_CONFIG_COUNT: '1', GIT_CONFIG_KEY_0: 'alias.x', GIT_CONFIG_VALUE_0: 'push',
          GIT_DIR: '/tmp/other/.git', GIT_WORK_TREE: '/tmp/other',
        }},
      }), ctx(spawn, {resolveExecutable: (cmd: string, trustedPath: string | undefined) => {
        resolved.push({cmd, path: trustedPath})
        return `/trusted/${cmd}`
      }}))
      expect(resolved.map(({cmd}) => cmd)).toEqual(['codex'])
      expect(resolved.every(({path: trustedPath}) => trustedPath === '/trusted/bin')).toBe(true)
      expect(calls[0].cmd).toBe('/trusted/codex')
      expect(calls[0].opts.env.PATH).toBe('/trusted/bin')
      expect(calls[0].opts.env.NODE_OPTIONS).toBe('')
      expect(calls[0].opts.env.LD_PRELOAD).toBe('')
      expect(calls[0].opts.env.DYLD_INSERT_LIBRARIES).toBe('')
      expect(calls[0].opts.env.RUBYOPT).toBe('')
      expect(calls[0].opts.env.PYTHONPATH).toBe('')
      expect(calls[0].opts.env.PERL5OPT).toBe('')
      expect(calls[0].opts.env.GIT_CONFIG_COUNT).toBe('4')
      expect(calls[0].opts.env.GIT_CONFIG_KEY_0).toBe('core.hooksPath')
      expect(calls[0].opts.env.GIT_CONFIG_VALUE_0).toBe('/dev/null')
      expect(calls[0].opts.env.GIT_CONFIG_KEY_1).toBe('core.fsmonitor')
      expect(calls[0].opts.env.GIT_CONFIG_VALUE_1).toBe('false')
      expect(calls[0].opts.env.GIT_DIR).toBeUndefined()
      expect(calls[0].opts.env.GIT_WORK_TREE).toBeUndefined()
      expect(calls[0].opts.env.CODEX_HOME).not.toBe('/evil')
    } finally {
      process.env.PATH = previousPath
    }
  })

  // Inside the sandbox the network goes through a proxy with allowlist: `curl` honours it from the environment, Node's
  // `fetch` does not. Without this variable `cyi` (Node CLI) answers `fetch failed` and the skill cannot
  // even read the ticket — a failure visible only at runtime, inside the sandbox.
  it('agent sessions receive the flag that makes Node fetch honour the proxy', async () => {
    for (const type of ['claude', 'codex'] as const) {
      const {spawn, calls} = makeSpawn({code: 0})
      await runAction('a', action({type, run: 'x'}), ctx(spawn))
      expect(calls[0].opts.env.NODE_USE_ENV_PROXY).toBe('1')
    }
  })

  it('not even an action env can turn off the proxy flag', async () => {
    const {spawn, calls} = makeSpawn({code: 0})
    await runAction('a', action({type: 'claude', run: 'x', env: {vars: {NODE_USE_ENV_PROXY: '0'}}}), ctx(spawn))

    expect(calls[0].opts.env.NODE_USE_ENV_PROXY).toBe('1')
  })

  // CYAU-128: git interprets GIT_EXTERNAL_DIFF as a diff COMMAND to run. Emptying it (='') does not
  // disable it: git tries to launch a program named with the empty string and dies with "external diff died",
  // breaking `git diff` inside every agent session. The real diff is the faithful reproduction of the bug.
  it('git diff inside an agent session exits 0 and returns the patch (CYAU-128)', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'automator-git-diff-'))
    const repo = path.join(root, 'repo')
    fs.mkdirSync(repo)
    expect(spawnSync('git', ['init', '-q', repo]).status).toBe(0)
    expect(spawnSync('git', ['-C', repo, 'config', 'user.email', 'agent@test']).status).toBe(0)
    expect(spawnSync('git', ['-C', repo, 'config', 'user.name', 'Agent']).status).toBe(0)
    fs.writeFileSync(path.join(repo, 'file.txt'), 'uno\n')
    expect(spawnSync('git', ['-C', repo, 'add', 'file.txt']).status).toBe(0)
    expect(spawnSync('git', ['-C', repo, 'commit', '-q', '-m', 'init']).status).toBe(0)
    fs.writeFileSync(path.join(repo, 'file.txt'), 'due\n') // dirty worktree: git diff shows the patch
    try {
      const result = await runAction(
        'git-diff',
        action({type: 'shell', run: 'git diff -- file.txt'}),
        {
          playbookDir: repo,
          logDir: dir,
          now,
          resolveExecutable: (command: string) => {
            if (command === 'sh') return '/bin/sh'
            throw new Error(`launcher inatteso: ${command}`)
          },
        },
      )
      expect(result.status).toBe('success')
      expect(result.exitCode).toBe(0)
      expect(result.stdout).toContain('-uno')
      expect(result.stdout).toContain('+due')
    } finally {
      fs.rmSync(root, {recursive: true, force: true})
    }
  })

  // CYAU-128: ONLY GIT_EXTERNAL_DIFF must be removed (git diff invokes it as a command: '' → "external diff died").
  const GIT_EXTERNAL_DIFF_ENV = 'GIT_EXTERNAL_DIFF'
  // git uses these as commands only outside the diff (or they are not commands): emptying them is safe and — unlike
  // removing them — does NOT reopen the fallbacks to PAGER/EDITOR/VISUAL/SSH_ASKPASS/core.* (review finding).
  const GIT_EMPTIED_ENV = [
    'GIT_DIFF_OPTS', 'GIT_PAGER', 'GIT_EDITOR', 'GIT_SEQUENCE_EDITOR', 'GIT_ASKPASS', 'GIT_PROXY_COMMAND',
  ] as const

  it('GIT_EXTERNAL_DIFF is ABSENT, the other command GIT_* stay empty (CYAU-128)', async () => {
    const {spawn, calls} = makeSpawn({code: 0})
    await runAction('a', action({type: 'shell', run: 'git diff'}), ctx(spawn))

    // GIT_EXTERNAL_DIFF: absent ⇒ git internal default; empty ⇒ git tries to run "" and dies.
    expect(GIT_EXTERNAL_DIFF_ENV in calls[0].opts.env).toBe(false)
    expect(calls[0].opts.env[GIT_EXTERNAL_DIFF_ENV]).toBeUndefined()
    // The others stay PRESENT but empty: '' disables without reopening the executable fallbacks.
    for (const key of GIT_EMPTIED_ENV) expect(calls[0].opts.env[key]).toBe('')
    // And the path/config GIT_* stay neutralized: no vector reopened.
    expect(calls[0].opts.env.GIT_SSH).toBe('')
    expect(calls[0].opts.env.GIT_SSH_COMMAND).toBe('')
    expect(calls[0].opts.env.GIT_EXEC_PATH).toBe('')
    expect(calls[0].opts.env.GIT_CONFIG_GLOBAL).toBe('')
    expect(calls[0].opts.env.GIT_CONFIG_SYSTEM).toBe('')
  })

  it('an inherited hostile GIT_EXTERNAL_DIFF is removed, not left empty (CYAU-128)', async () => {
    const {spawn, calls} = makeSpawn({code: 0})
    await runAction(
      'a',
      action({type: 'shell', run: 'git diff', env: {vars: {GIT_EXTERNAL_DIFF: '/tmp/malicious-diff'}}}),
      ctx(spawn),
    )

    // The env vector closed: neither the hostile value nor '' reaches the child.
    expect('GIT_EXTERNAL_DIFF' in calls[0].opts.env).toBe(false)
    expect(calls[0].opts.env.GIT_EXTERNAL_DIFF).toBeUndefined()
  })

  // CYAU-128 review finding: removing GIT_PAGER/GIT_EDITOR/GIT_ASKPASS would reactivate the executable fallbacks
  // (core.pager/PAGER, core.editor/EDITOR/VISUAL, core.askpass/SSH_ASKPASS). They must be EMPTIED, not removed.
  it('an inherited hostile pager/editor/askpass is EMPTIED, not removed (no fallback reopened, CYAU-128)', async () => {
    const {spawn, calls} = makeSpawn({code: 0})
    await runAction(
      'a',
      action({type: 'shell', run: 'git diff', env: {vars: {
        GIT_PAGER: '/tmp/evil-pager', GIT_EDITOR: '/tmp/evil-editor', GIT_ASKPASS: '/tmp/evil-askpass',
        GIT_SEQUENCE_EDITOR: '/tmp/evil-seq', GIT_PROXY_COMMAND: '/tmp/evil-proxy', GIT_DIFF_OPTS: '--evil',
      }}}),
      ctx(spawn),
    )

    for (const key of GIT_EMPTIED_ENV) {
      expect(key in calls[0].opts.env).toBe(true) // present ⇒ wins over the env/config fallbacks
      expect(calls[0].opts.env[key]).toBe('') // emptied, not the hostile value
    }
  })

  it('Codex: action env cannot move CODEX_HOME and bypass the installed policy', async () => {
    const previous = process.env.CODEX_HOME
    process.env.CODEX_HOME = '/managed/codex'
    try {
      const {spawn, calls} = makeSpawn({code: 0})
      await runAction(
        'a',
        action({type: 'codex', run: 'x', env: {vars: {CODEX_HOME: '/attacker/codex'}}}),
        ctx(spawn),
      )
      expect(calls[0].opts.env.CODEX_HOME).toBe('/managed/codex')
    } finally {
      if (previous === undefined) delete process.env.CODEX_HOME
      else process.env.CODEX_HOME = previous
    }
  })

  it('managed service uses persisted settings and CODEX_HOME even if the environment overrides them', async () => {
    const installRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'automator-exec-managed-'))
    const persistedConfig = path.join(installRoot, 'persisted-config')
    const persistedCodex = path.join(installRoot, 'persisted-codex')
    saveManagedServiceConfig(installRoot, {
      version: 1,
      nodePath: process.execPath,
      codexHome: persistedCodex,
      guardrails: {
        hooksDir: path.join(persistedConfig, 'guardrails', 'hooks'),
        settingsPath: path.join(persistedConfig, 'guardrails', 'settings.json'),
        codexRulesPath: path.join(persistedCodex, 'rules', 'closeyourit-automator.rules'),
        worktreesRoot: path.join(installRoot, 'worktrees'),
      },
    })
    const previousRoot = process.env.AUTOMATOR_INSTALL_ROOT
    const previousConfig = process.env.AUTOMATOR_CONFIG_DIR
    const previousCodex = process.env.CODEX_HOME
    const previousEntrypoint = process.argv[1]
    process.env.AUTOMATOR_INSTALL_ROOT = installRoot
    process.env.AUTOMATOR_CONFIG_DIR = '/attacker/config'
    process.env.CODEX_HOME = '/attacker/codex'
    process.argv[1] = path.join(installRoot, 'current', 'bin', 'run.js')
    try {
      const {spawn, calls} = makeSpawn([{code: 0}, {code: 0}])
      await runAction('managed-claude', action({type: 'claude', run: '/x'}), ctx(spawn))
      await runAction('managed-codex', action({type: 'codex', run: 'x'}), ctx(spawn))

      const settingsIndex = calls[0].args.indexOf('--settings')
      expect(calls[0].args[settingsIndex + 1]).toBe(path.join(persistedConfig, 'guardrails', 'settings.json'))
      expect(calls[1].opts.env.CODEX_HOME).toBe(persistedCodex)
    } finally {
      if (previousRoot === undefined) delete process.env.AUTOMATOR_INSTALL_ROOT
      else process.env.AUTOMATOR_INSTALL_ROOT = previousRoot
      if (previousConfig === undefined) delete process.env.AUTOMATOR_CONFIG_DIR
      else process.env.AUTOMATOR_CONFIG_DIR = previousConfig
      if (previousCodex === undefined) delete process.env.CODEX_HOME
      else process.env.CODEX_HOME = previousCodex
      process.argv[1] = previousEntrypoint
      fs.rmSync(installRoot, {recursive: true, force: true})
    }
  })

  it('Claude: action env cannot disable the hooks with the safe/simple mode variables', async () => {
    const {spawn, calls} = makeSpawn({code: 0})
    await runAction(
      'a',
      action({
        type: 'claude',
        run: '/x',
        env: {vars: {CLAUDE_CODE_SAFE_MODE: '1', CLAUDE_CODE_SIMPLE: '1'}},
      }),
      ctx(spawn),
    )
    expect(calls[0].opts.env.CLAUDE_CODE_SAFE_MODE).toBe('')
    expect(calls[0].opts.env.CLAUDE_CODE_SIMPLE).toBe('')
  })

  it('signal abort during execution → child killed, status failure', async () => {
    vi.useFakeTimers()
    const controller = new AbortController()
    const {spawn} = makeSpawn({hang: true})
    const promise = runAction('a', action({type: 'shell', run: 'sleep 999'}), ctx(spawn, {signal: controller.signal}))
    controller.abort()
    await vi.advanceTimersByTimeAsync(5000)
    const res = await promise
    expect(res.status).toBe('failure')
    expect(res.exitCode).toBeNull()
    vi.useRealTimers()
  })

  it('already aborted signal → child killed immediately, without waiting', async () => {
    vi.useFakeTimers()
    const controller = new AbortController()
    controller.abort()
    const {spawn} = makeSpawn({hang: true})
    const promise = runAction('a', action({type: 'shell', run: 'x'}), ctx(spawn, {signal: controller.signal}))
    await vi.advanceTimersByTimeAsync(5000)
    const res = await promise
    expect(res.status).toBe('failure')
    vi.useRealTimers()
  })

  it('cancelled action → on_failure NOT run (the cancellation is not a failure to recover)', async () => {
    vi.useFakeTimers()
    const controller = new AbortController()
    const {spawn, calls} = makeSpawn({hang: true})
    const promise = runAction(
      'a',
      action({type: 'shell', run: 'sleep 999', on_failure: {run: 'cyi report'}}),
      ctx(spawn, {signal: controller.signal}),
    )
    controller.abort()
    await vi.advanceTimersByTimeAsync(5000)
    const res = await promise
    expect(res.status).toBe('failure')
    expect(calls).toHaveLength(1)
    vi.useRealTimers()
  })

  it('timeout terminates the process group, drains bounded and ignores data arrived after the resolution', async () => {
    vi.useFakeTimers()
    const signals: Array<[number, NodeJS.Signals]> = []
    let data: ((chunk: string) => void) | undefined
    const calls: Array<{opts: {detached?: boolean}}> = []
    const spawn: SpawnFn = (_cmd, _args, opts) => {
      calls.push({opts})
      return {
        pid: 4242,
        stdout: {on: (_event, callback) => { data = callback as (chunk: string) => void }},
        stderr: null,
        on: () => undefined,
        kill: () => true,
      }
    }
    const promise = runAction('a', action({type: 'shell', run: 'sleep 999', timeout: 1}), ctx(spawn, {
      platform: 'linux',
      kill: (pid: number, signal: NodeJS.Signals) => signals.push([pid, signal]),
    }))
    let settled = false
    void promise.then(() => { settled = true })
    await vi.advanceTimersByTimeAsync(1000)
    await vi.advanceTimersByTimeAsync(5000)
    expect(settled).toBe(false)
    data?.('prima-del-drain\n')
    await vi.advanceTimersByTimeAsync(999)
    expect(settled).toBe(false)
    await vi.advanceTimersByTimeAsync(1)
    const res = await promise
    expect(res.status).toBe('timeout')
    expect(calls[0].opts.detached).toBe(true)
    expect(signals).toContainEqual([-4242, 'SIGTERM'])
    expect(signals).toContainEqual([-4242, 'SIGKILL'])
    data?.('dopo-il-footer\n')
    expect(fs.readFileSync(res.logPath, 'utf8')).toContain('prima-del-drain')
    expect(fs.readFileSync(res.logPath, 'utf8')).not.toContain('dopo-il-footer')
    vi.useRealTimers()
  })

  it('keeps the group SIGKILL if after SIGTERM only the leader closes', async () => {
    vi.useFakeTimers()
    const signals: Array<[number, NodeJS.Signals]> = []
    let close: ((code: number | null, signal: NodeJS.Signals | null) => void) | undefined
    const spawn: SpawnFn = () => ({
      pid: 4343,
      stdout: null,
      stderr: null,
      on: (event, callback) => { if (event === 'close') close = callback as typeof close },
      kill: () => true,
    })
    const promise = runAction('leader-close', action({type: 'shell', run: 'sleep 999', timeout: 1}), ctx(spawn, {
      platform: 'linux',
      kill: (pid: number, signal: NodeJS.Signals) => {
        signals.push([pid, signal])
        if (signal === 'SIGTERM') queueMicrotask(() => close?.(null, 'SIGTERM'))
      },
    }))
    await vi.advanceTimersByTimeAsync(1000)
    expect(signals).toEqual([[-4343, 'SIGTERM']])
    await vi.advanceTimersByTimeAsync(5000)
    expect((await promise).status).toBe('timeout')
    expect(signals).toEqual([[-4343, 'SIGTERM'], [-4343, 'SIGKILL']])
    vi.useRealTimers()
  })

  it('ignores relative PATH segments and spawns only an absolute launcher from the trusted PATH', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'automator-launcher-path-'))
    const trusted = path.join(root, 'trusted')
    const launcher = path.join(trusted, 'sh')
    fs.mkdirSync(trusted)
    fs.writeFileSync(launcher, '#!/bin/sh\n')
    fs.chmodSync(launcher, 0o755)
    const previousPath = process.env.PATH
    process.env.PATH = `relative-bin${path.delimiter}${trusted}`
    try {
      const {spawn, calls} = makeSpawn({code: 0})
      const res = await runAction('absolute-launcher', action({type: 'shell', run: 'true'}), ctx(spawn, {
        resolveExecutable: undefined,
      }))
      expect(res.status).toBe('success')
      // CYAU-184 — the path FOUND on the PATH is run (a shim dispatches by name); the pinning
      // stays on the canonical one, so the two must keep pointing to the same binary.
      expect(calls[0].cmd).toBe(launcher)
      expect(path.isAbsolute(calls[0].cmd)).toBe(true)
      expect(fs.realpathSync(calls[0].cmd)).toBe(fs.realpathSync(launcher))
    } finally {
      process.env.PATH = previousPath
      fs.rmSync(root, {recursive: true, force: true})
    }
  })

  // CYAU-184 — the mise case: on the PATH there is a link leading to a binary with ANOTHER name
  // (the shim dispatches by the name it is invoked with). Running the canonical one started that binary
  // with the tool arguments; now the shim is run, and the pinning keeps signing the real one.
  it('runs the shim (not the canonical binary) when the launcher is a link that dispatches by name', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'automator-launcher-shim-'))
    const trusted = path.join(root, 'trusted')
    const dispatcher = path.join(root, 'mise')
    const shim = path.join(trusted, 'sh')
    fs.mkdirSync(trusted)
    fs.writeFileSync(dispatcher, '#!/bin/sh\n')
    fs.chmodSync(dispatcher, 0o755)
    fs.symlinkSync(dispatcher, shim)
    const previousPath = process.env.PATH
    process.env.PATH = trusted
    try {
      const {spawn, calls} = makeSpawn({code: 0})
      const res = await runAction('shim-launcher', action({type: 'shell', run: 'true'}), ctx(spawn, {
        resolveExecutable: undefined,
      }))
      expect(res.status).toBe('success')
      expect(calls[0].cmd).toBe(shim)
      expect(fs.realpathSync(calls[0].cmd)).toBe(fs.realpathSync(dispatcher))
    } finally {
      process.env.PATH = previousPath
      fs.rmSync(root, {recursive: true, force: true})
    }
  })

  it('rejects a critical launcher replaced after the process baseline', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'automator-launcher-baseline-'))
    const sh = path.join(root, 'sh')
    const codex = path.join(root, 'codex')
    fs.writeFileSync(sh, '#!/bin/sh\n')
    fs.writeFileSync(codex, '#!/bin/sh\nexit 0\n')
    fs.chmodSync(sh, 0o755)
    fs.chmodSync(codex, 0o755)
    const previousPath = process.env.PATH
    process.env.PATH = root
    try {
      const first = makeSpawn({code: 0})
      expect((await runAction('baseline', action({type: 'shell', run: 'true'}), ctx(first.spawn, {
        resolveExecutable: undefined,
      }))).status).toBe('success')

      fs.writeFileSync(codex, '#!/bin/sh\nexit 99\n')
      fs.chmodSync(codex, 0o755)
      const second = makeSpawn({code: 0})
      const result = await runAction('poisoned', action({type: 'codex', run: 'x'}), ctx(second.spawn, {
        resolveExecutable: undefined,
      }))
      expect(result.errorCode).toBe('C400-EXEC-004')
      expect(second.calls).toHaveLength(0)
    } finally {
      process.env.PATH = previousPath
      fs.rmSync(root, {recursive: true, force: true})
    }
  })

  it('already aborted signal with open descendants/pipes resolves within the bounded grace', async () => {
    vi.useFakeTimers()
    const controller = new AbortController()
    controller.abort()
    const signals: Array<[number, NodeJS.Signals]> = []
    const {spawn} = makeSpawn({hang: true, pid: 5151})
    const promise = runAction('pre-abort', action({type: 'shell', run: 'x'}), ctx(spawn, {
      signal: controller.signal,
      platform: 'linux',
      kill: (pid: number, signal: NodeJS.Signals) => signals.push([pid, signal]),
    }))
    await vi.advanceTimersByTimeAsync(6000)
    const res = await promise
    expect(res.status).toBe('failure')
    expect(signals).toEqual([[-5151, 'SIGTERM'], [-5151, 'SIGKILL']])
    vi.useRealTimers()
  })

  it('drains but caps stdout and log at 1 MiB', async () => {
    const huge = 'x'.repeat(1024 * 1024 + 4096)
    const {spawn} = makeSpawn({code: 0, stdout: huge})
    const res = await runAction('bounded', action({type: 'shell', run: 'x'}), ctx(spawn))
    expect(Buffer.byteLength(res.stdout)).toBe(1024 * 1024)
    expect(fs.readFileSync(res.logPath, 'utf8')).toContain('output troncato a 1 MiB')
  })

  it('redacts a token crossing the artificial 1 MiB boundary', async () => {
    const limit = 1024 * 1024
    const exposedPrefix = 'cyi_a_AB'
    const output = `${'x'.repeat(limit - exposedPrefix.length - 1)}:${exposedPrefix}CDEF fine`
    const {spawn} = makeSpawn({code: 0, stdout: output})
    const result = await runAction('bounded-secret', action({type: 'shell', run: 'x'}), ctx(spawn))
    const log = fs.readFileSync(result.logPath, 'utf8')
    expect(result.stdout).not.toContain(exposedPrefix)
    expect(log).not.toContain(exposedPrefix)
    expect(result.stdout).toContain('[REDACTED]')
    expect(log).toContain('[REDACTED]')
    expect(Buffer.byteLength(result.stdout)).toBeLessThanOrEqual(limit)
  })

  it('discards an incomplete UTF-8 code point at the 1 MiB boundary without expanding the result', async () => {
    const limit = 1024 * 1024
    const euro = Buffer.from('€')
    const payload = Buffer.concat([Buffer.alloc(limit - 1, 0x78), euro])
    const spawn: SpawnFn = () => {
      let data: ((chunk: Buffer) => void) | undefined
      return {
        stdout: {on: (_event, callback) => { data = callback as (chunk: Buffer) => void }},
        stderr: null,
        on: (event, callback) => {
          if (event === 'close') queueMicrotask(() => {
            data?.(payload)
            ;(callback as (code: number | null, signal: NodeJS.Signals | null) => void)(0, null)
          })
        },
        kill: () => true,
      }
    }
    const result = await runAction('bounded-utf8', action({type: 'shell', run: 'x'}), ctx(spawn))
    const log = fs.readFileSync(result.logPath, 'utf8')
    expect(result.stdout).not.toContain('�')
    expect(log).not.toContain('�')
    expect(Buffer.byteLength(result.stdout)).toBe(limit - 1)
  })
})

// Runtime-agnostic command policy (CYAU-25): the process wrapper rejects forbidden operations BEFORE the spawn,
// for ANY runtime. DoD coverage from the wrapper side: deploy, destructive DB, protected branches, force-push.
describe('runAction · command policy (CYAU-25)', () => {
  const ctx = (spawn: SpawnFn, extra?: Record<string, unknown>) => ({playbookDir: '/pb', logDir: dir, now, spawn, authorizeCwd: (cwd: string) => cwd, resolveExecutable: (cmd: string) => `/trusted/${cmd}`, ...extra})

  it('shell action with Kamal deploy → rejected C412-POLICY-001, never spawned', async () => {
    const {spawn, calls} = makeSpawn({code: 0})
    const res = await runAction('a', action({type: 'shell', run: 'kamal deploy -d production'}), ctx(spawn))
    expect(res.status).toBe('failure')
    expect(res.errorCode).toBe('C412-POLICY-001')
    expect(res.exitCode).toBeNull()
    expect(calls).toHaveLength(0)
    expect(fs.existsSync(res.logPath)).toBe(true)
  })

  it('shell action with destructive DB (db:drop) → rejected, never spawned', async () => {
    const {spawn, calls} = makeSpawn({code: 0})
    const res = await runAction('a', action({type: 'shell', run: 'bin/rails db:drop'}), ctx(spawn))
    expect(res.errorCode).toBe('C412-POLICY-001')
    expect(calls).toHaveLength(0)
  })

  it('shell action with push to protected branch → rejected, never spawned', async () => {
    const {spawn, calls} = makeSpawn({code: 0})
    const res = await runAction('a', action({type: 'shell', run: 'git push origin main'}), ctx(spawn))
    expect(res.errorCode).toBe('C412-POLICY-001')
    expect(calls).toHaveLength(0)
  })

  it('shell action with force-push → rejected, never spawned', async () => {
    const {spawn, calls} = makeSpawn({code: 0})
    const res = await runAction('a', action({type: 'shell', run: 'git push --force origin ticket/x'}), ctx(spawn))
    expect(res.errorCode).toBe('C412-POLICY-001')
    expect(calls).toHaveLength(0)
  })

  it('shell action with force refspec `+` or additional refspecs → rejected', async () => {
    const first = makeSpawn({code: 0})
    expect((await runAction('a', action({type: 'shell', run: 'git push origin +ticket/x'}), ctx(first.spawn))).errorCode).toBe('C412-POLICY-001')
    expect(first.calls).toHaveLength(0)
    const second = makeSpawn({code: 0})
    expect((await runAction('b', action({type: 'shell', run: 'git push origin ticket/x feature/y'}), ctx(second.spawn))).errorCode).toBe('C412-POLICY-001')
    expect(second.calls).toHaveLength(0)
  })

  it('the rejection log reports the violation reason', async () => {
    const {spawn} = makeSpawn({code: 0})
    const res = await runAction('a', action({type: 'shell', run: 'kamal deploy'}), ctx(spawn))
    expect(fs.readFileSync(res.logPath, 'utf8')).toContain('command policy')
  })

  it('legitimate shell action → run normally (no false positive)', async () => {
    const {spawn, calls} = makeSpawn({code: 0, stdout: 'ok'})
    const res = await runAction('a', action({type: 'shell', run: 'git push -u origin ticket/CYAU-25'}), ctx(spawn))
    expect(res.status).toBe('success')
    expect(calls).toHaveLength(1)
  })

  it('cyi run production in a shell command → rejected before the spawn', async () => {
    const {spawn, calls} = makeSpawn({code: 0})
    const result = await runAction('a', action({type: 'shell', run: 'cyi run -p CYI -e production -- bin/rails c'}), ctx(spawn))
    expect(result.errorCode).toBe('C412-POLICY-001')
    expect(calls).toHaveLength(0)
  })

  it('action with forbidden on_failure → rejected upstream, never spawned', async () => {
    const {spawn, calls} = makeSpawn({code: 0})
    const res = await runAction('a', action({type: 'shell', run: 'bin/ci', on_failure: {run: 'kamal rollback'}}), ctx(spawn))
    expect(res.errorCode).toBe('C412-POLICY-001')
    expect(calls).toHaveLength(0)
  })
})

// CYAU-108: the machine must talk to CloseYourIt with its OWN service identity. Without this
// injection the session falls back on the identity `cyi login` left on disk — that is a person, with
// their permissions and their name in the ticket audit. Observed on minion-1 on 2026-07-30: `cyi whoami`
// answered with a human account of another organization, without permissions, and the triage did not see the
// project it had to work on.
describe('actionSecretEnv — machine cyi identity (CYAU-108)', () => {
  const capabilities = {cyiAuth: 'cyi_u_service'}

  function action(type: 'claude' | 'codex' | 'shell') {
    return PlaybookSchema.parse({
      version: 1,
      actions: {a: {schedule: 'every 1m', type, run: type === 'shell' ? 'echo x' : 'prompt'}},
    }).actions.a
  }

  it('reaches the agent sessions, which run the skills and call `cyi`', () => {
    for (const type of ['claude', 'codex'] as const) {
      expect(actionSecretEnv(action(type), capabilities, {}).CLOSEYOURIT_TOKEN).toBe('cyi_u_service')
    }
  })

  it('does NOT reach a shell action: whoever does not run skills does not need it', () => {
    expect(actionSecretEnv(action('shell'), capabilities, {}).CLOSEYOURIT_TOKEN).toBeUndefined()
  })

  it('without capability it invents nothing', () => {
    expect(actionSecretEnv(action('claude'), {}, {}).CLOSEYOURIT_TOKEN).toBeUndefined()
  })

  it('does not sneakily inherit from the environment: the source is the capability, not the shell', () => {
    const env = actionSecretEnv(action('claude'), {}, {CLOSEYOURIT_TOKEN: 'cyi_u_ereditato'})
    expect(env.CLOSEYOURIT_TOKEN).toBeUndefined()
  })

  it('it is a managed variable, so `on_failure` loses it like the others', () => {
    expect(isManagedSecretEnv('CLOSEYOURIT_TOKEN')).toBe(true)
    expect(isManagedSecretEnv('closeyourit_token')).toBe(true)
  })
})

// CYAU-248 — the one-hour GitHub token the server mints for the ticket being worked. `~/.config/gh` is denied to
// the sandbox (CYAU-242), and gh refuses to start on an unreadable config dir: the session gets an empty one.
describe('actionSecretEnv — GitHub token of the ticket (CYAU-248)', () => {
  const capabilities = {githubToken: 'ghs_ticketscoped'}

  function action(type: 'claude' | 'codex' | 'shell') {
    return PlaybookSchema.parse({
      version: 1,
      actions: {a: {schedule: 'every 1m', type, run: type === 'shell' ? 'echo x' : 'prompt'}},
    }).actions.a
  }

  it('reaches the agent sessions with a config dir gh can start from', () => {
    for (const type of ['claude', 'codex'] as const) {
      const env = actionSecretEnv(action(type), capabilities, {})
      expect(env.GH_TOKEN).toBe('ghs_ticketscoped')
      expect(env.GH_CONFIG_DIR).toMatch(/closeyourit-automator-gh$/)
      expect(env.GH_CONFIG_DIR?.startsWith(os.homedir())).toBe(false)
    }
  })

  it('does NOT reach a shell action', () => {
    const env = actionSecretEnv(action('shell'), capabilities, {})
    expect(env.GH_TOKEN).toBeUndefined()
    expect(env.GH_CONFIG_DIR).toBeUndefined()
  })

  it('never comes from the service environment', () => {
    const env = actionSecretEnv(action('claude'), {}, {GH_TOKEN: 'ghp_inherited', GITHUB_TOKEN: 'ghp_inherited'})
    expect(env.GH_TOKEN).toBeUndefined()
    expect(isManagedSecretEnv('GH_TOKEN')).toBe(true)
    expect(isManagedSecretEnv('GITHUB_TOKEN')).toBe(true)
  })
})
