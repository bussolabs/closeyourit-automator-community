import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import {spawnSync} from 'node:child_process'
import {afterAll, describe, expect, it} from 'vitest'
import {loadQualityGateAtRef} from '../src/lib/ticket-cycle'

const roots: string[] = []
afterAll(() => roots.forEach((root) => fs.rmSync(root, {recursive: true, force: true})))

function repo(withGate: boolean): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'automator-gate-ref-'))
  roots.push(root)
  spawnSync('git', ['init', '-q', root])
  fs.writeFileSync(path.join(root, 'README.md'), 'base\n')
  if (withGate) {
    fs.mkdirSync(path.join(root, '.closeyourit'))
    fs.writeFileSync(path.join(root, '.closeyourit', 'quality-gate.yml'), [
      'version: 2',
      'runner: []',
      'checks:',
      '  - {stage: lint, run: lint}',
      'remote:',
      '  provider: github',
      '  required_checks: ["ci / trusted"]',
      '',
    ].join('\n'))
  }
  spawnSync('git', ['-C', root, 'add', '.'])
  spawnSync('git', ['-C', root, '-c', 'user.name=Test', '-c', 'user.email=test@example.invalid', 'commit', '-qm', 'base'])
  return root
}

describe('quality gate of the base ref', () => {
  it('reads the committed blob and ignores a weakening in the proposed worktree', () => {
    const root = repo(true)
    fs.writeFileSync(path.join(root, '.closeyourit', 'quality-gate.yml'), [
      'version: 2', 'checks:', '  - {stage: lint, run: true}', 'remote:',
      '  provider: github', '  required_checks: ["ci / weakened"]', '',
    ].join('\n'))

    const config = loadQualityGateAtRef(root, 'HEAD')
    expect(config?.version).toBe(2)
    if (config?.version === 2) expect(config.remote.required_checks).toEqual(['ci / trusted'])
  })

  it('a legacy repository without the file returns null, an unattestable ref fails closed', () => {
    const root = repo(false)
    expect(loadQualityGateAtRef(root, 'HEAD')).toBeNull()
    expect(() => loadQualityGateAtRef(root, 'origin/missing')).toThrow(/ref base/)
  })
})
