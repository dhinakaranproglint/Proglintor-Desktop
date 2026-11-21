'use strict';
// Orbit's wellbeing coach: the rules for gentle reminders (water, eye breaks, stretching, rest, meals, wrap-up).
// Pure functions: given the clock, whether the person is actively working, and their settings, decide what (if anything) to say.
// Reminders count ACTIVE screen time, so a lunch break or a meeting away from the desk resets the clock instead of nagging.
// Loaded in the main process with require() and tested directly. Nothing here talks to a server.
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.CareLogic = factory();
}(typeof self !== 'undefined' ? self : this, () => {
  const MIN = 60 * 1000;

  const DEFAULTS = {
    enabled: true,
    water: { on: true, every: 60 },      // minutes of active time between reminders
    eyes: { on: true, every: 20 },       // the 20-20-20 rule: every 20 minutes look 20 feet away for 20 seconds
    stretch: { on: true, every: 50 },
    rest: { on: true, after: 100 },      // minutes without a real break before suggesting a short walk
    meal: { on: true, at: '13:00' },
    wrapup: { on: true, at: '17:45' },
    overwork: { on: true, hours: 9 },    // gently suggest logging off after this many active hours
    quiet: { on: false, from: '20:00', to: '08:00' },
    pauseInMeetings: true,              // stay quiet while a call or presentation app is in front
    quietApps: ['teams', 'zoom', 'webex', 'meet', 'keynote', 'powerpoint', 'obs', 'quicktime', 'vlc'],
    respectFullscreen: true,            // never interrupt something that is using the whole screen
    workdaysOnly: false,
    delivery: 'orb',                      // 'orb' (speech bubble) or 'notification' (system notification)
  };

  const RANGES = { water: [5, 240], eyes: [10, 60], stretch: [15, 120], rest: [45, 240], overwork: [6, 14] };
  const TIME = /^([01]\d|2[0-3]):([0-5]\d)$/;
  const GAP_MS = 8 * MIN;            // never two reminders closer than this
  const AWAY_MS = 3 * MIN;           // this long away from the keyboard counts as a real break
  const SNOOZE_MS = 10 * MIN;
  const MEETING_RE = /teams|zoom|webex|gotomeeting|bluejeans|meet\.google|slack huddle/i;
  /**
   * Should the companion be completely out of sight right now (so it can't show up in a screen share or recording)?
   * Presenting mode and a detected share always hide it; a call or presentation app in front hides it if the person allows that.
   */
  function shouldHideCompanion({ presenting = false, sharing = false, hideInCalls = true, pauseInMeetings = true, current = '', quietApps = [] } = {}) {
    if (presenting || sharing) return true;
    if (!hideInCalls || !pauseInMeetings) return false;
    return inQuietApp(current, quietApps) || MEETING_RE.test(String(current || ''));
  }

  /** Is the app in front one the person asked us to stay quiet in? (a plain, case-insensitive "contains" match: no patterns) */
  const inQuietApp = (text, list) => { const t = String(text || '').toLowerCase(); return (Array.isArray(list) ? list : []).some((q) => q && t.includes(q)); };

  const clamp = (v, [lo, hi], d) => (Number.isFinite(v) ? Math.min(hi, Math.max(lo, Math.round(v))) : d);
  const bool = (v, d) => (typeof v === 'boolean' ? v : d);
  const time = (v, d) => (typeof v === 'string' && TIME.test(v) ? v : d);

  /** Whatever the window sends is untrusted: keep only known keys with valid values. */
  function sanitizeCare(input, base = DEFAULTS) {
    const b = { ...DEFAULTS, ...base };
    const i = input && typeof input === 'object' ? input : {};
    const sub = (k) => (i[k] && typeof i[k] === 'object' ? i[k] : {});
    const out = {
      enabled: bool(i.enabled, b.enabled),
      water: { on: bool(sub('water').on, b.water.on), every: clamp(sub('water').every, RANGES.water, b.water.every) },
      eyes: { on: bool(sub('eyes').on, b.eyes.on), every: clamp(sub('eyes').every, RANGES.eyes, b.eyes.every) },
      stretch: { on: bool(sub('stretch').on, b.stretch.on), every: clamp(sub('stretch').every, RANGES.stretch, b.stretch.every) },
      rest: { on: bool(sub('rest').on, b.rest.on), after: clamp(sub('rest').after, RANGES.rest, b.rest.after) },
      meal: { on: bool(sub('meal').on, b.meal.on), at: time(sub('meal').at, b.meal.at) },
      wrapup: { on: bool(sub('wrapup').on, b.wrapup.on), at: time(sub('wrapup').at, b.wrapup.at) },
      overwork: { on: bool(sub('overwork').on, b.overwork.on), hours: clamp(sub('overwork').hours, RANGES.overwork, b.overwork.hours) },
      quiet: { on: bool(sub('quiet').on, b.quiet.on), from: time(sub('quiet').from, b.quiet.from), to: time(sub('quiet').to, b.quiet.to) },
      pauseInMeetings: bool(i.pauseInMeetings, b.pauseInMeetings),
      quietApps: Array.isArray(i.quietApps) ? [...new Set(i.quietApps.map((x) => String(x).toLowerCase().replace(/[^a-z0-9 .+-]/g, '').trim().slice(0, 30)).filter(Boolean))].slice(0, 20) : b.quietApps,
      respectFullscreen: bool(i.respectFullscreen, b.respectFullscreen),
      workdaysOnly: bool(i.workdaysOnly, b.workdaysOnly),
      delivery: ['orb', 'notification'].includes(i.delivery) ? i.delivery : b.delivery,
    };
    return out;
  }

  const minutesOf = (hhmm) => Number(hhmm.slice(0, 2)) * 60 + Number(hhmm.slice(3));

  function inQuietHours(cfg, minuteOfDay) {
    if (!cfg.quiet.on) return false;
    const from = minutesOf(cfg.quiet.from); const to = minutesOf(cfg.quiet.to);
    return from <= to ? minuteOfDay >= from && minuteOfDay < to : minuteOfDay >= from || minuteOfDay < to; // e.g. 20:00 to 08:00 crosses midnight
  }

  const newState = (day = '') => ({
    day, activeMs: 0, sinceWater: 0, sinceEyes: 0, sinceStretch: 0, sinceRest: 0, awayMs: 0, lastNudgeAt: 0, snoozeUntil: 0, pausedUntil: 0,
    counts: { water: 0, eyes: 0, stretch: 0, rest: 0, meal: 0 }, shown: {}, focus: null,
  });

  /** Keeps a saved state only if it is from today, and adds anything missing. */
  function restore(saved, day) {
    const s = newState(day);
    if (saved && typeof saved === 'object') {
      for (const k of ['pausedUntil', 'snoozeUntil']) if (Number.isFinite(saved[k])) s[k] = saved[k];
      if (saved.day === day) {
        for (const k of ['activeMs', 'sinceWater', 'sinceEyes', 'sinceStretch', 'sinceRest', 'lastNudgeAt']) if (Number.isFinite(saved[k])) s[k] = saved[k];
        if (saved.counts && typeof saved.counts === 'object') for (const k of Object.keys(s.counts)) if (Number.isFinite(saved.counts[k])) s.counts[k] = saved.counts[k];
        if (saved.shown && typeof saved.shown === 'object') s.shown = { ...saved.shown };
      }
      if (saved.focus && Number.isFinite(saved.focus.until)) s.focus = { until: saved.focus.until, startedAt: saved.focus.startedAt || 0 };
    }
    return s;
  }

  const every = (cfg) => ({ water: cfg.water.every * MIN, eyes: cfg.eyes.every * MIN, stretch: cfg.stretch.every * MIN, rest: cfg.rest.after * MIN });

  /**
   * One tick of time. Mutates and returns `state`, plus the reminder to show right now (or null).
   * @param {object} state  @param {{now:number, dt:number, active:boolean, inMeeting:boolean, day:string, minuteOfDay:number, weekday:number}} t  @param {object} cfg
   */
  function step(state, t, cfg) {
    if (state.day !== t.day) {
      const keep = { pausedUntil: state.pausedUntil, snoozeUntil: state.snoozeUntil, focus: state.focus };
      Object.assign(state, newState(t.day), keep);
    }
    if (t.active) {
      state.activeMs += t.dt; state.sinceWater += t.dt; state.sinceEyes += t.dt; state.sinceStretch += t.dt; state.sinceRest += t.dt; state.awayMs = 0;
    } else {
      state.awayMs += t.dt;
      if (state.awayMs >= AWAY_MS) { state.sinceEyes = 0; state.sinceStretch = 0; state.sinceRest = 0; } // a real break: eyes, legs and mind have rested
    }
    if (!cfg.enabled) return { state, nudge: null };

    if (state.focus) {
      if (t.now < state.focus.until) return { state, nudge: null }; // heads down: no interruptions
      state.focus = null;
      state.lastNudgeAt = t.now; state.sinceEyes = 0;
      return { state, nudge: { kind: 'focusEnd' } };
    }
    if (t.now < state.pausedUntil || t.now < state.snoozeUntil) return { state, nudge: null };
    if (inQuietHours(cfg, t.minuteOfDay) || (cfg.workdaysOnly && (t.weekday === 0 || t.weekday === 6))) return { state, nudge: null };
    if (!t.active || (cfg.pauseInMeetings && t.inMeeting)) return { state, nudge: null };
    if (t.now - state.lastNudgeAt < GAP_MS) return { state, nudge: null };

    const e = every(cfg);
    const once = (k) => state.shown[k] !== t.day;
    let kind = null;
    if (cfg.overwork.on && state.activeMs >= cfg.overwork.hours * 60 * MIN && once('overwork')) kind = 'overwork';
    else if (cfg.meal.on && t.minuteOfDay >= minutesOf(cfg.meal.at) && t.minuteOfDay < minutesOf(cfg.meal.at) + 120 && once('meal')) kind = 'meal';
    else if (cfg.wrapup.on && t.minuteOfDay >= minutesOf(cfg.wrapup.at) && once('wrapup')) kind = 'wrapup';
    else if (cfg.rest.on && state.sinceRest >= e.rest) kind = 'rest';
    else {
      // Among the everyday ones, the most overdue (compared with its own interval) goes first, so a short interval
      // (water every 5 minutes) can never starve a longer one (eyes every 10). Ties: stretch, then water, then eyes.
      const due = [['stretch', state.sinceStretch / e.stretch, cfg.stretch.on], ['water', state.sinceWater / e.water, cfg.water.on], ['eyes', state.sinceEyes / e.eyes, cfg.eyes.on]]
        .filter(([, ratio, on]) => on && ratio >= 1).sort((a, b) => b[1] - a[1]);
      if (due.length) kind = due[0][0];
    }
    if (!kind) return { state, nudge: null };

    state.lastNudgeAt = t.now;
    if (kind === 'overwork' || kind === 'meal' || kind === 'wrapup') state.shown[kind] = t.day;
    else if (kind === 'rest') { state.sinceRest = 0; state.sinceStretch = 0; state.sinceEyes = 0; }
    else if (kind === 'stretch') state.sinceStretch = 0;
    else if (kind === 'water') state.sinceWater = 0;
    else if (kind === 'eyes') state.sinceEyes = 0;
    return { state, nudge: { kind } };
  }

  /** The employee answered a reminder. 'done' counts it, 'snooze' brings it back in 10 minutes, 'skip' just lets it go. */
  function act(state, kind, action, now, cfg) {
    if (action === 'done') {
      if (kind in state.counts) state.counts[kind] += 1;
    } else if (action === 'snooze') {
      const e = every(cfg);
      if (kind in e) state[{ water: 'sinceWater', eyes: 'sinceEyes', stretch: 'sinceStretch', rest: 'sinceRest' }[kind]] = Math.max(0, e[kind] - SNOOZE_MS);
      else { delete state.shown[kind]; state.snoozeUntil = now + SNOOZE_MS; }
    }
    return state;
  }

  const pause = (state, minutes, now) => { state.pausedUntil = now + Math.max(1, Math.min(minutes, 24 * 60)) * MIN; return state; };
  const startFocus = (state, minutes, now) => { state.focus = { startedAt: now, until: now + Math.max(5, Math.min(minutes, 180)) * MIN }; return state; };
  const stopFocus = (state) => { state.focus = null; return state; };

  /** Minutes until each reminder is due (for the "next up" display). */
  function upcoming(state, cfg) {
    const e = every(cfg);
    const left = (k, since) => (cfg[k].on ? Math.max(0, Math.ceil((e[k] - since) / MIN)) : null);
    return { water: left('water', state.sinceWater), eyes: left('eyes', state.sinceEyes), stretch: left('stretch', state.sinceStretch), rest: left('rest', state.sinceRest) };
  }

  // ---- words ---------------------------------------------------------------------------------------

  const pick = (list, n) => list[n % list.length];

  /** The text for a reminder, varied so it never feels like a robot repeating itself. `n` is how many times it has been shown today. */
  function words(kind, { counts = {}, activeMs = 0, name = '', wrapupText = '' } = {}) {
    const n = counts[kind] || 0;
    const first = name ? `, ${name}` : '';
    switch (kind) {
      case 'water': return { title: 'Hydration check', body: pick([
        `Time for a glass of water${first}. ${n ? `That would be glass number ${n + 1} today.` : 'Your focus will thank you.'}`,
        'A quick sip break? Staying hydrated keeps your head clear.',
        `Water time${first}. Fill your glass while your code compiles.`], n), actions: ['done', 'snooze', 'skip'] };
      case 'eyes': return { title: 'Rest your eyes', body: pick([
        'Look at something about 20 feet away for 20 seconds, and blink slowly a few times.',
        'Eye break: look out of the window for 20 seconds. Blink, blink, blink.',
        'Give your eyes a rest. Focus on something far away for 20 seconds and blink gently.'], n), actions: ['start', 'done', 'snooze'], timer: 20 };
      case 'stretch': return { title: 'Stretch it out', body: pick([
        'Stand up, roll your shoulders back and stretch your neck gently from side to side.',
        'Time to move: stand, reach up high, and open your chest for a few breaths.',
        'Check your posture: feet flat, shoulders down, screen at eye level. Then stand and stretch.'], n), actions: ['done', 'snooze', 'skip'] };
      case 'rest': return { title: 'Take a real break', body: pick([
        `You've been going for a while${first}. A 5-minute walk will help you come back sharper.`,
        'Long stretch without a break. Step away for five minutes: water, window, walk.'], n), actions: ['breathe', 'done', 'snooze'] };
      case 'meal': return { title: 'Lunch time', body: pick([
        `It's lunch time${first}. Step away from the screen and eat something good.`,
        'Time to refuel. Your afternoon self will be glad you ate properly.'], n), actions: ['done', 'snooze', 'skip'] };
      case 'overwork': return { title: 'A long day', body: `You've been active for about ${Math.round(activeMs / 3600000)} hours today${first}. Consider wrapping up soon. Rest is part of the work.`, actions: ['done', 'snooze', 'skip'] };
      case 'wrapup': return { title: 'Wrapping up the day', body: wrapupText || `Nice work today${first}. Tidy up, note tomorrow's first task, and log off on time.`, actions: ['open', 'done', 'snooze'] };
      case 'focusEnd': return { title: 'Focus session complete', body: `Well done${first}! Take a few minutes to stretch and rest your eyes.`, actions: ['breathe', 'done'] };
      default: return { title: 'Orbit', body: '', actions: ['done'] };
    }
  }

  return { DEFAULTS, RANGES, MIN, GAP_MS, AWAY_MS, SNOOZE_MS, MEETING_RE, sanitizeCare, shouldHideCompanion, inQuietApp, inQuietHours, newState, restore, step, act, pause, startFocus, stopFocus, upcoming, words, minutesOf };
}));
