import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import {EventEmitter} from 'node:events'
import {PassThrough} from 'node:stream'
import {afterAll, describe, expect, it, vi} from 'vitest'
import {
  agentQuotaReport,
  detectQuotaLimit,
  makeQuotaGate,
  noteQuotaFailure,
  QUOTA_FALLBACK_PAUSE_MS,
  readClaudeQuota,
  readCodexQuota,
  readQuotaPause,
  recordQuotaPause,
} from '../src/lib/agent-quota'

// CYAU-275: a quota limit is a pause with a resume time, not a failure.

const dirs: string[] = []
function pauseFile(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'quota-'))
  dirs.push(dir)
  return path.join(dir, 'quota-pause.json')
}
afterAll(() => {
  for (const dir of dirs) fs.rmSync(dir, {recursive: true, force: true})
})

const now = new Date('2026-11-03T10:00:00.000Z')
const minutes = (value: number) => value * 60_000
const claudeError = (result: string) => JSON.stringify({type: 'result', is_error: true, result})
const codexError = (message: string) => JSON.stringify({type: 'error', message})

describe('detectQuotaLimit', () => {
  it.each([
    ['"resets_in_seconds":7200', '2026-11-03T12:00:00.000Z'],
    ['"resets_at":1793707200', '2026-11-03T12:00:00.000Z'],
    ['"resets_at":"2026-11-03T12:00:00.000Z"', '2026-11-03T12:00:00.000Z'],
  ])('reads embedded API reset %s only inside the engine error', (reset, expected) => {
    const message = `429: {"error":{"type":"usage_limit_reached",${reset}}}`
    expect(detectQuotaLimit(codexError(message), now)).toEqual({resetAt: new Date(expected), explicit: true})
    expect(detectQuotaLimit(JSON.stringify({type: 'error', message: 'usage limit reached', text: message}), now))
      .toEqual({resetAt: new Date(now.getTime() + QUOTA_FALLBACK_PAUSE_MS), explicit: false})
  })
  it.each([
    'usage limit reached; try again in 5 hours',
    '{"type":"error","message":"usage limit reached"',
    JSON.stringify({type: 'result', is_error: false, result: 'usage limit reached'}),
    JSON.stringify({type: 'result', is_error: 'true', result: 'usage limit reached'}),
    JSON.stringify({type: 'assistant', message: {type: 'error', message: 'usage limit reached'}}),
    JSON.stringify({type: 'item.completed', item: {type: 'command_execution', aggregated_output: '{"type":"error","message":"usage limit reached"}'}}),
    JSON.stringify({type: 'turn.failed', error: {message: {text: 'usage limit reached'}}}),
    'null', '[]',
  ])('rejects work content or malformed envelopes: %s', (text) => {
    expect(detectQuotaLimit(text, now)).toBeNull()
  })

  it.each(['"resets_in_seconds":0', '"resets_in_seconds":-1', '"resets_at":1000000000', '"resets_at":"invalid"'])('defaults for an unusable embedded reset: %s', (reset) => {
    expect(detectQuotaLimit(codexError(`{"error":{"type":"usage_limit_reached",${reset}}}`), now))
      .toEqual({resetAt: new Date(now.getTime() + QUOTA_FALLBACK_PAUSE_MS), explicit: false})
  })

  it('uses only the reset in the same recognized error field', () => {
    const event = {type: 'turn.failed', error: {message: 'usage limit reached'}, text: 'try again in 7 days', resets_in_seconds: 90000}
    expect(detectQuotaLimit(JSON.stringify(event), now, 'UTC', 'codex'))
      .toEqual({resetAt: new Date(now.getTime() + QUOTA_FALLBACK_PAUSE_MS), explicit: false})
    event.error.message = 'usage limit reached; try again in 2 hours'
    expect(detectQuotaLimit(JSON.stringify(event), now, 'UTC', 'codex')?.resetAt)
      .toEqual(new Date(now.getTime() + minutes(120)))
  })

  it('keeps the runtime boundary and the maximum pause', () => {
    expect(detectQuotaLimit(claudeError('usage limit reached'), now, undefined, 'codex')).toBeNull()
    expect(detectQuotaLimit(codexError('usage limit reached'), now, undefined, 'claude')).toBeNull()
    expect(detectQuotaLimit(codexError('usage limit reached; try again in 90 days'), now)?.resetAt)
      .toEqual(new Date(now.getTime() + 8 * 24 * 60 * 60_000))
  })
  it('reads the reset epoch of the Claude usage-limit result', () => {
    const out = JSON.stringify({type: 'result', is_error: true, result: 'Claude AI usage limit reached|1793790000'})
    expect(detectQuotaLimit(out, now)).toEqual({resetAt: new Date(1_793_790_000_000), explicit: true})
  })

  it('reads the Claude "resets 3pm (zone)" message in that time zone', () => {
    const out = JSON.stringify({type: 'result', is_error: true, result: "You've hit your limit · resets 3pm (Europe/Rome)"})
    // Rome is UTC+1 in November.
    expect(detectQuotaLimit(out, now)).toEqual({resetAt: new Date('2026-11-03T14:00:00.000Z'), explicit: true})
  })

  it('a reset hour already past today means tomorrow', () => {
    const out = claudeError('5-hour limit reached ∙ resets 9am (UTC)')
    expect(detectQuotaLimit(out, now)?.resetAt).toEqual(new Date('2026-11-04T09:00:00.000Z'))
  })

  it('reads the Codex "try again in" duration', () => {
    const out = '{"type":"error","message":"You\'ve hit your usage limit. Upgrade to Pro or try again in 2 hours 5 minutes."}'
    expect(detectQuotaLimit(out, now)).toEqual({resetAt: new Date(now.getTime() + minutes(125)), explicit: true})
  })

  it('reads the Codex "try again at" clock time in the machine zone', () => {
    const out = codexError("You've hit your usage limit. Try again at 3:45 PM.")
    expect(detectQuotaLimit(out, now, 'UTC')?.resetAt).toEqual(new Date('2026-11-03T15:45:00.000Z'))
  })

  it('reads the Codex "try again at" full date', () => {
    const out = codexError("You've hit your usage limit. Try again at Nov 5th, 2026 1:05 AM.")
    expect(detectQuotaLimit(out, now, 'UTC')?.resetAt).toEqual(new Date('2026-11-05T01:05:00.000Z'))
  })

  it('rejects an unverified bare API error envelope', () => {
    const out = '{"error":{"type":"usage_limit_reached","resets_in_seconds":3600}}'
    expect(detectQuotaLimit(out, now)).toBeNull()
  })

  it('a quota signal without a reset time waits the fixed prudent delay', () => {
    expect(detectQuotaLimit(codexError("You've hit your usage limit. Try again later."), now))
      .toEqual({resetAt: new Date(now.getTime() + QUOTA_FALLBACK_PAUSE_MS), explicit: false})
  })

  it('a reset time in the past falls back to the prudent delay', () => {
    expect(detectQuotaLimit(claudeError('Claude AI usage limit reached|1000000000'), now))
      .toEqual({resetAt: new Date(now.getTime() + QUOTA_FALLBACK_PAUSE_MS), explicit: false})
  })

  it.each(['resets 99pm', 'resets 3:99pm', 'try again at Feb 31st, 2027 1:05 AM', 'try again at Foo 5th, 2027 1:05 AM'])('defaults to thirty minutes for an unusable reset: %s', (time) => {
    expect(detectQuotaLimit(codexError(`usage limit reached; ${time}`), now))
      .toEqual({resetAt: new Date(now.getTime() + QUOTA_FALLBACK_PAUSE_MS), explicit: false})
  })

  it('a transient rate limit or an API billing error is not a quota pause', () => {
    expect(detectQuotaLimit('"api_error_status":429 rate_limit_error', now)).toBeNull()
    expect(detectQuotaLimit('You exceeded your current quota, please check your plan and billing details.', now)).toBeNull()
    expect(detectQuotaLimit('', now)).toBeNull()
  })
})

