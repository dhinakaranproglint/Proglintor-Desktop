'use strict';
// The employee side of the install assistant, running in the agent's main process:
//   * chat calls (catalogue, preview, request, cancel, history) with employee-friendly errors,
//   * the install worker: claims approved jobs for this laptop, runs them and reports progress/result,
//   * crash/offline safety: an interrupted install is reported on the next start, and a result that couldn't be
//     delivered is kept on disk and retried,
//   * native notifications when a request is approved, declined, finished or fails.
const fs = require('fs');
const path = require('path');
const installerModule = require('./installer');
const { networkHint } = require('./sync');
const { makeLog } = require('./installlog');

const IDLE_POLL_MS = 30 * 1000;   // nothing in flight: the heartbeat also nudges us when work appears
const BUSY_POLL_MS = 5 * 1000;    // an install is queued or running
const WAITING_POLL_MS = 12 * 1000; // only waiting for an admin's decision: no need to hammer the server
const PROGRESS_MS = 1500;
const RETRY_DELAYS = [2000, 5000, 15000];
const ACTIVE = new Set(['QUEUED', 'DISPATCHED', 'RUNNING', 'VERIFYING']);
const OPEN = new Set(['AWAITING_APPROVAL', ...ACTIVE]);

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** What an employee reads when a call fails. */
function friendlyError(err) {
  if (err?.status) {
    if (err.status === 401) return { code: 'not_connected', error: "This computer isn't connected to Proglint right now. Open My Device to reconnect." };
    if (err.status >= 500) return { code: 'server_error', error: 'Proglint is having trouble right now. Please try again in a few minutes.' };
    return { code: err.code || 'rejected', error: err.message || 'The request could not be completed.' };
  }
  return { code: 'offline', error: `${networkHint(err)} Your request was not sent.` };
}

class SoftwareAgent {
  /**
   * @param {object} o
   * @param {string} o.dir                         folder for software-job.json
   * @param {import('./sync').Sync} o.sync
   * @param {() => Promise<{id:string,name:string}[]>} o.runningApps
   * @param {(spec:object, p:string) => Promise<boolean>} [o.detect]   confirms the app is present after install
   * @param {() => Promise<void>} [o.afterInstall]  e.g. rescan installed apps and report them
   * @param {(title:string, body:string) => void} [o.notify]
   * @param {() => void} [o.onChange]               tells open windows to refresh
   * @param {object} [o.installer]                  injectable for tests
   */
  constructor(o) {
    Object.assign(this, { installer: installerModule, notify: () => {}, onChange: () => {}, afterInstall: async () => {}, ...o });
    this.file = path.join(o.dir, 'software-job.json');
    this.log = o.log || makeLog(o.dir);
    this.retryDelays = o.retryDelays || RETRY_DELAYS;
    this.busy = false;
    this.timer = null;
    this.known = new Map();   // request id -> last status seen (for notifications)
    this.watching = 0;        // open requests we know about (speeds up polling)
    this.inFlight = 0;        // of those, ones queued or running (the rest only await a decision)
    this.abort = null;
    this.started = false;
  }

  // ---- persisted job state (survives crashes and restarts) ---------------------------------------

