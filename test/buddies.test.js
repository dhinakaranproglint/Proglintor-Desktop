'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const B = require('../src/shared/renderer/orbit-buddies');
const L = require('../src/shared/renderer/orbit-logic');

test('every reminder has a friend and every friend can be drawn', () => {
  for (const kind of ['water', 'eyes', 'stretch', 'rest', 'meal', 'overwork', 'wrapup', 'focusEnd']) {
    const b = B.forReminder(kind);
    assert.ok(b && B.ANIMALS[b.animal], kind);
    const s = B.svg(b.animal, { mode: b.mode });
    assert.match(s, /^<svg class="bd bd-/);
    assert.match(s, /role="img" aria-label="[^"]+"/);
  }
  assert.deepEqual(B.forReminder('water'), { animal: 'otter' });
  assert.deepEqual(B.forReminder('eyes'), { animal: 'owl' });
  assert.deepEqual(B.forReminder('stretch'), { animal: 'redpanda', mode: 'stretch' });
  assert.equal(B.forReminder('nonsense'), null);
  assert.equal(B.forMoment('greet').animal, 'redpanda');
});

test('drawings are safe, self-contained and never clash when shown together', () => {
  const a = B.svg('otter');
  const b = B.svg('otter');
  const id = (s) => /id="(bd\d+f)"/.exec(s)[1];
  assert.notEqual(id(a), id(b), 'each drawing has its own gradient ids');
  for (const s of [B.svg('otter'), B.svg('redpanda', { mode: 'wave' }), B.svg('owl'), B.svg('sloth')]) {
    assert.doesNotMatch(s, /<script|onerror|onload|javascript:|href=/i);
  }
  assert.equal(B.svg('dragon'), '');
  assert.match(B.svg('otter', { color: 'red; evil' }), /fill="#7C5CFF"/, 'an unsafe colour falls back to the default');
  assert.match(B.svg('redpanda', { mode: 'evil' }), /data-mode=""/);
  assert.match(B.svg('redpanda', { mode: 'munch' }), /data-mode="munch"/);
  assert.match(B.svg('otter', { size: 9999 }), /width="200"/);
});

test('animal friends can be switched off in favour of the orb alone', () => {
  assert.equal(L.DEFAULTS.buddy, 'animals');
  assert.equal(L.sanitizePersona({ buddy: 'orb' }).buddy, 'orb');
  assert.equal(L.sanitizePersona({ buddy: 'dragon' }).buddy, 'animals');
});

test('each person chooses who lives on screen and who plays each moment, and the choices are checked', () => {
  const L2 = require('../src/shared/renderer/orbit-logic');
  assert.equal(L2.DEFAULTS.avatar, 'redpanda', 'an animal is on screen by default, not just an orb');
  const p = L2.sanitizePersona({ avatar: 'owl', buddies: { water: 'sloth', eyes: 'none', stretch: 'dragon', bogus: 'owl' } });
  assert.equal(p.avatar, 'owl');
  assert.deepEqual(B.resolve('water', p), { animal: 'sloth', mode: '' });
  assert.equal(B.resolve('eyes', p), null, '"Nobody" is allowed');
  assert.deepEqual(B.resolve('stretch', p), { animal: 'redpanda', mode: 'stretch' }, 'an invalid choice falls back to the default');
  assert.equal('bogus' in p.buddies, false);
  assert.equal(L2.sanitizePersona({ avatar: 'dragon' }).avatar, 'redpanda');
  // the red panda keeps its moves wherever it is cast; other animals have one signature move
  assert.equal(B.resolve('meal', L2.sanitizePersona({})).mode, 'munch');
  assert.equal(B.resolve('wrapup', L2.sanitizePersona({ buddies: { wrapup: 'owl' } })).mode, '');
  // a later partial change keeps earlier choices
  const q = L2.sanitizePersona({ buddies: { eyes: 'otter' } }, p);
  assert.deepEqual([q.buddies.water, q.buddies.eyes, q.avatar], ['sloth', 'otter', 'owl']);
  // every moment explains when it happens
  const care = { water: { on: true, every: 30 }, eyes: { on: false }, stretch: { on: true, every: 50 }, rest: { on: true, after: 100 }, meal: { on: true, at: '13:00' }, wrapup: { on: true, at: '17:45' }, overwork: { on: true, hours: 9 } };
  const when = Object.fromEntries(L2.EVENTS.map((e) => [e.id, e.when(L2.sanitizePersona({}), care)]));
  assert.equal(when.water, 'Every 30 minutes of active work');
  assert.equal(when.eyes, 'Off');
  assert.equal(when.meal, 'At 13:00');
  assert.match(when.greet, /first time you open your laptop each day/);
  assert.equal(L2.EVENTS.length, 11);
});

test('there is a shortcut to bring the companion back that works even when the menu bar icon is hard to find', () => {
  const L3 = require('../src/shared/renderer/orbit-logic');
  assert.equal(L3.COMPANION_SHORTCUT, 'CommandOrControl+Alt+Shift+A');
  assert.notEqual(L3.COMPANION_SHORTCUT, L3.PRESENTING_SHORTCUT);
});
