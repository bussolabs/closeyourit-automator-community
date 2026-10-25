import * as fs from 'node:fs'
import * as path from 'node:path'
import {type Action} from './schema'

const RELEASE_AUTHORITY = Symbol('host-issued-release')
type ReleaseAuthority = {version: string; sha?: string; expiresAt: number}

/** A symbol survives runner object spreads but cannot arrive through JSON, YAML or model output. */
export function bindReleaseAuthority(action: Action, release?: {version: string; sha?: string}): Action {
  if (!release) return action
  return Object.assign({}, action, {[RELEASE_AUTHORITY]: Object.freeze({
    version: release.version, sha: release.sha, expiresAt: Date.now() + (action.timeout ?? 3600) * 1000,
  })})
}

/** Bind trusted hook exceptions to the host-issued phase, ticket and checkout. */
export function sessionSettings(settingsPath: string, action: Action, cwd: string): Record<string, unknown> {
  const settings = JSON.parse(fs.readFileSync(settingsPath, 'utf8'))
  const skill = action.type === 'shell' ? undefined : action.skill
  const release = (action as Action & {[RELEASE_AUTHORITY]?: ReleaseAuthority})[RELEASE_AUTHORITY]
  const context = Buffer.from(JSON.stringify({skill: skill?.command, ticket: skill?.args, cwd: path.resolve(cwd), release})).toString('base64')
  for (const group of settings.hooks?.PreToolUse ?? []) {
    for (const hook of group.hooks ?? []) {
      if (typeof hook.command === 'string' && hook.command.includes('block-indirect-exec.mjs')) {
        hook.command += ` --session-context ${context}`
      }
    }
  }
  if (action.type === 'claude' && action.allowed_tools?.length &&
      !action.allowed_tools.some((tool) => ['Edit', 'Write', 'MultiEdit', 'NotebookEdit'].includes(tool))) {
    settings.sandbox = {...settings.sandbox, filesystem: {
      ...settings.sandbox?.filesystem,
      denyWrite: [...(settings.sandbox?.filesystem?.denyWrite ?? []), path.resolve(cwd)],
    }}
  }
  return settings
}
