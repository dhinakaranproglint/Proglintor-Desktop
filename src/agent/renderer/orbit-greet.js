'use strict';
/* global agent, OrbitLogic, OrbitOrb, OrbitSound */
// The small card that greets the employee when they open their laptop. It never takes focus, and closes itself after a while.
(async () => {
  const $ = (id) => document.getElementById(id);
  const persona = OrbitLogic.sanitizePersona(await agent.orbit.persona().catch(() => null));
  const who = await agent.orbit.identity().catch(() => ({ name: '' }));
  document.body.style.setProperty('--o', persona.color);
  const orb = OrbitOrb.create($('orb'), { color: persona.color, style: persona.style, motion: persona.motion });
  const local = OrbitLogic.localGreeting(who.name);
  $('hello').textContent = local.text;
  $('who').textContent = `${persona.name}, your work companion`;
  $('msg').textContent = 'Let me look at your day…';
  OrbitSound.play('greet', persona);
  orb.setState('speaking');

  const close = (what) => agent.orbit.greetAct(what);
  $('go').addEventListener('click', () => close('open'));
  $('later').addEventListener('click', () => close('later'));
  $('off').addEventListener('click', () => close('off'));
  setTimeout(() => close('later'), 29000);
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape') close('later'); });

  const r = await agent.orbit.briefing();
  let text = "I'm here whenever you need me. How can I help you today?";
  if (r.ok) {
    $('hello').textContent = r.data.greeting.text;
    text = `${r.data.message} ${r.data.ask}`;
  }
  // words appear one by one while the orb talks
  const words = text.split(/(\s+)/);
  let i = 0;
  $('msg').textContent = '';
  const t = setInterval(() => {
    $('msg').textContent += words[i++] || '';
    orb.level(0.5 + Math.random() * 0.5);
    if (i >= words.length) { clearInterval(t); orb.setState('idle'); }
  }, persona.motion ? 36 : 0);
  OrbitSound.speak(`${$('hello').textContent} ${text}`, persona);
})();
