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
    users: (id) => call('meta:users', id),
    grants: (id, user, host) => call('meta:grants', id, user, host),
  },
  sess: {
    open: (connId, db) => call('sess:open', connId, db),
    close: (sid) => call('sess:close', sid),
    use: (sid, db) => call('sess:use', sid, db),
    exec: (sid, text, opts) => call('sess:exec', sid, text, opts),
    cancel: (sid) => call('sess:cancel', sid),
    profile: (sid, text, cursor) => call('sess:profile', sid, text, cursor),
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
  ai: {
    settings: () => call('ai:settings'),
    saveSettings: (s) => call('ai:saveSettings', s),
    chat: (id, req) => call('ai:chat', id, req),
    cancel: (id) => call('ai:cancel', id),
    onDelta: (cb) => {
      const fn = (_e, p) => cb(p);
      ipcRenderer.on('ai:delta', fn);
      return () => ipcRenderer.removeListener('ai:delta', fn);
    },
  },
  history: {
    add: (list) => call('history:add', list),
    list: (opts) => call('history:list', opts),
    remove: (ids) => call('history:remove', ids),
    clear: () => call('history:clear'),
  },
  snippets: {
    list: () => call('snippets:list'),
    save: (list) => call('snippets:save', list),
  },
  objects: {
    apply: (connId, db, kind, orig, text) => call('object:apply', connId, db, kind, orig, text),
    params: (connId, db, kind, name) => call('object:params', connId, db, kind, name),
    currentUser: (connId) => call('object:currentUser', connId),
  },
  maint: {
    stats: (connId, db) => call('maint:stats', connId, db),
    run: (id, connId, db, tables, op, opts) => call('maint:run', id, connId, db, tables, op, opts),
    stop: (id) => call('maint:stop', id),
  },
  monitor: {
    snapshot: (connId) => call('monitor:snapshot', connId),
    kill: (connId, id, queryOnly) => call('monitor:kill', connId, id, queryOnly),
  },
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
    readHex: () => call('file:readHex'),
    writeHex: (hex, suggested) => call('file:writeHex', hex, suggested),
  },
  confirm: (message, detail, buttons) => call('app:confirm', message, detail, buttons),
  setTitle: (t) => ipcRenderer.send('win:title', t),
  onCloseRequest: (cb) => ipcRenderer.on('app:closeRequest', () => cb()),
  confirmClose: () => ipcRenderer.send('app:closeConfirmed'),
});
