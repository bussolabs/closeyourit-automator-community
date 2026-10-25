#!/bin/sh
# First-contact bootstrap for closeyourit-automator: installs the Node chain,
# a VERIFIED stable release of the Automator, cyi and Claude Code on Linux.
# It is the ONLY piece that runs without Node (solves the chicken-and-egg of `automator setup`).
# Idempotent: skips what is already present.
#   Usage:  sh bin/bootstrap.sh    (or  curl -fsSL <url>/bootstrap.sh | sh)
set -eu
# Everything installed here must not be group-writable: the review runs only trusted executables (CYRA-878).
umask 022

NODE_VERSION="24.11.0"
PNPM_VERSION="11.28.5"
GH_VERSION="2.102.0"
AUTOMATOR_RELEASE_API="https://api.github.com/repos/bussolabs/closeyourit-automator-community/releases/tags/automator-channels"
AUTOMATOR_INSTALL_ROOT="${AUTOMATOR_INSTALL_ROOT:-$HOME/.local/lib/closeyourit-automator}"

have() { command -v "$1" >/dev/null 2>&1; }
log() { printf '→ %s\n' "$1"; }

if [ "$(uname -s)" != "Linux" ]; then
  printf '%s\n' 'bootstrap: Automator supporta esclusivamente Linux' >&2
  exit 2
fi

# 1) mise (runtime manager) — installs into ~/.local/bin
if have mise; then
  log "mise già presente ($(mise --version 2>/dev/null || echo '?'))"
else
  log "installo mise…"
  curl https://mise.run | sh
fi
# mise + shims in the PATH of this session (the service unit receives a separate explicit PATH)
export PATH="$HOME/.local/bin:$HOME/.local/share/mise/shims:$PATH"

# 2) node + pnpm via mise (idempotent)
log "installo node@$NODE_VERSION + pnpm@$PNPM_VERSION via mise…"
mise use -g "node@$NODE_VERSION" "npm:pnpm@$PNPM_VERSION"
export PATH="$HOME/.local/share/mise/shims:$PATH"

# 3) GitHub CLI: the Automator repository is private. `mise use` is idempotent
# but always runs: an arbitrary gh already in the PATH cannot evade the pin.
log "assicuro GitHub CLI gh@$GH_VERSION via mise…"
mise use -g "github:cli/cli@$GH_VERSION"
if ! gh auth status --active --hostname github.com >/dev/null 2>&1; then
  log "autenticazione GitHub richiesta per il repository privato Automator…"
  gh auth login --hostname github.com --git-protocol https --web
fi
if ! gh auth status --active --hostname github.com >/dev/null 2>&1; then
  printf '%s\n' 'bootstrap: autenticazione GitHub non disponibile' >&2
  exit 1
fi

# 4) Automator: discovers the latest append-only stable generation, verifies SHA-256
# before extracting, then delegates the atomic installation to the updater of the candidate
# release. Private manifest and artifact go only through the gh session.
log "installo/aggiorno Automator dalla release stable verificata…"
bootstrap_tmp="$(mktemp -d "${TMPDIR:-/tmp}/closeyourit-automator-bootstrap.XXXXXX")"
cleanup_bootstrap() { rm -rf "$bootstrap_tmp"; }
trap cleanup_bootstrap EXIT HUP INT TERM

# Prevents inherited runtime options from changing the verified Node code or the
# updater subprocesses. The code neither reads nor writes secrets in the repository;
# only `gh` consults its own external credential store for the private requests.
unset NODE_OPTIONS NODE_PATH BASH_ENV ENV ZDOTDIR CDPATH 2>/dev/null || true
export AUTOMATOR_BOOTSTRAP_TMP="$bootstrap_tmp"
export AUTOMATOR_RELEASE_API AUTOMATOR_INSTALL_ROOT

node <<'AUTOMATOR_BOOTSTRAP_NODE'
'use strict'

const {createHash, randomUUID} = require('node:crypto')
const {spawnSync} = require('node:child_process')
const fs = require('node:fs')
const path = require('node:path')
const {pathToFileURL} = require('node:url')

const api = process.env.AUTOMATOR_RELEASE_API
const installRoot = path.resolve(process.env.AUTOMATOR_INSTALL_ROOT)
const temporaryRoot = path.resolve(process.env.AUTOMATOR_BOOTSTRAP_TMP)
const channel = 'stable'
const repository = 'bussolabs/closeyourit-automator-community'
const expectedApi = `https://api.github.com/repos/${repository}/releases/tags/automator-channels`
const semverPattern = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/
const checksumPattern = /^[a-f0-9]{64}$/

function fail(message) {
  process.stderr.write(`bootstrap Automator: ${message}\n`)
  process.exit(1)
}

