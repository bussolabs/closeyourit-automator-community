# Changelog

## [Unreleased]

## [0.42.0] - 2026-10-22

### Changed

- **I lavori grandi vengono riletti a pezzi.** Un lavoro troppo grande per una sola rilettura viene diviso per file e riletto un pezzo alla volta, fino a 4 MB in tutto. Passa solo se tutti i pezzi passano. Se un singolo file supera il limite, la rilettura lo dice chiaramente. (CYAU-268)

## [0.41.2] - 2026-10-20

### Added

- **Il controllo della macchina avvisa quando Codex non può raggiungere un server CloseYourIt su rete privata.** Con Codex, un server privato si raggiunge solo col suo indirizzo numerico, non col nome. Ora il controllo cerca l'indirizzo del nome configurato (al massimo per tre secondi: oltre, la ricerca viene interrotta e il controllo finisce comunque) e, se è privato, indica esattamente cosa scrivere nella configurazione; se il nome ha solo indirizzi del formato lungo, propone di dare al server un indirizzo corto oppure di far lavorare Claude. Un server indicato come `localhost` non genera avvisi. L'avviso non blocca la macchina. La guida di installazione spiega il limite. (CYAU-238)

## [0.41.1] - 2026-10-20

### Changed

- **La rilettura automatica tiene conto della risposta a un suo rilievo.** Al giro successivo chi rilegge vede i propri rilievi precedenti della stessa fase e la risposta di chi ha fatto il lavoro: ritira un rilievo solo quando una prova nelle modifiche lo smentisce. Se invece lo conferma, la sintesi consegnata mette affiancate le due posizioni, così una persona capisce il disaccordo senza aprire il codice. Senza rilievi precedenti la rilettura funziona come prima. (CYAU-237)

## [0.41.0] - 2026-10-12

### Changed

- **Le note interne del codice sono ora tutte in inglese.** Sono state tradotte le ultime note rimaste in italiano, soprattutto nelle regole di sicurezza degli agenti e in alcuni file di configurazione. Il funzionamento non cambia: i comandi vietati restano bloccati come prima, e i messaggi per le persone e per gli agenti restano gli stessi. (CYAU-215)

## [0.40.16] - 2026-10-12

### Fixed

- **La rilettura di Claude si collega con l'accesso fatto sulla macchina.** Prima, su una macchina collegata come dice la guida, la rilettura di Claude diceva «non collegato»; ora riceve solo il permesso di breve durata di quell'accesso, mentre il permesso di rinnovo resta sulla macchina. La chiave dell'organizzazione resta la prima scelta. Se l'accesso manca o è scaduto, la rilettura non parte e lo dice, e il controllo della macchina ora fallisce indicando come rimediare, anche dove Codex non c'è. (CYAU-223)

## [0.40.15] - 2026-10-12

### Fixed

- **La rilettura del lavoro non si blocca più per un falso allarme.** Un file di esempio con una variabile segreta lasciata vuota veniva scambiato per un segreto, e il lavoro restava fermo. Ora la rilettura parte. (CYAU-266)
- **Le macchine installate in modalità gestita si accendono da sole sul pannello.** Dopo la registrazione la macchina imposta e salva il proprio battito sul progetto scelto all'installazione, e quelle già installate lo sistemano al riavvio del servizio; se non ci riesce, il registro dice perché invece di tacere. (CYAU-220)

## [0.40.14] - 2026-10-10

### Changed

- **Strumenti delle macchine aggiornati.** Le macchine installano versioni più recenti di Claude Code, Codex, pnpm e GitHub CLI; l'aggiornamento le prova e torna indietro da solo se qualcosa non va.

## [0.40.12] - 2026-10-09

### Security

- **Chiusa una seconda vulnerabilità critica nella libreria che distribuisce i test su più processi.** La versione installata con la correzione precedente restava esposta a un altro difetto: la libreria, usata solo dallo strumento che esegue i test, passa alla versione successiva che lo chiude; il programma installato sulle macchine non cambia. (CYAU-231)

## [0.40.11] - 2026-10-09

### Security

- **Corretta una vulnerabilità critica nella libreria che distribuisce i test su più processi.** La libreria, usata solo dallo strumento che esegue i test, passa alla versione che chiude il difetto segnalato; il programma installato sulle macchine non cambia. (CYAU-230)

## [0.40.10] - 2026-10-09

### Fixed

- **«Già fatto» non viene più bocciato per lo stile del riassunto.** Un ticket già risolto nel codice si chiude da solo invece di fermarsi ad aspettare una persona. (CYAU-258)

### Security

- **Corretta una vulnerabilità nella libreria che legge le mappe dei sorgenti.** La libreria, usata solo dagli strumenti di sviluppo e di test, passa alla versione che chiude il difetto segnalato; il programma installato sulle macchine non cambia. (CYAU-229)

## [0.40.9] - 2026-10-09

### Security

- **Eliminata una libreria vulnerabile dagli strumenti di sviluppo.** Lo strumento che la portava con sé serviva solo a creare l'indice dei comandi nei pacchetti preparati a mano ed è stato tolto: la libreria non c'è più, il pacchetto locale continua a compilare il programma prima di crearsi, e il programma installato sulle macchine non cambia. (CYAU-218)

## [0.40.8] - 2026-10-09

### Security

- **Chiuse le ultime falle di una libreria usata dalla macchina.** Le due copie della libreria che legge i modelli di nomi di file passano all'ultima versione sicura. (CYAU-257)

## [0.40.7] - 2026-10-09

### Fixed

- **Il controllo automatico non chiede più modifiche impossibili.** Non boccia più un lavoro perché manca un passo nella verifica automatica del progetto, che la macchina non può modificare. (CYAU-256)

## [0.40.6] - 2026-10-09

### Security

- **Corretta una nuova vulnerabilità nella libreria dei modelli di nomi di file.** La libreria è aggiornata alla versione che chiude il difetto segnalato. (CYAU-213)

## [0.40.5] - 2026-10-09

### Fixed

- **I progetti senza ambiente di prova arrivano in fondo.** Il controllo automatico non scambia più per un errore un lavoro unito senza etichetta di prova, e il ticket non si blocca più dopo il rilascio. (CYAU-253)

## [0.40.4] - 2026-10-09

### Security

- **Corretta una vulnerabilità in una libreria usata dalla macchina.** La libreria che legge i modelli di nomi di file è aggiornata alla versione che corregge il difetto segnalato. (CYAU-211)

## [0.40.3] - 2026-10-09

### Fixed

- **Gli strumenti del progetto sono pronti prima che l'agente parta.** La macchina installa da sola gli strumenti che il progetto richiede, così la consegna non si ferma più perché ne manca uno. (CYAU-250)

## [0.40.2] - 2026-10-08

### Fixed

- **«Riprova» non viene più annullato dalla macchina.** Dopo «Riprova» la macchina riparte da zero con i tentativi, invece di ribloccare subito il ticket. La spesa già fatta resta nei totali. (CYAU-249)

## [0.40.1] - 2026-10-08

### Fixed

- **Consegna su GitHub con le chiavi di formato nuovo.** La macchina scartava le chiavi a tempo che GitHub emette oggi, più lunghe e con punti, e i registri non le nascondevano per intero. Ora le accetta e le copre tutte. (CYAU-248)

## [0.40.0] - 2026-10-08

### Fixed

- **Le macchine consegnano di nuovo il lavoro su GitHub.** Ogni lavorazione riceve dal server una chiave che dura un'ora e apre solo il repository del ticket. Prima il push falliva e il ticket finiva bloccato.

## [0.39.2] - 2026-10-08

### Fixed

- **Il segnale rifiutato si vede nel log.** Quando CloseYourIt rifiuta il segnale di vita, la macchina scrive una riga con il codice d'errore, e un'altra quando torna accettato. Prima la macchina sembrava accesa e il pannello la mostrava ferma. (CYAU-247)

## [0.39.1] - 2026-10-07

### Fixed

- **Nessun token esce dalla macchina.** Un push o un commento ticket che contiene una credenziale viene bloccato prima di partire, e la shell dell'agente non legge più le cartelle con i token dell'operatore. (CYAU-242)
- **La rilettura conosce le risposte e il piano.** Una scelta decisa in una risposta di chiarimento o scritta nel piano approvato non viene più respinta come scelta arbitraria. (CYAU-240)

## [0.39.0] - 2026-10-06

### Changed

- **Indirizzo predefinito app.closeyour.it.** Senza configurazione, la macchina si collega a `https://app.closeyour.it`. Le macchine già configurate su `www.closeyour.it` continuano a funzionare. (CYRA-996)

## [0.38.0] - 2026-10-06

### Added

- **Una chiave Claude per tutte le macchine.** Se l'organizzazione presta la sua chiave Claude, la macchina la scarica, la tiene nella cassaforte del sistema e la usa solo per Claude. Senza, usa il proprio accesso. (CYAU-224)
- **OpenCode rilegge il lavoro.** Quando il server lo sceglie come revisore, OpenCode rilegge con il modello e la chiave OpenRouter dell'organizzazione, senza strumenti e con rete solo verso OpenRouter. (CYAU-228)
- **Codex può fare il lavoro.** Le fasi girano anche con Codex, con le stesse protezioni di Claude. (CYRA-921)
- **Protezioni configurabili per installazione.** Ogni macchina può dichiarare i propri indirizzi di produzione e i domini ammessi nella sandbox. (CYRA-918)

### Changed

- **Il revisore lo sceglie il server.** La macchina rilegge con il motore indicato per lei, anche lo stesso che ha lavorato, in una sessione nuova. (CYAU-226)
- **Riassunti delle riletture più chiari.** Il revisore chiude con due frasi semplici. (CYRA-1003)
- **Schede di decisione fino a quattro punti.** (CYRA-998)
- **Licenza AGPL-3.0.** (CYRA-915)

### Fixed

- **Il controllo della macchina verifica tutti e due i revisori.** Codex resta sempre richiesto. (CYAU-222)
- **Il lavoro già consegnato si rilegge sulle modifiche.** (CYRA-1004)
- **Codex trovato anche se installato con npm globale.** (CYRA-921)

## [0.37.0] - 2026-10-01

### Added

- **L'automazione legge le schede di decisione.** Accetta la scheda breve di piani e consegne e le domande con due o tre risposte proposte. (CYRA-885)

## [0.36.6] - 2026-09-29

### Fixed

- **Una rilettura fallita dice perché.** Sul ticket compaiono il codice d'uscita e l'ultima riga d'errore del revisore, con i segreti oscurati. (CYRA-880)

## [0.36.5] - 2026-09-29

### Fixed

- **Un rilascio in produzione riuscito non viene più respinto.** La rilettura chiedeva il ramo, che il risultato di un rilascio non ha. (CYRA-877)
- **La Definition of Done del piano arriva leggibile.** L'agente leggeva «[object Object]» al posto dei criteri e non aveva su cosa verificarsi. (CYRA-877)

