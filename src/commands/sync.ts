import * as fs from 'node:fs'
import {Flags} from '@oclif/core'
import {stringify} from 'yaml'
import {BaseCommand} from '../base'
import {hasOperationalHostIdentity, loadSecrets} from '../lib/config'
import {detectPlatform, type OsPlatform} from '../lib/service'
import {materialize, pullManifestWithRecovery} from '../lib/sync'
import {AutomatorError, ErrorCodes} from '../errors/error-codes'

export default class Sync extends BaseCommand {
  static description = 'Pesca gli agenti da CloseYourIt e materializza il playbook generato (ispezione/force)'

  static examples = ['<%= config.bin %> sync', '<%= config.bin %> sync --out ./playbook.generated.yml --json']

  static flags = {
    out: Flags.string({description: 'Scrivi il playbook generato su questo path'}),
  }

  /** Test seam: the real CLI accepts only a platform detected as Linux. */
  protected currentPlatform(): OsPlatform {
    return detectPlatform()
  }

  async run(): Promise<unknown> {
    const {flags} = await this.parse(Sync)
    const secrets = loadSecrets()

    if (!secrets.sync) {
      throw new AutomatorError(ErrorCodes.Sync.notConfigured, 'Canale API non configurato: manca "sync" nei secret', 2)
    }

    if (!hasOperationalHostIdentity(secrets)) {
      throw new AutomatorError(ErrorCodes.Sync.hostNotConfigured, 'Host non registrato o credenziale host non valida: esegui "automator register"', 2)
    }

    const pulled = await pullManifestWithRecovery(secrets, (message: string) => {
      if (!this.jsonEnabled()) this.log(message)
    }, undefined, this.config.version, this.currentPlatform())
    if (pulled.outcome !== 'ok') {
      throw new AutomatorError(ErrorCodes.Sync.fetchFailed, 'Impossibile pescare il manifest dei repository da CloseYourIt', 1)
    }
    const manifest = pulled.value

    const {actions, skipped} = materialize(manifest, secrets.hosts ?? {})
    const doc = {version: 1, actions}

    if (flags.out) {
      fs.writeFileSync(flags.out, `${stringify(doc)}`)
    }

    const names = Object.keys(actions)
    if (!this.jsonEnabled()) {
      this.log(`Repository nel manifest: ${manifest.repositories.length} · code servite: ${names.length}${names.length ? ` (${names.join(', ')})` : ''}`)
      for (const s of skipped) {
        this.log(s.reason === 'project-key-missing'
          ? '  skip: voce del manifest senza project-key'
          : `  skip: progetto "${s.projectKey}" non nella mappa host`)
      }
      if (flags.out) this.log(`Scritto: ${flags.out}`)
    }

    return {repositories: manifest.repositories.length, actions: names, skipped, out: flags.out ?? null}
  }
}
