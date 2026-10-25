import {createHash} from 'node:crypto'
import {spawnSync} from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import {afterEach, describe, expect, it} from 'vitest'

const roots: string[] = []
const repoRoot = path.resolve(import.meta.dirname, '..')
const bootstrap = path.join(repoRoot, 'bin', 'bootstrap.sh')

function executable(file: string, content: string): void {
  fs.writeFileSync(file, content, {mode: 0o755})
}

function fakeArtifact(root: string, version: string, unsafeLink = false): {file: string; sha256: string} {
  const stageName = `automator-${version}`
  const stage = path.join(root, stageName)
  fs.mkdirSync(path.join(stage, 'bin'), {recursive: true})
  fs.writeFileSync(path.join(stage, 'package.json'), `${JSON.stringify({
    name: '@bussolabs/closeyourit-automator',
    version,
  })}\n`)
  executable(path.join(stage, 'bin', 'run.js'), `#!/usr/bin/env node
const fs = require('node:fs')
const path = require('node:path')
const version = ${JSON.stringify(version)}
const args = process.argv.slice(2)
if (args.includes('--version')) {
  process.stdout.write('@bussolabs/closeyourit-automator/' + version + ' test node-' + process.version + '\\n')
  process.exit(0)
}
if ((args[0] === 'setup' || args[0] === 'doctor') && args[1] === '--help') {
  process.stdout.write('USAGE automator ' + args[0] + '\\n')
  process.exit(0)
}
if (args[0] !== 'update') process.exit(64)
const flag = (name) => args[args.indexOf(name) + 1]
const installRoot = flag('--install-root')
if (!installRoot || flag('--target-version') !== version || !flag('--manifest-url')) process.exit(65)
const release = path.join(installRoot, 'releases', version)
fs.mkdirSync(path.join(release, 'bin'), {recursive: true})
fs.copyFileSync(__filename, path.join(release, 'bin', 'run.js'))
fs.chmodSync(path.join(release, 'bin', 'run.js'), 0o755)
fs.writeFileSync(path.join(release, 'package.json'), JSON.stringify({name: '@bussolabs/closeyourit-automator', version}))
fs.mkdirSync(installRoot, {recursive: true})
const current = path.join(installRoot, 'current')
try { fs.unlinkSync(current) } catch (error) { if (error.code !== 'ENOENT') throw error }
fs.symlinkSync(release, current)
process.stdout.write(JSON.stringify({result: {outcome: 'updated'}}) + '\\n')
`)
  if (unsafeLink) fs.symlinkSync('../../outside-bootstrap-root', path.join(stage, 'escape'))
  const archive = path.join(root, `${stageName}.tgz`)
  const packed = spawnSync('tar', ['-czf', archive, stageName], {cwd: root, encoding: 'utf8'})
  if (packed.status !== 0) throw new Error(packed.stderr)
  return {file: archive, sha256: createHash('sha256').update(fs.readFileSync(archive)).digest('hex')}
}

interface Harness {
  root: string
  home: string
  env: NodeJS.ProcessEnv
  log: string
  run(): ReturnType<typeof spawnSync>
}

