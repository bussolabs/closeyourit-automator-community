import {spawnSync} from 'node:child_process'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest'
import {
  comparePinToTags,
  defaultSkillsGit,
  type GitSpawnSync,
  isSafeVersion,
  makeSkillsReconciler,
  materializationDir,
  needsSkillSync,
  parseSkillsManifest,
  planSkillsSync,
  type SkillsGit,
  type SkillsManifest,
  syncFromSkillsManifest,
  syncSkillBundle,
} from '../src/lib/skills-manifest'
import {type Secrets} from '../src/lib/config'

const MANIFEST: SkillsManifest = {version: '0.1.0', digest: '', repo: 'bussolabs/closeyourit-skills', ref: 'v0.1.0'}

function fakeGit(over: Partial<SkillsGit> = {}): SkillsGit & {calls: string[]} {
  const calls: string[] = []
  return {
    calls,
    exists: over.exists ?? (() => false),
    isGitCheckout: over.isGitCheckout ?? (() => true),
    clone: over.clone ?? ((repo, dest) => { calls.push(`clone:${repo}:${dest}`) }),
    fetch: over.fetch ?? ((dest) => { calls.push(`fetch:${dest}`) }),
    checkout: over.checkout ?? ((_dest, ref) => { calls.push(`checkout:${ref}`) }),
    // By default the ref resolves to the same commit as HEAD: an existing checkout is already where it must be.
    resolveRef: over.resolveRef ?? (() => (over.headSha ? over.headSha('') : 'sha-ok')),
    headSha: over.headSha ?? (() => 'sha-ok'),
    setCurrent: over.setCurrent ?? ((_base, version) => { calls.push(`setCurrent:${version}`) }),
    remove: over.remove ?? ((target) => { calls.push(`remove:${target}`) }),
    // Default "no active version": most cases start from a machine without bundle, and
    // so the needsSkillSync short-circuit does not mask the tests verifying clone/fetch/checkout.
    currentVersion: over.currentVersion ?? (() => null),
    // Diagnostic probe: queries the remote but mutates nothing. Recorded in `calls` because it is a network
    // call, which must be counted in the beat.
    remoteTags: over.remoteTags ?? ((dest) => { calls.push(`remoteTags:${dest}`); return [] }),
  }
}

describe('parseSkillsManifest', () => {
  it('accepts envelope {data:{...}} and direct object', () => {
    expect(parseSkillsManifest({data: MANIFEST})).toEqual(MANIFEST)
    expect(parseSkillsManifest(MANIFEST)).toEqual(MANIFEST)
  })

  it('requires version/repo/ref; digest degrades to empty string', () => {
    expect(parseSkillsManifest({version: '0.1.0', repo: 'o/r', ref: 'v1'})).toEqual({version: '0.1.0', repo: 'o/r', ref: 'v1', digest: ''})
    expect(parseSkillsManifest({version: '0.1.0', repo: 'o/r'})).toBeNull() // ref missing
    expect(parseSkillsManifest({data: {repo: 'o/r', ref: 'v1'}})).toBeNull() // version missing
    expect(parseSkillsManifest('x')).toBeNull()
  })
})

describe('isSafeVersion', () => {
  it('accepts safe segments, rejects traversal/.git', () => {
    expect(isSafeVersion('0.1.0')).toBe(true)
    expect(isSafeVersion('v1-beta.2')).toBe(true)
    expect(isSafeVersion('..')).toBe(false)
    expect(isSafeVersion('a/b')).toBe(false)
    expect(isSafeVersion('.git')).toBe(false)
  })
})

describe('planSkillsSync', () => {
  it('risolve dest = base/<version>', () => {
    expect(planSkillsSync(MANIFEST, '/data/skills')).toMatchObject({
      base: '/data/skills', version: '0.1.0', repo: 'bussolabs/closeyourit-skills', ref: 'v0.1.0', dest: '/data/skills/0.1.0',
    })
  })

  it('rejects unsafe version and invalid repo (fail-closed)', () => {
    expect(() => planSkillsSync({...MANIFEST, version: '../evil'}, '/d')).toThrow(/versione/)
    expect(() => planSkillsSync({...MANIFEST, repo: 'not-a-repo'}, '/d')).toThrow(/repo/)
  })
})

