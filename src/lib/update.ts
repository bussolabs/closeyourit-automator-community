import {createHash, randomUUID} from 'node:crypto'
import {spawnSync} from 'node:child_process'
import * as fs from 'node:fs'
import * as path from 'node:path'
import {z} from 'zod'
import {isSafeSegment} from './workspace'
import {installGuardrails} from './guardrails'
import {managedGuardrailPaths} from './managed-service'
import {redactSecrets} from './secret-redaction'
import {AutomatorError, ErrorCodes} from '../errors/error-codes'

// Controlled distribution and updates of the Automator (CYAU-33). The Automator is distributed as a versioned
// artifact published by GitHub Actions on a CHANNEL (stable/beta), described by a MANIFEST with sha256
// checksum and server compatibility requirements. The installation uses an ATOMIC layout based on releases + symlink:
//   installRoot/releases/<version>/   one directory per installed version
//   installRoot/current               symlink → releases/<version> (the ACTIVE version)
// `automator update`: fetch of the channel manifest → selection of the target release (the latest > current,
// compatible) → unique staging → download → checksum VERIFICATION (unverified version → never extracted) →
// isolated extraction + preflight → rename into the immutable release → ATOMIC SWAP of `current` → restart → health. If
// any step after the swap throws → ROLLBACK: `current` goes back to the previous release + restart.
//
// The service gates run with the INSTALLED binary: a defect in them would make every later release
// unreachable, because the fixed code never runs. `skipServicePreflight` is the explicit recovery
// path (CYAU-156): no gate queried, only the managed bytes updated, service untouched and to be
// reconciled with a second `automator update` — which at that point runs from the new code.
//
// "Without losing runs" (DoD) is a STRUCTURAL property: the probe never touches state/data. The only mutation
// outside `installRoot` is the fail-closed migration of the runtime guardrails in config/CODEX_HOME; on rollback the
// canonical set of the previous release is reinstalled. State and data stay separate and intact directories.
//
// The core is PURE and deterministic (channels, semver, checksum, compatibility, selection, plan); the real
// execution (curl/tar/symlink/restart) lives behind the injectable `UpdateProbe` probe — like `deliver`/`workspace` —
// so the orchestration (rollback included) is testable without processes or network.

// ── Distribution channels ───────────────────────────────────────────────────────────────────────────────

export type ReleaseChannel = 'stable' | 'beta'
export const RELEASE_CHANNELS: readonly ReleaseChannel[] = ['stable', 'beta']
export const DEFAULT_CHANNEL: ReleaseChannel = 'stable'

export function isReleaseChannel(value: string): value is ReleaseChannel {
  return (RELEASE_CHANNELS as readonly string[]).includes(value)
}

/** Rejects an unknown channel (it ends up in the manifest URL and in the cache path). Exit 2. */
export function assertReleaseChannel(value: string): asserts value is ReleaseChannel {
  if (!isReleaseChannel(value)) {
    throw new AutomatorError(
      ErrorCodes.Update.invalidInput,
      `Canale di distribuzione sconosciuto: "${value}" (atteso ${RELEASE_CHANNELS.join('|')})`,
      2,
    )
  }
}

// ── Semver (pure, minimal but compliant on prerelease precedence) ─────────────────────────────────

export interface Semver {
  major: number
  minor: number
  patch: number
  prerelease: string[]
}

const SEMVER_RE = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-((?:0|[1-9]\d*|\d*[A-Za-z-][0-9A-Za-z-]*)(?:\.(?:0|[1-9]\d*|\d*[A-Za-z-][0-9A-Za-z-]*))*))?$/

/** Parses the publisher's canonical SemVer subset (safe-integer core, prerelease, no build metadata). */
export function parseSemver(value: string): Semver | null {
  const m = SEMVER_RE.exec(value)
  if (!m) return null
  const core = [Number(m[1]), Number(m[2]), Number(m[3])]
  if (!core.every(Number.isSafeInteger)) return null
  return {
    major: core[0],
    minor: core[1],
    patch: core[2],
    prerelease: m[4] ? m[4].split('.') : [],
  }
}

function sign(n: number): -1 | 0 | 1 {
  return n < 0 ? -1 : n > 0 ? 1 : 0
}

/** Compares two prerelease identifiers: numeric < alphanumeric, numeric ones by value. */
function compareIdentifier(a: string, b: string): -1 | 0 | 1 {
  const aNum = /^\d+$/.test(a)
  const bNum = /^\d+$/.test(b)
  if (aNum && bNum) {
    if (a.length !== b.length) return sign(a.length - b.length)
    return sign(a < b ? -1 : a > b ? 1 : 0)
  }
  if (aNum) return -1 // a numeric identifier has lower precedence than an alphanumeric one
  if (bNum) return 1
  return sign(a < b ? -1 : a > b ? 1 : 0)
}

function comparePrerelease(a: string[], b: string[]): -1 | 0 | 1 {
  // A release (no prerelease) has HIGHER precedence than the associated prerelease.
  if (a.length === 0 && b.length === 0) return 0
  if (a.length === 0) return 1
  if (b.length === 0) return -1
  const len = Math.min(a.length, b.length)
  for (let i = 0; i < len; i++) {
    const cmp = compareIdentifier(a[i], b[i])
    if (cmp !== 0) return cmp
  }
  // With an equal prefix, the larger set of fields has higher precedence.
  return sign(a.length - b.length)
}

/** Orders two semver versions: -1 (a<b), 0 (equal), 1 (a>b). Prerelease < release. */
export function compareSemver(a: Semver, b: Semver): -1 | 0 | 1 {
  if (a.major !== b.major) return sign(a.major - b.major)
  if (a.minor !== b.minor) return sign(a.minor - b.minor)
  if (a.patch !== b.patch) return sign(a.patch - b.patch)
  return comparePrerelease(a.prerelease, b.prerelease)
}

// ── sha256 checksum (artifact integrity check) ─────────────────────────────────────────────────

/** Hex sha256 of the content (pure, deterministic). */
export function computeSha256(data: Buffer | string): string {
  return createHash('sha256').update(data).digest('hex')
}

/** Normalizes a checksum: lowercase, without spaces, without the optional `sha256:` prefix. */
export function normalizeChecksum(value: string): string {
  return value.trim().toLowerCase().replace(/^sha256:/, '')
}

/** true if the expected and the computed checksum match (normalized comparison). An empty expected one → false. */
export function checksumMatches(expected: string, actual: string): boolean {
  const e = normalizeChecksum(expected)
  const a = normalizeChecksum(actual)
  return e.length > 0 && e === a
}

// ── Channel manifest (UNTRUSTED data: downloaded from the network) ───────────────────────────────────────────

export const ReleaseEntrySchema = z
  .object({
    version: z.string(),
    channel: z.enum(['stable', 'beta']),
    /** URL of the artifact (tarball) to download. */
    url: z.string(),
    /** Expected sha256 checksum of the artifact (with or without the `sha256:` prefix). */
    sha256: z.string(),
    /** Compatibility: minimum CloseYourIt server version required (optional). */
    minServer: z.string().refine((value) => parseSemver(value) !== null, 'minServer non SemVer').optional(),
    /** Compatibility: maximum supported server version (optional). */
    maxServer: z.string().refine((value) => parseSemver(value) !== null, 'maxServer non SemVer').optional(),
    notes: z.string().optional(),
  })
  .strict()
export type ReleaseEntry = z.infer<typeof ReleaseEntrySchema>

export interface ReleaseManifest {
  channel: ReleaseChannel
  releases: ReleaseEntry[]
}

/**
 * Parses a downloaded manifest fail-closed: unexpected shape (not an
 * object, channel out of domain, `releases` not an array) → null. A single malformed entry or one of another channel
 * invalidates the whole cumulative generation: it is not safe to silently regress to a previous release.
 */
export function parseManifest(raw: unknown): ReleaseManifest | null {
  if (typeof raw !== 'object' || raw === null) return null
  const obj = raw as Record<string, unknown>
  if (obj.channel !== 'stable' && obj.channel !== 'beta') return null
  if (!Array.isArray(obj.releases)) return null
  const releases: ReleaseEntry[] = []
  for (const entry of obj.releases) {
    const parsed = ReleaseEntrySchema.safeParse(entry)
    if (
      !parsed.success ||
      parsed.data.channel !== obj.channel ||
      parseSemver(parsed.data.version) === null ||
      assessServerCompatibility(parsed.data, null).status === 'incompatible'
    ) return null
    releases.push(parsed.data)
  }
  return {channel: obj.channel, releases}
}

// ── Server/client compatibility ───────────────────────────────────────────────────────────────────────────

export type CompatibilityStatus = 'compatible' | 'incompatible' | 'unknown'
export interface CompatibilityResult {
  status: CompatibilityStatus
  reason: string
}

/**
 * Evaluates whether a release is compatible with the current server. No requirement → compatible. Requirements
 * present but unknown/uninterpretable server version → `unknown` (does not block, but it is noted: the
 * compatibility is not verifiable). Server outside the [minServer, maxServer] range → `incompatible`.
 */
export function assessServerCompatibility(
  entry: Pick<ReleaseEntry, 'minServer' | 'maxServer'>,
  serverVersion: string | null,
): CompatibilityResult {
  const {minServer, maxServer} = entry
  if (minServer === undefined && maxServer === undefined) {
    return {status: 'compatible', reason: 'nessun requisito di compatibilità server'}
  }
  const min = minServer === undefined ? null : parseSemver(minServer)
  const max = maxServer === undefined ? null : parseSemver(maxServer)
  if (minServer !== undefined && !min) return {status: 'incompatible', reason: `vincolo minServer non valido: "${minServer}"`}
  if (maxServer !== undefined && !max) return {status: 'incompatible', reason: `vincolo maxServer non valido: "${maxServer}"`}
  if (min && max && compareSemver(min, max) > 0) {
    return {status: 'incompatible', reason: `range server non valido: ${minServer} > ${maxServer}`}
  }
  if (serverVersion == null) {
    return {status: 'unknown', reason: 'versione server sconosciuta: compatibilità non verificabile'}
  }
  const sv = parseSemver(serverVersion)
  if (!sv) return {status: 'unknown', reason: `versione server non interpretabile: "${serverVersion}"`}
  if (min) {
    if (compareSemver(sv, min) < 0) {
      return {status: 'incompatible', reason: `richiede server ≥ ${minServer} (attuale ${serverVersion})`}
    }
  }
  if (max) {
    if (compareSemver(sv, max) > 0) {
      return {status: 'incompatible', reason: `richiede server ≤ ${maxServer} (attuale ${serverVersion})`}
    }
  }
  return {status: 'compatible', reason: `server ${serverVersion} nel range supportato`}
}

// ── Target release selection (pure) ─────────────────────────────────────────────────────────────────

export type SelectionDecision = 'update' | 'up-to-date' | 'incompatible' | 'none'

export interface Selection {
  decision: SelectionDecision
  target: ReleaseEntry | null
  reason: string
  currentVersion: string | null
  /** Discarded releases (incompatible with the server) — for the audit. */
  skipped: Array<{version: string; reason: string}>
}

export interface SelectOptions {
  channel: ReleaseChannel
  currentVersion: string | null
  serverVersion?: string | null
  /** true → also consider versions ≤ current (do not stop on up-to-date). */
  allowDowngrade?: boolean
}

