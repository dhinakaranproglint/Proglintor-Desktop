'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { Sync, normalizeServer, networkHint } = require('../src/agent/sync');
const { UsageStore, dayKey } = require('../src/agent/store');
const { Backend, normalizeUrl } = require('../src/admin/backend');
const { isDevTool, isWeekend, normalizePolicy, DEFAULT_POLICY } = require('../src/shared/policy');

const tmp = (p) => fs.mkdtempSync(path.join(os.tmpdir(), p));

test('policy: dev tool matching and weekend days', () => {
  const tools = DEFAULT_POLICY.devTools;
  assert.ok(isDevTool({ id: 'com.microsoft.VSCode', name: 'Code' }, tools));
  assert.ok(isDevTool({ id: 'code.exe', name: 'Visual Studio Code' }, tools));
  assert.ok(isDevTool({ id: 'com.jetbrains.intellij', name: 'IntelliJ IDEA Ultimate' }, tools));
  assert.ok(isDevTool({ id: 'gnome-terminal-server', name: 'Terminal' }, tools));
  assert.ok(!isDevTool({ id: 'com.google.Chrome', name: 'Google Chrome' }, tools));
  assert.ok(!isDevTool({ id: 'com.apple.Notes', name: 'Notes' }, tools), 'short patterns must not match by substring');
  assert.ok(isWeekend(new Date(2026, 10, 21).getTime(), [0, 6])); // Saturday
  assert.ok(!isWeekend(new Date(2026, 10, 20).getTime(), [0, 6])); // Friday
  const p = normalizePolicy({ weekendDays: [6, 6, 9], devTools: 'bad', message: '  ' });
  assert.deepEqual(p.weekendDays, [6]);
  assert.equal(p.devTools, DEFAULT_POLICY.devTools);
  assert.equal(p.message, DEFAULT_POLICY.message);
});

test('server address: scheme default port, and own IP is reached over loopback', () => {
  const own = new Set(['10.143.194.13']);
  assert.equal(normalizeServer('192.168.1.20:8000', own), 'http://192.168.1.20:8000');
  assert.equal(normalizeServer('https://pulse.proglint.com/', own), 'https://pulse.proglint.com');
  assert.equal(normalizeServer('10.143.194.13:8000', own), 'http://127.0.0.1:8000', 'this computer -> 127.0.0.1');
  assert.equal(normalizeServer('localhost:8000', own), 'http://127.0.0.1:8000');
  assert.throws(() => normalizeServer('', own), /server address/);
  assert.equal(normalizeUrl('127.0.0.1:8000/'), 'http://127.0.0.1:8000');
});

test('network errors become actionable messages', () => {
  const e = (code) => Object.assign(new Error('fetch failed'), { cause: { code } });
  assert.match(networkHint(e('UND_ERR_SOCKET')), /Security software or a firewall/);
  assert.match(networkHint(e('ECONNREFUSED')), /Nothing is answering/);
  assert.match(networkHint(e('ENOTFOUND')), /could not be found/);
  for (const code of ['UND_ERR_SOCKET', 'ECONNREFUSED', 'ENOTFOUND', 'ETIMEDOUT']) {
    assert.doesNotMatch(networkHint(e(code)), /https?:\/\/|\d+\.\d+\.\d+\.\d+|:\d{4}/, 'error messages never reveal the server address');
  }
});

test('agent queues answers while the server is unreachable', async () => {
  const store = new UsageStore(tmp('pp-agent-'));
  const dir = tmp('pp-org-');
  fs.writeFileSync(path.join(dir, 'organization.json'), JSON.stringify({ server: 'http://127.0.0.1:59999', token: 'x', asset: { assetId: 'A' }, pendingAlerts: [] }));
  const sync = new Sync({ dir, store, liveStatus: () => ({}), runningApps: async () => [], installedApps: async () => [], device: () => ({}) });
  sync.queueAlert({ appName: 'Code', reason: 'Other', details: 'x' });
  await new Promise((r) => setTimeout(r, 300));
  assert.equal(sync.status().pendingAlerts, 1, 'kept for later');
  assert.match(sync.status().lastError, /Nothing is answering/);
  assert.equal(JSON.parse(fs.readFileSync(path.join(dir, 'organization.json'), 'utf8')).pendingAlerts.length, 1, 'persisted to disk');
});