describe('syncSkillBundle', () => {
  const plan = planSkillsSync(MANIFEST, '/data/skills')

  it('clones when missing, then checks out the ref and promotes current', () => {
    const git = fakeGit({exists: () => false})
    const r = syncSkillBundle(plan, git)
    expect(r).toMatchObject({action: 'cloned', ok: true, pluginDir: '/data/skills/current'})
    expect(git.calls).toEqual(['clone:bussolabs/closeyourit-skills:/data/skills/0.1.0', 'checkout:v0.1.0', 'setCurrent:0.1.0'])
  })

  it('updates (fetch + checkout) when the checkout already exists — idempotent', () => {
    const git = fakeGit({exists: () => true, isGitCheckout: () => true})
    const r = syncSkillBundle(plan, git)
    expect(r).toMatchObject({action: 'updated', ok: true, pluginDir: '/data/skills/current'})
    expect(git.calls).toEqual(['fetch:/data/skills/0.1.0', 'checkout:v0.1.0', 'setCurrent:0.1.0'])
  })

  it('path occupied by non-git directory → occupied, current not promoted', () => {
    const setCurrent = vi.fn()
    const git = fakeGit({exists: () => true, isGitCheckout: () => false, setCurrent})
    const r = syncSkillBundle(plan, git)
    expect(r).toMatchObject({action: 'occupied', ok: false, pluginDir: null})
    expect(setCurrent).not.toHaveBeenCalled()
  })

  it('non-matching digest → mismatch, worktree NEVER touched (fail-closed)', () => {
    const pinned = planSkillsSync({...MANIFEST, digest: 'expected-sha'}, '/data/skills')
    const setCurrent = vi.fn()
    const checkout = vi.fn()
    const git = fakeGit({exists: () => false, headSha: () => 'other-sha', setCurrent, checkout})
    const r = syncSkillBundle(pinned, git)
    expect(r).toMatchObject({action: 'mismatch', ok: false, pluginDir: null})
    expect(r.detail).toContain('digest non combacia')
    // The checkout must stay out: if it happened, the directory would already hold the unverified content —
    // and when that directory is the active one, `current` would point at it. Fail-closed only in appearance.
    expect(checkout).not.toHaveBeenCalled()
    expect(setCurrent).not.toHaveBeenCalled()
  })

  // CYAU-117: the residual hole. `current` already points to 0.1.0 but the directory is gone (broken symlink): the `git
  // clone` would repopulate EXACTLY that directory (checkout of the default branch) and make it active under
  // `current` BEFORE the verification, for the whole clone duration and also for concurrent sessions. Fail-closed:
  // `current` (broken symlink) is removed BEFORE the clone → the host is in prompt-mode until the verification passes.
  it('fresh clone on the current target (broken symlink): current removed BEFORE the clone, then mismatch → stays removed', () => {
    const pinned = planSkillsSync({...MANIFEST, digest: 'atteso'}, '/data/skills')
    const git = fakeGit({
      currentVersion: () => '0.1.0', // current already points to the version…
      exists: () => false, // …but the directory is not there (broken symlink) → clone
      resolveRef: () => 'evil-sha', // at the origin the ref points to content different from the expected one
    })
    const r = syncSkillBundle(pinned, git)
    expect(r).toMatchObject({action: 'mismatch', ok: false, pluginDir: null})
    // current removed BEFORE the clone (not after): the window with the unverified content does not exist at all.
    expect(git.calls).toEqual([
      'remove:/data/skills/current',
      'clone:bussolabs/closeyourit-skills:/data/skills/0.1.0',
      'remove:/data/skills/0.1.0', // cleanup of the unverified clone (best-effort)
    ])
    // checkout and setCurrent do not appear: the unverified content was never promoted.
    expect(git.calls).not.toContain('checkout:v0.1.0')
    expect(git.calls.some((c) => c.startsWith('setCurrent:'))).toBe(false)
  })

  // Happy mirror: same fresh clone on the current target, but the verification PASSES → after the verified
  // checkout `setCurrent` restores `current`. The preventive removal is safe, it does not leave the host without bundle.
  it('fresh clone on the current target + verification ok → current restored after the verified checkout', () => {
    const pinned = planSkillsSync({...MANIFEST, digest: 'sha-ok'}, '/data/skills')
    const git = fakeGit({
      currentVersion: () => '0.1.0',
      exists: () => false, // symlink rotto → clone
      resolveRef: () => 'sha-ok', // matches the digest
    })
    const r = syncSkillBundle(pinned, git)
    expect(r).toMatchObject({action: 'cloned', ok: true, pluginDir: '/data/skills/current'})
    expect(git.calls).toEqual([
      'remove:/data/skills/current', // removed first…
      'clone:bussolabs/closeyourit-skills:/data/skills/0.1.0',
      'checkout:v0.1.0',
      'setCurrent:0.1.0', // …and restored after the verification
    ])
  })

  // Mirror: if the destination directory ALREADY existed (fetch, not clone) `current` is NOT touched — it is not
  // a broken symlink and could point to a verified bundle. "Never destructive" stays the rule.
  it('mismatch on a PRE-EXISTING dir (fetch) → current not touched, no removal', () => {
    const pinned = planSkillsSync({...MANIFEST, digest: 'nuovosha0000000'}, '/data/skills')
    const git = fakeGit({
      currentVersion: () => '0.0.9', // another version is active
      exists: () => true, // both 0.1.0 and the suffixed one already present
      isGitCheckout: () => true,
      headSha: () => 'vecchio', // != digest → materializes into an already existing suffixed one
      resolveRef: () => 'evil-sha', // ref → content different from the expected digest
    })
    const r = syncSkillBundle(pinned, git)
    expect(r).toMatchObject({action: 'mismatch', ok: false})
    expect(git.calls.some((c) => c.startsWith('remove:'))).toBe(false)
  })

  // The moved pin converges BY ITSELF: the new commit goes into a new directory, never over the existing one.
  // Whoever is working keeps theirs (resolved via realpath), whoever starts later takes the other.
  it('pin moved on the ACTIVE bundle → new directory, current promoted, existing one intact', () => {
    const pinned = planSkillsSync({...MANIFEST, digest: 'nuovosha0000000'}, '/data/skills')
    const git = fakeGit({
      currentVersion: () => '0.1.0',
      exists: (p) => p === '/data/skills/0.1.0', // the suffixed one is not there yet
      isGitCheckout: () => true,
      headSha: () => 'vecchio-sha',
      resolveRef: () => 'nuovosha0000000',
    })
    const r = syncSkillBundle(pinned, git)
    expect(r).toMatchObject({action: 'cloned', ok: true, pluginDir: '/data/skills/current'})
    expect(git.calls).toEqual([
      'clone:bussolabs/closeyourit-skills:/data/skills/0.1.0-nuovosha0000',
      'checkout:v0.1.0',
      'setCurrent:0.1.0-nuovosha0000',
    ])
  })

  it('the suffixed directory already present with the right commit is reused, not recloned', () => {
    const pinned = planSkillsSync({...MANIFEST, digest: 'nuovosha0000000'}, '/data/skills')
    const git = fakeGit({
      currentVersion: () => '0.1.0',
      exists: () => true,
      isGitCheckout: () => true,
      headSha: (p) => (p === '/data/skills/0.1.0' ? 'vecchio-sha' : 'nuovosha0000000'),
      resolveRef: () => 'nuovosha0000000',
    })
    const r = syncSkillBundle(pinned, git)
    expect(r).toMatchObject({action: 'updated', ok: true})
    expect(git.calls).toEqual(['fetch:/data/skills/0.1.0-nuovosha0000', 'checkout:v0.1.0', 'setCurrent:0.1.0-nuovosha0000'])
  })

  it('updateActive does NOT bypass the digest: an unverified pin stays mismatch', () => {
    const pinned = planSkillsSync({...MANIFEST, digest: 'atteso'}, '/data/skills')
    const checkout = vi.fn()
    const git = fakeGit({
      currentVersion: () => '0.1.0', exists: () => true, isGitCheckout: () => true,
      headSha: () => 'vecchio-sha', resolveRef: () => 'altro', checkout,
    })
    expect(syncSkillBundle(pinned, git, {updateActive: true})).toMatchObject({action: 'mismatch', ok: false})
    expect(checkout).not.toHaveBeenCalled()
  })

  // The pin can go back to a previous version (0.1.0 → 0.1.1 → 0.1.0 again with a different commit)
  // while a session started earlier is still reading `skills/0.1.0`: not even that one is rewritten.
  it('pin moved to a NON-active but already existing version → new directory, existing one intact', () => {
    const pinned = planSkillsSync({...MANIFEST, digest: 'nuovosha0000000'}, '/data/skills')
    const git = fakeGit({
      currentVersion: () => '0.0.9', // the active version is ANOTHER one
      exists: (p) => p === '/data/skills/0.1.0',
      isGitCheckout: () => true,
      headSha: () => 'vecchio-sha',
      resolveRef: () => 'nuovosha0000000',
    })
    const r = syncSkillBundle(pinned, git)
    expect(r).toMatchObject({action: 'cloned', ok: true})
    expect(git.calls).toEqual([
      'clone:bussolabs/closeyourit-skills:/data/skills/0.1.0-nuovosha0000',
      'checkout:v0.1.0',
      'setCurrent:0.1.0-nuovosha0000',
    ])
  })

  // The automatic case is this: a never-seen version lands in a new directory, which by construction
  // no session can have resolved.
  it('new version → clone and promotion, without touching anything existing', () => {
    const pinned = planSkillsSync({...MANIFEST, digest: 'nuovo-sha'}, '/data/skills')
    const git = fakeGit({currentVersion: () => '0.0.9', exists: () => false, resolveRef: () => 'nuovo-sha', headSha: () => 'nuovo-sha'})
    const r = syncSkillBundle(pinned, git)
    expect(r).toMatchObject({action: 'cloned', ok: true})
    expect(git.calls).toEqual(['clone:bussolabs/closeyourit-skills:/data/skills/0.1.0', 'checkout:v0.1.0', 'setCurrent:0.1.0'])
  })

  // Without digest the expected commit is known only after the fetch: the directory choice is redone there, with the
  // same criterion. This case converges by itself too — no path is left to a person.
  it('manifest without digest, existing directory with different content → new directory after the fetch', () => {
    const plan = planSkillsSync(MANIFEST, '/data/skills')
    const git = fakeGit({
      currentVersion: () => '0.0.9',
      exists: (p) => p === '/data/skills/0.1.0',
      isGitCheckout: () => true,
      headSha: () => 'vecchio-sha',
      resolveRef: () => 'nuovosha0000000',
    })
    const r = syncSkillBundle(plan, git)
    expect(r).toMatchObject({action: 'cloned', ok: true})
    expect(git.calls).toEqual([
      'fetch:/data/skills/0.1.0', // harmless: refs and objects, not the worktree
      'clone:bussolabs/closeyourit-skills:/data/skills/0.1.0-nuovosha0000',
      'checkout:v0.1.0',
      'setCurrent:0.1.0-nuovosha0000',
    ])
  })

  it('matching digest → ok and current promoted', () => {
    const pinned = planSkillsSync({...MANIFEST, digest: 'sha-ok'}, '/data/skills')
    const r = syncSkillBundle(pinned, fakeGit({exists: () => true, headSha: () => 'sha-ok'}))
    expect(r).toMatchObject({action: 'updated', ok: true, pluginDir: '/data/skills/current'})
  })

  it('a failed clone → failed (never an escaping exception)', () => {
    const git = fakeGit({exists: () => false, clone: () => { throw new Error('network') }})
    const r = syncSkillBundle(plan, git)
    expect(r).toMatchObject({action: 'failed', ok: false, pluginDir: null})
    expect(r.detail).toContain('network')
  })
})

