'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { UsageStore, dayKey } = require('../src/agent/store');
const { Tracker } = require('../src/agent/tracker');

const tmpStore = () => new UsageStore(fs.mkdtempSync(path.join(os.tmpdir(), 'mm-test-')));
const A = { id: 'app.a', name: 'App A', path: '/a' };
const B = { id: 'app.b', name: 'App B', path: '/b' };

test('store: splits sessions at midnight and merges contiguous ones', () => {
  const s = tmpStore();
  const midnight = new Date(2026, 10, 21).getTime();
  s.recordForeground(A, midnight - 60000, midnight + 30000);
  assert.equal(s.db.days[dayKey(midnight - 1)][A.id].seconds, 60);
  assert.equal(s.db.days[dayKey(midnight)][A.id].seconds, 30);

  s.recordForeground(A, midnight + 30000, midnight + 40000); // continues previous session
  assert.equal(s.db.days[dayKey(midnight)][A.id].sessions.length, 1);
  s.recordForeground(A, midnight + 100000, midnight + 110000); // gap -> new session
  assert.equal(s.db.days[dayKey(midnight)][A.id].sessions.length, 2);
});

test('store: summaries, daily totals, CSV, and persistence', () => {
  const s = tmpStore();
  const now = Date.now();
  s.recordForeground(A, now - 120000, now - 60000);
  s.recordForeground(B, now - 60000, now);
  s.recordActivation(A, now - 120000);
  const view = s.rangeView('today');
  assert.deepEqual(view.summaries.map((x) => [x.id, Math.round(x.seconds)]), [['app.a', 60], ['app.b', 60]].sort((x, y) => (x[0] < y[0] ? -1 : 1)));
  assert.equal(view.timeline.length, 2);
  assert.equal(s.rangeView('week').daily.length, 7);
  assert.match(s.toCSV(), /"app.a","App A","\/a",60,1,1/);
  s.save();
  const reloaded = new UsageStore(path.dirname(s.file));
  assert.equal(reloaded.summaries(...reloaded.interval('today')).length, 2);
});

test('store: corrupt file is moved aside, not overwritten', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mm-test-'));
  fs.writeFileSync(path.join(dir, 'usage.json'), '{not json');
  const s = new UsageStore(dir);
  assert.deepEqual(s.db.days, {});
  assert.ok(fs.readdirSync(dir).some((f) => f.startsWith('usage.corrupt-')));
});

function harness() {
  let now = new Date(2026, 10, 21, 10, 0, 0).getTime();
  const realNow = Date.now;
  Date.now = () => now;
  const env = { active: A, idle: 0, locked: false };
  const store = tmpStore();
  const tracker = new Tracker({
    store,
    platform: { createWatcher: () => ({ getActive: async () => env.active, status: () => ({ ok: true, message: 'fake' }), stop() {} }) },
    power: { idleSeconds: () => env.idle, isLocked: () => env.locked },
    resolve: (raw) => raw,
    idleThreshold: 300,
  });
  tracker.watcher = tracker.platform.createWatcher();
  const advance = async (sec) => { now += sec * 1000; await tracker.tick(); };
  const secs = (app) => Math.round(store.db.days[dayKey(now)]?.[app.id]?.seconds || 0);
  return { env, store, tracker, advance, secs, restore: () => { Date.now = realNow; } };
}

test('tracker: counts foreground time and switches', async () => {
  const h = harness();
  try {
    await h.tracker.tick();
    await h.advance(10);
    await h.advance(10);
    assert.equal(h.secs(A), 20);
    h.env.active = B;
    await h.advance(5);           // switch detected; the 5s go to A (it was in front until now)
    await h.advance(30);
    assert.equal(h.secs(A), 25);
    assert.equal(h.secs(B), 30);
    assert.equal(h.store.db.days[dayKey(Date.now())][B.id].activations, 1);
  } finally { h.restore(); }
});

test('tracker: stops counting at last input when idle, and while locked or paused', async () => {
  const h = harness();
  try {
    await h.tracker.tick();
    await h.advance(60);
    h.env.idle = 400;               // user left 400s ago
    await h.advance(400);           // total elapsed 460s, but only 60s had input
    assert.equal(h.tracker.state, 'idle');
    assert.equal(h.secs(A), 60);
    h.env.idle = 0;
    await h.advance(2);             // back
    await h.advance(10);
    assert.equal(h.secs(A), 70);

    h.env.locked = true;
    await h.advance(100);
    assert.equal(h.tracker.state, 'locked');
    h.env.locked = false;
    await h.advance(2);
    await h.advance(10);
    assert.equal(h.secs(A), 80, 'locked time not counted');

    h.tracker.pause('user');
    await h.advance(100);
    h.tracker.resume('user');
    await h.advance(2);
    await h.advance(10);
    assert.equal(h.secs(A), 90, 'paused time not counted');
  } finally { h.restore(); }
});

test('store: saving survives a deleted data folder (recreates it, never throws)', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mm-test-'));
  const s = new UsageStore(dir);
  s.recordForeground(A, Date.now() - 60000, Date.now());
  fs.rmSync(dir, { recursive: true, force: true });
  assert.doesNotThrow(() => s.save());
  assert.ok(fs.existsSync(path.join(dir, 'usage.json')), 'folder and file are recreated');
  assert.equal(s.dirty, false);
});
