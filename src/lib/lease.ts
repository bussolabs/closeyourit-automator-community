import * as fs from 'node:fs'
import * as path from 'node:path'
import {type AutomatorClient, type LeaseReleaseRequest, type LeaseRenewRequest, type LeaseRequest, makeClient} from './client'
import {hasOperationalHostIdentity, type Secrets} from './config'
import {type FetchFn} from './heartbeat'
import {leasesDir} from './paths'
import {type AtomicFileOptions, isRecord, isSafeRunId, mutateJsonFileAtomically} from './state'
import {AutomatorError, ErrorCodes} from '../errors/error-codes'

// Building and validating lease bodies. Pure (no I/O): the HTTP client does the rest and atomicity
// lives in the server. Here we only guarantee that no identity field is empty and that the TTL is sensible,
// so an ambiguous lease request is never sent.

// Default expiry (seconds): a wide window for a run but not eternal, so if the host dies the
// lease expires and the ticket becomes acquirable by another host again. Overridable for longer runs.
export const DEFAULT_LEASE_TTL_SECONDS = 3600

export interface AcquireLeaseInput {
  ticket: string
  hostId: string
  runId: string
  agent: string
  ttlSeconds?: number
}

export interface ReleaseLeaseInput {
  ticket: string
  hostId: string
  runId: string
}

export interface RenewLeaseInput {
  ticket: string
  hostId: string
  runId: string
  ttlSeconds?: number
}

/** A lease identity field must be a non-empty string (spaces excluded). */
function requireField(name: string, value: string): string {
  if (typeof value !== 'string' || value.trim() === '') {
    throw new AutomatorError(ErrorCodes.Lease.invalidRequest, `Campo "${name}" del lease mancante o vuoto`, 2)
  }

  return value
}

/** The lease TTL must be a positive integer number of seconds; default if not given. */
function requireTtl(ttlSeconds?: number): number {
  const ttl = ttlSeconds ?? DEFAULT_LEASE_TTL_SECONDS
  if (!Number.isInteger(ttl) || ttl <= 0) {
    throw new AutomatorError(ErrorCodes.Lease.invalidRequest, `TTL del lease non valido (atteso intero positivo di secondi): ${ttl}`, 2)
  }

  return ttl
}

/** Body of POST /api/v1/leases, with default TTL and field validation. */
export function buildLeaseRequest(input: AcquireLeaseInput): LeaseRequest {
  return {
    ticket: requireField('ticket', input.ticket),
    host_id: requireField('host_id', input.hostId),
    run_id: requireField('run_id', input.runId),
    agent: requireField('agent', input.agent),
    ttl_seconds: requireTtl(input.ttlSeconds),
  }
}

/** Body of POST /api/v1/leases/:ticket/renew: extends the expiry without changing owner. */
export function buildRenewRequest(input: RenewLeaseInput): LeaseRenewRequest {
  return {
    ticket: requireField('ticket', input.ticket),
    host_id: requireField('host_id', input.hostId),
    run_id: requireField('run_id', input.runId),
    ttl_seconds: requireTtl(input.ttlSeconds),
  }
}

/** Body of POST /api/v1/leases/:ticket/release, with field validation. */
export function buildReleaseRequest(input: ReleaseLeaseInput): LeaseReleaseRequest {
  return {
    ticket: requireField('ticket', input.ticket),
    host_id: requireField('host_id', input.hostId),
    run_id: requireField('run_id', input.runId),
  }
}

// ── Store of the active leases (leases/<ticket>.json) ────────────────────────────────────────────────────────
// Every lease acquired by THIS host is persisted in a dedicated `leases/<ticket>.json` file under the state
// dir. It is needed because whoever ACQUIRES (the `lease` command, invoked by the orchestrator) and whoever RENEWS (the daemon,
// at the beat) are different processes: the daemon must know which leases to keep alive. File per ticket → no
// lost update (key = ticket, unique server-side). The file is ephemeral (not "work"): a corrupt record is
// discarded and the lease will expire server-side → recovery, which is the intended behaviour.

/** A lease held by this host, with the expiry computed by the server (server time). */
export interface LeaseRecord {
  ticket: string
  host_id: string
  run_id: string
  agent: string
  ttl_seconds: number
  expires_at: string | null // expiry from the SERVER (null if not exposed at acquisition time)
  acquired_at: string // ISO 8601 of the acquisition
  updated_at: string // ISO 8601 of the last renewal/acquisition
}

/** Path of a lease file: `<leasesDir>/<ticket>.json`. Validates the ticket as a segment (never path traversal). */
export function leasePath(ticket: string, base: string = leasesDir()): string {
  if (!isSafeRunId(ticket)) {
    throw new AutomatorError(ErrorCodes.Lease.invalidRequest, `ticket non sicuro come nome file: "${ticket}"`, 2)
  }

  return path.join(base, `${ticket}.json`)
}

