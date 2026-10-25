import {AutomatorError} from '../errors/error-codes'

export interface RemoteCommandFailure {
  status: number | null
  stdout: string
  stderr: string
}

/** Only explicit network/timeout/rate-limit/5xx signals are retryable; auth, policy and reject stay blocking. */
export function isRetryableRemoteFailure(outcome: RemoteCommandFailure): boolean {
  const detail = `${outcome.stderr}\n${outcome.stdout}`
  return /\b(?:ETIMEDOUT|EAI_AGAIN|ENOTFOUND|EPIPE|ECONNRESET|ECONNREFUSED|ENETUNREACH|EHOSTUNREACH)\b/i.test(detail) ||
    /(?:timed?\s*out|temporarily unavailable|could not resolve host|connection (?:reset|refused)|network is unreachable|TLS handshake timeout|socket (?:hang up|closed|ended)|error connecting to|rate limit exceeded)/i.test(detail) ||
    /\b(?:C(?:429|5\d\d)-[A-Z0-9-]+|HTTP\s*(?:429|5\d\d)|status(?:\s+code)?\s*(?:429|5\d\d))\b/i.test(detail)
}

export function remoteCommandError(code: string, message: string, outcome: RemoteCommandFailure): AutomatorError {
  return isRetryableRemoteFailure(outcome)
    ? new RetryableDeliveryError(code, message)
    : new AutomatorError(code, message, 1)
}

/**
 * A remote delivery effect failed without invalidating the local attestations. Only this class enables
 * the retry from `in_review`: local Git errors, TOCTOU, policy and persistence stay blocking integrity errors.
 */
export class RetryableDeliveryError extends AutomatorError {
  constructor(code: string, message: string) {
    super(code, message, 1)
    this.name = 'RetryableDeliveryError'
  }
}
