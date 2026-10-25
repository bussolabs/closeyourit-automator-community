import {describe, expect, it, vi} from 'vitest'
import {buildCapabilities as buildCapabilitiesRaw, collectRuntimes, combineBeats, heartbeatMissingReason, makeHeartbeat as makeHeartbeatRaw, sendHeartbeat, type HostCapabilities} from '../src/lib/heartbeat'
import {type HostActivity, IDLE_ACTIVITY} from '../src/lib/activity'
import {type HeartbeatConfig} from '../src/lib/config'
import {type ProbeResult} from '../src/lib/deps'

const cfg: HeartbeatConfig = {projectId: 'PID', slug: 'automator-tick', token: 'cyi_ingest'}

// The tests are deterministic on any workstation; the real runtime stays validated fail-closed.
const buildCapabilities = (input: Parameters<typeof buildCapabilitiesRaw>[0] = {}) =>
  buildCapabilitiesRaw({platform: 'linux', arch: 'x64', ...input})
const makeHeartbeat = (
  secrets: Parameters<typeof makeHeartbeatRaw>[0],
  opts: Parameters<typeof makeHeartbeatRaw>[1] = {},
) => makeHeartbeatRaw(secrets, {platform: 'linux', arch: 'x64', ...opts})

const CAPS: HostCapabilities = {
  automator_version: '0.0.1',
  platform: 'linux',
  arch: 'x64',
  runtimes: [{name: 'node', present: true, version: 'v24.11.0', required: true}],
  repositories: ['CYAU'],
  running: 0,
  slots: 1,
}

function fakeFetch(response: {ok: boolean} = {ok: true}) {
  const calls: Array<{url: string; opts: RequestInit}> = []
  const fn = vi.fn(async (url: string | URL, opts?: RequestInit) => {
    calls.push({url: String(url), opts: opts ?? {}})
    return {ok: response.ok} as Response
  })
  return {fn: fn as unknown as typeof globalThis.fetch, calls}
}

describe('sendHeartbeat', () => {
  it('POST to the check_in endpoint with Bearer token and status ok', async () => {
    const {fn, calls} = fakeFetch()
    const result = await sendHeartbeat(cfg, 'cyi_ah_host', true, undefined, fn)
    expect(result).toBe(true)
    expect(calls[0].url).toBe('https://app.closeyour.it/api/v1/projects/PID/crons/automator-tick/check_in')
    expect((calls[0].opts.headers as Record<string, string>).Authorization).toBe('Bearer cyi_ah_host')
    expect(JSON.parse(calls[0].opts.body as string).status).toBe('ok')
  })

  it('ok=false → body status fail', async () => {
    const {fn, calls} = fakeFetch()
    await sendHeartbeat(cfg, 'cyi_ah_host', false, undefined, fn)
    expect(JSON.parse(calls[0].opts.body as string).status).toBe('fail')
  })

  it('rispetta apiUrl custom', async () => {
    const {fn, calls} = fakeFetch()
    await sendHeartbeat({...cfg, apiUrl: 'http://localhost:3011'}, 'cyi_ah_host', true, undefined, fn)
    expect(calls[0].url).toContain('http://localhost:3011/api/v1/projects/PID')
  })

  it('network error → false (best-effort, does not throw)', async () => {
    const fn = (async () => {
      throw new Error('network down')
    }) as unknown as typeof globalThis.fetch
    await expect(sendHeartbeat(cfg, 'cyi_ah_host', true, undefined, fn)).resolves.toBe(false)
  })

  it('non-ok response → false', async () => {
    const {fn} = fakeFetch({ok: false})
    expect(await sendHeartbeat(cfg, 'cyi_ah_host', true, undefined, fn)).toBe(false)
  })

  it('without a valid host token fails closed without sending requests', async () => {
    const {fn, calls} = fakeFetch()
    expect(await sendHeartbeat(cfg, undefined, true, undefined, fn)).toBe(false)
    expect(await sendHeartbeat(cfg, 'cyi_a_org', true, undefined, fn)).toBe(false)
    expect(calls).toHaveLength(0)
  })

  it('without capabilities → body with only the monitor fields (backward compat)', async () => {
    const {fn, calls} = fakeFetch()
    await sendHeartbeat(cfg, 'cyi_ah_host', true, undefined, fn)
    const body = JSON.parse(calls[0].opts.body as string)
    expect(body).toEqual({status: 'ok', environment: 'production', expected_interval_minutes: 2, grace_minutes: 1})
  })

  it('with capabilities → capabilities and state attached to the body', async () => {
    const {fn, calls} = fakeFetch()
    await sendHeartbeat(cfg, 'cyi_ah_host', true, CAPS, fn)
    const body = JSON.parse(calls[0].opts.body as string)
    expect(body.automator_version).toBe('0.0.1')
    expect(body.platform).toBe('linux')
    expect(body.arch).toBe('x64')
    expect(body.runtimes).toEqual([{name: 'node', present: true, version: 'v24.11.0', required: true}])
    expect(body.repositories).toEqual(['CYAU'])
    expect(body.running).toBe(0)
    expect(body.slots).toBe(1)
  })

  it('with capabilities → the monitor fields stay intact (non-updated host → offline)', async () => {
    const {fn, calls} = fakeFetch()
    await sendHeartbeat(cfg, 'cyi_ah_host', true, CAPS, fn)
    const body = JSON.parse(calls[0].opts.body as string)
    expect(body.status).toBe('ok')
    expect(body.environment).toBe('production')
    expect(body.expected_interval_minutes).toBe(2)
    expect(body.grace_minutes).toBe(1)
  })

  it('with last_stops → the latest blocks end up in the body (CYAU-116)', async () => {
    const {fn, calls} = fakeFetch()
    await sendHeartbeat(cfg, 'cyi_ah_host', false, {...CAPS, last_stops: [{action: 'cyau', state: 'blocked', reason: 'limite raggiunto'}]}, fn)
    const body = JSON.parse(calls[0].opts.body as string)
    expect(body.last_stops).toEqual([{action: 'cyau', state: 'blocked', reason: 'limite raggiunto'}])
  })
})

