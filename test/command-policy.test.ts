import {afterEach, beforeEach, describe, expect, it} from 'vitest'
import {evaluateAction, evaluateCommand, productionHosts} from '../src/lib/command-policy'
import {type Action, PlaybookSchema} from '../src/lib/schema'

const RETIRED_PROVIDER = ['dop', 'pler'].join('')

// Runtime-agnostic command policy (CYAU-25): the critical protections (production, destructive DB, protected
// branches, force-push) evaluated on a shell COMMAND, independent of the runtime. The DoD asks for tests covering
// deploy, destructive DB, protected branches and force-push; here the unit coverage of the pure predicate.

/** Builds a typed Action with the defaults applied (via zod). */
function action(partial: Record<string, unknown>): Action {
  return PlaybookSchema.parse({version: 1, actions: {a: {schedule: 'every 1m', ...partial}}}).actions.a
}

describe('evaluateCommand · production (deploy and prod access)', () => {
  it('blocks the Kamal deploy', () => {
    const d = evaluateCommand('kamal deploy -d production')
    expect(d.allowed).toBe(false)
    expect(d.violation).toBe('production')
  })

  it('blocks kamal app boot', () => expect(evaluateCommand('kamal app boot').allowed).toBe(false))
  it('blocks RAILS_ENV=production', () => expect(evaluateCommand('RAILS_ENV=production bin/rails console').violation).toBe('production'))
  it('allows RAILS_ENV=staging (the service account is authorized for the staging secrets)', () =>
    expect(evaluateCommand('RAILS_ENV=staging rails db:migrate').allowed).toBe(true))
  it('blocks the retired secret provider in any environment', () => {
    for (const environment of ['production', 'staging', 'development']) {
      expect(evaluateCommand(`${RETIRED_PROVIDER} run --config ${environment} -- rails c`).violation)
        .toBe('retired-provider')
    }
  })
  it('blocks cyi run in production', () =>
    expect(evaluateCommand('cyi run -p CYI -e production -- bin/rails runner x').violation).toBe('production'))
  it('allows cyi run in non-production environments', () => {
    expect(evaluateCommand('cyi run -p CYI -e development -- bin/rails console').allowed).toBe(true)
    expect(evaluateCommand('cyi run --project CYI --environment staging -- bin/rails console').allowed).toBe(true)
  })
  describe('with the production hosts of this installation (AUTOMATOR_PRODUCTION_HOSTS)', () => {
    const previous = process.env.AUTOMATOR_PRODUCTION_HOSTS
    beforeEach(() => {
      process.env.AUTOMATOR_PRODUCTION_HOSTS = '10.20.0.9,prod.example.com,203.0.113.250'
    })
    afterEach(() => {
      if (previous === undefined) delete process.env.AUTOMATOR_PRODUCTION_HOSTS
      else process.env.AUTOMATOR_PRODUCTION_HOSTS = previous
    })
    it('blocks ssh to production hosts', () => expect(evaluateCommand('ssh root@10.20.0.9 "uptime"').violation).toBe('production'))
    it('blocks scp to a production host name', () =>
      expect(evaluateCommand('scp file root@prod.example.com:/tmp/').allowed).toBe(false))
    it('blocks rsync to the bastion', () => expect(evaluateCommand('rsync -av x root@203.0.113.250:/srv/').allowed).toBe(false))
    it('blocks DATABASE_URL to the prod DB', () =>
      expect(evaluateCommand('DATABASE_URL=postgres://u:p@10.20.0.9/db bin/rails c').violation).toBe('production'))
    it('blocks QUEUE_DATABASE_URL to the prod DB', () =>
      expect(evaluateCommand('QUEUE_DATABASE_URL=postgres://u:p@10.20.0.9/q bin/rails c').allowed).toBe(false))
    it('allows ssh to a host that is not in the list', () =>
      expect(evaluateCommand('ssh root@10.20.0.50 "uptime"').allowed).toBe(true))
  })

  it('refuses a malformed AUTOMATOR_PRODUCTION_HOSTS instead of dropping the host', () => {
    expect(() => productionHosts({AUTOMATOR_PRODUCTION_HOSTS: 'ok.example.com,not a host'})).toThrow(/AUTOMATOR_PRODUCTION_HOSTS/)
  })
})

