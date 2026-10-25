import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import {afterEach, describe, expect, it} from 'vitest'
import {
  BUSY_MARKER_FILE,
  busyMarkerPath,
  clearBusyMarker,
  gitAdminDirectory,
  markBusy,
  readBusyMarker,
  withBusyMarker,
} from '../src/lib/busy-marker'

// CYAU-168: a work folder must not be cleaned up while a check runs in it. The marker declares WHO is
// using it (pid, start time, ticket) and lives in the Git administrative directory, NEVER in the working tree: the
// review rejects untracked files and `git add -A` must not be able to stage it. lock.ts semantics: a
// marker whose process no longer exists counts as MISSING, otherwise the first crash blocks the folder
// forever. The marker only INFORMS: it is not a gate, so it must never make what it protects fail.

const directories: string[] = []

function temporaryDirectory(): string {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'automator-busy-'))
  directories.push(directory)
  return directory
}

/** Classic checkout: `.git` is a directory. */
function checkout(): string {
  const directory = temporaryDirectory()
  fs.mkdirSync(path.join(directory, '.git'))
  return directory
}

/** Linked worktree: `.git` is a `gitdir: <path>` file pointing to the administrative directory. */
function linkedWorktree(): {adminDir: string; worktree: string} {
  const repo = temporaryDirectory()
  const worktree = temporaryDirectory()
  const adminDir = path.join(repo, '.git', 'worktrees', 'CYAU-168')
  fs.mkdirSync(adminDir, {recursive: true})
  fs.writeFileSync(path.join(worktree, '.git'), `gitdir: ${adminDir}\n`)
  return {adminDir, worktree}
}

const deadPid = 2_147_483_646

afterEach(() => {
  for (const directory of directories.splice(0)) fs.rmSync(directory, {recursive: true, force: true})
})

describe('where the marker lives', () => {
  it('in a checkout it sits in .git, outside the working tree', () => {
    const repo = checkout()
    expect(gitAdminDirectory(repo)).toBe(path.join(repo, '.git'))
    expect(busyMarkerPath(repo)).toBe(path.join(repo, '.git', BUSY_MARKER_FILE))
  })

  it('in a linked worktree it sits in the gitdir pointed to by .git', () => {
    const {adminDir, worktree} = linkedWorktree()
    expect(gitAdminDirectory(worktree)).toBe(adminDir)
    expect(busyMarkerPath(worktree)).toBe(path.join(adminDir, BUSY_MARKER_FILE))
  })

  it('a folder that is not a Git checkout has no marker', () => {
    expect(busyMarkerPath(temporaryDirectory())).toBeNull()
  })

  it('a .git pointing to a non-existent gitdir has no marker', () => {
    const worktree = temporaryDirectory()
    fs.writeFileSync(path.join(worktree, '.git'), `gitdir: ${path.join(worktree, 'mai-esistito')}\n`)
    expect(busyMarkerPath(worktree)).toBeNull()
  })
})

describe('markBusy / readBusyMarker', () => {
  it('the marker carries pid, start time and ticket', () => {
    const repo = checkout()
    markBusy(repo, {label: 'quality-gate', ticket: 'CYAU-168', now: () => new Date('2026-08-17T09:00:00.000Z')})

    expect(readBusyMarker(repo)).toMatchObject({
      label: 'quality-gate',
      pid: process.pid,
      startedAt: '2026-08-17T09:00:00.000Z',
      ticket: 'CYAU-168',
    })
  })

  it('does not dirty the working tree of the work folder', () => {
    const {adminDir, worktree} = linkedWorktree()
    markBusy(worktree, {label: 'quality-gate', ticket: 'CYAU-168'})

    expect(fs.readdirSync(worktree)).toEqual(['.git'])
    expect(fs.existsSync(path.join(adminDir, BUSY_MARKER_FILE))).toBe(true)
  })

  it('without a known ticket the marker stays valid', () => {
    const repo = checkout()
    markBusy(repo, {label: 'quality-gate'})

    expect(readBusyMarker(repo)).toMatchObject({label: 'quality-gate', ticket: null})
  })

  it('a marker whose process no longer exists counts as missing', () => {
    const repo = checkout()
    markBusy(repo, {label: 'quality-gate', pid: deadPid, ticket: 'CYAU-168'})

    expect(fs.existsSync(busyMarkerPath(repo)!)).toBe(true)
    expect(readBusyMarker(repo)).toBeNull()
  })

  it('a pid reused by another process counts as missing', () => {
    const repo = checkout()
    markBusy(repo, {identify: () => 'avvio-di-allora', label: 'quality-gate', ticket: 'CYAU-168'})

    expect(readBusyMarker(repo, {identify: () => 'avvio-di-adesso', isAlive: () => true})).toBeNull()
    expect(readBusyMarker(repo, {identify: () => 'avvio-di-allora', isAlive: () => true})).toMatchObject({
      pid: process.pid,
    })
  })

  it('start identity not computable → the pid alone decides, like lock.ts', () => {
    const repo = checkout()
    markBusy(repo, {identify: () => 'avvio-di-allora', label: 'quality-gate'})

    expect(readBusyMarker(repo, {identify: () => null, isAlive: () => true})).toMatchObject({pid: process.pid})
    expect(readBusyMarker(repo, {identify: () => null, isAlive: () => false})).toBeNull()
  })

  it('an unreadable marker or one without a valid pid counts as missing', () => {
    const repo = checkout()
    const file = busyMarkerPath(repo)!
    fs.writeFileSync(file, 'non json')
    expect(readBusyMarker(repo)).toBeNull()

    fs.writeFileSync(file, JSON.stringify({label: 'quality-gate', startedAt: 'x'}))
    expect(readBusyMarker(repo)).toBeNull()

    fs.writeFileSync(file, JSON.stringify({label: 'quality-gate', pid: -1, startedAt: 'x'}))
    expect(readBusyMarker(repo)).toBeNull()
  })

  it('a non-Git folder receives no markers and does not throw', () => {
    const plain = temporaryDirectory()
    expect(markBusy(plain, {label: 'quality-gate', ticket: 'CYAU-168'})).toBeNull()
    expect(fs.readdirSync(plain)).toEqual([])
    expect(readBusyMarker(plain)).toBeNull()
  })

  it('does not replace the marker of a still alive piece of work', () => {
    const repo = checkout()
    markBusy(repo, {label: 'quality-gate', now: () => new Date('2026-08-17T09:00:00.000Z'), ticket: 'CYAU-168'})

    expect(markBusy(repo, {isAlive: () => true, label: 'gate-di-un-altro', pid: 4242, ticket: 'CYAU-999'})).toBeNull()
    expect(readBusyMarker(repo)).toMatchObject({
      pid: process.pid,
      startedAt: '2026-08-17T09:00:00.000Z',
      ticket: 'CYAU-168',
    })
  })

  it('replaces a stale marker and its own re-marking', () => {
    const repo = checkout()
    markBusy(repo, {label: 'quality-gate', pid: deadPid, ticket: 'CYAU-000'})
    expect(markBusy(repo, {label: 'quality-gate', ticket: 'CYAU-168'})).toMatchObject({pid: process.pid})

    markBusy(repo, {label: 'quality-gate', now: () => new Date('2026-08-17T10:00:00.000Z'), ticket: 'CYAU-168'})
    expect(readBusyMarker(repo)).toMatchObject({startedAt: '2026-08-17T10:00:00.000Z'})
  })
})