## [0.36.4] - 2026-09-29

### Fixed

- **La rilettura del lavoro parte di nuovo.** Claude e Codex si installano senza permessi di scrittura per il gruppo, che la rilettura rifiutava. `doctor` segnala il problema e il motivo vero di una rilettura mancata arriva fino al ticket. (CYRA-878)

## [0.36.3] - 2026-09-29

### Fixed

- **La rilettura del lavoro non si ferma più sui file di appoggio delle skill.** La cartella `.closeyourit/session/`, dove la skill tiene i testi della consegna, resta fuori dal controllo dei file non tracciati. (CYRA-877)

## [0.36.2] - 2026-09-29

### Fixed

- **Un rilascio riuscito non viene più respinto.** Staging e produzione consegnano un tag, non una proposta di modifica: l'host non cerca più la proposta su queste due fasi e non le fa rifare. (CYRA-876)

## [0.36.1] - 2026-09-29

### Fixed

- **Valutazione e piano leggono il codice di oggi.** Prima di queste due fasi la macchina scarica le novità e avanza la sua copia del repository, senza mai toccare modifiche locali. Prima la copia restava indietro di settimane. (CYRA-873)
- **`doctor` non dà più un falso «login scaduto».** Lanciato da una shell senza le credenziali di Claude che riceve il servizio, ora lo dice invece di far rifare un login che funziona. (CYRA-869)

## [0.36.0] - 2026-09-27

### Added

- **Il costo di ogni tentativo arriva a CloseYourIt.** Alla consegna la macchina manda quanto è costata la sessione di Claude e con quale modello. Da lì nasce il resoconto settimanale dei costi per fase e per progetto. (CYRA-872)

## [0.35.1] - 2026-09-25

### Fixed

- **Claude viene portato a una versione che conosce Opus 5.5.** La 2.1.274 lo rifiutava: ora la versione fissata è la 2.1.282, e il registro chiama questo errore «modello non disponibile per questa CLI». (CYAU-209)

## [0.35.0] - 2026-09-25

### Added

- **La macchina prova davvero Claude e Codex prima di chiedere lavoro.** Una richiesta minima ogni ora: se uno dei due non risponde, la macchina non prende ticket e il motivo compare su CloseYourIt. `automator doctor` fa la stessa prova. (CYAU-206)
- **Dopo una rilettura mancata la macchina si ferma subito se un runtime è rotto.** Al giro dopo riprova Claude e Codex invece di fidarsi della prova dell'ultima ora: al massimo un ticket perso, non una giornata. (CYAU-208)
- **Claude e Codex si aggiornano insieme all'automator.** Le loro versioni sono fissate nella release: `update` le installa, le prova e, se qualcosa non va, torna a quelle di prima e lo segnala su CloseYourIt. (CYAU-209)

### Changed

- **Il registro dice perché la rilettura non c'è.** Invece del solo `review=unavailable` la riga porta il motivo, per esempio «codex: autenticazione scaduta o revocata», e lo stesso motivo arriva a CloseYourIt. (CYAU-207)

## [0.34.0] - 2026-09-24

### Changed

- **Il modello non cambia più da solo.** Il lavoro usa sempre Claude Opus 5.5 e la rilettura di Codex usa sempre GPT-6 Astra. Prima valeva il modello predefinito di ciascuna CLI, che cambiava a ogni loro aggiornamento. Serve Codex 0.156.1 o successivo. (CYAU-203)

## [0.33.1] - 2026-09-23

### Fixed

- **Esce davvero la 0.33.0.** Il suo pacchetto non era stato pubblicato per un errore nel rilascio: questa versione porta le stesse novità.

## [0.33.0] - 2026-09-23

### Added

- **La macchina si aggiorna da sola.** Ogni ora controlla se c'è una versione nuova e la installa, ma solo quando non sta lavorando: un lavoro in corso non viene mai interrotto. Se l'aggiornamento non riesce, l'avviso compare su CloseYourIt. (CYAU-202)

### Fixed

- **I piani non vengono più rifatti per un dettaglio.** Il revisore respinge solo per un requisito scoperto, un rischio su dati o sicurezza, o un risultato fuori formato. Il resto diventa una nota che leggi quando approvi il piano. (CYAU-201)

## [0.32.3] - 2026-09-14

### Fixed

- **Nessun comando che scarica codice dalla rete può più bloccare il servizio.** Un server che accettava la connessione e poi taceva fermava tutto, senza limite di tempo. Ora ogni comando ha un tetto e fallisce invece di restare appeso. (CYAU-199)
- **I controlli automatici tornano a girare su ogni proposta di modifica.** Le verifiche erano ferme e le modifiche passavano senza prova. Ora ogni proposta viene controllata prima di essere unita. (CITM-8)

## [0.32.2] - 2026-09-03

### Fixed
- **Il registro non dice più «esito non letto» dopo ogni consegna riuscita.** La risposta del server
  veniva cercata un livello più in basso di dov'è, quindi non si trovava mai: ogni consegna accettata
  risultava illeggibile e il controllo «conclusa solo se lo dice il server» non ha mai potuto funzionare.
## [0.32.1] - 2026-09-03

### Sicurezza
- **Chiusa una falla in una libreria di sviluppo.** Il componente che controlla i formati durante le
  prove si appoggiava a una versione che poteva essere ingannata su quale indirizzo stesse leggendo.
  Non arriva mai sulle macchine che lavorano i ticket, ma ora è aggiornato lo stesso.

## [0.32.0] - 2026-09-03

### Changed
- **Lo stato dei chiarimenti si legge solo dal servizio.** L'host non ricava più dal testo dei commenti se
  serve una risposta: lo chiede al servizio. Se non riesce a chiederlo, il ticket aspetta invece di ripartire
  come se nessuno avesse chiesto niente.

### Fixed
- **I risultati di triage e rilascio nel nuovo formato non vengono più scartati.** Con il formato più
  recente l'host li dichiarava illeggibili e la lavorazione tornava in coda a vuoto. Ora legge tutte
  le fasi, e un motivo di blocco fuori elenco viene fermato prima di consegnare.

## [0.31.2] - 2026-09-02

### Fixed
- **Un risultato scritto male arriva comunque sul ticket.** Quando il modello non rispettava il formato
  del risultato, la macchina lo scriveva solo nel proprio registro e sul ticket non arrivava niente. Ora
  consegna un blocco con il motivo, e il ticket lo mostra.

## [0.31.1] - 2026-09-02

### Fixed
- **Il commit nella sessione ha sempre un'identità.** Le sessioni non leggono la configurazione
  git della macchina, e il commit falliva con «Author identity unknown» a meno che il modello non
  se ne inventasse una. Ora la sessione ha la stessa identità fissa dei comandi git dell'host.

## [0.31.0] - 2026-09-01

### Added
- **Il piano può portare un riassunto per chi approva.** Il risultato della pianificazione accetta
  un campo facoltativo con poche frasi in linguaggio semplice; i planner non aggiornati consegnano
  come prima. Riallineata anche la copia locale del contratto, che era rimasta indietro di uno stato.

## [0.30.1] - 2026-08-31

### Fixed
- **Il rilascio non inciampa più sui propri test di consegna.** Le prove della consegna non
  dichiaravano l'elenco delle anomalie, che dalla 0.30.0 è obbligatorio, e il rilascio si fermava
  sui suoi stessi controlli. La 0.30.0 esiste come etichetta ma non è mai stata pubblicata.

## [0.30.0] - 2026-08-31

### Fixed

- **La rilettura funziona anche quando gli strumenti sono installati tramite mise.** Prima l'automator
  seguiva il collegamento fino in fondo e lanciava mise con gli argomenti dello strumento: la rilettura
  moriva in un decimo di secondo e ogni consegna veniva rifiutata (95 su 96 tentativi). Ora si esegue
  il collegamento col suo nome e si continua a verificare il binario reale.

### Changed

- **Una consegna senza la dichiarazione delle anomalie di sicurezza non parte.** L'elenco vuoto resta la
  risposta legittima («ho guardato, niente da segnalare»); il campo assente — che in trenta giorni di
  prova è stato l'unico caso, 1457 volte su 1457 — ora viene fermato prima di consegnare, quando
  l'agente può ancora rimediare.

## [0.29.2] - 2026-08-30

### Fixed

- **Un lavoro che conclude «non c'è codice da scrivere» viene consegnato invece che rifiutato.** Prima gli si
  chiedeva comunque di far rileggere delle modifiche che non esistono, la rilettura falliva e il giudizio —
  corretto — non arrivava mai. Vale anche per il lavoro già consegnato da una sessione precedente. Chi ha
  scritto codice davvero passa ancora dalla rilettura piena.

## [0.29.1] - 2026-08-30

### Fixed

- **Un risultato rifiutato finisce nel registro per intero.** Prima se ne conservavano solo l'inizio e la
  fine, e il centro — dove sta il resoconto del lavoro — veniva buttato: proprio la parte che spiega
  perché è stato rifiutato. Il tetto contro gli output enormi resta.

## [0.29.0] - 2026-08-28

### Added

- **Chi pianifica può dire che il lavoro era già fatto.** Il risultato della pianificazione accetta l'esito
  «già fatto», con il riassunto e almeno un file che lo prova: il server chiude il ticket senza che nessuno
  debba approvare un piano per un lavoro che esiste già. Resta distinto da «già consegnato», che dice invece
  che una sessione precedente aveva aperto la proposta.

- **La rilettura incrociata sa cosa chiedere a quell'esito.** Senza un criterio suo, chi rilegge cercherebbe
  un piano che per contratto non esiste e boccerebbe un risultato sano — e un risultato bocciato non viene
  applicato, quindi il ticket tornerebbe in coda a farsi ripianificare all'infinito. Al reviewer si chiede
  invece di pretendere prove puntuali: è l'unico esito che chiude un ticket.

## [0.28.0] - 2026-08-25

### Removed

- **Automator ora gira soltanto su Linux.** Rimossi LaunchAgent, Keychain, sandbox e updater specifici Apple,
  insieme alla matrice macOS della release. Bootstrap, servizio, daemon, registrazione host e heartbeat rifiutano
  qualunque altro sistema prima di eseguire lavoro.

### Changed

- **Piani, consegne ed errori arrivano come un pacchetto leggibile.** Planner e Autopilot conservano interventi, prove per criterio, rilievi della revisione e azione richiesta in caso di blocco. Il vecchio formato resta accettato durante il passaggio.

- **I prerequisiti del worker sono un contratto verificato.** Installazione, doctor e gate di pubblicazione
  richiedono systemd ≥254 con user manager, cgroup v2, bubblewrap e Secret Service raggiungibile. Ticket e azioni
  skill richiedono sempre containment forte e non degradano più al solo process group.

