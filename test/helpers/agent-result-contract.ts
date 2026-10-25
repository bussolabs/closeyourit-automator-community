import {type ExecutionPhase} from '../../src/lib/phase-profile'
import {contractEnums, type ContractFixture, type ContractManifest, withValueAt, VALORE_FUORI_CONTRATTO} from './contract'

/**
 * CYAU-188 — link between the vendored `agent-result` contract and the hand-written zod of
 * `src/lib/typed-workflow.ts`.
 *
 * The zod is NOT generated from `schema.json`, on purpose: it also encodes constraints that are not in the shape
 * contract (the clarification question length limit, a server-side business rule; the stricter
 * judge of the PR URL from CYAU-173) and relaxes others (`.passthrough()`, because the server revalidates).
 * A generator would erase both choices and would have nowhere to note the reason.
 *
 * The defence against divergence is therefore here: the examples to pass are NOT listed by hand, they are read
 * from the contract manifest. A fixture added to the bundle automatically enters the check, and a zod
 * that stopped matching the contract says so with a red — without anyone having to remember to
 * extend a list. The pieces not specific to this contract live in `helpers/contract.ts`.
 */
export {
  contractEnums,
  type ContractEnum,
  type ContractFixture,
  type ContractManifest,
  fixtureFilesOnDisk,
  VALORE_FUORI_CONTRATTO,
  withValueAt,
} from './contract'

export type PhaseFixture = ContractFixture & {phase: ExecutionPhase}

/**
 * Contract definitions that are the RESULT of a phase, that is what `parseWorkflowResult` reads
 * from a session's stdout. The key is the schema definition, the value the phase with which the
 * result is signed in the claim.
 */
export const PHASE_BY_DEFINITION: Readonly<Record<string, ExecutionPhase>> = Object.freeze({
  triage_result: 'triage',
  planner_result: 'planner',
  autopilot_result: 'autopilot',
  closer_staging_result: 'closer_staging',
  closer_production_result: 'closer_production',
})

/**
 * Contract definitions that are NOT a phase result and for which there is no local check to
 * put in parity: `delivery_envelope` is the package the automator BUILDS for the server (typed
 * in `client.ts`), not something it reads from an agent.
 *
 * The list is closed on purpose: a new definition in the contract must not be silently skipped
 * by the parity check: either it is mapped to a phase, or it is declared here knowing why.
 */
export const NON_PHASE_DEFINITIONS: ReadonlySet<string> = new Set(['delivery_envelope'])

/** Manifest fixtures that are a phase result, already paired with the phase they must be parsed with. */
export function phaseFixtures(manifest: ContractManifest, valid: boolean): PhaseFixture[] {
  return manifest.fixtures
    .filter((fixture) => fixture.valid === valid && PHASE_BY_DEFINITION[fixture.definition] !== undefined)
    .map((fixture) => ({...fixture, phase: PHASE_BY_DEFINITION[fixture.definition]}))
}

/** A parity case: an instance derived from the contract, to be judged with ajv and with the zod. */
export interface ParityCase {
  name: string
  phase: ExecutionPhase
  definition: string
  instance: unknown
}

/**
 * Cases derived from the closed lists of the contract: for every result definition, every valid example
 * is rewritten with each allowed value and with an out-of-list value.
 *
 * No expectation is written here: the expected verdict is given by the canonical schema (ajv) and the test only asks
 * that the local check says the same. This is what makes the check derived instead of copied — a
 * list widened or narrowed in the contract changes the cases and the verdicts by itself.
 *
 * @param defs definitions of the contract schema (`$defs`)
 * @param readFixture reads a bundle fixture from the manifest path
 * @param stamp normalizes the instance for the bundle version (e.g. the `contract_version` marker)
 */
export function enumParityCases(
  manifest: ContractManifest,
  defs: Record<string, unknown>,
  readFixture: (relative: string) => unknown,
  stamp: (instance: unknown) => unknown = (instance) => instance,
): ParityCase[] {
  const cases: ParityCase[] = []
  for (const fixture of phaseFixtures(manifest, true)) {
    const base = stamp(readFixture(fixture.path))
    for (const closed of contractEnums(defs[fixture.definition], defs)) {
      const label = closed.path.join('.')
      for (const value of [...closed.values, VALORE_FUORI_CONTRATTO]) {
        const instance = withValueAt(base, closed.path, value)
        if (instance === undefined) continue
        cases.push({
          name: `${fixture.path} con ${label}=${JSON.stringify(value)}`,
          phase: fixture.phase,
          definition: fixture.definition,
          instance,
        })
      }
    }
  }
  return cases
}
