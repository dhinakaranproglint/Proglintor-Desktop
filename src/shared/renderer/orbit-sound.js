'use strict';
// Orbit's sounds: tiny synthesised tones (no audio files). Three themes, a volume, and an optional spoken greeting.
// Nothing plays unless the employee has sounds on, and a silent theme really is silent.
const OrbitSound = (() => {
  let ctx = null;

  const NOTE = { C4: 261.63, D4: 293.66, E4: 329.63, G4: 392, A4: 440, C5: 523.25, D5: 587.33, E5: 659.25, G5: 783.99, A5: 880, C6: 1046.5, E6: 1318.5 };
  const THEMES = {
    chime: { type: 'sine', decay: 0.9, partial: 2.01, seqs: { greet: ['G4', 'C5', 'E5', 'G5'], send: ['E5'], receive: ['C5', 'G5'], celebrate: ['C5', 'E5', 'G5', 'C6', 'E6'], notify: ['G5', 'E5'] }, step: 0.11 },
    soft: { type: 'triangle', decay: 1.1, partial: 0, seqs: { greet: ['C4', 'G4', 'C5'], send: ['G4'], receive: ['E4', 'A4'], celebrate: ['C4', 'E4', 'G4', 'C5'], notify: ['A4', 'E4'] }, step: 0.15 },
    sparkle: { type: 'sine', decay: 0.45, partial: 3, seqs: { greet: ['C5', 'E5', 'G5', 'C6', 'E6'], send: ['A5'], receive: ['E5', 'C6'], celebrate: ['C5', 'D5', 'E5', 'G5', 'A5', 'C6', 'E6'], notify: ['C6', 'E6'] }, step: 0.07 },
  };

  function audio() {
    if (!ctx) {
      const AC = window.AudioContext || window.webkitAudioContext;
      if (!AC) return null;
      try { ctx = new AC(); } catch { return null; }
    }
    if (ctx.state === 'suspended') ctx.resume().catch(() => {});
    return ctx;
  }

  function tone(c, freq, at, dur, type, vol) {
    const o = c.createOscillator(); const g = c.createGain();
    o.type = type; o.frequency.setValueAtTime(freq, at);
    g.gain.setValueAtTime(0.0001, at);
    g.gain.exponentialRampToValueAtTime(Math.max(0.0002, vol), at + 0.012);
    g.gain.exponentialRampToValueAtTime(0.0001, at + dur);
    o.connect(g); g.connect(c.destination);
    o.start(at); o.stop(at + dur + 0.05);
  }

  /** @param {'greet'|'send'|'receive'|'celebrate'|'notify'} name  @param {{sound:string, volume:number}} persona */
  function play(name, persona) {
    const theme = THEMES[persona?.sound];
    if (!theme || !(persona.volume > 0)) return false;
    const c = audio();
    if (!c) return false;
    const seq = theme.seqs[name] || theme.seqs.notify;
    const vol = Math.min(1, persona.volume) * 0.22;
    const t0 = c.currentTime + 0.02;
    seq.forEach((n, i) => {
      const f = NOTE[n];
      tone(c, f, t0 + i * theme.step, theme.decay, theme.type, vol);
      if (theme.partial) tone(c, f * theme.partial, t0 + i * theme.step, theme.decay * 0.6, 'sine', vol * 0.25);
    });
    return true;
  }

  /** Says the text aloud with the computer's own voice. Only when the employee asked for it. */
  function speak(text, persona) {
    if (!persona?.speak || !(persona.volume > 0) || typeof speechSynthesis === 'undefined') return false;
    try {
      speechSynthesis.cancel();
      const u = new SpeechSynthesisUtterance(String(text).slice(0, 300));
      u.volume = Math.min(1, persona.volume + 0.3); u.rate = 1.02; u.pitch = 1.05;
      speechSynthesis.speak(u);
      return true;
    } catch { return false; }
  }

  function hush() { try { speechSynthesis?.cancel(); } catch { /* nothing speaking */ } }

  return { play, speak, hush, THEMES };
})();
if (typeof module === 'object' && module.exports) module.exports = OrbitSound;
