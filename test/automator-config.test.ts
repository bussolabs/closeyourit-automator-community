import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest'
import {
  type AutomatorFlowConfig,
  DEFAULT_API_AUTOMATOR_CONFIG_PATH,
  DEFAULT_AUTOMATOR_CONFIG,
  DEFAULT_CACHE_MAX_AGE_SECONDS,
  DEFAULT_PHASE_CONCURRENCY,
  concurrencyForPhase,
  defaultAutomatorConfigFetcher,
  flowSequence,
  parseAutomatorConfig,
  readCachedAutomatorConfig,
  removeCachedAutomatorConfig,
  resolveAutomatorConfig,
  writeCachedAutomatorConfig,
} from '../src/lib/automator-config'
import {EXECUTION_PHASES} from '../src/lib/phase-profile'

// CYAU-73: flow-config downloadable by the automator (B.3 + C.6). The phase sequence and the per-phase concurrency
// can be configured in CloseYourIt and downloaded by the automator, instead of being fixed in the code. The
// first release uses a FIXED flow (5 steps) + default concurrency; this module makes the flow configurable
// remotely with a FAIL-CLOSED CACHE. The endpoint lives on the Rails side; here lives the client counterpart (fetch/cache/resolve).
// Key difference with limits: the fail-closed does NOT block but DEGRADES to the hardcoded default (the known fixed flow),
// so the host keeps working with the safe flow without ever applying an unauthorized configuration.

const NOW = new Date('2026-07-13T12:00:00.000Z')

const validConfig: AutomatorFlowConfig = {
  sequence: ['triage', 'planner', 'autopilot'],
  concurrency: {triage: 3, planner: 2},
}

describe('parseAutomatorConfig · untrusted input (from the server)', () => {
  it('config with valid sequence and concurrency → accepted', () => {
    expect(parseAutomatorConfig(validConfig)).toEqual(validConfig)
  })

  it('sequence with all five known phases → accepted', () => {
    const raw = {sequence: [...EXECUTION_PHASES]}
    expect(parseAutomatorConfig(raw)).toEqual({sequence: [...EXECUTION_PHASES]})
  })

  it('optional concurrency: missing → config still valid', () => {
    expect(parseAutomatorConfig({sequence: ['triage']})).toEqual({sequence: ['triage']})
  })

  it('non-object → null (never crash, never fail-open)', () => {
    expect(parseAutomatorConfig(null)).toBeNull()
    expect(parseAutomatorConfig('flow')).toBeNull()
    expect(parseAutomatorConfig(42)).toBeNull()
  })

  it('missing sequence → null', () => {
    expect(parseAutomatorConfig({concurrency: {triage: 1}})).toBeNull()
  })

  it('empty sequence → null (a sequence must have at least one phase)', () => {
    expect(parseAutomatorConfig({sequence: []})).toBeNull()
  })

  it('unknown phase in the sequence → null (fail-closed on the vocabulary)', () => {
    expect(parseAutomatorConfig({sequence: ['triage', 'deploy']})).toBeNull()
  })

  it('concurrency with non-positive value → null (malformed config → fail-closed)', () => {
    expect(parseAutomatorConfig({sequence: ['triage'], concurrency: {triage: 0}})).toBeNull()
    expect(parseAutomatorConfig({sequence: ['triage'], concurrency: {triage: -1}})).toBeNull()
    expect(parseAutomatorConfig({sequence: ['triage'], concurrency: {triage: 1.5}})).toBeNull()
  })

  it('concurrency with an unknown phase key (typo) → null (never a silent partial config)', () => {
    expect(parseAutomatorConfig({sequence: ['triage'], concurrency: {planer: 3}})).toBeNull()
    expect(parseAutomatorConfig({sequence: ['triage'], concurrency: {triage: 3, deploy: 1}})).toBeNull()
  })

  it('extra fields → strip (evolving server contract, a new field does not break the config)', () => {
    const raw = {sequence: ['triage'], concurrency: {triage: 2}, future_field: 'x'}
    expect(parseAutomatorConfig(raw)).toEqual({sequence: ['triage'], concurrency: {triage: 2}})
  })

  it('valid max_age_seconds → kept (cache freshness)', () => {
    const raw = {sequence: ['triage'], max_age_seconds: 600}
    expect(parseAutomatorConfig(raw)).toEqual({sequence: ['triage'], max_age_seconds: 600})
  })
})

