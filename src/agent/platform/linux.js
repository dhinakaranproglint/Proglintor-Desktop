'use strict';
// Linux (Ubuntu and other freedesktop desktops):
//  - active window: X11 via `xprop`; GNOME Wayland via the "Window Calls" GNOME Shell extension (D-Bus)
//  - installed apps: .desktop entries (system, snap, flatpak, user)
//  - idle/lock on GNOME via D-Bus (Mutter IdleMonitor / ScreenSaver), else Electron powerMonitor
const fs = require('fs');
const os = require('os');
const path = require('path');
const { run, exists, basename } = require('./util');

const HOME = os.homedir();
const isWayland = () => Boolean(process.env.WAYLAND_DISPLAY) || process.env.XDG_SESSION_TYPE === 'wayland';

// ---- parsers -----------------------------------------------------------------

function parseXpropActive(out) {
  const m = /window id # (0x[0-9a-f]+)/i.exec(out);
  return m && m[1] !== '0x0' ? m[1] : null;
}

function parseXpropWindow(out) {
  const pid = /_NET_WM_PID\(CARDINAL\) = (\d+)/.exec(out);
  const cls = /WM_CLASS\(STRING\) = "([^"]*)"(?:, "([^"]*)")?/.exec(out);
  const title = /_NET_WM_NAME\(UTF8_STRING\) = "((?:[^"\\]|\\.)*)"/.exec(out);
  return {
    pid: pid ? Number(pid[1]) : null,
    instance: cls ? cls[1] : '',
    cls: cls ? cls[2] || cls[1] : '',
    title: title ? title[1].replace(/\\(.)/g, '$1') : '',
  };
}

/** Unwraps gdbus output like ('[{"a":1}]',) into the inner string. */
function unwrapGVariantString(out) {
  const m = /^\(\s*'([\s\S]*)',?\s*\)\s*$/.exec(out.trim());
  return m ? m[1].replace(/\\(.)/g, '$1') : null;
}

function parseDesktopFile(text) {
  const entry = {};
  let inMain = false;
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    if (line.startsWith('[')) { inMain = line === '[Desktop Entry]'; continue; }
    if (!inMain) continue;
    const eq = line.indexOf('=');
    if (eq > 0) entry[line.slice(0, eq).trim()] = line.slice(eq + 1).trim();
  }
  return entry;
}

/** Extracts the program (and flatpak app id) from an Exec= line. */
function parseExec(exec) {
  const tokens = (String(exec || '').match(/"[^"]*"|\S+/g) || []).map((t) => t.replace(/^"|"$/g, ''));
  let i = 0;
  if (basename(tokens[0]) === 'env') { i = 1; while (tokens[i] && /^[A-Za-z_][A-Za-z0-9_]*=/.test(tokens[i])) i++; }
  const program = tokens[i] || '';
  let flatpakId = null;
  if (basename(program) === 'flatpak') {
    flatpakId = tokens.slice(i + 1).find((t) => /^[A-Za-z0-9_-]+(\.[A-Za-z0-9_-]+){2,}$/.test(t)) || null;
  }
  return { program, programName: basename(program).toLowerCase(), flatpakId };
}

function parseGnomeAppState(xml) {
  const map = {};
  const re = /<application\s+([^>]*)\/?>/g;
  let m;
  while ((m = re.exec(xml))) {
    const id = /id="([^"]+)"/.exec(m[1]);
    const seen = /last-seen="(\d+)"/.exec(m[1]);
    if (id && seen) map[id[1]] = Math.max(map[id[1]] || 0, Number(seen[1]) * 1000);
  }
  return map;
}

// ---- active window -------------------------------------------------------------

async function exeOf(pid) {
  if (!pid) return '';
  try { return fs.readlinkSync(`/proc/${pid}/exe`); } catch { return ''; }
}

