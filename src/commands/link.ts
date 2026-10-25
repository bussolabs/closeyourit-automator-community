import * as path from 'node:path'
import {Flags} from '@oclif/core'
import {BaseCommand} from '../base'
import {hasOperationalHostIdentity, loadSecrets, updateSecrets} from '../lib/config'
import {makeClient} from '../lib/client'
import {autoLink, collectRepoTargets, defaultScanFs, readGitHubAliases, scanCheckouts, type AutoLinkResult} from '../lib/discover'
import {AutomatorError, ErrorCodes} from '../errors/error-codes'

export default class Link extends BaseCommand {
  static description =
    'Rileva i checkout locali dai remote Git e collega i progetti CloseYourIt con corrispondenza univoca alla mappa host (idempotente). Ambiguità e repository mancanti restano da risolvere a mano'

  static examples = [
    '<%= config.bin %> link ~/Lavoro/Github',
    '<%= config.bin %> link . --dry-run',
    '<%= config.bin %> link ~/repos --depth 4 --json',
  ]

  // Accepts N root directories to scan (variadic). Without arguments uses the current cwd.
  static strict = false

  static flags = {
    'dry-run': Flags.boolean({description: 'Mostra le corrispondenze senza scrivere la mappa host'}),
    // Scan depth under each root: a repo nested deeper than the limit would (wrongly) show up as
    // "missing" → the user can widen it without guessing.
    depth: Flags.integer({description: 'Profondità massima di scansione sotto ogni root (default 3)', default: 3, min: 1}),
  }

  async run(): Promise<unknown> {
    const {argv, flags} = await this.parse(Link)
    const dryRun = flags['dry-run'] ?? false
    const secrets = loadSecrets()

    // The "GitHub map" (project → repo) comes from the CloseYourIt agents: without sync there is nothing to compare against.
    if (!secrets.sync) {
      throw new AutomatorError(ErrorCodes.Sync.notConfigured, 'Canale API non configurato: manca "sync" nei secret', 2)
    }

    if (!hasOperationalHostIdentity(secrets)) {
      throw new AutomatorError(ErrorCodes.Sync.hostNotConfigured, 'Host non registrato o credenziale host non valida: esegui "automator register"', 2)
    }

    const client = makeClient(secrets.sync, undefined, secrets.host.token)
    const manifest = await client.getWorkspaceManifest()
    if (manifest === null) {
      throw new AutomatorError(ErrorCodes.Sync.fetchFailed, 'Impossibile pescare il manifest dei repository da CloseYourIt', 1)
    }

    const roots = (argv as string[]).map((root) => path.resolve(root))
    const effectiveRoots = roots.length > 0 ? roots : [process.cwd()]
    const checkouts = scanCheckouts(effectiveRoots, defaultScanFs(), flags.depth)
    // SSH alias → github.com (multi-account setup): without it, `git@github-alias:…` remotes would not match.
    const githubHosts = readGitHubAliases()
    const targets = collectRepoTargets(manifest)
    let result = autoLink({targets, checkouts, hosts: secrets.hosts ?? {}, githubHosts})

    let written = false
    if (result.changed && !dryRun) {
      const committed = updateSecrets((current) => {
        // Recompute inside the shared lock: a host rotation or another link published after the initial load
        // is never lost to a stale snapshot.
        result = autoLink({targets, checkouts, hosts: current.hosts ?? {}, githubHosts})
        if (!result.changed) return null
        return {...current, hosts: result.hosts}
      })
      written = committed.updated
    }

    if (!this.jsonEnabled()) this.renderHuman(result, effectiveRoots, dryRun)

    return {
      dryRun,
      roots: effectiveRoots,
      matched: result.matched,
      ambiguous: result.ambiguous,
      missing: result.missing,
      alreadyMapped: result.alreadyMapped,
      changed: written,
    }
  }

  // Human output: the linked matches + clear instructions for ambiguities and missing repositories.
  // The cwds are local to the user (nothing sent to the server): showing them is the information needed to decide.
  private renderHuman(result: AutoLinkResult, roots: string[], dryRun: boolean): void {
    this.log(`Scansione: ${roots.join(', ')}`)
    if (result.matched.length + result.ambiguous.length + result.missing.length + result.alreadyMapped.length === 0) {
      this.log('Nessun progetto con repository GitHub da collegare.')
      return
    }

    for (const m of result.matched) this.log(`  ${dryRun ? 'collegabile' : 'collegato'}: ${m.projectKey} → ${m.cwd} (${m.repo})`)
    for (const a of result.ambiguous) {
      this.log(`  ambiguo: ${a.projectKey} (${a.repo}) → ${a.cwds.length} checkout [${a.cwds.join(', ')}]; scegli quale in hosts.${a.projectKey}.cwd`)
    }

    for (const mi of result.missing) {
      this.log(`  mancante: ${mi.projectKey} (${mi.repo}); clona il repo o imposta hosts.${mi.projectKey}.cwd`)
    }

    for (const key of result.alreadyMapped) this.log(`  già mappato: ${key} (invariato)`)

    if (result.changed && dryRun) this.log('(dry-run) mappa host NON scritta.')
    else if (result.changed) this.log(`Mappa host aggiornata: ${result.matched.length} nuovo/i collegamento/i.`)
  }
}
