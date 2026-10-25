import * as fs from 'node:fs'
import * as path from 'node:path'
import {Args, Flags} from '@oclif/core'
import {BaseCommand} from '../base'
import {logsDir} from '../lib/paths'
import {renderTable} from '../lib/output'

export default class Logs extends BaseCommand {
  static description = "Mostra l'ultimo log di un'azione, o elenca i log recenti"

  static examples = ['<%= config.bin %> logs', '<%= config.bin %> logs triage --lines 100']

  static args = {
    action: Args.string({description: "Nome azione: mostra il suo ultimo log (altrimenti elenca tutto)"}),
  }

  static flags = {
    lines: Flags.integer({char: 'n', description: 'Righe finali da mostrare', default: 40}),
  }

  async run(): Promise<unknown> {
    const {args, flags} = await this.parse(Logs)
    const dir = logsDir()
    const files = fs.existsSync(dir) ? fs.readdirSync(dir).filter((name) => name.endsWith('.log')) : []

    if (args.action) {
      const matches = files.filter((name) => name.startsWith(`${args.action}-`)).sort().reverse()
      if (matches.length === 0) {
        if (!this.jsonEnabled()) this.log(`(nessun log per ${args.action})`)
        return {action: args.action, file: null, content: ''}
      }
      const file = matches[0]
      const content = fs.readFileSync(path.join(dir, file), 'utf8')
      const tail = content.split('\n').slice(-flags.lines).join('\n')
      if (!this.jsonEnabled()) this.log(tail)
      return {action: args.action, file, content: tail}
    }

    const rows = files
      .map((name) => {
        const stat = fs.statSync(path.join(dir, name))
        return {name, size: stat.size, mtime: stat.mtime.toISOString()}
      })
      .sort((a, b) => (a.mtime < b.mtime ? 1 : -1))
      .slice(0, 30)

    if (!this.jsonEnabled()) {
      this.log(renderTable(['FILE', 'BYTE', 'MTIME'], rows.map((r) => [r.name, String(r.size), r.mtime])))
    }

    return {dir, logs: rows}
  }
}
