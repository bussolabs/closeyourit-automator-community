import {isIP} from 'node:net'
import {DEFAULT_API} from './client'
import {loadSecrets} from './config'
import {sandboxAllowedDomains} from './guardrails'
import {lookupIsolated} from './isolated-lookup'
import {workEngineFrom} from './models'

// CYAU-238 — Codex's network proxy refuses a private address reached by NAME, even when the name is in the allowed
// domains: in the lab a self-hosted CloseYourIt on a private network answered only when written as its IPv4 address.
// Doctor resolves the configured server name and, with Codex at work, says the exact correction. Never blocking:
// the same name may work for Claude.

/** Upper bound of the name lookup: an unanswered resolver must not hang doctor (R-2). */
export const LOOKUP_TIMEOUT_MS = 3000

export interface ResolvedAddress {
  address: string
  family: number
}

/** Resolves `hostname`; the system one stops at `timeoutMs` and leaves no request running behind it. */
export type LookupFn = (hostname: string, timeoutMs: number) => Promise<ResolvedAddress[]>

export type PrivateServerAdvice =
  | {kind: 'none'}
  | {kind: 'ipv4'; hostname: string; address: string; apiUrl: string; sandboxDomains: string}
  | {kind: 'ipv6-only'; hostname: string; addresses: string[]}
  | {kind: 'unverified'; hostname: string; detail: string}

export interface PrivateServerInput {
  apiUrl: string | undefined
  engine: 'claude' | 'codex'
  env?: NodeJS.ProcessEnv
  lookup?: LookupFn
  timeoutMs?: number
}

const systemLookup: LookupFn = (hostname, timeoutMs) => lookupIsolated(hostname, timeoutMs)

/** `localhost` and its subdomains: Codex lets them through by name, so they never need the warning. */
export function isLocalhostName(hostname: string): boolean {
  const lower = hostname.toLowerCase().replace(/\.$/, '')
  return lower === 'localhost' || lower.endsWith('.localhost')
}

/** RFC 1918, loopback, link-local and shared (CGNAT, e.g. Tailscale) IPv4 ranges. */
export function isPrivateIPv4(address: string): boolean {
  if (isIP(address) !== 4) return false
  const [a, b] = address.split('.').map(Number)
  return a === 10 || a === 127 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168)
    || (a === 169 && b === 254) || (a === 100 && b >= 64 && b <= 127)
}

/** Loopback, unique-local (fc00::/7) and link-local (fe80::/10) IPv6 addresses. */
export function isPrivateIPv6(address: string): boolean {
  if (isIP(address) !== 6) return false
  const lower = address.toLowerCase()
  return lower === '::1' || /^f[cd]/.test(lower) || /^fe[89ab]/.test(lower)
}

function passesAllowlist(domains: string): boolean {
  try {
    sandboxAllowedDomains({AUTOMATOR_SANDBOX_DOMAINS: domains})
    return true
  } catch {
    return false
  }
}

// The system lookup already stops at the deadline; the race also bounds an injected one.
async function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  let timer: NodeJS.Timeout | undefined
  const timeout = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => reject(new Error(`no answer within ${ms / 1000}s`)), ms)
  })
  try {
    return await Promise.race([promise, timeout])
  } finally {
    clearTimeout(timer)
  }
}

/**
 * What doctor must say about the configured server. Nothing for Claude, for the public default, for `localhost`, for a server
 * already written as an address. The suggested allowlist value always passes `sandboxAllowedDomains`, so the warning never
 * proposes an entry the guardrails would refuse; an IPv6 address never does (the colons), so it is never proposed.
 */
