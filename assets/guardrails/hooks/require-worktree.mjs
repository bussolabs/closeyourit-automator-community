// PreToolUse/(Edit|Write|MultiEdit|NotebookEdit) guardrail — allows edits only in a sibling Git worktree
// under the data root managed by the Automator. Realpath + git top-level block substrings, traversal and
// outbound symlinks. Hook contract: stdin JSON, exit 2 = block, exit 0 = allow.
import {fileURLToPath} from 'node:url'
import {spawnSync} from 'node:child_process'
import * as fs from 'node:fs'
import * as path from 'node:path'

const EDIT_TOOLS = new Set(['Edit', 'Write', 'MultiEdit', 'NotebookEdit'])

/**
 * @param {unknown} toolName Name of the tool.
 * @param {Record<string, unknown> | null | undefined} input The tool_input.
 * @returns {{blocked: boolean, reason?: string}}
 */
export function evaluate(toolName, input, worktreesRoot, authorizedCwd, sessionCwd) {
  // CYRA-921 — Codex edits with `apply_patch`: every file the patch adds, updates, deletes or moves to must pass.
  if (toolName === 'apply_patch') {
    const targets = patchTargets(input?.command)
    if (targets.length === 0) return {blocked: true, reason: 'guardrail worktree: patch without files; blocked.'}
    const base = typeof sessionCwd === 'string' && sessionCwd !== '' ? sessionCwd : process.cwd()
    for (const target of targets) {
      const verdict = evaluate('Write', {file_path: path.resolve(base, target)}, worktreesRoot, authorizedCwd)
      if (verdict.blocked) return verdict
    }
    return {blocked: false}
  }
  if (typeof toolName !== 'string' || !EDIT_TOOLS.has(toolName)) return {blocked: false}
  const target = input?.file_path ?? input?.notebook_path
  if (typeof target !== 'string' || target === '' ||
      ((typeof authorizedCwd !== 'string' || authorizedCwd === '') && (typeof worktreesRoot !== 'string' || worktreesRoot === ''))) {
    return {blocked: true, reason: 'guardrail worktree: payload o root worktree non validi.'}
  }

  try {
    const rootReal = fs.realpathSync(authorizedCwd ?? worktreesRoot)
    if (authorizedCwd !== undefined) {
      // CYAU-119: `--authorized-cwd` (always `.` in the settings) authorizes the session cwd. It is valid ONLY if
      // that resolved cwd is under `--worktrees-root`: write phases run inside it (managed worktree), read phases
      // in the personal checkout (outside) — which thus no longer receives writes. Without `--worktrees-root` no
      // comparison is possible → blocked (never fail-open on the cwd).
      if (typeof worktreesRoot !== 'string' || worktreesRoot === '') throw new Error('worktrees-root assente')
      if (!isWithin(fs.realpathSync(worktreesRoot), rootReal)) throw new Error('cwd autorizzata fuori dalla root worktree gestita')
      const authorizedGit = spawnSync('git', ['-C', rootReal, 'rev-parse', '--show-toplevel'], {encoding: 'utf8'})
      if (authorizedGit.status !== 0 || fs.realpathSync(authorizedGit.stdout.trim()) !== rootReal) throw new Error('cwd non autorizzata')
    }
    const absolute = path.resolve(target)
    const targetReal = fs.existsSync(absolute)
      ? fs.realpathSync(absolute)
      : path.join(fs.realpathSync(path.dirname(absolute)), path.basename(absolute))
    if (!isWithin(rootReal, targetReal)) throw new Error('fuori dalla root gestita')

    const probeDir = fs.existsSync(targetReal) && fs.statSync(targetReal).isDirectory() ? targetReal : path.dirname(targetReal)
    const git = spawnSync('git', ['-C', probeDir, 'rev-parse', '--show-toplevel'], {encoding: 'utf8'})
    if (git.status !== 0 || git.stdout.trim() === '') throw new Error('non è un worktree Git')
    const topLevel = fs.realpathSync(git.stdout.trim())
    if (!isWithin(rootReal, topLevel) || !isWithin(topLevel, targetReal)) throw new Error('worktree Git fuori root')
    return {blocked: false}
  } catch {
    // Any path, symlink or Git error blocks: no textual fallback.
  }
  return {
    blocked: true,
    reason: `guardrail worktree: modifica fuori da un worktree Git sibling gestito (${target}).`,
  }
}

// The file headers of a Codex patch (`*** Add File: p`, `*** Update File: p`, `*** Delete File: p`, `*** Move to: p`).
function patchTargets(patch) {
  if (typeof patch !== 'string') return []
  return patch.split('\n')
    .map((line) => /^\*\*\* (?:Add File|Update File|Delete File|Move to): (.+)$/.exec(line.trimEnd())?.[1]?.trim())
    .filter((target) => typeof target === 'string' && target !== '')
}

function isWithin(parent, child) {
  const relative = path.relative(parent, child)
  return relative === '' || (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative))
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

  const rootIndex = args.indexOf('--worktrees-root')
  const worktreesRoot = rootIndex >= 0 ? args[rootIndex + 1] : undefined
  const cwdIndex = args.indexOf('--authorized-cwd')
  const authorizedCwd = cwdIndex >= 0 ? args[cwdIndex + 1] : undefined
  if (typeof payload?.tool_name !== 'string' || !payload?.tool_input || typeof payload.tool_input !== 'object') return blockInvalidPayload()

  const sessionCwd = typeof payload.cwd === 'string' ? payload.cwd : undefined
  const {blocked, reason} = evaluate(payload.tool_name, payload.tool_input, worktreesRoot, authorizedCwd, sessionCwd)
  if (blocked) {
    process.stderr.write(`${reason}\n`)
    return process.exit(2)
  }

  return process.exit(0)
}

function blockInvalidPayload() {
  process.stderr.write('guardrail worktree: payload PreToolUse non valido; operazione bloccata.\n')
  return process.exit(2)
}

if (import.meta.url.startsWith('file:') && process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) void main()
