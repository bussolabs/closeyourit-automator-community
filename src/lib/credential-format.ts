export const HOST_TOKEN_PREFIX = 'cyi_ah_'

export function isOrgToken(value: unknown): value is string {
  return typeof value === 'string' && /^cyi_a_[A-Za-z0-9]+$/.test(value)
}

/** Automator Agent Host credential; `cyi_h_` is the distinct Server Host token and is not accepted. */
export function isHostToken(value: unknown): value is string {
  return typeof value === 'string' && /^cyi_ah_[A-Za-z0-9]+$/.test(value)
}

/** Account-proxy CLI token used by CloseYourIt service accounts for the vault. */
export function isUserToken(value: unknown): value is string {
  return typeof value === 'string' && /^cyi_u_[A-Za-z0-9]+$/.test(value)
}

/** CYAU-224: an Anthropic API key (`sk-ant-api…`) or a `claude setup-token` OAuth token (`sk-ant-oat…`). */
export function isClaudeToken(value: unknown): value is string {
  return typeof value === 'string' && /^sk-ant-(api|oat)[A-Za-z0-9_-]+$/.test(value)
}

/** CYAU-228: the organization's OpenRouter key (`sk-or-…`), which OpenCode reviews with. */
export function isOpenrouterToken(value: unknown): value is string {
  return typeof value === 'string' && /^sk-or-[A-Za-z0-9_-]+$/.test(value)
}