function command(command, args, label, options = {}) {
  const result = spawnSync(command, args, {
    encoding: options.encoding ?? 'utf8',
    env: process.env,
    maxBuffer: 16 * 1024 * 1024,
  })
  if (result.error || result.status !== 0) {
    const detail = result.error?.message ?? String(result.stderr || result.stdout || `exit ${result.status}`).trim()
    fail(`${label} fallito: ${detail}`)
  }
  return result.stdout
}

function json(raw, label) {
  try {
    return JSON.parse(raw)
  } catch {
    fail(`${label}: JSON non valido`)
  }
}

function ghJson(url, label, binary = false) {
  const headers = ['-H', binary ? 'Accept: application/octet-stream' : 'Accept: application/vnd.github+json']
  return json(command('gh', ['api', ...headers, url], label), label)
}

function validSemver(value) {
  const match = typeof value === 'string' ? semverPattern.exec(value) : null
  if (!match) return null
  const parts = match.slice(1).map(Number)
  return parts.every(Number.isSafeInteger) ? parts : null
}

function compareSemver(a, b) {
  for (let index = 0; index < 3; index += 1) {
    if (a[index] !== b[index]) return a[index] - b[index]
  }
  return 0
}

function assertSafeLauncher(launcher, expectedTarget) {
  let stat
  try {
    stat = fs.lstatSync(launcher)
  } catch (error) {
    if (error.code === 'ENOENT') return false
    throw error
  }
  if (!stat.isSymbolicLink() || path.resolve(path.dirname(launcher), fs.readlinkSync(launcher)) !== expectedTarget) {
    fail(`launcher automator esistente e non gestito: ${launcher}`)
  }
  return true
}

if (api !== expectedApi) fail('endpoint release non autorizzato')
const launcher = path.join(process.env.HOME, '.local', 'bin', 'automator')
const launcherTarget = path.join(installRoot, 'current', 'bin', 'run.js')
const launcherPresent = assertSafeLauncher(launcher, launcherTarget)

const metadata = ghJson(api, 'metadata release stable')
if (!metadata || Array.isArray(metadata) || typeof metadata !== 'object') fail('metadata release stable non validi')
const assetsUrl = metadata.assets_url
const assetsPattern = /^https:\/\/api\.github\.com\/repos\/bussolabs\/closeyourit-automator-community\/releases\/[1-9]\d*\/assets$/
if (typeof assetsUrl !== 'string' || !assetsPattern.test(assetsUrl)) fail('assets_url della release non autorizzato')

let selectedAsset = null
for (let page = 1; ; page += 1) {
  const assets = ghJson(`${assetsUrl}?per_page=100&page=${page}`, `pagina asset ${page}`)
  if (!Array.isArray(assets)) fail(`pagina asset ${page} non valida`)
  for (const asset of assets) {
    if (!asset || Array.isArray(asset) || typeof asset !== 'object') continue
    if (!Number.isSafeInteger(asset.id) || asset.id <= 0 || typeof asset.created_at !== 'string' ||
      typeof asset.name !== 'string' || typeof asset.url !== 'string') continue
    const match = /^stable-(.+)\.json$/.exec(asset.name)
    const assetVersion = match ? validSemver(match[1]) : null
    const createdAt = Date.parse(asset.created_at)
    const assetUrlPattern = /^https:\/\/api\.github\.com\/repos\/bussolabs\/closeyourit-automator-community\/releases\/assets\/[1-9]\d*$/
    if (!assetVersion || !Number.isFinite(createdAt) || !assetUrlPattern.test(asset.url)) continue
    if (!selectedAsset || createdAt > selectedAsset.createdAt ||
      (createdAt === selectedAsset.createdAt && asset.id > selectedAsset.id)) {
      selectedAsset = {createdAt, id: asset.id, url: asset.url}
    }
  }
  if (assets.length < 100) break
  if (page >= 1000) fail('troppe pagine asset')
}
if (!selectedAsset) fail('nessuna generazione manifest stable valida')

const manifest = ghJson(selectedAsset.url, 'manifest stable', true)
if (!manifest || Array.isArray(manifest) || typeof manifest !== 'object' || manifest.channel !== channel ||
  !Array.isArray(manifest.releases) || manifest.releases.length === 0) fail('manifest stable non valido')
