import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import {afterEach, describe, expect, it} from 'vitest'
import {
  assessServerCompatibility,
  assertReleaseChannel,
  checksumMatches,
  type CommandRunner,
  compareSemver,
  computeSha256,
  currentLinkFor,
  defaultCommandRunner,
  defaultUpdateFs,
  defaultUpdateProbe,
  DEFAULT_CHANNEL,
  isReleaseChannel,
  normalizeChecksum,
  parseManifest,
  parseSemver,
  planUpdate,
  processStartIdentity,
  RECOVERY_REPEAT_HINT,
  RELEASE_CHANNELS,
  type ReleaseEntry,
  type ReleaseManifest,
  releaseDirFor,
  runUpdate,
  selectPinnedRelease,
  selectTargetRelease,
  SERVICE_RECONCILIATION_HINT,
  stagingPrefixFor,
  type UpdateFs,
  type UpdateProbe,
  UpdateResultSchema,
  UpdateTransactionSchema,
  type UpdateTransaction,
  versionOutputMatches,
} from '../src/lib/update'
import {AutomatorError, ErrorCodes} from '../src/errors/error-codes'
import {saveManagedServiceConfig} from '../src/lib/managed-service'

// Distribution and controlled updates of the Automator (CYAU-33): the Automator ships as a versioned artifact
// published on a CHANNEL (stable/beta), described by a manifest with sha256 checksum and server
// compatibility requirements. The update uses an ATOMIC layout (releases/<version> + `current` symlink): it downloads a
// VERIFIED version, extracts it, swaps `current`; on health check failure it restores the symlink to the
// previous release WITHOUT touching state/config → no run lost. The core is pure (channels, semver, checksum,
// compat, selection, plan); the execution lives behind an injectable probe (mocked in tests, real commands in
// prod). No operation touches the stateDir → "without losing runs" is a STRUCTURAL property of the probe.

// ── Canali ────────────────────────────────────────────────────────────────────────────────────────────────

describe('stable/beta distribution channels', () => {
  it('RELEASE_CHANNELS lists stable and beta, the default is stable', () => {
    expect(RELEASE_CHANNELS).toEqual(['stable', 'beta'])
    expect(DEFAULT_CHANNEL).toBe('stable')
  })

  it('isReleaseChannel recognizes only the known channels', () => {
    expect(isReleaseChannel('stable')).toBe(true)
    expect(isReleaseChannel('beta')).toBe(true)
    expect(isReleaseChannel('nightly')).toBe(false)
    expect(isReleaseChannel('')).toBe(false)
  })

  it('assertReleaseChannel throws C400-UPDATE-001 (exit 2) on unknown channel', () => {
    expect(() => assertReleaseChannel('stable')).not.toThrow()
    const err = (() => {
      try {
        assertReleaseChannel('nightly')
      } catch (e) {
        return e as AutomatorError
      }
    })()
    expect(err).toBeInstanceOf(AutomatorError)
    expect(err?.code).toBe(ErrorCodes.Update.invalidInput)
    expect(err?.exitCode).toBe(2)
  })
})

// ── Semver ────────────────────────────────────────────────────────────────────────────────────────────────

describe('parseSemver / compareSemver', () => {
  it('parses canonical major.minor.patch with optional prerelease', () => {
    expect(parseSemver('1.2.3')).toEqual({major: 1, minor: 2, patch: 3, prerelease: []})
    expect(parseSemver('1.4.0-beta.2')).toEqual({major: 1, minor: 4, patch: 0, prerelease: ['beta', '2']})
  })

  it('rejects non-semver versions → null', () => {
    for (const bad of [
      // Four components: a sample starting with 0 so the public-copy IPv4 check (CYAU-242) does not read it as an address.
      '', '1', '1.2', '1.2.x', 'abc', '0.1.2.3', '..', 'v0.0.1',
      '01.2.3', '1.02.3', '1.2.03', '1.2.3-01', '1.2.3-alpha..1',
      '9007199254740992.0.0', ' 1.2.3', '1.2.3 ',
    ]) {
      expect(parseSemver(bad)).toBeNull()
    }
  })

  it('orders by major/minor/patch', () => {
    expect(compareSemver(parseSemver('1.0.0')!, parseSemver('2.0.0')!)).toBe(-1)
    expect(compareSemver(parseSemver('1.2.0')!, parseSemver('1.1.9')!)).toBe(1)
    expect(compareSemver(parseSemver('1.2.3')!, parseSemver('1.2.3')!)).toBe(0)
  })

  it('a prerelease is LOWER than the equivalent release (1.4.0-beta.1 < 1.4.0)', () => {
    expect(compareSemver(parseSemver('1.4.0-beta.1')!, parseSemver('1.4.0')!)).toBe(-1)
    expect(compareSemver(parseSemver('1.4.0')!, parseSemver('1.4.0-beta.1')!)).toBe(1)
  })

  it('compares the prerelease identifiers (numeric < alphanumeric, by length)', () => {
    expect(compareSemver(parseSemver('1.0.0-alpha')!, parseSemver('1.0.0-alpha.1')!)).toBe(-1)
    expect(compareSemver(parseSemver('1.0.0-alpha.1')!, parseSemver('1.0.0-alpha.beta')!)).toBe(-1)
    expect(compareSemver(parseSemver('1.0.0-beta.2')!, parseSemver('1.0.0-beta.11')!)).toBe(-1)
    expect(compareSemver(parseSemver('1.0.0-rc.1')!, parseSemver('1.0.0-rc.1')!)).toBe(0)
  })

  it('keeps the SemVer ordering in opposite directions and with equal identifiers', () => {
    expect(compareSemver(parseSemver('2.0.0')!, parseSemver('1.0.0')!)).toBe(1)
    expect(compareSemver(parseSemver('1.1.9')!, parseSemver('1.2.0')!)).toBe(-1)
    expect(compareSemver(parseSemver('1.2.4')!, parseSemver('1.2.3')!)).toBe(1)
    expect(compareSemver(parseSemver('1.0.0-beta')!, parseSemver('1.0.0-2')!)).toBe(1)
    expect(compareSemver(parseSemver('1.0.0-beta')!, parseSemver('1.0.0-alpha')!)).toBe(1)
    expect(compareSemver(parseSemver('1.0.0-alpha')!, parseSemver('1.0.0-alpha')!)).toBe(0)
    expect(compareSemver(parseSemver('1.0.0-beta.2')!, parseSemver('1.0.0-beta.1')!)).toBe(1)
    expect(compareSemver(parseSemver('1.0.0-beta.1')!, parseSemver('1.0.0-beta.2')!)).toBe(-1)
    expect(compareSemver(parseSemver('1.0.0-beta.1')!, parseSemver('1.0.0-beta.1')!)).toBe(0)
  })
})

// ── Checksum ──────────────────────────────────────────────────────────────────────────────────────────────

describe('sha256 checksum (artifact integrity check)', () => {
  it('computeSha256 is deterministic (known vector for "abc")', () => {
    expect(computeSha256('abc')).toBe('ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad')
    expect(computeSha256(Buffer.from('abc'))).toBe(computeSha256('abc'))
  })

  it('normalizeChecksum removes the sha256: prefix, spaces and uppercase', () => {
    expect(normalizeChecksum('SHA256:ABCDEF ')).toBe('abcdef')
    expect(normalizeChecksum('  abcDEF  ')).toBe('abcdef')
  })

  it('checksumMatches compares in a normalized way', () => {
    expect(checksumMatches('sha256:BA7816BF', 'ba7816bf')).toBe(true)
    expect(checksumMatches('deadbeef', 'ba7816bf')).toBe(false)
    expect(checksumMatches('', 'ba7816bf')).toBe(false)
  })
})

// ── Manifest (untrusted data) ────────────────────────────────────────────────────────────────────────────

describe('parseManifest — fail-closed on untrusted input', () => {
  const valid = {
    channel: 'stable',
    releases: [
      {version: '1.0.0', channel: 'stable', url: 'https://x/1.0.0.tgz', sha256: 'aa'},
      {version: '1.1.0', channel: 'stable', url: 'https://x/1.1.0.tgz', sha256: 'bb', minServer: '2.0.0'},
    ],
  }

  it('parses a valid manifest', () => {
    const m = parseManifest(valid)
    expect(m?.channel).toBe('stable')
    expect(m?.releases).toHaveLength(2)
    expect(m?.releases[1].minServer).toBe('2.0.0')
  })

  it('illegal JSON / unexpected shape → null', () => {
    expect(parseManifest(null)).toBeNull()
    expect(parseManifest('stringa')).toBeNull()
    expect(parseManifest({channel: 'stable'})).toBeNull() // releases missing
    expect(parseManifest({channel: 'nightly', releases: []})).toBeNull() // canale fuori dominio
  })

  it('fails closed if even a single entry of the cumulative manifest is malformed', () => {
    expect(parseManifest({
      channel: 'beta',
      releases: [
        {version: '2.0.0-beta.1', channel: 'beta', url: 'https://x/2.tgz', sha256: 'cc'},
        {version: '2.0.0-beta.2'},
      ],
    })).toBeNull()
    expect(parseManifest({
      channel: 'stable',
      releases: [{version: '1.0.0', channel: 'beta', url: 'https://x/1.tgz', sha256: 'aa'}],
    })).toBeNull()
  })

  it('rejects malformed or inverted server constraints in the manifest', () => {
    for (const constraint of [
      {minServer: '2.x'},
      {maxServer: '01.2.3'},
      {minServer: '3.0.0', maxServer: '2.0.0'},
    ]) {
      expect(parseManifest({
        channel: 'stable',
        releases: [{version: '2.0.0', channel: 'stable', url: 'https://x/2.tgz', sha256: 'aa', ...constraint}],
      })).toBeNull()
    }
  })
})

// ── Server/client compatibility ───────────────────────────────────────────────────────────────────────────

describe('assessServerCompatibility', () => {
  it('no requirement → compatible regardless of the server version', () => {
    expect(assessServerCompatibility({}, null).status).toBe('compatible')
    expect(assessServerCompatibility({}, '5.0.0').status).toBe('compatible')
  })

  it('requirement present but unknown server version → unknown (does not block but notes)', () => {
    const r = assessServerCompatibility({minServer: '2.0.0'}, null)
    expect(r.status).toBe('unknown')
    expect(r.reason).toMatch(/sconosciut/i)
  })

  it('server in range → compatible', () => {
    expect(assessServerCompatibility({minServer: '2.0.0', maxServer: '3.0.0'}, '2.5.0').status).toBe('compatible')
    expect(assessServerCompatibility({minServer: '2.0.0'}, '2.0.0').status).toBe('compatible')
  })

  it('server below the minimum or above the maximum → incompatible', () => {
    expect(assessServerCompatibility({minServer: '2.0.0'}, '1.9.0').status).toBe('incompatible')
    expect(assessServerCompatibility({maxServer: '3.0.0'}, '3.1.0').status).toBe('incompatible')
  })

  it('unparsable server version → unknown (conservative, does not block)', () => {
    expect(assessServerCompatibility({minServer: '2.0.0'}, 'boh').status).toBe('unknown')
  })

  it('malformed compatibility constraint → incompatible (never fail-open)', () => {
    expect(assessServerCompatibility({minServer: '9.x'}, '5.0.0').status).toBe('incompatible')
    expect(assessServerCompatibility({maxServer: '01.2.3'}, '1.0.0').status).toBe('incompatible')
    expect(assessServerCompatibility({minServer: '9.x'}, null).status).toBe('incompatible')
    expect(assessServerCompatibility({minServer: ''}, '1.0.0').status).toBe('incompatible')
    expect(assessServerCompatibility({minServer: '3.0.0', maxServer: '2.0.0'}, '2.5.0').status).toBe('incompatible')
  })
})

// ── Target release selection ────────────────────────────────────────────────────────────────────────

function manifest(releases: Array<Partial<ReleaseEntry> & {version: string}>, channel: 'stable' | 'beta' = 'stable'): ReleaseManifest {
  return {
    channel,
    releases: releases.map((r) => ({channel, url: `https://x/${r.version}.tgz`, sha256: 'aa', ...r})),
  }
}

describe('selectTargetRelease', () => {
  it('picks the latest release newer than the current one → update', () => {
    const sel = selectTargetRelease(manifest([{version: '1.0.0'}, {version: '1.2.0'}, {version: '1.1.0'}]), {
      channel: 'stable',
      currentVersion: '1.0.0',
    })
    expect(sel.decision).toBe('update')
    expect(sel.target?.version).toBe('1.2.0')
  })

  it('already on the latest version → up-to-date (nothing to do)', () => {
    const sel = selectTargetRelease(manifest([{version: '1.0.0'}, {version: '1.2.0'}]), {
      channel: 'stable',
      currentVersion: '1.2.0',
    })
    expect(sel.decision).toBe('up-to-date')
    expect(sel.target).toBeNull()
  })

  it('no installed version (current null) → update to the latest (new machine)', () => {
    const sel = selectTargetRelease(manifest([{version: '1.0.0'}, {version: '1.2.0'}]), {
      channel: 'stable',
      currentVersion: null,
    })
    expect(sel.decision).toBe('update')
    expect(sel.target?.version).toBe('1.2.0')
  })

  it('manifest without valid releases → none', () => {
    expect(selectTargetRelease(manifest([]), {channel: 'stable', currentVersion: null}).decision).toBe('none')
  })

  it('skips the releases incompatible with the server and picks the latest compatible one', () => {
    const sel = selectTargetRelease(
      manifest([
        {version: '1.0.0'},
        {version: '2.0.0', minServer: '9.0.0'}, // incompatible with server 5.0.0
        {version: '1.5.0', minServer: '4.0.0'}, // compatibile
      ]),
      {channel: 'stable', currentVersion: '1.0.0', serverVersion: '5.0.0'},
    )
    expect(sel.decision).toBe('update')
    expect(sel.target?.version).toBe('1.5.0')
    expect(sel.skipped.map((s) => s.version)).toContain('2.0.0')
  })

  it('all newer releases are incompatible → incompatible (does not update)', () => {
    const sel = selectTargetRelease(manifest([{version: '1.0.0'}, {version: '2.0.0', minServer: '9.0.0'}]), {
      channel: 'stable',
      currentVersion: '1.0.0',
      serverVersion: '5.0.0',
    })
    expect(sel.decision).toBe('incompatible')
    expect(sel.target).toBeNull()
  })

  it('allowDowngrade allows going down to a previous version', () => {
    const sel = selectTargetRelease(manifest([{version: '1.0.0'}, {version: '2.0.0'}]), {
      channel: 'stable',
      currentVersion: '2.0.0',
      allowDowngrade: true,
    })
    expect(sel.decision).toBe('update')
    expect(sel.target?.version).toBe('2.0.0')
  })
})

