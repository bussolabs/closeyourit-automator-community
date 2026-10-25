import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import {afterEach, beforeEach, describe, expect, it} from 'vitest'
import {
  BOOTSTRAP_SCRIPT,
  ONECLICK_STAGES,
  authOutcome,
  buildOneClickStages,
  defaultOneClickStore,
  doctorOutcome,
  emptyOneClickState,
  enrollOutcome,
  readOneClickState,
  runOneClick,
  skillsOutcome,
  subcommandOutcome,
  toolchainOutcome,
  workspaceOutcome,
  type OneClickStageId,
  type OneClickStages,
  type OneClickState,
  type OneClickStore,
  type StageHandler,
} from '../src/lib/oneclick'
import {type ProbeResult} from '../src/lib/deps'
import {type EnrollResult} from '../src/lib/enroll'
import {type ReplicationReport} from '../src/lib/workspace-manifest'
import {type SkillsSyncReport} from '../src/lib/skills-manifest'

/** In-memory store: records every save to verify the checkpoints. */
function memStore(initial: OneClickStageId[] = []): {store: OneClickStore; saved: OneClickState[]} {
  let state: OneClickState = {version: 1, updated_at: '', completed: [...initial]}
  const saved: OneClickState[] = []
  return {
    saved,
    store: {
      load: () => structuredClone(state),
      save: (s) => {
        state = structuredClone(s)
        saved.push(structuredClone(s))
      },
      reset: () => {
        state = emptyOneClickState()
      },
    },
  }
}

/** Fake stages that record the execution order and complete, unless overridden. */
function recordingStages(order: string[], overrides: Partial<OneClickStages> = {}): OneClickStages {
  const make = (id: OneClickStageId): StageHandler => async () => {
    order.push(id)
    return {status: 'completed', detail: id}
  }
  const stages = {} as OneClickStages
  for (const id of ONECLICK_STAGES) stages[id] = make(id)
  return {...stages, ...overrides}
}

const okDep = (name: string, required = true, present = true): ProbeResult => ({name, bin: name, present, version: present ? '1' : null, required})

describe('runOneClick', () => {
  it('runs the stages in canonical order and completes (ready)', async () => {
    const order: string[] = []
    const {store, saved} = memStore()
    const result = await runOneClick({stages: recordingStages(order), store, now: () => 'T'})
    expect(order).toEqual([...ONECLICK_STAGES])
    expect(result.ready).toBe(true)
    expect(result.status).toBe('ready')
    expect(result.stopped).toBeNull()
    expect(result.completed).toEqual([...ONECLICK_STAGES])
    // Checkpoint after EVERY completed stage.
    expect(saved).toHaveLength(ONECLICK_STAGES.length)
    expect(saved.at(-1)?.updated_at).toBe('T')
  })

  it('resumes from the non-completed stage (resume from checkpoint)', async () => {
    const order: string[] = []
    const {store} = memStore(['toolchain', 'auth'])
    const result = await runOneClick({stages: recordingStages(order), store})
    expect(order).toEqual(['update', 'install', 'enroll', 'workspace', 'skills', 'doctor'])
    expect(result.results.filter((r) => r.status === 'skipped').map((r) => r.stage)).toEqual(['toolchain', 'auth'])
    expect(result.ready).toBe(true)
  })

  it('stops at the first blocked stage; the following ones are not run', async () => {
    const order: string[] = []
    const {store, saved} = memStore()
    const stages = recordingStages(order, {
      update: async () => {
        order.push('update')
        return {status: 'blocked', detail: 'serve login', instructions: ['fai X']}
      },
    })
    const result = await runOneClick({stages, store})
    expect(order).toEqual(['toolchain', 'auth', 'update'])
    expect(result.ready).toBe(false)
    expect(result.stopped).toBe('update')
    expect(result.status).toBe('blocked')
    expect(result.instructions).toEqual(['fai X'])
    // The stages completed BEFORE the block are persisted → a rerun resumes from update.
    expect(saved.at(-1)?.completed).toEqual(['toolchain', 'auth'])
  })

  it('stops at the first failed stage with status failed', async () => {
    const order: string[] = []
    const {store} = memStore()
    const stages = recordingStages(order, {
      workspace: async () => {
        order.push('workspace')
        return {status: 'failed', detail: 'manifest ko'}
      },
    })
    const result = await runOneClick({stages, store})
    expect(result.ready).toBe(false)
    expect(result.stopped).toBe('workspace')
    expect(result.status).toBe('failed')
    expect(order).toEqual(['toolchain', 'auth', 'update', 'install', 'enroll', 'workspace'])
  })

  it('propagates data and instructions into the results', async () => {
    const {store} = memStore()
    const stages = recordingStages([], {workspace: async () => ({status: 'completed', detail: 'ws', data: {cloned: 2}})})
    const result = await runOneClick({stages, store})
    expect(result.results.find((r) => r.stage === 'workspace')?.data).toEqual({cloned: 2})
  })

  it('a rerun after full completion is a no-op (all skipped)', async () => {
    const order: string[] = []
    const {store} = memStore([...ONECLICK_STAGES])
    const result = await runOneClick({stages: recordingStages(order), store})
    expect(order).toEqual([])
    expect(result.results.every((r) => r.status === 'skipped')).toBe(true)
    expect(result.ready).toBe(true)
  })
})

