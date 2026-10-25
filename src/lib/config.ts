import * as fs from 'node:fs'
import * as path from 'node:path'
import {randomUUID} from 'node:crypto'
import {performance} from 'node:perf_hooks'
import {configDir} from './paths'
import {defaultIsAlive} from './lock'
import {
  directoryLockOwnerName,
  lockProcessIdentity,
  parseDirectoryLockOwner,
  prepareDirectoryLockClaim,
  releaseDirectoryLock,
  type ProcessIdentity,
} from './directory-lock'
import {type SecretCapabilities} from './env-capabilities'
import {isHostToken, isUserToken} from './credential-format'
export {HOST_TOKEN_PREFIX, isHostToken, isOrgToken, isUserToken} from './credential-format'
import {
  composeSecureSecrets,
  loadHostCredential,
  loadVaultCredential,
  persistableSecrets,
  saveHostCredential,
  saveVaultCredential,
  validSecureCredentialsConfig,
  type PersistedSecrets,
  type SecureCredentialsConfig,
} from './secure-credentials'

// Local automator configuration: in managed installations the file contains no credentials;
// static secrets come from the CloseYourIt vault and device ones from the operating system credential store.

export interface HeartbeatConfig {
  apiUrl?: string
  projectId: string
  slug: string
  token?: string // legacy: ignored; the operational check-in uses the revocable Agent Host credential
  environment?: string
}

// Automator API channel. The org token is needed only for bootstrap; after registration the
// operations use the host identity and can continue even if the org token is removed from the secrets.
export interface SyncConfig {
  apiUrl?: string
  orgToken?: string // org-scoped cyi_a_ token, exclusively POST /api/v1/hosts
}

// LOCAL host map: for every project key, where the repo is on THIS machine. It is the only
// machine-specific data and cannot come from the API.
export interface HostEntry {
  cwd: string
}

// Identity of THIS installation as an "Agent Host" on CloseYourIt: canonical host_id (stable over time)
// + dedicated revocable credential. Present only after a successful registration. NOT to be confused with
// `hosts` (project key → local repo map): here it is the identity of the machine/installation, not of the targets.
export interface HostIdentity {
  id: string // host_id assigned by CloseYourIt, stable for the installation
  token: string // revocable host-scoped credential (revoking it server-side disables the host)
}

/** Common boundary for every host-scoped call site: complete identity and valid revocable token. */
export function hasOperationalHostIdentity(secrets: Secrets): secrets is Secrets & {host: HostIdentity} {
  return typeof secrets.host?.id === 'string' && secrets.host.id.trim().length > 0 && isHostToken(secrets.host.token)
}

export interface Secrets {
  claudeToken?: string // CLAUDE_CODE_OAUTH_TOKEN (from `claude setup-token`)
  // CYAU-108: `cyi_u_` token of this machine's SERVICE ACCOUNT, from the credential store (never persisted in
  // clear in secrets.json: `persistableSecrets` does not write it). It is the identity the sessions talk to
  // CloseYourIt with — without it, they fall back to the one left by `cyi login`, i.e. a person.
  cyiToken?: string
  heartbeat?: HeartbeatConfig
  sync?: SyncConfig
  hosts?: Record<string, HostEntry>
  host?: HostIdentity // Agent Host identity of this installation (after registration)
  // Root under which the OneClick provisioning replicates the workspace manifest repositories (CYAU OneClick).
  // Explicit override from the secret; if missing, at runtime the manifest's `workspace_root_hint` is resolved under
  // $HOME (e.g. $HOME/Lavoro/Github/Personale). It is a non-sensitive local path, like `hosts.<KEY>.cwd`.
  workspaceRoot?: string
  // Stable local idempotency key (UUID) generated once and persisted BEFORE the registration: if
  // the response gets lost, the retry sends the same fingerprint and the (idempotent) server does not duplicate the host.
  hostFingerprint?: string
}

export function secretsPath(): string {
  return path.join(configDir(), 'secrets.json')
}

