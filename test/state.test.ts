import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import {afterAll, describe, expect, it} from 'vitest'
import {
  emptyState,
  latestCheckpoint,
  loadState,
  mutateRunAtomically,
  quarantineCorruptState,
  readRun,
  readRunAtomically,
  readState,
  recordCheckpoint,
  runPath,
  saveRun,
  saveState,
  updateAction,
  writeAtomicJson,
} from '../src/lib/state'
import {AutomatorError} from '../src/errors/error-codes'
import {normalizeAgentResult, type AgentRunResult} from '../src/lib/agent-result'

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'automator-state-'))
let counter = 0
const tmp = (): string => path.join(dir, `state-${counter++}.json`)

function agentResult(overrides: {stdout?: string; status?: 'success' | 'failure' | 'timeout'; errorCode?: string | null; logPath?: string} = {}): AgentRunResult {
  return normalizeAgentResult({
    runtime: 'codex',
    action: 'implement',
    result: {
      status: overrides.status ?? 'success',
      exitCode: overrides.status === 'failure' ? 1 : 0,
      errorCode: overrides.errorCode ?? null,
      durationMs: 42,
      logPath: overrides.logPath ?? '/logs/run.log',
      stdout: overrides.stdout ?? JSON.stringify({summary: 'fatto', changed_files: ['src/a.ts'], commit: 'abc123'}),
    },
  })
}

afterAll(() => fs.rmSync(dir, {recursive: true, force: true}))

describe('loadState', () => {
  it('missing file → empty state', () => {
    expect(loadState(path.join(dir, 'non-esiste.json'))).toEqual(emptyState())
  })

  it('corrupted JSON → empty state (no crash)', () => {
    const file = tmp()
    fs.writeFileSync(file, '{ questo non è json')
    expect(loadState(file)).toEqual(emptyState())
  })

  it('non-object actions → empty state', () => {
    const file = tmp()
    fs.writeFileSync(file, JSON.stringify({version: 1, actions: 'nope'}))
    expect(loadState(file)).toEqual(emptyState())
  })

  it('round-trip of a valid state', () => {
    const file = tmp()
    const state = updateAction(emptyState(), 'a', {last_run: '2026-07-07T00:00:00.000Z', last_status: 'success'})
    saveState(file, state)
    expect(loadState(file).actions.a.last_status).toBe('success')
  })

  it('round-trip after restart keeps the normalized AgentRunResult of the action', () => {
    const file = tmp()
    const result = agentResult()
    saveState(file, updateAction(emptyState(), 'a', {last_result: result}))

    expect(loadState(file).actions.a.last_result).toEqual(result)
  })

  it('legacy state without last_result stays readable; a malformed result degrades to null', () => {
    const legacy = tmp()
    fs.writeFileSync(legacy, JSON.stringify({version: 1, actions: {a: {last_run: '2026-07-07T00:00:00.000Z', last_status: 'success'}}}))
    expect(loadState(legacy).actions.a.last_result).toBeNull()

    const malformed = tmp()
    fs.writeFileSync(malformed, JSON.stringify({version: 1, actions: {a: {last_status: 'failure', last_result: {outcome: 'inventato'}}}}))
    expect(loadState(malformed).actions.a).toMatchObject({last_status: 'failure', last_result: null})
  })
})

describe('readState', () => {
  it('missing file → empty state, not corrupted (first start)', () => {
    expect(readState(path.join(dir, 'mai-scritto.json'))).toEqual({state: emptyState(), corrupt: false})
  })

  it('illegal JSON → corrupted (empty state, no crash)', () => {
    const file = tmp()
    fs.writeFileSync(file, '{ non è json')
    const read = readState(file)
    expect(read.corrupt).toBe(true)
    expect(read.state).toEqual(emptyState())
  })

  it('non-object root (array) → corrupted', () => {
    const file = tmp()
    fs.writeFileSync(file, JSON.stringify([1, 2, 3]))
    expect(readState(file).corrupt).toBe(true)
  })

  it('actions section present but non-object → corrupted (broken structure)', () => {
    const file = tmp()
    fs.writeFileSync(file, JSON.stringify({version: 1, actions: 'nope'}))
    expect(readState(file).corrupt).toBe(true)
  })

  it('unreadable file (a directory, not ENOENT) → corrupted', () => {
    const asDir = path.join(dir, 'state-as-dir')
    fs.mkdirSync(asDir, {recursive: true})
    expect(readState(asDir).corrupt).toBe(true)
  })
})

