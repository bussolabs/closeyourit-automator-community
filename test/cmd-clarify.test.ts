import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest'
import Clarify from '../src/commands/clarify'
import {type ClarificationStatus} from '../src/lib/clarification'
import {runCaptured, runExpectingExit} from './helpers/command'

// The `clarify` command (CYAU-22) is the clarification gate: having read the cycle state (contract
// `agent-clarification/v1`) it decides whether the ticket is workable automatically or is waiting for an answer.
// A waiting ticket does NOT hold the slot → the orchestrator skips it (exit 3) and continues the queue; an answer
// makes it workable again (exit 0). Safe-by-default shell gate (like cycle/review/lease): workable → 0;
// waiting/escalated/unreadable → 3; invalid input → 2.
//
// CYAU-189 — the state comes from the SYSTEM, no longer from a regex on the comments copied by hand from the server. Here the
// system reader is fake: really asking would mean a network call inside a test.

const sistema = vi.hoisted(() => ({
  stato: undefined as ClarificationStatus | undefined,
  chiamate: [] as Array<{ticket: string; project: string}>,
}))

vi.mock('../src/lib/clarification', async (importOriginal) => {
  const vero = await importOriginal<typeof import('../src/lib/clarification')>()
  return {
    ...vero,
    readClarificationState(ticket: string, project: string): ClarificationStatus {
      sistema.chiamate.push({ticket, project})
      return sistema.stato ?? {state: 'unreadable', cycles: 0, hasReply: false, source: 'unreadable'}
    },
  }
})

let dir: string
const savedEnv = {...process.env}

/** The cycle state in the contract format, as returned by `cyi tickets clarifications --json`. */
function stato(over: Partial<Record<string, unknown>> = {}): Record<string, unknown> {
  return {state: 'ready', cycles: 0, has_reply: false, rounds: [], ...over}
}

/** A contract question round (1..3 questions, `response` null until someone answered). */
function giro(cycle: number, response: string | null = null): Record<string, unknown> {
  return {
    cycle,
    questions: [`Domanda del giro ${cycle}?`],
    response,
    answered_at: response === null ? null : '2026-07-31T09:12:00Z',
    created_at: '2026-07-31T09:02:00Z',
  }
}

function writeState(payload: unknown, wrap = true): string {
  const file = path.join(dir, `clarifications-${fs.readdirSync(dir).length}.json`)
  fs.writeFileSync(file, JSON.stringify(wrap ? {data: payload} : payload))
  return file
}

interface ClarifyPayload {
  action: string
  state: string
  cycles: number
  cycle: number
  limit: number
  hasReply: boolean
  source: string | null
  workable: boolean
  requiresHuman: boolean
  phase: string | null
  reasons: string[]
  code: string | null
  error?: {code: string; message: string}
}

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'automator-clarify-'))
  sistema.stato = undefined
  sistema.chiamate.length = 0
})

afterEach(() => {
  process.env = {...savedEnv}
  fs.rmSync(dir, {recursive: true, force: true})
})

describe('clarify command — workability (DoD: an answer makes the ticket workable again)', () => {
  it('no question round and no missing decision → proceed, exit 0', async () => {
    const file = writeState(stato())
    const {result} = await runCaptured(Clarify, ['--state-file', file, '--json'])
    const p = result as ClarifyPayload
    expect(p.action).toBe('proceed')
    expect(p.workable).toBe(true)
    expect(p.source).toBe('system')
  })

  it('an answer to the last round → resume, exit 0 (workable again)', async () => {
    const file = writeState(stato({cycles: 1, has_reply: true, rounds: [giro(1, 'Sì, procedi con A')]}))
    const {result} = await runCaptured(Clarify, ['--state-file', file, '--json'])
    const p = result as ClarifyPayload
    expect(p.action).toBe('resume')
    expect(p.workable).toBe(true)
    expect(p.hasReply).toBe(true)
    expect(p.cycles).toBe(1)
  })
})

describe('clarify command — Scenario 1: a waiting ticket does not hold the slot', () => {
  it('a decision is missing and no question yet → ask, exit 3 (the server publishes the comment)', async () => {
    const file = writeState(stato())
    const {stdout, stderr} = await runExpectingExit(
      Clarify,
      ['--state-file', file, '--needs-decision', '--json'],
      3,
    )
    const p = JSON.parse(stdout) as ClarifyPayload
    expect(p.action).toBe('ask')
    expect(p.cycle).toBe(1)
    expect(p.workable).toBe(false)
    expect(p.error?.code).toBe('C409-CLARIFY-002')
    expect(stderr).toBe('')
  })

  it('a pending question without answer (last round) → wait, exit 3 (free slot, does not duplicate)', async () => {
    const file = writeState(stato({state: 'waiting', cycles: 1, rounds: [giro(1)]}))
    const {stderr} = await runExpectingExit(Clarify, ['--state-file', file], 3)
    expect(stderr).toContain('C409-CLARIFY-002')
  })

  it('human output reports that the slot must be released and the queue continues', async () => {
    const file = writeState(stato({state: 'waiting', cycles: 1, rounds: [giro(1)]}))
    const {stdout} = await runExpectingExit(Clarify, ['--state-file', file], 3)
    expect(stdout.toLowerCase()).toContain('slot')
  })
})