// End-to-end against a running Django backend:
//   PULSE_E2E_URL=http://127.0.0.1:8000 PULSE_E2E_USER=admin PULSE_E2E_PASS=... npm test
const E2E = process.env.PULSE_E2E_URL;
test('end to end with the Django backend: admin creates asset, agent enrolls and reports', { skip: !E2E && 'set PULSE_E2E_URL to run' }, async () => {
  const admin = new Backend(path.join(tmp('pp-admin-'), 'backend.json'));
  await admin.login(E2E, process.env.PULSE_E2E_USER, process.env.PULSE_E2E_PASS);
  const assetId = `E2E-${Date.now().toString(36).toUpperCase()}`;
  const asset = await admin.post('/api/admin/assets', { assetId, employeeName: 'Test Employee', employeeEmail: 'test.employee@proglint.com', department: 'QA' });
  try {
    const store = new UsageStore(tmp('pp-agent-'));
    const now = Date.now();
    store.recordForeground({ id: 'com.microsoft.VSCode', name: 'Code' }, now - 600000, now - 60000);
    const sync = new Sync({
      dir: tmp('pp-org-'),
      store,
      liveStatus: () => ({ state: 'tracking', current: { id: 'com.microsoft.VSCode', name: 'Code' }, sessionStart: now - 60000, today: 540 }),
      runningApps: async () => [{ id: 'com.microsoft.VSCode', name: 'Code' }, { id: 'com.apple.Safari', name: 'Safari' }],
      installedApps: async () => [{ id: 'com.microsoft.VSCode', name: 'Visual Studio Code', version: '1.140.0', lastUsed: now }],
      device: () => ({ hostname: 'e2e-host', os: 'macOS', platform: 'darwin', agentVersion: '1.0.0' }),
      defaultServer: E2E, // the agent knows the server from its configuration; the employee only types the code
    });
    await assert.rejects(sync.enroll('WRNG-CODE'), /not found/);
    const st = await sync.enroll(asset.enrollCode);
    sync.stop();
    assert.equal(st.assetId, assetId);
    assert.ok(st.online);

    sync.queueAlert({ day: dayKey(now), appId: 'com.microsoft.VSCode', appName: 'Code', reason: 'Project deadline', details: 'Release prep' });
    await new Promise((r) => setTimeout(r, 500));
    assert.equal(sync.status().pendingAlerts, 0);

    const d = await admin.get(`/api/admin/assets/${assetId}`);
    assert.equal(d.asset.online, true);
    assert.equal(d.asset.current.name, 'Code');
    assert.equal(d.asset.hostname, 'e2e-host');
    assert.deepEqual(d.asset.runningApps.map((r) => r.name), ['Code', 'Safari']);
    assert.equal(Math.round(d.todayApps[0].seconds), 540);
    assert.equal(d.installed.apps[0].version, '1.140.0');
    assert.equal(d.alerts[0].reason, 'Project deadline');

    await admin.post(`/api/admin/assets/${assetId}/reset-code`);
    await assert.rejects(sync.heartbeat());
    assert.equal(sync.status().revoked, true, 'agent learns it was disconnected');
  } finally {
    await admin.delete(`/api/admin/assets/${assetId}`);
  }
});

