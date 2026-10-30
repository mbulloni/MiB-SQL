const { app, BrowserWindow, ipcMain, dialog, Menu, shell } = require('electron');
const path = require('path');
const fs = require('fs');
const connections = require('./connections.cjs');
const server = require('./server.cjs');
const tds = require('./tds.cjs');
const entra = require('./entra.cjs');
const explorer = require('./explorer.cjs');
const exporter = require('./export.cjs');
const datacompare = require('./datacompare.cjs');
const backup = require('./backup.cjs');
const importer = require('./importer.cjs');
const assistant = require('./assistant.cjs');
const library = require('./library.cjs');
const objects = require('./objects.cjs');
const maint = require('./maint.cjs');
const procs = require('./procs.cjs');
const perf = require('./perf.cjs');
const datagen = require('./datagen.cjs');
const search = require('./search.cjs');
const logs = require('./logs.cjs');
const copydb = require('./copydb.cjs');
const updates = require('./updates.cjs');
const i18n = require('./i18n.cjs');
const { t } = require('./i18n.cjs');

app.commandLine.appendSwitch('no-sandbox');
// Separate profile for tests and screenshots, so they never touch the user's saved connections.
if (process.env.MIBSQL_USERDATA) app.setPath('userData', process.env.MIBSQL_USERDATA);
// Hardware acceleration off by default: with some GPU drivers (VMs, nouveau, old Intel) the window stays black
// without any crash to detect. Editor, grid and SVG diagrams don't need it; `--enable-gpu` or MIBSQL_ENABLE_GPU=1 turn it on.
if (!process.argv.includes('--enable-gpu') && !process.env.MIBSQL_ENABLE_GPU) app.disableHardwareAcceleration();

let win;