describe('syncFromSkillsManifest', () => {
  it('missing client → null (host not registered)', async () => {
    expect(await syncFromSkillsManifest({client: null})).toBeNull()
  })

  it('unretrievable manifest → null', async () => {
    const client = {getSkillsManifest: vi.fn(async () => null)}
    expect(await syncFromSkillsManifest({client})).toBeNull()
  })

  it('manifest ok → syncs and reports', async () => {
    const client = {getSkillsManifest: vi.fn(async () => MANIFEST)}
    const r = await syncFromSkillsManifest({client, base: '/data/skills', git: fakeGit({exists: () => false})})
    expect(r).toMatchObject({action: 'cloned', ok: true, version: '0.1.0', pluginDir: '/data/skills/current'})
  })
})

// The reconciliation runs at EVERY beat: without this short-circuit it would be a `fetch --all --tags` and a
// `checkout` per minute, forever, on every host.
describe('needsSkillSync', () => {
  const plan = planSkillsSync(MANIFEST, '/data/skills')
  const pinned = planSkillsSync({...MANIFEST, digest: 'sha-ok'}, '/data/skills')

  it('no current (new machine) → needed', () => {
    expect(needsSkillSync(plan, fakeGit({currentVersion: () => null}))).toBe(true)
  })

  it('current points to another version (pin changed) → needed', () => {
    expect(needsSkillSync(plan, fakeGit({currentVersion: () => '0.0.9'}))).toBe(true)
  })

  it('right current but checkout gone or non-git → needed', () => {
    expect(needsSkillSync(plan, fakeGit({currentVersion: () => '0.1.0', exists: () => false}))).toBe(true)
    expect(needsSkillSync(plan, fakeGit({currentVersion: () => '0.1.0', exists: () => true, isGitCheckout: () => false}))).toBe(true)
  })

  it('aligned → not needed', () => {
    const git = fakeGit({currentVersion: () => '0.1.0', exists: () => true, isGitCheckout: () => true})
    expect(needsSkillSync(plan, git)).toBe(false)
  })

  // The case the version alone does not see: same name, different commit.
  it('pin moved with the same version (digest ≠ HEAD) → needed', () => {
    const git = fakeGit({currentVersion: () => '0.1.0', exists: () => true, headSha: () => 'altro-sha'})
    expect(needsSkillSync(pinned, git)).toBe(true)
  })

  it('empty digest (unverified manifest) → the version is enough', () => {
    const git = fakeGit({currentVersion: () => '0.1.0', exists: () => true, headSha: () => { throw new Error('mai chiamato') }})
    expect(needsSkillSync(plan, git)).toBe(false)
  })

  it('unreadable sha → conservative, needed', () => {
    const git = fakeGit({currentVersion: () => '0.1.0', exists: () => true, headSha: () => { throw new Error('repo rotto') }})
    expect(needsSkillSync(pinned, git)).toBe(true)
  })

  // With the digest the question is about the active COMMIT, not the name: after a moved pin the active directory is
  // called `0.1.0-<sha>`, and comparing names would say "to sync" at every beat, forever.
  it('suffixed active directory with the right commit → not needed', () => {
    const git = fakeGit({currentVersion: () => '0.1.0-abc123def456', exists: () => true, isGitCheckout: () => true, headSha: () => 'sha-ok'})
    expect(needsSkillSync(pinned, git)).toBe(false)
  })

  it('suffixed active directory with the wrong commit → needed', () => {
    const git = fakeGit({currentVersion: () => '0.1.0-abc123def456', exists: () => true, isGitCheckout: () => true, headSha: () => 'altro'})
    expect(needsSkillSync(pinned, git)).toBe(true)
  })
})

