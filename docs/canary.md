# Canarino notturno (CYAU-205)

Ogni notte un ticket innocuo sul progetto Sandbox viene lavorato davvero e seguito fino allo staging.
L'account «collaudo» approva piano e codice, ma solo su quel progetto. Un blocco, un ritardo o un
permesso non confermato fermano le approvazioni e producono un avviso con fase e motivo.

È la Fase 4 di [`docs/plans/2026-09-24-automator-operativo.md`](plans/2026-09-24-automator-operativo.md).

## Cosa fa `automator canary`

1. Crea sul progetto Sandbox il ticket `Nightly canary AAAA-MM-GG` (data UTC della notte): una riga in
   `CANARY.md`, nient'altro.
2. Legge a intervalli lo stato della lavorazione di **quel** ticket, e solo di quello. Ogni risposta deve
   nominare lo stesso progetto e lo stesso codice: altrimenti si ferma.
3. Quando il piano aspetta l'approvazione, e poi quando il codice aspetta la revisione, **prima** di
   approvare fa la prova del limite dei permessi:
   - l'osservatore (seconda utenza, sola lettura sul progetto esca) controlla che il ticket esca accetti
     proprio quell'approvazione. Se non la accetta, la prova non si tenta e la notte si ferma;
   - l'account collaudo manda sull'esca la stessa richiesta che manderebbe sul ticket della notte;
     cambia solo il ticket;
   - la prova riesce **solo** con un diniego per permessi (`R403-CLIAUTH-002`). Un rifiuto per stato,
     richiesta non valida, errore interno o nessuna risposta ferma le approvazioni: anche una richiesta
     sbagliata viene rifiutata, quindi non prova niente;
   - se l'approvazione dell'esca **riesce**, l'account ha poteri fuori dal Sandbox: il lavoro si ferma
     subito con un avviso urgente che chiede di revocare la chiave.
4. Se il ticket non arriva allo staging entro il tempo fissato (`--deadline-minutes`, 240 di partenza),
   si ferma e dice in che fase era rimasto.

Esiti: `0` staging raggiunto, `1` fermo con avviso, `4` esca approvata (revocare la chiave), `2` input
non valido. L'avviso è una riga sola, per esempio:

```text
canary alert 2026-11-02: stage deadline, phase autopilot, ticket SBX-7: SBX-7 did not reach staging within 240 minutes, stuck in phase autopilot
```

Le fasi dell'avviso: `create`, `read`, `decoy` (esca non approvabile o illeggibile), `boundary` (prova
dei permessi), `plan-approval`, `code-approval`, `deadline`.

## Chiavi

Le due chiavi arrivano **solo** dalla cassaforte CloseYourIt del lavoro notturno, tramite `cyi run`, come
variabili d'ambiente `CANARY_COLLAUDO_TOKEN` e `CANARY_OBSERVER_TOKEN`. Mai da file, argomenti o
segreti di GitHub. Il comando rifiuta di partire se mancano, se non sono chiavi utente CloseYourIt o se
sono la stessa chiave. Revocare la chiave dell'account collaudo basta a spegnere il canarino.

## Preparazione (una volta, a mano)

### 1. Progetto Sandbox e repository giocattolo

1. Creare il repository `bussolabs/automator-sandbox`, senza produzione e senza deploy.
2. Creare il progetto Sandbox su CloseYourIt, collegato a quel repository, con pipeline closer fino allo
   staging.
3. Collegarlo a server-minion-1. Verifica: il log del daemon mostra la coda Sandbox servita.

### 2. Account collaudo

1. Registrarlo come **persona** (non service account): il server accetta approvazioni solo da persone.
   L'email è ancora la decisione D5 aperta.
2. Farne il responsabile tecnico del solo Sandbox. Il suo gruppo vede solo il Sandbox, con il ruolo
   minimo che permette di approvare piano e codice.
3. Creare la sua chiave e metterla nella cassaforte del lavoro notturno come `CANARY_COLLAUDO_TOKEN`.

### 3. Progetto esca, ticket esca e osservatore

1. Un progetto esca fuori dal perimetro dell'account collaudo, con un solo ticket esca.
2. Il ticket esca resta con un piano in attesa del responsabile e lo stato in revisione. Se cambia
   stato, la notte si ferma con un avviso `decoy` finché qualcuno non lo rimette a posto.
3. L'osservatore è una seconda utenza in sola lettura sul solo progetto esca. La sua chiave va nella
   stessa cassaforte come `CANARY_OBSERVER_TOKEN`.

### 4. Lavoro programmato

L'automator non può modificare `.github/workflows/`: il lavoro va aggiunto a mano, per esempio come
`.github/workflows/canary.yml`, sugli stessi runner privati del banco `e2e` di `ci.yml`.
Schema:

```yaml
on:
  schedule: [{cron: '0 1 * * *'}]
  workflow_dispatch:
jobs:
  canary:
    runs-on: [self-hosted, <private-runner-label>]
    timeout-minutes: 270 # più del limite del canarino, così l'avviso parte sempre prima
    steps:
      - uses: actions/checkout@9c091bb21b7c1c1d1991bb908d89e4e9dddfe3e0 # v7.0.0
        with: {persist-credentials: false}
      - uses: jdx/mise-action@e6a8b3978addb5a52f2b4cd9d91eafa7f0ab959d # v4.2.0
        with: {cache: false}
      - run: pnpm install --frozen-lockfile && pnpm build
      - name: Canarino
        run: >-
          cyi run -p "$SANDBOX" -e test --
          node bin/run.js canary --sandbox-project "$SANDBOX"
          --decoy-project "$DECOY" --decoy-ticket "$DECOY_TICKET"
        env:
          SANDBOX: ${{ vars.CANARY_SANDBOX_PROJECT }}
          DECOY: ${{ vars.CANARY_DECOY_PROJECT }}
          DECOY_TICKET: ${{ vars.CANARY_DECOY_TICKET }}
```

Un lavoro fallito è l'avviso minimo; se serve anche la notifica del prodotto è una decisione aperta.

## Punti aperti

- **Dipendenza dal server.** Oggi l'API a riga di comando approva solo il codice
  (`/cli/v1/projects/:p/tickets/:t/review/approval`). Mancano, e vanno aggiunte a closeyourit-rails prima
  di accendere il lavoro: la lettura della lavorazione (`.../automation`, con `ticket_code`,
  `project_key`, `phase`, `review_gate`, `closer_staging_verified_at`) e l'approvazione del piano
  (`.../automation/approval`). I percorsi attesi sono in `CANARY_PATHS` (`src/lib/canary.ts`).
- **Esca nascosta.** Un progetto che l'account non vede risponde `R404-SYSTEM-001`, non `403`. Di
  partenza **non** conta come diniego. Se si decide che conta, perché l'osservatore ne conferma
  l'esistenza prima della prova, si aggiunge `--hidden-decoy-counts-as-denial`.
- **Accesso del lavoro alla cassaforte.** Come `cyi` si autentica sul runner va deciso aggiungendo il
  lavoro: la sua credenziale può solo leggere i segreti del lavoro notturno, ambiente `test`.
- **Tempo limite.** I 240 minuti si tarano sulle prime due settimane di giri reali.