/**
 * Picks the release to install from the channel manifest: the latest one NEWER than the current (semver) and
 * COMPATIBLE with the server. Incompatible ones are discarded going down in version (noted in `skipped`). No
 * newer version → `up-to-date`; only newer versions but all incompatible → `incompatible`; no
 * valid release in the channel → `none`. Pure and deterministic.
 */
export function selectTargetRelease(manifest: ReleaseManifest, opts: SelectOptions): Selection {
  const skipped: Array<{version: string; reason: string}> = []
  const parsed = manifest.releases
    .filter((entry) => entry.channel === opts.channel)
    .map((entry) => ({entry, sv: parseSemver(entry.version)}))
    .filter((x): x is {entry: ReleaseEntry; sv: Semver} => x.sv !== null)
    .sort((a, b) => compareSemver(b.sv, a.sv)) // descending: the latest first

  if (parsed.length === 0) {
    return {decision: 'none', target: null, reason: `nessuna release valida nel canale ${opts.channel}`, currentVersion: opts.currentVersion, skipped}
  }

  const current = opts.currentVersion ? parseSemver(opts.currentVersion) : null
  const candidates = parsed.filter((x) => opts.allowDowngrade || current === null || compareSemver(x.sv, current) > 0)
  if (candidates.length === 0) {
    return {decision: 'up-to-date', target: null, reason: `già all'ultima versione disponibile (${opts.currentVersion})`, currentVersion: opts.currentVersion, skipped}
  }

  for (const {entry} of candidates) {
    const compat = assessServerCompatibility(entry, opts.serverVersion ?? null)
    if (compat.status === 'incompatible') {
      skipped.push({version: entry.version, reason: compat.reason})
      continue
    }
    const note = compat.status === 'unknown' ? ` (compatibilità server non verificata: ${compat.reason})` : ''
    return {decision: 'update', target: entry, reason: `release ${entry.version} selezionata dal canale ${opts.channel}${note}`, currentVersion: opts.currentVersion, skipped}
  }

  return {decision: 'incompatible', target: null, reason: `tutte le versioni più recenti sono incompatibili col server`, currentVersion: opts.currentVersion, skipped}
}

export interface SelectPinnedOptions {
  channel: ReleaseChannel
  currentVersion: string | null
  targetVersion: string
  serverVersion?: string | null
}

/**
 * Selects an explicit pin without letting it bypass the same assessment as the automatic selection.
 * A pin is a precise operational request: if the release declares constraints, a missing or
 * uninterpretable server version makes the assessment `unknown` and it is rejected (fail-closed), instead of installing blindly.
 */
export function selectPinnedRelease(manifest: ReleaseManifest, opts: SelectPinnedOptions): Selection {
  if (parseSemver(opts.targetVersion) === null) {
    return {
      decision: 'none',
      target: null,
      reason: `versione target non valida: "${opts.targetVersion}"`,
      currentVersion: opts.currentVersion,
      skipped: [],
    }
  }
  const pinned = manifest.releases.find((entry) => entry.channel === opts.channel && entry.version === opts.targetVersion)
  if (!pinned) {
    return {
      decision: 'none',
      target: null,
      reason: `versione ${opts.targetVersion} non presente nel canale ${opts.channel}`,
      currentVersion: opts.currentVersion,
      skipped: [],
    }
  }

  const compatibility = assessServerCompatibility(pinned, opts.serverVersion ?? null)
  if (compatibility.status !== 'compatible') {
    return {
      decision: 'incompatible',
      target: null,
      reason: `pin ${opts.targetVersion} incompatibile col server: ${compatibility.reason}`,
      currentVersion: opts.currentVersion,
      skipped: [{version: pinned.version, reason: compatibility.reason}],
    }
  }

  return {
    decision: 'update',
    target: pinned,
    reason: `pin ${opts.targetVersion}`,
    currentVersion: opts.currentVersion,
    skipped: [],
  }
}

// ── Atomic plan and paths (pure, segment defence) ──────────────────────────────────────────────────────────

/** Validates a version as a path segment (it ends up in `releases/<version>`): never `..`/separators/hostile keys. */
function assertSafeVersion(version: string): void {
  if (!isSafeSegment(version)) {
    throw new AutomatorError(ErrorCodes.Update.invalidInput, `Versione non valida come segmento di path: "${version}"`, 2)
  }
}

/** Release directory `installRoot/releases/<version>` (version validated as a safe segment). */
export function releaseDirFor(installRoot: string, version: string): string {
  assertSafeVersion(version)
  return path.join(installRoot, 'releases', version)
}

/** The `installRoot/current` symlink pointing to the active release. */
export function currentLinkFor(installRoot: string): string {
  return path.join(installRoot, 'current')
}

/** Exclusive lock of the whole update transaction (download → health/rollback included). */
export function updateLockFor(installRoot: string): string {
  return path.join(installRoot, '.update.lock')
}

/** Durable journal used to reconcile a process terminated after the promotion or the switch. */
export function updateTransactionFor(installRoot: string): string {
  return path.join(installRoot, '.update-transaction.json')
}

/** Prefix of the unique staging under `releases/` (version validated as a safe segment). */
export function stagingPrefixFor(installRoot: string, version: string): string {
  assertSafeVersion(version)
  return path.join(installRoot, 'releases', `.staging-${version}-`)
}

export interface UpdatePlan {
  channel: ReleaseChannel
  fromVersion: string | null
  toVersion: string
  url: string
  sha256: string
  installRoot: string
  releaseDir: string
  currentLink: string
  stagingPrefix: string
}

export interface PlanInput {
  installRoot: string
  channel: ReleaseChannel
  target: ReleaseEntry
  fromVersion: string | null
}

/** Composes the plan: immutable release, current symlink and staging prefix. Pure (validates the version). */
export function planUpdate(input: PlanInput): UpdatePlan {
  const {installRoot, target} = input
  return {
    channel: input.channel,
    fromVersion: input.fromVersion,
    toVersion: target.version,
    url: target.url,
    sha256: target.sha256,
    installRoot,
    releaseDir: releaseDirFor(installRoot, target.version),
    currentLink: currentLinkFor(installRoot),
    stagingPrefix: stagingPrefixFor(installRoot, target.version),
  }
}

// ── Auditable result (zod schema) ─────────────────────────────────────────────────────────────────────

export const UpdateResultSchema = z
  .object({
    /**
     * updated: new version active and healthy · up-to-date: already on the latest · rolled-back: update failed and
     * previous one restored (healthy system, not updated) · incompatible: no compatible version ·
     * busy: the machine was working, nothing touched (CYAU-202) · failed: unrecoverable failure /
     * integrity violated (checksum) / empty manifest.
     */
    outcome: z.enum(['updated', 'up-to-date', 'rolled-back', 'incompatible', 'busy', 'failed']),
    channel: z.enum(['stable', 'beta']),
    fromVersion: z.string().nullable(),
    toVersion: z.string().nullable(),
    /** true if the artifact checksum was verified (VERIFIED version). */
    verified: z.boolean(),
    /** true if the `current` symlink was swapped to the new release in this run. */
    activated: z.boolean(),
    /** true if a failed update was restored to the previous release. */
    rolledBack: z.boolean(),
    reason: z.string(),
    reasons: z.array(z.string()),
  })
  .strict()
export type UpdateResult = z.infer<typeof UpdateResultSchema>
export type UpdateOutcome = UpdateResult['outcome']

export const UpdateTransactionSchema = z
  .object({
    version: z.literal(1),
    transactionId: z.string().uuid(),
    targetVersion: z.string(),
    targetPath: z.string(),
    previousTarget: z.string().nullable(),
    /** promoted = the target must carry this transaction's marker; preexisting = it must never be deleted. */
    targetOwnership: z.enum(['promoted', 'preexisting']),
    /** Staging owned by the transaction, recorded for the deterministic cleanup after a crash. */
    stagingRoot: z.string().nullable(),
  })
  .strict()
  .superRefine((transaction, ctx) => {
    if (transaction.targetOwnership === 'promoted' && transaction.stagingRoot === null) {
      ctx.addIssue({code: z.ZodIssueCode.custom, path: ['stagingRoot'], message: 'staging richiesta per target promosso'})
    }
    if (transaction.targetOwnership === 'preexisting' && transaction.stagingRoot !== null) {
      ctx.addIssue({code: z.ZodIssueCode.custom, path: ['stagingRoot'], message: 'staging vietata per target preesistente'})
    }
  })
export type UpdateTransaction = z.infer<typeof UpdateTransactionSchema>

const ReleaseOwnershipSchema = z
  .object({version: z.literal(1), transactionId: z.string().uuid(), targetVersion: z.string()})
  .strict()
type ReleaseOwnership = z.infer<typeof ReleaseOwnershipSchema>

// ── Execution probe (injectable) ───────────────────────────────────────────────────────────────────

/**
 * The probe that runs the update (injectable: mocked in tests, real commands in prod). No method touches state or
 * data; `migrateGuardrails` is the only mutation outside installRoot and updates only config/CODEX_HOME with the
 * canonical assets of the given release, restorable from the previous release.
 */
export interface UpdateProbe {
  /** Read-only service preflight, run before any manifest fetch. */
  preflightService?(): void
  /** Acquires the updater's exclusive lock; null means another transaction is active. */
  acquireLock(): string | null
  /** Releases the lock only if it still belongs to the received token. */
  releaseLock(token: string): void
  /** Removes stagings abandoned by previous processes; called only under the exclusive lock. */
  reapStaging(): number
  /** Reads the journal of an interrupted transaction, or null. A malformed journal must fail closed. */
  readTransaction(): UpdateTransaction | null
  /** Writes and fsyncs the journal before the final release becomes visible. */
  writeTransaction(transaction: UpdateTransaction): void
  /** Deletes and fsyncs the journal only after complete verification or rollback. */
  clearTransaction(): void
  /** Currently active version (from the `current` symlink), or null if no installation. */
  currentVersion(): string | null
  /** Downloads and parses the channel manifest (network). */
  fetchManifest(channel: ReleaseChannel): ReleaseManifest
  /** Downloads the artifact into the dedicated temporary file. */
  download(url: string, dest: string): void
  /** Computes the sha256 of the downloaded file. */
  checksum(file: string): string
  /** Creates a new and unique staging directory from the safe prefix. */
  createStaging(prefix: string): string
  /** Extracts the artifact exclusively into the new staged directory. */
  extract(archive: string, destDir: string): void
  /** Verifies the candidate binary before making it active. */
  preflight(releaseDir: string, expectedVersion: string): boolean
  /** true if the final path is already occupied; it does not imply it is reusable. */
  releaseExists(releaseDir: string): boolean
  /** Keeps open the identities of the retained release and of the entrypoint up to restart+health included. */
  activateRetained(releaseDir: string, expectedVersion: string, whilePinned: () => boolean): boolean
  /** Writes into the staged release the durable marker binding the bytes to the transaction. */
  markReleaseOwnership(releaseDir: string, transactionId: string, targetVersion: string): void
  /** Verifies that the target was promoted by exactly the given transaction. */
  releaseOwnedBy(releaseDir: string, transactionId: string): boolean
  /** Atomically promotes the staged release to the immutable final path (rename on the same filesystem). */
  promote(stagedRelease: string, releaseDir: string): void
  /** Reads the current target of the `current` symlink BEFORE the swap (for the rollback), or null. */
  readCurrentTarget(): string | null
  /** true if the systemd service is already installed: at the FIRST bootstrap it is not yet. */
  serviceInstalled(): boolean
  /** Finalizes an orphan service rollback without update journal; true requires stopping this invocation. */
  recoverService?(): boolean
  /** Prepares the service journal before the first guardrail/unit mutation. */
  prepareService?(targetPath: string): void
  /** Atomically installs and verifies the release's canonical guardrails; throws on a partial/corrupt set. */
  migrateGuardrails(releaseDir: string): void
  /** ATOMIC swap of the `current` symlink to the new release. */
  activate(releaseDir: string): void
  /** Restores the `current` symlink to the previous release (rollback). */
  restore(previousTarget: string): void
  /** Removes `current` only if it still points to the expected target (unhealthy bootstrap without a previous one). */
  deactivate(expectedTarget: string): void
  /** Restarts the systemd service so the daemon starts again on the active version. */
  restart(): void
  /** Restores a legacy definition during the bootstrap rollback without a previous release. */
  rollbackService?(): void
  /** Finalizes the service journal only after health and rollback/update are fully verified. */
  commitService?(): void
  /** Verifies that the active version is healthy (e.g. the binary answers `--version`). */
  healthCheck(expectedVersion: string): boolean
  /** Removes staging files or directories (best-effort). */
  cleanup(target: string): void
}

