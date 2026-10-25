import {describe, expect, it} from 'vitest'
import {
  AGENT_ROLES,
  assertBudget,
  buildDiscoveryRole,
  DEFAULT_DISCOVERY_BUDGET,
  DISCOVERY_SOURCES,
  DiscoveryRoleSchema,
  type DiscoverySignal,
  evaluateDiscovery,
  IMPACT_LEVELS,
  isAgentRole,
  isDiscoverySource,
  isImpactLevel,
  isReadOnlyMode,
  parseSignal,
  READ_ONLY_MODE,
  readOnlyModeFor,
  roleCanModifyFiles,
  roleCanOpenPr,
} from '../src/lib/discovery'
import {AutomatorError} from '../src/errors/error-codes'

// The discovery (CYAU-29) defines a read-only ROLE that looks for real problems WITHOUT modifying the code:
// read-only permission mode per runtime, allowed sources, signal schema (source/evidence/impact/
// confidence) and budget, separate from the ticket worker. The module is PURE and DETERMINISTIC: same input → same
// outcome. The tests cover the DoD (signals with source/impact/confidence; agent that neither writes nor opens PRs) and
// Scenario 1 (errors/CI/uptime/performance/critical flows sources; signals with evidence without writing).

/** A convenient valid signal for the tests, overridable field by field. */
function signal(over: Partial<DiscoverySignal> = {}): DiscoverySignal {
  return {
    source: 'errors',
    title: 'Errore 500 ricorrente al checkout',
    evidence: '42 occorrenze in 24h nel gruppo di errori CHECKOUT_TIMEOUT',
    impact: 'high',
    confidence: 0.8,
    detail: null,
    ...over,
  }
}

describe('agent role: discovery separate from the ticket worker (DoD: separate discovery from ticket worker)', () => {
  it('exposes the two canonical roles', () => {
    expect(AGENT_ROLES).toEqual(['discovery', 'worker'])
  })

  it('isAgentRole recognizes the valid ones and rejects unknown / non-string', () => {
    for (const r of AGENT_ROLES) expect(isAgentRole(r)).toBe(true)
    expect(isAgentRole('reviewer')).toBe(false)
    expect(isAgentRole('')).toBe(false)
    expect(isAgentRole(3)).toBe(false)
    expect(isAgentRole(null)).toBe(false)
  })

  it('the discovery role can NOT modify files nor open PRs (read-only)', () => {
    expect(roleCanModifyFiles('discovery')).toBe(false)
    expect(roleCanOpenPr('discovery')).toBe(false)
  })

  it('the ticket worker can modify files and open PRs (the separation is first-class)', () => {
    expect(roleCanModifyFiles('worker')).toBe(true)
    expect(roleCanOpenPr('worker')).toBe(true)
  })
})

describe('read-only permission mode per runtime (Technical analysis: read-only permission mode)', () => {
  it('claude usa plan e codex usa read-only', () => {
    expect(READ_ONLY_MODE.claude).toBe('plan')
    expect(READ_ONLY_MODE.codex).toBe('read-only')
    expect(readOnlyModeFor('claude')).toBe('plan')
    expect(readOnlyModeFor('codex')).toBe('read-only')
  })

  it('isReadOnlyMode accepts ONLY the read-only mode of the runtime', () => {
    expect(isReadOnlyMode('claude', 'plan')).toBe(true)
    expect(isReadOnlyMode('codex', 'read-only')).toBe(true)
  })

  it('isReadOnlyMode rejects every write/interaction mode (never a discovery that writes)', () => {
    for (const mode of ['acceptEdits', 'auto', 'bypassPermissions', 'manual', 'dontAsk', 'workspace-write']) {
      expect(isReadOnlyMode('claude', mode)).toBe(false)
      expect(isReadOnlyMode('codex', mode)).toBe(false)
    }
    // The mode of one runtime does not apply to the other.
    expect(isReadOnlyMode('claude', 'read-only')).toBe(false)
    expect(isReadOnlyMode('codex', 'plan')).toBe(false)
  })
})

describe('allowed sources (Scenario 1: errors, CI, uptime, performance, critical flows)', () => {
  it('exposes the five sources of the scenario', () => {
    expect(DISCOVERY_SOURCES).toEqual(['errors', 'ci', 'uptime', 'performance', 'critical-flows'])
  })

  it('isDiscoverySource recognizes the valid ones and rejects unknown / non-string', () => {
    for (const s of DISCOVERY_SOURCES) expect(isDiscoverySource(s)).toBe(true)
    expect(isDiscoverySource('logs')).toBe(false)
    expect(isDiscoverySource('')).toBe(false)
    expect(isDiscoverySource(1)).toBe(false)
  })
})

