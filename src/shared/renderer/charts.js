'use strict';
/* global UI */
/* exported Charts */
// Small SVG chart kit: stacked bars, donut, timeline, shared tooltip.

const Charts = (() => {
  const { esc, fmtDur, fmtTime } = UI;
  const tip = () => document.getElementById('tip');

  function showTip(html, ev) {
    const t = tip();
    if (!t) return;
    t.innerHTML = html;
    t.classList.add('show');
    const pad = 14;
    const { innerWidth: W, innerHeight: H } = window;
    const r = t.getBoundingClientRect();
    let x = ev.clientX + pad;
    let y = ev.clientY + pad;
    if (x + r.width > W - 8) x = ev.clientX - r.width - pad;
    if (y + r.height > H - 8) y = ev.clientY - r.height - pad;
    t.style.left = `${x}px`;
    t.style.top = `${y}px`;
  }
  const hideTip = () => tip()?.classList.remove('show');

  /** Picks a readable axis step for a max value in seconds. */
  function niceStep(max) {
    const steps = [60, 120, 300, 600, 900, 1200, 1800, 3600, 7200, 10800, 14400, 21600, 43200, 86400];
    return steps.find((s) => max / s <= 4) || 86400;
  }

  const fmtAxis = (v) => {
    if (!v) return '0';
    if (v >= 3600) return `${+(v / 3600).toFixed(1)}h`;
    return `${Math.round(v / 60)}m`;
  };

  /**
   * Stacked bar chart.
   * buckets: [{ total, parts: { key: seconds } }]
   */
  function bars(el, buckets, { keys, colors, names = {}, label, title, onClick, height = 230, highlight }) {
    const W = Math.max(280, Math.floor(el.clientWidth));
    const H = height, L = 42, R = 6, T = 10, B = 26;
    const plotH = H - T - B;
    const max = Math.max(...buckets.map((b) => b.total), 1);
    const step = niceStep(max);
    const top = Math.max(step, Math.ceil(max / step) * step);
    const cw = (W - L - R) / buckets.length;
    const bw = Math.max(3, Math.min(cw * 0.64, 40));
    const r = Math.min(4, bw / 3);

    let s = `<svg width="${W}" height="${H}" class="${onClick ? 'clickable' : ''}" role="img">`;
    for (let v = 0; v <= top + 1e-6; v += step) {
      const y = T + plotH * (1 - v / top);
      s += `<line class="gridline" x1="${L}" x2="${W - R}" y1="${y}" y2="${y}"/><text class="axis" x="${L - 8}" y="${y + 4}" text-anchor="end">${fmtAxis(v)}</text>`;
    }
    buckets.forEach((b, i) => {
      const x = L + i * cw + (cw - bw) / 2;
      let y = T + plotH;
      const segs = keys.filter((k) => (b.parts?.[k] || 0) > 0);
      segs.forEach((k, j) => {
        const h = Math.max(1, (plotH * b.parts[k]) / top);
        y -= h;
        const isTop = j === segs.length - 1;
        const fill = colors[k] || '#94a3b8';
        const op = highlight != null && highlight !== i ? 0.35 : 1;
        if (isTop && h > r) {
          // Rounded top only for the top segment.
          s += `<path d="M${x},${y + h} v${-(h - r)} q0,${-r} ${r},${-r} h${bw - 2 * r} q${r},0 ${r},${r} v${h - r} z" style="fill:${fill};opacity:${op}"/>`;
        } else {
          s += `<rect x="${x}" y="${y}" width="${bw}" height="${h}" style="fill:${fill};opacity:${op}"/>`;
        }
      });
      const lb = label?.(b, i);
      if (lb) s += `<text class="axis" x="${x + bw / 2}" y="${H - 8}" text-anchor="middle">${esc(lb)}</text>`;
      s += `<rect class="hit" data-i="${i}" x="${L + i * cw}" y="${T}" width="${cw}" height="${plotH}" rx="6"/>`;
    });
    el.innerHTML = `${s}</svg>`;

    el.querySelectorAll('.hit').forEach((h) => {
      const b = buckets[Number(h.dataset.i)];
      const rows = keys.filter((k) => (b.parts?.[k] || 0) > 0).sort((a, z) => b.parts[z] - b.parts[a])
        .map((k) => `<div class="t-row"><span class="swatch" style="background:${colors[k] || '#94a3b8'}"></span><span class="n">${esc(names[k] || k)}</span><span class="v">${fmtDur(b.parts[k])}</span></div>`).join('');
      const html = `<div class="t-head"><span>${esc(title(b))}</span><span>${fmtDur(b.total)}</span></div>${rows || '<div class="muted">No activity</div>'}`;
      h.addEventListener('mousemove', (ev) => showTip(html, ev));
      h.addEventListener('mouseleave', hideTip);
      if (onClick) h.addEventListener('click', () => { hideTip(); onClick(b); });
    });
  }

  /** Donut with legend. items: [{ id, name, seconds, color }] */
  function donut(el, items, total) {
    const size = 150, sw = 20, R = (size - sw) / 2, C = 2 * Math.PI * R;
    let acc = 0;
    let arcs = '';
    for (const it of items) {
      const len = total ? (it.seconds / total) * C : 0;
      if (len <= 0) continue;
      const gap = items.length > 1 ? Math.min(2, len / 3) : 0;
      arcs += `<circle cx="${size / 2}" cy="${size / 2}" r="${R}" fill="none" style="stroke:${it.color}" stroke-width="${sw}"
        stroke-dasharray="${Math.max(0, len - gap)} ${C}" stroke-dashoffset="${-acc}" transform="rotate(-90 ${size / 2} ${size / 2})"><title>${esc(it.name)}: ${fmtDur(it.seconds)}</title></circle>`;
      acc += len;
    }
    const legend = items.map((it) => `<div><span class="swatch" style="background:${it.color}"></span><span class="n">${esc(it.name)}</span><span class="p">${total ? Math.round((it.seconds / total) * 100) : 0}%</span></div>`).join('');
    el.innerHTML = `<div class="donut-wrap">
      <svg width="${size}" height="${size}"><circle cx="${size / 2}" cy="${size / 2}" r="${R}" fill="none" style="stroke:var(--surface-2)" stroke-width="${sw}"/>${arcs}
        <text class="donut-center" x="50%" y="${size / 2 + 2}" text-anchor="middle">${esc(fmtDur(total))}</text>
        <text class="donut-sub" x="50%" y="${size / 2 + 19}" text-anchor="middle">total</text></svg>
      <div class="donut-legend">${legend}</div></div>`;
  }

  /** Timeline lanes for one day. rows: [{ id, name, path, sessions, color }] */
  function timeline(el, rows, dayStart, dayEnd, iconFn) {
    const span = dayEnd - dayStart;
    const pct = (t) => ((Math.min(Math.max(t, dayStart), dayEnd) - dayStart) / span) * 100;
    const now = Date.now();
    const nowLine = now > dayStart && now < dayEnd ? `<span class="tl-now" style="left:${pct(now)}%"></span>` : '';
    const lanes = rows.map((r) => `
      <div class="tl-row">${iconFn(r)}<span class="n" title="${esc(r.name)}">${esc(r.name)}</span>
        <div class="tl-track">${r.sessions.map(([s, e]) => `<span class="tl-seg" data-tip="${esc(r.name)}|${fmtTime(s)} – ${fmtTime(e)}|${fmtDur((e - s) / 1000)}" style="left:${pct(s)}%;width:${Math.max(0.15, pct(e) - pct(s))}%;background:${r.color}"></span>`).join('')}${nowLine}</div>
      </div>`).join('');
    const ticks = [0, 3, 6, 9, 12, 15, 18, 21, 24].map((h) => `<span style="left:${(h / 24) * 100}%">${String(h).padStart(2, '0')}</span>`).join('');
    el.innerHTML = `<div class="tl">${lanes}<div class="tl-axis"><span></span><span></span><div class="tl-ticks">${ticks}</div></div></div>`;
    el.querySelectorAll('.tl-seg').forEach((seg) => {
      const [n, t, d] = seg.dataset.tip.split('|');
      const html = `<div class="t-head"><span>${esc(n)}</span><span>${esc(d)}</span></div><div class="muted">${esc(t)}</div>`;
      seg.addEventListener('mousemove', (ev) => showTip(html, ev));
      seg.addEventListener('mouseleave', hideTip);
    });
  }

  return { bars, donut, timeline, hideTip };
})();
