'use strict';
// Persists usage data as JSON and answers queries for the UI.
// Layout: days["YYYY-MM-DD"][appId] = { name, path, seconds, activations, sessions: [[startMs, endMs], ...] }

const fs = require('fs');
const path = require('path');

function dayKey(ts) {
  const d = new Date(ts);
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

function startOfDay(ts) {
  const d = new Date(ts);
  d.setHours(0, 0, 0, 0);
  return d.getTime();
}

/** Adds n calendar days (DST-safe). */
function addDays(ts, n) {
  const d = new Date(ts);
  d.setDate(d.getDate() + n);
  return d.getTime();
}

function hourStart(day, h) {
  const d = new Date(day);
  d.setHours(h, 0, 0, 0);
  return d.getTime();
}

function keyToTs(key) {
  const [y, m, d] = key.split('-').map(Number);
  return new Date(y, m - 1, d).getTime();
}

/** Sorts and merges overlapping [start, end] intervals. */
function mergeIntervals(list) {
  const sorted = list.filter(([s, e]) => e > s).sort((a, b) => a[0] - b[0]);
  const out = [];
  for (const [s, e] of sorted) {
    const last = out[out.length - 1];
    if (last && s <= last[1]) last[1] = Math.max(last[1], e);
    else out.push([s, e]);
  }
  return out;
}

/** Returns the parts of [s, e] not covered by `covered` (merged, sorted). */
function subtractIntervals([s, e], covered) {
  const out = [];
  let cur = s;
  for (const [cs, ce] of covered) {
    if (ce <= cur) continue;
    if (cs >= e) break;
    if (cs > cur) out.push([cur, Math.min(cs, e)]);
    cur = Math.max(cur, ce);
    if (cur >= e) break;
  }
  if (cur < e) out.push([cur, e]);
  return out;
}

const overlap = (s, e, a, b) => Math.max(0, Math.min(e, b) - Math.max(s, a));

const RANGES = { day: 'Day', week: 'Week', month: 'Month', all: 'All Time' };
const RANGE_DAYS = { day: 1, week: 7, month: 30 };

class UsageStore {
  constructor(dir) {
    this.file = path.join(dir, 'usage.json');
    this.dirty = false;
    fs.mkdirSync(dir, { recursive: true });
    this.db = this._load();
  }

  _empty() {
    return { version: 1, trackingStarted: Date.now(), days: {} };
  }

  _load() {
    if (!fs.existsSync(this.file)) {
      this.dirty = true;
      return this._empty();
    }
    try {
      const db = JSON.parse(fs.readFileSync(this.file, 'utf8'));
      if (!db || typeof db.days !== 'object') throw new Error('invalid format');
      return db;
    } catch (err) {
      // Never overwrite unreadable data: keep a copy aside.
      const backup = this.file.replace(/\.json$/, `.corrupt-${Date.now()}.json`);
      try { fs.renameSync(this.file, backup); } catch { /* ignore */ }
      console.error(`Usage data unreadable (${err.message}); moved to ${backup}`);
      this.dirty = true;
      return this._empty();
    }
  }

  save() {
    if (!this.dirty) return;
    const tmp = `${this.file}.tmp`;
    try {
      fs.mkdirSync(path.dirname(this.file), { recursive: true }); // recreated if someone deleted the folder
      fs.writeFileSync(tmp, JSON.stringify(this.db));
      fs.renameSync(tmp, this.file);
      this.dirty = false;
    } catch (err) {
      // Never crash the always-running agent over a failed save; try again at the next interval.
      console.error(`Could not save usage data: ${err.message}`);
    }
  }

  clearAll() {
    this.db = this._empty();
    this.dirty = true;
    this.save();
  }

  // ---- recording -------------------------------------------------------

  _entry(ts, app) {
    const key = dayKey(ts);
    const day = (this.db.days[key] ||= {});
    const e = (day[app.id] ||= { name: app.name, path: app.path || '', seconds: 0, activations: 0, sessions: [] });
    e.name = app.name;
    if (app.path) e.path = app.path;
    this.dirty = true;
    return e;
  }

  /** Adds foreground time, split at midnight; extends the previous session when contiguous. */
  recordForeground(app, start, end) {
    if (!(end > start)) return;
    let s = start;
    while (s < end) {
      const segEnd = Math.min(end, addDays(startOfDay(s), 1));
      const e = this._entry(s, app);
      e.seconds += (segEnd - s) / 1000;
      const last = e.sessions[e.sessions.length - 1];
      if (last && Math.abs(last[1] - s) < 3000) last[1] = segEnd;
      else e.sessions.push([s, segEnd]);
      s = segEnd;
    }
  }

  recordActivation(app, ts = Date.now()) {
    this._entry(ts, app).activations += 1;
  }

  /**
   * Merges usage recorded elsewhere (e.g. the Swift Machine Monitor app).
   * Only time not already covered by existing sessions is added, so importing
   * twice, or importing a period both apps tracked, never double-counts.
   * @param {{id, name, path?, activations?, sessions: [number, number][]}[]} entries  (one per app per day)
   */
  importExternal(entries) {
    const covered = {};
    for (const [key, apps] of Object.entries(this.db.days)) {
      covered[key] = mergeIntervals(Object.values(apps).flatMap((u) => u.sessions.map((x) => [...x])));
    }
    const existed = (key, id) => Boolean(this.db.days[key]?.[id]);
    let seconds = 0;
    let earliest = Infinity;
    for (const ent of entries) {
      const app = { id: ent.id, name: ent.name, path: ent.path || '' };
      let key = null;
      let isNew = false;
      for (const [s, e] of ent.sessions) {
        const k = dayKey(s);
        if (k !== key) { key = k; isNew = !existed(k, ent.id); }
        for (const [ps, pe] of subtractIntervals([s, e], covered[k] || [])) {
          this.recordForeground(app, ps, pe);
          seconds += (pe - ps) / 1000;
          earliest = Math.min(earliest, ps);
        }
      }
      if (key && isNew && ent.activations && this.db.days[key]?.[ent.id]) this.db.days[key][ent.id].activations += ent.activations;
    }
    if (earliest < this.db.trackingStarted) this.db.trackingStarted = earliest;
    for (const apps of Object.values(this.db.days)) {
      for (const u of Object.values(apps)) u.sessions.sort((a, b) => a[0] - b[0]);
    }
    this.dirty = true;
    this.save();
    return { seconds };
  }

  /**
   * Folds usage recorded under other ids into one app (e.g. earlier dev runs that were
   * recorded as "Electron"). Overlapping sessions are merged, so time is never doubled.
   */
  mergeApps(fromIds, app) {
    let changed = false;
    for (const apps of Object.values(this.db.days)) {
      const parts = [app.id, ...fromIds].filter((id) => apps[id] && (id !== app.id || fromIds.some((f) => apps[f])));
      if (!parts.some((id) => id !== app.id)) continue;
      const sessions = mergeIntervals(parts.flatMap((id) => apps[id].sessions.map((s) => [...s])));
      const activations = parts.reduce((t, id) => t + apps[id].activations, 0);
      for (const id of parts) delete apps[id];
      apps[app.id] = {
        name: app.name,
        path: app.path || '',
        seconds: sessions.reduce((t, [s, e]) => t + (e - s) / 1000, 0),
        activations,
        sessions,
      };
      changed = true;
    }
    if (changed) { this.dirty = true; this.save(); }
    return changed;
  }

  // ---- queries -----------------------------------------------------------

  /** Day-aligned [start, end) for a range ending on the anchor's day. */
  interval(range, anchor = Date.now()) {
    const day = startOfDay(anchor);
    const next = addDays(day, 1);
    switch (range) {
      case 'yesterday': return [addDays(startOfDay(Date.now()), -1), startOfDay(Date.now())];
      case 'week': return [addDays(day, -6), next];
      case 'month': return [addDays(day, -29), next];
      case 'all': return [Math.min(startOfDay(this.db.trackingStarted), startOfDay(Date.now())), addDays(startOfDay(Date.now()), 1)];
      default: return [day, next]; // 'day' / 'today'
    }
  }

  _entries(start, end) {
    const out = [];
    for (const [key, apps] of Object.entries(this.db.days)) {
      const ts = keyToTs(key);
      if (ts >= start && ts < end) out.push([ts, apps]);
    }
    return out;
  }

  summaries(start, end) {
    const out = new Map();
    for (const [, apps] of this._entries(start, end)) {
      for (const [id, u] of Object.entries(apps)) {
        const s = out.get(id) || { id, name: u.name, path: u.path, seconds: 0, activations: 0, sessions: 0, lastActive: 0, longest: 0 };
        s.seconds += u.seconds;
        s.activations += u.activations;
        s.sessions += u.sessions.length;
        for (const [a, b] of u.sessions) s.longest = Math.max(s.longest, (b - a) / 1000);
        const last = u.sessions.length ? u.sessions[u.sessions.length - 1][1] : 0;
        if (last > s.lastActive) { s.lastActive = last; s.name = u.name; if (u.path) s.path = u.path; }
        out.set(id, s);
      }
    }
    return [...out.values()].filter((s) => s.seconds >= 1).sort((a, b) => b.seconds - a.seconds);
  }

  totalSeconds(start, end) {
    let t = 0;
    for (const [, apps] of this._entries(start, end)) for (const u of Object.values(apps)) t += u.seconds;
    return t;
  }

  /** Per-day totals (zero-filled). `appId == null` means all apps. */
  daily(appId, start, end) {
    const out = [];
    for (let d = startOfDay(start); d < end; d = addDays(d, 1)) {
      const apps = this.db.days[dayKey(d)] || {};
      const seconds = appId
        ? (apps[appId]?.seconds || 0)
        : Object.values(apps).reduce((t, u) => t + u.seconds, 0);
      out.push({ date: d, seconds });
    }
    return out;
  }

  /** Per-day totals split by the given app ids (others grouped as "other"). */
  dailyStacked(start, end, ids) {
    const out = [];
    for (let d = startOfDay(start); d < end; d = addDays(d, 1)) {
      const apps = this.db.days[dayKey(d)] || {};
      const parts = {};
      let total = 0;
      for (const [id, u] of Object.entries(apps)) {
        const k = ids.includes(id) ? id : 'other';
        parts[k] = (parts[k] || 0) + u.seconds;
        total += u.seconds;
      }
      out.push({ date: d, total, parts });
    }
    return out;
  }

  /** 24 hourly buckets for a day, split by the given app ids. */
  hourly(day, ids) {
    const d0 = startOfDay(day);
    const bounds = Array.from({ length: 25 }, (_, h) => (h === 24 ? addDays(d0, 1) : hourStart(d0, h)));
    const hours = bounds.slice(0, 24).map((start, h) => ({ hour: h, start, total: 0, parts: {} }));
    const apps = this.db.days[dayKey(d0)] || {};
    for (const [id, u] of Object.entries(apps)) {
      const k = ids.includes(id) ? id : 'other';
      for (const [s, e] of u.sessions) {
        for (let h = 0; h < 24; h++) {
          const sec = overlap(s, e, bounds[h], bounds[h + 1]) / 1000;
          if (sec > 0) { hours[h].parts[k] = (hours[h].parts[k] || 0) + sec; hours[h].total += sec; }
        }
      }
    }
    return hours;
  }

  timeline(day, ids) {
    const apps = this.db.days[dayKey(day)] || {};
    const order = ids?.length ? ids : Object.keys(apps);
    return order.filter((id) => apps[id]).map((id) => ({ id, name: apps[id].name, sessions: apps[id].sessions }));
  }

  sessions(appId, day) {
    return this.db.days[dayKey(day)]?.[appId]?.sessions || [];
  }

  /** Every app ever tracked, with all-time totals and the latest name/path. */
  trackedApps() {
    const [s, e] = this.interval('all');
    return this.summaries(s, e);
  }

  rangeView(range, anchor = Date.now()) {
    if (range === 'today') range = 'day';
    const [start, end] = this.interval(range, anchor);
    const single = range === 'day';
    const summaries = this.summaries(start, end);
    const top = summaries.slice(0, 6).map((s) => s.id);
    const total = summaries.reduce((t, s) => t + s.seconds, 0);
    const now = Date.now();

    let prevTotal = null;
    if (RANGE_DAYS[range]) prevTotal = this.totalSeconds(addDays(start, -RANGE_DAYS[range]), start);

    let elapsedDays = 0;
    for (let d = start; d < end && d <= now; d = addDays(d, 1)) elapsedDays++;

    const longest = summaries.reduce((best, s) => (s.longest > (best?.seconds || 0) ? { id: s.id, name: s.name, seconds: s.longest } : best), null);
    const daily = single ? null : this.dailyStacked(start, end, top);
    return {
      range,
      title: RANGES[range] || RANGES.day,
      anchor: startOfDay(anchor),
      start,
      end,
      singleDay: single,
      isCurrent: end > now,
      total,
      prevTotal,
      elapsedDays: Math.max(1, elapsedDays),
      switches: summaries.reduce((t, s) => t + s.activations, 0),
      sessions: summaries.reduce((t, s) => t + s.sessions, 0),
      longest,
      top,
      summaries,
      hourly: single ? this.hourly(start, top) : null,
      timeline: single ? this.timeline(start, summaries.slice(0, 8).map((s) => s.id)) : null,
      daily,
      busiest: daily ? daily.reduce((b, d) => (d.total > (b?.total || 0) ? d : b), null) : null,
    };
  }

  appDetail(appId, day) {
    const today = startOfDay(Date.now());
    const tomorrow = addDays(today, 1);
    const daily30 = this.daily(appId, addDays(today, -29), tomorrow);
    const all = this.trackedApps().find((s) => s.id === appId);
    const sel = startOfDay(day || today);
    return {
      id: appId,
      name: all?.name || appId,
      path: all?.path || '',
      today: daily30[daily30.length - 1].seconds,
      week: daily30.slice(-7).reduce((t, d) => t + d.seconds, 0),
      allTime: all?.seconds || 0,
      activations: all?.activations || 0,
      longest: all?.longest || 0,
      daily30,
      day: sel,
      sessions: this.sessions(appId, sel),
    };
  }

  toCSV() {
    const esc = (v) => `"${String(v).replace(/"/g, '""')}"`;
    const rows = ['date,app_id,app_name,path,active_seconds,switches_to,sessions'];
    for (const key of Object.keys(this.db.days).sort()) {
      const apps = Object.entries(this.db.days[key]).sort((a, b) => b[1].seconds - a[1].seconds);
      for (const [id, u] of apps) {
        rows.push([key, esc(id), esc(u.name), esc(u.path || ''), Math.round(u.seconds), u.activations, u.sessions.length].join(','));
      }
    }
    return rows.join('\n');
  }
}

module.exports = { UsageStore, dayKey, startOfDay, addDays, mergeIntervals, subtractIntervals, RANGES };
