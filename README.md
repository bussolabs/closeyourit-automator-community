# closeyourit-automator

Scheduler **esclusivamente Linux** che esegue **azioni** — sessioni **Claude Code headless**
(`claude -p`, che possono invocare skill/subagenti) o **comandi shell/`cyi`** — a intervalli definiti
in un **playbook YAML**. Gira come **servizio systemd utente persistente** e fa
**heartbeat** a CloseYourIt, così l'app stessa allerta se l'automator smette di girare.

Casi d'uso tipici: triage ticket, report/digest periodici, audit/manutenzione dei repo, watchdog.

## Requisiti di sistema

- Linux `x86_64` o `arm64`, cgroup v2 e systemd `>=254` con user manager raggiungibile.
- `bubblewrap` (`bwrap`) funzionante per il confinamento delle scritture e `socat`: senza, la sandbox di Claude Code
  rifiuta di partire (`sandbox required but unavailable: ... socat not installed`) e la prova reale fallisce con `claude: exit 1`.
- D-Bus utente e Secret Service sbloccato, accessibile con `/usr/bin/secret-tool`, con la raccolta `login` già creata:
  su un server senza desktop non esiste e `install --managed` fallisce con `credential store vault non disponibile`
  (procedura nella guida pubblica, sezione Ubuntu).
- Node.js `>=20`; il bootstrap installa la toolchain verificata con `mise`.
- `claude` e `codex` (`>=0.156.1`) installati e autenticati. Codex serve anche su una macchina che rilegge con
  Claude: la rilettura di Claude gira dentro la sandbox di Codex (CYAU-222). Va installato in un percorso fidato
  (`/usr/local/bin`, `~/.local/bin`, un install di `mise`), non con `sudo npm -g` in `/usr/lib`, e senza permessi di
  scrittura per gruppo o altri: `doctor` lo controlla con la stessa risoluzione usata dalla rilettura. Il modello è fissato in `src/lib/models.ts`:
  Claude Opus 5.5 e GPT-6 Astra per ogni sessione, lavoro e rilettura, salvo un `model` esplicito nel playbook.
  Le versioni delle due CLI sono fissate nello stesso file: `update` le installa, le prova con una richiesta
  vera e, se la prova fallisce, rimette quelle di prima e lascia l'avviso sul pannello.

`bootstrap`, `install`, `doctor`, daemon e registrazione host falliscono chiuso su qualunque altro sistema.
Per ritirare una vecchia installazione Apple, segui la [procedura di dismissione](docs/decommission-macos-host.md).

## Come funziona

- Un **daemon** self-scheduling (`automator daemon`) gira in loop: ogni ~60s ricarica il playbook,
  valuta quali azioni sono "due" e le esegue in sequenza. systemd lo tiene vivo (`Restart=always`).
- Lo **stato** (ultima esecuzione per azione) vive fuori dal repo in `~/.local/state/closeyourit-automator/`;
  i **log per-azione** in `.../logs/`.
- Gli **orari cron sono in UTC** (prevedibile sui server).

## Setup

### 1. Bootstrap delle CLI (macchina nuova)

Installa la catena Node, una release stable verificata dell'Automator e Claude Code (idempotente):

```sh
sh bin/bootstrap.sh
```

Installa: `mise` → `node`/`pnpm` e `gh` (pinnati) → login GitHub nel credential store di sistema → Automator
stable privato (artifact GitHub con SHA-256 verificato) → `cyi` (`@bussolabs/closeyourit-cli`) → `claude`.
Il launcher `automator` viene creato in `~/.local/bin`;
lo script stampa anche l'istruzione esatta per rendere persistente il PATH nelle nuove shell.
Poi, per completare i tool richiesti e quelli opzionali:

```sh
automator setup --optional     # o: node bin/run.js setup --optional
automator doctor               # verifica finale
```

### 2. Build

```sh
mise exec -- pnpm install
mise exec -- pnpm build
```

### 3. Credenziali del dispositivo (una per macchina)

