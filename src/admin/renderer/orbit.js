'use strict';
/* global admin, state, view, esc, icon, rel, $, $$, topbar, closeDialog, dialogShell, flash, hue, initials */
// Admin pages for Orbit, the employees' work companion: assign Tasks, decide on Recognition (appreciation, rewards, certificates),
// and see Team insights with an AI analyst. Only admins can reach these; the backend enforces it.

const PRIORITIES = { urgent: 'Urgent', high: 'High', medium: 'Medium', low: 'Low' };
const TASK_STATUS = { todo: 'To do', in_progress: 'In progress', blocked: 'Blocked', done: 'Done' };
const VERDICT = { SAFE: ['Comfortable', 'ok'], AT_RISK: ['Tight', 'warn'], OVERLOAD: ['Overloaded', 'bad'] };
const REWARD_IDEAS = ['Comp-off day', 'Gift card', 'Shout-out at the team meeting', 'Learning budget', 'Bonus credits'];
const opill = (text, tone = '') => `<span class="o-pill ${tone}">${esc(text)}</span>`;
const oavatar = (name) => `<span class="avatar" style="--h:${hue(name)}">${esc(initials(name))}</span>`;
const todayIso = () => new Date().toISOString().slice(0, 10);
const dueLabel = (d) => (d ? new Date(`${d}T00:00:00`).toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' }) : 'No due date');

const ORBIT_CSS = `<style>
.o-pill{display:inline-flex;align-items:center;padding:2px 9px;border-radius:999px;font:600 11.5px var(--font);background:var(--surface-3);color:var(--text-2)}
.o-pill.ok{background:var(--green-soft);color:var(--green)}.o-pill.warn{background:var(--orange-soft);color:#b45309}.o-pill.bad{background:var(--red-soft);color:var(--red)}
.o-row3{display:grid;grid-template-columns:minmax(0,2.4fr) minmax(0,1.3fr) 90px 110px 130px 36px;gap:12px;align-items:center;padding:12px 16px;border-top:1px solid var(--border)}
.o-row3.head{border-top:0;font:600 11.5px var(--font);color:var(--muted);text-transform:uppercase;letter-spacing:.05em}
.o-row3 .t{font-weight:600;overflow-wrap:anywhere}.o-row3 .s{font-size:12px;color:var(--muted)}
.o-prog{height:6px;border-radius:4px;background:var(--surface-3);overflow:hidden;margin-top:4px}.o-prog i{display:block;height:100%;background:var(--accent)}
.o-rcard{padding:16px;display:grid;gap:10px}.o-ev{display:flex;flex-wrap:wrap;gap:8px}.o-ev span{background:var(--surface-3);border-radius:8px;padding:4px 9px;font-size:12px}
.o-ctl{display:grid;grid-template-columns:1fr 110px;gap:10px}.o-ideas{display:flex;gap:6px;flex-wrap:wrap}
.o-chat{display:flex;flex-direction:column;gap:10px;max-height:46vh;overflow-y:auto;padding:4px 2px}
.o-b{max-width:88%;padding:10px 14px;border-radius:14px;white-space:pre-wrap;overflow-wrap:anywhere;font-size:13.5px;line-height:1.5}
.o-b.me{align-self:flex-end;background:var(--accent);color:#fff}.o-b.bot{align-self:flex-start;background:var(--surface-3)}.o-b.err{align-self:flex-start;background:var(--red-soft)}
.o-cert{width:100%;height:min(58vh,520px);border:0;border-radius:12px;background:#0b0d14}
.o-assignees{max-height:170px;overflow-y:auto;border:1px solid var(--border-strong);border-radius:10px;padding:6px 10px;display:grid;gap:4px}
.o-assignees label{display:flex;gap:8px;align-items:center;font-size:13px;padding:3px 0}
@media (max-width:900px){.o-row3{grid-template-columns:1fr 1fr}}
</style>`;

// ---- tasks ---------------------------------------------------------------------------------------

async function renderTasks() {
  const filter = state.taskFilter || 'open';
  const [data, inbox] = await Promise.all([admin.orbitTasks(), admin.orbitMessages().catch(() => ({ items: [] }))]);
  if (state.page !== 'tasks') return;
  const asks = (inbox && inbox.items) || [];
  const all = data.items || [];
  const rows = all.filter((t) => (filter === 'open' ? t.status !== 'done' : filter === 'done' ? t.status === 'done' : true));
  const today = todayIso();
  const counts = { open: all.filter((t) => t.status !== 'done').length, done: all.filter((t) => t.status === 'done').length, all: all.length };
  view.innerHTML = `${ORBIT_CSS}
    ${topbar('Tasks', 'Assign work. Orbit helps each person plan it and tells you if the week looks too full', `<button class="btn primary" id="t-new">${icon('plus', 14)} Assign task</button>`)}
    <div class="content">
      ${asks.length ? `<section class="card" style="margin-bottom:14px"><b>${asks.length} ${asks.length === 1 ? 'person says' : 'people say'} they have no task</b>
        ${asks.map((m) => `<div style="display:flex;gap:10px;align-items:center;margin-top:8px">${oavatar(m.employeeName)}<div style="flex:1;min-width:0"><div class="t">${esc(m.employeeName)}</div><div class="s">${esc(rel(m.createdAt))} · sent to ${esc(m.toName || 'the admin')}${m.emailed ? ' by email' : ''}</div></div><button class="btn primary" data-give="${esc(m.assetId)}">Assign task</button><button class="btn ghost" data-close="${esc(m.id)}">Dismiss</button></div>`).join('')}</section>` : ''}
      <div class="chips">${[['open', 'Open'], ['done', 'Done'], ['all', 'All']].map(([k, l]) => `<button class="chip ${filter === k ? 'on' : ''}" data-tf="${k}">${l}<span class="count">${counts[k]}</span></button>`).join('')}</div>
      ${rows.length ? `<section class="table"><div class="o-row3 head"><span>Task</span><span>Assigned to</span><span>Priority</span><span>Due</span><span>Progress</span><span></span></div>
        ${rows.map((t) => `<div class="o-row3"><div><div class="t">${esc(t.title)}</div><div class="s">${t.estimatedHours ? `${esc(t.estimatedHours)}h estimated` : 'No estimate'}${t.description ? ` · ${esc(t.description.slice(0, 80))}` : ''}</div></div>
          <div style="display:flex;gap:8px;align-items:center;min-width:0">${oavatar(t.employeeName)}<span style="overflow:hidden;text-overflow:ellipsis">${esc(t.employeeName)}</span></div>
          <div>${opill(PRIORITIES[t.priority] || t.priority, t.priority === 'urgent' ? 'bad' : t.priority === 'high' ? 'warn' : '')}</div>
          <div class="${t.dueDate && t.dueDate < today && t.status !== 'done' ? 'late' : ''}" style="${t.dueDate && t.dueDate < today && t.status !== 'done' ? 'color:var(--red);font-weight:600' : ''}">${esc(dueLabel(t.dueDate))}</div>
          <div><div class="s">${esc(TASK_STATUS[t.status] || t.status)} · ${esc(t.percent)}%</div><div class="o-prog"><i style="width:${esc(t.percent)}%"></i></div></div>
          <button class="iconbtn" data-del="${esc(t.id)}" title="Delete task" aria-label="Delete task">${icon('trash', 15)}</button></div>`).join('')}</section>`
        : `<section class="card"><div class="empty"><div class="ei">${icon('clipboard', 24)}</div><b>No tasks here</b>Assign a task and it appears on the employee's Orbit page right away.</div></section>`}
    </div>`;
  $$('[data-tf]').forEach((c) => c.addEventListener('click', () => { state.taskFilter = c.dataset.tf; renderTasks(); }));
  $('#t-new').addEventListener('click', openTaskDialog);
  $$('[data-give]').forEach((b) => b.addEventListener('click', openTaskDialog));
  $$('[data-close]').forEach((b) => b.addEventListener('click', async () => { const r = await admin.resolveMessage(b.dataset.close); if (!r.ok) flash(r.error, 'bad'); else renderTasks(); }));
  $$('[data-del]').forEach((b) => b.addEventListener('click', async () => {
    if (!confirm('Delete this task? The employee will no longer see it.')) return;
    const r = await admin.deleteTask(b.dataset.del);
    if (!r.ok) flash(r.error, 'bad'); else renderTasks();
  }));
}

async function openTaskDialog() {
  const assets = (await admin.assets()).filter((a) => a.enrolled);
  dialogShell(`<form id="t-form" class="dlg-form"><h2 style="margin:0 0 4px">Assign a task</h2><p class="muted small" style="margin:0 0 14px">Orbit checks each person's week and tells you if it fits.</p>
    <div class="form-grid">
      <label class="field full"><span>Title <em>*</em></span><input name="title" maxlength="160" required placeholder="e.g. Migrate the payment webhook"></label>
      <label class="field full"><span>Details</span><textarea name="description" rows="2" maxlength="1000" placeholder="What does done look like?"></textarea></label>
      <label class="field"><span>Priority</span><select name="priority">${Object.entries(PRIORITIES).map(([k, v]) => `<option value="${k}" ${k === 'medium' ? 'selected' : ''}>${v}</option>`).join('')}</select></label>
      <label class="field"><span>Estimated hours</span><input name="estimatedHours" type="number" min="0" max="400" step="0.5" value="8"></label>
      <label class="field"><span>Due date</span><input name="dueDate" type="date" min="${todayIso()}"></label>
      <div class="field"><span>Assign to <em>*</em></span><div class="o-assignees">${assets.length ? assets.map((a) => `<label><input type="checkbox" name="who" value="${esc(a.assetId)}"> ${esc(a.employeeName)} <span class="muted small">${esc(a.department || a.assetId)}</span></label>`).join('') : '<span class="muted small">No connected laptops yet.</span>'}</div></div>
    </div>
    <p class="muted small" id="t-msg" role="alert" style="min-height:18px;color:var(--red)"></p>
    <div class="dlg-foot" style="display:flex;justify-content:flex-end;gap:8px"><button type="button" class="btn" id="t-cancel">Cancel</button><button class="btn primary" type="submit">Assign</button></div></form>`, 620);
  $('#t-cancel').addEventListener('click', closeDialog);
  $('#t-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const f = new FormData(e.target);
    const ids = f.getAll('who');
    if (!ids.length) { $('#t-msg').textContent = 'Choose at least one person.'; return; }
    const body = { title: f.get('title'), description: f.get('description'), priority: f.get('priority'), estimatedHours: Number(f.get('estimatedHours') || 0), assetIds: ids };
    if (f.get('dueDate')) body.dueDate = f.get('dueDate');
    const r = await admin.createTask(body);
    if (!r.ok) { $('#t-msg').textContent = r.error; return; }
    showFeasibility(r.data.feasibility);
    if (state.page === 'tasks') renderTasks();
  });
}

function showFeasibility(list) {
  const worst = list.some((f) => f.verdict === 'OVERLOAD') ? 'bad' : list.some((f) => f.verdict === 'AT_RISK') ? 'warn' : 'ok';
  dialogShell(`<h2 style="margin:0 0 4px">Task assigned</h2>
    <p class="muted small" style="margin:0 0 14px">${worst === 'ok' ? 'It fits comfortably in everyone\'s week.' : worst === 'warn' ? 'It fits, but someone\'s week is tight.' : 'Someone\'s week is now overloaded. Consider moving the date or splitting the work.'}</p>
    ${list.map((f) => { const [label, tone] = VERDICT[f.verdict] || VERDICT.SAFE; return `<div style="display:flex;justify-content:space-between;gap:12px;align-items:center;padding:10px 0;border-top:1px solid var(--border)"><div><b>${esc(f.name)}</b><div class="muted small">${esc(f.pendingHours)}h of work this week · ${esc(f.availableHours)}h available</div></div>${opill(label, tone)}</div>`; }).join('')}
    <div style="display:flex;justify-content:flex-end;margin-top:14px"><button class="btn primary" id="f-ok">Done</button></div>`, 520);
  $('#f-ok').addEventListener('click', closeDialog);
}

// ---- recognition ---------------------------------------------------------------------------------

function evidenceChips(ev) {
  const label = { tasks: 'Tasks', count: 'Count', task: 'Task', due: 'Due', completed: 'Completed', date: 'Day', hours: 'Hours', streakDays: 'Streak (days)' };
  return Object.entries(ev || {}).map(([k, v]) => `<span><b>${esc(label[k] || k)}:</b> ${esc(Array.isArray(v) ? v.join(', ') : v)}</span>`).join('');
}

const SOURCE = { orbit: 'Found by Orbit', employee: 'Sent by the employee', admin: 'From an admin' };

async function renderRecognition() {
  if (document.activeElement?.closest?.('.o-rcard')) return; // don't interrupt typing a reward
  const tab = state.recTab || 'pending';
  const data = await admin.recognitions(tab === 'pending' ? 'pending' : '');
  if (state.page !== 'recognition') return;
  const items = tab === 'pending' ? data.items : data.items.filter((r) => r.status !== 'pending');
  view.innerHTML = `${ORBIT_CSS}
    ${topbar('Recognition', 'Appreciation proposed by Orbit or employees. You decide the reward; they get a certificate.', `<button class="btn primary" id="r-new">${icon('plus', 14)} Recognise someone</button>`)}
    <div class="content">
      <div class="chips"><button class="chip ${tab === 'pending' ? 'on' : ''}" data-rt="pending">Waiting for you<span class="count">${data.pending ?? 0}</span></button>
        <button class="chip ${tab === 'history' ? 'on' : ''}" data-rt="history">History</button></div>
      ${items.length ? items.map((r) => (r.status === 'pending' ? pendingCard(r) : historyCard(r))).join('')
        : `<section class="card"><div class="empty"><div class="ei">${icon('check', 24)}</div><b>${tab === 'pending' ? 'Nothing waiting' : 'No history yet'}</b>When an employee does something worth celebrating, it shows up here for you to approve.</div></section>`}
    </div>`;
  $$('[data-rt]').forEach((c) => c.addEventListener('click', () => { state.recTab = c.dataset.rt; renderRecognition(); }));
  $('#r-new').addEventListener('click', openAwardDialog);
  $$('[data-ideas] button').forEach((b) => b.addEventListener('click', () => { b.closest('.o-rcard').querySelector('[name=reward]').value = b.textContent; }));
  $$('[data-decide]').forEach((b) => b.addEventListener("click", () => decideRecognitionCard(b)));
  $$('[data-cert]').forEach((b) => b.addEventListener('click', () => openCert(b.dataset.cert)));
}

function pendingCard(r) {
  return `<section class="card o-rcard" data-rec="${esc(r.id)}"><div style="display:flex;gap:10px;align-items:center">${oavatar(r.employeeName)}<div style="min-width:0"><b>${esc(r.employeeName)}</b>
      <div class="muted small">${esc(r.department || r.assetId)} · ${esc(rel(r.createdAt))} · ${esc(SOURCE[r.source] || r.source)}</div></div></div>
    <div><div style="font:650 15px var(--font-display)">${esc(r.title)}</div>${r.citation ? `<div class="muted" style="margin-top:2px">${esc(r.citation)}</div>` : ''}</div>
    ${Object.keys(r.evidence || {}).length ? `<div class="o-ev">${evidenceChips(r.evidence)}</div>` : ''}
    <div class="o-ctl"><label class="field"><span>Reward</span><input name="reward" maxlength="200" placeholder="e.g. Comp-off day"></label>
      <label class="field"><span>Credits</span><input name="credits" type="number" min="0" max="10" step="0.5" value="${esc(r.credits || 0.5)}"></label></div>
    <div class="o-ideas" data-ideas>${REWARD_IDEAS.map((i) => `<button class="chip" type="button">${esc(i)}</button>`).join('')}</div>
    <label class="field"><span>A note for ${esc(r.employeeName.split(' ')[0])} (optional)</span><input name="note" maxlength="500" placeholder="Thank you for…"></label>
    <div style="display:flex;gap:8px;justify-content:flex-end"><button class="btn" data-decide="reject" data-id="${esc(r.id)}">Not this time</button><button class="btn primary" data-decide="approve" data-id="${esc(r.id)}">${icon('check', 14)} Approve &amp; award</button></div></section>`;
}

function historyCard(r) {
  const ok = r.status === 'approved';
  return `<section class="card o-rcard"><div style="display:flex;justify-content:space-between;gap:12px;align-items:center"><div style="display:flex;gap:10px;align-items:center;min-width:0">${oavatar(r.employeeName)}
    <div style="min-width:0"><b>${esc(r.title)}</b><div class="muted small">${esc(r.employeeName)} · ${esc(rel(r.decidedAt || r.createdAt))}${r.decidedBy ? ` · by ${esc(r.decidedBy)}` : ''}${ok && r.reward ? ` · ${esc(r.reward)}` : ''}${ok ? ` · +${esc(r.credits)} credits` : ''}</div></div></div>
    <div style="display:flex;gap:8px;align-items:center">${opill(ok ? 'Approved' : 'Not this time', ok ? 'ok' : '')}${ok ? `<button class="btn sm" data-cert="${esc(r.id)}">Certificate</button>` : ''}</div></div></section>`;
}

async function decideRecognitionCard(btn) {
  const card = btn.closest('.o-rcard');
  const decision = btn.dataset.decide;
  const body = { decision, reward: card.querySelector('[name=reward]').value, credits: card.querySelector('[name=credits]').value, note: card.querySelector('[name=note]').value };
  card.querySelectorAll('button').forEach((b) => { b.disabled = true; });
  const r = await admin.decideRecognition(btn.dataset.id, body);
  if (!r.ok) { flash(r.error, 'bad'); card.querySelectorAll('button').forEach((b) => { b.disabled = false; }); return; }
  flash(decision === 'approve' ? 'Approved. A certificate is ready for them.' : 'Marked as not this time.');
  renderRecognition();
  refreshSide();
}

async function openCert(id) {
  const r = await admin.certificate(id);
  if (!r.ok) { flash(r.error, 'bad'); return; }
  dialogShell(`<h2 style="margin:0 0 4px">Certificate</h2><p class="muted small" style="margin:0 0 12px">${esc(r.data.certificateId)}</p><iframe class="o-cert" sandbox="" title="Certificate"></iframe>
    <div style="display:flex;justify-content:flex-end;margin-top:12px"><button class="btn primary" id="c-close">Close</button></div>`, 940);
  $('.o-cert').srcdoc = r.data.html;
  $('#c-close').addEventListener('click', closeDialog);
}

async function openAwardDialog() {
  const assets = (await admin.assets()).filter((a) => a.enrolled);
  dialogShell(`<form id="a-form"><h2 style="margin:0 0 4px">Recognise someone</h2><p class="muted small" style="margin:0 0 14px">Send appreciation directly. They get a certificate right away.</p>
    <div class="form-grid">
      <label class="field full"><span>Who <em>*</em></span><select name="assetId" required>${assets.map((a) => `<option value="${esc(a.assetId)}">${esc(a.employeeName)} (${esc(a.assetId)})</option>`).join('')}</select></label>
      <label class="field full"><span>What for <em>*</em></span><input name="title" maxlength="120" required placeholder="e.g. Saved the release on Friday night"></label>
      <label class="field full"><span>A few words</span><textarea name="citation" rows="2" maxlength="600"></textarea></label>
      <label class="field"><span>Reward</span><input name="reward" maxlength="200" placeholder="e.g. Gift card"></label>
      <label class="field"><span>Credits</span><input name="credits" type="number" min="0" max="10" step="0.5" value="1"></label>
    </div><p class="muted small" id="a-msg" role="alert" style="min-height:18px;color:var(--red)"></p>
    <div style="display:flex;justify-content:flex-end;gap:8px"><button type="button" class="btn" id="a-cancel">Cancel</button><button class="btn primary" type="submit">Send appreciation</button></div></form>`, 560);
  $('#a-cancel').addEventListener('click', closeDialog);
  $('#a-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const f = Object.fromEntries(new FormData(e.target));
    const r = await admin.awardRecognition({ ...f, credits: Number(f.credits || 0) });
    if (!r.ok) { $('#a-msg').textContent = r.error; return; }
    closeDialog(); flash('Sent. They will see it in Orbit.'); if (state.page === 'recognition') renderRecognition();
  });
}

// ---- team insights & analyst ---------------------------------------------------------------------

async function renderTeam() {
  if (document.activeElement?.matches('#an-input')) return;
  const data = await admin.orbitTeam();
  if (state.page !== 'team') return;
  const rows = data.items || [];
  view.innerHTML = `${ORBIT_CSS}
    ${topbar('Team insights', 'Workload this week against available time, plus an analyst you can ask')}
    <div class="content">
      ${rows.length ? `<section class="table"><div class="o-row3 head" style="grid-template-columns:minmax(0,2fr) 90px 90px 140px 120px 90px"><span>Person</span><span>Open</span><span>Overdue</span><span>Hours due / free</span><span>Week</span><span>Credits</span></div>
        ${rows.map((t) => { const [label, tone] = VERDICT[t.verdict] || VERDICT.SAFE; return `<div class="o-row3" style="grid-template-columns:minmax(0,2fr) 90px 90px 140px 120px 90px"><div style="display:flex;gap:8px;align-items:center;min-width:0">${oavatar(t.name)}<div style="min-width:0"><div class="t">${esc(t.name)}</div><div class="s">${esc(t.department || t.assetId)}</div></div></div>
          <div>${esc(t.openTasks)}</div><div style="${t.overdue ? 'color:var(--red);font-weight:600' : ''}">${esc(t.overdue)}</div><div>${esc(t.pendingHours)}h / ${esc(t.availableHours)}h</div><div>${opill(label, tone)}</div><div>${esc(t.credits)}</div></div>`; }).join('')}</section>`
        : `<section class="card"><div class="empty"><b>No connected laptops yet</b>Once employees connect, their workload appears here.</div></section>`}
      <section class="card" style="margin-top:16px"><div class="card-head"><h3>Ask the analyst</h3><span class="muted small">Reads your team's tasks, workload and recognition. Changes nothing.</span></div>
        <div class="o-chat" id="an-thread" role="log" aria-live="polite"></div>
        <div class="chips" style="margin:10px 0">${['Who is overloaded this week?', 'Which tasks are overdue?', 'Who deserves recognition?', 'What appreciation is waiting for me?'].map((q) => `<button class="chip" data-q="${esc(q)}">${esc(q)}</button>`).join('')}</div>
        <form id="an-form" style="display:flex;gap:8px"><input id="an-input" class="field" style="flex:1;border:1px solid var(--border-strong);border-radius:10px;padding:9px 12px;background:var(--bg);color:var(--text)" maxlength="1000" placeholder="Ask about workload, delivery or who to recognise…" aria-label="Ask the analyst"><button class="btn primary" type="submit">${icon('send', 14)}</button></form></section>
    </div>`;
  drawAnalyst();
  $$('[data-q]').forEach((b) => b.addEventListener('click', () => ask(b.dataset.q)));
  $('#an-form').addEventListener('submit', (e) => { e.preventDefault(); const i = $('#an-input'); const q = i.value.trim(); if (q) { i.value = ''; ask(q); } });
}

const analyst = { msgs: [], busy: false };

function drawAnalyst() {
  const t = $('#an-thread');
  if (!t) return;
  t.innerHTML = '';
  for (const m of analyst.msgs) { const d = document.createElement('div'); d.className = `o-b ${m.role === 'user' ? 'me' : m.error ? 'err' : 'bot'}`; d.textContent = m.text; t.appendChild(d); }
  if (analyst.busy) { const d = document.createElement('div'); d.className = 'o-b bot'; d.textContent = 'Looking at the team…'; t.appendChild(d); }
  t.scrollTop = t.scrollHeight;
}

async function ask(q) {
  if (analyst.busy) return;
  analyst.msgs = analyst.msgs.filter((m) => !m.error);
  analyst.msgs.push({ role: 'user', text: q });
  analyst.busy = true; drawAnalyst();
  const history = analyst.msgs.slice(-19).map((m) => ({ role: m.role === 'user' ? 'user' : 'assistant', content: m.text }));
  const r = await admin.orbitChat(history);
  analyst.busy = false;
  analyst.msgs.push(r.ok ? { role: 'assistant', text: r.data.reply } : { role: 'assistant', text: r.error || 'The analyst is unavailable right now.', error: true });
  if (state.page === 'team') drawAnalyst();
}
