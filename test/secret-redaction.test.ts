import {describe, expect, it} from 'vitest'
import {MANAGED_SECRET_ENV} from '../src/lib/env-capabilities'
import {createStreamingSecretRedactor, redactSecrets} from '../src/lib/secret-redaction'

describe('redactSecrets', () => {
  // CYAU-266 — an empty NAME= in an example file took the next line as its value: the diff looked like it held a
  // secret and the review refused it, though no value was there.
  it('does not take the next line as the value of an empty managed variable', () => {
    const example = '# CLOSEYOURIT_TOKEN=\n# CLOSEYOURIT_PROJECT_ID=\n'
    expect(redactSecrets(example)).toBe(example)
    expect(redactSecrets('CLOSEYOURIT_TOKEN = opaque-value-1234567890')).toBe('[REDACTED]')
  })

  it('also masks the minimum payload accepted for an Agent Host token', () => {
    expect(redactSecrets('token=cyi_ah_s')).toBe('token=[REDACTED]')
  })

  // CYAU-248 — GitHub installation tokens are now ~390 characters with `.` and `-`: masking must not stop at the dot.
  it('masks a GitHub installation token of the current shape whole', () => {
    const token = `ghs_${'A1b2'.repeat(20)}.${'c3-D4_'.repeat(30)}.${'e5F6'.repeat(20)}`
    expect(redactSecrets(`push with ${token} done`)).toBe('push with [REDACTED] done')
  })

  it('masks GitHub fine-grained PATs', () => {
    expect(redactSecrets(`token=github_pat_${'A1_'.repeat(20)}`)).toBe('token=[REDACTED]')
  })

  it('masks the managed formats of Claude setup-token and of the retired provider even without env name', () => {
    expect(redactSecrets('claude=sk-ant-oat01-fakevalue retired=dp.st.fake_service_value')).toBe(
      'claude=[REDACTED] retired=[REDACTED]',
    )
  })

  // CYAU-223 — the Claude review now reads the machine sign-in: both its tokens must vanish from any log line.
  it('masks the access and refresh tokens of a Claude sign-in, also as they sit in the credentials file', () => {
    const file = '{"claudeAiOauth":{"accessToken":"sk-ant-oat01-Ab_9-cd","refreshToken":"sk-ant-ort01-Ef_8-gh","expiresAt":1}}'
    const masked = redactSecrets(file)
    expect(masked).not.toContain('sk-ant-oat01-Ab_9-cd')
    expect(masked).not.toContain('sk-ant-ort01-Ef_8-gh')
    expect(redactSecrets('CLAUDE_CODE_OAUTH_TOKEN=sk-ant-oat01-Ab_9-cd')).toBe('[REDACTED]')
  })

  it('masks the NAME=value form also for the local Claude auth envs (opaque ANTHROPIC_AUTH_TOKEN included)', () => {
    // The NAME=value pattern captures name+value together (as for CLAUDE_CODE_OAUTH_TOKEN): the whole pair disappears.
    expect(redactSecrets('ANTHROPIC_API_KEY=sk-ant-fakevalue')).toBe('[REDACTED]')
    // ANTHROPIC_AUTH_TOKEN is an opaque bearer (no `sk-` prefix): only the NAME=value pattern covers it.
    expect(redactSecrets('ANTHROPIC_AUTH_TOKEN=opaque-bearer-1234567890')).toBe('[REDACTED]')
  })
})

// CYAU-112: the redaction knew the credential name of the RETIRED provider but not that of the vault in
// use. The value does have the `cyi_` prefix, but the NAME=value pair is the defence that does not depend on the format:
// without it a token of a different shape (or truncated) would stay in clear in the logs.
describe('redactSecrets — credential of the vault in use (CYAU-112)', () => {
  it('masks the NAME=value pair of the CloseYourIt service token', () => {
    expect(redactSecrets('CLOSEYOURIT_TOKEN=opaque-service-account-1234567890')).toBe('[REDACTED]')
    expect(redactSecrets('CLOSEYOURIT_TOKEN: opaque-service-account-1234567890')).toBe('[REDACTED]')
  })

  // The constraint that prevents repeating the defect: every env declared managed MUST disappear from the logs.
  it.each(MANAGED_SECRET_ENV)('masks the NAME=value form of every managed env (%s)', (name) => {
    expect(redactSecrets(`${name}=opaque-value-1234567890`)).toBe('[REDACTED]')
  })
})

