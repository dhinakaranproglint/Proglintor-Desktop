'use strict';
// macOS: frontmost app via `lsappinfo`, installed apps via the filesystem + Spotlight (`mdls`).
const { spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { run, basename } = require('./util');

function parseLsappinfo(out) {
  const get = (key) => {
    const m = out.match(new RegExp(`"${key}"="((?:[^"\\\\]|\\\\.)*)"`));
    return m ? m[1] : null;
  };
  const pid = out.match(/"pid"\s*=\s*(\d+)/);
  const bundleID = get('CFBundleIdentifier');
  const name = get('LSDisplayName') || get('name');
  const bundlePath = get('LSBundlePath');
  if (!bundleID && !name) return null;
  return {
    id: bundleID || basename(bundlePath) || name,
    name: name || bundleID,
    path: bundlePath || '',
    pid: pid ? Number(pid[1]) : null,
  };
}

/** Parses one `lsappinfo listen +becameFrontmost` notification line. */
function parseFrontmostEvent(line) {
  if (!line.includes('kLSNotifyBecameFrontmost')) return null;
  const bundle = /"CFBundleIdentifier"="([^"]*)"/.exec(line);
  const affected = /affectedASN="((?:[^"\\]|\\.)*)"\s+(ASN:[0-9a-fx-]+:?)/i.exec(line);
  const name = affected ? affected[1] : null;
  if (!bundle && !name) return null;
  return { id: bundle ? bundle[1] : name, name: name || bundle[1], asn: affected ? affected[2] : null };
}

async function queryFront() {
  const asn = (await run('lsappinfo', ['front'], { timeout: 5000 })).trim();
  if (!asn || asn.includes('NULL')) return null;
  const out = await run('lsappinfo', ['info', '-only', 'name', '-only', 'bundleID', '-only', 'bundlepath', '-only', 'pid', asn], { timeout: 5000 });
  return parseLsappinfo(out);
}

/**
 * Event-driven watcher: Launch Services pushes a notification on every app switch
 * (same source as NSWorkspace activation notifications), so switches are recorded
 * at the exact moment instead of on the next poll. A periodic resync guards against
 * a missed event or a restarted listener.
 */
function createWatcher() {
  let current = null;
  let lastError = null;
  let child = null;
  let stopped = false;
  const listeners = [];
  const paths = new Map(); // bundle id -> bundle path

  const set = (app) => {
    const changed = (app?.id || null) !== (current?.id || null);
    current = app;
    if (changed) listeners.forEach((fn) => fn(current));
  };

  const resync = async () => {
    try {
      const app = await queryFront();
      if (app?.path) paths.set(app.id, app.path);
      set(app);
      lastError = null;
    } catch (err) {
      lastError = err.message;
    }
  };

  const fillPath = async (app, asn) => {
    if (paths.has(app.id) || !asn) { app.path = paths.get(app.id) || ''; return; }
    try {
      const info = parseLsappinfo(await run('lsappinfo', ['info', '-only', 'bundlepath', '-only', 'bundleID', '-only', 'pid', asn], { timeout: 5000 }));
      if (info?.path) { paths.set(app.id, info.path); app.path = info.path; app.pid = info.pid; }
    } catch { /* path is optional */ }
  };

  const listen = () => {
    child = spawn('lsappinfo', ['listen', '+becameFrontmost', 'forever'], { stdio: ['ignore', 'pipe', 'ignore'] });
    let buf = '';
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (chunk) => {
      buf += chunk;
      let i;
      while ((i = buf.indexOf('\n')) >= 0) {
        const ev = parseFrontmostEvent(buf.slice(0, i));
        buf = buf.slice(i + 1);
        if (!ev) continue;
        const app = { id: ev.id, name: ev.name, path: paths.get(ev.id) || '', pid: null };
        set(app);
        fillPath(app, ev.asn);
      }
    });
    child.on('error', (err) => { lastError = err.message; });
    child.on('exit', () => { child = null; if (!stopped) setTimeout(listen, 2000); });
  };

  resync();
  listen();
  const timer = setInterval(resync, 15000);

  return {
    async getActive() { return current; },
    onChange(fn) { listeners.push(fn); },
    status() {
      return lastError ? { ok: false, message: `lsappinfo failed: ${lastError}` } : { ok: true, message: 'macOS Launch Services (live app-switch events)' };
    },
    stop() { stopped = true; clearInterval(timer); child?.kill(); },
  };
}

// mdls -raw prints values in alphabetical attribute order, NUL separated.
const MD_ATTRS = ['kMDItemCFBundleIdentifier', 'kMDItemDisplayName', 'kMDItemLastUsedDate', 'kMDItemUseCount', 'kMDItemVersion'];

function parseMdDate(v) {
  const m = /^(\d{4}-\d\d-\d\d) (\d\d:\d\d:\d\d) ([+-]\d\d)(\d\d)$/.exec(v || '');
  return m ? Date.parse(`${m[1]}T${m[2]}${m[3]}:${m[4]}`) : null;
}