export async function privateServerAdvice(input: PrivateServerInput): Promise<PrivateServerAdvice> {
  if (input.engine !== 'codex' || !input.apiUrl) return {kind: 'none'}
  let url: URL
  try {
    url = new URL(input.apiUrl)
  } catch {
    return {kind: 'none'}
  }
  if (url.origin === new URL(DEFAULT_API).origin) return {kind: 'none'}
  const hostname = url.hostname
  if (isIP(hostname.replace(/^\[|\]$/g, '')) !== 0 || isLocalhostName(hostname)) return {kind: 'none'}

  const timeoutMs = input.timeoutMs ?? LOOKUP_TIMEOUT_MS
  let addresses: ResolvedAddress[]
  try {
    addresses = await withTimeout((input.lookup ?? systemLookup)(hostname, timeoutMs), timeoutMs)
  } catch (error) {
    return {kind: 'unverified', hostname, detail: error instanceof Error ? error.message : String(error)}
  }

  const privateV4 = addresses.find((entry) => entry.family === 4 && isPrivateIPv4(entry.address))
  if (privateV4) {
    const env = input.env ?? process.env
    const current = (env.AUTOMATOR_SANDBOX_DOMAINS ?? '').split(',').map((domain) => domain.trim()).filter((domain) => domain !== '')
    const merged = [...current.filter((domain) => domain !== privateV4.address), privateV4.address].join(',')
    // A correction must pass the rule the guardrails apply: when an entry already on the machine does not, only the
    // address is proposed (an IPv4 address always passes it).
    const sandboxDomains = passesAllowlist(merged) ? merged : privateV4.address
    const fixed = new URL(url)
    fixed.hostname = privateV4.address
    return {kind: 'ipv4', hostname, address: privateV4.address, apiUrl: fixed.toString().replace(/\/$/, ''), sandboxDomains}
  }
  const privateV6 = addresses.filter((entry) => entry.family === 6 && isPrivateIPv6(entry.address))
  if (privateV6.length > 0 && privateV6.length === addresses.length) {
    return {kind: 'ipv6-only', hostname, addresses: privateV6.map((entry) => entry.address)}
  }
  return {kind: 'none'}
}

/** The doctor line for an advice, or undefined when there is nothing to say. */
export function privateServerMessage(advice: PrivateServerAdvice): string | undefined {
  switch (advice.kind) {
    case 'ipv4': {
      return `⚠ Codex cannot reach the CloseYourIt server by name: ${advice.hostname} points to the private address `
        + `${advice.address}, which Codex's network proxy refuses when reached by name. Write the server as its address: `
        + `in ~/.config/closeyourit-automator/secrets.json set sync.apiUrl (and heartbeat.apiUrl, if present) to ${advice.apiUrl}, `
        + `then reinstall the service with AUTOMATOR_SANDBOX_DOMAINS=${advice.sandboxDomains} automator install --managed `
        + `(with the same options as the first install). `
        + `Give the server a fixed address, `
        + `and with HTTPS make its certificate valid for ${advice.address} too.`
    }
    case 'ipv6-only': {
      return `⚠ Codex cannot reach the CloseYourIt server: ${advice.hostname} points only to private IPv6 addresses `
        + `(${advice.addresses.join(', ')}), which the allowed domains cannot hold. Give the server a private IPv4 address `
        + `and write it in sync.apiUrl and in AUTOMATOR_SANDBOX_DOMAINS, or let Claude do the work on this machine `
        + `(AUTOMATOR_WORK_ENGINE=claude).`
    }
    case 'unverified': {
      return `⚠ Could not check whether Codex can reach the CloseYourIt server: looking up ${advice.hostname} failed `
        + `(${advice.detail}). If it is on a private network, write it as its IPv4 address.`
    }
    default: {
      return undefined
    }
  }
}

/** The advice for this machine: the configured server and the engine at work. A configuration that cannot be read says nothing. */
export async function checkPrivateServer(env: NodeJS.ProcessEnv = process.env): Promise<PrivateServerAdvice> {
  let apiUrl: string | undefined
  try {
    apiUrl = loadSecrets().sync?.apiUrl
  } catch {
    return {kind: 'none'}
  }
  return privateServerAdvice({apiUrl, engine: workEngineFrom(env.AUTOMATOR_WORK_ENGINE), env})
}