/** Non-sensitive configuration that enables CloseYourIt Secrets + credential store in managed installations. */
export function secureCredentialsPath(): string {
  return path.join(configDir(), 'credentials-provider.json')
}

export function loadSecureCredentialsConfig(): SecureCredentialsConfig | null {
  try {
    const parsed: unknown = JSON.parse(fs.readFileSync(secureCredentialsPath(), 'utf8'))
    return validSecureCredentialsConfig(parsed) ? parsed : null
  } catch {
    return null
  }
}

/** Immutable fingerprint claim: source of convergence between concurrent bootstraps. */
export function hostFingerprintPath(): string {
  return `${secretsPath()}.host-fingerprint`
}

/** Minimal injectable operations to test crash/failure without touching the public secrets API. */
export interface SecretsPersistence {
  mkdir(target: string): void
  read(target: string): string
  openExclusive(target: string, mode: number): number
  write(fd: number, data: string): void
  sync(fd: number): void
  close(fd: number): void
  link(from: string, to: string): void
  rename(from: string, to: string): void
  remove(target: string): void
  syncDirectory(target: string): void
}

const nodePersistence: SecretsPersistence = {
  mkdir: (target) => fs.mkdirSync(target, {recursive: true}),
  read: (target) => fs.readFileSync(target, 'utf8'),
  openExclusive: (target, mode) => fs.openSync(target, 'wx', mode),
  write: (fd, data) => fs.writeFileSync(fd, data, 'utf8'),
  sync: (fd) => fs.fsyncSync(fd),
  close: (fd) => fs.closeSync(fd),
  link: (from, to) => fs.linkSync(from, to),
  rename: (from, to) => fs.renameSync(from, to),
  remove: (target) => fs.rmSync(target, {force: true}),
  syncDirectory: (target) => {
    const fd = fs.openSync(target, 'r')
    try {
      fs.fsyncSync(fd)
    } finally {
      fs.closeSync(fd)
    }
  },
}

const SECRETS_LOCK_TIMEOUT_MS = 16_000
const SECRETS_LOCK_POLL_MS = 10
const EMPTY_LOCK_STALE_MS = 1_000
const waitBuffer = new Int32Array(new SharedArrayBuffer(4))

export interface SecretsWriteLockOptions {
  lockDir?: string
  timeoutMs?: number
  pollMs?: number
  clock?: () => number
  isAlive?: (pid: number) => boolean
  processIdentity?: ProcessIdentity
  beforePublish?: () => void
}

function waitSync(ms: number): void {
  if (ms > 0) Atomics.wait(waitBuffer, 0, 0, ms)
}

/** Recovers only writers that are surely dead; live PIDs or unknown entries conservatively degrade to timeout. */
function recoverDeadSecretsWriter(
  lockDir: string,
  deadline: number,
  clock: () => number,
  isAlive: (pid: number) => boolean,
  identify: ProcessIdentity,
): void {
  let entries: string[]
  try {
    entries = fs.readdirSync(lockDir)
  } catch {
    return
  }

  if (entries.length === 0) {
    try {
      if (Date.now() - fs.statSync(lockDir).mtimeMs >= EMPTY_LOCK_STALE_MS) fs.rmdirSync(lockDir)
    } catch {
      // The creator may have published the owner in the meantime.
    }
    return
  }

  for (const entry of entries) {
    if (clock() >= deadline) return
    const owner = parseDirectoryLockOwner(entry)
    if (!owner) continue
    const alive = isAlive(owner.pid)
    if (clock() >= deadline) return
    const identity = alive ? identify(owner.pid, Math.max(1, deadline - clock())) : null
    if (clock() >= deadline) return
    // Live but unverifiable owner: fail-closed. Different identity: recycled PID, recoverable.
    if (alive && (identity === null || identity === owner.identity)) continue
    try { fs.rmdirSync(path.join(lockDir, entry)) } catch { /* recovery concorrente */ }
  }
  try { fs.rmdirSync(lockDir) } catch { /* owner vivo/ignoto */ }
}

