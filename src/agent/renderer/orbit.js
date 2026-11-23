'use strict';
/* global agent, OrbitLogic, OrbitOrb, OrbitSound, OrbitBuddies, state, view, esc, icon, go */
// "Orbit" page: the employee's personal work companion. A greeting, the day at a glance, a chat that knows their tasks,
// workload, achievements and appreciation, and a customiser for the companion's name, colour, motion and sounds.
// All text from the server is shown with textContent / esc(); nothing from the model is ever inserted as HTML.

// Everything lives inside OrbitPage so it can't clash with the install page's functions (drawRail, drawThread, send...).
const OrbitPage = (() => {
const orb = {
  inited: false, messages: [], busy: false, brief: null, briefAt: 0, tasks: null, ach: null, persona: { ...OrbitLogic.DEFAULTS },
  ctl: null, identity: { name: '', enrolled: false }, sig: {}, greeted: false, typing: null, error: null, mode: 'ok', care: null, careTimer: null,
};

const ORBIT_MAX = 1000;
const $o = (sel) => document.querySelector(sel);

function personaApply() {
  const p = orb.persona;
  const page = $o('.orbit-page');
  if (page) page.style.setProperty('--o', p.color);
  orb.ctl?.setColor(p.color); orb.ctl?.setStyle(p.style); orb.ctl?.setMotion(p.motion);
  const title = $o('#orbit-title');
  if (title) title.textContent = p.name;
}

async function loadPersona() {
  orb.persona = OrbitLogic.sanitizePersona(await agent.orbit.persona().catch(() => null), OrbitLogic.DEFAULTS);
  orb.identity = await agent.orbit.identity().catch(() => orb.identity);
}

async function renderOrbit() {
  await loadPersona();
  if (state.page !== 'orbit') return;
  const first = OrbitLogic.localGreeting(orb.identity.name);
  view.innerHTML = `
    <header class="topbar"><div><h1 id="orbit-title">${esc(orb.persona.name)}</h1><div class="sub">Your work companion: tasks, progress and a friendly push</div></div>
      <div class="controls"><button class="btn" id="o-custom">${icon('settings', 14)} Customise</button></div></header>
    <div class="orbit-page" style="--o:${esc(orb.persona.color)}">
      <section class="orbit-main">
        <div class="orbit-hero">
          <canvas class="orbit-canvas" id="o-canvas" aria-hidden="true"></canvas>
          <div class="orbit-hello">
            <h2 class="orbit-greet" id="o-greet">${esc(first.text)}</h2>
            <p class="orbit-msg" id="o-msg" aria-live="polite"></p>
            <div class="orbit-ask" id="o-ask">How can I help you today?</div>
            <div class="orbit-starters" id="o-starters"></div>
          </div>
        </div>
        <div class="orbit-chat">
          <div class="o-scroll" id="o-scroll" role="log" aria-live="polite" aria-label="Conversation"><div class="o-thread" id="o-thread"></div></div>
          <form class="o-composer" id="o-form" autocomplete="off">
            <label class="sr-only" for="o-input">Message ${esc(orb.persona.name)}</label>
            <textarea id="o-input" rows="1" maxlength="${ORBIT_MAX}" placeholder="Ask about your tasks, time, progress…"></textarea>
            <button type="submit" class="btn primary" id="o-send" aria-label="Send">${icon('send', 15)}</button>
          </form>
        </div>
      </section>
      <aside class="orbit-rail" id="o-rail" aria-label="Your day"></aside>
    </div>`;
  orb.ctl?.destroy();
  orb.ctl = OrbitOrb.create($o('#o-canvas'), { color: orb.persona.color, style: orb.persona.style, motion: orb.persona.motion });
  orb.sig = {};
  if (!orb.messages.length) orb.messages.push({ role: 'assistant', local: true, text: `Hi ${OrbitLogic.firstName(orb.identity.name)}, I'm ${orb.persona.name}. Ask me what to focus on, how your week looks, or what you've achieved. I can also send your wins to your admin.` });
  drawStarters();
  drawThread();
  $o('#o-custom').addEventListener('click', openCustomiser);
  const input = $o('#o-input');
  input.addEventListener('input', () => { autoGrow(input); orb.ctl?.setState(input.value.trim() ? 'listening' : 'idle'); });
  input.addEventListener('keydown', (e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); $o('#o-form').requestSubmit(); } });
  $o('#o-form').addEventListener('submit', (e) => { e.preventDefault(); const t = input.value.trim(); if (t) { input.value = ''; autoGrow(input); send(t); } });
  $o('#o-starters').addEventListener('click', (e) => { const b = e.target.closest('[data-q]'); if (b) send(b.dataset.q); });
  input.focus();
  agent.orbit.poke();
  clearInterval(orb.careTimer);
  orb.careTimer = setInterval(() => { if (state.page === 'orbit' && !document.hidden) loadCare(); }, 20000);
  await Promise.all([loadBriefing(), loadTasks(), loadAchievements(), loadCare()]);
}

function autoGrow(el) { el.style.height = 'auto'; el.style.height = `${Math.min(el.scrollHeight, 120)}px`; }

function drawStarters() {
  const el = $o('#o-starters');
  if (!el) return;
  const list = orb.brief?.starters || ['What should I focus on first?', 'What tasks are due this week?', 'What have I achieved lately?'];
  el.innerHTML = list.slice(0, 5).map((q) => `<button class="chip" data-q="${esc(q)}">${esc(q)}</button>`).join('');
}

// ---- greeting & briefing -------------------------------------------------------------------------

