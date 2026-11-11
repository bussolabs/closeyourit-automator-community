import {redactSecrets} from './secret-redaction'

// CYAU-279 — the address of the ticket page, as RETURNED by the service. It is never built here: composing it
// from the API address would duplicate a rule that belongs to the service. What the service returns is still
// untrusted input that ends up in a public PR, so it is accepted only when it is plainly a CloseYourIt page.

/** The longest ticket link accepted: anything longer is treated as missing, never cut. */
export const TICKET_URL_MAX_LENGTH = 500

/** The CloseYourIt service domain: apex and subdomains (app/www/staging), like the sandbox allowlist. */
const SERVICE_DOMAIN = 'closeyour.it'

/** Characters that could escape the markdown of the PR body or hide part of the address. */
const UNSAFE_URL_CHARACTERS = /[\s<>()[\]{}"'`\\|^]/u

function isServiceHost(hostname: string): boolean {
  const host = hostname.toLowerCase()
  return host === SERVICE_DOMAIN || host.endsWith(`.${SERVICE_DOMAIN}`)
}

/**
 * The ticket link when it is a safe address of the service, otherwise `null`: https only, a CloseYourIt host,
 * no credentials or custom port, at most 500 characters, already in canonical form and with nothing the secret
 * redaction would hide. `null` means "missing" — the caller says so and never builds one. Pure.
 */
export function serviceTicketUrl(value: unknown): string | null {
  if (typeof value !== 'string') return null
  const candidate = value.trim()
  if (candidate === '' || candidate.length > TICKET_URL_MAX_LENGTH || UNSAFE_URL_CHARACTERS.test(candidate)) return null
  let parsed: URL
  try {
    parsed = new URL(candidate)
  } catch {
    return null
  }

  if (parsed.protocol !== 'https:' || parsed.username !== '' || parsed.password !== '' || parsed.port !== '') return null
  if (!isServiceHost(parsed.hostname)) return null
  // Canonical form only: what is published is exactly what was checked, with no normalization in between.
  if (parsed.href !== candidate) return null
  if (redactSecrets(candidate) !== candidate) return null
  return candidate
}
