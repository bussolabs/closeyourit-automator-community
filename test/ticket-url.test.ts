import {describe, expect, it} from 'vitest'
import {serviceTicketUrl, TICKET_URL_MAX_LENGTH} from '../src/lib/ticket-url'

// CYAU-279 — the ticket link is taken from the service, never built: it is published only when it is plainly a
// CloseYourIt page, and anything else counts as missing.
describe('serviceTicketUrl', () => {
  it('accepts an https page of the service, apex or subdomain, as it was returned', () => {
    for (const url of [
      'https://app.closeyour.it/projects/CYRA/tickets/CYRA-981',
      'https://closeyour.it/projects/CYRA/tickets/CYRA-981',
      'https://staging.closeyour.it/projects/CYRA/tickets/CYRA-981?tab=scenarios',
    ]) expect(serviceTicketUrl(url)).toBe(url)
    expect(serviceTicketUrl('  https://app.closeyour.it/t/CYRA-981  ')).toBe('https://app.closeyour.it/t/CYRA-981')
  })

  it('accepts exactly 500 characters and rejects 501', () => {
    const prefix = 'https://app.closeyour.it/t/'
    const atLimit = `${prefix}${'a'.repeat(TICKET_URL_MAX_LENGTH - prefix.length)}`
    expect(atLimit).toHaveLength(500)
    expect(serviceTicketUrl(atLimit)).toBe(atLimit)
    expect(serviceTicketUrl(`${atLimit}a`)).toBeNull()
  })

  it('treats anything that is not a safe service address as missing', () => {
    for (const value of [
      undefined, null, 42, {}, '', '   ', 'not a url',
      'http://app.closeyour.it/t/CYRA-981',
      'https://evil.example/t/CYRA-981',
      'https://closeyour.it.evil.example/t/CYRA-981',
      'https://evilcloseyour.it/t/CYRA-981',
      'https://user:pass@app.closeyour.it/t/CYRA-981',
      'https://app.closeyour.it:8443/t/CYRA-981',
      'https://app.closeyour.it/t/CYRA 981',
      'https://app.closeyour.it/t/CYRA-981)[x](https://evil.example)',
      'https://app.closeyour.it/t/<script>',
      'https://APP.closeyour.it/t/CYRA-981',
      'https://app.closeyour.it/t/../CYRA-981',
      'javascript:alert(1)',
    ]) expect(serviceTicketUrl(value)).toBeNull()
  })

  it('rejects a link the secret redaction would alter', () => {
    expect(serviceTicketUrl(`https://app.closeyour.it/t/CYRA-981?token=ghp_${'a'.repeat(36)}`)).toBeNull()
  })
})