/**
 * Cross-process lock shared by ALL writers of secrets.json. The unique child prevents an owner from releasing
 * a successor's lock; a crash is recovered only when the PID is surely dead.
 */
export function withSecretsWriteLock<T>(run: () => T, options: SecretsWriteLockOptions = {}): T {
  const lockDir = options.lockDir ?? `${secretsPath()}.write.lock`
  fs.mkdirSync(path.dirname(lockDir), {recursive: true})
  const clock = options.clock ?? (() => performance.now())
  const deadline = clock() + (options.timeoutMs ?? SECRETS_LOCK_TIMEOUT_MS)
  const pollMs = options.pollMs ?? SECRETS_LOCK_POLL_MS
  const isAlive = options.isAlive ?? defaultIsAlive
  const identify = options.processIdentity ?? lockProcessIdentity
  const identity = identify(process.pid, Math.max(1, deadline - clock()))
  if (!identity) throw new Error('identità avvio processo non disponibile')
  const owner = directoryLockOwnerName(process.pid, identity)

  while (true) {
    const claim = prepareDirectoryLockClaim(lockDir, owner)
    let acquired: boolean
    try {
      options.beforePublish?.()
      if (clock() >= deadline) throw new Error('timeout acquisizione lock scrittura secrets')
      acquired = claim.publish()
    } catch (error) {
      claim.discard()
      throw error
    }

    if (acquired) {
      try {
        return run()
      } finally {
        releaseDirectoryLock(lockDir, owner)
      }
    }

    recoverDeadSecretsWriter(lockDir, deadline, clock, isAlive, identify)
    const remaining = deadline - clock()
    if (remaining <= 0) throw new Error('timeout acquisizione lock scrittura secrets')
    waitSync(Math.min(pollMs, remaining))
  }
}

function uniqueSibling(file: string, marker: string): string {
  return `${file}.${marker}-${process.pid}-${randomUUID()}`
}

function removeBestEffort(file: string, persistence: SecretsPersistence): void {
  try {
    persistence.remove(file)
  } catch {
    // A unique sibling is never read as the canonical file.
  }
}

function loadPersistedSecrets(persistence: SecretsPersistence = nodePersistence): Secrets {
  const file = secretsPath()
  const snapshot = uniqueSibling(file, 'read')

  // The link atomically snapshots the inode BEFORE the read. A writer can replace `file` right after,
  // but quarantine and parsing keep referring to the observed inode, never to the new valid file.
  try {
    persistence.link(file, snapshot)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return {}
    // Filesystem without hard links: keep reading, but never move a corrupt file without a safe snapshot.
    try {
      const parsed: unknown = JSON.parse(persistence.read(file))
      return typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed) ? parsed as Secrets : {}
    } catch {
      return {}
    }
  }

  let raw: string
  try {
    raw = persistence.read(snapshot)
  } catch {
    removeBestEffort(snapshot, persistence)
    return {}
  }

  try {
    const parsed: unknown = JSON.parse(raw)
    if (typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)) {
      removeBestEffort(snapshot, persistence)
      return parsed as Secrets
    }
  } catch {
    // The content stays opaque: the common branch below preserves the file without including it in errors/logs.
  }

  try {
    persistence.rename(snapshot, uniqueSibling(file, 'corrupt'))
    persistence.syncDirectory(path.dirname(file))
  } catch {
    // The snapshot stays separate anyway and is never mistaken for the canonical file.
  }
  return {}
}

/**
 * In managed mode the file contains only non-sensitive configuration. The service-account/host credentials
 * live in the operating system credential store; no static secret comes from the project vault any more.
 */