export interface RunUpdateInput {
  installRoot: string
  channel: ReleaseChannel
  serverVersion?: string | null
  allowDowngrade?: boolean
  /** Forces a specific channel version (pin), bypassing the "latest" selection. */
  targetVersion?: string | null
  /**
   * Explicit recovery path (CYAU-156): the service gates run with the INSTALLED binary, so a defect in them
   * makes any later release unreachable — the fixed code never runs. With
   * explicit consent the gates are not queried and the update updates ONLY the managed bytes: no
   * restart, no guardrail migration, no unit mutation. The service must be reconciled right after
   * by re-running `automator update`, which at that point runs from the new code.
   */
  skipServicePreflight?: boolean
}

interface ResultDraft {
  outcome: UpdateOutcome
  channel: ReleaseChannel
  fromVersion: string | null
  toVersion: string | null
  verified?: boolean
  activated?: boolean
  rolledBack?: boolean
  reason: string
  reasons: string[]
}

function makeResult(draft: ResultDraft): UpdateResult {
  return UpdateResultSchema.parse({
    outcome: draft.outcome,
    channel: draft.channel,
    fromVersion: draft.fromVersion,
    toVersion: draft.toVersion,
    verified: draft.verified ?? false,
    activated: draft.activated ?? false,
    rolledBack: draft.rolledBack ?? false,
    reason: draft.reason,
    reasons: draft.reasons,
  })
}

/**
 * "Deferred" outcome (CYAU-202): the machine was working, so the update did not even start —
 * no network, no bytes, no restart. It is not a failure: the next timer round retries.
 */
export function busyResult(channel: ReleaseChannel, fromVersion: string | null, reason: string): UpdateResult {
  return makeResult({outcome: 'busy', channel, fromVersion, toVersion: null, reason, reasons: [reason]})
}

/**
 * Orchestrates the verified and atomic update with rollback behind the probe. Before the swap it touches nothing
 * active: unique staging, checksum before extraction, preflight and rename into the immutable release. After the
 * swap, if the restart/health check fails (or a step throws), the
 * `current` symlink goes back to the previous release and the service restarts on it — the state is never touched,
 * so no run is lost (DoD). Returns an auditable record.
 */
function versionFromTarget(target: string): string {
  return path.basename(target)
}

function cleanupTransactionStaging(transaction: UpdateTransaction, probe: UpdateProbe, reasons: string[]): void {
  if (transaction.stagingRoot === null || !probe.releaseExists(transaction.stagingRoot)) return
  probe.cleanup(transaction.stagingRoot)
  reasons.push(`staging della transazione ripulita (${transaction.stagingRoot})`)
}

/** Deletes the target only when the persistent marker proves this transaction promoted it. */
function cleanupOwnedTarget(transaction: UpdateTransaction, probe: UpdateProbe, reasons: string[]): void {
  if (transaction.targetOwnership === 'preexisting' || !probe.releaseExists(transaction.targetPath)) return
  if (!probe.releaseOwnedBy(transaction.targetPath, transaction.transactionId)) {
    reasons.push(`target ${transaction.targetPath} preservato: ownership della transazione non verificata`)
    return
  }
  probe.cleanup(transaction.targetPath)
  reasons.push(`target posseduto dalla transazione ripulito (${transaction.targetPath})`)
}

function clearRecoveredTransaction(transaction: UpdateTransaction, probe: UpdateProbe, reasons: string[]): void {
  cleanupTransactionStaging(transaction, probe, reasons)
  probe.clearTransaction()
}

function rollbackTransaction(
  transaction: UpdateTransaction,
  probe: UpdateProbe,
  serviceUp: boolean,
  reasons: string[],
): boolean {
  if (transaction.previousTarget === null) return false
  probe.restore(transaction.previousTarget)
  if (probe.readCurrentTarget() !== transaction.previousTarget) {
    throw new AutomatorError(ErrorCodes.Update.failed, 'target rollback non verificabile', 1)
  }
  if (transaction.previousTarget === transaction.targetPath) {
    throw new AutomatorError(ErrorCodes.Update.failed, 'rollback non sicuro: il target da eliminare è ancora attivo', 1)
  }
  if (serviceUp) {
    probe.prepareService?.(transaction.previousTarget)
    probe.migrateGuardrails(transaction.previousTarget)
    reasons.push(`guardrail ripristinati dalla release precedente (${transaction.previousTarget})`)
    probe.restart()
  }
  const previousVersion = versionFromTarget(transaction.previousTarget)
  if (!probe.healthCheck(previousVersion)) {
    throw new AutomatorError(ErrorCodes.Update.failed, `health check della release ${previousVersion} ripristinata fallito`, 1)
  }
  // The target is no longer active: it is deleted only if the marker proves its ownership. A pre-existing
  // release used for a pin/downgrade stays immutable and reusable.
  cleanupOwnedTarget(transaction, probe, reasons)
  clearRecoveredTransaction(transaction, probe, reasons)
  probe.commitService?.()
  reasons.push(`ripristinata e verificata la release precedente (${transaction.previousTarget})`)
  return true
}

function rollbackServiceReconciliation(probe: UpdateProbe, reasons: string[]): void {
  try {
    probe.rollbackService?.()
    probe.commitService?.()
    reasons.push('rollback della riconciliazione servizio completato')
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error)
    reasons.push(`rollback della riconciliazione servizio non verificato: ${detail}`)
  }
}

/**
 * Reconciles the journal of a terminated process. If the target is already active it restarts/verifies and adopts it; if it is
 * unhealthy it goes back to the previous one, deletes the no-longer-active target and allows the same invocation to
 * download it again. A target foreign to the journal fails closed, without removing any release.
 */
function recoverInterruptedUpdate(
  transaction: UpdateTransaction,
  probe: UpdateProbe,
  serviceUp: boolean,
  channel: ReleaseChannel,
  reasons: string[],
): UpdateResult | null {
  const currentTarget = probe.readCurrentTarget()
  if (currentTarget === transaction.targetPath) {
    reasons.push(`transazione interrotta rilevata con ${transaction.targetVersion} già attiva`)
    try {
      if (serviceUp) {
        probe.prepareService?.(transaction.targetPath)
        probe.migrateGuardrails(transaction.targetPath)
        reasons.push(`guardrail riconciliati dalla release ${transaction.targetVersion}`)
        probe.restart()
      }
      if (probe.healthCheck(transaction.targetVersion)) {
        clearRecoveredTransaction(transaction, probe, reasons)
        probe.commitService?.()
        reasons.push(`release ${transaction.targetVersion} riconciliata e verificata`)
        return makeResult({
          outcome: 'up-to-date',
          channel,
          fromVersion: transaction.targetVersion,
          toVersion: null,
          verified: true,
          reason: `versione ${transaction.targetVersion} già attiva e riconciliata dopo un'interruzione`,
          reasons,
        })
      }
      throw new AutomatorError(ErrorCodes.Update.failed, `release ${transaction.targetVersion} attiva ma non sana`, 1)
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error)
      reasons.push(`release ${transaction.targetVersion} non riconciliata (${detail}): avvio rollback di recovery`)
      try {
        if (!rollbackTransaction(transaction, probe, serviceUp, reasons)) {
          // First bootstrap: no previous target. Before removing `current` and the bytes we require the transaction's
          // persistent marker; a foreign target is never deleted.
          if (
            transaction.targetOwnership !== 'promoted' ||
            !probe.releaseOwnedBy(transaction.targetPath, transaction.transactionId)
          ) {
            throw new AutomatorError(ErrorCodes.Update.failed, 'ownership del target bootstrap non verificabile', 1)
          }
          probe.deactivate(transaction.targetPath)
          probe.rollbackService?.()
          if (probe.readCurrentTarget() !== null) {
            throw new AutomatorError(ErrorCodes.Update.failed, 'rimozione di current bootstrap non verificabile', 1)
          }
          cleanupOwnedTarget(transaction, probe, reasons)
          clearRecoveredTransaction(transaction, probe, reasons)
          probe.commitService?.()
          reasons.push(`bootstrap malsano ${transaction.targetVersion} ripulito; retry consentito`)
          return null
        }
        return null
      } catch (rollbackError) {
        const rollbackDetail = rollbackError instanceof Error ? rollbackError.message : String(rollbackError)
        reasons.push(`recovery non verificata: ${rollbackDetail}`)
        return makeResult({
          outcome: 'failed',
          channel,
          fromVersion: transaction.targetVersion,
          toVersion: transaction.targetVersion,
          verified: true,
          activated: true,
          reason: `transazione interrotta per ${transaction.targetVersion} non riconciliabile`,
          reasons,
        })
      }
    }
  }

  if (currentTarget === transaction.previousTarget) {
    // Crash before the switch or rollback already completed: the target is not active, but it is deleted only if the
    // marker proves this transaction promoted it. A pre-existing path stays intact.
    try {
      if (serviceUp && currentTarget !== null) {
        probe.prepareService?.(currentTarget)
        probe.migrateGuardrails(currentTarget)
        reasons.push(`guardrail della release precedente riconciliati (${currentTarget})`)
        probe.restart()
        reasons.push('servizio riavviato sulla release precedente durante recovery')
      }
      if (currentTarget !== null && !probe.healthCheck(versionFromTarget(currentTarget))) {
        throw new AutomatorError(ErrorCodes.Update.failed, 'release precedente non sana dopo recovery del rollback', 1)
      }
      if (currentTarget === null && serviceUp) probe.rollbackService?.()
      cleanupOwnedTarget(transaction, probe, reasons)
      clearRecoveredTransaction(transaction, probe, reasons)
      probe.commitService?.()
      reasons.push(`transazione interrotta ripulita; current è ancora ${currentTarget ?? 'assente'}`)
      return null
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error)
      reasons.push(`guardrail della release precedente non riconciliabili: ${detail}`)
      return makeResult({
        outcome: 'failed', channel, fromVersion: currentTarget ? versionFromTarget(currentTarget) : null,
        toVersion: transaction.targetVersion,
        reason: 'transazione interrotta con rollback guardrail non verificato', reasons,
      })
    }
  }

  reasons.push(`current punta a un target estraneo alla transazione interrotta (${currentTarget ?? 'assente'})`)
  return makeResult({
    outcome: 'failed',
    channel,
    fromVersion: currentTarget ? versionFromTarget(currentTarget) : null,
    toVersion: transaction.targetVersion,
    reason: 'transazione interrotta in conflitto con la release attiva: nessun file rimosso',
    reasons,
  })
}

