'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const src = fs.readFileSync(path.join(__dirname, '..', 'src', 'agent', 'main.js'), 'utf8');

// Regression: on macOS a normal window only appears while its own app is the active app, so a background companion (started hidden at login, or
// while you work in another app) never showed up. Floating windows that must appear over other apps have to be macOS panels.
test('the companion and the greeting card are macOS panels so they appear while another app is in front', () => {
  const companion = /companionWin = new BrowserWindow\(\{[\s\S]*?webPreferences/.exec(src)[0];
  const greeting = /greetWin = new BrowserWindow\(\{[\s\S]*?webPreferences/.exec(src)[0];
  for (const [name, block] of [['companion', companion], ['greeting card', greeting]]) {
    assert.match(block, /\.\.\.\(IS_MAC \? \{ type: 'panel' \} : \{\}\)/, `${name} must be a panel on macOS`);
  }
  assert.match(companion, /focusable: false/, 'and still never takes keyboard focus on its own');
});

test('every hide and show decision is written to a small local log so "it is not showing" can always be explained', () => {
  assert.match(src, /orbitLog\?\.\(hide \? 'companion\.hidden' : 'companion\.shown'/);
  assert.match(src, /makeLog\(app\.getPath\('userData'\), 'orbit\.log'\)/);
});