// CYAU-112 — the retired provider is blocked entirely, but the vault in use (`cyi`) had a single rule,
// anchored to `cyi run` with the environment spelled out. The check is now an ALLOWLIST: an environment
// denylist does not hold (`prod`, `prd`, the environment UUID, an expansion), and two commands that read or
// push the secrets — `secrets sync`, `secrets assets download` — do not even have an environment flag.
describe('evaluateCommand · secrets of the vault in use (CYAU-112)', () => {
  it('blocks cyi run in production with both binary names', () => {
    expect(evaluateCommand('cyi run -p CYI -e production -- printenv DATABASE_URL').violation).toBe('production')
    expect(evaluateCommand('closeyourit run -p CYI -e production -- printenv DATABASE_URL').violation).toBe('production')
  })

  it('blocks every environment spelling that is not an authorized environment', () => {
    expect(evaluateCommand('cyi run -p CYI -e prod -- printenv').violation).toBe('production')
    expect(evaluateCommand('cyi run -p CYI -e prd -- printenv').violation).toBe('production')
    expect(evaluateCommand('cyi run -p CYI -eproduction -- printenv').violation).toBe('production')
    expect(evaluateCommand('cyi run -p CYI --environment=production -- printenv').violation).toBe('production')
    expect(evaluateCommand("cyi run -p CYI -e 'production' -- printenv").violation).toBe('production')
    // The opaque environment id is an environment like any other: outside the allowlist, so denied.
    expect(evaluateCommand('cyi run -p CYI -e 7e9ef0d6-94c4-4aba-832f-cb5ce4b23b47 -- printenv').violation).toBe('production')
    // Value from expansion: statically unreadable → denied, not allowed pending knowing its value.
    expect(evaluateCommand('E=production; cyi run -p CYI -e "$E" -- printenv').violation).toBe('production')
    // Missing environment flag: `cyi run` requires it, so the form is already invalid — and unreadable anyway.
    expect(evaluateCommand('cyi run -p CYI -- printenv').violation).toBe('production')
    // Line continuation: the flag ends up on another line and can no longer be attributed to the invocation.
    expect(evaluateCommand('cyi run -p CYI \\\n-e production -- printenv').violation).toBe('production')
  })

  // CYAU-174 — twin of the rule in the hook: the server moves the state, not the agent. The boundary is one
  // character, so `statuses` must be tested next to `status` or the rule can tighten too much unnoticed.
  it('denies the agent the levers that move the ticket, and lets it read and comment', () => {
    expect(evaluateCommand('cyi tickets status CYAU-1 -p CYAU --status-id 7857bea5').violation).toBe('managed-secret')
    expect(evaluateCommand('cyi tickets update CYAU-1 -p CYAU --title x').violation).toBe('managed-secret')
    expect(evaluateCommand('closeyourit tickets approve CYAU-1 -p CYAU').violation).toBe('managed-secret')
    expect(evaluateCommand('cd /tmp && cyi tickets approve CYAU-1 -p CYAU').violation).toBe('managed-secret')

    expect(evaluateCommand('cyi tickets statuses -p CYAU --json').allowed).toBe(true)
    expect(evaluateCommand('cyi tickets show CYAU-1 -p CYAU').allowed).toBe(true)
    expect(evaluateCommand('cyi tickets list -p CYAU --json').allowed).toBe(true)
    expect(evaluateCommand('cyi tickets comment CYAU-1 -p CYAU -m "fatto"').allowed).toBe(true)
  })

  it('blocks the whole `cyi secrets` family that exposes or modifies values', () => {
    expect(evaluateCommand('cyi secrets get -p CYI -e production DATABASE_URL').violation).toBe('managed-secret')
    expect(evaluateCommand('cyi secrets download -p CYI -e production --format json').violation).toBe('managed-secret')
    expect(evaluateCommand('cyi secrets set -p CYI -e production K=v').violation).toBe('managed-secret')
    expect(evaluateCommand('cyi secrets delete -p CYI -e production K').violation).toBe('managed-secret')
    expect(evaluateCommand('cyi secrets import -p CYI -e production --file .env').violation).toBe('managed-secret')
  })

  // The bypass a rule on the environment could not see: these commands touch production without
  // naming it, because they have no environment flag at all.
  it('blocks the secret commands that have no environment flag', () => {
    expect(evaluateCommand('cyi secrets sync -p CYI').violation).toBe('managed-secret')
    expect(evaluateCommand('closeyourit secrets assets download 42 -p CYI -o /tmp/out').violation).toBe('managed-secret')
    expect(evaluateCommand('cyi secrets assets purge 42 -p CYI').violation).toBe('managed-secret')
    expect(evaluateCommand('cyi secrets assets shared-list').violation).toBe('managed-secret')
  })

  it('blocks the obfuscated form, as the claude hook this module mirrors already does', () => {
    expect(evaluateCommand("cy'i' run -p CYI -e production -- printenv").violation).toBe('production')
    expect(evaluateCommand('cyi run -p CYI -e prod\\uction -- printenv').violation).toBe('production')
  })

  it('blocks also at the tail of a legitimate command', () =>
    expect(evaluateCommand('bundle exec rspec && cyi secrets get -p CYI -e production DATABASE_URL').violation)
      .toBe('managed-secret'))

  it('lets through the environments authorized for the service account', () => {
    expect(evaluateCommand('cyi run -p CYI -e development -- bin/rails console').allowed).toBe(true)
    expect(evaluateCommand('cyi run --project CYI --environment staging -- bin/rails console').allowed).toBe(true)
    expect(evaluateCommand('cyi run -p CYI -e test -- bin/rails runner x').allowed).toBe(true)
  })

  it('lets through what does not expose values: name list and production observability', () => {
    // `secrets list` prints only the secret NAMES: it is the diagnostics allowed to the agent.
    expect(evaluateCommand('cyi secrets list -p CYI -e production').allowed).toBe(true)
    expect(evaluateCommand('cyi secrets assets list -p CYI').allowed).toBe(true)
    expect(evaluateCommand('cyi logs list --environment production --level error --json').allowed).toBe(true)
    expect(evaluateCommand('cyi errors list -p CYI --status unresolved --json').allowed).toBe(true)
  })

  it('does not confuse a `-e` of another command with the cyi environment flag', () => {
    expect(evaluateCommand('cyi tickets show CYAU-112 -p CYAU && grep -e production note.txt').allowed).toBe(true)
    // After the `--` the arguments belong to the hosted command: reading them would block a legitimate run…
    expect(evaluateCommand('cyi run -p CYI -e development -- grep -e production note.txt').allowed).toBe(true)
    // …and, conversely, they must not be able to redeem a forbidden environment declared before the `--`.
    expect(evaluateCommand('cyi run -p CYI -e production -- grep -e development note.txt').violation).toBe('production')
  })
})

