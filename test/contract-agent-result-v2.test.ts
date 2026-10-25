import {createHash} from 'node:crypto'
import * as fs from 'node:fs'
import * as path from 'node:path'

import Ajv2020 from 'ajv/dist/2020'
import addFormats from 'ajv-formats'
import {describe, expect, it} from 'vitest'

import {type ExecutionPhase} from '../src/lib/phase-profile'
import {parseWorkflowResult} from '../src/lib/typed-workflow'
import {syntheticBlockedResult} from '../src/lib/unparsable-result'
import {
  type ContractManifest,
  enumParityCases,
  fixtureFilesOnDisk,
  NON_PHASE_DEFINITIONS,
  PHASE_BY_DEFINITION,
  phaseFixtures,
} from './helpers/agent-result-contract'

const CONTRACT = path.join(import.meta.dirname, 'contracts', 'agent-result', 'v2')
const readJson = (relative: string): unknown => JSON.parse(fs.readFileSync(path.join(CONTRACT, relative), 'utf8'))

/**
 * CYAU-188 — `parseWorkflowResult` picks the v2 schema only if the result carries `contract_version: 2`, and
 * every fixture of this bundle is by definition a v2 example: the marker must therefore be imposed before the
 * parse, otherwise a fixture that does not declare it would be judged with the v1 schema and the parity check
 * would say something about the wrong version.
 *
 * It is the case of `planner_legacy_shape`, which WEARS the v1 shape: without the marker the v1 zod would
 * accept it, which is exactly the disguise to prevent. By imposing it, the example is rejected for its
 * SHAPE and not for the missing version — a stronger assertion, not a weaker one.
 */
const asV2 = (fixture: unknown): string =>
  JSON.stringify({...(fixture as Record<string, unknown>), contract_version: 2})