describe('impact level', () => {
  it('exposes the four levels from the lowest to the highest', () => {
    expect(IMPACT_LEVELS).toEqual(['low', 'medium', 'high', 'critical'])
  })

  it('isImpactLevel recognizes the valid ones and rejects unknown', () => {
    for (const i of IMPACT_LEVELS) expect(isImpactLevel(i)).toBe(true)
    expect(isImpactLevel('blocker')).toBe(false)
    expect(isImpactLevel(null)).toBe(false)
  })
})

describe('budget (Technical analysis: budget)', () => {
  it('the default budget limits the signals and has a confidence threshold', () => {
    expect(DEFAULT_DISCOVERY_BUDGET.maxSignals).toBeGreaterThan(0)
    expect(DEFAULT_DISCOVERY_BUDGET.minConfidence).toBeGreaterThanOrEqual(0)
    expect(DEFAULT_DISCOVERY_BUDGET.minConfidence).toBeLessThanOrEqual(1)
  })

  it('assertBudget accepts a valid budget', () => {
    expect(() => assertBudget({maxSignals: 5, minConfidence: 0.5})).not.toThrow()
  })

  it('assertBudget rejects maxSignals not a positive integer (exit 2)', () => {
    for (const bad of [0, -1, 1.5, Number.NaN]) {
      const err = grab(() => assertBudget({maxSignals: bad, minConfidence: 0.5}))
      expect(err.code).toBe('C400-DISCOVERY-001')
      expect(err.exitCode).toBe(2)
    }
  })

  it('assertBudget rejects minConfidence outside [0,1] or NaN (exit 2)', () => {
    for (const bad of [-0.1, 1.1, Number.NaN]) {
      const err = grab(() => assertBudget({maxSignals: 5, minConfidence: bad}))
      expect(err.code).toBe('C400-DISCOVERY-001')
    }
  })
})

describe('buildDiscoveryRole: structural read-only role (DoD: does not modify files, does not open PRs)', () => {
  it('claude → plan permission mode, read-only, without writes nor PRs', () => {
    const role = buildDiscoveryRole('claude')
    expect(role.role).toBe('discovery')
    expect(role.runtime).toBe('claude')
    expect(role.permissionMode).toBe('plan')
    expect(role.readOnly).toBe(true)
    expect(role.canModifyFiles).toBe(false)
    expect(role.canOpenPr).toBe(false)
  })

  it('codex → read-only sandbox, read-only, without writes nor PRs', () => {
    const role = buildDiscoveryRole('codex')
    expect(role.permissionMode).toBe('read-only')
    expect(role.canModifyFiles).toBe(false)
    expect(role.canOpenPr).toBe(false)
  })

  it('the built mode is ALWAYS read-only for that runtime (structural property)', () => {
    for (const runtime of ['claude', 'codex'] as const) {
      const role = buildDiscoveryRole(runtime)
      expect(isReadOnlyMode(runtime, role.permissionMode)).toBe(true)
    }
  })

  it('by default enables all the allowed sources and the default budget', () => {
    const role = buildDiscoveryRole('claude')
    expect(role.allowedSources).toEqual([...DISCOVERY_SOURCES])
    expect(role.budget).toEqual(DEFAULT_DISCOVERY_BUDGET)
  })

  it('a subset of sources and a custom budget are respected and deduplicated/sorted', () => {
    const role = buildDiscoveryRole('claude', {
      sources: ['performance', 'errors', 'errors'],
      budget: {maxSignals: 3, minConfidence: 0.7},
    })
    expect(role.allowedSources).toEqual(['errors', 'performance']) // canonical order, without duplicates
    expect(role.budget).toEqual({maxSignals: 3, minConfidence: 0.7})
  })

  it('carries non-empty reasons mentioning read-only and the separation from the worker', () => {
    const role = buildDiscoveryRole('claude')
    expect(role.reasons.length).toBeGreaterThan(0)
    const joined = role.reasons.join(' ').toLowerCase()
    expect(joined).toContain('read-only')
  })

  it('unrecognized runtime → exit 2 (input defence)', () => {
    const err = grab(() => buildDiscoveryRole('gpt' as never))
    expect(err.code).toBe('C400-DISCOVERY-001')
    expect(err.exitCode).toBe(2)
  })

  it('unrecognized source in the opts → exit 2', () => {
    const err = grab(() => buildDiscoveryRole('claude', {sources: ['logs' as never]}))
    expect(err.code).toBe('C400-DISCOVERY-001')
  })

  it('invalid budget in the opts → exit 2', () => {
    const err = grab(() => buildDiscoveryRole('claude', {budget: {maxSignals: 0, minConfidence: 0.5}}))
    expect(err.code).toBe('C400-DISCOVERY-001')
  })
})

