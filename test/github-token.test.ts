import {describe, expect, it, vi} from 'vitest'
import {type Secrets} from '../src/lib/config'
import {makeGithubTokenFetcher} from '../src/lib/github-token'

// CYAU-248 — before a ticket session the host asks the server for a GitHub token scoped to that ticket.
// The shape GitHub mints today: ~390 characters, with `.` and `-` (CYAU-248).
const TOKEN = `ghs_${'A1b2'.repeat(20)}.${'c3-D4_'.repeat(30)}.${'e5F6'.repeat(20)}`
const secrets: Secrets = {sync: {apiUrl: 'https://cyi.test'}, host: {id: 'host-1', token: 'cyi_ah_hosttoken'}}

function respond(status: number, body?: unknown) {
  return vi.fn(async (_url: string, _init?: RequestInit) =>
    new Response(body === undefined ? null : JSON.stringify(body), {status}))
}

describe('makeGithubTokenFetcher', () => {
  it('asks the server with the host token for the ticket and returns the token', async () => {
    const fetchFn = respond(200, {data: {env: 'GH_TOKEN', token: TOKEN, expires_at: '2026-10-08T20:00:00Z'}})
    const fetcher = makeGithubTokenFetcher(secrets, {fetchFn, log: () => undefined})

    await expect(fetcher('ALEX-78')).resolves.toBe(TOKEN)
    const [url, init] = fetchFn.mock.calls[0]
    expect(url).toBe('https://cyi.test/api/v1/agent_host/github_token')
    expect(init?.method).toBe('POST')
    expect((init?.headers as Record<string, string>).Authorization).toBe('Bearer cyi_ah_hosttoken')
    expect(JSON.parse(String(init?.body))).toEqual({ticket: 'ALEX-78'})
  })

  it('logs the refusal code and gives no token', async () => {
    const log = vi.fn()
    const fetcher = makeGithubTokenFetcher(secrets, {
      fetchFn: respond(403, {error: {code: 'R403-AGENT-009', message: 'The host does not hold this ticket'}}),
      log,
    })

    await expect(fetcher('ALEX-78')).resolves.toBeUndefined()
    expect(log).toHaveBeenCalledWith(expect.stringContaining('R403-AGENT-009'))
  })

  it('gives no token on a network failure or an odd body, and never logs a token', async () => {
    const log = vi.fn()
    const failing = vi.fn(async () => { throw new Error('boom') })
    await expect(makeGithubTokenFetcher(secrets, {fetchFn: failing, log})('ALEX-78')).resolves.toBeUndefined()
    await expect(makeGithubTokenFetcher(secrets, {fetchFn: respond(200, {data: {token: 'not-a-github-token'}}), log})('ALEX-78'))
      .resolves.toBeUndefined()
    expect(log.mock.calls.flat().join(' ')).not.toMatch(/gh[pousr]_/)
  })

  it('does not call the server without a host identity', async () => {
    const fetchFn = respond(200, {})
    const fetcher = makeGithubTokenFetcher({sync: {apiUrl: 'https://cyi.test'}}, {fetchFn, log: () => undefined})

    await expect(fetcher('ALEX-78')).resolves.toBeUndefined()
    expect(fetchFn).not.toHaveBeenCalled()
  })
})