function identity({ instance, cls, pid, title }, exe) {
  const id = (instance || cls || basename(exe)).toLowerCase();
  if (!id) return null;
  return { id, name: cls || instance || basename(exe), path: exe, pid, title };
}

async function activeX11() {
  const win = parseXpropActive(await run('xprop', ['-root', '_NET_ACTIVE_WINDOW'], { timeout: 3000 }));
  if (!win) return null;
  const info = parseXpropWindow(await run('xprop', ['-id', win, '_NET_WM_PID', 'WM_CLASS', '_NET_WM_NAME'], { timeout: 3000 }));
  return identity(info, await exeOf(info.pid));
}

async function activeGnomeWayland() {
  const out = await run('gdbus', ['call', '--session', '--dest', 'org.gnome.Shell', '--object-path', '/org/gnome/Shell/Extensions/Windows',
    '--method', 'org.gnome.Shell.Extensions.Windows.List'], { timeout: 3000 });
  const json = unwrapGVariantString(out);
  const wins = json ? JSON.parse(json) : [];
  const w = wins.find((x) => x.focus);
  if (!w) return null;
  return identity({ instance: w.wm_class_instance || w.wm_class, cls: w.wm_class, pid: w.pid, title: w.title || '' }, await exeOf(w.pid));
}

function createWatcher() {
  let lastError = null;
  const wayland = isWayland();
  return {
    async getActive() {
      try {
        const r = wayland ? await activeGnomeWayland() : await activeX11();
        lastError = null;
        return r;
      } catch (err) {
        if (wayland) {
          lastError = 'Wayland session: install the GNOME Shell extension "Window Calls" (extensions.gnome.org/extension/4724) or log in with "Ubuntu on Xorg".';
        } else {
          lastError = err.code === 'ENOENT' ? 'xprop not found: sudo apt install x11-utils' : `xprop failed: ${err.message}`;
        }
        return null;
      }
    },
    status() {
      if (lastError) return { ok: false, message: lastError };
      return { ok: true, message: wayland ? 'Using GNOME Wayland (Window Calls extension)' : 'Using X11 (xprop)' };
    },
    stop() {},
  };
}

// ---- idle / lock (GNOME D-Bus, falls back to Electron) ------------------------------

let gnomeIdleOk = true;
async function getIdleSeconds() {
  if (!gnomeIdleOk) return null;
  try {
    const out = await run('gdbus', ['call', '--session', '--dest', 'org.gnome.Mutter.IdleMonitor', '--object-path', '/org/gnome/Mutter/IdleMonitor/Core',
      '--method', 'org.gnome.Mutter.IdleMonitor.GetIdletime'], { timeout: 3000 });
    const m = /uint64 (\d+)/.exec(out);
    return m ? Number(m[1]) / 1000 : null;
  } catch {
    gnomeIdleOk = false; // not GNOME: use Electron's powerMonitor
    return null;
  }
}

let gnomeLockOk = true;
async function isLocked() {
  if (!gnomeLockOk) return null;
  try {
    const out = await run('gdbus', ['call', '--session', '--dest', 'org.gnome.ScreenSaver', '--object-path', '/org/gnome/ScreenSaver',
      '--method', 'org.gnome.ScreenSaver.GetActive'], { timeout: 3000 });
    return /true/.test(out);
  } catch {
    gnomeLockOk = false;
    return null;
  }
}

// ---- installed apps --------------------------------------------------------------

const DATA_DIRS = [
  path.join(HOME, '.local/share'),
  ...(process.env.XDG_DATA_DIRS || '/usr/local/share:/usr/share').split(':'),
  '/var/lib/snapd/desktop',
  '/var/lib/flatpak/exports/share',
  path.join(HOME, '.local/share/flatpak/exports/share'),
].filter((d, i, a) => d && a.indexOf(d) === i);

