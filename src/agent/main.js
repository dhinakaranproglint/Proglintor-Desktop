'use strict';
const { app, BrowserWindow, Tray, Menu, ipcMain, powerMonitor, dialog, shell, nativeImage, nativeTheme, screen } = require('electron');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');

const platform = require('./platform');
const { UsageStore, dayKey } = require('./store');
const { Tracker } = require('./tracker');
const { Catalog } = require('./catalog');
const { Sync } = require('./sync');
const { isDevTool, isWeekend } = require('../shared/policy');
const brand = require('../shared/branding');

const ASSETS = path.join(__dirname, '..', '..', 'assets');
const RENDERER = path.join(__dirname, 'renderer');
const PRELOAD = path.join(__dirname, 'preload.js');
const IS_MAC = process.platform === 'darwin';
const IS_WIN = process.platform === 'win32';
const VERSION = require('../../package.json').version;

// Fixed app name and data folder (also when started as `electron src/agent/main.js`).
app.setName(brand.agentName);
app.setPath('userData', process.env.PULSE_USER_DATA || path.join(app.getPath('appData'), brand.agentName));
if (IS_WIN) app.setAppUserModelId(brand.agentAppId);

/** Tracking id used for this app itself. */
const SELF = { id: brand.selfId, name: brand.agentName, path: '' };
/** Data from the earlier "Machine Monitor" Electron edition, moved over on first run. */
const LEGACY_DIR = path.join(app.getPath('appData'), 'Machine Monitor');
/** The Swift edition's data (macOS), offered for import. */
const SWIFT_DATA = path.join(os.homedir(), 'Library', 'Application Support', 'MachineMonitor', 'usage.json');
const SWIFT_SELF_ID = 'com.local.MachineMonitor';

let win = null;
let popover = null;
let tray = null;
let store, tracker, catalog, settings, sync;
let warnWin = null;
let quitting = false;

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', showWindow);
  app.whenReady().then(init);
}

// ---- settings ------------------------------------------------------------------------

const settingsFile = () => path.join(app.getPath('userData'), 'settings.json');

function loadSettings() {
  try { return { idleThreshold: 300, paused: false, ...JSON.parse(fs.readFileSync(settingsFile(), 'utf8')) }; }
  catch { return { idleThreshold: 300, paused: false }; }
}

function saveSettings() {
  fs.writeFileSync(settingsFile(), JSON.stringify(settings, null, 2));
}

const linuxAutostartFile = () => path.join(os.homedir(), '.config', 'autostart', 'proglintor.desktop');

function getOpenAtLogin() {
  if (process.platform === 'linux') return fs.existsSync(linuxAutostartFile());
  return app.getLoginItemSettings().openAtLogin;
}

function setOpenAtLogin(enabled) {
  if (process.platform !== 'linux') {
    app.setLoginItemSettings({ openAtLogin: enabled, openAsHidden: true, args: ['--hidden'] });
    return;
  }
  const file = linuxAutostartFile();
  if (!enabled) { fs.rmSync(file, { force: true }); return; }
  const exec = process.env.APPIMAGE || process.execPath;
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `[Desktop Entry]\nType=Application\nName=${brand.agentName}\nExec="${exec}" --hidden\nX-GNOME-Autostart-enabled=true\n`);
}

// ---- identity ----------------------------------------------------------------------------

/** Ids that all mean "Machine Monitor": the dev binary, and the Swift edition. */
const SELF_ALIASES = ['com.github.Electron', SWIFT_SELF_ID, 'com.local.machinemonitor', 'machine-monitor', 'proglint-pulse', 'com.proglint.pulse.agent', brand.agentAppId];

function isSelf(raw) {
  if (raw.pid && raw.pid === process.pid) return true;
  if (SELF_ALIASES.includes(raw.id)) return true;
  if (IS_MAC) return false;
  return Boolean(raw.path) && path.resolve(raw.path).toLowerCase() === path.resolve(process.execPath).toLowerCase();
}

function resolve(raw) {
  return isSelf(raw) ? SELF : catalog.resolve(raw);
}

// ---- startup ---------------------------------------------------------------------------

/**
 * First run after a rename: copies data from earlier editions ("Proglint Pulse", then "Machine Monitor").
 * Only files that don't exist yet are copied, so nothing is ever overwritten.
 */