describe('clearBusyMarker', () => {
  it('removes the marker of its own process and is idempotent', () => {
    const repo = checkout()
    markBusy(repo, {label: 'quality-gate', ticket: 'CYAU-168'})
    clearBusyMarker(repo)

    expect(fs.existsSync(busyMarkerPath(repo)!)).toBe(false)
    expect(() => clearBusyMarker(repo)).not.toThrow()
    expect(() => clearBusyMarker(temporaryDirectory())).not.toThrow()
  })

  it('does not remove the marker of another process', () => {
    const repo = checkout()
    markBusy(repo, {label: 'quality-gate', pid: deadPid, ticket: 'CYAU-168'})
    clearBusyMarker(repo)

    expect(fs.existsSync(busyMarkerPath(repo)!)).toBe(true)
    expect(clearBusyMarker(repo, {pid: deadPid})).toBe(true)
    expect(fs.existsSync(busyMarkerPath(repo)!)).toBe(false)
  })

  it('does not remove a later marking of the same pid', () => {
    const repo = checkout()
    const mine = markBusy(repo, {label: 'quality-gate', now: () => new Date('2026-08-17T09:00:00.000Z')})!
    markBusy(repo, {label: 'quality-gate', now: () => new Date('2026-08-17T11:00:00.000Z')})

    expect(clearBusyMarker(repo, mine)).toBe(false)
    expect(readBusyMarker(repo)).toMatchObject({startedAt: '2026-08-17T11:00:00.000Z'})
  })
})

describe('withBusyMarker', () => {
  it('the folder shows as busy during the work and free at the end', async () => {
    const {worktree} = linkedWorktree()
    const during = await withBusyMarker(worktree, {label: 'quality-gate', ticket: 'CYAU-168'}, async () =>
      readBusyMarker(worktree))

    expect(during).toMatchObject({label: 'quality-gate', pid: process.pid, ticket: 'CYAU-168'})
    expect(readBusyMarker(worktree)).toBeNull()
    expect(fs.existsSync(busyMarkerPath(worktree)!)).toBe(false)
  })

  it('removes the marker even when the work fails or is cancelled', async () => {
    const repo = checkout()
    await expect(withBusyMarker(repo, {label: 'quality-gate'}, async () => {
      throw new Error('verifica fallita')
    })).rejects.toThrow(/verifica fallita/)
    expect(fs.existsSync(busyMarkerPath(repo)!)).toBe(false)

    const controller = new AbortController()
    await expect(withBusyMarker(repo, {label: 'quality-gate'}, async () => {
      controller.abort()
      throw new Error('ciclo automatico annullato')
    })).rejects.toThrow(/annullato/)
    expect(fs.existsSync(busyMarkerPath(repo)!)).toBe(false)
  })

  it('a non-writable marker does not stop the work', async () => {
    const plain = temporaryDirectory()
    await expect(withBusyMarker(plain, {label: 'quality-gate'}, async () => 'verifica eseguita'))
      .resolves.toBe('verifica eseguita')
  })

  it('whoever finds the folder already declared works anyway but does not free the other declaration', async () => {
    const repo = checkout()
    markBusy(repo, {label: 'gate-di-un-altro', pid: 4242, ticket: 'CYAU-999'})

    const done = await withBusyMarker(
      repo,
      {isAlive: () => true, label: 'quality-gate', ticket: 'CYAU-168'},
      async () => 'verifica eseguita',
    )

    expect(done).toBe('verifica eseguita')
    expect(readBusyMarker(repo, {isAlive: () => true})).toMatchObject({pid: 4242, ticket: 'CYAU-999'})
  })
})
