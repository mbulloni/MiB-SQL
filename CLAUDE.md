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
- `electron/sqlsplit.cjs` — splitter tipo client mariadb (quote, commenti, `DELIMITER`), offset sul testo originale. Testato in `tests/`.
- `electron/explorer.cjs` — query su `information_schema`, `SHOW CREATE` per i DDL.
- `src/store.ts` — zustand: profili, stato connessioni, cache metadati (`metaKey`), documenti, dialog. `openConn` gestisce il prompt password su errori di autenticazione.
- `src/editor.ts` — Monaco: un modello per documento, dirty per `alternativeVersionId`, completamento (alias via `tableRefs`), marker errori.
- `src/actions.ts` — azioni documento (run, cancel, save, DDL, select top), persistenza schede in localStorage.
- `src/components/` — `Explorer`, `SqlEditor` (un'unica istanza Monaco, swap modelli), `ResultsPanel`, `ResultGrid` (virtualizzata, righe 22px), `Dialogs`, `ContextMenu`, `Icon` (SVG inline).

## Test e screenshot

- `MIBSQL_USERDATA=<dir>` usa un profilo separato (mai il profilo reale nei test).
- `MIBSQL_SHOT=out.png MIBSQL_SCRIPT=script.js [MIBSQL_WAIT=ms]`: esegue lo script nel renderer, salva il valore restituito in `out.json`, cattura e chiude. Lo script usa `window.__mib = { useStore, actions, monaco }`.
- DB di prova: `scripts/demo.sql` → `mibsql_demo` + utente `mibsql`/`mibsql` limitato a quel db. Non usare i db `r_lab_*` per i test.
- Tunnel SSH verificato con container `mariadb:11.4` + `linuxserver/openssh-server` sulla stessa rete Docker.

## Convenzioni

- Main process CommonJS (`.cjs`), renderer TypeScript/React senza framework CSS (`src/styles.css`, variabili CSS).
- Messaggi utente in italiano; commenti nel codice in inglese.
