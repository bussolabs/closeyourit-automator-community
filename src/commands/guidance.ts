import {Flags} from '@oclif/core'
import {BaseCommand} from '../base'
import {
  assertSafeProject,
  DEFAULT_MAX_UP,
  defaultGuidanceFs,
  defaultKbProbe,
  deriveKbQueries,
  gatherGuidance,
  type GuidanceDeps,
  type GuidancePack,
} from '../lib/guidance'

export default class Guidance extends BaseCommand {
  static description =
    'Prepara il contesto uniforme per gli agenti prima che decidano sul ticket (CYAU-26): raccoglie le convenzioni locali del repository (CLAUDE.md/AGENTS.md, risalendo fino alla git root) e le pagine Knowledge CloseYourIt pertinenti del progetto (via `cyi kb search`, read-only, filtrate per progetto). Compone UN pacchetto markdown identico per Claude e Codex (stessa guidance applicabile), registra le fonti consultate e ricorda di verificare le conclusioni sul codice. La consultazione della Knowledge è best-effort (un blip di rete non blocca): prepara il contesto → exit 0; project-key non valida → exit 2'

  static examples = [
    '<%= config.bin %> guidance --project CYAU --code CYAU-26 --title "Consultare la KB" --cwd /path/al/worktree',
    '<%= config.bin %> guidance --project CYAU --query "command policy" --query "guardrail" --json',
    '<%= config.bin %> guidance --project CYAU --title "..." --technical-analysis "..." --json',
  ]

  static flags = {
    project: Flags.string({description: 'project-key CloseYourIt: scope della ricerca Knowledge (finisce negli argv di cyi kb search)', required: true}),
    code: Flags.string({description: 'codice del ticket (solo per etichettare il pacchetto, es. CYAU-26)'}),
    title: Flags.string({description: 'titolo del ticket: usato per derivare la query di ricerca Knowledge'}),
    'technical-analysis': Flags.string({description: 'analisi tecnica del ticket: ripiego per la query se manca il titolo'}),
    query: Flags.string({description: 'query di ricerca Knowledge esplicita (ripetibile), in aggiunta a quelle derivate dal ticket', multiple: true}),
    cwd: Flags.string({description: 'directory del worktree da cui cercare la guidance locale (default: cwd corrente)', default: '.'}),
    file: Flags.string({description: 'file di guidance locale aggiuntivo oltre a CLAUDE.md/AGENTS.md (ripetibile, nome cercato nella gerarchia)', multiple: true}),
    'max-up': Flags.integer({description: `livelli massimi di risalita cercando la git root (default: ${DEFAULT_MAX_UP})`, default: DEFAULT_MAX_UP}),
  }

  /** Builds the real probes (filesystem + `cyi kb`). Overridable in tests to inject fake probes. */
  protected makeDeps(): GuidanceDeps {
    return {fs: defaultGuidanceFs(), kb: defaultKbProbe()}
  }

  async run(): Promise<unknown> {
    const {flags} = await this.parse(Guidance)

    // Input defence: the project key ends up in the argv of `cyi kb search -p …`. Outside the safe segments →
    // exit 2 BEFORE any search (never a hostile value in the command).
    assertSafeProject(flags.project)

    // The search queries: the explicit ones (--query) plus those derived from the ticket title/analysis. If
    // none → the Knowledge is not queried (local guidance only), noted in the package.
    const queries = [...(flags.query ?? []), ...deriveKbQueries({title: flags.title, technicalAnalysis: flags['technical-analysis']})]

    const pack = gatherGuidance(
      {
        project: flags.project,
        code: flags.code,
        cwd: flags.cwd,
        queries,
        extraFiles: flags.file,
        maxUp: flags['max-up'],
      },
      this.makeDeps(),
    )

    // In human mode prints the package (the markdown is the context ready for the agent); with --json returns the
    // structured payload (markdown + consulted sources) so the orchestrator captures it and passes it to BOTH
    // runtimes — the same guidance for Claude and Codex (DoD).
    if (!this.jsonEnabled()) this.printPack(pack)

    return {
      project: pack.project,
      code: pack.code,
      markdown: pack.markdown,
      sources: pack.sources,
      hasLocal: pack.hasLocal,
      hasKnowledge: pack.hasKnowledge,
      knowledgeAvailable: pack.knowledgeAvailable,
      notes: pack.notes,
    }
  }

  private printPack(pack: GuidancePack): void {
    this.log(pack.markdown)
    this.log('')
    const local = pack.sources.filter((s) => s.origin === 'local').length
    const knowledge = pack.sources.filter((s) => s.origin === 'knowledge').length
    const kbState = pack.knowledgeAvailable ? `${knowledge} pagine` : 'non consultabile'
    this.log(`guidance · progetto ${pack.project} · convenzioni locali: ${local} · Knowledge: ${kbState}`)
  }
}
