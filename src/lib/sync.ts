import {PlaybookSchema, type Playbook} from './schema'
import {hasOperationalHostIdentity, type HostEntry, type Secrets} from './config'
import {makeClient, type AutomatorClient, type HostCallResult} from './client'
import {recoverHostOperation} from './host-auth'
import {loadVaultCredential} from './secure-credentials'
import {type FetchFn} from './heartbeat'
import {type TicketQueueTarget} from './runner'
import {type WorkspaceManifest} from './workspace-manifest'

// Host-scoped sync (CYAU-87): the host fetches the MANIFEST of the repositories that belong to it
// (`GET /api/v1/agent_host/workspace_manifest`, `cyi_ah_` credential) and materializes ONE queue sentinel per
// project present in the local host map (the only machine-specific data: cwd). At every tick that
// sentinel claims the project's NEXT READY PHASE; runtime, sandbox, permissions, skill and TTL come from the
// claim (`PhaseProfile`), not from here.
//
// No more agent catalogue: `getAgents`, the per-agent fan-out, the sidecar and `reportRun` belonged to the
// typed-agent model (removal MT-9/CYAU-85). The outcome of a host-first run travels on
// `deliverAttempt` while the lease is still held, not on a per-agent run channel.

export type HostMap = Record<string, HostEntry>
export interface SkippedTarget {
  projectKey: string
  reason: 'host-unmapped' | 'project-key-missing'
}
export interface Materialized {
  actions: Record<string, unknown> // validated downstream by PlaybookSchema (avoids fighting the union)
  skipped: SkippedTarget[]
  /** Trusted cwd from the local host configuration, separate from the materialized remote manifest data. */
  authorizedCwds: Record<string, string>
  ticketQueues: Record<string, TicketQueueTarget>
}

// STABLE queue polling cadence: polling is the HOST's responsibility (it claims the next ready phase
// at every daemon tick) and no longer depends on any remote configuration.
const HOST_FIRST_QUEUE_SCHEDULE = 'every 1s'

/**
 * `run` of the queue sentinel. It is NOT an executable prompt: the host-first queue runs only in skill-mode
 * (clean break CYAU-94) and `composeQueueSkillAction` replaces type/permission_mode/timeout with the profile of the
 * claimed phase, keeping `run` only as a carrier of the retry findings. It stays an explicit text because
 * `PlaybookSchema` requires a non-empty `run` and because a playbook inspected by hand must tell the truth.
 */
const QUEUE_SENTINEL_RUN = 'sentinella coda host-first: la fase reclamata determina skill, runtime e permessi'

// Playbook action key: only [a-z0-9]+ (PlaybookSchema constraint), derived from the project key with an
// anti-collision numeric suffix (the digits stay [a-z0-9]).
function actionKey(projectKey: string, used: Set<string>): string {
  const base = projectKey.toLowerCase().replace(/[^a-z0-9]/g, '') || 'queue'
  let key = base
  let n = 2
  while (used.has(key)) {
    key = `${base}${n}`
    n += 1
  }

  used.add(key)
  return key
}

/** A project's queue sentinel: scheduler + cwd from the local host config, nothing from the remote. */
function composeQueueAction(host: HostEntry): Record<string, unknown> {
  const action: Record<string, unknown> = {
    type: 'claude',
    run: QUEUE_SENTINEL_RUN,
    schedule: HOST_FIRST_QUEUE_SCHEDULE,
    cwd: host.cwd,
    containment: 'strong',
    enabled: true,
    catch_up: true,
  }
  return action
}

/**
 * Materializes the host-scoped manifest into playbook actions: ONE queue sentinel per project mapped in the
 * host map. Manifest projects without a local `cwd` end up in `skipped` (never a silent drop: the host
 * must be able to say why it does not serve a project the server assigns to it). It does NOT validate yet —
 * `PlaybookSchema` does that downstream.
 */
export function materialize(manifest: WorkspaceManifest, hosts: HostMap): Materialized {
  const actions: Record<string, unknown> = {}
  const skipped: SkippedTarget[] = []
  const used = new Set<string>()
  const authorizedCwds: Record<string, string> = {}
  const ticketQueues: Record<string, TicketQueueTarget> = {}
  const seen = new Set<string>() // defensive dedup: the manifest should not repeat a project

  for (const entry of manifest.repositories) {
    const projectKey = entry.project_key.trim()
    if (projectKey === '') {
      skipped.push({projectKey: '', reason: 'project-key-missing'})
      continue
    }

    const host = hosts[projectKey]
    if (!host) {
      skipped.push({projectKey, reason: 'host-unmapped'})
      continue
    }
    if (seen.has(projectKey)) continue
    seen.add(projectKey)

    const key = actionKey(projectKey, used)
    actions[key] = composeQueueAction(host)
    authorizedCwds[key] = host.cwd
    ticketQueues[key] = {projectKey, repository: entry.repo}
  }

  return {actions, skipped, authorizedCwds, ticketQueues}
}