describe('runPath', () => {
  it('run-id sicuro → path <base>/<run-id>.json', () => {
    expect(runPath('run-42', '/runs')).toBe(path.join('/runs', 'run-42.json'))
  })

  it('names that are inherited properties (toString/valueOf/hasOwnProperty) are valid run-ids', () => {
    // Prototype bug fix: as a FILE NAME these are harmless; they must no longer crash nor be rejected.
    for (const name of ['toString', 'valueOf', 'hasOwnProperty', 'isPrototypeOf']) {
      expect(runPath(name, '/runs')).toBe(path.join('/runs', `${name}.json`))
    }
  })

  it('hostile run-id (empty, .., separators, prototype keys) → AutomatorError (never path traversal)', () => {
    for (const bad of ['', '.', '..', 'a/b', 'a\\b', '__proto__', 'prototype', 'constructor']) {
      expect(() => runPath(bad, '/runs')).toThrow(AutomatorError)
    }
  })
})

describe('recordCheckpoint', () => {
  it('creates the run and records the phase checkpoint (branch/commit/worktree/artifacts)', () => {
    const run = recordCheckpoint(null, 'run-1', {ticket: 'CYAU-12', repository: 'acme/widget'}, {
      phase: 'test',
      branch: 'ticket/CYAU-12',
      commit: 'deadbeef',
      worktree: '/w/CYAU/CYAU-12',
      dirty: true,
      artifacts: ['a.ts', 'b.ts'],
      outcome: 'success',
      at: '2026-07-12T10:00:00.000Z',
    })
    expect(run.run_id).toBe('run-1')
    expect(run.ticket).toBe('CYAU-12')
    expect(run.repository).toBe('acme/widget')
    expect(run.checkpoints).toHaveLength(1)
    expect(run.checkpoints[0]).toEqual({
      phase: 'test',
      branch: 'ticket/CYAU-12',
      commit: 'deadbeef',
      worktree: '/w/CYAU/CYAU-12',
      dirty: true,
      artifacts: ['a.ts', 'b.ts'],
      outcome: 'success',
      at: '2026-07-12T10:00:00.000Z',
    })
    expect(run.updated_at).toBe('2026-07-12T10:00:00.000Z')
  })

  it('is pure: does not mutate the existing RunRecord, appends to a new copy', () => {
    const first = recordCheckpoint(null, 'run-1', {}, {phase: 'setup', at: '2026-07-12T10:00:00.000Z'})
    const second = recordCheckpoint(first, 'run-1', {}, {phase: 'implement', at: '2026-07-12T11:00:00.000Z'})
    expect(first.checkpoints).toHaveLength(1) // the original was not mutated
    expect(second.checkpoints.map((c) => c.phase)).toEqual(['setup', 'implement'])
    expect(second.updated_at).toBe('2026-07-12T11:00:00.000Z')
  })

  it('run-id always authoritative (from file name/CLI), even starting from a record with a different run_id', () => {
    const stale = {run_id: 'vecchio', ticket: null, repository: null, updated_at: '', checkpoints: []}
    const run = recordCheckpoint(stale, 'run-1', {}, {phase: 'x', at: 'y'})
    expect(run.run_id).toBe('run-1')
  })

  it('normalizes the optional fields to null / empty list', () => {
    const run = recordCheckpoint(null, 'run-1', {}, {phase: 'setup', at: '2026-07-12T10:00:00.000Z'})
    expect(run.checkpoints[0]).toEqual({
      phase: 'setup',
      branch: null,
      commit: null,
      worktree: null,
      dirty: null,
      artifacts: [],
      outcome: null,
      at: '2026-07-12T10:00:00.000Z',
    })
    expect(run.ticket).toBeNull()
    expect(run.repository).toBeNull()
  })

  it('enriches ticket/repository on later phases if previously missing (never overwrites with null)', () => {
    let run = recordCheckpoint(null, 'run-1', {}, {phase: 'setup', at: '2026-07-12T10:00:00.000Z'})
    run = recordCheckpoint(run, 'run-1', {ticket: 'CYAU-12', repository: 'acme/widget'}, {phase: 'implement', at: '2026-07-12T11:00:00.000Z'})
    run = recordCheckpoint(run, 'run-1', {}, {phase: 'commit', at: '2026-07-12T12:00:00.000Z'})
    expect(run.ticket).toBe('CYAU-12')
    expect(run.repository).toBe('acme/widget')
  })

  it('run-id that is an inherited property (toString) → no crash, records normally', () => {
    // Prototype bug regression: with the old design `runs["toString"]` returned an inherited function
    // and crashed. Now `recordCheckpoint` does not access maps by key → it works.
    const run = recordCheckpoint(null, 'toString', {}, {phase: 'setup', at: '2026-07-12T10:00:00.000Z'})
    expect(run.run_id).toBe('toString')
    expect(run.checkpoints).toHaveLength(1)
  })

  it('records the run runtime when provided (feeds the dashboard, CYAU-31)', () => {
    const run = recordCheckpoint(null, 'run-1', {ticket: 'CYAU-31', runtime: 'claude'}, {phase: 'implementing', at: '2026-07-12T10:00:00.000Z'})
    expect(run.runtime).toBe('claude')
  })

  it('missing runtime → field omitted (backward compat with files written before CYAU-31)', () => {
    const run = recordCheckpoint(null, 'run-1', {ticket: 'CYAU-31'}, {phase: 'validating', at: '2026-07-12T10:00:00.000Z'})
    expect(run).not.toHaveProperty('runtime')
  })

  it('enriches the runtime on later phases and does not reset it (like ticket/repository)', () => {
    let run = recordCheckpoint(null, 'run-1', {}, {phase: 'validating', at: '2026-07-12T10:00:00.000Z'})
    run = recordCheckpoint(run, 'run-1', {runtime: 'codex'}, {phase: 'implementing', at: '2026-07-12T11:00:00.000Z'})
    run = recordCheckpoint(run, 'run-1', {}, {phase: 'verifying', at: '2026-07-12T12:00:00.000Z'})
    expect(run.runtime).toBe('codex')
  })

  it('persists AgentRunResult both on the RunRecord and on the checkpoint that produced it', () => {
    const result = agentResult()
    const run = recordCheckpoint(null, 'run-1', {ticket: 'CYAU-46'}, {
      phase: 'implementing', at: '2026-07-12T10:00:00.000Z', result,
    })

    expect(run.result).toEqual(result)
    expect(run.checkpoints[0].result).toEqual(result)
  })

  it('a later checkpoint without result keeps the last result without inventing it on the new checkpoint', () => {
    const result = agentResult()
    let run = recordCheckpoint(null, 'run-1', {}, {phase: 'implementing', at: '2026-07-12T10:00:00.000Z', result})
    run = recordCheckpoint(run, 'run-1', {}, {phase: 'reviewing', at: '2026-07-12T11:00:00.000Z'})

    expect(run.result).toEqual(result)
    expect(run.checkpoints[1]).not.toHaveProperty('result')
  })

  it('a malformed programmatic result degrades granularly without losing the last valid result', () => {
    const valid = agentResult()
    const first = recordCheckpoint(null, 'run-1', {}, {phase: 'implementing', at: '2026-07-12T10:00:00.000Z', result: valid})
    const malformed = {outcome: 'inventato'} as unknown as AgentRunResult

    const next = recordCheckpoint(first, 'run-1', {}, {
      phase: 'reviewing', at: '2026-07-12T11:00:00.000Z', result: malformed,
    })

    expect(next.result).toEqual(valid)
    expect(next.checkpoints[1]).not.toHaveProperty('result')
  })
})

