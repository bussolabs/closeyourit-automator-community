import {MANAGED_SECRET_ENV} from './env-capabilities'

/**
 * Builds the CloseYourIt token matcher without enumerating the current namespaces. Both the ingest token
 * without namespace (`cyi_<payload>`) and lowercase namespaces of one or more letters
 * (`cyi_u_`, `cyi_a_`, `cyi_ah_`, ...) are allowed. The payload must start with an alphanumeric: placeholders like
 * `cyi_ah_…`, `cyi_ah_...` or `cyi_ah_<token>` stay documentable.
 */
export function closeYourItTokenRegex(minPayloadLength: number, flags = ''): RegExp {
  if (!Number.isInteger(minPayloadLength) || minPayloadLength < 1) {
    throw new RangeError('minPayloadLength deve essere un intero positivo')
  }
  const tailLength = minPayloadLength - 1
  return new RegExp(
    `(?<![A-Za-z0-9])cyi_(?:[a-z]+_)?[A-Za-z0-9][A-Za-z0-9_-]{${tailLength},}\\b`,
    flags,
  )
}

/** Agent Host contract matcher: the operational payload can be as short as a single character. */
export function agentHostTokenRegex(flags = ''): RegExp {
  return new RegExp('(?<![A-Za-z0-9])cyi_ah_[A-Za-z0-9]+\\b', flags)
}

/**
 * A high-confidence secret shape: an inspectable name + the regex that recognises it. It is the type
 * shared between log redaction (below) and the anti-secret gate of `publish.ts`.
 */
export interface SecretPattern {
  name: string
  regex: RegExp
}

/**
 * HIGH-confidence credential shapes — PEM private key, cloud credentials (AWS/Google), session
 * tokens (Slack/JWT) — defined HERE only once (CYAU-113). They used to live only in the publication gate
 * (`publish.ts`): local logs left them in clear because their definition was weaker. Now there is
 * ONE single definition, shared by the two places, so they can no longer diverge. The regexes have no `g` flag
 * (usable with `.test()` without state): redaction derives the global variants in `RUNTIME_SECRET_PATTERNS`.
 */
export const CREDENTIAL_SECRET_PATTERNS: readonly SecretPattern[] = [
  // Redacts the WHOLE PEM block (header + key body up to `-----END … PRIVATE KEY-----`), not
  // only the header: in the logs the base64 body IS the secret and must not stay in clear. The final
  // group is optional, so a truncated block without END still makes at least the header disappear.
  {
    name: 'chiave privata PEM',
    regex: /-----BEGIN (?:[A-Z0-9]+ )*PRIVATE KEY-----(?:[\s\S]*?-----END (?:[A-Z0-9]+ )*PRIVATE KEY-----)?/,
  },
  {name: 'AWS access key id', regex: /\bAKIA[0-9A-Z]{16}\b/},
  {name: 'Google API key', regex: /\bAIza[0-9A-Za-z_-]{35}\b/},
  {name: 'Slack token', regex: /\bxox[baprs]-[A-Za-z0-9-]{10,}\b/},
  {name: 'JSON Web Token', regex: /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/},
]

/** Clones a regex forcing the `g` flag (idempotent): redaction replaces/scans ALL occurrences. */
function withGlobalFlag(regex: RegExp): RegExp {
  return new RegExp(regex.source, regex.flags.includes('g') ? regex.flags : `${regex.flags}g`)
}

const RUNTIME_SECRET_PATTERNS: readonly RegExp[] = [
  agentHostTokenRegex('g'),
  closeYourItTokenRegex(6, 'g'),
  // CYAU-248: GitHub installation tokens now carry `.` and `-`; stopping at the dot left most of one in the log.
  /\bgh[pousr]_[A-Za-z0-9_.-]{6,}\b/g,
  /\bgithub_pat_[A-Za-z0-9_]{6,}\b/g,
  /\bsk-[A-Za-z0-9_-]{6,}\b/g,
  /\bdp\.st\.[A-Za-z0-9_-]{6,}\b/g,
  // CYAU-112: the NAME=value pair is derived from MANAGED_SECRET_ENV, not rewritten by hand. The list used to be
  // duplicated here and knew only the retired provider: the vault credential in use (CLOSEYOURIT_TOKEN)
  // stayed out, and its value survived in the logs as soon as it did not have the expected `cyi_…` shape.
  // CYAU-266: blanks only, never a line break, around `=`/`:` — an empty `NAME=` must not swallow the next line.
  new RegExp(`\\b(${MANAGED_SECRET_ENV.join('|')})[ \\t]*[=:][ \\t]*\\S+`, 'gi'),
  // CYAU-113: the same shapes known to the publication gate, so the logs no longer leave them in clear.
  ...CREDENTIAL_SECRET_PATTERNS.map((pattern) => withGlobalFlag(pattern.regex)),
]

interface SecretRange {
  start: number
  end: number
}

