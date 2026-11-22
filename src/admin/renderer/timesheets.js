'use strict';
/* global admin, state, view, esc, icon, rel, $, $$, topbar, closeDialog, dialogShell, flash, hue, initials, TimesheetLogic, TimesheetView */
// Admin pages for timesheets and Employee of the Month. The timesheet is exactly what the employee sees (built from their real tracked time and
// task activity); the monthly ranking is a transparent guide with the score broken down, and the admin makes the decision.
const AdminTime = (() => {
  const T = TimesheetLogic;
  const V = TimesheetView;
  const ts = { asset: '', month: T.currentMonth(), data: null, day: null, period: 'month', summary: null, busy: false, people: [] };
  const aw = { month: T.shiftMonth(T.currentMonth(), -1), data: null, history: [] };
  const todayKey = () => { const d = new Date(); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`; };
  const avatar = (n) => `<span class="avatar" style="--h:${hue(n)}">${esc(initials(n))}</span>`;
  const REWARDS = ['Comp-off day', 'Gift card', 'Learning budget', 'Bonus credits', 'Shout-out at the team meeting'];

  // ---- timesheets --------------------------------------------------------------------------------

  async function renderTimesheets() {
    if (!ts.people.length) ts.people = (await admin.assets()).filter((a) => a.enrolled);
    if (state.page !== 'timesheets') return;
    if (!ts.asset || !ts.people.some((p) => p.assetId === ts.asset)) ts.asset = (ts.people[0] || {}).assetId || '';
    view.innerHTML = `${topbar('Timesheets', 'Real tracked time and task activity, with an AI summary: the same view each employee has')}<div class="content" id="at-root"></div>`;
    if (!ts.asset) { $('#at-root').innerHTML = '<section class="card"><div class="empty"><b>No connected laptops yet</b>Timesheets appear once employees connect.</div></section>'; return; }
    await loadTs();
    loadSummary();
  }

  async function loadTs() {
    try {
      const d = await admin.employeeTimesheet(ts.asset, ts.month);
      if (state.page !== 'timesheets') return;
      ts.data = { ...d, today: todayKey() };
      const days = ts.data.days;
      ts.day = days.find((x) => x.date === ts.data.today) ? ts.data.today : ([...days].reverse().find((x) => x.activeSeconds) || {}).date || null;
    } catch (err) { ts.data = null; flash(err.message, 'bad'); }
    drawTs();
  }

  async function loadSummary() {
    ts.busy = true; drawTs();
    const start = ts.period === 'week' ? weekStart() : `${ts.month}-01`;
    try { ts.summary = await admin.timesheetSummary(ts.asset, ts.period, start); } catch (err) { ts.summary = { text: err.message, source: 'template', label: '' }; }
    ts.busy = false;
    if (state.page === 'timesheets') drawTs();
  }

  function weekStart() {
    const base = ts.month === T.currentMonth() ? new Date() : new Date(Number(ts.month.slice(0, 4)), Number(ts.month.slice(5)), 0);
    const d = new Date(base.getFullYear(), base.getMonth(), base.getDate());
    d.setDate(d.getDate() - ((d.getDay() + 6) % 7));
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  }

  function drawTs() {
    const root = $('#at-root');
    if (!root) return;
    const day = ts.data && ts.data.days.find((d) => d.date === ts.day);
    root.innerHTML = `
      <div class="ts-head"><select id="at-who" aria-label="Employee" style="border:1px solid var(--border-strong);background:var(--surface);color:var(--text);border-radius:10px;padding:8px 10px;font:600 13px var(--font)">${ts.people.map((p) => `<option value="${esc(p.assetId)}" ${p.assetId === ts.asset ? 'selected' : ''}>${esc(p.employeeName)} (${esc(p.assetId)})</option>`).join('')}</select>
        <button class="btn sm" id="at-prev" aria-label="Previous month">${icon('left', 14)}</button><h2>${esc(T.monthLabel(ts.month))}</h2>
        <button class="btn sm" id="at-next" aria-label="Next month" ${ts.month >= T.currentMonth() ? 'disabled' : ''}>${icon('right', 14)}</button></div>
      ${ts.data ? `${V.totalsHtml(ts.data)}<div class="ts-layout"><div><section class="ts-card">${V.calendarHtml(ts.data, ts.day)}</section>${V.tasksHtml(ts.data)}</div>
        <aside>${V.summaryHtml(ts.summary, ts.period, ts.busy)}<section class="ts-card">${V.dayHtml(day)}</section></aside></div>` : '<p class="muted">Loading…</p>'}`;
    $('#at-who').onchange = (e) => { ts.asset = e.target.value; ts.summary = null; ts.data = null; drawTs(); loadTs().then(loadSummary); };
    $('#at-prev').onclick = () => nav(-1);
    $('#at-next').onclick = () => nav(1);
    root.querySelectorAll('[data-day]').forEach((b) => b.addEventListener('click', () => { ts.day = b.dataset.day; drawTs(); }));
    root.querySelectorAll('[data-period]').forEach((b) => b.addEventListener('click', () => { ts.period = b.dataset.period; loadSummary(); }));
    const rf = root.querySelector('[data-refresh]'); if (rf) rf.onclick = () => loadSummary();
  }

  function nav(d) { ts.month = T.shiftMonth(ts.month, d); ts.summary = null; ts.data = null; drawTs(); loadTs().then(loadSummary); }

  // ---- Employee of the Month ---------------------------------------------------------------------

  async function renderAwards() {
    if (document.activeElement?.closest?.('.dialog')) return;
    const [cand, hist] = await Promise.all([admin.awardCandidates(aw.month), admin.awards()]);
    if (state.page !== 'awards') return;
    aw.data = cand; aw.history = hist.items || [];
    const win = cand.award;
    const winner = win ? `<div class="eom-win"><div class="trophy">${icon('award', 22)}</div><div style="flex:1;min-width:0"><b>${esc(win.employeeName)} is Employee of the Month for ${esc(cand.label)}</b>
      <span>${esc(win.citation)}${win.reward ? ` Reward: ${esc(win.reward)}.` : ''}</span></div><button class="btn sm" data-cert="${esc(win.recognitionId)}">Certificate</button></div>` : '';
    const cards = cand.candidates.length ? cand.candidates.map(candidateCard).join('') : `<section class="card"><div class="empty"><div class="ei">${icon('award', 24)}</div><b>Nothing to compare yet</b>Once people have tracked time or finished tasks this month, they appear here.</div></section>`;
    const past = aw.history.length ? `<section class="card" style="padding:16px;margin-top:18px"><div class="card-head"><h3>Past winners</h3></div>${aw.history.map((h) => `<div class="eom-recs" style="display:flex;justify-content:space-between;gap:12px;padding:8px 0;border-top:1px solid var(--border)"><span><b>${esc(T.monthLabel(h.month))}</b> · ${esc(h.employeeName)}${h.reward ? ` · ${esc(h.reward)}` : ''}</span><button class="btn sm" data-cert="${esc(h.recognitionId)}">Certificate</button></div>`).join('')}</section>` : '';
    view.innerHTML = `${topbar('Employee of the Month', 'See how everyone did, read their appreciation, and choose who to reward')}
      <div class="content"><div class="ts-head"><button class="btn sm" id="aw-prev" aria-label="Previous month">${icon('left', 14)}</button><h2>${esc(cand.label)}</h2>
        <button class="btn sm" id="aw-next" aria-label="Next month" ${aw.month >= T.currentMonth() ? 'disabled' : ''}>${icon('right', 14)}</button></div>
        ${winner}<p class="muted small" style="margin:0 0 14px">${esc(cand.method)}</p>${cards}${past}</div>`;
    $('#aw-prev').onclick = () => { aw.month = T.shiftMonth(aw.month, -1); renderAwards(); };
    $('#aw-next').onclick = () => { aw.month = T.shiftMonth(aw.month, 1); renderAwards(); };
    $$('[data-cert]').forEach((b) => b.addEventListener('click', () => showCert(b.dataset.cert)));
    $$('[data-choose]').forEach((b) => b.addEventListener('click', () => chooseDialog(b.dataset.choose)));
    $$('[data-sheet]').forEach((b) => b.addEventListener('click', () => { ts.asset = b.dataset.sheet; ts.month = aw.month; ts.summary = null; ts.data = null; go('timesheets'); }));
  }

  function candidateCard(c) {
    const parts = [['delivery', 'Delivery'], ['reliability', 'Reliability'], ['consistency', 'Consistency'], ['appreciation', 'Appreciation']].map(([k, l]) => {
      const p = c.breakdown[k];
      return `<div class="eom-part"><span><b>${l}</b><b>${esc(p.score)}</b></span><div class="ts-bar"><i style="width:${esc(p.score)}%"></i></div><small>${esc(p.detail)}</small></div>`;
    }).join('');
    const flags = c.flags.map((f) => `<span class="eom-flag">${esc(f)}</span>`).join('');
    const recs = c.recognitions.length ? `<div class="eom-recs"><b>Appreciation this month:</b> ${c.recognitions.map((r) => esc(r.title)).join(' · ')}</div>` : '<div class="eom-recs">No recognitions approved this month.</div>';
    const f = c.facts;
    return `<section class="eom-card ${c.rank === 1 ? 'first' : ''}"><div class="eom-top"><div class="eom-rank">${esc(c.rank)}</div>${avatar(c.employeeName)}
      <div style="min-width:0"><b style="font-size:15px">${esc(c.employeeName)}</b><div class="muted small">${esc(c.department || c.assetId)} · ${esc(T.fmtHours(f.activeHours))} tracked · ${esc(f.tasksCompleted)} tasks done${f.onTimeRate == null ? '' : ` · ${esc(f.onTimeRate)}% on time`}</div></div>
      <div class="eom-score"><b>${esc(c.score)}</b><span>out of 100</span></div></div>
      <div class="eom-parts">${parts}</div>${flags}${recs}
      ${c.topTasks.length ? `<div class="eom-recs"><b>Finished:</b> ${c.topTasks.map(esc).join(' · ')}</div>` : ''}
      <div class="eom-actions"><button class="btn sm" data-sheet="${esc(c.assetId)}">View timesheet</button><button class="btn sm primary" data-choose="${esc(c.assetId)}">${icon('award', 14)} Choose as Employee of the Month</button></div></section>`;
  }

  function chooseDialog(assetId) {
    const c = aw.data.candidates.find((x) => x.assetId === assetId);
    const existing = aw.data.award;
    dialogShell(`<form id="aw-form"><h2 style="margin:0 0 4px">Employee of the Month: ${esc(c.employeeName)}</h2>
      <p class="muted small" style="margin:0 0 12px">${esc(aw.data.label)}. They get a certificate and a notification right away.</p>
      ${existing ? `<div class="banner warn" style="margin:0 0 12px"><div class="bt"><b>${esc(existing.employeeName)} is already chosen for this month.</b> Choosing ${esc(c.employeeName)} replaces them and removes their certificate.</div></div>` : ''}
      <div class="form-grid">
        <label class="field full"><span>Reward</span><input name="reward" maxlength="200" placeholder="e.g. Extra day off"></label>
        <div class="field full"><span>Ideas</span><div class="o-ideas" style="display:flex;gap:6px;flex-wrap:wrap">${REWARDS.map((r) => `<button type="button" class="chip" data-idea="${esc(r)}">${esc(r)}</button>`).join('')}</div></div>
        <label class="field"><span>Credits</span><input name="credits" type="number" min="0" max="10" step="0.5" value="2"></label>
        <label class="field full"><span>Citation on the certificate</span><textarea name="citation" rows="3" maxlength="600">${esc(c.suggestedCitation)}</textarea></label>
      </div><div style="display:flex;gap:8px;margin:6px 0 10px"><button type="button" class="btn sm" id="aw-ai">${icon('spark', 13)} Write it with AI</button><span class="muted small" id="aw-ai-note"></span></div>
      <p class="muted small" id="aw-msg" role="alert" style="min-height:18px;color:var(--red)"></p>
      <div style="display:flex;justify-content:flex-end;gap:8px"><button type="button" class="btn" id="aw-cancel">Cancel</button><button class="btn primary" type="submit">${existing ? 'Replace and award' : 'Award'}</button></div></form>`, 600);
    $('#aw-cancel').onclick = closeDialog;
    $$('[data-idea]').forEach((b) => b.addEventListener('click', () => { document.querySelector('#aw-form [name=reward]').value = b.dataset.idea; }));
    $('#aw-ai').onclick = async () => {
      $('#aw-ai-note').textContent = 'Writing…';
      const r = await admin.awardCitation(aw.month, assetId);
      if (!r.ok) { $('#aw-ai-note').textContent = r.error; return; }
      document.querySelector('#aw-form [name=citation]').value = r.data.citation;
      $('#aw-ai-note').textContent = r.data.source === 'llm' ? 'Written by AI. Edit freely.' : 'AI is unavailable, so this is the standard wording.';
    };
    $('#aw-form').onsubmit = async (e) => {
      e.preventDefault();
      const f = Object.fromEntries(new FormData(e.target));
      const r = await admin.makeAward({ month: aw.month, assetId, reward: f.reward, credits: f.credits, citation: f.citation, replace: Boolean(existing) });
      if (!r.ok) { $('#aw-msg').textContent = r.error; return; }
      closeDialog(); flash(`${c.employeeName} is Employee of the Month. Their certificate is ready.`); renderAwards();
    };
  }

  async function showCert(id) {
    const r = await admin.certificate(id);
    if (!r.ok) { flash(r.error, 'bad'); return; }
    dialogShell(`<h2 style="margin:0 0 4px">Certificate</h2><p class="muted small" style="margin:0 0 12px">${esc(r.data.certificateId)}</p><iframe class="o-cert" sandbox="" title="Certificate" style="width:100%;height:min(58vh,520px);border:0;border-radius:12px;background:#0b0d14"></iframe>
      <div style="display:flex;justify-content:flex-end;margin-top:12px"><button class="btn primary" id="c-close">Close</button></div>`, 940);
    document.querySelector('.dialog iframe').srcdoc = r.data.html;
    $('#c-close').onclick = closeDialog;
  }

  return { renderTimesheets, renderAwards };
})();
const renderTimesheets = AdminTime.renderTimesheets;
const renderAwards = AdminTime.renderAwards;
