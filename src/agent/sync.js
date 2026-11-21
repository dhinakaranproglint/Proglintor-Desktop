'use strict';
// Connects the agent to the Proglintor Admin server.
// All uploads are idempotent (whole days, alert uids), so retries after an outage are safe.
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const os = require('os');
const { dayKey, addDays, startOfDay } = require('./store');
const { normalizePolicy } = require('../shared/policy');

const HEARTBEAT_MS = 30 * 1000;
const USAGE_MS = 60 * 1000;
const INSTALLED_MS = 6 * 3600 * 1000;
const ONLINE_MS = 90 * 1000;

/** This computer's own IPv4 addresses (connections to them are kept on 127.0.0.1). */
function ownAddresses() {
  const out = new Set();
  for (const list of Object.values(os.networkInterfaces())) {
    for (const a of list || []) if (a.family === 'IPv4' && !a.internal) out.add(a.address);
  }
  return out;
}

/**
 * "192.168.1.20:8000" -> "http://192.168.1.20:8000". No port means the scheme default (80/443),
 * which is what a production server behind HTTPS uses.
 * If the address is this computer itself, 127.0.0.1 is used: endpoint security tools (e.g. CrowdStrike,
 * FortiClient) often drop connections to a laptop's own network address while loopback still works.
 */
