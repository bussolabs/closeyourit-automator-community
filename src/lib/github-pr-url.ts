import {z} from 'zod'

/**
 * Canonical shape of a PR URL, IDENTICAL to the pattern of the vendored contract
 * (`test/contracts/agent-result/v1/schema.json`, `delivery.prUrl` in both branches).
 *
 * CYAU-173 — this constant and that pattern must stay the same rule. When two parties judge
 * differently, the work is done in full and then thrown away at delivery: one accepts what
 * the other rejects. `github-pr-url.test.ts` reads the pattern from the contract and checks that the two outcomes
 * match on a corpus of crooked shapes, so the copy cannot silently diverge.
 *
 * No allow-list of domains: GitHub Enterprise has its own hosts and must be served.
 */
const CANONICO = /^https:\/\/[^/?#@\s]+\/(?!\.\.?\/)[^/?#%\s]+\/(?!\.\.?\/)[^/?#%\s]+\/pull\/[1-9][0-9]*$/u

/** Canonical URL produced by GitHub/GHES: HTTPS, no credentials/query/hash, `<owner>/<repo>/pull/<id>`. */
export function isGitHubPrUrl(value: string): boolean {
  // The check on the RAW string comes first, and it is not redundant: `new URL()` normalizes before
  // answering — it trims spaces and newlines at the edges, resolves `..`, lowercases the scheme, drops inner tabs.
  // Judging only the normalized object accepted five shapes the contract rejects, and they are
  // exactly those that got the delivery rejected after the work had already been done.
  if (!CANONICO.test(value)) return false
  try {
    const url = new URL(value)
    return url.protocol === 'https:' && url.username === '' && url.password === '' &&
      url.search === '' && url.hash === '' &&
      /^\/[^/%]+\/[^/%]+\/pull\/[1-9]\d*$/.test(url.pathname)
  } catch {
    return false
  }
}

export const GitHubPrUrlSchema = z.string().refine(isGitHubPrUrl, 'URL PR GitHub non valido')