describe('evaluateCommand · DB distruttivo', () => {
  it('blocks DROP TABLE', () => {
    const d = evaluateCommand('psql -c "DROP TABLE users"')
    expect(d.allowed).toBe(false)
    expect(d.violation).toBe('destructive-db')
  })

  it('blocks DROP DATABASE', () => expect(evaluateCommand('mysql -e "DROP DATABASE app"').violation).toBe('destructive-db'))
  it('blocks DROP SCHEMA', () => expect(evaluateCommand('psql -c "DROP SCHEMA public CASCADE"').allowed).toBe(false))
  it('blocks TRUNCATE <table>', () => expect(evaluateCommand('psql -c "TRUNCATE users"').violation).toBe('destructive-db'))
  it('blocks TRUNCATE TABLE', () => expect(evaluateCommand('psql -c "TRUNCATE TABLE users"').violation).toBe('destructive-db'))
  it('blocks DELETE FROM without WHERE (bulk deletion)', () =>
    expect(evaluateCommand('psql -c "DELETE FROM users"').violation).toBe('destructive-db'))
  it('blocks bin/rails db:drop', () => expect(evaluateCommand('bin/rails db:drop').violation).toBe('destructive-db'))
  it('blocks rake db:reset', () => expect(evaluateCommand('rake db:reset').allowed).toBe(false))
  it('blocks db:schema:load (overwrites the schema)', () => expect(evaluateCommand('bin/rails db:schema:load').allowed).toBe(false))
  it('blocks db:purge', () => expect(evaluateCommand('rails db:purge').allowed).toBe(false))

  // False negative (CYAU-25 review): the WHERE lookahead must be anchored to the same statement, not
  // to the whole string — a WHERE in a later chained command must not neutralize the block.
  it('blocks DELETE FROM without WHERE even if a WHERE appears in a command chained after (&&)', () =>
    expect(evaluateCommand('psql -c "DELETE FROM sessions" && bin/rails runner "User.where(id: 1)"').violation).toBe('destructive-db'))
  it('blocks the DELETE FROM without WHERE when the second statement (;) has a WHERE', () =>
    expect(evaluateCommand('psql -c "DELETE FROM sessions; DELETE FROM cache WHERE id=1"').violation).toBe('destructive-db'))

  it('allows DELETE FROM with WHERE (targeted deletion)', () =>
    expect(evaluateCommand('psql -c "DELETE FROM users WHERE id = 1"').allowed).toBe(true))
  it('allows db:migrate (non-destructive)', () => expect(evaluateCommand('bin/rails db:migrate').allowed).toBe(true))
  it('allows db:seed (non-destructive)', () => expect(evaluateCommand('bin/rails db:seed').allowed).toBe(true))

  // False positive (CYAU-25 review): `truncate` is also the UNIX coreutils command and the Ruby String#truncate method;
  // the rule must be in SQL context (table), not the isolated word.
  it('allows the UNIX truncate -s command (empties a log file, not SQL)', () =>
    expect(evaluateCommand('truncate -s 0 log/development.log').allowed).toBe(true))
  it('permette truncate --size', () => expect(evaluateCommand('truncate --size=0 tmp/x.log').allowed).toBe(true))
  it('allows Ruby String#truncate', () =>
    expect(evaluateCommand('bin/rails runner "puts msg.truncate(200)"').allowed).toBe(true))
})

