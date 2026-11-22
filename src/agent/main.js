'use strict';
const { app, BrowserWindow, Tray, Menu, ipcMain, powerMonitor, dialog, shell, nativeImage, nativeTheme, screen, Notification, globalShortcut } = require('electron');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn, execFile } = require('child_process');

const platform = require('./platform');
const { UsageStore, dayKey } = require('./store');
const { Tracker } = require('./tracker');
const { Catalog } = require('./catalog');
const { Sync } = require('./sync');
const { SoftwareAgent } = require('./software');
const { watchApps } = require('./appwatch');
const { OrbitAgent, UUID: ORBIT_UUID } = require('./orbit');
const OrbitLogic = require('../shared/renderer/orbit-logic');
const TimesheetLogic = require('../shared/renderer/timesheet-logic');
const CareLogic = require('../shared/renderer/care-logic');
const { CareCoach } = require('./care');
const { makeFullscreenProbe } = require('./screenstate');
const { makeLog } = require('./installlog');
const { run: runCommand } = require('./platform/util');
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
let store, tracker, catalog, settings, sync, software, orbit, care, appWatch;
let warnWin = null;
let greetWin = null;
let companionWin = null;
let quitting = false;
/** Installed builds can't be quit by the user; only shutdown, restart or logout (or development runs) end the agent. */
let systemQuit = false;
const MANAGED = app.isPackaged;

const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit(); // another copy is already running
} else {
  // A second launch (e.g. by the auto-start service) just stays in the background.
  app.on('second-instance', (_e, argv) => { if (!argv.includes('--hidden')) { reviveCompanion(); showWindow(); } });
  app.whenReady().then(init);
}

// ---- settings ------------------------------------------------------------------------

const settingsFile = () => path.join(app.getPath('userData'), 'settings.json');

function loadSettings() {
  let saved = {};
  try { saved = JSON.parse(fs.readFileSync(settingsFile(), 'utf8')); } catch { /* defaults */ }
  delete saved.paused; // tracking can't be paused
  return { idleThreshold: 300, ...saved, orbit: OrbitLogic.sanitizePersona(saved.orbit), care: CareLogic.sanitizeCare(saved.care) };
}

function saveSettings() {
  fs.writeFileSync(settingsFile(), JSON.stringify(settings, null, 2));
}

const linuxAutostartFile = () => path.join(os.homedir(), '.config', 'autostart', 'proglintor.desktop');

function getOpenAtLogin() {
  if (IS_MAC && MANAGED) return fs.existsSync(launchAgentFile());
  if (process.platform === 'linux') return fs.existsSync(linuxAutostartFile());
  return app.getLoginItemSettings().openAtLogin;
}

const launchAgentFile = () => path.join(os.homedir(), 'Library', 'LaunchAgents', `${brand.agentAppId}.plist`);

/**
 * macOS: a per-user LaunchAgent starts the agent at login and restarts it if it crashes or is
 * force-quit (KeepAlive on unsuccessful exit). A normal exit at shutdown/logout is not restarted.
 */