describe('collectRuntimes', () => {
  it('maps the runtime probes to name/presence/version without exposing the bin', () => {
    const probes: ProbeResult[] = [
      {name: 'node', bin: 'node', present: true, version: 'v24.11.0', required: true},
      {name: 'claude', bin: 'claude', present: false, version: null, required: true},
    ]
    const runtimes = collectRuntimes(() => probes)
    expect(runtimes).toEqual([
      {name: 'node', present: true, version: 'v24.11.0', required: true},
      {name: 'claude', present: false, version: null, required: true},
    ])
    expect(runtimes[0]).not.toHaveProperty('bin')
  })
})

describe('buildCapabilities', () => {
  const probes: ProbeResult[] = [{name: 'node', bin: 'node', present: true, version: 'v1', required: true}]

  it('composes version, platform, runtime, repository, load and slots', () => {
    const caps = buildCapabilities({
      version: '0.0.1',
      platform: 'linux',
      arch: 'x64',
      hosts: {CYAU: {cwd: '/repo/cyau'}, CYI: {cwd: '/repo/cyi'}},
      runtimes: collectRuntimes(() => probes),
    })
    expect(caps.automator_version).toBe('0.0.1')
    expect(caps.platform).toBe('linux')
    expect(caps.arch).toBe('x64')
    expect(caps.runtimes).toHaveLength(1)
    expect(caps.repositories.sort()).toEqual(['CYAU', 'CYI'])
    expect(caps.running).toBe(0)
    expect(caps.slots).toBe(1)
  })

  it('without version → automator_version omitted', () => {
    const caps = buildCapabilities({platform: 'linux', arch: 'x64', runtimes: []})
    expect(caps).not.toHaveProperty('automator_version')
  })

  it('host_id present → attached to the capabilities (server-side attribution, CYAU-31); missing → omitted', () => {
    expect(buildCapabilities({hostId: 'host-abc', runtimes: []}).host_id).toBe('host-abc')
    expect(buildCapabilities({runtimes: []})).not.toHaveProperty('host_id')
  })

  it('Linux default: running 0, slots 1, no repository', () => {
    const caps = buildCapabilities({runtimes: []})
    expect(caps.platform).toBe('linux')
    expect(caps.arch).toBe('x64')
    expect(caps.repositories).toEqual([])
    expect(caps.running).toBe(0)
    expect(caps.slots).toBe(1)
  })

  it('explicit running/slots pass through (extensible dynamic load)', () => {
    const caps = buildCapabilities({runtimes: [], running: 2, slots: 4})
    expect(caps.running).toBe(2)
    expect(caps.slots).toBe(4)
  })

  it('default runtimes → real probe of the DEPS (stable shape, machine-dependent values)', () => {
    const caps = buildCapabilities({version: '0.0.1', platform: 'linux', arch: 'x64'})
    expect(Array.isArray(caps.runtimes)).toBe(true)
    expect(caps.runtimes.length).toBeGreaterThan(0)
    for (const rt of caps.runtimes) {
      expect(typeof rt.name).toBe('string')
      expect(typeof rt.present).toBe('boolean')
      expect(typeof rt.required).toBe('boolean')
      expect(rt).not.toHaveProperty('bin')
    }
  })

  it('capabilities without secrets: only the keys leave the repositories, never cwd or token', () => {
    const caps = buildCapabilities({
      version: '0.0.1',
      hosts: {CYAU: {cwd: '/Users/me/segreto/repo'}},
      runtimes: collectRuntimes(() => probes),
    })
    const serialized = JSON.stringify(caps)
    expect(caps.repositories).toEqual(['CYAU'])
    expect(serialized).not.toContain('/Users/me/segreto/repo')
    expect(serialized).not.toContain('segreto')
  })
})

