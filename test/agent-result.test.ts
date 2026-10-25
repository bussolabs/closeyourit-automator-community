import {describe, expect, it} from 'vitest'
import {
  AgentRunResultSchema,
  normalizeAgentResult,
  parseAgentReport,
  type AgentReport,
} from '../src/lib/agent-result'
import {type RunResult} from '../src/lib/executor'

/** Raw engine (executor) RunResult with defaults, overridable for the case under test. */
function runResult(partial: Partial<RunResult> = {}): RunResult {
  return {status: 'success', exitCode: 0, errorCode: null, durationMs: 42, logPath: '/logs/a.log', stdout: '', ...partial}
}

/** Full report emitted by the agent (snake_case, as it would write it in its own output). */
const fullReport: AgentReport = {
  summary: 'implementata la feature',
  changed_files: ['src/a.ts', 'test/a.test.ts'],
  tests: {passed: 3, failed: 0, summary: '3 verdi'},
  risks: ['nessuna migrazione'],
  commit: 'abc1234',
  confidence: 0.8,
}

/** Real claude output: `--output-format json` wrapper with the report in a ```json block inside `result`. */
function claudeStdout(report: unknown, text = 'Ho completato il lavoro.'): string {
  const body = `${text}\n\n\`\`\`json\n${JSON.stringify(report)}\n\`\`\`\n`
  return JSON.stringify({type: 'result', subtype: 'success', is_error: false, result: body})
}

describe('normalizeAgentResult — outcome (normalizza successo/errore/timeout/cancel)', () => {
  it('successo → outcome success', () => {
    const r = normalizeAgentResult({runtime: 'claude', action: 'a', result: runResult({status: 'success'})})
    expect(r.outcome).toBe('success')
  })

  it('error → failure outcome', () => {
    const r = normalizeAgentResult({
      runtime: 'codex',
      action: 'a',
      result: runResult({status: 'failure', exitCode: 1, errorCode: 'C001-EXEC-003'}),
    })
    expect(r.outcome).toBe('failure')
    expect(r.metadata.exitCode).toBe(1)
    expect(r.metadata.errorCode).toBe('C001-EXEC-003')
  })

  it('timeout → outcome timeout', () => {
    const r = normalizeAgentResult({
      runtime: 'claude',
      action: 'a',
      result: runResult({status: 'timeout', exitCode: null, errorCode: 'C124-EXEC-001'}),
    })
    expect(r.outcome).toBe('timeout')
  })

  it('cancel → cancelled outcome even if the process closed as failure', () => {
    const r = normalizeAgentResult({
      runtime: 'claude',
      action: 'a',
      result: runResult({status: 'failure', exitCode: null}),
      cancelled: true,
    })
    expect(r.outcome).toBe('cancelled')
  })
})

describe('normalizeAgentResult — schema uniforme e validato', () => {
  it('ALWAYS produces an object that respects AgentRunResultSchema', () => {
    const r = normalizeAgentResult({runtime: 'claude', action: 'a', result: runResult()})
    expect(AgentRunResultSchema.safeParse(r).success).toBe(true)
  })

  it('metadati completi: runtime, action, exitCode, errorCode, durationMs, logPath, reportParsed', () => {
    const r = normalizeAgentResult({
      runtime: 'codex',
      action: 'nightly',
      result: runResult({exitCode: 0, durationMs: 1200, logPath: '/logs/nightly.log'}),
    })
    expect(r.metadata).toEqual({
      runtime: 'codex',
      action: 'nightly',
      exitCode: 0,
      errorCode: null,
      durationMs: 1200,
      logPath: '/logs/nightly.log',
      reportParsed: false,
    })
  })

  it('runtime diversi (claude vs codex) → stessa struttura confrontabile', () => {
    const base = runResult({stdout: JSON.stringify(fullReport)})
    const a = normalizeAgentResult({runtime: 'claude', action: 'x', result: base})
    const b = normalizeAgentResult({runtime: 'codex', action: 'x', result: base})
    expect(Object.keys(a).sort()).toEqual(Object.keys(b).sort())
    expect(Object.keys(a.metadata).sort()).toEqual(Object.keys(b.metadata).sort())
    expect(AgentRunResultSchema.safeParse(a).success).toBe(true)
    expect(AgentRunResultSchema.safeParse(b).success).toBe(true)
  })
})

