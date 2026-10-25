import {loadSecureCredentialsConfig} from './config'
import {isOpenrouterToken} from './credential-format'
import {makeOrgSecret, type OrgSecretStore} from './org-secret'
import {clearOpenrouterCredential, loadOpenrouterCredential, saveOpenrouterCredential} from './secure-credentials'

// CYAU-228 — the OpenRouter key the organization lends to its machines. OpenCode reviews only with it: the machine
// has no OpenRouter sign-in of its own. It reaches the confined OpenCode review (as OPENROUTER_KEY_ENV) and nothing else.

export type OrgOpenrouterCredentialStore = OrgSecretStore

const openrouterKey = makeOrgSecret<string>({
  resource: 'openrouter_credential',
  parse: (token) => (isOpenrouterToken(token) ? token : undefined),
  tokenOf: (token) => token,
  store: {
    load: () => (loadSecureCredentialsConfig() ? loadOpenrouterCredential() : undefined),
    save: (token) => (loadSecureCredentialsConfig() ? saveOpenrouterCredential(token) : false),
    clear: () => (loadSecureCredentialsConfig() ? clearOpenrouterCredential() : false),
  },
  messages: {
    set: 'opencode: using the organization OpenRouter key for reviews',
    rotated: 'opencode: organization OpenRouter key rotated',
    removed: 'opencode: organization OpenRouter key removed',
  },
})

export const orgOpenrouterKey = openrouterKey.current
export const resetOrgOpenrouterKey = openrouterKey.reset
export const applyOrgOpenrouterKey = openrouterKey.apply
export const fetchOrgOpenrouterKey = openrouterKey.fetch
export const makeOrgOpenrouterKeyReconciler = openrouterKey.reconciler
