import {createHash} from 'node:crypto'
import * as fs from 'node:fs'
import * as path from 'node:path'

import Ajv2020 from 'ajv/dist/2020'
import addFormats from 'ajv-formats'
import {describe, expect, it} from 'vitest'

import {parseWorkflowResult} from '../src/lib/typed-workflow'
import {type ContractManifest, phaseFixtures} from './helpers/agent-result-contract'

// CYRA-1316 — v3 changes only the planner: it proves the ticket's acceptance items instead of keeping its own lists.
const CONTRACT = path.join(import.meta.dirname, 'contracts', 'agent-result', 'v3')
const readJson = (relative: string): unknown => JSON.parse(fs.readFileSync(path.join(CONTRACT, relative), 'utf8'))
const asV3 = (fixture: unknown): string => JSON.stringify({...(fixture as Record<string, unknown>), contract_version: 3})

describe('contract agent-result/v3', () => {
  const schema = readJson('schema.json') as {$id: string}
  const ajv = new Ajv2020({allErrors: true, strict: false})
  addFormats(ajv)
  ajv.addSchema(schema)
  const manifest = readJson('manifest.json') as ContractManifest

  it('the vendored bundle is the pinned one', () => {
    const lock = JSON.parse(fs.readFileSync(path.join(CONTRACT, '..', 'LOCK.v3.json'), 'utf8')) as {sha256sums: string}
    const sums = fs.readFileSync(path.join(CONTRACT, 'SHA256SUMS'))
    expect(createHash('sha256').update(sums).digest('hex')).toBe(lock.sha256sums)
  })

  it.each(manifest.fixtures)('$path → $definition (valid=$valid)', ({path: relative, definition, valid}) => {
    const validate = ajv.getSchema(`${schema.$id}#/$defs/${definition}`)
    expect(validate!(readJson(relative)), JSON.stringify(validate!.errors)).toBe(valid)
  })

  it.each(phaseFixtures(manifest, true))('$phase: the parser accepts $path', ({path: relative, phase, definition}) => {
    const parsed = parseWorkflowResult(asV3(readJson(relative)), phase)
    expect(parsed, `${relative}: parse null`).not.toBeNull()
    expect(ajv.getSchema(`${schema.$id}#/$defs/${definition}`)!(parsed)).toBe(true)
  })

  it.each(phaseFixtures(manifest, false))('$phase: the parser rejects $path', ({path: relative, phase}) => {
    expect(parseWorkflowResult(asV3(readJson(relative)), phase)).toBeNull()
  })
})
