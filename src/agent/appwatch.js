'use strict';
// Notices when apps are installed or removed, so the installed-apps list the server relies on ("is Sublime Text already
// installed?") follows reality within seconds instead of at the next 6-hourly scan.
const fs = require('fs');

/**
 * Watches folders (not recursively: apps sit directly in /Applications) and calls onChange once things settle.
 * @param {string[]} dirs        folders to watch; missing ones are skipped
 * @param {() => void} onChange  called after changes stop for `debounceMs`
 * @returns {{ close: () => void, watching: string[] }}
 */
function watchApps(dirs, onChange, { debounceMs = 3000, fsImpl = fs } = {}) {
  const watchers = [];
  const watching = [];
  let timer = null;
  const settle = () => {
    clearTimeout(timer);
    timer = setTimeout(() => { try { onChange(); } catch { /* the next change tries again */ } }, debounceMs);
  };
  for (const dir of dirs) {
    try {
      if (!fsImpl.existsSync(dir)) continue;
      const w = fsImpl.watch(dir, { persistent: false }, (event, name) => {
        const n = String(name || '');
        // An app bundle appearing/disappearing/changing, or a folder being added or removed. Not hidden temp files, and not the
        // folder's own "modified" notification (it follows every change and would only cause a second, pointless rescan).
        if (/\.app$/i.test(n) || (event === 'rename' && n && !n.startsWith('.'))) settle();
      });
      w.on?.('error', () => {});
      watchers.push(w);
      watching.push(dir);
    } catch { /* a folder we can't watch: the periodic scan still covers it */ }
  }
  return { watching, close() { clearTimeout(timer); watchers.forEach((w) => { try { w.close(); } catch { /* already closed */ } }); } };
}

module.exports = { watchApps };
