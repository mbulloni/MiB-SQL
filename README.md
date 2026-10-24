<p align="center"><img src="build/icons/128x128.png" width="96" alt="MiB-SQL"></p>

# MiB-SQL

IDE educativo per **MariaDB e MySQL** su Linux, ispirato a [dbForge Studio](https://www.devart.com/dbforge/) (che su Linux gira solo tramite CrossOver/Wine). Electron + React + Monaco, driver nativo `mariadb`.

![Database Explorer ed editor SQL](docs/screenshot-1.png)

## Funzioni (v0.3 — fasi 1-4)

**Connessioni**
- Profili salvati con colore d'ambiente (sviluppo/test/produzione: tinge scheda e barra di stato)
- Password nel portachiavi di sistema (Electron `safeStorage`); senza portachiavi vengono chieste a ogni sessione
- TCP, socket Unix, SSL/TLS (con verifica del certificato e CA), **tunnel SSH** (password, chiave privata, ssh-agent)
- Prova connessione; richiesta della password quando manca o è sbagliata

**Database Explorer**
- Database › Tabelle, Viste, Procedure, Funzioni, Trigger, Eventi; per tabella Colonne, Indici, Chiavi esterne
- Caricamento lazy da `information_schema`, filtro, conteggio righe stimato
- Menu contestuale: seleziona prime 1000 righe, conta righe, mostra DDL, genera CALL, copia/inserisci nome
- Trascina un oggetto nell'editor per inserirne il nome qualificato

**Editor SQL**
- Monaco con evidenziazione MySQL, una sessione dedicata per documento (USE, variabili, transazioni e tabelle temporanee restano per scheda)
- Autocompletamento sullo schema: tabelle, viste, routine, database, colonne delle tabelle referenziate e degli **alias** (`o.` → colonne di `orders`)
- Esegui script o selezione (F5), istruzione sotto il cursore (Ctrl+Invio), **piano di esecuzione** (Ctrl+E), interrompi (Maiusc+F5, `KILL QUERY`)
- Splitter compatibile con il client `mariadb`: stringhe, commenti, `DELIMITER` per procedure e trigger
- Errori sottolineati nell'editor alla riga indicata dal server; warning anche per le SELECT
- Schede ripristinate al riavvio, apri/salva `.sql`, `mib-sql script.sql` da terminale

**Risultati**
- Griglia virtualizzata (fino a 50.000 righe per resultset), più resultset per script e per `CALL`
- Ordinamento, ridimensionamento colonne, selezione a celle, copia TSV (Ctrl+C, con intestazioni Ctrl+Maiusc+C)
- Visualizzatore valore (doppio clic/Invio) con JSON formattato; BLOB in esadecimale, NULL distinti

**Modifica dati**
- Risultati da una sola tabella con chiave primaria (o UNIQUE NOT NULL) modificabili in griglia: F2, Invio, doppio clic o digitazione diretta; Ctrl+Maiusc+N imposta NULL
- Aggiungi righe (colonne non toccate = DEFAULT), Canc elimina/ripristina le righe selezionate
- Modifiche evidenziate, **anteprima SQL**, applicazione in un'unica transazione con controllo dei conflitti (riga cambiata da un altro utente → rollback completo)
- Dopo l'applicazione le righe vengono rilette: si vedono DEFAULT, AUTO_INCREMENT, trigger e `ON UPDATE CURRENT_TIMESTAMP`
- Il motivo della sola lettura è sempre indicato (join, espressioni, chiave primaria mancante)

**Designer tabelle**
- «Nuova tabella…» e «Modifica tabella…» dall'Explorer: documento a schede Colonne, Indici, Chiavi esterne, Script
- Colonne con tipo, PK, NOT NULL, AUTO_INCREMENT, predefinito (espressione SQL), commento, collation, ON UPDATE, colonne generate VIRTUAL/STORED; riordino con ↑ ↓
- Indici PRIMARY/UNIQUE/INDEX/FULLTEXT/SPATIAL con colonne ordinate e prefissi; chiavi esterne verso qualsiasi database con ON DELETE/ON UPDATE (le colonne della chiave primaria riferita si compilano da sole)
- Engine, collation (anche CONVERT TO), commento e rinomina della tabella
- Script generato per differenza: `CREATE TABLE` o `ALTER TABLE` minimo (rinominare una colonna non ricrea indici e FK), posizioni FIRST/AFTER, FK modificate eliminate e ricreate; validazione prima dell'esecuzione e conferma se si eliminano colonne
- Svuota (TRUNCATE) ed elimina tabella dall'Explorer, con conferma
- Verificato su MariaDB 10.11, MariaDB 11.4 e MySQL 8.4

**Filtri ed export**
- Filtro testuale su tutte le colonne e filtri per valore dal menu contestuale (Filtra per / Escludi)
- Export **CSV** (separatore, intestazioni, BOM per Excel, NULL), **Excel .xlsx**, **JSON**, **SQL INSERT**
- Righe mostrate (con filtri) oppure tutte le righe rieseguendo la query in streaming; dall'Explorer «Esporta dati…» per l'intera tabella

![Autocompletamento sugli alias ed errori](docs/screenshot-2.png)

![Modifica dati in griglia](docs/screenshot-4.png)

![Export](docs/screenshot-5.png)

![Designer tabelle](docs/screenshot-6.png)

![Piano di esecuzione](docs/screenshot-3.png)

## Installazione

Scarica `MiB-SQL-x.y.z.AppImage` dalle [release](https://github.com/mbulloni/MiB-SQL/releases), poi:

```bash
chmod +x MiB-SQL-*.AppImage
./MiB-SQL-*.AppImage
```

Su Ubuntu 24.04 serve `libfuse2t64` per avviare le AppImage.

## Scorciatoie

| Tasto | Azione |
|---|---|
| F5 / Ctrl+Maiusc+Invio | Esegui script o selezione |
| Ctrl+Invio | Esegui istruzione corrente |
| Ctrl+E | Piano di esecuzione (`EXPLAIN EXTENDED`) |
| Maiusc+F5 | Interrompi |
| Ctrl+N / Ctrl+O / Ctrl+S / Ctrl+W | Nuovo, apri, salva, chiudi documento |
| Ctrl+Maiusc+N | Nuova connessione (fuori dalla griglia) |
| Ctrl+Tab | Documento successivo |
| F2 / Invio | Modifica cella (Maiusc+Invio: visualizzatore) |
| Ctrl+Maiusc+N | Imposta NULL (in griglia) |
| Canc | Elimina/ripristina righe selezionate |

## Sviluppo

```bash
npm install
npm run dev        # Vite (porta 5174) + Electron
npm test           # splitter SQL, modifiche in griglia, export, designer
npm run typecheck
npm run dist       # AppImage in release/
```

Database di prova: `scripts/demo.sql` crea `mibsql_demo` (clienti, prodotti, 20.000 ordini, vista, funzione, procedura, trigger, evento) e l'utente `mibsql`/`mibsql` con permessi solo su quel database.

```bash
mysql -u root -p < scripts/demo.sql
```

## Roadmap

5. Diagramma ER
6. Schema compare e data compare con script di sincronizzazione
7. Backup/restore, import guidato
8. Profiler query, utenti e privilegi, monitor sessioni

## Limiti noti (da implementare)

- I resultset oltre 50.000 righe vengono letti per intero e poi troncati: manca il fetch progressivo in streaming (l'export di tutte le righe invece è in streaming)
- Colonne binarie (BLOB/VARBINARY) non modificabili in griglia; manca un editor esadecimale/da file
- Le modifiche in griglia usano una connessione separata da quella del documento: non vedono le transazioni aperte nello script
- Alla chiusura della finestra non c'è conferma per i documenti modificati (il testo però viene ripristinato al riavvio)
- Blocchi `BEGIN … END` senza `DELIMITER` vengono divisi ai `;` interni, come nel client `mariadb`
- Solo tema chiaro
- Designer: niente CHECK, partizioni, ordine DESC negli indici, indici invisibili; trigger e viste si modificano ancora come SQL
- Le istruzioni DDL non sono transazionali: se una fallisce a metà, quelle precedenti restano applicate (il designer lo segnala e ricarica la struttura dal server)

## Licenza

MIT