Una macchina ha **una sola identità**: il suo **service account** CloseYourIt. Crea il service account con lo scope
di ambienti che decidi tu — `development`/`staging`/`preview`, **mai `production`** — e conia il suo token `cyi_u_…`
reveal-once. È l'operazione sensibile: eseguila dalla CLI o dalla UI CloseYourIt; non incollare mai il valore in file
o nella chat. Il minion non può ampliarsi da solo lo scope.

L'auth di **Claude** ha due strade:

- **Credenziale dell'organizzazione** (consigliata): il proprietario la imposta una volta in CloseYourIt →
  Agenti → Credenziale Claude (chiave API Console o token `claude setup-token`). Ogni macchina **certificata** la
  scarica col proprio token host all'avvio e poi ogni cinque battiti circa, la tiene nel Secret Service e la passa
  **solo** alle sessioni Claude e alla review Claude (come `ANTHROPIC_API_KEY` o `CLAUDE_CODE_OAUTH_TOKEN`), mai a
  shell, Codex, log o consegne. Rimossa nell'app, la macchina la cancella e torna all'auth locale. Una macchina
  compromessa obbliga a ruotarla per tutte.
- **Auth locale**, usata quando l'organizzazione non ne imposta una: `claude login` come lo stesso utente che avvia
  il servizio (sessione ritrovata via `HOME`), oppure `ANTHROPIC_API_KEY` **durevole nell'ambiente del servizio** —
  un `export` nella sola shell d'installazione non raggiunge il daemon systemd.

La review Claude confinata gira con una home vuota e sceglie l'accesso nello stesso ordine (CYAU-223): credenziale
dell'organizzazione, poi un token Claude nell'ambiente del servizio, poi la sessione di `claude login`. Di
quest'ultima legge da `$CLAUDE_CONFIG_DIR/.credentials.json` (di default `~/.claude/.credentials.json`) **solo**
il token di accesso di breve durata e lo passa come `CLAUDE_CODE_OAUTH_TOKEN`: il token di rinnovo non entra mai
nella sandbox e il file non viene riscritto, così a rinnovare la sessione resta solo la macchina. `automator doctor`
fallisce quando Claude è installato e la sua review non ha un accesso valido, con o senza Codex: se dice che manca,
esegui `claude login` come l'utente del servizio; se dice che è **scaduto**, avvia `claude` una volta con
quell'utente (o rifai `claude login`) per rinnovarlo. In alternativa il proprietario imposta la credenziale
dell'organizzazione. Una review con l'accesso mancante o scaduto non parte e ne dice il motivo.

**OpenCode** (CYAU-228) solo **rilegge**, mai lavora, e solo quando CloseYourIt lo sceglie come revisore della
macchina. Usa il modello OpenRouter scelto nella pagina Automator e la **chiave OpenRouter dell'organizzazione**
(Agenti → Chiave OpenRouter, solo il proprietario): la macchina la scarica come la credenziale Claude, la tiene nel
Secret Service e la passa **solo** alla rilettura di OpenCode. La rilettura gira nella sandbox di Codex: nessuno
strumento, scrittura solo in una cartella temporanea, rete solo verso `openrouter.ai`, modifiche su stdin e mai
negli argomenti. OpenCode non sa obbligare il formato della risposta: un testo che non è il report atteso fa
fallire la rilettura. Si installa con `automator setup --optional` (`npm install -g opencode-ai`); senza OpenCode,
modello o chiave, una macchina che rilegge con OpenCode non prende lavoro.

Durante `automator install --managed`, il token service account viene letto soltanto da `CLOSEYOURIT_TOKEN` e
trasferito nel Secret Service Linux; la macchina si **auto-registra** presentando quel token
(`POST /api/v1/hosts`). La registrazione trasferisce nello stesso store anche il token **Agent Host** `cyi_ah_…`
(revocabile, per coda/lease/heartbeat); non va confuso col token **Server Host** `cyi_h_…`. Revocare il service
account uccide entrambi. `~/.config/closeyourit-automator/secrets.json` conserva per retrocompatibilità il nome
storico, ma in modalità managed contiene solo host-map, URL, fingerprint e altri dati non sensibili. Nessun token
finisce nel file, nell'unit del servizio, negli argomenti dei processi o nei log.

