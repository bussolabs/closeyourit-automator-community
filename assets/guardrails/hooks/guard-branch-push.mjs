// PreToolUse/Bash guardrail — allows `git push` ONLY on the ticket/… branch created with the worktree.
// Blocks: force-push, and any push towards a protected branch (main/master/develop/staging/production
// /release/hotfix) or a push that does not concern a ticket/ branch. Hook contract: stdin JSON, exit 2 = block.
import {fileURLToPath} from 'node:url'

const IS_GIT_OR_PUSH = /(?:^|[\s/])git\b|\bpush\b/i
const DYNAMIC_SHELL_SYNTAX = /[$`*?\[\]{}~]/u
const OBFUSCATING_SHELL_SYNTAX = /[\\'"]/u
const GIT_OR_PUSH = /\b(?:git|push)\b/i
// Syntactic allowlist: a single refspec, without `+`, `src:dst` mappings, wrappers, expansions or arbitrary
// options. Anything that contains a push but does not have this shape is blocked fail-closed.
// `-u` stays ALLOWED (the automator uses it from outside the sandbox, where it works) but must NOT be suggested:
// in the agent session it writes the upstream into the config of the SHARED repository, outside the worktree and
// read-only under the sandbox → the push succeeds but git exits non-zero with «could not lock config file»
// and the delivery is thrown away. The message below therefore shows the form without `-u`.
const SAFE_PUSH = /^git\s+push(?:\s+(?:-u|--set-upstream))?\s+origin\s+ticket\/[A-Za-z0-9][A-Za-z0-9._\/-]*\s*$/i
const SAFE_GIT_READ = /^git\s+(?:status|rev-parse\s+(?:HEAD|--show-toplevel))\s*$/i

/** @param {unknown} command The proposed Bash command. @returns {{blocked: boolean, reason?: string}} */
export function evaluate(command) {
  if (typeof command !== 'string') return {blocked: false}
  const segments = shellSegments(command).map((original) => ({original, normalized: normalizeShell(original)}))
  // Expansions and substitutions can build the launcher and the verb across several segments (`$g $p`):
  // they are therefore always forbidden, fail-closed. Quoting/escaping is forbidden when it obfuscates a git/push marker.
  if (segments.some(({original}) => DYNAMIC_SHELL_SYNTAX.test(original)) ||
      segments.some(({original, normalized}) => OBFUSCATING_SHELL_SYNTAX.test(original) && GIT_OR_PUSH.test(normalized))) {
    return {
      blocked: true,
      reason: 'guardrail push: espansioni, substitution, quoting ed escaping non sono consentiti nei comandi Git.',
    }
  }
  const gitLike = segments.filter(({normalized}) => IS_GIT_OR_PUSH.test(normalized))
  if (gitLike.length === 0) return {blocked: false}
  // The Git command must be the ENTIRE action: prefixes like `cd /tmp;` would change the authorized cwd.
  if (segments.length !== 1 || (!SAFE_PUSH.test(segments[0].original) && !SAFE_GIT_READ.test(segments[0].original))) {
    return {
      blocked: true,
      reason: 'guardrail push: consentito SOLO un singolo refspec ticket/… senza -C, force, wrapper, mapping o espansioni. Usa: git push origin ticket/<code>-<slug>',
    }
  }

  return {blocked: false}
}

function shellSegments(command) {
  const segments = []
  let current = ''
  let quote = null
  for (let i = 0; i < command.length; i += 1) {
    const char = command[i]
    if (char === '\\' && i + 1 < command.length) {
      current += char + command[++i]
    } else if (quote) {
      current += char
      if (char === quote) quote = null
    } else if (char === "'" || char === '"') {
      quote = char
      current += char
    } else if (char === ';' || char === '\n' || (char === '&' && command[i + 1] === '&') || (char === '|' && command[i + 1] === '|')) {
      if (current.trim()) segments.push(current)
      current = ''
      if ((char === '&' || char === '|') && command[i + 1] === char) i += 1
    } else current += char
  }
  if (current.trim()) segments.push(current)
  return segments
}

function normalizeShell(command) {
  let normalized = ''
  for (let i = 0; i < command.length; i += 1) {
    const char = command[i]
    if (char === '\\' && i + 1 < command.length) normalized += command[++i]
    else if (char === "'" || char === '"') {
      const quote = char
      while (++i < command.length && command[i] !== quote) {
        if (quote === '"' && command[i] === '\\' && i + 1 < command.length) normalized += command[++i]
        else normalized += command[i]
      }
    } else normalized += char
  }
  return normalized
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

  const {blocked, reason} = evaluate(payload?.tool_input?.command)
  if (blocked) {
    process.stderr.write(`${reason}\n`)
    return process.exit(2)
  }

  return process.exit(0)
}

function blockInvalidPayload() {
  process.stderr.write('guardrail push: payload PreToolUse non valido; operazione bloccata.\n')
  return process.exit(2)
}

if (import.meta.url.startsWith('file:') && process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) void main()