function parseMdlsRaw(out, count) {
  const parts = out.split('\0');
  if (parts.length < count * MD_ATTRS.length) return null;
  const val = (v) => (v === '(null)' || v === '' ? null : v);
  const rows = [];
  for (let i = 0; i < count; i++) {
    const [bundleID, displayName, lastUsed, useCount, version] = parts.slice(i * 5, i * 5 + 5).map(val);
    rows.push({ bundleID, displayName, lastUsed: parseMdDate(lastUsed), useCount: useCount ? Number(useCount) : null, version });
  }
  return rows;
}

async function spotlight(paths) {
  const args = MD_ATTRS.flatMap((a) => ['-name', a]);
  try {
    const rows = parseMdlsRaw(await run('mdls', ['-raw', ...args, ...paths]), paths.length);
    if (rows) return rows;
  } catch { /* fall through to per-file */ }
  const rows = [];
  for (const p of paths) {
    try { rows.push(parseMdlsRaw(await run('mdls', ['-raw', ...args, p]), 1)?.[0] || {}); } catch { rows.push({}); }
  }
  return rows;
}

async function plistValue(appPath, key) {
  try {
    return (await run('plutil', ['-extract', key, 'raw', '-o', '-', path.join(appPath, 'Contents', 'Info.plist')], { timeout: 5000 })).trim() || null;
  } catch { return null; }
}

function findApps() {
  const roots = [
    ['/Applications', false],
    [path.join(os.homedir(), 'Applications'), false],
    ['/System/Applications', true],
    ['/System/Library/CoreServices/Applications', true],
  ];
  const found = new Map();
  const walk = (dir, depth, system) => {
    let entries;
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      if (e.name.startsWith('.')) continue;
      const full = path.join(dir, e.name);
      if (e.name.endsWith('.app')) {
        let real = full;
        try { real = fs.realpathSync(full); } catch { /* keep */ }
        if (!found.has(real)) found.set(real, { path: full, system });
      } else if ((e.isDirectory() || e.isSymbolicLink()) && depth < 3) {
        walk(full, depth + 1, system);
      }
    }
  };
  for (const [root, system] of roots) walk(root, 0, system);
  found.set('/System/Library/CoreServices/Finder.app', { path: '/System/Library/CoreServices/Finder.app', system: true });
  return [...found.values()];
}

async function listInstalledApps() {
  const apps = findApps();
  const out = [];
  for (let i = 0; i < apps.length; i += 40) {
    const chunk = apps.slice(i, i + 40);
    const meta = await spotlight(chunk.map((a) => a.path));
    for (let j = 0; j < chunk.length; j++) {
      const a = chunk[j];
      const m = meta[j] || {};
      const bundleID = m.bundleID || (await plistValue(a.path, 'CFBundleIdentifier'));
      const version = m.version || (await plistValue(a.path, 'CFBundleShortVersionString')) || '';
      let installed = null;
      try { installed = fs.statSync(a.path).birthtimeMs; } catch { /* ignore */ }
      if (installed && installed < Date.UTC(1990, 0, 1)) installed = null; // zip placeholder dates (1980)
      out.push({
        id: bundleID || a.path,
        name: basename(a.path).replace(/\.app$/, ''),
        version,
        publisher: '',
        category: '',
        path: a.path,
        iconPath: a.path,
        installDir: a.path,
        isSystem: a.system || a.path.startsWith('/System/'),
        lastUsed: m.lastUsed || null,
        useCount: m.useCount ?? null,
        installedAt: installed,
        matchKeys: [bundleID, basename(a.path).replace(/\.app$/, '')].filter(Boolean),
      });
    }
  }
  return out;
}

/** Regular (Dock) apps currently running, from `lsappinfo list`. */
function parseLsappinfoList(out) {
  const apps = [];
  for (const block of out.split(/\n(?=\s*\d+\) ")/)) {
    const head = /^\s*\d+\) "((?:[^"\\]|\\.)*)"/.exec(block);
    if (!head || !/type="Foreground"/.test(block)) continue;
    const bundle = /bundleID="([^"]*)"/.exec(block);
    const pid = /pid = (\d+)/.exec(block);
    apps.push({ id: bundle ? bundle[1] : head[1], name: head[1], pid: pid ? Number(pid[1]) : null });
  }
  return apps;
}

async function listRunningApps() {
  return parseLsappinfoList(await run('lsappinfo', ['list'], { timeout: 10000 }));
}

module.exports = {
  name: 'macOS',
  historySource: 'Spotlight (last opened, times opened)',
  createWatcher,
  listInstalledApps,
  listRunningApps,
  // Idle and lock state come from Electron's powerMonitor on macOS.
  _test: { parseLsappinfo, parseMdlsRaw, parseMdDate, parseFrontmostEvent, parseLsappinfoList },
};