- **Pacchetto e documentazione dichiarano Linux `x64`/`arm64`.** Lo smoke di release usa un unico artifact su
  runner Linux e resta obbligatorio prima della pubblicazione.

## [0.27.0] - 2026-08-24

### Removed

- **Via la scelta automatica fra i due motori, e i calcoli che nessuno leggeva più.** La macchina classificava il ticket, decideva se spezzarlo e sceglieva da sé quale motore usarlo: tre decisioni che ormai prende il sistema centrale, che le pubblica insieme all'incarico. Restavano lì a girare a ogni ticket senza che il risultato finisse da nessuna parte. Tolte, insieme ai tre comandi da riga di comando che le esponevano: quasi tremila righe in meno e nessuna funzione persa.

### Fixed

- **Due lavorazioni sullo stesso progetto non si pestano più i dati di prova.** Giravano le prove sugli stessi database: la seconda trovava le tabelle della prima e la suite cadeva per un motivo che col ticket non c'entrava niente. Adesso ogni lavorazione porta con sé uno spazio dati suo, ricavato dal codice del ticket, sia nella sessione che lavora sia nei controlli di qualità.

### Changed

- **Lo stato di una domanda in attesa si chiede al sistema, non alla discussione.** La macchina leggeva un marcatore nascosto in fondo ai commenti e provava a indovinare: bastava che fosse il sistema stesso a scriverci una riga qualsiasi perché venisse scambiata per una risposta, e il ticket ripartisse senza che avesse risposto nessuno. Adesso lo chiede a chi lo sa. La lettura dei commenti resta come ripiego e scatta solo se il comando non esiste; se lo stato non si riesce a leggere la macchina lascia il ticket dov'è e riprova più tardi, invece di dichiarare che si può lavorare.

- **Il numero della versione arriva con l'incarico: la macchina non se lo sceglie più.** Prima guardava l'ultimo numero uscito e decideva da sé quale cifra cambiare, e due lavorazioni partite vicine potevano scegliere lo stesso nome. Adesso il numero lo assegna il sistema quando consegna il lavoro e la macchina lo riceve insieme al piano approvato: un numero fuori forma viene scartato invece di essere usato lo stesso.

## [0.26.0] - 2026-08-22

### Changed

- **La macchina dichiara l'impronta del codice che ha davvero in mano.** Finendo un lavoro diceva «il lavoro è qui» e allegava un indirizzo, e nessuno controllava che dietro quell'indirizzo ci fosse proprio il codice appena scritto. Capita che la macchina scriva, salvi, e la spedizione verso GitHub non riesca fino in fondo: l'indirizzo esiste, la pagina si apre, i controlli automatici sono verdi — ma mostrano il lavoro com'era prima dell'ultimo pezzo, e chi approva non ha modo di accorgersene. Ora la consegna porta anche l'impronta esatta del codice, **misurata** sulla copia di lavoro del ticket con una lettura diretta e non scritta a parole dall'agente. Si misura sulla copia di lavoro del TICKET, mai sulla cartella da cui gira il servizio: quella con il lavoro non c'entra niente. Quando non si può misurare, il campo non c'è: una sigla sbagliata è peggio di una sigla assente, perché passerebbe i controlli.


