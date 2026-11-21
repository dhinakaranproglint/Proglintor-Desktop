'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const C = require('../src/shared/renderer/care-logic');

const MIN = C.MIN;
const DAY = '2026-01-14';

/** Runs `minutes` of one-minute ticks; returns every reminder that fired. */
function run(state, cfg, minutes, over = {}, start = 600) {
  const fired = [];
  let now = over.now ?? state.__now ?? 1_000_000_000; // time carries on from the last run
  for (let i = 0; i < minutes; i++) {
    now += MIN;
    const { nudge } = C.step(state, { now, dt: MIN, active: true, inMeeting: false, day: DAY, minuteOfDay: start + i, weekday: 3, ...over }, cfg);
    if (nudge) fired.push([i + 1, nudge.kind]);
  }
  state.__now = now;
  return fired;
}
const only = (kind, extra = {}) => C.sanitizeCare({ water: { on: false }, eyes: { on: false }, stretch: { on: false }, rest: { on: false }, meal: { on: false }, wrapup: { on: false }, overwork: { on: false }, ...extra, [kind]: { on: true, ...(extra[kind] || {}) } });

test('settings are clamped: a 5-minute water reminder is allowed, 1 minute or text is not', () => {
  assert.equal(C.sanitizeCare({ water: { every: 5 } }).water.every, 5);
  assert.equal(C.sanitizeCare({ water: { every: 1 } }).water.every, 5);
  assert.equal(C.sanitizeCare({ water: { every: 99999 } }).water.every, 240);
  assert.equal(C.sanitizeCare({ water: { every: 'soon' } }).water.every, 60);
  assert.equal(C.sanitizeCare({ meal: { at: '25:99' } }).meal.at, '13:00');
  assert.equal(C.sanitizeCare({ meal: { at: '12:30' } }).meal.at, '12:30');
  assert.equal(C.sanitizeCare({ delivery: 'email' }).delivery, 'orb');
  assert.equal(C.sanitizeCare({ evil: 1 }).evil, undefined);
  assert.equal(C.sanitizeCare(null).water.on, true);
  assert.equal(C.sanitizeCare({ water: { on: false } }, C.sanitizeCare({ water: { every: 30 } })).water.every, 30, 'keeps what was already chosen');
});

test('water is offered after the chosen minutes of active time, and again after the same again', () => {
  const cfg = only('water', { water: { every: 30 } });
  const s = C.newState(DAY);
  assert.deepEqual(run(s, cfg, 29), []);
  assert.deepEqual(run(s, cfg, 70).map(([m]) => m), [1, 31, 61], 'at 30, 60 and 90 minutes of work');
});

test('the 20-20-20 eye break comes every 20 minutes and a break away from the screen resets it', () => {
  const cfg = only('eyes');
  const s = C.newState(DAY);
  assert.equal(run(s, cfg, 19).length, 0);
  assert.deepEqual(run(s, cfg, 1).map(([, k]) => k), ['eyes']);
  const t = C.newState(DAY);
  run(t, cfg, 15);
  run(t, cfg, 4, { active: false });   // four minutes away: eyes have rested
  assert.equal(t.sinceEyes, 0);
  assert.equal(run(t, cfg, 10).length, 0, 'the clock started again');
});

test('a short pause away does not reset the water clock, a real break resets eyes and legs but not water', () => {
  const s = C.newState(DAY);
  s.sinceWater = 40 * MIN; s.sinceEyes = 10 * MIN; s.sinceStretch = 30 * MIN;
  C.step(s, { now: 1, dt: 2 * MIN, active: false, inMeeting: false, day: DAY, minuteOfDay: 700, weekday: 3 }, only('water'));
  assert.equal(s.sinceEyes, 10 * MIN, 'two minutes is not a break');
  C.step(s, { now: 2, dt: 2 * MIN, active: false, inMeeting: false, day: DAY, minuteOfDay: 702, weekday: 3 }, only('water'));
  assert.deepEqual([s.sinceEyes, s.sinceStretch, s.sinceWater], [0, 0, 40 * MIN]);
});

test('reminders are never closer than eight minutes, most important first', () => {
  const cfg = C.sanitizeCare({ water: { every: 20 }, eyes: { every: 20 }, stretch: { every: 20 }, rest: { on: false }, meal: { on: false }, wrapup: { on: false }, overwork: { on: false } });
  const fired = run(C.newState(DAY), cfg, 60);
  assert.ok(fired.length >= 3);
  for (let i = 1; i < fired.length; i++) assert.ok(fired[i][0] - fired[i - 1][0] >= 8, 'gap between reminders');
  assert.equal(fired[0][1], 'stretch', 'stretch outranks water and eyes');
});

test('nothing fires while away, in a meeting, paused, in quiet hours, or on a day off when asked', () => {
  const cfg = only('water', { water: { every: 5 } });
  const quiet = (over) => run(C.newState(DAY), cfg, 30, over);
  assert.deepEqual(run(C.newState(DAY), cfg, 30, { active: false }), []);
  assert.deepEqual(quiet({ inMeeting: true }), []);
  assert.equal(run(C.newState(DAY), C.sanitizeCare({ ...cfg, pauseInMeetings: false }), 30, { inMeeting: true }).length > 0, true, 'unless meetings are allowed');
  const paused = C.pause(C.newState(DAY), 60, 1_000_000_000);
  assert.deepEqual(run(paused, cfg, 30), []);
  assert.deepEqual(run(C.newState(DAY), C.sanitizeCare({ ...cfg, quiet: { on: true, from: '20:00', to: '08:00' } }), 30, {}, 22 * 60), []);
  assert.equal(run(C.newState(DAY), C.sanitizeCare({ ...cfg, quiet: { on: true, from: '20:00', to: '08:00' } }), 30, {}, 10 * 60).length > 0, true);
  assert.deepEqual(run(C.newState(DAY), C.sanitizeCare({ ...cfg, workdaysOnly: true }), 30, { weekday: 6 }), []);
  assert.deepEqual(run(C.newState(DAY), C.sanitizeCare({ ...cfg, enabled: false }), 30), []);
});

