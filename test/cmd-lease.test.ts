import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest'
import Lease from '../src/commands/lease'
import {saveSecrets} from '../src/lib/config'
import {listLeases, readLease, saveLease} from '../src/lib/lease'
import {runCaptured, runExpectingExit} from './helpers/command'

let dir: string
const savedEnv = {...process.env}

interface Call {
  url: string
  opts: RequestInit
}

// Fetch stub that records the calls and answers with the injected status (used to distinguish 409/404).
function stubFetch(res: {ok: boolean; status?: number; json?: unknown}): Call[] {
  const calls: Call[] = []
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string | URL, opts?: RequestInit) => {
      calls.push({url: String(url), opts: opts ?? {}})
      return {ok: res.ok, status: res.status ?? (res.ok ? 200 : 500), json: async () => res.json} as unknown as Response
    }),
  )
  return calls
}

const registered = {sync: {}, host: {id: 'h1', token: 'cyi_ah_s'}}
const lease = {ticket: 'CYAU-13', host_id: 'h1', run_id: 'run-42', agent: 'triage', expires_at: '2026-07-12T15:00:00.000Z'}

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'automator-lease-cmd-'))
  process.env.AUTOMATOR_CONFIG_DIR = dir
  // The active leases end up under the state dir: isolate it so the tests do not write into the real home.
  process.env.AUTOMATOR_STATE_DIR = dir
})

afterEach(() => {
  process.env = {...savedEnv}
  vi.unstubAllGlobals()
  fs.rmSync(dir, {recursive: true, force: true})
})

describe('lease command — preconditions', () => {
  it('sync not configured → exit 2', async () => {
    saveSecrets({})
    const {stderr} = await runExpectingExit(Lease, ['CYAU-13', '--run-id', 'run-42', '--agent', 'triage'], 2)
    expect(stderr).toContain('C400-SYNC-001')
  })

  it('host not registered → exit 2 (host_id needed)', async () => {
    saveSecrets({sync: {orgToken: 'cyi_a_x'}})
    const {stderr} = await runExpectingExit(Lease, ['CYAU-13', '--run-id', 'run-42', '--agent', 'triage'], 2)
    expect(stderr).toContain('C400-LEASE-001')
  })

  it('registered host without credential (partial secret) → exit 2 (no org token fallback)', async () => {
    saveSecrets({sync: {orgToken: 'cyi_a_x'}, host: {id: 'h1'} as unknown as {id: string; token: string}})
    const {stderr} = await runExpectingExit(Lease, ['CYAU-13', '--run-id', 'run-42', '--agent', 'triage'], 2)
    expect(stderr).toContain('C400-LEASE-001')
  })

  it('acquisition without --agent → exit 2 (invalid parameters)', async () => {
    saveSecrets(registered)
    const {stderr} = await runExpectingExit(Lease, ['CYAU-13', '--run-id', 'run-42'], 2)
    expect(stderr).toContain('C400-LEASE-002')
  })
})

