// CYAU-170 — the machine declares which manual it is running, and takes no work if it is not the right one.
//
// The defect these tests close was not visible anywhere: the check before taking
// a ticket only verified that the link to the manual RESOLVED, not that it pointed to the
// right version. A machine left behind — expired `gh` session, sync failed
// silently — kept taking work and delivering results produced by old instructions, and
// the server accepted them all: the result does not say which manual it comes from. The only signal was a
// line in the machine's local log.
import {describe, expect, it} from 'vitest'
import {
  activeBundleIdentity, compareBundleToPin,
  type SkillsGit, type SkillsManifest, type SkillsManifestClient,
} from '../src/lib/skills-manifest'
import {skillsBundleRuntime} from '../src/lib/heartbeat'

function fakeGit(over: Partial<SkillsGit> = {}): SkillsGit {
  return {
    exists: over.exists ?? (() => true),
    isGitCheckout: over.isGitCheckout ?? (() => true),
    clone: over.clone ?? (() => {}),
    fetch: over.fetch ?? (() => {}),
    checkout: over.checkout ?? (() => {}),
    resolveRef: over.resolveRef ?? (() => 'sha-atteso'),
    headSha: over.headSha ?? (() => 'sha-atteso'),
    setCurrent: over.setCurrent ?? (() => {}),
    currentVersion: over.currentVersion ?? (() => '1.0.0'),
    remove: over.remove ?? (() => {}),
  } as SkillsGit
}

const manifest = (over: Partial<SkillsManifest> = {}): SkillsManifest => ({
  version: '1.0.0', repo: 'bussolabs/closeyourit-skills', ref: 'v1.0.0', digest: 'sha-atteso', ...over,
} as SkillsManifest)

const client = (m: SkillsManifest | null): SkillsManifestClient => ({getSkillsManifest: async () => m})

describe('activeBundleIdentity — what this machine is really running', () => {
  it('reports version and commit of the active manual', () => {
    const identity = activeBundleIdentity('/data/skills', fakeGit({headSha: () => 'abcdef1234567890'}))

    expect(identity).toMatchObject({version: '1.0.0', sha: 'abcdef1234567890'})
  })

  // Three ways of not knowing, and none of the three must look like "all good".
  it('without an active link it invents nothing', () => {
    expect(activeBundleIdentity('/data/skills', fakeGit({currentVersion: () => null}))).toBeNull()
  })

  it('with the directory missing it invents nothing', () => {
    expect(activeBundleIdentity('/data/skills', fakeGit({exists: () => false}))).toBeNull()
  })

  it('with an unreadable sha it invents nothing', () => {
    const git = fakeGit({headSha: () => { throw new Error('non è un repository') }})

    expect(activeBundleIdentity('/data/skills', git)).toBeNull()
  })
})

describe('compareBundleToPin — the gate', () => {
  it('passes when the active commit is the pinned one', async () => {
    const outcome = await compareBundleToPin(client(manifest()), '/data/skills', fakeGit())

    expect(outcome.aligned).toBe(true)
  })

  // THE CASE THIS TICKET EXISTS FOR. A moved pin keeps the same version NAME and changes
  // commit: whoever compares names sees two equal things that are not equal, and the machine works with
  // old instructions without anyone noticing.
  it('stops the machine when the pin moved under the same name', async () => {
    const git = fakeGit({headSha: () => 'sha-vecchio'})

    const outcome = await compareBundleToPin(client(manifest()), '/data/skills', git)

    expect(outcome.aligned).toBe(false)
    expect(outcome.detail).toContain('disallineato')
    expect(outcome.detail).toContain('sha-vecchio')
  })

  it('stops the machine when the active version is a different one', async () => {
    const git = fakeGit({currentVersion: () => '0.9.0', headSha: () => 'sha-vecchio'})

    const outcome = await compareBundleToPin(client(manifest()), '/data/skills', git)

    expect(outcome.aligned).toBe(false)
    expect(outcome.detail).toContain('0.9.0')
  })

  // Three different failures, three different repairs: stating them with the same sentence sends people
  // looking in the wrong place.
  it('"not installed" is a reason of its own, distinct from the misalignment', async () => {
    const outcome = await compareBundleToPin(client(manifest()), '/data/skills', fakeGit({currentVersion: () => null}))

    expect(outcome.aligned).toBe(false)
    expect(outcome.detail).toContain('non risulta installato')
    expect(outcome.detail).not.toContain('disallineato')
  })

  it('"the server did not answer" is a reason of its own, and does not blame the machine', async () => {
    const outcome = await compareBundleToPin(client(null), '/data/skills', fakeGit())

    expect(outcome.aligned).toBe(false)
    expect(outcome.detail).toContain('il server non ha detto')
    expect(outcome.detail).not.toContain('disallineato')
  })

  it('an error reading the pin does not pass as aligned', async () => {
    const broken: SkillsManifestClient = {getSkillsManifest: async () => { throw new Error('rete giù') }}

    expect((await compareBundleToPin(broken, '/data/skills', fakeGit())).aligned).toBe(false)
  })

  // Without a digest the server does not declare a commit: demanding it would block every machine for data
  // that does not exist. The name comparison remains, which is all there is.
  it('without a digest declared by the server it compares the name, and passes if it matches', async () => {
    const git = fakeGit({headSha: () => 'un-altro-sha'})

    const outcome = await compareBundleToPin(client(manifest({digest: ''})), '/data/skills', git)

    expect(outcome.aligned).toBe(true)
  })

  it('without a declared digest it still stops a different version', async () => {
    const git = fakeGit({currentVersion: () => '0.9.0'})

    const outcome = await compareBundleToPin(client(manifest({digest: ''})), '/data/skills', git)

    expect(outcome.aligned).toBe(false)
  })
})

