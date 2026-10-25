import * as path from 'node:path'
import {afterEach, beforeEach, describe, expect, it} from 'vitest'
import {
  claudeCredentialsPath,
  claudeReviewCredentialProblem,
  resolveClaudeReviewCredential,
} from '../src/lib/claude-review-credential'
import {resetOrgClaudeCredential} from '../src/lib/org-claude-credential'
import {redactSecrets} from '../src/lib/secret-redaction'

const NOW = 1_800_000_000_000
const ACCESS = 'sk-ant-oat01-machine-access'
const REFRESH = 'sk-ant-ort01-machine-refresh'

function signedIn(expiresAt: number, extra: Record<string, unknown> = {}): (file: string) => string {
  return () => JSON.stringify({claudeAiOauth: {accessToken: ACCESS, refreshToken: REFRESH, expiresAt, ...extra}})
}

const noFile = (): string => {
  throw new Error('ENOENT')
}

beforeEach(() => resetOrgClaudeCredential({load: () => undefined, save: () => true, clear: () => true}))
afterEach(() => resetOrgClaudeCredential())

describe('resolveClaudeReviewCredential (CYAU-223)', () => {
  it('prefers the organization credential over the environment and the machine sign-in', () => {
    resetOrgClaudeCredential({load: () => 'sk-ant-api03-org', save: () => true, clear: () => true})
    const credential = resolveClaudeReviewCredential({
      env: {CLAUDE_CODE_OAUTH_TOKEN: 'sk-ant-oat01-env'}, readFile: signedIn(NOW + 3_600_000), now: () => NOW,
    })
    expect(credential).toEqual({status: 'valid', source: 'organization', env: {ANTHROPIC_API_KEY: 'sk-ant-api03-org'}})
  })

  it('then takes the Claude tokens of the service environment, without reading the machine sign-in', () => {
    let read = false
    const credential = resolveClaudeReviewCredential({
      env: {CLAUDE_CODE_OAUTH_TOKEN: 'sk-ant-oat01-env', GH_TOKEN: 'foreign'},
      readFile: () => { read = true; return '' },
    })
    expect(credential).toEqual({status: 'valid', source: 'environment', env: {CLAUDE_CODE_OAUTH_TOKEN: 'sk-ant-oat01-env'}})
    expect(read).toBe(false)
  })

  it('falls back to the access token of the machine sign-in, leaving the refresh token behind', () => {
    const credential = resolveClaudeReviewCredential({env: {HOME: '/home/u'}, readFile: signedIn(NOW + 3_600_000), now: () => NOW})
    expect(credential).toEqual({
      status: 'valid', source: 'machine', env: {CLAUDE_CODE_OAUTH_TOKEN: ACCESS}, expiresAt: NOW + 3_600_000,
    })
    expect(JSON.stringify(credential)).not.toContain(REFRESH)
  })

  it('reports an expired machine sign-in with its expiry and without any token', () => {
    const credential = resolveClaudeReviewCredential({env: {HOME: '/home/u'}, readFile: signedIn(NOW - 1000), now: () => NOW})
    expect(credential).toEqual({status: 'expired', source: 'machine', env: {}, expiresAt: NOW - 1000})
    const problem = claudeReviewCredentialProblem(credential) as string
    expect(problem).toContain('expired on 2027-01-15T07:59:59.000Z')
    expect(problem).not.toContain(ACCESS)
  })

  it('counts a token about to expire as already expired, so it does not die during the review', () => {
    expect(resolveClaudeReviewCredential({env: {HOME: '/home/u'}, readFile: signedIn(NOW + 30_000), now: () => NOW}).status)
      .toBe('expired')
  })

  it('reports the sign-in as missing when the file is absent, malformed or without a usable token', () => {
    for (const readFile of [
      noFile,
      () => `{"claudeAiOauth": {"accessToken": "${ACCESS}"`,
      () => JSON.stringify({claudeAiOauth: {refreshToken: REFRESH, expiresAt: NOW + 3_600_000}}),
      () => JSON.stringify({claudeAiOauth: {accessToken: ACCESS, expiresAt: 'tomorrow'}}),
      () => 'null',
    ]) {
      const credential = resolveClaudeReviewCredential({env: {HOME: '/home/u'}, readFile, now: () => NOW})
      expect(credential).toEqual({status: 'missing', source: null, env: {}})
      expect(claudeReviewCredentialProblem(credential)).toContain('no credential')
    }
  })

  it('reads the sign-in from CLAUDE_CONFIG_DIR when set, otherwise from ~/.claude', () => {
    expect(claudeCredentialsPath({HOME: '/home/u'})).toBe(path.join('/home/u', '.claude', '.credentials.json'))
    expect(claudeCredentialsPath({HOME: '/home/u', CLAUDE_CONFIG_DIR: '/srv/claude'}))
      .toBe(path.join('/srv/claude', '.credentials.json'))
    expect(claudeCredentialsPath({HOME: '/home/u', CLAUDE_CONFIG_DIR: 'relative'}))
      .toBe(path.join('/home/u', '.claude', '.credentials.json'))
    const files: string[] = []
    resolveClaudeReviewCredential({env: {CLAUDE_CONFIG_DIR: '/srv/claude'}, readFile: (file) => { files.push(file); return '' }})
    expect(files).toEqual([path.join('/srv/claude', '.credentials.json')])
  })

  it('has no problem to report for a valid credential', () => {
    expect(claudeReviewCredentialProblem(resolveClaudeReviewCredential({env: {ANTHROPIC_API_KEY: 'sk-ant-api03-x'}}))).toBeUndefined()
  })

  it('the tokens of the machine sign-in never survive the log redaction', () => {
    const line = `review env CLAUDE_CODE_OAUTH_TOKEN=${ACCESS} file ${signedIn(NOW)('')}`
    expect(redactSecrets(line)).not.toContain(ACCESS)
    expect(redactSecrets(line)).not.toContain(REFRESH)
  })
})