describe('quota pause store', () => {
  it('no file means no pause', () => {
    expect(readQuotaPause(now, pauseFile())).toBeNull()
  })

  it('records the pause and keeps it until the reset', () => {
    const file = pauseFile()
    recordQuotaPause('codex', new Date('2026-11-03T12:00:00.000Z'), now, file)
    expect(readQuotaPause(now, file)).toEqual({runtime: 'codex', until: new Date('2026-11-03T12:00:00.000Z')})
    expect(readQuotaPause(new Date('2026-11-03T12:00:00.000Z'), file)).toBeNull()
  })

  it('keeps the later pause of the same engine and reports the latest one', () => {
    const file = pauseFile()
    recordQuotaPause('claude', new Date('2026-11-03T13:00:00.000Z'), now, file)
    recordQuotaPause('claude', new Date('2026-11-03T11:00:00.000Z'), now, file)
    recordQuotaPause('codex', new Date('2026-11-03T12:00:00.000Z'), now, file)
    expect(readQuotaPause(now, file)).toEqual({runtime: 'claude', until: new Date('2026-11-03T13:00:00.000Z')})
  })

  it('an unreadable record is a short pause, never a green light', () => {
    const file = pauseFile()
    fs.writeFileSync(file, '{not json')
    const pause = readQuotaPause(new Date(), file)
    expect(pause?.runtime).toBeNull()
    expect(pause!.until.getTime()).toBeGreaterThan(Date.now())
    expect(readQuotaPause(new Date(Date.now() + QUOTA_FALLBACK_PAUSE_MS + 1000), file)).toBeNull()
  })

  // CYAU-305 — only the engines this machine uses count; an unreadable record counts whatever they are.
  it('reads only the pauses of the engines asked for', () => {
    const file = pauseFile()
    recordQuotaPause('claude', new Date('2026-11-03T13:00:00.000Z'), now, file)
    recordQuotaPause('codex', new Date('2026-11-03T12:00:00.000Z'), now, file)
    expect(readQuotaPause(now, file, ['codex'])).toEqual({runtime: 'codex', until: new Date('2026-11-03T12:00:00.000Z')})
    expect(readQuotaPause(now, file, [])).toBeNull()
    const onlyClaude = pauseFile()
    recordQuotaPause('claude', new Date('2026-11-03T13:00:00.000Z'), now, onlyClaude)
    expect(readQuotaPause(now, onlyClaude, ['codex'])).toBeNull()
  })

  it('an unreadable record is a short pause even for an engine list without it', () => {
    const file = pauseFile()
    fs.writeFileSync(file, '{not json')
    expect(readQuotaPause(new Date(), file, ['codex'])?.runtime).toBeNull()
  })

  it('noteQuotaFailure pauses the engine only on a clear quota signal', () => {
    const file = pauseFile()
    expect(noteQuotaFailure('claude', undefined, now, file)).toBeNull()
    expect(readQuotaPause(now, file)).toBeNull()
    const until = noteQuotaFailure('claude', detectQuotaLimit(claudeError('Claude AI usage limit reached|1793790000'), now), now, file)
    expect(until).toEqual(new Date(1_793_790_000_000))
    expect(readQuotaPause(now, file)).toEqual({runtime: 'claude', until})
  })
})

