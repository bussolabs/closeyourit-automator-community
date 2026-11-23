import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import {afterEach, beforeEach, describe, expect, it} from 'vitest'
import {
  type ActiveRun,
  deriveActiveRun,
  deriveHostActivity,
  hostStatus,
  IDLE_ACTIVITY,
  leaseHealth,
  readHostActivity,
} from '../src/lib/activity'
import {type LeaseRecord, saveLease} from '../src/lib/lease'
import {type SessionPulse} from '../src/lib/session-pulse'
import {type Checkpoint, type RunRecord, saveRun} from '../src/lib/state'

const NOW = new Date('2026-07-13T12:00:00.000Z')
const FUTURE = '2026-07-13T13:00:00.000Z' // lease non scaduto rispetto a NOW
const PAST = '2026-07-13T11:00:00.000Z' // lease scaduto rispetto a NOW

function lease(over: Partial<LeaseRecord> = {}): LeaseRecord {
  return {
    ticket: 'CYAU-31',
    host_id: 'h1',
    run_id: 'run-1',
    agent: 'Bug Fixer',
    ttl_seconds: 3600,
    expires_at: FUTURE,
    acquired_at: '2026-07-13T11:30:00.000Z',
    updated_at: '2026-07-13T11:45:00.000Z',
    ...over,
  }
}

function checkpoint(over: Partial<Checkpoint> = {}): Checkpoint {
  return {phase: 'implementing', branch: null, commit: null, worktree: null, dirty: null, artifacts: [], outcome: null, at: '2026-07-13T11:35:00.000Z', ...over}
}

function run(over: Partial<RunRecord> = {}): RunRecord {
  return {run_id: 'run-1', ticket: 'CYAU-31', repository: 'acme/widget', updated_at: '2026-07-13T11:50:00.000Z', checkpoints: [checkpoint()], ...over}
}

describe('leaseHealth', () => {
  it('missing or unparsable expiry → unknown (conservative)', () => {
    expect(leaseHealth(null, NOW)).toBe('unknown')
    expect(leaseHealth('non-una-data', NOW)).toBe('unknown')
  })

  it('scadenza futura → active, passata → expired', () => {
    expect(leaseHealth(FUTURE, NOW)).toBe('active')
    expect(leaseHealth(PAST, NOW)).toBe('expired')
  })
})

describe('deriveActiveRun', () => {
  it('composes ticket, phase, runtime, start, expiry and lease health from the run', () => {
    const ar = deriveActiveRun(lease(), run({runtime: 'claude'}), NOW)
    expect(ar.ticket).toBe('CYAU-31')
    expect(ar.run_id).toBe('run-1')
    expect(ar.phase).toBe('implementing')
    expect(ar.runtime).toBe('claude')
    expect(ar.started_at).toBe('2026-07-13T11:30:00.000Z') // lease acquisition
    expect(ar.updated_at).toBe('2026-07-13T11:50:00.000Z') // last checkpoint
    expect(ar.lease_expires_at).toBe(FUTURE)
    expect(ar.lease_health).toBe('active')
    expect(ar.stalled).toBe(false)
  })

  it('updated_at = the most recent between checkpoint and lease renewal (renewal after the last checkpoint)', () => {
    const ar = deriveActiveRun(lease({updated_at: '2026-07-13T11:59:00.000Z'}), run({updated_at: '2026-07-13T11:50:00.000Z'}), NOW)
    expect(ar.updated_at).toBe('2026-07-13T11:59:00.000Z')
  })

  it('lease without run (acquired, no phase) → null phase and runtime, start from the lease', () => {
    const ar = deriveActiveRun(lease(), null, NOW)
    expect(ar.phase).toBeNull()
    expect(ar.runtime).toBeNull()
    expect(ar.started_at).toBe('2026-07-13T11:30:00.000Z')
    expect(ar.updated_at).toBe('2026-07-13T11:45:00.000Z') // fallback on the last lease renewal
  })

  it('blocked phase → stalled (run stopped, intervention needed)', () => {
    const ar = deriveActiveRun(lease(), run({checkpoints: [checkpoint({phase: 'blocked'})]}), NOW)
    expect(ar.stalled).toBe(true)
  })

  it('expired lease → stalled even with an active phase (dead or late host)', () => {
    const ar = deriveActiveRun(lease({expires_at: PAST}), run(), NOW)
    expect(ar.lease_health).toBe('expired')
    expect(ar.stalled).toBe(true)
  })

  it('ignores the legacy granular phases for the current phase (last KNOWN checkpoint)', () => {
    const ar = deriveActiveRun(lease(), run({checkpoints: [checkpoint({phase: 'implementing'}), checkpoint({phase: 'commit'})]}), NOW)
    expect(ar.phase).toBe('implementing')
  })

  it('missing lease expiry → lease_health unknown (conservative, does not stop)', () => {
    const ar = deriveActiveRun(lease({expires_at: null}), run(), NOW)
    expect(ar.lease_health).toBe('unknown')
    expect(ar.stalled).toBe(false)
  })

  it('start: falls back to the first checkpoint when the lease acquisition is empty', () => {
    const ar = deriveActiveRun(lease({acquired_at: ''}), run({checkpoints: [checkpoint({at: '2026-07-13T11:35:00.000Z'})]}), NOW)
    expect(ar.started_at).toBe('2026-07-13T11:35:00.000Z')
  })

  it('all timestamps empty/missing → null start and update (no made-up field)', () => {
    const ar = deriveActiveRun(lease({acquired_at: '', updated_at: ''}), null, NOW)
    expect(ar.started_at).toBeNull()
    expect(ar.updated_at).toBeNull()
  })
})