describe('DiscoveryRoleSchema: structural read-only at schema level (not only in buildDiscoveryRole)', () => {
  const base = {
    role: 'discovery',
    readOnly: true,
    canModifyFiles: false,
    canOpenPr: false,
    allowedSources: ['errors'],
    budget: DEFAULT_DISCOVERY_BUDGET,
    reasons: [],
  }

  it('accepts the correct read-only mode of each runtime', () => {
    expect(DiscoveryRoleSchema.safeParse({...base, runtime: 'claude', permissionMode: 'plan'}).success).toBe(true)
    expect(DiscoveryRoleSchema.safeParse({...base, runtime: 'codex', permissionMode: 'read-only'}).success).toBe(true)
  })

  it('rejects every writable permission mode (schema guarantee, not only of the construction)', () => {
    for (const mode of ['acceptEdits', 'auto', 'bypassPermissions', 'manual', 'dontAsk', 'workspace-write']) {
      expect(DiscoveryRoleSchema.safeParse({...base, runtime: 'claude', permissionMode: mode}).success).toBe(false)
      expect(DiscoveryRoleSchema.safeParse({...base, runtime: 'codex', permissionMode: mode}).success).toBe(false)
    }
  })

  it('rejects the read-only mode of the OTHER runtime (claude≠read-only, codex≠plan)', () => {
    expect(DiscoveryRoleSchema.safeParse({...base, runtime: 'claude', permissionMode: 'read-only'}).success).toBe(false)
    expect(DiscoveryRoleSchema.safeParse({...base, runtime: 'codex', permissionMode: 'plan'}).success).toBe(false)
  })

  it('rejects canModifyFiles/canOpenPr set to true (the false literals are structural)', () => {
    expect(DiscoveryRoleSchema.safeParse({...base, runtime: 'claude', permissionMode: 'plan', canModifyFiles: true}).success).toBe(false)
    expect(DiscoveryRoleSchema.safeParse({...base, runtime: 'claude', permissionMode: 'plan', canOpenPr: true}).success).toBe(false)
  })
})

describe('parseSignal: source/evidence/impact/confidence schema (DoD: every signal contains source, impact and confidence)', () => {
  it('validates a complete signal and normalizes missing detail to null', () => {
    const s = parseSignal({
      source: 'performance',
      title: 'Query N+1 sulla dashboard',
      evidence: '1.8s medi, 120 query per render',
      impact: 'medium',
      confidence: 0.75,
    })
    expect(s.source).toBe('performance')
    expect(s.evidence).toContain('1.8s')
    expect(s.impact).toBe('medium')
    expect(s.confidence).toBe(0.75)
    expect(s.detail).toBeNull()
  })

  it('keeps detail when present', () => {
    const s = parseSignal({...raw(), detail: 'ripetibile in staging'})
    expect(s.detail).toBe('ripetibile in staging')
  })

  it.each([
    ['source', {...raw(), source: undefined}],
    ['evidence', {...raw(), evidence: undefined}],
    ['impact', {...raw(), impact: undefined}],
    ['confidence', {...raw(), confidence: undefined}],
    ['title', {...raw(), title: undefined}],
  ])('rejects a signal without %s (exit 2)', (_field, bad) => {
    const err = grab(() => parseSignal(bad))
    expect(err.code).toBe('C400-DISCOVERY-001')
    expect(err.exitCode).toBe(2)
  })

  it('rejects a source outside the allowed sources', () => {
    const err = grab(() => parseSignal({...raw(), source: 'logs'}))
    expect(err.code).toBe('C400-DISCOVERY-001')
  })

  it('rejects an unknown impact', () => {
    expect(() => parseSignal({...raw(), impact: 'blocker'})).toThrow(AutomatorError)
  })

  it('rejects a confidence outside [0,1]', () => {
    expect(() => parseSignal({...raw(), confidence: 1.4})).toThrow(AutomatorError)
    expect(() => parseSignal({...raw(), confidence: -0.2})).toThrow(AutomatorError)
  })

  it('rejects empty title/evidence (a signal must carry evidence)', () => {
    expect(() => parseSignal({...raw(), title: ''})).toThrow(AutomatorError)
    expect(() => parseSignal({...raw(), evidence: ''})).toThrow(AutomatorError)
  })

  it('rejects extra fields (strict schema, untrusted agent output)', () => {
    expect(() => parseSignal({...raw(), unexpected: true})).toThrow(AutomatorError)
  })

  it('rejects a non-object input', () => {
    for (const bad of [null, 'x', 42, []]) {
      expect(() => parseSignal(bad)).toThrow(AutomatorError)
    }
  })
})

