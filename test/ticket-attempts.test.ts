import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import {afterAll, describe, expect, it} from 'vitest'
import {
  addTicketAttemptCost,
  DEFAULT_MAX_TICKET_ATTEMPTS,
  evaluateTicketAttempts,
  listTicketAttempts,
  maxTicketAttempts,
  readTicketAttempts,
  recordTicketAttempt,
  resetTicketAttempts,
  ticketAttemptsPath,
} from '../src/lib/ticket-attempts'

// CYAU-155: the per-ticket counter is the only memory surviving between one tick and the next. Without it, a
// ticket that always fails the same way restarts forever (31 attempts, 5 dollars, real case).

const dirs: string[] = []

function tempDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'attempts-'))
  dirs.push(dir)
  return dir
}

afterAll(() => {
  for (const dir of dirs) fs.rmSync(dir, {recursive: true, force: true})
})

const at = (iso: string) => new Date(iso)

describe('ticketAttemptsPath', () => {
  it('one file per ticket, with project and code sanitized in the name', () => {
    const file = ticketAttemptsPath('CYAU', 'CYAU-155', '/state/ticket-attempts')
    expect(file).toBe('/state/ticket-attempts/CYAU__CYAU-155.json')
  })

  it('a hostile code does not escape the store directory', () => {
    const file = ticketAttemptsPath('CYAU', '../../etc/passwd', '/state/ticket-attempts')
    expect(path.dirname(file)).toBe('/state/ticket-attempts')
    expect(file).not.toContain('..')
  })

  it('empty project or code → error, never a file shared between different tickets', () => {
    expect(() => ticketAttemptsPath('', 'CYAU-155', '/state')).toThrow()
    expect(() => ticketAttemptsPath('CYAU', '   ', '/state')).toThrow()
  })
})

describe('recordTicketAttempt', () => {
  it('first attempt: creates the record with the counters at one', () => {
    const dir = tempDir()
    const record = recordTicketAttempt({project: 'CYAU', ticket: 'CYAU-155', phase: 'autopilot', now: at('2026-08-15T10:00:00Z')}, dir)

    expect(record).toMatchObject({
      project: 'CYAU', ticket: 'CYAU-155', phase: 'autopilot',
      attempts: 1, total_attempts: 1, cost: 0, total_cost: 0,
      first_at: '2026-08-15T10:00:00.000Z', updated_at: '2026-08-15T10:00:00.000Z',
    })
    expect(readTicketAttempts('CYAU', 'CYAU-155', dir)).toEqual({record, corrupt: false})
  })

  it('same phase: the attempts accumulate between one tick and the next', () => {
    const dir = tempDir()
    recordTicketAttempt({project: 'CYAU', ticket: 'CYAU-155', phase: 'autopilot', now: at('2026-08-15T10:00:00Z')}, dir)
    const second = recordTicketAttempt({project: 'CYAU', ticket: 'CYAU-155', phase: 'autopilot', now: at('2026-08-15T11:00:00Z')}, dir)

    expect(second.attempts).toBe(2)
    expect(second.total_attempts).toBe(2)
    expect(second.first_at).toBe('2026-08-15T10:00:00.000Z')
    expect(second.updated_at).toBe('2026-08-15T11:00:00.000Z')
  })

  it('advanced phase: the consecutive count restarts, the ticket total does not', () => {
    const dir = tempDir()
    recordTicketAttempt({project: 'CYAU', ticket: 'CYAU-155', phase: 'triage', now: at('2026-08-15T10:00:00Z')}, dir)
    addTicketAttemptCost({project: 'CYAU', ticket: 'CYAU-155', cost: 1.5, now: at('2026-08-15T10:30:00Z')}, dir)
    const advanced = recordTicketAttempt({project: 'CYAU', ticket: 'CYAU-155', phase: 'planner', now: at('2026-08-15T11:00:00Z')}, dir)

    expect(advanced).toMatchObject({phase: 'planner', attempts: 1, total_attempts: 2, cost: 0, total_cost: 1.5})
  })

  it('tickets of different projects do not share the counter', () => {
    const dir = tempDir()
    recordTicketAttempt({project: 'CYAU', ticket: 'CYAU-155', phase: 'autopilot', now: at('2026-08-15T10:00:00Z')}, dir)
    const other = recordTicketAttempt({project: 'CYRA', ticket: 'CYRA-298', phase: 'autopilot', now: at('2026-08-15T10:00:00Z')}, dir)

    expect(other.attempts).toBe(1)
    expect(readTicketAttempts('CYAU', 'CYAU-155', dir).record?.attempts).toBe(1)
  })

  it('unreadable record: throws instead of restarting from zero (never lose the count)', () => {
    const dir = tempDir()
    fs.mkdirSync(dir, {recursive: true})
    fs.writeFileSync(ticketAttemptsPath('CYAU', 'CYAU-155', dir), '{ non json')

    expect(() => recordTicketAttempt({project: 'CYAU', ticket: 'CYAU-155', phase: 'autopilot'}, dir)).toThrow()
  })
})