/** What to do after a recovery update: the service stays on the previous release until it is reconciled. */
export const SERVICE_RECONCILIATION_HINT =
  'servizio non riconciliato: eseguire ora `automator update` con la nuova versione per migrare i guardrail e riavviare il daemon'

/** The recovery of an interrupted transaction stops before looking for a newer release: it must be repeated. */
export const RECOVERY_REPEAT_HINT =
  'transazione interrotta riconciliata: ripetere lo stesso comando per applicare una release più recente'

/** The outcomes in which there really is an active release to reconcile with the service (updated or already active). */
const RECONCILABLE_OUTCOMES: readonly UpdateOutcome[] = ['updated', 'up-to-date']

/**
 * In recovery the result must say what to do NEXT, but only when it is true: on a failed, incompatible
 * or restored outcome there is no new version to reconcile and the hint would mislead the reader.
 */
export function runUpdate(input: RunUpdateInput, probe: UpdateProbe): UpdateResult {
  const result = executeUpdate(input, probe)
  if (input.skipServicePreflight !== true || !RECONCILABLE_OUTCOMES.includes(result.outcome)) return result
  return UpdateResultSchema.parse({...result, reasons: [...result.reasons, SERVICE_RECONCILIATION_HINT]})
}

function executeUpdate(input: RunUpdateInput, probe: UpdateProbe): UpdateResult {
  const {installRoot, channel} = input
  const reasons: string[] = []
  // Explicit recovery: no service gate is queried and no mutation touches it (CYAU-156).
  const skipService = input.skipServicePreflight === true
  if (skipService) {
    reasons.push('controlli del servizio saltati su richiesta esplicita: aggiornati soltanto i byte gestiti')
  }
  // A pin is validated using only reads even before acquiring the local lock: an incompatible,
  // malformed or unverifiable target must leave no mutation on the filesystem/service.
  let pinnedSelection: Selection | null = null
  if (input.targetVersion != null) {
    let currentBeforeMutation: string | null = null
    let manifestBeforeMutation: ReleaseManifest
    try {
      if (!skipService) probe.preflightService?.()
      currentBeforeMutation = probe.currentVersion()
      manifestBeforeMutation = probe.fetchManifest(channel)
    } catch (error) {
      const detail = redactSecrets(error instanceof Error ? error.message : String(error))
      const reason = `preflight del pin fallito: ${detail}`
      return makeResult({
        outcome: 'failed',
        channel,
        fromVersion: currentBeforeMutation,
        toVersion: input.targetVersion,
        reason,
        reasons: [reason],
      })
    }
    pinnedSelection = selectPinnedRelease(manifestBeforeMutation, {
      channel,
      currentVersion: currentBeforeMutation,
      targetVersion: input.targetVersion,
      serverVersion: input.serverVersion,
    })
    const pinReasons = [
      pinnedSelection.reason,
      ...pinnedSelection.skipped.map((skipped) => `scartata ${skipped.version}: ${skipped.reason}`),
    ]
    if (pinnedSelection.decision === 'none') {
      return makeResult({
        outcome: 'failed',
        channel,
        fromVersion: currentBeforeMutation,
        toVersion: input.targetVersion,
        reason: pinnedSelection.reason,
        reasons: pinReasons,
      })
    }
    if (pinnedSelection.decision === 'incompatible') {
      return makeResult({
        outcome: 'incompatible',
        channel,
        fromVersion: currentBeforeMutation,
        toVersion: null,
        reason: pinnedSelection.reason,
        reasons: pinReasons,
      })
    }
  }

  let lockToken: string | null
  try {
    lockToken = probe.acquireLock()
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error)
    return makeResult({outcome: 'failed', channel, fromVersion: null, toVersion: input.targetVersion ?? null, reason: `lock update non acquisibile: ${detail}`, reasons: [detail]})
  }
  if (lockToken === null) {
    return makeResult({
      outcome: 'failed',
      channel,
      fromVersion: null,
      toVersion: input.targetVersion ?? null,
      reason: 'un altro aggiornamento è già in corso',
      reasons: ['lock esclusivo dell’updater già occupato'],
    })
  }

  try {
    const serviceUp = skipService ? false : probe.serviceInstalled()
    const pending = probe.readTransaction()
    if (!skipService && pending === null && probe.recoverService?.()) {
      const current = probe.currentVersion()
      const reason = 'recovery del servizio legacy completato; ripetere update per applicare una nuova release'
      reasons.push(reason)
      return makeResult({outcome: 'failed', channel, fromVersion: current, toVersion: input.targetVersion ?? null, reason, reasons})
    }
    const reaped = probe.reapStaging()
    if (reaped > 0) reasons.push(`${reaped} staging abbandonata/e ripulita/e sotto lock`)
    if (pending !== null) {
      const recovered = recoverInterruptedUpdate(pending, probe, serviceUp, channel, reasons)
      // Adopting the interrupted transaction closes this invocation BEFORE looking at the manifest: without saying so,
      // a recovery would look already on the latest release. Repeating the same command the update continues.
      if (recovered !== null && skipService && recovered.outcome === 'up-to-date') {
        return UpdateResultSchema.parse({...recovered, reasons: [...recovered.reasons, RECOVERY_REPEAT_HINT]})
      }
      if (recovered !== null) return recovered
    }

    // The version used by no-op, plan and result is re-read under lock after the possible recovery: we do not use
    // pinnedSelection.currentVersion, which is only the diagnostic snapshot of the read-only preflight.
    const current = probe.currentVersion()
    const manifest = pinnedSelection === null ? probe.fetchManifest(channel) : null

    // Target resolution: explicit pin (targetVersion) or automatic selection.
    let target: ReleaseEntry
    if (input.targetVersion != null) {
      const selection = pinnedSelection!
      reasons.push(selection.reason)
      for (const skipped of selection.skipped) reasons.push(`scartata ${skipped.version}: ${skipped.reason}`)
      target = selection.target!
    } else {
      const sel = selectTargetRelease(manifest!, {
        channel,
        currentVersion: current,
        serverVersion: input.serverVersion,
        allowDowngrade: input.allowDowngrade,
      })
      reasons.push(sel.reason)
      for (const s of sel.skipped) reasons.push(`scartata ${s.version}: ${s.reason}`)
      if (sel.decision === 'up-to-date') {
        if (serviceUp) {
          try {
            const activeTarget = probe.readCurrentTarget()
            if (activeTarget === null || current === null) {
              throw new AutomatorError(ErrorCodes.Update.failed, 'target/versione current assente', 1)
            }
            probe.prepareService?.(activeTarget)
            probe.migrateGuardrails(activeTarget)
            reasons.push(`guardrail riconciliati dalla release attiva (${activeTarget})`)
            probe.restart()
            reasons.push(`servizio riavviato sulla release attiva (${activeTarget})`)
            if (!probe.healthCheck(current)) {
              throw new AutomatorError(ErrorCodes.Update.failed, `health check della release ${current} attiva fallito`, 1)
            }
            probe.commitService?.()
            reasons.push(`release ${current} attiva e daemon verificati`)
          } catch (error) {
            const detail = error instanceof Error ? error.message : String(error)
            rollbackServiceReconciliation(probe, reasons)
            const reason = `versione ${current ?? 'corrente'} attiva ma riconciliazione fallita: ${detail}`
            reasons.push(reason)
            return makeResult({outcome: 'failed', channel, fromVersion: current, toVersion: current, reason, reasons})
          }
        }
        return makeResult({outcome: 'up-to-date', channel, fromVersion: current, toVersion: null, reason: sel.reason, reasons})
      }
      if (sel.decision === 'none') {
        return makeResult({outcome: 'failed', channel, fromVersion: current, toVersion: null, reason: sel.reason, reasons})
      }
      if (sel.decision === 'incompatible') {
        return makeResult({outcome: 'incompatible', channel, fromVersion: current, toVersion: null, reason: sel.reason, reasons})
      }
      target = sel.target! // decision === 'update'
    }

    // Reinstalling the ACTIVE release would risk extracting over the bytes needed for the rollback. It is always a
    // no-op on the bytes, even with an explicit pin. With a service already installed it does however reconcile the guardrails from the
    // active release: it idempotently completes an upgrade performed by a previous updater.
    if (current !== null && target.version === current) {
      try {
        const activeTarget = probe.readCurrentTarget()
        if (serviceUp) {
          if (activeTarget === null) throw new AutomatorError(ErrorCodes.Update.failed, 'target current assente', 1)
          probe.prepareService?.(activeTarget)
          probe.migrateGuardrails(activeTarget)
          reasons.push(`guardrail riconciliati dalla release attiva (${activeTarget})`)
          probe.restart()
          reasons.push(`servizio riavviato sulla release attiva (${activeTarget})`)
        }
        if (!probe.healthCheck(target.version)) {
          throw new AutomatorError(ErrorCodes.Update.failed, `health/version della release ${target.version} non verificato`, 1)
        }
        probe.commitService?.()
      } catch (error) {
        const detail = error instanceof Error ? error.message : String(error)
        if (serviceUp) rollbackServiceReconciliation(probe, reasons)
        const reason = `versione ${target.version} attiva ma riconciliazione fallita: ${detail}`
        reasons.push(reason)
        return makeResult({outcome: 'failed', channel, fromVersion: current, toVersion: target.version, reason, reasons})
      }
      const reason = `versione ${target.version} già attiva: reinstallazione non necessaria`
      reasons.push(reason)
      return makeResult({outcome: 'up-to-date', channel, fromVersion: current, toVersion: null, verified: true, reason, reasons})
    }

    const plan = planUpdate({installRoot, channel, target, fromVersion: current})
    const previous = probe.readCurrentTarget()
    // On the FIRST update of a new machine the service is not installed yet (the flow is update → install
    // --managed): there is no daemon to restart. Restarting a non-existent service would fail
    // (systemctl non-zero exit) and would make the first update fail EVEN THOUGH `current` was correctly
    // activated → the restart is skipped and only the binary's standalone health check is relied upon.
    // A final release already retained is never overwritten: we reuse it only if its entrypoint and the
    // directory keep the same identity up to restart+health included. The switch is journaled too.
    if (probe.releaseExists(plan.releaseDir)) {
      const reused: UpdateTransaction = {
        version: 1,
        transactionId: randomUUID(),
        targetVersion: target.version,
        targetPath: plan.releaseDir,
        previousTarget: previous,
        targetOwnership: 'preexisting',
        stagingRoot: null,
      }
      probe.writeTransaction(reused)
      let retainedVerified = false
      try {
        if (!probe.activateRetained(plan.releaseDir, target.version, () => {
          if (probe.readCurrentTarget() !== plan.releaseDir) return false
          if (serviceUp) {
            probe.prepareService?.(plan.releaseDir)
            probe.migrateGuardrails(plan.releaseDir)
            reasons.push(`guardrail migrati dalla release ${target.version}`)
            probe.restart()
          }
          return probe.healthCheck(target.version)
        })) {
          throw new AutomatorError(
            ErrorCodes.Update.failed,
            'release conservata sostituita o non verificabile durante preflight/attivazione/health',
            1,
          )
        }
        retainedVerified = true
        probe.clearTransaction()
        probe.commitService?.()
        reasons.push(`release ${target.version} già conservata, verificata e riattivata senza sovrascriverla`)
        return makeResult({
          outcome: 'updated', channel, fromVersion: current, toVersion: target.version, verified: true,
          activated: true, reason: `attivata la release ${target.version} già installata`, reasons,
        })
      } catch (error) {
        reasons.push(`attivazione della release conservata fallita: ${error instanceof Error ? error.message : String(error)}`)
        let retainedActive = probe.readCurrentTarget() === plan.releaseDir
        if (previous !== null && retainedActive) {
          try {
            rollbackTransaction(reused, probe, serviceUp, reasons)
            return makeResult({
              outcome: 'rolled-back', channel, fromVersion: current, toVersion: target.version, verified: retainedVerified,
              activated: true, rolledBack: true,
              reason: `attivazione di ${target.version} fallita: ripristinata la versione precedente`, reasons,
            })
          } catch (rollbackError) {
            reasons.push(`rollback non verificato: ${rollbackError instanceof Error ? rollbackError.message : String(rollbackError)}`)
          }
        } else if (previous === null && retainedActive) {
          try {
            probe.deactivate(plan.releaseDir)
            probe.rollbackService?.()
            if (probe.readCurrentTarget() !== null) {
              throw new AutomatorError(ErrorCodes.Update.failed, 'rimozione di current bootstrap non verificabile', 1)
            }
            retainedActive = false
            probe.clearTransaction()
            probe.commitService?.()
          } catch (deactivateError) {
            reasons.push(`cleanup bootstrap non verificato: ${deactivateError instanceof Error ? deactivateError.message : String(deactivateError)}`)
          }
        } else {
          try {
            probe.clearTransaction()
          } catch (clearError) {
            reasons.push(`journal del riuso non eliminato: ${clearError instanceof Error ? clearError.message : String(clearError)}`)
          }
        }
        return makeResult({
          outcome: 'failed', channel, fromVersion: current, toVersion: target.version, verified: retainedVerified,
          activated: retainedActive,
          reason: `attivazione della release conservata ${target.version} fallita`, reasons,
        })
      }
    }

    let stagingRoot: string | null = null
    let verified = false
    let transactionWritten = false
    let promoted = false
    let transaction: UpdateTransaction | null = null
    try {
      stagingRoot = probe.createStaging(plan.stagingPrefix)
      const archive = path.join(stagingRoot, 'artifact.tgz')
      const stagedRelease = path.join(stagingRoot, 'release')
      reasons.push(`staging univoca creata: ${stagingRoot}`)

      probe.download(plan.url, archive)
      reasons.push(`scaricato ${plan.url}`)
      const actual = probe.checksum(archive)
      if (!checksumMatches(plan.sha256, actual)) {
        reasons.push('checksum NON corrispondente: artifact non estratto né attivato')
        return makeResult({
          outcome: 'failed',
          channel,
          fromVersion: current,
          toVersion: target.version,
          verified: false,
          reason: `checksum dell'artifact ${target.version} non corrispondente: versione non verificata, aggiornamento annullato`,
          reasons,
        })
      }
      verified = true
      reasons.push('checksum verificato prima dell’estrazione')

      probe.extract(archive, stagedRelease)
      reasons.push(`estratta nella staging nuova ${stagedRelease}`)
      if (!probe.preflight(stagedRelease, target.version)) {
        throw new AutomatorError(ErrorCodes.Update.failed, 'health check pre-switch del candidato non superato', 1)
      }
      reasons.push('health check pre-switch superato')
      transaction = {
        version: 1,
        transactionId: randomUUID(),
        targetVersion: target.version,
        targetPath: plan.releaseDir,
        previousTarget: previous,
        targetOwnership: 'promoted',
        stagingRoot,
      }
      probe.markReleaseOwnership(stagedRelease, transaction.transactionId, target.version)
      probe.writeTransaction(transaction)
      transactionWritten = true
      reasons.push('journal durabile scritto prima della promozione')
      probe.promote(stagedRelease, plan.releaseDir)
      promoted = true
      reasons.push(`release promossa atomicamente in ${plan.releaseDir}`)
    } catch (err) {
      const detail = err instanceof Error ? err.message : String(err)
      reasons.push(`preparazione della release fallita: ${detail}`)
      if (transactionWritten && !promoted && transaction !== null) {
        try {
          if (probe.releaseOwnedBy(transaction.targetPath, transaction.transactionId)) {
            promoted = true
            reasons.push('promozione completata prima dell’errore: journal conservato per il recovery')
          } else {
            probe.clearTransaction()
          }
        } catch (clearError) {
          const clearDetail = clearError instanceof Error ? clearError.message : String(clearError)
          reasons.push(`journal di preparazione non eliminato: ${clearDetail}`)
        }
      }
      return makeResult({
        outcome: 'failed',
        channel,
        fromVersion: current,
        toVersion: target.version,
        verified,
        reason: `preparazione atomica di ${target.version} fallita: release attiva invariata`,
        reasons,
      })
    } finally {
      if (stagingRoot !== null) probe.cleanup(stagingRoot)
    }

    let switched = false
    try {
      probe.activate(plan.releaseDir)
      switched = probe.readCurrentTarget() === plan.releaseDir
      if (!switched) throw new AutomatorError(ErrorCodes.Update.failed, 'switch di current non verificabile', 1)
      reasons.push(`symlink current → ${plan.releaseDir}`)
      if (serviceUp) {
        probe.prepareService?.(plan.releaseDir)
        probe.migrateGuardrails(plan.releaseDir)
        reasons.push(`guardrail migrati e verificati dalla release ${target.version}`)
        probe.restart()
        reasons.push('servizio riavviato')
      } else {
        reasons.push(
          skipService
            ? 'restart saltato: il servizio non è stato interrogato né mutato'
            : 'servizio non ancora installato: restart saltato (primo bootstrap)',
        )
      }
      if (probe.healthCheck(target.version)) {
        clearRecoveredTransaction(transaction!, probe, reasons)
        probe.commitService?.()
        reasons.push('health check superato')
        return makeResult({
          outcome: 'updated',
          channel,
          fromVersion: current,
          toVersion: target.version,
          verified: true,
          activated: true,
          reason: `aggiornato a ${target.version} sul canale ${channel}`,
          reasons,
        })
      }
      throw new AutomatorError(ErrorCodes.Update.rolledBack, 'health check post-update non superato', 3)
    } catch (err) {
      const detail = err instanceof Error ? err.message : String(err)
      reasons.push(`aggiornamento fallito: ${detail}`)
      // Rollback: the symlink goes back to the previous release and the service restarts on it. The STATE is never
      // touched → no run lost. Without a previous release (first installation) there is nothing to go back to.
      if (previous != null) {
        try {
          rollbackTransaction(transaction!, probe, serviceUp, reasons)
          return makeResult({
            outcome: 'rolled-back',
            channel,
            fromVersion: current,
            toVersion: target.version,
            verified: true,
            activated: switched,
            rolledBack: true,
            reason: `aggiornamento a ${target.version} fallito: ripristinata la versione precedente (nessuna run persa)`,
            reasons,
          })
        } catch (rollbackError) {
          const rollbackDetail = rollbackError instanceof Error ? rollbackError.message : String(rollbackError)
          reasons.push(`rollback non verificato: ${rollbackDetail}`)
          return makeResult({
            outcome: 'failed',
            channel,
            fromVersion: current,
            toVersion: target.version,
            verified: true,
            activated: switched,
            reason: `aggiornamento a ${target.version} fallito e rollback non verificato`,
            reasons,
          })
        }
      }
      if (
        transaction !== null &&
        switched &&
        transaction.targetOwnership === 'promoted' &&
        probe.releaseOwnedBy(transaction.targetPath, transaction.transactionId)
      ) {
        try {
          probe.deactivate(transaction.targetPath)
          probe.rollbackService?.()
          if (probe.readCurrentTarget() !== null) {
            throw new AutomatorError(ErrorCodes.Update.failed, 'rimozione di current bootstrap non verificabile', 1)
          }
          cleanupOwnedTarget(transaction, probe, reasons)
          clearRecoveredTransaction(transaction, probe, reasons)
          probe.commitService?.()
          reasons.push('prima installazione malsana ripulita; un retry può riscaricare la release')
        } catch (cleanupError) {
          reasons.push(`cleanup bootstrap non verificato: ${cleanupError instanceof Error ? cleanupError.message : String(cleanupError)}`)
        }
      }
      reasons.push('nessuna release precedente a cui tornare')
      return makeResult({
        outcome: 'failed',
        channel,
        fromVersion: current,
        toVersion: target.version,
        verified,
        activated: switched,
        reason: `installazione di ${target.version} fallita e nessuna versione precedente da ripristinare`,
        reasons,
      })
    }
  } finally {
    try {
      probe.releaseLock(lockToken)
    } catch {
      // The work is already done; the token makes the release idempotent and the stale lock is recoverable.
    }
  }
}