- **La macchina riceve il vincolo deciso da una persona, e senza quello non parte.** Quando approvi un piano decidi due cose: dove può nascere il lavoro e qual è la prova che dirà «finito». Nessuna delle due arrivava alla macchina: riceveva il piano scritto a parole e il testo del ticket, e da lì deduceva da sé dove aprire la proposta di modifica, da quale punto partire e quando dirsi finita. Se sbagliava posto nessuno se ne accorgeva fino alla consegna — lì il lavoro veniva rifiutato, ma il giro era già stato pagato per intero: analisi, scrittura del codice, proposta aperta. Ora quelle decisioni arrivano nella parte del messaggio che la macchina è obbligata a rispettare, scritte come un limite («puoi produrre solo questo, qualunque altra cosa verrà rifiutata») e mai come un ordine su cosa fare; e la prova le è data come «osservala e riporta le coordinate», non come «dichiara l'esito», perché chi esegue non è chi giudica. Non le può cambiare chi scrive il ticket e non le può scegliere la macchina: arrivano con la forma controllata carattere per carattere, e un pezzo fuori forma fa cadere il vincolo intero invece di essere ripulito e usato lo stesso. Se il vincolo non arriva, la lavorazione non parte affatto: il ticket torna nella coda con scritto quale pezzo manca, e non dichiara di aspettare una tua decisione — non c'è niente da decidere, manca un dato. Le fasi che leggono soltanto (l'analisi iniziale e la stesura del piano) restano come prima: non toccano il codice e un vincolo non ce l'hanno.

## [0.25.0] - 2026-08-21

### Fixed

- **Chi rilegge il lavoro della macchina adesso guarda il codice, e dice quale codice ha guardato.** Prima che un lavoro arrivi davanti a chi approva, un secondo assistente lo rilegge. Ma quello che rileggeva riceveva soltanto il rapporto scritto dal primo: poche righe di testo, nessuna riga di programma — e il suo era il giudizio che arrivava al sistema e decideva se il lavoro andava avanti. Sbagliava in tutte e due le direzioni: un lavoro sbagliato poteva passare perché il rapporto era scritto bene, e un lavoro sano veniva respinto perché il rapporto era scarno. Ora, sulla fase che scrive il programma, a rileggere è chi apre davvero le modifiche, e il suo giudizio parte accompagnato dall'impronta esatta di ciò che ha letto: se qualcosa tocca il lavoro dopo quella lettura l'impronta non torna e la consegna non passa per buona. Sulle due fasi che uniscono e rilasciano resta la lettura del rapporto, ma non le si chiede più di pretendere «le prove eseguite e i file toccati»: quelle fasi non scrivono programma e non eseguono prove, e il lavoro veniva respinto per prove che non poteva portare — così il rilascio in produzione non partiva. Le si chiede invece quello che un rilascio può davvero mostrare: quale versione, quale punto del programma, quale ramo. Quanto a fondo rileggere non lo sceglie più la macchina: glielo dice il sistema quando le assegna il lavoro, e la macchina lo dichiara su ogni consegna. Una rilettura che non si è potuta fare non ferma più la lavorazione in casa: parte lo stesso dicendo che non c'era, e a decidere è il sistema.

## [0.24.0] - 2026-08-21

### Added

- **La macchina conosce la casella delle anomalie di sicurezza, e la controlla prima di consegnare.** Chi lavora un ticket può segnalare quello che ha notato di storto passando — uno script che va a leggere le password salvate, una chiave d'accesso dentro un indirizzo — e chi approva lo vede in cima al ticket. Finora quella casella non esisteva da questa parte: qualunque cosa ci finisse dentro partiva verso il sistema centrale senza che nessuno la guardasse. Ora la forma si controlla qui, che è la prima barriera: se è sbagliata la consegna non parte, e chi ha lavorato può ancora rimediare invece di scoprirlo a lavoro consegnato. Un elenco vuoto è ammesso di proposito ed è una risposta — «ho guardato e non ho trovato niente» — diversa dal non dire niente. La gravità resta una parola libera: chiuderla in un elenco farebbe perdere l'intera consegna per un termine inventato.

- **Un rilascio che non dice su quale codice è stato fatto non parte più dalla macchina.** Il resoconto scriveva solo il numero della versione: «rilasciato v1.4.0», mai su quale fotografia di codice. Fra il momento in cui il lavoro viene approvato e quello in cui parte il rilascio possono passare ore, e nel frattempo il codice può cambiare: senza quella riga nessuno può tornare indietro a controllare che ciò che è uscito sia ciò che era stato guardato, e resta la parola della macchina. Ora la macchina se ne accorge da sé, prima di spedire il resoconto, così chi ha rilasciato lo scopre subito invece che a rilascio già fatto. Un caso resta com'era, ed è voluto: quando il rilascio si ferma, il resoconto viene accettato senza numero e senza sigla, perché lì conta il motivo.

### Changed

- **Davanti a un «no» della rilettura, la macchina non rifà più il lavoro da sola.** Quando finisce un pezzo di lavoro lo consegna al sistema, che prima di accettarlo pretende che un secondo controllo automatico l'abbia riletto e approvato. Se quel controllo chiedeva modifiche, la macchina rifaceva tutto da capo, subito — e quella seconda volta era buttata per intero: il sistema chiude il giro nel momento stesso in cui dice no, quindi la riconsegna si sentiva rispondere che era già registrata. Nel frattempo il sistema aveva già rimesso il ticket in fila, ma non poteva darlo a nessun altro finché la macchina non mollava la presa: il ticket restava fermo per tutto il tempo del secondo lavoro inutile. Ogni «no» costava una sessione intera in più e il tempo di farla, per niente — e non è un caso raro: nella giornata che fece nascere quel comportamento, su 67 sessioni 20 consegne furono rifiutate proprio così. Ora la macchina scrive nel suo registro il no e il motivo, e si ferma. Chi decide se riprovare è il sistema, che è l'unico a tenere il conto vero: rimette il passaggio in fila se c'è ancora margine, e alla seconda bocciatura di fila ferma la lavorazione e chiama una persona. Prima i conti erano due, uno per parte, e non dicevano la stessa cosa. Nessuna schermata cambia: cambia quanto si spende e quanto si aspetta su ogni ticket che riceve un no. C'è un costo, e va detto: il tentativo successivo riparte senza sapere cosa gli era stato contestato — anche prima quel testo si perdeva a ogni riavvio, e farglielo arrivare è un lavoro a parte.

## [0.23.0] - 2026-08-21

### Changed

- **Le verifiche complete si fanno una volta sola, sulla proposta esatta che verrà revisionata.** Un progetto
  può ora dichiarare un quality gate versione 2: il worker esegue i controlli locali rapidi, mentre la suite
  completa resta su GitHub Actions. La proposta nasce draft; l’Automator controlla progetto, branch e commit,
  aspetta per nome i check obbligatori, avvia la rilettura incrociata e la rende pronta soltanto se tutto è verde
  sullo stesso commit. Un check assente, rosso, troppo lento o illeggibile non viene scambiato per un via libera.
  La lavorazione locale diventa conclusa solo dopo che il server ha davvero accettato la consegna.

### Fixed

- **Un valore che il sistema non conosce viene fermato sulla macchina, non a metà consegna.** Quando una macchina dichiara di non poter andare avanti, dice anche perché: «serve una persona» oppure «non sono riuscito a guardare». Sono due cose diverse e portano a due esiti diversi — la prima ferma il lavoro e chiama qualcuno, la seconda lo rimette in coda e riprova da sola. Il programma sulla macchina quel campo non lo conosceva: qualunque parola ci finisse dentro partiva verso il sistema centrale, che la scartava. Il risultato era un tentativo bruciato per una parola sbagliata, e nessuno che dicesse quale. Ora la macchina conosce le due parole ammesse e si ferma prima di spedire, dicendo cosa ha trovato al posto loro. Nella stessa occasione le tre copie del contratto — sistema centrale, macchina, documentazione — sono tornate identiche una all'altra: il segnalibro che le lega dichiarava un codice che non esisteva in nessuna storia, e nessuno se ne accorgeva perché ogni copia veniva confrontata solo con se stessa.

- **Un indirizzo di proposta che GitHub non potrebbe aver prodotto non passa più.** Quando una macchina finisce un lavoro dice al sistema dove guardare, scrivendo l'indirizzo della proposta di modifica che ha aperto. Di quell'indirizzo si controllava quasi niente: bastava che cominciasse per «https» e finisse con la parola «pull» e un numero. Sono state provate sette forme inventate — una senza il nome del proprietario e del progetto, una con dentro nome utente e password, una col numero zero, una col numero scritto 007, una con la parola «pull» nascosta in mezzo a un percorso più lungo, una con caratteri codificati al posto del nome del progetto, e un sito qualunque che si incolla dentro il proprio indirizzo un vero indirizzo GitHub — e passavano tutte e sette. Ora passa solo la forma che GitHub produce davvero, e soprattutto a giudicare è **una** regola. Dentro la macchina ce n'erano due, una severa e una larga, e il sistema centrale usava proprio quella larga: quando due parti giudicano in modo diverso capita che il lavoro venga fatto per intero e poi buttato al momento della consegna, perché una accetta quello che l'altra rifiuta. Non c'è niente di nuovo da vedere e nessun pulsante cambia: è una protezione, e serve a un lavoro che viene dopo — il sistema andrà ad aprire quella proposta con i propri occhi, per leggere il codice esatto e l'esito dei controlli, e se l'indirizzo non ha una forma che si può aprire quel controllo non parte nemmeno. Una cosa va detta chiara, perché è facile fraintenderla: questo non rende l'indirizzo *vero*. Un indirizzo scritto benissimo ma di un progetto che non c'entra niente continua a passare, e a fermarlo è un altro lavoro, quello che confronta la proposta con i progetti approvati. Qui si toglie soltanto lo spazio agli indirizzi che GitHub non avrebbe mai potuto produrre. Le installazioni GitHub Enterprise restano servite: nessuna lista di siti ammessi.

- **Il programma che guida la macchina non sposta più lo stato del ticket.** A fine lavoro il ticket finiva su «Da revisionare» per mano di tre attori diversi — il manuale che la macchina segue, il programma installato sulla macchina, e il sistema centrale quando registra la consegna — e nessuno dei tre sapeva degli altri. Sta per entrare una regola che vieta di spostare lo stato dal terminale mentre una lavorazione è in corso, ed è esattamente da lì che lo spostava il programma: il giorno che entra in funzione, ogni consegna di ogni macchina si fermerebbe all'ultimo passo, con il codice già mandato e la proposta già aperta, ma il sistema centrale mai avvisato che il lavoro c'è. La lavorazione resterebbe appesa, dopo qualche ora verrebbe dichiarata abbandonata e il ticket rifatto da capo: ore di lavoro pagate e buttate, su ogni ticket e su ogni macchina. Ora il programma fa solo il suo mestiere — manda il codice, apre la proposta, scrive sul ticket l'indirizzo della proposta — e lo stato lo decide un posto solo. Sparisce con lui un secondo guaio già presente oggi: per spostare lo stato il programma doveva prima indovinare da solo quale fosse lo stato «da revisionare» dell'organizzazione, e pretendeva che ce ne fosse esattamente uno; con due si fermava con un errore, e si fermava **prima** di mandare il codice, buttando una sessione già pagata per intero. Chi lancia la consegna a mano deve sapere una cosa: **il comando `deliver` ha perso il parametro `--review-status-id`, che prima era obbligatorio**, e chi continua a passarlo riceve un errore. Non serve più: era il numero dello stato «da revisionare» che il programma doveva indovinare per poterlo applicare, e ora da qui non lo applica più nessuno. Alla macchina viene inoltre messo un fermo: se l'agente prova a spostare lui lo stato o ad approvare il proprio lavoro, il comando viene rifiutato prima di partire. Restano permesse le cose che deve poter fare — leggere l'elenco degli stati, leggere il ticket, scriverci un commento. Una cosa peggiora, ed è giusto saperlo: lo spostamento fatto dal terminale lasciava una riga nella cronologia, mandava un avviso a chi segue il ticket e faceva muovere la scheda sulla lavagna da sola; quello fatto dal sistema centrale cambia lo stato in silenzio. Il ticket arriva lo stesso in «Da revisionare» e compare lo stesso nella pila delle cose da approvare — quella pila si riempie in base alla consegna, non allo stato — ma l'avviso non parte e la scheda non si muove finché non si ricarica la pagina. È un passo indietro da chiudere sul sistema centrale, non qui.

- **Il rosso torna a voler dire rosso: una lavorazione consegnata e accettata non fa più suonare l'allarme.** Ogni lavorazione automatica che scrive codice avveniva in due tempi. Nel primo la macchina faceva il lavoro seguendo le istruzioni ufficiali, eseguiva le verifiche previste dal progetto, mandava la proposta di modifica e comunicava il risultato al sistema, che lo accettava. Nel secondo faceva un controllo tutto suo — che non partiva nemmeno: la macchina non sa quali verifiche esistano su quel progetto e, invece di dirlo, scriveva nel proprio diario una verifica «fallita» che nessuno aveva eseguito, segnava la lavorazione come bloccata e dichiarava guasto tutto il giro. Il risultato era un battito rosso su **ogni** lavorazione, comprese quelle andate benissimo: e quando la spia è accesa sempre, un guasto vero non si distingue più da un falso allarme. Ora quando l'esito della fase è di competenza del sistema, il ciclo locale registra il punto della sessione e chiude: niente secondo controllo, niente rilettura, niente consegna doppia. Nel diario non compare più una verifica fallita che nessuno ha eseguito, ma il fatto vero — su questo progetto quel controllo non si applica.

- **La protezione dei controlli era dichiarata e mai accesa.** La macchina tiene una copia di riferimento delle verifiche da eseguire sul proprio codice, per accorgersi se qualcuno le indebolisce dentro il ramo di lavoro. Quella copia era agganciata a un nome di progetto che non esiste, quindi il confronto non avveniva mai — su nessun progetto, nemmeno su quello che avrebbe dovuto proteggere. Ora è agganciata al nome vero, e il confronto si fa **prima** che la sessione parta: se i controlli sono stati indeboliti la lavorazione si ferma subito e lo dice, invece di accorgersene a lavoro già consegnato, quando non serve più a niente. Dichiarare i controlli nel ramo resta facoltativo: quello che non si può è indebolirli.

- **Il registro della macchina scrive quello che il sistema ha deciso, non quello che ha risposto la rete.** Quando una macchina finisce un passaggio e consegna il risultato, scriveva nel proprio registro «consegnata, conclusa» solo perché la connessione aveva risposto «ricevuto». La risposta del sistema conteneva già la sua decisione, e la macchina la buttava senza leggerla: nel registro non entrava una parola di quelle che il sistema aveva detto. Oggi le due cose coincidono, ma per fortuna, non per controllo — il sistema chiude il tentativo nello stesso istante in cui accetta la consegna, quindi nessuno se ne accorge. Smetteranno di coincidere il giorno in cui il sistema imparerà a rispondere «accettata, sto ancora guardando», che è la risposta che gli serve appena, prima di dire fatto, andrà ad aprire la proposta di modifica, leggere i controlli e aspettare di vedere il rilascio in piedi. Quel giorno la macchina avrebbe continuato a scrivere la riga verde, e chi apre il registro per capire perché una lavorazione è ferma ci avrebbe trovato scritto che è andata a posto — cercando il guasto dalla parte sbagliata. Ora il registro ha tre righe possibili: «conclusa» solo quando è il sistema a dirlo con le sue parole, «accettata, esito non ancora deciso» in tutti gli altri casi, e «consegnata, esito non letto» quando la risposta arriva ma non è leggibile — e quest'ultima dice anche, in chiaro, che non serve nessuna azione da parte di una persona. La regola è al contrario di come verrebbe naturale: si scrive «conclusa» solo davanti a una parola precisa, e qualunque altra risposta — comprese quelle che oggi non esistono ancora — finisce fra le non concluse.

- **Una macchina rimasta indietro non prende più lavoro, e dice quale manuale sta eseguendo.** Le macchine seguono un manuale di istruzioni, e il server dichiara quale versione è quella buona. Finora, prima di prendere in carico un ticket, si verificava soltanto che il manuale *ci fosse* — non che fosse quello giusto. Una macchina con la sincronizzazione rotta in silenzio continuava a lavorare con istruzioni vecchie, consegnava risultati prodotti da quelle, e il server li accettava tutti: il risultato non dice da quale manuale viene. L'unico segnale era una riga nel registro locale della macchina, che nessuno legge. Ora prima di ogni presa in carico la macchina confronta il commit del manuale che esegue con quello pinnato dal server, e si ferma se non combaciano — con tre motivi distinti, perché sono tre guasti diversi da riparare: il manuale è disallineato, non è leggibile, oppure il server non ha risposto. E nel battito che ogni macchina manda al pannello ora c'è anche il manuale, con la sua impronta: prima si vedevano nove strumenti e il manuale non era fra loro, quindi dal pannello nessuno poteva sapere se una macchina stesse lavorando con le istruzioni giuste o con quelle di tre settimane fa.

## [0.22.0] - 2026-08-17

### Changed

- **Una macchina lavora più ticket dello stesso progetto insieme**: il numero massimo di lavorazioni in
  parallelo era già impostabile, ma con un progetto solo restava sulla carta — la macchina ne prendeva uno per
  giro e i posti liberi restavano vuoti, perché due richieste di lavoro vedevano lo stesso ticket in cima e una
  sola lo otteneva. Ora la macchina chiede lavoro in un colpo solo e il sistema le assegna un ticket diverso
  ogni volta: i posti si riempiono davvero, anche su una coda sola. Il giro resta comunque limitato al numero di
  posti — la coda non viene svuotata tutta in una volta. Chiedere un ticket ora lo impegna già dall'inizio:
  perciò se non è lavorabile (già chiuso, troppi tentativi) viene lasciato subito invece di restare bloccato
  fino alla scadenza, la coda smette di dare lavoro fino al giro dopo, e una macchina che non è in condizione di
  lavorare non chiede niente, così non impegna ticket che non può portare avanti. Ogni lavorazione ha il proprio
  registro, col codice del ticket nel nome. Se il collegamento al sistema non c'è, tutto funziona come prima.

### Fixed

- **Una cartella di lavoro in uso non viene più ripulita da sotto**: una cartella è stata rimossa mentre ci
  girava una verifica, e la verifica è morta a metà scrivendo su un percorso sparito. La rimozione era
  legittima — quel lavoro risultava già integrato — ma «già integrato» non vuol dire «nessuno ci sta lavorando
  adesso». Ora, per tutto il tempo delle verifiche, la cartella porta un cartellino che dice chi la sta usando e
  da quando, con il ticket in lavorazione; il cartellino viene tolto appena le verifiche finiscono, anche se
  falliscono, sforano il tempo massimo o vengono interrotte. Chi fa pulizia lo legge e salta quelle cartelle. Se
  il programma che lo aveva messo non esiste più, il cartellino non vale: una cartella non resta bloccata per
  sempre dopo un blocco improvviso. Non si perde nulla e non cambia nulla di ciò che le verifiche fanno: il
  cartellino avvisa e basta, e se non può essere scritto le verifiche partono lo stesso.

## [0.21.0] - 2026-08-16

### Added

- **Le macchine dicono quando stanno lavorando su istruzioni vecchie**: quando si pubblica una nuova versione
  delle istruzioni, il segnalibro che indica alle macchine quale versione usare può restare indietro, e finora
  nulla lo segnalava — la pubblicazione sembrava riuscita e le macchine continuavano con la versione
  precedente. Ora ogni macchina confronta da sé il segnalibro con le versioni davvero pubblicate: se è rimasto
  indietro lo scrive nei propri registri, nella preparazione guidata e nel comando che sincronizza le
  istruzioni, dicendo quale versione sta usando e quale c'è già. Se il controllo non riesce — per esempio
  quando l'elenco delle versioni non è raggiungibile — lo dice anch'esso, invece di tacere come se fosse tutto
  a posto. Il controllo non cambia il lavoro in corso, ha un tempo massimo e viene rifatto più tardi.

### Fixed

- **I segreti di produzione non passano più all'automazione**: la regola che vieta di lavorare con i segreti di
  produzione conosceva solo il vecchio strumento e una sola forma del nuovo. Bastava scrivere il comando in un
  altro modo — il nome lungo del programma, l'ambiente abbreviato, o la richiesta di leggere e scaricare un
  singolo segreto — e nessuno lo fermava: i valori finivano nell'ambiente di un'automazione che gira senza
  chiedere conferma. Ora il permesso è rovesciato: si passa solo dagli ambienti di lavoro dichiarati, e
  qualunque altra scrittura dell'ambiente viene rifiutata anche quando non si capisce cosa indichi. Dei comandi
  sui segreti resta il solo elenco dei nomi, che non mostra alcun valore: gli altri venivano lasciati passare
  perché non nominano l'ambiente, pur toccando anche quello di produzione. Il controllo vale sia nelle azioni
  della macchina sia dentro le sessioni degli agenti; la consultazione di errori e registri non cambia.

- **La credenziale del nuovo strumento sparisce dai registri**: la pulizia dei registri conosceva il nome della
  vecchia credenziale e non quello in uso oggi, che poteva quindi restare scritta in chiaro. Ora l'elenco delle
  credenziali da nascondere è uno solo, condiviso: qualunque credenziale gestita viene oscurata, anche quando
  arriva spezzata a metà.

## [0.20.0] - 2026-08-15

### Fixed

- **Una lavorazione aperta accanto a un progetto non impedisce più di collegarlo**: le cartelle di lavoro
  isolate ora stanno accanto al progetto, non più nascoste dentro. Da lì però sono visibili, e siccome
  puntano allo stesso progetto la macchina ne vedeva due copie: si fermava e chiedeva a mano quale fosse
  quella buona, ogni volta che una lavorazione era in corso. Ora `automator link` guarda solo il progetto
  vero e salta le cartelle di lavoro, aperte o no.

- **Un difetto nei controlli iniziali dell'aggiornamento non blocca più l'aggiornamento stesso**: i controlli
  che l'aggiornamento fa prima di partire venivano eseguiti dalla versione già installata. Se il difetto stava
  proprio lì, pubblicare una versione corretta non serviva a niente — la macchina continuava a fallire allo
  stesso modo e bisognava disinstallare e reinstallare a mano. Ora, quando un controllo blocca, il messaggio
  dice anche cosa fare; e con `automator update --skip-service-preflight` la versione nuova viene installata
  senza passare da quei controlli e senza toccare il servizio. Subito dopo basta rilanciare `automator update`:
  gira già la versione nuova, che rimette in ordine il servizio da sola.

- **Un ticket già risolto a mano non viene più ripreso, e nessun ticket viene ritentato all'infinito**:
  se una persona sistemava un ticket mentre era in coda, la macchina non se ne accorgeva e ricominciava
  da capo ogni volta — in un caso reale ci ha provato 31 volte, spendendo cinque dollari. Ora, prima di
  iniziare, guarda se il lavoro risulta già concluso e in quel caso passa oltre. In più tiene il conto
  dei tentativi fatti su ogni ticket: dopo cinque giri consecutivi senza avanzare si ferma, lo scrive
  come commento sul ticket e chiede che ci guardi una persona. Se invece il lavoro va avanti, il conto
  riparte. Quanto è costato ogni ticket si vede con `automator activity`, anche dopo che il ticket è
  stato chiuso.

## [0.19.0]

### Security

- **Chiuse le ultime quattro segnalazioni di sicurezza sulle librerie di appoggio**: restavano aperte
  quattro correzioni note su librerie usate indirettamente — quelle che espandono i nomi dei file,
  generano identificativi, preparano i fogli di stile e costruiscono il codice per le prove. Ora sono
  tutte alla versione che le chiude. Nessun cambiamento in quello che la macchina fa.

## [0.18.0]

### Changed

- **Le domande di chiarimento le pubblica chi le raccoglie**: prima era questa macchina a scrivere il
  commento con le domande, e il testo che ne usciva veniva rifiutato perché troppo lungo — la domanda
  non arrivava a destinazione e la lavorazione restava ferma senza che si capisse perché. Ora le
  domande nascono dove vengono raccolte e questa parte si limita a leggerne lo stato: se una risposta
  è arrivata riprende, altrimenti lascia il posto libero e passa al lavoro successivo.

### Security

- **Sei librerie aggiornate per altrettante segnalazioni di sicurezza**: lo strumento con cui girano
  le prove automatiche e cinque librerie usate indirettamente contenevano difetti già noti e già
  corretti a monte. Ora sono tutte alla versione che li chiude, senza cambiare nulla di quello che
  la macchina fa.

### Fixed

- **Le prove automatiche non raccolgono più le copie di lavoro**: quando sul computer restavano
  aperte lavorazioni parallele, le loro copie venivano incluse nel giro di prove e il risultato
  diventava illeggibile. Ora restano fuori. Le prove che leggono e scrivono davvero su disco hanno
  anche più tempo per finire: prima venivano interrotte a metà su una macchina occupata, e un
  fallimento del genere non diceva niente di vero sul codice.

## [0.17.0]

### Added

- **Il pianificatore può dire «questo qui non si può fare»**: se un lavoro non è pianificabile sul
  progetto a cui è arrivato, prima non c'era modo di dirlo — si finiva per produrre un piano
  qualsiasi oppure per restare bloccati in silenzio. Ora quel caso si dichiara apertamente e viene
  registrato; la revisione incrociata non pretende più un piano da chi ha già detto di non poterlo
  fare, e la coda passa al lavoro successivo invece di insistere sullo stesso.

### Fixed

- **Le librerie scaricate non finiscono più dentro il lavoro consegnato**: preparando la copia di
  lavoro, i file prodotti dall'installazione delle librerie venivano raccolti insieme alle modifiche
  vere. Una volta è successo con 15.608 file e 372 MB: la consegna diventava impubblicabile e il
  lavoro vero risultava illeggibile in mezzo al resto. Ora quei file sono esclusi alla radice, per
  qualunque assistente, e un salvataggio comunque troppo grosso viene fermato prima di essere
  registrato, non dopo.

## [0.16.7]

### Fixed

- **Ogni lavorazione parte dal codice aggiornato**: la copia di lavoro per un ticket nasceva dalla fotografia del progetto che la macchina aveva in casa, e nessuno la aggiornava mai. Su un progetto che rilascia spesso quella copia scivolava indietro da sola — quando ce ne siamo accorti era ferma a quattro giorni e 165 modifiche prima. L'assistente lavorava quindi su una versione vecchia: non vedeva quello che era stato fatto nel frattempo, rischiava di rifarlo, e la sua proposta risultava illeggibile (445 file toccati per un lavoro che ne cambiava 4). Ora la copia viene aggiornata dal progetto vero prima di ogni nuovo lavoro. Se non si riesce a raggiungere il progetto si procede lo stesso con quello che c'è; se invece non si capisce da dove partire, il lavoro si ferma invece di ripartire alla cieca.

## [0.16.6]

### Fixed

- **Un motivo di blocco vuoto non passa più i controlli**: se l'automazione si fermava indicando un motivo fatto di soli spazi, il sito lo accettava ma questo programma lo scartava, e la segnalazione spariva. Ora serve un motivo vero da entrambe le parti.

## [0.16.5]

### Fixed

- **Quando la pubblicazione si ferma, il motivo non va più perso**: il programma scartava il rapporto di chi si era bloccato per un dettaglio di formato — così il motivo restava solo nei log della macchina e sul ticket non compariva nulla. Ora arriva sempre, e un rilascio non può dichiararsi riuscito senza la sua versione.

## [0.16.4]

### Fixed

- **Il lavoro consegnato non viene più scartato**: l'assistente ha il divieto di approvarsi da solo, e molti progetti non hanno una batteria di controlli automatici da lanciare. Il suo resoconto onesto — «controlli non eseguibili, il giudizio lo dà qualcun altro» — veniva però considerato non valido: la consegna non partiva e il lavoro fatto, proposta di modifica compresa, andava perso. Ora quel resoconto è accettato. Un controllo eseguito e fallito continua a fermare la consegna.
- **Chi rilegge il lavoro non chiede più le prove che non possono esistere**: sapeva già di non pretenderle per il lavoro trovato già consegnato, ora lo sa anche quando i controlli non erano eseguibili e il giudizio non era ancora stato scritto.

## [0.16.3]

### Fixed

- **La pubblicazione funziona davvero**: il programma che fornisce le credenziali veniva cercato per nome e non trovato dentro la sessione, quindi la pubblicazione falliva come se le credenziali mancassero. Ora viene indicato per percorso completo. Verificato con una pubblicazione reale.

## [0.16.2]

### Fixed

- **La macchina riesce di nuovo a pubblicare il lavoro**: dopo aver scritto il codice e averlo salvato, la pubblicazione si fermava perché nella sessione mancavano le credenziali — il lavoro restava sulla macchina e il ticket tornava in coda per essere rifatto da capo. Ora il repository su cui lavora sa come autenticarsi, e i rami molto grandi non fanno più fallire l'invio a metà.

## [0.16.1]

### Fixed

- **Il controllo incrociato non boccia più il lavoro già consegnato**: la macchina che riapriva un ticket già completato lo dichiarava correttamente, ma il controllo automatico che rilegge il risultato pretendeva prove di un lavoro che quella sessione non aveva svolto — e lo respingeva. La consegna veniva rifiutata lo stesso.

## [0.16.0]

### Fixed

- **Il lavoro già consegnato non viene più buttato via**: se la macchina riapriva un ticket che aveva già completato e pubblicato in un giro precedente, il suo resoconto non rientrava in nessuna forma prevista e veniva scartato: la lavorazione risultava non consegnata e il ticket tornava in coda per essere rifatto. In una sola giornata è successo a trentadue lavorazioni su trentasei. Ora quel caso ha una risposta propria, che per essere accettata deve mostrare il lavoro già pubblicato.

## [0.15.0]

### Fixed

- **Il piano approvato arriva a chi deve realizzarlo**: approvare un piano non faceva partire nulla. Il piano non è scritto dentro il ticket, e alla macchina che scrive il codice arrivava solo come materiale di contorno, insieme al testo del ticket e senza le condizioni di completamento — così si fermava dicendo che il piano approvato non c'era, su ogni ticket. Ora le arriva per intero insieme all'incarico, condizioni comprese.
- **Il lavoro finito non si perde più al momento di pubblicarlo**: quando la macchina aveva scritto il codice e provava a pubblicare il suo ramo, la pubblicazione riusciva ma veniva riportata come fallita, e la consegna veniva buttata via — con il codice già su GitHub e il ticket fermo come se niente fosse.

### Added

- **Il pannello dice perché una macchina è ferma**: il motivo dell'ultimo blocco viaggia col battito, così una macchina che non riesce a prendere un ticket non è più indistinguibile da una che non ha niente da fare.

### Security

- **I registri non conservano più segreti**: chiavi private, token dei servizi cloud e credenziali che finivano nei registri di lavorazione vengono ora oscurati, e i permessi dei file sono più stretti.
- **Il contenuto del ticket è trattato come dato, non come ordine**: quello che c'è scritto in un ticket o in un suo commento non può più presentarsi alla macchina come l'istruzione da eseguire.

## [0.14.2]

### Fixed

- **La macchina può chiedere su che ramo si trova**: il comando che risponde a questa domanda restava vietato, quindi l'assistente lavorava senza poter confermare di essere sul ramo giusto. Era l'ultimo rimasto fuori dall'elenco delle letture consentite.

## [0.14.1]

### Fixed

- **Vedere le differenze nel codice funziona di nuovo**: un'impostazione dell'ambiente impediva al comando che mostra le modifiche di dare una risposta utile durante le lavorazioni.

## [0.14.0]

### Fixed

- **Le lavorazioni arrivano in fondo invece di ricominciare da capo**: quando una macchina finiva di scrivere il codice ma non poteva dire com'era andata la verifica, il resoconto veniva scartato perché conteneva una risposta non prevista. Il lavoro spariva: nessuna consegna, il ticket tornava in coda come se non fosse mai stato preso e poco dopo veniva ripescato. Il giro si ripeteva per ore sugli stessi ticket. In una sola giornata: ventinove lavorazioni lasciate a metà e nessuna conclusa.
- **La macchina può guardare la storia del codice**: erano ammessi solo due comandi di lettura, quindi non poteva vedere né i cambiamenti fatti né i lavori precedenti — in una singola lavorazione sette comandi innocui sono stati rifiutati. Ora le letture sono permesse, anche più di una di seguito. Restano vietate come prima le scritture, le pubblicazioni e i comandi costruiti per nascondere quello che fanno.
- **Cercare i file per nome funziona**: qualsiasi comando che usasse un asterisco o un punto interrogativo veniva bloccato, anche una semplice ricerca. Ora è permesso nei comandi che si limitano a leggere.

### Changed

- **I progetti Ruby possono installare quello che serve ai controlli**: mancava il permesso di raggiungere l'archivio dei pacchetti Ruby, quindi su quei progetti nessun controllo di qualità poteva essere eseguito e la lavorazione finiva senza aver verificato nulla.

## [0.13.0]

### Added

- **Più passi in parallelo, davvero**: la macchina sapeva già lavorare più passi insieme con un tetto configurabile, ma la parte che gira come servizio continuava a farne uno alla volta. Ora la lavorazione in parallelo è attiva anche lì: a parità di macchina la coda scorre più in fretta.

### Fixed

- **La macchina viene avviata con il programma giusto**: al momento di far partire l'assistente veniva lanciato il programma sbagliato, che moriva dopo due secondi. Risultato: quindici lavorazioni aperte in un giorno e nessuna arrivata in fondo, senza nemmeno un commento a spiegare perché.
- **Gli assistenti possono lavorare sull'ambiente di prova**: il permesso era già scritto nella loro configurazione sul server, ma il programma sulle macchine lo negava lo stesso, trattando l'ambiente di prova come se fosse quello vero. Ora vale quanto è configurato; la produzione resta vietata come prima.
- **Aggiornare la macchina non chiede più di disinstallare prima**: il comando di aggiornamento si rifiutava di procedere a ogni tentativo, anche subito dopo una reinstallazione pulita. Attenzione: questa correzione arriva col programma nuovo, quindi la prima volta va ancora applicata a mano — dagli aggiornamenti successivi il problema non si presenta più.

### Security

- **I comandi vietati non passano più nascondendosi dentro un file**: i tre divieti che proteggono da pubblicazioni in produzione, cancellazioni di dati e riscritture della storia del codice guardavano solo il comando scritto in chiaro. Scrivendo il comando dentro un file e poi eseguendo quel file, il controllo non lo vedeva e il divieto veniva aggirato.

## [0.12.1]

### Fixed

- **Un lavoro bocciato viene corretto, non rifatto da capo**: quando il secondo agente rileggeva il lavoro del primo e chiedeva modifiche, quel lavoro veniva buttato e il ticket tornava in coda. Chi lo riprendeva ripartiva da zero senza sapere cosa non andava, e finiva per rifare la stessa scelta e farsi bocciare di nuovo. In una giornata sono andate perse così venti consegne su sessantasette. Ora i rilievi vengono passati a chi riprova, che corregge invece di ricominciare. Il tetto resta quello di prima: dopo un tentativo e una correzione, se ancora non si convergono, il lavoro si ferma e chiede aiuto a una persona.

## [0.12.0]

### Added

- **Le macchine si tengono aggiornate le skill da sole**: le istruzioni con cui gli agenti lavorano i ticket vengono decise dal server, ma nessuno le andava a prendere. Bisognava ricordarsi di scaricarle a mano su ogni macchina, e nessun aggiornamento successivo le rinnovava. Due guai, entrambi silenziosi: una macchina nuova sembrava accesa e in salute e non lavorava nulla, e una macchina vecchia restava per sempre alle istruzioni del primo giorno. Ora ogni macchina controlla da sola, mentre lavora, se le istruzioni che ha sono quelle giuste, e se non lo sono le prende. Il controllo costa quanto una domanda: solo quando la risposta cambia si muove qualcosa, e chi non usa le skill non paga niente.
- **Il cambio di istruzioni non disturba il lavoro in corso**: le istruzioni nuove vengono messe da parte, accanto a quelle vecchie, e solo dopo si passa a usarle. Un agente che sta già lavorando continua con quelle che aveva in mano fino alla fine; il lavoro successivo parte con le nuove. Non c'è un momento in cui qualcuno si trova i fogli cambiati sotto gli occhi a metà.

## [0.11.1]

### Fixed

- **Su Linux il servizio non partiva affatto**: il file con cui il sistema operativo avvia l'automator conteneva un valore scritto in un modo che Linux rifiuta. La macchina risultava installata e configurata, ma il servizio non si avviava mai. Ora il file viene scritto in una forma che il sistema accetta, e le macchine già installate continuano a essere riconosciute come prima.
- **La macchina non riusciva a leggere le proprie credenziali**: le chiavi di accesso sono custodite nel portachiavi del sistema, che si raggiunge solo attraverso un canale che il servizio non riceveva. Il risultato era che ogni richiesta di lavoro falliva e i ticket restavano fermi, con un messaggio che faceva pensare a un problema di rete. Ora il canale viene passato al servizio.
- **Il limite ai riavvii ripetuti non era mai in vigore**: l'impostazione che ferma una macchina dopo alcuni riavvii falliti si trovava nel punto sbagliato del file e veniva ignorata in silenzio. Una macchina in crisi si sarebbe riavviata all'infinito. Ora il limite viene applicato davvero.

## [0.11.0]

### Added

- **Le macchine Linux possono finalmente lavorare i ticket**: prima di consentire a un agente di eseguire comandi, l'automator verifica che il sistema operativo sappia davvero impedirgli di scrivere fuori dalla cartella di lavoro. Questa verifica esisteva solo per i Mac: su Linux non c'era, e in mancanza di una prova la macchina si comportava nell'unico modo prudente possibile — rifiutava ogni ticket. Si registrava, dava segni di vita, chiedeva lavoro e poi non ne faceva nessuno, senza che niente sembrasse rotto. Ora la verifica esiste anche per Linux, e una macchina che la supera lavora come un Mac.
- **Una macchina che non sa proteggersi continua a non lavorare**: la verifica non è una formalità. Se lo strumento che costruisce il recinto manca o il sistema si rifiuta di usarlo, l'esito resta negativo e i ticket restano fermi. È voluto: meglio una macchina che non lavora di una che lavora senza rete di sicurezza.

## [0.10.11]

### Fixed

- **Le macchine tornano ad aggiornarsi da sole**: prima di aggiornarsi la macchina controlla che il servizio in esecuzione sia davvero quello configurato — un controllo giusto, ma guardava anche le impostazioni che il sistema operativo aggiunge per conto suo. Una di queste, comparsa con le ultime versioni di macOS, non era prevista: bastava a far fallire ogni aggiornamento con un messaggio che diceva il contrario di quel che stava succedendo. Ora le impostazioni aggiunte dal sistema vengono riconosciute e ignorate; tutto il resto continua a fermare l'aggiornamento come prima.

## [0.10.10]

### Fixed

- **La macchina dice di essere viva anche mentre sta lavorando**: ogni macchina manda un segnale periodico per farsi riconoscere attiva, ma lo mandava soltanto alla fine di un giro di lavoro. Un giro che dura sette minuti la faceva quindi risultare spenta per quattro, e in quei minuti tutti i progetti che chiedevano un ticket si sentivano rispondere di no. Il primo progetto della lista lavorava, gli altri restavano fermi — per giorni, senza che il motivo comparisse da nessuna parte. Ora il segnale parte per conto suo ogni minuto, anche mentre un lavoro e' in corso.
- **Un rifiuto motivato non viene piu' scambiato per un server irraggiungibile**: quando la richiesta di prendere in carico un ticket veniva respinta, il registro diceva "il server non ha risposto" anche nei casi in cui il server aveva risposto benissimo, spiegando il motivo. Ora il motivo viene riportato per intero: chi legge distingue una macchina da sistemare da una rete che non va.

## [0.10.9]

### Fixed

- **Quando un progetto non riesce a prendere in carico un ticket, il registro dice perche'**: prima ogni rifiuto usciva con la stessa identica frase, qualunque fosse la causa — il server che risponde di no, il server che non risponde affatto, o una presa in carico intestata a un'altra macchina. Sono problemi con rimedi opposti, ma dal registro erano indistinguibili: quattro progetti sono rimasti fermi cinque giorni senza che si potesse capire cosa controllare. Ora ogni caso ha il suo messaggio. La macchina resta prudente come prima: se la presa in carico non e' certa non lavora il ticket, esattamente come faceva.

## [0.10.8]

### Fixed

- **I piani di lavoro non vengono piu' bocciati a vuoto**: ogni risultato viene riletto da un secondo assistente, ma a quel secondo veniva chiesta sempre la stessa cosa — "verifica le prove" — anche per il passo che si limita a scrivere il piano. Un piano descrive lavoro non ancora fatto: prove non ne puo' portare, quindi veniva bocciato ogni volta e rifatto da capo all'infinito. Ora a chi non esegue niente si chiede di giudicare il documento, non prove che non possono esistere; a chi esegue davvero le prove continuano a essere richieste.

## [0.10.7]

### Fixed

- **Il lavoro degli assistenti viene finalmente consegnato**: ogni lavoro viene riletto da un secondo assistente prima di essere consegnato, ma quel secondo assistente veniva avviato nella cartella sbagliata e il sistema lo fermava prima ancora che cominciasse. Cosi' nessun lavoro superava il controllo: la consegna veniva rifiutata anche quando la prima parte era andata benissimo.

## [0.10.6]

### Fixed

- **Gli assistenti riescono di nuovo a parlare con CloseYourIt**: le sessioni girano in un ambiente protetto che lascia uscire solo verso gli indirizzi consentiti. CloseYourIt era fra quelli, ma il comando che ci parla non passava dal varco previsto: falliva come se la rete non ci fosse, e l'assistente non riusciva nemmeno a leggere il ticket su cui doveva lavorare.

## [0.10.5] - 2026-07-30

### Security

- **La macchina lavora con la propria identità, non con quella di una persona**: ogni macchina ha già un'identità dedicata, che vede solo i progetti che le competono e si revoca in un clic. Ma quell'identità non le arrivava mai: l'unico modo di autenticarla passa da una pagina web, che un'identità di servizio non può usare. Così chi preparava la macchina finiva per collegarla col proprio account personale — e da quel momento la macchina poteva fare tutto quello che può fare quella persona, con il suo nome nella cronologia dei ticket. Ora la macchina usa la credenziale che ha già, quella con cui si registra: le arriva solo quando avvia un assistente, non viene scritta in nessun file di configurazione e non raggiunge i comandi che non ne hanno bisogno. [Assistenti](/member/agents)

## [0.10.4] - 2026-07-30

### Fixed

- **Le fasi di lettura possono eseguire i propri comandi**: la prima fase — quella che legge un ticket e lo classifica — girava in una modalità che non le permetteva di eseguire nulla. Doveva impedirle di modificare i file, ma non fa quello: impedisce di eseguire. E quella fase è fatta tutta di comandi, quindi non riusciva a fare nemmeno il primo passo. Ora esegue davvero, e non può comunque modificare niente: non riceve una cartella di lavoro, e ogni scrittura resta bloccata come prima. Il segnale che la macchina e il server si scambiano per riconoscere le fasi è cambiato di conseguenza: server e macchine vanno aggiornati insieme, altrimenti smettono di riconoscersi e nessun lavoro parte.
- **Il risultato di una sessione viene riconosciuto anche se non arriva pettinato**: la macchina sapeva leggere il risultato prodotto dall'assistente solo in una forma precisa — tutto su una riga sola, senza niente attorno. Bastava che l'assistente lo racchiudesse in un riquadro di codice, che ci scrivesse due righe di spiegazione prima, o che lo scrivesse su più righe dopo un avviso del programma, e la macchina non lo riconosceva più: risultato mai consegnato, ticket bloccato. Ora lo trova anche dentro un riquadro, anche preceduto da altro testo, e anche quando il messaggio è impaginato su più righe. Resta il rifiuto di tutto ciò che non rispetta il formato previsto: un output davvero incomprensibile non viene indovinato, viene segnalato.
- **Lo stesso vale per la revisione incrociata**: il verdetto del secondo assistente passava dallo stesso lettore e aveva lo stesso problema. Ora viene riconosciuto nelle stesse forme.

## [0.10.3] - 2026-07-30

### Fixed

- **Quando il lavoro non viene consegnato, adesso lo dice**: la macchina prendeva un ticket, lavorava per tre minuti e poi, se non riusciva a interpretare il risultato prodotto, si fermava senza mandare niente al server e senza scrivere una riga da nessuna parte. Da fuori sembrava tutto a posto: il resoconto della sessione diceva «riuscito», perché veniva scritto prima che la macchina scoprisse di non avere niente da consegnare, e il ticket restava segnato in lavorazione per sempre. Ora ogni consegna mancata lascia nel registro il motivo, un pezzo del risultato illeggibile per capire com'era fatto, e la dimensione dell'output con l'avviso se era stato tagliato perché troppo lungo. Il resoconto della sessione non dichiara più riuscita una lavorazione che non ha consegnato.
- **Una consegna rifiutata dice come è stata rifiutata**: prima ogni intoppo — credenziale scaduta, macchina revocata, risultato non valido, server non raggiungibile, attesa scaduta — finiva nella stessa risposta muta «non è andata». Sono guasti con rimedi diversi e ora si distinguono: il registro riporta la risposta del server, e un rifiuto nel merito non viene più confuso con un tentativo di cui non si sa l'esito.
- **Il messaggio di errore non manda a cercare nel posto sbagliato**: quando mancava il canale su cui consegnare, o il ramo di riferimento del progetto non era utilizzabile, la macchina segnalava un problema della cartella di lavoro — che invece non era stata nemmeno toccata. Ogni caso ora dichiara la propria causa.
- **Il ciclo di lavoro racconta cosa ha fatto**: a ogni giro il registro elenca le azioni non riuscite col loro codice e il file da aprire, le consegne non riuscite e i passaggi della coda interrotti da un guasto — che prima svanivano senza traccia. Le consegne riuscite restano silenziose, così il registro rimane leggibile.

## [0.10.2] - 2026-07-30

### Fixed

- **L'assistente parte davvero, invece di morire in due secondi**: quando la macchina lavorava da sola, al momento di avviare l'assistente veniva lanciato il programma che sceglie le versioni degli strumenti — non l'assistente vero. Quello non capiva la richiesta e si chiudeva subito con un errore, quindi ogni ticket preso in carico restava senza risultato: quindici lavorazioni aperte, nessuna conclusa. Succedeva solo col servizio attivo, mai provando a mano dal terminale, ed è per questo che nessun controllo se n'era accorto. Ora il programma giusto viene avviato col proprio nome, e i controlli di sicurezza sul programma da lanciare restano quelli di prima.

## [0.10.1] - 2026-07-29

### Fixed

- **Un ticket che il sistema vieta non blocca più la coda e non fa suonare l'allarme**: se un ticket fosse arrivato alla macchina contrassegnato come non lavorabile — cosa che non dovrebbe accadere, ma il controllo esiste apposta — la macchina si fermava senza metterlo da parte, e al giro dopo lo ritrovava identico: tutto il progetto sarebbe rimasto fermo dietro di lui, lo stesso inceppamento risolto poche ore fa. Inoltre registrava l'accaduto come un guasto della macchina, facendo diventare rosso il segnale di salute: ma un ticket vietato non è un guasto, è una decisione. Ora il ticket viene messo da parte come tutti gli altri e il segnale resta verde.

## [0.10.0] - 2026-07-29

### Changed

- **Decide CloseYourIt quali ticket sono lavorabili, non più la macchina**: ogni ticket porta ora un contrassegno che dice se un agente può lavorarlo, deciso dal sistema e correggibile a mano dalla pagina del ticket. La macchina però continuava a rifare la valutazione per conto suo, con un metodo molto più rozzo — cercava parole sospette nel testo — e finiva per rifiutare ticket che erano stati approvati apposta: nessun ticket è mai stato lavorato. Ora sulla coda comanda il contrassegno: la macchina prende il primo ticket contrassegnato come lavorabile e lo lavora. Continua a farsi la sua idea sul ticket, e la scrive nel registro delle lavorazioni, ma non ha più potere di veto. Se un ticket arriva contrassegnato diversamente da «lavorabile», si ferma e non lo tocca; su un server che non conosce ancora il contrassegno, tutto resta come prima.

Nessun cambiamento per chi usa la macchina col file di configurazione locale invece della coda: lì le valutazioni della macchina restano l'unica difesa e continuano a valere.

## [0.9.5] - 2026-07-29

### Fixed

- **Un'interruzione del servizio centrale non mette più i ticket da parte**: quando la macchina non riusciva a farsi dire quanto lavoro le è concesso — server irraggiungibile, o il suo conteggio giornaliero locale illeggibile — trattava la cosa come un intoppo del ticket e lo metteva in attesa qualche minuto. Ma il ticket non c'entrava nulla: bastava un disservizio di qualche minuto perché decine di ticket finissero da parte, e la coda restava muta anche dopo il ripristino. Ora nessun tipo di limite mette in attesa un ticket: i limiti parlano della macchina e del momento, mai del ticket.

## [0.9.4] - 2026-07-29

### Fixed

- **La richiesta di attesa veniva respinta e non metteva in coda proprio niente**: la macchina chiedeva al server di mettere da parte il ticket senza dichiarare la propria identità, che il server pretende e confronta con quella di chi firma la richiesta. Ogni richiesta finiva rifiutata, quindi il ticket in cima tornava lì al giro dopo esattamente come prima: la correzione della 0.9.3 era, di fatto, spenta. Ora l'identità viaggia nella richiesta, com'è sempre stato per la presa in carico del ticket.
- **Un riavvio non mette più i ticket in attesa**: quando il servizio si sta fermando, il lavoro in partenza viene annullato a metà, e quell'annullamento veniva scambiato per un intoppo del ticket. Risultato: il ticket interrotto dal riavvio restava da parte altri cinque minuti a servizio già ripartito. Un riavvio non dice nulla sul ticket, e ora non produce alcuna attesa.

## [0.9.3] - 2026-07-29

### Fixed

- **Un ticket che non si può lavorare non blocca più tutti gli altri**: quando la macchina prendeva in esame il ticket in cima alla coda e scopriva di non poterlo lavorare — serve un via libera umano, mancano informazioni, il rischio è alto — si fermava e basta. Al giro dopo ritrovava lo stesso ticket in cima, si fermava di nuovo, e così ogni minuto: l'intero progetto restava fermo dietro di lui, anche i ticket lavorabilissimi, e da fuori sembrava soltanto che la macchina non facesse nulla. Ora lo dice al server, che lo mette in attesa per un po' e le passa il successivo; quanto dura l'attesa lo decide il server in base al motivo — più corta per un intoppo tecnico che si risolve da sé, più lunga quando si aspetta la risposta di una persona. La macchina non chiede l'attesa quando è **lei** a non poter lavorare (configurazione incompleta, slot occupati, budget esaurito): quelle sono attese che sopravvivrebbero al rimedio e lascerebbero la coda muta proprio dopo averla riparata. Se la richiesta di attesa non arriva a destinazione non cambia nulla: il ticket ricompare al giro dopo, come oggi.

## [0.9.2] - 2026-07-28

### Fixed

- **La macchina si dichiarava pronta mentre non poteva lavorare**: per prendere in carico i ticket serve il pacchetto di istruzioni con cui esegue le fasi, che si scarica a parte e non arriva né con l'installazione né all'avvio del servizio. Senza, la macchina si registra, invia il suo segnale di vita e resta idonea a tutti i controlli — ma al momento di prendere un ticket si ferma, e nessuno lo dice a chi la sta preparando. Ora il controllo di configurazione verifica anche il pacchetto quando la macchina è impostata per lavorare da sola: se manca, lo elenca fra i passi da fare col comando che lo installa, e non dichiara più la macchina pronta. Il controllo guarda come è configurato **il servizio**, non il terminale da cui lo lanci: erano due cose diverse, e guardare il terminale avrebbe dato «tutto a posto» proprio sulle macchine impostate per lavorare da sole.

## [0.9.1] - 2026-07-28

### Fixed

- **La credenziale della macchina finiva vuota nel portachiavi, e l'installazione diceva che era andata bene**: su macOS il token del service account e quello di Agent Host venivano consegnati a `security` sullo standard input, ma quel comando la password da lì non la legge — chiede e basta. Il risultato era una voce salvata **vuota** con esito positivo: la macchina risultava installata e registrata, poi non riusciva a reclamare nulla perché la credenziale con cui autenticarsi non c'era. Ora il valore viene passato direttamente al comando e il salvataggio è verificato da un test che scrive e rilegge dal portachiavi vero, non da una sua imitazione.

## [0.9.0] - 2026-07-28

### Added

- **La macchina dimostra col kernel che le scritture restano nella cartella di lavoro**: prima di lavorare in autonomia l'host esegue una sonda reale della sandbox di sistema con **doppia prova** — dentro il perimetro la scrittura deve riuscire, fuori deve essere **negata** e non lasciare il file. Senza la prova positiva una sonda mai eseguita sarebbe indistinguibile da un recinto perfetto (comando fallito e file assente in entrambi i casi). Il profilo viaggia inline, non tocca il disco. Oggi vale su macOS; altrove la macchina non attesta e lo dichiara, invece di dare per buono un confinamento che non ha verificato.

### Changed

- **`install --skills-enabled` rifiuta un host che non lo dimostra**: accendere lo skill-mode significa dare Bash alle sessioni, quindi il turn-on viene negato **prima di installare qualunque cosa** se il confinamento non è attestato. Lo stesso requisito vale nel preflight della coda: un host non attestato resta in prompt-mode e non reclama ticket. Meglio non installare che lasciare un daemon che si fermerebbe comunque al primo claim senza spiegare perché.

### Fixed

- **Una prova non conclusiva non attesta più il confinamento**: un esito nullo della prova negativa — la sonda va in timeout, il comando non parte — veniva letto come «scrittura negata» e faceva passare l'attestazione. Era un fail-open sul controllo che decide se la macchina può lavorare da sola: ora attesta solo un diniego davvero osservato.
- **La raccolta dei test non risale più nei worktree annidati**: il runner includeva anche le copie di lavoro annidate ed eseguiva più suite in parallelo sullo stesso repository, producendo fallimenti che non esistevano nel codice.

## [0.8.0] - 2026-07-28

### Changed

- **La coda nasce dal manifest, non dal catalogo agenti**: il daemon chiede al backend il manifest dei repository autorizzati per la propria macchina e ne deriva una coda per progetto, invece di scaricare un catalogo di agenti e fare fan-out per agente. Sparisce il sidecar per-agente e il report di run verso il vecchio endpoint. Richiede un backend che esponga `agent_host/workspace_manifest` (CloseYourIt 0.46.0 o successivo).

### Added

- **Guidance del progetto prima di chiarezza e claim**: il ticket-worker consuma la guidance strutturata che il backend allega al dettaglio ticket — reference, procedure e regole — e la porta nel contesto come dati, senza trattamenti speciali per chiave. Le procedure ricevute finiscono nell'audit. Se una reference obbligatoria non è consultabile, l'esecuzione si ferma pulita con un commento sul ticket e senza prendere in carico il ticket. Su un backend che non espone la guidance il comportamento resta invariato.

## [0.7.0] - 2026-07-24

### Changed

- **Modello credenziali "un service account per macchina"**: la macchina si registra come Agent Host presentando il token del proprio service account (`cyi_u_`) invece dell'org token condiviso; lo scope di ambienti è deciso alla creazione del service account e la macchina non può ampliarselo.
- **Auth di Claude locale**: il `claude` headless usa l'autenticazione locale della macchina (`claude login`/Keychain o API key durevole nell'ambiente del servizio); l'automator non custodisce né inietta più il token di Claude e non lo legge dal vault. La sonda di `enroll`/`doctor` verifica l'auth nell'ambiente equivalente al servizio.
- **Il vault del progetto decade per il minion**: in modalità managed non si leggono più secret statici (`CLAUDE_CODE_OAUTH_TOKEN`/`CLOSEYOURIT_AUTOMATOR_ORG_TOKEN`) dal vault; l'unica credenziale richiesta è il token del service account nel credential store del sistema operativo.

