import {mkdtempSync, readFileSync, rmSync} from 'node:fs'
import {tmpdir} from 'node:os'
import {join} from 'node:path'
import {afterEach, describe, expect, it} from 'vitest'
import {lookupIsolated} from '../src/lib/isolated-lookup'

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

// CYAU-238 — the lookup runs in a child killed at the deadline: no getaddrinfo request survives in doctor's process.
describe('lookupIsolated', () => {
  let dir: string | undefined
  afterEach(() => {
    if (dir) rmSync(dir, {recursive: true, force: true})
    dir = undefined
  })

  it('resolves a name through the system resolver', async () => {
    const addresses = await lookupIsolated('localhost', 5000)

    expect(addresses.length).toBeGreaterThan(0)
    expect(addresses.map((entry) => entry.address)).toEqual(expect.arrayContaining([expect.stringMatching(/^(127\.|::1$)/)]))
  })

  it('passes the hostname to the child as its argument', async () => {
    const echo = "process.stdout.write(JSON.stringify([{address: process.argv[1], family: 4}, {nope: true}]))"

    expect(await lookupIsolated('cyi.lan', 5000, echo)).toEqual([{address: 'cyi.lan', family: 4}])
  })

  it('kills a lookup that does not answer by the deadline: the child process is gone when it rejects', async () => {
    dir = mkdtempSync(join(tmpdir(), 'cyau-238-'))
    const pidFile = join(dir, 'pid')
    const hang = `require('node:fs').writeFileSync(${JSON.stringify(pidFile)}, String(process.pid)); setInterval(() => {}, 1000)`
    const started = Date.now()

    await expect(lookupIsolated('cyi.lan', 500, hang)).rejects.toThrow('no answer within 0.5s')

    expect(Date.now() - started).toBeLessThan(3000)
    const pid = Number(readFileSync(pidFile, 'utf8'))
    expect(pid).toBeGreaterThan(0)
    expect(isAlive(pid)).toBe(false)
  })

  it('rejects with the resolver error', async () => {
    const fail = "process.stderr.write('getaddrinfo ENOTFOUND cyi.lan'); process.exit(2)"

    await expect(lookupIsolated('cyi.lan', 5000, fail)).rejects.toThrow('getaddrinfo ENOTFOUND cyi.lan')
  })

  it('rejects a child that fails without saying why', async () => {
    await expect(lookupIsolated('cyi.lan', 5000, 'process.exit(3)')).rejects.toThrow(/Command failed/)
  })

  it('rejects an answer it cannot read', async () => {
    await expect(lookupIsolated('cyi.lan', 5000, "process.stdout.write('{}')")).rejects.toThrow('unreadable lookup answer')
    await expect(lookupIsolated('cyi.lan', 5000, "process.stdout.write('nope')")).rejects.toThrow('unreadable lookup answer')
  })
})