describe('readOneClickState / defaultOneClickStore', () => {
  let dir: string
  let file: string

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'automator-oneclick-'))
    file = path.join(dir, 'oneclick.json')
  })

  afterEach(() => fs.rmSync(dir, {recursive: true, force: true}))

  it('missing file → empty state (restarts from the first stage)', () => {
    expect(readOneClickState(file)).toEqual(emptyOneClickState())
  })

  it('illegal JSON → empty state', () => {
    fs.writeFileSync(file, '{nope')
    expect(readOneClickState(file)).toEqual(emptyOneClickState())
  })

  it('non-object root → empty state', () => {
    fs.writeFileSync(file, '[1,2,3]')
    expect(readOneClickState(file)).toEqual(emptyOneClickState())
  })

  it('filters unknown stage ids from completed', () => {
    fs.writeFileSync(file, JSON.stringify({version: 1, updated_at: 'T', completed: ['toolchain', 'bogus', 'auth', 42]}))
    expect(readOneClickState(file)).toEqual({version: 1, updated_at: 'T', completed: ['toolchain', 'auth']})
  })

  it('non-array completed → empty', () => {
    fs.writeFileSync(file, JSON.stringify({completed: 'nope'}))
    expect(readOneClickState(file).completed).toEqual([])
  })

  it('round-trip via defaultOneClickStore (atomic write) + reset', () => {
    const store = defaultOneClickStore(file)
    store.save({version: 1, updated_at: 'T', completed: ['toolchain']})
    expect(store.load().completed).toEqual(['toolchain'])
    store.reset()
    expect(store.load()).toEqual(emptyOneClickState())
    expect(fs.existsSync(file)).toBe(false)
  })
})

describe('toolchainOutcome', () => {
  it('required CLIs present → completed', () => {
    expect(toolchainOutcome([okDep('cyi'), okDep('claude')]).status).toBe('completed')
  })

  it('missing required CLI → blocked with bootstrap.sh', () => {
    const o = toolchainOutcome([okDep('cyi', true, false)])
    expect(o.status).toBe('blocked')
    expect(o.detail).toContain('cyi')
    expect(o.instructions?.[0]).toContain(BOOTSTRAP_SCRIPT)
  })

  it('missing optional CLI does not block', () => {
    expect(toolchainOutcome([okDep('codex', false, false)]).status).toBe('completed')
  })
})

describe('authOutcome', () => {
  // CYRA-921 — on a machine that works with Codex, Codex must be signed in and Claude is optional.
  it('on a Codex machine asks for the Codex login and not for the Claude one', () => {
    expect(authOutcome({github: true, cyi: true, claudeAuth: false, codex: true}, 'codex').status).toBe('completed')
    const missing = authOutcome({github: true, cyi: true, claudeAuth: true, codex: false}, 'codex')
    expect(missing.status).toBe('blocked')
    expect(missing.instructions?.join(' ')).toContain('codex login')
  })

  it('gh/cyi/claude present, codex missing → completed with optional warning', () => {
    const o = authOutcome({github: true, cyi: true, claudeAuth: true, codex: false})
    expect(o.status).toBe('completed')
    expect(o.detail).toContain('codex login')
  })

  it('codex present → completed without warning', () => {
    expect(authOutcome({github: true, cyi: true, claudeAuth: true, codex: true}).detail).toContain('codex autenticato')
  })

  it('missing gh → blocked with gh auth login', () => {
    const o = authOutcome({github: false, cyi: true, claudeAuth: true, codex: true})
    expect(o.status).toBe('blocked')
    expect(o.instructions?.join(' ')).toContain('gh auth login')
  })

  it('missing cyi and claude → blocked with both instructions', () => {
    const o = authOutcome({github: true, cyi: false, claudeAuth: false, codex: false})
    expect(o.instructions).toHaveLength(2)
    expect(o.instructions?.join(' ')).toContain('cyi login')
    expect(o.instructions?.join(' ')).toContain('claude login')
  })
})

