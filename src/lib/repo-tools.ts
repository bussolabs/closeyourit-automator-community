import {execFile} from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

/**
 * Installs the tools a repository pins in its mise config before an agent session (CYAU-250).
 *
 * The session runs with mise's data directory read-only, so a pinned tool that is missing (gh 2.96.0
 * on the closeyourit-automator repository) failed every delivery with "Read-only file system". The
 * config is read from the trusted base ref, never from the ticket branch: an agent could otherwise edit
 * it and have the daemon install a plugin of its choice outside the sandbox.
 */

const CONFIG_FILES = ['mise.toml', '.mise.toml', '.tool-versions'] as const
const GIT_TIMEOUT_MS = 30_000
const INSTALL_TIMEOUT_MS = 5 * 60_000

export interface ToolsExecResult {
  code: number
  stdout: string
  stderr: string
}

export type ToolsExec = (
  cmd: string,
  args: string[],
  options: {cwd?: string; env?: NodeJS.ProcessEnv; timeoutMs: number; signal?: AbortSignal},
) => Promise<ToolsExecResult>

export interface ToolsOutcome {
  status: 'installed' | 'none' | 'failed'
  detail: string
}

const defaultExec: ToolsExec = (cmd, args, options) => new Promise((resolve) => {
  execFile(cmd, args, {
    cwd: options.cwd, env: options.env, timeout: options.timeoutMs, signal: options.signal, maxBuffer: 4 * 1024 * 1024,
  }, (error, stdout, stderr) => {
    const code = error ? (typeof error.code === 'number' ? error.code : 1) : 0
    resolve({code, stdout: String(stdout), stderr: String(stderr || (error && !stderr ? error.message : ''))})
  })
})

/** Never throws: a tool that cannot be installed shows up in the session, not as a lost run. */
export async function provisionRepoTools(
  repoPath: string,
  ref: string,
  options: {exec?: ToolsExec; signal?: AbortSignal} = {},
): Promise<ToolsOutcome> {
  const exec = options.exec ?? defaultExec
  const copy = fs.mkdtempSync(path.join(os.tmpdir(), 'closeyourit-tools-'))
  try {
    let found = 0
    for (const file of CONFIG_FILES) {
      const shown = await exec('git', ['-C', repoPath, 'show', `${ref}:${file}`], {timeoutMs: GIT_TIMEOUT_MS, signal: options.signal})
      if (shown.code !== 0) continue
      fs.writeFileSync(path.join(copy, file), shown.stdout)
      found += 1
    }
    if (found === 0) return {status: 'none', detail: `no mise config on ${ref}`}

    const install = await exec('mise', ['install'], {
      cwd: copy,
      env: {...process.env, MISE_TRUSTED_CONFIG_PATHS: copy, MISE_YES: '1'},
      timeoutMs: INSTALL_TIMEOUT_MS,
      signal: options.signal,
    })
    if (install.code !== 0) return {status: 'failed', detail: install.stderr.trim().slice(-500) || `mise install exited ${install.code}`}
    return {status: 'installed', detail: `tools from ${ref} installed`}
  } catch (error) {
    return {status: 'failed', detail: error instanceof Error ? error.message : String(error)}
  } finally {
    fs.rmSync(copy, {recursive: true, force: true})
  }
}
