#!/usr/bin/env node
import {spawnSync} from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'

const args = process.argv.slice(2)
const eventLog = process.env.E2E_EVENT_LOG
const append = (event) => {
  if (eventLog) fs.appendFileSync(eventLog, `${process.env.E2E_HOST_LABEL ?? 'review'}:${event}\n`)
}

if (args[0] === 'sandbox') {
  const chunks = []
  for await (const chunk of process.stdin) chunks.push(chunk)
  const input = Buffer.concat(chunks).toString('utf8')
  const marker = 'UNTRUSTED_REVIEW_INPUT_JSON='
  const at = input.indexOf(marker)
  if (at < 0) process.exit(65)
  const payload = JSON.parse(input.slice(at + marker.length))
  append('review')
  process.stdout.write(JSON.stringify({
    is_error: false,
    structured_output: {
      review_complete: true,
      reviewed_base_commit: payload.base_commit,
      reviewed_snapshot_tree: payload.snapshot_tree,
      reviewed_diff_sha256: payload.diff_sha256,
      findings: [],
    },
  }))
  process.exit(0)
}

if (!args.includes('exec')) process.exit(64)
append('implement')
const target = path.join(process.cwd(), 'E2E_RESULT.md')
fs.writeFileSync(target, '# Multi-host E2E\n\nImplementazione idempotente completata dal daemon vincitore.\n')
const staged = spawnSync('/usr/bin/git', ['add', '--', 'E2E_RESULT.md'], {cwd: process.cwd(), stdio: 'ignore'})
if (staged.status !== 0 || staged.error) process.exit(1)
process.stdout.write(JSON.stringify({
  outcome: 'success',
  summary: 'Aggiunge evidenza E2E multi-host',
  changedFiles: ['E2E_RESULT.md'],
  tests: ['quality gate automatico'],
  risks: [],
  confidence: 'high',
}))
