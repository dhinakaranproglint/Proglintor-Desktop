'use strict';
const { execFile } = require('child_process');
const fs = require('fs');

/** Runs a command and resolves with stdout. */
function run(cmd, args = [], opts = {}) {
  return new Promise((resolve, reject) => {
    execFile(cmd, args, { maxBuffer: 64 * 1024 * 1024, timeout: 30000, windowsHide: true, ...opts }, (err, stdout, stderr) => {
      if (err) {
        err.stderr = stderr;
        reject(err);
      } else {
        resolve(stdout);
      }
    });
  });
}

function exists(p) {
  try { fs.accessSync(p); return true; } catch { return false; }
}

function basename(p) {
  return String(p || '').split(/[\\/]/).filter(Boolean).pop() || '';
}

/** Words that mark an executable as an installer/updater rather than the app itself. */
const NOT_APP_EXE = /(unins|uninstall|setup|update|installer|helper|crashpad)/i;

module.exports = { run, exists, basename, NOT_APP_EXE };
