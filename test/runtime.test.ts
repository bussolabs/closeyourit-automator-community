import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import {afterAll, afterEach, describe, expect, it, vi} from 'vitest'
import {AGENT_RUNTIMES, type AgentRuntime, ClaudeRuntime, CodexRuntime, probeRuntimes, SpawnRuntime} from '../src/lib/runtime'
import {type ChildLike, type SpawnFn} from '../src/lib/executor'
import {type ProbeKillFn} from '../src/lib/process-probe'
import {type Action, PlaybookSchema} from '../src/lib/schema'

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'automator-runtime-'))
const now = new Date('2026-07-07T00:00:00.000Z')
afterAll(() => fs.rmSync(dir, {recursive: true, force: true}))
afterEach(() => vi.useRealTimers())

/** Builds a typed Action with the defaults applied (via zod). */
function action(partial: Record<string, unknown>): Action {
  return PlaybookSchema.parse({version: 1, actions: {a: {schedule: 'every 1m', ...partial}}}).actions.a
}

const TEST_EXEC_CTX = {
  authorizeCwd: (cwd: string): string => cwd,
  resolveExecutable: (cmd: string): string => cmd,
}

interface Behavior {
  stdout?: string
  code?: number | null
  hang?: boolean
  errorEvent?: boolean
}