describe('addTicketAttemptCost', () => {
  it('accumulates the real session spend on the phase and on the ticket', () => {
    const dir = tempDir()
    recordTicketAttempt({project: 'CYAU', ticket: 'CYAU-155', phase: 'autopilot', now: at('2026-08-15T10:00:00Z')}, dir)
    addTicketAttemptCost({project: 'CYAU', ticket: 'CYAU-155', cost: 0.25, now: at('2026-08-15T10:10:00Z')}, dir)
    const updated = addTicketAttemptCost({project: 'CYAU', ticket: 'CYAU-155', cost: 0.75, now: at('2026-08-15T10:20:00Z')}, dir)

    expect(updated).toMatchObject({cost: 1, total_cost: 1, updated_at: '2026-08-15T10:20:00.000Z'})
  })

  it('no recorded attempt or unrepresentable cost: no made-up write', () => {
    const dir = tempDir()
    expect(addTicketAttemptCost({project: 'CYAU', ticket: 'CYAU-155', cost: 1}, dir)).toBeNull()

    recordTicketAttempt({project: 'CYAU', ticket: 'CYAU-155', phase: 'autopilot'}, dir)
    expect(addTicketAttemptCost({project: 'CYAU', ticket: 'CYAU-155', cost: -1}, dir)).toBeNull()
    expect(addTicketAttemptCost({project: 'CYAU', ticket: 'CYAU-155', cost: Number.NaN}, dir)).toBeNull()
    expect(readTicketAttempts('CYAU', 'CYAU-155', dir).record?.total_cost).toBe(0)
  })
})

describe('readTicketAttempts', () => {
  it('missing file: no record, no corruption (first round of the ticket)', () => {
    expect(readTicketAttempts('CYAU', 'CYAU-155', tempDir())).toEqual({record: null, corrupt: false})
  })

  it('unreadable or malformed file: corrupt, never a count inferred as zero', () => {
    const dir = tempDir()
    fs.mkdirSync(dir, {recursive: true})
    fs.writeFileSync(ticketAttemptsPath('CYAU', 'CYAU-155', dir), '{"project":"CYAU","attempts":"molti"}')

    expect(readTicketAttempts('CYAU', 'CYAU-155', dir)).toEqual({record: null, corrupt: true})
  })

  it('record of another ticket in the same file: corrupt (identity not attestable)', () => {
    const dir = tempDir()
    fs.mkdirSync(dir, {recursive: true})
    fs.writeFileSync(
      ticketAttemptsPath('CYAU', 'CYAU-155', dir),
      JSON.stringify({project: 'CYAU', ticket: 'CYAU-999', phase: null, attempts: 1, total_attempts: 1, cost: 0, total_cost: 0, first_at: 'x', updated_at: 'x'}),
    )

    expect(readTicketAttempts('CYAU', 'CYAU-155', dir).corrupt).toBe(true)
  })
})

describe('evaluateTicketAttempts', () => {
  const record = (attempts: number, phase: string | null = 'autopilot') => ({
    project: 'CYAU', ticket: 'CYAU-155', phase, attempts,
    total_attempts: attempts, cost: 0, total_cost: 0, first_at: 'x', updated_at: 'x',
  })

  it('no record: first attempt admitted', () => {
    expect(evaluateTicketAttempts(null, 3, 'autopilot')).toEqual({outcome: 'admit', attempts: 0, limit: 3})
  })

  it('below the threshold: admitted; threshold reached: exhausted', () => {
    expect(evaluateTicketAttempts(record(2), 3, 'autopilot')).toEqual({outcome: 'admit', attempts: 2, limit: 3})
    expect(evaluateTicketAttempts(record(3), 3, 'autopilot')).toEqual({outcome: 'exhausted', attempts: 3, limit: 3})
    expect(evaluateTicketAttempts(record(31), 3, 'autopilot')).toEqual({outcome: 'exhausted', attempts: 31, limit: 3})
  })

  // The count applies to the phase in which it accumulated: if the flow advanced the ticket made real
  // progress and cannot stay blocked by the attempts of a phase that is no longer being worked on.
  it('phase different from the counted one: the ticket restarts admitted', () => {
    expect(evaluateTicketAttempts(record(31), 3, 'closer_staging')).toEqual({outcome: 'admit', attempts: 0, limit: 3})
    expect(evaluateTicketAttempts(record(31, null), 3, 'triage')).toEqual({outcome: 'admit', attempts: 0, limit: 3})
    expect(evaluateTicketAttempts(record(31, null), 3, null)).toEqual({outcome: 'exhausted', attempts: 31, limit: 3})
  })

  it('invalid threshold: falls back to the default instead of working without a limit', () => {
    expect(evaluateTicketAttempts(record(DEFAULT_MAX_TICKET_ATTEMPTS), 0, 'autopilot').outcome).toBe('exhausted')
    expect(evaluateTicketAttempts(record(DEFAULT_MAX_TICKET_ATTEMPTS), Number.NaN, 'autopilot').outcome).toBe('exhausted')
  })
})