function migrateLegacy() {
  if (process.env.PULSE_USER_DATA) return;
  const dir = app.getPath('userData');
  const sources = [path.join(app.getPath('appData'), 'Proglint Pulse'), LEGACY_DIR];
  fs.mkdirSync(dir, { recursive: true });
  for (const file of ['usage.json', 'organization.json', 'settings.json']) {
    const target = path.join(dir, file);
    if (fs.existsSync(target)) continue;
    const src = sources.map((d) => path.join(d, file)).find((f) => fs.existsSync(f));
    if (src) fs.copyFileSync(src, target);
  }
  // Remove the old Linux autostart entry; the renamed one is written by setOpenAtLogin.
  fs.rmSync(path.join(os.homedir(), '.config', 'autostart', 'proglint-pulse.desktop'), { force: true });
}

function device() {
  return {
    hostname: os.hostname(),
    os: `${platform.name} ${os.release()}`,
    platform: process.platform,
    agentVersion: VERSION,
  };
}

async function runningApps() {
  if (!platform.listRunningApps) return [];
  const seen = new Map();
  for (const raw of await platform.listRunningApps()) {
    if (raw.requireMatch && !catalog.match(raw)) continue;
    const r = resolve(raw);
    if (!seen.has(r.id)) seen.set(r.id, { id: r.id, name: r.name });
  }
  return [...seen.values()].sort((a, b) => a.name.localeCompare(b.name));
}

async function init() {
  settings = loadSettings();
  migrateLegacy();
  store = new UsageStore(app.getPath('userData'));
  store.mergeApps(SELF_ALIASES, SELF); // tidy up entries from older versions
  catalog = new Catalog(platform);
  catalog.refresh();

  tracker = new Tracker({
    store,
    platform,
    resolve,
    idleThreshold: settings.idleThreshold,
    power: {
      idleSeconds: () => powerMonitor.getSystemIdleTime(),
      isLocked: () => powerMonitor.getSystemIdleState(1) === 'locked',
    },
  });
  tracker.onUpdate = (st) => { broadcast('agent:update'); updateTray(); checkWeekend(st.current); };
  tracker.start();
  if (settings.paused) tracker.pause('user');

  sync = new Sync({
    dir: app.getPath('userData'),
    store,
    liveStatus: () => ({ ...tracker.status(), today: store.rangeView('day').total }),
    runningApps,
    installedApps: async () => { if (catalog.scanning) await catalog.scanning; return catalog.apps; },
    device,
    onChange: () => broadcast('agent:update'),
  });
  sync.start();
  setInterval(() => checkWeekend(tracker.status().current), 60 * 1000);

  // Company-managed: always start with the computer (packaged builds only).
  if (app.isPackaged && !getOpenAtLogin()) setOpenAtLogin(true);

  powerMonitor.on('suspend', () => tracker.pause('sleep'));
  powerMonitor.on('resume', () => tracker.resume('sleep'));
  powerMonitor.on('lock-screen', () => tracker.pause('lock'));
  powerMonitor.on('unlock-screen', () => tracker.resume('lock'));
  powerMonitor.on('shutdown', () => tracker.stop());

  registerIpc();
  createTray();
  if (!process.argv.includes('--hidden')) showWindow();

  setInterval(() => catalog.refresh(), 6 * 3600 * 1000); // rescan installed apps
  setInterval(() => broadcast('agent:tick'), 10000); // let open views refresh running totals
}

app.on('before-quit', () => {
  quitting = true;
  tracker?.stop();
});

// Keep running in the tray / menu bar when the window is closed.
app.on('window-all-closed', () => {});
app.on('activate', showWindow);

function broadcast(channel) {
  for (const w of [win, popover]) if (w && !w.isDestroyed()) w.webContents.send(channel);
}

// ---- main window -----------------------------------------------------------------------

function showWindow() {
  if (win) {
    if (win.isMinimized()) win.restore();
    win.show();
    win.focus();
    return;
  }
  const chrome = IS_MAC
    ? { titleBarStyle: 'hiddenInset', trafficLightPosition: { x: 18, y: 20 }, vibrancy: 'sidebar', visualEffectState: 'followWindow', backgroundColor: '#00000000' }
    : { backgroundColor: nativeTheme.shouldUseDarkColors ? '#111318' : '#f6f7fb', autoHideMenuBar: true, ...(IS_WIN ? { backgroundMaterial: 'mica' } : {}) };
  win = new BrowserWindow({
    width: 1280,
    height: 840,
    minWidth: 1000,
    minHeight: 660,
    title: brand.agentName,
    icon: path.join(ASSETS, 'icon.png'),
    show: false,
    ...chrome,
    webPreferences: { preload: PRELOAD, contextIsolation: true, nodeIntegration: false, sandbox: true },
  });
  win.loadFile(path.join(RENDERER, 'index.html'), { query: { platform: process.platform } });
  win.once('ready-to-show', () => win.show());
  win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  win.on('close', (e) => {
    if (!quitting) { e.preventDefault(); win.hide(); }
  });
  win.on('closed', () => { win = null; });
}