describe('makeQuotaGate', () => {
  const plenty = {runtime: 'claude' as const, windows: [{remaining_percent: 80, resets_at: null}]}

  it('an active pause stops the claim without reading the quota', async () => {
    const file = pauseFile()
    recordQuotaPause('codex', new Date('2026-11-03T12:00:00.000Z'), now, file)
    const claude = vi.fn(async () => plenty)
    const gate = makeQuotaGate({now: () => now, file, readers: {claude, codex: claude}})

    expect(await gate()).toEqual({ready: false, detail: 'codex quota exhausted: paused until 2026-11-03T12:00:00.000Z', runtime: 'codex'})
    expect(claude).not.toHaveBeenCalled()
  })

  // CYAU-305 — scenario 1: a machine all on Codex is not stopped by Claude's pause, nor reads Claude's quota.
  it('a pause of an engine not in use does not stop the claim', async () => {
    const file = pauseFile()
    recordQuotaPause('claude', new Date('2026-11-03T12:00:00.000Z'), now, file)
    const claude = vi.fn(async () => plenty)
    const codex = vi.fn(async () => ({runtime: 'codex' as const, windows: [{remaining_percent: 80, resets_at: null}]}))
    const gate = makeQuotaGate({now: () => now, file, readers: {claude, codex}})

    expect(await gate(['codex'])).toEqual({ready: true})
    expect(claude).not.toHaveBeenCalled()
    expect(codex).toHaveBeenCalledTimes(1)
  })

  // Scenario 4: without a list both engines count, as before.
  it('without a list of engines a pause of either one stops the claim', async () => {
    const file = pauseFile()
    recordQuotaPause('claude', new Date('2026-11-03T12:00:00.000Z'), now, file)
    const gate = makeQuotaGate({now: () => now, file, readers: {claude: async () => plenty, codex: async () => null}})

    expect(await gate()).toEqual({ready: false, detail: 'claude quota exhausted: paused until 2026-11-03T12:00:00.000Z', runtime: 'claude'})
  })

  // Scenario 9: the engine in use is paused.
  it('a pause of the engine in use stops the claim', async () => {
    const file = pauseFile()
    recordQuotaPause('codex', new Date('2026-11-03T12:00:00.000Z'), now, file)
    const gate = makeQuotaGate({now: () => now, file, readers: {claude: async () => plenty, codex: async () => null}})

    expect(await gate(['codex'])).toEqual({ready: false, detail: 'codex quota exhausted: paused until 2026-11-03T12:00:00.000Z', runtime: 'codex'})
  })

  // Scenario 10: which engine is paused is unknown, so the pause holds whatever the engines in use.
  it('an unreadable pause record stops a machine all on Codex for the short wait', async () => {
    const file = pauseFile()
    fs.writeFileSync(file, '{not json')
    const gate = makeQuotaGate({file, readers: {claude: async () => plenty, codex: async () => null}})

    const result = await gate(['codex'])
    expect(result).toMatchObject({ready: false, runtime: null})
    expect((result as {detail: string}).detail).toMatch(/^agent quota exhausted: paused until /)
  })

  it('low quota of an engine not in use does not stop the claim', async () => {
    const file = pauseFile()
    const claude = vi.fn(async () => ({runtime: 'claude' as const, windows: [{remaining_percent: 2, resets_at: null}]}))
    const gate = makeQuotaGate({now: () => now, file, readers: {claude, codex: async () => null}})

    expect(await gate(['codex'])).toEqual({ready: true})
    expect(claude).not.toHaveBeenCalled()
    expect(readQuotaPause(now, file)).toBeNull()
  })

  it('quota below 10% stops the claim and pauses until that window resets', async () => {
    const file = pauseFile()
    const gate = makeQuotaGate({now: () => now, file, readers: {
      claude: async () => plenty,
      codex: async () => ({runtime: 'codex', windows: [
        {remaining_percent: 50, resets_at: '2026-11-08T00:00:00.000Z'},
        {remaining_percent: 9, resets_at: '2026-11-03T11:30:00.000Z'},
      ]}),
    }})

    expect(await gate()).toEqual({ready: false, detail: 'codex quota below 10% (9% left): paused until 2026-11-03T11:30:00.000Z', runtime: 'codex'})
    expect(readQuotaPause(now, file)).toEqual({runtime: 'codex', until: new Date('2026-11-03T11:30:00.000Z')})
  })

  it('exactly 10% left still works', async () => {
    const gate = makeQuotaGate({now: () => now, file: pauseFile(), readers: {
      claude: async () => ({runtime: 'claude', windows: [{remaining_percent: 10, resets_at: null}]}),
      codex: async () => null,
    }})
    expect(await gate()).toEqual({ready: true})
  })

  it('a quota reading that fails or is unknown lets the machine work', async () => {
    const gate = makeQuotaGate({now: () => now, file: pauseFile(), readers: {
      claude: async () => { throw new Error('endpoint changed') },
      codex: async () => null,
    }})
    expect(await gate()).toEqual({ready: true})
  })

  it('caches a reading for a few minutes', async () => {
    let clock = now.getTime()
    const claude = vi.fn(async () => plenty)
    const gate = makeQuotaGate({now: () => new Date(clock), file: pauseFile(), readers: {claude, codex: async () => null}})
    await gate()
    clock += minutes(1)
    await gate()
    expect(claude).toHaveBeenCalledTimes(1)
    clock += minutes(10)
    await gate()
    expect(claude).toHaveBeenCalledTimes(2)
  })

  it('the report says unknown quota as null, never as zero', async () => {
    const file = pauseFile()
    const gate = makeQuotaGate({now: () => now, file, readers: {
      claude: async () => ({runtime: 'claude', windows: [
        {remaining_percent: 60, resets_at: '2026-11-03T15:00:00.000Z'},
        {remaining_percent: 40, resets_at: '2026-11-08T00:00:00.000Z'},
      ]}),
      codex: async () => null,
    }})
    await gate()
    expect(gate.report(now)).toEqual([
      {runtime: 'claude', remaining_percent: 40, resets_at: '2026-11-08T00:00:00.000Z', paused_until: null},
      {runtime: 'codex', remaining_percent: null, resets_at: null, paused_until: null},
    ])
  })

  it('the default report reads the pause from disk', () => {
    const file = pauseFile()
    recordQuotaPause('claude', new Date('2026-11-03T12:00:00.000Z'), now, file)
    expect(agentQuotaReport(now, undefined, file)).toEqual([
      {runtime: 'claude', remaining_percent: null, resets_at: null, paused_until: '2026-11-03T12:00:00.000Z'},
      {runtime: 'codex', remaining_percent: null, resets_at: null, paused_until: null},
    ])
  })
})

