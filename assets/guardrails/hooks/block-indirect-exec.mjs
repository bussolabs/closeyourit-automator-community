// PreToolUse/Bash guardrail — closes the indirect bypass of the three textual hooks (block-production /
// block-destructive-db / guard-branch-push): they inspect ONLY the command string, so writing a forbidden
// command into a worktree file and then launching it (`bash x.sh`, `./x.sh`, `make deploy`, `npm run
// deploy`) got around them. Here the LAUNCHER is blocked when it is an interpreter, a wrapper/task runner or a
// file executed by path, because the executed code would escape inspection. Only exception: the entrypoints of
// the trusted SKILL BUNDLE (`--plugin-dir`, pinned before the claim and not writable by the agent).
//
// The command is split the way the shell would split it: commands are divided on `;` `\n` `&` `|` `&&` `||`,
// the commands nested in command substitution `$(...)`/backticks and in subshell/process-substitution
// `(...)`/`<(...)` are extracted recursively, and every simple command is tokenized honouring quotes (so an
// assignment value like `FOO='a b'` does not mask the real launcher). The forms that remain uninspectable
// (launchers/scripts built from expansions or globs) are blocked fail-closed. Hook contract: stdin JSON,
// `--plugin-dir <dir>` in argv, exit 2 = block.
import {fileURLToPath} from 'node:url'
import * as fs from 'node:fs'
import * as path from 'node:path'

// Interpreters that run a SCRIPT passed as the first argument: allowed ONLY if that script lives inside the
// trusted skill bundle. A flag before the script (`-c`, `-e`, `-p`, `run`…) makes the code inline or
// indirect and controlled by the agent → never exempt.
const SCRIPT_INTERPRETERS = new Set([
  'sh', 'bash', 'zsh', 'dash', 'ksh', 'node', 'deno', 'bun', 'python', 'python2', 'python3',
  'ruby', 'perl', 'php', 'tsx', 'ts-node', 'Rscript', 'pwsh', 'osascript',
])
// Task runners and shell wrappers can execute repository-controlled code. Checks must use the
// isolated gate helper, including when mise supplies the runtime.
const OPAQUE_LAUNCHERS = new Set([
  'env', 'command', 'exec', 'xargs', 'make', 'npm', 'pnpm', 'yarn', 'mise', 'source', 'eval', '.', 'sudo', 'doas',
])
// Prefixes that run "the rest of the line" as a command: they are skipped (with their options/durations) and the
// real launcher that follows is evaluated, so `nohup cyi …` stays allowed but `timeout 60 bash x.sh` does not.
const TRANSPARENT_PREFIXES = new Set(['nohup', 'timeout', 'nice', 'time', 'stdbuf', 'ionice', 'watch'])
// `find` can run commands with these predicates: then it is an indirect launcher; without them, it stays a read.
const FINDLIKE = new Set(['find', 'gfind'])
const FIND_EXEC_FLAGS = new Set(['-exec', '-execdir', '-ok', '-okdir', '-delete'])