describe('selectPinnedRelease', () => {
  it('rejects a pin incompatible with the server instead of bypassing the compatibility gate', () => {
    const sel = selectPinnedRelease(
      manifest([{version: '2.0.0', minServer: '9.0.0'}]),
      {channel: 'stable', currentVersion: '1.0.0', targetVersion: '2.0.0', serverVersion: '5.0.0'},
    )

    expect(sel.decision).toBe('incompatible')
    expect(sel.target).toBeNull()
    expect(sel.skipped).toEqual([{version: '2.0.0', reason: 'richiede server ≥ 9.0.0 (attuale 5.0.0)'}])
  })

  it('notes the uncertainty in automatic mode but rejects the pin when the server is unknown', () => {
    const releases = manifest([{version: '2.0.0', minServer: '1.0.0'}])
    expect(selectTargetRelease(releases, {channel: 'stable', currentVersion: '1.0.0'}).reason)
      .toMatch(/compatibilità server non verificata/)
    const pinned = selectPinnedRelease(releases, {channel: 'stable', currentVersion: '1.0.0', targetVersion: '2.0.0'})
    expect(pinned.decision).toBe('incompatible')
    expect(pinned.reason).toMatch(/compatibilità non verificabile/)
  })

  it.each([
    ['min-1', '1.9.9', 'incompatible'],
    ['exact min', '2.0.0', 'update'],
    ['exact max', '3.0.0', 'update'],
    ['max+1', '3.0.1', 'incompatible'],
  ] as const)('applies the server boundary %s to the pin', (_label, serverVersion, decision) => {
    const releases = manifest([{version: '4.0.0', minServer: '2.0.0', maxServer: '3.0.0'}])

    expect(selectPinnedRelease(releases, {
      channel: 'stable',
      currentVersion: '1.0.0',
      targetVersion: '4.0.0',
      serverVersion,
    }).decision).toBe(decision)
  })

  it.each([
    ['missing', null],
    ['malformed', 'server-next'],
  ] as const)('fails closed when the server version is %s and the pin declares constraints', (_label, serverVersion) => {
    const releases = manifest([{version: '2.0.0', minServer: '1.0.0'}])
    const selection = selectPinnedRelease(releases, {
      channel: 'stable',
      currentVersion: '1.0.0',
      targetVersion: '2.0.0',
      serverVersion,
    })

    expect(selection.decision).toBe('incompatible')
    expect(selection.target).toBeNull()
    expect(selection.reason).toMatch(/non verificabile|non interpretabile/)
  })

  it('rejects a non-SemVer target-version even if an in-memory manifest contains it', () => {
    const releases = manifest([{version: '2.x'}])
    const selection = selectPinnedRelease(releases, {
      channel: 'stable',
      currentVersion: '1.0.0',
      targetVersion: '2.x',
      serverVersion: '2.0.0',
    })

    expect(selection.decision).toBe('none')
    expect(selection.reason).toMatch(/versione target non valida/i)
  })
})

describe('UpdateTransactionSchema — ownership/staging invariants', () => {
  const transaction = {
    version: 1 as const,
    transactionId: '11111111-1111-4111-8111-111111111111',
    targetVersion: '1.2.0',
    targetPath: '/opt/a/releases/1.2.0',
    previousTarget: null,
  }

  it('requires staging for a promoted target and forbids it for a pre-existing one', () => {
    expect(UpdateTransactionSchema.safeParse({...transaction, targetOwnership: 'promoted', stagingRoot: null}).success).toBe(false)
    expect(UpdateTransactionSchema.safeParse({...transaction, targetOwnership: 'preexisting', stagingRoot: '/opt/a/releases/.staging-1.2.0-x'}).success).toBe(false)
  })
})

// ── Piano atomico (path safety) ───────────────────────────────────────────────────────────────────────────

describe('planUpdate / path helpers', () => {
  const entry: ReleaseEntry = {version: '1.2.0', channel: 'stable', url: 'https://x/1.2.0.tgz', sha256: 'aa'}

  it('composes the releases/<version> and current paths and the staging prefix', () => {
    expect(releaseDirFor('/opt/a', '1.2.0')).toBe('/opt/a/releases/1.2.0')
    expect(currentLinkFor('/opt/a')).toBe('/opt/a/current')
    expect(stagingPrefixFor('/opt/a', '1.2.0')).toBe('/opt/a/releases/.staging-1.2.0-')
  })

  it('composes a consistent plan', () => {
    const plan = planUpdate({installRoot: '/opt/a', channel: 'stable', target: entry, fromVersion: '1.0.0'})
    expect(plan.toVersion).toBe('1.2.0')
    expect(plan.fromVersion).toBe('1.0.0')
    expect(plan.releaseDir).toBe('/opt/a/releases/1.2.0')
    expect(plan.currentLink).toBe('/opt/a/current')
    expect(plan.url).toBe('https://x/1.2.0.tgz')
  })

  it('rejects a version that is unsafe as a path segment (traversal) → C400-UPDATE-001', () => {
    for (const bad of ['..', 'a/b', '', '__proto__']) {
      const err = (() => {
        try {
          releaseDirFor('/opt/a', bad)
        } catch (e) {
          return e as AutomatorError
        }
      })()
      expect(err?.code).toBe(ErrorCodes.Update.invalidInput)
      expect(err?.exitCode).toBe(2)
    }
  })
})

// ── runUpdate orchestration (injectable probe) ──────────────────────────────────────────────────────────

interface ProbeCalls {
  download: Array<{url: string; dest: string}>
  extract: Array<{archive: string; destDir: string}>
  activate: string[]
  restore: string[]
  restart: number
  cleanup: string[]
  staging: string[]
  promote: Array<{source: string; destination: string}>
  health: string[]
  transactions: UpdateTransaction[]
  clearTransaction: number
  lockRelease: string[]
  deactivate: string[]
  reapStaging: number
  retainedActivation: string[]
  guardrails: string[]
  serviceInstalled: number
  readTransaction: number
  acquireLock: number
  commitService: number
  rollbackService: number
  recoverService: number
  prepareService: string[]
}

interface FakeProbeOptions {
  current?: string | null
  manifest?: ReleaseManifest
  checksum?: string // the "real" checksum of the downloaded artifact (default = matches the expected one)
  currentTarget?: string | null
  healthy?: boolean
  throwOnActivate?: boolean
  serviceInstalled?: boolean // default true (host with the service already installed); false = first bootstrap
  pending?: UpdateTransaction | null
  lockAvailable?: boolean
  existingReleases?: string[]
  ownedReleases?: Record<string, string>
  healthResults?: boolean[]
  preflightHealthy?: boolean
  retainedIdentityChanged?: boolean
  promoteAfterMoveError?: boolean
  guardrailFailures?: string[]
  manifestError?: Error
  clearTransactionError?: Error
  serviceRecoveryRequired?: boolean
}

const TX_ID = '11111111-1111-4111-8111-111111111111'

function pendingTransaction(overrides: Partial<UpdateTransaction> = {}): UpdateTransaction {
  return {
    version: 1,
    targetVersion: '1.2.0',
    targetPath: '/opt/a/releases/1.2.0',
    previousTarget: '/opt/a/releases/1.0.0',
    transactionId: TX_ID,
    targetOwnership: 'promoted',
    stagingRoot: '/opt/a/releases/.staging-1.2.0-crashed',
    ...overrides,
  } as UpdateTransaction
}

function fakeProbe(opts: FakeProbeOptions): {probe: UpdateProbe; calls: ProbeCalls} {
  const calls: ProbeCalls = {
    download: [], extract: [], activate: [], restore: [], restart: 0, cleanup: [], staging: [], promote: [],
    health: [], transactions: [], clearTransaction: 0, lockRelease: [], deactivate: [], reapStaging: 0,
    retainedActivation: [], guardrails: [],
    serviceInstalled: 0, readTransaction: 0, acquireLock: 0, commitService: 0, rollbackService: 0,
    recoverService: 0, prepareService: [],
  }
  let currentTarget = opts.currentTarget ?? (opts.current ? `/opt/a/releases/${opts.current}` : null)
  let pending = opts.pending ?? null
  let healthChecks = 0
  let promoteAfterMoveFailures = opts.promoteAfterMoveError ? 1 : 0
  const existingReleases = new Set(opts.existingReleases ?? [])
  const ownedReleases = new Map(Object.entries(opts.ownedReleases ?? {}))
  const probe = {
    acquireLock: () => {
      calls.acquireLock += 1
      return opts.lockAvailable === false ? null : 'fake-lock'
    },
    releaseLock: (token) => calls.lockRelease.push(token),
    reapStaging: () => {
      calls.reapStaging += 1
      return 0
    },
    readTransaction: () => {
      calls.readTransaction += 1
      return pending
    },
    writeTransaction: (transaction) => {
      pending = transaction
      calls.transactions.push(transaction)
    },
    clearTransaction: () => {
      calls.clearTransaction += 1
      if (opts.clearTransactionError) throw opts.clearTransactionError
      pending = null
    },
    currentVersion: () => currentTarget ? path.basename(currentTarget) : opts.current ?? null,
    fetchManifest: () => {
      if (opts.manifestError) throw opts.manifestError
      return opts.manifest ?? manifest([])
    },
    download: (url, dest) => calls.download.push({url, dest}),
    checksum: () => opts.checksum ?? 'MATCH',
    createStaging: (prefix) => {
      const staging = `${prefix}test`
      calls.staging.push(staging)
      return staging
    },
    extract: (archive, destDir) => calls.extract.push({archive, destDir}),
    preflight: () => opts.preflightHealthy ?? true,
    activateRetained: (releaseDir: string, _expectedVersion: string, whilePinned: () => boolean) => {
      calls.retainedActivation.push(releaseDir)
      if (opts.preflightHealthy === false) return false
      if (opts.retainedIdentityChanged) {
        currentTarget = releaseDir
        return false
      }
      calls.activate.push(releaseDir)
      currentTarget = releaseDir
      return whilePinned()
    },
    releaseExists: (releaseDir: string) => existingReleases.has(releaseDir),
    markReleaseOwnership: (releaseDir: string, transactionId: string) => ownedReleases.set(releaseDir, transactionId),
    releaseOwnedBy: (releaseDir: string, transactionId: string) => ownedReleases.get(releaseDir) === transactionId,
    promote: (source, destination) => {
      if (existingReleases.has(destination)) throw new Error('release finale già esistente')
      calls.promote.push({source, destination})
      existingReleases.add(destination)
      const owner = ownedReleases.get(source)
      if (owner) ownedReleases.set(destination, owner)
      if (promoteAfterMoveFailures > 0) {
        promoteAfterMoveFailures -= 1
        throw new Error('fsync fallito dopo rename riuscita')
      }
    },
    readCurrentTarget: () => currentTarget,
    serviceInstalled: () => {
      calls.serviceInstalled += 1
      return opts.serviceInstalled ?? true
    },
    recoverService: () => {
      calls.recoverService += 1
      return opts.serviceRecoveryRequired ?? false
    },
    prepareService: (targetPath: string) => {
      calls.prepareService.push(targetPath)
    },
    commitService: () => {
      calls.commitService += 1
    },
    rollbackService: () => {
      calls.rollbackService += 1
    },
    migrateGuardrails: (releaseDir: string) => {
      calls.guardrails.push(releaseDir)
      if (opts.guardrailFailures?.includes(releaseDir)) throw new Error(`guardrail falliti per ${releaseDir}`)
    },
    activate: (releaseDir) => {
      if (opts.throwOnActivate) throw new Error('activate boom')
      calls.activate.push(releaseDir)
      currentTarget = releaseDir
    },
    restore: (prev) => {
      calls.restore.push(prev)
      currentTarget = prev
    },
    deactivate: (expectedTarget: string) => {
      calls.deactivate.push(expectedTarget)
      if (currentTarget === expectedTarget) currentTarget = null
    },
    restart: () => {
      calls.restart += 1
    },
    healthCheck: (expectedVersion) => {
      calls.health.push(expectedVersion)
      const index = healthChecks++
      return opts.healthResults?.[index] ?? (index === 0 ? opts.healthy ?? true : true)
    },
    cleanup: (file) => {
      calls.cleanup.push(file)
      existingReleases.delete(file)
      ownedReleases.delete(file)
    },
  } as UpdateProbe
  return {probe, calls}
}

