const { contextBridge, ipcRenderer } = require('electron');

const call = async (channel, ...args) => {
  const r = await ipcRenderer.invoke(channel, ...args);
  if (r.error) {
    const err = new Error(r.error);
    err.code = r.code;
    throw err;
  }
  return r.ok;
};

contextBridge.exposeInMainWorld('api', {
  conn: {
    list: () => call('conn:list'),
    save: (def, secrets) => call('conn:save', def, secrets),
    remove: (id) => call('conn:delete', id),
    test: (def, secrets) => call('conn:test', def, secrets),
    open: (id, secrets) => call('conn:open', id, secrets),
    close: (id) => call('conn:close', id),
  },
  meta: {
    databases: (id) => call('meta:databases', id),
    objects: (id, db) => call('meta:objects', id, db),
    columns: (id, db, t) => call('meta:columns', id, db, t),
    indexes: (id, db, t) => call('meta:indexes', id, db, t),
    foreignKeys: (id, db, t) => call('meta:foreignKeys', id, db, t),
    ddl: (id, db, kind, name) => call('meta:ddl', id, db, kind, name),
    schema: (id, db) => call('meta:schema', id, db),
    tableDefinition: (id, db, t) => call('meta:tableDefinition', id, db, t),
    serverOptions: (id, db) => call('meta:serverOptions', id, db),
    erModel: (id, db) => call('meta:erModel', id, db),
    schemaSnapshot: (id, db) => call('meta:schemaSnapshot', id, db),
  },
  sess: {
    open: (connId, db) => call('sess:open', connId, db),
    close: (sid) => call('sess:close', sid),
    use: (sid, db) => call('sess:use', sid, db),
    exec: (sid, text, opts) => call('sess:exec', sid, text, opts),
    cancel: (sid) => call('sess:cancel', sid),
  },
  split: (text) => call('sql:split', text),
  data: {
    apply: (connId, stmts) => call('data:apply', connId, stmts),
    select: (connId, sql, params) => call('data:select', connId, sql, params),
  },
  exp: {
    rows: (format, opts, columns, rows, suggested) => call('export:rows', format, opts, columns, rows, suggested),
    query: (connId, db, sql, format, opts, suggested) => call('export:query', connId, db, sql, format, opts, suggested),
    onProgress: (cb) => {
      const fn = (_e, p) => cb(p);
      ipcRenderer.on('export:progress', fn);
      return () => ipcRenderer.removeListener('export:progress', fn);
    },
  },
  showItem: (file) => call('shell:showItem', file),
  pickFile: (kind) => call('file:pick', kind),
  tasks: {
    dump: (id, connId, db, opts) => call('backup:dump', id, connId, db, opts),
    restore: (id, connId, db, file, opts) => call('backup:restore', id, connId, db, file, opts),
    importPreview: (file, opts) => call('import:preview', file, opts),
    importRun: (id, connId, file, opts) => call('import:run', id, connId, file, opts),
    onProgress: (cb) => {
      const fn = (_e, p) => cb(p);
      ipcRenderer.on('task:progress', fn);
      return () => ipcRenderer.removeListener('task:progress', fn);
    },
  },
  ddl: { run: (connId, sqls) => call('ddl:run', connId, sqls) },
  compareData: (src, tgt, table, key, columns) => call('compare:data', src, tgt, table, key, columns),
  file: {
    open: () => call('file:open'),
    save: (content, path, suggested) => call('file:save', content, path, suggested),
    onOpenArg: (cb) => ipcRenderer.on('file:openArg', (_e, f) => cb(f)),
    saveData: (data, base64, suggested, filters) => call('file:saveData', data, base64, suggested, filters),
  },
  confirm: (message, detail, buttons) => call('app:confirm', message, detail, buttons),
  setTitle: (t) => ipcRenderer.send('win:title', t),
});
