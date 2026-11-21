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
  assert.match(networkHint(e('UND_ERR_SOCKET'), 'http://10.0.0.5:8000'), /Security software or a firewall/);
  assert.match(networkHint(e('ECONNREFUSED'), 'http://10.0.0.5:8000'), /Nothing is answering/);
  assert.match(networkHint(e('ENOTFOUND'), 'http://pulse'), /could not be found/);
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
    });
    await assert.rejects(sync.enroll(E2E, 'WRNG-CODE'), /not found/);
    const st = await sync.enroll(E2E, asset.enrollCode);
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
