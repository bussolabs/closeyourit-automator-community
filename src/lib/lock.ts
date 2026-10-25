import * as fs from 'node:fs'
import * as path from 'node:path'

// Pidfile to avoid overlapping ticks (.claude/scheduled_tasks.lock idiom). A lock held by a
// LIVE process → acquire fails (skip, not an error). A stale lock (dead pid) → stolen.

export interface LockInfo {
  pid: number
  startedAt: string
  label: string
}

export type IsAlive = (pid: number) => boolean

/** A pid is alive if `kill(pid, 0)` does not throw; EPERM = exists but without permission → alive. */
export function defaultIsAlive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'EPERM'
  }
}

export function readLock(file: string): LockInfo | null {
  try {
    const parsed = JSON.parse(fs.readFileSync(file, 'utf8'))
    if (typeof parsed?.pid === 'number') return parsed as LockInfo
    return null
  } catch {
    return null
  }
}

/** Acquires the lock. `false` if held by a live process; `true` if free/stale (stolen). */
export function acquire(file: string, label: string, isAlive: IsAlive = defaultIsAlive): boolean {
  const existing = readLock(file)
  if (existing && isAlive(existing.pid)) return false
  fs.mkdirSync(path.dirname(file), {recursive: true})
  const info: LockInfo = {pid: process.pid, startedAt: new Date().toISOString(), label}
  fs.writeFileSync(file, `${JSON.stringify(info, null, 2)}\n`)
  return true
}

export function release(file: string): void {
  fs.rmSync(file, {force: true})
}
