import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import {afterAll, describe, expect, it, vi} from 'vitest'
import {
  buildLeaseRequest,
  buildRenewRequest,
  buildReleaseRequest,
  DEFAULT_LEASE_TTL_SECONDS,
  fileLeaseStore,
  type LeaseRecord,
  type LeaseStore,
  leasePath,
  listLeases,
  makeLeaseRenewer,
  readLease,
  removeLease,
  removeLeaseIfHeld,
  renewActiveLeases,
  saveLease,
  saveLeaseIfHeld,
} from '../src/lib/lease'
import {type AutomatorClient, type LeaseRenewResult, makeClient} from '../src/lib/client'
import {AutomatorError} from '../src/errors/error-codes'
import {type Secrets, type SyncConfig} from '../src/lib/config'

describe('buildLeaseRequest', () => {
  const base = {ticket: 'CYAU-13', hostId: 'h1', runId: 'run-42', agent: 'triage'}

  it('builds the body with the default TTL when not provided', () => {
    expect(buildLeaseRequest(base)).toEqual({
      ticket: 'CYAU-13',
      host_id: 'h1',
      run_id: 'run-42',
      agent: 'triage',
      ttl_seconds: DEFAULT_LEASE_TTL_SECONDS,
    })
  })

  it('respects an explicit TTL', () => {
    expect(buildLeaseRequest({...base, ttlSeconds: 900}).ttl_seconds).toBe(900)
  })

  it('empty ticket → C400-LEASE-002 (exit 2)', () => {
    const err = grab(() => buildLeaseRequest({...base, ticket: '  '}))
    expect(err.code).toBe('C400-LEASE-002')
    expect(err.exitCode).toBe(2)
  })

  it('empty host_id → C400-LEASE-002', () => {
    expect(grab(() => buildLeaseRequest({...base, hostId: ''})).code).toBe('C400-LEASE-002')
  })

  it('empty run_id → C400-LEASE-002', () => {
    expect(grab(() => buildLeaseRequest({...base, runId: ''})).code).toBe('C400-LEASE-002')
  })

  it('empty agent → C400-LEASE-002', () => {
    expect(grab(() => buildLeaseRequest({...base, agent: ''})).code).toBe('C400-LEASE-002')
  })

  it('non-positive TTL → C400-LEASE-002', () => {
    expect(grab(() => buildLeaseRequest({...base, ttlSeconds: 0})).code).toBe('C400-LEASE-002')
  })

  it('non-integer TTL → C400-LEASE-002', () => {
    expect(grab(() => buildLeaseRequest({...base, ttlSeconds: 12.5})).code).toBe('C400-LEASE-002')
  })
})

describe('buildReleaseRequest', () => {
  it('builds the release body (ticket/host_id/run_id)', () => {
    expect(buildReleaseRequest({ticket: 'CYAU-13', hostId: 'h1', runId: 'run-42'})).toEqual({
      ticket: 'CYAU-13',
      host_id: 'h1',
      run_id: 'run-42',
    })
  })

  it('missing field → C400-LEASE-002', () => {
    expect(grab(() => buildReleaseRequest({ticket: '', hostId: 'h1', runId: 'run-42'})).code).toBe('C400-LEASE-002')
  })
})