describe('readClaudeQuota', () => {
  const response = (body: unknown, ok = true) => ({ok, status: ok ? 200 : 500, json: async () => body}) as unknown as Response

  it('asks the usage endpoint with the OAuth token and maps both windows', async () => {
    const fetchFn = vi.fn(async () => response({
      five_hour: {utilization: 37, resets_at: '2026-11-03T14:00:00+00:00'},
      seven_day: {utilization: 95.5, resets_at: '2026-11-08T00:00:00+00:00'},
    }))
    const reading = await readClaudeQuota({fetchFn, token: () => 'sk-ant-oat-token'})

    expect(reading).toEqual({runtime: 'claude', windows: [
      {remaining_percent: 63, resets_at: '2026-11-03T14:00:00.000Z'},
      {remaining_percent: 4.5, resets_at: '2026-11-08T00:00:00.000Z'},
    ]})
    const [url, init] = fetchFn.mock.calls[0] as unknown as [string, RequestInit]
    expect(url).toBe('https://api.anthropic.com/api/oauth/usage')
    expect((init.headers as Record<string, string>).Authorization).toBe('Bearer sk-ant-oat-token')
  })

  it('without an OAuth token, an error or a changed shape the quota is unknown', async () => {
    expect(await readClaudeQuota({fetchFn: vi.fn(), token: () => null})).toBeNull()
    expect(await readClaudeQuota({fetchFn: async () => response({}, false), token: () => 't'})).toBeNull()
    expect(await readClaudeQuota({fetchFn: async () => response({five_hour: {pct: 3}}), token: () => 't'})).toBeNull()
  })
})

