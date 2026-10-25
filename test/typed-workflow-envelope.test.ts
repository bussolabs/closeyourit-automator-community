import * as fs from 'node:fs'
import * as path from 'node:path'
import {describe, expect, it} from 'vitest'
import {parseWorkflowResult, parseWorkflowResultDetailed, parseWorkflowReview} from '../src/lib/typed-workflow'

// CYAU-106: `typed-workflow.test.ts` tested the parser on `JSON.stringify(fixture)`, that is on an ALREADY
// extracted result. The hole was exactly there: in production the stdout is the envelope of
// `claude -p … --output-format json`, where the result travels in the `result` field as a string — and that
// string can be prose, a markdown fence, or the envelope itself can be pretty-printed after lines of
// noise. Here the REAL stdout is read from the fixtures, as bytes.

const FIXTURES = path.join(__dirname, 'fixtures', 'claude')
const stdout = (name: string): string => fs.readFileSync(path.join(FIXTURES, name), 'utf8')

const TRIAGE = {
  code: 'CYRA-199', category: 'backend', capabilities: ['backend', 'database'],
  risk: 'low', requires_human_approval: false,
  reasons: ['Area: backend — segnali: migration, schema'], state: 'workable',
}

describe('parseWorkflowResult — real CLI stdout', () => {
  it('recognizes the result inside a code block in the `result` field', () => {
    // Case observed on minion-1: the model frames the JSON in markdown. Before, it returned null → no
    // delivery, and for two days nobody knew why.
    expect(parseWorkflowResult(stdout('envelope-fenced.json'), 'triage')).toMatchObject(TRIAGE)
  })

  it('recognizes the result even when the `result` field starts with prose', () => {
    expect(parseWorkflowResult(stdout('envelope-prose-then-fence.json'), 'triage')).toMatchObject(TRIAGE)
  })

  it('recognizes the pretty-printed envelope preceded by lines of noise', () => {
    // Here neither the whole stdout nor the last line are valid JSON: the balanced objects are needed.
    expect(parseWorkflowResult(stdout('envelope-noisy-pretty.txt'), 'triage')).toMatchObject(TRIAGE)
  })

  it('recognizes a code block without declared language', () => {
    const raw = `Ecco l'esito.\n\n\`\`\`\n${JSON.stringify(TRIAGE)}\n\`\`\`\n`
    expect(parseWorkflowResult(raw, 'triage')).toMatchObject(TRIAGE)
  })

  // The case that JUSTIFIES the code block scan: without it the other fences pass anyway,
  // because the balanced-object scanner finds them by itself. Not here — a brace opened and never closed in the noise
  // nests the object, which is therefore no longer top-level, and the multi-line pretty-print also rules out the
  // last-line fallback. It is the only way to read the result.
  it('recognizes a code block when the noise contains a brace opened and never closed', () => {
    const raw = `[warn] contesto { non chiuso\n\`\`\`json\n${JSON.stringify(TRIAGE, null, 2)}\n\`\`\`\n`
    expect(parseWorkflowResult(raw, 'triage')).toMatchObject(TRIAGE)
  })

  it('with several blocks the LAST valid one wins: a session answer sits at the end', () => {
    const bozza = {...TRIAGE, risk: 'high', requires_human_approval: true}
    const raw = [
      'Prima ipotesi:', '```json', JSON.stringify(bozza), '```',
      'Correggo, la migrazione è additiva:', '```json', JSON.stringify(TRIAGE), '```',
    ].join('\n')
    expect(parseWorkflowResult(raw, 'triage')).toMatchObject({risk: 'low', requires_human_approval: false})
  })

  it('with the last block invalid it falls back on the previous valid one, without inventing anything', () => {
    const raw = [
      '```json', JSON.stringify(TRIAGE), '```',
      'Poi mi sono interrotto:', '```json', '{"code": "CYRA-199", "state": "wor', '```',
    ].join('\n')
    expect(parseWorkflowResult(raw, 'triage')).toMatchObject(TRIAGE)
  })

  it('a nested object in the result does not confuse the brace count', () => {
    const plan = {
      code: 'CYRA-199', technical_analysis: 'Analisi', state: 'submitted-for-approval',
      scenarios: [{given: 'g', when: 'w', then: 't', expected: 'e'}],
      definition_of_done: ['RSpec'], mixed_parts: {ui: {files: ['a.erb']}}, notes: [],
    }
    const raw = `rumore\n${JSON.stringify({type: 'result', result: `\`\`\`json\n${JSON.stringify(plan, null, 2)}\n\`\`\``})}`
    expect(parseWorkflowResult(raw, 'planner')).toMatchObject({mixed_parts: {ui: {files: ['a.erb']}}})
  })

  // The scan must be FORCED (noise in front + pretty-print, so neither whole stdout nor last
  // line are JSON) and a string must contain unbalanced braces: counting them would close the object
  // early, the slice would come out truncated and the result would no longer be readable.
  it('a brace inside a string does not break the scan', () => {
    const withBrace = {...TRIAGE, reasons: ['Il template usa {{code}} e chiude con }']}
    const raw = `[warn] rumore\n${JSON.stringify({type: 'result', result: JSON.stringify(withBrace)}, null, 2)}`

    expect(parseWorkflowResult(raw, 'triage')).toMatchObject({
      reasons: ['Il template usa {{code}} e chiude con }'],
    })
  })

  it('a brace preceded by an escape does not open a string', () => {
    // An escaped backslash (`\\`) does NOT escape the following quote: if the parser confused it,
    // it would stay inside a string for the rest of the output and would find no object anymore.
    const withBackslash = {...TRIAGE, reasons: ['Path Windows: C:\\\\tmp\\\\ e poi }']}
    const raw = `[warn] rumore\n${JSON.stringify({type: 'result', result: JSON.stringify(withBackslash)}, null, 2)}`

    expect(parseWorkflowResult(raw, 'triage')).toMatchObject({reasons: withBackslash.reasons})
  })
})

describe('parseWorkflowResult — stays fail-closed', () => {
  it('prose only → null: a non-interpretable output stays non-interpretable', () => {
    const prosa = 'Since the interactive question tool isn\'t available here, I\'ll lay out the options and stop.'
    expect(parseWorkflowResult(prosa, 'triage')).toBeNull()
    expect(parseWorkflowResult(JSON.stringify({type: 'result', result: prosa}), 'triage')).toBeNull()
  })

  it('a code block with invalid schema → null, no textual fallback', () => {
    const invalido = {...TRIAGE, state: 'stopped'}
    expect(parseWorkflowResult(`\`\`\`json\n${JSON.stringify(invalido)}\n\`\`\``, 'triage')).toBeNull()
  })

  it('needs-clarification without questions → null even inside a fenced envelope', () => {
    const senzaDomande = {...TRIAGE, state: 'needs-clarification'}
    const raw = JSON.stringify({result: `\`\`\`json\n${JSON.stringify(senzaDomande)}\n\`\`\``})
    expect(parseWorkflowResult(raw, 'triage')).toBeNull()
  })

  it('the result of ANOTHER phase does not pass for the current phase', () => {
    const closer = {code: 'CYRA-199', state: 'staging-released', tag: 'v0.30.0-beta.1', commit: '3f2a91c0d4e6b8079a1c5f3d2e7b4a6c8d0f1e29'}
    expect(parseWorkflowResult(`\`\`\`json\n${JSON.stringify(closer)}\n\`\`\``, 'triage')).toBeNull()
  })

  it('a result truncated halfway is not rebuilt', () => {
    const troncato = `{"type":"result","result":"{\\"code\\":\\"CYRA-199\\",\\"category\\":\\"back`
    expect(parseWorkflowResult(troncato, 'triage')).toBeNull()
  })

  it('empty stdout or only spaces → null', () => {
    expect(parseWorkflowResult('', 'triage')).toBeNull()
    expect(parseWorkflowResult('   \n\n  ', 'triage')).toBeNull()
  })
})

