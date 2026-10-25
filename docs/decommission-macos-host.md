# Dismissione di un vecchio host macOS

Automator non supporta più macOS. Prima di cancellare file o credenziali, verifica che un host Linux sostitutivo
sia registrato, online e idoneo alle code interessate.

1. Ferma e disinstalla la vecchia release dell'Automator sul Mac, prima di aggiornarla. Se il vecchio comando non
   è più disponibile, scarica la unit con `launchctl bootout gui/$(id -u) <percorso-del-vecchio-plist>`.
2. Dalla UI CloseYourIt revoca l'Agent Host e il service account associati. È un'operazione sensibile e resta
   manuale: non copiare token in ticket, chat o script.
3. Rimuovi dal Mac la vecchia unit, la directory delle release e i dati locali soltanto dopo aver verificato che
   non contengano log o stato da conservare.
4. Controlla in CloseYourIt che il vecchio host risulti offline e che le nuove claim vengano assegnate soltanto
   all'host Linux.

Il server conserva i record e le run storiche: la dismissione non richiede migrazioni distruttive del database.