  _readJob() { try { return JSON.parse(fs.readFileSync(this.file, 'utf8')); } catch { return null; } }
  _writeJob(job) {
    if (!job) { fs.rmSync(this.file, { force: true }); return; }
    const tmp = `${this.file}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(job));
    fs.renameSync(tmp, this.file);
  }

  // ---- lifecycle -----------------------------------------------------------------------------------

  start() {
    if (this.started) return;
    this.started = true;
    const left = this._readJob();
    // The agent stopped in the middle of an install last time: tell the server so the employee isn't left waiting.
    if (left && !left.result) this._writeJob({ ...left, result: { ok: false, code: 'INSTALL_INTERRUPTED' } });
    this._schedule(2000);
  }

  /** The laptop was removed from Proglintor: stop any install and forget what we knew about its requests. */
  reset() {
    this.abort?.abort();
    this.known.clear();
    this.watching = 0;
    this.inFlight = 0;
    this._writeJob(null);
  }

  stop() {
    this.started = false;
    clearTimeout(this.timer);
    this.abort?.abort();
  }

  /** Run a worker pass soon (after a request is made, or when the server says work is waiting). */
  poke() {
    if (this.started && !this.busy) this._schedule(200);
  }

  _schedule(ms) {
    clearTimeout(this.timer);
    this.timer = setTimeout(() => this._tick().catch(() => {}), ms);
  }

  async _tick() {
    if (!this.started) return;
    try {
      if (this.sync.enrolled && !this.busy) {
        await this._flushResult();
        if (this.watching > 0) await this.list().catch(() => {}); // keeps notifications flowing while the window is closed
        await this._claimAndRun();
      }
    } finally {
      this._schedule(this.busy || this.inFlight > 0 ? BUSY_POLL_MS : this.watching > 0 ? WAITING_POLL_MS : IDLE_POLL_MS);
    }
  }

  // ---- chat API (called from the renderer through IPC) --------------------------------------------

  _gate() {
    if (this.sync.status().removed) {
      return { ok: false, code: 'removed', error: 'This laptop was removed from Proglintor by your admin. Ask for a new enrollment code on the My Device page.' };
    }
    if (!this.sync.enrolled) {
      return { ok: false, code: 'not_enrolled', error: "This laptop isn't connected to Proglint yet. Open My Device and enter the enrollment code from your admin." };
    }
    return null;
  }

  async _call(method, p, body) {
    const gate = this._gate();
    if (gate) return gate;
    try {
      return { ok: true, data: await this.sync.call(method, p, body) };
    } catch (err) {
      return { ok: false, ...friendlyError(err) };
    }
  }

  /**
   * "Is it already installed?" is answered from the installed-apps list the server holds, which is only a snapshot. So before asking,
   * make sure that list is current. If the apps folders have not changed since the last report (and it is under a minute old) there
   * is nothing to do; otherwise rescan and report. Without a change detector, rescan at most every 15 s.
   * Never blocks the request for more than 20 s and never fails it.
   */
  async _freshInventory() {
    if (!this.refreshInventory) return;
    const age = Date.now() - (this.inventoryAt || 0);
    const unchanged = this.inventoryUnchanged ? this.inventoryUnchanged() && age < 60000 : age < 15000;
    if (unchanged) return;
    try {
      await Promise.race([Promise.resolve(this.refreshInventory()), sleep(20000)]);
      this.inventoryAt = Date.now();
    } catch { /* a failed rescan must not stop the request: the server then relies on its own age check */ }
  }

  catalogue() { return this._call('GET', '/api/agent/software/catalogue'); }
  /** Chat that isn't a request (small talk, off-topic): the server asks its language model, or says it can't and the app uses built-in replies. */
  assist(message, history) { return this._call('POST', '/api/agent/software/assist', { message, history }); }
  async preview(prompt) {
    if (!this._gate()) await this._freshInventory();
    return this._call('POST', '/api/agent/software/preview', { prompt });
  }

  async submit(prompt, idempotencyKey, reinstall = false) {
    if (!this._gate()) await this._freshInventory();
    const r = await this._call('POST', '/api/agent/software/requests', { prompt, idempotencyKey, reinstall: reinstall === true });
    if (r.ok && r.data.id) {
      this._track(r.data);
      this.poke();
    }
    return r;
  }

  /** The employee said yes to "ask IT to review this app?". */
  async confirm(id) {
    const r = await this._call('POST', `/api/agent/software/requests/${encodeURIComponent(id)}/confirm`, {});
    if (r.ok) { this._track(r.data); this.poke(); }
    return r;
  }

  async cancel(id) {
    const r = await this._call('POST', `/api/agent/software/requests/${encodeURIComponent(id)}/cancel`, {});
    if (r.ok) this.list().catch(() => {});
    return r;
  }

  /** Recent requests; also feeds status-change notifications. */
  async list() {
    const r = await this._call('GET', '/api/agent/software/requests');
    if (!r.ok) return r;
    const items = r.data.items || [];
    for (const req of items) this._track(req);
    this.watching = items.filter((x) => OPEN.has(x.status)).length;
    this.inFlight = items.filter((x) => OPEN.has(x.status) && x.status !== 'AWAITING_APPROVAL').length;
    return r;
  }

  _track(req) {
    const before = this.known.get(req.id);
    this.known.set(req.id, req.status);
    // Anything open (waiting for approval, queued, running) means the employee is waiting: poll quickly.
    this.watching = [...this.known.values()].filter((st) => OPEN.has(st)).length;
    this.inFlight = [...this.known.values()].filter((st) => OPEN.has(st) && st !== 'AWAITING_APPROVAL').length;
    if (before === undefined || before === req.status) return;
    const name = req.softwareName || 'Your software';
    if (req.status === 'QUEUED' && before === 'AWAITING_APPROVAL') this.notify('Install approved', `${name} was approved. Installing on this computer now.`);
    else if (req.status === 'REJECTED') this.notify('Request declined', `${name} was declined${req.decisionComment ? `: ${req.decisionComment}` : '.'}`);
    else if (req.status === 'SUCCEEDED') this.notify('Installed', `${name} is installed and verified.`);
    else if (['FAILED', 'BLOCKED', 'EXPIRED'].includes(req.status)) this.notify("Couldn't install", `${name} didn't install. Open Proglintor to see why.`);
    this.onChange();
  }

