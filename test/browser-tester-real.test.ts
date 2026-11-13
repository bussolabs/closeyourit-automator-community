import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'

import {describe, expect, it} from 'vitest'

import {defaultBrowserTesterIo, resolveBrowserTools} from '../src/lib/browser-tester'
import {defaultEmulatorIo} from '../src/lib/emulator-test'

// CYAU-329 — the real cage and the real browser, on a worker machine. Skipped wherever bubblewrap, agent-browser or
// its Chrome are missing: the unit tests cover the logic, this one covers what only the machine can prove.
const machine = defaultEmulatorIo()
const ready = process.platform === 'linux' && machine.bwrapAvailable() && resolveBrowserTools() !== null

describe.skipIf(!ready)('the Tester browser in the real cage (CYAU-329)', () => {
  it('opens the allowed site, refuses every other one, hides the credentials and dies with its cage', async () => {
    const stateDir = fs.mkdtempSync(path.join(os.homedir(), '.tester-real-'))
    const previous = process.env.AUTOMATOR_STATE_DIR
    process.env.AUTOMATOR_STATE_DIR = stateDir
    try {
      const io = defaultBrowserTesterIo()
      expect((await io.available()).available).toBe(true)
      const session = await io.start({ticket: 'REAL-1', url: 'https://example.com/'})
      expect(session).not.toBeNull()
      if (!session) return
      try {
        expect(await session.snapshot()).toContain('Learn more')
        expect(await session.pageText()).toContain('documentation examples')

        const elsewhere = await session.step(['open', 'https://www.iana.org/'])
        expect(elsewhere.ok).toBe(false)
        const byAddress = await session.step(['open', 'http://1.1.1.1/'])
        expect(byAddress.ok).toBe(false)

        const image = await session.screenshot()
        expect(image?.subarray(1, 4).toString('latin1')).toBe('PNG')
      } finally {
        await session.close()
      }
      // The scratch folder is gone with the session.
      expect(fs.readdirSync(path.join(stateDir, 'emulator-build'))).toEqual([])
    } finally {
      if (previous === undefined) delete process.env.AUTOMATOR_STATE_DIR
      else process.env.AUTOMATOR_STATE_DIR = previous
      fs.rmSync(stateDir, {recursive: true, force: true})
    }
  }, 240_000)
})
