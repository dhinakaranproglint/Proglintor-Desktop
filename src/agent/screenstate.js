'use strict';
// Is something else using the whole screen right now (a presentation, a video, a game, a call in full screen)?
// The companion must stay out of the way then: macOS hides its window over a full-screen app, so anything it said would be
// missed. Reminders are therefore held back and delivered once the person is free. No special permission is needed: only
// window sizes and owner names are read (never titles or contents).
const { execFile } = require('child_process');

const JXA = `ObjC.import('CoreGraphics');
const raw = ObjC.deepUnwrap(ObjC.castRefToObject($.CGWindowListCopyWindowInfo($.kCGWindowListOptionOnScreenOnly | $.kCGWindowListExcludeDesktopElements, 0)));
JSON.stringify(raw.map((w) => ({ o: w.kCGWindowOwnerName, l: w.kCGWindowLayer, b: w.kCGWindowBounds })).filter((w) => w.l === 0));`;

// Windows that can cover the screen without meaning "someone is presenting".
const IGNORE = new Set(['Window Server', 'Dock', 'SystemUIServer', 'Control Center', 'Notification Center', 'Finder', 'loginwindow', 'Electron', 'Proglintor', 'Proglintor Admin']);

/**
 * The app whose window exactly covers the display (menu bar included, which is what full screen means; a merely maximised window
 * leaves the menu bar visible). Returns the app name, or '' if none.
 * @param {{o:string,l:number,b:{X:number,Y:number,Width:number,Height:number}}[]} windows  @param {{x:number,y:number,width:number,height:number}} display
 */
function coveringApp(windows, display, tolerance = 2) {
  for (const w of Array.isArray(windows) ? windows : []) {
    const b = w && w.b;
    if (!b || w.l !== 0 || IGNORE.has(w.o)) continue;
    if (Math.abs(b.X - display.x) <= tolerance && Math.abs(b.Y - display.y) <= tolerance
      && Math.abs(b.Width - display.width) <= tolerance && Math.abs(b.Height - display.height) <= tolerance) return String(w.o || 'an app');
  }
  return '';
}

/** @param {() => {x:number,y:number,width:number,height:number}} getDisplay */
function makeFullscreenProbe(getDisplay, { platform = process.platform, run = defaultRun, now = Date.now, ttlMs = 5000 } = {}) {
  let cached = { at: -Infinity, app: '' };
  return async function fullscreenApp() {
    if (platform !== 'darwin') return ''; // other systems: the app-name list still applies
    if (now() - cached.at < ttlMs) return cached.app;
    let app = '';
    try { app = coveringApp(JSON.parse(await run()), getDisplay()); } catch { app = ''; } // if we can't tell, we don't block
    cached = { at: now(), app };
    return app;
  };
}

const defaultRun = () => new Promise((resolve, reject) => {
  execFile('osascript', ['-l', 'JavaScript', '-e', JXA], { timeout: 4000, maxBuffer: 4 * 1024 * 1024 }, (err, stdout) => (err ? reject(err) : resolve(stdout)));
});

module.exports = { coveringApp, makeFullscreenProbe, IGNORE };
