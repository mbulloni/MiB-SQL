const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const desktop = require('../electron/desktop.cjs');

function withEnv(env, fn) {
  const saved = { APPIMAGE: process.env.APPIMAGE, XDG_DATA_HOME: process.env.XDG_DATA_HOME, MIBSQL_USERDATA: process.env.MIBSQL_USERDATA };
  Object.assign(process.env, env);
  delete process.env.MIBSQL_USERDATA;
  try { fn(); } finally {
    for (const [k, v] of Object.entries(saved)) if (v === undefined) delete process.env[k]; else process.env[k] = v;
  }
}

test('AppImage: menu entry and icons in the user data folder, updated when the AppImage moves', () => {
  const data = fs.mkdtempSync(path.join(os.tmpdir(), 'mibsql-desktop-'));
  const file = path.join(data, 'applications', 'mib-sql.desktop');
  withEnv({ APPIMAGE: '/opt/my apps/MiB-SQL.AppImage', XDG_DATA_HOME: data }, () => desktop.integrate());
  const text = fs.readFileSync(file, 'utf8');
  assert.match(text, /^Exec="\/opt\/my apps\/MiB-SQL\.AppImage" %f$/m);
  assert.match(text, /^Icon=mib-sql$/m);
  assert.match(text, /^StartupWMClass=mib-sql$/m);
  for (const n of [48, 64, 128, 256, 512]) assert.ok(fs.existsSync(path.join(data, 'icons', 'hicolor', `${n}x${n}`, 'apps', 'mib-sql.png')));
  withEnv({ APPIMAGE: '/home/u/MiB-SQL.AppImage', XDG_DATA_HOME: data }, () => desktop.integrate());
  assert.match(fs.readFileSync(file, 'utf8'), /^Exec="\/home\/u\/MiB-SQL\.AppImage" %f$/m);
});

test('an entry the user wrote is left alone', () => {
  const data = fs.mkdtempSync(path.join(os.tmpdir(), 'mibsql-desktop-'));
  const file = path.join(data, 'applications', 'mib-sql.desktop');
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, '[Desktop Entry]\nName=Mine\n');
  withEnv({ APPIMAGE: '/x/MiB-SQL.AppImage', XDG_DATA_HOME: data }, () => desktop.integrate());
  assert.strictEqual(fs.readFileSync(file, 'utf8'), '[Desktop Entry]\nName=Mine\n');
});

test('not an AppImage (.deb, development): nothing is written', () => {
  const data = fs.mkdtempSync(path.join(os.tmpdir(), 'mibsql-desktop-'));
  withEnv({ XDG_DATA_HOME: data }, () => { delete process.env.APPIMAGE; desktop.integrate(); });
  assert.deepStrictEqual(fs.readdirSync(data), []);
});
