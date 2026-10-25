import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import {afterAll, describe, expect, it} from 'vitest'
import {acquire, defaultIsAlive, readLock, release} from '../src/lib/lock'

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'automator-lock-'))
let counter = 0
const tmp = (): string => path.join(dir, `lock-${counter++}.lock`)

afterAll(() => fs.rmSync(dir, {recursive: true, force: true}))

describe('acquire / release', () => {
  it('acquires a free lock and writes the pidfile', () => {
    const file = tmp()
    expect(acquire(file, 'test')).toBe(true)
    expect(readLock(file)?.pid).toBe(process.pid)
  })

  it('fails if the lock is held by a live process', () => {
    const file = tmp()
    acquire(file, 'test')
    expect(acquire(file, 'test', () => true)).toBe(false)
  })

  it('steals a stale lock (dead pid)', () => {
    const file = tmp()
    fs.writeFileSync(file, JSON.stringify({pid: 999_999, startedAt: 'x', label: 'old'}))
    expect(acquire(file, 'test', () => false)).toBe(true)
    expect(readLock(file)?.pid).toBe(process.pid)
  })

  it('release removes the pidfile', () => {
    const file = tmp()
    acquire(file, 'test')
    release(file)
    expect(fs.existsSync(file)).toBe(false)
  })

  it('release is idempotent (missing file)', () => {
    expect(() => release(path.join(dir, 'mai-esistito.lock'))).not.toThrow()
  })
})

describe('readLock', () => {
  it('corrupted file → null', () => {
    const file = tmp()
    fs.writeFileSync(file, 'non json')
    expect(readLock(file)).toBeNull()
  })

  it('without a numeric pid field → null', () => {
    const file = tmp()
    fs.writeFileSync(file, JSON.stringify({label: 'x'}))
    expect(readLock(file)).toBeNull()
  })
})

describe('defaultIsAlive', () => {
  it('the current process is alive', () => {
    expect(defaultIsAlive(process.pid)).toBe(true)
  })

  it('a non-existent pid is dead', () => {
    expect(defaultIsAlive(2_147_483_646)).toBe(false)
  })
})
