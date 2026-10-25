import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import {afterEach, beforeEach, describe, expect, it} from 'vitest'
import Activity from '../src/commands/activity'
import {type HostActivity} from '../src/lib/activity'
import {saveSecrets} from '../src/lib/config'
import {type LeaseRecord, saveLease} from '../src/lib/lease'
import {type RunRecord, saveRun} from '../src/lib/state'
import {addTicketAttemptCost, recordTicketAttempt} from '../src/lib/ticket-attempts'
import {runCaptured} from './helpers/command'

let stateDir: string
const savedEnv = {...process.env}

const runFile = (runId: string): string => path.join(stateDir, 'runs', `${runId}.json`)

function lease(over: Partial<LeaseRecord> = {}): LeaseRecord {
  return {
    ticket: 'CYAU-31',
    host_id: 'h1',
    run_id: 'run-1',
    agent: 'Bug Fixer',
    ttl_seconds: 3600,
    expires_at: '2099-01-01T00:00:00.000Z',
    acquired_at: '2026-07-13T11:30:00.000Z',
    updated_at: '2026-07-13T11:45:00.000Z',
    ...over,
  }
}

function run(over: Partial<RunRecord> = {}): RunRecord {
  return {
    run_id: 'run-1',
    ticket: 'CYAU-31',
    repository: 'acme/widget',
    updated_at: '2026-07-13T11:50:00.000Z',
    checkpoints: [{phase: 'implementing', branch: null, commit: null, worktree: null, dirty: null, artifacts: [], outcome: null, at: '2026-07-13T11:35:00.000Z'}],
    ...over,
  }
}

beforeEach(() => {
  stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'automator-activity-cmd-'))
  process.env.AUTOMATOR_STATE_DIR = stateDir
  process.env.AUTOMATOR_CONFIG_DIR = stateDir
  saveSecrets({host: {id: 'h1', token: 'cyi_ah_s'}})
})

afterEach(() => {
  process.env = {...savedEnv}
  fs.rmSync(stateDir, {recursive: true, force: true})
})

describe('activity command', () => {
  it('no active run → host idle', async () => {
    const {result, stdout} = await runCaptured(Activity, [])
    expect((result as HostActivity).host_status).toBe('idle')
    expect(stdout).toContain('stato host: idle')
    expect(stdout).toContain('nessuna lavorazione attiva')
  })

  it('active lease + run → lists ticket, phase, runtime and lease health (Scenario 1 Then)', async () => {
    saveLease(lease())
    saveRun(runFile('run-1'), run({runtime: 'claude'}))
    const {result, stdout} = await runCaptured(Activity, [])
    const activity = result as HostActivity
    expect(activity.host_status).toBe('busy')
    expect(activity.active_runs).toHaveLength(1)
    expect(activity.active_runs[0]).toMatchObject({ticket: 'CYAU-31', phase: 'implementing', runtime: 'claude', lease_health: 'active'})
    expect(stdout).toContain('CYAU-31')
    expect(stdout).toContain('claude')
  })

  it('expired lease → host recovery_required and row marked stalled (blocked runs evident, DoD)', async () => {
    saveLease(lease({expires_at: '2000-01-01T00:00:00.000Z'}))
    saveRun(runFile('run-1'), run())
    const {result, stdout} = await runCaptured(Activity, [])
    expect((result as HostActivity).host_status).toBe('recovery_required')
    expect(stdout).toContain('ferma')
  })

  it('filters out the leases of another host identity (stale records)', async () => {
    saveLease(lease({host_id: 'h2', ticket: 'CYAU-99', run_id: 'run-2'}))
    const {result} = await runCaptured(Activity, [])
    expect((result as HostActivity).active_runs).toHaveLength(0)
  })

  // CYAU-155: "the cost spent per ticket is visible". Before, there was only the day's total, in which a ticket
  // resumed 31 times disappeared inside the spend of all the others.
  it('shows attempts and spend per ticket, even without active runs', async () => {
    recordTicketAttempt({project: 'CYAU', ticket: 'CYAU-155', phase: 'autopilot'})
    addTicketAttemptCost({project: 'CYAU', ticket: 'CYAU-155', cost: 5.02})

    const {result, stdout} = await runCaptured(Activity, [])

    expect((result as {ticket_spend: unknown[]}).ticket_spend).toEqual([
      expect.objectContaining({project: 'CYAU', ticket: 'CYAU-155', phase: 'autopilot', attempts: 1, total_cost: 5.02}),
    ])
    expect(stdout).toContain('spesa per ticket')
    expect(stdout).toContain('CYAU-155')
    expect(stdout).toContain('5.02')
  })

  it('no ticket worked on: no spend table to show', async () => {
    const {result, stdout} = await runCaptured(Activity, [])
    expect((result as {ticket_spend: unknown[]}).ticket_spend).toEqual([])
    expect(stdout).not.toContain('spesa per ticket')
  })

  it('--json does not print the human-readable lines', async () => {
    saveLease(lease())
    saveRun(runFile('run-1'), run())
    const {result, stdout} = await runCaptured(Activity, ['--json'])
    expect((result as HostActivity).active_runs).toHaveLength(1)
    expect(stdout).not.toContain('stato host:')
  })
})
