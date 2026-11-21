'use strict';
/* global agent, OrbitLogic, OrbitOrb, OrbitSound, OrbitBuddies */
// The companion that lives on the screen: an animal friend (or the orb) that is always nearby, like an assistant at your elbow.
// Click it to talk: a small chat box opens right here ("How can I help you today?"). Drag it anywhere, right-click for options.
// It greets you when the laptop is opened, speaks up for news and wellbeing reminders (an otter sips water, a panda stretches...),
// and on weekends asks gently what brought you in. It never takes keyboard focus unless you click into its box, and clicks anywhere
// except on the companion and its bubble pass straight through to the apps underneath.
(async () => {
  const $ = (id) => document.getElementById(id);
  let persona = OrbitLogic.sanitizePersona(await agent.orbit.persona().catch(() => null));
  let layout = await agent.orbit.companionLayout().catch(() => ({ side: 'right', vert: 'bottom', orbPx: 112 }));
  const who = await agent.orbit.identity().catch(() => ({ name: '' }));
  const figure = $('figure'); const canvas = $('orb'); const avatarEl = $('avatar');
  const orb = OrbitOrb.create(canvas, { color: persona.color, style: persona.style, motion: persona.motion });
  let hideTimer = null; let typer = null; let hovering = false; let avatarSig = '';
  const first = () => OrbitLogic.firstName(who.name);

  /** Show the chosen animal (or the orb) as the figure on screen. Re-drawn only when something about it changed, so animations don't restart. */
  function applyLayout() {
    document.body.style.setProperty('--o', persona.color);
    const px = layout.orbPx;
    figure.style.width = `${px}px`; figure.style.height = `${px}px`;
    $('stage').className = `oc-stage side-${layout.side} vert-${layout.vert}`;
    orb.setColor(persona.color); orb.setStyle(persona.style); orb.setMotion(persona.motion);
    const animal = persona.avatar !== 'orb';
    canvas.hidden = animal; avatarEl.hidden = !animal;
    const sig = `${persona.avatar}|${px}|${persona.color}`;
    if (sig !== avatarSig) { avatarSig = sig; avatarEl.innerHTML = animal ? OrbitBuddies.svg(persona.avatar, { size: px, color: persona.color }) : ''; }
  }
  applyLayout();

  /** One place for "what is the companion doing": drives both the orb and the animal. */
  function mood(s) { orb.setState(s); figure.dataset.state = s; }

  // ---- clicks pass through everywhere except the companion and the bubble ----
  let hit = false;
  document.addEventListener('mousemove', (e) => {
    const over = Boolean(e.target.closest?.('.hit'));
    if (over !== hit) { hit = over; agent.orbit.companionHit(over); }
    hovering = over;
    if (over && figure.dataset.state === 'idle') mood('listening');
    if (!over && figure.dataset.state === 'listening') mood('idle');
  });
  document.addEventListener('mouseleave', () => { if (hit) { hit = false; agent.orbit.companionHit(false); } hovering = false; });

  // ---- drag to move, click to talk ----
  let down = null;
  figure.addEventListener('mousedown', (e) => { if (e.button === 0) down = { x: e.screenX, y: e.screenY, moved: false }; });
  window.addEventListener('mousemove', (e) => {
    if (!down) return;
    const dx = e.screenX - down.x; const dy = e.screenY - down.y;
    if (!down.moved && Math.hypot(dx, dy) < 5) return;
    if (!down.moved) { down.moved = true; agent.orbit.companionDrag('start'); }
    agent.orbit.companionDrag('move', dx, dy);
  });
  window.addEventListener('mouseup', () => {
    if (!down) return;
    const wasDrag = down.moved; down = null;
    if (wasDrag) agent.orbit.companionDrag('end'); else openQuick(true);
  });
  figure.addEventListener('contextmenu', (e) => { e.preventDefault(); agent.orbit.companionMenu(); });

  // ---- the speech bubble ----
  const askInput = $('askInput');
  const typing = () => document.activeElement === askInput || askInput.value.trim() !== '';

  function hideBubble() {
    clearTimeout(hideTimer); clearInterval(typer); endSession();
    $('bubble').hidden = true; $('buddy').innerHTML = ''; $('askForm').hidden = true; askInput.value = ''; askInput.blur();
    agent.orbit.companionFocus(false); mood('idle'); OrbitSound.hush();
  }

  function setBuddy(b) {
    $('buddy').innerHTML = b && persona.buddy === 'animals' ? OrbitBuddies.svg(b.animal, { mode: b.mode, color: persona.color, size: 96 }) : '';
  }

  /**
   * Speak in the bubble. `buddy`: the animal who acts it out. `ask`: show the little chat box underneath ("How can I help you today?").
   */
  function say(text, { actions = [], ttl = 14000, sound = 'notify', speak = false, buddy = null, ask = false } = {}) {
    clearTimeout(hideTimer); clearInterval(typer);
    setBuddy(buddy);
    $('bubble').hidden = false;
    $('btns').replaceChildren();
    $('askForm').hidden = true;
    const t = $('text'); t.textContent = '';
    if (sound) OrbitSound.play(sound, persona);
    text = String(text).slice(0, 460);
    const words = text.split(/(\s+)/);
    let i = 0;
    mood('speaking');
    const armHide = () => { clearTimeout(hideTimer); hideTimer = setTimeout(() => { if (hovering || typing()) armHide(); else hideBubble(); }, ttl); };
    const finish = () => {
      mood('idle');
      for (const a of actions) {
        const b = document.createElement('button');
        b.className = `btn sm${a.primary ? ' primary' : ''}`; b.textContent = a.label;
        b.addEventListener('click', () => { if (!a.keep) hideBubble(); else clearTimeout(hideTimer); a.run(); });
        $('btns').appendChild(b);
      }
      const x = document.createElement('button'); x.className = 'og-link'; x.textContent = 'Dismiss'; x.addEventListener('click', hideBubble); $('btns').appendChild(x);
      if (ask) $('askForm').hidden = false;
      armHide();
    };
    if (!persona.motion) { t.textContent = text; finish(); } else {
      typer = setInterval(() => { t.textContent += words[i++] || ''; orb.level(0.5 + Math.random() * 0.5); if (i >= words.length) { clearInterval(typer); finish(); } }, 34);
    }
    if (speak) OrbitSound.speak(text, persona);
  }

  const open = (page = 'orbit') => agent.orbit.companionOpen(page);
  const resolve = (event) => (persona.buddy === 'animals' ? OrbitBuddies.resolve(event, persona) : null);
  const arrive = () => { figure.classList.remove('oc-arrive'); void figure.offsetWidth; figure.classList.add('oc-arrive'); };

  // ---- quick chat: click the companion and just ask ----
  const quick = { history: [], busy: false };

  function openQuick(userClicked) {
    const line = quick.history.length ? 'What else can I help with?' : `Hi ${first()}! How can I help you today?`;
    say(line, { actions: [{ label: 'Open the full page', run: () => open('orbit') }], ttl: 60000, sound: 'receive', buddy: resolve('greet'), ask: true });
    if (userClicked) { agent.orbit.companionFocus(true); setTimeout(() => askInput.focus(), 120); }
  }

  askInput.addEventListener('mousedown', () => agent.orbit.companionFocus(true)); // only now does the window accept typing
  askInput.addEventListener('focus', () => agent.orbit.companionFocus(true));
  $('askForm').addEventListener('submit', async (e) => {
    e.preventDefault();
    const q = askInput.value.trim();
    if (!q || quick.busy) return;
    askInput.value = '';
    quick.busy = true; quick.history.push({ role: 'user', content: q }); quick.history = quick.history.slice(-12);
    clearTimeout(hideTimer);
    $('text').textContent = 'Thinking…'; mood('thinking'); $('btns').replaceChildren();
    const r = await agent.orbit.chat(quick.history, persona.name);
    quick.busy = false;
    if (!r.ok) { say(r.error || 'I could not answer just now.', { ttl: 20000, sound: null, ask: true }); return; }
    quick.history.push({ role: 'assistant', content: r.data.reply });
    const actions = (r.data.actions || []).filter((a) => a.type === 'goto' && ['install', 'orbit'].includes(a.page)).map((a) => ({ label: a.page === 'install' ? 'Open Install software' : 'Show me', primary: true, run: () => open(a.page) }));
    actions.push({ label: 'Open the full page', run: () => open('orbit') });
    say(r.data.reply, { actions, ttl: 60000, sound: 'receive', ask: true, buddy: null });
    askInput.focus();
  });

  // ---- wellbeing reminders: water, eyes, stretch, rest, meals, wrap-up ----
  const LABEL = { done: { water: 'I drank water', rest: 'Took a break', meal: 'On my way', eyes: 'Done', stretch: 'Done' }, snooze: 'In 10 min' };
  let session = null; // a running eye-rest countdown or breathing exercise
  function endSession() { clearInterval(session); session = null; }

  function eyeBreak(n, secs) {
    endSession();
    let left = secs;
    mood('listening');
    $('text').textContent = `Look far away and blink slowly… ${left}s`;
    $('btns').replaceChildren();
    session = setInterval(() => {
      left -= 1;
      if (left > 0) { $('text').textContent = `Look far away and blink slowly… ${left}s`; return; }
      endSession();
      $('text').textContent = 'Lovely. Your eyes thank you.';
      OrbitSound.play('receive', persona);
      if (!n.demo) agent.orbit.care.act(n.kind, 'done');
      mood('idle');
      setTimeout(hideBubble, 3500);
    }, 1000);
  }

  function breathe(n) {
    endSession();
    const phases = [['Breathe in…', 4, 1], ['Hold…', 3, 1], ['Breathe out…', 6, 0]];
    let cycle = 0; let p = 0; let t = 0;
    mood('speaking');
    $('btns').replaceChildren();
    session = setInterval(() => {
      const [label, len, up] = phases[p];
      $('text').textContent = label;
      const frac = t / len;
      orb.level(up === 1 ? 0.25 + 0.7 * frac : 0.95 - 0.7 * frac);
      t += 0.2;
      if (t >= len) { t = 0; p += 1; if (p >= phases.length) { p = 0; cycle += 1; } }
      if (cycle >= 4) { endSession(); $('text').textContent = 'Nice. Feeling a little lighter?'; if (!n.demo) agent.orbit.care.act(n.kind, 'done'); mood('idle'); setTimeout(hideBubble, 3500); }
    }, 200);
  }

  function care(n) {
    const act = (a) => { if (!n.demo) agent.orbit.care.act(n.kind, a); };
    const actions = [];
    for (const a of n.actions || []) {
      if (a === 'start') actions.push({ label: 'Start 20-second break', primary: true, run: () => eyeBreak(n, n.timer || 20), keep: true });
      else if (a === 'breathe') actions.push({ label: 'Breathe with me', primary: n.kind === 'rest' && !(n.actions || []).includes('done'), run: () => breathe(n), keep: true });
      else if (a === 'open') actions.push({ label: 'Open Orbit', primary: true, run: () => { act('done'); open(); } });
      else if (a === 'done') actions.push({ label: LABEL.done[n.kind] || 'Done', primary: !(n.actions || []).includes('start'), run: () => act('done') });
      else if (a === 'snooze') actions.push({ label: LABEL.snooze, run: () => act('snooze') });
    }
    say(`${n.title}. ${n.body}`, { actions, ttl: 45000, sound: 'notify', speak: persona.speak && n.kind === 'wrapup', buddy: resolve(n.kind) });
    // "Skip" is the bubble's own Dismiss button: leaving it unanswered just lets the reminder go.
  }
  agent.orbit.care.onNudge(care);

  // news: a new task, a decision on appreciation
  agent.orbit.onSay(({ title, body }) => say(`${title}: ${body}`, { actions: [{ label: 'Open', primary: true, run: () => open() }], sound: 'notify' }));

  // the daily hello when the laptop is opened: greet by name, today's tasks, then "How can I help you today?" with a box to type in
  agent.orbit.onGreet(async () => {
    mood('thinking'); arrive();
    const r = await agent.orbit.briefing();
    const g = r.ok ? r.data.greeting.text : OrbitLogic.localGreeting(who.name).text;
    const msg = r.ok ? `${r.data.message} ${r.data.ask}` : 'I\'m here whenever you need me. How can I help you today?';
    say(`${g} ${msg}`, { actions: [{ label: 'Open my day', primary: true, run: () => open() }], ttl: 40000, sound: 'greet', speak: persona.speak, buddy: resolve('greet'), ask: true });
  });

  // weekend: a calm "what brought you in?" with the person's own high-priority work as the first answers
  agent.orbit.onCheckIn(({ text, choices, hasUrgent }) => {
    arrive();
    const answer = async (c) => {
      const r = await agent.orbit.checkinAnswer(c.id);
      const reply = r.ok ? r.reply : 'Thanks. Take care of yourself.';
      say(`${reply} How can I help you today?`, { actions: r.ok && r.recorded && hasUrgent ? [{ label: 'Open my tasks', primary: true, run: () => open() }] : [], ttl: 40000, sound: 'receive', speak: persona.speak, buddy: resolve('checkin'), ask: true });
    };
    say(text, { actions: choices.map((c, i) => ({ label: c.label, primary: i === 0 && hasUrgent, run: () => answer(c) })), ttl: 90000, sound: 'receive', speak: persona.speak, buddy: resolve('checkin') });
  });

  // back at the laptop: the companion pops forward and says hello with the first thing to do
  agent.orbit.onWelcome(({ text }) => {
    arrive(); orb.burst(16);
    say(`${text} How can I help you today?`, { actions: [{ label: 'Open my day', primary: true, run: () => open() }], ttl: 30000, sound: 'greet', speak: persona.speak, buddy: resolve('welcome'), ask: true });
  });

  agent.orbit.onQuick(() => openQuick(true));
  agent.orbit.onPersona(async () => { persona = OrbitLogic.sanitizePersona(await agent.orbit.persona().catch(() => persona)); applyLayout(); });
  agent.orbit.onLayout((l) => { layout = l; applyLayout(); });
})();
