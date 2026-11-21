'use strict';
// Proglintor Admin: desktop console for the Proglintor Django backend.
const { app, BrowserWindow, Tray, Menu, ipcMain, dialog, nativeImage, nativeTheme, Notification, clipboard } = require('electron');
const fs = require('fs');
const os = require('os');
const path = require('path');

const brand = require('../shared/branding');
const { Backend, AuthError } = require('./backend');

const ASSETS = path.join(__dirname, '..', '..', 'assets');
const IS_MAC = process.platform === 'darwin';
const IS_WIN = process.platform === 'win32';
const POLL_MS = 10 * 1000;

app.setName(brand.adminName);
app.setPath('userData', process.env.PULSE_USER_DATA || path.join(app.getPath('appData'), brand.adminName));
if (IS_WIN) app.setAppUserModelId(brand.adminAppId);

let win = null;
let tray = null;
let backend = null;
let quitting = false;
let seenAlerts = null; // uids of "new" alerts already notified (null until the first poll)
let newAlertCount = 0;

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', showWindow);
  app.whenReady().then(init);
}

// ---- startup -----------------------------------------------------------------------------

/** First run after the rename: keep the sign-in and preferences from "Proglint Pulse Admin". */
function migrateLegacy() {
  if (process.env.PULSE_USER_DATA) return;
  const dir = app.getPath('userData');
  const old = path.join(app.getPath('appData'), 'Proglint Pulse Admin');
  fs.mkdirSync(dir, { recursive: true });
  for (const file of ['backend.json', 'preferences.json']) {
    const target = path.join(dir, file);
    if (!fs.existsSync(target) && fs.existsSync(path.join(old, file))) fs.copyFileSync(path.join(old, file), target);
  }
  fs.rmSync(path.join(os.homedir(), '.config', 'autostart', 'proglint-pulse-admin.desktop'), { force: true });
}

async function init() {
  if (IS_MAC && !app.isPackaged) app.dock?.setIcon(nativeImage.createFromPath(path.join(ASSETS, 'icons', 'admin-mac.png'))); // dev runs: show the Proglintor Admin icon in the Dock
  migrateLegacy();
  backend = new Backend(path.join(app.getPath('userData'), 'backend.json'));
  registerIpc();
  createTray();
  if (app.isPackaged && readPrefs().openAtLogin !== false && !getOpenAtLogin()) setOpenAtLogin(true);
  if (!process.argv.includes('--hidden')) showWindow();
  poll();
  setInterval(poll, POLL_MS);
}

app.on('before-quit', () => { quitting = true; });
app.on('window-all-closed', () => {});
app.on('activate', showWindow);

const prefsFile = () => path.join(app.getPath('userData'), 'preferences.json');
function readPrefs() { try { return JSON.parse(fs.readFileSync(prefsFile(), 'utf8')); } catch { return {}; } }
function writePrefs(p) { fs.writeFileSync(prefsFile(), JSON.stringify({ ...readPrefs(), ...p }, null, 2)); }

function setOpenAtLogin(enabled) {
  if (process.platform === 'linux') {
    const file = path.join(os.homedir(), '.config', 'autostart', 'proglintor-admin.desktop');
    if (!enabled) { fs.rmSync(file, { force: true }); return; }
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, `[Desktop Entry]\nType=Application\nName=${brand.adminName}\nExec="${process.env.APPIMAGE || process.execPath}" --hidden\nX-GNOME-Autostart-enabled=true\n`);
    return;
  }
  app.setLoginItemSettings({ openAtLogin: enabled, openAsHidden: true, args: ['--hidden'] });
}

function getOpenAtLogin() {
  if (process.platform === 'linux') return fs.existsSync(path.join(os.homedir(), '.config', 'autostart', 'proglintor-admin.desktop'));
  return app.getLoginItemSettings().openAtLogin;
}

// ---- polling: live refresh + weekend alert notifications ----------------------------------------

async function poll() {
  if (!backend.loggedIn) { updateTray(); return; }
  try {
    const alerts = await backend.get('/api/admin/alerts?status=new');
    newAlertCount = alerts.length;
    const uids = new Set(alerts.map((a) => a.uid));
    if (seenAlerts) for (const a of alerts) if (!seenAlerts.has(a.uid)) notify(a);
    seenAlerts = uids;
  } catch (err) {
    if (err instanceof AuthError) send('admin:auth');
  }
  updateBadge();
  send('admin:update');
}

function notify(alert) {
  if (!Notification.isSupported()) return;
  const who = alert.employeeName ? `${alert.employeeName} (${alert.assetId})` : alert.assetId;
  const n = new Notification({
    title: alert.dismissed ? `Weekend work: ${who}` : `Weekend work reason from ${who}`,
    body: alert.dismissed ? `Opened ${alert.appName} and postponed answering.` : `${alert.appName} — ${alert.reason}${alert.details ? `: ${alert.details}` : ''}`,
  });
  n.on('click', () => { showWindow(); send('admin:navigate', 'alerts'); });
  n.show();
}

