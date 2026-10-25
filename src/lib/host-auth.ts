import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import {randomUUID} from 'node:crypto'
import {performance} from 'node:perf_hooks'
import {
  claimHostFingerprint,
  hasOperationalHostIdentity,
  isOrgToken,
  isUserToken,
  loadSecrets,
  saveSecrets,
  secretsPath,
  updateSecrets,
  type SecretsUpdater,
  type Secrets,
} from './config'
import {type HostCallResult, type HostRegistration, type RegisteredHost} from './client'
import {defaultIsAlive} from './lock'
import {
  directoryLockOwnerName,
  lockProcessIdentity,
  parseDirectoryLockOwner,
  prepareDirectoryLockClaim,
  releaseDirectoryLock,
  type ProcessIdentity,
} from './directory-lock'
import {detectPlatform} from './service'

export {processStartIdentity} from './directory-lock'

const ROTATION_LOCK_TIMEOUT_MS = 16_000
const ROTATION_LOCK_POLL_MS = 25
const EMPTY_LOCK_STALE_MS = 1_000

export type WithRotationLock = <T>(run: () => Promise<T>) => Promise<T>

class RotationLockTimeout extends Error {
  constructor() {
    super('timeout acquisizione lock rotazione host')
  }
}

const delay = async (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms))

/** Recovers only owners that are surely dead or whose PID now belongs to a process started differently. */
function recoverDeadOwner(
  lockDir: string,
  wallNow: number,
  deadline: number,
  clock: () => number,
  isAlive: (pid: number) => boolean,
  processIdentity: ProcessIdentity,
): boolean {
  let entries: string[]
  try {
    entries = fs.readdirSync(lockDir)
  } catch {
    return false
  }

  if (entries.length === 0) {
    try {
      if (wallNow - fs.statSync(lockDir).mtimeMs >= EMPTY_LOCK_STALE_MS) fs.rmdirSync(lockDir)
    } catch {
      // An owner may have appeared in the meantime: never force the recursive removal.
    }
    return false
  }

  for (const entry of entries) {
    if (clock() >= deadline) return true
    const owner = parseDirectoryLockOwner(entry)
    if (!owner) continue
    const alive = isAlive(owner.pid)
    if (clock() >= deadline) return true
    const currentIdentity = alive ? processIdentity(owner.pid, Math.max(1, deadline - clock())) : null
    if (clock() >= deadline) return true
    // If the process is alive but we cannot verify its start, conservatively degrade to timeout.
    if (alive && (currentIdentity === null || currentIdentity === owner.identity)) continue
    try {
      fs.rmdirSync(path.join(lockDir, entry))
    } catch {
      // A concurrent contender or recovery already changed the state.
    }
  }

  try {
    fs.rmdirSync(lockDir)
  } catch {
    // Not empty = live/corrupt owner: bounded wait, never destructive removal.
  }
  return false
}

/**
 * Cross-process critical section for the host rotation only. The unique child prevents an owner resumed after
 * recovery from removing a successor's lock; a crash is recoverable as soon as the PID is no longer alive.
 */
export interface HostRotationLockOptions {
  lockDir?: string
  timeoutMs?: number
  pollMs?: number
  isAlive?: (pid: number) => boolean
  processIdentity?: ProcessIdentity
  clock?: () => number
  beforePublish?: () => Promise<void> | void
}

export async function withHostRotationLock<T>(run: () => Promise<T>, options: HostRotationLockOptions = {}): Promise<T> {
  const lockDir = options.lockDir ?? `${secretsPath()}.host-rotation.lock`
  const clock = options.clock ?? (() => performance.now())
  const deadline = clock() + (options.timeoutMs ?? ROTATION_LOCK_TIMEOUT_MS)
  const identify = options.processIdentity ?? lockProcessIdentity
  const identity = identify(process.pid, Math.max(1, deadline - clock()))
  if (!identity) throw new Error('identità avvio processo non disponibile')
  const owner = directoryLockOwnerName(process.pid, identity)
  const pollMs = options.pollMs ?? ROTATION_LOCK_POLL_MS
  const isAlive = options.isAlive ?? defaultIsAlive

  while (true) {
    const claim = prepareDirectoryLockClaim(lockDir, owner)
    let acquired: boolean
    try {
      await options.beforePublish?.()
      if (clock() >= deadline) throw new RotationLockTimeout()
      acquired = claim.publish()
    } catch (error) {
      claim.discard()
      throw error
    }

    if (acquired) {
      try {
        return await run()
      } finally {
        releaseDirectoryLock(lockDir, owner)
      }
    }

    if (recoverDeadOwner(lockDir, Date.now(), deadline, clock, isAlive, identify)) throw new RotationLockTimeout()
    const remaining = deadline - clock()
    if (remaining <= 0) throw new RotationLockTimeout()
    await delay(Math.min(pollMs, remaining))
  }
}

export interface RecoverHostOperationDeps<T> {
  secrets: Secrets
  operation(token: string, sync: Secrets['sync']): Promise<HostCallResult<T>>
  register(registration: HostRegistration, sync: NonNullable<Secrets['sync']>, registrationToken?: string): Promise<HostCallResult<RegisteredHost>>
  loadRegistrationToken?: () => string | undefined // service account token (cyi_u_) from the credential store, for re-registration
  load?: () => Secrets
  save?: (secrets: Secrets) => void
  update?: SecretsUpdater
  claimFingerprint?: (candidate: string) => string
  withRotationLock?: WithRotationLock
  newFingerprint?: () => string
  hostname?: () => string
  platform?: string
  arch?: string
  version?: string
  log?: (message: string) => void
}