// Ticket Scenario 1: several hosts ask for the same ticket, one acquires it, the others can NOT
// while the lease is valid. The real atomicity (uniqueness constraint) lives in the server; here the "atomic server"
// is simulated by a shared variable — the first POST wins, the next ones get 409 + holder. The test
// verifies that the CLIENT, facing an atomic server, produces mutual exclusion: a single `acquired`.
describe('Scenario 1 — mutual exclusion under concurrent requests', () => {
  const cfg: SyncConfig = {orgToken: 'cyi_a_x'}

  function atomicServer(): typeof globalThis.fetch {
    let holder: {host_id: string; run_id: string; expires_at: string} | null = null
    return (async (_url: string | URL, opts?: RequestInit) => {
      const body = JSON.parse((opts?.body as string) ?? '{}') as {ticket: string; host_id: string; run_id: string}
      // Synchronous critical section (single-thread JS = no await before the assignment): the first wins.
      if (holder === null) {
        holder = {host_id: body.host_id, run_id: body.run_id, expires_at: '2026-07-12T15:00:00.000Z'}
        return {ok: true, status: 201, json: async () => ({data: {...body, expires_at: holder!.expires_at}})} as unknown as Response
      }

      // On conflict the server exposes the complete holder (host_id + run_id): it lets the client tell
      // another host (held) from the idempotent retry of the holder (acquired).
      return {
        ok: false,
        status: 409,
        json: async () => ({data: {ticket: body.ticket, host_id: holder!.host_id, run_id: holder!.run_id, expires_at: holder!.expires_at}}),
      } as unknown as Response
    }) as unknown as typeof globalThis.fetch
  }

  it('five concurrent hosts on the same ticket → exactly one acquires, the others see held', async () => {
    const fetchFn = atomicServer()
    const hosts = ['h1', 'h2', 'h3', 'h4', 'h5']
    const results = await Promise.all(
      hosts.map((h) =>
        makeClient(cfg, fetchFn, `cyi_ah_${h}`).acquireLease({
          ticket: 'CYAU-13',
          host_id: h,
          run_id: `run-${h}`,
          agent: 'triage',
          ttl_seconds: 3600,
        }),
      ),
    )

    const acquired = results.filter((r) => r.outcome === 'acquired')
    const held = results.filter((r) => r.outcome === 'held')
    expect(acquired).toHaveLength(1)
    expect(held).toHaveLength(hosts.length - 1)
    // Every excluded host sees as holder the single host that won the lease.
    const winner = acquired[0].lease?.host_id
    expect(winner).toBeTruthy()
    expect(held.every((r) => r.lease?.host_id === winner)).toBe(true)
  })

  it('another host stays held; a retry of the same host+run is idempotent (acquired)', async () => {
    const fetchFn = atomicServer()
    const winner = makeClient(cfg, fetchFn, 'cyi_ah_h1')
    const loser = makeClient(cfg, fetchFn, 'cyi_ah_h2')
    const req = (host: string) => ({ticket: 'CYAU-13', host_id: host, run_id: `run-${host}`, agent: 'triage', ttl_seconds: 3600})

    expect((await winner.acquireLease(req('h1'))).outcome).toBe('acquired')
    // A different host cannot acquire it while the lease is valid.
    expect((await loser.acquireLease(req('h2'))).outcome).toBe('held')
    // The winner retrying finds its OWN lease (same host+run) → idempotent acquired, not a conflict.
    expect((await winner.acquireLease(req('h1'))).outcome).toBe('acquired')
  })
})

describe('buildRenewRequest', () => {
  const base = {ticket: 'CYAU-13', hostId: 'h1', runId: 'run-42'}

  it('builds the renewal body with the default TTL (ticket/host_id/run_id/ttl)', () => {
    expect(buildRenewRequest(base)).toEqual({ticket: 'CYAU-13', host_id: 'h1', run_id: 'run-42', ttl_seconds: DEFAULT_LEASE_TTL_SECONDS})
  })

  it('respects an explicit TTL', () => {
    expect(buildRenewRequest({...base, ttlSeconds: 1800}).ttl_seconds).toBe(1800)
  })

  it('empty identity field → C400-LEASE-002', () => {
    expect(grab(() => buildRenewRequest({...base, runId: ''})).code).toBe('C400-LEASE-002')
  })

  it('TTL not a positive integer → C400-LEASE-002', () => {
    expect(grab(() => buildRenewRequest({...base, ttlSeconds: -5})).code).toBe('C400-LEASE-002')
  })
})

// ── Store of the active leases (leases/<ticket>.json) ────────────────────────────────────────────────────────
const storeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'automator-lease-store-'))
afterAll(() => fs.rmSync(storeDir, {recursive: true, force: true}))

/** Isolated sub-directory for a store test. */
let storeCounter = 0
const freshDir = (): string => {
  const d = path.join(storeDir, `s-${storeCounter++}`)
  fs.mkdirSync(d, {recursive: true})
  return d
}

function record(over: Partial<LeaseRecord> = {}): LeaseRecord {
  return {
    ticket: 'CYAU-13',
    host_id: 'h1',
    run_id: 'run-42',
    agent: 'triage',
    ttl_seconds: 3600,
    expires_at: '2026-07-12T15:00:00.000Z',
    acquired_at: '2026-07-12T14:00:00.000Z',
    updated_at: '2026-07-12T14:00:00.000Z',
    ...over,
  }
}

