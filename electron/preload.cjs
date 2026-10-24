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
  },
  sess: {
    open: (connId, db) => call('sess:open', connId, db),
    close: (sid) => call('sess:close', sid),
    use: (sid, db) => call('sess:use', sid, db),
    exec: (sid, text, opts) => call('sess:exec', sid, text, opts),
    cancel: (sid) => call('sess:cancel', sid),
  },
  split: (text) => call('sql:split', text),
  file: {
    open: () => call('file:open'),
    save: (content, path, suggested) => call('file:save', content, path, suggested),
    onOpenArg: (cb) => ipcRenderer.on('file:openArg', (_e, f) => cb(f)),
  },
  confirm: (message, detail, buttons) => call('app:confirm', message, detail, buttons),
  setTitle: (t) => ipcRenderer.send('win:title', t),
});
