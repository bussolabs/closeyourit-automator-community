# AGENT-HOST-SETUP — configurare un server Linux come host degli agenti CloseYourIt

Scopo: trasformare una macchina nel **worker** su cui gira il daemon `closeyourit-automator`. Il daemon pesca
le definizioni degli agenti da CloseYourIt (cloud) e, per ognuno che è "dovuto", lancia
`claude -p "/<agente>"` **nel checkout locale del repo target**. Per l'agente **`ticket-worker`** (target
progetto **CYRA** = `closeyourit-rails`) questo significa: prende un ticket, lo implementa in TDD su un
worktree e apre una PR — tutto su QUESTA macchina.

> La riga agente su `app.closeyour.it/member/agents` è solo la *definizione* (cloud, globale). Chi la ESEGUE
> è l'automator su questa macchina. I passi sotto vanno fatti **su questo host**, non sul PC di sviluppo.

## Prerequisiti macchina

- OS: **Linux** `x86_64` o `arm64`; altri sistemi sono rifiutati.
- systemd `>=254` con user manager, cgroup v2 e linger abilitato per l'utente del servizio.
- `bubblewrap`, `socat`, `/usr/bin/secret-tool`, D-Bus utente e una sessione Secret Service sbloccata con la raccolta
  `login` (su un server senza desktop va creata: vedi la sezione Requisiti del README).
- Toolchain: `git`, **mise** (node 24.11.0 + pnpm 11.28.5), **`claude`** CLI, **`codex`** CLI, **`cyi`** CLI
  (`@bussolabs/closeyourit-cli` ≥ 0.0.19), **`gh`** CLI. Codex serve sempre: la rilettura di Claude gira nella sua
  sandbox. Installalo con l'`npm` di mise, non con `sudo npm -g` (`/usr/lib` non è un percorso fidato), e con
  `chmod -R go-w` sul pacchetto se la umask è `0002` (CYAU-222).
- Rete: accesso a `https://app.closeyour.it` e a `github.com`.

## Passo A — Checkout dei repo
Clona (o `git pull` se già presenti) l'automator + i repo che gli agenti toccano:
```sh
git clone git@github.com:bussolabs/closeyourit-automator-community.git
git clone git@github.com:bussolabs/closeyourit-rails.git   # target di ticket-worker (key CYRA)
# se già presenti: git -C closeyourit-automator pull && git -C closeyourit-rails pull
```
Annota il **path assoluto** di `closeyourit-rails` su questa macchina: serve nell'host-map (Passo D).

## Passo B — Autenticazioni (per-macchina)

- **Claude headless**: esegui `claude login` come lo stesso utente del servizio. La sessione resta locale alla
  macchina e le sessioni di lavoro la ritrovano via `HOME`. La review Claude, confinata con una home vuota, riceve
  solo il token di accesso di breve durata letto da quella sessione (CYAU-223); il token di rinnovo resta sul disco
  e l'Automator non custodisce né riscrive nulla. Verifica con `automator doctor`: se segnala l'accesso della review
  **mancante**, ripeti `claude login`; se lo segnala **scaduto**, avvia `claude` una volta con l'utente del servizio
  (o ripeti `claude login`). In alternativa il proprietario imposta la credenziale Claude dell'organizzazione.
- **cyi**: `cyi login` (device flow). L'agente **agisce come questo account** (self-assign, commenti, PR-note):
  deve avere sul progetto CYRA i permessi `tickets.assign` / `tickets.edit` / commento.
- **gh**: `gh auth login` con un account che può **pushare** su `bussolabs/closeyourit-rails` (scope `repo`).
- **git push non-interattivo**: SSH key o `gh` come credential helper, così `git push` dei branch `ticket/…` va
  senza prompt.

## Passo C — Bootstrap e installazione (installa ANCHE i guardrail)
```sh
cd closeyourit-automator
sh bin/bootstrap.sh
# Dopo aver preparato il service account del Passo D:
automator install --managed --secrets-project CYAU --secrets-environment staging
loginctl enable-linger "$USER"   # senza, il servizio non parte al boot/logout
```
`install` fa due cose, in ordine fail-closed: **(1)** `installGuardrails` pubblica e valida i 4 hook come una
generazione condivisa Claude/Codex (`installing` → `committed`; un crash intermedio blocca entrambi i runtime),
Claude (`block-production`, `block-destructive-db`,
`require-worktree`, `guard-branch-push`), genera i settings autoritativi e installa la policy Codex in
`$CODEX_HOME/rules/closeyourit-automator.rules` (`CODEX_HOME`, path e Node dell'unità vengono resi assoluti e, in
modalità gestita, persistiti anche in `installRoot/service-runtime.json`); **(2)** soltanto a gate verde registra e avvia il servizio che ogni
~60s esegue gli agenti dovuti. Ogni sessione Claude/Codex richiede il guardrail del proprio runtime; se assente o
corrotto la run viene **RIFIUTATA** (`C412-GUARDRAILS-001`) prima dello spawn. Gli update successivi migrano e
verificano il set della nuova release prima del restart, ripristinando quello precedente durante il rollback. Il
primo boot dopo un upgrade legacy adotta il marker mancante prima di eseguire qualunque agente. L'updater accetta
solo l'unit gestita dalla stessa install root e verifica il post-restart col Node dell'unità più il daemon running.

