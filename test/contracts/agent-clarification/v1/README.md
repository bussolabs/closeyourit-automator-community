# Agent clarification state contract v1

Stato del ciclo di chiarimenti di un ticket, letto da
`GET /cli/v1/projects/:project_id/tickets/:ticket_id/clarifications` (bearer utente `cyi_u_`).

```json
{
  "state": "waiting",
  "cycles": 2,
  "has_reply": false,
  "rounds": [
    { "cycle": 1, "questions": ["Quale comportamento al logout?"], "response": "1. Torna alla dashboard",
      "answered_at": "2026-07-31T09:12:00Z", "created_at": "2026-07-31T09:02:00Z" },
    { "cycle": 2, "questions": ["Vale per tutti i ruoli?"], "response": null,
      "answered_at": null, "created_at": "2026-07-31T10:30:00Z" }
  ]
}
```

## Perché esiste (CYRA-221)

Fino a questo contratto lo stato del ciclo viveva nel **testo dei commenti**: il marker
`<!-- closeyourit-autopilot:waiting:v1 cycle=N -->` scritto da `closeyourit-rails` e ri-parsato con
un regex duplicato in `closeyourit-skills` (`skills/triage/scripts/clarification-state.mjs`) e in
`closeyourit-automator` (`src/lib/clarification.ts`). Tre implementazioni della stessa cosa in tre
repository: un commento riformattato cambiava lo stato di una lavorazione, e la copia divergente di
un lettore lo cambiava solo per lui.

## Campi

| campo | significato |
|---|---|
| `state` | `ready` = niente da aspettare · `waiting` = c'è un giro senza risposta · `escalated` = la lavorazione è ferma e chiama una persona (`blocked_at` lato server) |
| `cycles` | quanti giri di domande sono stati posti su questa lavorazione |
| `has_reply` | l'**ultimo** giro ha ricevuto risposta. Una risposta vecchia a un giro vecchio non conta: leggerla come "ha risposto" farebbe riprendere una lavorazione ancora in attesa |
| `rounds[]` | i giri in ordine cronologico. `cycle` è la posizione (1-based), la stessa che il marker riporta |

`rounds[].questions` è 1..3 stringhe non vuote, come nel contratto `agent-result/v1`
(`triage_result.questions`): sono le stesse domande, lette dal record invece che dal commento.

## Cosa NON c'è

Il **limite** di giri oltre il quale escalare. È una policy del chiamante — vive in
`decideClarification` (`DEFAULT_CLARIFICATION_LIMIT`) — e il server non la duplica: due numeri in due
repository un giorno divergono, e nessuno se ne accorge finché un ticket non si blocca.

## Transizione (ordine obbligato)

1. Il server espone questo endpoint e **continua a scrivere il marker** nei commenti.
2. I due lettori passano all'endpoint in **dual-read** (accettano entrambe le forme): il bundle skill
   è pinnato per-organizzazione e può restare indietro.
3. Solo allora il server smette di scrivere il marker.

Invertire 1 e 3 fa tornare `{state:'ready',cycles:0}` per ogni ticket: la lavorazione richiede il
chiarimento a ogni giro, per sempre, senza mai escalare.

Nota per i lettori: `ANY_MARKER_PATTERN` dell'automator considera **risposta del cliente** qualunque
commento senza marker. Le righe di servizio scritte dall'app (`kind: "service"` in
`CommentSerializer`) vanno ignorate, o sbloccano un ticket a cui nessuno ha risposto.
