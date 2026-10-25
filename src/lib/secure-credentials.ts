import {spawnSync} from 'node:child_process'

import {isClaudeToken, isHostToken, isOpenrouterToken, isUserToken} from './credential-format'
import {type Secrets} from './config'

const HOST_SECRET_SERVICE = 'it.closeyour.automator.host'
const VAULT_SECRET_SERVICE = 'it.closeyour.automator.vault'
const VAULT_SECRET_ACCOUNT = 'service-account'
const CLAUDE_SECRET_SERVICE = 'it.closeyour.automator.claude'
const ORGANIZATION_SECRET_ACCOUNT = 'organization'
const OPENROUTER_SECRET_SERVICE = 'it.closeyour.automator.openrouter'
const SAFE_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,79}$/

export interface SecureCredentialsConfig {
  version: 1
  provider: 'closeyourit-keychain'
  project: string
  environment: string
}

export interface PersistedSecrets {
  heartbeat?: Omit<NonNullable<Secrets['heartbeat']>, 'token'>
  sync?: Omit<NonNullable<Secrets['sync']>, 'orgToken'>
  hosts?: Secrets['hosts']
  host?: {id: string}
  hostFingerprint?: string
  workspaceRoot?: string // non-sensitive local path (like hosts.<KEY>.cwd): survives managed mode
}

export interface CredentialCommandResult {
  status: number
  stdout: string
  stderr: string
}

export interface CredentialCommandOptions {
  input?: string
  env?: NodeJS.ProcessEnv
}

export type CredentialCommand = (
  command: string,
  args: string[],
  options?: CredentialCommandOptions,
) => CredentialCommandResult

const defaultCommand: CredentialCommand = (command, args, options = {}) => {
  const result = spawnSync(command, args, {encoding: 'utf8', input: options.input, env: options.env})
  return {
    status: result.status ?? 1,
    stdout: result.stdout ?? '',
    stderr: result.stderr ?? '',
  }
}

function safeName(value: string): boolean {
  return SAFE_NAME.test(value)
}

export function validSecureCredentialsConfig(value: unknown): value is SecureCredentialsConfig {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false
  const candidate = value as Record<string, unknown>
  return candidate.version === 1 && candidate.provider === 'closeyourit-keychain' &&
    typeof candidate.project === 'string' && safeName(candidate.project) &&
    typeof candidate.environment === 'string' && safeName(candidate.environment) &&
    Object.keys(candidate).every((key) => ['version', 'provider', 'project', 'environment'].includes(key))
}

/** Persistable projection: no value used as a credential reaches the filesystem. */
export function persistableSecrets(secrets: Secrets): PersistedSecrets {
  const heartbeat = secrets.heartbeat
    ? {
        ...(secrets.heartbeat.apiUrl ? {apiUrl: secrets.heartbeat.apiUrl} : {}),
        projectId: secrets.heartbeat.projectId,
        slug: secrets.heartbeat.slug,
        ...(secrets.heartbeat.environment ? {environment: secrets.heartbeat.environment} : {}),
      }
    : undefined
  const sync = secrets.sync
    ? {...(secrets.sync.apiUrl ? {apiUrl: secrets.sync.apiUrl} : {})}
    : undefined
  return {
    ...(heartbeat ? {heartbeat} : {}),
    ...(sync ? {sync} : {}),
    ...(secrets.hosts ? {hosts: structuredClone(secrets.hosts)} : {}),
    ...(secrets.host?.id ? {host: {id: secrets.host.id}} : {}),
    ...(secrets.hostFingerprint ? {hostFingerprint: secrets.hostFingerprint} : {}),
    ...(secrets.workspaceRoot ? {workspaceRoot: secrets.workspaceRoot} : {}),
  }
}