describe('evaluateCommand · force-push', () => {
  it('blocks git push -f', () => {
    const d = evaluateCommand('git push -f origin ticket/CYAU-25')
    expect(d.allowed).toBe(false)
    expect(d.violation).toBe('force-push')
  })

  it('blocks git push --force', () => expect(evaluateCommand('git push --force origin ticket/x').violation).toBe('force-push'))
  it('blocks git push --force-with-lease', () =>
    expect(evaluateCommand('git push --force-with-lease origin ticket/x').violation).toBe('force-push'))
  it('force-push on protected branch → classified force-push (takes precedence)', () =>
    expect(evaluateCommand('git push --force origin main').violation).toBe('force-push'))
})

describe('evaluateCommand · branch protetti', () => {
  it('blocks push to main', () => {
    const d = evaluateCommand('git push origin main')
    expect(d.allowed).toBe(false)
    expect(d.violation).toBe('protected-branch')
  })

  it('blocks push to master', () => expect(evaluateCommand('git push origin master').violation).toBe('protected-branch'))
  it('blocks push to develop', () => expect(evaluateCommand('git push origin develop').allowed).toBe(false))
  it('blocks push to staging', () => expect(evaluateCommand('git push origin staging').allowed).toBe(false))
  it('blocks push to production', () => expect(evaluateCommand('git push origin production').allowed).toBe(false))
  it('blocks HEAD:main', () => expect(evaluateCommand('git push origin HEAD:main').violation).toBe('protected-branch'))
  it('blocks push to release/1.2', () => expect(evaluateCommand('git push origin release/1.2').violation).toBe('protected-branch'))
  it('blocks push to hotfix/x', () => expect(evaluateCommand('git push origin hotfix/urgent').allowed).toBe(false))
})

