import {afterEach, describe, expect, it} from 'vitest'
import {mkdtempSync, mkdirSync, writeFileSync, rmSync} from 'node:fs'
import {tmpdir} from 'node:os'
import {join} from 'node:path'
import {bindReleaseAuthority, sessionSettings} from '../src/lib/session-settings'
import {PlaybookSchema} from '../src/lib/schema'
import {evaluate} from '../assets/guardrails/hooks/block-indirect-exec.mjs'

const directories: string[] = []
afterEach(() => { for (const directory of directories.splice(0)) rmSync(directory, {recursive: true, force: true}) })
function directory(): string {
  const value = mkdtempSync(join(tmpdir(), 'session-security-'))
  directories.push(value)
  return value
}

describe('host-issued session authority', () => {
  it('binds release exceptions and makes read-phase Bash filesystem writes fail closed', () => {
    const cwd = directory()
    const settings = join(cwd, 'settings.json')
    writeFileSync(settings, JSON.stringify({hooks: {PreToolUse: [{matcher: 'Bash', hooks: [{type: 'command', command: 'node /hooks/block-indirect-exec.mjs'}]}]}, sandbox: {enabled: true}}))
    const action = PlaybookSchema.parse({version: 1, actions: {read: {
      type: 'claude', schedule: 'every 1m', run: 'read', containment: 'strong', allowed_tools: ['Read', 'Grep'],
      skill: {command: '/closeyourit-skills:triage', args: 'CYRA-1', plugin_dir: '/plugin'},
    }}}).actions.read
    const result = sessionSettings(settings, action, cwd) as any
    expect(result.sandbox.filesystem.denyWrite).toContain(cwd)
    const encoded = result.hooks.PreToolUse[0].hooks[0].command.split(' --session-context ')[1]
    expect(JSON.parse(Buffer.from(encoded, 'base64').toString())).toEqual({skill: '/closeyourit-skills:triage', ticket: 'CYRA-1', cwd})
  })

  it('rejects release helpers outside the assigned phase, ticket or checkout', () => {
    const plugin = directory()
    const folder = join(plugin, 'skills/closer-production/scripts')
    mkdirSync(folder, {recursive: true})
    const script = join(folder, 'release.sh')
    writeFileSync(script, '#!/bin/sh\nexit 0\n')
    const sha = 'a'.repeat(40)
    const command = `bash ${script} --ticket CYRA-1 --cwd /workspace --tag v1.2.3 --sha ${sha} --execute`
    const session = {skill: '/closeyourit-skills:closer-production', ticket: 'CYRA-1', cwd: '/workspace',
      release: {version: 'v1.2.3', sha, expiresAt: Date.now() + 60_000}}
    expect(evaluate(command, plugin).blocked).toBe(true)
    expect(evaluate(command, plugin, {...session, skill: '/closeyourit-skills:autopilot'}).blocked).toBe(true)
    expect(evaluate(command, plugin, {...session, ticket: 'CYRA-2'}).blocked).toBe(true)
    expect(evaluate(command, plugin, {...session, cwd: '/other'}).blocked).toBe(true)
    expect(evaluate(command, plugin, session).blocked).toBe(false)
    expect(evaluate(`${command} --ticket CYRA-2`, plugin, session).blocked).toBe(true)
    expect(evaluate(command.replace('v1.2.3', 'v9.9.9'), plugin, session).blocked).toBe(true)
    expect(evaluate(command.replace(sha, 'b'.repeat(40)), plugin, session).blocked).toBe(true)
    expect(evaluate(command, plugin, {...session, release: undefined}).blocked).toBe(true)
    expect(evaluate(command, plugin, {...session, release: {...session.release, expiresAt: 0}}).blocked).toBe(true)
  })

  it('keeps host release authority through runner copies but not JSON input', () => {
    const settings = join(directory(), 'settings.json')
    writeFileSync(settings, JSON.stringify({hooks: {PreToolUse: [{hooks: [{command: 'node /hooks/block-indirect-exec.mjs'}]}]}}))
    const action = PlaybookSchema.parse({version: 1, actions: {release: {
      type: 'claude', schedule: 'every 1m', run: 'release', containment: 'strong',
      skill: {command: '/closeyourit-skills:closer-production', args: 'CYRA-1', plugin_dir: '/plugin'},
    }}}).actions.release
    const assigned = bindReleaseAuthority(action, {version: 'v1.2.3', sha: 'a'.repeat(40)})
    const context = (value: typeof action) => {
      const result = sessionSettings(settings, value, '/workspace') as any
      return JSON.parse(Buffer.from(result.hooks.PreToolUse[0].hooks[0].command.split(' --session-context ')[1], 'base64').toString())
    }
    expect(context({...assigned, run: 'retry'}).release).toMatchObject({version: 'v1.2.3', sha: 'a'.repeat(40)})
    expect(context(JSON.parse(JSON.stringify(assigned))).release).toBeUndefined()
  })
})
