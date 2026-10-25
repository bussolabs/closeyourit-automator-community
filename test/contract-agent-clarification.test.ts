import {createHash} from 'node:crypto'
import * as fs from 'node:fs'
import * as path from 'node:path'

import Ajv2020 from 'ajv/dist/2020'
import addFormats from 'ajv-formats'
import {describe, expect, it} from 'vitest'

import {
  CLARIFICATION_STATES,
  CLARIFICATION_WIRE_STATES,
  MAX_QUESTIONS,
  parseSystemClarificationState,
} from '../src/lib/clarification'
import {
  contractEnums,
  contractFormats,
  type ContractManifest,
  fixtureFilesOnDisk,
  VALORE_FUORI_CONTRATTO,
  withValueAt,
} from './helpers/contract'

// CYAU-189 — the clarification state is stated by the `agent-clarification/v1` contract, not by a copied regex.
//
// The "an answer is needed" signal lived in three identical copies of the same rule (server, automator,
// skill): a reformatted comment changed the state of a run, and the diverging copy of one reader
// changed it only for that reader. Here the link is DERIVED from the bundle vendored in
// `test/contracts/agent-clarification/v1` (twin of the Rails `spec/contracts/agent_clarification_v1_spec.rb`):
//  (a) the vendored bytes match the LOCK and their checksums;
//  (b) every official example is judged by the canonical schema (ajv Draft 2020-12) as the manifest says;
//  (c) the local reader (`parseSystemClarificationState`) gives the SAME verdict on every example — this is
//      what makes "recognizing the clarifications" something proven on the official examples and not on memory;
//  (d) the closed lists of the schema produce the edge cases by themselves, with ajv as the oracle: a list that
//      changes in the contract changes the cases and the expected verdicts without anyone rewriting the test.

const CONTRACT_ROOT = path.join(import.meta.dirname, 'contracts', 'agent-clarification')
const CONTRACT = path.join(CONTRACT_ROOT, 'v1')

function readJson(relative: string): unknown {
  return JSON.parse(fs.readFileSync(path.join(CONTRACT, relative), 'utf8'))
}

describe('contract agent-clarification/v1 — checksum parity (twin of the Rails agent_clarification_v1_spec)', () => {
  it('the vendored snapshot matches the LOCK and every checksum', () => {
    const lock = JSON.parse(fs.readFileSync(path.join(CONTRACT_ROOT, 'LOCK.json'), 'utf8')) as {sha256sums: string}
    const sumsBuffer = fs.readFileSync(path.join(CONTRACT, 'SHA256SUMS'))
    // The digest of the checksum manifest is pinned in LOCK.json: tampering with SHA256SUMS breaks it.
    expect(createHash('sha256').update(sumsBuffer).digest('hex')).toBe(lock.sha256sums)

    const lines = sumsBuffer.toString('utf8').split('\n').filter((line) => line.trim() !== '')
    expect(lines.length).toBeGreaterThan(0)
    for (const line of lines) {
      // Every line is `<sha256>  ./<relative path>` (`split("  ./", 2)` of the Ruby twin, first occurrence).
      const separator = line.indexOf('  ./')
      expect(separator, line).toBeGreaterThan(0)
      const expected = line.slice(0, separator)
      const relative = line.slice(separator + '  ./'.length)
      const actual = createHash('sha256').update(fs.readFileSync(path.join(CONTRACT, relative))).digest('hex')
      expect(actual, relative).toBe(expected)
    }
  })
})

// A single shared Ajv 2020-12: registers the schema by `$id` so the `$def`s are reachable by JSON pointer.
const schema = readJson('schema.json') as {$id: string; $defs: Record<string, unknown>}
const ajv = new Ajv2020({allErrors: true, strict: false})
addFormats(ajv)
ajv.addSchema(schema)

type Validator = ((data: unknown) => boolean) & {errors?: unknown}

function validatorFor(definition: string): Validator {
  const validate = ajv.getSchema(`${schema.$id}#/$defs/${definition}`)
  if (!validate) throw new Error(`definition not found in the contract schema: ${definition}`)
  return validate as unknown as Validator
}

const manifest = readJson('manifest.json') as ContractManifest

/**
 * Contract definitions the automator READS from the wire, with the local judge recognizing them. The map
 * is closed on purpose: a new definition among the fixtures must not be able to silently disappear from the
 * check — either it is mapped to a reader, or the test says so.
 */
const READER_BY_DEFINITION: Readonly<Record<string, (payload: unknown) => boolean>> = Object.freeze({
  clarification_state: (payload) => parseSystemClarificationState(JSON.stringify(payload)) !== undefined,
})

describe('contract agent-clarification/v1 — schema (ajv Draft 2020-12)', () => {
  it.each(manifest.fixtures)('fixture $path → $definition (valid=$valid)', ({path: relative, definition, valid}) => {
    const validate = validatorFor(definition)
    const ok = validate(readJson(relative))
    expect(ok, `${relative}: ${JSON.stringify(validate.errors)}`).toBe(valid)
  })

  it('the manifest lists every example present in the bundle', () => {
    // An unlisted example would never be tested against the local reader: the check would call itself
    // green without having looked at it.
    expect(manifest.fixtures.map((fixture) => fixture.path).sort()).toEqual(fixtureFilesOnDisk(CONTRACT))
  })

  it('every definition used by the fixtures has a local reader in parity', () => {
    const used = [...new Set(manifest.fixtures.map((fixture) => fixture.definition))].sort()
    expect(used).toEqual(Object.keys(READER_BY_DEFINITION).sort())
  })
})