describe('DEFAULT_AUTOMATOR_CONFIG · the FIXED flow of the first release (fail-closed)', () => {
  it('the default sequence is the five execution phases, in order', () => {
    expect(DEFAULT_AUTOMATOR_CONFIG.sequence).toEqual([...EXECUTION_PHASES])
  })

  it('is a valid config according to the parser', () => {
    expect(parseAutomatorConfig(DEFAULT_AUTOMATOR_CONFIG)).toEqual({sequence: [...EXECUTION_PHASES]})
  })

  it('is frozen: the default is not mutable', () => {
    expect(Object.isFrozen(DEFAULT_AUTOMATOR_CONFIG)).toBe(true)
    expect(Object.isFrozen(DEFAULT_AUTOMATOR_CONFIG.sequence)).toBe(true)
  })
})

describe('local flow-config cache (fail-closed, always expires)', () => {
  let dir: string
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'automator-config-cache-'))
  })
  afterEach(() => {
    fs.rmSync(dir, {recursive: true, force: true})
  })
  const cacheFile = (): string => path.join(dir, 'automator-config.json')

  it('round-trip: write then read → the same config', () => {
    writeCachedAutomatorConfig(validConfig, NOW, cacheFile())
    expect(readCachedAutomatorConfig(NOW, cacheFile())).toEqual(validConfig)
  })

  it('missing file → null (not an error, simply no cache)', () => {
    expect(readCachedAutomatorConfig(NOW, cacheFile())).toBeNull()
  })

  it('JSON illegale → null', () => {
    fs.writeFileSync(cacheFile(), '{not json')
    expect(readCachedAutomatorConfig(NOW, cacheFile())).toBeNull()
  })

  it('non-object root → null', () => {
    fs.writeFileSync(cacheFile(), '"stringa"')
    expect(readCachedAutomatorConfig(NOW, cacheFile())).toBeNull()
  })

  it('non-conforming cached config → null', () => {
    fs.writeFileSync(cacheFile(), JSON.stringify({config: {sequence: ['deploy']}, fetched_at: NOW.toISOString()}))
    expect(readCachedAutomatorConfig(NOW, cacheFile())).toBeNull()
  })

  it('within the default TTL → valid', () => {
    writeCachedAutomatorConfig(validConfig, new Date(NOW.getTime() - (DEFAULT_CACHE_MAX_AGE_SECONDS - 60) * 1000), cacheFile())
    expect(readCachedAutomatorConfig(NOW, cacheFile())).toEqual(validConfig)
  })

  it('beyond the default TTL → expired (null, never valid forever)', () => {
    writeCachedAutomatorConfig(validConfig, new Date(NOW.getTime() - (DEFAULT_CACHE_MAX_AGE_SECONDS + 60) * 1000), cacheFile())
    expect(readCachedAutomatorConfig(NOW, cacheFile())).toBeNull()
  })

  it('the config max_age_seconds shortens the expiry', () => {
    const shortLived: AutomatorFlowConfig = {sequence: ['triage'], max_age_seconds: 60}
    writeCachedAutomatorConfig(shortLived, new Date(NOW.getTime() - 120 * 1000), cacheFile())
    expect(readCachedAutomatorConfig(NOW, cacheFile())).toBeNull()
  })

  it('unparsable fetched_at → expired (conservative)', () => {
    fs.writeFileSync(cacheFile(), JSON.stringify({config: validConfig, fetched_at: 'non-una-data'}))
    expect(readCachedAutomatorConfig(NOW, cacheFile())).toBeNull()
  })

  it('fetched_at in the future (negative age) → expired, never valid beyond the window', () => {
    writeCachedAutomatorConfig(validConfig, new Date(NOW.getTime() + 60 * 60 * 1000), cacheFile())
    expect(readCachedAutomatorConfig(NOW, cacheFile())).toBeNull()
  })

  it('removeCachedAutomatorConfig removes the file; on a missing file it is a no-op', () => {
    writeCachedAutomatorConfig(validConfig, NOW, cacheFile())
    removeCachedAutomatorConfig(cacheFile())
    expect(readCachedAutomatorConfig(NOW, cacheFile())).toBeNull()
    expect(() => removeCachedAutomatorConfig(cacheFile())).not.toThrow()
  })

  it('removeCachedAutomatorConfig swallows the errors (best-effort)', () => {
    // rmSync on a directory (without recursive) throws → the error is swallowed, never propagated
    expect(() => removeCachedAutomatorConfig(dir)).not.toThrow()
  })
})