const allowedEntryKeys = new Set(['version', 'channel', 'url', 'sha256', 'minServer', 'maxServer', 'notes'])
const seenVersions = new Set()
let selectedRelease = null
for (const entry of manifest.releases) {
  if (!entry || Array.isArray(entry) || typeof entry !== 'object' ||
    Object.keys(entry).some((key) => !allowedEntryKeys.has(key))) fail('entry manifest stable non valida')
  const parsedVersion = validSemver(entry.version)
  if (!parsedVersion || entry.channel !== channel || typeof entry.url !== 'string' ||
    typeof entry.sha256 !== 'string' || !checksumPattern.test(entry.sha256.toLowerCase()) ||
    (entry.notes !== undefined && typeof entry.notes !== 'string') ||
    (entry.minServer !== undefined && !validSemver(entry.minServer)) ||
    (entry.maxServer !== undefined && !validSemver(entry.maxServer)) || seenVersions.has(entry.version)) {
    fail('entry manifest stable non valida')
  }
  seenVersions.add(entry.version)
  const expectedArtifact = `https://github.com/${repository}/releases/download/v${entry.version}/automator-${entry.version}.tgz`
  if (entry.url !== expectedArtifact) fail(`URL artifact non autorizzato per ${entry.version}`)
  // Without a server version the bootstrap can choose only unconstrained releases.
  if (entry.minServer !== undefined || entry.maxServer !== undefined) continue
  if (!selectedRelease || compareSemver(parsedVersion, selectedRelease.parsedVersion) > 0) {
    selectedRelease = {...entry, sha256: entry.sha256.toLowerCase(), parsedVersion}
  }
}
if (!selectedRelease) fail('nessuna release stable compatibile senza versione server')

const archive = path.join(temporaryRoot, `automator-${selectedRelease.version}.tgz`)
command('gh', [
  'release', 'download', `v${selectedRelease.version}`,
  '--repo', repository,
  '--pattern', `automator-${selectedRelease.version}.tgz`,
  '--output', archive,
], 'download artifact privato')
const actualChecksum = createHash('sha256').update(fs.readFileSync(archive)).digest('hex')
if (actualChecksum !== selectedRelease.sha256) fail('checksum SHA-256 artifact non corrispondente')

const archiveRoot = `automator-${selectedRelease.version}`
const listing = command('tar', ['-tzf', archive], 'ispezione artifact').split('\n').filter(Boolean)
if (listing.length === 0 || !listing.includes(`${archiveRoot}/package.json`) || !listing.includes(`${archiveRoot}/bin/run.js`) ||
  listing.some((entry) => entry !== archiveRoot && !entry.startsWith(`${archiveRoot}/`)) ||
  listing.some((entry) => entry.startsWith('/') || entry.split('/').includes('..'))) {
  fail('layout artifact non sicuro')
}
// `tar -t` alone does not describe the type and target of links. We pair the verbose
// listing in the same order and reject devices/FIFOs or links that would escape
// the single root of the archive, before tar can extract them.
const verboseListing = command('tar', ['-tvzf', archive], 'ispezione tipi artifact').split('\n').filter(Boolean)
if (verboseListing.length !== listing.length) fail('indice tipi artifact ambiguo')
for (let index = 0; index < listing.length; index += 1) {
  const member = listing[index]
  const detail = verboseListing[index]
  const type = detail[0]
  if (!['-', 'd', 'l', 'h'].includes(type)) fail(`tipo artifact non sicuro: ${member}`)
  if (type !== 'l' && type !== 'h') continue
  const marker = type === 'l' ? ' -> ' : ' link to '
  const markerAt = detail.lastIndexOf(marker)
  if (markerAt < 0) fail(`target link artifact non leggibile: ${member}`)
  const target = detail.slice(markerAt + marker.length)
  if (target.length === 0 || path.posix.isAbsolute(target)) fail(`target link artifact non sicuro: ${member}`)
  const resolvedTarget = path.posix.normalize(path.posix.join(path.posix.dirname(member), target))
  if (resolvedTarget !== archiveRoot && !resolvedTarget.startsWith(`${archiveRoot}/`)) {
    fail(`target link artifact fuori root: ${member}`)
  }
}
const candidate = path.join(temporaryRoot, 'candidate')
fs.mkdirSync(candidate, {mode: 0o700})
command('tar', ['-xzf', archive, '-C', candidate, '--strip-components=1'], 'estrazione artifact')
const candidateReal = fs.realpathSync(candidate)
const pending = [candidate]
while (pending.length > 0) {
  const current = pending.pop()
  for (const entry of fs.readdirSync(current, {withFileTypes: true})) {
    const entryPath = path.join(current, entry.name)
    const stat = fs.lstatSync(entryPath)
    if (stat.isSymbolicLink()) {
      const link = fs.readlinkSync(entryPath)
      if (path.isAbsolute(link)) fail(`symlink candidate assoluto: ${entryPath}`)
      let real
      try {
        real = fs.realpathSync(entryPath)
      } catch {
        fail(`symlink candidate non risolvibile: ${entryPath}`)
      }
      if (real !== candidateReal && !real.startsWith(`${candidateReal}${path.sep}`)) {
        fail(`symlink candidate fuori confinement: ${entryPath}`)
      }
      continue
    }
    if (stat.isDirectory()) pending.push(entryPath)
    else if (!stat.isFile()) fail(`tipo candidate non sicuro: ${entryPath}`)
  }
}
const packageFile = path.join(candidate, 'package.json')
const candidateEntrypoint = path.join(candidate, 'bin', 'run.js')
for (const file of [packageFile, candidateEntrypoint]) {
  const stat = fs.lstatSync(file)
  const real = fs.realpathSync(file)
  if (!stat.isFile() || stat.isSymbolicLink() || (real !== candidateReal && !real.startsWith(`${candidateReal}${path.sep}`))) {
    fail('candidate artifact fuori confinement')
  }
}
const packageMetadata = json(fs.readFileSync(packageFile, 'utf8'), 'package candidate')
if (packageMetadata.name !== '@bussolabs/closeyourit-automator' || packageMetadata.version !== selectedRelease.version) {
  fail('identità package candidate non valida')
}
const expectedVersionPrefix = `@bussolabs/closeyourit-automator/${selectedRelease.version}`
const candidateVersion = command(process.execPath, [candidateEntrypoint, '--version'], 'preflight candidate').trim().split(/\s+/)
if (candidateVersion.length < 2 || candidateVersion[0] !== expectedVersionPrefix) fail('versione candidate non attestabile')