// Metacharacters the shell expands/globs: one left over here (after substituting only the known CLAUDE_PLUGIN_ROOT)
// makes the token statically unresolvable → fail-closed where it matters (launcher or script arg).
const DYNAMIC_SHELL_SYNTAX = /[$`*?[\]{}]/u
const ENV_ASSIGNMENT = /^[A-Za-z_][A-Za-z0-9_]*=/u
// Redirection operators, with or without an attached target: `<` `>` `>>` `2>` `&>` `<<` `<<<` `N<` `<file`…
const REDIRECTION = /^\d*(?:&?>>?|<<?<?|[<>])/u
const BARE_REDIRECTION = /^\d*(?:&?>>?|<<?<?|[<>])$/u

/**
 * @param {unknown} command The proposed Bash command.
 * @param {string | undefined} pluginDir Directory of the pinned skill bundle (`--plugin-dir`); missing → no exemption.
 * @returns {{blocked: boolean, reason?: string}}
 */
export function evaluate(command, pluginDir, session = {}) {
  if (typeof command !== 'string') return {blocked: false}
  // If CLAUDE_PLUGIN_ROOT is (re)assigned in the command, at runtime its value is not the trusted one: do not
  // substitute it and do not grant exemptions based on it.
  const pluginRoot = pluginDir && !hasPluginRootAssignment(command) ? pluginDir : undefined
  for (const simple of extractCommands(command)) {
    const verdict = evaluateCommand(simple, pluginRoot, session)
    if (verdict.blocked) return verdict
  }
  return {blocked: false}
}

function blocked(what) {
  return {
    blocked: true,
    reason: `guardrail exec-indiretto: ${what} non è consentito (aggirerebbe i controlli su produzione, database e push scrivendo il comando in un file). Sono ammessi solo gli entrypoint del bundle skill fidato.`,
  }
}

function evaluateCommand(command, pluginRoot, session) {
  const words = tokenizeWords(command).map((word) => substitutePluginRoot(word, pluginRoot))
  const {launcher, args} = findLauncher(words)
  if (launcher === undefined) return {blocked: false} // only assignments/redirections: no command executed
  if (DYNAMIC_SHELL_SYNTAX.test(launcher)) return blocked('un launcher costruito da espansioni o glob')

  const base = launcherBase(launcher)
  if (FINDLIKE.has(base) && args.some((arg) => FIND_EXEC_FLAGS.has(arg))) {
    return blocked(`"${base}" con un predicato che esegue comandi (-exec/-delete)`)
  }
  if (SCRIPT_INTERPRETERS.has(base)) {
    const scriptArg = args[0]
    if (scriptArg === undefined) return blocked(`l'interprete "${base}" senza uno script del bundle`)
    if (scriptArg.startsWith('-')) return blocked(`l'interprete "${base}" con codice inline o opzioni`)
    if (resolvesInsidePlugin(scriptArg, pluginRoot)) return authorizeHelper(scriptArg, args.slice(1), pluginRoot, session)
    return blocked(`l'interprete "${base}" su uno script fuori dal bundle skill`)
  }
  if (OPAQUE_LAUNCHERS.has(base)) return blocked(`il wrapper/task-runner "${base}"`)
  if (looksLikePath(launcher)) {
    if (resolvesInsidePlugin(launcher, pluginRoot)) return authorizeHelper(launcher, args, pluginRoot, session)
    return blocked('un file eseguibile fuori dal bundle skill')
  }
  // Ordinary command resolved from PATH (cyi, git, gh, ls, cat, mise…): not this hook's vector; git and the
  // production/DB patterns stay covered by the other Bash hooks.
  return {blocked: false}
}

/** The real launcher, skipping env assignments, redirections and transparent prefixes (with their options). */
function findLauncher(tokens) {
  let i = 0
  for (;;) {
    while (i < tokens.length && (ENV_ASSIGNMENT.test(tokens[i]) || REDIRECTION.test(tokens[i]))) {
      i += REDIRECTION.test(tokens[i]) && BARE_REDIRECTION.test(tokens[i]) ? 2 : 1 // a "bare" redirection also consumes the target
    }
    if (i >= tokens.length) break
    if (TRANSPARENT_PREFIXES.has(launcherBase(tokens[i]))) {
      i = skipPrefixArgs(tokens, i + 1)
      continue
    }
    break
  }
  return {launcher: tokens[i], args: tokens.slice(i + 1)}
}

/** Skips the options (`-x`), numeric values (durations) and `--` preceding the command behind a transparent prefix. */
function skipPrefixArgs(tokens, from) {
  let i = from
  while (i < tokens.length) {
    const token = tokens[i]
    if (token === '--') return i + 1
    if (token.startsWith('-') || /^\d+$/u.test(token)) {
      i += 1
      continue
    }
    break
  }
  return i
}

function launcherBase(token) {
  return token === '.' ? '.' : path.basename(token)
}

/** A token refers to a file by path (not a command from PATH) if it contains `/` or starts with `~`. */
function looksLikePath(token) {
  return token.includes('/') || token.startsWith('~')
}

/**
 * true if `token` is an ABSOLUTE path that, once resolved (realpath, so following symlinks), is a regular file
 * INSIDE the skill bundle. A bundle entrypoint is always referenced in absolute form (plugin_dir/CLAUDE_PLUGIN_ROOT
 * are absolute); relative, missing or dynamic paths, or symlinks pointing outside → false (fail-closed).
 */