Il **battito** si configura da solo (CYAU-220): dopo la registrazione, e a ogni avvio del servizio se manca, la
macchina risolve il progetto di `--secrets-project` col token service account (`GET /cli/v1/projects`, come `cyi`)
e scrive in `secrets.json` la sezione `heartbeat` — URL, id del progetto e monitor `automator-<host_id>`, ambiente
predefinito `production`, nessun token. Una sezione già presente non viene mai riscritta: il server lega la macchina
al primo progetto da cui riceve il battito. Se il progetto non è visibile al service account o il server non risponde
entro 15 secondi, il servizio parte comunque, scrive nel registro `heartbeat: not configured — <motivo>` e ritenta al
prossimo avvio; lo stesso avviso compare in `automator tick`.

### 4. Playbook

Parti da `playbook.example.yml`. Ogni azione ha `schedule` + `type` (`claude`|`codex`|`shell`) + `run`.
La `cwd` di un playbook locale deve essere relativa, senza `..`, e risolvere alla root di un repository/worktree Git:

```yaml
version: 1
defaults:
  cwd: .
actions:
  triage:
    schedule: "every 15m"          # cron "0 8 * * *" | "every 15m" | "every day at 8am"
    type: claude
    run: "/closeyourit-ticket triaggia i ticket aperti"
    permission_mode: acceptEdits   # plan (read-only) | acceptEdits | ... (MAI bypassPermissions schedulato)
    allowed_tools: [Read, Grep, Edit, Write]
    containment: process-group  # default per azioni generiche; `strong` richiede systemd/cgroup v2 verificabile
```

Per un worker che deve iniziare uno specifico ticket, dichiara il target esplicito su un runtime agente
(`claude` o `codex`, non `shell`). Prima di avviare il runtime, daemon e tick recuperano il dettaglio completo,
applicano Guidance/chiarimenti/limiti per lo specifico repository, acquisiscono il lease
distribuito del ticket prima di prenotare il budget, quindi lo rinnovano durante la run e lo rilasciano alla fine.
Dettaglio, label e Guidance entrano nel prompt. Un host non registrato o un lease non attestabile bloccano il
ticket in modalità fail-closed:

```yaml
actions:
  ticketworker:
    schedule: "every 15m"
    type: codex
    run: "Lavora esclusivamente il ticket autorizzato dal preflight"
    cwd: .
    sandbox: workspace-write
    containment: strong
    ticket:
      project: CYAU
      code: CYAU-34
      repository: closeyourit/closeyourit-automator # obbligatorio nel playbook locale
      estimated_cost: 0
      needs_decision: false
```

Valida e prova senza eseguire:

```sh
automator validate playbook.yml
automator tick --dry-run
automator run triage --dry-run
```

### 5. Installa il servizio

```sh
automator install --managed --playbook /percorso/assoluto/playbook.yml \
  --secrets-project CYAU --secrets-environment staging
automator status
# Linux headless (avvio senza login):
loginctl enable-linger "$USER"
```

Rimozione: `automator uninstall`.

#### Server CloseYourIt su rete privata con Codex

Le sessioni raggiungono soltanto i siti della lista permessa: quella fissa (`closeyour.it` e sottodomini, GitHub,
npm, RubyGems) più le voci di `AUTOMATOR_SANDBOX_DOMAINS`, separate da virgole, che `install` salva nel servizio.
Ogni voce deve essere un nome o un indirizzo IPv4, eventualmente con `*.` davanti: una voce diversa — un indirizzo
IPv6, con i suoi due punti — fa fallire l'avvio delle sessioni. Codex riceve la stessa lista come siti permessi
dalla sua rete.

