#!/usr/bin/env node
import fs from 'node:fs'

const args = process.argv.slice(2)
const command = args[0] === 'exec' && args[1] === '--' && args[2] === 'sh' && args[3] === '-c' ? args[4] : null
const checks = new Map([
  ['pnpm lint', 'gate-lint'],
  ['pnpm vitest run --coverage --minWorkers=4 --maxWorkers=4', 'gate-full'],
  ['pnpm build', 'gate-build'],
])
const event = command === null ? undefined : checks.get(command)
if (!event) process.exit(64)

const log = process.env.E2E_EVENT_LOG
if (log) fs.appendFileSync(log, `${process.env.E2E_HOST_LABEL ?? 'unknown'}:${event}\n`)