function harness(options: {version?: string; mode?: string; artifactFile?: string; homeName?: string; osName?: string} = {}): Harness {
  const version = options.version ?? '1.2.3'
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'automator-bootstrap-test-'))
  roots.push(root)
  const home = path.join(root, options.homeName ?? 'home')
  const fakeBin = path.join(root, 'bin')
  const log = path.join(root, 'commands.log')
  fs.mkdirSync(home, {recursive: true})
  fs.mkdirSync(fakeBin, {recursive: true})
  const artifact = options.artifactFile
    ? {
        file: path.resolve(options.artifactFile),
        sha256: createHash('sha256').update(fs.readFileSync(options.artifactFile)).digest('hex'),
      }
    : fakeArtifact(root, version, options.mode === 'unsafe-link')

  executable(path.join(fakeBin, 'mise'), `#!/bin/sh
printf 'mise %s\\n' "$*" >> "$BOOTSTRAP_TEST_LOG"
if [ "\${1:-}" = "--version" ]; then echo 'mise 2026.7.0'; fi
exit 0
`)
  executable(path.join(fakeBin, 'uname'), `#!/bin/sh\nprintf '%s\\n' '${options.osName ?? 'Linux'}'\n`)
  executable(path.join(fakeBin, 'cyi'), '#!/bin/sh\necho "cyi/1.0.0"\n')
  executable(path.join(fakeBin, 'claude'), '#!/bin/sh\necho "claude 1.0.0"\n')
  fs.symlinkSync(process.execPath, path.join(fakeBin, 'node'))
  executable(path.join(fakeBin, 'npm'), '#!/bin/sh\necho "unexpected npm" >&2\nexit 91\n')
  executable(path.join(fakeBin, 'gh'), `#!/usr/bin/env node
const fs = require('node:fs')
const args = process.argv.slice(2)
fs.appendFileSync(process.env.BOOTSTRAP_TEST_LOG, 'gh ' + args.join(' ') + '\\n')
const mode = process.env.BOOTSTRAP_TEST_MODE || ''
const version = process.env.BOOTSTRAP_TEST_VERSION
const authState = process.env.BOOTSTRAP_TEST_AUTH_STATE
const artifactUrl = mode === 'unsafe-url'
  ? 'https://attacker.example/automator.tgz'
  : 'https://github.com/bussolabs/closeyourit-automator-community/releases/download/v' + version + '/automator-' + version + '.tgz'
const release = {
  version, channel: 'stable', url: artifactUrl,
  sha256: mode === 'bad-checksum' ? '0'.repeat(64) : process.env.BOOTSTRAP_TEST_SHA,
  ...(mode === 'constrained' ? {minServer: '9.0.0'} : {}),
  ...(mode === 'unknown-field' ? {unexpected: true} : {}),
}
const manifest = JSON.stringify({channel: 'stable', releases: [release]})
if (args[0] === '--version') {
  process.stdout.write('gh version 2.96.0 (test)\\n')
} else if (args[0] === 'auth' && args[1] === 'status') {
  if (args.join(' ') !== 'auth status --active --hostname github.com') process.exit(95)
  if (mode === 'auth-login' && !fs.existsSync(authState)) process.exit(1)
} else if (args[0] === 'auth' && args[1] === 'login') {
  fs.writeFileSync(authState, 'authenticated\\n')
} else if (args[0] === 'api') {
  const url = args.at(-1)
  if (url === 'https://api.github.com/repos/bussolabs/closeyourit-automator-community/releases/tags/automator-channels') {
  process.stdout.write(JSON.stringify({assets_url: 'https://api.github.com/repos/bussolabs/closeyourit-automator-community/releases/1/assets'}))
  } else if (url.includes('/releases/1/assets?per_page=100&page=1')) {
  if (mode === 'pagination') {
    process.stdout.write(JSON.stringify(Array.from({length: 100}, (_, index) => ({
      id: index + 1, created_at: '2026-01-01T00:00:00Z', name: 'other-' + index, url: 'https://api.github.com/ignored/' + index,
    }))))
  } else {
    process.stdout.write(JSON.stringify([{id: 101, created_at: '2026-07-14T00:00:00Z', name: 'stable-' + version + '.json', url: 'https://api.github.com/repos/bussolabs/closeyourit-automator-community/releases/assets/101'}]))
  }
  } else if (url.includes('/releases/1/assets?per_page=100&page=2') && mode === 'pagination') {
  process.stdout.write(JSON.stringify([{id: 101, created_at: '2026-07-14T00:00:00Z', name: 'stable-' + version + '.json', url: 'https://api.github.com/repos/bussolabs/closeyourit-automator-community/releases/assets/101'}]))
  } else if (url === 'https://api.github.com/repos/bussolabs/closeyourit-automator-community/releases/assets/101') {
  process.stdout.write(manifest)
  } else {
    process.stderr.write('API inattesa: ' + url + '\\n')
    process.exit(92)
  }
} else if (args[0] === 'release' && args[1] === 'download') {
  const output = args[args.indexOf('--output') + 1]
  if (args[2] !== 'v' + version || args[args.indexOf('--repo') + 1] !== 'bussolabs/closeyourit-automator-community' ||
      args[args.indexOf('--pattern') + 1] !== 'automator-' + version + '.tgz' || !output) process.exit(93)
  fs.copyFileSync(process.env.BOOTSTRAP_TEST_ARTIFACT, output)
  if (mode === 'launcher-race') {
    const launcher = require('node:path').join(process.env.HOME, '.local', 'bin', 'automator')
    fs.unlinkSync(launcher)
    fs.symlinkSync('/tmp/launcher-estraneo', launcher)
  }
} else {
  process.stderr.write('gh inatteso: ' + args.join(' ') + '\\n')
  process.exit(94)
}
`)
  executable(path.join(fakeBin, 'curl'), `#!/usr/bin/env node
const fs = require('node:fs')
const {fileURLToPath} = require('node:url')
const args = process.argv.slice(2)
const url = args.at(-1)
const outputAt = args.indexOf('-o')
const output = outputAt >= 0 ? args[outputAt + 1] : null
fs.appendFileSync(process.env.BOOTSTRAP_TEST_LOG, 'curl ' + url + '\\n')
if (url.startsWith('file:') && output) {
  fs.copyFileSync(fileURLToPath(url), output)
} else if (url.startsWith('file:')) {
  process.stdout.write(fs.readFileSync(fileURLToPath(url)))
} else {
  process.stderr.write('URL inatteso: ' + url + '\\n')
  process.exit(92)
}
`)

  const env = {
    HOME: home,
    PATH: `${fakeBin}:/usr/bin:/bin`,
    LANG: 'C',
    LC_ALL: 'C',
    BOOTSTRAP_TEST_ARTIFACT: artifact.file,
    BOOTSTRAP_TEST_SHA: artifact.sha256,
    BOOTSTRAP_TEST_LOG: log,
    BOOTSTRAP_TEST_MODE: options.mode ?? '',
    BOOTSTRAP_TEST_VERSION: version,
    BOOTSTRAP_TEST_AUTH_STATE: path.join(root, 'gh-authenticated'),
  }
  return {
    root,
    home,
    env,
    log,
    run: () => spawnSync('/bin/sh', [bootstrap], {cwd: repoRoot, env, encoding: 'utf8', timeout: 30_000}),
  }
}