describe('evaluateCommand · allowed commands', () => {
  it('allows the push of the ticket/… branch', () =>
    expect(evaluateCommand('git push -u origin ticket/CYAU-25-fix').allowed).toBe(true))
  it('allows a ticket branch with "main" in the name', () =>
    expect(evaluateCommand('git push -u origin ticket/CYAU-25-fix-main-nav').allowed).toBe(true))
  it('permette bundle exec rspec', () => expect(evaluateCommand('bundle exec rspec').allowed).toBe(true))
  it('permette cyi', () => expect(evaluateCommand('cyi tickets list -p CYAU --json').allowed).toBe(true))
  it('permette cyi run in development', () =>
    expect(evaluateCommand('cyi run -p CYI -e development -- bin/rails console').allowed).toBe(true))
  it('allows gh pr create --base main (not a git push)', () =>
    expect(evaluateCommand('gh pr create --base main').allowed).toBe(true))
  it('denies mutating Git subcommands outside the allowlist', () => expect(evaluateCommand('git checkout main').allowed).toBe(false))
  it('permette git status', () => expect(evaluateCommand('git status').allowed).toBe(true))

  // CYAU-134: an agent that cannot read its own history does not know where the run is at.
  // In the real CYRA-225 run seven commands were denied, among them these.
  it('allows Git reads, chained ones too', () => {
    expect(evaluateCommand('git status && git log --oneline -10').allowed).toBe(true)
    expect(evaluateCommand('git log --oneline main..HEAD').allowed).toBe(true)
    expect(evaluateCommand('git rev-parse main').allowed).toBe(true)
    expect(evaluateCommand('git diff --stat').allowed).toBe(true)
    expect(evaluateCommand('git show HEAD').allowed).toBe(true)
    expect(evaluateCommand('git branch --list').allowed).toBe(true)
    // The standard way to know which branch one is on: denying it leaves the agent blind on its own worktree.
    expect(evaluateCommand('git branch --show-current').allowed).toBe(true)
    expect(evaluateCommand('git status && git branch --show-current').allowed).toBe(true)
    expect(evaluateCommand('git remote -v').allowed).toBe(true)
  })

  it('Git reads do not open the door to mutations nor to file writes', () => {
    expect(evaluateCommand('git branch -D main').allowed).toBe(false)
    expect(evaluateCommand('git tag -d v1.0.0').allowed).toBe(false)
    expect(evaluateCommand('git remote add evil https://x/y').allowed).toBe(false)
    expect(evaluateCommand('git diff --output=/tmp/out.patch').allowed).toBe(false)
    expect(evaluateCommand('git reset --hard origin/main').allowed).toBe(false)
    expect(evaluateCommand('git clean -fd').allowed).toBe(false)
    // A push stays the whole action: never at the tail of a read.
    expect(evaluateCommand('git status && git push origin ticket/CYAU-134').allowed).toBe(false)
  })

  it('allows path globs only in read-only filesystem commands', () => {
    expect(evaluateCommand('find spec -iname "*telegram*"').allowed).toBe(true)
    expect(evaluateCommand('ls app/views/member/*.erb').allowed).toBe(true)
    expect(evaluateCommand('grep -rn "foo" app/**/*.rb').allowed).toBe(true)
    // Outside those commands the glob stays forbidden: it could resolve an executable.
    expect(evaluateCommand('./g* push origin main').allowed).toBe(false)
    expect(evaluateCommand('bundle exec rspec spec/*_spec.rb').allowed).toBe(false)
    // Brace expansion builds tokens: forbidden even in a read command.
    expect(evaluateCommand('ls {git,push}').allowed).toBe(false)
    expect(evaluateCommand('find . -name "$(whoami)"').allowed).toBe(false)
  })
  it('empty string → allowed (no command to evaluate)', () => expect(evaluateCommand('').allowed).toBe(true))
  it('only spaces → allowed', () => expect(evaluateCommand('   ').allowed).toBe(true))
})