Con **Codex**, un server su rete privata (`10.x`, `172.16–31.x`, `192.168.x`, `100.64–127.x` e simili) non si
raggiunge **per nome**, anche se il nome è nella lista: il proxy di rete di Codex lo rifiuta. Va indicato col suo
**indirizzo IPv4** in due punti, l'indirizzo del server (`sync.apiUrl`, e `heartbeat.apiUrl` se presente, in
`~/.config/closeyourit-automator/secrets.json`) e la lista dei siti permessi:

```sh
# secrets.json: "sync": {"apiUrl": "https://192.168.1.20"}
AUTOMATOR_SANDBOX_DOMAINS=192.168.1.20 automator install --managed --playbook /percorso/assoluto/playbook.yml \
  --secrets-project CYAU --secrets-environment staging
```

- Dai al server un **indirizzo fisso**: se cambia, la configurazione smette di funzionare.
- Con HTTPS il **certificato** deve valere anche per l'indirizzo numerico, altrimenti la verifica fallisce.
- Se il server ha **solo indirizzi IPv6**, la lista non li accetta e non è provato che Codex li rispetti: dagli un
  indirizzo IPv4 privato, oppure fai lavorare Claude su quella macchina (`AUTOMATOR_WORK_ENGINE=claude`).
- Con Claude il nome funziona: il limite riguarda solo Codex.
- `localhost` (e i suoi sottodomini) fa eccezione: Codex lo lascia passare per nome, non serve cambiarlo.

`automator doctor` lo controlla: con Codex, se il nome del server porta a un indirizzo privato, avvisa e indica
la correzione esatta; se il nome non risponde entro tre secondi lo dice e prosegue (la ricerca gira in un processo
separato, interrotto alla scadenza). L'avviso non blocca la macchina.

## Comandi

| Comando | Cosa fa |
|---------|---------|
| `validate [playbook]` | Valida schema + schedule |
| `list [playbook]` | Azioni + stato + prossima esecuzione |
| `run <action> [--dry-run]` | Esegue una azione on-demand |
| `tick [--dry-run]` | Una iterazione (usata dal servizio) |
| `daemon [--interval N]` | Loop persistente |
| `install` / `uninstall` / `status` | Gestione servizio systemd utente |
| `doctor` | Verifica le CLI necessarie |
| `setup [--dry-run] [--optional]` | Installa le CLI mancanti |
| `update [--target-version V] [--server-version V] [--migrate-service] [--skip-service-preflight] [--dry-run]` | Aggiorna atomicamente; `--migrate-service` converte esplicitamente una unit checkout legacy con journal e rollback; `--skip-service-preflight` è il recovery da controlli di avvio difettosi (aggiorna i soli byte, poi va rieseguito `update`) |
| `link [dir...] [--dry-run]` | Rileva i checkout dai remote Git e collega i progetti con corrispondenza univoca alla mappa host |
| `skill sync` | Sincronizza il bundle skill pinnato dal server e promuove `skills/current`; avvisa se il pin è fermo a una versione già superata dai tag pubblicati |
| `logs [action] [-n N]` | Log per-azione |

Ogni comando supporta `--json`.

## Sicurezza

- **Mai `bypassPermissions`** nelle azioni claude schedulate (non presidiate). Read-only → `permission_mode: plan`;
  scrittura → `acceptEdits` con `allowed_tools` stretti e `cwd` isolato.
