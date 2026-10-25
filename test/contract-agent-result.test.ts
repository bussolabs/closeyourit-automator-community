import {createHash} from 'node:crypto'
import * as fs from 'node:fs'
import * as path from 'node:path'

import Ajv2020 from 'ajv/dist/2020'
import addFormats from 'ajv-formats'
import {describe, expect, it} from 'vitest'

import {parseWorkflowResult} from '../src/lib/typed-workflow'
import {
  type ContractManifest,
  enumParityCases,
  fixtureFilesOnDisk,
  NON_PHASE_DEFINITIONS,
  PHASE_BY_DEFINITION,
  phaseFixtures,
} from './helpers/agent-result-contract'
import {syntheticBlockedResult} from '../src/lib/unparsable-result'

// Vitest twin of the Rails `spec/contracts/agent_result_v1_spec.rb` (CYAU-97): the delivery result snapshot is
// vendored in `test/contracts/agent-result/v1` (checksum-pin twin of LOCK.json). We verify (a) the integrity
// of the vendored bytes, (b) that the fixtures validate/invalidate against the canonical schema (Draft 2020-12) and (c) that
// the automator `parseWorkflowResult` accepts the real fixtures and produces output conforming to the contract.

const CONTRACT_ROOT = path.join(import.meta.dirname, 'contracts', 'agent-result')
const CONTRACT = path.join(CONTRACT_ROOT, 'v1')

function readJson(relative: string): unknown {
  return JSON.parse(fs.readFileSync(path.join(CONTRACT, relative), 'utf8'))
}

describe('contract agent-result/v1 — checksum parity (twin of the Rails agent_result_v1_spec)', () => {
  it('the vendored snapshot matches the LOCK and every checksum', () => {
    const lock = JSON.parse(fs.readFileSync(path.join(CONTRACT_ROOT, 'LOCK.json'), 'utf8')) as {sha256sums: string}
    const sumsBuffer = fs.readFileSync(path.join(CONTRACT, 'SHA256SUMS'))
    expect(createHash('sha256').update(sumsBuffer).digest('hex')).toBe(lock.sha256sums)

    const lines = sumsBuffer.toString('utf8').split('\n').filter((line) => line.trim() !== '')
    expect(lines.length).toBeGreaterThan(0)
    for (const line of lines) {
      const separator = line.indexOf('  ./')
      expect(separator, line).toBeGreaterThan(0)
      const expected = line.slice(0, separator)
      const relative = line.slice(separator + '  ./'.length)
      const actual = createHash('sha256').update(fs.readFileSync(path.join(CONTRACT, relative))).digest('hex')
      expect(actual, relative).toBe(expected)
    }
  })

  // CYRA-598 — SHA256SUMS must list EXACTLY the files present: not one less, not one more.
  //
  // The check above walks the file LINES, so a file added and not listed is not
  // seen: it enters the bundle, does not enter the digest, and the pin keeps calling itself valid. It is the same
  // condition the canonical verifier enforces (`assert set(expected) == actual_files`) and that the
  // two twins did not have.
  //
  // The ORDER is not checked, on purpose: the canonical file is generated with the system `sort`, which
  // sorts according to the machine locale — asserting it here would give reds on a machine
  // configured differently, i.e. a false alarm instead of a check.
  //
  // The case that started all this remains uncovered: the host LOCK declared a commit whose
  // bundle differs from its own. No local check can see it — it would require reading the
  // contracts repository at the declared commit, and closeyourit-docs is private: without a
  // cross-repo credential, which today exists on neither repository, that check cannot be
  // written. A fake version that always passes was not written.
  it('SHA256SUMS lists exactly the bundle files', () => {
    const expected: string[] = []
    const scan = (dir: string, prefix: string) => {
      for (const entry of fs.readdirSync(dir, {withFileTypes: true})) {
        const relative = prefix === '' ? entry.name : `${prefix}/${entry.name}`
        if (entry.isDirectory()) scan(path.join(dir, entry.name), relative)
        else if (entry.name !== 'SHA256SUMS') expected.push(`./${relative}`)
      }
    }
    scan(CONTRACT, '')
    expected.sort()

    const listed = fs.readFileSync(path.join(CONTRACT, 'SHA256SUMS'), 'utf8')
      .split('\n').filter((line) => line.trim() !== '')
      .map((line) => line.slice(line.indexOf('  ') + 2))

    expect([...listed].sort()).toEqual(expected)
  })
})

const schema = readJson('schema.json') as {$id: string}
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

describe('contract agent-result/v1 — schema (ajv Draft 2020-12)', () => {
  it.each(manifest.fixtures)('fixture $path → $definition (valid=$valid)', ({path: relative, definition, valid}) => {
    const validate = validatorFor(definition)
    const ok = validate(readJson(relative))
    expect(ok, `${relative}: ${JSON.stringify(validate.errors)}`).toBe(valid)
  })
})