/** Composes only values attested by the device credential store; no secret comes from the vault any more. */
export function composeSecureSecrets(
  persisted: PersistedSecrets,
  hostToken?: string,
  // CYAU-108: service account `cyi_u_` token from the credential store. It enters the secrets IN MEMORY and never
  // goes back to disk (`persistableSecrets` does not know it), exactly like the host token.
  vaultToken?: string,
): Secrets {
  // In managed mode sync no longer carries orgToken: the registration authority is the service account token
  // (cyi_u_) from the credential store; the Claude token is the machine's local auth, not a managed secret.
  const sync = persisted.sync ? {...persisted.sync} : undefined
  const host = persisted.host?.id && hostToken && isHostToken(hostToken)
    ? {id: persisted.host.id, token: hostToken}
    : persisted.host
      ? persisted.host as Secrets['host']
      : undefined
  return {
    ...(persisted.heartbeat ? {heartbeat: structuredClone(persisted.heartbeat)} : {}),
    ...(sync ? {sync} : {}),
    ...(persisted.hosts ? {hosts: structuredClone(persisted.hosts)} : {}),
    ...(host ? {host} : {}),
    ...(persisted.hostFingerprint ? {hostFingerprint: persisted.hostFingerprint} : {}),
    ...(persisted.workspaceRoot ? {workspaceRoot: persisted.workspaceRoot} : {}),
    // Only a valid service token becomes an identity: a malformed value must not authenticate anything.
    ...(isUserToken(vaultToken) ? {cyiToken: vaultToken} : {}),
  }
}

function saveCredential(
  service: string,
  account: string,
  token: string,
  command: CredentialCommand,
): boolean {
  if (!safeName(account)) return false
  const result = command('/usr/bin/secret-tool', [
    'store', '--label', 'CloseYourIt Automator', 'service', service, 'account', account,
  ], {input: `${token}\n`})
  return result.status === 0
}

function loadCredential(
  service: string,
  account: string,
  command: CredentialCommand,
): string | undefined {
  if (!safeName(account)) return undefined
  const result = command('/usr/bin/secret-tool', ['lookup', 'service', service, 'account', account])
  if (result.status !== 0) return undefined
  return result.stdout.trim()
}

function clearCredential(
  service: string,
  account: string,
  command: CredentialCommand,
): boolean {
  if (!safeName(account)) return false
  return command('/usr/bin/secret-tool', ['clear', 'service', service, 'account', account]).status === 0
}

export function saveHostCredential(
  hostId: string,
  token: string,
  command: CredentialCommand = defaultCommand,
): boolean {
  return isHostToken(token) && saveCredential(HOST_SECRET_SERVICE, hostId, token, command)
}

export function loadHostCredential(
  hostId: string,
  command: CredentialCommand = defaultCommand,
): string | undefined {
  const token = loadCredential(HOST_SECRET_SERVICE, hostId, command)
  return isHostToken(token) ? token : undefined
}

export function saveVaultCredential(
  token: string,
  command: CredentialCommand = defaultCommand,
): boolean {
  return isUserToken(token) && saveCredential(VAULT_SECRET_SERVICE, VAULT_SECRET_ACCOUNT, token, command)
}

export function loadVaultCredential(
  command: CredentialCommand = defaultCommand,
): string | undefined {
  const token = loadCredential(VAULT_SECRET_SERVICE, VAULT_SECRET_ACCOUNT, command)
  return isUserToken(token) ? token : undefined
}

/** CYAU-224: the organization's Claude credential, kept like the host token so a restart works offline. */
export function saveClaudeCredential(
  token: string,
  command: CredentialCommand = defaultCommand,
): boolean {
  return isClaudeToken(token) && saveCredential(CLAUDE_SECRET_SERVICE, ORGANIZATION_SECRET_ACCOUNT, token, command)
}

export function loadClaudeCredential(
  command: CredentialCommand = defaultCommand,
): string | undefined {
  const token = loadCredential(CLAUDE_SECRET_SERVICE, ORGANIZATION_SECRET_ACCOUNT, command)
  return isClaudeToken(token) ? token : undefined
}

export function clearClaudeCredential(
  command: CredentialCommand = defaultCommand,
): boolean {
  return clearCredential(CLAUDE_SECRET_SERVICE, ORGANIZATION_SECRET_ACCOUNT, command)
}

/** CYAU-228: the organization's OpenRouter key, kept like the Claude credential. */
export function saveOpenrouterCredential(
  token: string,
  command: CredentialCommand = defaultCommand,
): boolean {
  return isOpenrouterToken(token) && saveCredential(OPENROUTER_SECRET_SERVICE, ORGANIZATION_SECRET_ACCOUNT, token, command)
}

export function loadOpenrouterCredential(
  command: CredentialCommand = defaultCommand,
): string | undefined {
  const token = loadCredential(OPENROUTER_SECRET_SERVICE, ORGANIZATION_SECRET_ACCOUNT, command)
  return isOpenrouterToken(token) ? token : undefined
}

export function clearOpenrouterCredential(
  command: CredentialCommand = defaultCommand,
): boolean {
  return clearCredential(OPENROUTER_SECRET_SERVICE, ORGANIZATION_SECRET_ACCOUNT, command)
}
