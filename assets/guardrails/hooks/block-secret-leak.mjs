// Guardrail PreToolUse/Bash — blocks what would carry a credential OUT of the machine (CYAU-242): a `git push`
// whose unpushed commits contain a token, or a cyi/closeyourit/gh/curl/wget command line that contains one
// (ticket comment, Knowledge page, pull request body, HTTP header). The values of the agent's environment
// (service account token, organisation keys) are the target: a ticket written on purpose must not be able
// to publish them. The reason names the shape, never the value. Hook contract: stdin JSON, exit 2 = block.
import {spawnSync} from 'node:child_process'
import {fileURLToPath} from 'node:url'

// The same shapes as src/lib/secret-redaction.ts. The hook runs from a data URL and cannot import that module:
// test/guardrails-hooks.test.ts keeps the two lists in step. A placeholder (`cyi_ah_…`, bare `ghp_`) never matches.
export const SECRET_PATTERNS = [
  {name: 'CloseYourIt token', regex: /(?<![A-Za-z0-9])cyi_(?:[a-z]+_)?[A-Za-z0-9][A-Za-z0-9_-]{5,}\b/},
  {name: 'CloseYourIt token', regex: /(?<![A-Za-z0-9])cyi_ah_[A-Za-z0-9]+\b/},
  {name: 'GitHub token', regex: /\bgh[pousr]_[A-Za-z0-9_.-]{6,}\b/},
  {name: 'GitHub token', regex: /\bgithub_pat_[A-Za-z0-9_]{6,}\b/},
  {name: 'API key (sk-)', regex: /\bsk-[A-Za-z0-9_-]{6,}\b/},
  {name: 'dp.st. token', regex: /\bdp\.st\.[A-Za-z0-9_-]{6,}\b/},
  {name: 'PEM private key', regex: /-----BEGIN (?:[A-Z0-9]+ )*PRIVATE KEY-----/},
  {name: 'AWS access key id', regex: /\bAKIA[0-9A-Z]{16}\b/},
  {name: 'Google API key', regex: /\bAIza[0-9A-Za-z_-]{35}\b/},
  {name: 'Slack token', regex: /\bxox[baprs]-[A-Za-z0-9-]{10,}\b/},
  {name: 'JSON Web Token', regex: /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/},
]

// guard-branch-push already reduces a push to the literal form `git push [-u] origin ticket/…`: here the
// detection only needs to recognise it.
const GIT_PUSH = /(?:^|[\s;&|(])git\s+push\b/
// Tools that send text to CloseYourIt, GitHub or any allowed host.
const OUTBOUND_TOOL = /(?:^|[\s;&|(])(?:cyi|closeyourit|gh|curl|wget)\b/

/** @param {string} text @returns {string | null} The name of the first credential shape found. */
export function findSecret(text) {
  const found = SECRET_PATTERNS.find(({regex}) => regex.test(text))
  return found ? found.name : null
}

/**
 * Messages and diffs of the commits no remote-tracking ref contains yet: what a push would send.
 * @param {string} cwd @returns {string | null} null when git cannot answer (not a repository, timeout).
 */
export function unpushedContent(cwd) {
  const outcome = spawnSync('git', ['-C', cwd, 'log', '-p', '--no-color', '--format=%B', 'HEAD', '--not', '--remotes'], {
    encoding: 'utf8',
    timeout: 30_000,
    maxBuffer: 64 * 1024 * 1024,
  })
  if (outcome.error || outcome.status !== 0 || typeof outcome.stdout !== 'string') return null
  return outcome.stdout
}

/**
 * @param {unknown} command The proposed Bash command.
 * @param {{cwd: string, unpushedContent?: (cwd: string) => string | null}} deps
 * @returns {{blocked: boolean, reason?: string}}
 */
export function evaluate(command, deps) {
  if (typeof command !== 'string') return {blocked: false}

  if (OUTBOUND_TOOL.test(command)) {
    const shape = findSecret(command)
    if (shape) return {blocked: true, reason: `guardrail secret: the command line carries a credential (${shape}); it must not leave the machine.`}
  }

  if (GIT_PUSH.test(command)) {
    const content = (deps.unpushedContent ?? unpushedContent)(deps.cwd)
    if (content === null) {
      return {blocked: true, reason: 'guardrail secret: the commits to push could not be read; push blocked.'}
    }
    const shape = findSecret(content)
    if (shape) return {blocked: true, reason: `guardrail secret: a commit to push carries a credential (${shape}); remove it from the history before pushing.`}
  }

  return {blocked: false}
}

async function readStdin() {
  const chunks = []
  for await (const chunk of process.stdin) chunks.push(chunk)
  return Buffer.concat(chunks).toString('utf8')
}

export async function main() {
  let payload
  try {
    payload = JSON.parse(await readStdin())
  } catch {
    return blockInvalidPayload()
  }

  if (payload?.tool_name !== 'Bash' || typeof payload?.tool_input?.command !== 'string' || payload.tool_input.command.trim() === '') {
    return blockInvalidPayload()
  }

  const cwd = typeof payload.cwd === 'string' && payload.cwd !== '' ? payload.cwd : process.cwd()
  const {blocked, reason} = evaluate(payload.tool_input.command, {cwd})
  if (blocked) {
    process.stderr.write(`${reason}\n`)
    return process.exit(2)
  }

  return process.exit(0)
}

function blockInvalidPayload() {
  process.stderr.write('guardrail secret: invalid PreToolUse payload; operation blocked.\n')
  return process.exit(2)
}

if (import.meta.url.startsWith('file:') && process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) void main()
