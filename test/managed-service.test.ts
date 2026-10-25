import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import {afterEach, beforeEach, describe, expect, it} from 'vitest'
import {activeManagedGuardrailPaths, loadManagedServiceConfig, managedGuardrailPaths, managedServiceConfigPath, saveManagedServiceConfig} from '../src/lib/managed-service'

let root: string
beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'automator-managed-service-'))
})
afterEach(() => fs.rmSync(root, {recursive: true, force: true}))

describe('managed service metadata', () => {
  const config = (base: string) => ({
    version: 1 as const,
    codexHome: path.join(base, 'codex'),
    nodePath: path.join(base, 'mise', 'node'),
    guardrails: {
      hooksDir: path.join(base, 'config', 'guardrails', 'hooks'),
      settingsPath: path.join(base, 'config', 'guardrails', 'settings.json'),
      codexRulesPath: path.join(base, 'codex', 'rules', 'closeyourit-automator.rules'),
      worktreesRoot: path.join(base, 'data', 'worktrees'),
    },
  })

  it('atomically saves non-secret absolute paths and re-reads them', () => {
    const expected = config(root)
    saveManagedServiceConfig(root, expected)
    expect(loadManagedServiceConfig(root)).toEqual(expected)
    expect(fs.lstatSync(managedServiceConfigPath(root)).isFile()).toBe(true)
    expect(fs.statSync(managedServiceConfigPath(root)).mode & 0o777).toBe(0o600)
  })

  it('missing is legacy, while a symlink or corrupt content fail closed', () => {
    expect(loadManagedServiceConfig(root)).toBeNull()
    fs.writeFileSync(path.join(root, 'target.json'), JSON.stringify(config(root)))
    fs.symlinkSync(path.join(root, 'target.json'), managedServiceConfigPath(root))
    expect(() => loadManagedServiceConfig(root)).toThrow(/non regolare/)
    fs.rmSync(managedServiceConfigPath(root))
    fs.writeFileSync(managedServiceConfigPath(root), '{}')
    expect(() => loadManagedServiceConfig(root)).toThrow(/non valida/)
  })

  it('rejects metadata with relative paths or a CODEX_HOME inconsistent with the policy', () => {
    expect(() => saveManagedServiceConfig(root, {
      ...config(root),
      nodePath: 'node',
    })).toThrow(/path assoluto/i)
    expect(() => saveManagedServiceConfig(root, {
      ...config(root),
      guardrails: {
        ...config(root).guardrails,
        codexRulesPath: path.join(root, 'altro-codex', 'rules', 'closeyourit-automator.rules'),
      },
    })).toThrow(/non coerente/i)
  })

  it('without metadata a legacy unit stays on the default CODEX_HOME, not on the shell one', () => {
    const previous = process.env.CODEX_HOME
    process.env.CODEX_HOME = path.join(root, 'shell-only')
    try {
      expect(managedGuardrailPaths(root)?.codexRulesPath).toBe(
        path.join(os.homedir(), '.codex', 'rules', 'closeyourit-automator.rules'),
      )
    } finally {
      if (previous === undefined) delete process.env.CODEX_HOME
      else process.env.CODEX_HOME = previous
    }
  })

  it('the managed process validates the sessions with the persisted paths and its own effective Node', () => {
    const expected = config(root)
    saveManagedServiceConfig(root, expected)
    const previous = process.env.AUTOMATOR_INSTALL_ROOT
    process.env.AUTOMATOR_INSTALL_ROOT = root
    try {
      expect(activeManagedGuardrailPaths(path.join(root, 'current', 'bin', 'run.js'))).toEqual({
        ...expected.guardrails,
        nodePath: process.execPath,
      })
      expect(() => activeManagedGuardrailPaths('/other/current/bin/run.js')).toThrow(/entrypoint effettivo/i)
    } finally {
      if (previous === undefined) delete process.env.AUTOMATOR_INSTALL_ROOT
      else process.env.AUTOMATOR_INSTALL_ROOT = previous
    }
  })

  it('without a managed root applies no override and with malformed entrypoints fails closed', () => {
    const previous = process.env.AUTOMATOR_INSTALL_ROOT
    delete process.env.AUTOMATOR_INSTALL_ROOT
    expect(activeManagedGuardrailPaths('/checkout/bin/run.js')).toEqual({})
    process.env.AUTOMATOR_INSTALL_ROOT = root
    try {
      for (const entrypoint of [undefined, 'relative/run.js', '/opt/current/bin/not-run', '/opt/current/run.js']) {
        expect(() => activeManagedGuardrailPaths(entrypoint)).toThrow(/entrypoint effettivo/i)
      }
    } finally {
      if (previous === undefined) delete process.env.AUTOMATOR_INSTALL_ROOT
      else process.env.AUTOMATOR_INSTALL_ROOT = previous
    }
  })
})
