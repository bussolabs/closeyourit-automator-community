# Agent result v2 — pacchetto di decisione

La versione 2 rende il risultato leggibile e verificabile senza sostituire la versione 1 durante il
rollout. Ogni result v2 dichiara `contract_version: 2`; l'assenza del campo identifica un result v1.

Le differenze principali sono:

- il planner produce `plan` strutturato, scenari identificati (`SC-*`) e criteri identificati
  (`DOD-*`); il server genera da questi dati sia la pagina sia il Markdown scaricabile;
- il planner puo' aggiungere `decision_brief` (top level, MAI dentro `plan`): 3-6 frasi in
  italiano semplice — niente path, nomi di classe o sigle — per chi approva dalla coda. E'
  opzionale: i planner non aggiornati consegnano senza e la card ripiega sulla sintesi tecnica;
- planner e autopilot possono aggiungere `decision_card` (top level): `headline` (una frase, ≤120),
  da 1 a 4 `points` con `label` (≤40) e `text` (≤160), `risk_level` (`none`/`low`/`high`) e
  `risk` (una riga o `null`). I punti sono 3; il quarto c'è solo sui bug ed è il primo, «Cosa succede
  oggi»: lo schema non conosce il tipo del ticket, la regola sta nel planner. È la scheda che la coda mostra a chi decide; `decision_brief` resta
  accettato per i planner che non la scrivono. Il server può solo alzare `risk_level`;
- il triage può consegnare ogni domanda come testo oppure come oggetto `{ body, options }`, con 2-4
  `options` (`label`, `recommended`) e al massimo una consigliata: chi risponde sceglie con un clic.
  Solo la consigliata può portare `reason`, una riga (≤160) sul perché (CYRA-1033). Gli automator che
  non conoscono la quarta opzione non ricevono lo smistamento: lo decide il server (`MIN_TRIAGE_VERSION`);
- l'autopilot produce `work_report`, che separa file, test, rischi, scostamenti e prova di ogni
  criterio;
- un blocco produce `failure`, con categoria, retry esplicito e azione richiesta alla persona;
- il planner puo' dichiarare `already-done` con `already_done.summary` e almeno una `source`: il
  lavoro chiesto dal ticket esiste gia' nel ramo principale e non c'e' niente da pianificare. Non e'
  `already-delivered`, che e' dell'autopilot e dice che una sessione precedente aveva gia' aperto la
  proposta;
- la cross-review conserva i singoli `findings`, oltre alla sintesi e alle attestazioni del diff.
- `reviewer_runtime` è il motore che ha riletto, per nome (CYAU-226): può essere lo stesso di `runtime`, in una sessione nuova. `opencode` rilegge soltanto (CYAU-228) e non è mai un `runtime`.

I dati dichiarati dall'agente restano `reported`. Le impronte `observed`, i controlli GitHub e le
attestazioni della review sono `attested`: l'interfaccia non li presenta come equivalenti.

## Compatibilità

- producer aggiornati: planner e autopilot emettono v2;
- consumer: server e automator accettano v1 e v2;
- record storici: continuano a essere resi dal formato v1;
- rollback: si può ripristinare un producer v1 senza migrare o riscrivere i record esistenti.

`manifest.json` elenca le fixture che congelano i confini principali del nuovo formato;
`SHA256SUMS` protegge l'intero bundle.