/** Normalizes a raw lease from disk: without the minimal identity (ticket/host_id/run_id) → null (discarded). */
function coerceLease(value: unknown): LeaseRecord | null {
  if (!isRecord(value)) return null
  if (typeof value.ticket !== 'string' || typeof value.host_id !== 'string' || typeof value.run_id !== 'string') return null
  const ttl = value.ttl_seconds
  return {
    ticket: value.ticket,
    host_id: value.host_id,
    run_id: value.run_id,
    agent: typeof value.agent === 'string' ? value.agent : '',
    ttl_seconds: typeof ttl === 'number' && Number.isInteger(ttl) && ttl > 0 ? ttl : DEFAULT_LEASE_TTL_SECONDS,
    expires_at: typeof value.expires_at === 'string' ? value.expires_at : null,
    acquired_at: typeof value.acquired_at === 'string' ? value.acquired_at : '',
    updated_at: typeof value.updated_at === 'string' ? value.updated_at : '',
  }
}

/** Reads a lease file from the given path; missing/corrupt/malformed → null (never crashes). */
function readLeaseFile(file: string): LeaseRecord | null {
  let raw: string
  try {
    raw = fs.readFileSync(file, 'utf8')
  } catch {
    return null
  }

  try {
    return coerceLease(JSON.parse(raw))
  } catch {
    return null
  }
}

/** Persists (atomically) an active lease. */
export function saveLease(lease: LeaseRecord, base: string = leasesDir(), options: AtomicFileOptions = {}): void {
  const file = leasePath(lease.ticket, base)
  mutateJsonFileAtomically(file, () => ({type: 'write', data: lease, value: undefined}), options)
}

/** Reads a ticket's lease, or null if missing/corrupt. */
export function readLease(ticket: string, base: string = leasesDir()): LeaseRecord | null {
  return readLeaseFile(leasePath(ticket, base))
}

/** Removes a lease file (idempotent: missing → no-op). */
export function removeLease(ticket: string, base: string = leasesDir(), options: AtomicFileOptions = {}): void {
  const file = leasePath(ticket, base)
  mutateJsonFileAtomically(file, () => ({type: 'remove', value: undefined}), options)
}

/** Lists the persisted active leases, discarding malformed files (granular degradation). Missing dir → []. */
export function listLeases(base: string = leasesDir()): LeaseRecord[] {
  let entries: string[]
  try {
    entries = fs.readdirSync(base)
  } catch {
    return []
  }

  const leases: LeaseRecord[] = []
  for (const entry of entries) {
    // Only lease files: temporaries (`.json.tmp`) and quarantines (`.corrupt-…`) do not end in `.json`.
    if (!entry.endsWith('.json')) continue
    const lease = readLeaseFile(path.join(base, entry))
    if (lease) leases.push(lease)
  }

  return leases
}

// Compare-and-set by identity (run_id): they protect the operations based on a potentially stale
// snapshot (the daemon's renewal round) and the release of a run from a CONCURRENT re-acquisition
// of the same ticket. Key = ticket, so a new run rewrites the same file: without the
// run_id comparison, an old operation would overwrite/delete the new lease (lost update).

/**
 * Updates a lease ONLY if the persisted file is STILL this run (same run_id). If it is missing
 * (released in the meantime) it does NOT recreate it; if it is another run (re-acquired) it does NOT overwrite it.
 * Returns true if it wrote. Used after a successful renewal, where `lease` comes from an earlier snapshot.
 */
export function saveLeaseIfHeld(lease: LeaseRecord, base: string = leasesDir(), options: AtomicFileOptions = {}): boolean {
  const file = leasePath(lease.ticket, base)
  return mutateJsonFileAtomically(file, () => {
    const current = readLeaseFile(file)
    return current && current.run_id === lease.run_id
      ? {type: 'write', data: lease, value: true}
      : {type: 'none', value: false}
  }, options)
}

/**
 * Removes a lease ONLY if the persisted file is still this run (same run_id) or is already missing
 * (idempotent no-op). If it is another run (concurrent re-acquisition) it leaves it intact. Used by the
 * release and by the renewal round (lost/expired lease).
 */
export function removeLeaseIfHeld(
  ticket: string,
  runId: string,
  base: string = leasesDir(),
  options: AtomicFileOptions = {},
): void {
  const file = leasePath(ticket, base)
  mutateJsonFileAtomically(file, () => {
    const current = readLeaseFile(file)
    return !current || current.run_id === runId
      ? {type: 'remove', value: undefined}
      : {type: 'none', value: undefined}
  }, options)
}