describe('active lease store', () => {
  it('saveLease/readLease round-trip', () => {
    const dir = freshDir()
    saveLease(record(), dir)
    expect(readLease('CYAU-13', dir)).toEqual(record())
  })

  it('readLease on missing lease → null', () => {
    expect(readLease('CYAU-99', freshDir())).toBeNull()
  })

  it('readLease on corrupted file → null (never crash)', () => {
    const dir = freshDir()
    fs.writeFileSync(path.join(dir, 'CYAU-13.json'), '{ non è json')
    expect(readLease('CYAU-13', dir)).toBeNull()
  })

  it('removeLease is idempotent (missing → no-op)', () => {
    const dir = freshDir()
    expect(() => removeLease('CYAU-13', dir)).not.toThrow()
    saveLease(record(), dir)
    removeLease('CYAU-13', dir)
    expect(readLease('CYAU-13', dir)).toBeNull()
  })

  it('listLeases lists the valid leases, discards the malformed ones and ignores the non-.json', () => {
    const dir = freshDir()
    saveLease(record({ticket: 'CYAU-13'}), dir)
    saveLease(record({ticket: 'CYAU-14', run_id: 'run-77'}), dir)
    fs.writeFileSync(path.join(dir, 'rotto.json'), '{ nope')
    fs.writeFileSync(path.join(dir, 'CYAU-13.json.tmp'), '{}') // temporaneo: ignorato
    fs.writeFileSync(path.join(dir, 'note.txt'), 'x') // non-json: ignorato
    const tickets = listLeases(dir).map((l) => l.ticket).sort()
    expect(tickets).toEqual(['CYAU-13', 'CYAU-14'])
  })

  it('listLeases on missing directory → [] (no lease)', () => {
    expect(listLeases(path.join(storeDir, 'mai-creata'))).toEqual([])
  })

  it('leasePath rejects a ticket unsafe as a file name → C400-LEASE-002 (never path traversal)', () => {
    expect(grab(() => leasePath('../evil')).code).toBe('C400-LEASE-002')
    expect(grab(() => leasePath('a/b')).code).toBe('C400-LEASE-002')
  })

  it('saveLeaseIfHeld updates only if the run_id matches (missing → does NOT recreate)', () => {
    const dir = freshDir()
    expect(saveLeaseIfHeld(record({run_id: 'run-42'}), dir)).toBe(false) // missing → does not write
    expect(readLease('CYAU-13', dir)).toBeNull()
    saveLease(record({run_id: 'run-42', expires_at: 'old'}), dir)
    expect(saveLeaseIfHeld(record({run_id: 'run-42', expires_at: 'new'}), dir)).toBe(true) // same run_id → writes
    expect(readLease('CYAU-13', dir)!.expires_at).toBe('new')
    expect(saveLeaseIfHeld(record({run_id: 'altro', expires_at: 'x'}), dir)).toBe(false) // different run_id → does not write
    expect(readLease('CYAU-13', dir)!.run_id).toBe('run-42')
  })

  it('saveLeaseIfHeld re-evaluates the owner after acquiring the lock (deterministic interleaving)', () => {
    const dir = freshDir()
    saveLease(record({run_id: 'run-42', expires_at: 'snapshot-vecchio'}), dir)

    const updated = saveLeaseIfHeld(record({run_id: 'run-42', expires_at: 'rinnovo-stantio'}), dir, {
      beforeAcquire: () => saveLease(record({run_id: 'run-99', expires_at: 'proprietario-nuovo'}), dir),
    })

    expect(updated).toBe(false)
    expect(readLease('CYAU-13', dir)).toMatchObject({run_id: 'run-99', expires_at: 'proprietario-nuovo'})
  })

  it('removeLeaseIfHeld removes only if the run_id matches (missing → no-op)', () => {
    const dir = freshDir()
    expect(() => removeLeaseIfHeld('CYAU-13', 'run-42', dir)).not.toThrow() // missing → no-op
    saveLease(record({run_id: 'run-99'}), dir)
    removeLeaseIfHeld('CYAU-13', 'run-42', dir) // run_id diverso → non rimuove
    expect(readLease('CYAU-13', dir)!.run_id).toBe('run-99')
    removeLeaseIfHeld('CYAU-13', 'run-99', dir) // same run_id → removes
    expect(readLease('CYAU-13', dir)).toBeNull()
  })

  it('removeLeaseIfHeld re-evaluates the owner after acquiring the lock (deterministic interleaving)', () => {
    const dir = freshDir()
    saveLease(record({run_id: 'run-42'}), dir)

    removeLeaseIfHeld('CYAU-13', 'run-42', dir, {
      beforeAcquire: () => saveLease(record({run_id: 'run-99', expires_at: 'proprietario-nuovo'}), dir),
    })

    expect(readLease('CYAU-13', dir)).toMatchObject({run_id: 'run-99', expires_at: 'proprietario-nuovo'})
  })
})

