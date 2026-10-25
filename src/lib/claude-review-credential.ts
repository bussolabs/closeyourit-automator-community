import {readFileSync} from 'node:fs'
import {homedir} from 'node:os'
import {isAbsolute, join} from 'node:path'
import {CLAUDE_LOCAL_AUTH_ENV} from './env-capabilities'
import {orgClaudeCredential} from './org-claude-credential'

/** Claude auth variables the confined review may receive; the session token is one Claude Code itself exports. */
export const CLAUDE_REVIEW_AUTH_ENV = [...CLAUDE_LOCAL_AUTH_ENV, 'CLAUDE_CODE_SESSION_ACCESS_TOKEN'] as const

/** A token this close to its expiry would die during the review: it already counts as expired. */
const EXPIRY_MARGIN_MS = 60_000

export type ClaudeReviewCredential =
  | {status: 'valid'; source: 'organization' | 'environment'; env: Record<string, string>}
  | {status: 'valid'; source: 'machine'; env: Record<string, string>; expiresAt: number}
  | {status: 'expired'; source: 'machine'; env: Record<string, never>; expiresAt: number}
  | {status: 'missing'; source: null; env: Record<string, never>}

export interface ClaudeReviewCredentialOptions {
  env?: NodeJS.ProcessEnv
  now?: () => number
  readFile?: (path: string) => string
}

/** Where `claude login` keeps the machine sign-in: `$CLAUDE_CONFIG_DIR/.credentials.json`, by default under `~/.claude`. */
export function claudeCredentialsPath(env: NodeJS.ProcessEnv = process.env): string {
  const configDir = env.CLAUDE_CONFIG_DIR && isAbsolute(env.CLAUDE_CONFIG_DIR)
    ? env.CLAUDE_CONFIG_DIR
    : join(env.HOME && isAbsolute(env.HOME) ? env.HOME : homedir(), '.claude')
  return join(configDir, '.credentials.json')
}

/**
 * CYAU-223 — the one place that decides how the confined Claude review signs in. The review runs with an empty home,
 * so the machine sign-in is invisible to it. Same order as the work sessions: the organization credential, then a
 * token already in the service environment, then the machine sign-in — of which only the short-lived access token is
 * taken. The refresh token never leaves the file and nothing is written back: the machine stays the only one that
 * renews its sign-in. File contents and parse errors never reach a message, so no token can end up in a log.
 */
export function resolveClaudeReviewCredential(options: ClaudeReviewCredentialOptions = {}): ClaudeReviewCredential {
  const org = orgClaudeCredential()
  if (org) return {status: 'valid', source: 'organization', env: {[org.env]: org.token}}

  const source = options.env ?? process.env
  const inherited: Record<string, string> = {}
  for (const key of CLAUDE_REVIEW_AUTH_ENV) {
    const value = source[key]
    if (value) inherited[key] = value
  }
  if (Object.keys(inherited).length > 0) return {status: 'valid', source: 'environment', env: inherited}

  const readFile = options.readFile ?? ((file: string) => readFileSync(file, 'utf8'))
  let oauth: unknown
  try {
    const parsed = JSON.parse(readFile(claudeCredentialsPath(source))) as {claudeAiOauth?: unknown} | null
    oauth = parsed?.claudeAiOauth
  } catch {
    return {status: 'missing', source: null, env: {}}
  }
  const {accessToken, expiresAt} = (oauth ?? {}) as {accessToken?: unknown; expiresAt?: unknown}
  if (typeof accessToken !== 'string' || !/^[\w.-]+$/.test(accessToken)) return {status: 'missing', source: null, env: {}}
  if (typeof expiresAt !== 'number' || !Number.isFinite(expiresAt)) return {status: 'missing', source: null, env: {}}
  if (expiresAt - EXPIRY_MARGIN_MS <= (options.now ?? Date.now)()) return {status: 'expired', source: 'machine', env: {}, expiresAt}
  return {status: 'valid', source: 'machine', env: {CLAUDE_CODE_OAUTH_TOKEN: accessToken}, expiresAt}
}

/** Remedy shared by the review and doctor: the reason, then the two ways out. Never carries a token. */
export function claudeReviewCredentialProblem(credential: ClaudeReviewCredential): string | undefined {
  if (credential.status === 'valid') return undefined
  const orOrganization = 'or have the owner set the organization Claude credential in CloseYourIt → Agents.'
  return credential.status === 'expired'
    ? `the Claude sign-in of this machine expired on ${new Date(credential.expiresAt).toISOString()}. `
      + `Start 'claude' once as the service user to renew it (or run 'claude login' again), ${orOrganization}`
    : 'the Claude review has no credential: no organization credential, no Claude token in the service environment '
      + `and no 'claude login' on this machine. Run 'claude login' as the service user, ${orOrganization}`
}
