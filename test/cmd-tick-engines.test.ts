import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest'
import TickCommand from '../src/commands/tick'
import {saveSecrets, type Secrets} from '../src/lib/config'
import {HOST_TOKEN_PREFIX} from '../src/lib/credential-format'
import {makeHeartbeat} from '../src/lib/heartbeat'
import {hostEngines, type HostEngines} from '../src/lib/host-engines'
import {IDLE_ACTIVITY} from '../src/lib/activity'
import {type RunOnceOptions, type RunOnceResult} from '../src/lib/runner'
import {run} from './helpers/command'

// CYAU-305 — a single tick is a new process: its list of engines must come from a beat sent BEFORE the claims,
// not from the beat at the end of the round, or a machine all on Codex stops on Claude's quota at every tick.

let dir: string
const savedEnv = {...process.env}
const allCodex: HostEngines = {work: 'codex', reviewer: 'codex', supporter: 'codex'}

type Reply = {engines: unknown} | 'network-error'
let replies: Reply[] = []
let events: string[] = []
let seenAtIteration: HostEngines | null | undefined
let iteration: RunOnceOptions | undefined

class Tick extends TickCommand {
  protected currentPlatform() {
    return 'linux' as const
  }

  protected hostBeat(secrets: Secrets) {
    const fetchFn = vi.fn(async () => {
      events.push('beat')
      const reply = replies.shift()
      if (!reply || reply === 'network-error') throw new Error('network down')
      return {ok: true, status: 202, json: async () => ({data: {engines: reply.engines}})} as unknown as Response
    }) as unknown as typeof globalThis.fetch
    return makeHeartbeat(secrets, {
      version: '0.0.1',
      platform: 'linux',
      arch: 'x64',
      runtimes: [],
      fetchFn,
      activity: () => IDLE_ACTIVITY,
      skillsBundle: () => ({name: 'skills', present: true, version: null, required: false}),
      updateFailure: () => null,
      agentQuota: () => [],
      engines: hostEngines,
    })
  }

  protected async runIteration(options: RunOnceOptions): Promise<RunOnceResult> {
    events.push('iteration')
    // What the claim would read now: the claimer is wired to this same list.
    seenAtIteration = hostEngines.current()
    iteration = options
    return {skipped: false, executed: [], seeded: [], scheduleErrors: [], pruned: 0, preflightStopped: [], flowFailures: []} as unknown as RunOnceResult
  }
}

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'automator-tick-engines-'))
  // A playbook needs at least one action to load; the iteration is stubbed, so it never runs.
  fs.writeFileSync(path.join(dir, 'playbook.yml'), 'version: 1\nactions:\n  hello:\n    schedule: "every 1m"\n    type: shell\n    run: "echo hello"\n')
  process.env.AUTOMATOR_STATE_DIR = path.join(dir, 'state')
  process.env.AUTOMATOR_CONFIG_DIR = path.join(dir, 'config')
  process.env.AUTOMATOR_PLAYBOOK = path.join(dir, 'playbook.yml')
  // Built from the prefix: a credential-shaped literal would stop the review of this diff.
  saveSecrets({heartbeat: {projectId: 'PID', slug: 'automator-tick', token: 'cyi_ingest'}, host: {id: 'h1', token: `${HOST_TOKEN_PREFIX}prova`}})
  // Leases, skills and credentials reach no server here: only the monitor beat answers.
  vi.stubGlobal('fetch', vi.fn(async () => {
    throw new Error('offline')
  }))
  hostEngines.replace(null)
  replies = []
  events = []
  seenAtIteration = undefined
  iteration = undefined
})

afterEach(() => {
  process.env = {...savedEnv}
  vi.unstubAllGlobals()
  hostEngines.replace(null)
  fs.rmSync(dir, {recursive: true, force: true})
})

describe('tick — engines in use before the claim', () => {
  it('beats before the iteration, so the claim already reads the list the server declared', async () => {
    replies = [{engines: allCodex}]
    await run(Tick, [])
    expect(events).toEqual(['beat', 'iteration'])
    expect(seenAtIteration).toEqual(allCodex)
  })

  it('a server that declares no valid list leaves the claim on both engines', async () => {
    replies = [{engines: {work: 'codex', reviewer: 'gemini', supporter: 'codex'}}]
    await run(Tick, [])
    expect(events).toEqual(['beat', 'iteration'])
    expect(seenAtIteration).toBeNull()
  })

  it('a failed beat before the claim leaves no list, and the iteration still runs', async () => {
    replies = ['network-error']
    await run(Tick, [])
    expect(events).toEqual(['beat', 'iteration'])
    expect(seenAtIteration).toBeNull()
  })

  it('the beat at the end of the round is the same one and replaces the list again', async () => {
    replies = [{engines: allCodex}, 'network-error']
    await run(Tick, [])
    expect(seenAtIteration).toEqual(allCodex)
    await iteration!.heartbeat!(true, [])
    expect(events).toEqual(['beat', 'iteration', 'beat'])
    expect(hostEngines.current()).toBeNull()
  })
})