// ---- tray & popover ---------------------------------------------------------------------

function fmt(sec) {
  const t = Math.round(sec);
  const h = Math.floor(t / 3600), m = Math.floor((t % 3600) / 60);
  return h ? `${h}h ${m}m` : `${m}m`;
}

function createTray() {
  const icon = nativeImage.createFromPath(path.join(ASSETS, IS_MAC ? 'trayTemplate.png' : 'tray.png'));
  if (IS_MAC) icon.setTemplateImage(true);
  tray = new Tray(icon);
  tray.setToolTip(brand.agentName);
  if (IS_MAC || IS_WIN) {
    // Click opens the popover (like the Swift menu bar window); right-click shows the menu.
    tray.on('click', togglePopover);
    tray.on('right-click', () => tray.popUpContextMenu(trayMenu()));
  } else {
    tray.on('click', showWindow); // Linux: click events are not reliable everywhere; menu is always attached
  }
  updateTray();
  setInterval(updateTray, 30000);
}

function trayMenu() {
  const view = store.rangeView('day');
  const st = tracker.status();
  return Menu.buildFromTemplate([
    { label: `Today: ${fmt(view.total)}`, enabled: false },
    { label: st.current ? `Now: ${st.current.name}` : stateLabel(st), enabled: false },
    ...(view.summaries.length ? [{ type: 'separator' }, ...view.summaries.slice(0, 5).map((s) => ({ label: `${s.name} — ${fmt(s.seconds)}`, enabled: false }))] : []),
    { type: 'separator' },
    { label: 'Open Dashboard', click: showWindow },
    { label: tracker.paused ? 'Resume Tracking' : 'Pause Tracking', click: () => togglePause() },
    { type: 'separator' },
    { label: `Quit ${brand.agentName}`, click: () => app.quit() },
  ]);
}

function stateLabel(st) {
  return { tracking: 'Tracking', idle: 'Idle', locked: 'Screen locked', paused: tracker.paused ? 'Paused' : 'Paused (sleep)', unavailable: 'Detection unavailable', starting: 'Starting…' }[st.state] || st.state;
}

function updateTray() {
  if (!tray || !store) return;
  const total = store.rangeView('day').total;
  tray.setToolTip(`${brand.agentName} — today ${fmt(total)}`);
  if (IS_MAC) tray.setTitle(total >= 60 ? ` ${fmt(total)}` : '', { fontType: 'monospacedDigit' });
  if (!IS_MAC && !IS_WIN) tray.setContextMenu(trayMenu());
}

function createPopover() {
  popover = new BrowserWindow({
    width: 360,
    height: 520,
    show: false,
    frame: false,
    resizable: false,
    movable: false,
    minimizable: false,
    maximizable: false,
    fullscreenable: false,
    skipTaskbar: true,
    alwaysOnTop: true,
    ...(IS_MAC ? { vibrancy: 'popover', visualEffectState: 'active', backgroundColor: '#00000000', roundedCorners: true }
      : { backgroundColor: nativeTheme.shouldUseDarkColors ? '#16181d' : '#ffffff' }),
    webPreferences: { preload: PRELOAD, contextIsolation: true, nodeIntegration: false, sandbox: true },
  });
  popover.loadFile(path.join(RENDERER, 'popover.html'), { query: { platform: process.platform } });
  popover.on('blur', () => popover?.hide());
  popover.on('closed', () => { popover = null; });
}

function togglePopover() {
  if (!popover) createPopover();
  if (popover.isVisible()) { popover.hide(); return; }
  const b = tray.getBounds();
  const { width, height } = popover.getBounds();
  const area = screen.getDisplayNearestPoint({ x: b.x, y: b.y }).workArea;
  let x = Math.round(b.x + b.width / 2 - width / 2);
  x = Math.max(area.x + 8, Math.min(x, area.x + area.width - width - 8));
  const trayAtTop = b.y < area.y + area.height / 2;
  const y = trayAtTop ? Math.round(b.y + b.height + 6) : Math.round(b.y - height - 6);
  popover.setPosition(x, Math.max(area.y, y), false);
  popover.webContents.send('agent:update');
  popover.show();
  popover.focus();
}

