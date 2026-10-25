import * as fs from 'node:fs'
import * as path from 'node:path'
import {describe, expect, it} from 'vitest'
import {isGitHubPrUrl} from '../src/lib/github-pr-url'

// CYAU-173 — the shape of a PR URL was judged by more than one party: a strict rule here and a loose one in the
// contract, which is the one the server uses. When two parties judge differently, the work is
// done in full and then thrown away at delivery, because one accepts what the other rejects. These tests
// read the pattern FROM THE VENDORED CONTRACT — not a hand-written copy here — and require the two
// outcomes to match: it is the only way they do not silently diverge again.

const CONTRACT = path.join(__dirname, 'contracts', 'agent-result', 'v1', 'schema.json')

function contractPattern(): {delivered: string; alreadyDelivered: string} {
  const schema = JSON.parse(fs.readFileSync(CONTRACT, 'utf8'))
  const branches = schema.$defs.autopilot_result.allOf ?? []
  const found: string[] = []
  const search = (node: unknown): void => {
    if (node === null || typeof node !== 'object') return
    const o = node as Record<string, unknown>
    const prUrl = (o.properties as Record<string, unknown> | undefined)?.prUrl as Record<string, unknown> | undefined
    if (typeof prUrl?.pattern === 'string') found.push(prUrl.pattern)
    for (const v of Object.values(o)) search(v)
  }
  search(branches.length > 0 ? branches : schema.$defs.autopilot_result)
  // Two branches, `delivered` and `already-delivered`: if the contract loses one, the remaining pattern
  // would protect half of the cases and the test below would not notice.
  expect(found).toHaveLength(2)
  return {delivered: found[0], alreadyDelivered: found[1]}
}

// The seven shapes of the ticket, plus the cases in which `new URL()` normalizes before judging: they are the ones where
// the local copy accepted what the contract rejects.
const CORPUS: Array<[string, string, boolean]> = [
  ['canonical github', 'https://github.com/bussolabs/closeyourit-rails/pull/123', true],
  ['GHES: no domain list', 'https://git.esempio.test/bussolabs/closeyourit-rails/pull/1', true],
  ['host with port', 'https://git.esempio.test:8443/bussolabs/repo/pull/42', true],
  ['long number', 'https://github.com/a/b/pull/1234567', true],

  ['without owner and repo', 'https://github.com/pull/123', false],
  ['with credentials', 'https://alessio:segreto@github.com/bussolabs/closeyourit-rails/pull/123', false],
  ['zero number', 'https://github.com/bussolabs/closeyourit-rails/pull/0', false],
  ['number with leading zeros', 'https://github.com/bussolabs/closeyourit-rails/pull/007', false],
  ['pull in the middle of the path', 'https://github.com/bussolabs/closeyourit-rails/tree/main/pull/123', false],
  ['percent-encoded repo', 'https://github.com/bussolabs/closeyourit%2Drails/pull/123', false],
  ['any site embedding it', 'https://tracker.esempio.test/redirect/github.com/a/b/pull/123', false],

  ['trailing space', 'https://github.com/a/b/pull/1 ', false],
  ['trailing newline', 'https://github.com/a/b/pull/1\n', false],
  ['leading space', ' https://github.com/a/b/pull/1', false],
  ['tab inside the path', 'https://github.com/a\tb/c/pull/1', false],
  ['.. segment', 'https://github.com/a/../pull/1', false],
  ['. segment', 'https://github.com/./b/pull/1', false],
  ['uppercase scheme', 'HTTPS://github.com/a/b/pull/1', false],
  ['http scheme', 'http://github.com/a/b/pull/1', false],
  ['with query', 'https://github.com/a/b/pull/1?x=1', false],
  ['with hash', 'https://github.com/a/b/pull/1#diff', false],
  ['trailing slash', 'https://github.com/a/b/pull/1/', false],
  ['double slash', 'https://github.com//b/pull/1', false],
  ['missing number', 'https://github.com/a/b/pull/', false],
  ['empty string', '', false],
  ['not a URL', 'x', false],
]

describe('isGitHubPrUrl — the shape GitHub could have produced', () => {
  it.each(CORPUS)('%s', (_label, url, expected) => {
    expect(isGitHubPrUrl(url)).toBe(expected)
  })
})

describe('a single judge: the local copy and the vendored contract cannot diverge', () => {
  const {delivered, alreadyDelivered} = contractPattern()

  it('the two contract branches carry the same pattern', () => {
    expect(delivered).toBe(alreadyDelivered)
  })

  it.each(CORPUS)('%s: contract and code give the same outcome', (_label, url) => {
    // `new RegExp` without flags = ECMA-262 semantics, the same the contract declares.
    expect(new RegExp(delivered).test(url)).toBe(isGitHubPrUrl(url))
  })

  // The "good" shape must stay good even after a tightening round: a pattern that rejects everything
  // would pass every line above except this one.
  it('the contract pattern has not become a closed door', () => {
    expect(new RegExp(delivered).test('https://github.com/bussolabs/closeyourit-rails/pull/123')).toBe(true)
  })
})