describe('evaluateDiscovery: budget and priority (Scenario 1: produces signals with evidence)', () => {
  it('orders by decreasing impact then decreasing confidence', () => {
    const report = evaluateDiscovery([
      signal({title: 'A', impact: 'low', confidence: 0.9}),
      signal({title: 'B', impact: 'critical', confidence: 0.6}),
      signal({title: 'C', impact: 'high', confidence: 0.7}),
      signal({title: 'D', impact: 'high', confidence: 0.95}),
    ])
    expect(report.accepted.map((s) => s.title)).toEqual(['B', 'D', 'C', 'A'])
  })

  it('respects maxSignals: the signals over the budget end up in dropped with the reason', () => {
    const report = evaluateDiscovery(
      [
        signal({title: 'A', impact: 'critical', confidence: 0.9}),
        signal({title: 'B', impact: 'high', confidence: 0.8}),
        signal({title: 'C', impact: 'low', confidence: 0.9}),
      ],
      {maxSignals: 2, minConfidence: 0},
    )
    expect(report.accepted.map((s) => s.title)).toEqual(['A', 'B'])
    expect(report.dropped.map((d) => d.signal.title)).toEqual(['C'])
    expect(report.dropped[0].reason.toLowerCase()).toContain('budget')
  })

  it('discards the signals below the confidence threshold (noise) with the reason', () => {
    const report = evaluateDiscovery(
      [signal({title: 'forte', confidence: 0.9}), signal({title: 'debole', confidence: 0.2})],
      {maxSignals: 10, minConfidence: 0.5},
    )
    expect(report.accepted.map((s) => s.title)).toEqual(['forte'])
    expect(report.dropped.map((d) => d.signal.title)).toEqual(['debole'])
    expect(report.dropped[0].reason.toLowerCase()).toContain('confidenza')
  })

  it('every accepted signal carries source, impact and confidence (DoD)', () => {
    const report = evaluateDiscovery([signal(), signal({source: 'ci', impact: 'critical'})])
    for (const s of report.accepted) {
      expect(isDiscoverySource(s.source)).toBe(true)
      expect(isImpactLevel(s.impact)).toBe(true)
      expect(typeof s.confidence).toBe('number')
      expect(s.evidence.length).toBeGreaterThan(0)
    }
  })

  it('no signal → valid empty report (the discovery may find nothing)', () => {
    const report = evaluateDiscovery([])
    expect(report.accepted).toEqual([])
    expect(report.dropped).toEqual([])
    expect(report.reasons.length).toBeGreaterThan(0)
  })

  it('is deterministic: same input → same report', () => {
    const input = [signal({title: 'A', impact: 'high'}), signal({title: 'B', impact: 'low'})]
    expect(evaluateDiscovery(input)).toEqual(evaluateDiscovery(input))
  })

  it('uses the default budget when not specified', () => {
    const report = evaluateDiscovery([signal()])
    expect(report.budget).toEqual(DEFAULT_DISCOVERY_BUDGET)
  })
})

/** A valid raw signal (record), for the parseSignal tests. */
function raw(): Record<string, unknown> {
  return {
    source: 'errors',
    title: 'Errore 500 al checkout',
    evidence: '42 occorrenze in 24h',
    impact: 'high',
    confidence: 0.8,
  }
}

/** Runs `fn`, which must throw an AutomatorError, and returns it for the assertions on code/exitCode. */
function grab(fn: () => unknown): AutomatorError {
  try {
    fn()
  } catch (error) {
    if (error instanceof AutomatorError) return error
    throw error
  }
  throw new Error('la funzione doveva sollevare un AutomatorError, ma non lo ha fatto')
}