describe('parseWorkflowReview — the reviewer also goes through the same extractor', () => {
  it('recognizes the verdict inside a code block', () => {
    const raw = `Ho revisionato il diff.\n\n\`\`\`json\n{"status":"accepted","summary":"Conforme"}\n\`\`\`\n`
    expect(parseWorkflowReview(raw, 'autopilot')).toEqual({status: 'accepted', summary: 'Conforme'})
  })

  it('recognizes the verdict in an envelope with noise', () => {
    const raw = `[warn] sandbox pronta\n${JSON.stringify({type: 'result', result: '{"status":"changes_requested","summary":"Manca un test"}'}, null, 2)}`
    expect(parseWorkflowReview(raw, 'autopilot')).toEqual({status: 'changes_requested', summary: 'Manca un test'})
  })

  it('stays strict: an extra field is not a valid verdict', () => {
    const raw = '```json\n{"status":"accepted","summary":"Ok","effect":"publish"}\n```'
    expect(parseWorkflowReview(raw, 'autopilot')).toBeNull()
  })
})

describe('parseWorkflowResult — bounded cost on huge outputs', () => {
  it('finds the result at the end of ~1 MiB of noise within the budget', () => {
    // OUTPUT_MAX_BYTES is 1 MiB: the scan must stay usable at that scale, not quadratic.
    const noise = `${'riga di rumore senza graffe\n'.repeat(40_000)}`
    const raw = `${noise}${JSON.stringify({type: 'result', result: JSON.stringify(TRIAGE)})}`
    expect(raw.length).toBeGreaterThan(1_000_000)

    const started = performance.now()
    expect(parseWorkflowResult(raw, 'triage')).toMatchObject(TRIAGE)
    expect(performance.now() - started).toBeLessThan(2000)
  })

  // DELIBERATE limit, not an oversight: the scan looks at the last window (~256 KiB) because a
  // session answer sits at the end. An object buried earlier stays unrecognized — and since CYAU-105
  // that case leaves a log line with the stdout size, so it is diagnosable.
  it('a result buried BEFORE the scan window is not searched', () => {
    const buried = `${JSON.stringify(TRIAGE)}\n${'coda senza graffe\n'.repeat(20_000)}`
    expect(buried.length).toBeGreaterThan(300_000)

    expect(parseWorkflowResult(buried, 'triage')).toBeNull()
  })

  it('many braces opened and never closed do not blow up the scan', () => {
    const raw = `${'{ frammento non chiuso\n'.repeat(20_000)}${JSON.stringify(TRIAGE)}`
    const started = performance.now()
    expect(parseWorkflowResult(raw, 'triage')).toMatchObject(TRIAGE)
    expect(performance.now() - started).toBeLessThan(2000)
  })
})