test('agent uploads only the icons the backend is missing, once', async () => {
  const http = require('node:http');
  const stored = new Set(['com.apple.Safari']); // already uploaded by another laptop
  const uploads = [];
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (c) => { body += c; });
    req.on('end', () => {
      const data = body ? JSON.parse(body) : {};
      res.setHeader('content-type', 'application/json');
      if (req.url === '/api/agent/icons/missing') return res.end(JSON.stringify({ missing: data.ids.filter((id) => !stored.has(id)) }));
      if (req.url === '/api/agent/icons') { for (const i of data.icons) { stored.add(i.id); uploads.push(i.id); } return res.end('{"ok":true,"saved":1}'); }
      res.statusCode = 404; return res.end('{}');
    });
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const port = server.address().port;
  try {
    const store = new UsageStore(tmp('pp-agent-'));
    store.recordForeground({ id: 'com.microsoft.VSCode', name: 'Code', path: '/Applications/Visual Studio Code.app' }, Date.now() - 120000, Date.now() - 60000);
    const dir = tmp('pp-org-');
    fs.writeFileSync(path.join(dir, 'organization.json'), JSON.stringify({ server: `http://127.0.0.1:${port}`, token: 't', asset: { assetId: 'A' }, pendingAlerts: [] }));
    const asked = [];
    const sync = new Sync({
      dir, store, liveStatus: () => ({}), device: () => ({}),
      runningApps: async () => [{ id: 'com.apple.Safari', name: 'Safari' }, { id: 'com.apple.Notes', name: 'Notes' }],
      installedApps: async () => [{ id: 'com.google.Chrome', name: 'Chrome', path: '/Applications/Google Chrome.app' }],
      iconFor: async (id) => { asked.push(id); return id === 'com.apple.Notes' ? null : `data:image/png;base64,AAAA-${id}`; },
    });
    await sync.pushIcons();
    assert.deepEqual(uploads.sort(), ['com.google.Chrome', 'com.microsoft.VSCode']);
    assert.ok(!asked.includes('com.apple.Safari'), 'icons the backend has are never read or sent again');
    asked.length = 0;
    await sync.pushIcons();
    assert.deepEqual(asked, [], 'second pass: nothing missing, and the unreadable one is not retried');
  } finally {
    server.close();
  }
});

test('sign-out is instant even if the server never answers', async () => {
  const net = require('node:net');
  const hang = net.createServer(() => { /* accepts the connection and never replies */ });
  await new Promise((r) => hang.listen(0, '127.0.0.1', r));
  try {
    const file = path.join(tmp('pp-admin-'), 'backend.json');
    fs.writeFileSync(file, JSON.stringify({ url: `http://127.0.0.1:${hang.address().port}`, token: 'abc', user: { username: 'x' }, lastLogin: 'x@proglint.com' }));
    const b = new Backend(file);
    assert.ok(b.loggedIn);
    const t0 = Date.now();
    await b.logout();
    assert.ok(Date.now() - t0 < 500, 'returns immediately');
    assert.equal(b.loggedIn, false);
    assert.equal(JSON.parse(fs.readFileSync(file, 'utf8')).token, undefined, 'token removed from disk');
    assert.equal(b.lastLogin, 'x@proglint.com', 'e-mail is remembered for the next sign-in');
  } finally {
    hang.close();
    hang.closeAllConnections?.();
  }
});


test('the agent learns its server from configuration, not from the employee', () => {
  const brand = require('../src/shared/branding');
  const keep = process.env.PROGLINTOR_SERVER;
  try {
    delete process.env.PROGLINTOR_SERVER;
    assert.match(brand.serverUrl(), /^https?:\/\//, 'default comes from src/shared/server.json');
    process.env.PROGLINTOR_SERVER = 'https://pulse.example.com';
    assert.equal(brand.serverUrl(), 'https://pulse.example.com', 'environment variable overrides it');
  } finally {
    if (keep === undefined) delete process.env.PROGLINTOR_SERVER; else process.env.PROGLINTOR_SERVER = keep;
  }
});

// ---- removal / deprovisioning edge cases (fake server) ----------------------------------------------
async function fakeServer(handler) {
  const http = require('node:http');
  const hits = [];
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (c) => { body += c; });
    req.on('end', () => {
      const data = body ? JSON.parse(body) : {};
      hits.push({ url: req.url, data });
      const [status, out] = handler(req.url, data, hits.length) || [200, { ok: true }];
      res.writeHead(status, { 'content-type': 'application/json' });
      res.end(JSON.stringify(out));
    });
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  return { url: `http://127.0.0.1:${server.address().port}`, hits, close: () => server.close() };
}