// ── renewActiveLeases: renewal in the beat (Scenario 1 + DoD) ────────────────────────────────────────────
/** In-memory store (no disk): exposes the records for the assertions. */
function memStore(initial: LeaseRecord[] = []): LeaseStore & {records: Map<string, LeaseRecord>} {
  const records = new Map(initial.map((l) => [l.ticket, l]))
  return {
    records,
    list: () => [...records.values()],
    update: (lease) => {
      const current = records.get(lease.ticket)
      if (current && current.run_id === lease.run_id) records.set(lease.ticket, lease)
    },
    remove: (lease) => {
      const current = records.get(lease.ticket)
      if (!current || current.run_id === lease.run_id) records.delete(lease.ticket)
    },
  }
}

/** Renewal client with fixed or ticket-dependent outcome; counts the calls. */
function stubRenew(outcome: LeaseRenewResult | ((ticket: string) => LeaseRenewResult)) {
  const tickets: string[] = []
  const client: Pick<AutomatorClient, 'renewLease'> = {
    renewLease: vi.fn(async (req) => {
      tickets.push(req.ticket)
      return typeof outcome === 'function' ? outcome(req.ticket) : outcome
    }),
  }
  return {client, tickets}
}

const fixedNow = (): Date => new Date('2026-07-12T14:30:00.000Z')

