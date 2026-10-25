import * as os from 'node:os'
import * as path from 'node:path'
import {afterEach, describe, expect, it} from 'vitest'
import {
  automatorConfigCachePath,
  configDir,
  codexHomeDir,
  codexGuardrailsRulesPath,
  daemonLogPath,
  dataDir,
  guardrailsDir,
  guardrailsHooksDir,
  guardrailsSettingsPath,
  installRoot,
  leasesDir,
  lockPath,
  logsDir,
  runsDir,
  playbookPath,
  repositoriesDir,
  skillsDir,
  skillsModeEnabled,
  skillsPluginDir,
  stateDir,
  statePath,
  worktreesDir,
} from '../src/lib/paths'

const saved = {...process.env}
afterEach(() => {
  process.env = {...saved}
})

function clearEnv(): void {
  delete process.env.AUTOMATOR_STATE_DIR
  delete process.env.AUTOMATOR_CONFIG_DIR
  delete process.env.AUTOMATOR_DATA_DIR
  delete process.env.AUTOMATOR_INSTALL_ROOT
  delete process.env.AUTOMATOR_PLAYBOOK
  delete process.env.XDG_STATE_HOME
  delete process.env.XDG_CONFIG_HOME
  delete process.env.XDG_DATA_HOME
  delete process.env.CODEX_HOME
  delete process.env.AUTOMATOR_SKILLS_DIR
  delete process.env.AUTOMATOR_SKILLS_ENABLED
}

describe('stateDir', () => {
  it('default → ~/.local/state/closeyourit-automator', () => {
    clearEnv()
    expect(stateDir()).toBe(path.join(os.homedir(), '.local', 'state', 'closeyourit-automator'))
  })

  it('override AUTOMATOR_STATE_DIR vince su tutto', () => {
    clearEnv()
    process.env.AUTOMATOR_STATE_DIR = '/custom/state'
    expect(stateDir()).toBe('/custom/state')
  })

  it('rispetta XDG_STATE_HOME', () => {
    clearEnv()
    process.env.XDG_STATE_HOME = '/xdg/state'
    expect(stateDir()).toBe(path.join('/xdg/state', 'closeyourit-automator'))
  })
})

describe('configDir', () => {
  it('default → ~/.config/closeyourit-automator', () => {
    clearEnv()
    expect(configDir()).toBe(path.join(os.homedir(), '.config', 'closeyourit-automator'))
  })

  it('rispetta XDG_CONFIG_HOME e l’override dedicato', () => {
    clearEnv()
    process.env.XDG_CONFIG_HOME = '/xdg/config'
    expect(configDir()).toBe(path.join('/xdg/config', 'closeyourit-automator'))
    process.env.AUTOMATOR_CONFIG_DIR = '/custom/config'
    expect(configDir()).toBe('/custom/config')
  })
})

describe('derivati di stateDir', () => {
  it('compongono su stateDir', () => {
    clearEnv()
    process.env.AUTOMATOR_STATE_DIR = '/s'
    expect(statePath()).toBe('/s/state.json')
    expect(logsDir()).toBe('/s/logs')
    expect(lockPath()).toBe('/s/tick.lock')
    expect(daemonLogPath()).toBe('/s/daemon.log')
    expect(runsDir()).toBe('/s/runs')
    expect(leasesDir()).toBe('/s/leases')
    expect(automatorConfigCachePath()).toBe('/s/automator-config.json')
    // keyed by host_id (sanitized: separators → `_`, always `.json` extension, never a `..` segment)
    expect(automatorConfigCachePath('host-123')).toBe('/s/automator-config-cache/host-123.json')
    expect(automatorConfigCachePath('a/b/c')).toBe('/s/automator-config-cache/a_b_c.json')
  })
})

describe('playbookPath', () => {
  it('argomento esplicito ha precedenza (risolto assoluto)', () => {
    clearEnv()
    process.env.AUTOMATOR_PLAYBOOK = '/env/pb.yml'
    expect(playbookPath('/explicit/pb.yml')).toBe('/explicit/pb.yml')
  })

  it('fallback su AUTOMATOR_PLAYBOOK', () => {
    clearEnv()
    process.env.AUTOMATOR_PLAYBOOK = '/env/pb.yml'
    expect(playbookPath()).toBe('/env/pb.yml')
  })

  it('default → ./playbook.yml (absolute relative to the cwd)', () => {
    clearEnv()
    expect(playbookPath()).toBe(path.resolve('playbook.yml'))
  })
})

