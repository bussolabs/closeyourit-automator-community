import * as path from 'node:path'
import {describe, expect, it} from 'vitest'
import {type ReleaseManifest, runUpdate, type UpdateProbe, type UpdateTransaction} from '../src/lib/update'

const INSTALL_ROOT = '/opt/automator'
const OLD_RELEASE = `${INSTALL_ROOT}/releases/1.0.0`
const NEW_RELEASE = `${INSTALL_ROOT}/releases/1.2.0`

const manifest: ReleaseManifest = {
  channel: 'stable',
  releases: [
    {version: '1.0.0', channel: 'stable', url: 'https://example/1.0.0.tgz', sha256: 'MATCH'},
    {version: '1.2.0', channel: 'stable', url: 'https://example/1.2.0.tgz', sha256: 'MATCH'},
  ],
}

interface AtomicOptions {
  currentVersion?: string | null
  currentTarget?: string | null
  partialExtract?: boolean
  preflightHealthy?: boolean
  postHealth?: boolean[]
  rollbackTargetMismatch?: boolean
}

interface AtomicState {
  calls: string[]
  cleanups: string[]
  currentTarget: () => string | null
  bytes: (release: string) => string | undefined
  readTargetCalls: () => number
  stagingRoots: string[]
}

function atomicProbe(options: AtomicOptions = {}): {probe: UpdateProbe; state: AtomicState} {
  let activeTarget = options.currentTarget === undefined ? OLD_RELEASE : options.currentTarget
  let stagingCounter = 0
  let targetReads = 0
  let healthIndex = 0
  let transaction: UpdateTransaction | null = null
  const calls: string[] = []
  const cleanups: string[] = []
  const stagingRoots: string[] = []
  const contents = new Map<string, string>([[OLD_RELEASE, 'OLD_RELEASE_BYTE_IDENTICAL']])
  const ownership = new Map<string, string>()
  const removed = new Set<string>()

  const probe = {
    acquireLock: () => 'atomic-lock',
    releaseLock: () => {},
    reapStaging: () => 0,
    readTransaction: () => transaction,
    writeTransaction(value: UpdateTransaction) {
      calls.push('write-transaction')
      transaction = value
    },
    clearTransaction() {
      calls.push('clear-transaction')
      transaction = null
    },
    currentVersion: () => options.currentVersion === undefined ? (activeTarget ? path.basename(activeTarget) : null) : options.currentVersion,
    fetchManifest: () => manifest,
    createStaging(releaseDir: string) {
      calls.push('create-staging')
      const root = `${path.dirname(releaseDir)}/.staging-${path.basename(releaseDir)}-${++stagingCounter}`
      stagingRoots.push(root)
      return root
    },
    download(_url: string, dest: string) {
      calls.push(`download:${dest}`)
    },
    checksum() {
      calls.push('checksum')
      return 'MATCH'
    },
    extract(_archive: string, destDir: string) {
      calls.push(`extract:${destDir}`)
      contents.set(destDir, options.partialExtract ? 'PARTIAL_RELEASE' : 'NEW_RELEASE_COMPLETE')
      if (options.partialExtract) throw new Error('partial extract')
    },
    preflight(releaseDir: string) {
      calls.push(`preflight:${releaseDir}`)
      return options.preflightHealthy ?? true
    },
    releaseExists(releaseDir: string) {
      return !removed.has(releaseDir) && (contents.has(releaseDir) || stagingRoots.includes(releaseDir))
    },
    markReleaseOwnership(releaseDir: string, transactionId: string) {
      calls.push('mark-ownership')
      ownership.set(releaseDir, transactionId)
    },
    releaseOwnedBy(releaseDir: string, transactionId: string) {
      return ownership.get(releaseDir) === transactionId
    },
    promote(stagedRelease: string, releaseDir: string) {
      calls.push(`promote:${stagedRelease}->${releaseDir}`)
      const bytes = contents.get(stagedRelease)
      if (bytes === undefined) throw new Error('staging missing')
      contents.set(releaseDir, bytes)
      contents.delete(stagedRelease)
      const owner = ownership.get(stagedRelease)
      if (owner) ownership.set(releaseDir, owner)
    },
    readCurrentTarget() {
      targetReads += 1
      return activeTarget
    },
    serviceInstalled: () => true,
    migrateGuardrails(releaseDir: string) {
      calls.push(`guardrails:${releaseDir}`)
    },
    activate(releaseDir: string) {
      calls.push(`activate:${releaseDir}`)
      activeTarget = releaseDir
    },
    restore(previousTarget: string) {
      calls.push(`restore:${previousTarget}`)
      if (!options.rollbackTargetMismatch) activeTarget = previousTarget
    },
    deactivate(expectedTarget: string) {
      calls.push(`deactivate:${expectedTarget}`)
      if (activeTarget === expectedTarget) activeTarget = null
    },
    restart() {
      calls.push('restart')
    },
    healthCheck() {
      calls.push('health')
      return options.postHealth?.[healthIndex++] ?? true
    },
    cleanup(target: string) {
      calls.push(`cleanup:${target}`)
      cleanups.push(target)
      removed.add(target)
      for (const key of [...contents.keys()]) {
        if (key === target || key.startsWith(`${target}${path.sep}`)) contents.delete(key)
      }
    },
  } as UpdateProbe

  return {
    probe,
    state: {
      calls,
      cleanups,
      currentTarget: () => activeTarget,
      bytes: (release) => contents.get(release),
      readTargetCalls: () => targetReads,
      stagingRoots,
    },
  }
}

