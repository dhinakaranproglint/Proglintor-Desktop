'use strict';
/* global agent, TimesheetLogic, TimesheetView, state, view, esc, icon, $, $$ */
// The employee's own timesheet: a month calendar built from real tracked time and task activity, a day-by-day breakdown,
// an AI-written summary of the week or month, and CSV export. It is only ever the person's own data.
const TimesheetPage = (() => {
  const T = TimesheetLogic;
  const V = TimesheetView;
  const S = { month: T.currentMonth(), ts: null, day: null, period: 'week', summary: null, busy: false, error: '', win: null };
  const todayKey = () => { const d = new Date(); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`; };
  const me = (sel) => document.querySelector(sel);

  async function render() {
    view.innerHTML = '<header class="topbar"><div><h1>Timesheet</h1><div class="sub">Your month at a glance, built from your real tracked time and tasks</div></div></header><div class="content" id="ts-root"><p class="muted">Loading…</p></div>';
    await Promise.all([loadMonth(), loadWin()]);
    loadSummary();
  }

  async function loadMonth() {
    const r = await agent.orbit.timesheet(S.month);
    if (state.page !== 'timesheet') return;
    if (!r.ok) { S.ts = null; S.error = r.error; draw(); return; }
    S.error = ''; S.ts = { ...r.data, today: todayKey() };
    const days = S.ts.days;
    S.day = days.find((d) => d.date === S.ts.today) ? S.ts.today : ([...days].reverse().find((d) => d.activeSeconds) || {}).date || null;
    draw();
  }

  async function loadWin() {
    const r = await agent.orbit.achievements();
    S.win = r.ok ? (r.data.recognitions || []).find((x) => x.kind === 'month' && x.status === 'approved') || null : null;
  }

  async function loadSummary() {
    S.busy = true; draw();
    const start = S.period === 'week' ? weekStartFor() : `${S.month}-01`;
    const r = await agent.orbit.timesheetSummary(S.period, start);
    S.busy = false;
    S.summary = r.ok ? r.data : { text: r.error || 'I could not write the summary just now.', source: 'template', label: '' };
    if (state.page === 'timesheet') draw();
  }

  /** Monday of the week being looked at: the current week when it is this month, else the last week of the month. */
  function weekStartFor() {
    const base = S.month === T.currentMonth() ? new Date() : new Date(Number(S.month.slice(0, 4)), Number(S.month.slice(5)), 0);
    const d = new Date(base.getFullYear(), base.getMonth(), base.getDate());
    d.setDate(d.getDate() - ((d.getDay() + 6) % 7));
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  }

  function draw() {
    const root = me('#ts-root');
    if (!root) return;
    if (!S.ts) { root.innerHTML = `<div class="o-card"><p class="muted">${esc(S.error || 'Loading…')}</p></div>`; return; }
    const day = S.ts.days.find((d) => d.date === S.day);
    const win = S.win ? `<div class="eom-win"><div class="trophy">${icon('award', 22)}</div><div style="flex:1"><b>You were ${esc(S.win.title.replace(/^Employee of the Month: /, 'Employee of the Month for '))}</b><span>${esc(S.win.citation || '')}${S.win.reward ? ` Reward: ${esc(S.win.reward)}.` : ''}</span></div><button class="btn sm primary" id="ts-cert">View certificate</button></div>` : '';
    root.innerHTML = `
      <div class="ts-head"><button class="btn sm" id="ts-prev" aria-label="Previous month">${icon('left', 14)}</button><h2>${esc(T.monthLabel(S.month))}</h2>
        <button class="btn sm" id="ts-next" aria-label="Next month" ${S.month >= T.currentMonth() ? 'disabled' : ''}>${icon('right', 14)}</button>
        ${S.month === T.currentMonth() ? '' : '<button class="btn sm" id="ts-now">This month</button>'}<span style="flex:1"></span><button class="btn sm" id="ts-csv">${icon('download', 14)} Export CSV</button></div>
      ${win}${V.totalsHtml(S.ts)}
      <div class="ts-layout"><div><section class="ts-card">${V.calendarHtml(S.ts, S.day)}</section>${V.tasksHtml(S.ts)}</div>
        <aside>${V.summaryHtml(S.summary, S.period, S.busy)}<section class="ts-card">${V.dayHtml(day)}</section></aside></div>`;
    bind(root);
  }

  function bind(root) {
    me('#ts-prev').onclick = () => go(T.shiftMonth(S.month, -1));
    me('#ts-next').onclick = () => go(T.shiftMonth(S.month, 1));
    const now = me('#ts-now'); if (now) now.onclick = () => go(T.currentMonth());
    me('#ts-csv').onclick = async () => { const r = await agent.orbit.timesheetCsv(S.month); toast(!r.ok ? r.error : r.data.saved ? 'Saved.' : 'Not saved.'); };
    root.querySelectorAll('[data-day]').forEach((b) => b.addEventListener('click', () => { S.day = b.dataset.day; draw(); }));
    root.querySelectorAll('[data-period]').forEach((b) => b.addEventListener('click', () => { S.period = b.dataset.period; loadSummary(); }));
    const rf = root.querySelector('[data-refresh]'); if (rf) rf.onclick = () => loadSummary();
    const cert = me('#ts-cert'); if (cert) cert.onclick = openCertificate;
  }

  async function go(month) { S.month = month; S.summary = null; S.ts = null; draw(); await loadMonth(); loadSummary(); }

  async function openCertificate() {
    const r = await agent.orbit.certificate(S.win.id);
    if (!r.ok) { toast(r.error); return; }
    const m = document.createElement('div');
    m.className = 'o-modal'; m.id = 'ts-modal';
    m.innerHTML = `<div class="o-dialog wide" role="dialog" aria-modal="true"><h2>Certificate of Appreciation</h2><p class="lead">${esc(r.data.certificateId)}</p><iframe class="o-cert" sandbox="" title="Certificate"></iframe><div class="foot"><button class="btn" data-close>Close</button><button class="btn primary" id="ts-save">Save as PDF</button></div></div>`;
    m.querySelector('iframe').srcdoc = r.data.html;
    m.addEventListener('mousedown', (e) => { if (e.target === m) m.remove(); });
    m.querySelector('[data-close]').onclick = () => m.remove();
    m.querySelector('#ts-save').onclick = async () => { const s = await agent.orbit.saveCertificate(S.win.id); toast(!s.ok ? s.error : s.data.saved ? 'Saved. Well deserved!' : 'Not saved.'); };
    document.body.appendChild(m);
  }

  function toast(text) {
    let el = document.getElementById('ts-toast');
    if (!el) { el = document.createElement('div'); el.id = 'ts-toast'; el.setAttribute('role', 'status'); el.style.cssText = 'position:fixed;left:50%;bottom:28px;transform:translateX(-50%);z-index:60;background:var(--text);color:var(--bg);padding:10px 16px;border-radius:999px;font:500 13px var(--font);box-shadow:var(--shadow-lg);max-width:80vw'; document.body.appendChild(el); }
    el.textContent = text; el.style.opacity = '1'; clearTimeout(el._t); el._t = setTimeout(() => { el.style.opacity = '0'; }, 3200);
  }

  agent.orbit.onChange(() => { if (state.page === 'timesheet') { loadMonth(); loadWin(); } });
  return { render };
})();
