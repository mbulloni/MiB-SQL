// Desktop integration for the AppImage: a menu entry and the icon in the user's icon theme.
// Started directly, an AppImage has neither, so GNOME shows a generic icon in the dock and the
// window list (the BrowserWindow icon is ignored under Wayland). The .deb installs both itself.
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFile } = require('child_process');

const MARK = 'X-MiBSQL-AppImage=true';
const SIZES = [48, 64, 128, 256, 512];

const iconFile = (size) => path.join(__dirname, size === 512 ? 'icon.png' : path.join('icons', `${size}x${size}.png`));

function entry(appImage) {
  // Exec: the path quoted as the desktop entry specification wants it
  const exec = `"${appImage.replace(/(["`$\\])/g, '\\$1')}"`;
  return [
    '[Desktop Entry]',
    'Type=Application',
    'Name=MiB-SQL',
    'GenericName=IDE SQL',
    'Comment=IDE per MariaDB e MySQL',
    `Exec=${exec} %f`,
    `TryExec=${appImage}`,
    'Icon=mib-sql',
    'Terminal=false',
    'Categories=Development;Database;',
    'MimeType=application/sql;text/x-sql;',
    'StartupWMClass=mib-sql',
    'Keywords=mariadb;mysql;sql;database;fabric;sqlserver;',
    MARK,
    '',
  ].join('\n');
}

/** Writes the entry and the icons when missing or out of date; never touches an entry the user wrote. */
function integrate() {
  const appImage = process.env.APPIMAGE;
  if (process.platform !== 'linux' || !appImage || process.env.MIBSQL_USERDATA) return;
  const data = process.env.XDG_DATA_HOME || path.join(os.homedir(), '.local', 'share');
  try {
    let changed = false;
    for (const size of SIZES) {
      const dest = path.join(data, 'icons', 'hicolor', `${size}x${size}`, 'apps', 'mib-sql.png');
      const src = fs.readFileSync(iconFile(size));
      if (fs.existsSync(dest) && fs.readFileSync(dest).equals(src)) continue;
      fs.mkdirSync(path.dirname(dest), { recursive: true });
      fs.writeFileSync(dest, src);
      changed = true;
    }
    // an icon cache in the user's hicolor folder hides icons added after it: rebuild it
    if (changed && fs.existsSync(path.join(data, 'icons', 'hicolor', 'icon-theme.cache'))) {
      execFile('gtk-update-icon-cache', ['-f', '-t', path.join(data, 'icons', 'hicolor')], () => {});
    }
    const file = path.join(data, 'applications', 'mib-sql.desktop');
    const current = fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : null;
    if (current !== null && !current.includes(MARK)) return; // written by the user or another installer
    const next = entry(appImage);
    if (current === next) return;
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, next);
    execFile('update-desktop-database', [path.dirname(file)], () => {});
  } catch (err) {
    console.error('desktop integration:', err.message);
  }
}

module.exports = { integrate, entry };
