import {describe, expect, it, vi} from 'vitest'
import {DEFAULT_API} from '../src/lib/client'
import {sandboxAllowedDomains} from '../src/lib/guardrails'
import {
  isLocalhostName,
  isPrivateIPv4,
  isPrivateIPv6,
  privateServerAdvice,
  privateServerMessage,
  type LookupFn,
  type ResolvedAddress,
} from '../src/lib/private-server'

const resolvesTo = (...addresses: ResolvedAddress[]): LookupFn => vi.fn(async () => addresses)
const v4 = (address: string): ResolvedAddress => ({address, family: 4})
const v6 = (address: string): ResolvedAddress => ({address, family: 6})

// CYAU-238 — Codex reaches a private server only by its IPv4 address: doctor says the exact correction.
describe('privateServerAdvice', () => {
  it('with Codex and a private name, proposes the IPv4 address for the server and the allowlist', async () => {
    const advice = await privateServerAdvice({
      apiUrl: 'https://cyi.lan:8443/base', engine: 'codex', env: {}, lookup: resolvesTo(v4('192.168.1.20')),
    })

    expect(advice).toEqual({
      kind: 'ipv4', hostname: 'cyi.lan', address: '192.168.1.20', apiUrl: 'https://192.168.1.20:8443/base', sandboxDomains: '192.168.1.20',
    })
    const message = privateServerMessage(advice)!
    expect(message).toContain('sync.apiUrl')
    expect(message).toContain('https://192.168.1.20:8443/base')
    expect(message).toContain('AUTOMATOR_SANDBOX_DOMAINS=192.168.1.20 automator install --managed')
    expect(message).not.toMatch(/'automator/)
    expect(message).toContain('certificate')
  })

  it('says nothing for localhost, which Codex lets through by name, without looking it up', async () => {
    const lookup = resolvesTo(v4('127.0.0.1'), v6('::1'))
    for (const apiUrl of ['http://localhost:3000', 'http://LOCALHOST', 'http://cyi.localhost:3000', 'http://localhost.']) {
      expect(await privateServerAdvice({apiUrl, engine: 'codex', lookup}), apiUrl).toEqual({kind: 'none'})
    }
    expect(lookup).not.toHaveBeenCalled()
    expect(isLocalhostName('localhost-server.lan')).toBe(false)
  })

  it('passes the deadline to the lookup', async () => {
    const lookup = resolvesTo(v4('8.8.8.8'))
    await privateServerAdvice({apiUrl: 'https://cyi.lan', engine: 'codex', lookup, timeoutMs: 1234})
    expect(lookup).toHaveBeenCalledWith('cyi.lan', 1234)
  })

  it('keeps the domains already allowed on the machine in the suggested value, and it passes the allowlist rule', async () => {
    const advice = await privateServerAdvice({
      apiUrl: 'http://cyi.lan', engine: 'codex', env: {AUTOMATOR_SANDBOX_DOMAINS: 'tracker.example.com'}, lookup: resolvesTo(v4('10.0.0.5')),
    })

    expect(advice.kind).toBe('ipv4')
    if (advice.kind !== 'ipv4') return
    expect(advice.apiUrl).toBe('http://10.0.0.5')
    expect(advice.sandboxDomains).toBe('tracker.example.com,10.0.0.5')
    expect(sandboxAllowedDomains({AUTOMATOR_SANDBOX_DOMAINS: advice.sandboxDomains})).toContain('10.0.0.5')
  })

  it('proposes only the address when a domain already on the machine would not pass the allowlist rule', async () => {
    const advice = await privateServerAdvice({
      apiUrl: 'http://cyi.lan', engine: 'codex', env: {AUTOMATOR_SANDBOX_DOMAINS: 'bad domain'}, lookup: resolvesTo(v4('10.0.0.5')),
    })

    expect(advice).toMatchObject({kind: 'ipv4', sandboxDomains: '10.0.0.5'})
  })

  it('with an IPv4 and an IPv6 address proposes only the IPv4 one', async () => {
    const advice = await privateServerAdvice({
      apiUrl: 'https://cyi.lan', engine: 'codex', env: {}, lookup: resolvesTo(v6('fd12::5'), v4('172.20.0.7')),
    })

    expect(advice).toMatchObject({kind: 'ipv4', address: '172.20.0.7', sandboxDomains: '172.20.0.7'})
    expect(privateServerMessage(advice)).not.toContain('fd12::5')
  })

  it('with only private IPv6 addresses never proposes them: an IPv4 address for the server, or Claude', async () => {
    const advice = await privateServerAdvice({
      apiUrl: 'https://cyi.lan', engine: 'codex', env: {}, lookup: resolvesTo(v6('fd12::5'), v6('fe80::1')),
    })

    expect(advice).toEqual({kind: 'ipv6-only', hostname: 'cyi.lan', addresses: ['fd12::5', 'fe80::1']})
    const message = privateServerMessage(advice)!
    expect(message).toContain('Codex cannot reach')
    expect(message).toContain('private IPv4 address')
    expect(message).toContain('AUTOMATOR_WORK_ENGINE=claude')
    expect(message).not.toContain('AUTOMATOR_SANDBOX_DOMAINS=fd12')
    // The allowlist refuses the IPv6 form: that is why it is never suggested.
    expect(() => sandboxAllowedDomains({AUTOMATOR_SANDBOX_DOMAINS: 'fd12::5'})).toThrow(/AUTOMATOR_SANDBOX_DOMAINS/)
  })

  it('says nothing when the server is already written as its address, without looking anything up', async () => {
    const lookup = resolvesTo(v4('10.0.0.5'))
    expect(await privateServerAdvice({apiUrl: 'http://10.0.0.5:3000', engine: 'codex', lookup})).toEqual({kind: 'none'})
    expect(await privateServerAdvice({apiUrl: 'http://[fd12::5]:3000', engine: 'codex', lookup})).toEqual({kind: 'none'})
    expect(lookup).not.toHaveBeenCalled()
  })

  it('says nothing when Claude does the work', async () => {
    const lookup = resolvesTo(v4('192.168.1.20'))
    expect(await privateServerAdvice({apiUrl: 'https://cyi.lan', engine: 'claude', lookup})).toEqual({kind: 'none'})
    expect(lookup).not.toHaveBeenCalled()
  })

  it('says nothing for the default public server, configured or not', async () => {
    const lookup = resolvesTo(v4('10.0.0.5'))
    expect(await privateServerAdvice({apiUrl: undefined, engine: 'codex', lookup})).toEqual({kind: 'none'})
    expect(await privateServerAdvice({apiUrl: DEFAULT_API, engine: 'codex', lookup})).toEqual({kind: 'none'})
    expect(lookup).not.toHaveBeenCalled()
  })

  it('says nothing when the name points to a public address', async () => {
    expect(await privateServerAdvice({apiUrl: 'https://tracker.example.com', engine: 'codex', lookup: resolvesTo(v4('93.184.216.34'))}))
      .toEqual({kind: 'none'})
  })

  it('says nothing for a malformed server address', async () => {
    expect(await privateServerAdvice({apiUrl: 'not a url', engine: 'codex', lookup: resolvesTo(v4('10.0.0.5'))})).toEqual({kind: 'none'})
  })

  it('a lookup that never answers ends within the timeout and says the name could not be checked', async () => {
    const started = Date.now()
    const advice = await privateServerAdvice({
      apiUrl: 'https://cyi.lan', engine: 'codex', lookup: () => new Promise<ResolvedAddress[]>(() => {}), timeoutMs: 50,
    })

    expect(Date.now() - started).toBeLessThan(2000)
    expect(advice).toMatchObject({kind: 'unverified', hostname: 'cyi.lan'})
    expect(privateServerMessage(advice)).toContain('Could not check')
  })

  it('a lookup that fails says the name could not be checked', async () => {
    const advice = await privateServerAdvice({
      apiUrl: 'https://cyi.lan', engine: 'codex', lookup: async () => { throw new Error('getaddrinfo ENOTFOUND cyi.lan') },
    })

    expect(advice).toEqual({kind: 'unverified', hostname: 'cyi.lan', detail: 'getaddrinfo ENOTFOUND cyi.lan'})
  })

  it('has no message when there is nothing to say', () => {
    expect(privateServerMessage({kind: 'none'})).toBeUndefined()
  })
})

describe('private address ranges', () => {
  it('recognizes the private IPv4 ranges', () => {
    for (const address of ['10.1.2.3', '172.16.0.1', '172.31.255.255', '192.168.0.1', '127.0.0.1', '169.254.1.1', '100.64.0.1']) {
      expect(isPrivateIPv4(address), address).toBe(true)
    }
    for (const address of ['8.8.8.8', '172.32.0.1', '172.15.0.1', '100.128.0.1', 'fd00::1', 'cyi.lan']) {
      expect(isPrivateIPv4(address), address).toBe(false)
    }
  })

  it('recognizes the private IPv6 ranges', () => {
    for (const address of ['::1', 'fd12::5', 'fc00::1', 'fe80::1', 'FEBF::1']) {
      expect(isPrivateIPv6(address), address).toBe(true)
    }
    for (const address of ['2001:db8::1', 'fec0::1', '10.0.0.1']) {
      expect(isPrivateIPv6(address), address).toBe(false)
    }
  })
})
