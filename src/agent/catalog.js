'use strict';
// Holds the installed-app list and links tracked apps (foreground processes) to installed apps.
const { basename } = require('./platform/util');

const norm = (p) => String(p || '').replace(/[\\/]+$/, '').toLowerCase();

/** Directories too generic to claim every exe inside them (e.g. "C:\Program Files"). */
function specificEnough(dir) {
  return dir.replace(/^[a-z]:/i, '').split(/[\\/]/).filter(Boolean).length >= 2;
}

class Catalog {
  constructor(platform) {
    this.platform = platform;
    this.apps = [];
    this.byId = new Map();
    this.keyIndex = new Map();
    this.dirs = [];
    this.scanning = null;
    this.lastScan = null;
    this.error = null;
  }

  refresh() {
    if (this.scanning) return this.scanning;
    this.scanning = this.platform.listInstalledApps()
      .then((apps) => {
        apps.sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: 'base' }));
        this._index(apps);
        this.lastScan = Date.now();
        this.error = null;
      })
      .catch((err) => { this.error = err.message; console.error('installed app scan failed:', err); })
      .finally(() => { this.scanning = null; });
    return this.scanning;
  }

  _index(apps) {
    this.apps = apps;
    this.byId = new Map(apps.map((a) => [a.id, a]));
    this.keyIndex = new Map();
    for (const a of apps) {
      for (const k of a.matchKeys || []) {
        const key = k.toLowerCase();
        if (!this.keyIndex.has(key)) this.keyIndex.set(key, a);
      }
    }
    this.dirs = apps
      .filter((a) => a.installDir && specificEnough(a.installDir))
      .map((a) => [norm(a.installDir), a])
      .sort((x, y) => y[0].length - x[0].length);
  }

  /** Finds the installed app for a tracked app ({ id, path }). */
  match({ id, path }) {
    const p = norm(path);
    const file = basename(p);
    for (const k of [String(id || '').toLowerCase(), file, file.replace(/\.(app|exe)$/, '')]) {
      if (k && this.keyIndex.has(k)) return this.keyIndex.get(k);
    }
    if (p) {
      for (const [dir, app] of this.dirs) {
        if (p === dir || p.startsWith(dir + '/') || p.startsWith(dir + '\\')) return app;
      }
    }
    return null;
  }

  /** Raw foreground app -> tracked identity with the friendliest name available. */
  resolve(raw) {
    const inst = this.match(raw);
    return { id: raw.id, name: inst?.name || raw.name, path: raw.path || '' };
  }
}

module.exports = { Catalog };