async function loadBriefing() {
  if (orb.brief && Date.now() - orb.briefAt < 20 * 60 * 1000 && !orb.error) { showBrief(false); return; }
  const r = await agent.orbit.briefing();
  if (state.page !== 'orbit') return;
  if (!r.ok) {
    orb.error = r;
    $o('#o-msg').textContent = r.code === 'orbit_disabled' ? r.error : `${r.error}`;
    $o('#o-ask').hidden = true;
    return;
  }
  orb.error = null; orb.brief = r.data; orb.briefAt = Date.now();
  showBrief(!orb.greeted);
}

function showBrief(announce) {
  const b = orb.brief;
  if (!b || !$o('#o-greet')) return;
  $o('#o-greet').textContent = b.greeting.text;
  $o('#o-ask').hidden = false;
  drawStarters();
  const demo = b.workData === 'simulated' ? ' (meetings and commits shown here are demo data)' : '';
  if (announce) {
    orb.greeted = true;
    OrbitSound.play('greet', orb.persona);
    typewrite($o('#o-msg'), b.message, () => { if (demo) $o('#o-msg').textContent += demo; });
    OrbitSound.speak(`${b.greeting.text} ${b.message}`, orb.persona);
  } else {
    $o('#o-msg').textContent = b.message + demo;
  }
}

/** Words appear one by one while the orb "talks". Skipped (instant) when motion is reduced. */
function typewrite(el, text, done) {
  clearInterval(orb.typing);
  if (!orb.persona.motion || (typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches)) { el.textContent = text; done?.(); return; }
  const words = String(text).split(/(\s+)/);
  let i = 0;
  el.textContent = '';
  orb.ctl?.setState('speaking');
  orb.typing = setInterval(() => {
    if (!el.isConnected) { clearInterval(orb.typing); return; }
    el.textContent += words[i++] || '';
    orb.ctl?.level(0.5 + Math.random() * 0.5);
    if (i >= words.length) { clearInterval(orb.typing); orb.ctl?.setState('idle'); done?.(); }
  }, 38);
}

// ---- chat ----------------------------------------------------------------------------------------

function drawThread() {
  const t = $o('#o-thread');
  if (!t) return;
  t.innerHTML = '';
  for (const m of orb.messages) t.appendChild(msgNode(m));
  if (orb.busy) t.appendChild(dotsNode());
  scrollDown();
}

function msgNode(m) {
  const d = document.createElement('div');
  d.className = `o-msg ${m.role === 'user' ? 'me' : m.error ? 'err' : 'bot'}`;
  const p = document.createElement('span');
  p.textContent = m.text;
  d.appendChild(p);
  if (m.note) { const n = document.createElement('span'); n.className = 'o-note'; n.textContent = m.note; d.appendChild(n); }
  if (m.actions?.length || m.retry) {
    const row = document.createElement('div'); row.className = 'o-actions';
    for (const a of m.actions || []) {
      if (a.type !== 'goto' || !['install', 'orbit', 'overview'].includes(a.page)) continue;
      const b = document.createElement('button'); b.className = 'btn sm'; b.textContent = a.page === 'install' ? 'Open Install software' : 'Show me';
      b.addEventListener('click', () => go(a.page)); row.appendChild(b);
    }
    if (m.retry) { const b = document.createElement('button'); b.className = 'btn sm'; b.textContent = 'Try again'; b.addEventListener('click', () => retry()); row.appendChild(b); }
    d.appendChild(row);
  }
  return d;
}

const dotsNode = () => { const d = document.createElement('div'); d.className = 'o-dots'; d.setAttribute('aria-label', 'Thinking'); d.innerHTML = '<i></i><i></i><i></i>'; return d; };
const scrollDown = () => { const s = $o('#o-scroll'); if (s) s.scrollTop = s.scrollHeight; };

function history() {
  return orb.messages.filter((m) => !m.error && !m.local).slice(-19).map((m) => ({ role: m.role === 'user' ? 'user' : 'assistant', content: m.text }));
}

async function send(text) {
  if (orb.busy) return;
  const clean = String(text).trim().slice(0, ORBIT_MAX);
  if (!clean) return;
  orb.messages = orb.messages.filter((m) => !m.error);
  orb.messages.push({ role: 'user', text: clean });
  orb.busy = true; orb.lastAsk = clean;
  OrbitSound.play('send', orb.persona);
  orb.ctl?.setState('thinking');
  drawThread();
  const r = await agent.orbit.chat(history(), orb.persona.name);
  orb.busy = false;
  if (state.page !== 'orbit') return;
  if (!r.ok) {
    orb.messages.push({ role: 'assistant', text: r.error || 'I could not answer just now.', error: true, retry: r.code !== 'orbit_disabled' && r.code !== 'not_enrolled' });
    orb.ctl?.setState('idle');
    drawThread();
    return;
  }
  const bot = { role: 'assistant', text: r.data.reply, actions: r.data.actions || [], note: r.data.source === 'rules' ? 'Quick answer. My smarter chat is offline right now.' : '' };
  orb.messages.push(bot);
  OrbitSound.play('receive', orb.persona);
  drawThread();
  const node = $o('#o-thread').lastElementChild?.firstElementChild;
  if (node) typewrite(node, bot.text, scrollDown);
  OrbitSound.speak(bot.text, orb.persona);
}

function retry() { const last = orb.lastAsk; orb.messages = orb.messages.filter((m) => !m.error); if (last) { orb.messages.pop(); send(last); } }

// ---- the rail: tasks, workload, achievements, appreciation ---------------------------------------

async function loadTasks() {
  const r = await agent.orbit.tasks();
  if (state.page !== 'orbit') return;
  orb.tasks = r.ok ? r.data : null;
  drawRail();
}