  // ---- worker --------------------------------------------------------------------------------------

  async _flushResult() {
    const job = this._readJob();
    if (!job?.result) return;
    try {
      await this.sync.call('POST', `/api/agent/software/jobs/${job.requestId}/result`, job.result);
      this._writeJob(null);
      this.onChange();
    } catch (err) {
      if (err.status === 404 || err.status === 400) this._writeJob(null); // the server doesn't know it any more: drop it
      // otherwise (offline, server error) keep it and retry on the next pass
    }
  }

  async _claimAndRun() {
    let res;
    try { res = await this.sync.call('POST', '/api/agent/software/jobs/next', {}); } catch { return; }
    if (!res?.job) return;
    await this._run(res.job);
  }

  async _isRunning(spec) {
    const apps = await this.runningApps().catch(() => []);
    const id = String(spec.appId || '').toLowerCase();
    const name = String(spec.name || '').toLowerCase();
    return apps.some((a) => (id && String(a.id).toLowerCase() === id) || String(a.name).toLowerCase() === name);
  }

  async _run(job) {
    const { requestId, spec } = job;
    this.busy = true;
    this.abort = new AbortController();
    this._writeJob({ requestId, startedAt: Date.now() });
    this.log('install.start', { request: requestId, app: spec.name, version: spec.version, type: spec.installerType });
    let lastPost = 0;
    let phase = 'DOWNLOADING';

    const post = async (p, done, total, force = false) => {
      const now = Date.now();
      if (!force && now - lastPost < PROGRESS_MS) return;
      lastPost = now;
      try {
        const r = await this.sync.call('POST', `/api/agent/software/jobs/${requestId}/progress`, { phase: p, bytesDone: done, bytesTotal: total });
        if (r.continue === false) this.abort?.abort(); // the server closed this request (e.g. the admin removed the laptop)
      } catch (err) {
        if (err.status === 401 || err.status === 404) this.abort?.abort();
        // other failures: progress is best-effort
      }
    };

    let result;
    try {
      await post('DOWNLOADING', 0, spec.sizeBytes || null, true);
      await this.installer.runJob(spec, {
        signal: this.abort.signal,
        onPhase: (p) => { phase = p; if (p !== 'DOWNLOADING') post(p, null, null, true).catch(() => {}); },
        onProgress: (done, total) => post('DOWNLOADING', done, total).catch(() => {}),
        detect: this.detect,
        mac: { isRunning: (s) => this._isRunning(s) },
        allowLoopbackHttp: Boolean(process.env.PROGLINTOR_ALLOW_LOOPBACK_HTTP),
      });
      result = { ok: true };
      this.log('install.ok', { request: requestId, app: spec.name });
    } catch (err) {
      const code = err?.code && /^[A-Z_]+$/.test(err.code) ? err.code : 'INSTALL_FAILED';
      result = { ok: false, code, detail: String(err?.message || '').slice(0, 200), phase };
      this.log('install.failed', { request: requestId, app: spec.name, code, phase, detail: result.detail });
    }

    this._writeJob({ requestId, startedAt: Date.now(), result });
    this.abort = null;
    for (const delay of [0, ...this.retryDelays]) {
      if (delay) await sleep(delay);
      await this._flushResult();
      if (!this._readJob()) break;
    }
    this.busy = false;
    try { await this.afterInstall(); } catch { /* inventory refresh is best-effort */ }
    this.list().catch(() => {});
    this.onChange();
  }
}

module.exports = { SoftwareAgent, friendlyError };
