'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const C = require('../src/shared/renderer/care-logic');
const { CareCoach } = require('../src/agent/care');

function coach(extra = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'care-'));
  const t = { now: new Date(2026, 0, 14, 10, 0).getTime(), status: { state: 'tracking', current: { id: 'com.microsoft.VSCode', name: 'Visual Studio Code' } } };
  const shown = [];
  const cfg = C.sanitizeCare({ water: { every: 30 }, eyes: { on: false }, stretch: { on: false }, rest: { on: false }, meal: { on: false }, wrapup: { on: false }, overwork: { on: false } });
  const c = new CareCoach({ dir, status: () => t.status, getConfig: () => extra.cfg || cfg, onNudge: (n) => shown.push(n), now: () => t.now, name: () => 'Asha Rao', ...extra });
  const advance = async (minutes) => { for (let i = 0; i < minutes * 4; i++) { t.now += 15000; await c.tick(); } };
  return { c, t, shown, advance, dir };
}

test('while working, a water reminder appears after the chosen time, with friendly words and a way to answer', async () => {
  const { c, shown, advance } = coach();
  await c.tick();
  await advance(29);
  assert.equal(shown.length, 0);
  await advance(2);
  assert.equal(shown.length, 1);
  assert.equal(shown[0].kind, 'water');
  assert.match(shown[0].body, /Asha/);
  assert.deepEqual(shown[0].actions, ['done', 'snooze', 'skip']);
  c.act('water', 'done');
  assert.equal(c.snapshot().counts.water, 1);
});

test('no reminders while idle, locked, or in a meeting', async () => {
  const idle = coach();
  idle.t.status = { state: 'idle' };
  await idle.advance(90);
  assert.equal(idle.shown.length, 0);
  const meet = coach();
  meet.t.status = { state: 'tracking', current: { id: 'us.zoom.xos', name: 'zoom.us' } };
  await meet.advance(90);
  assert.equal(meet.shown.length, 0, 'never interrupts a call');
});

test('a laptop that slept does not count the sleeping time as work', async () => {
  const { c, t, shown } = coach();
  await c.tick();
  t.now += 3 * 3600 * 1000; // closed the lid for three hours
  await c.tick();
  assert.equal(shown.length, 0);
  assert.ok(c.snapshot().activeMs < 60000);
});

test('the end-of-day reminder carries the server\'s summary, and falls back to kind words if the server is down', async () => {
  const cfg = C.sanitizeCare({ water: { on: false }, eyes: { on: false }, stretch: { on: false }, rest: { on: false }, meal: { on: false }, overwork: { on: false }, wrapup: { at: '10:05' } });
  const a = coach({ cfg, wrapup: async () => ({ message: 'You shipped the report today.' }) });
  await a.advance(10);
  assert.equal(a.shown[0].kind, 'wrapup');
  assert.match(a.shown[0].body, /shipped the report/);
  const b = coach({ cfg, wrapup: async () => { throw new Error('offline'); } });
  await b.advance(10);
  assert.match(b.shown[0].body, /Nice work today/);
});

test('pause, resume, focus and "I drank water" work from the app', async () => {
  const { c, shown, advance } = coach();
  c.pauseFor(60);
  await advance(45);
  assert.equal(shown.length, 0);
  assert.ok(c.snapshot().pausedUntil > 0);
  c.resume();
  assert.equal(c.snapshot().pausedUntil, 0);
  c.logWater();
  assert.equal(c.snapshot().counts.water, 1);
  c.focus(25);
  assert.ok(c.snapshot().focus);
  c.focus(0);
  assert.equal(c.snapshot().focus, null);
});

test('counts survive a restart on the same day', async () => {
  const { c, dir, t } = coach();
  c.logWater(); c.logWater();
  c.stop();
  const again = new CareCoach({ dir, status: () => ({ state: 'tracking' }), getConfig: () => C.DEFAULTS, onNudge() {}, now: () => t.now });
  assert.equal(again.snapshot().counts.water, 2);
  const tomorrow = new CareCoach({ dir, status: () => ({ state: 'tracking' }), getConfig: () => C.DEFAULTS, onNudge() {}, now: () => t.now + 24 * 3600 * 1000 });
  assert.equal(tomorrow.snapshot().counts.water, 0);
});

test('bad answers are ignored', () => {
  const { c } = coach();
  c.act('water', 'explode');
  c.act(42, 'done');
  assert.equal(c.snapshot().counts.water, 0);
});
