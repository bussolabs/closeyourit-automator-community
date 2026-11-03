// Translates the exit of a failed Claude/Codex session into a readable reason. Returns only fixed
// sentences or the error code: the raw text may contain secrets and never leaves this module.
import {detectQuotaLimit} from './agent-quota'

const SIGNALS: ReadonlyArray<[RegExp, string]> = [
  [/token_revoked|refresh token was revoked|refresh_token_invalidated|not logged in|please run \/login|\b401\b|unauthorized/i,
    'autenticazione scaduta o revocata'],
  [/\b429\b|rate.?limit|usage limit|quota/i, 'quota del modello esaurita'],
  [/model.*(requires a newer version|not supported|not found|does not exist)|does not support this model/i, 'modello non disponibile per questa CLI'],
]

export function describeRuntimeFailure(
  runtime: 'claude' | 'codex', output: string, errorCode: string | null, now: Date = new Date(),
): string {
  const match = SIGNALS.find(([pattern]) => pattern.test(output))
  // CYAU-275: a usage limit that names its reset keeps it, so the reason says when the engine works again.
  const quota = detectQuotaLimit(output, now)
  const reset = quota?.explicit ? `, reset ${quota.resetAt.toISOString()}` : ''
  return `${runtime}: ${match ? match[1] : errorCode ?? 'output non valido'}${reset}`
}