export function loadSecrets(persistence: SecretsPersistence = nodePersistence): Secrets {
  const persisted = loadPersistedSecrets(persistence)
  if (persistence !== nodePersistence) return persisted
  const secure = loadSecureCredentialsConfig()
  if (!secure) return persisted
  const safe = persistableSecrets(persisted)
  const hostToken = safe.host?.id ? loadHostCredential(safe.host.id) : undefined
  // Same credential that authorizes the host registration (`loadVaultCredential`): it is the machine's
  // service account token, and since CYAU-108 it is also its `cyi` identity in the sessions.
  const composed = composeSecureSecrets(safe, hostToken, loadVaultCredential())
  // A managed installation ALWAYS talks to the server: if no sync is persisted, synthesize an empty one
  // (default apiUrl in makeClient). With only the service account token in the credential store, registration and
  // host-scoped operations must not stop on `!secrets.sync` — the SA-only bootstrap must be able to register.
  if (!composed.sync) composed.sync = {}
  return composed
}

/**
 * Publishes only once the fingerprint already written and fsynced. `link` is an atomic create-if-absent on
 * Linux: two processes can propose different values, but both return the winner's value.
 * The claim is permanent, so a crash leaves no lock to recover and the retry completes `secrets.json`.
 */
export function claimHostFingerprint(candidate: string, persistence: SecretsPersistence = nodePersistence): string {
  if (candidate.trim().length === 0) throw new Error('fingerprint host non valido')

  const dir = configDir()
  const claim = hostFingerprintPath()
  const tmp = uniqueSibling(claim, 'tmp')
  persistence.mkdir(dir)
  let fd: number | null = null

  try {
    fd = persistence.openExclusive(tmp, 0o600)
    persistence.write(fd, `${candidate}\n`)
    persistence.sync(fd)
    persistence.close(fd)
    fd = null

    try {
      persistence.link(tmp, claim)
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
    }

    // Also makes durable a claim created by a process interrupted right after the link.
    persistence.syncDirectory(dir)
    const claimed = persistence.read(claim).trim()
    if (claimed.length === 0) throw new Error('claim fingerprint host non valido')
    return claimed
  } finally {
    if (fd !== null) {
      try {
        persistence.close(fd)
      } catch {
        // Keep the original error.
      }
    }
    removeBestEffort(tmp, persistence)
  }
}

type HostCredentialWriter = (hostId: string, token: string) => boolean
type VaultCredentialWriter = (token: string) => boolean
type VaultCredentialReader = () => string | undefined

export interface SecureCredentialMigrationDeps {
  credentialWriter?: HostCredentialWriter
  serviceAccountToken?: string
  vaultCredentialWriter?: VaultCredentialWriter
  vaultCredentialReader?: VaultCredentialReader
}

function writeSecretsFileUnlocked(secrets: Secrets | PersistedSecrets, persistence: SecretsPersistence): void {
  const dir = configDir()
  persistence.mkdir(dir)
  const file = secretsPath()
  const tmp = uniqueSibling(file, 'tmp')
  const serialized = `${JSON.stringify(secrets, null, 2)}\n`
  let fd: number | null = null

  try {
    // `wx` avoids collisions/overwrites; the mode already belongs to the inode that will be renamed.
    fd = persistence.openExclusive(tmp, 0o600)
    persistence.write(fd, serialized)
    persistence.sync(fd)
    persistence.close(fd)
    fd = null
    persistence.rename(tmp, file)
    persistence.syncDirectory(dir)
  } catch (error) {
    if (fd !== null) {
      try {
        persistence.close(fd)
      } catch {
        // Keep the original write/fsync/rename error.
      }
    }
    removeBestEffort(tmp, persistence)
    throw error
  }
}

function saveSecretsUnlocked(
  secrets: Secrets,
  persistence: SecretsPersistence,
  credentialWriter: HostCredentialWriter = saveHostCredential,
): void {
  const secure = persistence === nodePersistence && loadSecureCredentialsConfig() !== null
  if (secure && secrets.host?.token && !credentialWriter(secrets.host.id, secrets.host.token)) {
    throw new Error('credential store host non disponibile')
  }
  writeSecretsFileUnlocked(secure ? persistableSecrets(secrets) : secrets, persistence)
}