function togglePause(force) {
  const pause = force ?? !tracker.paused;
  if (pause) tracker.pause('user'); else tracker.resume('user');
  settings.paused = pause;
  saveSettings();
  updateTray();
}

// ---- icons ---------------------------------------------------------------------------

const iconCache = new Map();

async function iconFor(id, appPath) {
  const key = `${id}|${appPath}`;
  if (iconCache.has(key)) return iconCache.get(key);
  let result = null;
  try {
    if (id === SELF.id) {
      result = nativeImage.createFromPath(path.join(ASSETS, 'icon.png')).resize({ width: 64 }).toDataURL();
    } else if (process.platform === 'linux') {
      const inst = catalog.byId.get(id) || catalog.match({ id, path: appPath });
      const file = inst?.iconPath;
      if (file && /\.(png|svg)$/i.test(file)) {
        const mime = file.toLowerCase().endsWith('.svg') ? 'image/svg+xml' : 'image/png';
        result = `data:${mime};base64,${fs.readFileSync(file).toString('base64')}`;
      }
    } else {
      const inst = catalog.byId.get(id) || catalog.match({ id, path: appPath });
      const src = inst?.iconPath || appPath;
      if (src && fs.existsSync(src)) {
        // getFileIcon returns a generic icon for .app bundles; Quick Look gives the real one.
        const img = IS_MAC && src.endsWith('.app')
          ? await nativeImage.createThumbnailFromPath(fs.realpathSync(src), { width: 64, height: 64 })
          : await app.getFileIcon(src, { size: 'normal' });
        if (!img.isEmpty()) result = img.toDataURL();
      }
    }
  } catch { /* no icon */ }
  // Don't cache misses until the installed-app scan has finished (paths may not be known yet).
  if (result || catalog.lastScan) iconCache.set(key, result);
  return result;
}

// ---- Swift edition import (macOS) ------------------------------------------------------------

function readSwiftData() {
  if (!IS_MAC || !fs.existsSync(SWIFT_DATA)) return null;
  try {
    const db = JSON.parse(fs.readFileSync(SWIFT_DATA, 'utf8'));
    const entries = [];
    let seconds = 0;
    for (const apps of Object.values(db.days || {})) {
      for (const [bid, u] of Object.entries(apps)) {
        const sessions = (u.sessions || []).map((s) => [Date.parse(s.start), Date.parse(s.end)]).filter(([a, b]) => b > a);
        if (!sessions.length) continue;
        seconds += u.seconds || 0;
        const self = SELF_ALIASES.includes(bid);
        entries.push({ id: self ? SELF.id : bid, name: self ? SELF.name : u.name, activations: u.activations || 0, sessions });
      }
    }
    return { entries, seconds, days: Object.keys(db.days || {}).length, since: Date.parse(db.trackingStarted) || null };
  } catch (err) {
    console.error('could not read Swift data:', err);
    return null;
  }
}

// ---- weekend work check -------------------------------------------------------------

const REMIND_MS = 2 * 3600 * 1000;

/** Shows the weekend check when a dev tool is in use on a weekend (once a day; again 2h after "Later"). */
function checkWeekend(current) {
  if (!current || !sync?.enrolled || warnWin) return;
  const policy = sync.policy;
  const now = Date.now();
  if (!policy.weekendCheck || !isWeekend(now, policy.weekendDays) || !isDevTool(current, policy.devTools)) return;
  const key = dayKey(now);
  const st = sync.promptState(key);
  if (st.answered || (st.lastPrompt && now - st.lastPrompt < REMIND_MS)) return;
  sync.markPrompt(key, { lastPrompt: now });
  showWarning(current);
}

