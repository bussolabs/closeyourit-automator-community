import {DEFAULT_API} from './client'
import {
  hasOperationalHostIdentity,
  isUserToken,
  loadSecureCredentialsConfig,
  updateSecrets,
  type HeartbeatConfig,
  type Secrets,
  type SecretsUpdater,
} from './config'
import {type FetchFn} from './heartbeat'
import {loadVaultCredential} from './secure-credentials'

/**
 * CYAU-220 — the machine writes its own heartbeat section. A managed installation saved credentials and service
 * but never the `heartbeat` section: without it the daemon did not beat, the panel showed the host as stopped and
 * the server refused every claim, with nothing in the log saying why.
 *
 * The check-in URL wants the project id, not its key: the key is the one chosen at install for the secrets
 * (`credentials-provider.json`), resolved through the same `/cli/v1/projects` list `cyi` uses, with the machine's
 * service account token. The server binds the host to the FIRST project it beats for and refuses the others, so a
 * section already present is never rewritten.
 */

// One budget for the whole lookup, every page included: a slow server must not hold the daemon start.
export const PROJECT_LOOKUP_TIMEOUT_MS = 15_000
// A guard against a server that keeps announcing pages: 100 projects per page, 20 pages is far beyond any org.
const MAX_PAGES = 20

export type ProjectLookup = {outcome: 'found'; id: string} | {outcome: 'missing'; reason: string}

export interface ProjectLookupOptions {
  apiUrl?: string
  fetchFn?: FetchFn
  timeoutMs?: number
}

/** Project key → project id, walking every page of `/cli/v1/projects`. Never throws; the reason carries no secret. */
export async function resolveProjectId(key: string, token: string, opts: ProjectLookupOptions = {}): Promise<ProjectLookup> {
  const fetchFn = opts.fetchFn ?? globalThis.fetch
  const signal = AbortSignal.timeout(opts.timeoutMs ?? PROJECT_LOOKUP_TIMEOUT_MS)
  const wanted = key.toLowerCase()
  let page = 1
  let totalPages = 1
  try {
    do {
      const res = await fetchFn(`${opts.apiUrl ?? DEFAULT_API}/cli/v1/projects?page=${page}&per=100`, {
        method: 'GET',
        headers: {Authorization: `Bearer ${token}`},
        signal,
      })
      if (!res.ok) return {outcome: 'missing', reason: `project lookup refused by CloseYourIt (HTTP ${res.status})`}
      const body = (await Promise.resolve().then(() => res.json()).catch(() => null)) as {data?: unknown; meta?: {total_pages?: unknown}} | null
      const data = body?.data
      const rows = Array.isArray(data) ? data as Array<{id?: unknown; key?: unknown} | null> : []
      const match = rows.find((row) => typeof row?.key === 'string' && row.key.toLowerCase() === wanted)
      if (match && typeof match.id === 'string' && match.id.trim().length > 0) return {outcome: 'found', id: match.id}
      totalPages = Number(body?.meta?.total_pages ?? 1)
      page += 1
    } while (page <= totalPages && page <= MAX_PAGES)
  } catch {
    return signal.aborted
      ? {outcome: 'missing', reason: 'project lookup timed out (CloseYourIt did not answer in time)'}
      : {outcome: 'missing', reason: 'project lookup failed (CloseYourIt not reachable)'}
  }

  return {outcome: 'missing', reason: `project ${key} is not visible to this machine's service account`}
}

/** The monitor name of THIS machine: unique per host, stable across restarts. */
export function heartbeatSlug(hostId: string): string {
  return `automator-${hostId.toLowerCase().replace(/[^a-z0-9-]+/g, '-')}`
}

export type HeartbeatSetupResult =
  | {status: 'existing' | 'configured'; heartbeat: HeartbeatConfig}
  | {status: 'missing'; reason: string}

export interface HeartbeatSetupDeps {
  fetchFn?: FetchFn
  /** The project key chosen at install; default: `credentials-provider.json`. */
  projectKey?: () => string | undefined
  /** The service account token; default: the one already in memory, else the credential store. */
  serviceToken?: () => string | undefined
  update?: SecretsUpdater
  timeoutMs?: number
}

/**
 * Writes the heartbeat section when it is missing, and only then. Mutates `secrets` in place, like the host
 * registration, so whoever builds the beat right after sees it. Never throws: on any failure it says why.
 */
export async function ensureHeartbeatConfig(secrets: Secrets, deps: HeartbeatSetupDeps = {}): Promise<HeartbeatSetupResult> {
  if (secrets.heartbeat) return {status: 'existing', heartbeat: secrets.heartbeat}
  if (!hasOperationalHostIdentity(secrets)) return {status: 'missing', reason: 'this host is not registered yet'}
  const key = (deps.projectKey ?? (() => loadSecureCredentialsConfig()?.project))()
  if (!key) return {status: 'missing', reason: 'no project chosen at install (managed mode, --secrets-project)'}
  const token = (deps.serviceToken ?? (() => secrets.cyiToken ?? loadVaultCredential()))()
  if (!isUserToken(token)) return {status: 'missing', reason: 'no service account token in the credential store'}

  const apiUrl = secrets.sync?.apiUrl
  const lookup = await resolveProjectId(key, token, {apiUrl, fetchFn: deps.fetchFn, timeoutMs: deps.timeoutMs})
  if (lookup.outcome === 'missing') return {status: 'missing', reason: lookup.reason}

  const heartbeat: HeartbeatConfig = {
    ...(apiUrl ? {apiUrl} : {}),
    projectId: lookup.id,
    slug: heartbeatSlug(secrets.host.id),
  }
  try {
    // A section written meanwhile by someone else wins: the server already bound the host to its project.
    const committed = (deps.update ?? updateSecrets)((current) => (current.heartbeat ? null : {...current, heartbeat}))
    const saved = committed.secrets.heartbeat
    if (!saved) return {status: 'missing', reason: 'the heartbeat section could not be saved'}
    secrets.heartbeat = saved
    return {status: committed.updated ? 'configured' : 'existing', heartbeat: saved}
  } catch {
    return {status: 'missing', reason: 'the heartbeat section could not be saved'}
  }
}