function findIcon(icon) {
  if (!icon) return '';
  if (path.isAbsolute(icon)) return exists(icon) ? icon : '';
  const sizes = ['256x256', '128x128', '96x96', '64x64', '48x48', 'scalable', '32x32'];
  const themes = ['hicolor', 'Yaru', 'Adwaita', 'breeze'];
  for (const base of [...DATA_DIRS.map((d) => path.join(d, 'icons')), path.join(HOME, '.icons')]) {
    for (const theme of themes) {
      for (const size of sizes) {
        for (const ext of ['png', 'svg']) {
          const p = path.join(base, theme, size, 'apps', `${icon}.${ext}`);
          if (exists(p)) return p;
        }
      }
    }
  }
  for (const ext of ['png', 'svg']) {
    const p = `/usr/share/pixmaps/${icon}.${ext}`;
    if (exists(p)) return p;
  }
  return '';
}

async function listInstalledApps() {
  let gnomeState = {};
  try { gnomeState = parseGnomeAppState(fs.readFileSync(path.join(HOME, '.local/share/gnome-shell/application_state'), 'utf8')); } catch { /* not GNOME */ }

  const byId = new Map(); // earlier dirs (user) override later ones
  for (const dir of DATA_DIRS) {
    const appsDir = path.join(dir, 'applications');
    let files;
    try { files = fs.readdirSync(appsDir); } catch { continue; }
    for (const f of files) {
      if (!f.endsWith('.desktop') || byId.has(f)) continue;
      const file = path.join(appsDir, f);
      let e;
      try { e = parseDesktopFile(fs.readFileSync(file, 'utf8')); } catch { continue; }
      byId.set(f, { file, e });
    }
  }

  const apps = [];
  for (const [fileId, { file, e }] of byId) {
    if (e.Type !== 'Application' || e.NoDisplay === 'true' || e.Hidden === 'true' || !e.Name) continue;
    const desktopId = fileId.replace(/\.desktop$/, '');
    const exec = parseExec(e.Exec);
    const categories = (e.Categories || '').split(';').filter(Boolean);
    const keys = new Set([
      desktopId.toLowerCase(),
      desktopId.split('.').pop().toLowerCase(),
      (e.StartupWMClass || '').toLowerCase(),
      exec.programName,
      (exec.flatpakId || '').toLowerCase(),
    ]);
    keys.delete('');
    const source = file.includes('/snapd/') ? 'Snap' : file.includes('flatpak') ? 'Flatpak' : file.startsWith(HOME) ? 'User' : 'System';
    apps.push({
      id: `desktop:${desktopId}`,
      name: e.Name,
      version: e['X-AppImage-Version'] || '',
      publisher: source,
      category: categories.find((c) => !['GTK', 'GNOME', 'Qt', 'KDE'].includes(c)) || '',
      path: file,
      iconPath: findIcon(e.Icon),
      installDir: '',
      isSystem: categories.includes('Settings') || categories.includes('System') || categories.includes('X-GNOME-Settings-Panel'),
      lastUsed: gnomeState[fileId] || null,
      useCount: null,
      installedAt: (() => { try { return fs.statSync(file).mtimeMs; } catch { return null; } })(),
      matchKeys: [...keys],
    });
  }
  return apps;
}

/** Running processes; the agent keeps only those that match an installed app. */
async function listRunningApps() {
  const out = await run('ps', ['-eo', 'pid=,comm='], { timeout: 10000 });
  return out.split('\n').map((l) => /^\s*(\d+)\s+(.+)$/.exec(l)).filter(Boolean)
    .map(([, pid, comm]) => ({ id: comm.trim().toLowerCase(), name: comm.trim(), pid: Number(pid), path: '', requireMatch: true }));
}

module.exports = {
  name: 'Linux',
  historySource: 'GNOME Shell application state (last seen)',
  createWatcher,
  listInstalledApps,
  listRunningApps,
  getIdleSeconds,
  isLocked,
  _test: { parseXpropActive, parseXpropWindow, unwrapGVariantString, parseDesktopFile, parseExec, parseGnomeAppState },
};
