import {describe, expect, it} from 'vitest'
import {renderRecord, renderTable, sanitize, sanitizeMultiline} from '../src/lib/output'

describe('sanitize', () => {
  it('defusa i control char ANSI in spazi', () => {
    expect(sanitize('a[31mrosso')).toBe('a [31mrosso')
  })

  it('handles null/undefined as an empty string', () => {
    expect(sanitize(null)).toBe('')
    expect(sanitize(undefined)).toBe('')
  })

  it('oscura token real-looking ma preserva i placeholder documentali', () => {
    const token = 'cyi_ah_X'
    expect(sanitize(`token=${token}`)).toBe('token=[REDACTED]')
    expect(sanitize(`archive_${token}`)).toBe('archive_[REDACTED]')
    expect(sanitize(`backup_cyi_h_${'Y'.repeat(24)}`)).toBe('backup_[REDACTED]')
    expect(sanitize('formato cyi_ah_…')).toBe('formato cyi_ah_…')
    expect(sanitize('formato_archive_cyi_ah_…')).toBe('formato_archive_cyi_ah_…')
  })
})

describe('sanitizeMultiline', () => {
  it('preserves the newlines, defuses the rest', () => {
    const out = sanitizeMultiline('riga1\nriga2')
    expect(out).toContain('\n')
    expect(out).not.toContain('')
  })
})

describe('renderTable', () => {
  it('rende header + righe allineate', () => {
    const out = renderTable(['A', 'B'], [['1', '22'], ['333', '4']])
    expect(out).toContain('A')
    expect(out.split('\n')).toHaveLength(4) // header + separatore + 2 righe
  })

  it('without rows → the empty-result placeholder', () => {
    expect(renderTable(['A'], [])).toContain('(nessun risultato)')
  })
})

describe('renderRecord', () => {
  it('prints the scalar fields as key: value', () => {
    const out = renderRecord({name: 'x', n: 3, ok: true, nested: {a: 1}})
    expect(out).toContain('name: x')
    expect(out).toContain('n: 3')
    expect(out).not.toContain('nested')
  })

  it('valore null → trattino', () => {
    expect(renderRecord({a: null})).toContain('a: -')
  })

  it('without scalars → JSON fallback', () => {
    expect(renderRecord({nested: {a: 1}})).toContain('{')
  })

  it('the JSON fallback does not expose nested tokens', () => {
    const token = `cyi_agent_host_${'Y'.repeat(24)}`
    const out = renderRecord({nested: {token}})
    expect(out).toContain('[REDACTED]')
    expect(out).not.toContain(token)
  })
})