describe('makeHeartbeat', () => {
  it('without config → undefined', () => {
    expect(makeHeartbeat({})).toBeUndefined()
  })

  it('with config → callback that sends the check_in with the host capabilities', async () => {
    const {fn, calls} = fakeFetch()
    const hb = makeHeartbeat({heartbeat: cfg, host: {id: 'h1', token: 'cyi_ah_host'}, hosts: {CYAU: {cwd: '/repo'}}}, {version: '0.0.1', runtimes: [], fetchFn: fn, activity: () => IDLE_ACTIVITY})
    expect(hb).toBeDefined()
    await hb!(true)
    expect(calls).toHaveLength(1)
    const body = JSON.parse(calls[0].opts.body as string)
    expect(body.status).toBe('ok')
    expect(body.automator_version).toBe('0.0.1')
    expect(body.repositories).toEqual(['CYAU'])
  })

  // CYAU-247 — a rejected beat used to vanish: the host looked alive locally and offline on the panel.
  it('logs a rejected beat once, with the server code, and logs the recovery', async () => {
    const replies = [
      {ok: false, status: 422, body: {error: {code: 'R422-AGENT-004'}}},
      {ok: false, status: 422, body: {error: {code: 'R422-AGENT-004'}}},
      {ok: true, status: 202, body: {data: {}}},
    ]
    const fn = vi.fn(async () => {
      const reply = replies.shift()!
      return {ok: reply.ok, status: reply.status, json: async () => reply.body} as unknown as Response
    }) as unknown as typeof globalThis.fetch
    const log = vi.fn()
    const hb = makeHeartbeat({heartbeat: cfg, host: {id: 'h1', token: 'cyi_ah_secret'}}, {version: '0.0.1', runtimes: [], fetchFn: fn, activity: () => IDLE_ACTIVITY, log})

    await hb!(true)
    await hb!(true)
    await hb!(true)

    expect(log.mock.calls.map(([line]) => line)).toEqual([
      'heartbeat rejected by CloseYourIt: HTTP 422 R422-AGENT-004 (the panel shows this host as stopped)',
      'heartbeat accepted again by CloseYourIt',
    ])
    expect(JSON.stringify(log.mock.calls)).not.toContain('cyi_ah_secret')
  })

  it('logs an unreachable server without throwing', async () => {
    const fn = (async () => {
      throw new Error('network down')
    }) as unknown as typeof globalThis.fetch
    const log = vi.fn()
    const hb = makeHeartbeat({heartbeat: cfg, host: {id: 'h1', token: 'cyi_ah_host'}}, {version: '0.0.1', runtimes: [], fetchFn: fn, activity: () => IDLE_ACTIVITY, log})

    await hb!(true)

    expect(log).toHaveBeenCalledWith('heartbeat rejected by CloseYourIt: network error (the panel shows this host as stopped)')
  })

  it('ok=false → propagates status fail into the check_in', async () => {
    const {fn, calls} = fakeFetch()
    const hb = makeHeartbeat({heartbeat: cfg, host: {id: 'h1', token: 'cyi_ah_host'}}, {version: '0.0.1', runtimes: [], fetchFn: fn, activity: () => IDLE_ACTIVITY})
    await hb!(false)
    expect(JSON.parse(calls[0].opts.body as string).status).toBe('fail')
  })

  it('registered host → host_id in the body (attribution), never the host token (CYAU-31)', async () => {
    const {fn, calls} = fakeFetch()
    const hb = makeHeartbeat({heartbeat: cfg, host: {id: 'host-abc', token: 'cyi_ah_secret'}}, {version: '0.0.1', runtimes: [], fetchFn: fn, activity: () => IDLE_ACTIVITY})
    await hb!(true)
    const body = JSON.parse(calls[0].opts.body as string)
    expect(body.host_id).toBe('host-abc')
    expect(calls[0].opts.body as string).not.toContain('cyi_ah_secret')
  })

  it('attaches the activity snapshot (host_status + active_runs) to the check_in (CYAU-31)', async () => {
    const {fn, calls} = fakeFetch()
    const activity: HostActivity = {
      host_status: 'busy',
      active_runs: [
        {ticket: 'CYAU-31', run_id: 'run-1', phase: 'implementing', runtime: 'claude', started_at: '2026-07-13T11:30:00.000Z', updated_at: '2026-07-13T11:50:00.000Z', lease_expires_at: '2026-07-13T13:00:00.000Z', lease_health: 'active', stalled: false},
      ],
    }
    const hb = makeHeartbeat({heartbeat: cfg, host: {id: 'h1', token: 'cyi_ah_host'}}, {version: '0.0.1', runtimes: [], fetchFn: fn, activity: () => activity})
    await hb!(true)
    const body = JSON.parse(calls[0].opts.body as string)
    expect(body.host_status).toBe('busy')
    expect(body.active_runs).toHaveLength(1)
    expect(body.active_runs[0]).toMatchObject({ticket: 'CYAU-31', phase: 'implementing', runtime: 'claude'})
    // the monitor fields stay first and intact (cron_missed watchdog unchanged)
    expect(body.status).toBe('ok')
    expect(body.expected_interval_minutes).toBe(2)
  })

  it('the activity is RECOMPUTED at every beat (not a snapshot at boot)', async () => {
    const {fn, calls} = fakeFetch()
    const snapshots: HostActivity[] = [
      {host_status: 'busy', active_runs: []},
      {host_status: 'recovery_required', active_runs: []},
    ]
    let i = 0
    const hb = makeHeartbeat({heartbeat: cfg, host: {id: 'h1', token: 'cyi_ah_host'}}, {version: '0.0.1', runtimes: [], fetchFn: fn, activity: () => snapshots[i++]})
    await hb!(true)
    await hb!(true)
    expect(JSON.parse(calls[0].opts.body as string).host_status).toBe('busy')
    expect(JSON.parse(calls[1].opts.body as string).host_status).toBe('recovery_required')
  })

  it('the preflight stops reach the body as last_stops {action,state,reason} (CYAU-116)', async () => {
    const {fn, calls} = fakeFetch()
    const hb = makeHeartbeat({heartbeat: cfg, host: {id: 'h1', token: 'cyi_ah_host'}}, {version: '0.0.1', runtimes: [], fetchFn: fn, activity: () => IDLE_ACTIVITY})
    await hb!(false, [{action: 'cyau', state: 'blocked', reason: 'limite giornaliero raggiunto'}])
    const body = JSON.parse(calls[0].opts.body as string)
    expect(body.last_stops).toEqual([{action: 'cyau', state: 'blocked', reason: 'limite giornaliero raggiunto'}])
    // the monitor fields stay first and intact (cron_missed watchdog unchanged)
    expect(body.status).toBe('fail')
    expect(body.expected_interval_minutes).toBe(2)
  })

  it('last_stops is limited to the last 5 elements (CYAU-116)', async () => {
    const {fn, calls} = fakeFetch()
    const stops = Array.from({length: 7}, (_, k) => ({action: `a${k}`, state: 'blocked', reason: `r${k}`}))
    const hb = makeHeartbeat({heartbeat: cfg, host: {id: 'h1', token: 'cyi_ah_host'}}, {version: '0.0.1', runtimes: [], fetchFn: fn, activity: () => IDLE_ACTIVITY})
    await hb!(false, stops)
    const body = JSON.parse(calls[0].opts.body as string)
    expect(body.last_stops).toHaveLength(5)
    expect(body.last_stops.map((s: {action: string}) => s.action)).toEqual(['a2', 'a3', 'a4', 'a5', 'a6'])
  })

  it('the reserved values in the reason are erased before sending (DoD CYAU-116)', async () => {
    const {fn, calls} = fakeFetch()
    const hb = makeHeartbeat({heartbeat: cfg, host: {id: 'h1', token: 'cyi_ah_host'}}, {version: '0.0.1', runtimes: [], fetchFn: fn, activity: () => IDLE_ACTIVITY})
    await hb!(false, [{action: 'cyau', state: 'blocked', reason: 'token host cyi_ah_deadbeef1234 non valido'}])
    const raw = calls[0].opts.body as string
    expect(raw).not.toContain('cyi_ah_deadbeef1234')
    expect(JSON.parse(raw).last_stops[0].reason).toContain('[REDACTED]')
  })

  it('no stop passed (undefined) → no last_stops field (backward compat CYAU-116)', async () => {
    const {fn, calls} = fakeFetch()
    const hb = makeHeartbeat({heartbeat: cfg, host: {id: 'h1', token: 'cyi_ah_host'}}, {version: '0.0.1', runtimes: [], fetchFn: fn, activity: () => IDLE_ACTIVITY})
    await hb!(true)
    expect(JSON.parse(calls[0].opts.body as string)).not.toHaveProperty('last_stops')
  })

  it('empty stop array → last_stops present and empty (block overcome, not stale) (CYAU-116)', async () => {
    const {fn, calls} = fakeFetch()
    const hb = makeHeartbeat({heartbeat: cfg, host: {id: 'h1', token: 'cyi_ah_host'}}, {version: '0.0.1', runtimes: [], fetchFn: fn, activity: () => IDLE_ACTIVITY})
    await hb!(true, [])
    expect(JSON.parse(calls[0].opts.body as string).last_stops).toEqual([])
  })

  // CYAU-202: the update starts by itself, so its failure must reach the panel by itself —
  // otherwise one finds out only by logging into the server.
  it('a failed update reaches the panel even in a round without actions', async () => {
    const {fn, calls} = fakeFetch()
    const hb = makeHeartbeat(
      {heartbeat: cfg, host: {id: 'h1', token: 'cyi_ah_host'}},
      {
        version: '0.0.1', runtimes: [], fetchFn: fn, activity: () => IDLE_ACTIVITY,
        updateFailure: () => ({action: 'update', state: 'blocked', reason: 'aggiornamento a la versione 0.33.0 non riuscito: checksum'}),
      },
    )
    await hb!(true)
    const body = JSON.parse(calls[0].opts.body as string)
    expect(body.last_stops).toEqual([
      {action: 'update', state: 'blocked', reason: 'aggiornamento a la versione 0.33.0 non riuscito: checksum'},
    ])
  })

  it('the update notice is added to the round stops, it does not replace them', async () => {
    const {fn, calls} = fakeFetch()
    const hb = makeHeartbeat(
      {heartbeat: cfg, host: {id: 'h1', token: 'cyi_ah_host'}},
      {
        version: '0.0.1', runtimes: [], fetchFn: fn, activity: () => IDLE_ACTIVITY,
        updateFailure: () => ({action: 'update', state: 'blocked', reason: 'aggiornamento non riuscito'}),
      },
    )
    await hb!(false, [{action: 'cyau', state: 'blocked', reason: 'limite giornaliero raggiunto'}])
    const body = JSON.parse(calls[0].opts.body as string)
    expect(body.last_stops.map((stop: {action: string}) => stop.action)).toEqual(['cyau', 'update'])
  })

  it('no failed update → the body stays as before', async () => {
    const {fn, calls} = fakeFetch()
    const hb = makeHeartbeat(
      {heartbeat: cfg, host: {id: 'h1', token: 'cyi_ah_host'}},
      {version: '0.0.1', runtimes: [], fetchFn: fn, activity: () => IDLE_ACTIVITY, updateFailure: () => null},
    )
    await hb!(true)
    expect(JSON.parse(calls[0].opts.body as string)).not.toHaveProperty('last_stops')
  })
})

