'use strict';
// Picks the implementation for the current OS. Each module exports:
//   name, historySource, createWatcher(), listInstalledApps(), and optionally getIdleSeconds(), isLocked().
switch (process.platform) {
  case 'darwin': module.exports = require('./mac'); break;
  case 'win32': module.exports = require('./windows'); break;
  default: module.exports = require('./linux');
}
