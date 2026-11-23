'use strict';
// Orbit: pure helpers shared by the app window, the greeting window and the main process (and tested with require()).
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.OrbitLogic = factory();
}(typeof self !== 'undefined' ? self : this, () => {
  const COLORS = [
    { id: 'violet', name: 'Violet', hex: '#7C5CFF' }, { id: 'ocean', name: 'Ocean', hex: '#2BA8FF' }, { id: 'mint', name: 'Mint', hex: '#18C79B' },
    { id: 'sunset', name: 'Sunset', hex: '#FF7A59' }, { id: 'rose', name: 'Rose', hex: '#FF5C93' }, { id: 'gold', name: 'Gold', hex: '#F5B83D' },
  ];
  const STYLES = [
    { id: 'aurora', name: 'Aurora', hint: 'Soft flowing light' }, { id: 'pulse', name: 'Pulse', hint: 'Calm breathing rings' },
    { id: 'particles', name: 'Orbit', hint: 'Tiny moons circling' }, { id: 'wave', name: 'Voice', hint: 'A ring that dances as I talk' },
  ];
  const SOUNDS = [
    { id: 'chime', name: 'Chime', hint: 'Warm bell tones' }, { id: 'soft', name: 'Soft', hint: 'Gentle low notes' },
    { id: 'sparkle', name: 'Sparkle', hint: 'Bright, playful' }, { id: 'off', name: 'Silent', hint: 'No sounds' },
  ];
  const DOCKS = [
    { id: 'top-left', name: 'Top left' }, { id: 'top-right', name: 'Top right' },
    { id: 'bottom-left', name: 'Bottom left' }, { id: 'bottom-right', name: 'Bottom right' },
  ];
  const SIZES = [{ id: 's', name: 'Small', px: 84 }, { id: 'm', name: 'Medium', px: 112 }, { id: 'l', name: 'Large', px: 150 }];
  // `show`: the companion floats on screen. `dock`: which corner (or 'free' after being dragged to `x`,`y`).
  const ANIMAL_IDS = ['otter', 'redpanda', 'owl', 'sloth'];
  const AVATARS = ['orb', ...ANIMAL_IDS];
  /** Every moment an animal friend can act out, who does it by default, and when it happens. */
  const EVENTS = [
    { id: 'greet', label: 'Daily hello', animal: 'redpanda', when: () => 'The first time you open your laptop each day' },
    { id: 'welcome', label: 'Welcome back', animal: 'redpanda', when: (p) => (p.welcomeBack ? `When you come back after ${p.welcomeBack}+ minutes away` : 'Off (set "Welcome me back" above)') },
    { id: 'checkin', label: 'Weekend check-in', animal: 'sloth', when: () => 'On weekends, when you open your laptop' },
    { id: 'water', label: 'Drink water', animal: 'otter', when: (p, c) => (c.water.on ? `Every ${c.water.every} minutes of active work` : 'Off') },
    { id: 'eyes', label: 'Rest your eyes', animal: 'owl', when: (p, c) => (c.eyes.on ? `Every ${c.eyes.every} minutes of active work (20-20-20)` : 'Off') },
    { id: 'stretch', label: 'Stretch', animal: 'redpanda', when: (p, c) => (c.stretch.on ? `Every ${c.stretch.every} minutes of active work` : 'Off') },
    { id: 'rest', label: 'Take a break', animal: 'sloth', when: (p, c) => (c.rest.on ? `After ${c.rest.after} minutes without a break` : 'Off') },
    { id: 'meal', label: 'Lunch', animal: 'redpanda', when: (p, c) => (c.meal.on ? `At ${c.meal.at}` : 'Off') },
    { id: 'wrapup', label: 'Wrap up the day', animal: 'redpanda', when: (p, c) => (c.wrapup.on ? `At ${c.wrapup.at}` : 'Off') },
    { id: 'overwork', label: 'Long day', animal: 'sloth', when: (p, c) => (c.overwork.on ? `After ${c.overwork.hours} active hours` : 'Off') },
    { id: 'focusEnd', label: 'Focus session over', animal: 'sloth', when: () => 'When a focus session ends' },
  ];
  const DEFAULT_BUDDIES = Object.fromEntries(EVENTS.map((e) => [e.id, e.animal]));
  const DEFAULTS = { name: 'Orbit', avatar: 'redpanda', buddies: DEFAULT_BUDDIES, color: '#7C5CFF', style: 'aurora', sound: 'chime', volume: 0.35, speak: false, greet: true, motion: true, show: true, dock: 'bottom-right', size: 'm', x: null, y: null, welcomeBack: 20, buddy: 'animals' };

  const HEX = /^#[0-9a-fA-F]{6}$/;

  /** Whatever the window sends is untrusted: keep only known keys with valid values. */
  function sanitizePersona(input, base = DEFAULTS) {
    const p = { ...DEFAULTS, ...base };
    const i = input && typeof input === 'object' ? input : {};
    if (typeof i.name === 'string') {
      const n = i.name.replace(/[^\p{L}\p{N} .'-]/gu, '').trim().slice(0, 24);
      if (n) p.name = n;
    }
    if (typeof i.color === 'string' && HEX.test(i.color)) p.color = i.color.toUpperCase();
    if (STYLES.some((s) => s.id === i.style)) p.style = i.style;
    if (SOUNDS.some((s) => s.id === i.sound)) p.sound = i.sound;
    if (typeof i.volume === 'number' && Number.isFinite(i.volume)) p.volume = Math.min(1, Math.max(0, Math.round(i.volume * 100) / 100));
    for (const k of ['speak', 'greet', 'motion', 'show']) if (typeof i[k] === 'boolean') p[k] = i[k];
    if (DOCKS.some((d) => d.id === i.dock)) { p.dock = i.dock; p.x = null; p.y = null; } // picking a corner forgets a dragged position
    if (i.dock === 'free' && Number.isFinite(i.x) && Number.isFinite(i.y)) { p.dock = 'free'; p.x = Math.round(i.x); p.y = Math.round(i.y); }
    if (SIZES.some((z) => z.id === i.size)) p.size = i.size;
    if (AVATARS.includes(i.avatar)) p.avatar = i.avatar; // who lives on screen: the orb or one of the animals
    p.buddies = { ...DEFAULT_BUDDIES, ...(p.buddies && typeof p.buddies === 'object' ? p.buddies : {}) };
    if (i.buddies && typeof i.buddies === 'object') for (const e of EVENTS) if (ANIMAL_IDS.includes(i.buddies[e.id]) || i.buddies[e.id] === 'none') p.buddies[e.id] = i.buddies[e.id];
    for (const e of EVENTS) if (!ANIMAL_IDS.includes(p.buddies[e.id]) && p.buddies[e.id] !== 'none') p.buddies[e.id] = e.animal;
    if (i.buddy === 'animals' || i.buddy === 'orb') p.buddy = i.buddy; // animal friends act out reminders, or just the orb
    if (Number.isFinite(i.welcomeBack)) p.welcomeBack = Math.min(240, Math.max(0, Math.round(i.welcomeBack))); // minutes away before a "welcome back" (0 = never)
    if (!DOCKS.some((d) => d.id === p.dock) && p.dock !== 'free') p.dock = DEFAULTS.dock;
    if (p.dock !== 'free') { p.x = null; p.y = null; }
    return p;
  }

  function salutation(hour) {
    if (hour >= 5 && hour < 12) return 'Good morning';
    if (hour >= 12 && hour < 17) return 'Good afternoon';
    if (hour >= 17 && hour < 21) return 'Good evening';
    return 'Hello';
  }

  const firstName = (full) => String(full || '').trim().split(/\s+/)[0] || 'there';

  /** Shown instantly (and when the server can't be reached): the same words the server would pick. */
  function localGreeting(fullName, date = new Date()) {
    const s = salutation(date.getHours());
    return { salutation: s, name: firstName(fullName), text: `${s}, ${firstName(fullName)}!` };
  }

  /** The laptop's clock as ISO-8601 with its UTC offset (the server never guesses a time zone). */
  function localIso(d = new Date()) {
    const pad = (n, w = 2) => String(Math.abs(n)).padStart(w, '0');
    const off = -d.getTimezoneOffset();
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`
      + `${off >= 0 ? '+' : '-'}${pad(Math.floor(Math.abs(off) / 60))}:${pad(Math.abs(off) % 60)}`;
  }

  const dayKey = (d = new Date()) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;

  /** Greet once per local calendar day, only when the employee hasn't switched it off and the laptop is connected. */
  function shouldGreet({ enabled = true, enrolled = false, lastDay = '', today = dayKey() } = {}) {
    return Boolean(enabled && enrolled && lastDay !== today);
  }

  const PRIORITY = { urgent: { label: 'Urgent', tone: 'bad' }, high: { label: 'High', tone: 'warn' }, medium: { label: 'Medium', tone: 'info' }, low: { label: 'Low', tone: 'mute' } };
  const STATUS = { todo: 'To do', in_progress: 'In progress', blocked: 'Blocked', done: 'Done' };
  const REC_STATUS = { pending: { label: 'Waiting for your admin', tone: 'warn' }, approved: { label: 'Approved', tone: 'ok' }, rejected: { label: 'Not this time', tone: 'mute' } };
  const VERDICT = { SAFE: { label: 'Comfortable', tone: 'ok' }, AT_RISK: { label: 'Tight', tone: 'warn' }, OVERLOAD: { label: 'Overloaded', tone: 'bad' } };

  function hexToRgb(hex) {
    const m = HEX.test(hex) ? hex.slice(1) : DEFAULTS.color.slice(1);
    return [parseInt(m.slice(0, 2), 16), parseInt(m.slice(2, 4), 16), parseInt(m.slice(4, 6), 16)];
  }

  /** What the orb says when the person comes back to the laptop: short, specific, and an invitation to start. */
  function welcomeBackText({ name = '', tasks = null, hour = 12 } = {}) {
    const who = firstName(name);
    const open = tasks && (tasks.openCount || 0) > 0 ? [...(tasks.overdue || []), ...(tasks.dueToday || []), ...(tasks.upcoming || []), ...(tasks.later || [])][0] : null;
    const hello = hour < 5 || hour >= 21 ? `Welcome back, ${who}!` : `${salutation(hour)} again, ${who}!`;
    if (!tasks) return `${hello} I'm here whenever you're ready to pick things up.`;
    if (!open) return `${hello} You have no open tasks right now. Want to plan what's next?`;
    const late = (tasks.overdue || []).length ? ' It is overdue, so it is a good place to start.' : (tasks.dueToday || []).length ? ' It is due today.' : '';
    return `${hello} Next up: \u201c${open.title}\u201d.${late} Ready to pick it up?`;
  }

  // ---- weekend check-in: a calm "what brings you in?" instead of a stern warning ----------------------

  const DAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
  const ymd = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;

  function dueLabel(due, now = new Date()) {
    if (!due) return '';
    const today = ymd(now);
    const tomorrow = ymd(new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1));
    if (due < today) return 'overdue';
    if (due === today) return 'due today';
    if (due === tomorrow) return 'due tomorrow';
    const d = new Date(`${due}T00:00:00`);
    return Number.isNaN(d.getTime()) ? '' : `due ${DAYS[d.getDay()]}`;
  }

  /** High-priority open work that could genuinely need someone at the weekend: overdue, due today, or due in the next two days. */
  function pickUrgentTasks(sections, now = new Date()) {
    if (!sections) return [];
    const horizon = ymd(new Date(now.getFullYear(), now.getMonth(), now.getDate() + 2));
    const rank = { urgent: 0, high: 1 };
    return [...(sections.overdue || []), ...(sections.dueToday || []), ...(sections.upcoming || [])]
      .filter((t) => t && t.priority in rank && t.status !== 'done' && (!t.dueDate || t.dueDate <= horizon))
      .sort((a, b) => rank[a.priority] - rank[b.priority] || String(a.dueDate || '9').localeCompare(String(b.dueDate || '9')))
      .slice(0, 2);
  }

  /** What the orb asks, and the answers it offers. Reasons come from the company's own weekend policy. */
  function weekendCheckIn({ name = '', urgent = [], reasons = [], now = new Date() } = {}) {
    const who = firstName(name);
    const day = DAYS[now.getDay()];
    const first = urgent[0];
    const text = first
      ? `It's ${day}, ${who}. I noticed \u201c${first.title}\u201d is ${first.priority} priority and ${dueLabel(first.dueDate, now) || 'open'}. Is that what brought you in? No pressure, I'm just checking in.`
      : `It's ${day}, ${who}, and I don't see any urgent work assigned to you. Is something that can't wait, or are you just taking a quick look? No pressure.`;
    const choices = [];
    urgent.forEach((t, i) => choices.push({ id: `task:${i}`, label: `Working on: ${String(t.title).slice(0, 38)}`, reason: 'Assigned high-priority task', details: String(t.title).slice(0, 200) }));
    reasons.filter((r) => r && !/^other$/i.test(r)).slice(0, 4).forEach((r, i) => choices.push({ id: `reason:${i}`, label: String(r).slice(0, 40), reason: String(r).slice(0, 200), details: '' }));
    choices.push({ id: 'look', label: 'Just a quick look', reason: '', details: '' });
    return { text, choices };
  }

  const replyFor = (choice) => (!choice || choice.id === 'look'
    ? "No problem. Enjoy the rest of your weekend."
    : "Thanks for letting me know. I've noted it for your admin. Pace yourself, and take a proper break after.");

  /** The key combination that toggles Presenting mode from anywhere (shown in menus). */
  const PRESENTING_SHORTCUT = 'CommandOrControl+Alt+Shift+O';
  /** Shows or hides the companion from anywhere, even if the menu bar icon can't be found (e.g. tucked away by the notch). */
  const COMPANION_SHORTCUT = 'CommandOrControl+Alt+Shift+A';

  const MARGIN = 20;
  const BUBBLE_W = 340;
  const BUBBLE_H = 340;

  /**
   * Where the companion's window goes. The window is the orb plus room for a speech bubble beside/above/below it; it ignores mouse clicks
   * everywhere except on the orb and bubble, so it never blocks the apps underneath.
   * @param {{dock:string,size:string,x:?number,y:?number}} persona  @param {{x:number,y:number,width:number,height:number}} workArea
   */
  function placement(persona, workArea) {
    const px = (SIZES.find((z) => z.id === persona.size) || SIZES[1]).px;
    const width = BUBBLE_W; const height = px + BUBBLE_H;
    const clamp = (v, lo, hi) => Math.min(Math.max(v, lo), Math.max(lo, hi));
    let x; let y;
    if (persona.dock === 'free' && Number.isFinite(persona.x) && Number.isFinite(persona.y)) {
      x = clamp(persona.x, workArea.x, workArea.x + workArea.width - width);
      y = clamp(persona.y, workArea.y, workArea.y + workArea.height - height);
    } else {
      const right = String(persona.dock).endsWith('right');
      const bottom = String(persona.dock).startsWith('bottom');
      x = right ? workArea.x + workArea.width - width - MARGIN : workArea.x + MARGIN;
      y = bottom ? workArea.y + workArea.height - height - MARGIN : workArea.y + MARGIN;
    }
    const side = persona.dock === 'free' ? (x + width / 2 > workArea.x + workArea.width / 2 ? 'right' : 'left') : (String(persona.dock).endsWith('right') ? 'right' : 'left');
    const vert = persona.dock === 'free' ? (y + height / 2 > workArea.y + workArea.height / 2 ? 'bottom' : 'top') : (String(persona.dock).startsWith('bottom') ? 'bottom' : 'top');
    return { x: Math.round(x), y: Math.round(y), width, height, orbPx: px, side, vert };
  }

  return { COMPANION_SHORTCUT, PRESENTING_SHORTCUT, AVATARS, ANIMAL_IDS, EVENTS, DEFAULT_BUDDIES, dueLabel, pickUrgentTasks, weekendCheckIn, replyFor, welcomeBackText, DOCKS, SIZES, placement, COLORS, STYLES, SOUNDS, DEFAULTS, sanitizePersona, salutation, firstName, localGreeting, localIso, dayKey, shouldGreet, PRIORITY, STATUS, REC_STATUS, VERDICT, hexToRgb };
}));