describe('combineBeats', () => {
  it('no configured beat → undefined (runOnce skips the call)', () => {
    expect(combineBeats(undefined, undefined)).toBeUndefined()
  })

  it('runs all active beats, in order, propagating ok', async () => {
    const order: string[] = []
    const a = vi.fn(async (ok: boolean) => void order.push(`a:${ok}`))
    const b = vi.fn(async (ok: boolean) => void order.push(`b:${ok}`))
    const beat = combineBeats(a, undefined, b)
    await beat!(true)
    expect(order).toEqual(['a:true', 'b:true'])
    expect(a).toHaveBeenCalledWith(true, undefined)
    expect(b).toHaveBeenCalledWith(true, undefined)
  })

  it('propagates the preflight stops to all beats (CYAU-116)', async () => {
    const a = vi.fn(async () => undefined)
    const b = vi.fn(async () => undefined)
    const beat = combineBeats(a, b)
    const stops = [{action: 'cyau', state: 'blocked', reason: 'limite'}]
    await beat!(false, stops)
    expect(a).toHaveBeenCalledWith(false, stops)
    expect(b).toHaveBeenCalledWith(false, stops)
  })

  it('a failing beat neither prevents the others nor throws (best-effort)', async () => {
    const boom = vi.fn(async () => {
      throw new Error('beat down')
    })
    const ok = vi.fn(async () => undefined)
    const beat = combineBeats(boom, ok)
    await expect(beat!(true)).resolves.toBeUndefined()
    expect(ok).toHaveBeenCalledTimes(1) // run even though the previous one blew up
  })
})

