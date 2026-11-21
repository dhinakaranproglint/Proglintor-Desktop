'use strict';
// A small local log of install activity ("what happened on this laptop?"), for IT to read when a user reports a problem.
// One line per event, no file contents, no personal data. Rotates so it never grows without bound.
const fs = require('fs');
const path = require('path');

const MAX_BYTES = 256 * 1024;

function makeLog(dir, name = 'install.log') {
  const file = path.join(dir, name);
  return function log(event, fields = {}) {
    try {
      try { if (fs.statSync(file).size > MAX_BYTES) fs.renameSync(file, `${file}.1`); } catch { /* no file yet */ }
      const clean = Object.entries(fields).map(([k, v]) => `${k}=${String(v ?? '').replace(/\s+/g, ' ').slice(0, 160)}`).join(' ');
      fs.appendFileSync(file, `${new Date().toISOString()} ${event} ${clean}\n`, { mode: 0o600 });
    } catch { /* logging must never break an install */ }
  };
}

module.exports = { makeLog, MAX_BYTES };