describe('materializationDir', () => {
  const pinned = planSkillsSync({...MANIFEST, digest: 'nuovosha0000000'}, '/data/skills')

  it('version directory missing → it is that one (normal case)', () => {
    expect(materializationDir(pinned, fakeGit({exists: () => false}))).toBe('/data/skills/0.1.0')
  })

  it('version directory already with the pinned commit → it is that one, no proliferation', () => {
    const git = fakeGit({exists: () => true, isGitCheckout: () => true, headSha: () => 'nuovosha0000000'})
    expect(materializationDir(pinned, git)).toBe('/data/skills/0.1.0')
  })

  it('version directory with another commit → a NEW one, never the same', () => {
    const git = fakeGit({exists: () => true, isGitCheckout: () => true, headSha: () => 'vecchio'})
    expect(materializationDir(pinned, git)).toBe('/data/skills/0.1.0-nuovosha0000')
  })

  it('without digest it cannot address by content → the version directory stays', () => {
    const plan = planSkillsSync(MANIFEST, '/data/skills')
    const git = fakeGit({exists: () => true, isGitCheckout: () => true, headSha: () => 'qualsiasi'})
    expect(materializationDir(plan, git)).toBe('/data/skills/0.1.0')
  })

  it('a digest that would compose an unsafe name is rejected', () => {
    const ostile = planSkillsSync({...MANIFEST, digest: '../../etc/pwn'}, '/data/skills')
    const git = fakeGit({exists: () => true, isGitCheckout: () => true, headSha: () => 'vecchio'})
    expect(() => materializationDir(ostile, git)).toThrow(/non sicuro/)
  })
})

describe('syncSkillBundle — bundle already aligned', () => {
  it("exits with action 'current' without touching git", () => {
    const plan = planSkillsSync(MANIFEST, '/data/skills')
    const git = fakeGit({
      currentVersion: () => '0.1.0',
      exists: () => true,
      isGitCheckout: () => true,
      fetch: () => { throw new Error('git non deve essere toccato') },
      checkout: () => { throw new Error('git non deve essere toccato') },
      setCurrent: () => { throw new Error('git non deve essere toccato') },
    })
    const r = syncSkillBundle(plan, git)
    expect(r).toMatchObject({action: 'current', ok: true, pluginDir: '/data/skills/current'})
    expect(git.calls).toEqual([])
  })
})