function mergeSecretRanges(ranges: SecretRange[]): SecretRange[] {
  const sorted = ranges.sort((a, b) => a.start - b.start || a.end - b.end)
  const merged: SecretRange[] = []
  for (const range of sorted) {
    const previous = merged.at(-1)
    if (previous && range.start <= previous.end) previous.end = Math.max(previous.end, range.end)
    else merged.push({...range})
  }
  return merged
}

function secretRanges(text: string, previous: string, forcedTailLength = 0): SecretRange[] {
  const left = previous === '' ? '' : previous.at(-1) ?? ''
  const combined = `${left}${text}`
  const ranges: SecretRange[] = []

  for (const pattern of RUNTIME_SECRET_PATTERNS) {
    const matcher = new RegExp(pattern.source, pattern.flags.includes('g') ? pattern.flags : `${pattern.flags}g`)
    for (const match of combined.matchAll(matcher)) {
      const start = (match.index ?? 0) - left.length
      const end = start + match[0].length
      if (start >= 0 && end > start) ranges.push({start, end})
    }
  }

  if (forcedTailLength > 0) ranges.push({start: Math.max(0, text.length - forcedTailLength), end: text.length})
  return mergeSecretRanges(ranges)
}

/**
 * Redacts a sequence of chunks of the same stream keeping the output attached to the chunk where the secret
 * begins. The logger needs it to rebuild the global order without ever concatenating stdout and stderr together.
 */
export function redactSecretChunks(chunks: readonly string[], previous = '', forcedTailLength = 0): string[] {
  const text = chunks.join('')
  const ranges = secretRanges(text, previous, forcedTailLength)
  const output = chunks.map(() => '')
  let offset = 0

  for (const [index, chunk] of chunks.entries()) {
    const start = offset
    const end = start + chunk.length
    let cursor = start

    for (const range of ranges) {
      if (range.end <= start || range.start >= end) continue
      if (range.start >= start) {
        output[index] += text.slice(cursor, range.start)
        output[index] += '[REDACTED]'
      }
      cursor = Math.max(cursor, Math.min(end, range.end))
    }
    output[index] += text.slice(cursor, end)
    offset = end
  }

  return output
}

/** Best-effort redaction for diagnostics, runtime results and logs; never returns the value found. */
export function redactSecrets(text: string): string {
  return RUNTIME_SECRET_PATTERNS.reduce((safe, pattern) => safe.replace(pattern, '[REDACTED]'), text)
}

function redactSecretsWithLeftContext(text: string, previous: string): string {
  if (previous === '') return redactSecrets(text)

  const combined = `${previous}${text}`
  const safe = RUNTIME_SECRET_PATTERNS.reduce(
    (current, pattern) => current.replace(pattern, (match: string, ...args: unknown[]) => {
      const offset = args[args.length - 2] as number
      return offset < previous.length ? match : '[REDACTED]'
    }),
    combined,
  )
  return safe.slice(previous.length)
}

const TOKEN_STREAM_PREFIXES = [
  'cyi_',
  'ghp_',
  'gho_',
  'ghu_',
  'ghs_',
  'ghr_',
  'github_pat_',
  'sk-',
  'dp.st.',
  // CYAU-113: credential shapes with a fixed, continuous prefix — so a value split between two chunks is
  // held back at the edge (and redacted when it is recomposed) instead of leaking halfway, as for the tokens above.
  'AKIA',
  'AIza',
  'xox',
  'eyJ',
] as const

// The managed env names close the list and come from the same source as the NAME=value pair above
// (CYAU-112): adding a capability brings it into the stream carry without touching this file.
const STREAM_PREFIXES: readonly string[] = [...TOKEN_STREAM_PREFIXES, ...MANAGED_SECRET_ENV]

const TOKEN_STREAM_PREFIX_COUNT = TOKEN_STREAM_PREFIXES.length

function previousCharacter(text: string, cursor: number, previous: string): string {
  return cursor === 0 ? previous : text[cursor - 1]
}

function canStartAtBoundary(prefix: string, before: string): boolean {
  return prefix === 'cyi_' ? !/[A-Za-z0-9]/.test(before) : !/[A-Za-z0-9_]/.test(before)
}

