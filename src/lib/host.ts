import * as os from 'node:os'
import {randomUUID} from 'node:crypto'
import {
  claimHostFingerprint,
  hasOperationalHostIdentity,
  isOrgToken,
  isUserToken,
  loadSecrets,
  updateSecrets,
  type HostIdentity,
  type Secrets,
  type SecretsUpdater,
} from './config'
import {makeClient, type AutomatorClient} from './client'
import {loadVaultCredential} from './secure-credentials'
import {type FetchFn} from './heartbeat'
import {ensureHeartbeatConfig, type HeartbeatSetupDeps, type HeartbeatSetupResult} from './heartbeat-setup'
import {withHostRotationLock, type WithRotationLock} from './host-auth'
import {detectPlatform} from './service'

// Registration of this installation as an "Agent Host" on CloseYourIt. Idempotent and best-effort:
// if the host is already registered it does not repeat the POST; if the registration fails (network/HTTP) it does not throw,
// so it can run in the daemon boot without killing it (it retries at the next round).

export type EnsureHostStatus = 'existing' | 'registered' | 'failed'

export interface EnsureHostResult {
  status: EnsureHostStatus
  host: HostIdentity | null
}

export interface HostRegistrarDeps {
  clientForSync(sync: NonNullable<Secrets['sync']>, registrationToken?: string): AutomatorClient
  loadRegistrationToken?: () => string | undefined // service account token (cyi_u_) from the credential store
  secrets: Secrets // full secret object (mutated and persisted with the host/hostFingerprint fields)
  save?: (secrets: Secrets) => void // test compat: adapted to the atomic update protocol
  load?: () => Secrets
  update?: SecretsUpdater
  withMutationLock?: WithRotationLock
  hostname?: () => string // default os.hostname
  platform?: string // test seam; in production detectPlatform() accepts only Linux
  arch?: string // default process.arch
  version?: string // automator version (omitted from the payload if missing)
  newFingerprint?: () => string // default randomUUID (injectable in tests)
  claimFingerprint?: (candidate: string) => string // default claimHostFingerprint, atomic across processes
  log?: (message: string) => void
}

function replaceSecrets(target: Secrets, source: Secrets): void {
  for (const key of Object.keys(target) as Array<keyof Secrets>) delete target[key]
  Object.assign(target, structuredClone(source))
}

// Ensures this installation is registered as an Agent Host. Returns `existing` without calls if
// there is already a valid operational identity in the secrets; otherwise registers and persists id+credential. The fingerprint is
// generated and SAVED BEFORE the POST: if the response gets lost, the retry reuses the same fingerprint and
// the (idempotent) server returns the same host, without duplicates.
async function ensureHostRegisteredLocked(
  deps: HostRegistrarDeps,
  load: () => Secrets,
  update: SecretsUpdater,
): Promise<EnsureHostResult> {
  const {secrets} = deps
  const log = deps.log ?? (() => undefined)
  replaceSecrets(secrets, load())

  // Only a non-empty id + cyi_ah_ token is an operational identity. Legacy/malformed records must go through
  // bootstrap, otherwise they would stay present but unusable forever.
  if (hasOperationalHostIdentity(secrets)) {
    return {status: 'existing', host: secrets.host}
  }

  // Registration authority re-read under the lock: the machine presents itself with the token of ITS service
  // account (cyi_u_, from the credential store); fallback to the cyi_a_ org token for backward compat with the old
  // bootstrap. The client cannot have been built by the caller with the apiUrl/token of an old snapshot.
  const registrationToken = deps.loadRegistrationToken?.()
  if (!secrets.sync || (!isUserToken(registrationToken) && !isOrgToken(secrets.sync.orgToken))) {
    return {status: 'failed', host: null}
  }

  const proposedFingerprint = secrets.hostFingerprint ?? (deps.newFingerprint ?? randomUUID)()
  let fingerprint: string
  try {
    fingerprint = (deps.claimFingerprint ?? claimHostFingerprint)(proposedFingerprint)
  } catch (error) {
    log(`host: claim del fingerprint fallito (${String(error)})`)
    return {status: 'failed', host: null}
  }

  if (secrets.hostFingerprint !== fingerprint) {
    try {
      const committed = update((current) => ({...current, hostFingerprint: fingerprint}))
      replaceSecrets(secrets, committed.secrets)
    } catch (error) {
      log(`host: persistenza del secret fallita (${String(error)})`)
      return {status: 'failed', host: null}
    }
  }

  if (hasOperationalHostIdentity(secrets)) {
    return {status: 'existing', host: secrets.host}
  }
  if (!secrets.sync || (!isUserToken(registrationToken) && !isOrgToken(secrets.sync.orgToken))) {
    return {status: 'failed', host: null}
  }
  const client = deps.clientForSync(secrets.sync, registrationToken)

  const registered = await client.registerHost({
    fingerprint,
    hostname: (deps.hostname ?? os.hostname)(),
    platform: deps.platform ?? detectPlatform(),
    arch: deps.arch ?? process.arch,
    ...(deps.version ? {automator_version: deps.version} : {}),
  })

  if (!registered) {
    log('host: registrazione fallita (best-effort, si riprova al prossimo giro)')
    return {status: 'failed', host: null}
  }

  const host: HostIdentity = {id: registered.id, token: registered.token}
  let committed: ReturnType<SecretsUpdater>
  try {
    committed = update((current) => {
      // Another completed registration/recovery wins; never overwrite it with a late response.
      if (hasOperationalHostIdentity(current)) return null
      return {...current, hostFingerprint: fingerprint, host}
    })
  } catch (error) {
    log(`host: persistenza del secret fallita (${String(error)})`)
    return {status: 'failed', host: null}
  }
  replaceSecrets(secrets, committed.secrets)
  if (!committed.updated) {
    return hasOperationalHostIdentity(secrets)
      ? {status: 'existing', host: secrets.host}
      : {status: 'failed', host: null}
  }
  log(`host: registrato host_id=${registered.id}`)
  return {status: 'registered', host}
}