// CYAU-135: the pin belongs to the server and is updated only if the skills publication manages to write it. When
// that write does not happen (expired token, missing settings) the release LOOKS successful and the hosts
// stay on the old instructions: nothing, anywhere, says there is a gap. Comparing the pin
// with the repo tags makes it visible from the side that suffers it, without looking at the database.
describe('comparePinToTags (pin canary)', () => {
  it('pin older than the last published tag → gap, with the two versions', () => {
    const lag = comparePinToTags({ref: 'v0.1.1', version: '0.1.1'}, ['v0.1.0', 'v0.1.1', 'v0.1.2'])
    expect(lag).toEqual({pinned: '0.1.1', latest: '0.1.2'})
  })

  it('pin on the last tag → no gap', () => {
    expect(comparePinToTags({ref: 'v0.1.2', version: '0.1.2'}, ['v0.1.0', 'v0.1.1', 'v0.1.2'])).toBeNull()
  })

  // The comparison is numeric, not alphabetical: `v0.9.0` alphabetically beats `v0.10.0`, which is the later version.
  it('orders by number, not by string', () => {
    expect(comparePinToTags({ref: 'v0.9.0', version: '0.9.0'}, ['v0.9.0', 'v0.10.0'])).toEqual({pinned: '0.9.0', latest: '0.10.0'})
    expect(comparePinToTags({ref: 'v0.10.0', version: '0.10.0'}, ['v0.9.0', 'v0.10.0'])).toBeNull()
  })

  // A test tag or a prerelease is not a publication to chase: the canary must not ring for them.
  it('ignores the tags that are not a published version', () => {
    expect(comparePinToTags({ref: 'v0.1.1', version: '0.1.1'}, ['v0.1.1', 'v0.2.0-rc1', 'prova', 'latest'])).toBeNull()
  })

  // The pin can be on a sha (the manifest allows it): the declared version stays the only handle.
  it('pin on a sha → compares the version declared by the manifest', () => {
    expect(comparePinToTags({ref: 'abc123', version: '0.1.1'}, ['v0.1.2'])).toEqual({pinned: '0.1.1', latest: '0.1.2'})
  })

  it('no comparable tag (just created repo, non-numeric tags) → no gap', () => {
    expect(comparePinToTags({ref: 'v0.1.1', version: '0.1.1'}, [])).toBeNull()
    expect(comparePinToTags({ref: 'main', version: 'main'}, ['v0.1.2'])).toBeNull()
  })
})

describe('syncSkillBundle — pin check (CYAU-135)', () => {
  const plan = planSkillsSync(MANIFEST, '/data/skills')
  const allineato = (over: Partial<SkillsGit> = {}) =>
    fakeGit({currentVersion: () => '0.1.0', exists: () => true, isGitCheckout: () => true, ...over})

  // The case the ticket describes: the host is aligned TO THE PIN and exactly for this does nothing more — the pin
  // however is stuck on an outdated version. The probe queries the remote: it touches neither worktree nor local refs.
  it('bundle aligned to the pin: reads the published tags and reports the gap, without touching the checkout', () => {
    const git = allineato({
      remoteTags: () => ['v0.1.0', 'v0.1.1'],
      fetch: () => { throw new Error('il checkout non va toccato') },
      checkout: () => { throw new Error('il checkout non va toccato') },
      setCurrent: () => { throw new Error('il checkout non va toccato') },
    })
    const r = syncSkillBundle(plan, git, {checkPinLag: true})
    expect(r.pinCheck).toEqual({state: 'behind', lag: {pinned: '0.1.0', latest: '0.1.1'}})
    expect(r).toMatchObject({action: 'current', ok: true})
  })

  it('without explicit check the aligned branch pays nothing (the beat stays silent)', () => {
    const git = allineato({remoteTags: () => ['v0.1.0', 'v0.1.1']})
    const r = syncSkillBundle(plan, git)
    expect(r.pinCheck).toEqual({state: 'skipped'})
    expect(git.calls).toEqual([])
  })

  it('pin aligned to the last published version → says so, and it is not a silence', () => {
    const git = allineato({remoteTags: () => ['v0.0.9', 'v0.1.0']})
    expect(syncSkillBundle(plan, git, {checkPinLag: true}).pinCheck).toEqual({state: 'aligned'})
  })

  // Even after a successful sync the pin can be behind (0.2.0 published while the pin has just
  // moved to 0.1.0): whoever asked for the check gets it on both branches.
  it('after a clone the check applies as in the aligned branch', () => {
    const git = fakeGit({exists: () => false, remoteTags: () => ['v0.1.0', 'v0.2.0']})
    const r = syncSkillBundle(plan, git, {checkPinLag: true})
    expect(r.pinCheck).toEqual({state: 'behind', lag: {pinned: '0.1.0', latest: '0.2.0'}})
    expect(r).toMatchObject({action: 'cloned', ok: true})
  })

  // THE point: a failing probe must NOT look like "pin up to date". A canary that stays silent when it did not
  // look is the same silence this ticket exists to remove.
  it('failed tag read → "not verified", never "aligned"', () => {
    const git = allineato({remoteTags: () => { throw new Error('rete giù') }})
    const r = syncSkillBundle(plan, git, {checkPinLag: true})
    expect(r.pinCheck).toEqual({state: 'unknown'})
    expect(r).toMatchObject({action: 'current', ok: true}) // the sync is not affected
  })

  it('no readable published tag → not verified (there is nothing to compare)', () => {
    const git = allineato({remoteTags: () => []})
    expect(syncSkillBundle(plan, git, {checkPinLag: true}).pinCheck).toEqual({state: 'unknown'})
  })

  it('a failed sync declares nothing about the pin', () => {
    const git = fakeGit({exists: () => true, isGitCheckout: () => false, remoteTags: () => ['v9.9.9']})
    const r = syncSkillBundle(plan, git, {checkPinLag: true})
    expect(r).toMatchObject({action: 'occupied', ok: false})
    expect(r.pinCheck).toEqual({state: 'skipped'})
  })

  it('syncFromSkillsManifest forwards the check request', async () => {
    const client = {getSkillsManifest: vi.fn(async () => MANIFEST)}
    const git = allineato({remoteTags: () => ['v0.1.0', 'v0.1.1']})
    const r = await syncFromSkillsManifest({client, base: '/data/skills', git, checkPinLag: true})
    expect(r?.pinCheck).toEqual({state: 'behind', lag: {pinned: '0.1.0', latest: '0.1.1'}})
  })
})

