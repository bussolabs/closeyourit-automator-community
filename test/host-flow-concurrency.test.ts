import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import {afterEach, beforeEach, describe, expect, it} from 'vitest'
import {resolveHostFlowConcurrency} from '../src/lib/ticket-preflight'
import {type Secrets} from '../src/lib/config'

// CYAU-69: `resolveHostFlowConcurrency` resolves the host-scoped CAP of the skill-mode flow pool = `limits.max_parallel`
// (DoD "the per-step concurrency respects the configured cap"). It is best-effort and fail-closed: when there is no
// resolvable cap it returns `undefined`, which downstream becomes `resolveFlowConcurrency(undefined)` = 1 (serial, never
// unlimited). Here it is isolated with a temporary `AUTOMATOR_STATE_DIR` (policy cache) and a fake `globalThis.fetch`.

const now = new Date('2026-07-17T12:30:00.000Z')
const originalFetch = globalThis.fetch
let stateDir: string
let prevStateDir: string | undefined

/** Fake HTTP response of the policy GET: `data` is the policy body (or null). */
function fakeFetch(data: unknown, ok = true, status = 200): typeof globalThis.fetch {
  return (async () => ({ok, status, json: async () => ({data})})) as unknown as typeof globalThis.fetch
}

/** Complete operational host identity (id + revocable `cyi_ah_` token): the real fetcher requires it. */
const operationalHost = {sync: {}, host: {id: 'h1', token: 'cyi_ah_tok'}} as Secrets

beforeEach(() => {
  // FRESH state dir per test: the policy cache written by one test must not contaminate the next
  // (an outage with a populated cache would read the previous cap instead of falling back to `undefined`).
  stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'automator-host-flow-'))
  prevStateDir = process.env.AUTOMATOR_STATE_DIR
  process.env.AUTOMATOR_STATE_DIR = stateDir
})

afterEach(() => {
  globalThis.fetch = originalFetch
  if (prevStateDir === undefined) delete process.env.AUTOMATOR_STATE_DIR
  else process.env.AUTOMATOR_STATE_DIR = prevStateDir
  fs.rmSync(stateDir, {recursive: true, force: true})
})

describe('resolveHostFlowConcurrency (CYAU-69: host-scoped cap of the flow-pool)', () => {
  it('sync channel not configured → undefined (backward compat: non-managed host stays serial, no policy call)', async () => {
    let called = false
    globalThis.fetch = (async () => {
      called = true
      throw new Error('non deve essere chiamata')
    }) as unknown as typeof globalThis.fetch

    expect(await resolveHostFlowConcurrency({} as Secrets, now)).toBeUndefined()
    expect(called).toBe(false) // without sync the server is not queried at all
  })

  it('server policy with max_parallel → that cap (the concurrency respects the configured value)', async () => {
    globalThis.fetch = fakeFetch({max_parallel: 3})
    expect(await resolveHostFlowConcurrency(operationalHost, now)).toBe(3)
  })

  it('server policy WITHOUT max_parallel → undefined (non-binding cap → serial downstream)', async () => {
    globalThis.fetch = fakeFetch({max_daily_runs: 10}) // valid policy but without slots
    expect(await resolveHostFlowConcurrency(operationalHost, now)).toBeUndefined()
  })

  it('max_parallel = 0 → 0 (policy closing all slots: value preserved, not mistaken for "missing")', async () => {
    globalThis.fetch = fakeFetch({max_parallel: 0})
    expect(await resolveHostFlowConcurrency(operationalHost, now)).toBe(0)
  })

  it('unreachable server and no cache → undefined without throwing (best-effort, fail-closed to serial)', async () => {
    globalThis.fetch = fakeFetch(null, false, 503) // outage: !ok, empty cache (fresh state dir) → none
    await expect(resolveHostFlowConcurrency(operationalHost, now)).resolves.toBeUndefined()
  })
})