// ── Real probe (curl/tar/symlink behind injectable CommandRunner + UpdateFs) ────────────────────────────

export interface CommandOutcome {
  status: number | null
  stdout: string
  stderr: string
}

/** Runs an external command (injectable: default `spawnSync`, argv array = no shell → no injection). */
export type CommandRunner = (cmd: string, args: string[], cwd?: string) => CommandOutcome

export function defaultCommandRunner(cmd: string, args: string[], cwd?: string): CommandOutcome {
  const res = spawnSync(cmd, args, {cwd, encoding: 'utf8'})
  // spawnSync does NOT throw on a missing binary: the error is in `res.error` with status null → propagate it in the detail.
  const stderr = res.error ? `${res.error.message}\n${res.stderr ?? ''}`.trim() : res.stderr ?? ''
  return {status: res.status, stdout: res.stdout ?? '', stderr}
}

function boundedHelperRunner(cmd: string, args: string[], timeout: number): CommandOutcome {
  const res = spawnSync(cmd, args, {encoding: 'utf8', timeout, maxBuffer: 16 * 1024})
  const stderr = res.error ? `${res.error.message}\n${res.stderr ?? ''}`.trim() : res.stderr ?? ''
  return {status: res.status, stdout: res.stdout ?? '', stderr}
}

/** Filesystem operations of the update (injectable: mocked in tests, `node:fs` in prod). */
export interface UpdateFs {
  /** Atomic POSIX claim; recovers a dead owner and returns null if the lock belongs to a live process. */
  acquireLock(lockPath: string): string | null
  /** Removes the claim only if the token matches the symlink target. */
  releaseLock(lockPath: string, token: string): void
  /** Target of a symlink, or null if missing/not a symlink. */
  readlink(linkPath: string): string | null
  /** Deletes a symlink only if its target matches; returns false on mismatch/absence. */
  unlinkSymlinkIfTarget(linkPath: string, expectedTarget: string): boolean
  /** ATOMICALLY creates/replaces a symlink (temporary symlink + rename): the swap has no partial window. */
  symlinkReplace(target: string, linkPath: string): void
  mkdirp(dir: string): void
  /** Creates a unique directory by appending random characters to the prefix. */
  mkdtemp(prefix: string): string
  /** Checks existence without assumptions about the path type. */
  exists(target: string): boolean
  /** true only for a real directory at the path itself (does not follow a final symlink). */
  isDirectory(target: string): boolean
  /** Canonical path, or null if the target does not exist/is not resolvable. */
  realpath(target: string): string | null
  /** Keeps a real directory open and passes its dev+inode kernel identity to the callback. */
  withDirectoryIdentity<T>(target: string, run: (identity: string) => T): T | null
  /** Verifies, without following the final symlink, that the path still points to the same directory. */
  sameDirectory(target: string, identity: string): boolean
  /** Keeps a real regular file open and passes its dev+inode kernel identity to the callback. */
  withFileIdentity<T>(target: string, run: (identity: string) => T): T | null
  /** Verifies, without following the final symlink, that the path still points to the same regular file. */
  sameFile(target: string, identity: string): boolean
  /** Lists the direct names of a directory; missing directory → empty list. */
  list(directory: string): string[]
  /** Recursive fsync of the release bytes and directories before the promotion. */
  syncTree(root: string): void
  /** Atomic rename on the same filesystem followed by fsync of the involved directories. */
  rename(source: string, destination: string): void
  /** Atomic no-replace rename: false if the destination exists, without modifying it. */
  renameNoReplace(source: string, destination: string): boolean
  readFile(file: string): Buffer
  /** Atomic write (temp+rename) with fsync of content and parent directory. */
  writeFileAtomic(file: string, content: string): void
  /** Removes recursively and fsyncs the parent directory. */
  remove(target: string): void
}