function showWarning(appInfo) {
  warnWin = new BrowserWindow({
    width: 580,
    height: 780,
    show: false,
    resizable: false,
    minimizable: false,
    maximizable: false,
    fullscreenable: false,
    alwaysOnTop: true,
    title: `${brand.agentName} — Weekend work check`,
    icon: path.join(ASSETS, 'icon.png'),
    // Solid background (no vibrancy) so the warning always has full contrast.
    backgroundColor: nativeTheme.shouldUseDarkColors ? '#0e1015' : '#f5f6fa',
    ...(IS_MAC ? { titleBarStyle: 'hiddenInset' } : { autoHideMenuBar: true }),
    webPreferences: { preload: PRELOAD, contextIsolation: true, nodeIntegration: false, sandbox: true },
  });
  warnWin.pending = { app: appInfo, day: dayKey(Date.now()), shownAt: Date.now(), done: false };
  warnWin.setAlwaysOnTop(true, 'floating');
  warnWin.loadFile(path.join(RENDERER, 'warning.html'));
  warnWin.once('ready-to-show', () => { warnWin.center(); warnWin.show(); warnWin.focus(); });
  warnWin.on('closed', () => {
    // Closing without answering counts as "remind me later", and the admin is told.
    const w = warnWin;
    warnWin = null;
    if (w?.pending && !w.pending.done) recordWeekendAnswer(w.pending, { dismissed: true });
  });
}

function recordWeekendAnswer(pending, answer) {
  pending.done = true;
  sync.queueAlert({
    day: pending.day,
    appId: pending.app.id,
    appName: pending.app.name,
    reason: answer.dismissed ? 'Postponed (no answer yet)' : String(answer.reason || '').slice(0, 200),
    details: String(answer.details || '').slice(0, 2000),
    approver: String(answer.approver || '').slice(0, 200),
    duration: String(answer.duration || '').slice(0, 50),
    dismissed: Boolean(answer.dismissed),
  });
  if (!answer.dismissed) sync.markPrompt(pending.day, { answered: true });
}

// ---- IPC ------------------------------------------------------------------------------

/** Only paths the agent itself knows about may be opened/revealed. */
function knownPath(p) {
  if (!p) return false;
  return catalog.apps.some((a) => a.path === p || a.installDir === p) || store.trackedApps().some((s) => s.path === p);
}

function statusPayload() {
  return {
    ...tracker.status(),
    platform: platform.name,
    trackingStarted: store.db.trackingStarted,
    days: Object.keys(store.db.days).length,
    dataFile: store.file,
    today: store.rangeView('day').total,
    org: sync.status(),
    managedStartup: app.isPackaged,
  };
}