describe('hostStatus', () => {
  const base: ActiveRun = {ticket: 'T', run_id: 'r', phase: 'implementing', runtime: 'claude', started_at: null, updated_at: null, lease_expires_at: null, lease_health: 'active', stalled: false, stall_reason: null, last_step_kind: null, last_step_at: null, silent_seconds: null}

  it('no run → idle', () => {
    expect(hostStatus([])).toBe('idle')
  })

  it('run in progress → busy', () => {
    expect(hostStatus([base])).toBe('busy')
  })

  it('run waiting for the customer → waiting', () => {
    expect(hostStatus([{...base, phase: 'waiting'}])).toBe('waiting')
  })

  it('stuck run → recovery_required (precedence over waiting and busy)', () => {
    expect(hostStatus([{...base, phase: 'waiting'}, {...base, stalled: true}])).toBe('recovery_required')
  })
})

describe('deriveHostActivity', () => {
  it('matches the leases with the runs by run_id and sorts by ticket (deterministic)', () => {
    const activity = deriveHostActivity({
      leases: [lease({ticket: 'CYAU-31', run_id: 'run-b'}), lease({ticket: 'CYAU-10', run_id: 'run-a'})],
      runs: [run({run_id: 'run-a', ticket: 'CYAU-10'}), run({run_id: 'run-b', ticket: 'CYAU-31'})],
      hostId: 'h1',
      now: NOW,
    })
    expect(activity.active_runs.map((r) => r.ticket)).toEqual(['CYAU-10', 'CYAU-31'])
    expect(activity.host_status).toBe('busy')
  })

  it('filters out the leases of another host identity (stale records after re-registration)', () => {
    const activity = deriveHostActivity({
      leases: [lease({host_id: 'h1', ticket: 'CYAU-31'}), lease({host_id: 'h2', ticket: 'CYAU-99', run_id: 'run-2'})],
      runs: [],
      hostId: 'h1',
      now: NOW,
    })
    expect(activity.active_runs.map((r) => r.ticket)).toEqual(['CYAU-31'])
  })

  it('null hostId → no filter (no known host identity)', () => {
    const activity = deriveHostActivity({leases: [lease({host_id: 'h1'}), lease({host_id: 'h2', run_id: 'run-2', ticket: 'CYAU-99'})], runs: [], hostId: null, now: NOW})
    expect(activity.active_runs).toHaveLength(2)
  })

  it('no lease → idle without runs', () => {
    expect(deriveHostActivity({leases: [], runs: [], hostId: 'h1', now: NOW})).toEqual(IDLE_ACTIVITY)
  })

  it('lease scaduto → host recovery_required (heartbeat/lease scaduto evidente, DoD)', () => {
    const activity = deriveHostActivity({leases: [lease({expires_at: PAST})], runs: [run()], hostId: 'h1', now: NOW})
    expect(activity.host_status).toBe('recovery_required')
    expect(activity.active_runs[0].stalled).toBe(true)
  })
})

