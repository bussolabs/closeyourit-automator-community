import {execFileSync, spawnSync} from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import {afterEach, describe, expect, it} from 'vitest'

const script = path.resolve('scripts/release-package.mjs')
const temporaryDirectories: string[] = []

function temporaryDirectory(): string {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'automator-release-package-'))
  temporaryDirectories.push(directory)
  return directory
}

function writePackage(directory: string, version = '0.0.0'): string {
  const packagePath = path.join(directory, 'package.json')
  fs.writeFileSync(packagePath, `${JSON.stringify({name: '@bussolabs/closeyourit-automator', version}, null, 2)}\n`)
  return packagePath
}

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) fs.rmSync(directory, {recursive: true, force: true})
})

describe('release-package', () => {
  it('the workflow stamps and verifies the staged package before creating checksum and manifest', () => {
    const workflow = fs.readFileSync('.github/workflows/release.yml', 'utf8')
    const validate = workflow.indexOf('release-package.mjs validate')
    const stamp = workflow.indexOf('release-package.mjs stamp')
    const install = workflow.indexOf('"$PNPM" install --prod --frozen-lockfile')
    const verify = workflow.indexOf('release-package.mjs verify')
    const archive = workflow.indexOf('tar --sort=name')
    const checksum = workflow.indexOf('shasum -a 256')
    const manifest = workflow.indexOf('release-package.mjs "${manifest_args[@]}"')
    const publish = workflow.indexOf('gh release create')

    expect(validate).toBeGreaterThan(-1)
    expect(stamp).toBeGreaterThan(validate)
    expect(install).toBeGreaterThan(stamp)
    expect(verify).toBeGreaterThan(install)
    expect(archive).toBeGreaterThan(verify)
    expect(checksum).toBeGreaterThan(archive)
    expect(manifest).toBeGreaterThan(checksum)
    expect(publish).toBeGreaterThan(manifest)
  })

  it('publishes append-only generations and distinguishes a missing manifest from transient errors', () => {
    const workflow = fs.readFileSync('.github/workflows/release.yml', 'utf8')
    const updateCommand = fs.readFileSync('src/commands/update.ts', 'utf8')

    expect(updateCommand).toContain('api.github.com/repos/bussolabs/closeyourit-automator-community/releases/tags/automator-channels')
    expect(workflow).toContain('gh api --paginate --slurp')
    expect(workflow).toContain('sort_by([.created_at, .id]) | last | .url // empty')
    expect(workflow).toContain('generation="$CHANNEL-$VERSION.json"')
    expect(workflow).toContain('gh release upload automator-channels "$generation"')
    expect(workflow).not.toContain('gh release upload automator-channels "$CHANNEL.json" --clobber')
    expect(workflow).not.toContain('gh release upload "$GITHUB_REF_NAME" $assets --clobber')
    expect(workflow).toContain('cmp -s "$asset" "existing-$asset"')
    expect(workflow).toContain('existing_generation_url=$(jq')
    expect(workflow).toContain('manifest_args+=(--existing existing-generation.json)')
    expect(workflow.indexOf('existing-generation.json')).toBeLessThan(workflow.indexOf('previous_url=$(jq'))
    expect(workflow).toContain("--sort=name --mtime='UTC 1970-01-01' --owner=0 --group=0 --numeric-owner")
    expect(workflow).toContain('stage="$RUNNER_TEMP/$stage_name"')
    // The final parenthesis is part of the assertion: it anchors the END of the command, so a
    // `--ignore-workspace` reintroduced at the tail would not pass. That flag ignored
    // `pnpm-workspace.yaml`, which since pnpm 10 contains `overrides` and `allowBuilds`: with overrides in the
    // lockfile and none in the stage, the install dies with ERR_PNPM_LOCKFILE_CONFIG_MISMATCH and the
    // release publishes nothing. The file must be copied with the others (assertion below).
    expect(workflow).toContain('"$PNPM" install --prod --frozen-lockfile --ignore-scripts )')
    expect(workflow).toContain('cp -R bin dist assets package.json pnpm-lock.yaml pnpm-workspace.yaml "$stage"/')
    expect(workflow).toContain('| gzip -n > "$stage_name.tgz"')
    expect(workflow).toContain('mv "published-$artifact" "$artifact"')
    expect(workflow.indexOf('mv "published-$artifact" "$artifact"')).toBeLessThan(
      workflow.indexOf('release-package.mjs "${manifest_args[@]}"'),
    )
    expect(workflow).toContain('SHA256: ${{ needs.package.outputs.sha256 }}')
    expect(workflow).toContain('Not Found (HTTP 404)')
    expect(workflow).toContain('cat channel-release-error >&2')
    expect(workflow).not.toContain('gh release list --limit 100')
    expect(workflow).toContain('group: automator-release')
  })

  it('a late rerun reuses byte for byte the historical generation already published', () => {
    const directory = temporaryDirectory()
    const existing = path.join(directory, 'stable-1.0.0.json')
    const previous = path.join(directory, 'stable-2.0.0.json')
    const output = path.join(directory, 'output.json')
    const firstEntry = {version: '1.0.0', channel: 'stable', url: 'https://example/v1.tgz', sha256: 'sha-v1'}
    const exactBytes = `${JSON.stringify({channel: 'stable', releases: [firstEntry]}, null, 2)}\n`
    fs.writeFileSync(existing, exactBytes)
    fs.writeFileSync(previous, `${JSON.stringify({
      channel: 'stable',
      releases: [firstEntry, {version: '2.0.0', channel: 'stable', url: 'https://example/v2.tgz', sha256: 'sha-v2'}],
    })}\n`)

    const result = spawnSync(process.execPath, [
      script, 'manifest', '--version', '1.0.0', '--channel', 'stable', '--url', firstEntry.url,
      '--sha256', firstEntry.sha256, '--output', output, '--existing', existing,
    ], {encoding: 'utf8'})

    expect(result.status, result.stderr).toBe(0)
    expect(fs.readFileSync(output, 'utf8')).toBe(exactBytes)
    expect(fs.readFileSync(output, 'utf8')).not.toContain('2.0.0')
  })

  it('a late rerun fails closed if the historical generation does not match the current SHA', () => {
    const directory = temporaryDirectory()
    const existing = path.join(directory, 'stable-1.0.0.json')
    const output = path.join(directory, 'output.json')
    fs.writeFileSync(existing, `${JSON.stringify({
      channel: 'stable',
      releases: [{version: '1.0.0', channel: 'stable', url: 'https://example/v1.tgz', sha256: 'sha-diverso'}],
    })}\n`)

    const result = spawnSync(process.execPath, [
      script, 'manifest', '--version', '1.0.0', '--channel', 'stable', '--url', 'https://example/v1.tgz',
      '--sha256', 'sha-v1', '--output', output, '--existing', existing,
    ], {encoding: 'utf8'})

    expect(result.status).not.toBe(0)
    expect(result.stderr).toMatch(/existing generation inconsistent/i)
    expect(fs.existsSync(output)).toBe(false)
  })

  it.runIf(spawnSync('tar', ['--version'], {encoding: 'utf8'}).stdout.includes('GNU tar'))(
    'the normalized GNU archive is byte-identical after rebuilding the staging',
    () => {
      const directory = temporaryDirectory()
      const stage = path.join(directory, 'automator-1.2.3')
      const pack = (output: string, reverse: boolean): void => {
        fs.rmSync(stage, {recursive: true, force: true})
        fs.mkdirSync(stage)
        for (const name of reverse ? ['b.txt', 'a.txt'] : ['a.txt', 'b.txt']) {
          fs.writeFileSync(path.join(stage, name), `${name}\n`)
        }
        const result = spawnSync('bash', [
          '-c',
          "tar --sort=name --mtime='UTC 1970-01-01' --owner=0 --group=0 --numeric-owner -cf - automator-1.2.3 | gzip -n > \"$1\"",
          'pack',
          output,
        ], {cwd: directory, encoding: 'utf8'})
        expect(result.status, result.stderr).toBe(0)
      }

      const first = path.join(directory, 'first.tgz')
      const second = path.join(directory, 'second.tgz')
      pack(first, false)
      pack(second, true)
      expect(fs.readFileSync(second)).toEqual(fs.readFileSync(first))
    },
  )

  it('embeds the SemVer version only in the package.json copied into the staging', () => {
    const directory = temporaryDirectory()
    const sourcePackage = writePackage(directory)
    const stagedDirectory = path.join(directory, 'automator-1.4.0-beta.1')
    fs.mkdirSync(stagedDirectory)
    const stagedPackage = path.join(stagedDirectory, 'package.json')
    fs.copyFileSync(sourcePackage, stagedPackage)

    execFileSync(process.execPath, [script, 'stamp', '--package', stagedPackage, '--version', '1.4.0-beta.1'])

    expect(JSON.parse(fs.readFileSync(sourcePackage, 'utf8')).version).toBe('0.0.0')
    expect(JSON.parse(fs.readFileSync(stagedPackage, 'utf8')).version).toBe('1.4.0-beta.1')
  })

  it.each([
    '01.2.3',
    '1.02.3',
    '1.2.03',
    '1.2.3-alpha..1',
    '1.2.3-.',
    '1.2.3-01',
    '1.2.3+build.1',
    '1.2',
    '9007199254740992.0.0',
  ])('rejects the non-SemVer version %s before modifying the package', (invalidVersion) => {
    const packagePath = writePackage(temporaryDirectory())

    const result = spawnSync(process.execPath, [script, 'stamp', '--package', packagePath, '--version', invalidVersion], {
      encoding: 'utf8',
    })

    expect(result.status).not.toBe(0)
    expect(JSON.parse(fs.readFileSync(packagePath, 'utf8')).version).toBe('0.0.0')
  })

  it.each(['0.0.0', '1.2.3', '1.2.3-alpha', '1.2.3-alpha.1', '1.2.3-x-y-z.--'])('accepts %s', (version) => {
    const result = spawnSync(process.execPath, [script, 'validate', '--version', version], {encoding: 'utf8'})

    expect(result.status).toBe(0)
  })

  it('verifies that package metadata and --version output match the expected version', () => {
    const directory = temporaryDirectory()
    const packagePath = writePackage(directory, '2.3.4')
    const cliPath = path.join(directory, 'cli.mjs')
    fs.writeFileSync(cliPath, "console.log('@bussolabs/closeyourit-automator/2.3.4 linux-x64 node-v24')\n")

    expect(() => execFileSync(process.execPath, [
      script, 'verify', '--package', packagePath, '--version', '2.3.4', '--cli', cliPath,
    ])).not.toThrow()
  })

  // The checkout deliberately exposes the 0.0.0 placeholder: the real version is the git tag, which
  // release.yml stamps into the artifact via `release-package.mjs stamp`. No manual bump of package.json.
  it('verifies that the checkout exposes the 0.0.0 placeholder (source of truth: the release tags)', () => {
    expect(() => execFileSync(process.execPath, [
      script, 'verify', '--package', path.resolve('package.json'), '--version', '0.0.0', '--cli', path.resolve('bin/run.js'),
    ])).not.toThrow()
  })

  // opencli.json is static and committed (release.yml does NOT stamp it with the tag): its version must
  // stay aligned with the package.json placeholder, otherwise it diverges again (CYAU-99).
  it('opencli.json exposes the same placeholder version as package.json', () => {
    const pkg = JSON.parse(fs.readFileSync(path.resolve('package.json'), 'utf8'))
    const opencli = JSON.parse(fs.readFileSync(path.resolve('opencli.json'), 'utf8'))
    expect(opencli.info.version).toBe(pkg.version)
  })

  it.each([
    ['metadata', '2.3.3', '@bussolabs/closeyourit-automator/2.3.4 linux-x64 node-v24'],
    ['binary', '2.3.4', '@bussolabs/closeyourit-automator/0.0.1 linux-x64 node-v24'],
  ])('fails closed if %s does not match the tag', (_surface, packageVersion, cliOutput) => {
    const directory = temporaryDirectory()
    const packagePath = writePackage(directory, packageVersion)
    const cliPath = path.join(directory, 'cli.mjs')
    fs.writeFileSync(cliPath, `console.log(${JSON.stringify(cliOutput)})\n`)

    const result = spawnSync(process.execPath, [
      script, 'verify', '--package', packagePath, '--version', '2.3.4', '--cli', cliPath,
    ], {encoding: 'utf8'})

    expect(result.status).not.toBe(0)
  })

  it.each([
    ['empty output', ''],
    ['non-zero process', "process.stderr.write('ko\\n'); process.exitCode = 7"],
  ])('fails closed with %s from the binary', (_case, source) => {
    const directory = temporaryDirectory()
    const packagePath = writePackage(directory, '2.3.4')
    const cliPath = path.join(directory, 'cli.mjs')
    fs.writeFileSync(cliPath, source)

    const result = spawnSync(process.execPath, [
      script, 'verify', '--package', packagePath, '--version', '2.3.4', '--cli', cliPath,
    ], {encoding: 'utf8'})

    expect(result.status).not.toBe(0)
  })

  it('fails closed if the staged binary does not exist', () => {
    const directory = temporaryDirectory()
    const packagePath = writePackage(directory, '2.3.4')

    const result = spawnSync(process.execPath, [
      script, 'verify', '--package', packagePath, '--version', '2.3.4', '--cli', path.join(directory, 'missing.js'),
    ], {encoding: 'utf8'})

    expect(result.status).not.toBe(0)
  })
})