## [0.6.2] - 2026-07-24

### Added

- Flag `install --skills-enabled`: accende lo skill-mode del daemon managed iniettando `AUTOMATOR_SKILLS_ENABLED=true` nell'unit del servizio (assente = prompt-mode, default invariato).

## [0.6.1] - 2026-07-23

### Changed

- Coda ticket host-first: una coda per progetto con dispatch a un solo claim per tick; eliminato il vecchio fan-out per-agente.

## [0.6.0] - 2026-07-21

### Added

- Esecuzione dei workflow tipizzati sui contratti reali delle skill + contract `agent-result` vendored e verificato lato client.

## [0.5.0] - 2026-07-17

### Added

- Skill-mode: esecuzione host-first delle fasi tramite bundle di skill risolto e pinnato dal server.

## [0.4.0] - 2026-07-17

### Changed

- Hardening skill-mode: propagazione dei retry finding della review e requisito che il bundle di skill sia presente prima di abilitare lo skill-mode.

## [0.3.0] - 2026-07-16

### Added

- Comando `oneclick`: provisioning resumable di una macchina worker in un solo comando (toolchain, autenticazioni, `update`/`install --managed`, registrazione host e replica dei repository dal manifest del server), con checkpoint per stadio.
- Consumo del workspace-manifest del server (`GET /api/v1/agent_host/workspace_manifest`, host-scoped): la macchina scarica la lista dei repository da gestire (path logico + `owner/repo` + branch) e li clona/aggiorna sotto una workspace root, idempotente e mai distruttivo (clone se manca, `fetch` + `pull --ff-only` altrimenti).
- Probe dell'autenticazione Codex in `enroll`/`doctor`.

