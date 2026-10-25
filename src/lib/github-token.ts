import {DEFAULT_API} from './client'
import {hasOperationalHostIdentity, type Secrets} from './config'
import {type FetchFn} from './heartbeat'

/**
 * CYAU-248 — the GitHub token for one ticket session: minted by the server for the ticket's repository only,
 * valid one hour (the phase cap). It replaces the operator's permanent token, which the sandbox may not read.
 * Asked outside the sandbox with the host token, once per session. Any failure gives no token: the session
 * still runs, and the push fails as before instead of the session not starting.
 */
export type GithubTokenFetcher = (ticket: string) => Promise<string | undefined>

const REQUEST_TIMEOUT_MS = 15_000
// GitHub's installation tokens are ~390 characters with `.` and `-` today; only the prefix is stable.
const INSTALLATION_TOKEN = /^ghs_[A-Za-z0-9_.-]{20,1024}$/

export function makeGithubTokenFetcher(
  secrets: Secrets,
  opts: {fetchFn?: FetchFn; log: (line: string) => void},
): GithubTokenFetcher {
  const fetchFn = opts.fetchFn ?? globalThis.fetch
  return async (ticket) => {
    if (!secrets.sync || !hasOperationalHostIdentity(secrets)) return undefined
    try {
      const res = await fetchFn(`${secrets.sync.apiUrl ?? DEFAULT_API}/api/v1/agent_host/github_token`, {
        method: 'POST',
        headers: {Authorization: `Bearer ${secrets.host.token}`, 'Content-Type': 'application/json'},
        body: JSON.stringify({ticket}),
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      })
      const body = (await res.json().catch(() => null)) as {data?: {token?: unknown}; error?: {code?: unknown}} | null
      const token = body?.data?.token
      if (res.ok && typeof token === 'string' && INSTALLATION_TOKEN.test(token)) return token
      const code = typeof body?.error?.code === 'string' ? body.error.code : `HTTP ${res.status}`
      opts.log(`github token: none for ${ticket} (${code}), the session cannot push`)
    } catch {
      opts.log(`github token: none for ${ticket} (server unreachable), the session cannot push`)
    }

    return undefined
  }
}
