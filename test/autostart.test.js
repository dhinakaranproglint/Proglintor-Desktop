'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { buildPlist, LABEL } = require('../scripts/autostart');

test('the login job starts the dev agent hidden, restarts it only after a crash, and escapes odd paths', () => {
  const plist = buildPlist({ node: '/usr/local/bin/node', root: '/Users/x/My & Projects/proglint-pulse', server: 'http://127.0.0.1:8000', home: '/Users/x' });
  assert.match(plist, new RegExp(`<key>Label</key><string>${LABEL}</string>`));
  assert.match(plist, /<string>\/usr\/local\/bin\/node<\/string><string>\/Users\/x\/My &amp; Projects\/proglint-pulse\/scripts\/dev\.js<\/string><string>agent<\/string><string>--hidden<\/string>/);
  assert.match(plist, /<key>RunAtLoad<\/key><true\/>/);
  assert.match(plist, /<key>SuccessfulExit<\/key><false\/>/, 'a normal exit (already running) is not restarted');
  assert.match(plist, /PROGLINTOR_SERVER<\/key><string>http:\/\/127\.0\.0\.1:8000/);
  assert.doesNotMatch(plist, /<string>\/Users\/x\/My & /, 'ampersands are escaped');
  assert.doesNotMatch(buildPlist({ node: '/n', root: '/r' }), /PROGLINTOR_SERVER/);
});

test('the generated file is a valid property list', { skip: process.platform !== 'darwin' }, () => {
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'plist-')), 'x.plist');
  fs.writeFileSync(file, buildPlist({ node: process.execPath, root: path.join(__dirname, '..') }));
  assert.match(execFileSync('plutil', ['-lint', file]).toString(), /OK/);
});
