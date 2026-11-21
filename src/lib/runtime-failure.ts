// Translates the exit of a failed Claude/Codex session into a readable reason. Returns only fixed
// sentences or the error code: the raw text may contain secrets and never leaves this module.
import {type QuotaLimit} from './agent-quota'

/** A sign-in that expired or was revoked: nothing runs again until a person signs in. */
const CREDENTIAL_SIGNAL =
  /token_revoked|refresh token was revoked|refresh_token_invalidated|not logged in|please run \/login|\b401\b|unauthorized/i

const SIGNALS: ReadonlyArray<[RegExp, string]> = [
  [CREDENTIAL_SIGNAL, 'autenticazione scaduta o revocata'],
  [/\b429\b|rate.?limit|usage limit|quota/i, 'quota del modello esaurita'],
  [/model.*(requires a newer version|not supported|not found|does not exist)|does not support this model/i, 'modello non disponibile per questa CLI'],
]

export function describeRuntimeFailure(
  runtime: 'claude' | 'codex', output: string, errorCode: string | null, _now: Date = new Date(), quota?: QuotaLimit,
): string {
  const match = SIGNALS.find(([pattern]) => pattern.test(output))
  // CYAU-275: a usage limit that names its reset keeps it, so the reason says when the engine works again.
  const reset = quota?.explicit ? `, reset ${quota.resetAt.toISOString()}` : ''
  return `${runtime}: ${quota ? 'quota del modello esaurita' : match ? match[1] : errorCode ?? 'output non valido'}${reset}`
}

/**
 * CYAU-335 — true when the session failed on its sign-in. Starting it again would meet the same wall, so the
 * caller must not spend another session on it: the machine simply cannot review until someone signs in.
 */
export function isRuntimeCredentialFailure(output: string): boolean {
  return CREDENTIAL_SIGNAL.test(output)
}