function registerIpc() {

  // Organization (Proglint server)
  ipcMain.handle('org:status', () => sync.status());
  ipcMain.handle('org:enroll', async (_e, server, code) => {
    try { return { ok: true, status: await sync.enroll(server, code) }; } catch (err) { return { ok: false, error: err.message }; }
  });
  ipcMain.handle('org:sync', async () => {
    try { await sync.syncNow(); return { ok: true }; } catch (err) { return { ok: false, error: err.message }; }
  });

  // Weekend check window
  ipcMain.handle('warning:info', (e) => {
    const w = BrowserWindow.fromWebContents(e.sender);
    if (!w?.pending) return null;
    return { app: w.pending.app, day: w.pending.day, shownAt: w.pending.shownAt, policy: sync.policy, employee: sync.status().employeeName, company: brand.company };
  });
  ipcMain.handle('warning:submit', (e, answer) => {
    const w = BrowserWindow.fromWebContents(e.sender);
    if (!w?.pending || w.pending.done) return false;
    if (!answer?.reason) return false;
    recordWeekendAnswer(w.pending, answer);
    return true;
  });
  ipcMain.handle('warning:later', (e) => {
    const w = BrowserWindow.fromWebContents(e.sender);
    if (w?.pending && !w.pending.done) recordWeekendAnswer(w.pending, { dismissed: true });
    w?.close();
    return true;
  });
  ipcMain.handle('warning:close', (e) => { BrowserWindow.fromWebContents(e.sender)?.close(); return true; });
  ipcMain.handle('usage:range', (_e, range, anchor) => {
    tracker.commit(Date.now());
    return store.rangeView(range, anchor || Date.now());
  });

  ipcMain.handle('usage:detail', (_e, id, day) => {
    tracker.commit(Date.now());
    const d = store.appDetail(id, day);
    const inst = id === SELF.id ? null : catalog.match({ id, path: d.path });
    return {
      ...d,
      installed: inst ? { name: inst.name, version: inst.version, publisher: inst.publisher, path: inst.path, lastUsed: inst.lastUsed, useCount: inst.useCount, installedAt: inst.installedAt } : null,
    };
  });

  ipcMain.handle('apps:installed', async (_e, refresh) => {
    if (refresh || (!catalog.lastScan && !catalog.error)) await catalog.refresh();
    else if (catalog.scanning) await catalog.scanning;
    tracker.commit(Date.now());
    // Attribute tracked time to installed apps (all time and last 7 days).
    const weekStart = store.interval('week')[0];
    const week = new Map(store.summaries(weekStart, Date.now() + 86400000).map((s) => [s.id, s.seconds]));
    const tracked = new Map();
    for (const s of store.trackedApps()) {
      const inst = catalog.match(s);
      if (!inst) continue;
      const t = tracked.get(inst.id) || { seconds: 0, week: 0, trackIds: [] };
      t.seconds += s.seconds;
      t.week += week.get(s.id) || 0;
      t.trackIds.push(s.id);
      tracked.set(inst.id, t);
    }
    return {
      platform: platform.name,
      historySource: platform.historySource,
      lastScan: catalog.lastScan,
      error: catalog.error,
      apps: catalog.apps.map(({ matchKeys, ...a }) => ({
        ...a,
        trackedSeconds: tracked.get(a.id)?.seconds || 0,
        weekSeconds: tracked.get(a.id)?.week || 0,
        trackId: tracked.get(a.id)?.trackIds[0] || matchKeys?.[0] || a.id,
      })),
    };
  });

  ipcMain.handle('icon:get', (_e, id, appPath) => iconFor(id, appPath));
  ipcMain.handle('status:get', () => statusPayload());
  ipcMain.handle('settings:get', () => ({ ...settings, openAtLogin: getOpenAtLogin() }));

  ipcMain.handle('settings:set', (_e, patch) => {
    if (typeof patch.idleThreshold === 'number' && patch.idleThreshold > 0) {
      settings.idleThreshold = patch.idleThreshold;
      tracker.idleThreshold = patch.idleThreshold;
    }
    if (typeof patch.paused === 'boolean') togglePause(patch.paused);
    if (typeof patch.openAtLogin === 'boolean') setOpenAtLogin(patch.openAtLogin);
    saveSettings();
    broadcast('agent:update');
    return { ...settings, openAtLogin: getOpenAtLogin() };
  });

  ipcMain.handle('swift:check', () => {
    const data = readSwiftData();
    if (!data) return { available: false };
    return { available: true, seconds: data.seconds, days: data.days, since: data.since, importedAt: store.db.imports?.swift || null };
  });

  ipcMain.handle('swift:import', () => {
    const data = readSwiftData();
    if (!data) return null;
    tracker.commit(Date.now());
    const result = store.importExternal(data.entries);
    store.mergeApps(SELF_ALIASES, SELF);
    store.db.imports = { ...(store.db.imports || {}), swift: Date.now() };
    store.dirty = true;
    store.save();
    broadcast('agent:update');
    return result;
  });

  ipcMain.handle('data:export', async () => {
    tracker.commit(Date.now());
    const today = new Date().toISOString().slice(0, 10);
    const { canceled, filePath } = await dialog.showSaveDialog(win, {
      defaultPath: `app-usage-${today}.csv`,
      filters: [{ name: 'CSV', extensions: ['csv'] }],
    });
    if (canceled || !filePath) return null;
    fs.writeFileSync(filePath, store.toCSV());
    return filePath;
  });

  ipcMain.handle('data:clear', async () => {
    const { response } = await dialog.showMessageBox(win, {
      type: 'warning',
      buttons: ['Cancel', 'Delete All'],
      defaultId: 0,
      cancelId: 0,
      message: 'Delete all recorded usage?',
      detail: 'This cannot be undone.',
    });
    if (response !== 1) return false;
    store.clearAll();
    tracker.sessionStart = null;
    broadcast('agent:update');
    return true;
  });

  ipcMain.handle('data:folder', () => shell.showItemInFolder(store.file));
  ipcMain.handle('window:show', () => { popover?.hide(); showWindow(); });
  ipcMain.handle('app:quit', () => app.quit());

  ipcMain.handle('app:open', (_e, p) => {
    if (!knownPath(p)) return false;
    if (process.platform === 'linux' && p.endsWith('.desktop')) {
      spawn('gtk-launch', [path.basename(p)], { detached: true, stdio: 'ignore' }).on('error', () => {}).unref();
    } else {
      shell.openPath(p);
    }
    return true;
  });

  ipcMain.handle('app:reveal', (_e, p) => {
    if (!knownPath(p)) return false;
    shell.showItemInFolder(p);
    return true;
  });
}

// For automated UI checks.
module.exports = { showWarning };