// The two defects found by the independent review, each with its own test.
describe('the commit suffix is not a different version', () => {
  // `materializationDir` creates `skills/<version>-<sha 12>` when the pin moves under the same
  // number. Comparing that NAME with the number declared by the server always gave "misaligned", and the
  // machine stayed blocked forever — precisely in the case where the sync had
  // worked. The defect bit only without a declared digest, where the name is the only comparison.
  it('the identity reports the logical version, not the directory name', () => {
    const git = fakeGit({currentVersion: () => '1.0.0-abcdef123456', headSha: () => 'abcdef1234567890'})

    const identity = activeBundleIdentity('/data/skills', git)

    expect(identity).toMatchObject({version: '1.0.0', directory: '1.0.0-abcdef123456'})
  })

  it('a bundle materialized with the suffix passes the gate even without a declared digest', async () => {
    const git = fakeGit({currentVersion: () => '1.0.0-abcdef123456', headSha: () => 'abcdef1234567890'})

    const outcome = await compareBundleToPin(client(manifest({digest: ''})), '/data/skills', git)

    expect(outcome.aligned).toBe(true)
  })
})

describe('the gate looks at the manual that really runs', () => {
  // AUTOMATOR_SKILLS_DIR replaces the WHOLE bundle path, not its root: checking
  // `skills/current` with that variable set would mean giving the go-ahead by looking at a
  // manual different from the one the session then runs.
  it('with a forced path it compares the commit of THAT path', async () => {
    const git = fakeGit({headSha: (dir) => (dir === '/altrove/bundle' ? 'sha-atteso' : 'sha-di-current')})

    const outcome = await compareBundleToPin(client(manifest()), '/data/skills', git, '/altrove/bundle')

    expect(outcome.aligned).toBe(true)
  })

  it('with a misaligned forced path it stops the machine', async () => {
    const git = fakeGit({headSha: () => 'sha-vecchio'})

    const outcome = await compareBundleToPin(client(manifest()), '/data/skills', git, '/altrove/bundle')

    expect(outcome.aligned).toBe(false)
    expect(outcome.detail).toContain('percorso forzato')
  })

  // Without a declared digest and with a forced path there is no name to compare: pretending
  // it is fine would be exactly the defect this ticket removes.
  it('forced path without a declared digest: it cannot be verified, so it does not pass', async () => {
    const outcome = await compareBundleToPin(client(manifest({digest: ''})), '/data/skills', fakeGit(), '/altrove/bundle')

    expect(outcome.aligned).toBe(false)
    expect(outcome.detail).toContain('impossibile verificarlo')
  })
})

describe('skillsBundleRuntime — what the machine declares in the heartbeat', () => {
  // The heartbeat sent nine tools and the manual was not among them: from the panel nobody could
  // know whether a machine was working with the right instructions or with the ones from three weeks ago.
  it('carries version and digest inside the field the server keeps', () => {
    const entry = skillsBundleRuntime({version: '1.0.0', sha: 'abcdef1234567890ab', directory: '1.0.0'}, true)

    expect(entry.name).toBe('closeyourit-skills')
    expect(entry.present).toBe(true)
    expect(entry.version).toBe('1.0.0 (abcdef123456)')
    expect(entry.required).toBe(true)
  })

  it('without an active manual it declares it missing, without inventing a version', () => {
    const entry = skillsBundleRuntime(null, true)

    expect(entry.present).toBe(false)
    expect(entry.version).toBeNull()
  })
})
