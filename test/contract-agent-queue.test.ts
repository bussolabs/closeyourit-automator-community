import {createHash} from 'node:crypto'
import * as fs from 'node:fs'
import * as path from 'node:path'

import Ajv2020 from 'ajv/dist/2020'
import addFormats from 'ajv-formats'
import {describe, expect, it, vi} from 'vitest'

import {makeClient} from '../src/lib/client'
import {type SyncConfig} from '../src/lib/config'

// Vitest twin of the Rails `spec/contracts/agent_queue_v1_spec.rb` (CYAU-94): the host-first snapshot of the agent
// queue is vendored in `test/contracts/agent-queue/v1` (checksum pin twin of LOCK.json). Here we verify
// (a) the integrity of the vendored bytes, (b) that the fixtures validate/invalidate against the canonical schema
// (Draft 2020-12), (c) that the automator client produces the wire required by the contract and (d) maps its responses.

const CONTRACT_ROOT = path.join(import.meta.dirname, 'contracts', 'agent-queue')
const CONTRACT = path.join(CONTRACT_ROOT, 'v1')

function readJson(relative: string): unknown {
  return JSON.parse(fs.readFileSync(path.join(CONTRACT, relative), 'utf8'))
}

describe('contract agent-queue/v1 — checksum parity (twin of the Rails agent_queue_v1_spec)', () => {
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
const schema = readJson('schema.json') as {$id: string}
const ajv = new Ajv2020({allErrors: true, strict: false})
addFormats(ajv)
ajv.addSchema(schema)

type Validator = ((data: unknown) => boolean) & {errors?: unknown}

function validatorFor(definition: string): Validator {
  const validate = ajv.getSchema(`${schema.$id}#/$defs/${definition}`)
  if (!validate) throw new Error(`definizione non trovata nello schema del contratto: ${definition}`)
  return validate as unknown as Validator
}

describe('contract agent-queue/v1 — schema (ajv Draft 2020-12)', () => {
  const manifest = readJson('manifest.json') as {
    fixtures: Array<{path: string; definition: string; valid: boolean}>
  }

  it.each(manifest.fixtures)('fixture $path → $definition (valid=$valid)', ({path: relative, definition, valid}) => {
    const validate = validatorFor(definition)
    const ok = validate(readJson(relative))
    expect(ok, `${relative}: ${JSON.stringify(validate.errors)}`).toBe(valid)
  })
})

const cfg: SyncConfig = {orgToken: 'cyi_a_secret'}
const HOST_TOKEN = 'cyi_ah_host'
const HOST_UUID = '22222222-2222-4222-8222-222222222222'
const claimRequest = {selection_token: 'opaque', host_id: HOST_UUID, run_id: 'run-42', ttl_seconds: 3600}

function fakeFetch(res: {ok: boolean; status?: number; json?: unknown}) {
  const calls: Array<{url: string; opts: RequestInit}> = []
  const fn = vi.fn(async (url: string | URL, opts?: RequestInit) => {
    calls.push({url: String(url), opts: opts ?? {}})
    return {ok: res.ok, status: res.status ?? (res.ok ? 200 : 500), json: async () => res.json} as unknown as Response
  })
  return {fn: fn as unknown as typeof globalThis.fetch, calls}
}

describe('contract agent-queue/v1 — client wire request (host-first)', () => {
  const validateClaimRequest = validatorFor('claim_request')

  it('claimTicketQueue POSTs the contract claim_request with the host bearer', async () => {
    const {fn, calls} = fakeFetch({ok: true, status: 201, json: {data: {
      ticket: 'CYAU-1', host_id: HOST_UUID, run_id: 'run-42', agent: 'ticket-worker',
      attempt_id: '55555555-5555-4555-8555-555555555555', expires_at: '2026-07-14T13:00:00.000Z',
    }}})
    await makeClient(cfg, fn, HOST_TOKEN).claimTicketQueue(claimRequest)
    // Host-first (CYAU-84): flattened claim, no agent_id in the URL.
    expect(calls[0].url).toBe('https://app.closeyour.it/api/v1/ticket_queue/claims')
    expect(calls[0].opts.method).toBe('POST')
    expect((calls[0].opts.headers as Record<string, string>).Authorization).toBe(`Bearer ${HOST_TOKEN}`)
    const body = JSON.parse(calls[0].opts.body as string)
    expect(validateClaimRequest(body), JSON.stringify(validateClaimRequest.errors)).toBe(true)
  })

  it('getTicketQueue queries the host-scoped next channel with the host bearer', async () => {
    const {fn, calls} = fakeFetch({ok: true, json: {data: null}})
    await makeClient(cfg, fn, HOST_TOKEN).getTicketQueue('CYAU')
    // Host-first (CYAU-84): flattened queue, no agent_id in the URL.
    expect(calls[0].url).toBe('https://app.closeyour.it/api/v1/ticket_queue?project_key=CYAU')
    expect(calls[0].opts.method).toBe('GET')
    expect((calls[0].opts.headers as Record<string, string>).Authorization).toBe(`Bearer ${HOST_TOKEN}`)
  })
})

describe('contract agent-queue/v1 — mapping of the claim golden responses', () => {
  it('201 acquired → acquired outcome with the contract attempt_id', async () => {
    const {fn} = fakeFetch({ok: true, status: 201, json: readJson('fixtures/valid/claim_response_acquired.json')})
    const result = await makeClient(cfg, fn, HOST_TOKEN).claimTicketQueue(claimRequest)
    expect(result.outcome).toBe('acquired')
    if (result.outcome !== 'acquired') throw new Error('atteso outcome acquired')
    expect(result.lease.attempt_id).toBe('55555555-5555-4555-8555-555555555555')
  })

  it('409 R409-QUEUE-001 → stale (selection no longer eligible)', async () => {
    const {fn} = fakeFetch({ok: false, status: 409, json: readJson('fixtures/valid/claim_response_stale.json')})
    expect((await makeClient(cfg, fn, HOST_TOKEN).claimTicketQueue(claimRequest)).outcome).toBe('stale')
  })

  it('409 R409-LEASE-001 → held with the contract holder', async () => {
    const {fn} = fakeFetch({ok: false, status: 409, json: readJson('fixtures/valid/claim_response_held.json')})
    const result = await makeClient(cfg, fn, HOST_TOKEN).claimTicketQueue(claimRequest)
    expect(result.outcome).toBe('held')
    if (result.outcome === 'acquired') throw new Error('non deve essere acquired')
    expect(result.lease?.host_id).toBe('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa')
  })

  it('422 → invalid', async () => {
    const {fn} = fakeFetch({ok: false, status: 422, json: {error: {code: 'R422-QUEUE-001', message: 'Token opaco non valido'}}})
    expect((await makeClient(cfg, fn, HOST_TOKEN).claimTicketQueue(claimRequest)).outcome).toBe('invalid')
  })
})
