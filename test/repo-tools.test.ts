import {spawnSync} from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import {describe, expect, it, vi} from 'vitest'

import {provisionRepoTools, type ToolsExec} from '../src/lib/repo-tools'

function fakeExec(files: Record<string, string>, install: {code: number; stderr?: string} = {code: 0}) {
  const calls: Array<{cmd: string; args: string[]; cwd?: string; env?: NodeJS.ProcessEnv}> = []
  const exec: ToolsExec = vi.fn(async (cmd, args, options) => {
    calls.push({cmd, args, cwd: options.cwd, env: options.env})
    if (cmd === 'git') {
      const spec = args.at(-1)!
      const file = spec.slice(spec.indexOf(':') + 1)
      return file in files ? {code: 0, stdout: files[file], stderr: ''} : {code: 128, stdout: '', stderr: 'missing'}
    }
    if (options.cwd) {
      expect(fs.readdirSync(options.cwd).sort()).toEqual(Object.keys(files).sort())
    }
    return {code: install.code, stdout: '', stderr: install.stderr ?? ''}
  })
  return {exec, calls}
}

describe('provisionRepoTools', () => {
  it('installs the tools declared on the trusted base ref, from a copy outside the worktree', async () => {
    const {exec, calls} = fakeExec({'mise.toml': '[tools]\ngh = "2.96.0"\n'})

    const outcome = await provisionRepoTools('/repo', 'origin/main', {exec})

    expect(outcome.status).toBe('installed')
    expect(calls.filter((call) => call.cmd === 'git').map((call) => call.args))
      .toContainEqual(['-C', '/repo', 'show', 'origin/main:mise.toml'])
    const install = calls.find((call) => call.cmd === 'mise')!
    expect(install.args).toEqual(['install'])
    expect(install.cwd).not.toContain('/repo')
    expect(install.env?.MISE_TRUSTED_CONFIG_PATHS).toBe(install.cwd)
    expect(fs.existsSync(install.cwd!)).toBe(false)
  })

  it('does nothing when the base ref declares no tools', async () => {
    const {exec, calls} = fakeExec({})

    const outcome = await provisionRepoTools('/repo', 'origin/main', {exec})

    expect(outcome.status).toBe('none')
    expect(calls.some((call) => call.cmd === 'mise')).toBe(false)
  })

  it('reports a failed install instead of throwing', async () => {
    const {exec} = fakeExec({'.tool-versions': 'nodejs 24.11.0\n'}, {code: 1, stderr: 'network down'})

    const outcome = await provisionRepoTools('/repo', 'origin/main', {exec})

    expect(outcome).toMatchObject({status: 'failed'})
    expect(outcome.detail).toContain('network down')
  })

  it('never reads the ticket branch, even when the worktree carries its own config', async () => {
    const worktree = fs.mkdtempSync(path.join(os.tmpdir(), 'wt-'))
    fs.writeFileSync(path.join(worktree, 'mise.toml'), '[tools]\nevil = "1"\n')
    const {exec, calls} = fakeExec({})

    await provisionRepoTools(worktree, 'origin/main', {exec})

    expect(calls.every((call) => call.cmd !== 'mise')).toBe(true)
  })

  // CYAU-311 — the daemon passes the commit pinned at preparation: a session that rewrites the local
  // `origin/main` to a commit with its own mise config does not choose what gets installed.
  it('reads the config from the commit it receives, not from a rewritten local base ref', async () => {
    const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'tools-ref-'))
    const git = (...args: string[]) => {
      const res = spawnSync('git', ['-C', repo, ...args], {encoding: 'utf8'})
      if (res.status !== 0) throw new Error(res.stderr)
      return res.stdout.trim()
    }
    const commit = (content: string) => {
      fs.writeFileSync(path.join(repo, 'mise.toml'), content)
      git('add', '.')
      git('-c', 'user.email=t@e.st', '-c', 'user.name=Test', 'commit', '-qm', content)
      return git('rev-parse', 'HEAD')
    }
    try {
      git('init', '-q', '-b', 'main')
      const pinned = commit('[tools]\ngh = "2.96.0"\n')
      git('update-ref', 'refs/remotes/origin/main', commit('[tools]\nevil = "1"\n'))
      const installed: string[] = []
      const exec: ToolsExec = async (cmd, args, options) => {
        if (cmd === 'git') {
          const res = spawnSync(cmd, args, {encoding: 'utf8'})
          return {code: res.status ?? 1, stdout: res.stdout, stderr: res.stderr}
        }
        installed.push(fs.readFileSync(path.join(options.cwd!, 'mise.toml'), 'utf8'))
        return {code: 0, stdout: '', stderr: ''}
      }

      expect(await provisionRepoTools(repo, pinned, {exec})).toMatchObject({status: 'installed'})
      expect(installed).toEqual(['[tools]\ngh = "2.96.0"\n'])
    } finally {
      fs.rmSync(repo, {recursive: true, force: true})
    }
  })
})