describe('latestCheckpoint', () => {
  it('returns the last checkpoint or null if there are none', () => {
    let run = recordCheckpoint(null, 'run-1', {}, {phase: 'a', at: '2026-07-12T10:00:00.000Z'})
    run = recordCheckpoint(run, 'run-1', {}, {phase: 'b', at: '2026-07-12T11:00:00.000Z'})
    expect(latestCheckpoint(run)?.phase).toBe('b')
    expect(latestCheckpoint({run_id: 'x', ticket: null, repository: null, updated_at: '', checkpoints: []})).toBeNull()
  })
})

describe('readRun / saveRun', () => {
  it('missing file → run null, not corrupted (run never started)', () => {
    expect(readRun(path.join(dir, 'mai-iniziata.json'))).toEqual({run: null, corrupt: false})
  })

  it('illegal JSON → corrupted (run null, no crash)', () => {
    const file = tmp()
    fs.writeFileSync(file, '{ non è json')
    expect(readRun(file)).toEqual({run: null, corrupt: true})
  })

  it('non-object root → corrupted', () => {
    const file = tmp()
    fs.writeFileSync(file, JSON.stringify(['nope']))
    expect(readRun(file).corrupt).toBe(true)
  })

  it('unreadable file (a directory, not ENOENT) → corrupted', () => {
    const asDir = path.join(dir, 'run-as-dir')
    fs.mkdirSync(asDir, {recursive: true})
    expect(readRun(asDir)).toEqual({run: null, corrupt: true})
  })

  it('round-trip: recordCheckpoint → saveRun → readRun', () => {
    const file = tmp()
    const run = recordCheckpoint(null, 'run-1', {ticket: 'CYAU-12'}, {phase: 'commit', commit: 'abc', at: '2026-07-12T10:00:00.000Z'})
    saveRun(file, run)
    const read = readRun(file)
    expect(read.corrupt).toBe(false)
    expect(read.run?.checkpoints[0].commit).toBe('abc')
    expect(read.run?.ticket).toBe('CYAU-12')
  })

  it('restart round-trip keeps structured result and error/log metadata', () => {
    const file = tmp()
    const result = agentResult({status: 'failure', errorCode: 'C001-EXEC-003', logPath: '/logs/failure.log', stdout: 'non-json'})
    saveRun(file, recordCheckpoint(null, 'run-1', {}, {phase: 'implementing', at: '2026-07-12T10:00:00.000Z', result}))

    const restarted = readRun(file).run
    expect(restarted?.result).toEqual(result)
    expect(restarted?.checkpoints[0].result).toEqual(result)
    expect(restarted?.result?.summary).toBeNull()
    expect(restarted?.result?.metadata).toMatchObject({errorCode: 'C001-EXEC-003', logPath: '/logs/failure.log', reportParsed: false})
  })

  it('legacy record without result stays readable; a malformed result is ignored without corrupting valid checkpoints', () => {
    const file = tmp()
    fs.writeFileSync(file, JSON.stringify({
      run_id: 'run-legacy', ticket: 'CYAU-46', result: {outcome: 'inventato'},
      checkpoints: [{phase: 'implementing', at: '2026-07-12T10:00:00.000Z', result: {outcome: 'inventato'}}],
    }))

    const read = readRun(file)
    expect(read.corrupt).toBe(false)
    expect(read.run).not.toHaveProperty('result')
    expect(read.run?.checkpoints[0]).not.toHaveProperty('result')
    expect(read.run?.checkpoints[0].phase).toBe('implementing')
  })

  it('reads the persisted runtime; non-string or missing runtime → field omitted', () => {
    const withRuntime = tmp()
    saveRun(withRuntime, recordCheckpoint(null, 'run-1', {runtime: 'claude'}, {phase: 'implementing', at: '2026-07-12T10:00:00.000Z'}))
    expect(readRun(withRuntime).run?.runtime).toBe('claude')

    const bogus = tmp()
    fs.writeFileSync(bogus, JSON.stringify({run_id: 'run-1', runtime: 42, checkpoints: [{phase: 'ready', at: 'z'}]}))
    expect(readRun(bogus).run).not.toHaveProperty('runtime')
  })

  it('malformed checkpoints in the list → discarded (granular degradation), non-string/missing fields to defaults', () => {
    const file = tmp()
    fs.writeFileSync(
      file,
      JSON.stringify({
        run_id: 'run-1',
        checkpoints: [{phase: 'ok', at: 123, branch: 5, dirty: 'no', artifacts: 'x', outcome: 'bad'}, {nope: true}, 'garbage'],
      }),
    )
    const read = readRun(file)
    expect(read.corrupt).toBe(false)
    expect(read.run?.checkpoints).toHaveLength(1)
    expect(read.run?.checkpoints[0]).toEqual({
      phase: 'ok',
      branch: null,
      commit: null,
      worktree: null,
      dirty: null,
      artifacts: [],
      outcome: null,
      at: '',
    })
  })

  it('missing run_id/updated_at → derived (empty / last checkpoint)', () => {
    const file = tmp()
    fs.writeFileSync(file, JSON.stringify({checkpoints: [{phase: 'commit', at: '2026-07-12T12:00:00.000Z'}]}))
    const read = readRun(file)
    expect(read.run?.run_id).toBe('')
    expect(read.run?.updated_at).toBe('2026-07-12T12:00:00.000Z')
  })

  it('atomic write (no leftover .tmp)', () => {
    const file = path.join(dir, 'nested', 'deep', 'run.json')
    saveRun(file, recordCheckpoint(null, 'run-1', {}, {phase: 'x', at: 'y'}))
    expect(fs.existsSync(file)).toBe(true)
    expect(fs.existsSync(`${file}.tmp`)).toBe(false)
  })

  it('concurrent appends read under lock and do not lose checkpoints (deterministic interleaving)', () => {
    const file = tmp()
    saveRun(file, recordCheckpoint(null, 'run-1', {}, {phase: 'setup', at: '2026-07-12T10:00:00.000Z'}))
    let injected = false

    mutateRunAtomically(
      file,
      'outer',
      (run) => ({
        run: recordCheckpoint(run, 'run-1', {}, {phase: 'review', at: '2026-07-12T12:00:00.000Z'}),
        value: undefined,
      }),
      {
        beforeAcquire: () => {
          if (injected) return
          injected = true
          mutateRunAtomically(file, 'inner', (run) => ({
            run: recordCheckpoint(run, 'run-1', {}, {phase: 'test', at: '2026-07-12T11:00:00.000Z'}),
            value: undefined,
          }))
        },
      },
    )

    expect(readRun(file).run?.checkpoints.map((checkpoint) => checkpoint.phase)).toEqual(['setup', 'test', 'review'])
  })

  it('concurrent appends also serialize the results: complete history and consistent last result', () => {
    const file = tmp()
    const first = agentResult({stdout: JSON.stringify({summary: 'primo'})})
    const second = agentResult({stdout: JSON.stringify({summary: 'secondo'})})
    let injected = false

    mutateRunAtomically(file, 'outer', (run) => ({
      run: recordCheckpoint(run, 'run-1', {}, {phase: 'reviewing', at: '2026-07-12T11:00:00.000Z', result: second}),
      value: undefined,
    }), {
      beforeAcquire: () => {
        if (injected) return
        injected = true
        mutateRunAtomically(file, 'inner', (run) => ({
          run: recordCheckpoint(run, 'run-1', {}, {phase: 'implementing', at: '2026-07-12T10:00:00.000Z', result: first}),
          value: undefined,
        }))
      },
    })

    const run = readRun(file).run
    expect(run?.checkpoints.map((checkpoint) => checkpoint.result?.summary)).toEqual(['primo', 'secondo'])
    expect(run?.result?.summary).toBe('secondo')
  })

  it('quarantine re-evaluates the file under lock and does not move a valid checkpoint published meanwhile', () => {
    const file = tmp()
    fs.writeFileSync(file, '{ corrotto')
    const valid = recordCheckpoint(null, 'run-1', {}, {phase: 'validating', at: '2026-07-12T10:00:00.000Z'})

    const result = readRunAtomically(file, 'outer', {beforeAcquire: () => saveRun(file, valid)})

    expect(result).toMatchObject({corrupt: false, quarantined: null})
    expect(result.run?.checkpoints.map((checkpoint) => checkpoint.phase)).toEqual(['validating'])
    expect(fs.readdirSync(path.dirname(file)).filter((entry) => entry.includes(`${path.basename(file)}.corrupt-`))).toEqual([])
  })
})