/** Serialized full replace. Read-modify-write writers must use updateSecrets so as not to save stale snapshots. */
export function saveSecrets(secrets: Secrets, persistence: SecretsPersistence = nodePersistence): void {
  if (persistence !== nodePersistence) return saveSecretsUnlocked(secrets, persistence)
  withSecretsWriteLock(() => saveSecretsUnlocked(secrets, persistence))
}

/**
 * Migrates a managed checkout to the mode without secrets on the filesystem. Makes any host token durable,
 * publishes the provider and then sanitizes the file. After the publication the loader ignores any legacy token anyway;
 * a sanitization error is propagated and the retry can complete without losing the operational credential.
 */
export function enableSecureCredentials(
  config: SecureCredentialsConfig,
  deps: SecureCredentialMigrationDeps = {},
): void {
  if (!validSecureCredentialsConfig(config)) throw new Error('configurazione credential provider non valida')
  withSecretsWriteLock(() => {
    const current = loadPersistedSecrets()
    const vaultCredential = deps.serviceAccountToken ?? (deps.vaultCredentialReader ?? loadVaultCredential)()
    if (!vaultCredential || !isUserToken(vaultCredential)) {
      throw new Error('token del service account CloseYourIt (cyi_u_) mancante o non valido')
    }
    // The service account token IS the machine's identity: it enters the credential store and is used to self-register
    // the host. No static secret is read from the project vault any more (Claude uses the machine's local auth;
    // the org token is replaced by the service account token).
    if (!(deps.vaultCredentialWriter ?? saveVaultCredential)(vaultCredential)) {
      throw new Error('credential store vault non disponibile')
    }
    const credentialWriter = deps.credentialWriter ?? saveHostCredential
    if (current.host?.token && !credentialWriter(current.host.id, current.host.token)) {
      throw new Error('credential store host non disponibile')
    }
    const dir = configDir()
    fs.mkdirSync(dir, {recursive: true})
    const target = secureCredentialsPath()
    const tmp = uniqueSibling(target, 'tmp')
    let fd: number | null = null
    try {
      fd = fs.openSync(tmp, 'wx', 0o600)
      fs.writeFileSync(fd, `${JSON.stringify(config, null, 2)}\n`, 'utf8')
      fs.fsyncSync(fd)
      fs.closeSync(fd)
      fd = null
      fs.renameSync(tmp, target)
      nodePersistence.syncDirectory(dir)
      writeSecretsFileUnlocked(persistableSecrets(current), nodePersistence)
    } finally {
      if (fd !== null) fs.closeSync(fd)
      fs.rmSync(tmp, {force: true})
    }
  })
}

export interface SecretsUpdateResult {
  updated: boolean
  secrets: Secrets
}

export type SecretsMutator = (current: Secrets) => Secrets | null
export type SecretsUpdater = (mutate: SecretsMutator) => SecretsUpdateResult

/** Load→merge→save atomic with respect to every writer of the repository. `null` leaves the file unchanged. */
export function updateSecrets(mutate: SecretsMutator): SecretsUpdateResult {
  return withSecretsWriteLock(() => {
    const current = loadSecrets()
    const next = mutate(structuredClone(current))
    if (next === null) return {updated: false, secrets: current}
    saveSecretsUnlocked(next, nodePersistence)
    return {updated: true, secrets: structuredClone(next)}
  })
}

/** Splits the secrets by capability; the transformation into env happens only in front of the authorized action. */
export function secretCapabilities(secrets: Secrets): SecretCapabilities {
  const capabilities: SecretCapabilities = {}
  // CYAU-108: the machine's `cyi` identity. It is the service account token already kept in the credential
  // store (the same that authorizes the host registration): not a new credential to distribute, only
  // one that finally reaches where it is needed.
  if (secrets.cyiToken) capabilities.cyiAuth = secrets.cyiToken
  return capabilities
}