function installLaunchAgent() {
  const exe = process.execPath.replace(/&/g, '&amp;').replace(/</g, '&lt;');
  const plist = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>${brand.agentAppId}</string>
  <key>ProgramArguments</key><array><string>${exe}</string><string>--hidden</string></array>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><dict><key>SuccessfulExit</key><false/></dict>
  <key>ThrottleInterval</key><integer>10</integer>
  <key>ProcessType</key><string>Interactive</string>
</dict>
</plist>
`;
  const file = launchAgentFile();
  let current = '';
  try { current = fs.readFileSync(file, 'utf8'); } catch { /* not installed */ }
  if (current === plist) return;
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, plist);
  // Register it now too; the copy launchd starts exits right away because this one is already running.
  // (Skipped for isolated test runs that use their own data folder.)
  if (!process.env.PULSE_USER_DATA) spawn('launchctl', ['bootstrap', `gui/${process.getuid()}`, file], { stdio: 'ignore' }).on('error', () => {});
  // The LaunchAgent replaces the older login item.
  app.setLoginItemSettings({ openAtLogin: false });
}

/** Makes sure the agent starts whenever the computer is turned on and the user signs in. */
function ensureAutostart() {
  if (!MANAGED) return;
  if (IS_MAC) installLaunchAgent();
  else if (!getOpenAtLogin()) setOpenAtLogin(true);
}

function setOpenAtLogin(enabled) {
  if (IS_MAC && MANAGED) return; // handled by the LaunchAgent
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

/** Is the signed-in user a local administrator? (macOS: member of the "admin" group). Installing a .pkg needs one, or an administrator's password. */
let localAdmin = null;
async function detectLocalAdmin() {
  if (!IS_MAC) return;
  try { localAdmin = (await runCommand('id', ['-Gn'], { timeout: 5000 })).trim().split(/\s+/).includes('admin'); } catch { localAdmin = null; }
}

function device() {
  return {
    localAdmin,
    hostname: os.hostname(),
    os: `${platform.name} ${os.release()}`,
    platform: process.platform,
    arch: process.arch,
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
  detectLocalAdmin(); // fills in `localAdmin` for the next heartbeat
  setDockIcon();
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

  sync = new Sync({
    dir: app.getPath('userData'),
    store,
    liveStatus: () => ({ ...tracker.status(), today: store.rangeView('day').total }),
    runningApps,
    installedApps: async () => { if (catalog.scanning) await catalog.scanning; return catalog.apps; },
    device,
    iconFor,
    defaultServer: brand.serverUrl(),
    onChange: () => broadcast('agent:update'),
    onRemoved: onAssetRemoved,
  });
  sync.start();

  // Install assistant: runs approved installs for this laptop and reports back.
  software = new SoftwareAgent({
    dir: app.getPath('userData'),
    sync,
    runningApps,
    detect: detectInstalled,
    afterInstall: async () => { await catalog.refresh(); await sync.pushInstalled(true); },
    // A fresh installed-apps list whenever the employee asks for something, unless the apps folders haven't changed (their modification
    // time moves the instant an app is added or removed, long before the file watcher's settle delay).
    refreshInventory: async () => { const sig = appsSignature(); await catalog.refresh(); await sync.pushInstalled(true); lastAppsSig = sig; },
    inventoryUnchanged: IS_MAC ? () => appsSignature() === lastAppsSig : undefined,
    notify: notifyEmployee,
    onChange: () => broadcast('agent:software'),
  });
  // Orbit: the personal companion (greeting, tasks, achievements, appreciation).
  orbit = new OrbitAgent({
    sync,
    flush: () => sync.pushUsage(),
    notify: async (t, b) => { if (mustHideCompanion()) return; if (companionVisible() && !(await fullscreenApp().catch(() => ''))) companionWin.webContents.send('agent:orbit-say', { title: t, body: b }); else notifyEmployee(t, b, 'orbit'); },
    onChange: () => broadcast('agent:orbit'),
  });
  care = new CareCoach({
    dir: app.getPath('userData'),
    status: () => tracker.status(),
    fullscreenApp: () => fullscreenApp(),
    hold: mustHideCompanion,
    getConfig: () => settings.care,
    name: () => sync.status().employeeName || '',
    wrapup: () => orbit.wrapup(),
    onNudge: deliverCare,
  });
  care.start();
  startPrivacyWatch();
  setTimeout(applyCompanion, 2500);
  screen.on('display-metrics-changed', () => applyCompanion());
  orbit.start();
  setTimeout(() => whenFree(async () => { if (!(await weekendCheckIn().catch(() => false))) maybeGreet(); }), 9000);
  powerMonitor.on('lock-screen', markAway);
  powerMonitor.on('suspend', markAway);
  const onReturn = () => whenFree(async () => { if (await weekendCheckIn().catch(() => false)) { awaySince = 0; return; } if (!maybeGreet()) welcomeBack().catch(() => {}); });
  powerMonitor.on('unlock-screen', () => setTimeout(onReturn, 3500));
  powerMonitor.on('resume', () => setTimeout(onReturn, 7000));
  sync.onSoftwareJobs = () => software.poke();
  // Apps installed or removed (by us, by the employee, by IT): the list follows within seconds.
  if (IS_MAC) appWatch = watchApps(APP_DIRS, async () => { const sig = appsSignature(); await catalog.refresh(); await sync.pushInstalled(); lastAppsSig = sig; });
  software.start();
  setInterval(() => checkWeekend(tracker.status().current), 60 * 1000);

  // Company-managed: always start with the computer (installed builds).
  ensureAutostart();

  powerMonitor.on('suspend', () => tracker.pause('sleep'));
  powerMonitor.on('resume', () => tracker.resume('sleep'));
  powerMonitor.on('lock-screen', () => tracker.pause('lock'));
  powerMonitor.on('unlock-screen', () => tracker.resume('lock'));
  // Shutdown, restart or logout: let the agent exit normally.
  powerMonitor.on('shutdown', () => { systemQuit = true; tracker.stop(); });

  registerIpc();
  createTray();
  if (!process.argv.includes('--hidden')) showWindow();

  setInterval(() => catalog.refresh(), 6 * 3600 * 1000); // rescan installed apps
  setInterval(() => broadcast('agent:tick'), 10000); // let open views refresh running totals
}

const APP_DIRS = IS_MAC ? ['/Applications', path.join(os.homedir(), 'Applications')] : [];
let lastAppsSig = '';
function appsSignature() {
  return APP_DIRS.map((d) => { try { return fs.statSync(d).mtimeMs; } catch { return 0; } }).join('|');
}

/** After an install: is the app really there? (path when we know it, otherwise the rescanned app list). */
async function detectInstalled(spec, installedPath) {
  if (installedPath) return fs.existsSync(installedPath);
  await catalog.refresh();
  const id = String(spec.appId || '').toLowerCase();
  const name = String(spec.name || '').toLowerCase();
  return catalog.apps.some((a) => (id && String(a.id).toLowerCase() === id) || String(a.name).toLowerCase() === name);
}

/** Native notification for install updates; skipped while the employee is already looking at the window. */
function notifyEmployee(title, body, page = 'install') {
  if (win && !win.isDestroyed() && win.isVisible() && win.isFocused()) return;
  if (!Notification.isSupported()) return;
  const n = new Notification({ title, body });
  n.on('click', () => { showWindow(); win?.webContents.send('agent:goto', page); });
  n.show();
}

app.on('before-quit', (e) => {
  // Installed agent: Cmd+Q / Alt+F4 / "Quit" from the Dock only hide it; it keeps tracking in the background.
  if (MANAGED && !systemQuit && gotLock) {
    e.preventDefault();
    hideToBackground();
    return;
  }
  quitting = true;
  software?.stop();
  orbit?.stop();
  care?.stop();
  appWatch?.close();
  tracker?.stop();
});
// Windows sends this at logout/shutdown.
app.on('session-end', () => { systemQuit = true; });

/** Closes the windows but keeps the agent running (menu bar / system tray only). */
function hideToBackground() {
  win?.hide();
  popover?.hide();
  if (IS_MAC) app.dock?.hide();
}

// Keep running in the tray / menu bar when the window is closed.
app.on('window-all-closed', () => {});
app.on('activate', () => { reviveCompanion(); showWindow(); });

/** The admin deleted this laptop's asset (or issued a new code): tell the employee and refresh the UI. */
function onAssetRemoved(st) {
  software?.reset();
  orbit?.reset();
  applyCompanion();
  broadcast('agent:update');
  updateTray();
  if (Notification.isSupported()) {
    const n = new Notification({
      title: 'This laptop was removed from Proglintor',
      body: `${st.removed?.assetId ? `Asset ${st.removed.assetId} was` : 'Its asset was'} removed by your admin. Nothing is being sent to Proglint. Open Proglintor to reconnect.`,
    });
    n.on('click', () => { showWindow(); broadcast('agent:navigate'); });
    n.show();
  }
}

function broadcast(channel) {
  for (const w of [win, popover, greetWin, companionWin]) if (w && !w.isDestroyed()) w.webContents.send(channel);
}

// ---- main window -----------------------------------------------------------------------

/** Development runs use Electron's own bundle, so the Dock icon is set explicitly (installed builds use the bundle's icon.icns). */
function setDockIcon() {
  if (IS_MAC && !app.isPackaged) app.dock?.setIcon(nativeImage.createFromPath(path.join(ASSETS, 'icons', 'agent-mac.png')));
}

function showWindow() {
  if (IS_MAC) { app.dock?.show(); setDockIcon(); }
  sync?.heartbeat().catch(() => {}); // so an admin's change (e.g. a deleted asset) is visible as soon as the window opens
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
    icon: path.join(ASSETS, 'icons', 'agent.png'),
    show: false,
    ...chrome,
    webPreferences: { preload: PRELOAD, contextIsolation: true, nodeIntegration: false, sandbox: true },
  });
  win.loadFile(path.join(RENDERER, 'index.html'), { query: { platform: process.platform } });
  win.once('ready-to-show', () => win.show());
  win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  win.on('close', (e) => {
    if (!quitting) { e.preventDefault(); hideToBackground(); }
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
    { label: 'Chat with Orbit', click: () => { showWindow(); win?.webContents.send('agent:goto', 'orbit'); } },
    presentingItem(),
    { label: persona().show ? 'Hide Orbit from screen' : 'Show Orbit on screen', accelerator: OrbitLogic.COMPANION_SHORTCUT, click: toggleCompanion },
  ]);
}

function stateLabel(st) {
  return { tracking: 'Tracking', idle: 'Idle', locked: 'Screen locked', paused: 'Paused (sleep)', unavailable: 'Detection unavailable', starting: 'Starting…' }[st.state] || st.state;
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

// ---- Orbit companion (always-on-screen orb) -----------------------------------------------------

const companionVisible = () => Boolean(companionWin && !companionWin.isDestroyed() && companionWin.isVisible());

/** Creates, moves, resizes or closes the floating orb to match the employee's choices. */
function applyCompanion() {
  const p = persona();
  const want = p.show && sync?.enrolled && !sync.status().removed;
  if (!want) { if (companionWin && !companionWin.isDestroyed()) companionWin.close(); return; }
  const b = OrbitLogic.placement(p, screen.getPrimaryDisplay().workArea);
  if (companionWin && !companionWin.isDestroyed()) {
    companionWin.setBounds({ x: b.x, y: b.y, width: b.width, height: b.height });
    companionWin.webContents.send('agent:orbit-layout', b);
    return;
  }
  companionWin = new BrowserWindow({
    x: b.x, y: b.y, width: b.width, height: b.height, show: false, frame: false, transparent: true, resizable: false, minimizable: false,
    maximizable: false, fullscreenable: false, skipTaskbar: true, hasShadow: false, alwaysOnTop: true, focusable: false, title: p.name,
    // A macOS panel stays on screen while another app is active. A normal window only shows while its own app is active,
    // which is almost never true for a background assistant (it simply never appeared when the agent started at login).
    ...(IS_MAC ? { type: 'panel' } : {}),
    webPreferences: { preload: PRELOAD, contextIsolation: true, nodeIntegration: false, sandbox: true },
  });
  companionWin.setContentProtection(persona().hideFromShare);
  companionWin.setAlwaysOnTop(true, 'floating');
  companionWin.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: false });
  companionWin.setIgnoreMouseEvents(true, { forward: true }); // clicks pass through until the pointer is over the orb or its bubble
  companionWin.loadFile(path.join(RENDERER, 'orbit-companion.html'));
  companionWin.once('ready-to-show', () => companionWin.showInactive());
  companionWin.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  companionWin.on('closed', () => { companionWin = null; });
}

/** A wellbeing reminder: a speech bubble from the orb (or a system notification if the orb is hidden or the employee prefers it). */
function deliverCare(n) {
  if (settings.care.delivery === 'orb' && companionVisible()) companionWin.webContents.send('agent:orbit-care', n);
  else notifyEmployee(n.title, n.body, 'orbit');
  broadcast('agent:orbit-care-state');
}

/** Hiding for an hour (or a custom time) comes back by itself; hiding "until I turn it on" needs one of the ways back below. */
function hideFor(minutes) {
  const m = Number(minutes);
  const result = setPersona({ show: false });   // (this clears any older timer)
  settings.orbitHiddenUntil = m > 0 ? Date.now() + Math.min(m, 24 * 60) * 60 * 1000 : 0;
  saveSettings();
  return result;
}

/** Bring the companion back (and cancel any timed hide). Used by the ways back: shortcut, menu, popover, dashboard, relaunching the app. */
function showCompanionAgain() {
  settings.orbitHiddenUntil = 0;
  if (presenting) setPresenting(false);
  return setPersona({ show: true });
}

/** Someone deliberately opened the app again (relaunch or Dock click): that is a clear sign they want to see it. */
function reviveCompanion() {
  if (!persona().show && sync?.enrolled) showCompanionAgain();
}

const toggleCompanion = () => (persona().show ? hideFor(0) : showCompanionAgain());

function setPersona(patch) {
  const wasShown = persona().show;
  if (patch && 'show' in patch) settings.orbitHiddenUntil = 0; // any deliberate show/hide replaces an older timed hide
  settings.orbit = OrbitLogic.sanitizePersona(patch, persona());
  if (wasShown && !settings.orbit.show && Notification.isSupported()) {
    // Hiding is easy to do and easy to forget how to undo: say where the way back is.
    new Notification({ title: `${persona().name} is hidden`, body: `To bring it back: press ${OrbitLogic.COMPANION_SHORTCUT.replace('CommandOrControl', IS_MAC ? 'Cmd' : 'Ctrl').replace('Alt', IS_MAC ? 'Option' : 'Alt')}, click the Proglintor icon in the menu bar, or open the dashboard and click "Show Orbit".` }).show();
  }
  saveSettings();
  applyCompanion();
  broadcast('agent:orbit-persona');
  updateTray();
  return settings.orbit;
}

function companionMenu() {
  const p = persona();
  const choose = (patch) => () => setPersona(patch);
  Menu.buildFromTemplate([
    { label: `Open ${p.name}`, click: () => { showWindow(); win?.webContents.send('agent:goto', 'orbit'); } },
    { type: 'separator' },
    { label: 'Ask me something…', click: () => companionWin?.webContents.send('agent:orbit-quick') },
    { label: 'Say hello now', click: () => companionWin?.webContents.send('agent:orbit-greet') },
    { type: 'separator' },
    presentingItem(),
    { label: 'Log a glass of water', click: () => { care?.logWater(); broadcast('agent:orbit-care-state'); } },
    care?.snapshot().focus
      ? { label: 'Stop focus session', click: () => { care.focus(0); broadcast('agent:orbit-care-state'); } }
      : { label: 'Start a 25-minute focus session', click: () => { care?.focus(25); broadcast('agent:orbit-care-state'); } },
    care?.snapshot().pausedUntil
      ? { label: 'Resume reminders', click: () => { care.resume(); broadcast('agent:orbit-care-state'); } }
      : { label: 'Pause reminders for 1 hour', click: () => { care?.pauseFor(60); broadcast('agent:orbit-care-state'); } },
    { type: 'separator' },
    { label: 'Position', submenu: OrbitLogic.DOCKS.map((d) => ({ label: d.name, type: 'radio', checked: p.dock === d.id, click: choose({ dock: d.id }) })) },
    { label: 'Size', submenu: OrbitLogic.SIZES.map((z) => ({ label: z.name, type: 'radio', checked: p.size === z.id, click: choose({ size: z.id }) })) },
    { type: 'separator' },
    { label: 'Hide for 1 hour', click: () => hideFor(60) },
    { label: 'Hide until I turn it back on', click: () => hideFor(0) },
  ]).popup({ window: companionWin || undefined });
}

let dragStart = null;

// ---- Orbit greeting ---------------------------------------------------------------------------

const persona = () => OrbitLogic.sanitizePersona(settings.orbit);

/** Once per local day, when the laptop is opened: a small card greets the employee. It never takes focus and never speaks unless asked to. */
function maybeGreet() {
  if (!sync?.enrolled || sync.status().removed || greetWin) return false;
  const today = OrbitLogic.dayKey();
  if (!OrbitLogic.shouldGreet({ enabled: persona().greet, enrolled: true, lastDay: settings.orbitLastGreetDay || '', today })) return false;
  settings.orbitLastGreetDay = today;
  saveSettings();
  applyCompanion();
  if (companionVisible()) companionWin.webContents.send('agent:orbit-greet');
  else showGreeting();
  return true;
}

/**
 * Weekend check-in: when the laptop is opened on a weekend day, the orb asks (calmly) what brought them in, and offers any high-priority work
 * assigned to them as an answer. The answer goes to the admin exactly like the weekend prompt always has, and counts as "answered".
 * Returns true if it asked.
 */
const fullscreenApp = makeFullscreenProbe(() => screen.getPrimaryDisplay().bounds);

// ---- keeping the companion out of screen shares ----------------------------------------------------------
// Layers: (1) the windows are excluded from screen capture where the OS honours it (best effort; newer macOS capture APIs ignore it),
// (2) the companion hides itself while a call or presentation app is in front, or while Zoom's share helper is running,
// (3) Presenting mode hides it completely on demand (menu, tray, or the keyboard shortcut) and holds every reminder until it is switched off.
let presenting = false;
let presentingTimer = null;
let zoomSharing = false;

const frontApp = () => { const st = tracker?.status() || {}; return `${st.current?.id || ''} ${st.current?.name || ''}`; };
const mustHideCompanion = () => CareLogic.shouldHideCompanion({
  presenting, sharing: zoomSharing, hideInCalls: persona().hideInCalls, pauseInMeetings: settings.care.pauseInMeetings, current: frontApp(), quietApps: settings.care.quietApps,
});

let orbitLog = null;
let lastHideReason = '';
const hideReason = () => (presenting ? 'presenting mode' : zoomSharing ? 'zoom is sharing' : mustHideCompanion() ? `call or presentation app in front (${frontApp().trim()})` : '');

function refreshPrivacy() {
  if (settings.orbitHiddenUntil && Date.now() >= settings.orbitHiddenUntil) showCompanionAgain(); // the timed hide is over
  const hide = mustHideCompanion();
  const reason = hide ? hideReason() : '';
  if (reason !== lastHideReason) { orbitLog?.(hide ? 'companion.hidden' : 'companion.shown', { reason }); lastHideReason = reason; }
  for (const w of [companionWin, greetWin]) {
    if (!w || w.isDestroyed()) continue;
    w.setContentProtection(persona().hideFromShare);
    if (hide && w.isVisible()) w.hide();
    else if (!hide && w === companionWin && !w.isVisible() && persona().show) w.showInactive();
  }
}

function setPresenting(on) {
  presenting = on === true;
  clearTimeout(presentingTimer);
  if (presenting) presentingTimer = setTimeout(() => setPresenting(false), 3 * 60 * 60 * 1000); // never stay hidden forever by accident
  refreshPrivacy();
  updateTray();
  broadcast('agent:orbit-care-state');
  return presenting;
}

const presentingItem = () => ({ label: presenting ? 'Stop presenting mode (show me again)' : 'Presenting mode: hide me for a call or share', accelerator: OrbitLogic.PRESENTING_SHORTCUT, click: () => setPresenting(!presenting) });

function startPrivacyWatch() {
  orbitLog = makeLog(app.getPath('userData'), 'orbit.log');
  orbitLog('agent.start', { args: process.argv.slice(2).join(' '), show: persona().show });
  setInterval(refreshPrivacy, 2000);
  // Zoom starts a helper called CptHost for as long as someone is sharing their screen: a real "sharing now" signal.
  if (process.platform === 'darwin') setInterval(() => execFile('pgrep', ['-x', 'CptHost'], (err) => { zoomSharing = !err; }), 5000);
  try { globalShortcut.register(OrbitLogic.PRESENTING_SHORTCUT, () => setPresenting(!presenting)); } catch { /* another app owns the shortcut: the menu still works */ }
  try { globalShortcut.register(OrbitLogic.COMPANION_SHORTCUT, toggleCompanion); } catch { /* the other ways back still work */ }
  app.on('will-quit', () => globalShortcut.unregisterAll());
}

/** Greetings and check-ins wait until nothing is using the whole screen (retrying every two minutes), instead of being lost. */
async function whenFree(fn, tries = 15) {
  for (let i = 0; i < tries; i++) {
    if (!mustHideCompanion() && !(await fullscreenApp().catch(() => ''))) return fn();
    await new Promise((r) => setTimeout(r, 2 * 60 * 1000));
  }
  return false;
}

let pendingCheckIn = null;
async function weekendCheckIn(demo = false) {
  if (!sync?.enrolled || sync.status().removed) return false;
  const policy = sync.policy;
  const now = Date.now();
  const day = dayKey(now);
  if (!demo) {
    if (!policy.weekendCheck || !isWeekend(now, policy.weekendDays)) return false;
    if (sync.promptState(day).answered) return false;
    if (settings.orbitWeekendAskedAt && now - settings.orbitWeekendAskedAt < 90 * 60 * 1000) return false; // never nag: at most once in 90 minutes
  }
  applyCompanion();
  if (!companionVisible()) return false;
  const r = await orbit.tasks();
  const urgent = OrbitLogic.pickUrgentTasks(r.ok ? r.data : null, new Date(now));
  const ask = OrbitLogic.weekendCheckIn({ name: sync.status().employeeName || '', urgent, reasons: policy.reasons, now: new Date(now) });
  pendingCheckIn = { day, choices: ask.choices, urgent: urgent.length, demo };
  if (!demo) {
    settings.orbitWeekendAskedAt = now;
    settings.orbitLastGreetDay = OrbitLogic.dayKey(new Date(now)); // this replaces today's greeting
    saveSettings();
  }
  companionWin.showInactive();
  companionWin.moveTop();
  companionWin.webContents.send('agent:orbit-checkin', { text: ask.text, choices: ask.choices.map((c) => ({ id: c.id, label: c.label })), hasUrgent: urgent.length > 0 });
  return true;
}

/** Back at the laptop after a while (lid closed, screen locked): the orb comes forward and says hello with the first thing to do. */
let awaySince = 0;
const markAway = () => { if (!awaySince) awaySince = Date.now(); };

async function welcomeBack(demo = false) {
  const since = awaySince;
  awaySince = 0;
  const wb = persona().welcomeBack;
  if (!demo && (!since || !wb || (Date.now() - since) / 60000 < wb)) return;
  if (!sync?.enrolled || sync.status().removed || !persona().show) return;
  applyCompanion();
  if (!companionVisible()) return;
  const r = await orbit.tasks();
  const text = OrbitLogic.welcomeBackText({ name: sync.status().employeeName || '', tasks: r.ok ? r.data : null, hour: new Date().getHours() });
  companionWin.showInactive();
  companionWin.moveTop();
  companionWin.webContents.send('agent:orbit-welcome', { text });
}

function showGreeting() {
  if (greetWin && !greetWin.isDestroyed()) { greetWin.show(); return; }
  const { workArea } = screen.getPrimaryDisplay();
  const w = 420;
  const h = 400;
  greetWin = new BrowserWindow({
    width: w, height: h, x: Math.round(workArea.x + workArea.width - w - 24), y: Math.round(workArea.y + 24),
    show: false, frame: false, transparent: true, resizable: false, minimizable: false, maximizable: false, fullscreenable: false,
    skipTaskbar: true, hasShadow: false, alwaysOnTop: true, title: persona().name,
    ...(IS_MAC ? { type: 'panel' } : {}), // same reason as the companion: it must appear while another app is in front
    webPreferences: { preload: PRELOAD, contextIsolation: true, nodeIntegration: false, sandbox: true },
  });
  greetWin.setContentProtection(persona().hideFromShare);
  greetWin.setAlwaysOnTop(true, 'floating');
  greetWin.loadFile(path.join(RENDERER, 'orbit-greet.html'));
  greetWin.once('ready-to-show', () => greetWin.showInactive());
  greetWin.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  greetWin.on('closed', () => { greetWin = null; });
}

/** Saves an approved certificate as a PDF the employee can keep or print. The page is rendered with scripts off. */
async function saveCertificate(id) {
  const r = await orbit.certificate(id);
  if (!r.ok) return r;
  const target = await dialog.showSaveDialog(win && !win.isDestroyed() ? win : undefined, {
    title: 'Save certificate', defaultPath: path.join(app.getPath('documents'), `${String(r.data.certificateId || 'certificate').replace(/[^A-Za-z0-9_-]/g, '')}.pdf`),
    filters: [{ name: 'PDF', extensions: ['pdf'] }],
  });
  if (target.canceled || !target.filePath) return { ok: true, data: { saved: false } };
  const hidden = new BrowserWindow({ show: false, webPreferences: { javascript: false, sandbox: true, contextIsolation: true, nodeIntegration: false } });
  try {
    await hidden.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(r.data.html)}`);
    const pdf = await hidden.webContents.printToPDF({ landscape: true, printBackground: true, pageSize: 'A4', margins: { marginType: 'none' } });
    fs.writeFileSync(target.filePath, pdf);
    return { ok: true, data: { saved: true, path: target.filePath } };
  } catch {
    return { ok: false, code: 'save_failed', error: 'I could not save the certificate. Please try another folder.' };
  } finally {
    hidden.destroy();
  }
}