function enrolledSync(url, extra = {}) {
  const dir = tmp('pp-org-');
  fs.writeFileSync(path.join(dir, 'organization.json'), JSON.stringify({
    server: url, token: 'tok', asset: { assetId: 'PG-001', employeeName: 'Kishore', employeeEmail: 'k@proglint.com', department: 'Mobile' },
    pendingAlerts: [{ uid: 'a1', appName: 'Code' }], weekendPrompts: { '2026-11-21': { answered: true } }, fullSyncDone: true, installedHash: 'h', ...extra,
  }));
  const removed = [];
  const sync = new Sync({ dir, store: new UsageStore(tmp('pp-agent-')), liveStatus: () => ({ state: 'tracking' }), runningApps: async () => [], installedApps: async () => [], device: () => ({}), onRemoved: (st) => removed.push(st) });
  return { sync, dir, removed };
}

test('agent disconnects only when the server explicitly says the asset was removed', async () => {
  let mode = 'proxy';
  const srv = await fakeServer(() => (mode === 'proxy' ? [401, { error: 'Login required' }] : mode === 'removed' ? [401, { error: 'This device was removed from Proglintor', code: 'device_removed' }] : [200, { policy: {}, asset: {} }]));
  try {
    const { sync, dir, removed } = enrolledSync(srv.url);
    await assert.rejects(sync.heartbeat());
    assert.equal(sync.enrolled, true, 'a plain 401 (proxy, captive portal…) must not disconnect the laptop');
    assert.equal(removed.length, 0);
    assert.equal(sync.status().pendingAlerts, 1, 'queued answers are kept');

    mode = 'removed';
    await assert.rejects(sync.heartbeat());
    const st = sync.status();
    assert.equal(st.enrolled, false);
    assert.equal(st.removed.assetId, 'PG-001');
    assert.equal(st.removed.employeeName, 'Kishore', 'who it was assigned to is kept for the friendly message');
    assert.equal(st.pendingAlerts, 0, 'answers for the removed asset are discarded');
    assert.equal(removed.length, 1, 'the UI/notification callback fires once');
    const saved = JSON.parse(fs.readFileSync(path.join(dir, 'organization.json'), 'utf8'));
    assert.equal(saved.token, null, 'credentials are wiped from disk');
    assert.deepEqual(saved.weekendPrompts, {});
    assert.equal(saved.fullSyncDone, false);

    const before = srv.hits.length;
    await sync.heartbeat();
    await sync.pushUsage();
    assert.equal(srv.hits.length, before, 'nothing more is sent once removed');
    assert.equal(sync.timers.length, 0, 'background sync stopped');
    assert.equal(removed.length, 1, 'and no second notification');
  } finally { srv.close(); }
});

test('re-connecting to a different asset does not upload the previous owner\'s history', async () => {
  const uploads = [];
  const asset = (id) => ({ assetId: id, employeeName: 'New Person', employeeEmail: 'n@proglint.com' });
  let next = 'PG-002';
  const srv = await fakeServer((url, data) => {
    if (url === '/api/agent/enroll') return [200, { token: 'new', asset: asset(next), policy: {} }];
    if (url === '/api/agent/usage') { uploads.push(Object.keys(data.days).sort()); return [200, { ok: true }]; }
    if (url === '/api/agent/heartbeat') return [200, { policy: {}, asset: asset(next) }];
    return [200, { ok: true }];
  });
  try {
    for (const [label, nextAsset, expectOldHistory] of [['different asset', 'PG-002', false], ['same asset (new code)', 'PG-001', true]]) {
      next = nextAsset;
      uploads.length = 0;
      const { sync } = enrolledSync(srv.url);
      const now = Date.now();
      sync.store.recordForeground({ id: 'a', name: 'A' }, now - 5 * 86400000, now - 5 * 86400000 + 60000); // five days ago
      sync.store.recordForeground({ id: 'a', name: 'A' }, now - 60000, now);
      sync._markRemoved();
      sync.defaultServer = srv.url;
      await sync.enroll('ABCD-2345');
      sync.stop();
      const days = uploads.flat();
      assert.ok(days.includes(dayKey(now)), `${label}: today is uploaded`);
      assert.equal(days.includes(dayKey(now - 5 * 86400000)), expectOldHistory, `${label}: older history ${expectOldHistory ? 'is' : 'is not'} uploaded`);
      assert.equal(sync.status().removed, null, 'removed state is cleared after reconnecting');
    }
  } finally { srv.close(); }
});