function normalizeServer(input, own = ownAddresses()) {
  let s = String(input || '').trim().replace(/\/+$/, '');
  if (!s) throw new Error('Enter the server address from your admin');
  if (!/^https?:\/\//i.test(s)) s = `http://${s}`;
  let u;
  try { u = new URL(s); } catch { throw new Error('That server address is not valid'); }
  if (own.has(u.hostname) || u.hostname === 'localhost') u.hostname = '127.0.0.1';
  return u.origin;
}

/** Turns low-level network errors into advice an employee can act on. */
function networkHint(err, base) {
  // Node may wrap the real error (e.g. AggregateError when IPv4 and IPv6 both fail).
  const code = err?.cause?.code || err?.cause?.errors?.[0]?.code || err?.code || '';
  if (/bad port/i.test(err?.cause?.message || '')) return `Port in ${base} is not allowed. Use the backend's port, e.g. 8000.`;
  if (code === 'ECONNREFUSED') return `Nothing is answering at ${base}. Check the address and port, and that the Proglint server is running.`;
  if (code === 'UND_ERR_SOCKET' || code === 'ECONNRESET') return `${base} closed the connection. Security software or a firewall on the server computer is probably blocking connections from other computers. Ask IT to allow it, or use the company server address.`;
  if (code === 'ENOTFOUND' || code === 'EAI_AGAIN') return `The server name in ${base} could not be found. Check the address.`;
  if (err?.name === 'TimeoutError' || code === 'UND_ERR_CONNECT_TIMEOUT' || code === 'ETIMEDOUT' || code === 'EHOSTUNREACH' || code === 'ENETUNREACH') {
    return `${base} did not respond. Make sure you're on the office network or VPN.`;
  }
  return `Can't reach ${base} (${code || err?.message || 'network error'}).`;
}

class Sync {
  /**
   * @param {object} o
   * @param {string} o.dir                where organization.json is stored
   * @param {import('./store').UsageStore} o.store
   * @param {() => object} o.liveStatus   tracker status
   * @param {() => Promise<object[]>} o.runningApps
   * @param {() => Promise<object[]|null>} o.installedApps
   * @param {() => object} o.device       hostname, os, platform, agentVersion
   * @param {() => void} [o.onChange]
   */
  constructor(o) {
    Object.assign(this, o);
    this.file = path.join(o.dir, 'organization.json');
    this.cfg = this._load();
    this.lastOk = 0;
    this.lastError = null;
    this.timers = [];
    this.busy = false;
  }

  _load() {
    try { return { pendingAlerts: [], weekendPrompts: {}, ...JSON.parse(fs.readFileSync(this.file, 'utf8')) }; } catch { return { pendingAlerts: [], weekendPrompts: {} }; }
  }

  _save() {
    const tmp = `${this.file}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(this.cfg, null, 2));
    fs.renameSync(tmp, this.file);
  }

  get enrolled() { return Boolean(this.cfg.token); }
  get policy() { return normalizePolicy(this.cfg.policy); }

  status() {
    return {
      enrolled: this.enrolled,
      revoked: Boolean(this.cfg.revoked),
      server: this.cfg.server || '',
      assetId: this.cfg.asset?.assetId || '',
      employeeName: this.cfg.asset?.employeeName || '',
      employeeEmail: this.cfg.asset?.employeeEmail || '',
      department: this.cfg.asset?.department || '',
      online: this.enrolled && Date.now() - this.lastOk < ONLINE_MS,
      lastSync: this.cfg.lastSync || null,
      lastError: this.lastError,
      pendingAlerts: this.cfg.pendingAlerts.length,
    };
  }

  async _request(base, p, body, token) {
    const res = await fetch(base + p, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(15000),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw Object.assign(new Error(data.error || `Server error (${res.status})`), { status: res.status });
    return data;
  }

  async _post(p, body) {
    try {
      const data = await this._request(this.cfg.server, p, body, this.cfg.token);
      this.lastOk = Date.now();
      this.lastError = null;
      this.cfg.lastSync = this.lastOk;
      return data;
    } catch (err) {
      if (err.status === 401) {
        // The admin reset or deleted this asset.
        this.cfg.token = null;
        this.cfg.revoked = true;
        this._save();
        this.stop();
        this.lastError = 'This laptop was disconnected by your admin. Enter a new enrollment code.';
      } else {
        this.lastError = err.status ? err.message : `${networkHint(err, this.cfg.server)} Data is saved on this laptop and sent when the server is reachable.`;
      }
      this.onChange?.();
      throw err;
    }
  }

  async enroll(server, code) {
    const base = normalizeServer(server);
    if (!String(code || '').trim()) throw new Error('Enter the enrollment code from your admin');
    let data;
    try {
      data = await this._request(base, '/api/agent/enroll', { code, ...this.device() });
    } catch (err) {
      if (err.status) throw err;
      throw new Error(networkHint(err, base));
    }
    this.cfg = {
      ...this.cfg,
      server: base,
      token: data.token,
      revoked: false,
      asset: data.asset,
      policy: data.policy,
      enrolledAt: Date.now(),
      fullSyncDone: false,
      installedHash: null,
    };
    this._save();
    this.lastOk = Date.now();
    this.lastError = null;
    this.start();
    await this.syncNow().catch(() => {});
    return this.status();
  }

  start() {
    if (!this.enrolled || this.timers.length) return;
    this.timers = [
      setInterval(() => this.heartbeat().catch(() => {}), HEARTBEAT_MS),
      setInterval(() => this.pushUsage().catch(() => {}), USAGE_MS),
      setInterval(() => this.pushInstalled().catch(() => {}), INSTALLED_MS),
    ];
    setTimeout(() => this.syncNow().catch(() => {}), 1500);
  }

  stop() {
    this.timers.forEach(clearInterval);
    this.timers = [];
  }

  async syncNow() {
    if (!this.enrolled) return;
    await this.heartbeat();
    await this.pushUsage();
    await this.pushInstalled();
  }

  async heartbeat() {
    if (!this.enrolled) return;
    const st = this.liveStatus();
    const data = await this._post('/api/agent/heartbeat', {
      state: st.state,
      current: st.current ? { id: st.current.id, name: st.current.name } : null,
      sessionStart: st.sessionStart,
      todaySeconds: st.today,
      runningApps: await this.runningApps().catch(() => []),
      ...this.device(),
    });
    if (data.policy) this.cfg.policy = data.policy;
    if (data.asset) this.cfg.asset = data.asset;
    this._save();
    await this.flushAlerts();
    this.onChange?.();
  }

  _dayPayload(key) {
    const apps = this.store.db.days[key] || {};
    return Object.entries(apps).map(([id, u]) => ({
      id, name: u.name, seconds: Math.round(u.seconds), sessions: u.sessions.length, activations: u.activations,
      lastActive: u.sessions.length ? u.sessions[u.sessions.length - 1][1] : null,
    }));
  }

  async pushUsage() {
    if (!this.enrolled) return;
    const today = startOfDay(Date.now());
    const keys = this.cfg.fullSyncDone
      ? [dayKey(addDays(today, -1)), dayKey(today)]
      : Object.keys(this.store.db.days);
    const days = {};
    for (const k of keys) days[k] = this._dayPayload(k);
    await this._post('/api/agent/usage', { days });
    if (!this.cfg.fullSyncDone) { this.cfg.fullSyncDone = true; this._save(); }
  }

  async pushInstalled(force = false) {
    if (!this.enrolled) return;
    const apps = await this.installedApps();
    if (!apps?.length) return;
    const slim = apps.map((a) => ({ id: a.id, name: a.name, version: a.version, publisher: a.publisher, lastUsed: a.lastUsed, useCount: a.useCount, isSystem: a.isSystem }));
    const hash = crypto.createHash('sha1').update(JSON.stringify(slim)).digest('hex');
    if (!force && hash === this.cfg.installedHash) return;
    await this._post('/api/agent/installed', { apps: slim });
    this.cfg.installedHash = hash;
    this._save();
  }

  /** Queues a weekend answer; delivered now or after the next successful contact. */
  queueAlert(alert) {
    this.cfg.pendingAlerts.push({ uid: crypto.randomUUID(), createdAt: Date.now(), ...alert });
    this._save();
    this.flushAlerts().catch(() => {});
  }

  async flushAlerts() {
    if (!this.enrolled || !this.cfg.pendingAlerts.length || this.busy) return;
    this.busy = true;
    try {
      const batch = this.cfg.pendingAlerts.slice(0, 50);
      const res = await this._post('/api/agent/alerts', { alerts: batch });
      const sent = new Set(res.received || batch.map((a) => a.uid));
      this.cfg.pendingAlerts = this.cfg.pendingAlerts.filter((a) => !sent.has(a.uid));
      this._save();
    } finally {
      this.busy = false;
    }
  }

  // ---- weekend prompt bookkeeping (per calendar day) ----
  promptState(key) { return this.cfg.weekendPrompts[key] || {}; }
  markPrompt(key, patch) {
    // Keep only the last two weeks of prompt history.
    for (const k of Object.keys(this.cfg.weekendPrompts)) if (k < dayKey(addDays(Date.now(), -14))) delete this.cfg.weekendPrompts[k];
    this.cfg.weekendPrompts[key] = { ...this.promptState(key), ...patch };
    this._save();
  }
}

module.exports = { Sync, normalizeServer, networkHint };
