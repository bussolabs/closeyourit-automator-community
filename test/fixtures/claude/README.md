# Fixture: stdout REALE di `claude -p … --output-format json`

Le fixture qui sono **envelope della CLI**, non JSON già estratto. È la differenza che ha lasciato passare
CYAU-106: `typed-workflow.test.ts` provava il parser su `JSON.stringify(fixture)`, cioè su un risultato già
ripulito, mentre in produzione il risultato arriva annidato nel campo `result` dell'envelope — a volte
incorniciato in markdown, a volte dopo righe di rumore, a volte pretty-printed su più righe.

- `envelope-fenced.json` — `result` con il JSON dentro un blocco ` ```json `. Caso osservato su minion-1.
- `envelope-prose-then-fence.json` — `result` con prosa prima del blocco: il modello spiega e poi emette.
- `envelope-noisy-pretty.txt` — righe di rumore su stdout **e** envelope pretty-print multi-riga: né lo
  stdout intero né l'ultima riga sono JSON validi.

Vanno lette come byte grezzi (`fs.readFileSync`), non importate: rappresentano stdout, non moduli.
