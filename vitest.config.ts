import {defineConfig} from 'vitest/config'

export default defineConfig({
  test: {
    // Many tests are INTEGRATION tests with REAL I/O (git via spawnSync in workspace/recovery/publish/
    // ticket-delivery, `tar`+symlink+health in release-smoke, process spawns in bootstrap/process-probe).
    // spawnSync BLOCKS the worker: under fork parallelism (heightened by the move to vitest 3) N git/tar
    // processes contend for the same disk and a single test easily overruns the 5000ms default — 35+
    // NON-deterministic timeouts that do not exist in isolation. release-smoke exceeds 5s even on its own. 30s (the
    // same value already used explicitly by cmd-workspace) absorbs the contention peaks; hookTimeout because
    // the beforeEach/afterEach do equally heavy real git setup/teardown. It stays a LIMIT, not a wait:
    // the ~3400 fast unit tests finish in ms, only a test that overruns waits up to 30s before failing.
    testTimeout: 30_000,
    hookTimeout: 30_000,
    // Worktrees live NESTED under .claude/worktrees/<branch>/ or worktrees/<branch>/: without this
    // exclusion vitest also collects their tests and runs N copies of the same file in parallel, on the
    // SAME git repository and the same lock/state files. The tests that manipulate refs, snapshots or locks
    // (review-execution, cmd-phase1) step on each other's toes and produce failures that do not exist in isolation.
    // The vitest default excludes only node_modules/dist, so it must be declared here: `exclude` REPLACES the
    // default, it does not extend it.
    //
    // `worktrees/**` was missing: `vitest run test/workspace.test.ts` alone collected FIVE copies of it, one per
    // nested worktree. They pass anyway today, but that is scheduling luck — when trying to upgrade vitest they
    // turned into 33 timeouts on real git, all files that pass in isolation.
    // Prototypes have their own package and use node:test, not the Vitest runner.
    exclude: ['**/node_modules/**', '**/dist/**', '**/.claude/**', '**/worktrees/**', '**/prototypes/**'],
    // Coverage gate on the core (src/lib + src/errors + src/base.ts) AND on the oclif commands (src/commands/**).
    // Thresholds = ratchet: ONLY raise them (rules/tdd.md, ≥90 line+branch). Real baseline (end of phase 4):
    // line/stmt 98.8, funcs 97.3, branch 90.8 — the floors below leave a safety margin.
    coverage: {
      provider: 'v8',
      include: ['src/lib/**', 'src/errors/**', 'src/base.ts', 'src/commands/**'],
      thresholds: {
        lines: 95,
        statements: 95,
        functions: 90,
        branches: 90,
      },
    },
  },
})