function send(channel, ...args) {
  if (win && !win.isDestroyed()) win.webContents.send(channel, ...args);
}

function updateBadge() {
  if (IS_MAC) app.dock?.setBadge(newAlertCount ? String(newAlertCount) : '');
  else app.setBadgeCount?.(newAlertCount);
  updateTray();
}

// ---- window & tray -----------------------------------------------------------------------

function showWindow() {
  if (win) {
    if (win.isMinimized()) win.restore();
    win.show();
    win.focus();
    return;
  }
  const chrome = IS_MAC
    ? { titleBarStyle: 'hiddenInset', trafficLightPosition: { x: 18, y: 20 }, backgroundColor: nativeTheme.shouldUseDarkColors ? '#0e1015' : '#f5f6fa' }
    : { backgroundColor: nativeTheme.shouldUseDarkColors ? '#111318' : '#f6f7fb', autoHideMenuBar: true, ...(IS_WIN ? { backgroundMaterial: 'mica' } : {}) };
  win = new BrowserWindow({
    width: 1360,
    height: 880,
    minWidth: 1080,
    minHeight: 680,
    title: brand.adminName,
    icon: path.join(ASSETS, 'icons', 'admin.png'),
    show: false,
    ...chrome,
    webPreferences: { preload: path.join(__dirname, 'preload.js'), contextIsolation: true, nodeIntegration: false, sandbox: true },
  });
  win.loadFile(path.join(__dirname, 'renderer', 'index.html'));
  win.once('ready-to-show', () => win.show());
  win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  win.on('close', (e) => { if (!quitting) { e.preventDefault(); win.hide(); } });
  win.on('closed', () => { win = null; });
}

function createTray() {
  const icon = nativeImage.createFromPath(path.join(ASSETS, IS_MAC ? 'adminTrayTemplate.png' : 'admin-tray.png'));
  if (IS_MAC) icon.setTemplateImage(true);
  tray = new Tray(icon);
  tray.on('click', () => { if (!IS_MAC) showWindow(); });
  updateTray();
}

function updateTray() {
  if (!tray) return;
  const status = !backend?.loggedIn ? 'Not signed in' : backend.reachable === false ? 'Backend unreachable' : `Connected to ${backend.url}`;
  tray.setToolTip(`${brand.adminName} — ${status}`);
  tray.setContextMenu(Menu.buildFromTemplate([
    { label: status, enabled: false },
    ...(newAlertCount ? [{ label: `${newAlertCount} new weekend alert${newAlertCount === 1 ? '' : 's'}`, click: () => { showWindow(); send('admin:navigate', 'alerts'); } }] : []),
    { type: 'separator' },
    { label: 'Open Admin Console', click: showWindow },
    { type: 'separator' },
    { label: `Quit ${brand.adminName}`, click: () => app.quit() },
  ]));
}

// ---- helpers ------------------------------------------------------------------------------

