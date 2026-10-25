# Agent ticket queue contract v1 (host-first)

Bundle canonico, offline e versionato per il **wire host-first della coda agenti** tra
`closeyourit-rails` (server) e `closeyourit-automator` (client host). `schema.json` usa JSON Schema
Draft 2020-12; `fixtures/valid` deve validare contro il proprio `$defs`, `fixtures/invalid` descrive
payload di richiesta che il server rifiuta prima di eseguire.

Copre gli endpoint **flat host-scoped** (bearer **Agent Host** `cyi_ah_`):

- `GET  /api/v1/ticket_queue` — prossima fase pronta (**next**), risposta candidate o `{"data":null}`.
- `POST /api/v1/ticket_queue/claims` — **claim** host-first (token host+fase+profile_digest).
- `POST /api/v1/ticket_queue/deferrals` — **deferral** host+ticket+execution_phase.

> **Nota di versione (CYAU-94/84/85, clean break).** Il wire del claim è **host-bound** (`selection_token`
> firma host + execution_phase + profile_digest; nessun `agent_id` nel token). **CYAU-85 ha rimosso il
> catalogo**: `GET /api/v1/agents` non esiste più, e con esso i typed agent. L'host scopre i repository che
> gli competono dal **workspace manifest** (`GET /api/v1/agent_host/workspace_manifest`), mentre runtime,
> sandbox, permessi e TTL vengono dal `PhaseProfile` della fase reclamata — l'unica fonte autoritativa
> dell'esecuzione. Non esiste `/api/v2`: host-first È `/api/v1`.
>
> **CYAU-84 ha appiattito le route** (nessun `agent_id` nell'URL): l'host è identificato dal solo bearer
> `cyi_ah_` (`Current.agent_host`). Il **capability gate** — prima l'`active_agent?` dell'agente URL — è ora
> **host-side**: al preflight `next` un host non certificato riceve **403 `R403-AGENT-006`**; il claim resta
> gated sotto lock da `Agents::Hosts::Eligibility` (certificato/heartbeat/capacità/runtime/scope host). L'AUTORITÀ
> del claim è il token host-bound (host+`execution_phase`+`profile_digest`, che Deliver rivalida). L'anti-BOLA
> non è più l'`agent_id` del path ma il token host-bound: una selezione di un'altra org/host → **404
> `R404-QUEUE-001`**. Lo **slug** `agent` del lease/deferral è ritirato (host-first puro → `null`; lo `schema` lo
> marca **opzionale**, la colonna sparisce a CYAU-85 → drop non-breaking).

## Semantica

- Il **candidate** di `next` porta `workflow.execution_phase` (uno dei 5 `execution_phase`): è la fase
  AUTORITATIVA **pre-claim** (= `ready_execution_phase` server-side), allineata al vocabolario del `lease`
  post-claim. L'automator ne deriva runtime/skill/sandbox via `PhaseProfile` (twin), non dallo stato FSM
  `workflow.phase` (che per il planner-pronto è `planning`/`review_blocked`, non mappabile). Il claim resta
  autoritativo (il server rivalida la fase firmata nel token sotto lock).
- `additionalProperties` resta consentito per evoluzioni wire additive.
- Il `selection_token` è **opaco e firmato dal server**: il client lo conserva e lo ripresenta al claim
  senza reinterpretarlo, e **non lo logga mai**. Nelle fixture è un placeholder
  (`<<host-bound-selection-token-issued-by-server>>`); i consumer che replayano contro il server reale
  ne coniano uno fresco. `fixtures/valid/selection_payload.json` documenta i claim **decodificati**
  (VERSION 3) per l'accordo cross-consumer, non il token firmato.
- Identificativi (`host_id`, `project_id`, `ticket_id`, `attempt_id`, `id`) sono UUID; `ticket`
  è il **codice** del ticket (es. `CYAU-1`), mai un UUID. `retry_at`/`expires_at`/`created_at` sono ISO8601.
- Il claim/deferral di successo bypassano l'envelope `render_ok` (JSON piano `{"data":...}`); solo **next**
  usa `render_ok`. Gli errori usano `{"error":{"code","message","details?}}`, con l'eccezione del
  **held-lease** `R409-LEASE-001` che porta anche `data` (l'holder): `{"data":<holder>,"error":{...}}`.
- `estimated_cost` è oggi sempre `null` (nessuna stima server-side attendibile).
- **`fixtures/valid/phase_profiles.json`** pinna il `profile_digest` di ciascuna `execution_phase` (SHA256 del
  profilo di esecuzione: skill_key/runtime/sandbox/permission_mode/allowed_tools/ttl). Il wire porta solo la fase +
  il digest, mai il profilo: entrambi i lati tengono una copia del profilo (Rails `Agents::PhaseProfile`, automator
  twin TS) e la fixture è l'**accordo cross-consumer sul digest** — Rails asserisce `PhaseProfile.for(p).digest ==
  fixture[p]`, l'automator asserisce che il twin produce lo stesso digest. Un drift del profilo tra i due lati
  rompe la parità (oltre a `R409-LEASE-005` a runtime). Rigenerare via `bin/rails runner` sul `PhaseProfile` se il
  profilo cambia.

## Disposizione client per R-code (completezza)

Il client automator (`src/lib/client.ts`) mappa gli esiti server. **Regola autoritativa di disposizione
(esaustiva per costruzione):** solo `R409-QUEUE-001`→`stale`, `R409-LEASE-001`→`held`, `4xx 422`→`invalid`; **OGNI
altro R-code raggiungibile → `error`** (il client ne fa `usage-unavailable`/fail-closed). Le righe sotto elencano
gli esiti raggiungibili noti (mirror in `fixtures/http/cases.json`); un codice futuro non elencato ricade sulla
regola catch-all → `error`, quindi la mappatura resta completa senza dover enumerare ogni codice a mano.

| endpoint | status | code | esito client |
|---|---|---|---|
| claim | 201 / 200 | — | `acquired` (fresh / replay) |
| claim | 409 | `R409-QUEUE-001` | `stale` |
| claim | 409 | `R409-LEASE-001` | `held` (payload `{data:holder,error}`) |
| claim | 409 | `R409-QUEUE-005` (ttl-mismatch) | `error` |
| claim | 409 | `R409-QUEUE-002` (limite) | `error` |
| claim | 409 | `R409-QUEUE-003` (defer attivo) | `error` |
| claim | 409 | `R409-LEASE-004` (scadenza autoritativa) | `error` |
| claim | 409 | `R409-LEASE-002` (lavorazione già rilasciata) | `error` |
| claim | 409 | `R409-LEASE-005` (drift PhaseProfile pinnato) | `error` |
| claim | 409 | `R409-LEASE-006` (run già pinnato ad altra fase) | `error` |
| claim | 403 | `R403-AGENT-006` (host non eleggibile post-selezione) | `error` |
| claim | 422 | `R422-QUEUE-001` (token) | `invalid` |
| claim | 422 | `R422-LEASE-001` (campi lease) | `invalid` |
| claim | 422 | `R422-QUEUE-002` (costo) | `invalid` |
| claim | 403 | `R403-LEASE-001` (host mismatch) | `error` |
| claim | 404 | `R404-QUEUE-001` (selezione non trovata / altra org o host) | `error` |
| claim | 401 | `R401-AGENT-001` | `error` (unauthorized recovery) |
| next | 200 | — | `candidate` / `empty` (`{data:null}`) |
| next | 403 | `R403-AGENT-006` (host non certificato) | `error` |
| next | 404 | `R404-AGENT-002` (progetto non risolvibile) | `error` |
| deferral | 201 / 200 / 4xx | vari | **server-only** (nessun metodo client oggi; CYRA-129) |

## File

`manifest.json` elenca ogni fixture e il relativo `$defs`; `SHA256SUMS` protegge lo snapshot
vendorizzato nei consumer (Rails `contracts/agent-queue/`, automator `test/contracts/agent-queue/`).
`fixtures/http/cases.json` classifica gli esiti HTTP e la disposizione client;
`fixtures/http/auth-cases.json` separa il bearer host `cyi_ah_` dal token org `cyi_a_` (rifiutato) e
copre 401 senza credenziale, 403 host-mismatch (`host_id` del body diverso dal bearer host) e
**404 anti-BOLA host-bound** su tutti i canali: `foreign-selection-{claim,deferral}` (bearer host valido +
`selection_token` emesso per un'altra org/host → `R404-QUEUE-001`) e `foreign-project-next` (bearer host valido +
`project_key` di un'altra org, l'unico input di **next** prima del token → `R404-AGENT-002`).

Per aggiornare il bundle: modificare schema/fixture, rigenerare i checksum e aggiornare la versione del
contratto nei consumer. Eseguire `python scripts/verify_agent_queue_contract.py` dalla root del
repository per verificare schema, fixture, matrice HTTP/auth e checksum prima di vendorizzare.

> **Seam CYAU-84 (applicato).** L'appiattimento delle route agent-nested → flat ha cambiato i `endpoint` in
> `fixtures/http/{cases,auth-cases}.json` (+ rigenerato `SHA256SUMS`/`LOCK`), il codice del gate `next`
> (`R404-AGENT-001` → `R403-AGENT-006`, host non certificato) e ritirato i casi anti-BOLA via `agent_id`
> (impossibili senza agent_id nell'URL; l'anti-BOLA è ora il token host-bound). I corpi (schema/fixture di
> richiesta/risposta) restano invariati. Un cambio di route È un cambio di contratto: reso visibile e deliberato.