describe('runUpdate — verified, atomic update with rollback', () => {
  const m = manifest([{version: '1.0.0', sha256: 'sha256:MATCH'}, {version: '1.2.0', sha256: 'sha256:MATCH'}])

  it('happy path: downloads, verifies the checksum, extracts, activates, restarts, health ok → updated', () => {
    const {probe, calls} = fakeProbe({current: '1.0.0', manifest: m, checksum: 'MATCH', healthy: true, currentTarget: '/opt/a/releases/1.0.0'})
    const res = runUpdate({installRoot: '/opt/a', channel: 'stable'}, probe)
    expect(res.outcome).toBe('updated')
    expect(res.fromVersion).toBe('1.0.0')
    expect(res.toVersion).toBe('1.2.0')
    expect(res.verified).toBe(true)
    expect(res.activated).toBe(true)
    expect(res.rolledBack).toBe(false)
    expect(calls.activate).toEqual(['/opt/a/releases/1.2.0'])
    expect(calls.guardrails).toEqual(['/opt/a/releases/1.2.0'])
    expect(calls.prepareService).toEqual(['/opt/a/releases/1.2.0'])
    expect(calls.restart).toBe(1)
    expect(calls.commitService).toBe(1)
    expect(calls.clearTransaction).toBe(1)
    expect(calls.restore).toEqual([]) // no rollback
    expect(calls.cleanup.length).toBe(1) // the downloaded tmp is removed
    expect(UpdateResultSchema.parse(res)).toEqual(res)
  })

  it('if clearTransaction fails it does not commit the service journal', () => {
    const {probe, calls} = fakeProbe({
      current: '1.0.0', manifest: m, checksum: 'MATCH', healthy: true,
      currentTarget: '/opt/a/releases/1.0.0', clearTransactionError: new Error('fsync journal update fallito'),
    })

    const result = runUpdate({installRoot: '/opt/a', channel: 'stable'}, probe)

    expect(result.outcome).toBe('failed')
    expect(calls.clearTransaction).toBeGreaterThan(0)
    expect(calls.commitService).toBe(0)
  })

  it('already on the latest version → reconciles guardrails, restart and health without touching the bytes', () => {
    const {probe, calls} = fakeProbe({current: '1.2.0', manifest: m})
    const res = runUpdate({installRoot: '/opt/a', channel: 'stable'}, probe)
    expect(res.outcome).toBe('up-to-date')
    expect(calls.download).toEqual([])
    expect(calls.activate).toEqual([])
    expect(calls.guardrails).toEqual(['/opt/a/releases/1.2.0'])
    expect(calls.restart).toBe(1)
    expect(calls.health).toEqual(['1.2.0'])
    expect(calls.rollbackService).toBe(0)
    expect(calls.commitService).toBe(1)
  })

  it('already active pin with failed health restores and finalizes the legacy service', () => {
    const {probe, calls} = fakeProbe({current: '1.2.0', manifest: m, healthy: false})
    const result = runUpdate({
      installRoot: '/opt/a', channel: 'stable', targetVersion: '1.2.0', serverVersion: '1.0.0',
    }, probe)

    expect(result.outcome).toBe('failed')
    expect(calls.rollbackService).toBe(1)
    expect(calls.commitService).toBe(1)
  })

  it('orphan restoring service recovery interrupts the run before a later release', () => {
    const {probe, calls} = fakeProbe({
      current: '1.0.0', currentTarget: '/opt/a/releases/1.0.0',
      manifest: manifest([{version: '3.0.0'}]), serviceRecoveryRequired: true,
    })

    const result = runUpdate({installRoot: '/opt/a', channel: 'stable'}, probe)

    expect(result.outcome).toBe('failed')
    expect(result.reason).toMatch(/recovery.*completato.*ripetere update/i)
    expect(calls.recoverService).toBe(1)
    expect(calls.download).toEqual([])
    expect(calls.activate).toEqual([])
    expect(calls.guardrails).toEqual([])
  })

  it('already on the latest version but unhealthy daemon → failed, never up-to-date success', () => {
    const {probe, calls} = fakeProbe({current: '1.2.0', manifest: m, healthy: false})
    const result = runUpdate({installRoot: '/opt/a', channel: 'stable'}, probe)

    expect(result.outcome).toBe('failed')
    expect(result.reason).toMatch(/riconciliazione fallita/i)
    expect(calls.restart).toBe(1)
    expect(calls.health).toEqual(['1.2.0'])
    expect(calls.rollbackService).toBe(1)
    expect(calls.commitService).toBe(1)
  })

  it('first update on a new machine (service NOT yet installed): does not restart but activates and succeeds', () => {
    // Regression: before, the unconditional restart made the first update fail (launchctl/systemctl without unit)
    // despite having already activated current → outcome failed. Now the restart is skipped if the service does not exist.
    const {probe, calls} = fakeProbe({current: null, manifest: m, checksum: 'MATCH', healthy: true, currentTarget: null, serviceInstalled: false})
    const res = runUpdate({installRoot: '/opt/a', channel: 'stable'}, probe)
    expect(res.outcome).toBe('updated')
    expect(res.toVersion).toBe('1.2.0')
    expect(calls.activate).toEqual(['/opt/a/releases/1.2.0'])
    expect(calls.guardrails).toEqual([])
    expect(calls.restart).toBe(0) // no service to restart at the first bootstrap
  })

  it('non-matching checksum → does NOT activate, version not verified, outcome failed', () => {
    const {probe, calls} = fakeProbe({current: '1.0.0', manifest: m, checksum: 'TAMPERED'})
    const res = runUpdate({installRoot: '/opt/a', channel: 'stable'}, probe)
    expect(res.outcome).toBe('failed')
    expect(res.verified).toBe(false)
    expect(res.activated).toBe(false)
    expect(calls.extract).toEqual([]) // never extracted
    expect(calls.activate).toEqual([]) // never activated → no rollback needed
    expect(calls.restore).toEqual([])
    expect(calls.cleanup.length).toBe(1) // the corrupted tmp is removed
  })

  it('failed post-update health check → rollback to the previous release, outcome rolled-back', () => {
    const {probe, calls} = fakeProbe({
      current: '1.0.0',
      manifest: m,
      checksum: 'MATCH',
      healthy: false,
      currentTarget: '/opt/a/releases/1.0.0',
    })
    const res = runUpdate({installRoot: '/opt/a', channel: 'stable'}, probe)
    expect(res.outcome).toBe('rolled-back')
    expect(res.rolledBack).toBe(true)
    expect(res.verified).toBe(true)
    expect(calls.activate).toEqual(['/opt/a/releases/1.2.0']) // ha attivato
    expect(calls.restore).toEqual(['/opt/a/releases/1.0.0']) // then restored the previous one
    expect(calls.guardrails).toEqual(['/opt/a/releases/1.2.0', '/opt/a/releases/1.0.0'])
    expect(calls.prepareService).toEqual(['/opt/a/releases/1.2.0', '/opt/a/releases/1.0.0'])
    expect(calls.restart).toBe(2) // restart after activation + restart after rollback
    // The unhealthy candidate does not commit the service journal: the only commit happens after the rollback health.
    expect(calls.health).toEqual(['1.2.0', '1.0.0'])
    expect(calls.commitService).toBe(1)
  })

  it('failed candidate guardrail migration restores current and the guardrails of the previous release', () => {
    const target = '/opt/a/releases/1.2.0'
    const previous = '/opt/a/releases/1.0.0'
    const {probe, calls} = fakeProbe({
      current: '1.0.0', manifest: m, currentTarget: previous,
      guardrailFailures: [target],
    })

    const result = runUpdate({installRoot: '/opt/a', channel: 'stable'}, probe)

    expect(result.outcome).toBe('rolled-back')
    expect(calls.restore).toEqual([previous])
    expect(calls.guardrails).toEqual([target, previous])
    expect(calls.restart).toBe(1)
  })

  it('fails closed if the restore of the previous guardrails fails too', () => {
    const target = '/opt/a/releases/1.2.0'
    const previous = '/opt/a/releases/1.0.0'
    const {probe, calls} = fakeProbe({
      current: '1.0.0', manifest: m, currentTarget: previous,
      guardrailFailures: [target, previous],
    })

    const result = runUpdate({installRoot: '/opt/a', channel: 'stable'}, probe)

    expect(result.outcome).toBe('failed')
    expect(result.reason).toMatch(/rollback non verificato/i)
    expect(calls.guardrails).toEqual([target, previous])
    expect(calls.restart).toBe(0)
  })

  it('an exception after the swap (activate boom) still rolls back', () => {
    const {probe, calls} = fakeProbe({
      current: '1.0.0',
      manifest: m,
      checksum: 'MATCH',
      currentTarget: '/opt/a/releases/1.0.0',
      throwOnActivate: true,
    })
    const res = runUpdate({installRoot: '/opt/a', channel: 'stable'}, probe)
    expect(res.outcome).toBe('rolled-back')
    expect(calls.restore).toEqual(['/opt/a/releases/1.0.0'])
  })

  it('failed first installation (no previous release) → failed, no rollback possible', () => {
    const {probe, calls} = fakeProbe({current: null, manifest: m, checksum: 'MATCH', healthy: false, currentTarget: null, serviceInstalled: false})
    const res = runUpdate({installRoot: '/opt/a', channel: 'stable'}, probe)
    expect(res.outcome).toBe('failed')
    expect(res.rolledBack).toBe(false)
    expect(calls.restore).toEqual([]) // nothing to go back to
    expect(calls.restart).toBe(0) // service not installed → no restart attempted
    expect(calls.deactivate).toEqual(['/opt/a/releases/1.2.0'])
    expect(calls.cleanup).toContain('/opt/a/releases/1.2.0')
  })

  it('no compatible release → incompatible, nothing touched', () => {
    const incompat = manifest([{version: '1.0.0'}, {version: '2.0.0', minServer: '9.0.0'}])
    const {probe, calls} = fakeProbe({current: '1.0.0', manifest: incompat})
    const res = runUpdate({installRoot: '/opt/a', channel: 'stable', serverVersion: '5.0.0'}, probe)
    expect(res.outcome).toBe('incompatible')
    expect(calls.download).toEqual([])
  })

  it('empty manifest → failed (no release to install)', () => {
    const {probe} = fakeProbe({current: null, manifest: manifest([])})
    const res = runUpdate({installRoot: '/opt/a', channel: 'stable'}, probe)
    expect(res.outcome).toBe('failed')
  })

  it('targetVersion forces a specific channel version (pin), even equal to the current one', () => {
    const {probe, calls} = fakeProbe({
      current: '1.2.0',
      manifest: m,
      checksum: 'MATCH',
      healthy: true,
      currentTarget: '/opt/a/releases/1.2.0',
      existingReleases: ['/opt/a/releases/1.0.0', '/opt/a/releases/1.2.0'],
    })
    const res = runUpdate({installRoot: '/opt/a', channel: 'stable', targetVersion: '1.0.0'}, probe)
    expect(res.outcome).toBe('updated')
    expect(res.toVersion).toBe('1.0.0')
    expect(calls.activate).toEqual(['/opt/a/releases/1.0.0'])
    expect(calls.download).toEqual([])
    expect(calls.promote).toEqual([])
  })

  it('targetVersion missing from the channel → failed', () => {
    const {probe} = fakeProbe({current: '1.0.0', manifest: m})
    const res = runUpdate({installRoot: '/opt/a', channel: 'stable', targetVersion: '9.9.9'}, probe)
    expect(res.outcome).toBe('failed')
  })

  it('targetVersion incompatible with the server → incompatible without download or activation', () => {
    const pinned = manifest([{version: '2.0.0', maxServer: '4.0.0'}])
    const {probe, calls} = fakeProbe({current: '1.0.0', manifest: pinned})

    const res = runUpdate({
      installRoot: '/opt/a',
      channel: 'stable',
      targetVersion: '2.0.0',
      serverVersion: '5.0.0',
    }, probe)

    expect(res.outcome).toBe('incompatible')
    expect(calls.download).toEqual([])
    expect(calls.activate).toEqual([])
  })

  it('pin with unverifiable compatibility fails before any mutating I/O', () => {
    const pinned = manifest([{version: '2.0.0', minServer: '1.0.0'}])
    const {probe, calls} = fakeProbe({
      current: '1.0.0',
      manifest: pinned,
      pending: pendingTransaction(),
      existingReleases: ['/opt/a/releases/.staging-1.2.0-crashed', '/opt/a/releases/1.2.0'],
      ownedReleases: {'/opt/a/releases/1.2.0': TX_ID},
    })

    const result = runUpdate({
      installRoot: '/opt/a',
      channel: 'stable',
      targetVersion: '2.0.0',
    }, probe)

    expect(result.outcome).toBe('incompatible')
    expect(calls.acquireLock).toBe(0)
    expect(calls.lockRelease).toEqual([])
    expect(calls.serviceInstalled).toBe(0)
    expect(calls.readTransaction).toBe(0)
    expect(calls.reapStaging).toBe(0)
    expect(calls.download).toEqual([])
    expect(calls.extract).toEqual([])
    expect(calls.staging).toEqual([])
    expect(calls.transactions).toEqual([])
    expect(calls.clearTransaction).toBe(0)
    expect(calls.promote).toEqual([])
    expect(calls.activate).toEqual([])
    expect(calls.restore).toEqual([])
    expect(calls.deactivate).toEqual([])
    expect(calls.guardrails).toEqual([])
    expect(calls.restart).toBe(0)
    expect(calls.cleanup).toEqual([])
  })

  it('error fetching the pin manifest → controlled failed without mutating I/O', () => {
    const {probe, calls} = fakeProbe({current: '1.0.0', manifestError: new Error('rete non disponibile')})

    const result = runUpdate({
      installRoot: '/opt/a',
      channel: 'stable',
      targetVersion: '2.0.0',
      serverVersion: '2.0.0',
    }, probe)

    expect(result.outcome).toBe('failed')
    expect(result.fromVersion).toBe('1.0.0')
    expect(result.toVersion).toBe('2.0.0')
    expect(result.reason).toMatch(/preflight del pin fallito.*rete non disponibile/i)
    expect(calls.acquireLock).toBe(0)
    expect(calls.lockRelease).toEqual([])
    expect(calls.serviceInstalled).toBe(0)
    expect(calls.readTransaction).toBe(0)
    expect(calls.reapStaging).toBe(0)
    expect(calls.download).toEqual([])
    expect(calls.extract).toEqual([])
    expect(calls.staging).toEqual([])
    expect(calls.transactions).toEqual([])
    expect(calls.promote).toEqual([])
    expect(calls.activate).toEqual([])
    expect(calls.cleanup).toEqual([])
  })

  it('redacts any credentials present in the pin preflight error', () => {
    const {probe} = fakeProbe({
      current: '1.0.0',
      manifestError: new Error('fetch negato con token cyi_ah_s'),
    })

    const result = runUpdate({
      installRoot: '/opt/a',
      channel: 'stable',
      targetVersion: '2.0.0',
      serverVersion: '2.0.0',
    }, probe)

    expect(result.reason).toContain('[REDACTED]')
    expect(result.reason).not.toContain('cyi_ah_')
  })

  it('retained release with unverifiable version stays intact and is not activated', () => {
    const target = '/opt/a/releases/1.0.0'
    const {probe, calls} = fakeProbe({
      currentTarget: '/opt/a/releases/1.2.0',
      manifest: m,
      existingReleases: [target],
      preflightHealthy: false,
    })
    const res = runUpdate({installRoot: '/opt/a', channel: 'stable', targetVersion: '1.0.0'}, probe)
    expect(res.outcome).toBe('failed')
    expect(calls.activate).toEqual([])
    expect(calls.cleanup).not.toContain(target)
  })

  it('detects the replacement of the retained release during the preflight and restores current', () => {
    const target = '/opt/a/releases/1.0.0'
    const previous = '/opt/a/releases/1.2.0'
    const {probe, calls} = fakeProbe({
      currentTarget: previous,
      manifest: m,
      existingReleases: [target, previous],
      retainedIdentityChanged: true,
    })

    const result = runUpdate({installRoot: '/opt/a', channel: 'stable', targetVersion: '1.0.0'}, probe)

    expect(result.outcome).toBe('rolled-back')
    expect(calls.retainedActivation).toEqual([target])
    expect(calls.activate).toEqual([])
    expect(calls.restore).toEqual([previous])
    expect(calls.download).toEqual([])
  })

  it('at the first bootstrap removes current if the retained release changes during the swap', () => {
    const target = '/opt/a/releases/1.2.0'
    const {probe, calls} = fakeProbe({
      currentTarget: null,
      manifest: m,
      existingReleases: [target],
      retainedIdentityChanged: true,
      serviceInstalled: false,
    })

    const result = runUpdate({installRoot: '/opt/a', channel: 'stable'}, probe)

    expect(result.outcome).toBe('failed')
    expect(result.activated).toBe(false)
    expect(calls.deactivate).toEqual([target])
    expect(calls.clearTransaction).toBe(1)
    expect(calls.restart).toBe(0)
  })

  it('failed health on the retained release rolls back without deleting either release', () => {
    const target = '/opt/a/releases/1.0.0'
    const previous = '/opt/a/releases/1.2.0'
    const {probe, calls} = fakeProbe({
      currentTarget: previous,
      manifest: m,
      existingReleases: [target, previous],
      healthResults: [false, true],
    })
    const res = runUpdate({installRoot: '/opt/a', channel: 'stable', targetVersion: '1.0.0'}, probe)
    expect(res.outcome).toBe('rolled-back')
    expect(calls.restore).toEqual([previous])
    expect(calls.cleanup).not.toContain(target)
    expect(calls.cleanup).not.toContain(previous)
  })

  it('retry after post-switch crash reconciles restart+exact version instead of doing a no-op', () => {
    const target = '/opt/a/releases/1.2.0'
    const {probe, calls} = fakeProbe({
      current: '1.2.0',
      currentTarget: target,
      manifest: m,
      pending: pendingTransaction({targetPath: target, previousTarget: '/opt/a/releases/1.0.0'}),
      existingReleases: [target],
      ownedReleases: {[target]: TX_ID},
      healthy: true,
    })

    const res = runUpdate({installRoot: '/opt/a', channel: 'stable'}, probe)

    expect(res.outcome).toBe('up-to-date')
    expect(res.verified).toBe(true)
    expect(calls.restart).toBe(1)
    expect(calls.guardrails).toEqual([target])
    expect(calls.health).toEqual(['1.2.0'])
    expect(calls.clearTransaction).toBe(1)
    expect(calls.download).toEqual([])
    expect(calls.lockRelease).toEqual(['fake-lock'])
  })

  it('retry with unhealthy journaled target rolls back, cleans the final one and retries in the same run', () => {
    const target = '/opt/a/releases/1.2.0'
    const previous = '/opt/a/releases/1.0.0'
    const {probe, calls} = fakeProbe({
      current: '1.2.0',
      currentTarget: target,
      manifest: m,
      pending: pendingTransaction({targetPath: target, previousTarget: previous}),
      existingReleases: [target],
      ownedReleases: {[target]: TX_ID},
      healthy: false,
    })

    const res = runUpdate({installRoot: '/opt/a', channel: 'stable'}, probe)

    expect(res.outcome).toBe('updated')
    expect(calls.restore).toEqual([previous])
    expect(calls.cleanup).toContain(target)
    expect(calls.download).toHaveLength(1)
    expect(calls.promote).toHaveLength(1)
    expect(calls.activate).toEqual([target])
    expect(calls.guardrails).toEqual([target, previous, target])
    expect(calls.health).toEqual(['1.2.0', '1.0.0', '1.2.0'])
  })

  it('pre-promotion recovery does not delete a pre-existing target not owned by the transaction', () => {
    const target = '/opt/a/releases/1.2.0'
    const previous = '/opt/a/releases/1.0.0'
    const {probe, calls} = fakeProbe({
      currentTarget: previous,
      manifest: m,
      pending: pendingTransaction({targetPath: target, previousTarget: previous}),
      existingReleases: [previous, target],
    })

    const res = runUpdate({installRoot: '/opt/a', channel: 'stable'}, probe)

    expect(res.outcome).toBe('updated')
    expect(calls.cleanup).not.toContain(target)
    expect(calls.activate).toEqual([target])
    expect(calls.guardrails).toEqual([previous, target])
    expect(calls.restart).toBe(2)
    expect(calls.health).toEqual(['1.0.0', '1.2.0'])
    expect(calls.promote).toEqual([])
  })

  it('recovery after restore but before restart does not clean the target if the previous one does not come back healthy', () => {
    const target = '/opt/a/releases/1.2.0'
    const previous = '/opt/a/releases/1.0.0'
    const {probe, calls} = fakeProbe({
      current: '1.0.0',
      currentTarget: previous,
      manifest: m,
      pending: pendingTransaction({targetPath: target, previousTarget: previous}),
      existingReleases: [previous, target],
      ownedReleases: {[target]: TX_ID},
      healthResults: [false],
    })

    const result = runUpdate({installRoot: '/opt/a', channel: 'stable'}, probe)

    expect(result.outcome).toBe('failed')
    expect(calls.guardrails).toEqual([previous])
    expect(calls.restart).toBe(1)
    expect(calls.health).toEqual(['1.0.0'])
    expect(calls.cleanup).not.toContain(target)
    expect(calls.clearTransaction).toBe(0)
    expect(calls.activate).toEqual([])
  })

  it('unhealthy first-installation recovery deactivates and cleans the owned target, then retries', () => {
    const target = '/opt/a/releases/1.2.0'
    const {probe, calls} = fakeProbe({
      currentTarget: target,
      manifest: m,
      pending: pendingTransaction({targetPath: target, previousTarget: null}),
      existingReleases: [target],
      ownedReleases: {[target]: TX_ID},
      healthResults: [false, true],
      serviceInstalled: false,
    })

    const res = runUpdate({installRoot: '/opt/a', channel: 'stable'}, probe)

    expect(res.outcome).toBe('updated')
    expect(calls.deactivate).toEqual([target])
    expect(calls.cleanup).toContain(target)
    expect(calls.download).toHaveLength(1)
    expect(calls.activate).toEqual([target])
  })

  it('reaps the abandoned stagings under lock before starting a new transaction', () => {
    const {probe, calls} = fakeProbe({current: '1.2.0', manifest: m})
    const res = runUpdate({installRoot: '/opt/a', channel: 'stable'}, probe)
    expect(res.outcome).toBe('up-to-date')
    expect(calls.reapStaging).toBe(1)
  })

  it('keeps the journal if the promotion renames the target but fails during the fsync', () => {
    const target = '/opt/a/releases/1.2.0'
    const {probe, calls} = fakeProbe({
      currentTarget: '/opt/a/releases/1.0.0',
      manifest: m,
      promoteAfterMoveError: true,
    })

    const result = runUpdate({installRoot: '/opt/a', channel: 'stable'}, probe)

    expect(result.outcome).toBe('failed')
    expect(calls.clearTransaction).toBe(0)
    expect(calls.cleanup).not.toContain(target)

    const retry = runUpdate({installRoot: '/opt/a', channel: 'stable'}, probe)
    expect(retry.outcome).toBe('updated')
    expect(calls.activate).toContain(target)
    expect(calls.clearTransaction).toBe(2)
  })

  it('busy lock fails before reading current/manifest or mutating releases', () => {
    const {probe, calls} = fakeProbe({lockAvailable: false, manifest: m})
    const res = runUpdate({installRoot: '/opt/a', channel: 'stable'}, probe)
    expect(res.outcome).toBe('failed')
    expect(res.reason).toMatch(/altro aggiornamento/i)
    expect(calls.download).toEqual([])
    expect(calls.activate).toEqual([])
    expect(calls.lockRelease).toEqual([])
  })

  it('normalizes non-Error lock errors and does not degrade a concluded result if the release fails', () => {
    const unavailable = fakeProbe({manifest: m})
    unavailable.probe.acquireLock = () => { throw 'lock non disponibile' }
    const failed = runUpdate({installRoot: '/opt/a', channel: 'stable'}, unavailable.probe)
    expect(failed.outcome).toBe('failed')
    expect(failed.reason).toContain('lock non disponibile')

    const completed = fakeProbe({current: '1.0.0', currentTarget: '/opt/a/releases/1.0.0', manifest: m})
    completed.probe.releaseLock = () => { throw new Error('rilascio best-effort fallito') }
    expect(runUpdate({installRoot: '/opt/a', channel: 'stable'}, completed.probe).outcome).toBe('updated')
  })

  it('logs the reaping under lock before continuing with the update', () => {
    const {probe} = fakeProbe({current: '1.0.0', currentTarget: '/opt/a/releases/1.0.0', manifest: m})
    probe.reapStaging = () => 2
    const result = runUpdate({installRoot: '/opt/a', channel: 'stable'}, probe)
    expect(result.outcome).toBe('updated')
    expect(result.reasons).toContain('2 staging abbandonata/e ripulita/e sotto lock')
  })

  it('recovery fails closed on coinciding rollback, missing ownership and unverifiable deactivate', () => {
    const target = '/opt/a/releases/1.2.0'
    const coincident = fakeProbe({
      currentTarget: target,
      pending: pendingTransaction({previousTarget: target}),
      existingReleases: [target],
      ownedReleases: {[target]: TX_ID},
      healthResults: [false],
    })
    expect(runUpdate({installRoot: '/opt/a', channel: 'stable'}, coincident.probe).outcome).toBe('failed')
    expect(coincident.calls.cleanup).toEqual([])

    const unowned = fakeProbe({
      currentTarget: target,
      pending: pendingTransaction({previousTarget: null, targetOwnership: 'preexisting', stagingRoot: null}),
      existingReleases: [target],
      healthResults: [false],
    })
    expect(runUpdate({installRoot: '/opt/a', channel: 'stable'}, unowned.probe).reason).toMatch(/non riconciliabile/)
    expect(unowned.calls.deactivate).toEqual([])

    const stuckCurrent = fakeProbe({
      currentTarget: target,
      pending: pendingTransaction({previousTarget: null}),
      existingReleases: [target],
      ownedReleases: {[target]: TX_ID},
      healthResults: [false],
    })
    stuckCurrent.probe.deactivate = () => {}
    expect(runUpdate({installRoot: '/opt/a', channel: 'stable'}, stuckCurrent.probe).reason).toMatch(/non riconciliabile/)
    expect(stuckCurrent.calls.cleanup).toEqual([])
  })

  it('recovery distinguishes a missing current consistent with the bootstrap from a foreign current', () => {
    const bootstrap = fakeProbe({
      currentTarget: null,
      serviceInstalled: false,
      pending: pendingTransaction({previousTarget: null, targetOwnership: 'preexisting', stagingRoot: null}),
      manifest: manifest([]),
    })
    const retried = runUpdate({installRoot: '/opt/a', channel: 'stable'}, bootstrap.probe)
    expect(retried.outcome).toBe('failed')
    expect(retried.reasons).toContain('transazione interrotta ripulita; current è ancora assente')

    const conflict = fakeProbe({currentTarget: null, pending: pendingTransaction(), manifest: m})
    const conflicted = runUpdate({installRoot: '/opt/a', channel: 'stable'}, conflict.probe)
    expect(conflicted.outcome).toBe('failed')
    expect(conflicted.fromVersion).toBeNull()
    expect(conflicted.reason).toMatch(/conflitto con la release attiva/)
  })

  it('normalizes non-Error thrown values during reuse, preparation, switch and rollback', () => {
    const target = '/opt/a/releases/1.2.0'
    const retained = fakeProbe({
      current: '1.0.0', currentTarget: '/opt/a/releases/1.0.0', manifest: m, existingReleases: [target],
    })
    retained.probe.activateRetained = () => { throw 'retained non verificabile' }
    expect(runUpdate({installRoot: '/opt/a', channel: 'stable'}, retained.probe).reasons.join(' '))
      .toContain('retained non verificabile')

    const preparation = fakeProbe({current: '1.0.0', currentTarget: '/opt/a/releases/1.0.0', manifest: m})
    preparation.probe.download = () => { throw 'download interrotto' }
    expect(runUpdate({installRoot: '/opt/a', channel: 'stable'}, preparation.probe).reasons.join(' '))
      .toContain('download interrotto')

    const switched = fakeProbe({current: '1.0.0', currentTarget: '/opt/a/releases/1.0.0', manifest: m})
    switched.probe.activate = () => { throw 'switch interrotto' }
    const switchedResult = runUpdate({installRoot: '/opt/a', channel: 'stable'}, switched.probe)
    expect(switchedResult.outcome).toBe('rolled-back')
    expect(switchedResult.reasons.join(' ')).toContain('switch interrotto')

    const rollback = fakeProbe({current: '1.0.0', currentTarget: '/opt/a/releases/1.0.0', manifest: m})
    rollback.probe.activate = () => { throw 'switch interrotto' }
    rollback.probe.restore = () => { throw 'restore interrotto' }
    const rollbackResult = runUpdate({installRoot: '/opt/a', channel: 'stable'}, rollback.probe)
    expect(rollbackResult.outcome).toBe('failed')
    expect(rollbackResult.reasons.join(' ')).toContain('restore interrotto')
  })
})

