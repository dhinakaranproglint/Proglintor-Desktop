'use strict';
// Orbit, the personal work companion: talks to the Proglint server for this laptop's employee (briefing, chat, tasks, achievements,
// appreciation) and tells them when something changes (a new task, a decision on their appreciation).
// Everything the model says comes from the server; this file only carries messages and never decides anything.
const { friendlyError } = require('./software');
const L = require('../shared/renderer/orbit-logic');

const PULSE_MS = 90 * 1000;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const STATUSES = new Set(['todo', 'in_progress', 'blocked', 'done']);

class OrbitAgent {
  /**
   * @param {object} o
   * @param {import('./sync').Sync} o.sync
   * @param {(title:string, body:string) => void} [o.notify]
   * @param {() => void} [o.onChange]   tells open windows to refresh
   * @param {() => Date} [o.now]
   */
  constructor(o) {
    Object.assign(this, { notify: () => {}, onChange: () => {}, now: () => new Date(), flush: async () => {}, ...o });
    this.timer = null;
    this.started = false;
    this.knownTasks = null;       // id set after the first poll (so we don't announce everything at start-up)
    this.knownRecs = null;        // id -> status
    this.openTasks = 0;
  }

  start() {
    if (this.started) return;
    this.started = true;
    this._schedule(5000);
  }

  stop() { this.started = false; clearTimeout(this.timer); }

  reset() { this.knownTasks = null; this.knownRecs = null; this.openTasks = 0; }

  /** Called when the window gets focus: no need to wait for the next poll. */
  poke() { if (this.started) this._schedule(300); }

  _schedule(ms) {
    clearTimeout(this.timer);
    this.timer = setTimeout(() => this._tick().catch(() => {}), ms);
  }

  async _tick() {
    if (!this.started) return;
    try {
      if (this.sync.enrolled && !this.sync.status().removed) await this.pulse();
    } finally {
      if (this.started) this._schedule(PULSE_MS);
    }
  }

  _gate() {
    if (this.sync.status().removed) return { ok: false, code: 'removed', error: 'This laptop was removed by your admin. Reconnect it on the My Device page.' };
    if (!this.sync.enrolled) return { ok: false, code: 'not_enrolled', error: "This laptop isn't connected to Proglint yet. Open My Device and enter the enrollment code from your admin." };
    return null;
  }

  async _call(method, path, body) {
    const gate = this._gate();
    if (gate) return gate;
    try {
      return { ok: true, data: await this.sync.call(method, path, body) };
    } catch (err) {
      if (err?.status === 404 && err?.code === 'orbit_disabled') return { ok: false, code: 'orbit_disabled', error: 'Orbit is switched off by your administrator.' };
      return { ok: false, ...friendlyError(err) };
    }
  }

  // ---- what the window asks for --------------------------------------------------------------------

  /** Sends the latest tracked time to the server first, so an answer about \"hours today\" is exact, not up to a minute old. Never blocks for long. */
  async _fresh() {
    try { await Promise.race([this.flush(), new Promise((r) => setTimeout(r, 4000))]); } catch { /* the last report is still there */ }
  }

  async briefing() { await this._fresh(); return this._call('GET', `/api/agent/orbit/briefing?localTime=${encodeURIComponent(L.localIso(this.now()))}`); }

  async chat(messages, agentName) {
    if (!Array.isArray(messages) || !messages.length || messages.length > 20) return { ok: false, code: 'bad_input', error: 'Please type a shorter message.' };
    const clean = messages.slice(-20).map((m) => ({ role: m?.role === 'assistant' ? 'assistant' : 'user', content: String(m?.content || '').slice(0, 1000) }));
    if (clean[clean.length - 1].role !== 'user' || !clean[clean.length - 1].content.trim()) return { ok: false, code: 'bad_input', error: 'Please type a message first.' };
    await this._fresh();
    return this._call('POST', '/api/agent/orbit/chat', { messages: clean, agentName: L.sanitizePersona({ name: agentName }).name, localTime: L.localIso(this.now()) });
  }

  async wrapup() { await this._fresh(); return this._call('GET', `/api/agent/orbit/wrapup?localTime=${encodeURIComponent(L.localIso(this.now()))}`).then((r) => (r.ok ? r.data : null)); }

  tasks() { return this._call('GET', `/api/agent/orbit/tasks?localTime=${encodeURIComponent(L.localIso(this.now()))}`); }

  async updateTask(id, patch) {
    if (!UUID.test(String(id))) return { ok: false, code: 'bad_input', error: 'I could not find that task.' };
    const body = {};
    if (patch && STATUSES.has(patch.status)) body.status = patch.status;
    if (patch && Number.isInteger(patch.percent) && patch.percent >= 0 && patch.percent <= 100) body.percent = patch.percent;
    const r = await this._call('PATCH', `/api/agent/orbit/tasks/${id}`, body);
    if (r.ok) this.onChange();
    return r;
  }

  achievements() { return this._call('GET', `/api/agent/orbit/achievements?localTime=${encodeURIComponent(L.localIso(this.now()))}`); }

  async nominate({ dedupeKey, title, details } = {}) {
    const body = { localTime: L.localIso(this.now()) };
    if (typeof dedupeKey === 'string' && dedupeKey.length <= 80) body.dedupeKey = dedupeKey;
    else { body.title = String(title || '').slice(0, 120); body.details = String(details || '').slice(0, 500); }
    const r = await this._call('POST', '/api/agent/orbit/recognitions', body);
    if (r.ok) this.onChange();
    return r;
  }

  certificate(id) {
    if (!UUID.test(String(id))) return Promise.resolve({ ok: false, code: 'bad_input', error: 'I could not find that certificate.' });
    return this._call('GET', `/api/agent/orbit/recognitions/${id}/certificate`);
  }

  // ---- notifications -------------------------------------------------------------------------------

  async pulse() {
    const r = await this._call('GET', '/api/agent/orbit/pulse');
    if (!r.ok || !r.data.enabled) return r;
    const tasks = r.data.tasks || [];
    const recs = r.data.recognitions || [];
    this.openTasks = tasks.length;
    let changed = false;
    if (this.knownTasks) {
      for (const t of tasks) {
        if (!this.knownTasks.has(t.id)) { this.notify('New task for you', t.title); changed = true; }
      }
    }
    if (this.knownRecs) {
      for (const x of recs) {
        const before = this.knownRecs.get(x.id);
        if (before === x.status) continue;
        changed = true; // anything new or different: the page refreshes
        // A decision is news whether or not we saw it while it was still pending (the admin may be quicker than our poll).
        if (x.status === 'approved' && before !== 'approved') this.notify('Your appreciation was approved 🎉', x.reward ? `${x.title}. Reward: ${x.reward}` : x.title);
        else if (x.status === 'rejected' && before !== 'rejected') this.notify('An update on your appreciation request', x.title);
      }
    }
    this.knownTasks = new Set(tasks.map((t) => t.id));
    this.knownRecs = new Map(recs.map((x) => [x.id, x.status]));
    if (changed) this.onChange();
    return r;
  }
}

module.exports = { OrbitAgent, UUID };
