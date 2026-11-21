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
    if (!res.ok) throw Object.assign(new Error(data.error || data.detail || `Server error (${res.status})`), { status: res.status });
    return data;
  }

  get(path) { return this.request('GET', path); }
  post(path, body) { return this.request('POST', path, body || {}); }
  patch(path, body) { return this.request('PATCH', path, body); }
  put(path, body) { return this.request('PUT', path, body); }
  delete(path) { return this.request('DELETE', path); }

  async login(url, username, password) {
    const base = normalizeUrl(url);
    const res = await this._fetch(base, '/api/admin/login', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ username, password }),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || (res.status === 404 ? `${base} is not a Proglintor backend` : `Sign-in failed (${res.status})`));
    this.cfg = { url: base, token: data.token, user: data.user };
    this._save();
    return this.user;
  }

  async logout() {
    try { await this.post('/api/admin/logout'); } catch { /* signing out locally is enough */ }
    this.cfg = { url: this.cfg.url };
    this._save();
  }
}

module.exports = { Backend, AuthError, normalizeUrl };
