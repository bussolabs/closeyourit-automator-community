import {describe, expect, it} from 'vitest'
import {
  composeReferenceStopComment,
  composeTicketGuidanceMarkdown,
  consultRequiredReferences,
  defaultReferenceProbe,
  type GuidanceEntry,
  hasReferenceStopComment,
  parseTicketGuidance,
  REFERENCE_BLOCKED_MARKER,
  type ReferenceProbe,
  requiredReferences,
  type TicketGuidance,
} from '../src/lib/ticket-guidance'

// Structured guidance from the ticket detail (CYAU-1). Shape aligned with closeyourit-cli (CYCL-2): guidance =
// {references, procedures} with entry {key, origin, level, required, application_mode}; the automator adds the
// additive list `rules` (Scenario 3, "rules as data") with the SAME generic shape. The hierarchy
// resolution is SERVER-side: the worker consumes the values verbatim, with no special logic for single keys
// (Scenario 3, "no special condition in the code"). The core is pure (parse/compose/select); the
// consultation of a reference lives behind the injectable `ReferenceProbe` (read-only, like `KbProbe`).

describe('parseTicketGuidance — defensive parser of the ticket detail (untrusted input from the backend)', () => {
  it('reads references/procedures/rules from the snake_case wire and maps application_mode → applicationMode', () => {
    const guidance = parseTicketGuidance({
      references: [{key: 'global/git.md', origin: 'org', level: 'project', required: true, application_mode: 'always'}],
      procedures: [{key: 'procedures/reset.md', origin: 'stack', level: 'global', required: false, application_mode: 'on_demand'}],
      rules: [{key: 'development.tdd', origin: 'org', level: 'project'}],
    })
    expect(guidance).not.toBeNull()
    expect(guidance!.references).toEqual([
      {key: 'global/git.md', origin: 'org', level: 'project', required: true, applicationMode: 'always'},
    ])
    expect(guidance!.procedures).toEqual([
      {key: 'procedures/reset.md', origin: 'stack', level: 'global', required: false, applicationMode: 'on_demand'},
    ])
    expect(guidance!.rules).toEqual([{key: 'development.tdd', origin: 'org', level: 'project'}])
  })

  it('preserves the additive extra fields verbatim (loose Record<string, unknown> contract)', () => {
    const guidance = parseTicketGuidance({procedures: [{key: 'p', note: 'extra', weight: 3}]})
    expect(guidance!.procedures[0]).toMatchObject({key: 'p', note: 'extra', weight: 3})
  })

  it('discards single malformed entries (not objects) without dropping the valid ones', () => {
    const guidance = parseTicketGuidance({references: [{key: 'ok'}, 'stringa', 42, null]})
    expect(guidance!.references.map((r) => r.key)).toEqual(['ok'])
  })

  it('tolerates a non-array list treating it as empty', () => {
    const guidance = parseTicketGuidance({references: 'non-lista', procedures: [{key: 'p'}]})
    expect(guidance!.references).toEqual([])
    expect(guidance!.procedures).toEqual([{key: 'p'}])
  })

  it('non-object input → null (missing guidance)', () => {
    expect(parseTicketGuidance(null)).toBeNull()
    expect(parseTicketGuidance('x')).toBeNull()
    expect(parseTicketGuidance(['array'])).toBeNull()
  })

  it('all lists missing or empty → null (backward compat: no structured guidance)', () => {
    expect(parseTicketGuidance({})).toBeNull()
    expect(parseTicketGuidance({references: [], procedures: [], rules: []})).toBeNull()
  })

  it('accepts required only if boolean true (a "true" string does not make the reference required)', () => {
    const guidance = parseTicketGuidance({references: [{key: 'a', required: 'true'}, {key: 'b', required: true}]})
    expect(guidance!.references[0].required).toBeUndefined()
    expect(guidance!.references[1].required).toBe(true)
  })
})