describe('lease command — acquire', () => {
  it('happy: 2xx → acquired, persists the host identity in the lease, exit 0', async () => {
    saveSecrets(registered)
    stubFetch({ok: true, status: 201, json: {data: lease}})
    const {result, stdout} = await runCaptured(Lease, ['CYAU-13', '--run-id', 'run-42', '--agent', 'triage'])
    expect((result as {acquired: boolean}).acquired).toBe(true)
    expect((result as {outcome: string}).outcome).toBe('acquired')
    expect((result as {host_id: string}).host_id).toBe('h1')
    expect(stdout.toLowerCase()).toContain('acquisito')
  })

  it('already held by another host (409) → exit 3 (do not proceed)', async () => {
    saveSecrets(registered)
    stubFetch({ok: false, status: 409, json: {data: {ticket: 'CYAU-13', host_id: 'h2', expires_at: lease.expires_at}}})
    const {stderr} = await runExpectingExit(Lease, ['CYAU-13', '--run-id', 'run-42', '--agent', 'triage'], 3)
    expect(stderr).toContain('C409-LEASE-004')
  })

  it('server unreachable (500) → exit 1', async () => {
    saveSecrets(registered)
    stubFetch({ok: false, status: 500})
    const {stderr} = await runExpectingExit(Lease, ['CYAU-13', '--run-id', 'run-42', '--agent', 'triage'], 1)
    expect(stderr).toContain('C502-LEASE-003')
  })

  it('held without holder details (409 empty body) → exit 3 anyway', async () => {
    saveSecrets(registered)
    stubFetch({ok: false, status: 409, json: {}})
    await runExpectingExit(Lease, ['CYAU-13', '--run-id', 'run-42', '--agent', 'triage'], 3)
  })

  it('acquired without lease details (201 empty body) → acquired true', async () => {
    saveSecrets(registered)
    stubFetch({ok: true, status: 201, json: {}})
    const {result} = await runCaptured(Lease, ['CYAU-13', '--run-id', 'run-42', '--agent', 'triage'])
    expect((result as {acquired: boolean}).acquired).toBe(true)
    expect((result as {lease: unknown}).lease).toBeNull()
  })

  it('uses the revocable host credential (Bearer cyi_ah_), not the org token', async () => {
    saveSecrets(registered)
    const calls = stubFetch({ok: true, status: 201, json: {data: lease}})
    await runCaptured(Lease, ['CYAU-13', '--run-id', 'run-42', '--agent', 'triage'])
    expect((calls[0].opts.headers as Record<string, string>).Authorization).toBe('Bearer cyi_ah_s')
  })

  it('retry with 409 of its own host+run → acquired (idempotent), exit 0', async () => {
    saveSecrets(registered)
    stubFetch({ok: false, status: 409, json: {data: {ticket: 'CYAU-13', host_id: 'h1', run_id: 'run-42', expires_at: lease.expires_at}}})
    const {result} = await runCaptured(Lease, ['CYAU-13', '--run-id', 'run-42', '--agent', 'triage'])
    expect((result as {acquired: boolean}).acquired).toBe(true)
  })

  it('--ttl customises the expiry sent in the body', async () => {
    saveSecrets(registered)
    const calls = stubFetch({ok: true, status: 201, json: {data: lease}})
    await runCaptured(Lease, ['CYAU-13', '--run-id', 'run-42', '--agent', 'triage', '--ttl', '900'])
    expect(JSON.parse(calls[0].opts.body as string)).toMatchObject({ticket: 'CYAU-13', host_id: 'h1', ttl_seconds: 900})
  })

  it('--dry-run does not contact the server and shows the request', async () => {
    saveSecrets(registered)
    const calls = stubFetch({ok: true, status: 201, json: {data: lease}})
    const {result} = await runCaptured(Lease, ['CYAU-13', '--run-id', 'run-42', '--agent', 'triage', '--dry-run'])
    expect((result as {dryRun: boolean}).dryRun).toBe(true)
    expect((result as {ttl_seconds: number}).ttl_seconds).toBe(3600)
    expect(calls).toHaveLength(0)
  })

  it('--json does not print the human-readable lines', async () => {
    saveSecrets(registered)
    stubFetch({ok: true, status: 201, json: {data: lease}})
    const {result, stdout} = await runCaptured(Lease, ['CYAU-13', '--run-id', 'run-42', '--agent', 'triage', '--json'])
    expect((result as {acquired: boolean}).acquired).toBe(true)
    expect(stdout).not.toContain('acquisito')
  })
})