function fsyncPath(target: string): void {
  const descriptor = fs.openSync(target, 'r')
  try {
    fs.fsyncSync(descriptor)
  } finally {
    fs.closeSync(descriptor)
  }
}

function fsyncDirectory(directory: string): void {
  fsyncPath(directory)
}

function defaultProcessIsAlive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'EPERM'
  }
}

const NATIVE_RENAME_NOREPLACE_HELPER = `
import ctypes, errno, os, platform, sys
libc = ctypes.CDLL(None, use_errno=True)
source, destination = os.fsencode(sys.argv[1]), os.fsencode(sys.argv[2])
if sys.platform.startswith('linux'):
    try:
        rename = libc.renameat2
        rename.argtypes = [ctypes.c_int, ctypes.c_char_p, ctypes.c_int, ctypes.c_char_p, ctypes.c_uint]
        result = rename(-100, source, -100, destination, 1)
    except AttributeError:
        syscall_number = {'x86_64': 316, 'aarch64': 276}.get(platform.machine().lower())
        if syscall_number is None:
            raise SystemExit(2)
        result = libc.syscall(
            ctypes.c_long(syscall_number), ctypes.c_int(-100), ctypes.c_char_p(source),
            ctypes.c_int(-100), ctypes.c_char_p(destination), ctypes.c_uint(1),
        )
else:
    raise SystemExit(2)
if result == 0:
    print('renamed')
elif ctypes.get_errno() in (errno.EEXIST, errno.ENOTEMPTY):
    print('exists')
else:
    value = ctypes.get_errno()
    raise OSError(value, os.strerror(value))
`.trim()

export interface ProcessIdentityRuntime {
  platform?: NodeJS.Platform
  readFile?: (file: string) => string
  run?: CommandRunner
}

/** Precise kernel start identity; if the platform offers no reliable probe it fails closed. */
export function processStartIdentity(pid: number, runtime: ProcessIdentityRuntime = {}): string | null {
  if (!Number.isSafeInteger(pid) || pid <= 0) return null
  const platform = runtime.platform ?? process.platform
  if (platform === 'linux') {
    try {
      const stat = (runtime.readFile ?? ((file) => fs.readFileSync(file, 'utf8')))(`/proc/${pid}/stat`)
      const close = stat.lastIndexOf(')')
      if (close < 0) return null
      const startTicks = stat.slice(close + 2).trim().split(/\s+/)[19]
      return startTicks && /^\d+$/.test(startTicks) ? `linux:${startTicks}` : null
    } catch {
      return null
    }
  }
  return null
}

function processIdentityMarker(identity: string): string {
  return createHash('sha256').update(identity).digest('hex')
}

export interface UpdateFsRuntime {
  now?: () => number
  processIsAlive?: (pid: number) => boolean
  processIdentity?: (pid: number) => string | null
}

export function defaultUpdateFs(runtime: UpdateFsRuntime = {}): UpdateFs {
  const now = runtime.now ?? Date.now
  const isAlive = runtime.processIsAlive ?? defaultProcessIsAlive
  const identify = runtime.processIdentity ?? processStartIdentity
  const ownerIsCurrent = (token: string): boolean => {
    const fields = token.split(':')
    const versioned = fields[0] === 'v2' && fields.length === 5
    const pidText = versioned ? fields[1] : fields[0]
    const pid = Number.parseInt(pidText, 10)
    if (!Number.isSafeInteger(pid) || pid <= 0 || !isAlive(pid)) return false
    // Legacy tokens do not contain the start identity: a live PID cannot be safely distinguished from a
    // real owner, so they stay fail-closed and require manual recovery. v2 tokens instead compare
    // the start identity and recover a recycled PID without ever expiring a process that is really still alive.
    if (!versioned) return true
    if (fields[2] === 'unknown') return true
    const currentIdentity = identify(pid)
    return currentIdentity === null || processIdentityMarker(currentIdentity) === fields[2]
  }
  return {
    acquireLock(lockPath) {
      fs.mkdirSync(path.dirname(lockPath), {recursive: true})
      const identity = identify(process.pid)
      const marker = identity === null ? 'unknown' : processIdentityMarker(identity)
      const token = `v2:${process.pid}:${marker}:${now()}:${randomUUID()}`
      const tryClaim = (claimPath: string, claimToken: string): boolean => {
        try {
          fs.symlinkSync(claimToken, claimPath)
          fsyncDirectory(path.dirname(claimPath))
          return true
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code === 'EEXIST') return false
          throw error
        }
      }
      if (tryClaim(lockPath, token)) return token

      let existing: string
      try {
        existing = fs.readlinkSync(lockPath)
      } catch {
        return tryClaim(lockPath, token) ? token : null
      }
      if (ownerIsCurrent(existing)) return null

      // Serializes the stale removal: without this second claim, two reclaimers could both observe the
      // old owner and the slower one would end up removing the lock just acquired by the faster one. The reaper
      // is not recovered automatically: a crash in the few recovery syscalls fails closed and requires
      // the manual removal of `.update.lock.reaper`, without ever allowing two concurrent updaters.
      const reaperPath = `${lockPath}.reaper`
      const reaperToken = `${process.pid}:${now()}:${randomUUID()}`
      if (!tryClaim(reaperPath, reaperToken)) return null
      try {
        let observed: string | null
        try {
          observed = fs.readlinkSync(lockPath)
        } catch {
          observed = null
        }
        if (observed !== null) {
          if (ownerIsCurrent(observed)) return null
          fs.unlinkSync(lockPath)
          fsyncDirectory(path.dirname(lockPath))
        }
        return tryClaim(lockPath, token) ? token : null
      } finally {
        try {
          if (fs.readlinkSync(reaperPath) === reaperToken) {
            fs.unlinkSync(reaperPath)
            fsyncDirectory(path.dirname(reaperPath))
          }
        } catch {
          // Fail closed: a reaper that cannot be deleted prevents concurrent recoveries, not mutual exclusion.
        }
      }
    },
    releaseLock(lockPath, token) {
      let owner: string
      try {
        owner = fs.readlinkSync(lockPath)
      } catch {
        return
      }
      if (owner !== token) return
      fs.unlinkSync(lockPath)
      fsyncDirectory(path.dirname(lockPath))
    },
    readlink(linkPath) {
      try {
        return fs.readlinkSync(linkPath)
      } catch {
        return null
      }
    },
    unlinkSymlinkIfTarget(linkPath, expectedTarget) {
      let observed: string
      try {
        observed = fs.readlinkSync(linkPath)
      } catch {
        return false
      }
      if (observed !== expectedTarget) return false
      fs.unlinkSync(linkPath)
      fsyncDirectory(path.dirname(linkPath))
      return true
    },
    symlinkReplace(target, linkPath) {
      // Atomic swap: writes a temporary symlink next to it and renames it over `linkPath` (rename is atomic on
      // POSIX) → never a window in which `current` does not exist. Needed because `symlink` fails if it already exists.
      const tmp = `${linkPath}.tmp-${process.pid}-${randomUUID()}`
      fs.rmSync(tmp, {force: true})
      fs.symlinkSync(target, tmp)
      fsyncDirectory(path.dirname(linkPath))
      fs.renameSync(tmp, linkPath)
      fsyncDirectory(path.dirname(linkPath))
    },
    mkdirp(dir) {
      fs.mkdirSync(dir, {recursive: true})
    },
    mkdtemp(prefix) {
      return fs.mkdtempSync(prefix)
    },
    exists(target) {
      try {
        fs.lstatSync(target)
        return true
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false
        throw error
      }
    },
    isDirectory(target) {
      try {
        return fs.lstatSync(target).isDirectory()
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false
        throw error
      }
    },
    realpath(target) {
      try {
        return fs.realpathSync(target)
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null
        throw error
      }
    },
    withDirectoryIdentity(target, run) {
      const flags = fs.constants.O_RDONLY | fs.constants.O_DIRECTORY | fs.constants.O_NOFOLLOW
      let descriptor: number
      try {
        descriptor = fs.openSync(target, flags)
      } catch (error) {
        const code = (error as NodeJS.ErrnoException).code
        if (code === 'ENOENT' || code === 'ENOTDIR' || code === 'ELOOP') return null
        throw error
      }
      try {
        const stat = fs.fstatSync(descriptor, {bigint: true})
        if (!stat.isDirectory()) return null
        return run(`${stat.dev}:${stat.ino}`)
      } finally {
        fs.closeSync(descriptor)
      }
    },
    sameDirectory(target, identity) {
      try {
        const stat = fs.lstatSync(target, {bigint: true})
        return stat.isDirectory() && `${stat.dev}:${stat.ino}` === identity
      } catch (error) {
        const code = (error as NodeJS.ErrnoException).code
        if (code === 'ENOENT' || code === 'ENOTDIR') return false
        throw error
      }
    },
    withFileIdentity(target, run) {
      const flags = fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW
      let descriptor: number
      try {
        descriptor = fs.openSync(target, flags)
      } catch (error) {
        const code = (error as NodeJS.ErrnoException).code
        if (code === 'ENOENT' || code === 'ENOTDIR' || code === 'ELOOP') return null
        throw error
      }
      try {
        const stat = fs.fstatSync(descriptor, {bigint: true})
        if (!stat.isFile()) return null
        return run(`${stat.dev}:${stat.ino}`)
      } finally {
        fs.closeSync(descriptor)
      }
    },
    sameFile(target, identity) {
      try {
        const stat = fs.lstatSync(target, {bigint: true})
        return stat.isFile() && `${stat.dev}:${stat.ino}` === identity
      } catch (error) {
        const code = (error as NodeJS.ErrnoException).code
        if (code === 'ENOENT' || code === 'ENOTDIR') return false
        throw error
      }
    },
    list(directory) {
      try {
        return fs.readdirSync(directory)
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') return []
        throw error
      }
    },
    syncTree(root) {
      const sync = (target: string): void => {
        const stat = fs.lstatSync(target)
        if (stat.isSymbolicLink()) return
        if (stat.isDirectory()) {
          for (const child of fs.readdirSync(target)) sync(path.join(target, child))
        }
        fsyncPath(target)
      }
      sync(root)
    },
    rename(source, destination) {
      fs.renameSync(source, destination)
      fsyncDirectory(path.dirname(source))
      if (path.dirname(destination) !== path.dirname(source)) fsyncDirectory(path.dirname(destination))
    },
    renameNoReplace(source, destination) {
      const outcome = boundedHelperRunner(
        'python3',
        ['-c', NATIVE_RENAME_NOREPLACE_HELPER, source, destination],
        5_000,
      )
      const result = outcome.stdout.trim()
      if (outcome.status !== 0 || (result !== 'renamed' && result !== 'exists')) {
        const detail = outcome.stderr.trim() || `helper no-replace non disponibile (exit ${String(outcome.status)})`
        throw new Error(`rename atomico no-replace fallito: ${detail}`)
      }
      if (result === 'exists') return false
      fsyncDirectory(path.dirname(source))
      if (path.dirname(destination) !== path.dirname(source)) fsyncDirectory(path.dirname(destination))
      return true
    },
    readFile(file) {
      return fs.readFileSync(file)
    },
    writeFileAtomic(file, content) {
      fs.mkdirSync(path.dirname(file), {recursive: true})
      const tmp = `${file}.tmp-${process.pid}-${randomUUID()}`
      let descriptor: number | null = null
      try {
        descriptor = fs.openSync(tmp, 'wx', 0o600)
        fs.writeFileSync(descriptor, content, 'utf8')
        fs.fsyncSync(descriptor)
        fs.closeSync(descriptor)
        descriptor = null
        fs.renameSync(tmp, file)
        fsyncDirectory(path.dirname(file))
      } finally {
        if (descriptor !== null) fs.closeSync(descriptor)
        fs.rmSync(tmp, {force: true})
      }
    },
    remove(target) {
      let existed = false
      try {
        fs.lstatSync(target)
        existed = true
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
      }
      fs.rmSync(target, {force: true, recursive: true})
      if (existed) fsyncDirectory(path.dirname(target))
    },
  }
}