const localManifest = path.join(temporaryRoot, 'manifest')
fs.mkdirSync(localManifest, {mode: 0o700})
fs.writeFileSync(path.join(localManifest, 'stable.json'), `${JSON.stringify({
  channel,
  releases: [{
    version: selectedRelease.version,
    channel,
    url: pathToFileURL(archive).href,
    sha256: selectedRelease.sha256,
  }],
})}\n`, {mode: 0o600})
command(process.execPath, [
  candidateEntrypoint,
  'update',
  '--install-root', installRoot,
  '--manifest-url', pathToFileURL(localManifest).href.replace(/\/$/, ''),
  '--target-version', selectedRelease.version,
], 'installazione atomica Automator')

const expectedRelease = path.join(installRoot, 'releases', selectedRelease.version)
let activeRelease
try {
  activeRelease = fs.realpathSync(path.join(installRoot, 'current'))
} catch {
  fail('release Automator attiva non verificabile')
}
if (activeRelease !== fs.realpathSync(expectedRelease)) fail('release Automator attiva inattesa')
const installedEntrypoint = path.join(activeRelease, 'bin', 'run.js')
const installedVersion = command(process.execPath, [installedEntrypoint, '--version'], 'verifica Automator installato').trim().split(/\s+/)
if (installedVersion.length < 2 || installedVersion[0] !== expectedVersionPrefix) fail('Automator installato non attestabile')
command(process.execPath, [installedEntrypoint, 'setup', '--help'], 'verifica comando automator setup')
command(process.execPath, [installedEntrypoint, 'doctor', '--help'], 'verifica comando automator doctor')

fs.mkdirSync(path.dirname(launcher), {recursive: true, mode: 0o755})
if (launcherPresent) {
  // Closes the window between the initial preflight and the final publication.
  assertSafeLauncher(launcher, launcherTarget)
} else {
  try {
    fs.symlinkSync(launcherTarget, launcher)
  } catch (error) {
    if (error.code !== 'EEXIST') throw error
    assertSafeLauncher(launcher, launcherTarget)
  }
}
process.stdout.write(`Automator ${selectedRelease.version} verificato e disponibile: ${launcher}\n`)
AUTOMATOR_BOOTSTRAP_NODE

# 5) cyi (closeyourit-cli) via global npm
if have cyi; then
  log "cyi già presente ($(cyi --version 2>/dev/null || echo '?'))"
else
  log "installo @bussolabs/closeyourit-cli…"
  npm install -g @bussolabs/closeyourit-cli
fi

# 6) Claude Code (native installer → ~/.local/bin/claude)
if have claude; then
  log "claude già presente ($(claude --version 2>/dev/null || echo '?'))"
else
  log "installo Claude Code…"
  curl -fsSL https://claude.ai/install.sh | bash
fi

log "bootstrap completato."
log "Per rendere il PATH persistente nelle nuove shell, aggiungi al profilo:"
# shellcheck disable=SC2016 # it must print the variables, not expand them in the child shell.
log '  export PATH="$HOME/.local/bin:$HOME/.local/share/mise/shims:$PATH"'
log "Prossimi passi:"
log "  1) automator setup        # completa i tool richiesti"
log "  2) claude login           # auth Claude LOCALE della macchina; l'automator non la custodisce"
log "  3) crea un service account con lo scope di ambienti scelto (mai production) e conia il token reveal-once cyi_u_"
log "  4) passa temporaneamente il token come CLOSEYOURIT_TOKEN ad automator install --managed  # si auto-registra col SA token"
log "  5) automator doctor       # verifica finale (host registrato + claude autenticato per il servizio)"