describe('composeTicketGuidanceMarkdown — renders the guidance as verbatim DATA (Scenario 3)', () => {
  const guidance: TicketGuidance = {
    references: [{key: 'global/git.md', origin: 'org', level: 'project', required: true, applicationMode: 'always'}],
    procedures: [
      {key: 'procedures/reset.md', origin: 'org', level: 'global', applicationMode: 'on_demand'},
      {key: 'procedures/release.md', origin: 'stack', level: 'project', applicationMode: 'always'},
    ],
    rules: [{key: 'development.tdd'}, {key: 'documentation.update_kb'}],
  }

  it('includes the three sections with keys and metadata (procedures, references, rules)', () => {
    const markdown = composeTicketGuidanceMarkdown(guidance)
    expect(markdown).toContain('procedures/reset.md')
    expect(markdown).toContain('procedures/release.md')
    expect(markdown).toContain('global/git.md')
    // Scenario 1: the received procedures (with their level) appear in the context.
    expect(markdown).toContain('global')
    expect(markdown).toContain('project')
    expect(markdown).toContain('on_demand')
  })

  it('Scenario 3: the rules appear verbatim as data (no interpretation)', () => {
    const markdown = composeTicketGuidanceMarkdown(guidance)
    expect(markdown).toContain('development.tdd')
    expect(markdown).toContain('documentation.update_kb')
  })

  it('is deterministic: same input → same output', () => {
    expect(composeTicketGuidanceMarkdown(guidance)).toBe(composeTicketGuidanceMarkdown(guidance))
  })

  it('an empty section does not break the markdown (only the present sections)', () => {
    const markdown = composeTicketGuidanceMarkdown({references: [], procedures: [{key: 'p'}], rules: []})
    expect(markdown).toContain('p')
  })

  it('renders the extra attributes as data (scalars and objects)', () => {
    const markdown = composeTicketGuidanceMarkdown({
      references: [],
      procedures: [{key: 'p', tag: 'x', meta: {a: 1}}],
      rules: [],
    })
    expect(markdown).toContain('tag=x')
    expect(markdown).toContain('meta={"a":1}')
  })

  it('an entry without key is rendered with a placeholder (no crash)', () => {
    const markdown = composeTicketGuidanceMarkdown({references: [], procedures: [{origin: 'org'}], rules: []})
    expect(markdown).toContain('(senza chiave)')
  })

  it('includes the content of the consulted mandatory references (Scenario 2)', () => {
    const markdown = composeTicketGuidanceMarkdown(
      {references: [{key: 'global/git.md', required: true}], procedures: [], rules: []},
      [{key: 'global/git.md', title: 'Guida Git', content: 'contenuto della guida'}],
    )
    expect(markdown).toContain('Contenuto delle reference obbligatorie consultate')
    expect(markdown).toContain('Guida Git')
    expect(markdown).toContain('contenuto della guida')
  })

  it('without consulted contents it does not add the content section', () => {
    const markdown = composeTicketGuidanceMarkdown({references: [{key: 'r'}], procedures: [], rules: []}, [])
    expect(markdown).not.toContain('Contenuto delle reference obbligatorie consultate')
  })
})

describe('requiredReferences — the mandatory references to consult before the claim (Scenario 2)', () => {
  it('selects only the references with required === true', () => {
    const guidance: TicketGuidance = {
      references: [
        {key: 'a', required: true},
        {key: 'b', required: false},
        {key: 'c'},
      ],
      procedures: [{key: 'p', required: true}],
      rules: [],
    }
    expect(requiredReferences(guidance).map((r) => r.key)).toEqual(['a'])
  })
})

// ── Fake ReferenceProbe ───────────────────────────────────────────────────────────────────────────────────────
function recordingProbe(byKey: Record<string, {accessible: boolean; reason?: string}>): {
  probe: ReferenceProbe
  calls: Array<{key: string; project: string}>
} {
  const calls: Array<{key: string; project: string}> = []
  return {
    calls,
    probe: {
      consult({key, project}) {
        calls.push({key, project})
        return byKey[key] ?? {accessible: false, reason: 'non trovata'}
      },
    },
  }
}

describe('consultRequiredReferences — checks accessibility before the claim (Scenario 2 / DoD)', () => {
  const withRefs = (references: GuidanceEntry[]): TicketGuidance => ({references, procedures: [], rules: []})

  it('all required references accessible → none inaccessible', () => {
    const {probe, calls} = recordingProbe({'global/git.md': {accessible: true}})
    const result = consultRequiredReferences(withRefs([{key: 'global/git.md', required: true}]), 'CYAU', probe)
    expect(result.inaccessible).toEqual([])
    expect(result.consulted.map((c) => c.key)).toEqual(['global/git.md'])
    expect(calls).toEqual([{key: 'global/git.md', project: 'CYAU'}])
  })

  it('an inaccessible required reference → appears in inaccessible with the reason (stop without claim)', () => {
    const {probe} = recordingProbe({'advenias-care-md-docs': {accessible: false, reason: 'permesso negato'}})
    const result = consultRequiredReferences(withRefs([{key: 'advenias-care-md-docs', required: true}]), 'ADV', probe)
    expect(result.inaccessible).toEqual([{key: 'advenias-care-md-docs', reason: 'permesso negato'}])
  })

  it('does NOT consult non-mandatory references (only the required ones before the claim)', () => {
    const {probe, calls} = recordingProbe({a: {accessible: true}})
    consultRequiredReferences(withRefs([{key: 'a', required: true}, {key: 'b', required: false}]), 'CYAU', probe)
    expect(calls.map((c) => c.key)).toEqual(['a'])
  })

  it('a required reference without key → inaccessible (fail-closed, not consultable)', () => {
    const {probe, calls} = recordingProbe({})
    const result = consultRequiredReferences(withRefs([{required: true}]), 'CYAU', probe)
    expect(result.inaccessible).toHaveLength(1)
    expect(result.inaccessible[0].reason).toContain('chiave')
    expect(calls).toEqual([]) // no key → no consultation, but still blocking
  })

  it('a required reference with an unsafe key (option injection) → inaccessible, without consulting it', () => {
    const {probe, calls} = recordingProbe({})
    const result = consultRequiredReferences(withRefs([{key: '--json', required: true}]), 'CYAU', probe)
    expect(result.inaccessible).toHaveLength(1)
    expect(result.inaccessible[0].reason).toContain('non valida')
    expect(calls).toEqual([]) // hostile key → never passed to cyi
  })

  it('propagates title and content of the consulted reference (the runtime receives the text, not only the key)', () => {
    const probe: ReferenceProbe = {consult: () => ({accessible: true, title: 'Git', content: 'come si fa'})}
    const result = consultRequiredReferences(withRefs([{key: 'global/git.md', required: true}]), 'CYAU', probe)
    expect(result.consulted).toEqual([{key: 'global/git.md', title: 'Git', content: 'come si fa'}])
  })
})

