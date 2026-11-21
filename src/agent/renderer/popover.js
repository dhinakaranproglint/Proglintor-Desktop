'use strict';
/* global agent, UI */
// Tray / menu-bar popover: today's total, what is being tracked now, top apps.

const { esc, fmtDur, fmtBig, fmtClock, icon, appIcon, hydrate } = UI;
const PALETTE = ['#EF6A4C', '#6366f1', '#10b981', '#ec4899', '#06b6d4', '#8b5cf6'];
document.body.classList.add(`platform-${agent.platform}`);

let status = null;

async function render() {
  const [d, st] = await Promise.all([agent.rangeView('day'), agent.status()]);
  status = st;
  const cur = st.current;
  const max = d.summaries[0]?.seconds || 1;
  const stateText = { idle: 'Idle — not counting', locked: 'Screen locked', paused: st.paused ? 'Tracking paused' : 'Paused (sleep)', unavailable: 'Detection unavailable', starting: 'Starting…' }[st.state] || 'Waiting for activity…';
  const cls = { tracking: 'tracking', idle: 'idle', locked: 'locked', unavailable: 'unavailable' }[st.state] || '';
  let delta = '';
  if (d.prevTotal) {
    const r = (d.total - d.prevTotal) / d.prevTotal;
    delta = Math.abs(r) < 0.02 ? '<span class="delta flat">Same as yesterday</span>'
      : `<span class="delta ${r > 0 ? 'up' : 'down'}">${icon(r > 0 ? 'up' : 'down', 12)} ${Math.round(Math.abs(r) * 100)}% vs yesterday</span>`;
  }

  document.getElementById('pop').innerHTML = `
    <section class="card">
      <div class="eyebrow">${icon('clock', 13)} Today</div>
      <div class="big">${fmtBig(d.total)}</div>
      ${delta}
    </section>
    <section class="card">
      <div class="eyebrow"><span class="dot ${cls}"></span> Now</div>
      ${cur ? `<div class="now-app" style="margin-top:10px">${appIcon(cur.id, cur.path, 36, cur.name)}<div style="min-width:0"><div class="now-name" style="font-size:15px">${esc(cur.name)}</div><div class="num muted" data-timer>${fmtClock(st.sessionStart ? (Date.now() - st.sessionStart) / 1000 : 0)}</div></div></div>`
        : `<div class="muted" style="margin-top:8px">${esc(stateText)}</div>`}
    </section>
    <div class="applist">${d.summaries.slice(0, 6).map((s, i) => `
      <div class="approw">${appIcon(s.id, s.path, 26, s.name)}<span class="nm">${esc(s.name)}</span>
        <span class="bar"><i style="width:${(s.seconds / max) * 100}%;background:${PALETTE[i]}"></i></span>
        <span class="tm">${fmtDur(s.seconds)}</span></div>`).join('') || '<div class="muted small" style="padding:6px">No activity yet today.</div>'}
    </div>
    <div class="foot">
      <button class="btn primary" id="open">${icon('overview', 14)} Open Dashboard</button>
    </div>`;

  document.getElementById('open').onclick = () => agent.showWindow();
  hydrate(document);
}

setInterval(() => {
  if (!status?.sessionStart) return;
  const t = fmtClock((Date.now() - status.sessionStart) / 1000);
  document.querySelectorAll('[data-timer]').forEach((el) => { el.textContent = t; });
}, 1000);

agent.onUpdate(() => { if (!document.hidden) render(); });
document.addEventListener('visibilitychange', () => { if (!document.hidden) render(); });
render();