describe('readHostActivity', () => {
  it('best-effort: if reading the leases throws → idle (does not make the beat fail)', () => {
    const activity = readHostActivity(
      {host: {id: 'h1', token: 't'}},
      {
        leases: () => {
          throw new Error('disco rotto')
        },
      },
    )
    expect(activity).toEqual(IDLE_ACTIVITY)
  })

  it('composes the snapshot from the leases and the runs via injected probes', () => {
    const activity = readHostActivity(
      {host: {id: 'h1', token: 't'}},
      {
        leases: () => [lease({run_id: 'run-1'})],
        readRunById: (id) => (id === 'run-1' ? run({runtime: 'codex'}) : null),
        now: () => NOW,
      },
    )
    expect(activity.host_status).toBe('busy')
    expect(activity.active_runs[0].runtime).toBe('codex')
  })

  describe('lettura reale dallo state dir', () => {
    let stateDir: string
    const savedEnv = {...process.env}

    beforeEach(() => {
      stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'automator-activity-'))
      process.env.AUTOMATOR_STATE_DIR = stateDir
    })

    afterEach(() => {
      process.env.AUTOMATOR_STATE_DIR = savedEnv.AUTOMATOR_STATE_DIR
      fs.rmSync(stateDir, {recursive: true, force: true})
    })

    it('reads persisted leases + runs and derives the host snapshot', () => {
      saveLease(lease({ticket: 'CYAU-31', run_id: 'run-1', expires_at: FUTURE}))
      saveRun(path.join(stateDir, 'runs', 'run-1.json'), run({run_id: 'run-1', ticket: 'CYAU-31', runtime: 'claude'}))
      const activity = readHostActivity({host: {id: 'h1', token: 't'}}, {now: () => NOW})
      expect(activity.host_status).toBe('busy')
      expect(activity.active_runs).toHaveLength(1)
      expect(activity.active_runs[0]).toMatchObject({ticket: 'CYAU-31', phase: 'implementing', runtime: 'claude', lease_health: 'active'})
    })

    it('no lease in the state dir → idle', () => {
      expect(readHostActivity({host: {id: 'h1', token: 't'}}, {now: () => NOW})).toEqual(IDLE_ACTIVITY)
    })

    it('lease with a hostile run_id → run without phase (never path traversal when reading the run)', () => {
      saveLease(lease({ticket: 'CYAU-31', run_id: '..'}))
      const activity = readHostActivity({host: {id: 'h1', token: 't'}}, {now: () => NOW})
      expect(activity.active_runs).toHaveLength(1)
      expect(activity.active_runs[0]).toMatchObject({ticket: 'CYAU-31', phase: null, runtime: null, last_step_kind: null})
    })

    // CYAU-276 — the note the runner writes at every step, read from the same state dir at every beat.
    it('reads the session pulse of the run and marks it stopped after 8 silent minutes', () => {
      saveLease(lease({ticket: 'CYAU-31', run_id: 'run-1', expires_at: FUTURE}))
      saveRun(path.join(stateDir, 'runs', 'run-1.json'), run({runtime: 'claude'}))
      fs.mkdirSync(path.join(stateDir, 'pulse'))
      fs.writeFileSync(path.join(stateDir, 'pulse', 'run-1.json'), JSON.stringify(pulse({last_step_at: '2026-07-13T11:50:00.000Z'})))
      const activity = readHostActivity({host: {id: 'h1', token: 't'}}, {now: () => NOW})
      expect(activity.host_status).toBe('recovery_required')
      expect(activity.active_runs[0]).toMatchObject({last_step_kind: 'command', last_step_at: '2026-07-13T11:50:00.000Z', silent_seconds: 600, stalled: true, stall_reason: 'silent'})
    })

    it('a corrupt note: the beat goes on, the run simply has no last step', () => {
      saveLease(lease({ticket: 'CYAU-31', run_id: 'run-1', expires_at: FUTURE}))
      saveRun(path.join(stateDir, 'runs', 'run-1.json'), run({runtime: 'claude'}))
      fs.mkdirSync(path.join(stateDir, 'pulse'))
      fs.writeFileSync(path.join(stateDir, 'pulse', 'run-1.json'), '{"session_open": true, "opened_at": "2026-07-1')
      const activity = readHostActivity({host: {id: 'h1', token: 't'}}, {now: () => NOW})
      expect(activity.host_status).toBe('busy')
      expect(activity.active_runs[0]).toMatchObject({ticket: 'CYAU-31', last_step_kind: null, last_step_at: null, silent_seconds: null, stalled: false})
    })

    it('a note that is a folder (unreadable) counts as no information', () => {
      saveLease(lease({ticket: 'CYAU-31', run_id: 'run-1', expires_at: FUTURE}))
      fs.mkdirSync(path.join(stateDir, 'pulse', 'run-1.json'), {recursive: true})
      const activity = readHostActivity({host: {id: 'h1', token: 't'}}, {now: () => NOW})
      expect(activity.active_runs[0]).toMatchObject({last_step_kind: null, stalled: false})
    })
  })

  it('a pulse probe that throws costs only that run its last step, never the beat', () => {
    const activity = readHostActivity(
      {host: {id: 'h1', token: 't'}},
      {
        leases: () => [lease({run_id: 'run-1'}), lease({ticket: 'CYAU-32', run_id: 'run-2'})],
        readRunById: () => run({runtime: 'claude'}),
        readPulseByRunId: (id) => {
          if (id === 'run-1') throw new Error('disco rotto')
          return pulse()
        },
        now: () => NOW,
      },
    )
    expect(activity.active_runs.map((r) => [r.ticket, r.last_step_kind])).toEqual([['CYAU-31', null], ['CYAU-32', 'command']])
  })
})