// CYAU-220 — a machine that cannot beat says so in the log instead of staying silent.
describe('heartbeatMissingReason', () => {
  const host = {id: 'h1', token: 'cyi_ah_host'}

  it('heartbeat configured and host registered → null, and makeHeartbeat builds the beat', () => {
    const secrets = {heartbeat: cfg, host}
    expect(heartbeatMissingReason(secrets)).toBeNull()
    expect(makeHeartbeat(secrets, {runtimes: []})).toBeDefined()
  })

  it('no heartbeat section → names it, and makeHeartbeat returns undefined', () => {
    const secrets = {host}
    expect(makeHeartbeat(secrets, {runtimes: []})).toBeUndefined()
    expect(heartbeatMissingReason(secrets)).toBe(
      'heartbeat: not configured — secrets.json has no heartbeat section. The panel shows this host as stopped and it takes no work; retrying at the next service start',
    )
  })

  it('host not registered → says so even when the section is there', () => {
    expect(heartbeatMissingReason({heartbeat: cfg})).toContain('this host is not registered yet')
  })

  it('a more precise reason from the setup wins, and no secret reaches the line', () => {
    const line = heartbeatMissingReason({host}, "project CYAU is not visible to this machine's service account")
    expect(line).toContain("not configured — project CYAU is not visible to this machine's service account")
    expect(line).not.toContain('cyi_')
  })
})