// CYAU-113: the credential shapes already known to the publication gate (publish.ts) must ALSO disappear from the
// local logs — before, they went through in clear. One case for each shared shape.
describe('redactSecrets — credential shapes shared with the publication gate (CYAU-113)', () => {
  it('masks the header of a PEM private key', () => {
    expect(redactSecrets('key: -----BEGIN RSA PRIVATE KEY-----')).toBe('key: [REDACTED]')
  })

  it('masks the WHOLE PEM block, key body included (not only the header)', () => {
    const pem = '-----BEGIN PRIVATE KEY-----\nMIIBVwIBADANBgkq\nhkiG9w0BAQEFAAS\n-----END PRIVATE KEY-----'
    expect(redactSecrets(`prima\n${pem}\ndopo`)).toBe('prima\n[REDACTED]\ndopo')
  })

  it('masks an AWS access key id', () => {
    expect(redactSecrets(`aws=AKIA${'A'.repeat(16)}`)).toBe('aws=[REDACTED]')
  })

  it('masks a Google API key', () => {
    expect(redactSecrets(`g=AIza${'a'.repeat(35)}`)).toBe('g=[REDACTED]')
  })

  it('masks a Slack session token', () => {
    expect(redactSecrets(`slack=xoxb-${'1'.repeat(12)}`)).toBe('slack=[REDACTED]')
  })

  it('masks a JSON Web Token', () => {
    expect(redactSecrets(`jwt=eyJ${'a'.repeat(10)}.${'b'.repeat(10)}.${'c'.repeat(10)}`)).toBe('jwt=[REDACTED]')
  })
})

describe('createStreamingSecretRedactor', () => {
  it.each(Array.from({length: 'Acyi_ah_ABCDEF '.length + 1}, (_, split) => split))(
    'keeps the preceding character and the non-token text at split %i',
    (split) => {
      const input = 'Acyi_ah_ABCDEF '
      const stream = createStreamingSecretRedactor()
      const output = stream.write(input.slice(0, split)) + stream.write(input.slice(split)) + stream.flush()

      expect(output).toBe(input)
    },
  )

  it.each(Array.from({length: 'cyi_ah_ABCDEF '.length + 1}, (_, split) => split))(
    'masks the Agent Host token at every split %i',
    (split) => {
      const input = 'cyi_ah_ABCDEF '
      const stream = createStreamingSecretRedactor()
      const output = stream.write(input.slice(0, split)) + stream.write(input.slice(split)) + stream.flush()

      expect(output).toBe('[REDACTED] ')
    },
  )

  it.each(Array.from({length: `github_pat_${'A1_'.repeat(20)} `.length + 1}, (_, split) => split))(
    'masks a GitHub fine-grained PAT at every split %i',
    (split) => {
      const input = `github_pat_${'A1_'.repeat(20)} `
      const stream = createStreamingSecretRedactor()
      const output = stream.write(input.slice(0, split)) + stream.write(input.slice(split)) + stream.flush()

      expect(output).toBe('[REDACTED] ')
    },
  )

  // CYAU-248 — the current GitHub installation token shape, with `.` and `-`, split anywhere between two chunks.
  const installationToken = `ghs_${'A1b2'.repeat(5)}.${'c3-D4_'.repeat(5)}.${'e5F6'.repeat(5)}`
  it.each(Array.from({length: `${installationToken} `.length + 1}, (_, split) => split))(
    'masks a GitHub installation token at every split %i',
    (split) => {
      const input = `${installationToken} `
      const stream = createStreamingSecretRedactor()
      const output = stream.write(input.slice(0, split)) + stream.write(input.slice(split)) + stream.flush()

      expect(output).toBe('[REDACTED] ')
    },
  )

  it.each(Array.from({length: 'dp.st.fake_service_value '.length + 1}, (_, split) => split))(
    'masks a retired-provider token at every split %i',
    (split) => {
      const input = 'dp.st.fake_service_value '
      const stream = createStreamingSecretRedactor()
      const output = stream.write(input.slice(0, split)) + stream.write(input.slice(split)) + stream.flush()

      expect(output).toBe('[REDACTED] ')
    },
  )

  // CYAU-113: the credential shapes moved here must also withstand the split between chunks, not only when
  // they arrive whole in a chunk. Without the carry in STREAM_PREFIXES the first half would leak in clear.
  it.each(Array.from({length: `AKIA${'A'.repeat(16)} `.length + 1}, (_, split) => split))(
    'masks an AWS access key id at every split %i',
    (split) => {
      const input = `AKIA${'A'.repeat(16)} `
      const stream = createStreamingSecretRedactor()
      const output = stream.write(input.slice(0, split)) + stream.write(input.slice(split)) + stream.flush()

      expect(output).toBe('[REDACTED] ')
    },
  )

  // CYAU-112: the service token arrives in the environment as NAME=value and in the logs it can be split like
  // any other; without the carry on the name, the first half of the pair would leak.
  it.each(Array.from({length: 'CLOSEYOURIT_TOKEN=opaque-value-1234567890 '.length + 1}, (_, split) => split))(
    'masks the NAME=value pair of the CloseYourIt service token at every split %i',
    (split) => {
      const input = 'CLOSEYOURIT_TOKEN=opaque-value-1234567890 '
      const stream = createStreamingSecretRedactor()
      const output = stream.write(input.slice(0, split)) + stream.write(input.slice(split)) + stream.flush()

      expect(output).toBe('[REDACTED] ')
    },
  )

  it.each(Array.from({length: `xoxb-${'1'.repeat(12)} `.length + 1}, (_, split) => split))(
    'masks a Slack session token at every split %i',
    (split) => {
      const input = `xoxb-${'1'.repeat(12)} `
      const stream = createStreamingSecretRedactor()
      const output = stream.write(input.slice(0, split)) + stream.write(input.slice(split)) + stream.flush()

      expect(output).toBe('[REDACTED] ')
    },
  )
})