async function loadAchievements() {
  const r = await agent.orbit.achievements();
  if (state.page !== 'orbit') return;
  orb.ach = r.ok ? r.data : null;
  drawRail();
}

async function loadCare() {
  const r = await agent.orbit.care.get().catch(() => null);
  if (state.page !== 'orbit' || !r) return;
  orb.care = r;
  drawRail();
}

const CareLogicDefaults = () => ({ water: { on: true, every: 60 }, eyes: { on: true, every: 20 }, stretch: { on: true, every: 50 }, rest: { on: true, after: 100 }, meal: { on: true, at: '13:00' }, wrapup: { on: true, at: '17:45' }, overwork: { on: true, hours: 9 } });

const fmtMins = (ms) => { const m = Math.round(ms / 60000); return m >= 60 ? `${Math.floor(m / 60)}h ${m % 60}m` : `${m}m`; };

function wellbeingCard() {
  const c = orb.care;
  if (!c) return '';
  const { config: cfg, snapshot: sn } = c;
  const stat = (n, label) => `<div style="text-align:center"><div style="font:700 22px var(--font-display)">${esc(n)}</div><div class="muted small">${esc(label)}</div></div>`;
  const next = [['water', 'Water'], ['eyes', 'Eyes'], ['stretch', 'Stretch'], ['rest', 'Break']].filter(([k]) => sn.upcoming[k] != null && cfg.enabled)
    .map(([k, l]) => `${l} in ${sn.upcoming[k]} min`).join(' · ');
  const focus = sn.focus ? `<div class="o-win" style="margin:10px 0 0"><div class="t">Focus session</div><div class="c">Until ${esc(new Date(sn.focus.until).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }))}. No interruptions.</div></div>` : '';
  const paused = sn.pausedUntil ? `<div class="muted small" style="margin-top:8px">Reminders paused until ${esc(new Date(sn.pausedUntil).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }))}.</div>` : '';
  return `<section class="o-card" id="o-care"><h3>Take care <span class="sub">${cfg.enabled ? `Active ${esc(fmtMins(sn.activeMs))} today` : 'Reminders off'}</span></h3>
    <div style="display:grid;grid-template-columns:repeat(4,1fr);gap:8px;margin-bottom:10px">${stat(sn.counts.water, 'Water')}${stat(sn.counts.eyes, 'Eye rests')}${stat(sn.counts.stretch, 'Stretches')}${stat(sn.counts.rest, 'Breaks')}</div>
    ${next ? `<div class="muted small">Next: ${esc(next)}</div>` : ''}${focus}${paused}
    <div style="display:flex;gap:8px;flex-wrap:wrap;margin-top:12px">
      <button class="btn sm" data-care="water">I drank water</button>
      ${sn.focus ? '<button class="btn sm" data-care="focus-stop">Stop focus</button>' : '<button class="btn sm primary" data-care="focus">Focus 25 min</button>'}
      ${sn.pausedUntil ? '<button class="btn sm" data-care="resume">Resume</button>' : '<button class="btn sm" data-care="pause">Pause 1 hour</button>'}
      <button class="btn sm ${c.presenting ? 'primary' : ''}" data-care="presenting" title="Hides me completely (even from screen shares) until you turn it off">${c.presenting ? 'Stop presenting mode' : 'Presenting mode'}</button>
      <button class="btn sm ghost" data-care="settings">Reminders…</button></div></section>`;
}

function drawRail() {
  const rail = $o('#o-rail');
  if (!rail) return;
  const html = [tasksCard(), wellbeingCard(), workloadCard(), achievementsCard(), appreciationCard()].join('');
  if (orb.sig.rail === html) return; // unchanged: leave the DOM alone so nothing blinks
  const keep = document.activeElement?.closest?.('#o-extra') ? { t: $o('#x-title')?.value, d: $o('#x-details')?.value } : null;
  orb.sig.rail = html;
  rail.innerHTML = html;
  if (keep) { $o('#x-title').value = keep.t || ''; $o('#x-details').value = keep.d || ''; }
  bindRail(rail);
}

const dueText = (t) => {
  if (!t.dueDate) return 'No due date';
  const d = new Date(`${t.dueDate}T00:00:00`);
  return `Due ${d.toLocaleDateString(undefined, { weekday: 'short', day: 'numeric', month: 'short' })}`;
};

function taskRow(t, late) {
  const pr = OrbitLogic.PRIORITY[t.priority] || OrbitLogic.PRIORITY.medium;
  const opts = (map, cur) => Object.entries(map).map(([k, v]) => `<option value="${esc(k)}" ${k === cur ? 'selected' : ''}>${esc(v)}</option>`).join('');
  const pct = [...new Set([0, 25, 50, 75, 100, t.percent])].sort((a, b) => a - b).map((p) => `<option value="${p}" ${p === t.percent ? 'selected' : ''}>${p}%</option>`).join('');
  return `<div class="o-task p-${esc(t.priority)}" data-task="${esc(t.id)}"><span class="bar"></span><div>
    <div class="t">${esc(t.title)}</div>
    <div class="m"><span class="${late ? 'late' : ''}">${esc(dueText(t))}</span><span>${esc(pr.label)}</span>${t.estimatedHours ? `<span>${esc(t.estimatedHours)}h</span>` : ''}</div>
    ${t.description ? `<div class="m">${esc(t.description)}</div>` : ''}
    <div class="ctl"><select data-status aria-label="Status">${opts(OrbitLogic.STATUS, t.status)}</select><select data-pct aria-label="Progress">${pct}</select></div></div></div>`;
}

