#!/usr/bin/env node
import {spawnSync} from 'node:child_process'
import fs from 'node:fs'

const args = process.argv.slice(2)
if (process.env.E2E_EVENT_LOG) {
  fs.appendFileSync(process.env.E2E_EVENT_LOG, `${process.env.E2E_HOST_LABEL ?? 'unknown'}:cyi ${args.join(' ')}\n`)
}
const result = spawnSync(process.env.E2E_CYI_BIN, args, {stdio: 'inherit', env: process.env})
if (result.error) process.exit(126)
process.exit(result.status ?? 1)