/** Injectable fake spawn: records the calls and simulates close/error/hang without real processes. */
function makeSpawn(behaviors: Behavior | Behavior[]): {spawn: SpawnFn; calls: Array<{cmd: string; args: string[]}>} {
  const queue = Array.isArray(behaviors) ? [...behaviors] : [behaviors]
  const calls: Array<{cmd: string; args: string[]}> = []
  const spawn: SpawnFn = (cmd, args) => {
    calls.push({cmd, args})
    const b = queue.shift() ?? {code: 0}
    let dataCb: ((c: string) => void) | undefined
    let errorCb: ((e: Error) => void) | undefined
    let closeCb: ((code: number | null, sig: NodeJS.Signals | null) => void) | undefined
    const child: ChildLike = {
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

describe('SpawnRuntime · contract', () => {
  it('exposes an id and implements the three capabilities of the AgentRuntime contract', () => {
    const rt: AgentRuntime = new SpawnRuntime()
    expect(rt.id).toBe('spawn')
    expect(typeof rt.healthCheck).toBe('function')
    expect(typeof rt.execute).toBe('function')
  })
})

describe('SpawnRuntime · healthCheck', () => {
  it('by default probes the availability with `claude --version`', async () => {
    const {spawn, calls} = makeSpawn({code: 0})
    await new SpawnRuntime({spawn}).healthCheck()
    expect(calls[0].cmd).toBe('claude')
    expect(calls[0].args).toEqual(['--version'])
  })

  it('uses the configured health command when provided', async () => {
    const {spawn, calls} = makeSpawn({code: 0})
    await new SpawnRuntime({spawn, healthCommand: {cmd: 'foo', args: ['ping']}}).healthCheck()
    expect(calls[0].cmd).toBe('foo')
    expect(calls[0].args).toEqual(['ping'])
  })

  it('provider raggiungibile (exit 0) → available true', async () => {
    const {spawn} = makeSpawn({code: 0})
    const health = await new SpawnRuntime({spawn}).healthCheck()
    expect(health.available).toBe(true)
  })

  it('provider not ready (exit ≠ 0) → available false with detail', async () => {
    const {spawn} = makeSpawn({code: 1})
    const health = await new SpawnRuntime({spawn}).healthCheck()
    expect(health.available).toBe(false)
    expect(health.detail).toContain('exit 1')
  })

  it('missing binary (error event) → available false with the message', async () => {
    const {spawn} = makeSpawn({errorEvent: true})
    const health = await new SpawnRuntime({spawn}).healthCheck()
    expect(health.available).toBe(false)
    expect(health.detail).toContain('spawn boom')
  })

  it('a process error is redacted before entering the diagnostics', async () => {
    const spawn: SpawnFn = () => ({
      stdout: null,
      stderr: null,
      on: (event, cb) => {
        if (event === 'error') queueMicrotask(() => (cb as (error: Error) => void)(new Error('errore cyi_ah_SEGRETISSIMO')))
      },
      kill: () => true,
    })
    const health = await new ClaudeRuntime({spawn}).healthCheck()
    expect(health.available).toBe(false)
    expect(health.detail).toContain('[REDACTED]')
    expect(health.detail).not.toContain('SEGRETISSIMO')
  })

  it('spawn throwing a synchronous Error → available false (never crash)', async () => {
    const spawn: SpawnFn = () => {
      throw new Error('boom sincrono')
    }
    const health = await new SpawnRuntime({spawn}).healthCheck()
    expect(health.available).toBe(false)
    expect(health.detail).toContain('boom sincrono')
  })

  it('spawn throwing a non-Error value → available false with stringified detail', async () => {
    const spawn: SpawnFn = () => {
      throw 'kaboom'
    }
    const health = await new SpawnRuntime({spawn}).healthCheck()
    expect(health.available).toBe(false)
    expect(health.detail).toBe('kaboom')
  })
})

describe('SpawnRuntime · execute', () => {
  const ctx = (extra?: Record<string, unknown>) => ({playbookDir: '/pb', logDir: dir, now, ...TEST_EXEC_CTX, ...extra})

  it('starts the action and the outcome (result) resolves with the derived status', async () => {
    const {spawn} = makeSpawn({code: 0, stdout: 'ok'})
    const exec = new SpawnRuntime({spawn}).execute('a', action({type: 'shell', run: 'echo ok'}), ctx())
    const res = await exec.result
    expect(res.status).toBe('success')
    expect(res.exitCode).toBe(0)
  })

  it('redacts multi-letter CloseYourIt tokens from the result and the runtime log', async () => {
    const token = `cyi_ah_${'S'.repeat(24)}`
    const {spawn} = makeSpawn({code: 0, stdout: `output con ${token}`})
    const res = await new SpawnRuntime({spawn}).execute('a', action({type: 'shell', run: 'echo ok'}), ctx()).result
    const log = fs.readFileSync(res.logPath, 'utf8')

    expect(res.stdout).toContain('[REDACTED]')
    expect(res.stdout).not.toContain(token)
    expect(log).toContain('[REDACTED]')
    expect(log).not.toContain(token)
  })

  it('cancel() cancels the running execution: the child is killed → failure', async () => {
    vi.useFakeTimers()
    const {spawn} = makeSpawn({hang: true})
    const exec = new SpawnRuntime({spawn}).execute('a', action({type: 'shell', run: 'sleep 999'}), ctx())
    exec.cancel()
    await vi.advanceTimersByTimeAsync(5000)
    const res = await exec.result
    expect(res.status).toBe('failure')
    expect(res.exitCode).toBeNull()
    vi.useRealTimers()
  })

  it('an already aborted external signal cancels the action immediately', async () => {
    vi.useFakeTimers()
    const {spawn} = makeSpawn({hang: true})
    const controller = new AbortController()
    controller.abort()
    const exec = new SpawnRuntime({spawn}).execute(
      'a',
      action({type: 'shell', run: 'x'}),
      ctx({signal: controller.signal}),
    )
    await vi.advanceTimersByTimeAsync(5000)
    const res = await exec.result
    expect(res.status).toBe('failure')
    vi.useRealTimers()
  })

  it('an abort of the external signal during execution cancels the action', async () => {
    vi.useFakeTimers()
    const {spawn} = makeSpawn({hang: true})
    const controller = new AbortController()
    const exec = new SpawnRuntime({spawn}).execute(
      'a',
      action({type: 'shell', run: 'x'}),
      ctx({signal: controller.signal}),
    )
    controller.abort()
    await vi.advanceTimersByTimeAsync(5000)
    const res = await exec.result
    expect(res.status).toBe('failure')
    vi.useRealTimers()
  })

  it('at the end of execution detaches the listener from the external signal (no leak on shared signal)', async () => {
    const {spawn} = makeSpawn({code: 0})
    const controller = new AbortController()
    const removeSpy = vi.spyOn(controller.signal, 'removeEventListener')
    const exec = new SpawnRuntime({spawn}).execute('a', action({type: 'shell', run: 'x'}), ctx({signal: controller.signal}))
    await exec.result
    expect(removeSpy).toHaveBeenCalledWith('abort', expect.any(Function))
  })

  // Defence in depth: even if a claude action ends up on SpawnRuntime by mistake, it must go through the
  // claude provider (guardrail gate + is_error) — never an unguarded claude session.
  it('a claude action is delegated to the claude provider: guardrail gate active (bypass without guardrails → C412)', async () => {
    const {spawn, calls} = makeSpawn({code: 0})
    const exec = new SpawnRuntime({spawn}).execute(
      'a',
      action({type: 'claude', run: '/x', permission_mode: 'bypassPermissions'}),
      ctx({guardrailsInstalled: () => false}),
    )
    const res = await exec.result
    expect(res.errorCode).toBe('C412-GUARDRAILS-001')
    expect(calls).toHaveLength(0)
  })

  it('a claude action is delegated to the claude provider: is_error downgraded to failure', async () => {
    const {spawn} = makeSpawn({code: 0, stdout: '{"is_error":true}'})
    const res = await new SpawnRuntime({spawn})
      .execute('a', action({type: 'claude', run: '/x'}), ctx({guardrailsInstalled: () => true}))
      .result
    expect(res.status).toBe('failure')
  })

  it('a codex action is delegated to the Codex provider: missing policy → C412 without spawn', async () => {
    const {spawn, calls} = makeSpawn({code: 0})
    const res = await new SpawnRuntime({spawn})
      .execute('a', action({type: 'codex', run: 'x'}), ctx({guardrailsInstalled: () => false}))
      .result
    expect(res.errorCode).toBe('C412-GUARDRAILS-001')
    expect(calls).toHaveLength(0)
  })

  // CYRA-921 — a Codex skill session runs under the Claude hooks: without them it never starts.
  it('a codex skill action needs the skill guardrails, not only the Codex policy', async () => {
    const {spawn, calls} = makeSpawn({code: 0})
    const skill = {command: '/closeyourit-skills:triage', args: 'CYRA-1', plugin_dir: '/opt/skills'}
    const rt = new CodexRuntime({spawn, guardrailsInstalled: () => true, skillGuardrailsInstalled: () => false})
    const res = await rt.execute('a', action({type: 'codex', run: 'x', skill}), ctx({})).result
    expect(res.errorCode).toBe('C412-GUARDRAILS-001')
    expect(calls).toHaveLength(0)
  })
})

describe('ClaudeRuntime · contract', () => {
  it('id "claude" and implements the three capabilities of the AgentRuntime contract', () => {
    const rt: AgentRuntime = new ClaudeRuntime()
    expect(rt.id).toBe('claude')
    expect(typeof rt.healthCheck).toBe('function')
    expect(typeof rt.execute).toBe('function')
  })
})

describe('ClaudeRuntime · healthCheck', () => {
  it('probes the availability with `claude --version`', async () => {
    const {spawn, calls} = makeSpawn({code: 0})
    await new ClaudeRuntime({spawn}).healthCheck()
    expect(calls[0].cmd).toBe('claude')
    expect(calls[0].args).toEqual(['--version'])
  })

  it('claude raggiungibile (exit 0) → available true', async () => {
    const {spawn} = makeSpawn({code: 0})
    expect((await new ClaudeRuntime({spawn}).healthCheck()).available).toBe(true)
  })

  it('claude not ready (exit ≠ 0) → available false with detail', async () => {
    const {spawn} = makeSpawn({code: 1})
    const health = await new ClaudeRuntime({spawn}).healthCheck()
    expect(health.available).toBe(false)
    expect(health.detail).toContain('exit 1')
  })
})

describe('ClaudeRuntime · execute · output interpretation', () => {
  const ctx = (extra?: Record<string, unknown>) => ({playbookDir: '/pb', logDir: dir, now, guardrailsInstalled: () => true, ...TEST_EXEC_CTX, ...extra})

  it('claude with is_error:true → failure even at exit 0', async () => {
    const {spawn} = makeSpawn({code: 0, stdout: '{"type":"result","is_error":true}'})
    const res = await new ClaudeRuntime({spawn}).execute('a', action({type: 'claude', run: '/x'}), ctx()).result
    expect(res.status).toBe('failure')
  })

  it('claude with is_error:false → success', async () => {
    const {spawn} = makeSpawn({code: 0, stdout: '{"type":"result","is_error":false}'})
    const res = await new ClaudeRuntime({spawn}).execute('a', action({type: 'claude', run: '/x'}), ctx()).result
    expect(res.status).toBe('success')
  })

  it('claude with non-JSON output at exit 0 → success (does not downgrade)', async () => {
    const {spawn} = makeSpawn({code: 0, stdout: 'fatto'})
    const res = await new ClaudeRuntime({spawn}).execute('a', action({type: 'claude', run: '/x'}), ctx()).result
    expect(res.status).toBe('success')
  })

  it('spawns the claude binary with the resolved argv (-p, --output-format json)', async () => {
    const {spawn, calls} = makeSpawn({code: 0, stdout: '{"is_error":false}'})
    await new ClaudeRuntime({spawn}).execute('a', action({type: 'claude', run: '/audit'}), ctx()).result
    expect(calls[0].cmd).toBe('claude')
    expect(calls[0].args).toEqual([
      '-p',
      '/audit',
      '--output-format',
      'json',
      '--tools',
      'Read,Glob,Grep,Edit,Write,MultiEdit,NotebookEdit',
      '--model',
      'claude-opus-5-5',
      '--settings',
      expect.stringMatching(/guardrails\/settings\.json$/),
      '--setting-sources',
      '',
    ])
  })
})

describe('ClaudeRuntime · execute · guardrail gate (every permission mode)', () => {
  const ctx = (extra?: Record<string, unknown>) => ({playbookDir: '/pb', logDir: dir, now, ...TEST_EXEC_CTX, ...extra})

  it('bypass without installed guardrails → C412 rejection, never spawned', async () => {
    const {spawn, calls} = makeSpawn({code: 0})
    const rt = new ClaudeRuntime({spawn, guardrailsInstalled: () => false})
    const res = await rt.execute('a', action({type: 'claude', run: '/x', permission_mode: 'bypassPermissions'}), ctx()).result
    expect(res.status).toBe('failure')
    expect(res.errorCode).toBe('C412-GUARDRAILS-001')
    expect(calls).toHaveLength(0)
  })

  it('bypass with installed guardrails → proceeds and injects --settings', async () => {
    const {spawn, calls} = makeSpawn({code: 0, stdout: '{"is_error":false}'})
    const rt = new ClaudeRuntime({spawn, guardrailsInstalled: () => true})
    const res = await rt.execute('a', action({type: 'claude', run: '/x', permission_mode: 'bypassPermissions'}), ctx()).result
    expect(res.status).toBe('success')
    expect(calls).toHaveLength(1)
    expect(calls[0].args).toContain('--settings')
  })

  it('ctx.guardrailsInstalled takes precedence over the constructor override', async () => {
    const {spawn, calls} = makeSpawn({code: 0})
    const rt = new ClaudeRuntime({spawn, guardrailsInstalled: () => true})
    const res = await rt
      .execute('a', action({type: 'claude', run: '/x', permission_mode: 'bypassPermissions'}), ctx({guardrailsInstalled: () => false}))
      .result
    expect(res.errorCode).toBe('C412-GUARDRAILS-001')
    expect(calls).toHaveLength(0)
  })

  it('without override → uses the real on-disk check (empty configDir → rejection)', async () => {
    const prev = process.env.AUTOMATOR_CONFIG_DIR
    process.env.AUTOMATOR_CONFIG_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'automator-noguard-'))
    const {spawn, calls} = makeSpawn({code: 0})
    const res = await new ClaudeRuntime({spawn})
      .execute('a', action({type: 'claude', run: '/x', permission_mode: 'bypassPermissions'}), ctx())
      .result
    expect(res.errorCode).toBe('C412-GUARDRAILS-001')
    expect(calls).toHaveLength(0)
    if (prev === undefined) delete process.env.AUTOMATOR_CONFIG_DIR
    else process.env.AUTOMATOR_CONFIG_DIR = prev
  })

  it('non-bypass permission_mode without guardrails → C412 rejection, never spawned', async () => {
    const {spawn, calls} = makeSpawn({code: 0})
    const rt = new ClaudeRuntime({spawn, guardrailsInstalled: () => false})
    const res = await rt.execute('a', action({type: 'claude', run: '/x', permission_mode: 'plan'}), ctx()).result
    expect(res.errorCode).toBe('C412-GUARDRAILS-001')
    expect(calls).toHaveLength(0)
  })

  it('non-bypass permission_mode with guardrails → proceeds and injects --settings', async () => {
    const {spawn, calls} = makeSpawn({code: 0, stdout: '{"is_error":false}'})
    const rt = new ClaudeRuntime({spawn, guardrailsInstalled: () => true})
    const res = await rt.execute('a', action({type: 'claude', run: '/x', permission_mode: 'plan'}), ctx()).result
    expect(res.status).toBe('success')
    expect(calls[0].args).toContain('--settings')
  })
})

describe('ClaudeRuntime · execute · timeout e cancel', () => {
  const ctx = (extra?: Record<string, unknown>) => ({playbookDir: '/pb', logDir: dir, now, guardrailsInstalled: () => true, ...TEST_EXEC_CTX, ...extra})

  it('timeout → status timeout preservato', async () => {
    vi.useFakeTimers()
    const {spawn} = makeSpawn({hang: true})
    const exec = new ClaudeRuntime({spawn}).execute('a', action({type: 'claude', run: '/x', timeout: 2}), ctx())
    await vi.advanceTimersByTimeAsync(2000)
    await vi.advanceTimersByTimeAsync(5000)
    const res = await exec.result
    expect(res.status).toBe('timeout')
    expect(res.errorCode).toBe('C124-EXEC-001')
    vi.useRealTimers()
  })

  it('cancel() cancels the running execution → failure', async () => {
    vi.useFakeTimers()
    const {spawn} = makeSpawn({hang: true})
    const exec = new ClaudeRuntime({spawn}).execute('a', action({type: 'claude', run: '/x'}), ctx())
    exec.cancel()
    await vi.advanceTimersByTimeAsync(5000)
    const res = await exec.result
    expect(res.status).toBe('failure')
    expect(res.exitCode).toBeNull()
    vi.useRealTimers()
  })

  it('a non-claude action is delegated to the generic engine (no claude logic)', async () => {
    const {spawn, calls} = makeSpawn({code: 0, stdout: '{"is_error":true}'})
    const res = await new ClaudeRuntime({spawn}).execute('a', action({type: 'shell', run: 'echo x'}), ctx()).result
    expect(res.status).toBe('success') // is_error ignored: it is not a claude action
    expect(calls[0].cmd).toBe('sh')
  })

  it('a codex action routed here still goes through the Codex gate', async () => {
    const {spawn, calls} = makeSpawn({code: 0})
    const res = await new ClaudeRuntime({spawn})
      .execute('a', action({type: 'codex', run: 'x'}), ctx({guardrailsInstalled: () => false}))
      .result
    expect(res.errorCode).toBe('C412-GUARDRAILS-001')
    expect(calls).toHaveLength(0)
  })
})

describe('CodexRuntime · contract', () => {
  it('id "codex" and implements the three capabilities of the AgentRuntime contract', () => {
    const rt: AgentRuntime = new CodexRuntime()
    expect(rt.id).toBe('codex')
    expect(typeof rt.healthCheck).toBe('function')
    expect(typeof rt.execute).toBe('function')
  })
})

describe('CodexRuntime · healthCheck', () => {
  it('probes the availability with `codex --version`', async () => {
    const {spawn, calls} = makeSpawn({code: 0})
    await new CodexRuntime({spawn}).healthCheck()
    expect(calls[0].cmd).toBe('codex')
    expect(calls[0].args).toEqual(['--version'])
  })

  it('codex raggiungibile (exit 0) → available true', async () => {
    const {spawn} = makeSpawn({code: 0})
    expect((await new CodexRuntime({spawn}).healthCheck()).available).toBe(true)
  })

  it('codex not ready (exit ≠ 0) → available false with detail', async () => {
    const {spawn} = makeSpawn({code: 1})
    const health = await new CodexRuntime({spawn}).healthCheck()
    expect(health.available).toBe(false)
    expect(health.detail).toContain('exit 1')
  })
})

describe('CodexRuntime · execute · outcome via exit code', () => {
  const ctx = (extra?: Record<string, unknown>) => ({playbookDir: '/pb', logDir: dir, now, guardrailsInstalled: () => true, ...TEST_EXEC_CTX, ...extra})

  it('spawns `codex exec` with the resolved argv (default sandbox + prompt after `--`)', async () => {
    const {spawn, calls} = makeSpawn({code: 0})
    await new CodexRuntime({spawn}).execute('a', action({type: 'codex', run: 'analizza'}), ctx()).result
    expect(calls[0].cmd).toBe('codex')
    expect(calls[0].args).toContain('read-only')
    expect(calls[0].args).toContain('features.hooks=true')
    expect(calls[0].args.some((arg) => arg.includes('shell_command|exec_command'))).toBe(true)
    expect(calls[0].args.slice(-2)).toEqual(['--', 'analizza'])
  })

  it('exit 0 → success', async () => {
    const {spawn} = makeSpawn({code: 0, stdout: 'fatto'})
    const res = await new CodexRuntime({spawn}).execute('a', action({type: 'codex', run: 'x'}), ctx()).result
    expect(res.status).toBe('success')
    expect(res.exitCode).toBe(0)
  })

  it('exit ≠ 0 → failure (the exit code is the source of truth: `codex exec` exits ≠0 on a failed turn)', async () => {
    const {spawn} = makeSpawn({code: 1, stdout: 'errore'})
    const res = await new CodexRuntime({spawn}).execute('a', action({type: 'codex', run: 'x'}), ctx()).result
    expect(res.status).toBe('failure')
    expect(res.exitCode).toBe(1)
  })

  it('is_error-like output at exit 0 → success (Codex does not downgrade: no JSON interpretation)', async () => {
    const {spawn} = makeSpawn({code: 0, stdout: '{"is_error":true}'})
    const res = await new CodexRuntime({spawn}).execute('a', action({type: 'codex', run: 'x'}), ctx()).result
    expect(res.status).toBe('success')
  })
})

describe('CodexRuntime · execute · gate guardrail', () => {
  const ctx = (extra?: Record<string, unknown>) => ({playbookDir: '/pb', logDir: dir, now, ...TEST_EXEC_CTX, ...extra})

  it('missing policy → C412 rejection, never spawned', async () => {
    const {spawn, calls} = makeSpawn({code: 0})
    const res = await new CodexRuntime({spawn, guardrailsInstalled: () => false})
      .execute('a', action({type: 'codex', run: 'x'}), ctx())
      .result
    expect(res.errorCode).toBe('C412-GUARDRAILS-001')
    expect(calls).toHaveLength(0)
  })

  it('a claude action routed here still goes through the Claude gate', async () => {
    const {spawn, calls} = makeSpawn({code: 0})
    const res = await new CodexRuntime({spawn})
      .execute('a', action({type: 'claude', run: '/x'}), ctx({guardrailsInstalled: () => false}))
      .result
    expect(res.errorCode).toBe('C412-GUARDRAILS-001')
    expect(calls).toHaveLength(0)
  })
})

describe('CodexRuntime · execute · authorized directory and traceability (Scenario 1)', () => {
  const ctx = (extra?: Record<string, unknown>) => ({playbookDir: '/pb', logDir: dir, now, guardrailsInstalled: () => true, ...TEST_EXEC_CTX, ...extra})

  it('works in the authorized directory (resolved cwd) and traces command + output in the log', async () => {
    const {spawn} = makeSpawn({code: 0, stdout: 'risultato dell’agente'})
    const res = await new CodexRuntime({spawn})
      .execute('audit', action({type: 'codex', run: 'controlla', cwd: 'repo/target'}), ctx())
      .result
    expect(res.status).toBe('success')
    const log = fs.readFileSync(res.logPath, 'utf8')
    expect(log).toContain('# cwd:     /pb/repo/target') // directory autorizzata
    expect(log).toContain('codex --ask-for-approval never --dangerously-bypass-hook-trust exec --ignore-user-config --sandbox read-only') // comando tracciato
    expect(log).toContain('risultato dell’agente') // output tracciato
  })
})

describe('CodexRuntime · execute · timeout e cancel', () => {
  const ctx = (extra?: Record<string, unknown>) => ({playbookDir: '/pb', logDir: dir, now, guardrailsInstalled: () => true, ...TEST_EXEC_CTX, ...extra})

  it('timeout → status timeout preservato', async () => {
    vi.useFakeTimers()
    const {spawn} = makeSpawn({hang: true})
    const exec = new CodexRuntime({spawn}).execute('a', action({type: 'codex', run: 'x', timeout: 2}), ctx())
    await vi.advanceTimersByTimeAsync(2000)
    await vi.advanceTimersByTimeAsync(5000)
    const res = await exec.result
    expect(res.status).toBe('timeout')
    expect(res.errorCode).toBe('C124-EXEC-001')
    vi.useRealTimers()
  })

  it('cancel() cancels the running execution → failure', async () => {
    vi.useFakeTimers()
    const {spawn} = makeSpawn({hang: true})
    const exec = new CodexRuntime({spawn}).execute('a', action({type: 'codex', run: 'x'}), ctx())
    exec.cancel()
    await vi.advanceTimersByTimeAsync(5000)
    const res = await exec.result
    expect(res.status).toBe('failure')
    expect(res.exitCode).toBeNull()
    vi.useRealTimers()
  })

  it('an aborted external signal cancels the execution', async () => {
    vi.useFakeTimers()
    const {spawn} = makeSpawn({hang: true})
    const controller = new AbortController()
    controller.abort()
    const exec = new CodexRuntime({spawn}).execute('a', action({type: 'codex', run: 'x'}), ctx({signal: controller.signal}))
    await vi.advanceTimersByTimeAsync(5000)
    const res = await exec.result
    expect(res.status).toBe('failure')
    vi.useRealTimers()
  })
})

// CYAU-25 · "the same forbidden cases are blocked for Claude and Codex": the command policy lives in the process
// wrapper (runAction), so it applies through EVERY runtime — not only the claude bypass session (`--settings` hook).
describe('runtime-independent command policy (CYAU-25, Scenario 1)', () => {
  const ctx = (extra?: Record<string, unknown>) => ({playbookDir: '/pb', logDir: dir, now, guardrailsInstalled: () => true, ...TEST_EXEC_CTX, ...extra})

  it('SpawnRuntime · shell action with deploy → rejected C412-POLICY-001, never spawned', async () => {
    const {spawn, calls} = makeSpawn({code: 0})
    const res = await new SpawnRuntime({spawn}).execute('a', action({type: 'shell', run: 'kamal deploy'}), ctx()).result
    expect(res.errorCode).toBe('C412-POLICY-001')
    expect(calls).toHaveLength(0)
  })

  it('SpawnRuntime · shell action with force-push → rejected, never spawned', async () => {
    const {spawn, calls} = makeSpawn({code: 0})
    const res = await new SpawnRuntime({spawn}).execute('a', action({type: 'shell', run: 'git push --force origin main'}), ctx()).result
    expect(res.errorCode).toBe('C412-POLICY-001')
    expect(calls).toHaveLength(0)
  })

  it('ClaudeRuntime · on_failure with cyi production → rejected, never spawned', async () => {
    const {spawn, calls} = makeSpawn({code: 0})
    const res = await new ClaudeRuntime({spawn})
      .execute('a', action({type: 'claude', run: '/x', on_failure: {run: 'cyi run -p CYI -e production -- bin/rails c'}}), ctx())
      .result
    expect(res.errorCode).toBe('C412-POLICY-001')
    expect(calls).toHaveLength(0)
  })

  it('CodexRuntime · on_failure with cyi production → rejected, never spawned', async () => {
    const {spawn, calls} = makeSpawn({code: 0})
    const res = await new CodexRuntime({spawn})
      .execute('a', action({type: 'codex', run: 'x', on_failure: {run: 'cyi run -p CYI -e production -- bin/rails c'}}), ctx())
      .result
    expect(res.errorCode).toBe('C412-POLICY-001')
    expect(calls).toHaveLength(0)
  })

  it('CodexRuntime · delegated destructive shell action (DB) → rejected, never spawned', async () => {
    const {spawn, calls} = makeSpawn({code: 0})
    const res = await new CodexRuntime({spawn}).execute('a', action({type: 'shell', run: 'psql -c "TRUNCATE users"'}), ctx()).result
    expect(res.errorCode).toBe('C412-POLICY-001')
    expect(calls).toHaveLength(0)
  })

  it('an agent prompt is NOT a command: a claude action mentioning "deploy" proceeds (no false positive)', async () => {
    const {spawn, calls} = makeSpawn({code: 0, stdout: '{"is_error":false}'})
    const res = await new ClaudeRuntime({spawn}).execute('a', action({type: 'claude', run: 'valuta se serve un deploy kamal'}), ctx()).result
    expect(res.status).toBe('success')
    expect(calls).toHaveLength(1)
  })
})

describe('probeRuntimes · doctor probes both runtimes (CYAU-5, Scenario 1)', () => {
  it('probes claude and codex with a non-destructive probe (--version), without touching credentials', async () => {
    const {spawn, calls} = makeSpawn([{code: 0}, {code: 0}])
    const statuses = await probeRuntimes(spawn)
    expect(statuses.map((s) => s.id)).toEqual(['claude', 'codex'])
    expect(calls).toHaveLength(2)
    expect(calls[0]).toMatchObject({cmd: 'claude', args: ['--version']})
    expect(calls[1]).toMatchObject({cmd: 'codex', args: ['--version']})
  })

  it('reachable runtime (exit 0) → available true, no problem nor fix', async () => {
    const {spawn} = makeSpawn([{code: 0}, {code: 0}])
    const [claude, codex] = await probeRuntimes(spawn)
    expect(claude.available).toBe(true)
    expect(claude.detail).toBeUndefined()
    expect(claude.fix).toBeUndefined()
    expect(codex.available).toBe(true)
  })

  it('claude is a required runtime, codex is optional (availability evaluated separately)', async () => {
    const {spawn} = makeSpawn([{code: 0}, {code: 0}])
    const [claude, codex] = await probeRuntimes(spawn)
    expect(claude.required).toBe(true)
    expect(codex.required).toBe(false)
  })

  it('runtime not ready (exit ≠ 0) → available false with the problem and a practicable fix without secrets', async () => {
    const {spawn} = makeSpawn([{code: 0}, {code: 1}]) // claude ok, codex esce ≠0
    const [, codex] = await probeRuntimes(spawn)
    expect(codex.available).toBe(false)
    expect(codex.detail).toContain('exit 1') // problem shown
    expect(codex.fix).toContain('automator setup') // practicable fix
    expect(codex.fix).not.toMatch(/cyi_|sk-|token|oauth|CLAUDE_CODE/i) // no secret
  })

  it('missing binary (error event) → available false with the message, practicable fix, never crash', async () => {
    const {spawn} = makeSpawn([{errorEvent: true}, {code: 0}])
    const [claude] = await probeRuntimes(spawn)
    expect(claude.available).toBe(false)
    expect(claude.detail).toContain('spawn boom')
    expect(claude.fix).toContain('automator setup')
  })

  it('a stuck runtime times out without stopping the others and the whole process is cleaned up', async () => {
    vi.useFakeTimers()
    const signals: Array<{pid: number; signal: NodeJS.Signals}> = []
    const calls: Array<{cmd: string; detached: boolean | undefined}> = []
    let nextPid = 100
    const spawn: SpawnFn = (cmd, _args, opts) => {
      const pid = nextPid++
      calls.push({cmd, detached: opts.detached})
      let closeCb: ((code: number | null, signal: NodeJS.Signals | null) => void) | undefined
      const child: ChildLike = {
        pid,
        stdout: null,
        stderr: null,
        on: (event, cb) => {
          if (event === 'close') {
            closeCb = cb as typeof closeCb
            if (cmd === 'codex') queueMicrotask(() => closeCb?.(0, null))
          }
        },
        kill: () => true,
      }
      return child
    }
    const kill: ProbeKillFn = (pid, signal) => {
      signals.push({pid, signal})
    }

    const pending = probeRuntimes(spawn, AGENT_RUNTIMES, {timeoutMs: 20, killGraceMs: 10, kill})
    await vi.advanceTimersByTimeAsync(20)
    expect(signals).toContainEqual({pid: -100, signal: 'SIGTERM'})
    await vi.advanceTimersByTimeAsync(10)
    const [claude, codex] = await pending

    expect(claude).toMatchObject({available: false, detail: 'timeout dopo 20ms'})
    expect(codex.available).toBe(true)
    expect(calls).toEqual([
      {cmd: 'claude', detached: true},
      {cmd: 'codex', detached: true},
    ])
    expect(signals).toContainEqual({pid: -100, signal: 'SIGKILL'})
  })

  it('a late close after the timeout does not change the outcome and does not leak process output', async () => {
    vi.useFakeTimers()
    let closeHung: ((code: number | null, signal: NodeJS.Signals | null) => void) | undefined
    const spawn: SpawnFn = (cmd) => ({
      pid: cmd === 'claude' ? 201 : 202,
      stdout: {on: (_event, cb) => cb('cyi_ah_SEGRETO')},
      stderr: {on: () => undefined},
      on: (event, cb) => {
        if (event !== 'close') return
        if (cmd === 'claude') closeHung = cb as typeof closeHung
        else queueMicrotask(() => (cb as (code: number | null, signal: NodeJS.Signals | null) => void)(0, null))
      },
      kill: () => true,
    })

    const pending = probeRuntimes(spawn, AGENT_RUNTIMES, {timeoutMs: 5, killGraceMs: 5, kill: () => undefined})
    await vi.advanceTimersByTimeAsync(5)
    await vi.advanceTimersByTimeAsync(5)
    const result = await pending
    closeHung?.(0, null)

    expect(result[0].available).toBe(false)
    expect(result[0].detail).toBe('timeout dopo 5ms')
    expect(JSON.stringify(result)).not.toContain('cyi_ah_SEGRETO')
  })
})