function tasksCard() {
  const s = orb.tasks;
  if (!s) return `<section class="o-card"><h3>Your tasks</h3><p class="o-empty">${orb.error ? 'Connect to see your tasks.' : 'Loading…'}</p></section>`;
  const groups = [['Overdue', s.overdue, true], ['Due today', s.dueToday], ['This week', s.upcoming], ['Later', s.later]].filter(([, rows]) => rows?.length);
  const body = groups.length ? groups.map(([name, rows, late]) => `<div class="o-group">${esc(name)}</div>${rows.map((t) => taskRow(t, late)).join('')}`).join('')
    : '<p class="o-empty">No open tasks. A good moment to learn something new, or help a teammate.</p>';
  return `<section class="o-card"><h3>Your tasks <span class="sub">${esc(s.openCount)} open</span></h3>${body}</section>`;
}

function workloadCard() {
  const c = orb.tasks?.capacity;
  if (!c) return '';
  const v = OrbitLogic.VERDICT[c.verdict] || OrbitLogic.VERDICT.SAFE;
  const pctUsed = c.availableHours > 0 ? Math.min(100, Math.round((c.pendingHours / c.availableHours) * 100)) : (c.pendingHours > 0 ? 100 : 0);
  return `<section class="o-card"><h3>This week's workload <span class="o-pill ${v.tone}">${esc(v.label)}</span></h3>
    <div class="o-meter ${v.tone === 'ok' ? '' : v.tone}"><i style="width:${pctUsed}%"></i></div>
    <div class="m muted small">${esc(c.pendingHours)}h of work due · ${esc(c.availableHours)}h available${c.meetingHours ? ` after ${esc(c.meetingHours)}h of meetings` : ''}</div></section>`;
}

function achievementsCard() {
  const a = orb.ach;
  if (!a) return '';
  const gem = (id) => ({ finisher: 'check', punctual: 'clock', steady: 'spark', deepfocus: 'eye', appreciated: 'bell' }[id] || 'spark');
  const rows = a.milestones.map((m) => {
    const pct = m.maxed ? 100 : Math.min(100, Math.round((m.value / m.target) * 100));
    return `<div class="o-badge ${m.earned ? 'on' : ''}"><span class="gem">${icon(gem(m.id), 18)}</span><div><div class="n">${esc(m.title)}${m.level ? `<span class="o-pill">Level ${esc(m.level)}</span>` : ''}</div>
      <div class="d">${esc(m.detail)}: ${esc(m.value)}${m.maxed ? ' · top level!' : ` of ${esc(m.target)}`}</div><div class="bar"><i style="width:${pct}%"></i></div></div></div>`;
  }).join('');
  return `<section class="o-card"><h3>Achievements <span class="o-pill ok">${esc(a.credits)} credits</span></h3>${rows}</section>`;
}

function appreciationCard() {
  const a = orb.ach;
  if (!a) return '';
  const wins = a.suggestions.map((s) => `<div class="o-win"><div class="t">${esc(s.title)}</div><div class="c">${esc(s.citation)}</div>
    <button class="btn sm primary" data-send="${esc(s.dedupeKey)}">${icon('send', 12)} Send to admin</button></div>`).join('');
  const recs = a.recognitions.slice(0, 6).map((r) => {
    const st = OrbitLogic.REC_STATUS[r.status] || OrbitLogic.REC_STATUS.pending;
    return `<div class="o-rec"><div class="l"><b>${esc(r.title)}</b><span>${esc(st.label)}${r.reward ? ` · ${esc(r.reward)}` : ''}${r.credits && r.status === 'approved' ? ` · +${esc(r.credits)} credits` : ''}</span></div>
      ${r.status === 'approved' ? `<button class="btn sm" data-cert="${esc(r.id)}">Certificate</button>` : `<span class="o-pill ${st.tone}">${esc(st.label.split(' ')[0])}</span>`}</div>`;
  }).join('');
  return `<section class="o-card" id="o-extra"><h3>Appreciation</h3>
    ${wins || '<p class="o-empty">Nothing new to celebrate yet. I\'ll tell you the moment there is.</p>'}
    ${recs ? `<div class="o-group">Sent to your admin</div>${recs}` : ''}
    <details style="margin-top:10px"><summary class="muted small" style="cursor:pointer">Did something extra? Tell your admin</summary>
      <form class="o-form" id="o-extra-form"><input id="x-title" maxlength="120" placeholder="e.g. Covered the production incident on Saturday" aria-label="What did you do?">
        <textarea id="x-details" rows="2" maxlength="500" placeholder="A few details (optional)" aria-label="Details"></textarea>
        <button class="btn sm primary" type="submit">Send to admin</button></form></details></section>`;
}

function bindRail(rail) {
  rail.querySelectorAll('[data-task]').forEach((row) => {
    const id = row.dataset.task;
    row.querySelector('[data-status]').addEventListener('change', (e) => updateTask(id, { status: e.target.value }));
    row.querySelector('[data-pct]').addEventListener('change', (e) => updateTask(id, { percent: Number(e.target.value) }));
  });
  rail.querySelectorAll('[data-care]').forEach((b) => b.addEventListener('click', () => careAction(b.dataset.care)));
  rail.querySelectorAll('[data-send]').forEach((b) => b.addEventListener('click', () => sendAchievement(b)));
  rail.querySelectorAll('[data-cert]').forEach((b) => b.addEventListener('click', () => openCertificate(b.dataset.cert)));
  $o('#o-extra-form')?.addEventListener('submit', async (e) => {
    e.preventDefault();
    const title = $o('#x-title').value.trim(); const details = $o('#x-details').value.trim();
    if (title.length < 4) { toast('Give it a short title first.'); return; }
    const r = await agent.orbit.nominate({ title, details });
    toast(r.ok ? 'Sent to your admin. I\'ll tell you when they decide.' : r.error);
    if (r.ok) { orb.ctl?.burst(24); OrbitSound.play('notify', orb.persona); loadAchievements(); }
  });
}

