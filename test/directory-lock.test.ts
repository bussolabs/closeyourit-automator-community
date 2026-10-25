import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import {describe, expect, it} from 'vitest'
import {
  directoryLockOwnerName,
  lockProcessIdentity,
  parseDirectoryLockOwner,
  prepareDirectoryLockClaim,
  processStartIdentity,
  releaseDirectoryLock,
} from '../src/lib/directory-lock'

describe('directory lock — identity and atomic publication', () => {
  it('serializes and re-reads an owner without losing pid or identity', () => {
    const name = directoryLockOwnerName(42, 'linux:12345', 'generation')
    expect(parseDirectoryLockOwner(name)).toEqual({pid: 42, identity: 'linux:12345'})
  })

  it.each([
    '',
    '1~~generation',
    '1~bGludXg6MQ~',
    '0~bGludXg6MQ~generation',
    '1~bGludXg6MQ==~generation',
  ])('rejects malformed or non-canonical owners: %s', (name) => {
    expect(parseDirectoryLockOwner(name)).toBeNull()
  })

  it('rejects invalid pids and reuses the stable identity of the current process', () => {
    expect(processStartIdentity(0)).toBeNull()
    expect(lockProcessIdentity(0)).toBeNull()
    const first = lockProcessIdentity(process.pid)
    expect(lockProcessIdentity(process.pid)).toBe(first)
    if (process.platform === 'linux') expect(first).toMatch(/^linux:\d+$/u)
  })

  it('publishes, keeps and releases only its own generation', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'automator-directory-lock-'))
    const lockDir = path.join(root, 'resource.lock')
    const owner = directoryLockOwnerName(process.pid, 'test:owner', 'owned')
    try {
      const claim = prepareDirectoryLockClaim(lockDir, owner)
      expect(claim.publish()).toBe(true)
      claim.discard()
      expect(fs.existsSync(path.join(lockDir, owner))).toBe(true)

      releaseDirectoryLock(lockDir, owner)
      expect(fs.existsSync(lockDir)).toBe(false)
      expect(() => releaseDirectoryLock(lockDir, owner)).not.toThrow()
    } finally {
      fs.rmSync(root, {recursive: true, force: true})
    }
  })

  it('cleanly loses the race against an already published lock', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'automator-directory-lock-'))
    const lockDir = path.join(root, 'resource.lock')
    const successor = directoryLockOwnerName(99, 'test:successor', 'successor')
    try {
      const claim = prepareDirectoryLockClaim(lockDir, '1~dGVzdDpjbGFpbQ~claim')
      fs.mkdirSync(path.join(lockDir, successor), {recursive: true})
      expect(claim.publish()).toBe(false)
      expect(fs.readdirSync(root)).toEqual(['resource.lock'])

      releaseDirectoryLock(lockDir, 'owner-diverso')
      expect(fs.existsSync(path.join(lockDir, successor))).toBe(true)
    } finally {
      fs.rmSync(root, {recursive: true, force: true})
    }
  })

  it('discards an unpublished claim and cleans up an incomplete preparation', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'automator-directory-lock-'))
    try {
      const claim = prepareDirectoryLockClaim(path.join(root, 'discard.lock'), '1~dGVzdA~discard')
      claim.discard()
      expect(fs.readdirSync(root)).toEqual([])

      expect(() => prepareDirectoryLockClaim(path.join(root, 'invalid.lock'), 'nested/owner')).toThrow()
      expect(fs.readdirSync(root)).toEqual([])
    } finally {
      fs.rmSync(root, {recursive: true, force: true})
    }
  })
})
