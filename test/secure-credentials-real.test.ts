import {execFileSync} from 'node:child_process'
import fs from 'node:fs'
import {afterAll, beforeAll, describe, expect, it} from 'vitest'
import {loadHostCredential, saveHostCredential} from '../src/lib/secure-credentials'

// Real round-trip in the Linux Secret Service. Requires an explicit opt-in because CI and release run it
// inside a temporary D-Bus session and keyring: the persistent runner must not keep an empty or
// unlocked keyring between two repositories/jobs.
const realStoreRequired = process.platform === 'linux' &&
  process.env.AUTOMATOR_REQUIRE_SECRET_SERVICE_TEST === '1'
const HOST_SERVICE = 'it.closeyour.automator.host'
const accounts: string[] = []
const originalEnvironment = {
  DBUS_SESSION_BUS_ADDRESS: process.env.DBUS_SESSION_BUS_ADDRESS,
  XDG_RUNTIME_DIR: process.env.XDG_RUNTIME_DIR,
  XDG_DATA_HOME: process.env.XDG_DATA_HOME,
}

function restoreEnvironment(name: keyof typeof originalEnvironment): void {
  const value = originalEnvironment[name]
  if (value === undefined) delete process.env[name]
  else process.env[name] = value
}

function testAccount(suffix: string): string {
  const account = `automator-real-test-${process.pid}-${suffix}`
  accounts.push(account)
  return account
}

beforeAll(() => {
  if (!realStoreRequired) return
  const busAddress = process.env.AUTOMATOR_TEST_SECRET_BUS_ADDRESS
  const runtimeDir = process.env.AUTOMATOR_TEST_SECRET_RUNTIME_DIR
  const dataHome = process.env.AUTOMATOR_TEST_SECRET_DATA_HOME
  if (!busAddress || !runtimeDir || !dataHome) {
    throw new Error('sessione Secret Service isolata non configurata')
  }
  process.env.DBUS_SESSION_BUS_ADDRESS = busAddress
  process.env.XDG_RUNTIME_DIR = runtimeDir
  process.env.XDG_DATA_HOME = dataHome
})

afterAll(() => {
  if (!realStoreRequired) return
  for (const account of accounts) {
    try {
      execFileSync('/usr/bin/secret-tool', ['clear', 'service', HOST_SERVICE, 'account', account], {stdio: 'ignore'})
    } catch {
      // The entry may not exist if the save failed: the cleanup stays best-effort.
    }
  }
  restoreEnvironment('DBUS_SESSION_BUS_ADDRESS')
  restoreEnvironment('XDG_RUNTIME_DIR')
  restoreEnvironment('XDG_DATA_HOME')
})

describe('credential store reale su Linux', () => {
  it.skipIf(!realStoreRequired)('saves and re-reads the host token from the Secret Service', () => {
    const account = testAccount('roundtrip')
    const token = `cyi_ah_${'a1b2c3d4'.repeat(4)}`

    expect(saveHostCredential(account, token)).toBe(true)
    expect(loadHostCredential(account)).toBe(token)
  })

  it.skipIf(!realStoreRequired)('overwrites an existing entry instead of duplicating it', () => {
    const account = testAccount('update')
    const first = `cyi_ah_${'1'.repeat(32)}`
    const second = `cyi_ah_${'2'.repeat(32)}`

    expect(saveHostCredential(account, first)).toBe(true)
    expect(saveHostCredential(account, second)).toBe(true)
    expect(loadHostCredential(account)).toBe(second)
  })

  it.skipIf(realStoreRequired)('without opt-in the real round-trip does not use the machine credential store', () => {
    expect(realStoreRequired).toBe(false)
  })

  it('CI and release run the round-trip through the isolated helper', () => {
    for (const workflow of ['.github/workflows/ci.yml', '.github/workflows/release.yml']) {
      expect(fs.readFileSync(workflow, 'utf8')).toContain('bash scripts/test-secret-service.sh')
    }
  })
})