async function careAction(what) {
  if (what === 'settings') { openCareSettings(); return; }
  if (what === 'water') { await agent.orbit.care.water(); OrbitSound.play('receive', orb.persona); orb.ctl?.burst(10); toast('Nice. Stay hydrated.'); }
  else if (what === 'focus') { await agent.orbit.care.focus(25); toast('Focus session started. I will keep quiet for 25 minutes.'); }
  else if (what === 'focus-stop') await agent.orbit.care.focus(0);
  else if (what === 'pause') { await agent.orbit.care.pause(60); toast('Reminders paused for an hour.'); }
  else if (what === 'resume') await agent.orbit.care.pause(0);
  else if (what === 'presenting') { const on = await agent.orbit.presenting(!(orb.care && orb.care.presenting)); toast(on ? 'Presenting mode on: I am hidden and quiet. Turn it off here, from the menu bar, or with the shortcut.' : 'Welcome back! I am visible again.'); }
  loadCare();
}

function openCareSettings() {
  const cfg = orb.care.config;
  const sw = (id, on) => `<label class="o-switch"><input type="checkbox" id="${id}" ${on ? 'checked' : ''}><i></i></label>`;
  const num = (id, v, min, max) => `<input id="${id}" type="number" min="${min}" max="${max}" value="${v}" style="width:72px;border:1px solid var(--border-strong);background:var(--bg);color:var(--text);border-radius:10px;padding:6px 8px"> <span class="muted small">min</span>`;
  const tm = (id, v) => `<input id="${id}" type="time" value="${v}" style="border:1px solid var(--border-strong);background:var(--bg);color:var(--text);border-radius:10px;padding:6px 8px">`;
  const row = (title, hint, control, toggle) => `<div class="o-row"><div class="l"><b>${esc(title)}</b><span>${esc(hint)}</span></div><div style="display:flex;gap:10px;align-items:center">${control || ''}${toggle || ''}</div></div>`;
  const m = modal(`<h2>Take-care reminders</h2><p class="lead">Gentle nudges, only while you are actively working. Meetings and breaks away from the desk reset the clock.</p>
    ${row('All reminders', 'Switch everything on or off', '', sw('k-enabled', cfg.enabled))}
    ${row('Drink water', 'How often', num('k-water', cfg.water.every, 5, 240), sw('k-water-on', cfg.water.on))}
    ${row('Rest your eyes (20-20-20)', 'Look 20 feet away for 20 seconds, and blink', num('k-eyes', cfg.eyes.every, 10, 60), sw('k-eyes-on', cfg.eyes.on))}
    ${row('Stretch and posture', 'Stand up and move', num('k-stretch', cfg.stretch.every, 15, 120), sw('k-stretch-on', cfg.stretch.on))}
    ${row('Take a real break', 'After a long unbroken stretch', num('k-rest', cfg.rest.after, 45, 240), sw('k-rest-on', cfg.rest.on))}
    ${row('Lunch', 'A reminder to eat', tm('k-meal', cfg.meal.at), sw('k-meal-on', cfg.meal.on))}
    ${row('Wrap up the day', 'A short summary and tomorrow\'s first task', tm('k-wrap', cfg.wrapup.at), sw('k-wrap-on', cfg.wrapup.on))}
    ${row('Long-day guard', 'Suggest logging off after this many active hours', `<input id="k-over" type="number" min="6" max="14" value="${cfg.overwork.hours}" style="width:72px;border:1px solid var(--border-strong);background:var(--bg);color:var(--text);border-radius:10px;padding:6px 8px"> <span class="muted small">hours</span>`, sw('k-over-on', cfg.overwork.on))}
    ${row('Quiet hours', 'No reminders between these times', `${tm('k-qf', cfg.quiet.from)} <span class="muted small">to</span> ${tm('k-qt', cfg.quiet.to)}`, sw('k-quiet-on', cfg.quiet.on))}
    ${row('Stay quiet in calls and presentations', 'Held back (not lost) while one of the apps below is in front', '', sw('k-meet', cfg.pauseInMeetings))}
    <div class="o-row"><div class="l"><b>Apps to stay quiet in</b><span>Comma separated, part of the app name is enough</span></div><input id="k-quiet-apps" value="${esc((cfg.quietApps || []).join(', '))}" style="width:230px;border:1px solid var(--border-strong);background:var(--bg);color:var(--text);border-radius:10px;padding:6px 8px"></div>
    ${row('Never interrupt full-screen apps', 'Presentations, videos, games: I wait until you are done, then speak up', '', sw('k-full', cfg.respectFullscreen))}
    ${row('Weekdays only', 'No reminders on Saturday or Sunday', '', sw('k-wd', cfg.workdaysOnly))}
    ${row('How to tell me', 'Speech bubble from the orb, or a system notification', `<div class="segmented" role="group"><button data-del="orb" class="${cfg.delivery === 'orb' ? 'on' : ''}">Orb</button><button data-del="notification" class="${cfg.delivery === 'notification' ? 'on' : ''}">Notification</button></div>`, '')}
    <div class="foot"><button class="btn" id="k-test">Try a reminder</button><button class="btn primary" data-close>Done</button></div>`);
  const save = async (patch) => { orb.care = await agent.orbit.care.set(patch); drawRail(); };
  const n = (id) => Number(m.querySelector(id).value);
  const on = (id, fn) => m.querySelector(id).addEventListener('change', fn);
  m.querySelector('[data-close]').addEventListener('click', closeModal);
  on('#k-enabled', (e) => save({ enabled: e.target.checked }));
  for (const [key, on_, val] of [['water', '#k-water-on', '#k-water'], ['eyes', '#k-eyes-on', '#k-eyes'], ['stretch', '#k-stretch-on', '#k-stretch']]) {
    on(on_, (e) => save({ [key]: { on: e.target.checked } }));
    on(val, () => save({ [key]: { every: n(val) } }));
  }
  on('#k-rest-on', (e) => save({ rest: { on: e.target.checked } })); on('#k-rest', () => save({ rest: { after: n('#k-rest') } }));
  on('#k-meal-on', (e) => save({ meal: { on: e.target.checked } })); on('#k-meal', (e) => save({ meal: { at: e.target.value } }));
  on('#k-wrap-on', (e) => save({ wrapup: { on: e.target.checked } })); on('#k-wrap', (e) => save({ wrapup: { at: e.target.value } }));
  on('#k-over-on', (e) => save({ overwork: { on: e.target.checked } })); on('#k-over', () => save({ overwork: { hours: n('#k-over') } }));
  on('#k-quiet-on', (e) => save({ quiet: { on: e.target.checked } })); on('#k-qf', (e) => save({ quiet: { from: e.target.value } })); on('#k-qt', (e) => save({ quiet: { to: e.target.value } }));
  on('#k-meet', (e) => save({ pauseInMeetings: e.target.checked }));
  on('#k-quiet-apps', (e) => save({ quietApps: e.target.value.split(',') }));
  on('#k-full', (e) => save({ respectFullscreen: e.target.checked })); on('#k-wd', (e) => save({ workdaysOnly: e.target.checked }));
  m.querySelectorAll('[data-del]').forEach((b) => b.addEventListener('click', () => { m.querySelectorAll('[data-del]').forEach((x) => x.classList.toggle('on', x === b)); save({ delivery: b.dataset.del }); }));
  m.querySelector('#k-test').addEventListener('click', () => { orb.ctl?.burst(12); OrbitSound.play('notify', orb.persona); toast('The orb on your screen will remind you like this.'); });
}

