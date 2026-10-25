import {spawnSync} from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import {afterEach, describe, expect, it} from 'vitest'

import {runReleaseSmoke} from '../src/lib/release-smoke'

const temporaryDirectories: string[] = []

function temporaryDirectory(): string {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'automator-release-smoke-test-'))
  temporaryDirectories.push(directory)
  return directory
}

function candidateArchive(version: string): string {
  const root = temporaryDirectory()
  const stage = path.join(root, `automator-${version}`)
  fs.mkdirSync(path.join(stage, 'bin'), {recursive: true})
  fs.writeFileSync(
    path.join(stage, 'package.json'),
    `${JSON.stringify({name: '@bussolabs/closeyourit-automator', version})}\n`,
  )
  fs.writeFileSync(
    path.join(stage, 'bin', 'run.js'),
    `const metadata = require('../package.json'); console.log('@bussolabs/closeyourit-automator/' + metadata.version + ' test-x64 node-test')\n`,
  )
  const archive = path.join(root, `automator-${version}.tgz`)
  const packed = spawnSync('tar', ['-czf', archive, path.basename(stage)], {cwd: root, encoding: 'utf8'})
  expect(packed.status, packed.stderr).toBe(0)
  return archive
}

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) fs.rmSync(directory, {recursive: true, force: true})
})

describe('release smoke — artifact as a new machine', () => {
  it.skipIf(process.platform !== 'linux')('verifies fresh install, healthy upgrade and rollback after health failure using real I/O', () => {
    const result = runReleaseSmoke({
      artifact: candidateArchive('1.2.3-beta.1'),
      version: '1.2.3-beta.1',
      channel: 'beta',
      workspace: temporaryDirectory(),
    })

    expect(result).toEqual({
      version: '1.2.3-beta.1',
      channel: 'beta',
      freshInstall: 'updated',
      upgrade: 'updated',
      rollback: 'rolled-back',
      rollbackTarget: '0.0.0',
      restartCount: 6,
    })
  })

  it('the workflow runs the Linux smoke on the same artifact before publishing', () => {
    const workflow = fs.readFileSync('.github/workflows/release.yml', 'utf8')
    const packageJob = workflow.indexOf('  package:')
    const smokeJob = workflow.indexOf('  release-smoke:')
    const publishJob = workflow.indexOf('  publish:')

    expect(packageJob).toBeGreaterThan(-1)
    expect(smokeJob).toBeGreaterThan(packageJob)
    expect(publishJob).toBeGreaterThan(smokeJob)
    expect(workflow).toContain('name: smoke linux')
    expect(workflow).toContain('runs-on: ubuntu-latest')
    expect(workflow).not.toContain('macos-latest')
    expect(workflow).toContain('Verifica prerequisiti host Linux')
    expect(workflow).toContain('bash scripts/test-secret-service.sh')
    expect(workflow).toContain('node scripts/release-smoke.mjs')
    expect(workflow).toContain('stage="$RUNNER_TEMP/$stage_name"')
    expect(workflow).toContain('--ignore-workspace')
    expect(workflow).toContain('Verifica bootstrap reale e idempotente su host pulito')
    expect(workflow).toContain('AUTOMATOR_BOOTSTRAP_REAL_ARTIFACT:')
    expect(workflow).toContain('pnpm vitest run test/bootstrap.test.ts -t "artifact release reale"')
    expect(workflow).toContain('needs: [package, release-smoke]')
    expect(workflow).toContain('actions/checkout@9c091bb21b7c1c1d1991bb908d89e4e9dddfe3e0')
    expect(workflow).toContain('actions/upload-artifact@043fb46d1a93c77aae656e7c1c64a875d1fc6a0a')
    expect(workflow).toContain('actions/download-artifact@3e5f45b2cfb9172054b4087a40e8e0b5a5461e7c')
    expect(workflow).toMatch(/publish:[\s\S]*?runs-on: ubuntu-latest/)
  })

  it.skipIf(process.platform !== 'linux')('fails closed when the candidate does not match the declared version', () => {
    expect(() => runReleaseSmoke({
      artifact: candidateArchive('1.2.3'),
      version: '1.2.4',
      channel: 'stable',
      workspace: temporaryDirectory(),
    })).toThrow(/fresh install fallita|preflight/i)
  })

  it('rejects invalid version, artifact and archive before the release', () => {
    const workspace = temporaryDirectory()
    const missingArtifact = path.join(workspace, 'missing.tgz')
    const corruptArtifact = path.join(workspace, 'corrupt.tgz')
    fs.writeFileSync(corruptArtifact, 'non è un archivio tar')

    expect(() => runReleaseSmoke({
      artifact: missingArtifact,
      version: 'non-semver',
      channel: 'stable',
      workspace,
    })).toThrow(/versione non SemVer/i)

    expect(() => runReleaseSmoke({
      artifact: missingArtifact,
      version: '1.2.3',
      channel: 'stable',
      workspace,
    })).toThrow(/artifact non trovato/i)

    expect(() => runReleaseSmoke({
      artifact: corruptArtifact,
      version: '1.2.3',
      channel: 'stable',
      workspace,
    })).toThrow(/estrazione baseline fallita/i)
  })
})
