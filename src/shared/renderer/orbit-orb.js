'use strict';
// The Orbit orb: a living, colourful companion drawn on a canvas. No images, no libraries.
// States: idle (breathing), listening (leans in while you type), thinking (swirls), speaking (dances with the words), celebrate (burst of stars).
// Styles: aurora (flowing light), pulse (rings), particles (little moons), wave (a ring that moves like a voice).
// Honours "reduce motion" (a calm still frame) and stops drawing while the window is hidden.
const OrbitOrb = (() => {
  const TAU = Math.PI * 2;

  function rgbToHsl(r, g, b) {
    r /= 255; g /= 255; b /= 255;
    const max = Math.max(r, g, b); const min = Math.min(r, g, b);
    let h = 0; let s = 0; const l = (max + min) / 2;
    if (max !== min) {
      const d = max - min;
      s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
      if (max === r) h = (g - b) / d + (g < b ? 6 : 0); else if (max === g) h = (b - r) / d + 2; else h = (r - g) / d + 4;
      h /= 6;
    }
    return [h * 360, s, l];
  }

  const hsl = (h, s, l, a = 1) => `hsla(${((h % 360) + 360) % 360}, ${Math.round(s * 100)}%, ${Math.round(l * 100)}%, ${a})`;

  const TARGETS = {
    idle: { energy: 0.25, spin: 0.25 },
    listening: { energy: 0.55, spin: 0.5 },
    thinking: { energy: 0.8, spin: 2.2 },
    speaking: { energy: 0.7, spin: 0.9 },
    celebrate: { energy: 1, spin: 1.6 },
  };

  function create(canvas, opts = {}) {
    const ctx = canvas.getContext('2d');
    let color = opts.color || '#7C5CFF';
    let style = opts.style || 'aurora';
    let motion = opts.motion !== false;
    let state = 'idle';
    let energy = 0.25; let spin = 0.25; let phase = 0; let level = 0; let levelTarget = 0;
    let raf = 0; let last = 0; let w = 0; let h = 0; let dpr = 1;
    let base = [270, 0.9, 0.62];
    const stars = [];
    const moons = Array.from({ length: 16 }, (_, i) => ({ a: (i / 16) * TAU, r: 0.62 + (i % 4) * 0.08, s: 0.4 + (i % 5) * 0.13, size: 1.2 + (i % 3) * 0.9, off: i * 1.7 }));
    const reduced = () => !motion || (typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches);

    function setColor(hex) {
      color = hex;
      const m = /^#([0-9a-f]{6})$/i.exec(hex) || [null, '7C5CFF'];
      base = rgbToHsl(parseInt(m[1].slice(0, 2), 16), parseInt(m[1].slice(2, 4), 16), parseInt(m[1].slice(4, 6), 16));
      base[1] = Math.max(base[1], 0.65);
      base[2] = Math.min(Math.max(base[2], 0.5), 0.66);
      if (!raf) draw(0);
    }

    function resize() {
      const r = canvas.getBoundingClientRect();
      dpr = Math.min(window.devicePixelRatio || 1, 2);
      w = Math.max(40, r.width); h = Math.max(40, r.height);
      canvas.width = Math.round(w * dpr); canvas.height = Math.round(h * dpr);
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      if (!raf) draw(0);
    }

    function glow(cx, cy, r, c0, c1) {
      const g = ctx.createRadialGradient(cx, cy, 0, cx, cy, r);
      g.addColorStop(0, c0); g.addColorStop(1, c1);
      ctx.fillStyle = g;
      ctx.beginPath(); ctx.arc(cx, cy, r, 0, TAU); ctx.fill();
    }

    function draw(dt) {
      const t = TARGETS[state];
      const k = Math.min(1, dt * 3.2);
      energy += (t.energy - energy) * k; spin += (t.spin - spin) * k;
      level += (levelTarget - level) * Math.min(1, dt * 14); levelTarget *= 0.9;
      phase += dt * (0.6 + spin);
      ctx.clearRect(0, 0, w, h);
      const cx = w / 2; const cy = h / 2; const side = Math.min(w, h); const R = side * 0.235;
      const breathe = 1 + Math.sin(phase * 1.4) * (0.03 + energy * 0.03) + level * 0.08;
      const r = R * breathe;
      const [H, S, Lm] = base;

      // halo
      glow(cx, cy, side * 0.5, hsl(H, S, Lm, 0.26 + energy * 0.2), hsl(H, S, Lm, 0));

      ctx.save();
      ctx.globalCompositeOperation = 'lighter';
      if (style === 'pulse') {
        const rings = 4;
        for (let i = 0; i < rings; i++) {
          const p = ((phase * (0.22 + energy * 0.25)) + i / rings) % 1;
          ctx.strokeStyle = hsl(H + i * 14, S, Lm + 0.08, (1 - p) * (0.45 + energy * 0.3));
          ctx.lineWidth = 2 + (1 - p) * 3;
          ctx.beginPath(); ctx.arc(cx, cy, r * (1 + p * 1.05), 0, TAU); ctx.stroke();
        }
      } else if (style === 'particles') {
        for (const m of moons) {
          const a = m.a + phase * m.s * (0.6 + spin * 0.5);
          const rr = r * (1.25 + (m.r - 0.62) * 2.2) * (1 + Math.sin(phase + m.off) * 0.04 + level * 0.1);
          const x = cx + Math.cos(a) * rr; const y = cy + Math.sin(a) * rr * 0.86;
          for (let tr = 5; tr >= 0; tr--) {
            const ta = a - tr * 0.07 * (0.6 + spin);
            ctx.fillStyle = hsl(H + m.off * 6, S, Lm + 0.12, (1 - tr / 6) * 0.55);
            ctx.beginPath(); ctx.arc(cx + Math.cos(ta) * rr, cy + Math.sin(ta) * rr * 0.86, m.size * (1 - tr / 9) * (1 + energy * 0.5), 0, TAU); ctx.fill();
          }
          ctx.fillStyle = hsl(H + m.off * 6, S, Lm + 0.2, 0.95);
          ctx.beginPath(); ctx.arc(x, y, m.size * (1 + energy * 0.5), 0, TAU); ctx.fill();
        }
      } else if (style === 'wave') {
        const n = 90;
        for (let layer = 0; layer < 3; layer++) {
          ctx.beginPath();
          for (let i = 0; i <= n; i++) {
            const a = (i / n) * TAU;
            const wob = Math.sin(a * (3 + layer) + phase * (1.6 + layer * 0.5)) * (0.05 + energy * 0.12 + level * 0.3) + Math.sin(a * 7 - phase * 2.1) * (0.02 + level * 0.12);
            const rr = r * (1.28 + layer * 0.12 + wob);
            const x = cx + Math.cos(a) * rr; const y = cy + Math.sin(a) * rr;
            if (i) ctx.lineTo(x, y); else ctx.moveTo(x, y);
          }
          ctx.closePath();
          ctx.strokeStyle = hsl(H + layer * 22, S, Lm + 0.1, 0.55 - layer * 0.12);
          ctx.lineWidth = 2.2;
          ctx.stroke();
        }
      }

      // body (clipped sphere)
      ctx.save();
      ctx.beginPath(); ctx.arc(cx, cy, r, 0, TAU); ctx.clip();
      ctx.globalCompositeOperation = 'source-over';
      glow(cx - r * 0.25, cy - r * 0.3, r * 1.6, hsl(H + 16, S, Lm + 0.1, 1), hsl(H - 12, S, Lm - 0.24, 1));
      ctx.globalCompositeOperation = 'lighter';
      const blobs = style === 'aurora' ? 4 : 2;
      for (let i = 0; i < blobs; i++) {
        const a = phase * (0.5 + i * 0.23 + spin * 0.4) + i * 1.9;
        const bx = cx + Math.cos(a) * r * 0.5; const by = cy + Math.sin(a * 1.3) * r * 0.5;
        glow(bx, by, r * (0.7 + energy * 0.25), hsl(H + 40 * (i - 1.5), S, Lm + 0.04, 0.36 + energy * 0.14), hsl(H + 40 * (i - 1.5), S, Lm, 0));
      }
      if (state === 'thinking') {
        ctx.strokeStyle = 'rgba(255,255,255,0.65)'; ctx.lineWidth = 2.4; ctx.lineCap = 'round';
        for (let i = 0; i < 3; i++) {
          const a0 = phase * 3.2 + i * (TAU / 3);
          ctx.beginPath(); ctx.arc(cx, cy, r * (0.45 + i * 0.16), a0, a0 + 1.1); ctx.stroke();
        }
      }
      ctx.globalCompositeOperation = 'source-over';
      glow(cx - r * 0.42, cy - r * 0.5, r * 0.42, 'rgba(255,255,255,0.38)', 'rgba(255,255,255,0)'); // specular highlight
      ctx.restore();
      ctx.restore();

      // little face: two eyes that blink and smile when happy (gives it personality without being cartoonish)
      const blink = (Math.sin(phase * 0.9) > 0.985 || (phase * 0.9) % 6.3 > 6.2) ? 0.12 : 1;
      const ink = hsl(H, 0.55, 0.14, 0.88);
      ctx.fillStyle = ink;
      const ex = r * 0.26; const ey = cy - r * 0.02; const er = r * 0.07;
      for (const sx of [-1, 1]) { ctx.beginPath(); ctx.ellipse(cx + sx * ex, ey, er, er * 1.35 * blink, 0, 0, TAU); ctx.fill(); }
      ctx.strokeStyle = ink; ctx.lineWidth = Math.max(1.8, r * 0.04); ctx.lineCap = 'round';
      ctx.beginPath();
      const smile = state === 'celebrate' ? 0.34 : state === 'speaking' ? 0.1 + level * 0.5 : 0.16;
      ctx.arc(cx, cy + r * 0.12, r * 0.2, Math.PI * (0.18 - 0.0), Math.PI * (0.82), false);
      if (state === 'speaking' || state === 'celebrate') { ctx.stroke(); ctx.beginPath(); ctx.ellipse(cx, cy + r * 0.3, r * 0.08, r * smile * 0.35, 0, 0, TAU); ctx.fillStyle = hsl(H, 0.5, 0.12, 0.55); ctx.fill(); } else ctx.stroke();

      // celebration stars
      for (let i = stars.length - 1; i >= 0; i--) {
        const s = stars[i];
        s.life -= dt; s.x += s.vx * dt; s.y += s.vy * dt; s.vy += 220 * dt; s.rot += s.vr * dt;
        if (s.life <= 0) { stars.splice(i, 1); continue; }
        ctx.save(); ctx.translate(s.x, s.y); ctx.rotate(s.rot);
        ctx.fillStyle = hsl(s.hue, 0.95, 0.65, Math.min(1, s.life * 1.6));
        ctx.beginPath();
        for (let p = 0; p < 10; p++) { const rr = p % 2 ? s.size * 0.45 : s.size; ctx.lineTo(Math.cos((p / 10) * TAU) * rr, Math.sin((p / 10) * TAU) * rr); }
        ctx.closePath(); ctx.fill(); ctx.restore();
      }
    }

    function loop(now) {
      raf = requestAnimationFrame(loop);
      if (document.hidden) { last = now; return; }
      const dt = Math.min(0.05, ((now - last) / 1000) || 0.016);
      last = now;
      draw(dt);
    }

    function start() {
      if (reduced()) { draw(0.016); return; }
      if (!raf) { last = performance.now(); raf = requestAnimationFrame(loop); }
    }
    function stop() { cancelAnimationFrame(raf); raf = 0; }

    const ro = typeof ResizeObserver === 'function' ? new ResizeObserver(resize) : null;
    ro?.observe(canvas);
    setColor(color);
    resize();
    start();

    return {
      setState(s) { if (TARGETS[s]) { state = s; if (!raf) draw(0.4); } },
      get state() { return state; },
      setColor,
      setStyle(s) { style = s; if (!raf) draw(0); },
      setMotion(on) { motion = on !== false; stop(); start(); },
      /** 0..1 loudness, pushed as words appear so the orb "talks". */
      level(v) { levelTarget = Math.max(levelTarget, Math.min(1, v)); },
      burst(n = 46) {
        const cx = w / 2; const cy = h / 2;
        for (let i = 0; i < n; i++) {
          const a = Math.random() * TAU; const v = 120 + Math.random() * 220;
          stars.push({ x: cx, y: cy, vx: Math.cos(a) * v, vy: Math.sin(a) * v - 120, life: 1.1 + Math.random() * 0.9, rot: Math.random() * TAU, vr: (Math.random() - 0.5) * 8, size: 3 + Math.random() * 5, hue: base[0] + (Math.random() - 0.5) * 140 });
        }
        if (reduced()) return;
        this.setState('celebrate');
        setTimeout(() => { if (state === 'celebrate') this.setState('idle'); }, 1800);
      },
      destroy() { stop(); ro?.disconnect(); },
    };
  }

  return { create };
})();
if (typeof module === 'object' && module.exports) module.exports = OrbitOrb;
