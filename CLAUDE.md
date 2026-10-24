# CLAUDE.md

MiB-SQL: IDE educativo per MariaDB/MySQL su Linux ispirato a dbForge Studio. Progetto autonomo (nessun codice condiviso con LinBI). UI in italiano.

## Comandi

```bash
npm run dev         # Vite :5174 + Electron (VITE_DEV=1)
npm run build       # renderer in dist/
npm test            # node --test tests/*.test.cjs
npm run typecheck   # tsc --noEmit (solo src/)
npm run dist        # AppImage
```

## Architettura

- `electron/main.cjs` — finestra, IPC (`handle()` → `{ok}`/`{error, code}`), dialog file. Menu applicazione rimosso; F12 = DevTools.
- `electron/connections.cjs` — profili in `<userData>/connections.json`; segreti in `secrets.json` cifrati con `safeStorage` async. Backend `basic_text` = portachiavi non disponibile → segreti solo in memoria per la sessione.
- `electron/server.cjs` — per connessione: pool metadati (explorer, completamento, `KILL QUERY`) + tunnel SSH condiviso (`ssh2`, server locale su porta 0). Per documento: connessione dedicata (sessione). `exec()` divide lo script, esegue in sequenza, normalizza celle (BigInt/DECIMAL → stringa, Buffer → `0x…`, JSON → stringa), limita a 50.000 righe per resultset. `open()` prova prima una connessione singola: il pool riproverebbe fino ad `acquireTimeout` perdendo il codice d'errore.
- `electron/sqlsplit.cjs` — splitter tipo client mariadb (quote, commenti, `DELIMITER`), offset sul testo originale; `scan(text, delim, final)` e `Splitter` incrementale per i file grandi; `isBlank` è uno scanner (le regex con `\s` mangiavano le righe dopo `--`). Testato in `tests/`.
- `electron/explorer.cjs` — query su `information_schema`, `SHOW CREATE` per i DDL.
- `electron/export.cjs` — writer CSV/JSON/SQL/xlsx (exceljs in streaming) riga per riga; `server.streamQuery` per esportare tutta una query. `server.apply` esegue le modifiche della griglia in transazione su una connessione del pool (`expectOne` → rollback sui conflitti), `server.selectRows` rilegge le righe toccate.
- `src/store.ts` — zustand: profili, stato connessioni, cache metadati (`metaKey`), documenti, dialog. `openConn` gestisce il prompt password su errori di autenticazione.
- `src/editor.ts` — Monaco: un modello per documento, dirty per `alternativeVersionId`, completamento (alias via `tableRefs`), marker errori.
- `src/edits.ts` — logica pura delle modifiche in griglia (target modificabile, `Edits`, generazione UPDATE/INSERT/DELETE parametrizzati, anteprima). Testata da `tests/edits.test.mjs` con il type stripping di Node: `src/package.json` dichiara `"type": "module"` per questo.
- `src/design.ts` — modello del designer tabelle (`TableDef`, colonne/indici/FK con id stabili), `createSql`, `alterSql` per differenza (FK modificate in un ALTER a parte, posizioni simulate nell'ordine delle clausole, RENAME per ultimo), `validate`. Test: `tests/design.test.mjs`; verificato anche contro MariaDB 10.11/11.4 e MySQL 8.4. `explorer.tableDefinition` legge la struttura (COLUMN_DEFAULT è un'espressione su MariaDB, su MySQL viene quotato), `server.runStatements` esegue il DDL.
- `src/components/TableDesigner.tsx` — documento `kind: 'table'` (Doc.design.table, null = nuova); stato in `designByDoc` (store.ts). Le schede designer si ripristinano dal server, senza le modifiche non applicate.
- `src/er.ts` + `components/ErDiagram.tsx` — diagramma ER (doc `kind: 'er'`): modello da `explorer.erModel` (3 query su tutto lo schema), layout a livelli con padri avvicinati ai figli, SVG con stili interni (variabili CSS con fallback chiaro: gli export restano chiari). Editor visuale: relazioni trascinate tra righe `[data-col]`, DDL via `api.ddl.run`. Disposizione per conn/db in localStorage.
- `src/qb.ts` + `components/QueryBuilder.tsx` — query builder (doc `kind: 'query'`, modello in `doc.qb`, persistito con le schede). `runDoc` per i doc query rigenera l'SQL con `toSql` nel modello Monaco del documento e riusa sessione e ResultsPanel.
- `src/compare.ts` + `components/CompareView.tsx` + `electron/datacompare.cjs` — confronto (doc `kind: 'compare'`, origine/destinazione in `doc.cmp`). `explorer.schemaSnapshot` = `tableDefinitions` (5 query per tutto lo schema) + DDL normalizzate (senza DEFINER/schema) di viste e routine; `alignTo` dà alla definizione d'origine gli id della destinazione per nome, poi `alterSql`. `syncStatements`: DROP/CREATE TABLE con FOREIGN_KEY_CHECKS=0, tutto il resto (FK comprese) con i controlli attivi, perché MariaDB salva come NO ACTION le regole RESTRICT aggiunte a controlli spenti. Dati: destinazione in una Map per PK, origine in streaming, istruzioni parametrizzate (`UNHEX(?)` per i binari) eseguite con `server.apply`.
- `electron/backup.cjs` — dump proprio (pool conn in UTC, `SHOW CREATE`, INSERT a blocchi con `export.literal`, trigger dopo i dati, DELIMITER ;;) e restore a flusso con `Splitter` (sqlsplit.cjs). Il restore è byte-transparent: file letto come latin1, connessione dedicata (`server.withDedicated`) con collation latin1, `session_track_system_variables = ''` (altrimenti il driver torna a UTF-8 vedendo SET NAMES) e poi `SET NAMES utf8mb4`.
- `electron/importer.cjs` + `components/TaskDialogs.tsx` — import CSV/xlsx/JSON (CsvParser a flusso, exceljs WorkbookReader), `normalize`/`inferType`, tutto in una transazione; dialoghi Backup/Ripristino/Import aperti da `store.task`. Aggancio test `MIBSQL_OPEN=<file>` salta il dialog di apertura.
- Fase 8: `server.profile` (status prima/dopo meno il costo di SHOW STATUS, SHOW PROFILE, ANALYZE FORMAT=JSON solo per letture) + `src/profile.ts` (planRows, hints) + `ProfileView` nella scheda «Profilo»; `server.monitorSnapshot` (query marcate `/* mibsql-monitor */` e nascoste dalla lista) + `src/monitor.ts` (ratei) + `Monitor.tsx` (grafici a una serie, colore `--series` validato con lo skill dataviz); `explorer.users/grants` + `src/users.ts` (parseGrants, grantStatements, maskPasswords) + `Users.tsx`. Doc `kind: 'monitor' | 'users'` aperti con `openServerTool`.
- `allowPublicKeyRetrieval` è attivo solo senza SSL: serve a MySQL 8 (caching_sha2_password) al primo login di un account.
- `src/theme.ts` — tema: `<html data-theme>` + variabili in `styles.css` (`:root` chiaro, `:root[data-theme="dark"]` scuro), temi Monaco `mibsql`/`mibsql-dark`, preferenza light/dark/system in localStorage; nei componenti usare sempre le variabili (`--panel`, `--input`, `--subtle`, `--line`…), mai colori fissi.
- `src/components/ResultView.tsx` — barra filtri/modifiche/export sopra `ResultGrid`; modifiche in sospeso in `editsBySet` (WeakMap per ResultSet, store.ts). `runDoc`/`closeDoc` chiedono conferma se ci sono modifiche non applicate.
- `src/actions.ts` — azioni documento (run, cancel, save, DDL, select top), persistenza schede in localStorage.
- `src/components/` — `Explorer`, `SqlEditor` (un'unica istanza Monaco, swap modelli), `ResultsPanel`, `ResultGrid` (virtualizzata, righe 22px), `Dialogs`, `ContextMenu`, `Icon` (SVG inline).

## Icona

`build/icons/*.png` (e `electron/icon.png`, `build/icon.png` 1024) sono generate dall'immagine fornita dall'utente (sfondo bianco reso trasparente, ritaglio quadrato).

## Test e screenshot

- `MIBSQL_USERDATA=<dir>` usa un profilo separato (mai il profilo reale nei test).
- `MIBSQL_SHOT=out.png MIBSQL_SCRIPT=script.js [MIBSQL_WAIT=ms]`: esegue lo script nel renderer, salva il valore restituito in `out.json`, cattura e chiude. Lo script usa `window.__mib = { useStore, actions, monaco }`.
- `MIBSQL_SAVE_AS=<path senza estensione>` salta il dialog di salvataggio degli export.
- Nei test UI: React 19 applica lo stato in un microtask, quindi tra eventi sintetici consecutivi (mousedown → contextmenu) serve un `await sleep()`.
- DB di prova: `scripts/demo.sql` → `mibsql_demo` + utente `mibsql`/`mibsql` limitato a quel db. Non usare i db `r_lab_*` per i test.
- Tunnel SSH verificato con container `mariadb:11.4` + `linuxserver/openssh-server` sulla stessa rete Docker.

## Convenzioni

- Main process CommonJS (`.cjs`), renderer TypeScript/React senza framework CSS (`src/styles.css`, variabili CSS).
- Messaggi utente in italiano; commenti nel codice in inglese.