describe('resolveAutomatorConfig · server → cache → default (fail-closed to the fixed flow)', () => {
  let dir: string
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'automator-config-resolve-'))
  })
  afterEach(() => {
    fs.rmSync(dir, {recursive: true, force: true})
  })
  const cacheFile = (): string => path.join(dir, 'automator-config.json')

  it('server answers with a valid config → used and written to cache (Scenario 1)', async () => {
    const fetcher = {fetch: async () => ({outcome: 'success', data: validConfig}) as const}
    const res = await resolveAutomatorConfig(fetcher, NOW, cacheFile())
    expect(res.source).toBe('server')
    expect(res.config).toEqual(validConfig)
    expect(readCachedAutomatorConfig(NOW, cacheFile())).toEqual(validConfig)
  })

  it('unreachable server but cache present → uses the cache (Scenario 2)', async () => {
    writeCachedAutomatorConfig(validConfig, NOW, cacheFile())
    const fetcher = {fetch: async () => ({outcome: 'unavailable'}) as const}
    const res = await resolveAutomatorConfig(fetcher, NOW, cacheFile())
    expect(res.source).toBe('cache')
    expect(res.config).toEqual(validConfig)
  })

  it('neither server nor cache → hardcoded default (fixed flow, NOT a block)', async () => {
    const fetcher = {fetch: async () => ({outcome: 'unavailable'}) as const}
    const res = await resolveAutomatorConfig(fetcher, NOW, cacheFile())
    expect(res.source).toBe('default')
    expect(res.config).toEqual(DEFAULT_AUTOMATOR_CONFIG)
  })

  it('auth-denied ignores a fresh cache → default and INVALIDATES the on-disk cache', async () => {
    writeCachedAutomatorConfig(validConfig, NOW, cacheFile())
    const fetcher = {fetch: async () => ({outcome: 'auth-denied'}) as const}
    const res = await resolveAutomatorConfig(fetcher, NOW, cacheFile())
    expect(res.source).toBe('auth-denied')
    expect(res.config).toEqual(DEFAULT_AUTOMATOR_CONFIG)
    // the revoked config was removed → a later read does not find it again
    expect(readCachedAutomatorConfig(NOW, cacheFile())).toBeNull()
  })

  it('after an auth-denied, a later unavailable does NOT reuse the revoked config → default', async () => {
    writeCachedAutomatorConfig(validConfig, NOW, cacheFile())
    await resolveAutomatorConfig({fetch: async () => ({outcome: 'auth-denied'}) as const}, NOW, cacheFile())
    const res = await resolveAutomatorConfig({fetch: async () => ({outcome: 'unavailable'}) as const}, NOW, cacheFile())
    expect(res.source).toBe('default')
    expect(res.config).toEqual(DEFAULT_AUTOMATOR_CONFIG)
  })

  it('cache write error → still uses the valid server config (best-effort)', async () => {
    const blocker = path.join(dir, 'blocca')
    fs.writeFileSync(blocker, 'x') // a FILE where a directory would be needed → the cache write fails
    const impossible = path.join(blocker, 'nested.json')
    const fetcher = {fetch: async () => ({outcome: 'success', data: validConfig}) as const}
    const res = await resolveAutomatorConfig(fetcher, NOW, impossible)
    expect(res.source).toBe('server')
    expect(res.config).toEqual(validConfig)
  })

  it('server returns an invalid config → discards it and falls back to the cache', async () => {
    writeCachedAutomatorConfig(validConfig, NOW, cacheFile())
    const fetcher = {fetch: async () => ({outcome: 'success', data: {sequence: []}}) as const}
    const res = await resolveAutomatorConfig(fetcher, NOW, cacheFile())
    expect(res.source).toBe('cache')
    expect(res.config).toEqual(validConfig)
  })

  it('server returns an invalid config and no cache → default', async () => {
    const fetcher = {fetch: async () => ({outcome: 'success', data: {sequence: ['deploy']}}) as const}
    const res = await resolveAutomatorConfig(fetcher, NOW, cacheFile())
    expect(res.source).toBe('default')
    expect(res.config).toEqual(DEFAULT_AUTOMATOR_CONFIG)
  })
})

