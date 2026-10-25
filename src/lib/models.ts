// Models pinned for every session started by the automator, work and review. Without them, each CLI uses its own
// default, which changes by itself at every Claude Code or Codex update.
//
// CYRA-921 — a machine can pick other models with AUTOMATOR_CLAUDE_MODEL / AUTOMATOR_CODEX_MODEL (for example
// a model its subscription allows); empty or missing keeps these defaults.
export const DEFAULT_CLAUDE_MODEL = 'claude-opus-5-5'
export const DEFAULT_CODEX_MODEL = 'gpt-6-astra'

export function modelFrom(value: string | undefined, fallback: string): string {
  const trimmed = value?.trim()
  return trimmed ? trimmed : fallback
}

export const CLAUDE_MODEL = modelFrom(process.env.AUTOMATOR_CLAUDE_MODEL, DEFAULT_CLAUDE_MODEL)
export const CODEX_MODEL = modelFrom(process.env.AUTOMATOR_CODEX_MODEL, DEFAULT_CODEX_MODEL)

// Versions of the CLIs that serve the default models: `update` installs and tests them (CYAU-209). Opus 5.5 requires
// Claude Code >= 2.1.280 and gpt-6-astra Codex >= 0.156.1: older versions reject them.
export const RUNTIME_VERSIONS = {claude: '2.1.296', codex: '0.162.1'} as const

// CYRA-921 — the engine this machine installs to do the work (the server sends the same choice with each piece of
// work). It decides which CLI `setup` and `doctor` require: Claude by default, Codex with AUTOMATOR_WORK_ENGINE=codex.
export function workEngineFrom(value: string | undefined): 'claude' | 'codex' {
  return value?.trim() === 'codex' ? 'codex' : 'claude'
}

export const LOCAL_WORK_ENGINE = workEngineFrom(process.env.AUTOMATOR_WORK_ENGINE)