## [0.2.0] - 2026-07-15

### Added

- Esecuzione dei workflow tipizzati di triage, pianificazione e autopilot ricevuti da CloseYourIt, con prompt versionati e output strutturati.
- Revisione incrociata obbligatoria tra Claude e Codex prima della consegna di ogni risultato al server.

### Changed

- La sincronizzazione remota usa comandi organizzativi autorizzati al posto di comandi liberi definiti sull'agente.
- Il daemon consegna gli esiti mentre detiene ancora il lease e interrompe il flusso se host, progetto, comando o snapshot non sono più validi.

## [0.1.3] - 2026-07-14

### Fixed

- Packaging hermetico fuori dal checkout: l'artifact include davvero le dipendenze di produzione e il preflight
  non può più risolverle accidentalmente dal `node_modules` del repository.
- Diagnostica completa dei gate fresh install, upgrade e rollback nel release smoke.

## [0.1.2] - 2026-07-14

### Fixed

- GitHub CLI gestita e versionata con mise, così il job di packaging self-hosted può verificare e riusare in
  sicurezza gli artifact immutabili delle release.

## [0.1.1] - 2026-07-14

### Fixed

- Inizializzazione DBus idempotente nel job di release Linux: il test di strong containment usa il manager
  systemd utente già avviato dal runner self-hosted.

