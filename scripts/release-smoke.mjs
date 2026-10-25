#!/usr/bin/env node

import {parseArgs} from 'node:util'

import {runReleaseSmoke} from '../dist/lib/release-smoke.js'

const {values} = parseArgs({
  options: {
    artifact: {type: 'string'},
    version: {type: 'string'},
    channel: {type: 'string'},
    workspace: {type: 'string'},
  },
  strict: true,
})

if (!values.artifact || !values.version || !values.channel) {
  throw new Error('--artifact, --version and --channel are required')
}

const result = runReleaseSmoke({
  artifact: values.artifact,
  version: values.version,
  channel: values.channel,
  workspace: values.workspace,
})
process.stdout.write(`${JSON.stringify(result)}\n`)