describe('contract agent-result/v2', () => {
  const schema = readJson('schema.json') as {$id: string}
  const ajv = new Ajv2020({allErrors: true, strict: false})
  addFormats(ajv)
  ajv.addSchema(schema)
  const manifest = readJson('manifest.json') as ContractManifest

  it('SHA256SUMS lists exactly the bundle and every file matches', () => {
    const lock = JSON.parse(fs.readFileSync(path.join(CONTRACT, '..', 'LOCK.v2.json'), 'utf8')) as {sha256sums: string}
    const sums = fs.readFileSync(path.join(CONTRACT, 'SHA256SUMS'))
    expect(createHash('sha256').update(sums).digest('hex')).toBe(lock.sha256sums)
    const files: string[] = []
    const scan = (dir: string, prefix = '') => {
      for (const entry of fs.readdirSync(dir, {withFileTypes: true})) {
        const relative = prefix === '' ? entry.name : `${prefix}/${entry.name}`
        if (entry.isDirectory()) scan(path.join(dir, entry.name), relative)
        else if (entry.name !== 'SHA256SUMS') files.push(`./${relative}`)
      }
    }
    scan(CONTRACT)
    const lines = fs.readFileSync(path.join(CONTRACT, 'SHA256SUMS'), 'utf8').trim().split('\n')
    expect(lines.map((line) => line.slice(line.indexOf('  ') + 2)).sort()).toEqual(files.sort())
    for (const line of lines) {
      const separator = line.indexOf('  ./')
      const relative = line.slice(separator + 4)
      const actual = createHash('sha256').update(fs.readFileSync(path.join(CONTRACT, relative))).digest('hex')
      expect(actual, relative).toBe(line.slice(0, separator))
    }
  })

  it.each(manifest.fixtures)('$path → $definition (valid=$valid)', ({path: relative, definition, valid}) => {
    const validate = ajv.getSchema(`${schema.$id}#/$defs/${definition}`)
    expect(validate).toBeDefined()
    expect(validate!(readJson(relative)), JSON.stringify(validate!.errors)).toBe(valid)
  })

  // CYAU-188 — as for v1: the list of the examples tested against the zod is DERIVED from the manifest, and the two
  // checks below are what keeps that derivation honest.
  it('the manifest lists every fixture present in the bundle', () => {
    expect(manifest.fixtures.map((fixture) => fixture.path).sort()).toEqual(fixtureFilesOnDisk(CONTRACT))
  })

  it('the manifest uses only definitions mapped to a phase or declared non-phase', () => {
    const sconosciute = [...new Set(manifest.fixtures.map((fixture) => fixture.definition))]
      .filter((definition) => PHASE_BY_DEFINITION[definition] === undefined && !NON_PHASE_DEFINITIONS.has(definition))
    expect(sconosciute).toEqual([])
  })

  it.each(phaseFixtures(manifest, true))('$phase: the parser accepts $path and produces output conforming to $definition', ({path: relative, phase, definition}) => {
    const parsed = parseWorkflowResult(asV2(readJson(relative)), phase)
    const validate = ajv.getSchema(`${schema.$id}#/$defs/${definition}`)!
    expect(parsed, `${relative}: parse null`).not.toBeNull()
    expect(validate(parsed), `${relative}: ${JSON.stringify(validate.errors)}`).toBe(true)
  })

  it.each(phaseFixtures(manifest, false))('$phase: the parser rejects $path ($definition)', ({path: relative, phase}) => {
    expect(parseWorkflowResult(asV2(readJson(relative)), phase)).toBeNull()
  })

  // CYAU-188 — as for v1: the canonical schema dictates the expectation, the local check must only say the
  // same. Here it weighs more, because the v2 bundle carries examples only for the two phases whose shape changed:
  // on the closed lists of the others there is no fixture acting as a net.
  describe('the closed lists hold exactly as much as in the contract', () => {
    const casi = enumParityCases(manifest, (schema as unknown as {$defs: Record<string, unknown>}).$defs, readJson, (instance) => JSON.parse(asV2(instance)))

    it('the contract declares closed lists to test', () => {
      expect(casi.length).toBeGreaterThan(0)
    })

    it.each(casi)('$phase: $name', ({name, definition, instance, phase}) => {
      const validate = ajv.getSchema(`${schema.$id}#/$defs/${definition}`)!
      const atteso = validate(instance) as boolean
      expect(parseWorkflowResult(JSON.stringify(instance), phase) !== null, `${name}: ${JSON.stringify(validate.errors)}`).toBe(atteso)
    })
  })

  /**
   * CYAU-188 — the v2 bundle carries examples only for planner and autopilot, but the schema also DECLARES triage and the
   * two closers: for the contract a result of those phases with `contract_version: 2` is valid, and the host must
   * be able to read it. A missing example is not a permission not to interpret it — it is just a missing example,
   * and as long as the local check rejects that shape the phase runs idle: uninterpretable result,
   * no delivery, ticket back in the queue.
   *
   * The candidate is taken from the v2 bundle if present, otherwise from the v1 examples of the same definition with the
   * version marker: they are the same shape, and it is exactly what the v2 contract redeclares.
   */
  describe('every result definition declared by the contract is interpretable', () => {
    const V1 = path.join(CONTRACT, '..', 'v1')
    const manifestV1 = JSON.parse(fs.readFileSync(path.join(V1, 'manifest.json'), 'utf8')) as ContractManifest
    const definizioni = Object.keys((schema as unknown as {$defs: Record<string, unknown>}).$defs)
      .filter((definition) => PHASE_BY_DEFINITION[definition] !== undefined)

    const candidato = (definition: string): unknown => {
      const daV2 = phaseFixtures(manifest, true).find((fixture) => fixture.definition === definition)
      if (daV2) return JSON.parse(asV2(readJson(daV2.path)))
      const daV1 = phaseFixtures(manifestV1, true).find((fixture) => fixture.definition === definition)
      if (!daV1) throw new Error(`nessun esempio valido per ${definition} in v2 né in v1`)
      return JSON.parse(asV2(JSON.parse(fs.readFileSync(path.join(V1, daV1.path), 'utf8'))))
    }

    it.each(definizioni)('%s', (definition) => {
      const instance = candidato(definition)
      const validate = ajv.getSchema(`${schema.$id}#/$defs/${definition}`)!
      expect(validate(instance), `candidato non conforme allo schema v2: ${JSON.stringify(validate.errors)}`).toBe(true)
      expect(parseWorkflowResult(JSON.stringify(instance), PHASE_BY_DEFINITION[definition])).not.toBeNull()
    })
  })

  // CYAU-192 — the `blocked` the host composes in place of an unreadable result travels on the same PUT
  // as every delivery and the server revalidates it against THIS schema: if it does not pass here, the ticket stays mute
  // exactly as before, with one more rejection in the log.
  it.each([
    ['planner', 'planner_result'],
    ['autopilot', 'autopilot_result'],
  ] as Array<[ExecutionPhase, string]>)('the host synthetic blocked for %s validates against %s', (phase, definition) => {
    const synthetic = syntheticBlockedResult({
      phase, code: 'CYRA-660',
      issues: ['failure.category: Invalid enum value. Expected \'authentication\' | \'unknown\', received \'git_auth\''],
      stdout: 'prosa e poi {"failure":{"category":"git_auth"}}',
    })
    const validate = ajv.getSchema(`${schema.$id}#/$defs/${definition}`)!
    expect(validate(synthetic), JSON.stringify(validate.errors)).toBe(true)
    expect(synthetic).toMatchObject({
      contract_version: 2, code: 'CYRA-660', state: 'blocked', security_findings: [],
      failure: {category: 'unknown', retryable: true, summary: expect.stringMatching(/^Risultato non interpretabile: failure\.category/u)},
    })
    // The local parser accepts it too: the same barrier that rejected the original.
    expect(parseWorkflowResult(JSON.stringify(synthetic), phase)).not.toBeNull()
  })
})
