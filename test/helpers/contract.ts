import * as fs from 'node:fs'
import * as path from 'node:path'

/**
 * COMMON pieces of the tests derived from a vendored contract (`test/contracts/<name>/v<N>`).
 *
 * Born with CYAU-188 for `agent-result`, they live here because every contract has the same problem: the local
 * check is hand-written — and must stay so, because it encodes constraints the shape contract does not have and
 * relaxes others — so the defence against divergence cannot be a generator, it must be a test that
 * reads the bundle. The examples to pass are NOT listed by hand, they are read from the manifest; the edge cases
 * are not made up, they are derived from the closed lists of the schema with ajv as the oracle.
 */
export interface ContractFixture {
  path: string
  definition: string
  valid: boolean
}

export interface ContractManifest {
  fixtures: ContractFixture[]
}

/**
 * Fixtures present on disk under `fixtures/`, relative to the contract root (the same form in which
 * the manifest writes them). It proves that the manifest — from which the parity check is derived — really
 * lists them all: an unlisted example would never be tested against the local check.
 */
export function fixtureFilesOnDisk(contractRoot: string): string[] {
  const found: string[] = []
  const scan = (dir: string, prefix: string) => {
    for (const entry of fs.readdirSync(dir, {withFileTypes: true})) {
      const relative = `${prefix}/${entry.name}`
      if (entry.isDirectory()) scan(path.join(dir, entry.name), relative)
      else found.push(relative)
    }
  }
  scan(path.join(contractRoot, 'fixtures'), 'fixtures')
  return found.sort()
}

/** A closed list declared by the contract, with the path where it lives inside the payload. */
export interface ContractEnum {
  path: string[]
  values: unknown[]
}

/** A format (`format`) declared by the contract, with the path of the property carrying it. */
export interface ContractFormat {
  path: string[]
  format: string
}

/**
 * Walks a contract definition and visits every node with the path where it lives. `[]` in a path
 * means "every element of the array".
 *
 * Only `properties` and `items` are descended, NEVER the `allOf`/`if`/`then` branches: there the constraints do not describe the
 * property domain, they NARROW it for a particular case (`gate.passed` is `true|null` only on
 * `delivered`). Replacing their values as if they were the domain would produce reds on conditional rules that
 * the contract definitely wants — the invalid fixtures stay the way to test those.
 *
 * Internal `$ref`s ARE followed. In v2 of `agent-result` almost all the substance lives behind a reference
 * — `failure`, `work_report`, `structured_plan` — and stopping at the reference left out of the check the
 * longest lists of the contract: the parity would have called itself green without ever looking at them. `seen` stops
 * the recursive references.
 */
function walkContract(
  definition: unknown,
  defs: Record<string, unknown>,
  visit: (node: {enum?: unknown[]; format?: unknown}, at: string[]) => void,
): void {
  const walk = (node: unknown, at: string[], seen: ReadonlySet<string>) => {
    if (node === null || typeof node !== 'object') return
    const schema = node as {
      $ref?: unknown
      enum?: unknown[]
      format?: unknown
      properties?: Record<string, unknown>
      items?: unknown
    }
    if (typeof schema.$ref === 'string') {
      const name = schema.$ref.startsWith('#/$defs/') ? schema.$ref.slice('#/$defs/'.length) : undefined
      if (name === undefined) throw new Error(`unresolvable reference in the contract schema: ${schema.$ref}`)
      if (seen.has(name)) return
      if (!(name in defs)) throw new Error(`definition referenced but missing from the contract schema: ${name}`)
      walk(defs[name], at, new Set([...seen, name]))
      return
    }
    if (at.length > 0) visit(schema, at)
    if (schema.properties) for (const [key, child] of Object.entries(schema.properties)) walk(child, [...at, key], seen)
    if (schema.items) walk(schema.items, [...at, '[]'], seen)
  }
  walk(definition, [], new Set())
}

/** Closed lists (`enum`) declared by a contract definition, with the path hosting them. */
export function contractEnums(definition: unknown, defs: Record<string, unknown> = {}): ContractEnum[] {
  const found: ContractEnum[] = []
  walkContract(definition, defs, (node, at) => {
    if (Array.isArray(node.enum)) found.push({path: at, values: node.enum})
  })
  return found
}

/**
 * Formats (`format`) declared by a contract definition. They prove that the local judge
 * recognizes the same strings: a `format` not copied lets anything through, and the local check
 * would call itself in parity while being looser than the contract.
 */
export function contractFormats(definition: unknown, defs: Record<string, unknown> = {}): ContractFormat[] {
  const found: ContractFormat[] = []
  walkContract(definition, defs, (node, at) => {
    if (typeof node.format === 'string') found.push({path: at, format: node.format})
  })
  return found
}

/**
 * Copy of `value` with the `path` set to `replacement`, if that path ALREADY exists. Returns
 * `undefined` when it does not exist and cannot be created (a missing intermediate branch): an example that does not host
 * that property has nothing to say about that list, and making up a branch for it would say something else.
 *
 * The last segment instead is created even if missing: an optional property exists precisely to
 * be added, and that is where a closed list not copied into the local check hides.
 */
export function withValueAt(value: unknown, path: string[], replacement: unknown): unknown | undefined {
  if (path.length === 0) return replacement
  const [head, ...rest] = path
  if (head === '[]') {
    if (!Array.isArray(value) || value.length === 0) return undefined
    const items = value.map((item) => withValueAt(item, rest, replacement))
    return items.some((item) => item === undefined) ? undefined : items
  }
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return undefined
  const record = value as Record<string, unknown>
  if (rest.length > 0 && !(head in record)) return undefined
  const child = rest.length === 0 ? replacement : withValueAt(record[head], rest, replacement)
  if (child === undefined) return undefined
  return {...record, [head]: child}
}

/**
 * Value OUTSIDE a closed list, used to prove that the local check rejects it as the
 * contract does: an enum not copied by hand lets anything through, and the host treats as good
 * something the contract already knows is invalid.
 */
export const VALORE_FUORI_CONTRATTO = '__fuori-contratto__'