describe('enrollOutcome', () => {
  const enroll = (over: Partial<EnrollResult>): EnrollResult => ({ready: true, steps: [], diagnostics: {deps: [], runtimes: []}, ...over})

  it('ready → completed', () => {
    expect(enrollOutcome(enroll({ready: true})).status).toBe('completed')
  })

  it('not ready → blocked with the steps and the missing CLIs (never the tokens)', () => {
    const o = enrollOutcome(enroll({
      ready: false,
      steps: [{key: 'service', label: 'Servizio di sistema', required: true, status: 'missing'}],
      diagnostics: {deps: [okDep('cyi', true, false)], runtimes: []},
    }))
    expect(o.status).toBe('blocked')
    expect(o.detail).toContain('Servizio di sistema')
    expect(o.detail).toContain('CLI cyi')
  })

  // CYAU-95: the `skills` stage that installs the bundle comes AFTER enroll (and requires the host identity that
  // enroll registers). If the missing bundle blocked here, the first provisioning could never complete.
  it('only the skill bundle missing → completed: the next stage installs it', () => {
    const o = enrollOutcome(enroll({
      ready: false,
      steps: [{key: 'skill-bundle', label: 'Bundle skill (skill-mode)', required: true, status: 'missing'}],
    }))
    expect(o.status).toBe('completed')
  })

  it('skill bundle missing TOGETHER with another prerequisite → blocked, and the bundle is not among the blockers', () => {
    const o = enrollOutcome(enroll({
      ready: false,
      steps: [
        {key: 'skill-bundle', label: 'Bundle skill (skill-mode)', required: true, status: 'missing'},
        {key: 'service', label: 'Servizio di sistema', required: true, status: 'missing'},
      ],
    }))
    expect(o.status).toBe('blocked')
    expect(o.detail).toContain('Servizio di sistema')
    expect(o.detail).not.toContain('Bundle skill')
  })
})

describe('workspaceOutcome', () => {
  it('null report → failed (manifest not retrievable)', () => {
    expect(workspaceOutcome(null).status).toBe('failed')
  })

  it('report → completed coi conteggi (best-effort), data = report', () => {
    const report: ReplicationReport = {workspaceRoot: '/ws', outcomes: [], rejected: [], cloned: 2, updated: 1, failed: 0}
    const o = workspaceOutcome(report)
    expect(o.status).toBe('completed')
    expect(o.detail).toContain('2 clonati')
    expect(o.data).toBe(report)
  })
})