## [0.1.0] - 2026-07-14

Prima release stable installabile dell'Automator CloseYourIt.

### Added

- Pipeline autonoma completa per ticket: discovery, deduplica, classificazione, routing, split, review incrociata,
  quality gate, consegna e checkpoint recuperabili.
- Coordinamento multi-host con registrazione Agent Host revocabile, lease distribuiti, code ticket atomiche,
  rinnovo, recovery e limiti di utilizzo server-side.
- Runtime Claude e Codex con guardrail condivisi, policy fail-closed, contenimento dei processi, timeout e
  redazione centralizzata dei secret.
- Installazione e aggiornamento managed con artifact verificati, canali stable/beta, smoke Linux/macOS,
  rollback e bootstrap idempotente.
- E2E multi-host reale contro CloseYourIt Rails per claim, scadenza, recupero e completamento di un ticket.
- CloseYourIt Secrets come fonte dei secret statici; token service account e Agent Host nel Keychain macOS o
  Secret Service Linux, senza credenziali operative nei file locali o nelle unit di servizio.

### Security

- Nessun secret negli argomenti dei processi, nei log, nei report o nella configurazione managed.
- Accesso al vault tramite service account confinabile per progetto ed environment e auditato da CloseYourIt.
- TTL dei claim allineato al timeout reale degli agenti per evitare duplicazioni durante lavorazioni lunghe.
