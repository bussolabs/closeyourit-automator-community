import * as fs from 'node:fs'
import * as path from 'node:path'

import {describe, expect, it} from 'vitest'

import {
  EXECUTION_PHASES,
  isExecutionPhase,
  phaseProfile,
  phaseProfileDigest,
} from '../src/lib/phase-profile'

// The contract fixture pins the profile_digest of every phase (== Rails Agents::PhaseProfile#digest). If this
// twin diverges from the server PhaseProfile the parity breaks here (besides R409-LEASE-005 at runtime).
const FIXTURE = path.join(import.meta.dirname, 'contracts', 'agent-queue', 'v1', 'fixtures', 'valid', 'phase_profiles.json')
const DIGESTS = JSON.parse(fs.readFileSync(FIXTURE, 'utf8')) as Record<string, string>

describe('phase-profile (twin of the Rails Agents::PhaseProfile)', () => {
  it('exposes the 5 host-first execution_phases in flow order', () => {
    expect([...EXECUTION_PHASES]).toEqual(['triage', 'planner', 'autopilot', 'closer_staging', 'closer_production'])
  })

  describe('phaseProfile', () => {
    // The read-only nature of triage/planner is the ABSENCE of sandbox — no managed worktree, so
    // `require-worktree` denies every Edit/Write — not the permission mode. The mode is there to let the
    // scripts the skills are made of RUN.
    it('triage/planner run claude without sandbox: no write access', () => {
      for (const phase of ['triage', 'planner'] as const) {
        expect(phaseProfile(phase)).toEqual({
          skill: `/closeyourit-${phase}`, runtime: 'claude', sandbox: null,
          permissionMode: 'bypassPermissions', allowedTools: ['Read', 'Glob', 'Grep'], ttl: 3600,
        })
      }
    })

    // Regression of 2026-07-30: the read phases ran in `plan`, where Claude does NOT execute. Every Bash of the
    // triage skill ended up denied and the session gave up in prose, so no delivery. In headless mode
    // there is no approver: `plan` means a phase that cannot do its own work.
    it('no phase runs in `plan`: in headless mode it would not run its own scripts', () => {
      for (const phase of EXECUTION_PHASES) {
        expect(phaseProfile(phase).permissionMode).toBe('bypassPermissions')
      }
    })

    it('autopilot/closer run claude bypassPermissions in workspace-write (PIVOT CYAU-87, no tool allowlist)', () => {
      const cases = [
        ['autopilot', '/closeyourit-autopilot'],
        ['closer_staging', '/closeyourit-closer-staging'],
        ['closer_production', '/closeyourit-closer-production'],
      ] as const
      for (const [phase, skill] of cases) {
        expect(phaseProfile(phase)).toEqual({
          skill, runtime: 'claude', sandbox: 'workspace-write',
          permissionMode: 'bypassPermissions', allowedTools: [], ttl: 3600,
        })
      }
    })

    it('fail-closed su fase sconosciuta o vocabolario pre-claim (*_queued) → null', () => {
      expect(phaseProfile('unknown')).toBeNull()
      expect(phaseProfile('')).toBeNull()
      expect(phaseProfile('triage_queued')).toBeNull()
    })

    it('is not vulnerable to keys inherited from the prototype', () => {
      expect(phaseProfile('toString')).toBeNull()
      expect(phaseProfile('constructor')).toBeNull()
    })
  })

  describe('phaseProfileDigest — cross-repo parity with the contract', () => {
    it('every phase produces the profile_digest pinned in the contract (== Rails PhaseProfile#digest)', () => {
      for (const phase of EXECUTION_PHASES) {
        expect(phaseProfileDigest(phase)).toBe(DIGESTS[phase])
      }
    })

    it('the fixture covers exactly the 5 phases', () => {
      expect(Object.keys(DIGESTS).sort()).toEqual([...EXECUTION_PHASES].sort())
    })

    it('fase sconosciuta → null', () => {
      expect(phaseProfileDigest('unknown')).toBeNull()
    })
  })

  describe('isExecutionPhase', () => {
    it('accepts the 5 host-first phases, rejects the rest', () => {
      for (const phase of EXECUTION_PHASES) expect(isExecutionPhase(phase)).toBe(true)
      expect(isExecutionPhase('triage_queued')).toBe(false)
      expect(isExecutionPhase(null)).toBe(false)
      expect(isExecutionPhase(42)).toBe(false)
    })
  })
})