// The immutable bundle is trusted code, but release authority belongs to one host-issued phase.
function authorizeHelper(script, args, pluginRoot, session) {
  const relative = path.relative(fs.realpathSync(pluginRoot), fs.realpathSync(script))
  if (relative !== 'skills/closer-production/scripts/release.sh') return {blocked: false}
  const value = (flag) => {
    const positions = args.flatMap((item, index) => item === flag ? [index] : [])
    return positions.length === 1 ? args[positions[0] + 1] : undefined
  }
  if (session.skill !== '/closeyourit-skills:closer-production' || !session.ticket || !session.cwd) {
    return blocked('production release outside its host-authorized phase')
  }
  if (value('--ticket') !== session.ticket || value('--cwd') !== session.cwd) {
    return blocked('production release outside its authorized ticket or checkout')
  }
  const release = session.release
  if (!release || !/^v\d+\.\d+\.\d+$/.test(release.version) || !/^[0-9a-f]{40}$/.test(release.sha) ||
      !Number.isFinite(release.expiresAt) || release.expiresAt <= Date.now()) {
    return blocked('production release requires a current host-issued tag and commit assignment')
  }
  if (value('--tag') !== release.version || value('--sha') !== release.sha) {
    return blocked('production release differs from its assigned tag or commit')
  }
  return {blocked: false}
}

function resolvesInsidePlugin(token, pluginRoot) {
  if (!pluginRoot || DYNAMIC_SHELL_SYNTAX.test(token) || !path.isAbsolute(token)) return false
  try {
    const pluginReal = fs.realpathSync(pluginRoot)
    const targetReal = fs.realpathSync(token)
    return fs.statSync(targetReal).isFile() && isWithin(pluginReal, targetReal)
  } catch {
    return false
  }
}

function isWithin(parent, child) {
  const relative = path.relative(parent, child)
  return relative !== '' && !relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative)
}

/** true if the command (re)assigns the CLAUDE_PLUGIN_ROOT variable (`CLAUDE_PLUGIN_ROOT=…`, also with `export`). */
function hasPluginRootAssignment(command) {
  return /(?:^|[^A-Za-z0-9_])CLAUDE_PLUGIN_ROOT=/u.test(command)
}

/** Substitutes only `${CLAUDE_PLUGIN_ROOT}` / `$CLAUDE_PLUGIN_ROOT` with the known value; the replacement is inert to `$`. */
function substitutePluginRoot(word, pluginRoot) {
  if (!pluginRoot) return word
  return word
    .replace(/\$\{CLAUDE_PLUGIN_ROOT\}/gu, () => pluginRoot)
    .replace(/\$CLAUDE_PLUGIN_ROOT\b/gu, () => pluginRoot)
}

/**
 * Splits the command into the list of simple commands to evaluate: divides on unquoted control separators
 * (`;` `\n` `&` `|` `&&` `||`) and recursively extracts the commands nested in command substitution
 * `$(...)`/backticks and in subshell/process-substitution `(...)`/`<(...)`. Honours quotes: inside single
 * quotes everything is literal; inside double quotes `$()` and backticks stay active.
 */
function extractCommands(input) {
  const commands = []
  scanCommands(input, commands)
  return commands
}

function scanCommands(input, out) {
  let current = ''
  let quote = null
  const flush = () => {
    if (current.trim()) out.push(current)
    current = ''
  }
  for (let i = 0; i < input.length; i += 1) {
    const char = input[i]
    if (quote === "'") {
      current += char
      if (char === "'") quote = null
      continue
    }
    if (quote === '"') {
      if (char === '\\' && i + 1 < input.length) {
        current += char + input[++i]
      } else if (char === '`') {
        i = extractDelimited(input, i, out)
        current += ' '
      } else if (char === '$' && input[i + 1] === '(') {
        i = extractParen(input, i + 1, out)
        current += ' '
      } else {
        current += char
        if (char === '"') quote = null
      }
      continue
    }
    if (char === '\\' && i + 1 < input.length) {
      current += char + input[++i]
    } else if (char === "'" || char === '"') {
      quote = char
      current += char
    } else if (char === '`') {
      i = extractDelimited(input, i, out)
      current += ' '
    } else if (char === '$' && input[i + 1] === '(') {
      i = extractParen(input, i + 1, out)
      current += ' '
    } else if (char === '(') {
      i = extractParen(input, i, out)
      current += ' '
    } else if ((char === '<' || char === '>') && input[i + 1] === '(') {
      i = extractParen(input, i + 1, out)
      current += ' '
    } else if (char === ';' || char === '\n' || char === '&' || char === '|') {
      flush()
      if ((char === '&' && input[i + 1] === '&') || (char === '|' && input[i + 1] === '|')) i += 1
    } else {
      current += char
    }
  }
  flush()
}