// Real probe: `currentVersion` must read the DECLARED TARGET of the symlink (the version), not resolve it.
// With `realpath` it would return an absolute path and the comparison with `plan.version` would always fail → sync at every
// beat, that is the exact opposite of the short-circuit.
describe('defaultSkillsGit().currentVersion', () => {
  let base: string
  beforeEach(() => { base = fs.mkdtempSync(path.join(os.tmpdir(), 'skills-')) })
  afterEach(() => { fs.rmSync(base, {recursive: true, force: true}) })

  it('returns the version from the symlink written by setCurrent', () => {
    const git = defaultSkillsGit()
    fs.mkdirSync(path.join(base, '0.1.0'))
    git.setCurrent(base, '0.1.0')
    expect(git.currentVersion(base)).toBe('0.1.0')
  })

  it('missing current → null (new machine, not an error)', () => {
    expect(defaultSkillsGit().currentVersion(base)).toBeNull()
  })

  it('current is not a symlink (leftover of a manual installation) → null', () => {
    fs.mkdirSync(path.join(base, 'current'))
    expect(defaultSkillsGit().currentVersion(base)).toBeNull()
  })
})

// CYAU-117: the removal is real but best-effort — it must delete the tree, remove only the `current` symlink
// (never the target) and never throw (not even on a missing path), otherwise a mismatch would become an exception.
describe('defaultSkillsGit().remove', () => {
  let base: string
  beforeEach(() => { base = fs.mkdtempSync(path.join(os.tmpdir(), 'skills-')) })
  afterEach(() => { fs.rmSync(base, {recursive: true, force: true}) })

  it('recursively removes the directory (unverified clone discarded)', () => {
    const dir = path.join(base, '0.1.0')
    fs.mkdirSync(path.join(dir, '.git'), {recursive: true})
    fs.writeFileSync(path.join(dir, 'SKILL.md'), 'non verificato')
    defaultSkillsGit().remove(dir)
    expect(fs.existsSync(dir)).toBe(false)
  })

  it('on `current` removes the symlink but NOT the target (prompt-mode, verified content preserved)', () => {
    const git = defaultSkillsGit()
    fs.mkdirSync(path.join(base, '0.1.0'))
    fs.writeFileSync(path.join(base, '0.1.0', 'SKILL.md'), 'verificato')
    git.setCurrent(base, '0.1.0')
    git.remove(path.join(base, 'current'))
    expect(fs.existsSync(path.join(base, 'current'))).toBe(false) // symlink via
    expect(fs.existsSync(path.join(base, '0.1.0', 'SKILL.md'))).toBe(true) // target intatto
  })

  it('missing path → no error (best-effort)', () => {
    expect(() => defaultSkillsGit().remove(path.join(base, 'non-esiste'))).not.toThrow()
  })
})

// CYAU-135. Real canary probe: queries the REMOTE (the published tags), not the local refs, which after a
// successful sync are stuck at the pin as much as the host. It touches neither worktree nor refs: it is read-only.
describe('defaultSkillsGit().remoteTags', () => {
  let origin: string
  let checkout: string
  const git = (cwd: string, ...args: string[]) => spawnSync('git', ['-C', cwd, ...args], {encoding: 'utf8'})

  beforeEach(() => {
    origin = fs.mkdtempSync(path.join(os.tmpdir(), 'skills-origin-'))
    checkout = fs.mkdtempSync(path.join(os.tmpdir(), 'skills-checkout-'))
    spawnSync('git', ['init', '-q', origin])
    git(origin, 'config', 'user.email', 'test@example.invalid')
    git(origin, 'config', 'user.name', 'Test')
    git(origin, 'commit', '-q', '--allow-empty', '-m', 'primo')
    git(origin, 'tag', 'v0.1.0') // lightweight
    git(origin, 'tag', '-a', 'v0.1.2', '-m', 'release') // annotated: ls-remote also shows it as v0.1.2^{}
    spawnSync('git', ['init', '-q', checkout])
    git(checkout, 'remote', 'add', 'origin', origin)
  })

  afterEach(() => {
    fs.rmSync(origin, {recursive: true, force: true})
    fs.rmSync(checkout, {recursive: true, force: true})
  })

  it('lists the tags published by the remote, annotated included and without duplicates', () => {
    expect(defaultSkillsGit().remoteTags(checkout).sort()).toEqual(['v0.1.0', 'v0.1.2'])
  })

  it('writes nothing in the checkout: the local refs stay the same as before', () => {
    defaultSkillsGit().remoteTags(checkout)
    expect(git(checkout, 'tag', '--list').stdout.trim()).toBe('')
  })

  it('unreachable remote → empty list, never an escaping error', () => {
    fs.rmSync(origin, {recursive: true, force: true})
    expect(defaultSkillsGit().remoteTags(checkout)).toEqual([])
  })

  it('checkout without remote → empty list', () => {
    const nudo = fs.mkdtempSync(path.join(os.tmpdir(), 'skills-nudo-'))
    spawnSync('git', ['init', '-q', nudo])
    try {
      expect(defaultSkillsGit().remoteTags(nudo)).toEqual([])
    } finally {
      fs.rmSync(nudo, {recursive: true, force: true})
    }
  })
})

