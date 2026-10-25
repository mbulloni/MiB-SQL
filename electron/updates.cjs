// Updates from the GitHub releases of the project: the latest release is compared with the running version;
// installing downloads the asset for how the app was installed and replaces it:
//  - AppImage (APPIMAGE is set by the runtime): new file next to the old one, then renamed over it;
//  - .deb (installed under /opt): `pkexec apt-get install` asks for the password, else the system installer;
//  - anything else (development): only the release page.
// MIBSQL_UPDATE_FEED points the check at another URL (tests).
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFile, spawn } = require('child_process');
const { app, net, shell } = require('electron');
const { t } = require('./i18n.cjs');

const FEED = process.env.MIBSQL_UPDATE_FEED || 'https://api.github.com/repos/mbulloni/MiB-SQL/releases/latest';

/** -1, 0, 1 comparing "1.10.0" with "1.9.2" numerically (a leading v is ignored). */
function compare(a, b) {
  const pa = String(a).replace(/^v/, '').split(/[.-]/).map((x) => Number(x) || 0);
  const pb = String(b).replace(/^v/, '').split(/[.-]/).map((x) => Number(x) || 0);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    if ((pa[i] ?? 0) !== (pb[i] ?? 0)) return (pa[i] ?? 0) > (pb[i] ?? 0) ? 1 : -1;
  }
  return 0;
}

function mode() {
  if (process.env.APPIMAGE) return 'appimage';
  if (app.isPackaged && process.execPath.startsWith('/opt/')) return 'deb';
  return 'manual';
}

async function latest() {
  const r = await net.fetch(FEED, { headers: { Accept: 'application/vnd.github+json', 'User-Agent': `MiB-SQL/${app.getVersion()}` } });
  if (!r.ok) throw new Error(t('Controllo aggiornamenti non riuscito (HTTP {0}).', r.status));
  const j = await r.json();
  const assets = (j.assets ?? []).map((a) => ({ name: a.name, url: a.browser_download_url, size: a.size }));
  return { version: String(j.tag_name ?? '').replace(/^v/, ''), notes: j.body ?? '', url: j.html_url ?? '', published: j.published_at ?? null, assets };
}

async function check() {
  const l = await latest();
  const m = mode();
  const asset = m === 'appimage' ? l.assets.find((a) => /\.AppImage$/i.test(a.name)) : m === 'deb' ? l.assets.find((a) => /_amd64\.deb$/i.test(a.name)) : null;
  return { current: app.getVersion(), latest: l.version, newer: compare(l.version, app.getVersion()) > 0, notes: l.notes, url: l.url, published: l.published, mode: m, asset: asset ?? null };
}

async function download(url, file, size, onProgress) {
  if (!/^https:\/\//.test(url) && !process.env.MIBSQL_UPDATE_FEED) throw new Error(t('Indirizzo di download non sicuro: {0}', url));
  const r = await net.fetch(url, { headers: { 'User-Agent': `MiB-SQL/${app.getVersion()}` } });
  if (!r.ok || !r.body) throw new Error(t('Download non riuscito (HTTP {0}).', r.status));
  const total = Number(r.headers.get('content-length')) || size || 0;
  const out = fs.createWriteStream(file, { mode: 0o755 });
  let bytes = 0;
  let last = 0;
  try {
    for await (const chunk of r.body) {
      bytes += chunk.length;
      if (!out.write(chunk)) await new Promise((res) => out.once('drain', res));
      if (bytes - last > 512 * 1024) { last = bytes; onProgress({ bytes, total }); }
    }
    await new Promise((res, rej) => out.end((e) => (e ? rej(e) : res())));
  } catch (err) {
    out.destroy();
    fs.rmSync(file, { force: true });
    throw err;
  }
  if (size && bytes !== size) { fs.rmSync(file, { force: true }); throw new Error(t('Download incompleto: {0} byte invece di {1}.', bytes, size)); }
  onProgress({ bytes, total: bytes });
}

/** Downloads and installs the latest release; resolves with what the renderer should do next. */
async function install(onProgress = () => {}) {
  const info = await check();
  if (!info.newer) return { done: false, reason: 'current' };
  if (info.mode === 'manual' || !info.asset) { await shell.openExternal(info.url); return { done: false, reason: 'manual' }; }
  if (info.mode === 'appimage') {
    const target = process.env.APPIMAGE;
    const tmp = `${target}.download`;
    try { fs.accessSync(path.dirname(target), fs.constants.W_OK); } catch { throw new Error(t('La cartella {0} non è scrivibile: scarica la nuova versione dalla pagina della release.', path.dirname(target))); }
    await download(info.asset.url, tmp, info.asset.size, onProgress);
    fs.chmodSync(tmp, 0o755);
    // the running AppImage keeps its open inode: renaming over the path is safe
    fs.renameSync(tmp, target);
    return { done: true, restart: true, version: info.latest };
  }
  const file = path.join(os.tmpdir(), info.asset.name);
  await download(info.asset.url, file, info.asset.size, onProgress);
  onProgress({ phase: 'install' });
  const ok = await new Promise((res) => execFile('pkexec', ['apt-get', 'install', '-y', file], (err) => res(!err)));
  if (!ok) {
    await shell.openPath(file);
    return { done: false, reason: 'installer', file };
  }
  fs.rmSync(file, { force: true });
  return { done: true, restart: true, version: info.latest };
}

function restart() {
  if (process.env.APPIMAGE) {
    // app.relaunch() does not survive the AppImage runtime unmounting: start the (new) file as a detached process
    const env = { ...process.env };
    for (const k of ['APPDIR', 'APPIMAGE', 'ARGV0', 'OWD']) delete env[k];
    const args = process.argv.slice(1).filter((a) => a !== '--no-sandbox').concat('--no-sandbox');
    spawn(process.env.APPIMAGE, args, { detached: true, stdio: 'ignore', env }).unref();
  } else app.relaunch();
  app.exit(0);
}

module.exports = { check, install, restart, compare };
