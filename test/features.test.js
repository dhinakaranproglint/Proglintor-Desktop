'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { UsageStore, dayKey, mergeIntervals, subtractIntervals } = require('../src/agent/store');
const mac = require('../src/agent/platform/mac')._test;

const tmpStore = () => new UsageStore(fs.mkdtempSync(path.join(os.tmpdir(), 'mm-feat-')));
const T = (h, m = 0, s = 0) => new Date(2026, 10, 20, h, m, s).getTime();
const secs = (store, id, ts) => Math.round(store.db.days[dayKey(ts)]?.[id]?.seconds || 0);

test('interval helpers', () => {
  assert.deepEqual(mergeIntervals([[5, 8], [1, 3], [2, 4], [8, 9]]), [[1, 4], [5, 9]]);
  assert.deepEqual(subtractIntervals([0, 10], [[2, 4], [6, 7]]), [[0, 2], [4, 6], [7, 10]]);
  assert.deepEqual(subtractIntervals([3, 5], [[0, 10]]), []);
});

test('import from another tracker adds only uncovered time and is idempotent', () => {
  const s = tmpStore();
  // Already tracked here: Code 10:00-10:10
  s.recordForeground({ id: 'code', name: 'Code' }, T(10), T(10, 10));
  const entries = [
    { id: 'code', name: 'Code', activations: 3, sessions: [[T(9, 50), T(10, 5)]] }, // overlaps 5 min
    { id: 'notes', name: 'Notes', activations: 2, sessions: [[T(10, 5), T(10, 20)]] }, // overlaps 5 min
  ];
  const r1 = s.importExternal(entries);
  assert.equal(Math.round(r1.seconds), 10 * 60 + 10 * 60);
  assert.equal(secs(s, 'code', T(10)), 20 * 60);
  assert.equal(secs(s, 'notes', T(10)), 10 * 60);
  assert.equal(s.db.days[dayKey(T(10))].notes.activations, 2, 'activations kept for new app-days');
  assert.ok(s.db.trackingStarted <= T(9, 50));
  const r2 = s.importExternal(entries);
  assert.equal(Math.round(r2.seconds), 0, 'second import adds nothing');
  assert.equal(secs(s, 'code', T(10)), 20 * 60);
});

test('hourly buckets split sessions across hours and group other apps', () => {
  const s = tmpStore();
  s.recordForeground({ id: 'a', name: 'A' }, T(9, 30), T(10, 15));
  s.recordForeground({ id: 'b', name: 'B' }, T(10, 15), T(10, 25));
  const h = s.hourly(T(9), ['a']);
  assert.equal(h.length, 24);
  assert.equal(Math.round(h[9].parts.a), 30 * 60);
  assert.equal(Math.round(h[10].parts.a), 15 * 60);
  assert.equal(Math.round(h[10].parts.other), 10 * 60);
  assert.equal(Math.round(h[10].total), 25 * 60);
});

test('range view: previous-period total and navigation anchor', () => {
  const s = tmpStore();
  s.recordForeground({ id: 'a', name: 'A' }, T(10), T(11));
  s.recordForeground({ id: 'a', name: 'A' }, new Date(2026, 10, 19, 10).getTime(), new Date(2026, 10, 19, 10, 30).getTime());
  const v = s.rangeView('day', T(12));
  assert.equal(Math.round(v.total), 3600);
  assert.equal(Math.round(v.prevTotal), 1800);
  assert.equal(v.hourly[10].total, 3600);
  assert.equal(v.isCurrent, false);
  const w = s.rangeView('week', T(12));
  assert.equal(w.daily.length, 7);
  assert.equal(new Date(w.busiest.date).getDate(), 20);
});

test('macOS: parses lsappinfo frontmost events', () => {
  const line = 'Notification: kLSNotifyBecameFrontmost time=+0.25s  dataRef={ "ApplicationType"="Foreground", , "CFBundleIdentifier"="com.apple.Notes", , "LSASN"=ASN:0x0-0x36036:, } affectedASN="Notes" ASN:0x0-0x36036:  context=0x0';
  assert.deepEqual(mac.parseFrontmostEvent(line), { id: 'com.apple.Notes', name: 'Notes', asn: 'ASN:0x0-0x36036:' });
  assert.equal(mac.parseFrontmostEvent('Notification: kLSNotifyLaunch ...'), null);
});

test('mergeApps folds aliases into one app without doubling time', () => {
  const s = tmpStore();
  s.recordForeground({ id: 'com.github.Electron', name: 'Electron' }, T(9), T(9, 10));
  s.recordForeground({ id: 'machine-monitor', name: 'Machine Monitor' }, T(9, 10), T(9, 20));
  s.recordForeground({ id: 'code', name: 'Code' }, T(9, 20), T(9, 30));
  s.mergeApps(['com.github.Electron'], { id: 'machine-monitor', name: 'Machine Monitor' });
  const day = s.db.days[dayKey(T(9))];
  assert.equal(day['com.github.Electron'], undefined);
  assert.equal(Math.round(day['machine-monitor'].seconds), 20 * 60);
  assert.equal(day['machine-monitor'].sessions.length, 1, 'contiguous sessions merged');
  assert.equal(Math.round(day.code.seconds), 600);
});