export interface SyncResult {
  playbook: Playbook
  authorizedCwds: Record<string, string>
  ticketQueues: Record<string, TicketQueueTarget>
}
export interface SyncDeps {
  client: AutomatorClient
  hosts: HostMap
  log?: (message: string) => void
}
export type SyncFn = () => Promise<SyncResult | null>

/** First operational pull with bounded recovery of the host-token 401 only. Reused by daemon/tick and the sync command. */
export async function pullManifestWithRecovery(
  secrets: Secrets,
  log?: (message: string) => void,
  fetchFn?: FetchFn,
  version?: string,
  platform?: string,
): Promise<HostCallResult<WorkspaceManifest>> {
  if (!secrets.sync || !hasOperationalHostIdentity(secrets)) return {outcome: 'unavailable'}
  const configuredSync = secrets.sync
  const hostOnlyFallback = configuredSync.apiUrl ? {apiUrl: configuredSync.apiUrl} : {}
  return recoverHostOperation({
    secrets,
    // If `sync` is removed during the rotation, keep at most the endpoint: never bring the initial
    // orgToken back to life for a host-scoped operational call.
    operation: (token, currentSync) => makeClient(currentSync ?? hostOnlyFallback, fetchFn, token).getWorkspaceManifestResult(),
    // Re-registers with the service account token (cyi_u_) re-read inside the lock; org token fallback via makeClient.
    // Uses only the config re-read inside the lock; never closes over the initial org token.
    register: (registration, currentSync, registrationToken) =>
      makeClient(currentSync, fetchFn, undefined, registrationToken).registerHostResult(registration),
    loadRegistrationToken: () => loadVaultCredential(),
    version,
    platform,
    log,
  })
}

/**
 * Builds the sync function for daemon/tick: fetches the manifest and materializes the sentinels' playbook.
 * Returns null if there is nothing to run (failed fetch, zero actions, or invalid generated playbook) → the
 * caller skips the iteration.
 */
export function buildSync(deps: SyncDeps): SyncFn {
  const log = deps.log ?? (() => undefined)

  return async () => {
    const manifest = await deps.client.getWorkspaceManifest()
    if (manifest === null) {
      log('sync: fetch del manifest fallito (best-effort, salto questa iterazione)')
      return null
    }

    const {actions, skipped, authorizedCwds, ticketQueues} = materialize(manifest, deps.hosts)
    for (const s of skipped) {
      log(s.reason === 'project-key-missing'
        ? 'sync: voce del manifest senza project-key → saltata'
        : `sync: progetto "${s.projectKey}" non nella mappa host → coda non servita da questo host`)
    }

    if (Object.keys(actions).length === 0) {
      log('sync: nessuna coda da servire su questo host')
      return null
    }

    const parsed = PlaybookSchema.safeParse({version: 1, actions})
    if (!parsed.success) {
      log(`sync: playbook generato invalido (${parsed.error.issues.length} problemi), salto`)
      return null
    }

    return {playbook: parsed.data, authorizedCwds, ticketQueues}
  }
}

// Builds the SyncFn from the secrets (mirrors makeHeartbeat), or `undefined` if sync is not configured
// (then daemon/tick use the local playbook file). Empty host map if missing → every manifest project
// ends up in skipped (log), no action: safe behaviour, not a crash.
export function makeSync(
  secrets: Secrets,
  log?: (message: string) => void,
  fetchFn?: FetchFn,
  platform?: string,
): SyncFn | undefined {
  if (!secrets.sync) return undefined
  // A sync configured but not yet authenticated stays defined to prevent the daemon from falling back to the
  // local playbook: the iteration is skipped, without network and without downgrading to the org token.
  if (!hasOperationalHostIdentity(secrets)) {
    return async () => {
      log?.('Sync saltata: host non registrato o credenziale host non valida')
      return null
    }
  }
  return async () => {
    const pulled = await pullManifestWithRecovery(secrets, log, fetchFn, undefined, platform)

    if (pulled.outcome !== 'ok') {
      const reason = pulled.outcome === 'unauthorized'
        ? 'token host non autenticato'
        : pulled.outcome === 'forbidden'
          ? 'host revocato: recovery vietato'
          : 'server/rete o persistenza non disponibile'
      log?.(`sync: fetch del manifest fallito (${reason}), salto questa iterazione`)
      return null
    }

    // After any rotation the client uses the persisted identity, never the superseded initial token.
    if (!secrets.sync || !hasOperationalHostIdentity(secrets)) return null
    const activeClient = makeClient(secrets.sync, fetchFn, secrets.host.token)
    const client: AutomatorClient = {...activeClient, getWorkspaceManifest: async () => pulled.value}
    return buildSync({client, hosts: secrets.hosts ?? {}, log})()
  }
}