/** Extracts the content of a balanced `(...)` (honouring quotes and nesting) as commands; returns the index of the `)`. */
function extractParen(input, openIndex, out) {
  let depth = 0
  let quote = null
  for (let i = openIndex; i < input.length; i += 1) {
    const char = input[i]
    if (quote) {
      if (char === '\\' && quote === '"' && i + 1 < input.length) i += 1
      else if (char === quote) quote = null
      continue
    }
    if (char === "'" || char === '"') quote = char
    else if (char === '(') depth += 1
    else if (char === ')') {
      depth -= 1
      if (depth === 0) {
        scanCommands(input.slice(openIndex + 1, i), out)
        return i
      }
    }
  }
  scanCommands(input.slice(openIndex + 1), out) // unbalanced: evaluate the rest anyway (fail-closed)
  return input.length
}

/** Extracts the content of a backtick `` `...` `` as commands; returns the index of the closing backtick. */
function extractDelimited(input, openIndex, out) {
  for (let i = openIndex + 1; i < input.length; i += 1) {
    if (input[i] === '\\' && i + 1 < input.length) i += 1
    else if (input[i] === '`') {
      scanCommands(input.slice(openIndex + 1, i), out)
      return i
    }
  }
  scanCommands(input.slice(openIndex + 1), out)
  return input.length
}

/** Tokenizes a simple command into shell words honouring quotes (removes them but keeps the boundaries). */
function tokenizeWords(command) {
  const words = []
  let current = ''
  let has = false
  let quote = null
  for (let i = 0; i < command.length; i += 1) {
    const char = command[i]
    if (quote === "'") {
      if (char === "'") quote = null
      else {
        current += char
        has = true
      }
    } else if (quote === '"') {
      if (char === '"') quote = null
      else if (char === '\\' && i + 1 < command.length && '"\\$`'.includes(command[i + 1])) {
        current += command[++i]
        has = true
      } else {
        current += char
        has = true
      }
    } else if (char === '\\' && i + 1 < command.length) {
      current += command[++i]
      has = true
    } else if (char === "'" || char === '"') {
      quote = char
      has = true
    } else if (/\s/u.test(char)) {
      if (has) {
        words.push(current)
        current = ''
        has = false
      }
    } else {
      current += char
      has = true
    }
  }
  if (has) words.push(current)
  return words
}

async function readStdin() {
  const chunks = []
  for await (const chunk of process.stdin) chunks.push(chunk)
  return Buffer.concat(chunks).toString('utf8')
}

export async function main(args = process.argv.slice(2)) {
  let payload
  try {
    payload = JSON.parse(await readStdin())
  } catch {
    return blockInvalidPayload()
  }

  const pluginIndex = args.indexOf('--plugin-dir')
  const pluginDir = pluginIndex >= 0 ? args[pluginIndex + 1] : undefined

  if (payload?.tool_name !== 'Bash' || typeof payload?.tool_input?.command !== 'string' || payload.tool_input.command.trim() === '') {
    return blockInvalidPayload()
  }

  let session = {}
  const contextIndex = args.indexOf('--session-context')
  if (contextIndex >= 0) {
    try { session = JSON.parse(Buffer.from(args[contextIndex + 1], 'base64').toString('utf8')) }
    catch { return blockInvalidPayload() }
  }
  const {blocked: isBlocked, reason} = evaluate(payload.tool_input.command, pluginDir, session)
  if (isBlocked) {
    process.stderr.write(`${reason}\n`)
    return process.exit(2)
  }

  return process.exit(0)
}

function blockInvalidPayload() {
  process.stderr.write('guardrail exec-indiretto: payload PreToolUse non valido; operazione bloccata.\n')
  return process.exit(2)
}

if (import.meta.url.startsWith('file:') && process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) void main()
