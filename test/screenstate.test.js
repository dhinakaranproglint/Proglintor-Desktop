'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const C = require('../src/shared/renderer/care-logic');
const { CareCoach } = require('../src/agent/care');
const { coveringApp, makeFullscreenProbe } = require('../src/agent/screenstate');
const fs = require('fs');
const os = require('os');
const path = require('path');

const display = { x: 0, y: 0, width: 1680, height: 1050 };
const win = (o, X, Y, Width, Height, l = 0) => ({ o, l, b: { X, Y, Width, Height } });

test('only a window covering the whole display counts as full screen (a maximised window keeps the menu bar)', () => {
  assert.equal(coveringApp([win('Keynote', 0, 0, 1680, 1050)], display), 'Keynote');
  assert.equal(coveringApp([win('Microsoft Teams', 0, 25, 1680, 936)], display), '', 'maximised, menu bar still visible');
  assert.equal(coveringApp([win('Google Chrome', 2, 135, 1200, 600)], display), '');
  assert.equal(coveringApp([win('Keynote', 0, 0, 1680, 1050, 25)], display), '', 'only normal windows, not overlays');
  assert.equal(coveringApp([win('Proglintor', 0, 0, 1680, 1050), win('Finder', 0, 0, 1680, 1050), win('Window Server', 0, 0, 1680, 1050)], display), '', 'our own windows and the system never count');
  assert.equal(coveringApp(null, display), '');
  assert.equal(coveringApp([win('VLC', 1, 1, 1679, 1049)], display), 'VLC', 'a pixel or two of tolerance');
});

test('the probe is cheap (cached), fails open, and does nothing off macOS', async () => {
  let runs = 0; let t = 1000;
  const probe = makeFullscreenProbe(() => display, { platform: 'darwin', now: () => t, run: async () => { runs++; return JSON.stringify([win('VLC', 0, 0, 1680, 1050)]); } });
  assert.equal(await probe(), 'VLC');
  assert.equal(await probe(), 'VLC');
  assert.equal(runs, 1, 'asked once within five seconds');
  t += 6000;
  await probe();
  assert.equal(runs, 2);
  const broken = makeFullscreenProbe(() => display, { platform: 'darwin', run: async () => { throw new Error('no osascript'); } });
  assert.equal(await broken(), '', 'if we cannot tell, we do not block');
  const garbage = makeFullscreenProbe(() => display, { platform: 'darwin', run: async () => 'not json' });
  assert.equal(await garbage(), '');
  let called = false;
  assert.equal(await makeFullscreenProbe(() => display, { platform: 'win32', run: async () => { called = true; return '[]'; } })(), '');
  assert.equal(called, false);
});

function coach(fullscreen) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'care-fs-'));
  const t = { now: new Date(2026, 0, 14, 10, 0).getTime(), full: fullscreen, current: { id: 'com.microsoft.VSCode', name: 'Visual Studio Code' } };
  const shown = [];
  const cfg = C.sanitizeCare({ water: { every: 10 }, eyes: { on: false }, stretch: { on: false }, rest: { on: false }, meal: { on: false }, wrapup: { on: false }, overwork: { on: false } });
  const c = new CareCoach({ dir, status: () => ({ state: 'tracking', current: t.current }), getConfig: () => cfg, onNudge: (n) => shown.push(n), now: () => t.now, fullscreenApp: async () => (t.full ? 'Keynote' : '') });
  const run = async (m) => { for (let i = 0; i < m * 4; i++) { t.now += 15000; await c.tick(); } };
  return { c, t, shown, run };
}

test('a reminder that comes due during a full-screen presentation is held, not lost, and appears once the person is free', async () => {
  const { c, t, shown, run } = coach(true);
  await run(30);
  assert.equal(shown.length, 0, 'nothing was said over the presentation');
  assert.equal(c.heldBy, 'Keynote');
  t.full = false;
  await run(1);
  assert.equal(shown.length, 1, 'said as soon as the screen is free');
  assert.equal(shown[0].kind, 'water');
});

