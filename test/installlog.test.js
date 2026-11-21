'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { makeLog, MAX_BYTES } = require('../src/agent/installlog');

test('the install log writes one tidy line per event and rotates', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ilog-'));
  const log = makeLog(dir);
  log('install.failed', { app: 'Zoom\nWorkplace', code: 'ELEVATION_DENIED' });
  const text = fs.readFileSync(path.join(dir, 'install.log'), 'utf8');
  assert.match(text, /install\.failed app=Zoom Workplace code=ELEVATION_DENIED\n$/);
  fs.appendFileSync(path.join(dir, 'install.log'), 'x'.repeat(MAX_BYTES));
  log('install.ok', {});
  assert.ok(fs.existsSync(path.join(dir, 'install.log.1')), 'the old log is kept as .1');
  assert.ok(fs.statSync(path.join(dir, 'install.log')).size < 200);
});
