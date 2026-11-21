'use strict';
// Client for the Proglintor Django backend (admin API).
const fs = require('fs');

class AuthError extends Error {}

function normalizeUrl(input) {
  let s = String(input || '').trim().replace(/\/+$/, '');
  if (!s) throw new Error('Enter the backend address, e.g. http://127.0.0.1:8000');
  if (!/^https?:\/\//i.test(s)) s = `http://${s}`;
  try { return new URL(s).origin; } catch { throw new Error('That backend address is not valid'); }
}

function networkMessage(err, url) {
  // Node may wrap the real error (e.g. AggregateError when IPv4 and IPv6 both fail).
  const code = err?.cause?.code || err?.cause?.errors?.[0]?.code || err?.code || '';
  if (code === 'ECONNREFUSED') return `Nothing is answering at ${url}. Is the Django backend running?`;
  if (code === 'UND_ERR_SOCKET' || code === 'ECONNRESET') return `${url} closed the connection. A firewall or security software may be blocking it.`;
  if (code === 'ENOTFOUND' || code === 'EAI_AGAIN') return `The server name in ${url} could not be found.`;
  if (err?.name === 'TimeoutError') return `${url} did not respond in time.`;
  return `Can't reach ${url} (${code || err?.message || 'network error'}).`;
}

class Backend {
  constructor(file) {
    this.file = file;
    this.reachable = null;
    this.lastError = null;
    try { this.cfg = JSON.parse(fs.readFileSync(file, 'utf8')); } catch { this.cfg = {}; }
  }

  get url() { return this.cfg.url || ''; }
  get loggedIn() { return Boolean(this.cfg.url && this.cfg.token); }
  get user() { return this.cfg.user || null; }
  get lastLogin() { return this.cfg.lastLogin || this.cfg.user?.email || ''; }

  _save() { fs.writeFileSync(this.file, JSON.stringify(this.cfg, null, 2), { mode: 0o600 }); }

  async _fetch(url, path, opts) {
    try {
      const res = await fetch(url + path, { ...opts, signal: AbortSignal.timeout(15000) });
      this.reachable = true;
      this.lastError = null;
      return res;
    } catch (err) {
      this.reachable = false;
      this.lastError = networkMessage(err, url);
      throw Object.assign(new Error(this.lastError), { network: true });
    }
  }

  async request(method, path, body, { raw = false } = {}) {
    if (!this.loggedIn) throw new AuthError('Please sign in');
    const res = await this._fetch(this.cfg.url, path, {
      method,
      headers: { authorization: `Token ${this.cfg.token}`, ...(body ? { 'content-type': 'application/json' } : {}) },
      body: body ? JSON.stringify(body) : undefined,
    });
    if (res.status === 401) {
      this.cfg.token = null;
      this._save();
      throw new AuthError('Your session has ended. Please sign in again.');
    }
    if (raw) {
      if (!res.ok) throw new Error(`Server error (${res.status})`);
      return res.text();
    }
    if (res.status === 204) return null;
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw Object.assign(new Error(data.error || data.detail || `Server error (${res.status})`), { status: res.status, code: data.code });
    return data;
  }

  get(path) { return this.request('GET', path); }
  post(path, body) { return this.request('POST', path, body || {}); }
  patch(path, body) { return this.request('PATCH', path, body); }
  put(path, body) { return this.request('PUT', path, body); }
  delete(path) { return this.request('DELETE', path); }

  /** Unauthenticated call; returns { status, data } and records reachability. */
  async _public(url, path, method = 'GET', body = null) {
    const base = normalizeUrl(url);
    const res = await this._fetch(base, path, {
      method,
      headers: body ? { 'content-type': 'application/json' } : {},
      body: body ? JSON.stringify(body) : undefined,
    });
    const data = await res.json().catch(() => ({}));
    return { base, status: res.status, ok: res.ok, data };
  }

  /** Is this a Proglintor backend, and does it still need its first admin? */
  async check(url) {
    const health = await this._public(url, '/api/health');
    if (!health.ok || !String(health.data.service || '').includes('backend')) {
      throw new Error(`${health.base} answered, but it isn't a Proglintor backend.`);
    }
    const setup = await this._public(url, '/api/admin/setup');
    return { url: health.base, needsSetup: Boolean(setup.data.needsSetup), setupAllowed: Boolean(setup.data.allowed) };
  }

  _fail(r) {
    const msg = r.data.error || (r.status === 404 ? `${r.base} is not a Proglintor backend` : `Request failed (${r.status})`);
    return Object.assign(new Error(msg), { field: r.data.field, needsSetup: r.data.needsSetup });
  }

  _store(base, data) {
    this.cfg = { url: base, token: data.token, user: data.user, lastLogin: data.user.email || data.user.username };
    this._save();
    return this.user;
  }

  async login(url, login, password) {
    const r = await this._public(url, '/api/admin/login', 'POST', { login, password });
    if (!r.ok) throw this._fail(r);
    return this._store(r.base, r.data);
  }

  async setup(url, form) {
    const r = await this._public(url, '/api/admin/setup', 'POST', form);
    if (!r.ok) throw this._fail(r);
    return this._store(r.base, r.data);
  }

  async forgot(url, login) {
    const r = await this._public(url, '/api/admin/password/forgot', 'POST', { login });
    if (!r.ok) throw this._fail(r);
    return r.data.message;
  }

  async reset(url, login, code, password) {
    const r = await this._public(url, '/api/admin/password/reset', 'POST', { login, code, password });
    if (!r.ok) throw this._fail(r);
    return this.login(url, login, password); // sign straight in with the new password
  }

  /** Signs out locally right away; the server is told in the background (a slow or offline server can't block it). */
  async logout() {
    const { url, token, lastLogin } = this.cfg;
    this.cfg = { url, lastLogin };
    this._save();
    if (url && token) {
      fetch(`${url}/api/admin/logout`, { method: 'POST', headers: { authorization: `Token ${token}` }, signal: AbortSignal.timeout(5000) }).catch(() => {});
    }
  }
}

module.exports = { Backend, AuthError, normalizeUrl };