function registerIpc() {
  ipcMain.handle('orbit:checkin:answer', (e, id) => {
    if (!companionWin || e.sender !== companionWin.webContents || !pendingCheckIn) return { ok: false };
    const c = pendingCheckIn.choices.find((x) => x.id === id);
    if (!c) return { ok: false };
    const { day } = pendingCheckIn;
    const pendingCheckIn_demo = pendingCheckIn.demo === true;
    pendingCheckIn = null;
    if (c.reason && !pendingCheckIn_demo) {
      sync.queueAlert({ day, appId: 'orbit', appName: 'Orbit check-in', reason: c.reason, details: c.details, approver: '', duration: '', dismissed: false });
      sync.markPrompt(day, { answered: true });
    }
    return { ok: true, reply: OrbitLogic.replyFor(c), recorded: Boolean(c.reason) && !pendingCheckIn_demo };
  });
  ipcMain.handle('orbit:hide', (_e, minutes) => { hideFor(minutes); return true; });
  ipcMain.handle('orbit:show', () => { showCompanionAgain(); return true; });
  ipcMain.handle('orbit:presenting', (_e, on) => (typeof on === 'boolean' ? setPresenting(on) : presenting));
  ipcMain.handle('orbit:care:get', () => ({ config: settings.care, snapshot: care.snapshot(), presenting }));
  ipcMain.handle('orbit:care:set', (_e, patch) => {
    settings.care = CareLogic.sanitizeCare(patch, settings.care);
    saveSettings();
    broadcast('agent:orbit-care-state');
    return { config: settings.care, snapshot: care.snapshot() };
  });
  ipcMain.handle('orbit:care:act', (_e, kind, action) => { const r = care.act(kind, action); broadcast('agent:orbit-care-state'); return r; });
  ipcMain.handle('orbit:care:water', () => { const r = care.logWater(); broadcast('agent:orbit-care-state'); return r; });
  ipcMain.handle('orbit:care:pause', (_e, minutes) => { const r = minutes > 0 ? care.pauseFor(minutes) : care.resume(); broadcast('agent:orbit-care-state'); return r; });
  ipcMain.handle('orbit:care:focus', (_e, minutes) => { const r = care.focus(minutes); broadcast('agent:orbit-care-state'); return r; });
  ipcMain.handle('orbit:companion:layout', () => OrbitLogic.placement(persona(), screen.getPrimaryDisplay().workArea));
  ipcMain.handle('orbit:companion:hit', (e, over) => { if (companionWin && !companionWin.isDestroyed() && e.sender === companionWin.webContents) companionWin.setIgnoreMouseEvents(!over, { forward: true }); return true; });
  ipcMain.handle('orbit:companion:open', (_e, page) => { showWindow(); win?.webContents.send('agent:goto', page === 'install' ? 'install' : 'orbit'); return true; });
  ipcMain.handle('orbit:companion:focus', (e, on) => {
    if (!companionWin || companionWin.isDestroyed() || e.sender !== companionWin.webContents) return false;
    companionWin.setFocusable(on === true); // typing needs focus; otherwise the companion never takes it
    if (on === true) companionWin.focus();
    return true;
  });
  /** "Show me": plays one of the companion's moments right now, so people can see (and choose) the animals without waiting. Records nothing. */
  ipcMain.handle('orbit:demo', async (_e, kind) => {
    if (!persona().show) return { ok: false, error: 'The companion is hidden. Turn on "Keep me on screen" first.' };
    if (!sync?.enrolled) return { ok: false, error: 'Connect this laptop first (My Device).' };
    applyCompanion();
    await new Promise((r) => setTimeout(r, 400));
    if (!companionVisible()) return { ok: false, error: 'The companion is not on screen yet. Try again in a moment.' };
    companionWin.showInactive();
    const name = (sync.status().employeeName || '').split(/\s+/)[0];
    if (kind === 'greet') companionWin.webContents.send('agent:orbit-greet');
    else if (kind === 'welcome') await welcomeBack(true);
    else if (kind === 'checkin') await weekendCheckIn(true);
    else if (kind === 'quick') companionWin.webContents.send('agent:orbit-quick');
    else if (CareLogic.words(kind).body !== '') companionWin.webContents.send('agent:orbit-care', { id: `demo-${kind}`, kind, ...CareLogic.words(kind, { counts: {}, activeMs: 9 * 3600000, name }), demo: true });
    else return { ok: false, error: 'Unknown moment.' };
    return { ok: true };
  });
  ipcMain.handle('orbit:companion:menu', () => { companionMenu(); return true; });
  ipcMain.handle('orbit:companion:drag', (e, phase, dx, dy) => {
    if (!companionWin || companionWin.isDestroyed() || e.sender !== companionWin.webContents) return false;
    if (phase === 'start') dragStart = companionWin.getBounds();
    else if (phase === 'move' && dragStart && Number.isFinite(dx) && Number.isFinite(dy)) companionWin.setPosition(Math.round(dragStart.x + dx), Math.round(dragStart.y + dy));
    else if (phase === 'end' && dragStart) {
      const b = companionWin.getBounds();
      dragStart = null;
      setPersona({ dock: 'free', x: b.x, y: b.y });
    }
    return true;
  });
  ipcMain.handle('orbit:briefing', () => orbit.briefing());
  ipcMain.handle('orbit:chat', (_e, messages, agentName) => orbit.chat(messages, agentName));
  ipcMain.handle('orbit:tasks', () => orbit.tasks());
  ipcMain.handle('orbit:task', (_e, id, patch) => orbit.updateTask(id, patch));
  ipcMain.handle('orbit:achievements', () => orbit.achievements());
  ipcMain.handle('orbit:timesheet', (_e, month) => orbit.timesheet(month));
  ipcMain.handle('orbit:timesheet:summary', (_e, period, start) => orbit.timesheetSummary(period, start));
  ipcMain.handle('orbit:timesheet:csv', async (_e, month) => {
    const r = await orbit.timesheet(month);
    if (!r.ok) return r;
    const who = sync.status().employeeName || '';
    const target = await dialog.showSaveDialog(win && !win.isDestroyed() ? win : undefined, {
      title: 'Save timesheet', defaultPath: path.join(app.getPath('documents'), `timesheet-${month}.csv`), filters: [{ name: 'CSV', extensions: ['csv'] }],
    });
    if (target.canceled || !target.filePath) return { ok: true, data: { saved: false } };
    try { fs.writeFileSync(target.filePath, TimesheetLogic.toCsv(r.data, who)); return { ok: true, data: { saved: true } }; } catch { return { ok: false, code: 'save_failed', error: 'I could not save the file. Please try another folder.' }; }
  });
  ipcMain.handle('orbit:nominate', (_e, body) => orbit.nominate(body));
  ipcMain.handle('orbit:certificate', (_e, id) => orbit.certificate(id));
  ipcMain.handle('orbit:certificate:save', (_e, id) => (ORBIT_UUID.test(String(id)) ? saveCertificate(id) : { ok: false, code: 'bad_input', error: 'I could not find that certificate.' }));
  ipcMain.handle('orbit:persona:get', () => persona());
  ipcMain.handle('orbit:persona:set', (_e, patch) => setPersona(patch));
  ipcMain.handle('orbit:identity', () => ({ name: sync.status().employeeName || '', enrolled: Boolean(sync.enrolled) }));
  ipcMain.handle('orbit:poke', () => { orbit.poke(); return true; });
  ipcMain.handle('orbit:greet:act', (e, what) => {
    const w = BrowserWindow.fromWebContents(e.sender);
    if (what === 'open') { showWindow(); win?.webContents.send('agent:goto', 'orbit'); }
    if (what === 'off') setPersona({ greet: false });
    if (w && !w.isDestroyed()) w.close();
    return true;
  });


  // Organization (Proglint server)
  ipcMain.handle('org:status', () => ({ ...sync.status(), device: device() }));
  ipcMain.handle('org:enroll', async (_e, code) => {
    try { const status = await sync.enroll(code); applyCompanion(); return { ok: true, status }; } catch (err) { return { ok: false, error: err.message }; }
  });
  ipcMain.handle('org:sync', async () => {
    try { await sync.syncNow(); return { ok: true }; } catch (err) { return { ok: false, error: err.message }; }
  });

  // Install assistant (employee). Inputs are validated here too: the renderer is not trusted.
  const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
  const bad = (error) => ({ ok: false, code: 'invalid', error });
  ipcMain.handle('sw:catalogue', () => software.catalogue());
  ipcMain.handle('sw:list', () => software.list());
  ipcMain.handle('sw:preview', (_e, prompt) => (typeof prompt === 'string' && prompt.length <= 600 ? software.preview(prompt) : bad('Please type a shorter request.')));
  ipcMain.handle('sw:submit', (_e, prompt, key, reinstall) => {
    if (typeof prompt !== 'string' || prompt.length > 600) return bad('Please type a shorter request.');
    if (typeof key !== 'string' || !/^[A-Za-z0-9._:-]{8,64}$/.test(key)) return bad('This request is missing its id. Please try again.');
    return software.submit(prompt, key, reinstall === true);
  });
  ipcMain.handle('sw:assist', (_e, message, history) => {
    if (typeof message !== 'string' || message.length > 600) return bad('Please type a shorter message.');
    const lines = (Array.isArray(history) ? history : []).slice(-6)
      .filter((h) => h && (h.role === 'user' || h.role === 'assistant') && typeof h.text === 'string')
      .map((h) => ({ role: h.role, text: h.text.slice(0, 300) }));
    return software.assist(message, lines);
  });
  ipcMain.handle('sw:confirm', (_e, id) => (typeof id === 'string' && UUID.test(id) ? software.confirm(id) : bad('I could not find that suggestion.')));
  ipcMain.handle('sw:cancel', (_e, id) => (typeof id === 'string' && UUID.test(id) ? software.cancel(id) : bad('I could not find that request.')));

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
  ipcMain.handle('app:quit', () => { hideToBackground(); return false; }); // the agent can't be quit from its UI

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