afterEach(() => {
  for (const root of roots.splice(0)) fs.rmSync(root, {recursive: true, force: true})
})

describe('bin/bootstrap.sh — verified fresh install', () => {
  it('rejects a non-Linux system before installing dependencies', () => {
    const subject = harness({osName: 'Darwin'})

    const result = subject.run()

    expect(result.status).toBe(2)
    expect(result.stderr).toContain('esclusivamente Linux')
    expect(fs.existsSync(subject.log)).toBe(false)
  })

  it('versions the launcher entrypoint as executable', () => {
    expect(fs.statSync(path.join(repoRoot, 'bin', 'run.js')).mode & 0o111).not.toBe(0)
  })

  it('installs the verified stable release, exposes automator on the PATH and points to the persistent PATH', () => {
    const subject = harness()
    const result = subject.run()

    expect(result.status, result.stderr).toBe(0)
    const launcher = path.join(subject.home, '.local', 'bin', 'automator')
    expect(fs.lstatSync(launcher).isSymbolicLink()).toBe(true)
    expect(fs.realpathSync(launcher)).toBe(fs.realpathSync(path.join(subject.home, '.local', 'lib', 'closeyourit-automator', 'releases', '1.2.3', 'bin', 'run.js')))
    const version = spawnSync(launcher, ['--version'], {env: subject.env, encoding: 'utf8'})
    expect(version.status, version.stderr).toBe(0)
    expect(version.stdout).toContain('@bussolabs/closeyourit-automator/1.2.3')
    for (const command of ['setup', 'doctor']) {
      const help = spawnSync(launcher, [command, '--help'], {env: subject.env, encoding: 'utf8'})
      expect(help.status, help.stderr).toBe(0)
      expect(help.stdout).toContain(`automator ${command}`)
    }
    expect(result.stdout).toContain('export PATH="$HOME/.local/bin:$HOME/.local/share/mise/shims:$PATH"')
    expect(result.stdout).toContain('automator setup')
    expect(result.stdout).toContain('automator doctor')
    expect(fs.readFileSync(subject.log, 'utf8')).toContain('mise use -g github:cli/cli@2.102.0')
  })

  it('is idempotent on a second run', () => {
    const subject = harness()
    expect(subject.run().status).toBe(0)
    const before = fs.realpathSync(path.join(subject.home, '.local', 'bin', 'automator'))

    const retry = subject.run()

    expect(retry.status, retry.stderr).toBe(0)
    expect(fs.realpathSync(path.join(subject.home, '.local', 'bin', 'automator'))).toBe(before)
  })

  it('follows all asset pages before choosing the stable generation', () => {
    const subject = harness({mode: 'pagination'})

    const result = subject.run()

    expect(result.status, result.stderr).toBe(0)
    expect(fs.readFileSync(subject.log, 'utf8')).toContain('page=2')
  })

  it('handles HOME and installRoot containing spaces without losing the launcher', () => {
    const subject = harness({homeName: 'home con spazi'})

    const result = subject.run()

    expect(result.status, result.stderr).toBe(0)
    expect(fs.realpathSync(path.join(subject.home, '.local', 'bin', 'automator'))).toContain('home con spazi')
  })

  it('completes the GitHub login in the same flow when the session is missing', () => {
    const subject = harness({mode: 'auth-login'})

    const result = subject.run()

    expect(result.status, result.stderr).toBe(0)
    const commands = fs.readFileSync(subject.log, 'utf8')
    expect(commands).toContain('gh auth login --hostname github.com --git-protocol https --web')
    expect(commands.match(/gh auth status --active --hostname github\.com/g)?.length).toBeGreaterThanOrEqual(2)
  })

  it('verifies only the active GitHub.com account and ignores expired secondary accounts', () => {
    const subject = harness()

    const result = subject.run()

    expect(result.status, result.stderr).toBe(0)
    const commands = fs.readFileSync(subject.log, 'utf8')
    expect(commands).toContain('gh auth status --active --hostname github.com')
    expect(commands).not.toMatch(/gh auth status --hostname github\.com/)
  })

  it('blocks a wrong checksum before extracting or activating the release', () => {
    const subject = harness({mode: 'bad-checksum'})

    const result = subject.run()

    expect(result.status).not.toBe(0)
    expect(result.stderr).toMatch(/checksum/i)
    expect(fs.existsSync(path.join(subject.home, '.local', 'lib', 'closeyourit-automator', 'current'))).toBe(false)
  })

  it('rejects artifacts outside the expected GitHub release', () => {
    const subject = harness({mode: 'unsafe-url'})

    const result = subject.run()

    expect(result.status).not.toBe(0)
    expect(result.stderr).toMatch(/URL.*artifact|artifact.*URL/i)
    expect(fs.readFileSync(subject.log, 'utf8')).not.toContain('attacker.example')
  })

  it('rejects before extraction a tar symlink escaping the signed root', () => {
    const subject = harness({mode: 'unsafe-link'})

    const result = subject.run()

    expect(result.status).not.toBe(0)
    expect(result.stderr).toMatch(/link artifact.*fuori root|target link artifact non sicuro/i)
    expect(fs.existsSync(path.join(subject.root, 'outside-bootstrap-root'))).toBe(false)
  })

  it.each([
    ['unverifiable server constraint', 'constrained'],
    ['unknown manifest field', 'unknown-field'],
  ])('fails closed with %s', (_label, mode) => {
    const subject = harness({mode})

    const result = subject.run()

    expect(result.status).not.toBe(0)
    expect(fs.existsSync(path.join(subject.home, '.local', 'lib', 'closeyourit-automator', 'current'))).toBe(false)
  })

  it('does not overwrite a foreign automator launcher', () => {
    const subject = harness()
    const launcher = path.join(subject.home, '.local', 'bin', 'automator')
    fs.mkdirSync(path.dirname(launcher), {recursive: true})
    fs.writeFileSync(launcher, 'estraneo\n')

    const result = subject.run()

    expect(result.status).not.toBe(0)
    expect(fs.readFileSync(launcher, 'utf8')).toBe('estraneo\n')
    expect(result.stderr).toMatch(/launcher.*esistente|automator.*esistente/i)
    expect(fs.readFileSync(subject.log, 'utf8')).not.toContain('/releases/tags/automator-channels')
  })

  it('rejects a managed launcher replaced during the download', () => {
    const subject = harness({mode: 'launcher-race'})
    const launcher = path.join(subject.home, '.local', 'bin', 'automator')
    const expectedTarget = path.join(subject.home, '.local', 'lib', 'closeyourit-automator', 'current', 'bin', 'run.js')
    fs.mkdirSync(path.dirname(launcher), {recursive: true})
    fs.symlinkSync(expectedTarget, launcher)

    const result = subject.run()

    expect(result.status).not.toBe(0)
    expect(result.stderr).toMatch(/launcher automator esistente e non gestito/i)
    expect(fs.readlinkSync(launcher)).toBe('/tmp/launcher-estraneo')
  })

  it.skipIf(!process.env.AUTOMATOR_BOOTSTRAP_REAL_ARTIFACT || !process.env.AUTOMATOR_BOOTSTRAP_REAL_VERSION)(
    'installs the real release artifact twice on a clean HOME',
    () => {
      const subject = harness({
        artifactFile: process.env.AUTOMATOR_BOOTSTRAP_REAL_ARTIFACT,
        version: process.env.AUTOMATOR_BOOTSTRAP_REAL_VERSION,
      })

      const first = subject.run()
      const retry = subject.run()

      expect(first.status, first.stderr).toBe(0)
      expect(retry.status, retry.stderr).toBe(0)
      const launcher = path.join(subject.home, '.local', 'bin', 'automator')
      const version = spawnSync(launcher, ['--version'], {env: subject.env, encoding: 'utf8'})
      expect(version.status, version.stderr).toBe(0)
      expect(version.stdout).toContain(`@bussolabs/closeyourit-automator/${process.env.AUTOMATOR_BOOTSTRAP_REAL_VERSION}`)
      expect(spawnSync(launcher, ['setup', '--help'], {env: subject.env}).status).toBe(0)
      expect(spawnSync(launcher, ['doctor', '--help'], {env: subject.env}).status).toBe(0)
    },
    60_000,
  )
})