describe('defaultReferenceProbe — real read-only probe (cyi kb search, scope + content)', () => {
  it('builds the argv `cyi kb search <key> -p <project> --json` and returns title+content on exit 0', () => {
    const calls: Array<{cmd: string; args: string[]}> = []
    const run = (cmd: string, args: string[]) => {
      calls.push({cmd, args})
      return {status: 0, stdout: JSON.stringify({data: [{id: 'x', title: 'Doc', body: 'contenuto', project: 'CYAU'}]}), stderr: ''}
    }
    const outcome = defaultReferenceProbe(run).consult({key: 'global/git.md', project: 'CYAU'})
    expect(calls[0]).toEqual({cmd: 'cyi', args: ['kb', 'search', 'global/git.md', '-p', 'CYAU', '--json']})
    expect(outcome).toEqual({accessible: true, title: 'Doc', content: 'contenuto'})
  })

  it('no page found → inaccessible (fail-closed)', () => {
    const outcome = defaultReferenceProbe(() => ({status: 0, stdout: '{"data":[]}', stderr: ''}))
      .consult({key: 'assente', project: 'CYAU'})
    expect(outcome.accessible).toBe(false)
    expect(outcome.reason).toContain('nessuna pagina')
  })

  it('discards the pages of another project (defence in depth on the scope)', () => {
    const run = () => ({status: 0, stdout: JSON.stringify({data: [{id: 'o', title: 'Altrui', body: 'segreto', project: 'CYRA'}]}), stderr: ''})
    const outcome = defaultReferenceProbe(run).consult({key: 'x', project: 'CYAU'})
    expect(outcome.accessible).toBe(false)
  })

  it('exit ≠ 0 → inaccessible with the reason (best-effort, the gate blocks)', () => {
    const run = () => ({status: 1, stdout: '', stderr: 'C401 unauthorized'})
    const outcome = defaultReferenceProbe(run).consult({key: 'assente', project: 'CYAU'})
    expect(outcome.accessible).toBe(false)
    expect(outcome.reason).toContain('C401 unauthorized')
  })

  it('is read-only by construction: exposes only consult', () => {
    const probe = defaultReferenceProbe(() => ({status: 0, stdout: '{"data":[]}', stderr: ''}))
    expect(Object.keys(probe)).toEqual(['consult'])
  })
})

describe('composeReferenceStopComment / hasReferenceStopComment — idempotent block comment', () => {
  it('the comment is customer-friendly, cites the documents and carries the hidden marker', () => {
    const body = composeReferenceStopComment([{key: 'advenias-care-md-docs', reason: 'permesso negato'}])
    expect(body).toContain('advenias-care-md-docs')
    expect(body).toContain(REFERENCE_BLOCKED_MARKER)
    // No internal technical jargon (the raw reason does not end up in the visible text).
    expect(body).not.toContain('permesso negato')
  })

  it('recognises a ticket already commented from the marker (avoids republishing)', () => {
    const body = composeReferenceStopComment([{key: 'k', reason: 'r'}])
    expect(hasReferenceStopComment([{body}])).toBe(true)
    expect(hasReferenceStopComment([{body: 'un altro commento'}])).toBe(false)
    expect(hasReferenceStopComment([])).toBe(false)
  })

  // The server rejects a comment beyond the cap (App::Constants::COMMENT_MAX_CHARS, CYRA-222): if the body
  // exceeds it, publishing fails and the preflight stops without being able to say why. The worst case is a
  // long list of long keys: it must degrade to "+N others", never grow.
  it('stays under the comment cap even with many documents', () => {
    const many = Array.from({length: 40}, (_, i) => ({key: `documento-di-riferimento-molto-lungo-${i}`, reason: 'r'}))
    const body = composeReferenceStopComment(many)

    expect(body.length).toBeLessThanOrEqual(240)
    expect(body).toContain(REFERENCE_BLOCKED_MARKER)
    expect(body).toContain('altri')
  })

  it('without room for any key it still says how many documents there are', () => {
    const body = composeReferenceStopComment([{key: 'k'.repeat(300), reason: 'r'}])

    expect(body.length).toBeLessThanOrEqual(240)
    expect(body).toContain('1 documenti')
  })
})
