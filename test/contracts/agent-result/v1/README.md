# Agent delivery result contract v1 (skill-mode)

Contratto del **result** che un host consegna al server al termine di una fase, tramite
`PUT /api/v1/agent_attempts/:id/result` (bearer host `cyi_ah_`). Il body è un `delivery_envelope`:

```json
{ "runtime": "claude", "reviewer_runtime": "codex", "result": { … }, "review": { "status": "accepted", "summary": "…" } }
```

- `runtime` = runtime che ha eseguito la fase; `reviewer_runtime` = runtime della cross-review (l'altro).
- `review` = esito della cross-review prodotta dall'automator (**non** dalla skill): il server richiede
  `status == "accepted"` per applicare gli effetti.
- `result` = output reale della skill della fase, forma per-fase qui sotto.

Questo è il **clean break** (CYAU-97): il server adotta i contratti reali emessi dalle skill
`closeyourit-skills` e **non** mantiene gli schemi agent-typed precedenti.

## Result per fase (`$defs`)

Ogni result porta `code` (codice ticket). Lo stato terminale governa gli effetti server; gli stati
**non-avanzanti** (`waiting`/`escalated`/`blocked`) sono delivery valide che **non** muovono la coda.

| Fase | `$def` | `state` | Note |
|---|---|---|---|
| triage | `triage_result` | `workable` \| `needs-clarification` \| `waiting` \| `escalated` | `workable` → avanza; `needs-clarification` richiede `questions` (1..3) e crea la `Clarification` (il commento lo posta la skill, non il server) |
| planner | `planner_result` | `submitted-for-approval` \| `blocked` | `submitted-for-approval` esige `technical_analysis` + `scenarios[{given,when,then,expected}]` + `definition_of_done[]` + `mixed_parts` (null\|obj) + `notes[]` → crea `Agents::Plan`. `blocked` esige `reason` non vuoto e **non** crea nessun piano: serve quando il ticket non e' pianificabile qui — di solito e' finito nella coda del prodotto sbagliato. Senza questo stato l'agente non aveva come dirlo: provava, veniva respinto, riprovava, e la lavorazione si fermava dando la colpa alla revisione, che non c'entrava. `causa` (opzionale, solo sensata con `blocked`) distingue **`needs_decision`** — serve una persona, e la lavorazione entra subito nella coda delle approvazioni — da **`unreachable`**, che vuol dire «non sono riuscito a guardare»: la lavorazione resta dov'e, riprova da sola, e solo oltre un tetto di tentativi chiama qualcuno. Assente vale `needs_decision`, che e' il default sicuro: chiamare una persona che non serviva costa un'occhiata, non chiamarla quando serviva ferma la lavorazione per sempre |
| autopilot | `autopilot_result` | `delivered` \| `blocked` \| `already-delivered` | `delivered` → ticket In Review + `autopilot_completed_at`; `gate`/`review{verdict}`/`cycles`/`delivery` per audit. `gate.passed` può essere `null` (nessun quality-gate.yml, o suite non eseguibile nel sandbox) e `review.verdict` `unavailable`: la skill VIETA all'agente di auto-approvarsi — il verdetto lo scrive l'automator dopo, sulla cross review. Pretendere `true`/`approved` qui rendeva non interpretabile l'esito onesto e buttava via il lavoro, PR aperta compresa. Non è un rilascio: `delivered` porta al gate UMANO, i closer restano dietro l'approvazione. `delivery.prUrl` accetta solo la forma che GitHub produce davvero — `https://<host>/<owner>/<repo>/pull/<n>` con `n` da 1 — in ENTRAMBI i rami. Nessuna lista di domini ammessi: GHES ha host propri e va servito. Questo non rende l'URL *vero*: un URL scritto benissimo ma di un progetto estraneo passa, e a fermarlo è il confronto con i progetti autorizzati, non il contratto. Qui si toglie solo lo spazio alle forme che GitHub non avrebbe potuto produrre. La regola è UNA: `isGitHubPrUrl` nell'automator è la stessa, e le fixture `*_prurl_*` la tengono allineata da entrambe le parti (CYAU-173). `security_findings` (CYRA-603) è l'elenco delle anomalie di sicurezza notate MENTRE si lavorava — non una scansione, ma ciò che si è visto passando. OBBLIGATORIA su `delivered` e `already-delivered` (CYRA-674: trenta giorni di campo facoltativo = zero dichiarazioni su 1457 consegne; su `blocked` resta facoltativa): la distinzione che porta è fra elenco **vuoto** («ho guardato, niente da segnalare») e campo **assente** («non ho guardato»), che senza obbligo erano lo stesso silenzio. Ogni voce esige un `title` non vuoto e non di soli spazi: senza, occuperebbe il riquadro rosso senza dire niente. `severity` resta stringa libera DI PROPOSITO — chiuderla in un elenco farebbe rifiutare l'intera consegna per una parola, e chi la legge la scarta da sé. `already-delivered` → stesso avanzamento, per il lavoro trovato **già consegnato** da una sessione precedente: esige `delivery{prUrl,cyiStatus}` come prova, `reason` e `cycles: 0` (questa sessione non ha implementato nulla). Senza quello stato l'agente non aveva come dirlo — `blocked` sarebbe falso, `delivered` mentirebbe sui cicli — e usciva dallo schema, sprecando la consegna |
| closer_staging | `closer_staging_result` | `staging-released` \| `blocked` | `staging-released` esige `tag` (stringa, pattern beta) + `commit`; `blocked` esige `reason` e ammette `tag: null`. Il null serve: un closer che si ferma NON ha prodotto un tag, e scrivere `"tag": null` è la forma che gli viene naturale — pretendere una stringa lì rendeva il rapporto non interpretabile e la consegna non partiva nemmeno, così il motivo del blocco si perdeva del tutto (successo davvero su CYRA-296). `blocked` ammette `plain_reason` (CYRA-1082): lo stesso motivo in una o due frasi di italiano semplice, quello che la scheda mostra a chi decide; `reason` resta il testo tecnico. |
| closer_production | `closer_production_result` | `production-released` \| `blocked` | `production-released` esige `tag` (stringa) + `awaiting_human_approval` + `commit`; `blocked` esige `reason` e ammette `tag: null`, come closer_staging; ticket → done. `commit` (CYRA-606) è obbligatorio nel ramo rilasciato: la sigla esatta della fotografia di codice su cui il tag è stato messo, 40 esadecimali minuscoli. Fra l'approvazione e il rilascio possono passare ore e il codice può cambiare — senza questa riga nessuno può più tornare indietro a controllare che ciò che è uscito sia ciò che era stato guardato. Il ramo `blocked` NON lo esige, di proposito: lì quello che conta è il motivo per cui ci si è fermati, e pretendere una sigla che non esiste farebbe perdere di nuovo proprio quel motivo. `blocked` ammette `plain_reason`, come closer_staging (CYRA-1082). |

## Verifica

`python scripts/verify_agent_result_contract.py` — valida lo schema (Draft 2020-12), ogni fixture contro
il suo `$def` (valide/invalide) e i checksum `SHA256SUMS`.

I consumatori (Rails `spec/contracts/agent_result_v1_spec.rb`, automator `test/contract-agent-result.test.ts`)
vendorizzano questo bundle byte-identico e pinnano il commit docs in `LOCK.json`.
