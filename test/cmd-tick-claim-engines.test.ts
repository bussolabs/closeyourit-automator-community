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
import {type RuntimeId} from '../src/lib/route'
import {type QueueClaimOutcome, type RunOnceOptions, type RunOnceResult} from '../src/lib/runner'
import {run} from './helpers/command'

// CYAU-305 — end to end on the single tick: the claim the tick hands the round must read the engines the beat
// before it declared. The only checks replaced are those that do not depend on the engines (manifest sync, pinned
// bundle, write confinement) and the two paid ones (quota, answer), which record which engines they were asked for.

const quota = vi.hoisted(() => ({asked: [] as RuntimeId[][], paused: new Set<string>()}))

vi.mock('../src/lib/sync', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/lib/sync')>()
  return {...actual, makeSync: () => undefined}
})

vi.mock('../src/lib/skills-manifest', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/lib/skills-manifest')>()
  return {...actual, compareBundleToPin: async () => ({aligned: true, detail: ''})}
})

vi.mock('../src/lib/write-confinement', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/lib/write-confinement')>()
  return {...actual, createWriteConfinementAttestor: () => async () => ({attested: true})}
})

vi.mock('../src/lib/agent-quota', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/lib/agent-quota')>()
  return {
    ...actual,
    agentQuotaGate: async (runtimes: readonly RuntimeId[] = ['claude', 'codex']) => {
      quota.asked.push([...runtimes])
      const paused = runtimes.find((runtime) => quota.paused.has(runtime))
      return paused ? {ready: false, detail: `${paused}: quota esaurita`, runtime: paused} : {ready: true}
    },
  }
})

vi.mock('../src/lib/runtime-probe', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/lib/runtime-probe')>()
  return {...actual, agentRuntimeReadiness: async () => ({ready: true})}
})

let dir: string
const savedEnv = {...process.env}
const allCodex: HostEngines = {work: 'codex', reviewer: 'codex', supporter: 'codex'}
let declared: unknown
let claims: number
let outcome: QueueClaimOutcome | undefined

class Tick extends TickCommand {
  protected currentPlatform() {
    return 'linux' as const
  }

  protected hostBeat(secrets: Secrets) {
    const fetchFn = vi.fn(async () => {
      if (declared === undefined) throw new Error('network down')
      return {ok: true, status: 202, json: async () => ({data: {engines: declared}})} as unknown as Response
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
    // The round asks for work exactly once, with the claimer the tick built.
    outcome = await options.claimQueue!({projectKey: 'CYAU', repository: 'bussolabs/closeyourit-automator'})
    return {skipped: false, executed: [], seeded: [], scheduleErrors: [], pruned: 0, preflightStopped: [], flowFailures: []} as unknown as RunOnceResult
  }
}

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'automator-tick-claim-'))
  fs.writeFileSync(path.join(dir, 'playbook.yml'), 'version: 1\nactions:\n  hello:\n    schedule: "every 1m"\n    type: shell\n    run: "echo hello"\n')
  fs.mkdirSync(path.join(dir, 'skills'))
  process.env.AUTOMATOR_STATE_DIR = path.join(dir, 'state')
  process.env.AUTOMATOR_CONFIG_DIR = path.join(dir, 'config')
  process.env.AUTOMATOR_PLAYBOOK = path.join(dir, 'playbook.yml')
  process.env.AUTOMATOR_SKILLS_DIR = path.join(dir, 'skills')
  // Built from the prefix: a credential-shaped literal would stop the review of this diff.
  saveSecrets({
    sync: {apiUrl: 'https://x.example'},
    heartbeat: {projectId: 'PID', slug: 'automator-tick', token: 'cyi_ingest'},
    host: {id: 'h1', token: `${HOST_TOKEN_PREFIX}prova`},
  })
  // Only the claim answers: an empty queue, so asking for work costs nothing here.
  claims = 0
  vi.stubGlobal('fetch', vi.fn(async (url: string) => {
    if (!String(url).endsWith('/ticket_queue/next_claim')) throw new Error('offline')
    claims += 1
    return {ok: true, status: 200, json: async () => ({data: null})} as unknown as Response
  }))
  hostEngines.replace(null)
  quota.asked = []
  quota.paused = new Set()
  declared = undefined
  outcome = undefined
})

afterEach(() => {
  process.env = {...savedEnv}
  vi.unstubAllGlobals()
  hostEngines.replace(null)
  fs.rmSync(dir, {recursive: true, force: true})
})

describe('tick — the claim reads the engines of the beat before it', () => {
  it('scenario 1: all on Codex and Claude without quota → only Codex is checked and the tick asks for work', async () => {
    declared = allCodex
    quota.paused.add('claude')
    await run(Tick, [])
    expect(quota.asked).toEqual([['codex']])
    expect(outcome).toEqual({outcome: 'empty'})
    expect(claims).toBe(1)
  })

  it('scenario 3: support on Claude and Claude without quota → the tick stays still and says why', async () => {
    declared = {work: 'codex', reviewer: 'codex', supporter: 'claude'}
    quota.paused.add('claude')
    await run(Tick, [])
    // Codex first: it is the work engine, the first role the list names.
    expect(quota.asked).toEqual([['codex', 'claude']])
    expect(outcome).toMatchObject({outcome: 'unready'})
    expect((outcome as {detail: string}).detail).toContain('claude serve a questa macchina per supporto')
    expect(claims).toBe(0)
  })

  it('scenario 7: the beat before the claim fails → both checked, the tick stays still as before', async () => {
    quota.paused.add('claude')
    await run(Tick, [])
    expect(quota.asked).toEqual([['claude', 'codex']])
    expect(outcome).toMatchObject({outcome: 'unready'})
    expect(claims).toBe(0)
  })
})