describe('makeSkillsReconciler', () => {
  const registered: Secrets = {sync: {}, host: {id: 'h1', token: 'cyi_ah_s'}}

  beforeEach(() => { process.env.AUTOMATOR_SKILLS_ENABLED = 'true' })
  afterEach(() => { delete process.env.AUTOMATOR_SKILLS_ENABLED })

  const manifestFetch = (version = '0.1.0') => vi.fn(async (_url: string | URL, opts?: RequestInit) => ({
    ok: true,
    status: 200,
    json: async () => ({data: {version, digest: '', repo: 'bussolabs/closeyourit-skills', ref: `v${version}`}}),
    headers: opts?.headers,
  }) as unknown as Response) as unknown as typeof globalThis.fetch

  it('without sync → undefined (no host-scoped channel)', () => {
    expect(makeSkillsReconciler({host: {id: 'h1', token: 'cyi_ah_s'}})).toBeUndefined()
  })

  it('without an operational host identity → undefined', () => {
    expect(makeSkillsReconciler({sync: {orgToken: 'cyi_a_x'}})).toBeUndefined()
  })

  // Whoever stays in prompt-mode does not use the bundle: it must not pay even one GET per minute.
  it('skill-mode spento → undefined', () => {
    delete process.env.AUTOMATOR_SKILLS_ENABLED
    expect(makeSkillsReconciler(registered)).toBeUndefined()
  })

  it('missing bundle → downloads it and reports it, with the revocable host credential', async () => {
    const calls: Array<{url: string; opts: RequestInit}> = []
    const fetchFn = vi.fn(async (url: string | URL, opts?: RequestInit) => {
      calls.push({url: String(url), opts: opts ?? {}})
      return {ok: true, status: 200, json: async () => ({data: {version: '0.1.0', digest: '', repo: 'bussolabs/closeyourit-skills', ref: 'v0.1.0'}})} as unknown as Response
    }) as unknown as typeof globalThis.fetch
    const log = vi.fn()
    const git = fakeGit({currentVersion: () => null, exists: () => false})

    const beat = makeSkillsReconciler(registered, {fetchFn, base: '/data/skills', git, log})
    expect(beat).toBeDefined()
    await beat!(true)

    expect(calls[0].url).toBe('https://app.closeyour.it/api/v1/agent_host/skill_manifest')
    expect((calls[0].opts.headers as Record<string, string>).Authorization).toBe('Bearer cyi_ah_s')
    expect(git.calls).toContain('setCurrent:0.1.0')
    expect(log).toHaveBeenCalledWith('skill: bundle 0.1.0 promosso (cloned)')
  })

  // A log per minute would be noise: the beat speaks only when something changes.
  it('bundle already aligned and pin up to date → no log', async () => {
    const log = vi.fn()
    const git = fakeGit({currentVersion: () => '0.1.0', exists: () => true, isGitCheckout: () => true, remoteTags: () => ['v0.1.0']})
    const beat = makeSkillsReconciler(registered, {fetchFn: manifestFetch(), base: '/data/skills', git, log})
    await beat!(true)
    expect(log).not.toHaveBeenCalled()
  })

  // CYAU-135. The gap is visible only by querying the repo, and that is a network call INSIDE the beat:
  // the beats run in sequence and the git probe is synchronous, so every round spent here is a round in which
  // heartbeat and lease renewal do not advance. It runs at the first beat (the snapshot of a fresh start)
  // and then periodically, never every minute.
  it('the pin check runs at the first beat and then periodically, not at every round', async () => {
    const probed: string[] = []
    const git = fakeGit({
      currentVersion: () => '0.1.0', exists: () => true, isGitCheckout: () => true,
      remoteTags: (dest) => { probed.push(dest); return ['v0.1.0'] },
    })
    const beat = makeSkillsReconciler(registered, {fetchFn: manifestFetch(), base: '/data/skills', git, pinLagEveryBeats: 3})
    for (let i = 0; i < 7; i++) await beat!(true) // beats 1, 4 and 7 check; the others do not
    expect(probed).toEqual(['/data/skills/0.1.0', '/data/skills/0.1.0', '/data/skills/0.1.0'])
  })

  it('pin stuck on an outdated version → says so in the service logs, without looking at the database', async () => {
    const log = vi.fn()
    const git = fakeGit({currentVersion: () => '0.1.0', exists: () => true, isGitCheckout: () => true, remoteTags: () => ['v0.1.0', 'v0.1.2']})
    const beat = makeSkillsReconciler(registered, {fetchFn: manifestFetch(), base: '/data/skills', git, log})
    await beat!(true)
    expect(log).toHaveBeenCalledTimes(1)
    expect(log.mock.calls[0][0]).toContain('pin')
    expect(log.mock.calls[0][0]).toContain('0.1.2')
  })

  // A failed check is not a passed check: if it stayed silent, the log would say "all good"
  // exactly as when the pin is up to date.
  it('failed pin check → writes it, does not confuse it with "all good"', async () => {
    const log = vi.fn()
    const git = fakeGit({
      currentVersion: () => '0.1.0', exists: () => true, isGitCheckout: () => true,
      remoteTags: () => { throw new Error('rete giù') },
    })
    const beat = makeSkillsReconciler(registered, {fetchFn: manifestFetch(), base: '/data/skills', git, log})
    await beat!(true)
    expect(log).toHaveBeenCalledTimes(1)
    expect(log.mock.calls[0][0]).toContain('non verificato')
  })

  it('failed sync → reports it without throwing', async () => {
    const log = vi.fn()
    const git = fakeGit({currentVersion: () => null, exists: () => true, isGitCheckout: () => false})
    const beat = makeSkillsReconciler(registered, {fetchFn: manifestFetch(), base: '/data/skills', git, log})
    await expect(beat!(true)).resolves.toBeUndefined()
    expect(log.mock.calls[0][0]).toContain('non promosso')
  })

  it('no bundle pinned server-side → silence (prompt-mode, not an error)', async () => {
    const log = vi.fn()
    const fetchFn = vi.fn(async () => ({ok: false, status: 404} as unknown as Response)) as unknown as typeof globalThis.fetch
    const beat = makeSkillsReconciler(registered, {fetchFn, base: '/data/skills', git: fakeGit(), log})
    await beat!(true)
    expect(log).not.toHaveBeenCalled()
  })

  it('best-effort: an unreachable server does not throw', async () => {
    const fetchFn = vi.fn(async () => { throw new Error('rete giù') }) as unknown as typeof globalThis.fetch
    const beat = makeSkillsReconciler(registered, {fetchFn, base: '/data/skills', git: fakeGit()})
    await expect(beat!(true)).resolves.toBeUndefined()
  })

  it('rebuilds the client at every beat: after a rotation it uses the new host token', async () => {
    const secrets: Secrets = {sync: {}, host: {id: 'h1', token: 'cyi_ah_old'}}
    const authorizations: string[] = []
    const fetchFn = vi.fn(async (_url: string | URL, opts?: RequestInit) => {
      authorizations.push((opts?.headers as Record<string, string>).Authorization)
      return {ok: true, status: 200, json: async () => ({data: {version: '0.1.0', digest: '', repo: 'bussolabs/closeyourit-skills', ref: 'v0.1.0'}})} as unknown as Response
    }) as unknown as typeof globalThis.fetch
    const beat = makeSkillsReconciler(secrets, {fetchFn, base: '/data/skills', git: fakeGit({currentVersion: () => '0.1.0', exists: () => true})})

    secrets.host = {id: 'h1', token: 'cyi_ah_new'}
    await beat!(true)

    expect(authorizations).toEqual(['Bearer cyi_ah_new'])
  })

  // Same defensive guard as makeLeaseRenewer: the identity can disappear between construction and the beat.
  it('host identity gone between construction and the beat → calls nothing', async () => {
    const secrets: Secrets = {sync: {}, host: {id: 'h1', token: 'cyi_ah_s'}}
    const fetchFn = vi.fn(async () => { throw new Error('mai chiamato') }) as unknown as typeof globalThis.fetch
    const beat = makeSkillsReconciler(secrets, {fetchFn, base: '/data/skills', git: fakeGit()})

    secrets.host = undefined
    await expect(beat!(true)).resolves.toBeUndefined()
    expect(fetchFn).not.toHaveBeenCalled()
  })
})

