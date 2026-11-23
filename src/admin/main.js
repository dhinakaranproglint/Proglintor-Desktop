'use strict';
// Proglintor Admin: desktop console for the Proglintor Django backend.
const { app, BrowserWindow, Tray, Menu, ipcMain, dialog, nativeImage, nativeTheme, Notification, clipboard } = require('electron');
const fs = require('fs');
const os = require('os');
const path = require('path');

const brand = require('../shared/branding');
const { Backend, AuthError } = require('./backend');
const { inspectLink, friendly, InspectError, cleanLinkInput } = require('./inspect');
const { renderAndCapture } = require('./render');
const presets = require('./presets');

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
let seenApprovals = null; // ids of software requests waiting for approval that were already notified
let pendingApprovals = 0;
let seenRecs = null; // ids of appreciation requests already notified
let pendingRecs = 0;

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
    const pending = (await backend.get('/api/admin/software/approvals')).items || [];
    pendingApprovals = pending.length;
    const ids = new Set(pending.map((r) => r.id));
    if (seenApprovals) for (const r of pending) if (!seenApprovals.has(r.id)) notifyApproval(r);
    seenApprovals = ids;
    const recs = (await backend.get('/api/admin/orbit/recognitions?status=pending')).items || [];
    pendingRecs = recs.length;
    if (seenRecs) for (const r of recs) if (!seenRecs.has(r.id)) notifyRecognition(r);
    seenRecs = new Set(recs.map((r) => r.id));
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

function notifyApproval(req) {
  if (!Notification.isSupported()) return;
  const n = new Notification({
    title: 'Software approval needed',
    body: `${req.employeeName} (${req.assetId}) asked for ${[req.softwareName, req.version].filter(Boolean).join(' ')}.`,
  });
  n.on('click', () => { showWindow(); send('admin:navigate', 'approvals'); });
  n.show();
}

function notifyRecognition(rec) {
  if (!Notification.isSupported()) return;
  const n = new Notification({ title: `Appreciation to review: ${rec.employeeName}`, body: rec.title });
  n.on('click', () => { showWindow(); send('admin:navigate', 'recognition'); });
  n.show();
}

function send(channel, ...args) {
  if (win && !win.isDestroyed()) win.webContents.send(channel, ...args);
}