describe('dataDir e layout gestito', () => {
  it('default → ~/.local/share/closeyourit-automator', () => {
    clearEnv()
    expect(dataDir()).toBe(path.join(os.homedir(), '.local', 'share', 'closeyourit-automator'))
  })

  it('override AUTOMATOR_DATA_DIR vince su tutto', () => {
    clearEnv()
    process.env.XDG_DATA_HOME = '/xdg/data'
    process.env.AUTOMATOR_DATA_DIR = '/custom/data'
    expect(dataDir()).toBe('/custom/data')
  })

  it('rispetta XDG_DATA_HOME', () => {
    clearEnv()
    process.env.XDG_DATA_HOME = '/xdg/data'
    expect(dataDir()).toBe(path.join('/xdg/data', 'closeyourit-automator'))
  })

  it('repositoriesDir/worktreesDir compongono su dataDir', () => {
    clearEnv()
    process.env.AUTOMATOR_DATA_DIR = '/d'
    expect(repositoriesDir()).toBe('/d/repositories')
    expect(worktreesDir()).toBe('/d/worktrees')
  })
})

describe('installRoot (CYAU-33: managed installation of the code)', () => {
  it('default → ~/.local/lib/closeyourit-automator (codice ≠ stato/dati XDG)', () => {
    clearEnv()
    expect(installRoot()).toBe(path.join(os.homedir(), '.local', 'lib', 'closeyourit-automator'))
  })

  it('override AUTOMATOR_INSTALL_ROOT vince', () => {
    clearEnv()
    process.env.AUTOMATOR_INSTALL_ROOT = '/opt/automator'
    expect(installRoot()).toBe('/opt/automator')
  })

  it('an empty/whitespace override falls back to the default', () => {
    clearEnv()
    process.env.AUTOMATOR_INSTALL_ROOT = '   '
    expect(installRoot()).toBe(path.join(os.homedir(), '.local', 'lib', 'closeyourit-automator'))
  })
})

describe('guardrails paths', () => {
  it('compongono su configDir', () => {
    clearEnv()
    process.env.AUTOMATOR_CONFIG_DIR = '/c'
    expect(guardrailsDir()).toBe('/c/guardrails')
    expect(guardrailsHooksDir()).toBe('/c/guardrails/hooks')
    expect(guardrailsSettingsPath()).toBe('/c/guardrails/settings.json')
  })

  it('the Codex exec policy lives in the active CODEX_HOME, outside the target repo', () => {
    clearEnv()
    process.env.CODEX_HOME = '/managed/codex'
    expect(codexHomeDir()).toBe('/managed/codex')
    expect(codexGuardrailsRulesPath()).toBe('/managed/codex/rules/closeyourit-automator.rules')
  })

  it('normalizes a relative CODEX_HOME before installing it or passing it to the service', () => {
    clearEnv()
    process.env.CODEX_HOME = 'relative-codex-home'
    expect(codexHomeDir()).toBe(path.resolve('relative-codex-home'))
    expect(codexGuardrailsRulesPath()).toBe(path.resolve('relative-codex-home/rules/closeyourit-automator.rules'))
  })
})

describe('skills paths (skill-mode, C.3)', () => {
  it('skillsDir compone su dataDir; skillsPluginDir → skills/current di default', () => {
    clearEnv()
    process.env.AUTOMATOR_DATA_DIR = '/d'
    expect(skillsDir()).toBe('/d/skills')
    expect(skillsPluginDir()).toBe(path.join('/d', 'skills', 'current'))
  })

  it('AUTOMATOR_SKILLS_DIR override wins over the default', () => {
    clearEnv()
    process.env.AUTOMATOR_DATA_DIR = '/d'
    process.env.AUTOMATOR_SKILLS_DIR = '/custom/skills-bundle'
    expect(skillsPluginDir()).toBe('/custom/skills-bundle')
  })

  it('an empty/whitespace override falls back to the default', () => {
    clearEnv()
    process.env.AUTOMATOR_DATA_DIR = '/d'
    process.env.AUTOMATOR_SKILLS_DIR = '   '
    expect(skillsPluginDir()).toBe(path.join('/d', 'skills', 'current'))
  })
})

describe('skillsModeEnabled (interruttore skill-mode)', () => {
  it('off by default when the env is missing', () => {
    clearEnv()
    expect(skillsModeEnabled()).toBe(false)
  })

  it('on with 1 or true (case-insensitive)', () => {
    clearEnv()
    process.env.AUTOMATOR_SKILLS_ENABLED = '1'
    expect(skillsModeEnabled()).toBe(true)
    process.env.AUTOMATOR_SKILLS_ENABLED = 'TRUE'
    expect(skillsModeEnabled()).toBe(true)
  })

  it('off with any other value', () => {
    clearEnv()
    process.env.AUTOMATOR_SKILLS_ENABLED = 'yes'
    expect(skillsModeEnabled()).toBe(false)
    process.env.AUTOMATOR_SKILLS_ENABLED = '0'
    expect(skillsModeEnabled()).toBe(false)
  })
})