describe('maxTicketAttempts', () => {
  it('default when the environment imposes nothing', () => {
    expect(maxTicketAttempts({})).toBe(DEFAULT_MAX_TICKET_ATTEMPTS)
  })

  it('valid configured value', () => {
    expect(maxTicketAttempts({AUTOMATOR_MAX_TICKET_ATTEMPTS: '2'})).toBe(2)
  })

  it('absurd value (zero, negative, non-numeric): default, never no limit', () => {
    expect(maxTicketAttempts({AUTOMATOR_MAX_TICKET_ATTEMPTS: '0'})).toBe(DEFAULT_MAX_TICKET_ATTEMPTS)
    expect(maxTicketAttempts({AUTOMATOR_MAX_TICKET_ATTEMPTS: '-3'})).toBe(DEFAULT_MAX_TICKET_ATTEMPTS)
    expect(maxTicketAttempts({AUTOMATOR_MAX_TICKET_ATTEMPTS: 'tanti'})).toBe(DEFAULT_MAX_TICKET_ATTEMPTS)
  })
})

describe('resetTicketAttempts e listTicketAttempts', () => {
  it('the concluded ticket resets the attempts but keeps the historical spend', () => {
    const dir = tempDir()
    recordTicketAttempt({project: 'CYAU', ticket: 'CYAU-155', phase: 'autopilot', now: at('2026-08-15T10:00:00Z')}, dir)
    addTicketAttemptCost({project: 'CYAU', ticket: 'CYAU-155', cost: 5.02, now: at('2026-08-15T10:30:00Z')}, dir)

    const reset = resetTicketAttempts('CYAU', 'CYAU-155', dir, at('2026-08-15T11:00:00Z'))

    // Reopened, the ticket restarts clean on the threshold; what it already cost stays visible.
    expect(reset).toMatchObject({attempts: 0, cost: 0, phase: null, total_attempts: 1, total_cost: 5.02})
    expect(readTicketAttempts('CYAU', 'CYAU-155', dir).record).toMatchObject({attempts: 0, total_cost: 5.02})
  })

  it('resetting a non-existent or unreadable counter is not an error nor makes up a record', () => {
    const dir = tempDir()
    expect(resetTicketAttempts('CYAU', 'CYAU-155', dir)).toBeNull()
    expect(readTicketAttempts('CYAU', 'CYAU-155', dir).record).toBeNull()

    fs.writeFileSync(ticketAttemptsPath('CYAU', 'CYAU-156', dir), '{ rotto')
    expect(resetTicketAttempts('CYAU', 'CYAU-156', dir)).toBeNull()
  })

  it('lists the per-ticket spend in deterministic order, skipping unreadable files', () => {
    const dir = tempDir()
    recordTicketAttempt({project: 'CYAU', ticket: 'CYAU-156', phase: 'triage', now: at('2026-08-15T10:00:00Z')}, dir)
    recordTicketAttempt({project: 'CYAU', ticket: 'CYAU-155', phase: 'autopilot', now: at('2026-08-15T10:00:00Z')}, dir)
    addTicketAttemptCost({project: 'CYAU', ticket: 'CYAU-155', cost: 5.02, now: at('2026-08-15T10:30:00Z')}, dir)
    fs.writeFileSync(path.join(dir, 'rotto.json'), 'non json')

    expect(listTicketAttempts(dir).map((entry) => [entry.ticket, entry.total_cost])).toEqual([
      ['CYAU-155', 5.02],
      ['CYAU-156', 0],
    ])
  })

  it('missing directory: no spend to show, no error', () => {
    expect(listTicketAttempts(path.join(tempDir(), 'mai-creata'))).toEqual([])
  })
})
