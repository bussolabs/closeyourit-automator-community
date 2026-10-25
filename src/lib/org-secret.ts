import {DEFAULT_API} from './client'
import {hasOperationalHostIdentity, type Secrets} from './config'
import {type FetchFn} from './heartbeat'

/**
 * A secret the organization lends to its machines (CYAU-224 Claude credential, CYAU-228 OpenRouter key): fetched
 * with the host token, kept in the system credential store so it survives a restart, refreshed by a beat.
 */

/** Where the secret survives a restart: the system credential store, on managed installations only. */
export interface OrgSecretStore {
  load(): string | undefined
  save(token: string): boolean
  clear(): boolean
}

export type OrgSecretChange = 'unchanged' | 'set' | 'rotated' | 'removed'

export type OrgSecretFetch<T> = {outcome: 'set'; value: T} | {outcome: 'none'} | {outcome: 'unavailable'}

export interface OrgSecretSpec<T> {
  /** The API path under /api/v1/agent_host, e.g. 'claude_credential'. */
  resource: string
  parse(token: unknown): T | undefined
  tokenOf(value: T): string
  store: OrgSecretStore
  /** What the reconciler logs on each change; never the token. */
  messages: Record<Exclude<OrgSecretChange, 'unchanged'>, string>
}

export interface OrgSecret<T> {
  /** The secret in effect for this process, read once from the store and then kept up to date by the beat. */
  current(): T | undefined
  /** Test seam: swaps the store and forgets the in-memory secret. */
  reset(store?: OrgSecretStore): void
  /** Applies what the server answered: replaces, rotates or removes the secret, in memory and in the store. */
  apply(next: T | undefined): OrgSecretChange
  fetch(secrets: Secrets, fetchFn?: FetchFn): Promise<OrgSecretFetch<T>>
  reconciler(secrets: Secrets, opts?: OrgSecretReconcilerOptions): ((ok: boolean) => Promise<void>) | undefined
}

export interface OrgSecretReconcilerOptions {
  fetchFn?: FetchFn
  log?: (message: string) => void
  everyBeats?: number
  /** Called after the secret changed, e.g. to drop a readiness probe that ran with the old one. */
  onChange?: (change: Exclude<OrgSecretChange, 'unchanged'>) => void
}

const REQUEST_TIMEOUT_MS = 15_000

/** One GET every five beats (about five minutes): the pages promise machines get a new key "within a few minutes". */
const DEFAULT_EVERY_BEATS = 5

export function makeOrgSecret<T>(spec: OrgSecretSpec<T>): OrgSecret<T> {
  const defaultStore = spec.store
  let store = defaultStore
  let loaded = false
  let value: T | undefined

  const current = (): T | undefined => {
    if (!loaded) {
      loaded = true
      value = spec.parse(store.load())
    }

    return value
  }

  const apply = (next: T | undefined): OrgSecretChange => {
    const previous = current()
    const previousToken = previous === undefined ? undefined : spec.tokenOf(previous)
    const nextToken = next === undefined ? undefined : spec.tokenOf(next)
    if (previousToken === nextToken) return 'unchanged'
    value = next
    if (nextToken) store.save(nextToken)
    else store.clear()
    if (!nextToken) return 'removed'
    return previous ? 'rotated' : 'set'
  }

  /**
   * Asks the server with the host token. 404 = the organization has none, 403 = this host may not have it: both
   * remove the local copy. Anything else (network, 401, 5xx, odd body) keeps the last known secret.
   */
  const fetchSecret = async (secrets: Secrets, fetchFn: FetchFn = globalThis.fetch): Promise<OrgSecretFetch<T>> => {
    if (!secrets.sync || !hasOperationalHostIdentity(secrets)) return {outcome: 'unavailable'}
    try {
      const res = await fetchFn(`${secrets.sync.apiUrl ?? DEFAULT_API}/api/v1/agent_host/${spec.resource}`, {
        method: 'GET',
        headers: {Authorization: `Bearer ${secrets.host.token}`},
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      })
      if (res.status === 404 || res.status === 403) return {outcome: 'none'}
      if (!res.ok) return {outcome: 'unavailable'}
      const body = (await res.json().catch(() => null)) as {data?: {token?: unknown}} | null
      const parsed = spec.parse(body?.data?.token)
      return parsed === undefined ? {outcome: 'unavailable'} : {outcome: 'set', value: parsed}
    } catch {
      return {outcome: 'unavailable'}
    }
  }

  /**
   * Beat that keeps the secret aligned with the server, twin of `makeSkillsReconciler`. The first beat fetches at
   * once, so a just-started machine picks up a rotation without waiting. Never throws; logs never carry the token.
   */
  const reconciler = (secrets: Secrets, opts: OrgSecretReconcilerOptions = {}) => {
    if (!secrets.sync || !hasOperationalHostIdentity(secrets)) return undefined
    const every = opts.everyBeats ?? DEFAULT_EVERY_BEATS
    let beats = 0
    return async () => {
      const due = beats % every === 0
      beats++
      if (!due) return
      const result = await fetchSecret(secrets, opts.fetchFn)
      if (result.outcome === 'unavailable') return
      const change = apply(result.outcome === 'set' ? result.value : undefined)
      if (change === 'unchanged') return
      opts.log?.(spec.messages[change])
      opts.onChange?.(change)
    }
  }

  return {
    current,
    reset: (next = defaultStore) => {
      store = next
      loaded = false
      value = undefined
    },
    apply,
    fetch: fetchSecret,
    reconciler,
  }
}
