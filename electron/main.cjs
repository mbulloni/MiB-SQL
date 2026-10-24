const { app, BrowserWindow, ipcMain, dialog, Menu, shell } = require('electron');
const path = require('path');
const fs = require('fs');
const connections = require('./connections.cjs');
const server = require('./server.cjs');
const explorer = require('./explorer.cjs');
const exporter = require('./export.cjs');
const datacompare = require('./datacompare.cjs');

app.commandLine.appendSwitch('no-sandbox');
// Separate profile for tests and screenshots, so they never touch the user's saved connections.
if (process.env.MIBSQL_USERDATA) app.setPath('userData', process.env.MIBSQL_USERDATA);

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
  if (process.env.VITE_DEV) win.loadURL('http://localhost:5174');
  else win.loadFile(path.join(__dirname, '..', 'dist', 'index.html'));
  if (process.env.MIBSQL_SHOT) screenshotMode(process.env.MIBSQL_SHOT, process.env.MIBSQL_SCRIPT);
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
handle('conn:delete', async (id) => { await server.close(id); await connections.remove(id); });
handle('conn:test', (def, secrets) => server.test(def, secrets));
handle('conn:open', (id, secrets) => server.open(id, secrets));
handle('conn:close', (id) => server.close(id));

handle('meta:databases', (id) => explorer.databases(id));
handle('meta:objects', (id, db) => explorer.objects(id, db));
handle('meta:columns', (id, db, t) => explorer.columns(id, db, t));
handle('meta:indexes', (id, db, t) => explorer.indexes(id, db, t));
handle('meta:foreignKeys', (id, db, t) => explorer.foreignKeys(id, db, t));
handle('meta:ddl', (id, db, kind, name) => explorer.ddl(id, db, kind, name));
handle('meta:schema', (id, db) => explorer.schema(id, db));
handle('meta:tableDefinition', (id, db, t) => explorer.tableDefinition(id, db, t));
handle('meta:serverOptions', (id, db) => explorer.serverOptions(id, db));
handle('meta:erModel', (id, db) => explorer.erModel(id, db));
handle('meta:schemaSnapshot', (id, db) => explorer.schemaSnapshot(id, db));
handle('compare:data', (src, tgt, table, key, columns) => datacompare.compareTable(src, tgt, table, key, columns));

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

handle('sess:open', (connId, db) => server.openSession(connId, db));
handle('sess:close', (sid) => server.closeSession(sid));
handle('sess:use', (sid, db) => server.useDb(sid, db));
handle('sess:exec', (sid, text, opts) => server.exec(sid, text, opts));
handle('sess:cancel', (sid) => server.cancel(sid));
handle('sql:split', (text) => server.split(text));
handle('data:apply', (connId, stmts) => server.apply(connId, stmts));
handle('data:select', (connId, sql, params) => server.selectRows(connId, sql, params));

async function exportTarget(format, suggested) {
  // tests: write to <MIBSQL_SAVE_AS>.<ext> without the native dialog
  if (process.env.MIBSQL_SAVE_AS) return `${process.env.MIBSQL_SAVE_AS}.${exporter.EXT[format]}`;
  const base = (suggested || 'risultato').replace(/[\\/:*?"<>|]+/g, '_');
  const r = await dialog.showSaveDialog(win, { defaultPath: `${base}.${exporter.EXT[format]}`, filters: exporter.FILTERS[format] });
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
    const rows = await server.streamQuery(connId, db, sql, (cols) => { w = exporter.writer(format, file, opts, cols); }, async (row, n) => {
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

const SQL_FILTERS = [{ name: 'Script SQL', extensions: ['sql'] }, { name: 'Tutti i file', extensions: ['*'] }];

handle('file:open', async () => {
  const r = await dialog.showOpenDialog(win, { properties: ['openFile', 'multiSelections'], filters: SQL_FILTERS });
  return r.canceled ? [] : r.filePaths.map(readSql);
});
handle('file:save', async (content, file, suggested) => {
  let target = file;
  if (!target) {
    const r = await dialog.showSaveDialog(win, { defaultPath: suggested || 'query.sql', filters: SQL_FILTERS });
    if (r.canceled) return null;
    target = r.filePath.endsWith('.sql') || path.extname(r.filePath) ? r.filePath : r.filePath + '.sql';
  }
  fs.writeFileSync(target, content);
  return target;
});
handle('app:confirm', async (message, detail, buttons) => {
  const r = await dialog.showMessageBox(win, { type: 'question', message, detail, buttons, defaultId: 0, cancelId: buttons.length - 1 });
  return r.response;
});

ipcMain.on('win:title', (_e, title) => win.setTitle(title));

app.whenReady().then(createWindow);
app.on('before-quit', () => { server.shutdown(); });
app.on('window-all-closed', () => app.quit());