// CYAU-276 — a Claude session open but silent: the lease is renewed at every beat, so only the step note tells it.
function pulse(over: Partial<SessionPulse> = {}): SessionPulse {
  return {session_open: true, opened_at: '2026-07-13T11:40:00.000Z', last_step_kind: 'command', last_step_at: '2026-07-13T11:58:00.000Z', ...over}
}

describe('session pulse in the activity (CYAU-276)', () => {
  const claude = (): RunRecord => run({runtime: 'claude'})

  it('a working Claude session carries kind and time of the last step, and is not stopped', () => {
    const ar = deriveActiveRun(lease(), claude(), NOW, pulse())
    expect(ar).toMatchObject({last_step_kind: 'command', last_step_at: '2026-07-13T11:58:00.000Z', silent_seconds: 120, stalled: false, stall_reason: null})
  })

  it('only kind and time leave: no path, command or argument field exists on the row', () => {
    const ar = deriveActiveRun(lease(), claude(), NOW, pulse())
    expect(Object.keys(ar).sort()).toEqual([
      'last_step_at', 'last_step_kind', 'lease_expires_at', 'lease_health', 'phase', 'run_id', 'runtime', 'silent_seconds',
      'stall_reason', 'stalled', 'started_at', 'ticket', 'updated_at',
    ])
  })

  it('threshold: 7m59s of silence is working, 8 minutes is stopped', () => {
    expect(deriveActiveRun(lease(), claude(), NOW, pulse({last_step_at: '2026-07-13T11:52:01.000Z'})).stalled).toBe(false)
    const stopped = deriveActiveRun(lease(), claude(), NOW, pulse({last_step_at: '2026-07-13T11:52:00.000Z'}))
    expect(stopped).toMatchObject({stalled: true, stall_reason: 'silent', silent_seconds: 480, last_step_kind: 'command'})
  })

  it('a stopped run working again: the next beat shows it at work, no intervention', () => {
    const before = deriveHostActivity({leases: [lease()], runs: [claude()], hostId: 'h1', now: NOW, pulses: new Map([['run-1', pulse({last_step_at: '2026-07-13T11:45:00.000Z'})]])})
    expect(before.host_status).toBe('recovery_required')
    const after = deriveHostActivity({leases: [lease()], runs: [claude()], hostId: 'h1', now: NOW, pulses: new Map([['run-1', pulse({last_step_at: '2026-07-13T11:59:30.000Z'})]])})
    expect(after.host_status).toBe('busy')
    expect(after.active_runs[0].stalled).toBe(false)
  })

  it('a session that opened 8 minutes ago without any step is stopped (silence from the opening)', () => {
    const ar = deriveActiveRun(lease(), claude(), NOW, pulse({opened_at: '2026-07-13T11:52:00.000Z', last_step_kind: null, last_step_at: null}))
    expect(ar).toMatchObject({stalled: true, stall_reason: 'silent', silent_seconds: 480, last_step_kind: null})
  })

  it('a closed session (delivery, review) is never stopped for silence, however long', () => {
    const ar = deriveActiveRun(lease(), claude(), NOW, pulse({session_open: false, last_step_at: '2026-07-13T11:00:00.000Z'}))
    expect(ar).toMatchObject({stalled: false, stall_reason: null, silent_seconds: null, last_step_kind: 'command'})
  })

  it('Codex: no last step and never stopped for silence, even with a note on disk', () => {
    const withNote = deriveActiveRun(lease(), run({runtime: 'codex'}), NOW, pulse({last_step_at: '2026-07-13T11:00:00.000Z'}))
    expect(withNote).toMatchObject({last_step_kind: null, last_step_at: null, silent_seconds: null, stalled: false})
    const without = deriveActiveRun(lease(), run({runtime: 'codex'}), NOW)
    expect(without).toMatchObject({last_step_kind: null, stalled: false, stall_reason: null})
  })

  it('the older reasons keep precedence: blocked phase, then expired lease', () => {
    const silent = pulse({last_step_at: '2026-07-13T11:00:00.000Z'})
    expect(deriveActiveRun(lease(), run({checkpoints: [checkpoint({phase: 'blocked'})]}), NOW, silent).stall_reason).toBe('blocked')
    expect(deriveActiveRun(lease({expires_at: PAST}), claude(), NOW, silent).stall_reason).toBe('lease_expired')
  })
})
