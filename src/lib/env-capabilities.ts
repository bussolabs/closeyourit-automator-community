/** Opaque capabilities available to the engine: they are not a ProcessEnv and are materialized per action. */
export interface SecretCapabilities {
  /**
   * `cyi_u_` token of this machine's SERVICE ACCOUNT (CYAU-108) — the same credential store credential
   * that authorizes the host registration. The agent sessions need it: the skills read the ticket,
   * post the clarification comment and compose the result with `cyi`, and without this credential they use
   * the identity `cyi login` left on disk, i.e. necessarily that of a PERSON — with their
   * permissions and their name in the audit. A service account cannot do the device flow (no web login), and
   * the service environment is a closed allowlist: this is the only way.
   */
  cyiAuth?: string
  /** CYAU-248 — GitHub token valid one hour for the repository of the ticket being worked, minted by the server. */
  githubToken?: string
}

/**
 * Variables that carry Claude's auth (subscription via setup-token, or API key). They come either from the service
 * environment or, when the organization lends one (CYAU-224), from `org-claude-credential.ts`: in both cases they
 * reach Claude sessions only, never the other actions. The confined Claude review, which cannot see the machine home,
 * may also receive the short-lived access token of `claude login` (CYAU-223, `claude-review-credential.ts`).
 */
export const CLAUDE_LOCAL_AUTH_ENV = ['CLAUDE_CODE_OAUTH_TOKEN', 'ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN'] as const

/**
 * Variable with which the `cyi` CLI accepts an identity without device flow: it is the service token channel
 * (CYAU-108). It lives among the MANAGED ones because it must never be inherited by the back door — only the action
 * that needs it receives it, and `on_failure` (shell) loses it like the others.
 */
export const CYI_AUTH_ENV = 'CLOSEYOURIT_TOKEN'

/** Env names reserved for capabilities: single source for playbook validation and runtime sanitization. */
const RETIRED_VAULT_TOKEN_ENV = ['DOP', 'PLER_TOKEN'].join('')
/** CYAU-228 — the organization's OpenRouter key: only the confined OpenCode review receives it. */
export const OPENROUTER_KEY_ENV = 'OPENROUTER_API_KEY'

/** CYAU-248 — the variables gh reads a token from: only the server-minted ticket token may fill them. */
export const GITHUB_TOKEN_ENV = 'GH_TOKEN'
const GITHUB_TOKEN_ENVS = [GITHUB_TOKEN_ENV, 'GITHUB_TOKEN', 'GH_ENTERPRISE_TOKEN', 'GITHUB_ENTERPRISE_TOKEN'] as const

export const MANAGED_SECRET_ENV = [
  ...CLAUDE_LOCAL_AUTH_ENV, RETIRED_VAULT_TOKEN_ENV, CYI_AUTH_ENV, OPENROUTER_KEY_ENV, ...GITHUB_TOKEN_ENVS,
] as const

const managedSecretEnv = new Set<string>(MANAGED_SECRET_ENV)

/** Case-insensitive comparison to keep the same policy in the Windows environment too. */
export function isManagedSecretEnv(name: string): boolean {
  return managedSecretEnv.has(name.toUpperCase())
}