describe('normalizeAgentResult — validation of the agent output', () => {
  it('claude report (```json block inside result) → rich fields populated, reportParsed true', () => {
    const r = normalizeAgentResult({
      runtime: 'claude',
      action: 'a',
      result: runResult({stdout: claudeStdout(fullReport)}),
    })
    expect(r.summary).toBe('implementata la feature')
    expect(r.changedFiles).toEqual(['src/a.ts', 'test/a.test.ts'])
    expect(r.tests).toEqual({passed: 3, failed: 0, summary: '3 verdi'})
    expect(r.risks).toEqual(['nessuna migrazione'])
    expect(r.commit).toBe('abc1234')
    expect(r.confidence).toBe(0.8)
    expect(r.metadata.reportParsed).toBe(true)
  })

  it('direct JSON report (codex/shell) → rich fields populated', () => {
    const r = normalizeAgentResult({
      runtime: 'codex',
      action: 'a',
      result: runResult({stdout: JSON.stringify({summary: 'ok', changed_files: ['b.ts']})}),
    })
    expect(r.summary).toBe('ok')
    expect(r.changedFiles).toEqual(['b.ts'])
    expect(r.metadata.reportParsed).toBe(true)
  })

  it('invalid output (malformed JSON) → no crash, empty fields, reportParsed false, valid schema', () => {
    const r = normalizeAgentResult({
      runtime: 'claude',
      action: 'a',
      result: runResult({stdout: '{ questo non è json valido'}),
    })
    expect(r.metadata.reportParsed).toBe(false)
    expect(r.summary).toBeNull()
    expect(r.changedFiles).toEqual([])
    expect(r.risks).toEqual([])
    expect(r.confidence).toBeNull()
    expect(AgentRunResultSchema.safeParse(r).success).toBe(true)
  })

  it('output with a wrongly typed field (non-numeric confidence) → report discarded, reportParsed false', () => {
    const r = normalizeAgentResult({
      runtime: 'claude',
      action: 'a',
      result: runResult({stdout: JSON.stringify({summary: 'ok', confidence: 'altissima'})}),
    })
    expect(r.metadata.reportParsed).toBe(false)
    expect(r.summary).toBeNull()
  })

  it('confidence out of range [0,1] → report discarded (boundary validation)', () => {
    const r = normalizeAgentResult({
      runtime: 'claude',
      action: 'a',
      result: runResult({stdout: JSON.stringify({confidence: 1.5})}),
    })
    expect(r.metadata.reportParsed).toBe(false)
    expect(r.confidence).toBeNull()
  })

  it('empty stdout → no report, reportParsed false, fields at defaults', () => {
    const r = normalizeAgentResult({runtime: 'spawn', action: 'a', result: runResult({stdout: ''})})
    expect(r.metadata.reportParsed).toBe(false)
    expect(r.tests).toEqual({passed: null, failed: null, summary: null})
  })

  it('stdout with an empty object {} → reportParsed false (no recognized field)', () => {
    const r = normalizeAgentResult({runtime: 'claude', action: 'a', result: runResult({stdout: '{}'})})
    expect(r.metadata.reportParsed).toBe(false)
    expect(r.summary).toBeNull()
  })

  it('partial tests in the report → missing fields as null (not undefined)', () => {
    const r = normalizeAgentResult({
      runtime: 'codex',
      action: 'a',
      result: runResult({stdout: JSON.stringify({tests: {passed: 5}})}),
    })
    expect(r.tests).toEqual({passed: 5, failed: null, summary: null})
  })

  it('a valid report on a failed run stays associated with the failure outcome', () => {
    const r = normalizeAgentResult({
      runtime: 'claude',
      action: 'a',
      result: runResult({status: 'failure', exitCode: 1, stdout: claudeStdout({summary: 'ho fallito', confidence: 0.1})}),
    })
    expect(r.outcome).toBe('failure')
    expect(r.summary).toBe('ho fallito')
    expect(r.metadata.reportParsed).toBe(true)
  })
})

describe('parseAgentReport', () => {
  it('extracts the report from the claude wrapper', () => {
    expect(parseAgentReport(claudeStdout(fullReport))).toEqual({report: fullReport, parsed: true})
  })

  it('extracts the direct JSON report', () => {
    const report = {summary: 'x'}
    expect(parseAgentReport(JSON.stringify(report))).toEqual({report, parsed: true})
  })

  it('stdout without report → parsed false', () => {
    expect(parseAgentReport('solo log testuale, nessun json')).toEqual({report: null, parsed: false})
  })

  it('empty JSON object {} → parsed false (it is not a report, it is noise)', () => {
    expect(parseAgentReport('{}')).toEqual({report: null, parsed: false})
  })

  it('object with only unrecognized fields → parsed false (no schema field)', () => {
    expect(parseAgentReport(JSON.stringify({pippo: 1, bar: true}))).toEqual({report: null, parsed: false})
  })
})

describe('AgentRunResultSchema', () => {
  it('rejects an unknown outcome', () => {
    const r = normalizeAgentResult({runtime: 'claude', action: 'a', result: runResult()})
    expect(AgentRunResultSchema.safeParse({...r, outcome: 'boh'}).success).toBe(false)
  })

  it('rejects unexpected extra fields (strict)', () => {
    const r = normalizeAgentResult({runtime: 'claude', action: 'a', result: runResult()})
    expect(AgentRunResultSchema.safeParse({...r, extra: 1}).success).toBe(false)
  })
})