describe('writeAtomicJson', () => {
  it('a crash before the rename leaves the last valid JSON intact and cleans up the unique temp', () => {
    const file = tmp()
    fs.writeFileSync(file, '{"version":"precedente"}\n')

    expect(() => writeAtomicJson(file, {version: 'nuova'}, {
      beforeRename: () => {
        throw new Error('crash injection')
      },
    })).toThrow('crash injection')

    expect(fs.readFileSync(file, 'utf8')).toBe('{"version":"precedente"}\n')
    expect(fs.readdirSync(path.dirname(file)).filter((entry) => entry.startsWith(`${path.basename(file)}.tmp-`))).toEqual([])
  })

  it('each writer uses a different sibling temp', () => {
    const file = tmp()
    const temps: string[] = []

    writeAtomicJson(file, {version: 1}, {beforeRename: (temp) => temps.push(temp)})
    writeAtomicJson(file, {version: 2}, {beforeRename: (temp) => temps.push(temp)})

    expect(temps).toHaveLength(2)
    expect(temps[0]).not.toBe(temps[1])
    expect(temps.every((temp) => path.dirname(temp) === path.dirname(file))).toBe(true)
    expect(JSON.parse(fs.readFileSync(file, 'utf8'))).toEqual({version: 2})
  })
})

