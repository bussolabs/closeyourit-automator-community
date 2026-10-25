#!/usr/bin/env node

import {spawnSync} from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'

// SemVer 2.0 subset also supported by the update client: core + prerelease, without build metadata.
// Prevents leading zeros and empty prerelease identifiers or numeric ones with leading zeros.
const SEMVER_PATTERN = /^(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)(?:-(?:(?:0|[1-9]\d*|\d*[A-Za-z-][0-9A-Za-z-]*)(?:\.(?:0|[1-9]\d*|\d*[A-Za-z-][0-9A-Za-z-]*))*))?$/

function fail(message) {
  process.stderr.write(`release-package: ${message}\n`)
  process.exitCode = 1
}

function optionsFrom(argv) {
  const options = new Map()
  for (let index = 0; index < argv.length; index += 2) {
    const flag = argv[index]
    const value = argv[index + 1]
    if (!flag?.startsWith('--') || value === undefined || value.startsWith('--')) {
      throw new Error('invalid arguments')
    }
    if (options.has(flag)) throw new Error(`duplicate argument: ${flag}`)
    options.set(flag, value)
  }
  return options
}

function required(options, flag) {
  const value = options.get(flag)
  if (!value) throw new Error(`missing required argument: ${flag}`)
  return value
}

function validateVersion(version) {
  if (!SEMVER_PATTERN.test(version)) throw new Error('non-SemVer version')
  const core = version.split('-', 1)[0].split('.').map(Number)
  if (!core.every(Number.isSafeInteger)) throw new Error('version beyond the supported numeric range')
}

function readPackage(packagePath) {
  const parsed = JSON.parse(fs.readFileSync(packagePath, 'utf8'))
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('invalid package.json')
  if (typeof parsed.name !== 'string' || parsed.name.length === 0) throw new Error('missing package name')
  return parsed
}

function stamp(packagePath, version) {
  validateVersion(version)
  const manifest = readPackage(packagePath)
  manifest.version = version
  const temporaryPath = path.join(path.dirname(packagePath), `.package.json.release-${process.pid}`)
  try {
    fs.writeFileSync(temporaryPath, `${JSON.stringify(manifest, null, 2)}\n`, {flag: 'wx'})
    fs.renameSync(temporaryPath, packagePath)
  } finally {
    fs.rmSync(temporaryPath, {force: true})
  }
}

function verify(packagePath, version, cliPath) {
  validateVersion(version)
  const manifest = readPackage(packagePath)
  if (manifest.version !== version) {
    throw new Error(`inconsistent package metadata: expected ${version}, found ${String(manifest.version)}`)
  }

  const outcome = spawnSync(process.execPath, [cliPath, '--version'], {
    encoding: 'utf8',
    timeout: 10_000,
    maxBuffer: 64 * 1024,
  })
  if (outcome.error || outcome.status !== 0) throw new Error('the staged binary does not expose --version')
  const expectedPrefix = `${manifest.name}/${version}`
  const versionIdentity = outcome.stdout.trim().split(/\s+/, 1)[0]
  if (versionIdentity !== expectedPrefix) {
    throw new Error(`inconsistent binary version: expected ${expectedPrefix}, found ${versionIdentity || 'empty'}`)
  }
}

function readManifest(manifestPath, label) {
  const parsed = JSON.parse(fs.readFileSync(manifestPath, 'utf8'))
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed) || !Array.isArray(parsed.releases)) {
    throw new Error(`invalid ${label}`)
  }
  if (parsed.channel !== 'stable' && parsed.channel !== 'beta') throw new Error(`${label} with invalid channel`)
  for (const entry of parsed.releases) {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) throw new Error(`${label} with invalid release`)
    for (const field of ['version', 'channel', 'url', 'sha256']) {
      if (typeof entry[field] !== 'string' || entry[field].length === 0) {
        throw new Error(`${label} with invalid release`)
      }
    }
  }
  return parsed
}

function writeManifest(options, version) {
  const channel = required(options, '--channel')
  if (channel !== 'stable' && channel !== 'beta') throw new Error('invalid manifest channel')
  const url = required(options, '--url')
  const sha256 = required(options, '--sha256')
  const output = required(options, '--output')
  const existingPath = options.get('--existing')
  const previousPath = options.get('--previous')
  if (existingPath && previousPath) throw new Error('--existing and --previous are mutually exclusive')

  const entry = {version, channel, url, sha256}
  if (existingPath) {
    const existing = readManifest(existingPath, 'existing generation')
    const matching = existing.releases.filter((candidate) => candidate.version === version)
    const current = matching[0]
    if (existing.channel !== channel || existing.releases.some((candidate) => candidate.channel !== channel)
      || matching.length !== 1 || current.channel !== channel || current.url !== url || current.sha256 !== sha256) {
      throw new Error('existing generation inconsistent with the current release')
    }
    fs.copyFileSync(existingPath, output)
    return
  }

  const previous = previousPath ? readManifest(previousPath, 'previous manifest') : {channel, releases: []}
  if (previous.channel !== channel || previous.releases.some((candidate) => candidate.channel !== channel)) {
    throw new Error('previous manifest inconsistent with the current channel')
  }
  const releases = previous.releases.filter((candidate) => candidate.version !== version)
  releases.push(entry)
  releases.sort((left, right) => left.version.localeCompare(right.version))
  const temporaryPath = `${output}.release-${process.pid}`
  try {
    fs.writeFileSync(temporaryPath, `${JSON.stringify({channel, releases})}\n`, {flag: 'wx'})
    fs.renameSync(temporaryPath, output)
  } finally {
    fs.rmSync(temporaryPath, {force: true})
  }
}

try {
  const [command, ...argv] = process.argv.slice(2)
  const options = optionsFrom(argv)
  const version = required(options, '--version')

  if (command === 'validate') {
    if (options.size !== 1) throw new Error('invalid validate arguments')
    validateVersion(version)
  } else if (command === 'stamp') {
    if (options.size !== 2) throw new Error('invalid stamp arguments')
    stamp(required(options, '--package'), version)
  } else if (command === 'verify') {
    if (options.size !== 3) throw new Error('invalid verify arguments')
    verify(required(options, '--package'), version, required(options, '--cli'))
  } else if (command === 'manifest') {
    const allowed = new Set(['--version', '--channel', '--url', '--sha256', '--output', '--existing', '--previous'])
    if ([...options.keys()].some((flag) => !allowed.has(flag))) throw new Error('invalid manifest arguments')
    validateVersion(version)
    writeManifest(options, version)
  } else {
    throw new Error('expected command: validate, stamp, verify or manifest')
  }
} catch (error) {
  fail(error instanceof Error ? error.message : String(error))
}