function updateBadge() {
  const total = newAlertCount + pendingApprovals + pendingRecs;
  if (IS_MAC) app.dock?.setBadge(total ? String(total) : '');
  else app.setBadgeCount?.(total);
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
    ...(pendingApprovals ? [{ label: `${pendingApprovals} software request${pendingApprovals === 1 ? '' : 's'} to approve`, click: () => { showWindow(); send('admin:navigate', 'approvals'); } }] : []),
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
      return { ok: false, error: err.message, code: err.code || null, status: err.status || null, network: Boolean(err.network) };
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
  const signedIn = (user) => { seenAlerts = null; seenApprovals = null; seenRecs = null; poll(); return user; };
  authForm('auth:check', (_e, url) => backend.check(url));
  authForm('auth:login', async (_e, url, login, password) => signedIn(await backend.login(url, login, password)));
  authForm('auth:setup', async (_e, url, form) => signedIn(await backend.setup(url, form)));
  authForm('auth:forgot', (_e, url, login) => backend.forgot(url, login));
  authForm('auth:reset', async (_e, url, login, code, password) => signedIn(await backend.reset(url, login, code, password)));
  handle('auth:logout', async () => { await backend.logout(); seenAlerts = null; newAlertCount = 0; seenApprovals = null; pendingApprovals = 0; updateBadge(); return true; });

  // Data
  handle('dash:get', async () => ({ ...(await backend.get('/api/admin/dashboard')), server: serverInfo() }));
  handle('employees:list', () => backend.get('/api/admin/employees'));
  form('employees:create', async (_e, data) => { const r = await backend.post('/api/admin/employees', data); send('admin:update'); return r; });
  form('employees:update', async (_e, id, data) => { const r = await backend.patch(`/api/admin/employees/${enc(id)}`, data); send('admin:update'); return r; });
  form('employees:delete', async (_e, id, name) => {
    if (!(await confirm(`Remove ${String(name || 'this employee').slice(0, 120)}?`, 'They disappear from the employee list and from the reporting-person list. This cannot be undone.', 'Remove'))) return false;
    await backend.delete(`/api/admin/employees/${enc(id)}`);
    send('admin:update');
    return true;
  });
  handle('assets:list', () => backend.get('/api/admin/assets'));

  // Orbit: tasks, appreciation, team insights
  const orbitPath = (p) => `/api/admin/orbit/${p}`;
  const okId = (v) => typeof v === 'string' && /^[0-9a-f-]{36}$/i.test(v);
  handle('orbit:tasks', (_e, q) => backend.get(orbitPath(`tasks?status=${enc((q && q.status) || '')}&asset=${enc((q && q.asset) || '')}`)));
  form('orbit:task:create', async (_e, data) => { const r = await backend.post(orbitPath('tasks'), data); send('admin:update'); return r; });
  form('orbit:task:update', async (_e, id, data) => { if (!okId(id)) throw new Error('Unknown task'); const r = await backend.patch(orbitPath(`tasks/${enc(id)}`), data); send('admin:update'); return r; });
  form('orbit:task:delete', async (_e, id) => { if (!okId(id)) throw new Error('Unknown task'); const r = await backend.delete(orbitPath(`tasks/${enc(id)}`)); send('admin:update'); return r; });
  handle('orbit:recs', (_e, status) => backend.get(orbitPath(`recognitions?status=${enc(status || '')}`)));
  form('orbit:rec:decide', async (_e, id, body) => {
    if (!okId(id)) throw new Error('Unknown request');
    const r = await backend.post(orbitPath(`recognitions/${enc(id)}/decision`), body);
    poll();
    return r;
  });
  form('orbit:rec:award', async (_e, body) => { const r = await backend.post(orbitPath('recognitions'), body); poll(); return r; });
  form('orbit:rec:cert', (_e, id) => { if (!okId(id)) throw new Error('Unknown certificate'); return backend.get(orbitPath(`recognitions/${enc(id)}/certificate`)); });
  handle('orbit:team', () => backend.get(orbitPath('team')));
  handle('orbit:messages', () => backend.get(orbitPath('messages?open=1')));
  form('orbit:message:resolve', async (_e, id) => { if (!okId(id)) throw new Error('Unknown message'); return backend.post(orbitPath(`messages/${enc(id)}/resolve`), {}); });

  // Timesheets and Employee of the Month
  const okAsset = (v) => typeof v === 'string' && /^[A-Za-z0-9._-]{1,40}$/.test(v);
  const okMonth = (v) => typeof v === 'string' && /^\d{4}-(0[1-9]|1[0-2])$/.test(v);
  handle('ts:get', (_e, assetId, month) => { if (!okAsset(assetId) || !okMonth(month)) throw new Error('Pick an employee and a valid month'); return backend.get(orbitPath(`timesheets/${enc(assetId)}?month=${month}`)); });
  handle('ts:summary', (_e, assetId, period, start) => {
    if (!okAsset(assetId) || !['week', 'month'].includes(period) || !/^\d{4}-\d{2}-\d{2}$/.test(String(start))) throw new Error('Pick an employee, a period and a date');
    return backend.get(orbitPath(`timesheets/${enc(assetId)}/summary?period=${period}&start=${start}`));
  });
  handle('awards:candidates', (_e, month) => { if (!okMonth(month)) throw new Error('Pick a valid month'); return backend.get(orbitPath(`awards/candidates?month=${month}`)); });
  handle('awards:list', () => backend.get(orbitPath('awards')));
  form('awards:citation', (_e, month, assetId) => { if (!okMonth(month) || !okAsset(assetId)) throw new Error('Pick a month and an employee'); return backend.post(orbitPath('awards/citation'), { month, assetId }); });
  form('awards:make', async (_e, body) => {
    if (!okMonth(body?.month) || !okAsset(body?.assetId)) throw new Error('Pick a month and an employee');
    const r = await backend.post(orbitPath('awards'), { month: body.month, assetId: body.assetId, reward: String(body.reward || '').slice(0, 200), credits: Number(body.credits) || 0, citation: String(body.citation || '').slice(0, 600), replace: body.replace === true });
    poll();
    return r;
  });
  form('orbit:chat', (_e, messages) => backend.post(orbitPath('chat'), { messages }));
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

  // Software catalogue and approvals (admin only: the backend refuses these to anyone without a staff token).
  const swPath = (p) => `/api/admin/software/${p}`;
  const isId = (v) => typeof v === 'string' && /^[0-9a-f-]{36}$/i.test(v);
  const isSlug = (v) => typeof v === 'string' && /^[a-z0-9][a-z0-9._-]{1,59}$/.test(v);
  // The catalogue list carries no icons (they can be large and rarely change). Fetch only the ones not seen yet, keyed by entry + last update.
  const softwareIconCache = new Map();
  handle('sw:items', async () => {
    const data = await backend.get(swPath('items'));
    const key = (i) => `${i.slug}@${i.updatedAt}`;
    const need = (data.items || []).filter((i) => i.hasIcon && !softwareIconCache.has(key(i)));
    for (let k = 0; k < need.length; k += 40) {
      const chunk = need.slice(k, k + 40);
      try {
        const r = await backend.get(swPath(`icons?slugs=${enc(chunk.map((i) => i.slug).join(','))}`));
        for (const i of chunk) softwareIconCache.set(key(i), (r.icons || {})[i.slug] || null);
      } catch { break; } // icons are decoration: a failure shows letter tiles and is retried on the next refresh
    }
    for (const i of data.items || []) i.icon = softwareIconCache.get(key(i)) || null;
    return data;
  });
  form('sw:item:create', async (_e, data) => { const r = await backend.post(swPath('items'), data); send('admin:update'); return r; });
  form('sw:item:update', async (_e, slug, data) => {
    if (!isSlug(slug)) throw new Error('Unknown software entry');
    const r = await backend.patch(swPath(`items/${enc(slug)}`), data);
    send('admin:update');
    return r;
  });
  handle('sw:item:delete', async (_e, slug, name) => {
    if (!isSlug(slug)) throw new Error('Unknown software entry');
    if (!(await confirm(`Remove ${name || slug} from the catalogue?`, 'Employees will no longer be able to request it. Past requests and the audit trail are kept.', 'Remove'))) return false;
    try { await backend.delete(swPath(`items/${enc(slug)}`)); } catch (err) { return { __error: err.message }; }
    send('admin:update');
    return true;
  });
  // "Add software" from a link or a popular app: download, identify, verify and measure, so the admin doesn't type technical details.
  let inspecting = null;
  ipcMain.handle('sw:presets', () => presets.listPresets());
  ipcMain.handle('sw:inspect:cancel', () => { inspecting?.abort(); return true; });
  ipcMain.handle('sw:inspect', async (_e, req) => {
    if (!backend.loggedIn) return { ok: false, ...friendly('FAILED'), message: 'Please sign in again.' };
    const preset = req && typeof req.presetId === 'string' ? presets.byId(req.presetId) : null;
    const url = preset ? preset.url : cleanLinkInput(req && req.url);
    if (!url || url.length > 2000) return { ok: false, ...friendly('LINK_NOT_HTTPS') };
    inspecting?.abort(); // one check at a time
    const ctl = new AbortController();
    inspecting = ctl;
    try {
      const d = await inspectLink(url, {
        expectTeamId: preset?.teamId || (req && /^[A-Z0-9]{10}$/.test(req.expectTeamId || '') ? req.expectTeamId : ''), hintName: preset?.name || (req && typeof req.hintName === 'string' ? req.hintName.slice(0, 80) : ''),
        preferPlatform: req && ['darwin', 'win32', 'linux'].includes(req.preferPlatform) ? req.preferPlatform : undefined,
        preferArch: req && ['x64', 'arm64'].includes(req.preferArch) ? req.preferArch : undefined, signal: ctl.signal,
        allowLoopbackHttp: Boolean(process.env.PROGLINTOR_ALLOW_LOOPBACK_HTTP), onStage: (st) => send('admin:inspect', st), renderPage: renderAndCapture,
      });
      if (preset) {
        d.name = preset.name;
        d.publisher = d.publisher || preset.publisher;
        d.description = preset.description;
        d.aliases = [...new Set([...preset.aliases, ...d.aliases])];
      }
      return { ok: true, data: d };
    } catch (err) {
      return { ok: false, ...friendly(err instanceof InspectError ? err.code : 'FAILED'), choices: err instanceof InspectError ? err.choices || null : null };
    } finally {
      if (inspecting === ctl) inspecting = null;
    }
  });
  // New software (not in the catalogue): the admin has checked the file here; this adds it to the catalogue and approves the request in one step.
  form('sw:approve-new', async (_e, id, expectedVersion, item, licenceConfirmed) => {
    if (!isId(id)) throw new Error('Unknown request');
    try {
      const r = await backend.post(swPath(`requests/${enc(id)}/approve-new`), { expectedVersion, item, licenceConfirmed: licenceConfirmed === true });
      poll();
      send('admin:update');
      return r;
    } catch (err) {
      poll();
      throw err;
    }
  });
  handle('sw:approvals', () => backend.get(swPath('approvals')));
  handle('sw:requests', (_e, status) => backend.get(swPath(`requests?status=${enc(status || '')}`)));
  handle('sw:request', (_e, id) => { if (!isId(id)) throw new Error('Unknown request'); return backend.get(swPath(`requests/${enc(id)}`)); });
  form('sw:decide', async (_e, id, decision, expectedVersion, comment) => {
    if (!isId(id)) throw new Error('Unknown request');
    if (decision !== 'APPROVED' && decision !== 'REJECTED') throw new Error('Unknown decision');
    try {
      const r = await backend.post(swPath(`requests/${enc(id)}/decision`), { decision, expectedVersion, comment: String(comment || '').slice(0, 500) });
      poll();
      return r;
    } catch (err) {
      poll();
      throw err;
    }
  });

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