- Ogni sessione Claude/Codex richiede i guardrail installati da `automator install`; `automator update` li migra
  alla nuova release e li ripristina in rollback. Un marker di generazione condiviso rende i set parziali
  fail-closed fino al commit/recovery. `CODEX_HOME` viene normalizzata e, per le installazioni gestite, i path
  effettivi e il Node dell'unità sono persistiti in `installRoot/service-runtime.json`: daemon e updater usano la
  stessa policy anche da shell con env/toolchain diverse. Il primo boot adotta automaticamente installazioni
  legacy senza marker prima di schedulare run. L'update rifiuta unit legate a un'altra root; una unit checkout
  legacy richiede il consenso `--migrate-service` prima di accedere alla rete ed è migrata con backup e journal
  recuperabile. Dopo aver validato l'intera command line `daemon` ricarica la definizione soltanto dopo la
  migrazione guardrail; anche nel caso `up-to-date` riavvia e verifica la configurazione live (inclusi config e
  CODEX_HOME), la versione col Node dell'unità e il daemon running. Le sessioni usano direttamente i path guardrail
  persistiti e la root env deve coincidere con quella derivata dall'entrypoint effettivo; le unit legacy adottano
  atomicamente questi metadata prima del restart. Override di environment/settings locali non possono quindi
  allentare hook, sandbox o rete. Questi controlli girano col binario già installato: quando rifiutano indicano
  anche il rimedio, e `automator update --skip-service-preflight` aggiorna i soli byte gestiti senza interrogare
  né mutare il servizio — un difetto nei controlli si corregge quindi con un secondo `automator update` (che gira
  dal codice nuovo e riconcilia guardrail e daemon), non disinstallando e reinstallando a mano.