// CYRA-872 — cost and model travel next to the result: the envelope already admits them (additionalProperties). The
// day it stopped doing so, the cost delivery would break here and not on the server.
describe('contract agent-result/v1 — the envelope admits the host cost and model', () => {
  it('delivery_envelope with cost_usd and model stays valid', () => {
    const validate = validatorFor('delivery_envelope')
    const envelope = {...(readJson('fixtures/valid/delivery_envelope.json') as object), cost_usd: 0.42, model: 'claude-opus-5-5'}
    expect(validate(envelope), JSON.stringify(validate.errors)).toBe(true)
  })
})

// CYAU-188 — the two checks below are what makes the list of examples tested against zod DERIVED, and not
// hand-written: without the first an example added to the bundle but not listed would never be
// tested, without the second a new contract definition would silently vanish from the per-phase
// filter. In both cases parity would keep calling itself green on a contract that changed.
describe('contract agent-result/v1 — the manifest is the complete source of examples', () => {
  it('lists every fixture present in the bundle', () => {
    expect(manifest.fixtures.map((fixture) => fixture.path).sort()).toEqual(fixtureFilesOnDisk(CONTRACT))
  })

  it('uses only definitions mapped to a phase or declared non-phase', () => {
    const unknown = [...new Set(manifest.fixtures.map((fixture) => fixture.definition))]
      .filter((definition) => PHASE_BY_DEFINITION[definition] === undefined && !NON_PHASE_DEFINITIONS.has(definition))
    expect(unknown).toEqual([])
  })
})

describe('contract agent-result/v1 — parseWorkflowResult accepts EVERY valid example of the contract', () => {
  it.each(phaseFixtures(manifest, true))('$phase: accepts $path and produces output conforming to $definition',({path: relative, phase, definition}) => {
    const parsed = parseWorkflowResult(JSON.stringify(readJson(relative)), phase)
    expect(parsed, `${relative}: parse null`).not.toBeNull()
    const validate = validatorFor(definition)
    expect(validate(parsed), `${relative}: ${JSON.stringify(validate.errors)}`).toBe(true)
  })
})

// CYAU-192 — the phases that stay on the v1 contract (triage and the two closers) receive a synthetic `blocked` in
// v1 shape: `causa: 'unreachable'` is what the server reads to put the phase back in the queue. Triage has no
// `blocked`: `escalated` is the state the server treats the same way, and the reason sits in `reasons`.
describe('contract agent-result/v1 — the host synthetic blocked (CYAU-192) validates per phase', () => {
  const cases: Array<{phase: ExecutionPhase; definition: string; expected: Record<string, unknown>}> = [
    {phase: 'triage', definition: 'triage_result',
      expected: {state: 'escalated', causa: 'unreachable', requires_human_approval: true, reasons: [expect.stringMatching(/^Risultato non interpretabile: /u)]}},
    {phase: 'closer_staging', definition: 'closer_staging_result', expected: {state: 'blocked', tag: null, causa: 'unreachable'}},
    {phase: 'closer_production', definition: 'closer_production_result', expected: {state: 'blocked', tag: null, causa: 'unreachable'}},
  ]

  it.each(cases)('$phase → $definition', ({phase, definition, expected}) => {
    const synthetic = syntheticBlockedResult({
      phase, code: 'CYRA-199', issues: ['state: Invalid enum value, received \'done\''], stdout: 'Done.',
    })
    const validate = validatorFor(definition)
    expect(validate(synthetic), JSON.stringify(validate.errors)).toBe(true)
    expect(synthetic).toMatchObject({code: 'CYRA-199', ...expected})
    expect(parseWorkflowResult(JSON.stringify(synthetic), phase)).not.toBeNull()
  })
})

describe('contract agent-result/v1 — parseWorkflowResult rejects EVERY invalid example of the contract', () => {
  it.each(phaseFixtures(manifest, false))('$phase: rejects $path ($definition)', ({path: relative, phase}) => {
    expect(parseWorkflowResult(JSON.stringify(readJson(relative)), phase)).toBeNull()
  })
})

// CYAU-188 — the fixtures test TODAY's contract; this tests its RULES. Closed lists are the
// point where the hand-written zod diverges most easily and most silently: a value not copied over passes
// the local check and is rejected by the server once the work is done, burning an attempt to discover it
// on the other side. Here the expectation is not written: the canonical schema dictates it, and the local check must
// say the same.
describe('contract agent-result/v1 — closed lists hold exactly as in the contract', () => {
  const enumCases = enumParityCases(manifest, (schema as {$defs: Record<string, unknown>}).$defs, readJson)

  it('the contract declares closed lists to test', () => {
    expect(enumCases.length).toBeGreaterThan(0)
  })

  it.each(enumCases)('$phase: $name', ({name, definition, instance, phase}) => {
    const validate = validatorFor(definition)
    const expected = validate(instance)
    expect(parseWorkflowResult(JSON.stringify(instance), phase) !== null, `${name}: ${JSON.stringify(validate.errors)}`).toBe(expected)
  })
})
