#!/usr/bin/env node
import fs from 'node:fs'

const args = process.argv.slice(2)
const eventLog = process.env.E2E_EVENT_LOG
const control = process.env.E2E_CONTROL_DIR
const label = process.env.E2E_HOST_LABEL ?? 'unknown'
const append = (event) => {
  if (eventLog) fs.appendFileSync(eventLog, `${label}:${event}\n`)
}

if (args[0] !== 'pr') process.exit(64)
if (args[1] === 'list') {
  const crashed = control && fs.existsSync(`${control}/delivery-crashed`)
  if (!crashed) {
    append('delivery-crash')
    fs.writeFileSync(`${control}/delivery-crashed`, `${label}\n`)
    setInterval(() => undefined, 60_000)
  } else {
    append('pr-list')
    const created = fs.existsSync(`${control}/pr-created`)
    process.stdout.write(created ? 'https://github.com/closeyourit/automator/pull/56\n' : '\n')
  }
} else if (args[1] === 'create') {
  append('pr-create')
  fs.writeFileSync(`${control}/pr-created`, `${label}\n`)
  process.stdout.write('https://github.com/closeyourit/automator/pull/56\n')
} else {
  process.exit(65)
}