function earliestOpenSecret(text: string, previous: string): number | null {
  let earliest = text.length

  // A token can have arbitrary length: if it reaches the chunk edge, hold back the whole candidate
  // until a delimiter appears or until flush() declares the stream finished.
  for (let cursor = text.indexOf('cyi_'); cursor >= 0; cursor = text.indexOf('cyi_', cursor + 1)) {
    const before = previousCharacter(text, cursor, previous)
    if (canStartAtBoundary('cyi_', before) && /^[A-Za-z0-9_-]*$/.test(text.slice(cursor + 4))) {
      earliest = Math.min(earliest, cursor)
    }
  }

  for (const prefix of STREAM_PREFIXES.slice(1, TOKEN_STREAM_PREFIX_COUNT)) {
    for (let cursor = text.indexOf(prefix); cursor >= 0; cursor = text.indexOf(prefix, cursor + 1)) {
      const before = previousCharacter(text, cursor, previous)
      // `.` included: GitHub installation tokens and JWTs carry it (CYAU-248), and a cut after it leaked the rest.
      if (canStartAtBoundary(prefix, before) && /^[A-Za-z0-9_.-]*$/.test(text.slice(cursor + prefix.length))) {
        earliest = Math.min(earliest, cursor)
      }
    }
  }

  for (const prefix of STREAM_PREFIXES.slice(TOKEN_STREAM_PREFIX_COUNT)) {
    const cursor = text.lastIndexOf(prefix)
    const before = cursor < 0 ? '' : previousCharacter(text, cursor, previous)
    if (cursor >= 0 && canStartAtBoundary(prefix, before) && /^\s*(?:[=:]\s*\S*)?$/.test(text.slice(cursor + prefix.length))) {
      earliest = Math.min(earliest, cursor)
    }
  }

  // Also keeps a partial prefix at the edge (`cy` + `i_ah_…` in the next chunk).
  for (const prefix of STREAM_PREFIXES) {
    const max = Math.min(prefix.length - 1, text.length)
    for (let length = max; length > 0; length--) {
      const cursor = text.length - length
      const before = previousCharacter(text, cursor, previous)
      if (text.endsWith(prefix.slice(0, length)) && canStartAtBoundary(prefix, before)) {
        earliest = Math.min(earliest, cursor)
        break
      }
    }
  }

  return earliest === text.length ? null : earliest
}

export interface StreamingSecretRedactor {
  /** Consumes a chunk and returns only the prefix that is now safe to persist. */
  write(chunk: string): string
  /** Closes the current edge, redacts any complete candidate and does not lose harmless placeholders/fragments. */
  flush(): string
  /** Number of characters held back because they could complete a secret. */
  pendingLength(): number
  /** Last raw character already emitted, needed to keep the boundary during an ordered replay. */
  leftContext(): string
  /** Indicates that an already redacted tail is still consuming its raw continuation. */
  isSuppressing(): boolean
  /** Conservatively redacts the pending tail and suppresses its continuation; used only at the memory limit. */
  forceRedactPending(): string
}

/** Stateful redactor for a single arbitrarily split stream; independent streams require distinct instances. */
export function createStreamingSecretRedactor(): StreamingSecretRedactor {
  let pending = ''
  let previous = ''
  let suppression: 'token' | 'line' | null = null

  const redactWithContext = (raw: string): string => {
    const safe = redactSecretsWithLeftContext(raw, previous)
    if (raw !== '') previous = raw[raw.length - 1]
    return safe
  }

  const suppressionFor = (raw: string): 'token' | 'line' => {
    const tokenPrefixes = STREAM_PREFIXES.slice(0, TOKEN_STREAM_PREFIX_COUNT)
    return tokenPrefixes.some((prefix) => prefix.startsWith(raw) || raw.startsWith(prefix)) ? 'token' : 'line'
  }

  const consumeSuppressed = (chunk: string): string => {
    if (suppression === null || chunk === '') return chunk
    const boundary = suppression === 'token' ? chunk.search(/[^A-Za-z0-9_-]/) : chunk.search(/[\r\n]/)
    if (boundary < 0) {
      previous = chunk.at(-1) ?? previous
      return ''
    }

    if (boundary > 0) previous = chunk[boundary - 1]
    suppression = null
    return chunk.slice(boundary)
  }

  const write = (chunk: string): string => {
      const remaining = consumeSuppressed(chunk)
      if (remaining === '') return ''
      pending += remaining
      const carryStart = earliestOpenSecret(pending, previous)
      if (carryStart === null) {
        const safe = redactWithContext(pending)
        pending = ''
        return safe
      }

      const safe = redactWithContext(pending.slice(0, carryStart))
      pending = pending.slice(carryStart)
      return safe
  }

  return {
    write,
    flush() {
      const safe = redactWithContext(pending)
      pending = ''
      suppression = null
      previous = ''
      return safe
    },
    pendingLength: () => pending.length,
    leftContext: () => previous,
    isSuppressing: () => suppression !== null,
    forceRedactPending() {
      if (pending === '') return ''
      suppression = suppressionFor(pending)
      previous = pending.at(-1) ?? previous
      pending = ''
      return '[REDACTED]'
    },
  }
}

/**
 * Redacts a buffer closed by an artificial limit: a tail that could be the start of a secret is
 * conservatively treated as a secret, instead of being made harmless by the cut itself.
 */
export function redactSecretsAtTruncation(text: string): string {
  const redactor = createStreamingSecretRedactor()
  return `${redactor.write(text)}${redactor.forceRedactPending()}`
}