/** Address employees enter in the agent (the backend URL, without a trailing slash). */
function serverInfo() {
  const url = backend.url;
  let local = false;
  try { local = ['127.0.0.1', 'localhost', '::1'].includes(new URL(url).hostname); } catch { /* not configured */ }
  return {
    loggedIn: backend.loggedIn,
    running: backend.loggedIn && backend.reachable !== false,
    reachable: backend.reachable,
    error: backend.lastError,
    url,
    local,
    user: backend.user,
    lastLogin: backend.lastLogin,
    addresses: url ? [{ name: local ? 'This computer only' : 'Backend', address: url.replace(/^http:\/\//, '') }] : [],
  };
}

async function confirm(message, detail, okLabel) {
  const { response } = await dialog.showMessageBox(win, { type: 'warning', buttons: ['Cancel', okLabel], defaultId: 0, cancelId: 0, message, detail });
  return response === 1;
}

const enc = encodeURIComponent;

// ---- IPC ------------------------------------------------------------------------------------

function registerIpc() {
  /** Errors are returned as values so the renderer can show sign-in or offline states. */
  const handle = (channel, fn) => ipcMain.handle(channel, async (...args) => {
    try { return await fn(...args); } catch (err) {
      if (err instanceof AuthError) send('admin:auth', err.message);
      return { __error: err.message, auth: err instanceof AuthError, network: Boolean(err.network) };
    }
  });
  /** For forms: { ok, data } or { ok: false, error }. */
  const form = (channel, fn) => ipcMain.handle(channel, async (...args) => {
    try { return { ok: true, data: await fn(...args) }; } catch (err) {
      if (err instanceof AuthError) send('admin:auth', err.message);
      return { ok: false, error: err.message };
    }
  });

  // Auth
  ipcMain.handle('auth:status', () => serverInfo());
  /** Sign-in forms: { ok, data } or { ok: false, error, field, needsSetup }. */
  const authForm = (channel, fn) => ipcMain.handle(channel, async (...args) => {
    try { return { ok: true, data: await fn(...args) }; } catch (err) {
      return { ok: false, error: err.message, field: err.field || null, needsSetup: Boolean(err.needsSetup), network: Boolean(err.network) };
    }
  });
  const signedIn = (user) => { seenAlerts = null; poll(); return user; };
  authForm('auth:check', (_e, url) => backend.check(url));
  authForm('auth:login', async (_e, url, login, password) => signedIn(await backend.login(url, login, password)));
  authForm('auth:setup', async (_e, url, form) => signedIn(await backend.setup(url, form)));
  authForm('auth:forgot', (_e, url, login) => backend.forgot(url, login));
  authForm('auth:reset', async (_e, url, login, code, password) => signedIn(await backend.reset(url, login, code, password)));
  handle('auth:logout', async () => { await backend.logout(); seenAlerts = null; newAlertCount = 0; updateBadge(); return true; });

  // Data
  handle('dash:get', async () => ({ ...(await backend.get('/api/admin/dashboard')), server: serverInfo() }));
  handle('assets:list', () => backend.get('/api/admin/assets'));
  handle('assets:detail', async (_e, id) => ({ ...(await backend.get(`/api/admin/assets/${enc(id)}`)), server: serverInfo() }));
  form('assets:create', async (_e, data) => { const a = await backend.post('/api/admin/assets', data); send('admin:update'); return a; });
  form('assets:update', async (_e, id, data) => { const a = await backend.patch(`/api/admin/assets/${enc(id)}`, data); send('admin:update'); return a; });
  handle('assets:delete', async (_e, id) => {
    if (!(await confirm(`Delete asset ${id}?`, 'Its usage history and alerts are deleted. Within about 30 seconds the Proglintor app on that laptop shows that it was removed and stops sending data. This cannot be undone.', 'Delete'))) return false;
    await backend.delete(`/api/admin/assets/${enc(id)}`);
    send('admin:update');
    return true;
  });
  handle('assets:reset', async (_e, id, ask = true) => {
    const a = await backend.get(`/api/admin/assets/${enc(id)}`);
    if (ask && a.asset.enrolled && !(await confirm(`Generate a new enrollment code for ${id}?`, 'The laptop currently linked to this asset is disconnected until the new code is entered.', 'New code'))) return null;
    const r = await backend.post(`/api/admin/assets/${enc(id)}/reset-code`);
    send('admin:update');
    return r;
  });

  handle('alerts:list', (_e, status) => backend.get(`/api/admin/alerts?status=${enc(status || 'all')}`));
  handle('alerts:update', async (_e, uid, patch) => { const r = await backend.patch(`/api/admin/alerts/${enc(uid)}`, patch); poll(); return r; });

  handle('policy:get', () => backend.get('/api/admin/policy'));
  handle('policy:set', (_e, p) => backend.put('/api/admin/policy', p));

  // App icons uploaded by agents. Found icons are cached; misses are retried after 2 minutes.
  const iconCache = new Map(); // id -> { url, at }
  ipcMain.handle('icons:get', async (_e, ids) => {
    try {
      const wanted = (ids || []).map(String).filter((id) => { const c = iconCache.get(id); return !c || (!c.url && Date.now() - c.at > 120000); });
      for (let i = 0; i < wanted.length; i += 100) {
        const chunk = wanted.slice(i, i + 100);
        const r = await backend.post('/api/admin/icons', { ids: chunk });
        for (const id of chunk) iconCache.set(id, { url: r.icons?.[id] || null, at: Date.now() });
      }
    } catch { /* offline or signed out: letters are shown */ }
    return Object.fromEntries((ids || []).map((id) => [id, iconCache.get(String(id))?.url || null]));
  });

  handle('server:info', () => serverInfo());

  ipcMain.handle('settings:get', () => ({ openAtLogin: getOpenAtLogin(), packaged: app.isPackaged }));
  ipcMain.handle('settings:set', (_e, patch) => {
    if (typeof patch.openAtLogin === 'boolean') { setOpenAtLogin(patch.openAtLogin); writePrefs({ openAtLogin: patch.openAtLogin }); }
    return { openAtLogin: getOpenAtLogin(), packaged: app.isPackaged };
  });

  handle('data:export', async () => {
    const csv = await backend.request('GET', '/api/admin/export.csv', null, { raw: true });
    const day = new Date().toISOString().slice(0, 10);
    const { canceled, filePath } = await dialog.showSaveDialog(win, { defaultPath: `proglint-usage-${day}.csv`, filters: [{ name: 'CSV', extensions: ['csv'] }] });
    if (canceled || !filePath) return null;
    fs.writeFileSync(filePath, csv);
    return filePath;
  });
  ipcMain.handle('clipboard:write', (_e, text) => { clipboard.writeText(String(text)); return true; });
}