function sameHostIdentity(left: Secrets['host'], right: Secrets['host']): boolean {
  return left?.id === right?.id && left?.token === right?.token
}

/** Replaces the shared snapshot in place: keys removed on disk stay removed in memory too. */
function replaceSecrets(target: Secrets, source: Secrets): void {
  for (const key of Object.keys(target) as Array<keyof Secrets>) delete target[key]
  Object.assign(target, structuredClone(source))
}

/**
 * Runs a host-scoped call and allows exclusively 401 → one rotation → one retry. No branch uses
 * the org token for the operation: it is needed only for the registration POST inside the critical section.
 */
export async function recoverHostOperation<T>(deps: RecoverHostOperationDeps<T>): Promise<HostCallResult<T>> {
  if (!hasOperationalHostIdentity(deps.secrets)) return {outcome: 'unavailable'}
  const initialHost = deps.secrets.host

  const first = await deps.operation(initialHost.token, deps.secrets.sync)
  if (first.outcome !== 'unauthorized') return first

  const load = deps.load ?? loadSecrets
  const save = deps.save ?? saveSecrets
  const update: SecretsUpdater = deps.update ?? (deps.save
    ? (mutate) => {
        const current = load()
        const next = mutate(structuredClone(current))
        if (next === null) return {updated: false, secrets: current}
        save(next)
        return {updated: true, secrets: structuredClone(next)}
      }
    : updateSecrets)
  const claim = deps.claimFingerprint ?? claimHostFingerprint
  const lock = deps.withRotationLock ?? withHostRotationLock
  const log = deps.log ?? (() => undefined)

  try {
    return await lock(async () => {
      const latest = load()
      if (!hasOperationalHostIdentity(latest)) return {outcome: 'unavailable'}

      // Another process already completed the rotation while we were waiting: spend the only retry with the
      // persisted token, without a second POST that would immediately supersede it. The durable snapshot
      // becomes the operational one right away even if the retry is still 401/403: the next round must never
      // restart from the old token nor turn a terminal revocation into a loop.
      if (latest.host.token !== initialHost.token) {
        replaceSecrets(deps.secrets, latest)
        const retry = await deps.operation(latest.host.token, latest.sync)
        return retry
      }

      // The re-registration authority is re-read INSIDE the lock: the service account token (cyi_u_) from the
      // credential store or, for backward compat, the org token cyi_a_ in sync. Never use a value captured before
      // the critical section nor an org token removed/invalidated during the wait.
      // `latest.sync` is always needed (it carries the POST apiUrl); the AUTHORITY is the SA token cyi_u_ or the org token.
      const registrationToken = deps.loadRegistrationToken?.()
      if (!latest.sync || (!isUserToken(registrationToken) && !isOrgToken(latest.sync.orgToken))) return {outcome: 'unauthorized'}

      const proposed = latest.hostFingerprint ?? deps.secrets.hostFingerprint ?? (deps.newFingerprint ?? randomUUID)()
      let fingerprint: string
      try {
        fingerprint = claim(proposed)
      } catch {
        return {outcome: 'unavailable'}
      }

      const observedHost = {...latest.host}
      const registration = await deps.register({
        fingerprint,
        hostname: (deps.hostname ?? os.hostname)(),
        platform: deps.platform ?? detectPlatform(),
        arch: deps.arch ?? process.arch,
        ...(deps.version ? {automator_version: deps.version} : {}),
      }, latest.sync, registrationToken)
      if (registration.outcome !== 'ok') return registration

      // The POST can stay in flight while another writer updates the secrets. Re-read immediately before
      // the commit and CAS on the observed identity: never reintroduce a removed orgToken, lose other updates or
      // overwrite a more recent rotation. If the CAS loses but a valid identity exists, use that one.
      const beforePersist = load()
      if (!sameHostIdentity(beforePersist.host, observedHost)) {
        if (!hasOperationalHostIdentity(beforePersist)) return {outcome: 'unavailable'}
        replaceSecrets(deps.secrets, beforePersist)
        const retry = await deps.operation(beforePersist.host.token, beforePersist.sync)
        return retry
      }

      let committed: ReturnType<SecretsUpdater>
      try {
        committed = update((current) => {
          if (!sameHostIdentity(current.host, observedHost)) return null
          return {...current, hostFingerprint: fingerprint, host: {...registration.value}}
        })
      } catch {
        // The token just received may be valid but it is not operational until it is durable on disk.
        return {outcome: 'unavailable'}
      }

      if (!committed.updated) {
        if (!hasOperationalHostIdentity(committed.secrets)) return {outcome: 'unavailable'}
        replaceSecrets(deps.secrets, committed.secrets)
        const retry = await deps.operation(committed.secrets.host.token, committed.secrets.sync)
        return retry
      }

      replaceSecrets(deps.secrets, committed.secrets)
      log('host: credenziale superata ruotata e persistita')
      return deps.operation(registration.value.token, committed.secrets.sync)
    })
  } catch (error) {
    if (error instanceof RotationLockTimeout) log('host: rotazione non acquisita entro il limite')
    else log(`host: rotazione fallita (${String(error)})`)
    return {outcome: 'unavailable'}
  }
}
