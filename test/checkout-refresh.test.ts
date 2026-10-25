import {spawnSync} from 'node:child_process'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import {afterEach, beforeEach, describe, expect, it} from 'vitest'
import {refreshReadOnlyCheckout} from '../src/lib/checkout-refresh'

function git(cwd: string, ...args: string[]): string {
  const res = spawnSync('git', args, {cwd, encoding: 'utf8', env: {...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1'}})
  if (res.status !== 0) throw new Error(`git ${args.join(' ')}: ${res.stderr}`)
  return res.stdout.trim()
}

function commit(cwd: string, file: string, content: string): string {
  fs.writeFileSync(path.join(cwd, file), content)
  git(cwd, 'add', file)
  git(cwd, '-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-q', '-m', file)
  return git(cwd, 'rev-parse', 'HEAD')
}

describe('refreshReadOnlyCheckout', () => {
  let root: string
  let upstream: string
  let checkout: string

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'automator-refresh-'))
    upstream = path.join(root, 'upstream')
    checkout = path.join(root, 'checkout')
    fs.mkdirSync(upstream)
    git(upstream, 'init', '-q', '-b', 'main')
    commit(upstream, 'README.md', 'v1\n')
    git(root, 'clone', '-q', upstream, checkout)
  })

  afterEach(() => {
    fs.rmSync(root, {recursive: true, force: true})
  })

  it('fast-forwards the default branch to the remote head', () => {
    const head = commit(upstream, 'README.md', 'v2\n')

    const result = refreshReadOnlyCheckout(checkout)

    expect(result.outcome).toBe('fast-forwarded')
    expect(git(checkout, 'rev-parse', 'HEAD')).toBe(head)
  })

  it('reports up-to-date when nothing changed upstream', () => {
    expect(refreshReadOnlyCheckout(checkout).outcome).toBe('up-to-date')
  })

  it('keeps an unrelated local change while fast-forwarding', () => {
    commit(upstream, 'other.md', 'x\n')
    fs.writeFileSync(path.join(checkout, 'README.md'), 'local edit\n')

    const result = refreshReadOnlyCheckout(checkout)

    expect(result.outcome).toBe('fast-forwarded')
    expect(fs.readFileSync(path.join(checkout, 'README.md'), 'utf8')).toBe('local edit\n')
  })

  it('never overwrites a local change that the remote also touched', () => {
    commit(upstream, 'README.md', 'v2\n')
    fs.writeFileSync(path.join(checkout, 'README.md'), 'local edit\n')

    const result = refreshReadOnlyCheckout(checkout)

    expect(result.outcome).toBe('not-fast-forwardable')
    expect(fs.readFileSync(path.join(checkout, 'README.md'), 'utf8')).toBe('local edit\n')
  })

  it('does not move a checkout that sits on another branch', () => {
    commit(upstream, 'README.md', 'v2\n')
    git(checkout, 'checkout', '-q', '-b', 'topic')
    const before = git(checkout, 'rev-parse', 'HEAD')

    const result = refreshReadOnlyCheckout(checkout)

    expect(result.outcome).toBe('not-on-default')
    expect(git(checkout, 'rev-parse', 'HEAD')).toBe(before)
  })

  it('reports a failed fetch without throwing', () => {
    fs.rmSync(upstream, {recursive: true, force: true})

    expect(refreshReadOnlyCheckout(checkout).outcome).toBe('fetch-failed')
  })
})