// ── Recovery when the service checks are faulty (CYAU-156) ────────────────────────────────────

describe('runUpdate — skipServicePreflight bypasses faulty service checks', () => {
  const m = manifest([{version: '1.0.0', sha256: 'sha256:MATCH'}, {version: '1.2.0', sha256: 'sha256:MATCH'}])

  /** Replicates the INSTALLED version with broken service gates: they throw before any network access. */
  function brokenGates(probe: UpdateProbe): UpdateProbe {
    const broken = (): never => {
      throw new AutomatorError(ErrorCodes.Update.failed, 'controlli del servizio difettosi', 1)
    }
    return {...probe, preflightService: broken, serviceInstalled: broken, recoverService: broken}
  }

  it('without explicit consent a faulty gate blocks every later release', () => {
    const {probe} = fakeProbe({current: '1.0.0', manifest: m, currentTarget: '/opt/a/releases/1.0.0'})

    expect(() => runUpdate({installRoot: '/opt/a', channel: 'stable'}, brokenGates(probe)))
      .toThrow(/controlli del servizio difettosi/)
  })

  it('with skipServicePreflight updates the bytes without querying or mutating the service', () => {
    const {probe, calls} = fakeProbe({
      current: '1.0.0', manifest: m, checksum: 'MATCH', healthy: true, currentTarget: '/opt/a/releases/1.0.0',
    })

    const result = runUpdate({installRoot: '/opt/a', channel: 'stable', skipServicePreflight: true}, brokenGates(probe))

    expect(result.outcome).toBe('updated')
    expect(result.toVersion).toBe('1.2.0')
    expect(calls.activate).toEqual(['/opt/a/releases/1.2.0'])
    expect(calls.serviceInstalled).toBe(0)
    expect(calls.recoverService).toBe(0)
    expect(calls.guardrails).toEqual([])
    expect(calls.prepareService).toEqual([])
    expect(calls.restart).toBe(0)
  })

  it('declares that the service is not reconciled and what to do right after', () => {
    const {probe} = fakeProbe({
      current: '1.0.0', manifest: m, checksum: 'MATCH', healthy: true, currentTarget: '/opt/a/releases/1.0.0',
    })

    const result = runUpdate({installRoot: '/opt/a', channel: 'stable', skipServicePreflight: true}, probe)

    const reasons = result.reasons.join(' ')
    expect(reasons).toContain('controlli del servizio saltati')
    expect(reasons).toContain('automator update')
  })

  it('even with an explicit pin it does not run the service preflight before the manifest', () => {
    const {probe, calls} = fakeProbe({
      current: '1.0.0', manifest: m, checksum: 'MATCH', healthy: true, currentTarget: '/opt/a/releases/1.0.0',
    })

    const result = runUpdate({
      installRoot: '/opt/a', channel: 'stable', targetVersion: '1.2.0', serverVersion: '5.0.0',
      skipServicePreflight: true,
    }, brokenGates(probe))

    expect(result.outcome).toBe('updated')
    expect(calls.restart).toBe(0)
  })

  it.each([
    ['failed', {checksum: 'TAMPERED'} as const, 'failed'],
    ['restored', {healthy: false} as const, 'rolled-back'],
  ] as const)('on a %s outcome does not promise a new version to reconcile', (_case, override, outcome) => {
    const {probe} = fakeProbe({
      current: '1.0.0', manifest: m, currentTarget: '/opt/a/releases/1.0.0', ...override,
    })

    const result = runUpdate({installRoot: '/opt/a', channel: 'stable', skipServicePreflight: true}, probe)

    expect(result.outcome).toBe(outcome)
    expect(result.reasons).not.toContain(SERVICE_RECONCILIATION_HINT)
  })

  it('when it reconciles an interrupted transaction it asks to repeat the same command', () => {
    const target = '/opt/a/releases/1.2.0'
    const {probe} = fakeProbe({
      current: '1.2.0', currentTarget: target, manifest: m, healthy: true,
      pending: pendingTransaction({targetPath: target, previousTarget: '/opt/a/releases/1.0.0'}),
      existingReleases: [target], ownedReleases: {[target]: TX_ID},
    })

    const result = runUpdate({installRoot: '/opt/a', channel: 'stable', skipServicePreflight: true}, probe)

    expect(result.outcome).toBe('up-to-date')
    expect(result.reasons).toContain(RECOVERY_REPEAT_HINT)
    expect(result.reasons).toContain(SERVICE_RECONCILIATION_HINT)
  })

  it('does not start the legacy service recovery even when it would be required', () => {
    const {probe, calls} = fakeProbe({
      current: '1.0.0', manifest: m, checksum: 'MATCH', healthy: true, currentTarget: '/opt/a/releases/1.0.0',
      serviceRecoveryRequired: true,
    })

    const result = runUpdate({installRoot: '/opt/a', channel: 'stable', skipServicePreflight: true}, probe)

    expect(result.outcome).toBe('updated')
    expect(calls.recoverService).toBe(0)
  })
})

// ── Real probe (curl/tar/symlink behind injectable CommandRunner + UpdateFs) ───────────────────────────────

interface RunCall {
  cmd: string
  args: string[]
  cwd?: string
}

function recordingRun(outcomes: Record<string, {status: number; stdout?: string; stderr?: string}>): {
  run: CommandRunner
  calls: RunCall[]
} {
  const calls: RunCall[] = []
  const run: CommandRunner = (cmd, args, cwd) => {
    calls.push({cmd, args, cwd})
    const out = outcomes[cmd] ?? {status: 0}
    return {status: out.status, stdout: out.stdout ?? '', stderr: out.stderr ?? ''}
  }
  return {run, calls}
}

function fakeFs(overrides: Partial<UpdateFs> & {file?: Buffer; link?: string | null}): UpdateFs {
  const symlinks: Array<{target: string; link: string}> = []
  return {
    acquireLock: overrides.acquireLock ?? (() => 'fs-lock'),
    releaseLock: overrides.releaseLock ?? (() => {}),
    readlink: overrides.readlink ?? (() => overrides.link ?? null),
    unlinkSymlinkIfTarget: overrides.unlinkSymlinkIfTarget ?? (() => true),
    symlinkReplace: overrides.symlinkReplace ?? ((target, link) => symlinks.push({target, link})),
    mkdirp: overrides.mkdirp ?? (() => {}),
    mkdtemp: overrides.mkdtemp ?? ((prefix) => `${prefix}unique`),
    exists: overrides.exists ?? (() => false),
    isDirectory: overrides.isDirectory ?? (() => false),
    realpath: overrides.realpath ?? ((target) => target),
    withDirectoryIdentity: overrides.withDirectoryIdentity ?? ((target, run) => run(`identity:${target}`)),
    sameDirectory: overrides.sameDirectory ?? (() => true),
    withFileIdentity: overrides.withFileIdentity ?? ((target, run) => run(`identity:${target}`)),
    sameFile: overrides.sameFile ?? (() => true),
    list: overrides.list ?? (() => []),
    syncTree: overrides.syncTree ?? (() => {}),
    rename: overrides.rename ?? (() => {}),
    renameNoReplace: overrides.renameNoReplace ?? (() => true),
    readFile: overrides.readFile ?? (() => overrides.file ?? Buffer.from('artifact-bytes')),
    writeFileAtomic: overrides.writeFileAtomic ?? (() => {}),
    remove: overrides.remove ?? (() => {}),
  }
}