async function updateTask(id, patch) {
  const r = await agent.orbit.updateTask(id, patch);
  if (!r.ok) { toast(r.error); loadTasks(); return; }
  if (patch.status === 'done') {
    orb.ctl?.burst(); OrbitSound.play('celebrate', orb.persona);
    toast('Nice work! Marked as done.');
    orb.brief = null; // today's summary is out of date now
  }
  await Promise.all([loadTasks(), loadAchievements()]);
}

async function sendAchievement(btn) {
  btn.disabled = true;
  const r = await agent.orbit.nominate({ dedupeKey: btn.dataset.send });
  if (!r.ok) { toast(r.error); btn.disabled = false; loadAchievements(); return; }
  orb.ctl?.burst(); OrbitSound.play('celebrate', orb.persona);
  toast('Sent! Your admin will decide on a reward.');
  loadAchievements();
}

// ---- dialogs -------------------------------------------------------------------------------------

function modal(inner, wide = false) {
  closeModal();
  const m = document.createElement('div');
  m.className = 'o-modal'; m.id = 'o-modal';
  m.style.setProperty('--o', orb.persona.color);
  m.innerHTML = `<div class="o-dialog${wide ? ' wide' : ''}" role="dialog" aria-modal="true">${inner}</div>`;
  m.addEventListener('mousedown', (e) => { if (e.target === m) closeModal(); });
  document.body.appendChild(m);
  m.querySelector('[data-close]')?.focus({ preventScroll: true });
  const dlg = m.querySelector('.o-dialog'); if (dlg) dlg.scrollTop = 0;
  return m;
}
function closeModal() { $o('#o-modal')?.remove(); }
document.addEventListener('keydown', (e) => { if (e.key === 'Escape') closeModal(); });

async function openCertificate(id) {
  const r = await agent.orbit.certificate(id);
  if (!r.ok) { toast(r.error); return; }
  const m = modal(`<h2>Certificate of Appreciation</h2><p class="lead">${esc(r.data.certificateId)}</p>
    <iframe class="o-cert" sandbox="" title="Certificate"></iframe>
    <div class="foot"><button class="btn" data-close>Close</button><button class="btn primary" id="o-save">Save as PDF</button></div>`, true);
  m.querySelector('iframe').srcdoc = r.data.html; // scripts are off (sandbox) and the page carries its own strict policy
  m.querySelector('[data-close]').addEventListener('click', closeModal);
  m.querySelector('#o-save').addEventListener('click', async () => {
    const s = await agent.orbit.saveCertificate(id);
    toast(!s.ok ? s.error : s.data.saved ? 'Saved. Well deserved!' : 'Not saved.');
  });
  orb.ctl?.burst(30); OrbitSound.play('celebrate', orb.persona);
}