export interface DefaultProbeOptions {
  installRoot: string
  /** Custom base `<base>/<channel>.json`, or the GitHub API of a release tag with append-only generations. */
  manifestBaseUrl: string
  /** systemctl command to restart the user service. */
  restartCommand: {cmd: string; args: string[]}
  /** Injectable managed restart: it can reload and then restart the unit after the guardrail migration. */
  restartService?: () => void
  /** Read-only service preflight before any network access. */
  preflightService?: () => void
  /** Separate rollback of the legacy unit when `current` has no previous release. */
  rollbackService?: () => void
  /** Commit of the service journal after the full verification of the update transaction. */
  commitService?: () => void
  /** Lazy command for the health check: it may depend on the unit's Node resolved by serviceInstalled(). */
  healthCommand: {cmd: string; args: string[]} | (() => {cmd: string; args: string[]})
  /** Standalone command to verify the staged candidate before the switch. */
  candidateHealthCommand: (releaseDir: string) => {cmd: string; args: string[]}
  /** true if the service is already installed (per the service manager): at the first bootstrap it is not → restart skipped. */
  serviceInstalled: () => boolean
  /** Finalizes a restoring service journal left without an update transaction. */
  recoverService?: () => boolean
  /** Prepares the service backup/journal before the guardrail migration. */
  prepareService?: (targetPath: string) => void
  /** Skips the reinstallation from the release when the service rollback restores the legacy snapshot. */
  skipGuardrailMigration?: (releaseDir: string) => boolean
  /** After the restart confirms that the unit, not only the standalone binary, is really running. */
  serviceRunning?: () => boolean
  /** Injectable guardrail installer; default = the real installGuardrails. */
  installGuardrails?: typeof installGuardrails
  /** Resolves the paths persisted by the managed installation; injectable in tests. */
  guardrailPaths?: () => import('./guardrails').GuardrailPaths | undefined
  run?: CommandRunner
  fs?: UpdateFs
}

const VERSION_OUTPUT_PREFIX = '@bussolabs/closeyourit-automator/'
const RELEASE_OWNERSHIP_FILE = '.automator-update-owner.json'

/** Accepts only the exact identity/version emitted by oclif as the first stdout token. */
export function versionOutputMatches(stdout: string, expectedVersion: string): boolean {
  const [identity, ...rest] = stdout.trim().split(/\s+/)
  return rest.length > 0 && identity === `${VERSION_OUTPUT_PREFIX}${expectedVersion}`
}

/**
 * The real probe: private GitHub manifest and artifact through the authenticated `gh` session, custom mirror with
 * `curl`, extraction with `tar --strip-components=1`, swap with atomic symlink, restart/health with the platform
 * commands. A failed external command → `C500-UPDATE-004`
 * (exit 1). It operates ONLY on `installRoot`: it has no method touching state/config/data (structural property).
 */