// CYAU-192 — the WHY of a non-interpretable result. `parseWorkflowResult` returns `null` and throws away the
// zod issues: the runner only knew that it "was not interpretable", and a block delivered to the server without reason
// helps nobody. Here it is tested that the reason comes out, with the field path, from the candidate closest to the
// schema — and that `parseWorkflowResult` stays identical for whoever already uses it.
describe('parseWorkflowResultDetailed — the rejection reason, not only the rejection', () => {
  const AUTOPILOT_BLOCKED_V2 = {
    contract_version: 2, code: 'CYRA-660', state: 'blocked', security_findings: [],
    failure: {category: 'authentication', summary: 'Git non si autentica.', retryable: false, human_action: 'Ruotare la credenziale.'},
  }

  it('a valid result: full value and no issue, like `parseWorkflowResult`', () => {
    const raw = JSON.stringify(AUTOPILOT_BLOCKED_V2)
    const detailed = parseWorkflowResultDetailed(raw, 'autopilot')
    expect(detailed.issues).toEqual([])
    expect(detailed.value).toEqual(parseWorkflowResult(raw, 'autopilot'))
    expect(detailed.value).toMatchObject({code: 'CYRA-660', state: 'blocked'})
  })

  it('invented enum in failure.category: the path and the received value', () => {
    const raw = JSON.stringify({...AUTOPILOT_BLOCKED_V2, failure: {...AUTOPILOT_BLOCKED_V2.failure, category: 'git_auth'}})
    const detailed = parseWorkflowResultDetailed(raw, 'autopilot')
    expect(detailed.value).toBeNull()
    expect(parseWorkflowResult(raw, 'autopilot')).toBeNull()
    expect(detailed.issues).toHaveLength(1)
    expect(detailed.issues[0]).toMatch(/^failure\.category: /u)
    expect(detailed.issues[0]).toContain("'git_auth'")
  })

  it('acceptance_evidence.status "pending": the indexed path inside the work_report', () => {
    const delivered = {
      contract_version: 2, code: 'CYRA-700', state: 'delivered', gate: {passed: true}, review: {verdict: 'unavailable'},
      cycles: 1, security_findings: [],
      delivery: {prUrl: 'https://github.com/bussolabs/closeyourit-rails/pull/72', cyiStatus: 'in_review', autoMerged: false},
      work_report: {
        summary: 'Fatto', commit: 'a'.repeat(40),
        changed_files: [{path: 'app/x.rb', summary: 'x'}],
        tests: [{command: 'rspec', status: 'passed', summary: 'verde'}], risks: [], deviations: [],
        acceptance_evidence: [{criterion_id: 'DOD-1', status: 'pending', evidence: 'in corso', source: 'reported'}],
      },
    }
    const detailed = parseWorkflowResultDetailed(`\`\`\`json\n${JSON.stringify(delivered, null, 2)}\n\`\`\``, 'autopilot')
    expect(detailed.value).toBeNull()
    expect(detailed.issues).toEqual([expect.stringMatching(/^work_report\.acceptance_evidence\.0\.status: .*'pending'/u)])
  })

  it('hybrid keys (ticket/branch/pr_url): the missing contract fields, not a generic "invalid"', () => {
    const ibrido = {ticket: 'CYRA-701', branch: 'ticket/CYRA-701', pr_url: 'https://github.com/bussolabs/x/pull/3', state: 'delivered'}
    const detailed = parseWorkflowResultDetailed(JSON.stringify({type: 'result', result: JSON.stringify(ibrido)}), 'autopilot')
    expect(detailed.value).toBeNull()
    expect(detailed.issues).toEqual(expect.arrayContaining([expect.stringMatching(/^code: /u)]))
    // The CLI envelope is NOT the candidate: its issues (`type`, `result`) must not confuse the diagnosis.
    expect(detailed.issues.join('\n')).not.toContain('type')
  })

  it('prose without JSON: a single issue saying so, even inside the CLI envelope', () => {
    const prosa = 'Since the interactive question tool isn\'t available here, I\'ll lay out the options and stop.'
    expect(parseWorkflowResultDetailed(prosa, 'triage')).toEqual({value: null, issues: ['nessun oggetto JSON riconosciuto nell\'output']})
    expect(parseWorkflowResultDetailed(JSON.stringify({type: 'result', result: prosa}), 'triage').issues)
      .toEqual(['nessun oggetto JSON riconosciuto nell\'output'])
    expect(parseWorkflowResultDetailed('', 'triage').issues).toEqual(['nessun oggetto JSON riconosciuto nell\'output'])
  })

  it('with several candidates the one with fewer issues wins: the discarded draft does not hide the almost right result', () => {
    const bozza = {gate: 'non ancora', cycles: 'uno'}
    const quasi = {...AUTOPILOT_BLOCKED_V2, failure: {...AUTOPILOT_BLOCKED_V2.failure, retryable: 'yes'}}
    const raw = ['```json', JSON.stringify(quasi), '```', 'Riassumendo:', '```json', JSON.stringify(bozza), '```'].join('\n')
    const detailed = parseWorkflowResultDetailed(raw, 'autopilot')
    expect(detailed.issues).toEqual([expect.stringMatching(/^failure\.retryable: /u)])
  })

  it('contract_version not allowed for the phase: spelled out', () => {
    const detailed = parseWorkflowResultDetailed(JSON.stringify({contract_version: 3, code: 'X-1', state: 'blocked'}), 'planner')
    expect(detailed.value).toBeNull()
    expect(detailed.issues).toEqual([expect.stringMatching(/^contract_version: /u)])
  })
})
