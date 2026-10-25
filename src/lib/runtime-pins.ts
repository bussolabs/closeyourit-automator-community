import {spawnSync} from 'node:child_process'
import {RUNTIME_VERSIONS} from './models'
import {type RuntimeReadiness} from './runtime-probe'

// Brings Claude and Codex to the versions pinned in the release, really tests them and, if the test fails, puts
// back the previous versions. Without it, the automator updated itself and the two CLIs did not: Codex was ten versions
// behind and rejected the new model.

type Tool = 'claude' | 'codex'
const TOOLS: readonly Tool[] = ['claude', 'codex']

export type PinCommand = (cmd: string, args: string[]) => {code: number | null; stdout: string}
export type PinResult =
  | {outcome: 'aligned'}
  | {outcome: 'updated'; changes: string[]}
  | {outcome: 'rolled-back' | 'failed'; detail: string}

export function defaultPinCommand(cmd: string, args: string[]): {code: number | null; stdout: string} {
  // The child inherits the umask. With the distro default 0002 the runtimes landed group-writable and the review
  // trust policy refused them, so no diff review could start (CYRA-878).
  const previous = process.umask(0o022)
  try {
    const result = spawnSync(cmd, args, {encoding: 'utf8', timeout: 300_000, stdio: ['ignore', 'pipe', 'ignore']})
    return {code: result.error ? null : result.status, stdout: result.stdout ?? ''}
  } finally {
    process.umask(previous)
  }
}

function installArgs(tool: Tool, version: string): [string, string[]] {
  return tool === 'claude' ? ['claude', ['install', version]] : ['npm', ['install', '-g', `@openai/codex@${version}`]]
}

function installedVersion(run: PinCommand, tool: Tool): string | null {
  const result = run(tool, ['--version'])
  return result.code === 0 ? /(\d+\.\d+\.\d+)/.exec(result.stdout)?.[1] ?? null : null
}

export async function reconcileRuntimePins(
  deps: {run?: PinCommand; probe: () => Promise<RuntimeReadiness>},
  pins: Record<Tool, string> = RUNTIME_VERSIONS,
): Promise<PinResult> {
  const run = deps.run ?? defaultPinCommand
  const before = Object.fromEntries(TOOLS.map((tool) => [tool, installedVersion(run, tool)])) as Record<Tool, string | null>
  const drift = TOOLS.filter((tool) => before[tool] !== pins[tool])
  if (drift.length === 0) return {outcome: 'aligned'}

  const restore = (): string => {
    const restorable = drift.filter((tool) => before[tool] !== null)
    for (const tool of restorable) run(...installArgs(tool, before[tool]!))
    return restorable.length === 0
      ? 'nessuna versione precedente da ripristinare'
      : `tornato a ${restorable.map((tool) => `${tool} ${before[tool]}`).join(', ')}`
  }

  for (const tool of drift) {
    if (run(...installArgs(tool, pins[tool])).code !== 0) {
      return {outcome: 'failed', detail: `installazione di ${tool} ${pins[tool]} non riuscita: ${restore()}`}
    }
  }
  const ready = await deps.probe()
  if (ready.ready) return {outcome: 'updated', changes: drift.map((tool) => `${tool} ${before[tool] ?? 'assente'} → ${pins[tool]}`)}
  const tried = drift.map((tool) => `${tool} ${pins[tool]}`).join(', ')
  return {outcome: 'rolled-back', detail: `prova fallita con ${tried} (${ready.detail}): ${restore()}`}
}