## Passo D — Service account e Secret Service

Crea un **service account** CloseYourIt con visibilità soltanto sui progetti necessari, privilegi minimi e
ambienti non-production (`development`, `test`, `staging` o `preview`), poi conia un token `cyi_u_…` reveal-once.
Passalo una sola volta all'installazione tramite `CLOSEYOURIT_TOKEN`: l'Automator lo trasferisce nel Secret Service
senza scriverlo nel repository, nella config, nell'unit del servizio o negli argomenti dei processi. Esegui tu
queste operazioni sensibili dalla UI o dalla CLI; non incollare il valore in ticket, chat o script.

Infine collega il checkout locale (dato non sensibile):

```sh
automator link /PATH/ASSOLUTO/DI/closeyourit-rails
```

Il file locale dal nome storico `secrets.json` contiene in modalità managed soltanto questa host-map e altri
dati pubblici. I valori operativi arrivano da CloseYourIt Secrets a ogni caricamento.

## Passo E — Verifica
```sh
node bin/run.js enroll              # percorso unico: registra l'host + verifica prerequisiti + diagnostica completa
node bin/run.js sync                # ticket-worker su CYRA deve essere materializzato, NON negli "skip"
node bin/run.js run ticket-worker   # esecuzione ON-DEMAND (cyi agents run NON esiste)
```
`enroll` è **idempotente**: rilancialo quando vuoi. Registra la macchina come Agent Host (device flow) e stampa una
checklist — provider claude, `gh` autenticata, guardrail, repository mappati, servizio — più la diagnostica di
`doctor`. Se dice "pronta" l'host è operativo; altrimenti elenca i **passaggi mancanti** con il rimedio (mai token).
Su un ticket **chiaro** (Open, non assegnato, con ≥1 scenario BDD + ≥1 Definition of Done): self-assign →
worktree → `bin/ci` verde → push `ticket/…` → PR aperta → commento sul ticket con l'URL. Controlla:
```sh
node bin/run.js logs ticket-worker
cyi agents runs list 37f969fa-7347-4b5f-bad4-d50fff6f2a3b   # storico run (success/fail)
```
Su un ticket **scarno**: l'agente commenta cosa manca (scenari/DoD/analisi) e salta, senza toccare codice.

## Passo F — Abilita lo schedule
Finché è disabilitato gira solo on-demand (`run`). Per lo schedule orario (UTC):
```sh
cyi agents update 37f969fa-7347-4b5f-bad4-d50fff6f2a3b --enabled
# oppure toggle su app.closeyour.it/member/agents
```

## Note
- Schedule in **UTC**; timeout run **1h** (l'agente aborta pulito se sta per sforare).
- L'agente lavora **UN** ticket per run del progetto **CYRA** (Open + non assegnato, priorità poi più vecchio).
- Logica dell'agente: `closeyourit-rails/.claude/commands/ticket-worker.md`. Guardrail: automator, §Guardrail del suo `CLAUDE.md`.
- I guardrail bloccano comunque, per costruzione: mai produzione, edit solo in worktree, push solo `ticket/…` (mai main/force).

## Troubleshooting
| Sintomo | Causa → fix |
|---|---|
| Bootstrap/install rifiutato come host non supportato | Verifica Linux, systemd ≥254, cgroup v2, bubblewrap, D-Bus e Secret Service con `automator doctor` |
| Run rifiutata `C412-GUARDRAILS-001` | Guardrail non installati → rilancia `automator install --managed` |
| `ticket-worker` negli "skip" del `sync` | CYRA non nell'host-map → esegui `automator link <checkout>` |
| claude headless: account sbagliato / non parte | Esegui `claude login` come l'utente del servizio e verifica con `automator doctor` |
| `git push` / `gh pr create` falliscono | `gh` non autenticato o senza permesso di push su `bussolabs/closeyourit-rails` |
| Vault non autorizzato durante install/enroll | Service account senza `secrets.read`, progetto/environment errati o token revocato |
| Nessun agente scaricato | Service account senza visibilità o token revocato; correggi lo scope e reinstalla la credenziale device |