export function defaultUpdateProbe(opts: DefaultProbeOptions): UpdateProbe {
  const run = opts.run ?? defaultCommandRunner
  const io = opts.fs ?? defaultUpdateFs()
  const currentLink = currentLinkFor(opts.installRoot)
  const lockPath = updateLockFor(opts.installRoot)
  const transactionPath = updateTransactionFor(opts.installRoot)
  const releasesRoot = path.resolve(opts.installRoot, 'releases')
  const ownershipFile = (releaseDir: string): string => path.join(releaseDir, RELEASE_OWNERSHIP_FILE)
  // readlink returns the raw text: legacy links can be relative to the directory of `current`.
  // The whole orchestration instead uses absolute canonical targets, so rollback, guardrails and recovery agree.
  const resolveCurrentTarget = (target: string): string => path.resolve(path.dirname(currentLink), target)
  const canonicalReleasesRoot = (): string | null => {
    if (!io.isDirectory(releasesRoot)) return null
    const realInstallRoot = io.realpath(opts.installRoot)
    const realRoot = io.realpath(releasesRoot)
    if (realInstallRoot === null || realRoot === null) return null
    return path.resolve(realRoot) === path.resolve(realInstallRoot, 'releases') ? realRoot : null
  }
  const confinedRelease = (releaseDir: string): boolean => {
    if (path.dirname(path.resolve(releaseDir)) !== releasesRoot || !io.isDirectory(releaseDir)) return false
    const realRoot = canonicalReleasesRoot()
    const realRelease = io.realpath(releaseDir)
    return realRoot !== null && realRelease !== null && path.dirname(realRelease) === realRoot
  }
  const removeConfinedReleaseChild = (target: string): boolean => {
    if (path.dirname(path.resolve(target)) !== releasesRoot) return false
    const guarded = io.withDirectoryIdentity(releasesRoot, (rootIdentity) => {
      const realRoot = canonicalReleasesRoot()
      if (realRoot === null || !io.sameDirectory(releasesRoot, rootIdentity)) return false
      return io.withDirectoryIdentity(target, (targetIdentity) => {
        const realTarget = io.realpath(target)
        if (
          realTarget === null ||
          path.dirname(realTarget) !== realRoot ||
          !io.sameDirectory(target, targetIdentity) ||
          !io.sameDirectory(releasesRoot, rootIdentity)
        ) return false
        // Never delete the validated pathname directly: a concurrent rename could replace it between
        // the check and rm. First we move it atomically to an unpredictable sibling name, then we delete
        // only if the moved inode still matches the open handle. A replacement is restored/preserved.
        const quarantine = path.join(releasesRoot, `.cleanup-${randomUUID()}`)
        let moved = false
        try {
          moved = io.renameNoReplace(target, quarantine)
        } catch (error) {
          if (!io.sameDirectory(quarantine, targetIdentity)) throw error
          moved = true // rename succeeded, later fsync failed: the identity proves where the target is.
        }
        if (!moved) return false
        if (!io.sameDirectory(quarantine, targetIdentity)) {
          try {
            io.renameNoReplace(quarantine, target)
          } catch {
            // Fail-safe: the replacement stays quarantined and is never deleted.
          }
          return false
        }
        io.remove(quarantine)
        return io.sameDirectory(releasesRoot, rootIdentity)
      }) ?? false
    })
    return guarded ?? false
  }
  const candidatePasses = (releaseDir: string, expectedVersion: string): boolean => {
    const command = opts.candidateHealthCommand(releaseDir)
    const outcome = run(command.cmd, command.args)
    return outcome.status === 0 && versionOutputMatches(outcome.stdout, expectedVersion)
  }

  const fail = (what: string, outcome: CommandOutcome): never => {
    const detail = redactSecrets(outcome.stderr.trim() || outcome.stdout.trim() || `exit ${outcome.status}`)
    throw new AutomatorError(ErrorCodes.Update.failed, `${what} fallito: ${detail}`, 1)
  }

  const parseJsonOutcome = (what: string, outcome: CommandOutcome): unknown => {
    if (outcome.status !== 0) fail(what, outcome)
    try {
      return JSON.parse(outcome.stdout)
    } catch {
      throw new AutomatorError(ErrorCodes.Update.failed, `${what}: JSON non valido`, 1)
    }
  }

  /**
   * GitHub offers no atomic replacement of assets. For the default we therefore use a release tag as a
   * container of immutable `<channel>-<semver>.json` generations: we list all the pages and pick
   * the GitHub asset with the most recent `created_at` (`id` breaks ties). Every new generation starts from the last
   * cumulative one, so even a version published out of order stays visible without making an asset mutable.
   */
  const fetchGitHubGeneration = (channel: ReleaseChannel): ReleaseManifest => {
    const metadata = parseJsonOutcome(
      `fetch metadata release manifest ${channel}`,
      run('gh', ['api', opts.manifestBaseUrl]),
    )
    if (typeof metadata !== 'object' || metadata === null || Array.isArray(metadata)) {
      throw new AutomatorError(ErrorCodes.Update.failed, `metadata release manifest ${channel} non validi`, 1)
    }
    const assetsUrl = (metadata as Record<string, unknown>).assets_url
    if (typeof assetsUrl !== 'string' || assetsUrl.length === 0) {
      throw new AutomatorError(ErrorCodes.Update.failed, `metadata release manifest ${channel} non validi`, 1)
    }

    let selected: {createdAt: number; id: number; url: string} | null = null
    for (let page = 1; ; page += 1) {
      const separator = assetsUrl.includes('?') ? '&' : '?'
      const pageUrl = `${assetsUrl}${separator}per_page=100&page=${page}`
      const rawAssets = parseJsonOutcome(`elenco generazioni manifest ${channel}`, run('gh', ['api', pageUrl]))
      if (!Array.isArray(rawAssets)) {
        throw new AutomatorError(ErrorCodes.Update.failed, `elenco generazioni manifest ${channel} non valido`, 1)
      }

      for (const rawAsset of rawAssets) {
        if (typeof rawAsset !== 'object' || rawAsset === null || Array.isArray(rawAsset)) continue
        const asset = rawAsset as Record<string, unknown>
        if (
          typeof asset.id !== 'number' ||
          !Number.isSafeInteger(asset.id) ||
          asset.id <= 0 ||
          typeof asset.created_at !== 'string' ||
          typeof asset.name !== 'string' ||
          typeof asset.url !== 'string'
        ) continue
        const createdAt = Date.parse(asset.created_at)
        if (!Number.isFinite(createdAt)) continue
        const prefix = `${channel}-`
        const suffix = '.json'
        if (!asset.name.startsWith(prefix) || !asset.name.endsWith(suffix)) continue
        const version = parseSemver(asset.name.slice(prefix.length, -suffix.length))
        if (
          version === null ||
          (selected !== null && (createdAt < selected.createdAt || (createdAt === selected.createdAt && asset.id <= selected.id)))
        ) continue
        selected = {createdAt, id: asset.id, url: asset.url}
      }

      if (rawAssets.length < 100) break
    }

    if (selected === null) {
      throw new AutomatorError(ErrorCodes.Update.failed, `nessuna generazione manifest trovata per ${channel}`, 1)
    }
    const rawManifest = parseJsonOutcome(
      `fetch generazione manifest ${channel}`,
      run('gh', ['api', '-H', 'Accept: application/octet-stream', selected.url]),
    )
    const manifest = parseManifest(rawManifest)
    if (!manifest || manifest.channel !== channel) {
      throw new AutomatorError(ErrorCodes.Update.failed, `manifest ${channel} non valido`, 1)
    }
    return manifest
  }

  return {
    preflightService() {
      opts.preflightService?.()
    },
    acquireLock() {
      return io.acquireLock(lockPath)
    },
    releaseLock(token) {
      io.releaseLock(lockPath, token)
    },
    reapStaging() {
      if (canonicalReleasesRoot() === null) return 0
      let reaped = 0
      for (const entry of io.list(releasesRoot)) {
        if (!entry.startsWith('.staging-')) continue
        if (removeConfinedReleaseChild(path.join(releasesRoot, entry))) reaped += 1
      }
      return reaped
    },
    readTransaction() {
      if (!io.exists(transactionPath)) return null
      let raw: unknown
      try {
        raw = JSON.parse(io.readFile(transactionPath).toString('utf8'))
      } catch {
        throw new AutomatorError(ErrorCodes.Update.failed, 'journal update non leggibile o non JSON', 1)
      }
      const parsed = UpdateTransactionSchema.safeParse(raw)
      if (!parsed.success) throw new AutomatorError(ErrorCodes.Update.failed, 'journal update non valido', 1)
      const expectedTarget = releaseDirFor(opts.installRoot, parsed.data.targetVersion)
      if (path.resolve(parsed.data.targetPath) !== path.resolve(expectedTarget)) {
        throw new AutomatorError(ErrorCodes.Update.failed, 'target del journal update fuori dal layout releases', 1)
      }
      if (parsed.data.previousTarget !== null) {
        const resolvedPrevious = path.resolve(path.dirname(currentLink), parsed.data.previousTarget)
        if (!resolvedPrevious.startsWith(`${releasesRoot}${path.sep}`)) {
          throw new AutomatorError(ErrorCodes.Update.failed, 'target precedente del journal fuori dal layout releases', 1)
        }
        if (resolvedPrevious === path.resolve(expectedTarget)) {
          throw new AutomatorError(ErrorCodes.Update.failed, 'journal update non valido: target e release precedente coincidono', 1)
        }
      }
      if (parsed.data.stagingRoot !== null) {
        const resolvedStaging = path.resolve(parsed.data.stagingRoot)
        const expectedPrefix = `.staging-${parsed.data.targetVersion}-`
        if (
          path.dirname(resolvedStaging) !== releasesRoot ||
          !path.basename(resolvedStaging).startsWith(expectedPrefix) ||
          path.basename(resolvedStaging).length <= expectedPrefix.length
        ) {
          throw new AutomatorError(ErrorCodes.Update.failed, 'staging del journal fuori dal layout releases', 1)
        }
      }
      return {
        ...parsed.data,
        targetPath: expectedTarget,
        previousTarget: parsed.data.previousTarget === null
          ? null
          : resolveCurrentTarget(parsed.data.previousTarget),
        stagingRoot: parsed.data.stagingRoot === null ? null : path.resolve(parsed.data.stagingRoot),
      }
    },
    writeTransaction(transaction) {
      io.writeFileAtomic(transactionPath, `${JSON.stringify(UpdateTransactionSchema.parse(transaction))}\n`)
    },
    clearTransaction() {
      io.remove(transactionPath)
    },
    currentVersion() {
      const target = io.readlink(currentLink)
      return target ? path.basename(resolveCurrentTarget(target)) : null
    },
    fetchManifest(channel) {
      if (/^https:\/\/api\.github\.com\/repos\/[^/]+\/[^/]+\/releases\/tags\/[^/?#]+$/.test(opts.manifestBaseUrl)) {
        return fetchGitHubGeneration(channel)
      }
      const outcome = run('curl', ['-fsSL', `${opts.manifestBaseUrl}/${channel}.json`])
      if (outcome.status !== 0) fail(`fetch del manifest ${channel}`, outcome)
      let raw: unknown
      try {
        raw = JSON.parse(outcome.stdout)
      } catch {
        throw new AutomatorError(ErrorCodes.Update.failed, `manifest ${channel} non è JSON valido`, 1)
      }
      const manifest = parseManifest(raw)
      if (!manifest || manifest.channel !== channel) throw new AutomatorError(ErrorCodes.Update.failed, `manifest ${channel} non valido`, 1)
      return manifest
    },
    download(url, dest) {
      // On a new machine `installRoot/releases/` does not exist yet: create it before the downloader.
      io.mkdirp(path.dirname(dest))
      let outcome: CommandOutcome
      let parsed: URL | null = null
      let segments: string[] = []
      try {
        parsed = new URL(url)
        segments = parsed.pathname.split('/').filter(Boolean).map((segment) => decodeURIComponent(segment))
      } catch {
        // Invalid custom URLs stay curl's responsibility, which will produce the uniform operational error.
        parsed = null
      }
      const isGitHubRelease = parsed?.protocol === 'https:' && parsed.hostname === 'github.com' &&
        segments.length === 6 && segments[2] === 'releases' && segments[3] === 'download' &&
        segments.slice(0, 2).every((segment) => /^[A-Za-z0-9_.-]+$/.test(segment)) &&
        /^[A-Za-z0-9_.-]+$/.test(segments[4]) && /^[A-Za-z0-9_.-]+$/.test(segments[5])
      if (isGitHubRelease) {
        const [owner, repo, , , tag, asset] = segments
        outcome = run('gh', [
          'release', 'download', tag,
          '--repo', `${owner}/${repo}`,
          '--pattern', asset,
          '--output', dest,
        ])
      } else {
        outcome = run('curl', ['-fsSL', '-o', dest, url])
      }
      if (outcome.status !== 0) fail('download dell\'artifact', outcome)
    },
    checksum(file) {
      return computeSha256(io.readFile(file))
    },
    createStaging(prefix) {
      io.mkdirp(path.dirname(prefix))
      return io.mkdtemp(prefix)
    },
    extract(archive, destDir) {
      io.mkdirp(destDir)
      const outcome = run('tar', ['-xzf', archive, '-C', destDir, '--strip-components=1'])
      if (outcome.status !== 0) fail('estrazione dell\'artifact', outcome)
    },
    preflight(releaseDir, expectedVersion) {
      return candidatePasses(releaseDir, expectedVersion)
    },
    releaseExists(releaseDir) {
      return confinedRelease(releaseDir)
    },
    activateRetained(releaseDir, expectedVersion, whilePinned) {
      const entrypoint = path.join(releaseDir, 'bin', 'run.js')
      const guarded = io.withDirectoryIdentity(releasesRoot, (rootIdentity) => {
        if (canonicalReleasesRoot() === null || !io.sameDirectory(releasesRoot, rootIdentity)) return false
        return io.withDirectoryIdentity(releaseDir, (releaseIdentity) => {
          if (!confinedRelease(releaseDir) || !io.sameDirectory(releaseDir, releaseIdentity)) return false
          return io.withFileIdentity(entrypoint, (entrypointIdentity) => {
            if (!io.sameFile(entrypoint, entrypointIdentity)) return false
            if (!candidatePasses(releaseDir, expectedVersion)) return false
            const identitiesMatch = (): boolean =>
              io.sameDirectory(releasesRoot, rootIdentity) &&
              io.sameDirectory(releaseDir, releaseIdentity) &&
              io.sameFile(entrypoint, entrypointIdentity)
            if (!identitiesMatch()) return false
            io.symlinkReplace(releaseDir, currentLink)
            if (io.readlink(currentLink) !== releaseDir || !identitiesMatch()) return false
            if (!whilePinned()) return false
            return io.readlink(currentLink) === releaseDir && identitiesMatch()
          }) ?? false
        }) ?? false
      })
      return guarded ?? false
    },
    markReleaseOwnership(releaseDir, transactionId, targetVersion) {
      const ownership: ReleaseOwnership = ReleaseOwnershipSchema.parse({version: 1, transactionId, targetVersion})
      io.writeFileAtomic(ownershipFile(releaseDir), `${JSON.stringify(ownership)}\n`)
    },
    releaseOwnedBy(releaseDir, transactionId) {
      try {
        const parsed = ReleaseOwnershipSchema.safeParse(JSON.parse(io.readFile(ownershipFile(releaseDir)).toString('utf8')))
        return parsed.success && parsed.data.transactionId === transactionId
      } catch {
        return false
      }
    },
    promote(stagedRelease, releaseDir) {
      io.syncTree(stagedRelease)
      if (!io.renameNoReplace(stagedRelease, releaseDir)) {
        throw new AutomatorError(
          ErrorCodes.Update.failed,
          `release finale già esistente, non verrà sovrascritta: ${releaseDir}`,
          1,
        )
      }
    },
    readCurrentTarget() {
      const target = io.readlink(currentLink)
      return target === null ? null : resolveCurrentTarget(target)
    },
    serviceInstalled() {
      return opts.serviceInstalled()
    },
    recoverService() {
      return opts.recoverService?.() ?? false
    },
    prepareService(targetPath) {
      opts.prepareService?.(targetPath)
    },
    migrateGuardrails(releaseDir) {
      if (!confinedRelease(releaseDir)) {
        throw new AutomatorError(ErrorCodes.Update.failed, 'release guardrail fuori dal layout confinato', 1)
      }
      if (opts.skipGuardrailMigration?.(releaseDir)) return
      try {
        const paths = (opts.guardrailPaths ?? (() => managedGuardrailPaths(opts.installRoot)))()
        ;(opts.installGuardrails ?? installGuardrails)(path.join(releaseDir, 'assets', 'guardrails'), paths)
      } catch (error) {
        const detail = error instanceof Error ? error.message : String(error)
        throw new AutomatorError(ErrorCodes.Update.failed, `migrazione guardrail fallita: ${detail}`, 1)
      }
    },
    activate(releaseDir) {
      io.symlinkReplace(releaseDir, currentLink)
    },
    restore(previousTarget) {
      io.symlinkReplace(previousTarget, currentLink)
    },
    deactivate(expectedTarget) {
      const observed = io.readlink(currentLink)
      if (
        observed === null ||
        resolveCurrentTarget(observed) !== path.resolve(expectedTarget) ||
        !io.unlinkSymlinkIfTarget(currentLink, observed)
      ) {
        throw new AutomatorError(ErrorCodes.Update.failed, 'current non coincide col target bootstrap atteso', 1)
      }
    },
    restart() {
      if (opts.restartService) {
        opts.restartService()
        return
      }
      const outcome = run(opts.restartCommand.cmd, opts.restartCommand.args)
      if (outcome.status !== 0) fail('restart del servizio', outcome)
    },
    rollbackService() {
      opts.rollbackService?.()
    },
    commitService() {
      opts.commitService?.()
    },
    healthCheck(expectedVersion) {
      const command = typeof opts.healthCommand === 'function' ? opts.healthCommand() : opts.healthCommand
      const outcome = run(command.cmd, command.args)
      return outcome.status === 0 &&
        versionOutputMatches(outcome.stdout, expectedVersion) &&
        (opts.serviceRunning?.() ?? true)
    },
    cleanup(file) {
      removeConfinedReleaseChild(file)
    },
  }
}
