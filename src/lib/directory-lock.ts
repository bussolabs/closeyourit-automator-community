import * as fs from 'node:fs'
import * as path from 'node:path'
import {execFileSync} from 'node:child_process'
import {randomUUID} from 'node:crypto'

export type ProcessIdentity = (pid: number, timeoutMs?: number) => string | null

/** Start identity stable for the process lifetime: kernel starttime on Linux, ps lstart on other Unixes. */
export function processStartIdentity(pid: number, timeoutMs = 1_000): string | null {
  if (!Number.isSafeInteger(pid) || pid <= 0) return null
  if (process.platform === 'linux') {
    try {
      const stat = fs.readFileSync(`/proc/${pid}/stat`, 'utf8')
      const close = stat.lastIndexOf(')')
      if (close < 0) return null
      // After "pid (comm)" the first element is field 3; starttime is field 22 → index 19.
      const starttime = stat.slice(close + 2).trim().split(/\s+/)[19]
      return starttime ? `linux:${starttime}` : null
    } catch {
      return null
    }
  }

  try {
    const started = execFileSync('ps', ['-o', 'lstart=', '-p', String(pid)], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
      timeout: Math.max(1, Math.floor(timeoutMs)),
    }).trim()
    return started ? `${process.platform}:${started}` : null
  } catch {
    return null
  }
}

let cachedCurrentProcessIdentity: string | undefined

/** Reuses the kernel identity of the current process, while still always checking concurrent owners. */
export function lockProcessIdentity(pid: number, timeoutMs = 1_000): string | null {
  if (pid !== process.pid) return processStartIdentity(pid, timeoutMs)
  if (cachedCurrentProcessIdentity) return cachedCurrentProcessIdentity
  const identity = processStartIdentity(pid, timeoutMs)
  if (identity) cachedCurrentProcessIdentity = identity
  return identity
}

export interface DirectoryLockOwner {
  pid: number
  identity: string
}

export function directoryLockOwnerName(pid: number, identity: string, generation = randomUUID()): string {
  return `${pid}~${Buffer.from(identity).toString('base64url')}~${generation}`
}

export function parseDirectoryLockOwner(name: string): DirectoryLockOwner | null {
  const parts = name.split('~')
  if (parts.length !== 3 || parts[1].length === 0 || parts[2].length === 0) return null
  const pid = Number(parts[0])
  if (!Number.isSafeInteger(pid) || pid <= 0) return null
  try {
    const decoded = Buffer.from(parts[1], 'base64url')
    if (decoded.toString('base64url') !== parts[1]) return null
    const identity = decoded.toString('utf8')
    return identity ? {pid, identity} : null
  } catch {
    return null
  }
}

export interface PreparedDirectoryLockClaim {
  publish(): boolean
  discard(): void
}

/**
 * Prepares owner+generation outside the canonical path and publishes them together with rename. The canonical lock
 * is therefore never observable as an empty directory between mkdir(parent) and mkdir(owner).
 */
export function prepareDirectoryLockClaim(lockDir: string, owner: string): PreparedDirectoryLockClaim {
  fs.mkdirSync(path.dirname(lockDir), {recursive: true})
  const claimDir = `${lockDir}.claim-${process.pid}-${randomUUID()}`
  let published = false

  try {
    fs.mkdirSync(claimDir, {mode: 0o700})
    fs.mkdirSync(path.join(claimDir, owner), {mode: 0o700})
  } catch (error) {
    fs.rmSync(claimDir, {recursive: true, force: true})
    throw error
  }

  return {
    publish: () => {
      try {
        fs.renameSync(claimDir, lockDir)
        published = true
        return true
      } catch (error) {
        const code = (error as NodeJS.ErrnoException).code
        if (code === 'EEXIST' || code === 'ENOTEMPTY') return false
        throw error
      } finally {
        if (!published) fs.rmSync(claimDir, {recursive: true, force: true})
      }
    },
    discard: () => {
      if (!published) fs.rmSync(claimDir, {recursive: true, force: true})
    },
  }
}

/** Releases only the owned generation; a non-empty successor cannot be removed by mistake. */
export function releaseDirectoryLock(lockDir: string, owner: string): void {
  try { fs.rmdirSync(path.join(lockDir, owner)) } catch { /* recovery may have already removed this generation */ }
  try { fs.rmdirSync(lockDir) } catch { /* do not remove a successor's non-empty lock */ }
}
