'use strict';
// Product names and identifiers for the Proglintor suite.
module.exports = {
  company: 'Proglint',
  agentName: 'Proglintor',
  adminName: 'Proglintor Admin',
  agentAppId: 'com.proglint.proglintor.agent',
  adminAppId: 'com.proglint.proglintor.admin',
  /**
   * The Proglintor server the agent connects to. Employees never type it: IT sets it once in
   * src/shared/server.json before building the installer (or with the PROGLINTOR_SERVER environment variable).
   */
  serverUrl() {
    if (process.env.PROGLINTOR_SERVER) return process.env.PROGLINTOR_SERVER;
    try { return require('./server.json').server; } catch { return 'http://127.0.0.1:8000'; }
  },
  /** Tracking id used for the agent itself in usage data. */
  selfId: 'proglintor',
};
