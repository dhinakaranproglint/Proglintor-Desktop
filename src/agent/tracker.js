'use strict';
// Records time for the foreground app.
// Switches are handled the moment the platform watcher reports them (event-driven on
// macOS/Windows); a 2s poll also keeps idle/lock state and running totals current.
// Time is not counted while idle, locked, asleep or manually paused.

const POLL_MS = 2000;

class Tracker {
  /**
   * @param {object} o
   * @param {import('./store').UsageStore} o.store
   * @param {object} o.platform         platform module (createWatcher, optional getIdleSeconds/isLocked)
   * @param {object} o.power            { idleSeconds(): number, isLocked(): boolean }  (Electron powerMonitor fallbacks)
   * @param {(raw) => object} o.resolve maps a raw foreground app to { id, name, path }
   * @param {number} o.idleThreshold    seconds
   */
  constructor({ store, platform, power, resolve, idleThreshold = 300 }) {
    Object.assign(this, { store, platform, power, resolve, idleThreshold });
    this.current = null;
    this.sessionStart = null;
    this.state = 'starting'; // tracking | idle | locked | paused | unavailable
    this.pauseReasons = new Set();
    this.busy = false;
    this.again = false;
    this.onUpdate = null; // called when the current app or state changes
    this._lastSignature = '';
  }

  start() {
    this.watcher = this.platform.createWatcher();
    this.watcher.onChange?.(() => this.tick());
    this.timer = setInterval(() => this.tick(), POLL_MS);
    this.saveTimer = setInterval(() => this.store.save(), 30000);
    this.tick();
  }

  stop() {
    clearInterval(this.timer);
    clearInterval(this.saveTimer);
    this.commit(Date.now());
    this.watcher?.stop();
    this.store.save();
  }

  /** Writes the in-progress interval for the current app into the store. */
  commit(until) {
    if (this.current && this.sessionStart && until > this.sessionStart) {
      this.store.recordForeground(this.current, this.sessionStart, until);
      this.sessionStart = until;
    }
  }

  pause(reason) {
    if (this.pauseReasons.size === 0) {
      this.commit(Date.now());
      this.sessionStart = null;
      this.store.save();
    }
    this.pauseReasons.add(reason);
    this.state = 'paused';
    this._notify();
  }

  resume(reason) {
    this.pauseReasons.delete(reason);
    if (this.pauseReasons.size === 0) {
      this.sessionStart = null; // the next check starts a fresh session
      this.state = 'starting';
      this._notify();
    }
  }

  get paused() { return this.pauseReasons.has('user'); }

  async _idleSeconds() {
    const v = this.platform.getIdleSeconds ? await this.platform.getIdleSeconds() : null;
    return v ?? this.power.idleSeconds();
  }

  async _isLocked() {
    const v = this.platform.isLocked ? await this.platform.isLocked() : null;
    return v ?? this.power.isLocked();
  }

  async tick() {
    if (this.busy) { this.again = true; return; } // run again right after; never drop a switch
    this.busy = true;
    try {
      await this._step();
    } catch (err) {
      console.error('tracker tick failed:', err);
    } finally {
      this.lastTickAt = Date.now();
      this.busy = false;
      this._notify();
      if (this.again) { this.again = false; await this.tick(); }
    }
  }

  async _step() {
    const now = Date.now();
    if (this.pauseReasons.size) { this.state = 'paused'; return; }

    if (await this._isLocked()) {
      // Count only up to the last check where the session was seen unlocked.
      if (this.state !== 'locked') { this.commit(Math.min(now, this.lastTickAt || now)); this.sessionStart = null; }
      this.state = 'locked';
      return;
    }

    const idle = await this._idleSeconds();
    if (idle >= this.idleThreshold) {
      if (this.state !== 'idle') {
        // Count only up to the last real input.
        if (this.sessionStart) this.commit(Math.max(this.sessionStart, now - idle * 1000));
        this.sessionStart = null;
      }
      this.state = 'idle';
      return;
    }

    const raw = await this.watcher.getActive();
    const at = Date.now();
    if (!raw) {
      this.commit(at);
      this.sessionStart = null;
      this.current = null;
      this.state = this.watcher.status().ok ? 'tracking' : 'unavailable';
      return;
    }

    const app = this.resolve(raw);
    if (!this.current || this.current.id !== app.id) {
      this.commit(at);
      this.current = app;
      this.sessionStart = at;
      this.store.recordActivation(app, at);
    } else if (!this.sessionStart) {
      this.sessionStart = at;
    } else {
      if (app.path && !this.current.path) this.current = app; // path may arrive after the event
      this.commit(at);
    }
    this.state = 'tracking';
  }

  _notify() {
    const sig = `${this.state}|${this.current?.id || ''}|${this.paused}`;
    if (sig !== this._lastSignature) {
      this._lastSignature = sig;
      this.onUpdate?.(this.status());
    }
  }

  status() {
    const w = this.watcher?.status() || { ok: false, message: 'Starting…' };
    const tracking = this.state === 'tracking' && this.current;
    return {
      state: this.state,
      current: tracking ? this.current : null,
      // Start of the uninterrupted stretch in the current app (for the live timer).
      sessionStart: tracking ? this._stretchStart() : null,
      paused: this.paused,
      detector: w.message,
      detectorOk: w.ok,
      idleThreshold: this.idleThreshold,
    };
  }

  _stretchStart() {
    const sessions = this.store.sessions(this.current.id, Date.now());
    const last = sessions[sessions.length - 1];
    if (last && this.sessionStart && Math.abs(last[1] - this.sessionStart) < 3000) return last[0];
    return this.sessionStart;
  }
}

module.exports = { Tracker, POLL_MS };