// The stage NEVER blocks (skills are optional): what changes is what the operator reads.
describe('skillsOutcome', () => {
  const report = (over: Partial<SkillsSyncReport> = {}): SkillsSyncReport => ({
    version: '0.1.0', repo: 'o/r', ref: 'v0.1.0', action: 'cloned', ok: true, pluginDir: '/d/skills/current', detail: 'ok',
    pinCheck: {state: 'aligned'}, ...over,
  })

  it('no pinned bundle → completed, prompt-mode', () => {
    expect(skillsOutcome(null)).toMatchObject({status: 'completed'})
    expect(skillsOutcome(null).detail).toContain('prompt-mode')
  })

  it('promoted → completed with the active plugin dir', () => {
    expect(skillsOutcome(report()).detail).toContain('/d/skills/current')
  })

  it('already aligned → completed, stated as such (not "promoted")', () => {
    const o = skillsOutcome(report({action: 'current', detail: 'bundle 0.1.0 già attivo'}))
    expect(o.status).toBe('completed')
    expect(o.detail).toContain('già attivo')
  })

  it('failed sync → completed but reported as prompt-mode', () => {
    expect(skillsOutcome(report({action: 'occupied', ok: false, pluginDir: null, detail: 'path occupato'})).detail).toContain('prompt-mode')
  })

  // CYAU-117: a mismatch is NOT a missing optional bundle, it is a failed integrity check (the content
  // at the origin does not match the approved version). Hiding it as "completed" lets the host continue
  // as if nothing happened: it must show as FAILED to whoever looks at the outcome.
  it('mismatch (failed integrity check) → FAILED, not completed', () => {
    const o = skillsOutcome(report({action: 'mismatch', ok: false, pluginDir: null, detail: 'digest non combacia (atteso abc, ottenuto def)'}))
    expect(o.status).toBe('failed')
    expect(o.detail).toContain('digest non combacia')
  })

  // CYAU-135: the bundle is fine — it is aligned to the pin — but the pin is stuck at an outdated version. The stage
  // stays completed (the host has nothing to fix) and says so to whoever reads the setup outcome: it is the only way
  // to notice it without looking at the database.
  it('pin left behind → completed, but the gap is written in the outcome', () => {
    const o = skillsOutcome(report({action: 'current', detail: 'bundle 0.1.0 già attivo', pinCheck: {state: 'behind', lag: {pinned: '0.1.0', latest: '0.1.2'}}}))
    expect(o.status).toBe('completed')
    expect(o.detail).toContain('0.1.2')
    expect(o.detail).toContain('pin')
  })

  // A failed check read as "pin fine" would bring back exactly the silence the ticket removes.
  it('failed pin check → stated as not verified, not as aligned', () => {
    const o = skillsOutcome(report({pinCheck: {state: 'unknown'}}))
    expect(o.detail).toContain('non verificato')
  })

  it('aligned pin → no distracting note', () => {
    expect(skillsOutcome(report()).detail).not.toContain('pin')
  })
})

describe('doctorOutcome', () => {
  it('required CLIs and runtimes ok → completed', () => {
    expect(doctorOutcome([okDep('cyi')], [{id: 'claude', required: true, available: true}]).status).toBe('completed')
  })

  it('missing required runtime → failed', () => {
    expect(doctorOutcome([], [{id: 'claude', required: true, available: false}]).status).toBe('failed')
  })

  it('missing required CLI → failed', () => {
    expect(doctorOutcome([okDep('cyi', true, false)], []).status).toBe('failed')
  })

  it('codex available → noted as available', () => {
    const o = doctorOutcome([], [{id: 'claude', required: true, available: true}, {id: 'codex', required: false, available: true}])
    expect(o.detail).toContain('disponibile')
  })
})

describe('subcommandOutcome', () => {
  it('exit 0 → completed', () => {
    expect(subcommandOutcome('update', [], 0).status).toBe('completed')
  })

  it('exit 3 → blocked with oneclick rerun instruction', () => {
    const o = subcommandOutcome('update', ['--channel', 'stable'], 3)
    expect(o.status).toBe('blocked')
    expect(o.instructions?.[0]).toContain('oneclick')
  })

  it('altro exit → failed', () => {
    expect(subcommandOutcome('install', [], 1).status).toBe('failed')
  })
})

describe('buildOneClickStages', () => {
  it('maps each stage to the correct outcome helper applied to the probes', async () => {
    const stages = buildOneClickStages({
      probeToolchain: async () => [okDep('cyi')],
      probeAuth: async () => ({github: true, cyi: true, claudeAuth: true, codex: true}),
      runUpdate: async () => ({status: 'completed', detail: 'update fatto'}),
      runInstall: async () => ({status: 'completed', detail: 'install fatto'}),
      runEnrollment: async () => ({ready: true, steps: [], diagnostics: {deps: [], runtimes: []}}),
      replicate: async () => ({workspaceRoot: '/ws', outcomes: [], rejected: [], cloned: 0, updated: 0, failed: 0}),
      syncSkills: async () => ({version: '0.1.0', repo: 'o/r', ref: 'v0.1.0', action: 'cloned' as const, ok: true, pluginDir: '/d/skills/current', detail: 'ok', pinCheck: {state: 'aligned' as const}}),
      diagnose: async () => ({deps: [okDep('cyi')], runtimes: [{id: 'claude', required: true, available: true}]}),
    })
    expect((await stages.toolchain()).status).toBe('completed')
    expect((await stages.auth()).status).toBe('completed')
    expect((await stages.update()).detail).toBe('update fatto')
    expect((await stages.install()).detail).toBe('install fatto')
    expect((await stages.enroll()).status).toBe('completed')
    expect((await stages.workspace()).status).toBe('completed')
    expect((await stages.skills()).status).toBe('completed')
    expect((await stages.doctor()).status).toBe('completed')
  })
})
