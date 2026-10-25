import {loadSecureCredentialsConfig} from './config'
import {isClaudeToken} from './credential-format'
import {CLAUDE_LOCAL_AUTH_ENV} from './env-capabilities'
import {makeOrgSecret, type OrgSecretStore} from './org-secret'
import {clearClaudeCredential, loadClaudeCredential, saveClaudeCredential} from './secure-credentials'

/**
 * CYAU-224 — the Claude credential the organization lends to its machines. When set it wins over the machine's
 * own Claude sign-in; when absent the machine keeps its local credential. It reaches Claude sessions only.
 */
export interface OrgClaudeCredential {
  env: 'ANTHROPIC_API_KEY' | 'CLAUDE_CODE_OAUTH_TOKEN'
  token: string
}

export function parseOrgClaudeCredential(token: unknown): OrgClaudeCredential | undefined {
  if (!isClaudeToken(token)) return undefined
  return {env: token.startsWith('sk-ant-oat') ? 'CLAUDE_CODE_OAUTH_TOKEN' : 'ANTHROPIC_API_KEY', token}
}

export type OrgClaudeCredentialStore = OrgSecretStore

const claudeCredential = makeOrgSecret<OrgClaudeCredential>({
  resource: 'claude_credential',
  parse: parseOrgClaudeCredential,
  tokenOf: (credential) => credential.token,
  store: {
    load: () => (loadSecureCredentialsConfig() ? loadClaudeCredential() : undefined),
    save: (token) => (loadSecureCredentialsConfig() ? saveClaudeCredential(token) : false),
    clear: () => (loadSecureCredentialsConfig() ? clearClaudeCredential() : false),
  },
  messages: {
    set: 'claude: using the organization credential for Claude sessions',
    rotated: 'claude: organization credential rotated',
    removed: 'claude: organization credential removed, back to the machine sign-in',
  },
})

export const orgClaudeCredential = claudeCredential.current
export const resetOrgClaudeCredential = claudeCredential.reset
export const applyOrgClaudeCredential = claudeCredential.apply
export const fetchOrgClaudeCredential = claudeCredential.fetch
export const makeOrgClaudeCredentialReconciler = claudeCredential.reconciler

/**
 * Claude auth for one Claude session. The organization credential replaces every inherited Claude variable, so a
 * session never mixes two identities; without it the machine's durable credentials pass through as before.
 */
export function claudeAuthEnv(inherited: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const org = orgClaudeCredential()
  if (org) return {[org.env]: org.token}
  const env: NodeJS.ProcessEnv = {}
  for (const key of CLAUDE_LOCAL_AUTH_ENV) {
    const value = inherited[key]
    if (value) env[key] = value
  }

  return env
}