- L'aggiornamento non si lancia più a mano: `install --managed` installa accanto al daemon il timer utente
  `closeyourit-automator-update.timer` (ogni ora, con ritardo sparpagliato e `Persistent=true`, così una macchina
  spenta recupera l'occasione persa), e `uninstall` lo rimuove. Ogni `update` sano su unit gestita lo riconcilia
  leggendo l'ambiente dall'unit reale del daemon — senza, le macchine già installate resterebbero senza timer. Il gate «macchina libera» sta nel comando, non nel
  timer: `update` prende il lock del ciclo per tutta la sua durata — se è già detenuto esce `busy` con exit 0 senza
  toccare rete né byte, e finché lo detiene nessun giro nuovo può partire, quindi il riavvio del servizio non può
  interrompere una lavorazione. Fail-closed: un lock non verificabile rimanda l'aggiornamento. Ne restano fuori
  `--dry-run` e `--skip-service-preflight`, che non riavviano nulla — e il secondo resta la via di recovery se a
  essere difettoso fosse questo gate. L'esito di un aggiornamento non riuscito resta in `update-outcome.json`
  nello state dir e viaggia nel battito come `last_stops`, così su CloseYourIt si vede che c'è da intervenire
  senza entrare nel server; un aggiornamento riuscito lo cancella.
- Gli agenti non ricevono un tool shell: Claude usa una allowlist di tool file e Codex nega `Bash` con un hook
  CLI autoritativo. I launcher sono risolti sul PATH del servizio prima di applicare `env.vars` e pin-nati per
  path canonico + SHA-256 durante il processo; cwd assolute o con traversal sono rifiutate, salvo directory host
  sincronizzate e autorizzate localmente.
- Le azioni shell usano una policy fail-closed: espansioni e substitution dinamiche non sono ammesse; `git push`
  accetta soltanto il token letterale `git` e un singolo refspec `ticket/…` senza force, mapping o wrapper.
- I segreti del vault sono gestiti per allowlist, nel wrapper e nell'hook della sessione: `cyi run` passa solo con
  un ambiente letterale fra `development|dev|test|staging` — ogni altro valore, id opaco o espansione compresi, è
  rifiutato — e della famiglia `cyi secrets` restano ammessi solo `list` e `assets list`, che non stampano valori
  (`sync` e `assets download` non hanno nemmeno un flag ambiente: toccherebbero la produzione senza nominarla).
  Osservabilità di produzione e altri comandi `cyi` non sono toccati; il provider di secret ritirato è vietato
  ovunque. La rete è deterministica e precede il gate server-side, non lo sostituisce.
- Timeout e annullamento terminano l'intero process group con `SIGTERM`→`SIGKILL`; stdout/stderr vengono sempre
  drenati ma limitati a 1 MiB nei risultati e nei log. Il default `containment: process-group` resta disponibile
  per azioni generiche, ma un discendente che chiama `setsid`/`setpgid` può uscire dal PGID. Ticket e azioni skill
  devono invece dichiarare `containment: strong`: sono eseguiti in una scope systemd/cgroup v2, segnalata per
  identità unit (non PID) e considerata conclusa soltanto a `cgroup.procs` vuoto. Se il backend non è disponibile
  l'azione è rifiutata prima dello spawn (`C412-EXEC-005`), senza downgrade silenzioso.
  Le sonde systemd sono asincrone; se la verifica finale supera la deadline, la sola azione resta fail-closed e
  ritenta KILL+verifica entro una seconda deadline assoluta, senza abbattere globalmente il daemon. Una bonifica
  provata soltanto dopo la prima deadline resta comunque un failure `C500-EXEC-006`; se nemmeno la deadline
  assoluta produce una prova, termina con lo stesso errore invece di impedire indefinitamente lo shutdown. Il
  polling usa backoff fino a 500 ms per non creare una tempesta di subprocess nel percorso di errore.
- Un ticket già chiuso o risolto (anche a mano, mentre era in coda) non viene lavorato: il preflight legge lo
  stato canonico del ticket, non l'etichetta. Ogni tentativo viene contato per ticket in
  `<stateDir>/ticket-attempts/`; dopo `AUTOMATOR_MAX_TICKET_ATTEMPTS` tentativi consecutivi sulla stessa fase
  (default 5) il ticket non viene più reclamato, la sospensione è commentata sul ticket una sola volta e il
  candidato viene differito lato server. Un avanzamento di fase azzera il conteggio; la spesa storica resta e
  si legge con `automator activity`. Il contatore è host-scoped: con più host sullo stesso progetto la soglia
  vale per macchina, finché la coda non espone un contatore server-side.
- Mentre il quality gate gira, la cartella di lavoro è dichiarata **in uso**: `closeyourit-busy.json` viene scritto
  nella directory amministrativa Git della cartella (`.git/` in un checkout, il gitdir puntato in un worktree
  collegato) con pid, ora d'inizio e ticket, e rimosso alla fine — anche se la verifica fallisce, va in timeout o
  viene annullata. Chi fa pulizia (skill `closeyourit-repo-hygiene`) lo legge e salta quelle cartelle: «ramo già
  integrato» non vuol dire «nessuno ci sta lavorando adesso». Il marcatore informa e basta: non blocca comandi, e
  se non è scrivibile il gate gira comunque. Vale come ASSENTE quando il suo processo non esiste più — o quel pid
  appartiene ormai a un altro processo, riconosciuto dall'identità d'avvio — così un crash non blocca la cartella
  per sempre. Non vive mai nella working tree: la review rifiuta i file non tracciati e `git add -A` non deve
  poterlo stagiare. Un marcatore ancora vivo non viene sostituito e ognuno rilascia soltanto la propria
  marcatura (pid + ora d'inizio): con due lavori sulla stessa cartella, la fine del secondo non la fa risultare
  libera mentre il primo continua. `automator gate --ticket <TICKET>` dichiara il ticket anche nell'uso manuale.
- I repository con `.closeyourit/quality-gate.yml` **versione 2** separano il feedback locale dalla verifica
  autorevole: `checks` resta il gate rapido eseguito nel worktree; `remote.provider: github` dichiara i nomi
  esatti dei check richiesti, timeout e polling. La policy remota viene letta dal ref base fidato, mai dal branch
  proposto. In skill-mode l’Autopilot apre o ripristina una PR draft; l’Automator attesta repository, branch e
  HEAD locale/remoto, aspetta la CI, avvia la cross-review, riattesta lo SHA, rende pronta la PR e soltanto dopo
  consegna il risultato al server. Rosso, check mancante, timeout, push concorrente o risposta GitHub illeggibile
  non avanzano né PR né ticket.
- Il tetto di lavorazioni in parallelo (`limits.max_parallel`) vale anche con **un solo progetto in coda**: in
  skill-mode il dispatch chiede lavoro con la presa in carico atomica (`POST /api/v1/ticket_queue/next_claim`),
  dove il server sceglie il candidato e prende il lease nella stessa transazione. Richieste concorrenti sulla
  stessa coda ottengono così ticket diversi, invece di rileggere la stessa testa e trovarla già presa. Una coda
  può fornire fino a `max_parallel` prese in carico per giro: gli slot si riempiono, ma il giro resta finito e
  la continuazione la riaccoda il server. Senza canale sync o in prompt-mode resta il percorso in due passi:
  snapshot della testa, poi claim, una lavorazione per coda per giro.
- Da lì il lease arriva **prima** dei gate locali, con due conseguenze operative. Ogni stop del preflight
  restituisce subito il lease (il ticket non resta occupato fino alla scadenza) ma **non** lo rimette in coda:
  la presa in carico ha già marcato la fase come avviata lato server, e a riaprirla è il recupero delle fasi
  interrotte — il planner fa eccezione, non avendo un avvio dedicato torna proposto da solo. Per questo una coda
  che consegna un ticket non lavorabile **si chiude fino al giro dopo**, invece di farsene dare un altro: senza,
  il planner verrebbe ripreso subito e ogni ripresa aprirebbe un tentativo in più. Per lo stesso motivo un host
  che non può eseguire la coda (bundle skill assente, write-confinement non attestato) **non chiede lavoro
  affatto**: la richiesta stessa brucerebbe un ticket a ogni giro. Il rilascio è del dispatch, che ha preso il
  ticket, finché il preflight non dichiara di aver adottato il lease (`queueClaimAdopted`).
- Ogni lavorazione della coda ha il proprio file di log (`<azione>-<TICKET>-<timestamp>.log`): la stessa azione
  gira più volte nello stesso giro e senza il codice ticket nel nome i registri si mescolerebbero.
- Secret statici nel vault CloseYourIt; credenziali device nel Secret Service; file locale solo non sensibile.
- Il PATH del servizio è esplicito (shim mise) — vedi `CLAUDE.md` per i gotcha operativi.

## Sviluppo

```sh
mise exec -- pnpm test     # vitest + coverage (gate ≥90% line/branch)
mise exec -- pnpm lint     # tsc --noEmit
mise exec -- pnpm build
# E2E multi-host opt-in: Rails test + CLI locali + due daemon + remote Git temporaneo
CLOSEYOURIT_RAILS_ROOT=/path/to/closeyourit-rails mise exec -- pnpm test:e2e:multi-host
```

## Coworkers VM pilot

The isolated Coworkers experiment is documented in
[prototypes/coworkers/README.md](prototypes/coworkers/README.md). Its optional
[AX41 browser pilot](prototypes/coworkers/pilot/README.md) is provisioned only by
manual GitHub Actions dispatch after dedicated SSH authorization. It is separate
from this daemon's installation and is not enabled by normal CI or deployment.

## Security boundaries for skill sessions (CYRA-989)

The host binds the release helper exception to the current production closer,
ticket code, authorized checkout and server-assigned tag/SHA through per-session
hook settings. Authority expires at the action timeout and cannot be supplied
through playbook JSON or model output. Missing assignments fail closed. A helper
from the pinned bundle does not grant production authority to another phase.
Claude read phases deny checkout writes including Bash; Codex read phases mark
their workspace read-only in the effective permission profile.

Upgrade the skill bundle together with these guardrails. Quality gates require
`/usr/bin/bwrap` and preinstalled mise runtimes and dependencies. Their inner
sandbox has no network, session credentials or host home directory. Checks
requiring an external service belong in a dedicated CI job. A missing sandbox
fails the gate.

Cross-review resolves trusted mise launchers to the installed runtime before
confinement. Native Claude and Codex binaries are executed directly; official
Codex npm wrappers resolve to their platform binary. Ownership, permissions and
checkout exclusion are checked again on the resolved path. Unsupported or
untrusted installations fail closed.

Reviewer profiles expose only minimal system files, exact runtime files and the
isolated review directory. Codex selects the named profile without the legacy
`--sandbox` override. Claude runs inside Codex's OS sandbox with the network proxy
enabled and only the Anthropic/Claude domain allowlist. Offline smoke tests use
the same runtime resolver and verify that a file outside the allowlist cannot be
read; authenticated provider smoke remains an explicit opt-in check.
