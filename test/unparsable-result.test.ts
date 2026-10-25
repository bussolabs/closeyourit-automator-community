import {describe, expect, it} from 'vitest'
import {
  UNPARSABLE_REASON_CHARS,
  UNPARSABLE_TECHNICAL_DETAIL_CHARS,
  syntheticBlockedResult,
  unparsableReason,
} from '../src/lib/unparsable-result'

// CYAU-192 — the per-phase shape is tested against the vendored schemas in `contract-agent-result*.test.ts`,
// and the runner path in `runner-workflow-delivery.test.ts`. What remains here are the boundaries of the text sent
// to the server: the reason is a line on the card, the excerpt is redacted and capped.
describe('unparsableReason', () => {
  it('prefisso fisso e rilievi separati da «; »', () => {
    expect(unparsableReason(['code: Required', 'state: Required'])).toBe('Risultato non interpretabile: code: Required; state: Required')
  })

  it('redacts and cleans the issues BEFORE the cut: a token quoted by the issue does not pass even halfway', () => {
    const token = `cyi_ah_${'C'.repeat(24)}`
    // The cut falls in the middle of the token: on raw text it would let a piece of it through.
    const padding = 'x'.repeat(UNPARSABLE_REASON_CHARS - 12)
    const reason = unparsableReason([`${padding}: received '\u001b[31m${token}'`])
    expect(reason).not.toContain(token)
    expect(reason).not.toContain(token.slice(0, 12))
    expect(reason).not.toContain('\u001b')
  })

  it('truncates the issues beyond the cap, without cutting the prefix', () => {
    const reason = unparsableReason(['x'.repeat(UNPARSABLE_REASON_CHARS + 50)])
    expect(reason.startsWith('Risultato non interpretabile: ')).toBe(true)
    expect(reason.endsWith('…')).toBe(true)
    expect(reason.length).toBe('Risultato non interpretabile: '.length + UNPARSABLE_REASON_CHARS + 1)
  })
})

describe('syntheticBlockedResult — technical_detail', () => {
  it('is redacted BEFORE the cut and cleaned of control sequences', () => {
    const token = `cyi_ah_${'B'.repeat(24)}`
    const stdout = `[31mrosso[0m ${token}\n${'y'.repeat(UNPARSABLE_TECHNICAL_DETAIL_CHARS * 2)}`
    const result = syntheticBlockedResult({phase: 'autopilot', code: 'CYAU-192', issues: ['code: Required'], stdout})
    const detail = (result.failure as {technical_detail: string}).technical_detail
    expect(detail).not.toContain(token)
    expect(detail).not.toContain('')
    expect(detail).toContain('rosso')
    expect(detail).toContain('caratteri omessi')
    expect(detail.length).toBeLessThan(UNPARSABLE_TECHNICAL_DETAIL_CHARS + 100)
  })
})