describe('contract agent-clarification/v1 — the automator reader is tested on the official examples (DoD)', () => {
  it.each(manifest.fixtures)(
    'fixture $path: the local reader says what the contract says (valid=$valid)',
    ({path: relative, definition, valid}) => {
      const accepts = READER_BY_DEFINITION[definition]
      expect(accepts(readJson(relative)), relative).toBe(valid)
    },
  )

  it.each(manifest.fixtures.filter((fixture) => fixture.valid))(
    'fixture $path: the read state is the one written in the example',
    ({path: relative}) => {
      const example = readJson(relative) as {state: string; cycles: number; has_reply: boolean}
      // The CLI response arrives wrapped in `data`: the reader must handle both shapes.
      const wrapped = parseSystemClarificationState(JSON.stringify({data: example}))
      const bare = parseSystemClarificationState(JSON.stringify(example))

      expect(wrapped).toEqual(bare)
      expect(wrapped).toMatchObject({
        state: example.state,
        cycles: example.cycles,
        hasReply: example.has_reply,
        source: 'system',
      })
    },
  )
})

/**
 * Cases derived from the closed lists of the contract: every valid example rewritten with each allowed value
 * and with an out-of-list value. No expectation is written here — ajv gives the expected verdict.
 */
const parityCases = manifest.fixtures
  .filter((fixture) => fixture.valid)
  .flatMap((fixture) => {
    const base = readJson(fixture.path)
    return contractEnums(schema.$defs[fixture.definition], schema.$defs).flatMap((closed) =>
      [...closed.values, VALORE_FUORI_CONTRATTO].flatMap((value) => {
        const instance = withValueAt(base, closed.path, value)
        if (instance === undefined) return []
        return [{
          name: `${fixture.path} with ${closed.path.join('.')}=${JSON.stringify(value)}`,
          definition: fixture.definition,
          instance,
        }]
      }),
    )
  })

describe('contract agent-clarification/v1 — parity on the closed lists (ajv as oracle)', () => {
  it('the closed lists of the contract produce cases (the check does not run idle)', () => {
    expect(parityCases.length).toBeGreaterThan(0)
  })

  it.each(parityCases)('$name', ({definition, instance}) => {
    const expected = validatorFor(definition)(instance)
    expect(READER_BY_DEFINITION[definition](instance)).toBe(expected)
  })
})

/**
 * Probes for the `format`s declared by the contract. They are INPUTS, not expectations: ajv gives the verdict, and the
 * test only asks that the local judge says the same. They cover the shapes RFC 3339 allows and that are easy
 * to forget (space separator, lowercase, offset without colon), and those that look like dates but are not
 * (non-existent day, month out of range, missing offset).
 */
const PROBES_BY_FORMAT: Readonly<Record<string, string[]>> = Object.freeze({
  'date-time': [
    '2026-07-31T09:02:00Z',
    '2026-07-31T09:02:00.500+02:00',
    '2026-07-31t09:02:00z',
    '2026-07-31 09:02:00Z',
    '2026-07-31T09:02:00+0200',
    '2026-07-31T09:02:00',
    '2026-02-30T00:00:00Z',
    '2026-13-01T00:00:00Z',
    '2026-07-31T25:02:00Z',
    'domani',
    '',
  ],
})

const formatCases = manifest.fixtures
  .filter((fixture) => fixture.valid)
  .flatMap((fixture) => {
    const base = readJson(fixture.path)
    return contractFormats(schema.$defs[fixture.definition], schema.$defs).flatMap((declared) => {
      const probes = PROBES_BY_FORMAT[declared.format]
      if (!probes) throw new Error(`format declared by the contract without probes: ${declared.format}`)
      return probes.flatMap((value) => {
        const instance = withValueAt(base, declared.path, value)
        if (instance === undefined) return []
        return [{
          name: `${fixture.path} with ${declared.path.join('.')}=${JSON.stringify(value)}`,
          definition: fixture.definition,
          instance,
        }]
      })
    })
  })

describe('contract agent-clarification/v1 — parity on the declared formats (ajv as oracle)', () => {
  it('the contract formats produce cases (the check does not run idle)', () => {
    expect(formatCases.length).toBeGreaterThan(0)
  })

  it.each(formatCases)('$name', ({definition, instance}) => {
    const expected = validatorFor(definition)(instance)
    expect(READER_BY_DEFINITION[definition](instance)).toBe(expected)
  })
})

describe('contract agent-clarification/v1 — the wire states are the contract ones', () => {
  it('CLARIFICATION_WIRE_STATES is the closed list of the schema, not a hand-made copy', () => {
    const states = (schema.$defs.clarification_state as {properties: {state: {enum: string[]}}}).properties.state.enum
    expect([...CLARIFICATION_WIRE_STATES]).toEqual(states)
  })

  it('`unreadable` is local: it is not accepted from the wire', () => {
    // It is the CYRA-628 "I could not ask for it" signal, not a state the server can declare.
    expect(CLARIFICATION_STATES).toContain('unreadable')
    expect([...CLARIFICATION_WIRE_STATES]).not.toContain('unreadable')
    expect(parseSystemClarificationState(JSON.stringify({data: {
      state: 'unreadable', cycles: 0, has_reply: false, rounds: [],
    }}))).toBeUndefined()
  })

  it('MAX_QUESTIONS is the per-round question cap declared by the contract', () => {
    const round = schema.$defs.clarification_round as {properties: {questions: {maxItems: number}}}
    expect(MAX_QUESTIONS).toBe(round.properties.questions.maxItems)
  })
})