describe('renewActiveLeases', () => {
  it('renewed → updates expires_at and updated_at WITHOUT changing owner (DoD)', async () => {
    const store = memStore([record({expires_at: '2026-07-12T15:00:00.000Z'})])
    const {client} = stubRenew({
      outcome: 'renewed',
      lease: {ticket: 'CYAU-13', host_id: 'h1', run_id: 'run-42', expires_at: '2026-07-12T16:00:00.000Z'},
    })
    const result = await renewActiveLeases(client, store, 'h1', fixedNow)
    expect(result.renewed).toEqual(['CYAU-13'])
    const saved = store.records.get('CYAU-13')!
    expect(saved.host_id).toBe('h1') // proprietario invariato
    expect(saved.run_id).toBe('run-42')
    expect(saved.expires_at).toBe('2026-07-12T16:00:00.000Z') // new expiry from the server
    expect(saved.updated_at).toBe('2026-07-12T14:30:00.000Z')
  })

  it('renewed without lease in the body → keeps the previous expiry, updates updated_at', async () => {
    const store = memStore([record({expires_at: '2026-07-12T15:00:00.000Z'})])
    const {client} = stubRenew({outcome: 'renewed', lease: null})
    await renewActiveLeases(client, store, 'h1', fixedNow)
    expect(store.records.get('CYAU-13')!.expires_at).toBe('2026-07-12T15:00:00.000Z')
    expect(store.records.get('CYAU-13')!.updated_at).toBe('2026-07-12T14:30:00.000Z')
  })

  it('held (another host holds it) → removes the local lease, stops renewing it', async () => {
    const store = memStore([record()])
    const {client} = stubRenew({outcome: 'held', lease: {ticket: 'CYAU-13', host_id: 'h2', expires_at: 'x'}})
    const result = await renewActiveLeases(client, store, 'h1', fixedNow)
    expect(result.lost).toEqual(['CYAU-13'])
    expect(store.records.has('CYAU-13')).toBe(false)
  })

  it('expired (expired server-side) → removes the local lease (server-side recovery)', async () => {
    const store = memStore([record()])
    const {client} = stubRenew({outcome: 'expired', lease: null})
    const result = await renewActiveLeases(client, store, 'h1', fixedNow)
    expect(result.lost).toEqual(['CYAU-13'])
    expect(store.records.has('CYAU-13')).toBe(false)
  })

  it('network error → KEEPS the file (transient blip, retries at the next beat)', async () => {
    const store = memStore([record()])
    const {client} = stubRenew({outcome: 'error', lease: null})
    const result = await renewActiveLeases(client, store, 'h1', fixedNow)
    expect(result.errored).toEqual(['CYAU-13'])
    expect(store.records.has('CYAU-13')).toBe(true) // NOT removed: the lease stays ours
  })

  it('renews only the leases of THIS host identity (record of another identity skipped)', async () => {
    const store = memStore([record({ticket: 'CYAU-13', host_id: 'h1'}), record({ticket: 'CYAU-14', host_id: 'hX'})])
    const {client, tickets} = stubRenew({outcome: 'renewed', lease: null})
    const result = await renewActiveLeases(client, store, 'h1', fixedNow)
    expect(tickets).toEqual(['CYAU-13']) // renewLease called only for the h1 lease
    expect(result.renewed).toEqual(['CYAU-13'])
    expect(store.records.has('CYAU-14')).toBe(true) // the other identity's lease stays intact
  })

  it('a record with invalid identity does not block the others (best-effort)', async () => {
    const store = memStore([record({ticket: 'CYAU-13', run_id: ''}), record({ticket: 'CYAU-14', run_id: 'run-77'})])
    const {client} = stubRenew({outcome: 'renewed', lease: null})
    const result = await renewActiveLeases(client, store, 'h1', fixedNow)
    expect(result.errored).toEqual(['CYAU-13']) // empty run_id → buildRenewRequest throws → errored
    expect(result.renewed).toEqual(['CYAU-14']) // the other one renewed anyway
  })

  it('held but the file was re-acquired with a new run_id → does NOT remove it (no lost-update, file store)', async () => {
    const dir = freshDir()
    saveLease(record({run_id: 'run-99'}), dir) // the NEW run is already on disk
    // ...but the renewal round processes the STALE snapshot (run-42): force a list() with the old record.
    const staleStore: LeaseStore = {...fileLeaseStore(dir), list: () => [record({run_id: 'run-42'})]}
    const {client} = stubRenew({outcome: 'held', lease: {ticket: 'CYAU-13', host_id: 'h1', run_id: 'run-99', expires_at: 'x'}})
    await renewActiveLeases(client, staleStore, 'h1', fixedNow)
    expect(readLease('CYAU-13', dir)?.run_id).toBe('run-99') // the new lease on disk stays intact
  })

  it('renewed but the file was re-acquired with a new run_id → does NOT overwrite it (no lost-update, file store)', async () => {
    const dir = freshDir()
    saveLease(record({run_id: 'run-99', expires_at: 'owner-nuovo'}), dir) // the NEW run on disk
    const staleStore: LeaseStore = {...fileLeaseStore(dir), list: () => [record({run_id: 'run-42'})]} // stale snapshot
    const {client} = stubRenew({outcome: 'renewed', lease: {ticket: 'CYAU-13', host_id: 'h1', run_id: 'run-42', expires_at: '2026-07-12T20:00:00.000Z'}})
    await renewActiveLeases(client, staleStore, 'h1', fixedNow)
    const persisted = readLease('CYAU-13', dir)!
    expect(persisted.run_id).toBe('run-99') // ownership of the new lease intact
    expect(persisted.expires_at).toBe('owner-nuovo') // the stale renewal did NOT overwrite
  })

  it('renewed but the file was released in the meantime → does NOT recreate it (file store)', async () => {
    const dir = freshDir() // empty: the lease was released
    const staleStore: LeaseStore = {...fileLeaseStore(dir), list: () => [record({run_id: 'run-42'})]}
    const {client} = stubRenew({outcome: 'renewed', lease: {ticket: 'CYAU-13', host_id: 'h1', run_id: 'run-42', expires_at: 'x'}})
    await renewActiveLeases(client, staleStore, 'h1', fixedNow)
    expect(readLease('CYAU-13', dir)).toBeNull() // non ricreato
  })

  it('no active lease → empty result, no call to the server', async () => {
    const store = memStore([])
    const {client, tickets} = stubRenew({outcome: 'renewed', lease: null})
    const result = await renewActiveLeases(client, store, 'h1', fixedNow)
    expect(result).toEqual({renewed: [], lost: [], errored: []})
    expect(tickets).toEqual([])
  })

  it('integration with the file store: a round renews the lease persisted on disk', async () => {
    const dir = freshDir()
    saveLease(record({expires_at: '2026-07-12T15:00:00.000Z'}), dir)
    const {client} = stubRenew({
      outcome: 'renewed',
      lease: {ticket: 'CYAU-13', host_id: 'h1', run_id: 'run-42', expires_at: '2026-07-12T17:00:00.000Z'},
    })
    await renewActiveLeases(client, fileLeaseStore(dir), 'h1', fixedNow)
    expect(readLease('CYAU-13', dir)!.expires_at).toBe('2026-07-12T17:00:00.000Z')
  })
})