function createWindow() {
  win = new BrowserWindow({
    width: 1500,
    height: 920,
    minWidth: 1000,
    minHeight: 600,
    backgroundColor: '#f3f4f6',
    title: 'MiB-SQL',
    icon: path.join(__dirname, 'icon.png'),
    webPreferences: {
      preload: path.join(__dirname, 'preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });
  Menu.setApplicationMenu(null);
  win.webContents.on('before-input-event', (_e, input) => {
    if (input.type === 'keyDown' && (input.key === 'F12' || (input.control && input.shift && input.key.toLowerCase() === 'i'))) win.webContents.toggleDevTools();
  });
  // closing asks the renderer first: unsaved files, unapplied table designs or grid edits get a confirmation
  let closing = false;
  win.on('close', (e) => {
    if (closing || (process.env.MIBSQL_SHOT && !process.env.MIBSQL_TEST_CLOSE)) return;
    e.preventDefault();
    win.webContents.send('app:closeRequest');
  });
  ipcMain.removeAllListeners('app:closeConfirmed');
  ipcMain.on('app:closeConfirmed', () => { closing = true; win.close(); });
  if (process.env.VITE_DEV) win.loadURL('http://localhost:5174');
  else win.loadFile(path.join(__dirname, '..', 'dist', 'index.html'));
  if (process.env.MIBSQL_SHOT) screenshotMode(process.env.MIBSQL_SHOT, process.env.MIBSQL_SCRIPT);
  // tests: MIBSQL_LOG=1 copies the renderer's console (and uncaught errors) to stdout
  if (process.env.MIBSQL_LOG) win.webContents.on('console-message', (e) => console.log(`[renderer] ${e.message ?? ''}`));
  // `mib-sql script.sql`: open the file once the UI is ready.
  const arg = process.argv.slice(1).find((a) => /\.sql$/i.test(a) && fs.existsSync(a));
  if (arg) win.webContents.once('did-finish-load', () => setTimeout(() => win.webContents.send('file:openArg', readSql(path.resolve(arg))), 300));
}

/** Screenshots for the README: runs a renderer script, waits, captures, quits. */
function screenshotMode(out, script) {
  win.webContents.once('did-finish-load', async () => {
    if (script) {
      const res = await win.webContents.executeJavaScript(fs.readFileSync(script, 'utf8')).catch((err) => ({ scriptError: String(err) }));
      if (res !== undefined) fs.writeFileSync(out.replace(/\.png$/, '') + '.json', JSON.stringify(res, null, 2));
    }
    setTimeout(async () => {
      const img = await win.webContents.capturePage();
      fs.writeFileSync(out, img.toPNG());
      app.quit();
    }, Number(process.env.MIBSQL_WAIT || 3000));
  });
}

// Wraps handlers so errors reach the renderer as { error } instead of rejecting.
function handle(channel, fn) {
  ipcMain.handle(channel, async (_e, ...args) => {
    try {
      return { ok: await fn(...args) };
    } catch (err) {
      return { error: err.message || String(err), code: err.code };
    }
  });
}

const readSql = (file) => ({ path: file, content: fs.readFileSync(file, 'utf8') });

handle('conn:list', async () => ({ list: connections.list(), keyring: await connections.keyringAvailable() }));
handle('conn:save', (def, secrets) => connections.save(def, secrets));
// Microsoft Fabric / SQL Server profiles (engine 'mssql') go to tds.cjs, every other one to the MariaDB driver.
const isTds = (connId) => { try { return tds.isTds(connections.get(connId)); } catch { return false; } };

handle('conn:delete', async (id) => { await (isTds(id) ? tds : server).close(id); await connections.remove(id); });
handle('conn:test', (def, secrets) => (tds.isTds(def) ? tds : server).test(def, secrets));
handle('conn:open', (id, secrets) => (isTds(id) ? tds : server).open(id, secrets));
handle('conn:close', (id) => (isTds(id) ? tds : server).close(id));
handle('entra:account', (id) => entra.account(connections.get(id)));
handle('entra:signOut', async (id) => { await tds.close(id); return entra.signOut(connections.get(id)); });
entra.onPrompt((p) => win?.webContents.send('entra:prompt', p));
// device code page: only Microsoft sign-in addresses open in the browser
handle('entra:openUrl', (url) => (/^https:\/\/([a-z.]+\.)?(microsoft\.com|microsoftonline\.com)\//i.test(url) ? shell.openExternal(url) : null));

handle('meta:databases', (id) => (isTds(id) ? tds : explorer).databases(id));
handle('meta:objects', (id, db) => (isTds(id) ? tds : explorer).objects(id, db));
handle('meta:columns', (id, db, t) => (isTds(id) ? tds : explorer).columns(id, db, t));
handle('meta:indexes', (id, db, t) => (isTds(id) ? tds : explorer).indexes(id, db, t));
handle('meta:foreignKeys', (id, db, t) => (isTds(id) ? [] : explorer.foreignKeys(id, db, t)));
handle('meta:ddl', (id, db, kind, name) => (isTds(id) ? tds : explorer).ddl(id, db, kind, name));
handle('meta:schema', (id, db) => (isTds(id) ? tds : explorer).schema(id, db));
handle('meta:tableDefinition', (id, db, t) => explorer.tableDefinition(id, db, t));
handle('meta:serverOptions', (id, db) => explorer.serverOptions(id, db));
handle('meta:erModel', (id, db) => (isTds(id) ? tds : explorer).erModel(id, db));
handle('meta:schemaSnapshot', (id, db) => explorer.schemaSnapshot(id, db));
handle('meta:users', (id) => explorer.users(id));
handle('meta:grants', (id, user, host) => explorer.grants(id, user, host));
handle('compare:data', (src, tgt, table, key, columns) => datacompare.compareTable(src, tgt, table, key, columns, (p) => win.webContents.send('task:progress', { id: `compare:${table}`, ...p })));

// Generic save of generated content (diagram images, reports): text or base64 data.
handle('file:saveData', async (data, base64, suggested, filters) => {
  let file = process.env.MIBSQL_SAVE_AS ? `${process.env.MIBSQL_SAVE_AS}${path.extname(suggested)}` : null;
  if (!file) {
    const r = await dialog.showSaveDialog(win, { defaultPath: suggested, filters });
    if (r.canceled) return null;
    file = r.filePath;
  }
  fs.writeFileSync(file, base64 ? Buffer.from(data, 'base64') : data);
  return file;
});
handle('ddl:run', (connId, sqls) => server.runStatements(connId, sqls));

const sess = (sid) => (tds.hasSession(sid) ? tds : server);
handle('sess:open', (connId, db) => (isTds(connId) ? tds : server).openSession(connId, db));
handle('sess:close', (sid) => sess(sid).closeSession(sid));
handle('sess:use', (sid, db) => sess(sid).useDb(sid, db));
handle('sess:exec', (sid, text, opts) => sess(sid).exec(sid, text, opts));
handle('sess:cancel', (sid) => sess(sid).cancel(sid));
handle('sess:profile', (sid, text, cursor) => {
  if (tds.hasSession(sid)) throw new Error(t('Il profilo non è disponibile per Microsoft Fabric.'));
  return server.profile(sid, text, cursor);
});
handle('sql:split', (text) => server.split(text));
handle('data:apply', (connId, stmts) => server.apply(connId, stmts));
handle('data:select', (connId, sql, params) => server.selectRows(connId, sql, params));

async function exportTarget(format, suggested) {
  // tests: write to <MIBSQL_SAVE_AS>.<ext> without the native dialog
  if (process.env.MIBSQL_SAVE_AS) return `${process.env.MIBSQL_SAVE_AS}.${exporter.EXT[format]}`;
  const base = (suggested || 'risultato').replace(/[\\/:*?"<>|]+/g, '_');
  const r = await dialog.showSaveDialog(win, { defaultPath: `${base}.${exporter.EXT[format]}`, filters: exporter.FILTERS()[format] });
  if (r.canceled) return null;
  return path.extname(r.filePath) ? r.filePath : `${r.filePath}.${exporter.EXT[format]}`;
}

handle('export:rows', async (format, opts, columns, rows, suggested) => {
  const file = await exportTarget(format, suggested);
  if (!file) return null;
  return { file, rows: await exporter.writeRows(format, file, opts, columns, rows) };
});

// Whole query streamed to the file; progress every 5000 rows on 'export:progress'.
handle('export:query', async (connId, db, sql, format, opts, suggested) => {
  const file = await exportTarget(format, suggested);
  if (!file) return null;
  let w = null;
  try {
    const rows = await (isTds(connId) ? tds : server).streamQuery(connId, db, sql, (cols) => { w = exporter.writer(format, file, opts, cols); }, async (row, n) => {
      await w.row(row);
      if (n % 5000 === 0) win.webContents.send('export:progress', { file, rows: n });
    });
    await w.end();
    return { file, rows };
  } catch (err) {
    await w?.end().catch(() => {});
    fs.rmSync(file, { force: true });
    throw err;
  }
});
handle('shell:showItem', (file) => shell.showItemInFolder(file));

// Binary cells: a file's bytes as 0x… hex for the grid, and back
const MAX_BINARY = 16 * 1024 * 1024;
handle('file:readHex', async () => {
  const file = process.env.MIBSQL_OPEN || (await dialog.showOpenDialog(win, { properties: ['openFile'] })).filePaths?.[0];
  if (!file) return null;
  const size = fs.statSync(file).size;
  if (size > MAX_BINARY) throw new Error(t('File troppo grande ({0} MB): il limite è 16 MB.', Math.round(size / 1e6)));
  return '0x' + fs.readFileSync(file).toString('hex').toUpperCase();
});
handle('file:writeHex', async (hex, suggested) => {
  let file = process.env.MIBSQL_SAVE_AS || null;
  if (!file) {
    const r = await dialog.showSaveDialog(win, { defaultPath: `${suggested || 'dati'}.bin` });
    if (r.canceled) return null;
    file = r.filePath;
  }
  fs.writeFileSync(file, Buffer.from(String(hex).replace(/^0x/i, ''), 'hex'));
  return file;
});
handle('ai:settings', () => assistant.settings());
handle('ai:saveSettings', (s) => assistant.saveSettings(s));
handle('ai:chat', (id, req) => assistant.chat(id, req, (text) => win.webContents.send('ai:delta', { id, text })));
handle('ai:cancel', (id) => assistant.cancel(id));
handle('history:add', (list) => library.addHistory(list));
handle('history:list', (opts) => library.listHistory(opts));
handle('history:remove', (ids) => library.removeHistory(ids));
handle('history:clear', () => library.clearHistory());
handle('snippets:list', () => library.snippets());
handle('snippets:save', (list) => library.saveSnippets(list));
handle('object:apply', (connId, db, kind, orig, text) => objects.apply(connId, db, kind, orig, text));
handle('object:params', (connId, db, kind, name) => objects.routineParams(connId, db, kind, name));
handle('object:currentUser', (connId) => objects.currentUser(connId));
handle('maint:stats', (connId, db) => maint.tableStats(connId, db));
handle('maint:run', (id, connId, db, tables, op, opts) => maint.run(id, connId, db, tables, op, opts, progress(id)));
handle('maint:stop', (id) => maint.stop(id));
handle('procs:snapshot', (connId) => procs.snapshot(connId));
handle('procs:explainFor', (connId, id, flavor) => procs.explainFor(connId, id, flavor));
handle('procs:kill', (connId, ids, queryOnly) => procs.kill(connId, ids, queryOnly));
handle('procs:installMdl', (connId) => procs.installMdlPlugin(connId));
handle('procs:innodbStatus', (connId) => procs.innodbStatus(connId));
handle('perf:overview', (connId) => perf.overview(connId));
handle('perf:topQueries', (connId, source) => perf.topQueries(connId, source));
handle('perf:resetTop', (connId, source) => perf.resetTop(connId, source));
handle('perf:enableSlowLog', (connId, seconds) => perf.enableSlowLog(connId, seconds));
handle('perf:indexData', (connId, db) => perf.indexData(connId, db));
handle('perf:setVariable', (connId, name, value, persist) => perf.setVariable(connId, name, value, persist));
handle('perf:explain', (connId, db, sql) => perf.explain(connId, db, sql));
handle('datagen:tables', (connId, db) => datagen.tables(connId, db));
handle('datagen:values', (connId, db, table, column, limit) => datagen.values(connId, db, table, column, limit));
handle('datagen:tuples', (connId, db, table, columns) => datagen.tuples(connId, db, table, columns));
handle('datagen:rowsOf', (connId, db, table, columns) => datagen.rowsOf(connId, db, table, columns));
handle('datagen:clear', (connId, db, tables, truncate) => datagen.clear(connId, db, tables, truncate));
handle('datagen:counts', (connId, db, tables) => datagen.counts(connId, db, tables));
handle('search:objects', (connId, dbs, text, opts) => search.objects(connId, dbs, text, opts));
handle('search:data', (id, connId, dbs, text, opts) => search.data(id, connId, dbs, text, opts, progress(id)));
handle('search:stop', (id) => search.stop(id));
handle('logs:status', (connId) => logs.status(connId));
handle('logs:error', (connId) => logs.errorLog(connId));
handle('logs:query', (connId, which) => logs.queryLog(connId, which));
handle('logs:set', (connId, which, on, toTable) => logs.setLog(connId, which, on, toTable));
handle('logs:clear', (connId, which) => logs.clear(connId, which));
handle('copy:target', (connId, db) => copydb.targetInfo(connId, db));
handle('copy:run', (id, src, tgt, opts) => copydb.copy(src, tgt, opts, progress(id)));
handle('update:check', () => updates.check());
handle('update:install', () => updates.install(progress('update')));
handle('update:restart', () => updates.restart());
// only the project's GitHub pages open in the browser
handle('shell:openRelease', (url) => (/^https:\/\/github\.com\/mbulloni\/MiB-SQL\//.test(url) ? shell.openExternal(url) : null));
handle('app:setLang', (l) => i18n.setLang(l));
handle('monitor:snapshot', (connId) => server.monitorSnapshot(connId));
handle('monitor:kill', (connId, id, queryOnly) => server.kill(connId, id, queryOnly));

// ---- Backup, restore, import (progress on 'task:progress' with the task id) ----
const progress = (id) => (p) => win.webContents.send('task:progress', { id, ...p });

handle('backup:dump', async (id, connId, db, opts) => {
  const ext = opts.gzip ? 'sql.gz' : 'sql';
  const stamp = new Date().toISOString().slice(0, 16).replace(/[:T]/g, '-');
  let file = process.env.MIBSQL_SAVE_AS ? `${process.env.MIBSQL_SAVE_AS}.${ext}` : null;
  if (!file) {
    const r = await dialog.showSaveDialog(win, { defaultPath: `${db}-${stamp}.${ext}`, filters: [{ name: opts.gzip ? t('SQL compresso') : t('Script SQL'), extensions: opts.gzip ? ['gz'] : ['sql'] }] });
    if (r.canceled) return null;
    file = r.filePath.endsWith(`.${ext}`) ? r.filePath : `${r.filePath.replace(/\.sql$|\.gz$/, '')}.${ext}`;
  }
  return backup.dump(connId, db, file, opts, progress(id));
});

handle('file:pick', async (kind) => {
  const filters = {
    sql: [{ name: t('Script SQL'), extensions: ['sql', 'gz'] }, { name: t('Tutti i file'), extensions: ['*'] }],
    data: [{ name: t('Dati (CSV, Excel, JSON)'), extensions: ['csv', 'tsv', 'txt', 'xlsx', 'json', 'ndjson', 'jsonl'] }, { name: t('Tutti i file'), extensions: ['*'] }],
  }[kind];
  if (process.env.MIBSQL_OPEN) return process.env.MIBSQL_OPEN;
  const r = await dialog.showOpenDialog(win, { properties: ['openFile'], filters });
  return r.canceled ? null : r.filePaths[0];
});
handle('backup:restore', (id, connId, db, file, opts) => backup.restore(connId, db, file, opts, progress(id)));
handle('import:preview', (file, opts) => importer.preview(file, opts));
handle('import:run', (id, connId, file, opts) => importer.importFile(connId, file, opts, progress(id)));

const SQL_FILTERS = () => [{ name: t('Script SQL'), extensions: ['sql'] }, { name: t('Tutti i file'), extensions: ['*'] }];

handle('file:open', async () => {
  const r = await dialog.showOpenDialog(win, { properties: ['openFile', 'multiSelections'], filters: SQL_FILTERS() });
  return r.canceled ? [] : r.filePaths.map(readSql);
});
handle('file:save', async (content, file, suggested) => {
  let target = file;
  if (!target) {
    const r = await dialog.showSaveDialog(win, { defaultPath: suggested || 'query.sql', filters: SQL_FILTERS() });
    if (r.canceled) return null;
    target = r.filePath.endsWith('.sql') || path.extname(r.filePath) ? r.filePath : r.filePath + '.sql';
  }
  fs.writeFileSync(target, content);
  return target;
});
// tests: MIBSQL_CONFIRM=0,1,… answers the confirmations in order (button index) instead of showing them
const confirmAnswers = process.env.MIBSQL_CONFIRM ? process.env.MIBSQL_CONFIRM.split(',').map(Number) : null;
handle('app:confirm', async (message, detail, buttons) => {
  if (confirmAnswers?.length) {
    const r = confirmAnswers.shift();
    console.log(`[confirm] ${message} -> ${buttons[r]}`);
    return r;
  }
  const r = await dialog.showMessageBox(win, { type: 'question', message, detail, buttons, defaultId: 0, cancelId: buttons.length - 1 });
  return r.response;
});

ipcMain.on('win:title', (_e, title) => win.setTitle(title));

app.whenReady().then(createWindow);
app.on('before-quit', () => { server.shutdown(); tds.shutdown(); });
app.on('window-all-closed', () => app.quit());
