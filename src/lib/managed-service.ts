import {randomUUID} from 'node:crypto'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import {z} from 'zod'
import type {GuardrailPaths} from './guardrails'

const AbsolutePathSchema = z.string().min(1).refine(path.isAbsolute, 'path assoluto richiesto')

const ManagedServiceConfigSchema = z.object({
  version: z.literal(1),
  codexHome: AbsolutePathSchema,
  nodePath: AbsolutePathSchema,
  guardrails: z.object({
    hooksDir: AbsolutePathSchema,
    settingsPath: AbsolutePathSchema,
    codexRulesPath: AbsolutePathSchema,
    worktreesRoot: AbsolutePathSchema,
  }).strict(),
}).strict().superRefine((value, ctx) => {
  const expected = path.join(value.codexHome, 'rules', 'closeyourit-automator.rules')
  if (value.guardrails.codexRulesPath !== expected) {
    ctx.addIssue({code: z.ZodIssueCode.custom, path: ['guardrails', 'codexRulesPath'], message: 'path non coerente con codexHome'})
  }
})

export type ManagedServiceConfig = z.infer<typeof ManagedServiceConfigSchema>

export function managedServiceConfigPath(installRoot: string): string {
  return path.join(path.resolve(installRoot), 'service-runtime.json')
}

function fsyncDirectory(directory: string): void {
  const descriptor = fs.openSync(directory, 'r')
  try {
    fs.fsyncSync(descriptor)
  } finally {
    fs.closeSync(descriptor)
  }
}

/** Publishes the non-secret configuration used by the unit, so a later CLI uses the same paths. */
export function saveManagedServiceConfig(installRoot: string, input: ManagedServiceConfig): void {
  const value = ManagedServiceConfigSchema.parse(input)
  const destination = managedServiceConfigPath(installRoot)
  const directory = path.dirname(destination)
  fs.mkdirSync(directory, {recursive: true})
  const temporary = `${destination}.${process.pid}.${randomUUID()}.tmp`
  let descriptor: number | null = null
  try {
    descriptor = fs.openSync(temporary, 'wx', 0o600)
    fs.writeFileSync(descriptor, `${JSON.stringify(value)}\n`, 'utf8')
    fs.fsyncSync(descriptor)
    fs.closeSync(descriptor)
    descriptor = null
    fs.renameSync(temporary, destination)
    fsyncDirectory(directory)
  } finally {
    if (descriptor !== null) fs.closeSync(descriptor)
    fs.rmSync(temporary, {force: true})
  }
}

/** Missing = legacy installation (default paths); present but corrupt = fail-closed. */
export function loadManagedServiceConfig(installRoot: string): ManagedServiceConfig | null {
  const source = managedServiceConfigPath(installRoot)
  try {
    const stat = fs.lstatSync(source)
    if (!stat.isFile() || stat.isSymbolicLink()) throw new Error('metadata servizio non regolare')
    return ManagedServiceConfigSchema.parse(JSON.parse(fs.readFileSync(source, 'utf8')))
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null
    const detail = error instanceof Error ? error.message : String(error)
    throw new Error(`metadata servizio gestito non valida: ${detail}`)
  }
}

export function managedGuardrailPaths(installRoot: string): GuardrailPaths {
  const persisted = loadManagedServiceConfig(installRoot)
  if (persisted) return {...persisted.guardrails, nodePath: persisted.nodePath}
  // Legacy units did not persist CODEX_HOME: the daemon therefore used the default, even if a later shell
  // exports a different override. The other paths stay at the historical defaults resolved by installGuardrails.
  return {codexRulesPath: path.join(os.homedir(), '.codex', 'rules', 'closeyourit-automator.rules')}
}

function managedRootFromEntrypoint(entrypoint: string | undefined): string | null {
  if (!entrypoint || !path.isAbsolute(entrypoint)) return null
  const resolved = path.resolve(entrypoint)
  if (path.basename(resolved) !== 'run.js') return null
  const bin = path.dirname(resolved)
  const current = path.dirname(bin)
  if (path.basename(bin) !== 'bin' || path.basename(current) !== 'current') return null
  return path.dirname(current)
}

/** Authoritative paths for the current unit's process; root env and entrypoint must agree. */
export function activeManagedGuardrailPaths(entrypoint: string | undefined = process.argv[1]): GuardrailPaths {
  const managedRoot = process.env.AUTOMATOR_INSTALL_ROOT?.trim()
  if (!managedRoot) return {}
  const rootFromEntrypoint = managedRootFromEntrypoint(entrypoint)
  const rootFromEnvironment = path.resolve(managedRoot)
  if (rootFromEntrypoint !== rootFromEnvironment) {
    throw new Error('root gestita dell\'environment non coincide con l\'entrypoint effettivo')
  }
  return {...managedGuardrailPaths(rootFromEntrypoint), nodePath: process.execPath}
}