function openCustomiser() {
  const p = orb.persona;
  const sw = OrbitLogic.COLORS.map((c) => `<button class="o-sw ${c.hex.toUpperCase() === p.color ? 'on' : ''}" style="background:${c.hex}" data-color="${c.hex}" title="${esc(c.name)}" aria-label="${esc(c.name)}"></button>`).join('');
  const opt = (list, cur, key) => list.map((o) => `<button class="o-opt ${o.id === cur ? 'on' : ''}" data-${key}="${o.id}"><b>${esc(o.name)}</b><span>${esc(o.hint)}</span></button>`).join('');
  const sw2 = (id, label, hint, on) => `<div class="o-row"><div class="l"><b>${esc(label)}</b><span>${esc(hint)}</span></div><label class="o-switch"><input type="checkbox" id="${id}" ${on ? 'checked' : ''}><i></i></label></div>`;
  const m = modal(`<h2>Make it yours</h2><p class="lead">Name your companion, pick a colour, a motion style and how it sounds. Changes apply instantly.</p>
    <div style="padding:12px 0 4px"><b style="font-size:13.5px">Who lives on your screen</b><div class="muted small" style="margin:2px 0 8px">Your companion stays on screen, ready to chat. Click it to talk.</div>
      <div class="o-avatars">${OrbitLogic.AVATARS.map((a) => `<button class="o-av ${p.avatar === a ? 'on' : ''}" data-avatar="${a}" title="${a === 'orb' ? 'The orb' : esc(OrbitBuddies.ANIMALS[a].name)}">${a === 'orb' ? '<span class="o-orbdot"></span>' : OrbitBuddies.svg(a, { color: p.color, size: 62 })}<b>${a === 'orb' ? 'Orb' : esc(OrbitBuddies.ANIMALS[a].name)}</b></button>`).join('')}</div></div>
    <div class="o-row"><div class="l"><b>Presenting mode</b><span>Hides me completely and holds every reminder. Shortcut: ${esc(OrbitLogic.PRESENTING_SHORTCUT.replace('CommandOrControl', navigator.platform.includes('Mac') ? '⌘' : 'Ctrl').replace('Alt', navigator.platform.includes('Mac') ? '⌥' : 'Alt').replace('Shift', '⇧').replace(/\+/g, ' '))}</span></div><button class="btn sm" id="c-present">${orb.care && orb.care.presenting ? 'Turn off' : 'Turn on'}</button></div>
    ${sw2('c-buddy', 'Animal friends act out my reminders', 'An otter sips water, a panda stretches, an owl rests his eyes, a sloth breathes. Off = just the companion', p.buddy === 'animals')}
    <div style="padding:10px 0 2px"><b style="font-size:13.5px">When the animals appear, and who plays each part</b><div class="muted small" style="margin:2px 0 6px">Press Show me to see any of them right now.</div>
      <div class="o-events">${OrbitLogic.EVENTS.map((ev) => `<div class="o-event"><div class="l"><b>${esc(ev.label)}</b><span>${esc(ev.when(p, orb.care?.config || CareLogicDefaults()))}</span></div>
        <select data-event="${ev.id}" aria-label="Who plays ${esc(ev.label)}">${[...OrbitLogic.ANIMAL_IDS, 'none'].map((a) => `<option value="${a}" ${p.buddies[ev.id] === a ? 'selected' : ''}>${a === 'none' ? 'Nobody' : esc(OrbitBuddies.ANIMALS[a].name)}</option>`).join('')}</select>
        <button class="btn sm" data-demo="${ev.id}">Show me</button></div>`).join('')}</div>
      <div style="display:flex;gap:8px;margin-top:10px;flex-wrap:wrap"><button class="btn sm" data-demo="quick">Try the chat box</button><span class="muted small" id="c-demo-msg" role="status"></span></div></div>
    <div class="o-row"><div class="l"><b>Name</b><span>What you'd like to call me</span></div><input id="c-name" maxlength="24" value="${esc(p.name)}" style="width:160px;border:1px solid var(--border-strong);background:var(--bg);color:var(--text);border-radius:10px;padding:7px 10px"></div>
    <div class="o-row"><div class="l"><b>Colour</b></div><div class="o-swatches">${sw}<input type="color" id="c-color" value="${esc(p.color.toLowerCase())}" aria-label="Custom colour"></div></div>
    ${sw2('c-show', 'Keep me on screen', 'A small floating companion that stays nearby. Click to open, drag to move, right-click for options', p.show)}
    <div style="padding:10px 0"><b style="font-size:13.5px">Where I live</b><div class="o-styles" style="margin-top:8px">${OrbitLogic.DOCKS.map((d) => `<button class="o-opt ${p.dock === d.id ? 'on' : ''}" data-dock="${d.id}"><b>${esc(d.name)}</b></button>`).join('')}</div>
      <div class="muted small" style="margin-top:6px">${p.dock === 'free' ? 'You moved me to a custom spot. Pick a corner to snap back.' : 'Or drag me anywhere on your screen.'}</div></div>
    <div class="o-row"><div class="l"><b>Size</b></div><div class="segmented" role="group" aria-label="Companion size">${OrbitLogic.SIZES.map((z) => `<button class="${p.size === z.id ? 'on' : ''}" data-size="${z.id}">${esc(z.name)}</button>`).join('')}</div></div>
    <div style="padding:10px 0"><b style="font-size:13.5px">Animation</b><div class="o-styles" style="margin-top:8px">${opt(OrbitLogic.STYLES, p.style, 'style')}</div></div>
    <div style="padding:10px 0"><b style="font-size:13.5px">Sound</b><div class="o-styles" style="margin-top:8px">${opt(OrbitLogic.SOUNDS, p.sound, 'sound')}</div></div>
    <div class="o-row"><div class="l"><b>Volume</b></div><input type="range" id="c-vol" min="0" max="100" value="${Math.round(p.volume * 100)}" style="width:180px"></div>
    ${sw2('c-speak', 'Speak my greeting aloud', 'Uses your computer\'s voice', p.speak)}
    ${sw2('c-greet', 'Greet me when I open my laptop', 'The first time each day, with a summary of your day', p.greet)}
    <div class="o-row"><div class="l"><b>Welcome me back</b><span>Say hello when I return after being away</span></div><select id="c-wb" style="border:1px solid var(--border-strong);background:var(--bg);color:var(--text);border-radius:10px;padding:6px 8px">${[[0, 'Never'], [10, 'After 10 min'], [20, 'After 20 min'], [30, 'After 30 min'], [60, 'After 1 hour']].map(([v, l]) => `<option value="${v}" ${v === p.welcomeBack ? 'selected' : ''}>${l}</option>`).join('')}</select></div>
    ${sw2('c-motion', 'Animations', 'Turn off for a calm, still companion', p.motion)}
    <div class="foot"><button class="btn" id="c-reset">Reset</button><button class="btn primary" data-close>Done</button></div>`);
  const save = async (patch) => { orb.persona = OrbitLogic.sanitizePersona(await agent.orbit.setPersona(patch), p); personaApply(); };
  m.querySelector('[data-close]').addEventListener('click', closeModal);
  m.querySelector('#c-name').addEventListener('change', (e) => save({ name: e.target.value }));
  m.querySelectorAll('[data-color]').forEach((b) => b.addEventListener('click', () => { m.querySelectorAll('[data-color]').forEach((x) => x.classList.toggle('on', x === b)); save({ color: b.dataset.color }); orb.ctl?.burst(14); }));
  m.querySelector('#c-color').addEventListener('input', (e) => save({ color: e.target.value }));
  m.querySelectorAll('[data-style]').forEach((b) => b.addEventListener('click', () => { m.querySelectorAll('[data-style]').forEach((x) => x.classList.toggle('on', x === b)); save({ style: b.dataset.style }); }));
  m.querySelectorAll('[data-sound]').forEach((b) => b.addEventListener('click', async () => { m.querySelectorAll('[data-sound]').forEach((x) => x.classList.toggle('on', x === b)); await save({ sound: b.dataset.sound }); OrbitSound.play('greet', orb.persona); }));
  m.querySelector('#c-vol').addEventListener('change', async (e) => { await save({ volume: Number(e.target.value) / 100 }); OrbitSound.play('receive', orb.persona); });
  m.querySelector('#c-speak').addEventListener('change', async (e) => { await save({ speak: e.target.checked }); if (e.target.checked) OrbitSound.speak(`Hi ${OrbitLogic.firstName(orb.identity.name)}, I'm ${orb.persona.name}.`, orb.persona); else OrbitSound.hush(); });
  m.querySelector('#c-show').addEventListener('change', (e) => save({ show: e.target.checked }));
  m.querySelectorAll('[data-dock]').forEach((b) => b.addEventListener('click', () => { m.querySelectorAll('[data-dock]').forEach((x) => x.classList.toggle('on', x === b)); save({ dock: b.dataset.dock }); }));
  m.querySelectorAll('[data-size]').forEach((b) => b.addEventListener('click', () => { m.querySelectorAll('[data-size]').forEach((x) => x.classList.toggle('on', x === b)); save({ size: b.dataset.size }); }));
  m.querySelectorAll('[data-avatar]').forEach((b) => b.addEventListener('click', () => { m.querySelectorAll('[data-avatar]').forEach((x) => x.classList.toggle('on', x === b)); save({ avatar: b.dataset.avatar }); }));
  m.querySelectorAll('[data-event]').forEach((sel) => sel.addEventListener('change', () => save({ buddies: { [sel.dataset.event]: sel.value } })));
  m.querySelectorAll('[data-demo]').forEach((b) => b.addEventListener('click', async () => {
    const r = await agent.orbit.demo(b.dataset.demo);
    m.querySelector('#c-demo-msg').textContent = r.ok ? 'Look at your screen: your companion is showing it.' : r.error;
  }));
  m.querySelector('#c-present').addEventListener('click', async (e) => { const on = await agent.orbit.presenting(!(orb.care && orb.care.presenting)); e.target.textContent = on ? 'Turn off' : 'Turn on'; loadCare(); });
  m.querySelector('#c-buddy').addEventListener('change', (e) => save({ buddy: e.target.checked ? 'animals' : 'orb' }));
  m.querySelector('#c-wb').addEventListener('change', (e) => save({ welcomeBack: Number(e.target.value) }));
  m.querySelector('#c-greet').addEventListener('change', (e) => save({ greet: e.target.checked }));
  m.querySelector('#c-motion').addEventListener('change', (e) => save({ motion: e.target.checked }));
  m.querySelector('#c-reset').addEventListener('click', async () => { await save({ ...OrbitLogic.DEFAULTS }); closeModal(); openCustomiser(); });
}