test('quiet hours handle a window that crosses midnight', () => {
  const cfg = C.sanitizeCare({ quiet: { on: true, from: '20:00', to: '08:00' } });
  assert.equal(C.inQuietHours(cfg, 23 * 60), true);
  assert.equal(C.inQuietHours(cfg, 3 * 60), true);
  assert.equal(C.inQuietHours(cfg, 12 * 60), false);
  assert.equal(C.inQuietHours(C.sanitizeCare({ quiet: { on: true, from: '12:00', to: '14:00' } }), 13 * 60), true);
});

test('snooze brings it back in ten minutes, done counts it, skip does nothing', () => {
  const cfg = only('water', { water: { every: 30 } });
  const s = C.newState(DAY);
  run(s, cfg, 30);
  C.act(s, 'water', 'snooze', 0, cfg);
  assert.equal(run(s, cfg, 9).length, 0);
  assert.equal(run(s, cfg, 2).length, 1, 'due again after about ten minutes');
  C.act(s, 'water', 'done', 0, cfg); C.act(s, 'water', 'done', 0, cfg); C.act(s, 'water', 'skip', 0, cfg);
  assert.equal(s.counts.water, 2);
});

test('meal and wrap-up come once a day, at their time, only if working', () => {
  const cfg = C.sanitizeCare({ water: { on: false }, eyes: { on: false }, stretch: { on: false }, rest: { on: false }, overwork: { on: false }, meal: { at: '13:00' }, wrapup: { at: '17:45' } });
  const s = C.newState(DAY);
  assert.deepEqual(run(s, cfg, 30, {}, 12 * 60 + 46), [[15, 'meal']], 'at 13:00, once');
  assert.deepEqual(run(s, cfg, 30, {}, 17 * 60 + 30).map(([, k]) => k), ['wrapup']);
  assert.equal(run(s, cfg, 60, {}, 18 * 60).length, 0, 'not again today');
  const next = run(s, cfg, 30, { day: '2026-01-15' }, 12 * 60 + 40);
  assert.deepEqual(next.map(([, k]) => k), ['meal'], 'a new day starts fresh');
});

test('a very long day gets one gentle suggestion to wrap up', () => {
  const cfg = only('overwork', { overwork: { hours: 6 } });
  const fired = run(C.newState(DAY), cfg, 6 * 60 + 30);
  assert.deepEqual(fired.map(([, k]) => k), ['overwork']);
  assert.equal(fired[0][0], 6 * 60);
});

test('a focus session holds every reminder, then ends with a break suggestion', () => {
  const cfg = only('water', { water: { every: 5 } });
  const s = C.startFocus(C.newState(DAY), 25, 1_000_000_000);
  const fired = run(s, cfg, 30);
  assert.deepEqual(fired.map(([m, k]) => k), ['focusEnd']);
  assert.ok(fired[0][0] >= 25 && fired[0][0] <= 26);
  assert.equal(s.focus, null);
  assert.equal(C.stopFocus(C.startFocus(C.newState(DAY), 10, 0)).focus, null);
});

test('state survives a restart only for the same day; pauses and focus carry over', () => {
  const s = C.newState(DAY); s.counts.water = 4; s.activeMs = 5 * 3600_000; s.pausedUntil = 123; s.shown.meal = DAY;
  const same = C.restore(JSON.parse(JSON.stringify(s)), DAY);
  assert.deepEqual([same.counts.water, same.activeMs, same.pausedUntil, same.shown.meal], [4, 5 * 3600_000, 123, DAY]);
  const next = C.restore(JSON.parse(JSON.stringify(s)), '2026-01-15');
  assert.deepEqual([next.counts.water, next.activeMs, next.shown.meal], [0, 0, undefined]);
  assert.equal(C.restore('garbage', DAY).counts.water, 0);
});

test('upcoming shows minutes left for each switched-on reminder', () => {
  const cfg = C.sanitizeCare({ eyes: { on: false } });
  const s = C.newState(DAY); s.sinceWater = 45 * MIN;
  const u = C.upcoming(s, cfg);
  assert.equal(u.water, 15);
  assert.equal(u.eyes, null);
});

test('the words vary and always offer a way to answer', () => {
  for (const k of ['water', 'eyes', 'stretch', 'rest', 'meal', 'overwork', 'wrapup', 'focusEnd']) {
    const w = C.words(k, { counts: { [k]: 0 }, name: 'Asha', activeMs: 9 * 3600_000 });
    assert.ok(w.title && w.body && w.actions.length, k);
  }
  assert.notEqual(C.words('water', { counts: { water: 0 } }).body, C.words('water', { counts: { water: 1 } }).body);
  assert.match(C.words('wrapup', { wrapupText: 'You shipped it.' }).body, /shipped/);
  assert.equal(C.words('eyes').timer, 20);
});

test('a short interval never starves a longer one: water every 5 minutes still lets the eye break through', () => {
  const cfg = C.sanitizeCare({ water: { every: 5 }, eyes: { every: 10 }, stretch: { on: false }, rest: { on: false }, meal: { on: false }, wrapup: { on: false }, overwork: { on: false } });
  const fired = run(C.newState(DAY), cfg, 60).map(([, k]) => k);
  assert.ok(fired.includes('eyes'), `got ${fired.join(',')}`);
  assert.ok(fired.includes('water'));
});