describe('readCodexQuota', () => {
  function fakeAppServer(reply: (message: {id?: number; method: string}) => unknown) {
    const stdin = new PassThrough()
    const stdout = new PassThrough()
    const child = Object.assign(new EventEmitter(), {stdin, stdout, kill: vi.fn()})
    let buffer = ''
    stdin.on('data', (chunk) => {
      buffer += String(chunk)
      let index
      while ((index = buffer.indexOf('\n')) >= 0) {
        const message = JSON.parse(buffer.slice(0, index))
        buffer = buffer.slice(index + 1)
        const answer = reply(message)
        if (answer !== undefined) stdout.write(`${JSON.stringify(answer)}\n`)
      }
    })
    return child
  }

  it('reads the windows from the local app-server', async () => {
    const child = fakeAppServer((message) => {
      if (message.method === 'initialize') return {id: message.id, result: {}}
      if (message.method === 'account/rateLimits/read') {
        return {id: message.id, result: {rateLimits: {
          primary: {usedPercent: 62, windowDurationMins: 10080, resetsAt: 1793775876},
          secondary: null,
        }}}
      }
      return undefined
    })
    const spawnFn = vi.fn(() => child)

    const reading = await readCodexQuota({spawnFn: spawnFn as never})

    expect(reading).toEqual({runtime: 'codex', windows: [{remaining_percent: 38, resets_at: new Date(1_793_775_876_000).toISOString()}]})
    expect(spawnFn).toHaveBeenCalledWith('codex', ['app-server'], expect.anything())
    expect(child.kill).toHaveBeenCalled()
  })

  it('an app-server that does not answer in time means unknown quota', async () => {
    const child = fakeAppServer(() => undefined)
    expect(await readCodexQuota({spawnFn: (() => child) as never, timeoutMs: 20})).toBeNull()
    expect(child.kill).toHaveBeenCalled()
  })
})