describe('CYAU-48 — installation in a new staging and atomic switch', () => {
  it('a pin of the already active version is a no-op and does not rewrite the bytes used by the rollback', () => {
    const {probe, state} = atomicProbe()
    const result = runUpdate({installRoot: INSTALL_ROOT, channel: 'stable', targetVersion: '1.0.0'}, probe)

    expect(result.outcome).toBe('up-to-date')
    expect(state.calls).toEqual([`guardrails:${OLD_RELEASE}`, 'restart', 'health'])
    expect(state.bytes(OLD_RELEASE)).toBe('OLD_RELEASE_BYTE_IDENTICAL')
    expect(state.currentTarget()).toBe(OLD_RELEASE)
  })

  it('a partial extraction is confined and removed without touching current or the previous release', () => {
    const {probe, state} = atomicProbe({partialExtract: true})
    let result: ReturnType<typeof runUpdate> | undefined

    expect(() => { result = runUpdate({installRoot: INSTALL_ROOT, channel: 'stable'}, probe) }).not.toThrow()
    expect(result?.outcome).toBe('failed')
    expect(state.currentTarget()).toBe(OLD_RELEASE)
    expect(state.bytes(OLD_RELEASE)).toBe('OLD_RELEASE_BYTE_IDENTICAL')
    expect(state.calls.some((call) => call.startsWith(`activate:`))).toBe(false)
    expect(state.cleanups).toContain(state.stagingRoots[0])
  })

  it('an unhealthy candidate fails before the switch and leaves current intact', () => {
    const {probe, state} = atomicProbe({preflightHealthy: false})
    const result = runUpdate({installRoot: INSTALL_ROOT, channel: 'stable'}, probe)

    expect(result.outcome).toBe('failed')
    expect(result.activated).toBe(false)
    expect(state.currentTarget()).toBe(OLD_RELEASE)
    expect(state.bytes(OLD_RELEASE)).toBe('OLD_RELEASE_BYTE_IDENTICAL')
    expect(state.calls.some((call) => call.startsWith('activate:'))).toBe(false)
  })

  it('verifies the checksum, extracts into a unique staging, runs the preflight and promotes before the switch', () => {
    const {probe, state} = atomicProbe()
    const result = runUpdate({installRoot: INSTALL_ROOT, channel: 'stable'}, probe)

    expect(result.outcome).toBe('updated')
    expect(state.stagingRoots).toHaveLength(1)
    expect(state.stagingRoots[0]).not.toBe(NEW_RELEASE)
    const sequence = state.calls.map((call) => call.split(':')[0])
    expect(sequence).toEqual([
      'create-staging', 'download', 'checksum', 'extract', 'preflight', 'mark-ownership', 'write-transaction', 'promote',
      'cleanup', 'activate', 'guardrails', 'restart', 'health', 'clear-transaction',
    ])
    expect(state.currentTarget()).toBe(NEW_RELEASE)
    expect(state.bytes(NEW_RELEASE)).toBe('NEW_RELEASE_COMPLETE')
    expect(state.bytes(OLD_RELEASE)).toBe('OLD_RELEASE_BYTE_IDENTICAL')
  })

  it('a failed post-switch health atomically restores and verifies the previous target and bytes', () => {
    const {probe, state} = atomicProbe({postHealth: [false, true]})
    const result = runUpdate({installRoot: INSTALL_ROOT, channel: 'stable'}, probe)

    expect(result.outcome).toBe('rolled-back')
    expect(result.rolledBack).toBe(true)
    expect(state.currentTarget()).toBe(OLD_RELEASE)
    expect(state.bytes(OLD_RELEASE)).toBe('OLD_RELEASE_BYTE_IDENTICAL')
    expect(state.calls).toContain(`restore:${OLD_RELEASE}`)
    expect(state.readTargetCalls()).toBeGreaterThanOrEqual(3)
  })

  it('after rollback deletes the promoted final and a retry can promote the same version', () => {
    const {probe, state} = atomicProbe({postHealth: [false, true, true]})
    const first = runUpdate({installRoot: INSTALL_ROOT, channel: 'stable'}, probe)
    expect(first.outcome).toBe('rolled-back')
    expect(state.currentTarget()).toBe(OLD_RELEASE)
    expect(state.bytes(NEW_RELEASE)).toBeUndefined()

    const retry = runUpdate({installRoot: INSTALL_ROOT, channel: 'stable'}, probe)
    expect(retry.outcome).toBe('updated')
    expect(state.currentTarget()).toBe(NEW_RELEASE)
    expect(state.bytes(NEW_RELEASE)).toBe('NEW_RELEASE_COMPLETE')
  })

  it('a rollback whose target does not match the previous one is rejected as unverified', () => {
    const {probe, state} = atomicProbe({postHealth: [false], rollbackTargetMismatch: true})
    const result = runUpdate({installRoot: INSTALL_ROOT, channel: 'stable'}, probe)

    expect(result.outcome).toBe('failed')
    expect(result.rolledBack).toBe(false)
    expect(result.reason).toContain('rollback non verificato')
    expect(state.currentTarget()).toBe(NEW_RELEASE)
    expect(state.bytes(OLD_RELEASE)).toBe('OLD_RELEASE_BYTE_IDENTICAL')
  })
})