describe('clarify command — massimo due cicli, poi escalation', () => {
  it('at the two-cycle limit with a missing decision → escalate, exit 3', async () => {
    const file = writeState(stato({
      cycles: 2, has_reply: true, rounds: [giro(1, 'prima risposta'), giro(2, 'seconda risposta insufficiente')],
    }))
    const {stdout} = await runExpectingExit(
      Clarify,
      ['--state-file', file, '--needs-decision', '--json'],
      3,
    )
    const p = JSON.parse(stdout) as ClarifyPayload
    expect(p.action).toBe('escalate')
    expect(p.requiresHuman).toBe(true)
    expect(p.error?.code).toBe('C409-CLARIFY-003')
  })

  it('an already escalated ticket stays escalated → exit 3, C409-CLARIFY-003', async () => {
    const file = writeState(stato({state: 'escalated', cycles: 2, rounds: [giro(1, 'r'), giro(2)]}))
    const {stderr} = await runExpectingExit(Clarify, ['--state-file', file], 3)
    expect(stderr).toContain('C409-CLARIFY-003')
  })

  it('--limit 3 grants a third clarification cycle', async () => {
    const file = writeState(stato({cycles: 2, has_reply: true, rounds: [giro(1, 'r'), giro(2, 'r')]}))
    const {stdout} = await runExpectingExit(
      Clarify,
      ['--state-file', file, '--needs-decision', '--limit', '3', '--json'],
      3,
    )
    const p = JSON.parse(stdout) as ClarifyPayload
    expect(p.action).toBe('ask')
    expect(p.cycle).toBe(3)
    expect(p.limit).toBe(3)
  })
})

describe('clarify command — state source and input defence', () => {
  it('with --code and --project the state is asked of the system', async () => {
    sistema.stato = {state: 'waiting', cycles: 1, hasReply: false, source: 'system'}
    const {stderr} = await runExpectingExit(Clarify, ['--code', 'CYAU-22', '--project', 'CYAU'], 3)

    expect(sistema.chiamate).toEqual([{ticket: 'CYAU-22', project: 'CYAU'}])
    expect(stderr).toContain('C409-CLARIFY-002')
  })

  // Fail-closed: failing to ask is not "no question in progress".
  it('state not readable from the system → exit 3, not a green light', async () => {
    sistema.stato = {state: 'unreadable', cycles: 0, hasReply: false, source: 'unreadable'}
    const {stdout} = await runExpectingExit(Clarify, ['--code', 'CYAU-22', '--project', 'CYAU', '--json'], 3)

    const p = JSON.parse(stdout) as ClarifyPayload
    expect(p.action).toBe('wait')
    expect(p.state).toBe('unreadable')
    expect(p.workable).toBe(false)
  })

  it('accepts a file with the bare response (without data wrapper)', async () => {
    const file = writeState(stato({cycles: 1, has_reply: true, rounds: [giro(1, 'risposta')]}), false)
    const {result} = await runCaptured(Clarify, ['--state-file', file, '--json'])
    expect((result as ClarifyPayload).action).toBe('resume')
  })

  it('without a state source → exit 2 (not knowing is not "no question")', async () => {
    const {stderr} = await runExpectingExit(Clarify, [], 2)
    expect(stderr).toContain('C400-CLARIFY-001')
    expect(sistema.chiamate).toEqual([])
  })

  it('--code without --project → exit 2', async () => {
    const {stderr} = await runExpectingExit(Clarify, ['--code', 'CYAU-22'], 2)
    expect(stderr).toContain('C400-CLARIFY-001')
  })

  it('file inesistente → exit 2, C400-CLARIFY-001', async () => {
    const {stderr} = await runExpectingExit(Clarify, ['--state-file', path.join(dir, 'nope.json')], 2)
    expect(stderr).toContain('C400-CLARIFY-001')
  })

  it('JSON illegale → exit 2', async () => {
    const file = path.join(dir, 'bad.json')
    fs.writeFileSync(file, '{ non json')
    const {stderr} = await runExpectingExit(Clarify, ['--state-file', file], 2)
    expect(stderr).toContain('C400-CLARIFY-001')
  })

  it('a state outside the contract → exit 2, mentioning the contract', async () => {
    // `waiting` without even one round is a contradiction: there is a wait, but nothing explaining it.
    const file = writeState(stato({state: 'waiting', cycles: 1}))
    const {stderr} = await runExpectingExit(Clarify, ['--state-file', file], 2)
    expect(stderr).toContain('C400-CLARIFY-001')
    expect(stderr).toContain('agent-clarification/v1')
  })

  it('--limit not a positive integer → exit 2', async () => {
    const file = writeState(stato())
    const {stderr} = await runExpectingExit(Clarify, ['--state-file', file, '--limit', '0'], 2)
    expect(stderr).toContain('C400-CLARIFY-001')
  })
})

describe('clarify command — output', () => {
  it('--json does not print the human-readable lines', async () => {
    const file = writeState(stato())
    const {stdout} = await runCaptured(Clarify, ['--state-file', file, '--json'])
    expect(stdout).not.toContain('clarify ·')
  })

  it('human output shows state, action and ticket code', async () => {
    const file = writeState(stato({cycles: 1, has_reply: true, rounds: [giro(1, 'risposta')]}))
    const {stdout} = await runCaptured(Clarify, ['--state-file', file, '--code', 'CYAU-22'])
    const low = stdout.toLowerCase()
    expect(low).toContain('cyau-22')
    expect(low).toContain('resume')
  })

  it('with an answer but --needs-decision asks for a NEW round at cycle 2', async () => {
    const file = writeState(stato({cycles: 1, has_reply: true, rounds: [giro(1, 'risposta parziale')]}))
    const {stdout} = await runExpectingExit(
      Clarify,
      ['--state-file', file, '--needs-decision', '--json'],
      3,
    )
    const p = JSON.parse(stdout) as ClarifyPayload
    expect(p.action).toBe('ask')
    expect(p.cycle).toBe(2)
  })
})