describe('defaultUpdateProbe — maps the real commands (curl/tar/symlink)', () => {
  const base = {
    installRoot: '/opt/a',
    manifestBaseUrl: 'https://dl/latest',
    restartCommand: {cmd: 'launchctl', args: ['kickstart', '-k', 'gui/501/it.closeyour.automator']},
    healthCommand: {cmd: 'node', args: ['/opt/a/current/bin/run.js', '--version']},
    candidateHealthCommand: (releaseDir: string) => ({cmd: 'node', args: [path.join(releaseDir, 'bin', 'run.js'), '--version']}),
    serviceInstalled: () => true,
  }

  it('currentVersion derives the version from the basename of the current target', () => {
    expect(defaultUpdateProbe({...base, fs: fakeFs({link: '/opt/a/releases/1.2.0'})}).currentVersion()).toBe('1.2.0')
    expect(defaultUpdateProbe({...base, fs: fakeFs({link: null})}).currentVersion()).toBeNull()
  })

  it('migrates the policy into the CODEX_HOME persisted by the service even if the current shell differs', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'automator-managed-service-'))
    const persisted = {
      hooksDir: path.join(root, 'config', 'guardrails', 'hooks'),
      settingsPath: path.join(root, 'config', 'guardrails', 'settings.json'),
      codexRulesPath: path.join(root, 'service-codex', 'rules', 'closeyourit-automator.rules'),
      worktreesRoot: path.join(root, 'data', 'worktrees'),
    }
    const serviceNode = path.join(root, 'service-node')
    saveManagedServiceConfig(root, {version: 1, codexHome: path.join(root, 'service-codex'), nodePath: serviceNode, guardrails: persisted})
    const previous = process.env.CODEX_HOME
    process.env.CODEX_HOME = path.join(root, 'shell-codex')
    let received: unknown
    try {
      fs.mkdirSync(path.join(root, 'releases', '1.2.0'), {recursive: true})
      const probe = defaultUpdateProbe({
        ...base,
        installRoot: root,
        installGuardrails: (_assets, opts) => { received = opts },
      })
      probe.migrateGuardrails(path.join(root, 'releases', '1.2.0'))
    } finally {
      if (previous === undefined) delete process.env.CODEX_HOME
      else process.env.CODEX_HOME = previous
      fs.rmSync(root, {recursive: true, force: true})
    }
    expect(received).toEqual({...persisted, nodePath: serviceNode})
  })

  it('fetchManifest downloads <base>/<channel>.json and parses it', () => {
    const body = JSON.stringify(manifest([{version: '1.0.0'}], 'beta'))
    const {run, calls} = recordingRun({curl: {status: 0, stdout: body}})
    const probe = defaultUpdateProbe({...base, run, fs: fakeFs({})})
    const m = probe.fetchManifest('beta')
    expect(m.releases[0].version).toBe('1.0.0')
    expect(calls[0].cmd).toBe('curl')
    expect(calls[0].args).toContain('https://dl/latest/beta.json')
  })

  it('fetchManifest resolves from the GitHub API the latest append-only generation of the channel', () => {
    const apiBase = 'https://api.github.com/repos/bussolabs/closeyourit-automator-community/releases/tags/automator-channels'
    const calls: RunCall[] = []
    const manifests: Record<string, string> = {
      'https://api.github.com/assets/stable-1.9.0': JSON.stringify(manifest([{version: '1.9.0'}])),
      'https://api.github.com/assets/stable-1.10.0': JSON.stringify(manifest([{version: '1.9.0'}, {version: '1.10.0'}])),
    }
    const run: CommandRunner = (cmd, args, cwd) => {
      calls.push({cmd, args, cwd})
      const url = args.at(-1) ?? ''
      if (url === apiBase) {
        return {status: 0, stdout: JSON.stringify({assets_url: 'https://api.github.com/releases/1/assets'}), stderr: ''}
      }
      if (url.includes('per_page=100&page=1')) {
        return {
          status: 0,
          stdout: JSON.stringify([
            {id: 1, created_at: '2026-07-14T00:00:00Z', name: 'beta-9.0.0-beta.1.json', url: 'https://api.github.com/assets/beta'},
            {id: 2, created_at: '2026-07-14T00:01:00Z', name: 'stable-1.9.0.json', url: 'https://api.github.com/assets/stable-1.9.0'},
            {id: 3, created_at: '2026-07-14T00:02:00Z', name: 'stable-1.10.0.json', url: 'https://api.github.com/assets/stable-1.10.0'},
          ]),
          stderr: '',
        }
      }
      return {status: manifests[url] ? 0 : 1, stdout: manifests[url] ?? '', stderr: manifests[url] ? '' : 'unexpected URL'}
    }

    const probe = defaultUpdateProbe({...base, manifestBaseUrl: apiBase, run, fs: fakeFs({})})
    expect(probe.fetchManifest('stable').releases.map((entry) => entry.version)).toEqual(['1.9.0', '1.10.0'])
    expect(calls.every((call) => call.cmd === 'gh')).toBe(true)
    expect(calls[0].args).toEqual(['api', apiBase])
    expect(calls.at(-1)?.args).toContain('Accept: application/octet-stream')
    expect(calls.at(-1)?.args).toContain('https://api.github.com/assets/stable-1.10.0')
  })

  it('fetchManifest reads the most recently published cumulative generation even with an out-of-order version', () => {
    const apiBase = 'https://api.github.com/repos/bussolabs/closeyourit-automator-community/releases/tags/automator-channels'
    const latestGeneration = 'https://api.github.com/assets/stable-1.9.0-late'
    const run: CommandRunner = (_cmd, args) => {
      const url = args.at(-1)
      if (url === apiBase) {
        return {status: 0, stdout: JSON.stringify({assets_url: 'https://api.github.com/releases/1/assets'}), stderr: ''}
      }
      if (url?.includes('per_page=100&page=1')) {
        return {
          status: 0,
          stdout: JSON.stringify([
            {id: 100, created_at: '2026-07-14T00:00:00Z', name: 'stable-2.0.0.json', url: 'https://api.github.com/assets/stable-2.0.0'},
            {id: 101, created_at: '2026-07-14T00:01:00Z', name: 'stable-1.9.0.json', url: latestGeneration},
          ]),
          stderr: '',
        }
      }
      if (url === latestGeneration) {
        return {
          status: 0,
          stdout: JSON.stringify(manifest([{version: '1.9.0'}, {version: '2.0.0'}])),
          stderr: '',
        }
      }
      return {status: 1, stdout: '', stderr: `generazione obsoleta selezionata: ${url}`}
    }

    const probe = defaultUpdateProbe({...base, manifestBaseUrl: apiBase, run, fs: fakeFs({})})
    expect(probe.fetchManifest('stable').releases.map((entry) => entry.version)).toEqual(['1.9.0', '2.0.0'])
  })

  it('private beta fetchManifest ignores stable and resolves the latest prerelease via authenticated gh', () => {
    const apiBase = 'https://api.github.com/repos/bussolabs/closeyourit-automator-community/releases/tags/automator-channels'
    const selectedUrl = 'https://api.github.com/assets/beta-2.0.0-beta.2'
    const calls: RunCall[] = []
    const run: CommandRunner = (cmd, args, cwd) => {
      calls.push({cmd, args, cwd})
      const url = args.at(-1)
      if (url === apiBase) {
        return {status: 0, stdout: JSON.stringify({assets_url: 'https://api.github.com/releases/1/assets'}), stderr: ''}
      }
      if (url?.includes('per_page=100&page=1')) {
        return {
          status: 0,
          stdout: JSON.stringify([
            {id: 1, created_at: '2026-07-14T00:00:00Z', name: 'stable-9.0.0.json', url: 'https://api.github.com/assets/stable'},
            {id: 2, created_at: '2026-07-14T00:01:00Z', name: 'beta-2.0.0-beta.1.json', url: 'https://api.github.com/assets/beta-2.0.0-beta.1'},
            {id: 3, created_at: '2026-07-14T00:02:00Z', name: 'beta-2.0.0-beta.2.json', url: selectedUrl},
          ]),
          stderr: '',
        }
      }
      if (url === selectedUrl) {
        return {
          status: 0,
          stdout: JSON.stringify(manifest([
            {version: '2.0.0-beta.1'},
            {version: '2.0.0-beta.2'},
          ], 'beta')),
          stderr: '',
        }
      }
      return {status: 1, stdout: '', stderr: `URL inatteso: ${url}`}
    }

    const probe = defaultUpdateProbe({...base, manifestBaseUrl: apiBase, run, fs: fakeFs({})})
    expect(probe.fetchManifest('beta').releases.map((entry) => entry.version))
      .toEqual(['2.0.0-beta.1', '2.0.0-beta.2'])
    expect(calls.every((call) => call.cmd === 'gh')).toBe(true)
    expect(calls.at(-1)?.args).toEqual(['api', '-H', 'Accept: application/octet-stream', selectedUrl])
  })

  it('API fetchManifest fails closed if metadata, asset page or generation are not readable', () => {
    const apiBase = 'https://api.github.com/repos/bussolabs/closeyourit-automator-community/releases/tags/automator-channels'
    const metadataFailure: CommandRunner = () => ({status: 7, stdout: '', stderr: 'temporary network failure'})
    expect(() => defaultUpdateProbe({...base, manifestBaseUrl: apiBase, run: metadataFailure, fs: fakeFs({})}).fetchManifest('stable')).toThrow(
      AutomatorError,
    )

    const malformedMetadata: CommandRunner = () => ({status: 0, stdout: '{}', stderr: ''})
    expect(() => defaultUpdateProbe({...base, manifestBaseUrl: apiBase, run: malformedMetadata, fs: fakeFs({})}).fetchManifest('stable')).toThrow(
      /metadata.*non valid/i,
    )
  })

  it('fetchManifest pages through all assets, ignores untrusted records and keeps the latest generation', () => {
    const apiBase = 'https://api.github.com/repos/bussolabs/closeyourit-automator-community/releases/tags/automator-channels'
    const selectedUrl = 'https://api.github.com/assets/stable-1.2.0'
    const firstPage: unknown[] = [
      null,
      [],
      'record-inatteso',
      {id: 1, created_at: '2026-07-14T00:00:00Z', name: 1, url: 'https://api.github.com/assets/invalid-name'},
      {id: 2, created_at: '2026-07-14T00:01:00Z', name: 'stable-1.0.0.json', url: 1},
      {id: 3, created_at: '2026-07-14T00:02:00Z', name: 'beta-9.0.0.json', url: 'https://api.github.com/assets/beta'},
      {id: 4, created_at: 'invalid', name: 'stable-9.0.0.json', url: 'https://api.github.com/assets/invalid-date'},
      {id: 5, created_at: '2026-07-14T00:03:00Z', name: 'stable-not-semver.json', url: 'https://api.github.com/assets/not-semver'},
      {id: 6, created_at: '2026-07-14T00:04:00Z', name: 'stable-1.3.0.txt', url: 'https://api.github.com/assets/wrong-suffix'},
      {id: 8, created_at: '2026-07-14T00:06:00Z', name: 'stable-1.2.0.json', url: selectedUrl},
      {id: 7, created_at: '2026-07-14T00:06:00Z', name: 'stable-1.1.0.json', url: 'https://api.github.com/assets/stable-1.1.0'},
      ...Array.from({length: 89}, () => ({})),
    ]
    const calls: RunCall[] = []
    const run: CommandRunner = (cmd, args, cwd) => {
      calls.push({cmd, args, cwd})
      const url = args.at(-1)
      if (url === apiBase) return {status: 0, stdout: JSON.stringify({assets_url: 'https://api.github.com/assets?state=all'}), stderr: ''}
      if (url?.endsWith('page=1')) return {status: 0, stdout: JSON.stringify(firstPage), stderr: ''}
      if (url?.endsWith('page=2')) return {status: 0, stdout: '[]', stderr: ''}
      if (url === selectedUrl) return {status: 0, stdout: JSON.stringify(manifest([{version: '1.2.0'}])), stderr: ''}
      return {status: 1, stdout: '', stderr: `URL inatteso: ${url}`}
    }

    const result = defaultUpdateProbe({...base, manifestBaseUrl: apiBase, run, fs: fakeFs({})}).fetchManifest('stable')
    expect(result.releases[0].version).toBe('1.2.0')
    expect(calls.map((call) => call.args.at(-1))).toContain('https://api.github.com/assets?state=all&per_page=100&page=2')
  })

  it('GitHub fetchManifest rejects every malformed level without choosing an ambiguous generation', () => {
    const apiBase = 'https://api.github.com/repos/bussolabs/closeyourit-automator-community/releases/tags/automator-channels'
    const assetUrl = 'https://api.github.com/assets/stable-1.2.0'
    const probeFor = (metadata: string, assets: string, generation = '{}') => defaultUpdateProbe({
      ...base,
      manifestBaseUrl: apiBase,
      fs: fakeFs({}),
      run: (_cmd, args) => {
        const url = args.at(-1)
        if (url === apiBase) return {status: 0, stdout: metadata, stderr: ''}
        if (url?.includes('per_page=100')) return {status: 0, stdout: assets, stderr: ''}
        return {status: 0, stdout: generation, stderr: ''}
      },
    })

    expect(() => probeFor('not-json', '[]').fetchManifest('stable')).toThrow(/JSON non valido/)
    expect(() => probeFor('[]', '[]').fetchManifest('stable')).toThrow(/metadata.*non valid/i)
    expect(() => probeFor(JSON.stringify({assets_url: 'https://api.github.com/assets'}), '{}').fetchManifest('stable'))
      .toThrow(/elenco.*non valido/i)
    expect(() => probeFor(JSON.stringify({assets_url: 'https://api.github.com/assets'}), '[]').fetchManifest('stable'))
      .toThrow(/nessuna generazione/i)

    const oneAsset = JSON.stringify([{
      id: 1,
      created_at: '2026-07-14T00:00:00Z',
      name: 'stable-1.2.0.json',
      url: assetUrl,
    }])
    expect(() => probeFor(JSON.stringify({assets_url: 'https://api.github.com/assets'}), oneAsset, 'not-json').fetchManifest('stable'))
      .toThrow(/JSON non valido/)
    expect(() => probeFor(
      JSON.stringify({assets_url: 'https://api.github.com/assets'}),
      oneAsset,
      JSON.stringify(manifest([{version: '1.2.0'}], 'beta')),
    ).fetchManifest('stable')).toThrow(/manifest stable non valido/)
  })

  it('failed fetchManifest (curl non-zero) → C500-UPDATE-004 (exit 1)', () => {
    const {run} = recordingRun({curl: {status: 7, stderr: 'connection refused'}})
    const probe = defaultUpdateProbe({...base, run, fs: fakeFs({})})
    const err = (() => {
      try {
        probe.fetchManifest('stable')
      } catch (e) {
        return e as AutomatorError
      }
    })()
    expect(err?.code).toBe(ErrorCodes.Update.failed)
    expect(err?.exitCode).toBe(1)
  })

  it('command errors keep stdout or exit code when stderr is empty', () => {
    const stdoutProbe = defaultUpdateProbe({...base, fs: fakeFs({}), run: () => ({status: 7, stdout: 'errore remoto', stderr: ''})})
    expect(() => stdoutProbe.fetchManifest('stable')).toThrow(/errore remoto/)
    const exitProbe = defaultUpdateProbe({...base, fs: fakeFs({}), run: () => ({status: 9, stdout: '', stderr: ''})})
    expect(() => exitProbe.fetchManifest('stable')).toThrow(/exit 9/)
  })

  it('fetchManifest with invalid JSON → C500-UPDATE-004', () => {
    const {run} = recordingRun({curl: {status: 0, stdout: 'non-json'}})
    const probe = defaultUpdateProbe({...base, run, fs: fakeFs({})})
    expect(() => probe.fetchManifest('stable')).toThrow(AutomatorError)
  })

  it('download creates the parent dir (new machine) and uses curl -o dest url', () => {
    const {run, calls} = recordingRun({curl: {status: 0}})
    let made = ''
    const probe = defaultUpdateProbe({...base, run, fs: fakeFs({mkdirp: (d) => (made = d)})})
    probe.download('https://dl/1.tgz', '/opt/a/releases/.download-1.tgz')
    expect(made).toBe('/opt/a/releases') // the releases/ dir is created before the download
    expect(calls[0].args).toEqual(['-fsSL', '-o', '/opt/a/releases/.download-1.tgz', 'https://dl/1.tgz'])
  })

  it('failed download → C500-UPDATE-004', () => {
    const {run} = recordingRun({curl: {status: 1, stderr: '404'}})
    const probe = defaultUpdateProbe({...base, run, fs: fakeFs({})})
    expect(() => probe.download('https://dl/1.tgz', '/tmp/x')).toThrow(AutomatorError)
  })

  it('download of a private GitHub release uses the authenticated gh session', () => {
    const {run, calls} = recordingRun({gh: {status: 0}})
    const probe = defaultUpdateProbe({...base, run, fs: fakeFs({})})

    probe.download(
      'https://github.com/bussolabs/closeyourit-automator-community/releases/download/v1.2.3/automator-1.2.3.tgz',
      '/opt/a/releases/.download-1.2.3.tgz',
    )

    expect(calls).toEqual([{
      cmd: 'gh',
      args: [
        'release', 'download', 'v1.2.3',
        '--repo', 'bussolabs/closeyourit-automator-community',
        '--pattern', 'automator-1.2.3.tgz',
        '--output', '/opt/a/releases/.download-1.2.3.tgz',
      ],
      cwd: undefined,
    }])
  })

  it.each([
    {status: 1, stderr: 'HTTP 401: Bad credentials'},
    {status: 1, stderr: 'HTTP 404: release or asset not found'},
  ])('private GitHub download fails closed on $stderr without anonymous fallback', ({status, stderr}) => {
    const token = `github_pat_${'A1_'.repeat(20)}`
    const {run, calls} = recordingRun({gh: {status, stderr: `${stderr}; diagnostic token=${token}`}})
    const probe = defaultUpdateProbe({...base, run, fs: fakeFs({})})

    const error = (() => {
      try {
        probe.download(
          'https://github.com/bussolabs/closeyourit-automator-community/releases/download/v1.2.3/automator-1.2.3.tgz',
          '/opt/a/releases/.download-1.2.3.tgz',
        )
      } catch (caught) {
        return caught as AutomatorError
      }
    })()
    expect(error).toBeInstanceOf(AutomatorError)
    expect(error?.message).toContain('[REDACTED]')
    expect(error?.message).not.toContain(token)
    expect(calls).toHaveLength(1)
    expect(calls[0].cmd).toBe('gh')
    expect(calls[0].args).not.toContain(token)
  })

  it('download uses gh only for canonical GitHub release URLs and leaves custom URLs to curl', () => {
    const urls = [
      'not a url',
      'https://example.com/owner/repo/releases/download/v1.2.3/asset.tgz',
      'http://github.com/owner/repo/releases/download/v1.2.3/asset.tgz',
      'https://github.com/owner/repo/archive/v1.2.3/asset.tgz',
      'https://github.com/owner/repo/releases/latest/v1.2.3/asset.tgz',
      'https://github.com/owner/repo/releases/download/v1.2.3',
      'https://github.com/owner%2Fescape/repo/releases/download/v1.2.3/asset.tgz',
      'https://github.com/owner/repo/releases/download/tag%2Fescape/asset.tgz',
      'https://github.com/owner/repo/releases/download/v1.2.3/asset%2Fescape.tgz',
      'https://github.com/%E0%A4%A/repo/releases/download/v1.2.3/asset.tgz',
    ]
    const {run, calls} = recordingRun({curl: {status: 0}})
    const probe = defaultUpdateProbe({...base, run, fs: fakeFs({})})

    urls.forEach((url, index) => probe.download(url, `/tmp/artifact-${index}.tgz`))

    expect(calls).toHaveLength(urls.length)
    expect(calls.every((call) => call.cmd === 'curl')).toBe(true)
    expect(calls.map((call) => call.args.at(-1))).toEqual(urls)
  })

  it('checksum reads the file and computes its sha256', () => {
    const probe = defaultUpdateProbe({...base, fs: fakeFs({file: Buffer.from('abc')})})
    expect(probe.checksum('/tmp/x')).toBe('ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad')
  })

  it('extract creates the dir and unpacks with tar --strip-components=1', () => {
    const {run, calls} = recordingRun({tar: {status: 0}})
    let made = ''
    const probe = defaultUpdateProbe({...base, run, fs: fakeFs({mkdirp: (d) => (made = d)})})
    probe.extract('/tmp/x.tgz', '/opt/a/releases/1.0.0')
    expect(made).toBe('/opt/a/releases/1.0.0')
    expect(calls[0].cmd).toBe('tar')
    expect(calls[0].args).toEqual(['-xzf', '/tmp/x.tgz', '-C', '/opt/a/releases/1.0.0', '--strip-components=1'])
  })

  it('createStaging uses mkdtemp and promote renames atomically on the same filesystem', () => {
    const made: string[] = []
    const synced: string[] = []
    const renames: Array<{source: string; destination: string}> = []
    const probe = defaultUpdateProbe({...base, fs: fakeFs({
      mkdirp: (dir) => made.push(dir),
      mkdtemp: (prefix) => `${prefix}xyz`,
      syncTree: (target) => synced.push(target),
      renameNoReplace: (source, destination) => {
        renames.push({source, destination})
        return true
      },
    })})
    expect(probe.createStaging('/opt/a/releases/.staging-1.2.0-')).toBe('/opt/a/releases/.staging-1.2.0-xyz')
    probe.promote('/opt/a/releases/.staging-1.2.0-xyz/release', '/opt/a/releases/1.2.0')
    expect(made).toEqual(['/opt/a/releases'])
    expect(renames).toEqual([{
      source: '/opt/a/releases/.staging-1.2.0-xyz/release',
      destination: '/opt/a/releases/1.2.0',
    }])
    expect(synced).toEqual(['/opt/a/releases/.staging-1.2.0-xyz/release'])
  })

  it('promote never overwrites an already existing final release', () => {
    const probe = defaultUpdateProbe({...base, fs: fakeFs({renameNoReplace: () => false})})
    expect(() => probe.promote('/opt/a/releases/.staging/release', '/opt/a/releases/1.2.0')).toThrow(
      /release finale già esistente/,
    )
  })

  it('promote uses an atomic no-replace claim even if the destination appears after the initial check', () => {
    let ordinaryRenameCalled = false
    const io = fakeFs({
      exists: () => false,
      rename: () => { ordinaryRenameCalled = true },
      ...({renameNoReplace: () => false} as Partial<UpdateFs>),
    })
    const probe = defaultUpdateProbe({...base, fs: io})

    expect(() => probe.promote('/opt/a/releases/.staging/release', '/opt/a/releases/1.2.0')).toThrow(
      /release finale già esistente/,
    )
    expect(ordinaryRenameCalled).toBe(false)
  })

  it('releaseExists accepts only a real directory confined directly under releases', () => {
    const release = '/opt/a/releases/1.2.0'
    const valid = defaultUpdateProbe({...base, fs: fakeFs({
      isDirectory: (target) => target === release || target === '/opt/a/releases',
      realpath: (target) => target,
    })})
    const symlink = defaultUpdateProbe({...base, fs: fakeFs({
      isDirectory: () => false,
      realpath: (target) => target === release ? '/tmp/attacker' : target,
    })})
    const escaped = defaultUpdateProbe({...base, fs: fakeFs({
      isDirectory: () => true,
      realpath: (target) => target === release ? '/tmp/attacker' : target,
    })})
    const nested = defaultUpdateProbe({...base, fs: fakeFs({
      isDirectory: () => true,
      realpath: (target) => target === release ? '/opt/a/releases/nested/1.2.0' : target,
    })})

    expect(valid.releaseExists(release)).toBe(true)
    expect(symlink.releaseExists(release)).toBe(false)
    expect(escaped.releaseExists(release)).toBe(false)
    expect(nested.releaseExists(release)).toBe(false)
  })

  it('releaseExists rejects a symlink releasesRoot or a canonical one outside the real installRoot', () => {
    const release = '/opt/a/releases/1.2.0'
    const rootSymlink = defaultUpdateProbe({...base, fs: fakeFs({
      isDirectory: (target) => target === release,
      realpath: (target) => target === '/opt/a' ? '/real/opt/a' :
        target === '/opt/a/releases' ? '/tmp/attacker' : '/tmp/attacker/1.2.0',
    })})
    const indirect = defaultUpdateProbe({...base, fs: fakeFs({
      isDirectory: () => true,
      realpath: (target) => target === '/opt/a' ? '/real/opt/a' :
        target === '/opt/a/releases' ? '/elsewhere/releases' : '/elsewhere/releases/1.2.0',
    })})

    expect(rootSymlink.releaseExists(release)).toBe(false)
    expect(indirect.releaseExists(release)).toBe(false)
  })

  it('releaseExists fails closed when installRoot or releases have no stable realpath', () => {
    const release = '/opt/a/releases/1.2.0'
    for (const unavailable of ['/opt/a', '/opt/a/releases']) {
      const probe = defaultUpdateProbe({...base, fs: fakeFs({
        isDirectory: () => true,
        realpath: (target) => target === unavailable ? null : target,
      })})
      expect(probe.releaseExists(release)).toBe(false)
    }
  })

  it('activateRetained rejects the permanent replacement of bin/run.js during the preflight', () => {
    const installRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'cyau48-retained-entrypoint-'))
    const release = path.join(installRoot, 'releases', '1.2.0')
    const entrypoint = path.join(release, 'bin', 'run.js')
    fs.mkdirSync(path.dirname(entrypoint), {recursive: true})
    fs.writeFileSync(entrypoint, 'originale')
    const run: CommandRunner = () => {
      fs.renameSync(entrypoint, `${entrypoint}.originale`)
      fs.writeFileSync(entrypoint, 'sostituito')
      return {status: 0, stdout: '@bussolabs/closeyourit-automator/1.2.0 linux-x64 node-v26', stderr: ''}
    }
    const probe = defaultUpdateProbe({...base, installRoot, run})

    expect(probe.activateRetained(release, '1.2.0', () => true)).toBe(false)
    expect(probe.readCurrentTarget()).toBeNull()
    fs.rmSync(installRoot, {recursive: true, force: true})
  })

  it('activateRetained keeps bin/run.js anchored until restart and health are complete', () => {
    const installRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'cyau48-retained-health-entrypoint-'))
    const release = path.join(installRoot, 'releases', '1.2.0')
    const entrypoint = path.join(release, 'bin', 'run.js')
    fs.mkdirSync(path.dirname(entrypoint), {recursive: true})
    fs.writeFileSync(entrypoint, 'originale')
    const run: CommandRunner = () => ({
      status: 0, stdout: '@bussolabs/closeyourit-automator/1.2.0 linux-x64 node-v26', stderr: '',
    })
    const probe = defaultUpdateProbe({...base, installRoot, run})

    expect(probe.activateRetained(release, '1.2.0', () => {
      fs.renameSync(entrypoint, `${entrypoint}.originale`)
      fs.writeFileSync(entrypoint, 'sostituito')
      return true
    })).toBe(false)
    fs.rmSync(installRoot, {recursive: true, force: true})
  })

  it('real activateRetained verifies and activates an unchanged release', () => {
    const installRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'cyau48-retained-'))
    const release = path.join(installRoot, 'releases', '1.2.0')
    fs.mkdirSync(path.join(release, 'bin'), {recursive: true})
    fs.writeFileSync(path.join(release, 'bin', 'run.js'), 'entrypoint')
    const run: CommandRunner = () => ({
      status: 0, stdout: '@bussolabs/closeyourit-automator/1.2.0 linux-x64 node-v26', stderr: '',
    })
    const probe = defaultUpdateProbe({...base, installRoot, run})

    expect(probe.activateRetained(release, '1.2.0', () => true)).toBe(true)
    expect(probe.readCurrentTarget()).toBe(release)
    fs.rmSync(installRoot, {recursive: true, force: true})
  })

  it('failed extract (tar non-zero) → C500-UPDATE-004', () => {
    const {run} = recordingRun({tar: {status: 2, stderr: 'corrupt archive'}})
    const probe = defaultUpdateProbe({...base, run, fs: fakeFs({})})
    expect(() => probe.extract('/tmp/x.tgz', '/opt/a/releases/1.0.0')).toThrow(AutomatorError)
  })

  it('readCurrentTarget reads the current symlink (null if missing)', () => {
    expect(defaultUpdateProbe({...base, fs: fakeFs({link: '/opt/a/releases/1.0.0'})}).readCurrentTarget()).toBe('/opt/a/releases/1.0.0')
    expect(defaultUpdateProbe({...base, fs: fakeFs({link: 'releases/1.0.0'})}).readCurrentTarget()).toBe('/opt/a/releases/1.0.0')
    expect(defaultUpdateProbe({...base, fs: fakeFs({link: null})}).readCurrentTarget()).toBeNull()
  })

  it('serviceInstalled delegates to the options callback (from the service manager)', () => {
    expect(defaultUpdateProbe({...base, serviceInstalled: () => true, fs: fakeFs({})}).serviceInstalled()).toBe(true)
    expect(defaultUpdateProbe({...base, serviceInstalled: () => false, fs: fakeFs({})}).serviceInstalled()).toBe(false)
  })

  it('migrateGuardrails installs the confined release assets and propagates a fail-closed failure', () => {
    const release = '/opt/a/releases/1.2.0'
    const installed: string[] = []
    const io = fakeFs({
      isDirectory: (target) => ['/opt/a/releases', release].includes(target),
      realpath: (target) => target,
    })
    const probe = defaultUpdateProbe({...base, fs: io, installGuardrails: (assetsDir) => installed.push(assetsDir)})

    probe.migrateGuardrails(release)
    expect(installed).toEqual([path.join(release, 'assets', 'guardrails')])

    const failing = defaultUpdateProbe({...base, fs: io, installGuardrails: () => { throw new Error('set parziale') }})
    expect(() => failing.migrateGuardrails(release)).toThrow(/migrazione guardrail.*set parziale/i)
    expect(() => probe.migrateGuardrails('/tmp/attacker')).toThrow(/fuori dal layout/i)
  })

  it('activate and restore swap the current symlink', () => {
    const swaps: Array<{target: string; link: string}> = []
    const probe = defaultUpdateProbe({...base, fs: fakeFs({symlinkReplace: (target, link) => swaps.push({target, link})})})
    probe.activate('/opt/a/releases/1.2.0')
    probe.restore('/opt/a/releases/1.0.0')
    expect(swaps).toEqual([
      {target: '/opt/a/releases/1.2.0', link: '/opt/a/current'},
      {target: '/opt/a/releases/1.0.0', link: '/opt/a/current'},
    ])
  })

  it('restart runs the platform restart command', () => {
    const {run, calls} = recordingRun({launchctl: {status: 0}})
    const probe = defaultUpdateProbe({...base, run, fs: fakeFs({})})
    probe.restart()
    expect(calls[0]).toMatchObject({cmd: 'launchctl', args: ['kickstart', '-k', 'gui/501/it.closeyour.automator']})
  })

  it('restart uses the injected service manager after the migration instead of the standalone command', () => {
    const {run, calls} = recordingRun({launchctl: {status: 0}})
    let managedRestarts = 0
    const probe = defaultUpdateProbe({
      ...base,
      run,
      restartService: () => { managedRestarts += 1 },
      fs: fakeFs({}),
    })

    probe.restart()
    expect(managedRestarts).toBe(1)
    expect(calls).toEqual([])
  })

  it('failed restart → C500-UPDATE-004', () => {
    const {run} = recordingRun({launchctl: {status: 1, stderr: 'no such service'}})
    const probe = defaultUpdateProbe({...base, run, fs: fakeFs({})})
    expect(() => probe.restart()).toThrow(AutomatorError)
  })

  it('healthCheck requires status 0 and the exact version in stdout', () => {
    const ok = defaultUpdateProbe({...base, run: recordingRun({node: {status: 0, stdout: '@bussolabs/closeyourit-automator/1.2.0 linux-x64 node-v26'}}).run, fs: fakeFs({})})
    const wrong = defaultUpdateProbe({...base, run: recordingRun({node: {status: 0, stdout: '@bussolabs/closeyourit-automator/9.9.9 linux-x64 node-v26'}}).run, fs: fakeFs({})})
    const ko = defaultUpdateProbe({...base, run: recordingRun({node: {status: 1, stdout: '@bussolabs/closeyourit-automator/1.2.0 linux-x64 node-v26'}}).run, fs: fakeFs({})})
    expect(ok.healthCheck('1.2.0')).toBe(true)
    expect(wrong.healthCheck('1.2.0')).toBe(false)
    expect(ko.healthCheck('1.2.0')).toBe(false)
  })

  it('health and preflight lazily resolve the unit Node and require the daemon to be running', () => {
    let serviceNode = '/shell/node'
    let running = false
    const calls: Array<{cmd: string; args: string[]}> = []
    const run: CommandRunner = (cmd, args) => {
      calls.push({cmd, args})
      return {status: 0, stdout: '@bussolabs/closeyourit-automator/1.2.0 linux-x64 node-v24', stderr: ''}
    }
    const probe = defaultUpdateProbe({
      ...base,
      run,
      healthCommand: () => ({cmd: serviceNode, args: ['/opt/a/current/bin/run.js', '--version']}),
      candidateHealthCommand: (releaseDir) => ({cmd: serviceNode, args: [path.join(releaseDir, 'bin', 'run.js'), '--version']}),
      serviceRunning: () => running,
      fs: fakeFs({}),
    })

    serviceNode = '/service/node'
    expect(probe.preflight('/opt/a/releases/1.2.0', '1.2.0')).toBe(true)
    expect(probe.healthCheck('1.2.0')).toBe(false)
    running = true
    expect(probe.healthCheck('1.2.0')).toBe(true)
    expect(calls.map((call) => call.cmd)).toEqual(['/service/node', '/service/node', '/service/node'])
  })

  it('preflight runs the binary directly from the staged release', () => {
    const {run, calls} = recordingRun({node: {status: 0, stdout: '@bussolabs/closeyourit-automator/1.2.0 linux-x64 node-v26'}})
    const probe = defaultUpdateProbe({...base, run, fs: fakeFs({})})
    expect(probe.preflight('/opt/a/releases/.staging-x/release', '1.2.0')).toBe(true)
    expect(calls[0]).toMatchObject({
      cmd: 'node', args: ['/opt/a/releases/.staging-x/release/bin/run.js', '--version'],
    })
  })

  it('versionOutputMatches rejects empty stdout, different package and prefix-match versions', () => {
    expect(versionOutputMatches('@bussolabs/closeyourit-automator/1.2.0 linux-x64 node-v26', '1.2.0')).toBe(true)
    expect(versionOutputMatches('@bussolabs/closeyourit-automator/1.2.0-evil linux-x64 node-v26', '1.2.0')).toBe(false)
    expect(versionOutputMatches('@other/1.2.0 linux-x64', '1.2.0')).toBe(false)
    expect(versionOutputMatches('', '1.2.0')).toBe(false)
  })

  it('cleanup ignores targets outside the confined releasesRoot', () => {
    let removed = ''
    const probe = defaultUpdateProbe({...base, fs: fakeFs({remove: (f) => (removed = f)})})
    expect(() => probe.cleanup('/tmp/x')).not.toThrow()
    expect(removed).toBe('')
  })

  it('cleanup removes a direct directory confined in the canonical releasesRoot', () => {
    const target = '/opt/a/releases/.staging-1.2.0-orphan'
    let removed = ''
    const probe = defaultUpdateProbe({...base, fs: fakeFs({
      isDirectory: (candidate) => candidate === '/opt/a/releases' || candidate === target,
      remove: (file) => (removed = file),
    })})

    probe.cleanup(target)
    expect(path.dirname(removed)).toBe('/opt/a/releases')
    expect(path.basename(removed)).toMatch(/^\.cleanup-[0-9a-f-]+$/)
  })

  it('cleanup does not delete a replacement moved atomically after the validation', () => {
    const target = '/opt/a/releases/.staging-1.2.0-orphan'
    const removed: string[] = []
    const renames: Array<{source: string; destination: string}> = []
    const probe = defaultUpdateProbe({...base, fs: fakeFs({
      isDirectory: (candidate) => candidate === '/opt/a/releases' || candidate === target,
      renameNoReplace: (source, destination) => {
        renames.push({source, destination})
        return true
      },
      sameDirectory: (candidate) => !path.basename(candidate).startsWith('.cleanup-'),
      remove: (file) => removed.push(file),
    })})

    probe.cleanup(target)
    expect(renames).toHaveLength(2)
    expect(renames[0].source).toBe(target)
    expect(renames[1].destination).toBe(target)
    expect(removed).toEqual([])
  })

  it('real journal is atomic, re-readable and rejects coinciding targets before any cleanup', () => {
    const installRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'cyau48-journal-'))
    const probe = defaultUpdateProbe({...base, installRoot})
    const transaction: UpdateTransaction = {
      version: 1,
      transactionId: TX_ID,
      targetVersion: '1.2.0',
      targetPath: path.join(installRoot, 'releases', '1.2.0'),
      previousTarget: path.join(installRoot, 'releases', '1.0.0'),
      targetOwnership: 'promoted',
      stagingRoot: path.join(installRoot, 'releases', '.staging-1.2.0-test'),
    }
    probe.writeTransaction(transaction)
    expect(probe.readTransaction()).toEqual(transaction)
    probe.clearTransaction()
    expect(probe.readTransaction()).toBeNull()

    const unsafe = {...transaction, previousTarget: transaction.targetPath}
    probe.writeTransaction(unsafe)
    expect(() => probe.readTransaction()).toThrow(/coincidono/)

    const unsafeStaging = {...transaction, stagingRoot: path.join(installRoot, '.staging-1.2.0-escape')}
    probe.writeTransaction(unsafeStaging)
    expect(() => probe.readTransaction()).toThrow(/staging.*fuori/i)
    fs.rmSync(installRoot, {recursive: true, force: true})
  })

  it('readTransaction rejects corrupted journals, external targets and staging without unique suffix', () => {
    const valid = {
      version: 1,
      transactionId: '11111111-1111-4111-8111-111111111111',
      targetVersion: '1.2.0',
      targetPath: '/opt/a/releases/1.2.0',
      previousTarget: null,
      targetOwnership: 'preexisting',
      stagingRoot: null,
    }
    const probeFor = (value: string) => defaultUpdateProbe({...base, fs: fakeFs({
      exists: () => true,
      readFile: () => Buffer.from(value),
    })})

    expect(() => probeFor('{').readTransaction()).toThrow(/non leggibile o non JSON/)
    expect(() => probeFor(JSON.stringify({...valid, transactionId: 'not-a-uuid'})).readTransaction()).toThrow(/journal update non valido/)
    expect(() => probeFor(JSON.stringify({...valid, targetPath: '/tmp/1.2.0'})).readTransaction()).toThrow(/target.*fuori/)
    expect(() => probeFor(JSON.stringify({...valid, previousTarget: '../../tmp/1.0.0'})).readTransaction()).toThrow(/target precedente.*fuori/)

    const promoted = {...valid, targetOwnership: 'promoted', stagingRoot: '/opt/a/releases/.staging-1.2.0-'}
    expect(() => probeFor(JSON.stringify(promoted)).readTransaction()).toThrow(/staging.*fuori/)
    expect(() => probeFor(JSON.stringify({...promoted, stagingRoot: '/opt/a/releases/.staging-9.9.9-x'})).readTransaction())
      .toThrow(/staging.*fuori/)
    expect(probeFor(JSON.stringify(valid)).readTransaction()).toEqual(valid)
  })

  it('activateRetained fails closed at every observable replacement of the root/release/entrypoint chain', () => {
    const release = '/opt/a/releases/1.2.0'
    const makeProbe = (
      overrides: Partial<UpdateFs>,
      run: CommandRunner = () => ({status: 0, stdout: '@bussolabs/closeyourit-automator/1.2.0 linux-x64 node-v26', stderr: ''}),
    ) => {
      let current: string | null = null
      return defaultUpdateProbe({...base, run, fs: fakeFs({
        isDirectory: () => true,
        realpath: (target) => target,
        readlink: () => current,
        symlinkReplace: (target) => { current = target },
        ...overrides,
      })})
    }

    expect(makeProbe({isDirectory: () => false}).activateRetained(release, '1.2.0', () => true)).toBe(false)
    expect(makeProbe({sameDirectory: () => false}).activateRetained(release, '1.2.0', () => true)).toBe(false)

    let directoryChecks = 0
    expect(makeProbe({
      sameDirectory: () => ++directoryChecks !== 2,
    }).activateRetained(release, '1.2.0', () => true)).toBe(false)
    expect(makeProbe({sameFile: () => false}).activateRetained(release, '1.2.0', () => true)).toBe(false)
    expect(makeProbe({}, () => ({status: 1, stdout: '', stderr: 'candidate failed'}))
      .activateRetained(release, '1.2.0', () => true)).toBe(false)

    directoryChecks = 0
    expect(makeProbe({
      sameDirectory: () => ++directoryChecks !== 3,
    }).activateRetained(release, '1.2.0', () => true)).toBe(false)
    expect(makeProbe({readlink: () => null}).activateRetained(release, '1.2.0', () => true)).toBe(false)
    expect(makeProbe({}).activateRetained(release, '1.2.0', () => false)).toBe(false)

    let reads = 0
    expect(makeProbe({readlink: () => ++reads === 1 ? release : null}).activateRetained(release, '1.2.0', () => true)).toBe(false)
  })

  it('activateRetained fails closed if it cannot keep one of the identities open', () => {
    const release = '/opt/a/releases/1.2.0'
    const rootUnavailable = fakeFs({
      isDirectory: () => true,
      realpath: (target) => target,
      withDirectoryIdentity: (() => null) as UpdateFs['withDirectoryIdentity'],
    })
    expect(defaultUpdateProbe({...base, fs: rootUnavailable}).activateRetained(release, '1.2.0', () => true)).toBe(false)

    const releaseUnavailable = fakeFs({
      isDirectory: () => true,
      realpath: (target) => target,
      withDirectoryIdentity: ((target, run) => target === '/opt/a/releases' ? run('root') : null) as UpdateFs['withDirectoryIdentity'],
    })
    expect(defaultUpdateProbe({...base, fs: releaseUnavailable}).activateRetained(release, '1.2.0', () => true)).toBe(false)

    const fileUnavailable = fakeFs({
      isDirectory: () => true,
      realpath: (target) => target,
      withFileIdentity: (() => null) as UpdateFs['withFileIdentity'],
    })
    expect(defaultUpdateProbe({...base, fs: fileUnavailable}).activateRetained(release, '1.2.0', () => true)).toBe(false)
  })

  it('cleanup preserves the target on a lost claim and completes a rename that succeeded before an error', () => {
    const target = '/opt/a/releases/.staging-1.2.0-orphan'
    const notMoved: string[] = []
    defaultUpdateProbe({...base, fs: fakeFs({
      isDirectory: () => true,
      realpath: (candidate) => candidate,
      renameNoReplace: () => false,
      remove: (candidate) => notMoved.push(candidate),
    })}).cleanup(target)
    expect(notMoved).toEqual([])

    const removed: string[] = []
    defaultUpdateProbe({...base, fs: fakeFs({
      isDirectory: () => true,
      realpath: (candidate) => candidate,
      renameNoReplace: () => { throw new Error('fsync dopo rename') },
      sameDirectory: () => true,
      remove: (candidate) => removed.push(candidate),
    })}).cleanup(target)
    expect(removed).toHaveLength(1)
    expect(path.basename(removed[0])).toMatch(/^\.cleanup-/)
  })

  it('releaseOwnedBy and migrateGuardrails fail closed on I/O and non-Error thrown values', () => {
    const release = '/opt/a/releases/1.2.0'
    const unreadable = defaultUpdateProbe({...base, fs: fakeFs({readFile: () => { throw new Error('missing marker') }})})
    expect(unreadable.releaseOwnedBy(release, TX_ID)).toBe(false)

    const migration = defaultUpdateProbe({
      ...base,
      fs: fakeFs({isDirectory: () => true, realpath: (target) => target}),
      installGuardrails: () => { throw 'policy non scrivibile' },
    })
    expect(() => migration.migrateGuardrails(release)).toThrow(/policy non scrivibile/)
  })

  it('normalizes the relative targets of a legacy journal before recovery and guardrail migration', () => {
    const installRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'cyau48-relative-journal-'))
    const previous = path.join(installRoot, 'releases', '1.0.0')
    const target = path.join(installRoot, 'releases', '1.2.0')
    fs.mkdirSync(previous, {recursive: true})
    fs.mkdirSync(target, {recursive: true})
    const migrated: string[] = []
    const probe = defaultUpdateProbe({
      ...base,
      installRoot,
      installGuardrails: (assetsDir) => migrated.push(assetsDir),
    })
    probe.writeTransaction({
      version: 1,
      transactionId: TX_ID,
      targetVersion: '1.2.0',
      targetPath: target,
      previousTarget: 'releases/1.0.0',
      targetOwnership: 'preexisting',
      stagingRoot: null,
    })

    const transaction = probe.readTransaction()
    expect(transaction?.previousTarget).toBe(previous)
    probe.migrateGuardrails(transaction!.previousTarget!)
    expect(migrated).toEqual([path.join(previous, 'assets', 'guardrails')])
    fs.rmSync(installRoot, {recursive: true, force: true})
  })

  it.skipIf(process.platform !== 'linux')('real marker ownership and staging reaper tell owned targets apart and preserve the final releases', () => {
    const installRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'cyau48-ownership-'))
    const probe = defaultUpdateProbe({...base, installRoot})
    const release = path.join(installRoot, 'releases', '1.2.0')
    const staleOne = path.join(installRoot, 'releases', '.staging-1.2.0-deadone')
    const staleTwo = path.join(installRoot, 'releases', '.staging-1.3.0-deadtwo')
    fs.mkdirSync(release, {recursive: true})
    fs.mkdirSync(staleOne, {recursive: true})
    fs.mkdirSync(staleTwo, {recursive: true})
    fs.writeFileSync(path.join(staleOne, 'artifact.tgz'), 'orphan')

    probe.markReleaseOwnership(release, TX_ID, '1.2.0')
    expect(probe.releaseOwnedBy(release, TX_ID)).toBe(true)
    expect(probe.releaseOwnedBy(release, '22222222-2222-4222-8222-222222222222')).toBe(false)
    expect(probe.reapStaging()).toBe(2)
    expect(fs.existsSync(staleOne)).toBe(false)
    expect(fs.existsSync(staleTwo)).toBe(false)
    expect(fs.existsSync(release)).toBe(true)
    fs.rmSync(installRoot, {recursive: true, force: true})
  })

  it('real release root as a symlink is rejected even if it points to a valid directory', () => {
    const installRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'cyau48-root-link-'))
    const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'cyau48-outside-'))
    const release = path.join(installRoot, 'releases', '1.2.0')
    fs.mkdirSync(path.join(outside, '1.2.0'), {recursive: true})
    fs.symlinkSync(outside, path.join(installRoot, 'releases'))
    const probe = defaultUpdateProbe({...base, installRoot})

    expect(probe.releaseExists(release)).toBe(false)
    fs.rmSync(installRoot, {recursive: true, force: true})
    fs.rmSync(outside, {recursive: true, force: true})
  })

  it('reapStaging and cleanup do not delete through a symlink releasesRoot outside installRoot', () => {
    const installRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'cyau48-cleanup-root-link-'))
    const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'cyau48-cleanup-outside-'))
    const stale = path.join(outside, '.staging-1.2.0-dead')
    const release = path.join(outside, '1.2.0')
    fs.mkdirSync(stale)
    fs.mkdirSync(release)
    fs.symlinkSync(outside, path.join(installRoot, 'releases'))
    const probe = defaultUpdateProbe({...base, installRoot})

    expect(probe.reapStaging()).toBe(0)
    probe.cleanup(path.join(installRoot, 'releases', '1.2.0'))
    expect(fs.existsSync(stale)).toBe(true)
    expect(fs.existsSync(release)).toBe(true)
    fs.rmSync(installRoot, {recursive: true, force: true})
    fs.rmSync(outside, {recursive: true, force: true})
  })
})

