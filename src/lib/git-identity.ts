/**
 * CYAU-193 — the automator's single git identity: the one of the git commands run by the host
 * (delivery, review) and the one injected into agent sessions. A single place, so host and
 * session cannot diverge.
 */
export const AUTOMATOR_GIT_IDENTITY = {name: 'CloseYourIt Automator', email: 'automator@localhost'} as const

/** The git environment variables the host runs its own commands with. */
export function automatorGitIdentityEnv(): Record<string, string> {
  return {
    GIT_AUTHOR_NAME: AUTOMATOR_GIT_IDENTITY.name,
    GIT_AUTHOR_EMAIL: AUTOMATOR_GIT_IDENTITY.email,
    GIT_COMMITTER_NAME: AUTOMATOR_GIT_IDENTITY.name,
    GIT_COMMITTER_EMAIL: AUTOMATOR_GIT_IDENTITY.email,
  }
}