describe('makeLeaseRenewer', () => {
  const registered: Secrets = {sync: {}, host: {id: 'h1', token: 'cyi_ah_s'}}

  it('without sync → undefined (no host-scoped channel)', () => {
    expect(makeLeaseRenewer({host: {id: 'h1', token: 'cyi_ah_s'}})).toBeUndefined()
  })

  it('without host identity → undefined', () => {
    expect(makeLeaseRenewer({sync: {orgToken: 'cyi_a_x'}})).toBeUndefined()
  })

  it('host without token (partial secret) → undefined (no org token fallback)', () => {
    expect(makeLeaseRenewer({sync: {orgToken: 'cyi_a_x'}, host: {id: 'h1'} as {id: string; token: string}})).toBeUndefined()
  })

  it('Server Host token cyi_h_ → undefined (not an Agent Host)', () => {
    expect(makeLeaseRenewer({sync: {}, host: {id: 'h1', token: 'cyi_h_server'}})).toBeUndefined()
  })

  it('with sync+host → callback that renews the active leases with the revocable host credential', async () => {
    const store = memStore([record()])
    const calls: Array<{url: string; opts: RequestInit}> = []
    const fetchFn = vi.fn(async (url: string | URL, opts?: RequestInit) => {
      calls.push({url: String(url), opts: opts ?? {}})
      return {ok: true, status: 200, json: async () => ({data: {ticket: 'CYAU-13', host_id: 'h1', run_id: 'run-42', expires_at: '2026-07-12T18:00:00.000Z'}})} as unknown as Response
    }) as unknown as typeof globalThis.fetch

    const renewer = makeLeaseRenewer(registered, {store, fetchFn, now: fixedNow})
    expect(renewer).toBeDefined()
    await renewer!(true)

    expect(calls[0].url).toBe('https://app.closeyour.it/api/v1/leases/CYAU-13/renew')
    expect((calls[0].opts.headers as Record<string, string>).Authorization).toBe('Bearer cyi_ah_s')
    expect(store.records.get('CYAU-13')!.expires_at).toBe('2026-07-12T18:00:00.000Z')
  })

  it('rebuilds the client at every beat: after a rotation it uses the new host token', async () => {
    const secrets: Secrets = {sync: {}, host: {id: 'h1', token: 'cyi_ah_old'}}
    const store = memStore([record()])
    const authorizations: string[] = []
    const fetchFn = vi.fn(async (_url: string | URL, opts?: RequestInit) => {
      authorizations.push((opts?.headers as Record<string, string>).Authorization)
      return {
        ok: true,
        status: 200,
        json: async () => ({data: {ticket: 'CYAU-13', host_id: 'h1', run_id: 'run-42', expires_at: '2026-07-12T18:00:00.000Z'}}),
      } as unknown as Response
    }) as unknown as typeof globalThis.fetch
    const renewer = makeLeaseRenewer(secrets, {store, fetchFn, now: fixedNow})

    secrets.host = {id: 'h1', token: 'cyi_ah_new'}
    await renewer!(true)

    expect(authorizations).toEqual(['Bearer cyi_ah_new'])
  })

  it('best-effort: never throws even if the server is unreachable', async () => {
    const store = memStore([record()])
    const fetchFn = (async () => {
      throw new Error('network down')
    }) as unknown as typeof globalThis.fetch
    const renewer = makeLeaseRenewer(registered, {store, fetchFn, now: fixedNow})
    await expect(renewer!(true)).resolves.toBeUndefined()
    expect(store.records.has('CYAU-13')).toBe(true) // network error → lease kept
  })
})

/** Captures a synchronous AutomatorError to inspect its code/exitCode. */
function grab(fn: () => unknown): AutomatorError {
  try {
    fn()
  } catch (error) {
    if (error instanceof AutomatorError) return error
    throw error
  }

  throw new Error('nessun AutomatorError sollevato')
}