test('it stays quiet in the apps the person lists, and can be told to ignore full screen', async () => {
  const a = coach(false);
  a.t.current = { id: 'com.apple.iWork.Keynote', name: 'Keynote' };
  await a.run(30);
  assert.equal(a.shown.length, 0, 'Keynote is on the default quiet list');
  const b = coach(false);
  b.t.current = { id: 'com.example.game', name: 'My Game' };
  await b.run(15);
  assert.equal(b.shown.length, 1, 'an unlisted app is fine');
  assert.equal(C.inQuietApp('Visual Studio Code', ['vlc', 'keynote']), false);
  assert.equal(C.inQuietApp('VLC media player', ['vlc']), true);
  const cfg = C.sanitizeCare({ quietApps: ['  Figma ', 'Zoom', '', '<script>', 'x'.repeat(80)], respectFullscreen: false });
  assert.deepEqual(cfg.quietApps.slice(0, 3), ['figma', 'zoom', 'script']);
  assert.ok(cfg.quietApps.every((x) => x.length <= 30));
  assert.equal(cfg.respectFullscreen, false);
  assert.equal(C.sanitizeCare({}).respectFullscreen, true, 'on by default');
});

test('the companion hides itself for presenting mode, a detected share, or a call app in front, and the person can opt out', () => {
  const base = { hideInCalls: true, pauseInMeetings: true, quietApps: ['zoom', 'keynote'], current: 'com.microsoft.VSCode Visual Studio Code' };
  assert.equal(C.shouldHideCompanion(base), false, 'normal work: visible');
  assert.equal(C.shouldHideCompanion({ ...base, presenting: true }), true, 'presenting mode always hides');
  assert.equal(C.shouldHideCompanion({ ...base, sharing: true }), true, 'a detected share always hides');
  assert.equal(C.shouldHideCompanion({ ...base, current: 'us.zoom.xos zoom.us' }), true);
  assert.equal(C.shouldHideCompanion({ ...base, current: 'com.apple.iWork.Keynote Keynote' }), true);
  assert.equal(C.shouldHideCompanion({ ...base, current: 'com.microsoft.teams2 Microsoft Teams' }), true, 'the built-in call-app list applies too');
  assert.equal(C.shouldHideCompanion({ ...base, current: 'us.zoom.xos zoom.us', hideInCalls: false }), false, 'opted out of auto-hide');
  assert.equal(C.shouldHideCompanion({ ...base, current: 'us.zoom.xos zoom.us', pauseInMeetings: false }), false);
  assert.equal(C.shouldHideCompanion({ ...base, current: 'us.zoom.xos zoom.us', hideInCalls: false, presenting: true }), true, 'presenting mode overrides opting out');
  assert.equal(C.shouldHideCompanion(), false);
});

test('presenting mode holds reminders (nothing is lost) and releases them when switched off', async () => {
  const { c, t, shown, run } = coach(false);
  let presenting = true;
  c.hold = () => presenting;
  await run(30);
  assert.equal(shown.length, 0, 'nothing appeared while presenting');
  assert.equal(c.heldBy, 'presenting');
  presenting = false;
  await run(1);
  assert.equal(shown.length, 1, 'the water reminder arrives as soon as presenting ends');
});

test('privacy settings default to on and are validated', () => {
  const L = require('../src/shared/renderer/orbit-logic');
  assert.deepEqual([L.DEFAULTS.hideFromShare, L.DEFAULTS.hideInCalls], [true, true]);
  assert.equal(L.sanitizePersona({ hideFromShare: false }).hideFromShare, false);
  assert.equal(L.sanitizePersona({ hideInCalls: 'no' }).hideInCalls, true, 'only real booleans are accepted');
  assert.match(L.PRESENTING_SHORTCUT, /^CommandOrControl\+Alt\+Shift\+O$/);
});
