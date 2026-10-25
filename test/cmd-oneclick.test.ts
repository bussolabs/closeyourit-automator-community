import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import {afterEach, beforeEach, describe, expect, it} from 'vitest'
import OneClick from '../src/commands/oneclick'
import {
  emptyOneClickState,
  type OneClickStageDeps,
  type OneClickStageId,
  type OneClickState,
  type OneClickStore,
} from '../src/lib/oneclick'
import {type ProbeResult} from '../src/lib/deps'
import {runCaptured, runExpectingExit} from './helpers/command'

const okDep = (name: string, present = true, required = true): ProbeResult => ({name, bin: name, present, version: present ? '1' : null, required})

/** Injectable in-memory store: seed of the completed stages + trace of the saves. */
function memStore(initial: OneClickStageId[] = []): {store: OneClickStore; state: () => OneClickState; resets: () => number} {
  let state: OneClickState = {version: 1, updated_at: '', completed: [...initial]}
  let resetCount = 0
  return {
    state: () => state,
    resets: () => resetCount,
    store: {
      load: () => structuredClone(state),
      save: (s) => {
        state = structuredClone(s)
      },
      reset: () => {
        resetCount += 1
        state = emptyOneClickState()
      },
    },
  }
}

/** Fake all-green stage probes, overridable; they track the invocation order. */
function fakeStageDeps(over: Partial<OneClickStageDeps> = {}): {deps: OneClickStageDeps; calls: string[]} {
  const calls: string[] = []
  const track = <T>(id: string, fn: () => Promise<T>): (() => Promise<T>) => async () => {
    calls.push(id)
    return fn()
  }
  const deps: OneClickStageDeps = {
    probeToolchain: track('toolchain', async () => [okDep('cyi')]),
    probeAuth: track('auth', async () => ({github: true, cyi: true, claudeAuth: true, codex: true})),
    runUpdate: track('update', async () => ({status: 'completed', detail: 'update'})),
    runInstall: track('install', async () => ({status: 'completed', detail: 'install'})),
    runEnrollment: track('enroll', async () => ({ready: true, steps: [], diagnostics: {deps: [], runtimes: []}})),
    replicate: track('workspace', async () => ({workspaceRoot: '/ws', outcomes: [], rejected: [], cloned: 1, updated: 0, failed: 0})),
    syncSkills: track('skills', async () => ({version: '0.1.0', repo: 'o/r', ref: 'v0.1.0', action: 'cloned' as const, ok: true, pluginDir: '/d/skills/current', detail: 'ok', pinCheck: {state: 'aligned' as const}})),
    diagnose: track('doctor', async () => ({deps: [okDep('cyi')], runtimes: [{id: 'claude', required: true, available: true}]})),
    ...over,
  }
  return {deps, calls}
}

/** Command subclass injecting fake stageDeps and store (the real orchestration stays unchanged). */
function testCommand(deps: OneClickStageDeps, store: OneClickStore): typeof OneClick {
  return class extends OneClick {
    protected override makeStore(): OneClickStore {
      return store
    }

    protected override stageDeps(): OneClickStageDeps {
      return deps
    }
  }
}

let dir: string
const savedEnv = {...process.env}

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'automator-cmd-oneclick-'))
  process.env.AUTOMATOR_CONFIG_DIR = dir
  process.env.AUTOMATOR_STATE_DIR = dir
})

afterEach(() => {
  process.env = {...savedEnv}
  fs.rmSync(dir, {recursive: true, force: true})
})

interface Payload {
  ready: boolean
  stopped: string | null
  status: string
  completed: string[]
  stages: Array<{stage: string; status: string}>
}

describe('oneclick command', () => {
  it('all stages complete → exit 0, ready, machine ready', async () => {
    const {deps, calls} = fakeStageDeps()
    const {store} = memStore()
    const {result, stdout} = await runCaptured(testCommand(deps, store), [])
    const payload = result as Payload
    expect(payload.ready).toBe(true)
    expect(payload.completed).toEqual(['toolchain', 'auth', 'update', 'install', 'enroll', 'workspace', 'skills', 'doctor'])
    expect(calls).toEqual(['toolchain', 'auth', 'update', 'install', 'enroll', 'workspace', 'skills', 'doctor'])
    expect(stdout).toContain('pronta')
  })

  it('auth stage blocked (missing login) → exit 3 with C409-ONECLICK-001 and instructions', async () => {
    const {deps} = fakeStageDeps({probeAuth: async () => ({github: false, cyi: true, claudeAuth: true, codex: true})})
    const {store} = memStore()
    const {stderr, stdout} = await runExpectingExit(testCommand(deps, store), [], 3)
    expect(stderr).toContain('C409-ONECLICK-001')
    expect(stdout).toContain('gh auth login')
    expect(stdout).toContain("rilancia 'automator oneclick'")
  })

  it('workspace stage failed (manifest not retrievable) → exit 1 with C500-ONECLICK-002', async () => {
    const {deps} = fakeStageDeps({replicate: async () => null})
    const {store} = memStore()
    const {stderr} = await runExpectingExit(testCommand(deps, store), [], 1)
    expect(stderr).toContain('C500-ONECLICK-002')
  })

  it('resume: already completed stages are skipped, resumes from the next one', async () => {
    const {deps, calls} = fakeStageDeps()
    const {store} = memStore(['toolchain', 'auth'])
    const {result} = await runCaptured(testCommand(deps, store), [])
    expect(calls).toEqual(['update', 'install', 'enroll', 'workspace', 'skills', 'doctor'])
    expect((result as Payload).ready).toBe(true)
  })

  it('--reset discards the state and reruns all stages', async () => {
    const {deps, calls} = fakeStageDeps()
    const {store, resets} = memStore(['toolchain', 'auth', 'update', 'install', 'enroll', 'workspace', 'doctor'])
    await runCaptured(testCommand(deps, store), ['--reset'])
    expect(resets()).toBe(1)
    expect(calls).toEqual(['toolchain', 'auth', 'update', 'install', 'enroll', 'workspace', 'skills', 'doctor'])
  })

  it('--json returns the structured payload without the human-readable lines', async () => {
    const {deps} = fakeStageDeps()
    const {store} = memStore()
    const {result, stdout} = await runCaptured(testCommand(deps, store), ['--json'])
    expect((result as Payload).ready).toBe(true)
    expect(stdout).not.toContain('OneClick provisioning')
  })

  it('--json on a blocked stage: exit 3, payload with error in the JSON', async () => {
    const {deps} = fakeStageDeps({probeToolchain: async () => [okDep('cyi', false)]})
    const {store} = memStore()
    const {stdout} = await runExpectingExit(testCommand(deps, store), ['--json'], 3)
    // In --json the payload + error end up on stdout (oclif suppresses stderr in JSON), no human-readable tables.
    expect(stdout).toContain('C409-ONECLICK-001')
    expect(stdout).not.toContain('OneClick provisioning')
  })
})
