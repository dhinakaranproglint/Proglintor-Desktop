'use strict';
// Orbit's wellbeing coach: watches whether the employee is actively at the computer and, following their own settings, nudges them
// to drink water, rest their eyes, stretch, eat, and wrap up. All of it happens on this laptop (nothing is sent anywhere) except the
// end-of-day summary text, which Orbit fetches from the server. The rules live in shared/renderer/care-logic.js.
const fs = require('fs');
const path = require('path');
const C = require('../shared/renderer/care-logic');
const L = require('../shared/renderer/orbit-logic');

class CareCoach {
  /**
   * @param {object} o
   * @param {string} o.dir                          where care-state.json lives
   * @param {() => {state:string,current?:{id?:string,name?:string}}} o.status   the tracker's view of what the person is doing
   * @param {() => object} o.getConfig              current reminder settings
   * @param {(n:object) => void} o.onNudge          show a reminder
   * @param {() => Promise<{message?:string}|null>} [o.wrapup]   end-of-day text from the server
   * @param {() => string} [o.name]                 first name, for friendlier words
   * @param {() => number} [o.now]
   */
  constructor(o) {
    Object.assign(this, { wrapup: async () => null, name: () => '', now: () => Date.now(), tickMs: 15000, fullscreenApp: async () => '', hold: () => false, ...o });
    this.file = path.join(o.dir, 'care-state.json');
    this.timer = null;
    this.last = 0;
    this.dirty = 0;
    this.state = C.restore(this._read(), this._day());
  }

  _read() { try { return JSON.parse(fs.readFileSync(this.file, 'utf8')); } catch { return null; } }
  _write() { try { fs.writeFileSync(this.file, JSON.stringify(this.state), { mode: 0o600 }); this.dirty = 0; } catch { /* the next change tries again */ } }
  _day(t = this.now()) { return L.dayKey(new Date(t)); }

  start() {
    if (this.timer) return;
    this.last = this.now();
    this.timer = setInterval(() => this.tick().catch(() => {}), this.tickMs);
  }

  stop() { clearInterval(this.timer); this.timer = null; this._write(); }

  /** One look at the clock. Exposed so tests (and the first run) can drive it directly. */
  async tick() {
    const now = this.now();
    const gap = now - this.last;
    this.last = now;
    const st = this.status() || {};
    const d = new Date(now);
    // A long gap means the laptop was asleep: that time is rest, not work.
    const slept = gap > this.tickMs * 3;
    const current = `${st.current?.id || ''} ${st.current?.name || ''}`;
    const cfg = this.getConfig();
    const t = {
      now, dt: Math.max(0, gap), active: st.state === 'tracking' && !slept, inMeeting: cfg.pauseInMeetings && (C.inQuietApp(current, cfg.quietApps) || C.MEETING_RE.test(current)),
      day: this._day(now), minuteOfDay: d.getHours() * 60 + d.getMinutes(), weekday: d.getDay(),
    };
    // Hold (never lose) a reminder while the person can't be interrupted: presenting mode / a screen share, or a full-screen app.
    // The full-screen check only runs when a reminder is actually about to appear, so the screen is not polled all day.
    let heldBy = '';
    if (this.hold()) { t.inMeeting = true; heldBy = 'presenting'; }
    else if (cfg.respectFullscreen && !t.inMeeting && C.step(structuredClone(this.state), t, cfg).nudge) {
      const app = await this.fullscreenApp().catch(() => '');
      if (app) { t.inMeeting = true; heldBy = app; }
    }
    this.heldBy = heldBy;
    const { nudge } = C.step(this.state, t, cfg);
    this.dirty += 1;
    if (this.dirty >= 4) this._write();
    if (!nudge) return null;
    return this._deliver(nudge.kind, now);
  }

  async _deliver(kind, now = this.now()) {
    let wrapupText = '';
    if (kind === 'wrapup') { try { wrapupText = (await this.wrapup())?.message || ''; } catch { /* the generic words are fine */ } }
    const w = C.words(kind, { counts: this.state.counts, activeMs: this.state.activeMs, name: L.firstName(this.name()), wrapupText });
    const payload = { id: `${kind}-${now}`, kind, ...w };
    this._write();
    this.onNudge(payload);
    return payload;
  }

  /** The employee answered a reminder (done / snooze / skip). */
  act(kind, action) {
    if (!['done', 'snooze', 'skip'].includes(action) || typeof kind !== 'string') return this.snapshot();
    C.act(this.state, kind, action, this.now(), this.getConfig());
    this._write();
    return this.snapshot();
  }

  /** "I drank water" from the app or the orb's menu: counts it and restarts the water clock. */
  logWater() { this.state.counts.water += 1; this.state.sinceWater = 0; this._write(); return this.snapshot(); }

  pauseFor(minutes) { C.pause(this.state, Number(minutes) || 60, this.now()); this._write(); return this.snapshot(); }
  resume() { this.state.pausedUntil = 0; this._write(); return this.snapshot(); }

  focus(minutes) {
    if (Number(minutes) > 0) C.startFocus(this.state, Number(minutes), this.now()); else C.stopFocus(this.state);
    this._write();
    return this.snapshot();
  }

  /** Everything the Orbit page shows about wellbeing right now. */
  snapshot() {
    const now = this.now();
    const s = this.state;
    return {
      counts: { ...s.counts }, activeMs: s.activeMs, upcoming: C.upcoming(s, this.getConfig()),
      focus: s.focus && s.focus.until > now ? { until: s.focus.until, startedAt: s.focus.startedAt } : null,
      pausedUntil: s.pausedUntil > now ? s.pausedUntil : 0,
    };
  }
}

module.exports = { CareCoach };