describe('quarantineCorruptState', () => {
  it('renames the corrupted file preserving it, returns the quarantine path', () => {
    const file = tmp()
    fs.writeFileSync(file, '{ corrotto')
    const dest = quarantineCorruptState(file, '2026-07-12T10-00-00')
    expect(dest).toBe(`${file}.corrupt-2026-07-12T10-00-00`)
    expect(fs.existsSync(file)).toBe(false) // the original is no longer there (moved, not overwritten)
    expect(fs.readFileSync(dest as string, 'utf8')).toBe('{ corrotto') // content preserved for inspection
  })

  it('missing file → null (nothing to preserve)', () => {
    expect(quarantineCorruptState(path.join(dir, 'assente.json'), 'stamp')).toBeNull()
  })
})

describe('saveState', () => {
  it('creates the directory and writes atomically (no leftover .tmp)', () => {
    const file = path.join(dir, 'nested', 'deep', 'state.json')
    saveState(file, emptyState())
    expect(fs.existsSync(file)).toBe(true)
    expect(fs.existsSync(`${file}.tmp`)).toBe(false)
  })
})

describe('updateAction', () => {
  it('preserves the other actions and merges the patch', () => {
    let state = updateAction(emptyState(), 'a', {last_status: 'success'})
    state = updateAction(state, 'b', {last_status: 'failure', last_exit_code: 1})
    expect(state.actions.a.last_status).toBe('success')
    expect(state.actions.b.last_exit_code).toBe(1)
  })
})