// ── Default implementations (real I/O, tmpdir) ────────────────────────────────────────────────────────

describe('defaultCommandRunner / defaultUpdateFs — I/O reale', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'cyau33-'))
  afterEach(() => {
    // best-effort: cleanup of the files created in tmp
  })

  it('defaultCommandRunner runs a command and captures its status/stdout', () => {
    const out = defaultCommandRunner('node', ['-e', 'process.stdout.write("ok")'])
    expect(out.status).toBe(0)
    expect(out.stdout).toBe('ok')
  })

  it('defaultCommandRunner on missing binary → non-zero status with detail in stderr', () => {
    const out = defaultCommandRunner('closeyourit-inesistente-xyz', [])
    expect(out.status).not.toBe(0)
    expect(out.stderr.length).toBeGreaterThan(0)
  })

  it('processStartIdentity uses the Linux kernel ticks, not one-second-resolution ps timestamps', () => {
    const fields = Array.from({length: 20}, () => '0')
    fields[0] = 'S'
    fields[19] = '987654321'
    const stat = `42 (worker con ) nel nome) ${fields.join(' ')}`
    const calls: string[] = []

    expect(processStartIdentity(42, {
      platform: 'linux',
      readFile: () => stat,
      run: (cmd) => {
        calls.push(cmd)
        return {status: 0, stdout: 'non-usato', stderr: ''}
      },
    })).toBe('linux:987654321')
    expect(calls).toEqual([])
  })

  it('processStartIdentity fails closed on unreliable pid and kernel data', () => {
    const neverRun: CommandRunner = () => {
      throw new Error('la sonda non deve partire')
    }
    for (const pid of [0, -1, Number.NaN, Number.MAX_SAFE_INTEGER + 1]) {
      expect(processStartIdentity(pid, {platform: 'linux', run: neverRun})).toBeNull()
    }

    expect(processStartIdentity(42, {platform: 'linux', readFile: () => 'stat senza parentesi'})).toBeNull()
    expect(processStartIdentity(42, {platform: 'linux', readFile: () => '42 (worker) S 1 2'})).toBeNull()
    const fields = Array.from({length: 20}, () => '0')
    fields[19] = 'not-a-tick'
    expect(processStartIdentity(42, {platform: 'linux', readFile: () => `42 (worker) ${fields.join(' ')}`})).toBeNull()
    expect(processStartIdentity(42, {platform: 'linux', readFile: () => { throw new Error('proc sparito') }})).toBeNull()
    expect(processStartIdentity(42, {platform: 'win32', run: neverRun})).toBeNull()
  })

  it.skipIf(process.platform !== 'linux')('real processStartIdentity is stable for the current process', () => {
    const first = processStartIdentity(process.pid)
    const second = processStartIdentity(process.pid)
    expect(first).not.toBeNull()
    expect(second).toBe(first)
  })

  it('defaultUpdateFs: mkdirp, readFile, atomic symlinkReplace, readlink, remove', () => {
    const fsImpl = defaultUpdateFs()
    const dir = path.join(tmp, 'releases', '1.0.0')
    fsImpl.mkdirp(dir)
    expect(fs.existsSync(dir)).toBe(true)

    const staging = fsImpl.mkdtemp(path.join(tmp, 'releases', '.staging-1.0.0-'))
    const secondStaging = fsImpl.mkdtemp(path.join(tmp, 'releases', '.staging-1.0.0-'))
    expect(staging).not.toBe(dir)
    expect(secondStaging).not.toBe(staging)
    const stagedRelease = path.join(staging, 'release')
    fsImpl.mkdirp(stagedRelease)
    const promoted = path.join(tmp, 'releases', '1.0.1')
    fsImpl.rename(stagedRelease, promoted)
    expect(fs.existsSync(promoted)).toBe(true)
    expect(fsImpl.exists(promoted)).toBe(true)

    fs.writeFileSync(path.join(secondStaging, 'partial'), 'partial')
    fsImpl.remove(secondStaging)
    expect(fs.existsSync(secondStaging)).toBe(false)

    const artifact = path.join(tmp, 'artifact.bin')
    fs.writeFileSync(artifact, 'contenuto')
    expect(fsImpl.readFile(artifact).toString()).toBe('contenuto')

    const link = path.join(tmp, 'current')
    fsImpl.symlinkReplace(dir, link)
    expect(fsImpl.readlink(link)).toBe(dir)

    // atomic and replaceable: a second swap replaces the previous one without an "already exists" error
    const dir2 = path.join(tmp, 'releases', '1.1.0')
    fsImpl.mkdirp(dir2)
    fsImpl.symlinkReplace(dir2, link)
    expect(fsImpl.readlink(link)).toBe(dir2)
    expect(fsImpl.unlinkSymlinkIfTarget(link, dir)).toBe(false)
    expect(fsImpl.readlink(link)).toBe(dir2)
    expect(fsImpl.unlinkSymlinkIfTarget(link, dir2)).toBe(true)
    expect(fsImpl.readlink(link)).toBeNull()

    const dangling = path.join(tmp, 'releases', 'dangling')
    fs.symlinkSync(path.join(tmp, 'missing-target'), dangling)
    expect(fsImpl.exists(dangling)).toBe(true)
    fsImpl.remove(dangling)

    fsImpl.remove(artifact)
    expect(fs.existsSync(artifact)).toBe(false)
    // remove is best-effort: a missing path does not throw
    expect(() => fsImpl.remove(path.join(tmp, 'non-esiste'))).not.toThrow()
  })

  it('defaultUpdateFs.readlink on missing link → null', () => {
    expect(defaultUpdateFs().readlink(path.join(tmp, 'nessun-link'))).toBeNull()
  })

  it.skipIf(process.platform !== 'linux')('defaultUpdateFs renameNoReplace is atomic: it does not clobber a concurrent directory', () => {
    const root = fs.mkdtempSync(path.join(tmp, 'rename-exclusive-'))
    const firstSource = path.join(root, 'source-one')
    const destination = path.join(root, 'destination')
    fs.mkdirSync(firstSource)
    fs.writeFileSync(path.join(firstSource, 'ours'), 'ours')
    fs.mkdirSync(destination)
    fs.writeFileSync(path.join(destination, 'theirs'), 'theirs')
    const io = defaultUpdateFs()

    expect(io.renameNoReplace(firstSource, destination)).toBe(false)
    expect(fs.readFileSync(path.join(destination, 'theirs'), 'utf8')).toBe('theirs')
    expect(fs.existsSync(path.join(firstSource, 'ours'))).toBe(true)

    const secondSource = path.join(root, 'source-two')
    const freeDestination = path.join(root, 'free-destination')
    fs.mkdirSync(secondSource)
    fs.writeFileSync(path.join(secondSource, 'ours'), 'ours')
    expect(io.renameNoReplace(secondSource, freeDestination)).toBe(true)
    expect(fs.readFileSync(path.join(freeDestination, 'ours'), 'utf8')).toBe('ours')
  })

  it('defaultUpdateFs serializes concurrent updaters and recovers a dead process lock', () => {
    const root = fs.mkdtempSync(path.join(tmp, 'lock-'))
    const lock = path.join(root, '.update.lock')
    const first = defaultUpdateFs()
    const second = defaultUpdateFs()
    const firstToken = first.acquireLock(lock)
    expect(firstToken).not.toBeNull()
    expect(second.acquireLock(lock)).toBeNull()
    first.releaseLock(lock, firstToken!)
    const secondToken = second.acquireLock(lock)
    expect(secondToken).not.toBeNull()
    second.releaseLock(lock, secondToken!)

    fs.symlinkSync('999999999:dead-owner', lock)
    const recoveredToken = first.acquireLock(lock)
    expect(recoveredToken).not.toBeNull()
    first.releaseLock(lock, recoveredToken!)
  })

  it('never recovers by age alone a lock whose process is still the same owner', () => {
    const root = fs.mkdtempSync(path.join(tmp, 'lock-reused-pid-'))
    const lock = path.join(root, '.update.lock')
    const owner = defaultUpdateFs({
      now: () => 1,
      processIsAlive: () => true,
      processIdentity: () => 'owner-start',
    })
    const ownerToken = owner.acquireLock(lock)
    expect(ownerToken).not.toBeNull()
    const challenger = defaultUpdateFs({
      now: () => 2_000_000_000_000,
      processIsAlive: () => true,
      processIdentity: () => 'owner-start',
    })

    expect(challenger.acquireLock(lock)).toBeNull()
    owner.releaseLock(lock, ownerToken!)
  })

  it('recovers a v2 lock when the live PID belongs to a recycled process', () => {
    const root = fs.mkdtempSync(path.join(tmp, 'lock-recycled-pid-'))
    const lock = path.join(root, '.update.lock')
    const owner = defaultUpdateFs({
      processIsAlive: () => true,
      processIdentity: () => 'old-start',
    })
    expect(owner.acquireLock(lock)).not.toBeNull()
    const io = defaultUpdateFs({
      processIsAlive: () => true,
      processIdentity: () => 'new-start',
    })

    const token = io.acquireLock(lock)
    expect(token).not.toBeNull()
    io.releaseLock(lock, token!)
  })

  it('keeps fail-closed a legacy lock bound to a still live PID', () => {
    const root = fs.mkdtempSync(path.join(tmp, 'lock-legacy-live-'))
    const lock = path.join(root, '.update.lock')
    fs.symlinkSync(`${process.pid}:1:legacy-owner`, lock)
    const io = defaultUpdateFs({processIsAlive: () => true, processIdentity: () => 'new-start'})

    expect(io.acquireLock(lock)).toBeNull()
  })

  it('keeps fail-closed also a live v2 lock created without kernel identity', () => {
    const root = fs.mkdtempSync(path.join(tmp, 'lock-unknown-live-'))
    const lock = path.join(root, '.update.lock')
    const owner = defaultUpdateFs({processIsAlive: () => true, processIdentity: () => null})
    const ownerToken = owner.acquireLock(lock)
    expect(ownerToken).toContain(':unknown:')

    const challenger = defaultUpdateFs({processIsAlive: () => true, processIdentity: () => 'precise-start'})
    expect(challenger.acquireLock(lock)).toBeNull()
    owner.releaseLock(lock, ownerToken!)
  })

  it('defaultUpdateFs makes content, rename, symlink and journal removal durable', () => {
    const root = fs.mkdtempSync(path.join(tmp, 'durable-'))
    const io = defaultUpdateFs()
    const transaction = path.join(root, '.update-transaction.json')
    io.writeFileAtomic(transaction, '{"version":1}\n')
    expect(io.readFile(transaction).toString()).toBe('{"version":1}\n')

    const staged = path.join(root, 'releases', '.staging', 'release')
    io.mkdirp(staged)
    io.writeFileAtomic(path.join(staged, 'bin.js'), 'ok')
    io.syncTree(staged)
    const final = path.join(root, 'releases', '1.2.0')
    io.rename(staged, final)
    io.symlinkReplace(final, path.join(root, 'current'))
    expect(io.readlink(path.join(root, 'current'))).toBe(final)

    io.remove(transaction)
    expect(io.exists(transaction)).toBe(false)
  })

  it('defaultUpdateFs does not follow symlinks and rejects missing or wrong-type file/directory identities', () => {
    const root = fs.mkdtempSync(path.join(tmp, 'identity-'))
    const directory = path.join(root, 'directory')
    const file = path.join(root, 'file')
    const directoryLink = path.join(root, 'directory-link')
    const fileLink = path.join(root, 'file-link')
    const missing = path.join(root, 'missing')
    fs.mkdirSync(directory)
    fs.writeFileSync(file, 'content')
    fs.symlinkSync(directory, directoryLink)
    fs.symlinkSync(file, fileLink)
    const io = defaultUpdateFs()

    const directoryIdentity = io.withDirectoryIdentity(directory, (identity) => identity)
    const fileIdentity = io.withFileIdentity(file, (identity) => identity)
    expect(directoryIdentity).not.toBeNull()
    expect(fileIdentity).not.toBeNull()
    expect(io.withDirectoryIdentity(missing, () => 'unexpected')).toBeNull()
    expect(io.withDirectoryIdentity(file, () => 'unexpected')).toBeNull()
    expect(io.withDirectoryIdentity(directoryLink, () => 'unexpected')).toBeNull()
    expect(io.withFileIdentity(missing, () => 'unexpected')).toBeNull()
    expect(io.withFileIdentity(directory, () => 'unexpected')).toBeNull()
    expect(io.withFileIdentity(fileLink, () => 'unexpected')).toBeNull()
    expect(io.sameDirectory(file, directoryIdentity!)).toBe(false)
    expect(io.sameDirectory(missing, directoryIdentity!)).toBe(false)
    expect(io.sameFile(directory, fileIdentity!)).toBe(false)
    expect(io.sameFile(missing, fileIdentity!)).toBe(false)
    expect(io.isDirectory(missing)).toBe(false)
    expect(io.realpath(missing)).toBeNull()
    expect(io.list(missing)).toEqual([])

    io.syncTree(directoryLink)
  })

  it('defaultUpdateFs handles non-symlink lock, already present reaper and idempotent release', () => {
    const root = fs.mkdtempSync(path.join(tmp, 'lock-boundaries-'))
    const lock = path.join(root, '.update.lock')
    const io = defaultUpdateFs({processIsAlive: () => false, processIdentity: () => 'identity'})

    io.releaseLock(lock, 'token-assente')
    fs.writeFileSync(lock, 'non-symlink')
    expect(io.acquireLock(lock)).toBeNull()
    fs.rmSync(lock)

    fs.symlinkSync('not-a-pid', lock)
    fs.symlinkSync('busy-reaper', `${lock}.reaper`)
    expect(io.acquireLock(lock)).toBeNull()
    fs.unlinkSync(`${lock}.reaper`)
    fs.unlinkSync(lock)

    const token = io.acquireLock(lock)!
    io.releaseLock(lock, 'token-diverso')
    expect(fs.readlinkSync(lock)).toBe(token)
    io.releaseLock(lock, token)
    expect(io.unlinkSymlinkIfTarget(lock, token)).toBe(false)
  })
})