describe('defaultSkillsGit(): the clone goes through the wrapper with a time cap', () => {
  let base: string

  const callsOf = (spawn: GitSpawnSync) =>
    (spawn as unknown as {mock: {calls: [string, string[], {timeout?: number; env?: NodeJS.ProcessEnv}][]}}).mock.calls

  beforeEach(() => {
    base = fs.mkdtempSync(path.join(os.tmpdir(), 'cyau-skills-net-'))
  })

  afterEach(() => {
    fs.rmSync(base, {recursive: true, force: true})
  })

  it('gh repo clone has a timeout and forbids credential prompts', () => {
    const spawn = vi.fn(() => ({status: 0, stdout: '', stderr: ''})) as unknown as GitSpawnSync
    defaultSkillsGit(spawn).clone('org/repo', path.join(base, 'dest'))
    const [file, , options] = callsOf(spawn)[0]
    expect(file).toBe('gh')
    expect(options.timeout).toBeGreaterThan(0)
    expect(options.env?.GIT_TERMINAL_PROMPT).toBe('0')
  })

  it('the git clone fallback has the same cap, higher than the fetch one', () => {
    const spawn = vi.fn((file: string) => ({
      status: file === 'gh' ? 1 : 0,
      stdout: '',
      stderr: '',
    })) as unknown as GitSpawnSync
    const git = defaultSkillsGit(spawn)
    git.clone('org/repo', path.join(base, 'dest'))
    git.fetch(base)
    const [cloneCall, gitCloneCall, fetchCall] = callsOf(spawn)
    expect(cloneCall[0]).toBe('gh')
    expect(gitCloneCall[0]).toBe('git')
    expect(gitCloneCall[2].env?.GIT_TERMINAL_PROMPT).toBe('0')
    expect(gitCloneCall[2].timeout).toBeGreaterThan(fetchCall[2].timeout!)
  })

  it('a clone failed on both paths stays a meaningful error', () => {
    const spawn = vi.fn(() => ({status: 1, stdout: '', stderr: 'remoto muto'})) as unknown as GitSpawnSync
    expect(() => defaultSkillsGit(spawn).clone('org/repo', path.join(base, 'dest'))).toThrow(/remoto muto/)
  })

  it('fetch and checkout also forbid credential prompts', () => {
    const spawn = vi.fn(() => ({status: 0, stdout: '', stderr: ''})) as unknown as GitSpawnSync
    const git = defaultSkillsGit(spawn)
    git.fetch(base)
    git.checkout(base, 'v1.0.0')
    for (const [, , options] of callsOf(spawn)) {
      expect(options.timeout).toBeGreaterThan(0)
      expect(options.env?.GIT_TERMINAL_PROMPT).toBe('0')
    }
  })
})