describe('defaultAutomatorConfigFetcher · GET host-scoped', () => {
  it('without configured sync/token → unavailable (not configured)', async () => {
    const fetcher = defaultAutomatorConfigFetcher({})
    expect(await fetcher.fetch()).toEqual({outcome: 'unavailable'})
  })

  it('with only the org token it does not contact the server and does not fall back', async () => {
    const fakeFetch = vi.fn()
    const fetcher = defaultAutomatorConfigFetcher(
      {sync: {orgToken: 'cyi_a_org'}},
      fakeFetch as unknown as typeof globalThis.fetch,
    )
    expect(await fetcher.fetch()).toEqual({outcome: 'unavailable'})
    expect(fakeFetch).not.toHaveBeenCalled()
  })

  it('calls the host-scoped endpoint with the host token bearer and returns data', async () => {
    let calledUrl = ''
    let calledAuth = ''
    const fakeFetch = (async (url: string, init: {headers: Record<string, string>}) => {
      calledUrl = url
      calledAuth = init.headers.Authorization
      return {ok: true, json: async () => ({data: validConfig})}
    }) as unknown as typeof globalThis.fetch
    const fetcher = defaultAutomatorConfigFetcher({sync: {}, host: {id: 'h1', token: 'cyi_ah_tok'}}, fakeFetch)
    const raw = await fetcher.fetch()
    expect(raw).toEqual({outcome: 'success', data: validConfig})
    expect(calledUrl).toContain(DEFAULT_API_AUTOMATOR_CONFIG_PATH)
    expect(calledAuth).toBe('Bearer cyi_ah_tok')
  })

  it('HTTP 5xx → unavailable', async () => {
    const fakeFetch = (async () => ({ok: false, status: 500, json: async () => ({})})) as unknown as typeof globalThis.fetch
    const fetcher = defaultAutomatorConfigFetcher({sync: {}, host: {id: 'h1', token: 'cyi_ah_tok'}}, fakeFetch)
    expect(await fetcher.fetch()).toEqual({outcome: 'unavailable'})
  })

  it('network error → unavailable (best-effort, then cache/default)', async () => {
    const fakeFetch = (async () => {
      throw new Error('rete giù')
    }) as unknown as typeof globalThis.fetch
    const fetcher = defaultAutomatorConfigFetcher({sync: {}, host: {id: 'h1', token: 'cyi_ah_tok'}}, fakeFetch)
    expect(await fetcher.fetch()).toEqual({outcome: 'unavailable'})
  })

  it.each([401, 403])('HTTP %s → auth-denied, without retry or token fallback', async (status) => {
    const fakeFetch = vi.fn(async () => ({ok: false, status}) as Response)
    const fetcher = defaultAutomatorConfigFetcher(
      {sync: {}, host: {id: 'h1', token: 'cyi_ah_tok'}},
      fakeFetch as unknown as typeof globalThis.fetch,
    )
    expect(await fetcher.fetch()).toEqual({outcome: 'auth-denied'})
    expect(fakeFetch).toHaveBeenCalledTimes(1)
    expect((fakeFetch.mock.calls[0][1] as RequestInit).headers).toMatchObject({Authorization: 'Bearer cyi_ah_tok'})
  })

  it('body without data field → success with data null (then discarded downstream)', async () => {
    const fakeFetch = (async () => ({ok: true, json: async () => ({})})) as unknown as typeof globalThis.fetch
    const fetcher = defaultAutomatorConfigFetcher({sync: {}, host: {id: 'h1', token: 'cyi_ah_tok'}}, fakeFetch)
    expect(await fetcher.fetch()).toEqual({outcome: 'success', data: null})
  })
})

describe('consumption helpers (what the flow wiring will use)', () => {
  it('flowSequence → the phase sequence of the config', () => {
    expect(flowSequence(validConfig)).toEqual(['triage', 'planner', 'autopilot'])
  })

  it('concurrencyForPhase → the value configured for the phase', () => {
    expect(concurrencyForPhase(validConfig, 'triage')).toBe(3)
    expect(concurrencyForPhase(validConfig, 'planner')).toBe(2)
  })

  it('concurrencyForPhase → default for a phase without configured concurrency', () => {
    expect(concurrencyForPhase(validConfig, 'autopilot')).toBe(DEFAULT_PHASE_CONCURRENCY)
  })

  it('concurrencyForPhase → default when the config has no concurrency', () => {
    expect(concurrencyForPhase({sequence: ['triage']}, 'triage')).toBe(DEFAULT_PHASE_CONCURRENCY)
  })

  it('concurrencyForPhase on the default → always the default concurrency (serial)', () => {
    for (const phase of EXECUTION_PHASES) {
      expect(concurrencyForPhase(DEFAULT_AUTOMATOR_CONFIG, phase)).toBe(DEFAULT_PHASE_CONCURRENCY)
    }
  })
})
