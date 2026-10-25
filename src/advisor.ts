// Server health advisor: rules over SHOW GLOBAL STATUS / VARIABLES and a few information_schema aggregates,
// in the spirit of mysqltuner. Every finding says what was measured, why it matters and what to change; a
// fix names the variable, the proposed value and whether SET GLOBAL can apply it without a restart.
// Pure functions, tested in tests/advisor.test.mjs.
import { locale, t, tn } from './i18n.ts';
import { duration } from './monitor.ts';

export type Severity = 'critical' | 'warning' | 'info' | 'ok';

export interface Fix {
  variable: string;
  value: string;        // for SET GLOBAL (bytes as integers)
  cnf?: string;         // for the configuration file (2G, 256M…), when it reads better than value
  dynamic: boolean;     // SET GLOBAL applies it at once
}

export interface Finding {
  id: string;
  severity: Severity;
  area: string;
  title: string;
  value: string;
  detail: string;
  advice?: string;
  fixes?: Fix[];
  tables?: { db: string | null; name: string | null; note: string }[];
  link?: 'procs' | 'top' | 'indexes' | 'maint';
}

export interface Overview {
  at: number;
  status: Record<string, string | null>;
  variables: Record<string, string | null>;
  engines: { engine: string; tables: number; data: number; idx: number; free: number }[];
  noPk: { db: string | null; name: string | null; engine: string | null; rows: number | null }[];
  fragmented: { db: string | null; name: string | null; engine: string | null; size: number; free: number }[];
  myisam: { db: string | null; name: string | null; size: number }[];
  deadlocks: number | null;
}

const MB = 1024 * 1024;
const GB = 1024 * MB;

export function bytes(n: number | null | undefined) {
  if (n === null || n === undefined || !Number.isFinite(n)) return '';
  if (n < 1024) return `${n} B`;
  const u = ['KB', 'MB', 'GB', 'TB'];
  let v = n / 1024;
  let i = 0;
  while (v >= 1024 && i < u.length - 1) { v /= 1024; i++; }
  return `${v.toLocaleString(locale(), { maximumFractionDigits: v < 10 ? 1 : 0 })} ${u[i]}`;
}

/** Size as written in my.cnf: 2G, 256M, else bytes. */
export function cnfSize(n: number) {
  if (n % GB === 0) return `${n / GB}G`;
  if (n % MB === 0) return `${n / MB}M`;
  return String(n);
}

/** Rounds up to a multiple of step. */
const ceilTo = (n: number, step: number) => Math.ceil(n / step) * step;
const pct = (v: number, digits = 1) => `${(v * 100).toLocaleString(locale(), { maximumFractionDigits: digits })}%`;
const int = (v: number) => Math.round(v).toLocaleString(locale());

/** "10.11.14-MariaDB" → [10, 11, 14]. */
export function versionOf(v: string | null | undefined): number[] {
  const m = /^(\d+)\.(\d+)\.(\d+)/.exec(v ?? '');
  return m ? [Number(m[1]), Number(m[2]), Number(m[3])] : [0, 0, 0];
}
const atLeast = (v: number[], ...min: number[]) => {
  for (let i = 0; i < min.length; i++) if ((v[i] ?? 0) !== min[i]) return (v[i] ?? 0) > min[i];
  return true;
};