export async function ensureHostRegistered(deps: HostRegistrarDeps): Promise<EnsureHostResult> {
  // Units with injected persistence stay isolated from the filesystem; in production load/update and the rotation
  // lock form a single protocol with every other writer of secrets.json.
  const injectedPersistence = deps.save !== undefined || deps.load !== undefined || deps.update !== undefined
  const load = deps.load ?? (() => structuredClone(deps.secrets))
  const update: SecretsUpdater = deps.update ?? (deps.save
    ? (mutate) => {
        const current = load()
        const next = mutate(structuredClone(current))
        if (next === null) return {updated: false, secrets: current}
        deps.save!(next)
        replaceSecrets(deps.secrets, next)
        return {updated: true, secrets: structuredClone(next)}
      }
    : updateSecrets)
  const lock = deps.withMutationLock ?? (injectedPersistence
    ? async <T>(run: () => Promise<T>): Promise<T> => run()
    : withHostRotationLock)
  return lock(() => ensureHostRegisteredLocked(deps, load, update))
}

// What a registration command gets back: the host outcome plus, once the host is operational, the heartbeat
// section outcome (CYAU-220) — `missing` carries the reason the caller logs.
export type HostRegistrarResult = EnsureHostResult & {heartbeat?: HeartbeatSetupResult}

// Builds the registrar from the secrets. An already valid host can answer `existing` even without orgToken;
// a bootstrap/re-bootstrap instead requires the org authority and never POSTs without it.
//
// CYAU-220: every registration command goes through here, so here the machine also writes its heartbeat section
// when it is missing — after a fresh registration and, at every daemon start, for hosts registered before.
export function makeHostRegistrar(
  secrets: Secrets,
  log?: (message: string) => void,
  fetchFn?: FetchFn,
  version?: string,
  platform?: string,
  heartbeatDeps: HeartbeatSetupDeps = {},
): (() => Promise<HostRegistrarResult>) | undefined {
  const existing = hasOperationalHostIdentity(secrets)
  // A bootstrap requires the registration authority: the service account token (cyi_u_) from the credential
  // store or, for backward compat, the org token (cyi_a_). An already valid host stays operational even without it.
  if (!existing && !isUserToken(loadVaultCredential()) && (!secrets.sync || !isOrgToken(secrets.sync.orgToken))) {
    return undefined
  }
  const withHeartbeat = async (result: EnsureHostResult): Promise<HostRegistrarResult> => {
    if (result.status === 'failed') return result
    const heartbeat = await ensureHeartbeatConfig(secrets, {fetchFn, ...heartbeatDeps})
    if (heartbeat.status === 'configured') log?.(`heartbeat: configured for project ${heartbeat.heartbeat.projectId} (monitor ${heartbeat.heartbeat.slug})`)
    return {...result, heartbeat}
  }
  if (existing) return () => withHeartbeat({status: 'existing', host: secrets.host})
  return async () => withHeartbeat(await ensureHostRegistered({
    clientForSync: (currentSync, registrationToken) => makeClient(currentSync, fetchFn, undefined, registrationToken),
    loadRegistrationToken: () => loadVaultCredential(),
    secrets,
    log,
    platform,
    version,
    load: loadSecrets,
    update: updateSecrets,
    withMutationLock: withHostRotationLock,
  }))
}