describe('evaluateCommand · launcher git autoritativo', () => {
  it('blocks arbitrary wrappers/paths even when the ticket refspec is valid', () => {
    expect(evaluateCommand('/tmp/git push origin ticket/CYAU-55').allowed).toBe(false)
    expect(evaluateCommand('$HOME/bin/git push origin ticket/CYAU-55').allowed).toBe(false)
    expect(evaluateCommand("g''it push origin ticket/CYAU-55").allowed).toBe(false)
    expect(evaluateCommand('g\\it push origin ticket/CYAU-55').allowed).toBe(false)
    expect(evaluateCommand('git p${x}ush origin ticket/CYAU-55').allowed).toBe(false)
    expect(evaluateCommand('gi${x}t p${y}ush origin ticket/CYAU-55').allowed).toBe(false)
    expect(evaluateCommand('g=git; $g push origin ticket/CYAU-55').allowed).toBe(false)
    expect(evaluateCommand('verb=push; git $verb origin ticket/CYAU-55').allowed).toBe(false)
    expect(evaluateCommand('g=git; p=push; $g $p origin main').allowed).toBe(false)
    expect(evaluateCommand('echo $HOME').allowed).toBe(false)
    expect(evaluateCommand('git p* origin main').allowed).toBe(false)
    expect(evaluateCommand('./.g push origin main').allowed).toBe(false)
    expect(evaluateCommand('git -C /tmp/other push origin ticket/CYAU-55').allowed).toBe(false)
    expect(evaluateCommand('git diff --output=/tmp/written').allowed).toBe(false)
    expect(evaluateCommand('cd /tmp; git push origin ticket/CYAU-55').allowed).toBe(false)
  })
})

describe('evaluateAction · applies the policy to the inspectable commands of the action', () => {
  it('shell action with forbidden command → blocked', () => {
    const d = evaluateAction(action({type: 'shell', run: 'kamal deploy'}))
    expect(d.allowed).toBe(false)
    expect(d.violation).toBe('production')
  })

  it('legitimate shell action → allowed', () =>
    expect(evaluateAction(action({type: 'shell', run: 'bundle exec rspec'})).allowed).toBe(true))

  it('shell action with force-push → blocked', () =>
    expect(evaluateAction(action({type: 'shell', run: 'git push --force origin ticket/x'})).violation).toBe('force-push'))

  it('shell action with forbidden on_failure → blocked (even if the main run is legitimate)', () => {
    const d = evaluateAction(action({type: 'shell', run: 'bin/ci', on_failure: {run: 'kamal rollback'}}))
    expect(d.allowed).toBe(false)
    expect(d.violation).toBe('production')
  })

  it('shell action with legitimate on_failure → allowed', () =>
    expect(evaluateAction(action({type: 'shell', run: 'bin/ci', on_failure: {run: 'cyi report'}})).allowed).toBe(true))

  // Heart of the ticket: an agent prompt is NOT a command → it must not be evaluated (a prompt mentioning "deploy" or
  // "push" is legitimate). The defence of the agent's INTERNAL commands stays provider-specific (claude hook/codex sandbox).
  it('claude action: the run is a PROMPT, not a command → allowed even if it mentions sensitive operations', () =>
    expect(evaluateAction(action({type: 'claude', run: 'valuta se serve un deploy kamal e come fare git push --force'})).allowed).toBe(true))

  it('codex action: the run is a PROMPT, not a command → allowed even if it mentions sensitive operations', () =>
    expect(evaluateAction(action({type: 'codex', run: 'droppa la tabella users e fai git push su main'})).allowed).toBe(true))

  it('a structured field of the retired provider is rejected by the schema', () => {
    const retiredEnv = {[RETIRED_PROVIDER]: {project: 'p', config: 'development'}}
    expect(() => action({type: 'shell', run: 'cyi x', env: retiredEnv})).toThrow(/Unrecognized key/)
  })
})