function toast(text) {
  let el = document.getElementById('o-toast');
  if (!el) { el = document.createElement('div'); el.id = 'o-toast'; el.setAttribute('role', 'status'); el.style.cssText = 'position:fixed;left:50%;bottom:28px;transform:translateX(-50%);z-index:60;background:var(--text);color:var(--bg);padding:10px 16px;border-radius:999px;font:500 13px var(--font);box-shadow:var(--shadow-lg);transition:opacity .2s;max-width:80vw'; document.body.appendChild(el); }
  el.textContent = text; el.style.opacity = '1';
  clearTimeout(el._t); el._t = setTimeout(() => { el.style.opacity = '0'; }, 3200);
}

// ---- live updates --------------------------------------------------------------------------------

agent.orbit.onChange(() => { if (state.page === 'orbit') { orb.brief = null; loadTasks(); loadAchievements(); } });
agent.orbit.care.onState(() => { if (state.page === 'orbit') loadCare(); });
agent.orbit.onPersona(async () => { await loadPersona(); if (state.page === 'orbit') personaApply(); });
document.addEventListener('visibilitychange', () => { if (!document.hidden && state.page === 'orbit') { loadTasks(); loadAchievements(); agent.orbit.poke(); } });

/** Called when the employee leaves the page: stop drawing and stop the typing effect. */
function leave() {
  clearInterval(orb.careTimer);
  if (orb.ctl) { orb.ctl.destroy(); orb.ctl = null; }
  clearInterval(orb.typing);
}

return { render: renderOrbit, leave };
})();