describe('lease command — release', () => {
  it('happy: 2xx → rilasciato', async () => {
    saveSecrets(registered)
    const calls = stubFetch({ok: true, status: 200})
    const {result} = await runCaptured(Lease, ['CYAU-13', '--run-id', 'run-42', '--release'])
    expect((result as {released: boolean}).released).toBe(true)
    expect(calls[0].url).toContain('/api/v1/leases/CYAU-13/release')
    expect(JSON.parse(calls[0].opts.body as string)).toEqual({ticket: 'CYAU-13', host_id: 'h1', run_id: 'run-42'})
  })

  it('lease already missing (404) → released (idempotent)', async () => {
    saveSecrets(registered)
    stubFetch({ok: false, status: 404})
    const {result} = await runCaptured(Lease, ['CYAU-13', '--run-id', 'run-42', '--release'])
    expect((result as {released: boolean}).released).toBe(true)
  })

  it('failed release (500) → exit 1', async () => {
    saveSecrets(registered)
    stubFetch({ok: false, status: 500})
    const {stderr} = await runExpectingExit(Lease, ['CYAU-13', '--run-id', 'run-42', '--release'], 1)
    expect(stderr).toContain('C502-LEASE-003')
  })

  it('--dry-run does not contact the server', async () => {
    saveSecrets(registered)
    const calls = stubFetch({ok: true, status: 200})
    const {result} = await runCaptured(Lease, ['CYAU-13', '--run-id', 'run-42', '--release', '--dry-run'])
    expect((result as {dryRun: boolean}).dryRun).toBe(true)
    expect(calls).toHaveLength(0)
  })
})

// The acquired lease must be persisted among the active leases so the daemon renews it at the beat (CYAU-14): who
// acquires (command) and who renews (daemon) are different processes and share the state dir.
describe('lease command — persistence for the renewal in the heartbeat', () => {
  it('acquire persists the active lease (ticket/host/run/agent/ttl + expiry from the server)', async () => {
    saveSecrets(registered)
    stubFetch({ok: true, status: 201, json: {data: lease}})
    await runCaptured(Lease, ['CYAU-13', '--run-id', 'run-42', '--agent', 'triage'])
    const saved = readLease('CYAU-13')
    expect(saved).toMatchObject({
      ticket: 'CYAU-13',
      host_id: 'h1',
      run_id: 'run-42',
      agent: 'triage',
      ttl_seconds: 3600,
      expires_at: '2026-07-12T15:00:00.000Z',
    })
  })

  it('acquire with --ttl persists the custom ttl', async () => {
    saveSecrets(registered)
    stubFetch({ok: true, status: 201, json: {data: lease}})
    await runCaptured(Lease, ['CYAU-13', '--run-id', 'run-42', '--agent', 'triage', '--ttl', '900'])
    expect(readLease('CYAU-13')!.ttl_seconds).toBe(900)
  })

  it('acquire --dry-run persists NOTHING', async () => {
    saveSecrets(registered)
    stubFetch({ok: true, status: 201, json: {data: lease}})
    await runCaptured(Lease, ['CYAU-13', '--run-id', 'run-42', '--agent', 'triage', '--dry-run'])
    expect(readLease('CYAU-13')).toBeNull()
  })

  it('held (409) does NOT persist a lease (it is not ours)', async () => {
    saveSecrets(registered)
    stubFetch({ok: false, status: 409, json: {data: {ticket: 'CYAU-13', host_id: 'h2', expires_at: lease.expires_at}}})
    await runExpectingExit(Lease, ['CYAU-13', '--run-id', 'run-42', '--agent', 'triage'], 3)
    expect(listLeases()).toEqual([])
  })

  it('release removes the persisted active lease (stops renewing it)', async () => {
    saveSecrets(registered)
    saveLease({ticket: 'CYAU-13', host_id: 'h1', run_id: 'run-42', agent: 'triage', ttl_seconds: 3600, expires_at: null, acquired_at: 'x', updated_at: 'x'})
    stubFetch({ok: true, status: 200})
    await runCaptured(Lease, ['CYAU-13', '--run-id', 'run-42', '--release'])
    expect(readLease('CYAU-13')).toBeNull()
  })

  it('release does NOT remove a lease re-acquired with another run_id (no lost update)', async () => {
    saveSecrets(registered)
    // On disk there is already a re-acquisition of the same ticket with another run (run-99).
    saveLease({ticket: 'CYAU-13', host_id: 'h1', run_id: 'run-99', agent: 'triage', ttl_seconds: 3600, expires_at: null, acquired_at: 'x', updated_at: 'x'})
    stubFetch({ok: true, status: 200})
    await runCaptured(Lease, ['CYAU-13', '--run-id', 'run-42', '--release'])
    expect(readLease('CYAU-13')!.run_id).toBe('run-99') // the other run's lease stays intact
  })
})