// ── Renewal of the active leases in the host beat (CYAU-14) ─────────────────────────────────────────────
// While the host is alive, at every beat it renews the leases it holds → they stay its own. If the host dies the beats
// stop, nobody renews and the server expires the lease (→ ticket "recovery required", server-side). On a
// lost/expired lease the worktree is NOT touched nor the unpushed work reassigned: we only stop
// renewing it, the recovery is a server/human decision.

// Store of the active leases used by the renewal round, which works on a potentially stale snapshot (`list`):
// that is why `update`/`remove` are compare-and-set by run_id (never overwrite/delete a lease
// re-acquired in the meantime). Injectable in tests (no real disk).
export interface LeaseStore {
  list(): LeaseRecord[]
  // Updates a renewed lease ONLY if still ours (same run_id); no-op if released or re-acquired.
  update(lease: LeaseRecord): void
  // Removes ONLY if still ours (same run_id) or already missing; if re-acquired, leaves it intact.
  remove(lease: LeaseRecord): void
}

/** File store (default): `leases/<ticket>.json` under the state dir. */
export function fileLeaseStore(dir: string = leasesDir()): LeaseStore {
  return {
    list: () => listLeases(dir),
    update: (lease) => void saveLeaseIfHeld(lease, dir),
    remove: (lease) => removeLeaseIfHeld(lease.ticket, lease.run_id, dir),
  }
}

/** Outcome of a renewal round: tickets renewed, lost/expired (removed), in transient error (kept). */
export interface RenewLeasesResult {
  renewed: string[]
  lost: string[]
  errored: string[]
}

/**
 * Renews every active lease of this host. Pure with respect to I/O (injectable client and store). Best-effort:
 * a malformed lease or an error on one does not block the others. Idempotent transitions on the server outcome:
 * - renewed → updates expires_at (owner unchanged) and updated_at, ONLY if still ours (compare-and-set);
 * - held/expired → removes the local file (no longer ours / expired), ONLY if still ours: stops renewing it;
 * - error (network) → KEEPS the file: a network blip must not lose the lease, retry at the next beat.
 * The writes are compare-and-set by run_id: `list` is a snapshot and in the meantime the ticket may have been
 * released or re-acquired (new run_id) → never overwrite/delete the new run's lease.
 */
export async function renewActiveLeases(
  client: Pick<AutomatorClient, 'renewLease'>,
  store: LeaseStore,
  hostId: string,
  now: () => Date,
): Promise<RenewLeasesResult> {
  const result: RenewLeasesResult = {renewed: [], lost: [], errored: []}
  for (const lease of store.list()) {
    try {
      // Renews only the leases of THIS host identity: a stale file of another identity (after a
      // re-registration) must be left to expire server-side, not renewed with the current identity.
      if (lease.host_id !== hostId) continue
      const req = buildRenewRequest({ticket: lease.ticket, hostId, runId: lease.run_id, ttlSeconds: lease.ttl_seconds})
      const res = await client.renewLease(req)
      if (res.outcome === 'renewed') {
        store.update({...lease, expires_at: res.lease?.expires_at ?? lease.expires_at, updated_at: now().toISOString()})
        result.renewed.push(lease.ticket)
      } else if (res.outcome === 'held' || res.outcome === 'expired') {
        store.remove(lease)
        result.lost.push(lease.ticket)
      } else {
        result.errored.push(lease.ticket)
      }
    } catch {
      // Unreadable record or unexpected error on a single lease: it must not block the others.
      result.errored.push(lease.ticket)
    }
  }

  return result
}

export interface LeaseRenewerOptions {
  fetchFn?: FetchFn
  now?: () => Date
  store?: LeaseStore // injectable in tests; default: file store
}

/**
 * Lease renewal callback to compose into the host beat (heartbeat). `undefined` if the host-scoped channel is
 * missing: sync + the COMPLETE host identity (host_id + revocable credential) are needed. The call ALWAYS uses
 * the host credential (revoking it server-side also disables the renewals). Ignores `ok` (the host is alive
 * regardless of the actions' outcome). Best-effort: `renewActiveLeases` never throws.
 */
export function makeLeaseRenewer(secrets: Secrets, opts: LeaseRenewerOptions = {}): ((ok: boolean) => Promise<void>) | undefined {
  if (!secrets.sync || !hasOperationalHostIdentity(secrets)) return undefined
  const store = opts.store ?? fileLeaseStore()
  const now = opts.now ?? (() => new Date())
  return async () => {
    // `secrets` is the same object atomically updated by the first pull's recovery. Client, token and
    // host_id must therefore be resolved at EVERY beat: capturing them here would leave the daemon on the superseded token.
    if (!secrets.sync || !hasOperationalHostIdentity(secrets)) return
    const client = makeClient(secrets.sync, opts.fetchFn, secrets.host.token)
    await renewActiveLeases(client, store, secrets.host.id, now)
  }
}
