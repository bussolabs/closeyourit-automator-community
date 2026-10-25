import {Args, Flags} from '@oclif/core'
import {BaseCommand} from '../base'
import {hasOperationalHostIdentity, loadSecrets} from '../lib/config'
import {makeClient} from '../lib/client'
import {buildLeaseRequest, buildReleaseRequest, DEFAULT_LEASE_TTL_SECONDS, type LeaseRecord, removeLeaseIfHeld, saveLease} from '../lib/lease'
import {AutomatorError, ErrorCodes} from '../errors/error-codes'

export default class Lease extends BaseCommand {
  static description =
    'Acquisisce (o rilascia con --release) un lease atomico sul ticket, così due host non lavorano lo stesso ticket. Il lease associa ticket, host_id (identità registrata), run_id, agent e una scadenza; l\'unicità è garantita server-side. Acquisito → exit 0; già detenuto da un altro host → exit 3 (non procedere); server non raggiungibile → exit 1'

  static examples = [
    '<%= config.bin %> lease CYAU-13 --run-id run-42 --agent triage',
    '<%= config.bin %> lease CYAU-13 --run-id run-42 --agent triage --ttl 1800 --json',
    '<%= config.bin %> lease CYAU-13 --run-id run-42 --release',
  ]

  static args = {
    ticket: Args.string({description: 'codice del ticket da bloccare (es. CYAU-13)', required: true}),
  }

  static flags = {
    'run-id': Flags.string({description: 'identificativo della lavorazione che detiene il lease', required: true}),
    agent: Flags.string({description: 'agente che lavora il ticket (richiesto in acquisizione)'}),
    ttl: Flags.integer({description: `scadenza del lease in secondi (default ${DEFAULT_LEASE_TTL_SECONDS})`}),
    release: Flags.boolean({description: 'rilascia il lease invece di acquisirlo'}),
    'dry-run': Flags.boolean({description: 'Mostra la richiesta senza contattare il server'}),
  }

  async run(): Promise<unknown> {
    const {args, flags} = await this.parse(Lease)
    const secrets = loadSecrets()

    // The channel to CloseYourIt (and the atomic lease endpoint) requires sync to be configured.
    if (!secrets.sync) {
      throw new AutomatorError(ErrorCodes.Sync.notConfigured, 'Canale API non configurato: manca "sync" nei secret', 2)
    }

    // The lease is host-scoped: the COMPLETE identity is needed (host_id + revocable credential). Without registration
    // — or with a partial secret — do NOT fall back to the org token (it would bypass revocation): it is a config error.
    if (!hasOperationalHostIdentity(secrets)) {
      throw new AutomatorError(
        ErrorCodes.Lease.notConfigured,
        'Host non registrato o registrazione incompleta: esegui "automator register" (il lease usa la credenziale host, non l\'org token)',
        2,
      )
    }

    const hostId = secrets.host.id
    const runId = flags['run-id']
    // Explicit host credential: revoking it server-side really disables the leases (no org token fallback).
    const client = () => makeClient(secrets.sync!, undefined, secrets.host.token)

    if (flags.release) {
      const req = buildReleaseRequest({ticket: args.ticket, hostId, runId})
      if (flags['dry-run']) {
        if (!this.jsonEnabled()) this.log(`(dry-run) rilascio lease: ${req.ticket} (host ${hostId}, run ${runId})`)
        return {dryRun: true, action: 'release', released: false, ...req}
      }

      const released = await client().releaseLease(req)
      if (!released) {
        throw new AutomatorError(ErrorCodes.Lease.requestFailed, 'Rilascio del lease fallito: CloseYourIt non raggiungibile', 1)
      }

      // The lease is no longer active: stop renewing it at the beat. Removal conditioned on the run_id (never
      // delete a concurrent re-acquisition of the same ticket). Best-effort — if it fails, the next
      // renewal gets 404/409 and cleans up the file (self-healing), so it does not fail the release.
      this.forgetLease(req.ticket, runId)
      if (!this.jsonEnabled()) this.log(`lease rilasciato: ${req.ticket} (host ${hostId}, run ${runId})`)
      return {dryRun: false, action: 'release', released: true, ...req}
    }

    // On acquisition the agent is part of the lease association (ticket+host_id+run_id+agent): required.
    if (!flags.agent) {
      throw new AutomatorError(ErrorCodes.Lease.invalidRequest, 'Acquisizione lease: manca --agent', 2)
    }

    const req = buildLeaseRequest({ticket: args.ticket, hostId, runId, agent: flags.agent, ttlSeconds: flags.ttl})
    if (flags['dry-run']) {
      if (!this.jsonEnabled()) this.log(`(dry-run) acquisizione lease: ${req.ticket} (host ${hostId}, run ${runId}, ttl ${req.ttl_seconds}s)`)
      return {dryRun: true, action: 'acquire', acquired: false, outcome: 'dry-run', ...req}
    }

    const result = await client().acquireLease(req)
    if (result.outcome === 'error') {
      throw new AutomatorError(ErrorCodes.Lease.requestFailed, 'Acquisizione del lease fallita: CloseYourIt non raggiungibile', 1)
    }

    // Already held by another host: NOT acquired. Dedicated exit 3 → a shell gate does not proceed by mistake.
    if (result.outcome === 'held') {
      const holder = result.lease ? ` da host ${result.lease.host_id}` : ''
      const until = result.lease ? ` (scade ${result.lease.expires_at})` : ''
      throw new AutomatorError(ErrorCodes.Lease.held, `Lease del ticket ${req.ticket} già detenuto${holder}${until}: non procedere`, 3)
    }

    // Lease acquired: persist it among the active leases so the daemon renews it at the beat (while the host is alive
    // it stays ours). Records the expires_at computed by the SERVER (server time), not a local one.
    const at = new Date().toISOString()
    this.rememberLease({
      ticket: req.ticket,
      host_id: hostId,
      run_id: runId,
      agent: req.agent,
      ttl_seconds: req.ttl_seconds,
      expires_at: result.lease?.expires_at ?? null,
      acquired_at: at,
      updated_at: at,
    })

    if (!this.jsonEnabled()) {
      const until = result.lease ? `, scade ${result.lease.expires_at}` : ''
      this.log(`lease acquisito: ${req.ticket} → host ${hostId} (run ${runId}${until})`)
    }

    return {dryRun: false, action: 'acquire', acquired: true, outcome: 'acquired', host_id: hostId, run_id: runId, lease: result.lease}
  }

  /** Persists an active lease (best-effort): a local failure must not invalidate an already acquired lease. */
  private rememberLease(lease: LeaseRecord): void {
    try {
      saveLease(lease)
    } catch (error) {
      this.warn(`lease acquisito ma non registrato localmente (non sarà rinnovato in automatico): ${(error as Error).message}`)
    }
  }

  /** Removes the lease of THIS run (best-effort, conditioned on the run_id): if it fails, the next renewal cleans up the file. */
  private forgetLease(ticket: string, runId: string): void {
    try {
      removeLeaseIfHeld(ticket, runId)
    } catch {
      // Ignored: self-healing at the next beat (renew → 404/409 → remove).
    }
  }
}