export function advise(o: Overview): Finding[] {
  const out: Finding[] = [];
  const s = (k: string) => { const v = o.status[k]; return v === null || v === undefined || v === '' ? NaN : Number(v); };
  const has = (k: string) => Number.isFinite(s(k));
  const v = (k: string) => o.variables[k] ?? null;
  const vn = (k: string) => Number(o.variables[k] ?? NaN);
  const on = (k: string) => /^(ON|1|YES|TRUE)$/i.test(v(k) ?? '');
  const mariadb = /mariadb/i.test(v('version') ?? '') || /mariadb/i.test(v('version_comment') ?? '');
  const ver = versionOf(v('version'));
  const uptime = Math.max(1, s('Uptime') || 1);
  const hours = uptime / 3600;
  const perHour = (n: number) => n / hours;
  const add = (f: Finding) => out.push(f);

  // ---- general ----
  if (uptime < 86400) add({
    id: 'uptime', severity: 'info', area: t('Generale'), title: t('Server avviato da poco'), value: duration(uptime),
    detail: t('I contatori del server si azzerano a ogni avvio: con meno di 24 ore di attività le percentuali qui sotto sono poco rappresentative.'),
    advice: t('Ricontrolla dopo almeno un giorno di carico normale.'),
  });

  // ---- InnoDB buffer pool ----
  const pool = vn('innodb_buffer_pool_size');
  const inno = o.engines.find((e) => e.engine.toLowerCase() === 'innodb');
  const innoSize = inno ? inno.data + inno.idx : 0;
  if (Number.isFinite(pool) && inno) {
    if (innoSize > pool) {
      const rec = Math.min(ceilTo(innoSize * 1.25, 128 * MB), Math.max(pool * 4, 1 * GB));
      add({
        id: 'pool-size', severity: innoSize > pool * 2 ? 'warning' : 'info', area: 'InnoDB', title: t('Buffer pool più piccolo dei dati InnoDB'),
        value: `${bytes(pool)} / ${bytes(innoSize)}`,
        detail: t('Il buffer pool tiene in memoria dati e indici InnoDB: quando i dati usati spesso non ci stanno, ogni lettura va su disco.'),
        advice: t('Aumenta innodb_buffer_pool_size verso {0} se la RAM lo consente: su un server dedicato al database fino al 70-80% della RAM, lasciando spazio al sistema e alle connessioni.', bytes(rec)),
        fixes: [{ variable: 'innodb_buffer_pool_size', value: String(rec), cnf: cnfSize(rec), dynamic: true }],
      });
    } else add({
      id: 'pool-size', severity: 'ok', area: 'InnoDB', title: t('Il buffer pool contiene tutti i dati InnoDB'), value: `${bytes(pool)} / ${bytes(innoSize)}`,
      detail: t('Dati e indici InnoDB ({0}) stanno interamente nel buffer pool ({1}).', bytes(innoSize), bytes(pool)),
    });
  }
  const req = s('Innodb_buffer_pool_read_requests');
  const reads = s('Innodb_buffer_pool_reads');
  if (req > 10000) {
    const hit = 1 - reads / req;
    add({
      id: 'pool-hit', severity: hit < 0.95 ? 'critical' : hit < 0.99 ? 'warning' : 'ok', area: 'InnoDB', title: t('Letture servite dal buffer pool'), value: pct(hit, 2),
      detail: t('{0} letture logiche, {1} dal disco.', int(req), int(reads)),
      advice: hit < 0.99 ? t('Sotto il 99% molte letture vanno su disco: aumenta innodb_buffer_pool_size o riduci le scansioni complete (vedi Indici e Query pesanti).') : undefined,
      link: hit < 0.99 ? 'top' : undefined,
    });
  }
  if (s('Innodb_buffer_pool_wait_free') > 0) add({
    id: 'pool-wait', severity: 'warning', area: 'InnoDB', title: t('Attese di pagine libere nel buffer pool'), value: int(s('Innodb_buffer_pool_wait_free')),
    detail: t('InnoDB ha dovuto aspettare che si liberassero pagine: il buffer pool è troppo piccolo o la scrittura su disco delle pagine modificate non tiene il passo.'),
    advice: t('Aumenta innodb_buffer_pool_size; su dischi veloci valuta innodb_io_capacity più alto.'),
  });

  // ---- redo log ----
  const capacity = Number.isFinite(vn('innodb_redo_log_capacity')) ? vn('innodb_redo_log_capacity')
    : vn('innodb_log_file_size') * (Number.isFinite(vn('innodb_log_files_in_group')) ? vn('innodb_log_files_in_group') : 1);
  if (Number.isFinite(capacity) && hours >= 1 && s('Innodb_os_log_written') > 0) {
    const hourly = perHour(s('Innodb_os_log_written'));
    if (capacity < hourly) {
      const rec = Math.max(256 * MB, ceilTo(hourly, 128 * MB));
      const redoVar = Number.isFinite(vn('innodb_redo_log_capacity')) ? 'innodb_redo_log_capacity' : 'innodb_log_file_size';
      add({
        id: 'redo', severity: capacity < hourly / 4 ? 'warning' : 'info', area: 'InnoDB', title: t('Redo log piccolo per il volume di scritture'),
        value: t('{0} contro {1}/ora', bytes(capacity), bytes(hourly)),
        detail: t('Un redo log che si riempie in meno di un\'ora costringe InnoDB a checkpoint frequenti, con picchi di scrittura su disco.'),
        advice: t('Porta {0} a circa un\'ora di scritture: {1}.', redoVar, bytes(rec)),
        fixes: [{ variable: redoVar, value: String(rec), cnf: cnfSize(rec), dynamic: redoVar === 'innodb_redo_log_capacity' || (mariadb && atLeast(ver, 10, 9)) }],
      });
    }
  }
  if (s('Innodb_log_waits') > 0) {
    const cur = vn('innodb_log_buffer_size');
    const rec = Math.max(cur * 2, 32 * MB);
    add({
      id: 'log-waits', severity: s('Innodb_log_waits') < 100 ? 'info' : 'warning', area: 'InnoDB', title: t('Attese sul buffer del redo log'), value: int(s('Innodb_log_waits')),
      detail: t('Le transazioni hanno aspettato che il buffer del redo log ({0}) venisse scritto: succede con transazioni grandi o molte scritture concorrenti.', bytes(cur)),
      advice: t('Aumenta innodb_log_buffer_size a {0}.', bytes(rec)),
      fixes: [{ variable: 'innodb_log_buffer_size', value: String(rec), cnf: cnfSize(rec), dynamic: !mariadb }],
    });
  }
  if (v('innodb_file_per_table') !== null && !on('innodb_file_per_table')) add({
    id: 'file-per-table', severity: 'warning', area: 'InnoDB', title: t('innodb_file_per_table disattivato'), value: 'OFF',
    detail: t('Le tabelle nuove finiscono nel tablespace di sistema, che non si restringe mai: lo spazio liberato da DROP o OPTIMIZE non torna al disco.'),
    advice: t('Attivalo: vale per le tabelle create o ricostruite da quel momento.'),
    fixes: [{ variable: 'innodb_file_per_table', value: 'ON', dynamic: true }],
  });
  if (v('innodb_flush_log_at_trx_commit') !== null && v('innodb_flush_log_at_trx_commit') !== '1') add({
    id: 'flush-commit', severity: 'info', area: 'InnoDB', title: t('Durabilità delle transazioni ridotta'), value: `innodb_flush_log_at_trx_commit = ${v('innodb_flush_log_at_trx_commit')}`,
    detail: t('Con un valore diverso da 1 il redo log non viene scritto su disco a ogni COMMIT: è più veloce, ma un crash del sistema può perdere circa l\'ultimo secondo di transazioni.'),
    advice: t('Va bene se è una scelta consapevole (repliche, dati ricostruibili); per dati che non si possono perdere usa 1.'),
  });

  // ---- temporary tables ----
  const tmp = s('Created_tmp_tables');
  const disk = s('Created_tmp_disk_tables');
  const tmpSize = vn('tmp_table_size');
  const heap = vn('max_heap_table_size');
  if (tmp > 100) {
    const r = disk / tmp;
    const sev: Severity = r > 0.5 ? 'critical' : r > 0.25 ? 'warning' : 'ok';
    const rec = Math.max(64 * MB, Math.min(tmpSize, heap) * 2);
    add({
      id: 'tmp-disk', severity: sev, area: t('Memoria'), title: t('Tabelle temporanee su disco'), value: pct(r),
      detail: t('{0} tabelle temporanee interne (GROUP BY, ORDER BY, DISTINCT, UNION, sottoquery), {1} create su disco.', int(tmp), int(disk)),
      advice: sev === 'ok' ? undefined : t('Aumenta insieme tmp_table_size e max_heap_table_size (conta il minore dei due) a {0}; le colonne TEXT/BLOB nel risultato intermedio portano comunque su disco: seleziona solo quelle necessarie.', bytes(rec)),
      fixes: sev === 'ok' ? undefined : [
        { variable: 'tmp_table_size', value: String(rec), cnf: cnfSize(rec), dynamic: true },
        { variable: 'max_heap_table_size', value: String(rec), cnf: cnfSize(rec), dynamic: true },
      ],
    });
  }
  if (Number.isFinite(tmpSize) && Number.isFinite(heap) && tmpSize !== heap) add({
    id: 'tmp-mismatch', severity: 'info', area: t('Memoria'), title: t('tmp_table_size diverso da max_heap_table_size'), value: `${bytes(tmpSize)} / ${bytes(heap)}`,
    detail: t('Per le tabelle temporanee in memoria vale il minore dei due valori ({0}).', bytes(Math.min(tmpSize, heap))),
    advice: t('Impostali allo stesso valore.'),
    fixes: [{ variable: tmpSize < heap ? 'tmp_table_size' : 'max_heap_table_size', value: String(Math.max(tmpSize, heap)), cnf: cnfSize(Math.max(tmpSize, heap)), dynamic: true }],
  });

  // ---- sorts and joins ----
  const sorts = s('Sort_scan') + s('Sort_range');
  const passes = s('Sort_merge_passes');
  if (sorts > 1000 && passes / sorts > 0.1) {
    const cur = vn('sort_buffer_size');
    const rec = Math.min(Math.max(cur * 2, 2 * MB), 8 * MB);
    add({
      id: 'sort', severity: 'warning', area: t('Memoria'), title: t('Ordinamenti a più passaggi'), value: pct(passes / sorts),
      detail: t('{0} passaggi di fusione su {1} ordinamenti: i dati da ordinare non stavano nel sort buffer ({2}).', int(passes), int(sorts), bytes(cur)),
      advice: t('Prima un indice che eviti l\'ordinamento (ORDER BY sulle colonne dell\'indice); poi sort_buffer_size a {0}. È memoria per connessione: non esagerare.', bytes(rec)),
      fixes: cur < rec ? [{ variable: 'sort_buffer_size', value: String(rec), cnf: cnfSize(rec), dynamic: true }] : undefined,
    });
  }
  const fullJoin = s('Select_full_join');
  if (fullJoin > 0 && perHour(fullJoin) > 10) add({
    id: 'full-join', severity: 'warning', area: t('Query'), title: t('Join senza indice'), value: t('{0} ({1}/ora)', int(fullJoin), int(perHour(fullJoin))),
    detail: t('Join in cui la tabella interna viene letta per intero per ogni riga dell\'altra (Select_full_join).'),
    advice: t('Cerca in Query pesanti le istruzioni con «senza indice» e aggiungi un indice sulle colonne della condizione di join; aumentare join_buffer_size attenua soltanto il problema.'),
    link: 'top',
  });
  const handlerKeys = ['Handler_read_first', 'Handler_read_key', 'Handler_read_last', 'Handler_read_next', 'Handler_read_prev', 'Handler_read_rnd', 'Handler_read_rnd_next'];
  const totalReads = handlerKeys.reduce((n, k) => n + (has(k) ? s(k) : 0), 0);
  if (totalReads > 1e6) {
    const r = s('Handler_read_rnd_next') / totalReads;
    if (r > 0.5) add({
      id: 'scans', severity: r > 0.8 ? 'warning' : 'info', area: t('Query'), title: t('Righe lette con scansioni complete'), value: pct(r),
      detail: t('{0} delle righe lette dal server arrivano da scansioni sequenziali di tabella (Handler_read_rnd_next) invece che da un indice.', pct(r)),
      advice: t('Guarda Indici › Tabelle lette senza indice e Query pesanti: le query senza indice vanno corrette con indici sulle colonne di WHERE e JOIN.'),
      link: 'indexes',
    });
  }

  // ---- caches ----
  const hits = s('Table_open_cache_hits');
  const misses = s('Table_open_cache_misses');
  const toc = vn('table_open_cache');
  if (Number.isFinite(hits) && Number.isFinite(misses) && misses > 1000 && hits / (hits + misses) < 0.9) {
    const rec = Math.max(toc * 2, 2000);
    add({
      id: 'table-cache', severity: 'warning', area: t('Cache'), title: t('Cache delle tabelle aperte insufficiente'), value: pct(hits / (hits + misses)),
      detail: t('Solo il {0} delle aperture di tabella è servito dalla cache (table_open_cache = {1}).', pct(hits / (hits + misses)), int(toc)),
      advice: t('Aumenta table_open_cache a {0}; verifica che open_files_limit del sistema sia sufficiente.', int(rec)),
      fixes: [{ variable: 'table_open_cache', value: String(rec), dynamic: true }],
    });
  } else if (!Number.isFinite(hits) && s('Open_tables') >= toc * 0.95 && perHour(s('Opened_tables')) > 100) {
    add({
      id: 'table-cache', severity: 'warning', area: t('Cache'), title: t('Cache delle tabelle aperte piena'), value: `${int(s('Open_tables'))} / ${int(toc)}`,
      detail: t('{0} tabelle aperte all\'ora: la cache è piena e le tabelle vengono richiuse e riaperte.', int(perHour(s('Opened_tables')))),
      advice: t('Aumenta table_open_cache.'),
      fixes: [{ variable: 'table_open_cache', value: String(toc * 2), dynamic: true }],
    });
  }
  const tdc = vn('table_definition_cache');
  if (Number.isFinite(tdc) && s('Open_table_definitions') >= tdc * 0.95 && perHour(s('Opened_table_definitions')) > 50) add({
    id: 'def-cache', severity: 'info', area: t('Cache'), title: t('Cache delle definizioni di tabella piena'), value: `${int(s('Open_table_definitions'))} / ${int(tdc)}`,
    detail: t('Le definizioni delle tabelle vengono rilette dal disco: ci sono più tabelle in uso di quante la cache ne contenga.'),
    advice: t('Aumenta table_definition_cache ad almeno il numero di tabelle usate abitualmente.'),
    fixes: [{ variable: 'table_definition_cache', value: String(Math.max(tdc * 2, 2000)), dynamic: true }],
  });
  const conns = s('Connections');
  const created = s('Threads_created');
  if (conns > 1000 && v('thread_handling') !== 'pool-of-threads' && created / conns > 0.05 && vn('thread_cache_size') < s('Max_used_connections')) {
    const cur = vn('thread_cache_size');
    const rec = Math.max(16, Math.min(Math.max(cur * 2, Math.ceil(s('Max_used_connections') / 2)), 256));
    add({
      id: 'thread-cache', severity: 'warning', area: t('Connessioni'), title: t('Thread creati a ogni connessione'), value: pct(created / conns),
      detail: t('{0} thread creati per {1} connessioni: la cache dei thread (thread_cache_size = {2}) non basta per il ritmo delle connessioni.', int(created), int(conns), int(cur)),
      advice: t('Aumenta thread_cache_size a {0}; meglio ancora un pool di connessioni nell\'applicazione.', int(rec)),
      fixes: [{ variable: 'thread_cache_size', value: String(rec), dynamic: true }],
    });
  }
  if (v('query_cache_type') !== null && !/^(OFF|0)$/i.test(v('query_cache_type') ?? '') && vn('query_cache_size') > 0) {
    const qh = s('Qcache_hits');
    const sel = s('Com_select');
    const prunes = s('Qcache_lowmem_prunes');
    add({
      id: 'qcache', severity: perHour(prunes) > 50 ? 'warning' : 'info', area: t('Cache'), title: t('Query cache attiva'),
      value: qh + sel > 0 ? t('{0} di successi', pct(qh / (qh + sel))) : 'ON',
      detail: t('La query cache è protetta da un unico lock: con molte connessioni che scrivono diventa un collo di bottiglia, e ogni modifica a una tabella invalida tutte le sue query in cache.') + (prunes ? ` ${t('{0} query rimosse per mancanza di memoria.', int(prunes))}` : ''),
      advice: t('Sui carichi con scritture frequenti disattivala (query_cache_type = OFF, query_cache_size = 0); tienila solo se i dati cambiano raramente.'),
      fixes: [{ variable: 'query_cache_type', value: 'OFF', dynamic: true }, { variable: 'query_cache_size', value: '0', dynamic: true }],
    });
  }
  const myisam = o.engines.find((e) => e.engine.toLowerCase() === 'myisam');
  const krr = s('Key_read_requests');
  if (myisam && myisam.idx > 0 && krr > 10000 && s('Key_reads') / krr > 0.01) {
    const rec = Math.max(vn('key_buffer_size'), ceilTo(myisam.idx * 1.2, 16 * MB));
    add({
      id: 'key-buffer', severity: 'warning', area: 'MyISAM', title: t('Key buffer MyISAM insufficiente'), value: pct(s('Key_reads') / krr, 2),
      detail: t('Letture di indici MyISAM fatte da disco invece che dal key buffer ({0}); indici MyISAM: {1}.', bytes(vn('key_buffer_size')), bytes(myisam.idx)),
      advice: t('Aumenta key_buffer_size a {0}.', bytes(rec)),
      fixes: [{ variable: 'key_buffer_size', value: String(rec), cnf: cnfSize(rec), dynamic: true }],
    });
  }
  if (o.myisam.length) add({
    id: 'myisam', severity: 'info', area: 'MyISAM', title: tn(o.myisam.length, '{0} tabella MyISAM', '{0} tabelle MyISAM'), value: bytes(o.myisam.reduce((n, x) => n + x.size, 0)),
    detail: t('MyISAM non ha transazioni né recupero dopo un crash e blocca l\'intera tabella a ogni scrittura.'),
    advice: t('Valuta la conversione: ALTER TABLE … ENGINE=InnoDB (ricostruisce la tabella; prima controlla gli indici FULLTEXT e lo spazio su disco).'),
    tables: o.myisam.map((x) => ({ db: x.db, name: x.name, note: bytes(x.size) })),
  });

  // ---- connections ----
  const maxConn = vn('max_connections');
  const used = s('Max_used_connections');
  if (Number.isFinite(maxConn) && Number.isFinite(used)) {
    const r = used / maxConn;
    const refused = s('Connection_errors_max_connections');
    if (r >= 0.75 || refused > 0) {
      const rec = Math.ceil(Math.max(used * 1.5, maxConn * 1.25));
      add({
        id: 'max-conn', severity: refused > 0 || r >= 0.9 ? 'critical' : 'warning', area: t('Connessioni'), title: t('Connessioni vicine al limite'), value: `${int(used)} / ${int(maxConn)}`,
        detail: t('Il picco di connessioni contemporanee è arrivato al {0} di max_connections.', pct(r)) + (refused > 0 ? ` ${t('{0} connessioni rifiutate per il limite raggiunto.', int(refused))}` : ''),
        advice: t('Aumenta max_connections a {0} (ogni connessione usa memoria) e controlla che l\'applicazione chiuda le connessioni o usi un pool.', int(rec)),
        fixes: [{ variable: 'max_connections', value: String(rec), dynamic: true }],
        link: 'procs',
      });
    } else add({
      id: 'max-conn', severity: 'ok', area: t('Connessioni'), title: t('Connessioni entro il limite'), value: `${int(used)} / ${int(maxConn)}`,
      detail: t('Picco di connessioni contemporanee: {0} di max_connections.', pct(r)),
    });
  }
  const aborted = s('Aborted_connects');
  if (conns > 100 && aborted > 100 && aborted / conns > 0.05) add({
    id: 'aborted', severity: 'warning', area: t('Connessioni'), title: t('Tentativi di connessione falliti'), value: t('{0} ({1})', int(aborted), pct(aborted / conns)),
    detail: t('Connessioni non riuscite: password errate, utenti o host non autorizzati, timeout dell\'handshake.'),
    advice: t('Controlla le credenziali delle applicazioni e il log degli errori del server; tentativi da host sconosciuti possono indicare un attacco.'),
  });
  const abortedClients = s('Aborted_clients');
  if (conns > 1000 && abortedClients / conns > 0.05) add({
    id: 'aborted-clients', severity: 'info', area: t('Connessioni'), title: t('Connessioni chiuse senza disconnettersi'), value: pct(abortedClients / conns),
    detail: t('Client che terminano senza chiudere la connessione o che restano inattivi oltre wait_timeout ({0} s).', int(vn('wait_timeout'))),
    advice: t('Fai chiudere le connessioni all\'applicazione; se usa un pool, allinea il suo timeout a wait_timeout.'),
  });
  const openFiles = s('Open_files');
  const fileLimit = vn('open_files_limit');
  if (Number.isFinite(openFiles) && fileLimit > 0 && openFiles / fileLimit > 0.75) add({
    id: 'open-files', severity: 'warning', area: t('Sistema'), title: t('File aperti vicini al limite'), value: `${int(openFiles)} / ${int(fileLimit)}`,
    detail: t('Se il server raggiunge open_files_limit non riesce più ad aprire tabelle.'),
    advice: t('Aumenta open_files_limit nel file di configurazione (e LimitNOFILE del servizio systemd); richiede il riavvio.'),
    fixes: [{ variable: 'open_files_limit', value: String(fileLimit * 2), dynamic: false }],
  });

  // ---- logging ----
  if (!on('slow_query_log')) add({
    id: 'slow-log', severity: 'info', area: t('Diagnostica'), title: t('Log delle query lente disattivato'), value: 'OFF',
    detail: t('Senza il log delle query lente (o performance_schema) non si sa quali istruzioni pesano di più.'),
    advice: t('Attivalo con una soglia di 1 secondo: si può fare da Query pesanti con un clic.'),
    fixes: [{ variable: 'slow_query_log', value: 'ON', dynamic: true }, { variable: 'long_query_time', value: '1', dynamic: true }],
    link: 'top',
  });
  else if (vn('long_query_time') >= 10) add({
    id: 'slow-threshold', severity: 'info', area: t('Diagnostica'), title: t('Soglia delle query lente alta'), value: `${vn('long_query_time')} s`,
    detail: t('Vengono registrate solo le query oltre {0} secondi: quelle da 1-5 secondi, spesso le più frequenti, sfuggono.', vn('long_query_time')),
    advice: t('Abbassa long_query_time a 1 (vale per le connessioni aperte dopo la modifica).'),
    fixes: [{ variable: 'long_query_time', value: '1', dynamic: true }],
  });
  const questions = s('Questions');
  const slow = s('Slow_queries');
  if (questions > 10000 && slow / questions > 0.05) add({
    id: 'slow-ratio', severity: 'warning', area: t('Query'), title: t('Molte query lente'), value: pct(slow / questions),
    detail: t('{0} query oltre long_query_time su {1}.', int(slow), int(questions)),
    advice: t('Apri Query pesanti per vedere quali sono e analizzarle.'),
    link: 'top',
  });
  if (v('performance_schema') !== null && !on('performance_schema')) add({
    id: 'ps', severity: 'info', area: t('Diagnostica'), title: t('performance_schema disattivato'), value: 'OFF',
    detail: t('performance_schema raccoglie le statistiche per istruzione e per indice usate da Query pesanti e da Indici › inutilizzati. Costa qualche punto percentuale di CPU.'),
    advice: t('Aggiungi performance_schema = ON nella sezione [mysqld] del file di configurazione e riavvia il server.') + (mariadb ? ` ${t('In alternativa su MariaDB userstat = ON (dinamico) dà le statistiche d\'uso degli indici.')}` : ''),
    fixes: [{ variable: 'performance_schema', value: 'ON', dynamic: false }],
    link: 'top',
  });
  if (on('log_bin') && s('Binlog_cache_use') > 1000 && s('Binlog_cache_disk_use') / s('Binlog_cache_use') > 0.1) {
    const rec = Math.max(vn('binlog_cache_size') * 2, 1 * MB);
    add({
      id: 'binlog-cache', severity: 'warning', area: t('Replica'), title: t('Cache del binary log su disco'), value: pct(s('Binlog_cache_disk_use') / s('Binlog_cache_use')),
      detail: t('Le transazioni più grandi di binlog_cache_size ({0}) vengono appoggiate su un file temporaneo prima di finire nel binary log.', bytes(vn('binlog_cache_size'))),
      advice: t('Aumenta binlog_cache_size a {0}.', bytes(rec)),
      fixes: [{ variable: 'binlog_cache_size', value: String(rec), cnf: cnfSize(rec), dynamic: true }],
    });
  }

  // ---- locking ----
  const lockWaits = s('Innodb_row_lock_waits');
  const lockAvg = s('Innodb_row_lock_time_avg');
  if (lockWaits > 0 && (lockAvg > 500 || perHour(lockWaits) > 100)) add({
    id: 'row-locks', severity: lockWaits < 20 ? 'info' : lockAvg > 2000 && perHour(lockWaits) > 10 ? 'critical' : 'warning', area: t('Lock'), title: t('Contesa sui lock di riga'),
    value: t('{0} attese, media {1} ms', int(lockWaits), int(lockAvg)),
    detail: t('Transazioni che aspettano righe bloccate da altre transazioni.'),
    advice: t('Tieni brevi le transazioni, aggiorna le righe nello stesso ordine e usa indici nelle condizioni di UPDATE/DELETE (senza indice vengono bloccate tutte le righe lette). Processi › Blocchi mostra chi blocca chi in tempo reale.'),
    link: 'procs',
  });
  const deadlocks = has('Innodb_deadlocks') ? s('Innodb_deadlocks') : o.deadlocks;
  if (deadlocks !== null && deadlocks > 0) add({
    id: 'deadlocks', severity: deadlocks / Math.max(1, uptime / 86400) > 10 ? 'warning' : 'info', area: t('Lock'), title: t('Deadlock'),
    value: t('{0} dall\'avvio', int(deadlocks)),
    detail: t('Due transazioni si bloccavano a vicenda e InnoDB ne ha annullata una.'),
    advice: t('Processi › Ultimo deadlock mostra le istruzioni coinvolte; accedi alle righe sempre nello stesso ordine e ripeti la transazione annullata nell\'applicazione.'),
    link: 'procs',
  });

  // ---- schema ----
  if (o.noPk.length) add({
    id: 'no-pk', severity: 'warning', area: t('Schema'), title: tn(o.noPk.length, '{0} tabella senza chiave primaria', '{0} tabelle senza chiave primaria'), value: String(o.noPk.length),
    detail: t('InnoDB ordina le righe per chiave primaria: senza, usa una chiave nascosta. Le repliche basate su riga e i cluster Galera diventano lentissimi su UPDATE/DELETE, e le righe duplicate non si distinguono.'),
    advice: t('Aggiungi una chiave primaria (Indici propone l\'istruzione per ogni tabella).'),
    tables: o.noPk.map((x) => ({ db: x.db, name: x.name, note: x.rows !== null ? tn(x.rows, '{0} riga', '{0} righe') : '' })),
    link: 'indexes',
  });
  if (o.fragmented.length) add({
    id: 'fragmented', severity: 'info', area: t('Schema'), title: tn(o.fragmented.length, '{0} tabella frammentata', '{0} tabelle frammentate'),
    value: bytes(o.fragmented.reduce((n, x) => n + x.free, 0)),
    detail: t('Spazio allocato ma libero (oltre il 20% e oltre 10 MB per tabella), lasciato da DELETE e UPDATE.'),
    advice: t('OPTIMIZE TABLE lo recupera: Manutenzione tabelle › Ottimizza.'),
    tables: o.fragmented.map((x) => ({ db: x.db, name: x.name, note: t('{0} liberi su {1}', bytes(x.free), bytes(x.size + x.free)) })),
    link: 'maint',
  });

  const order: Record<Severity, number> = { critical: 0, warning: 1, info: 2, ok: 3 };
  return out.sort((a, b) => order[a.severity] - order[b.severity]);
}

/** 0-100: 100 minus 15 per critical and 5 per warning finding. */
export const score = (fs: Finding[]) => Math.max(0, 100 - fs.reduce((n, f) => n + (f.severity === 'critical' ? 15 : f.severity === 'warning' ? 5 : 0), 0));

/** SQL to apply a fix now, and the line for the configuration file. */
export function fixSql(f: Fix, persist = false) {
  const value = /^-?\d+(\.\d+)?$/.test(f.value) || /^(ON|OFF)$/i.test(f.value) ? f.value : `'${f.value}'`;
  return `SET ${persist ? 'PERSIST' : 'GLOBAL'} ${f.variable} = ${value};`;
}
export const fixCnf = (fs: Fix[]) => `[mysqld]\n${fs.map((f) => `${f.variable} = ${f.cnf ?? f.value}`).join('\n')}\n`;
