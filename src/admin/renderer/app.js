'use strict';
/* global admin, agent, UI, Charts */

const { esc, fmtDur, fmtBig, fmtClock, fmtTime, fmtDate, rel, icon, appIcon } = UI;
const $ = (s, r = document) => r.querySelector(s);
const $$ = (s, r = document) => [...r.querySelectorAll(s)];
const view = $('#view');
const PALETTE = ['#EF6A4C', '#6366f1', '#10b981', '#ec4899', '#06b6d4', '#8b5cf6', '#84cc16', '#f59e0b'];
const DAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

document.body.classList.add(`platform-${agent.platform}`);
$$('[data-icon]').forEach((el) => { el.outerHTML = icon(el.dataset.icon, 17); });

const state = { page: 'dashboard', assetFilter: 'all', assetQuery: '', alertFilter: 'new', drawer: null, policyDraft: null };

// ---- helpers ------------------------------------------------------------------------------

function hue(str) { let h = 0; for (const c of String(str)) h = (h * 31 + c.charCodeAt(0)) % 360; return h; }
function initials(name) { return String(name || '?').split(/\s+/).filter(Boolean).slice(0, 2).map((w) => w[0].toUpperCase()).join(''); }
function avatar(a, lg = false) {
  return `<span class="avatar ${lg ? 'lg' : ''}" style="--h:${hue(a.employeeName)}">${esc(initials(a.employeeName))}<span class="dot ${dotClass(a)}"></span></span>`;
}
function dotClass(a) {
  if (!a.online) return '';
  return { tracking: 'tracking', idle: 'idle', locked: 'locked' }[a.state] || 'idle';
}
function statusText(a) {
  if (!a.enrolled) return 'Not enrolled';
  if (!a.online) return a.lastSeen ? `Offline · ${rel(a.lastSeen)}` : 'Offline';
  return { tracking: a.current ? a.current.name : 'Active', idle: 'Idle', locked: 'Screen locked', paused: 'Paused by user', unavailable: 'Detection unavailable', starting: 'Starting…' }[a.state] || a.state;
}
function doing(a) {
  if (a.online && a.state === 'tracking' && a.current) {
    return `<span class="doing">${appIcon(a.current.id, '', 20, a.current.name)}<span class="t">${esc(a.current.name)}</span></span>`;
  }
  return `<span class="doing muted"><span class="t">${esc(statusText(a))}</span></span>`;
}
function topbar(title, sub, controls = '') {
  return `<header class="topbar"><div><h1>${esc(title)}</h1><div class="sub">${sub}</div></div><div class="controls">${controls}</div></header>`;
}
const newAssetBtn = () => `<button class="btn primary" data-new-asset>${icon('plus', 14)} New asset</button>`;
function bindCommon() {
  $$('[data-new-asset]').forEach((b) => b.addEventListener('click', () => openAssetDialog()));
  $$('[data-asset]').forEach((b) => b.addEventListener('click', () => openDrawer(b.dataset.asset)));
}
async function copy(text, btn) {
  await admin.copy(text);
  if (btn) { const old = btn.innerHTML; btn.innerHTML = `${icon('check', 13)} Copied`; setTimeout(() => { btn.innerHTML = old; }, 1400); }
}

// ---- dashboard ----------------------------------------------------------------------------

async function renderDashboard() {
  const d = await admin.dashboard();
  if (state.page !== 'dashboard') return;
  const k = d.kpis;
  const sorted = [...d.assets].sort((a, b) => (b.online - a.online) || (b.todaySeconds - a.todaySeconds));
  const maxApp = d.topApps[0]?.seconds || 1;

  if (!d.assets.length) {
    view.innerHTML = `${topbar('Dashboard', esc(fmtDate(Date.now(), { weekday: 'long', month: 'long', day: 'numeric' })), newAssetBtn())}
      <div class="content"><section class="card"><div class="empty"><div class="ei">${icon('building', 26)}</div>
        <b>Welcome to Proglintor Admin</b>
        <div style="max-width:460px;margin:6px auto 16px">Add each company laptop as an asset. You'll get a one-time code to connect the Proglintor agent on that laptop.</div>
        <button class="btn primary" data-new-asset>${icon('plus', 14)} Add your first asset</button></div></section>
        ${serverCard(d.server)}</div>`;
    bindCommon();
    bindServerCard();
    return;
  }

  view.innerHTML = `
    ${topbar('Dashboard', esc(fmtDate(Date.now(), { weekday: 'long', month: 'long', day: 'numeric', year: 'numeric' })), newAssetBtn())}
    <div class="content">
      <div class="kpis">
        <section class="card kpi"><div class="eyebrow">${icon('monitor', 13)} Assets</div><div class="big"><b>${k.assets}</b></div><div class="hint">${k.enrolled} connected · ${k.assets - k.enrolled} awaiting setup</div></section>
        <section class="card kpi"><div class="eyebrow"><span class="dot tracking"></span> Online now</div><div class="big"><b>${k.online}</b><small> / ${k.enrolled}</small></div><div class="hint">agents reporting in the last 90 s</div></section>
        <section class="card kpi"><div class="eyebrow">${icon('clock', 13)} Active time today</div><div class="big">${fmtBig(k.activeToday)}</div><div class="hint">across all assets</div></section>
        <section class="card kpi ${k.newAlerts ? 'alert' : ''}" data-goto="alerts" style="cursor:pointer"><div class="eyebrow">${icon('bell', 13)} Weekend alerts</div><div class="big"><b>${k.newAlerts}</b></div><div class="hint">${k.newAlerts ? 'waiting for review →' : 'nothing to review'}</div></section>
      </div>
      <div class="grid-2">
        <section class="card">
          <div class="card-head"><h3>Live status</h3><span class="muted small">Click an employee for details</span></div>
          <div class="live">${sorted.map((a) => `
            <button class="live-row" data-asset="${esc(a.assetId)}">
              ${avatar(a)}
              <span style="min-width:0"><span class="nm">${esc(a.employeeName)}</span><span class="sub"><span class="idpill" style="padding:2px 5px;font-size:10.5px">${esc(a.assetId)}</span> ${esc(a.department || '')}</span></span>
              ${doing(a)}
              <span class="right"><b class="num">${fmtDur(a.todaySeconds)}</b><span class="sub">today</span></span>
            </button>`).join('')}</div>
        </section>
        <div class="stack">
          <section class="card"><div class="card-head"><h3>Top apps today</h3><span class="muted small">all assets</span></div>
            ${d.topApps.length ? `<div class="applist">${d.topApps.map((s, i) => `
              <div class="approw" style="grid-template-columns:28px minmax(0,1fr) 110px 64px">${appIcon(s.id, '', 28, s.name)}
                <span style="min-width:0"><span class="nm">${esc(s.name)}</span><span class="sub">${s.assets} employee${s.assets === 1 ? '' : 's'}</span></span>
                <span class="bar"><i style="width:${(s.seconds / maxApp) * 100}%;background:${PALETTE[i % PALETTE.length]}"></i></span>
                <span class="tm">${fmtDur(s.seconds)}</span></div>`).join('')}</div>` : '<div class="muted small">No activity reported yet today.</div>'}
          </section>
          <section class="card"><div class="card-head"><h3>Last 7 days</h3><span class="muted small">total active time</span></div><div class="chart" id="dash-daily"></div></section>
        </div>
      </div>
      ${d.recentAlerts.length ? `<section class="card"><div class="card-head"><h3>Recent weekend alerts</h3><button class="btn ghost sm" data-goto="alerts">View all</button></div>
        <div class="alerts-list">${d.recentAlerts.map((a) => alertCard(a, true)).join('')}</div></section>` : ''}
    </div>`;

  Charts.bars($('#dash-daily'), d.daily.map((x) => ({ ...x, total: x.seconds, parts: { v: x.seconds } })), {
    keys: ['v'], colors: { v: 'var(--accent)' }, names: { v: 'All assets' }, height: 170,
    label: (b) => fmtDate(b.date, { weekday: 'short' }),
    title: (b) => fmtDate(b.date, { weekday: 'long', month: 'short', day: 'numeric' }),
  });
  bindCommon();
  bindAlertCards();
}

// ---- assets -------------------------------------------------------------------------------

const ASSET_FILTERS = [
  ['all', 'All', () => true],
  ['online', 'Online', (a) => a.online],
  ['offline', 'Offline', (a) => a.enrolled && !a.online],
  ['pending', 'Awaiting setup', (a) => !a.enrolled],
];

async function renderAssets() {
  const assets = await admin.assets();
  if (state.page !== 'assets') return;
  const searchHasFocus = document.activeElement?.id === 'asset-q';
  if (!searchHasFocus || !$('#assets-table')) {
    view.innerHTML = `
      ${topbar('Assets', `${assets.length} registered`, `<label class="search">${icon('search', 14)}<input id="asset-q" type="search" placeholder="Search asset ID, employee, email" value="${esc(state.assetQuery)}"></label>${newAssetBtn()}`)}
      <div class="content">
        <div class="chips" id="asset-chips"></div>
        <div class="table" id="assets-table"></div>
      </div>`;
    $('#asset-q').addEventListener('input', (e) => { state.assetQuery = e.target.value; drawAssets(assets); });
    bindCommon();
  }
  drawAssets(assets);
}

function drawAssets(assets) {
  $('#asset-chips').innerHTML = ASSET_FILTERS.map(([k, l, f]) => `<button class="chip ${state.assetFilter === k ? 'on' : ''}" data-f="${k}">${l}<span class="count">${assets.filter(f).length}</span></button>`).join('');
  $$('#asset-chips .chip').forEach((c) => c.addEventListener('click', () => { state.assetFilter = c.dataset.f; drawAssets(assets); }));
  const q = state.assetQuery.trim().toLowerCase();
  const f = ASSET_FILTERS.find(([k]) => k === state.assetFilter)[2];
  const rows = assets.filter(f).filter((a) => !q || [a.assetId, a.employeeName, a.employeeEmail, a.department, a.location, a.hostname].some((v) => String(v || '').toLowerCase().includes(q)));
  const el = $('#assets-table');
  if (!assets.length) {
    el.innerHTML = `<div class="empty"><div class="ei">${icon('monitor', 24)}</div><b>No assets yet</b>Create an asset for each company laptop.<div style="margin-top:14px"><button class="btn primary" data-new-asset>${icon('plus', 14)} New asset</button></div></div>`;
    bindCommon();
    return;
  }
  el.innerHTML = `
    <div class="assets-row head"><span>Asset</span><span>Employee</span><span>Department · Location</span><span>Status</span><span>Today</span><span>Last seen</span><span></span></div>
    ${rows.map((a) => `
      <div class="assets-row item" data-asset="${esc(a.assetId)}" tabindex="0">
        <span style="min-width:0"><span class="idpill">${esc(a.assetId)}</span><span class="sub" style="margin-top:4px">${esc(a.deviceType)}${a.hostname ? ` · ${esc(a.hostname)}` : ''}</span></span>
        <span style="display:flex;gap:10px;align-items:center;min-width:0">${avatar(a)}<span style="min-width:0"><span class="nm">${esc(a.employeeName)}</span><span class="sub">${esc(a.employeeEmail)}</span></span></span>
        <span style="min-width:0"><span class="nm" style="font-weight:500">${esc(a.department || '—')}</span><span class="sub">${esc(a.location || '')}</span></span>
        ${doing(a)}
        <span class="num">${a.todaySeconds ? fmtDur(a.todaySeconds) : '<span class="muted">—</span>'}</span>
        <span class="muted small">${a.online ? '<span class="status-line ok" style="font-size:12px">Now</span>' : a.lastSeen ? esc(rel(a.lastSeen)) : 'Never'}</span>
        <span class="chev muted">${icon('right', 14)}</span>
      </div>`).join('') || '<div class="empty"><b>No matching assets</b></div>'}`;
  $$('.assets-row.item', el).forEach((r) => {
    r.addEventListener('click', () => openDrawer(r.dataset.asset));
    r.addEventListener('keydown', (e) => { if (e.key === 'Enter') openDrawer(r.dataset.asset); });
  });
}

// ---- asset dialog (create / edit) ---------------------------------------------------------------

function closeDialog() { $('#dialog-root').innerHTML = ''; }

function openAssetDialog(existing = null) {
  const a = existing || { deviceType: 'Laptop' };
  const field = (id, label, value, opts = {}) => `<label class="field ${opts.full ? 'full' : ''}"><span>${label}${opts.req ? '<em>*</em>' : ''}</span>
    ${opts.textarea ? `<textarea class="input" id="${id}" rows="2" placeholder="${esc(opts.ph || '')}">${esc(value || '')}</textarea>`
      : `<input class="input ${opts.mono ? 'mono' : ''}" id="${id}" value="${esc(value || '')}" placeholder="${esc(opts.ph || '')}" ${opts.disabled ? 'disabled' : ''} ${opts.type ? `type="${opts.type}"` : ''}>`}
    ${opts.hint ? `<small>${opts.hint}</small>` : ''}</label>`;
  $('#dialog-root').innerHTML = `
    <div class="dialog-backdrop" id="dlg-bg">
      <div class="dialog" role="dialog" aria-modal="true">
        <h2>${existing ? `Edit ${esc(existing.assetId)}` : 'New asset'}</h2>
        <p class="lead">${existing ? 'Update the employee and device details.' : 'Register a company laptop and assign it to an employee.'}</p>
        <div class="form-grid">
          ${field('f-id', 'Asset ID', a.assetId, { req: true, mono: true, ph: 'PGL-LT-0042', disabled: Boolean(existing), hint: existing ? 'Asset IDs cannot be changed.' : 'The ID on the asset tag, e.g. PGL-LT-0042.' })}
          <label class="field"><span>Device type</span><select class="input" id="f-type">${['Laptop', 'Desktop', 'Workstation', 'Other'].map((t) => `<option ${a.deviceType === t ? 'selected' : ''}>${t}</option>`).join('')}</select></label>
          ${field('f-name', 'Employee name', a.employeeName, { req: true, ph: 'Priya Sharma' })}
          ${field('f-email', 'Employee email address', a.employeeEmail, { req: true, ph: 'priya.sharma@proglint.com', type: 'email' })}
          ${field('f-dept', 'Department', a.department, { ph: 'Engineering' })}
          ${field('f-loc', 'Office / address', a.location, { ph: 'Chennai office, 3rd floor' })}
          ${field('f-notes', 'Notes', a.notes, { full: true, textarea: true, ph: 'Serial number, accessories, etc.' })}
        </div>
        <div class="form-error" id="f-err" style="margin-top:12px"></div>
        <div class="actions"><button class="btn ghost" id="f-cancel">Cancel</button><button class="btn primary" id="f-save">${existing ? 'Save changes' : `${icon('plus', 14)} Create asset`}</button></div>
      </div>
    </div>`;
  $('#dlg-bg').addEventListener('mousedown', (e) => { if (e.target.id === 'dlg-bg') closeDialog(); });
  $('#f-cancel').addEventListener('click', closeDialog);
  (existing ? $('#f-name') : $('#f-id')).focus();
  $('#f-save').addEventListener('click', async () => {
    const data = {
      assetId: $('#f-id').value.trim(), deviceType: $('#f-type').value, employeeName: $('#f-name').value.trim(), employeeEmail: $('#f-email').value.trim(),
      department: $('#f-dept').value.trim(), location: $('#f-loc').value.trim(), notes: $('#f-notes').value.trim(),
    };
    const r = existing ? await admin.updateAsset(existing.assetId, data) : await admin.createAsset(data);
    if (!r.ok) { $('#f-err').textContent = r.error; return; }
    if (existing) { closeDialog(); refresh(); return; }
    showEnrollment(r.data);
    refresh();
  });
}

async function showEnrollment(asset) {
  const info = await admin.serverInfo();
  const addr = info.addresses[0]?.address || '';
  $('#dialog-root').innerHTML = `
    <div class="dialog-backdrop" id="dlg-bg">
      <div class="dialog" role="dialog" aria-modal="true">
        <div style="display:flex;align-items:center;gap:12px;margin-bottom:6px"><span class="status-line ok">${icon('check', 18)}</span><h2 style="margin:0">Asset ${esc(asset.assetId)} is ready</h2></div>
        <p class="lead">Connect ${esc(asset.employeeName)}'s laptop. These details are needed once.</p>
        <div class="field" style="margin-bottom:12px"><span>Server address</span>
          <div class="codebox"><span class="addr">${esc(addr)}</span><button class="btn sm" data-copy="${esc(addr)}">${icon('copy', 13)} Copy</button></div>
          ${info.local ? '<small>This local address only works for an agent on this computer. Other laptops need the backend on a server they can reach.</small>' : ''}</div>
        <div class="field"><span>One-time enrollment code</span>
          <div class="codebox"><span class="code">${esc(asset.enrollCode)}</span><button class="btn sm" data-copy="${esc(asset.enrollCode)}">${icon('copy', 13)} Copy</button></div></div>
        <div class="card" style="margin-top:16px;padding:14px 16px"><b>On the employee's laptop</b>
          <ol class="steps" style="margin-top:8px"><li>Install and open <b>Proglintor</b>. It starts automatically from then on.</li><li>Click <b>Connect</b> (or Settings → Connect to Proglint).</li><li>Enter the server address and the code above.</li></ol></div>
        <div class="actions"><button class="btn primary" id="f-done">Done</button></div>
      </div>
    </div>`;
  $$('[data-copy]').forEach((b) => b.addEventListener('click', () => copy(b.dataset.copy, b)));
  $('#f-done').addEventListener('click', closeDialog);
  $('#dlg-bg').addEventListener('mousedown', (e) => { if (e.target.id === 'dlg-bg') closeDialog(); });
}

// ---- asset drawer ---------------------------------------------------------------------------

async function openDrawer(assetId) {
  state.drawer = assetId;
  await renderDrawer();
  $('#drawer').classList.add('open');
  $('#scrim').classList.add('open');
}

function closeDrawer() {
  state.drawer = null;
  $('#drawer').classList.remove('open');
  $('#scrim').classList.remove('open');
  Charts.hideTip();
}

async function renderDrawer() {
  const id = state.drawer;
  const d = await admin.assetDetail(id);
  if (state.drawer !== id) return;
  if (!d) { closeDrawer(); return; }
  if ($('#drawer').contains(document.activeElement) && document.activeElement.matches('input, textarea')) return; // don't interrupt typing
  const a = d.asset;
  const maxApp = d.todayApps[0]?.seconds || 1;
  const week = d.daily.slice(-7).reduce((t, x) => t + x.seconds, 0);
  const instQuery = state.instQuery || '';
  const installed = d.installed.apps.filter((x) => !instQuery || x.name.toLowerCase().includes(instQuery.toLowerCase()))
    .sort((x, y) => (y.lastUsed || 0) - (x.lastUsed || 0));

  $('#drawer').innerHTML = `
    <div class="dhead">
      ${avatar(a, true)}
      <div style="min-width:0"><div class="nm">${esc(a.employeeName)}</div><div class="id">${esc(a.employeeEmail)}</div>
        <div style="margin-top:6px;display:flex;gap:6px;flex-wrap:wrap"><span class="idpill">${esc(a.assetId)}</span>${a.department ? `<span class="pill">${esc(a.department)}</span>` : ''}${a.location ? `<span class="pill">${esc(a.location)}</span>` : ''}</div></div>
      <button class="iconbtn" id="d-close" title="Close (Esc)">${icon('close', 18)}</button>
    </div>
    <div class="dactions">
      <button class="btn sm" id="d-edit">${icon('edit', 13)} Edit</button>
      <button class="btn sm" id="d-code">${icon('building', 13)} ${a.enrolled ? 'New enrollment code' : 'Show enrollment code'}</button>
      <button class="btn sm danger" id="d-del">${icon('trash', 13)} Delete</button>
    </div>

    ${!a.enrolled ? `
      <section class="card"><div class="card-head"><h3>Awaiting setup</h3></div>
        <div class="codebox"><span class="code">${esc(a.enrollCode || '—')}</span><button class="btn sm" data-copy="${esc(a.enrollCode || '')}">${icon('copy', 13)} Copy</button></div>
        <div class="small muted" style="margin-top:8px">Enter this code with the server address <b class="mono">${esc(d.server.addresses[0]?.address || '')}</b> in Proglintor on the laptop.</div></section>` : `
      <section class="card">
        <div class="card-head"><h3>Right now</h3><span class="status-line ${a.online ? 'ok' : 'bad'}">${a.online ? 'Online' : `Offline${a.lastSeen ? ` · last seen ${esc(rel(a.lastSeen))}` : ''}`}</span></div>
        ${a.online && a.current ? `<div class="now-app">${appIcon(a.current.id, '', 44, a.current.name)}<div><div class="now-name">${esc(a.current.name)}</div><div class="muted">Active for <span class="num" data-since="${a.current.sessionStart || ''}">${a.current.sessionStart ? fmtClock((Date.now() - a.current.sessionStart) / 1000) : '—'}</span></div></div></div>`
          : `<div class="muted">${esc(statusText(a))}</div>`}
        ${a.runningApps.length ? `<div class="small muted" style="margin:14px 0 6px">Running apps (${a.runningApps.length})</div>
          <div class="chips-run">${a.runningApps.map((r) => `<span class="${a.current?.id === r.id ? 'now' : ''}">${esc(r.name)}</span>`).join('')}</div>` : ''}
      </section>`}

    <div class="tiles">
      <div class="tile"><div class="label">Today</div><div class="value">${fmtDur(a.todaySeconds)}</div></div>
      <div class="tile"><div class="label">Last 7 days</div><div class="value">${fmtDur(week)}</div></div>
      <div class="tile"><div class="label">Apps used today</div><div class="value">${d.todayApps.length}</div></div>
      <div class="tile"><div class="label">Weekend alerts</div><div class="value">${d.alerts.length}</div></div>
    </div>

    <section class="card"><div class="card-head"><h3>Last 14 days</h3></div><div class="chart" id="d-chart"></div></section>

    <section class="card"><div class="card-head"><h3>Apps today</h3><span class="muted small">${fmtDur(d.todayApps.reduce((t, x) => t + x.seconds, 0))}</span></div>
      ${d.todayApps.length ? `<div class="applist">${d.todayApps.slice(0, 12).map((s, i) => `
        <div class="approw" style="grid-template-columns:28px minmax(0,1fr) 120px 64px">${appIcon(s.id, '', 28, s.name)}
          <span style="min-width:0"><span class="nm">${esc(s.name)}</span><span class="sub">${s.sessions} session${s.sessions === 1 ? '' : 's'}${s.lastActive ? ` · last ${esc(fmtTime(s.lastActive))}` : ''}</span></span>
          <span class="bar"><i style="width:${(s.seconds / maxApp) * 100}%;background:${PALETTE[i % PALETTE.length]}"></i></span>
          <span class="tm">${fmtDur(s.seconds)}</span></div>`).join('')}</div>` : '<div class="muted small">No activity reported today.</div>'}
    </section>

    ${d.alerts.length ? `<section class="card"><div class="card-head"><h3>Weekend alerts</h3></div><div class="alerts-list">${d.alerts.slice(0, 10).map((x) => alertCard(x, true)).join('')}</div></section>` : ''}

    <section class="card"><div class="card-head"><h3>Installed apps</h3><span class="muted small">${d.installed.apps.length} apps${d.installed.updatedAt ? ` · updated ${esc(rel(d.installed.updatedAt))}` : ''}</span></div>
      ${d.installed.apps.length ? `<label class="search" style="margin-bottom:10px">${icon('search', 14)}<input id="inst-q" type="search" placeholder="Search installed apps" value="${esc(instQuery)}" style="width:100%"></label>
      <div class="inst-list">${installed.slice(0, 200).map((x) => `<div class="inst-row"><span class="nm" style="font-weight:500">${esc(x.name)}${x.isSystem ? ' <span class="pill sys">System</span>' : ''}</span><span class="muted">${esc(x.version || '—')}</span><span class="muted">${x.lastUsed ? esc(rel(x.lastUsed)) : 'Never opened'}</span></div>`).join('')}</div>`
      : '<div class="muted small">The agent sends the installed app list after it connects.</div>'}
    </section>

    <section class="card"><div class="card-head"><h3>Device</h3></div>
      <dl class="kv">
        <dt>Device type</dt><dd>${esc(a.deviceType)}</dd>
        <dt>Computer name</dt><dd>${esc(a.hostname || '—')}</dd>
        <dt>Operating system</dt><dd>${esc(a.os || '—')}</dd>
        <dt>Agent version</dt><dd>${esc(a.agentVersion || '—')}</dd>
        <dt>Connected</dt><dd>${a.enrolledAt ? esc(new Date(a.enrolledAt).toLocaleString()) : '—'}</dd>
        <dt>Registered</dt><dd>${esc(new Date(a.createdAt).toLocaleString())}</dd>
        ${a.notes ? `<dt>Notes</dt><dd>${esc(a.notes)}</dd>` : ''}
      </dl>
    </section>`;

  Charts.bars($('#d-chart'), d.daily.map((x) => ({ ...x, total: x.seconds, parts: { v: x.seconds } })), {
    keys: ['v'], colors: { v: 'var(--accent)' }, names: { v: 'Active time' }, height: 160,
    label: (b, i) => (i % 2 === 0 ? fmtDate(b.date, { month: 'short', day: 'numeric' }) : ''),
    title: (b) => fmtDate(b.date, { weekday: 'long', month: 'short', day: 'numeric' }),
  });
  $('#d-close').addEventListener('click', closeDrawer);
  $('#d-edit').addEventListener('click', () => openAssetDialog(a));
  $('#d-del').addEventListener('click', async () => { if (await admin.deleteAsset(a.assetId)) { closeDrawer(); refresh(); } });
  $('#d-code').addEventListener('click', async () => {
    const r = a.enrolled ? await admin.resetEnrollment(a.assetId) : a;
    if (r) { showEnrollment(r); refresh(); }
  });
  $$('#drawer [data-copy]').forEach((b) => b.addEventListener('click', () => copy(b.dataset.copy, b)));
  $('#inst-q')?.addEventListener('input', (e) => { state.instQuery = e.target.value; const pos = e.target.selectionStart; renderDrawer().then(() => { const q = $('#inst-q'); if (q) { q.focus(); q.setSelectionRange(pos, pos); } }); });
  bindAlertCards($('#drawer'));
}

$('#scrim').addEventListener('click', closeDrawer);
document.addEventListener('keydown', (e) => {
  if (e.key !== 'Escape') return;
  if ($('#dialog-root').innerHTML) closeDialog();
  else if (state.drawer) closeDrawer();
});

// ---- alerts -------------------------------------------------------------------------------

function alertCard(a, compact = false) {
  const when = new Date(a.createdAt);
  return `
    <div class="card alert-card ${a.dismissed ? 'dismissed' : ''} ${a.status === 'reviewed' ? 'reviewed' : ''}" style="${compact ? 'padding:14px' : ''}" data-alert="${esc(a.uid)}">
      <span class="ai">${icon('alert', 18)}</span>
      <div style="min-width:0">
        <div class="title"><a data-asset="${esc(a.assetId)}" style="cursor:pointer">${esc(a.employeeName || a.assetId)}</a> <span class="idpill" style="padding:2px 6px">${esc(a.assetId)}</span>
          used <b>${esc(a.appName)}</b> on ${esc(fmtDate(a.createdAt, { weekday: 'long', month: 'short', day: 'numeric' }))} at ${esc(fmtTime(when))}</div>
        <span class="reason ${a.dismissed ? 'post' : ''}">${esc(a.dismissed ? 'No answer — postponed' : a.reason)}</span>
        ${a.details ? `<div class="quote">${esc(a.details)}</div>` : ''}
        ${a.duration || a.approver ? `<div class="meta">${a.duration ? `<span>${icon('clock', 12)} ${esc(a.duration)}</span>` : ''}${a.approver ? `<span>${icon('user', 12)} Approved by ${esc(a.approver)}</span>` : ''}</div>` : ''}
        ${compact ? '' : `<input class="input note-input" data-note="${esc(a.uid)}" placeholder="Add a private admin note…" value="${esc(a.adminNote || '')}">`}
      </div>
      <div style="display:flex;flex-direction:column;align-items:flex-end;gap:8px">
        <span class="state-pill ${a.status === 'new' ? 'idle' : 'tracking'}">${a.status === 'new' ? 'New' : 'Reviewed'}</span>
        <button class="btn sm" data-review="${esc(a.uid)}" data-to="${a.status === 'new' ? 'reviewed' : 'new'}">${a.status === 'new' ? `${icon('check', 13)} Mark reviewed` : 'Reopen'}</button>
      </div>
    </div>`;
}

function bindAlertCards(root = document) {
  $$('[data-review]', root).forEach((b) => b.addEventListener('click', async (e) => {
    e.stopPropagation();
    await admin.updateAlert(b.dataset.review, { status: b.dataset.to });
    refresh();
  }));
  $$('[data-note]', root).forEach((inp) => inp.addEventListener('change', () => admin.updateAlert(inp.dataset.note, { adminNote: inp.value })));
  $$('[data-asset]', root).forEach((b) => b.addEventListener('click', () => openDrawer(b.dataset.asset)));
}

async function renderAlerts() {
  if (document.activeElement?.matches('[data-note]')) return; // don't interrupt typing a note
  const all = await admin.alerts('all');
  if (state.page !== 'alerts') return;
  const counts = { new: all.filter((a) => a.status === 'new').length, reviewed: all.filter((a) => a.status === 'reviewed').length, all: all.length };
  const list = state.alertFilter === 'all' ? all : all.filter((a) => a.status === state.alertFilter);
  view.innerHTML = `
    ${topbar('Weekend alerts', 'Answers from employees who used development tools on a weekend')}
    <div class="content">
      <div class="chips">${[['new', 'New'], ['reviewed', 'Reviewed'], ['all', 'All']].map(([k, l]) => `<button class="chip ${state.alertFilter === k ? 'on' : ''}" data-af="${k}">${l}<span class="count">${counts[k]}</span></button>`).join('')}</div>
      ${list.length ? `<div class="alerts-list">${list.map((a) => alertCard(a)).join('')}</div>`
        : `<section class="card"><div class="empty"><div class="ei">${icon('check', 24)}</div><b>${state.alertFilter === 'new' ? 'All caught up' : 'No alerts'}</b>When someone opens a development tool on a weekend, their answer appears here.</div></section>`}
    </div>`;
  $$('[data-af]').forEach((c) => c.addEventListener('click', () => { state.alertFilter = c.dataset.af; renderAlerts(); }));
  bindAlertCards();
}

// ---- policies -----------------------------------------------------------------------------

async function renderPolicies() {
  if (!state.policyDraft) {
    const { policy, defaults } = await admin.getPolicy();
    state.policyDraft = structuredClone(policy);
    state.policyDefaults = defaults;
  }
  if (state.page !== 'policies') return;
  const p = state.policyDraft;
  view.innerHTML = `
    ${topbar('Policies', 'Applied to all agents within a minute of saving', `<span class="toast" id="pol-msg"></span><button class="btn ghost" id="pol-reset">Reset to defaults</button><button class="btn primary" id="pol-save">${icon('check', 14)} Save policy</button>`)}
    <div class="content settings">
      <section class="card">
        <div class="card-head"><h3>Weekend work check</h3><label class="switch"><input type="checkbox" id="pol-on" ${p.weekendCheck ? 'checked' : ''}><span></span></label></div>
        <div class="srow"><div><div class="st">Weekend days</div><div class="sd">Using a development tool on these days shows the warning on the laptop.</div></div>
          <div class="daypick" id="pol-days">${DAYS.map((d, i) => `<button data-d="${i}" class="${p.weekendDays.includes(i) ? 'on' : ''}">${d}</button>`).join('')}</div></div>
        <div class="field" style="padding:14px 0"><span>Message shown to the employee</span><textarea class="input" id="pol-msgtext" rows="3">${esc(p.message)}</textarea></div>
        <div class="field" style="padding-bottom:6px"><span>Reasons the employee can choose</span>
          <div class="tags" id="pol-reasons">${p.reasons.map((r, i) => `<span class="tag">${esc(r)}<button data-rr="${i}" title="Remove">${icon('close', 11)}</button></span>`).join('')}</div>
          <div style="display:flex;gap:8px;margin-top:8px"><input class="input" id="pol-reason-new" placeholder="Add a reason"><button class="btn" id="pol-reason-add">${icon('plus', 13)} Add</button></div></div>
      </section>
      <section class="card">
        <div class="card-head"><h3>Development tools</h3><span class="muted small">${p.devTools.length} apps · matched by app name or ID</span></div>
        <div class="tags" id="pol-tools">${p.devTools.map((t, i) => `<span class="tag">${esc(t)}<button data-rt="${i}" title="Remove">${icon('close', 11)}</button></span>`).join('')}</div>
        <div style="display:flex;gap:8px;margin-top:12px"><input class="input" id="pol-tool-new" placeholder="App name or ID, e.g. IntelliJ IDEA or com.jetbrains.intellij"><button class="btn" id="pol-tool-add">${icon('plus', 13)} Add</button></div>
      </section>
    </div>`;
  const msg = (t) => { $('#pol-msg').textContent = t; };
  $('#pol-on').addEventListener('change', (e) => { p.weekendCheck = e.target.checked; });
  $('#pol-msgtext').addEventListener('input', (e) => { p.message = e.target.value; });
  $$('#pol-days button').forEach((b) => b.addEventListener('click', () => {
    const d = Number(b.dataset.d);
    p.weekendDays = p.weekendDays.includes(d) ? p.weekendDays.filter((x) => x !== d) : [...p.weekendDays, d].sort();
    b.classList.toggle('on');
  }));
  const addFrom = (inputId, key) => {
    const v = $(inputId).value.trim();
    if (v && !p[key].includes(v)) p[key].push(v);
    renderPolicies();
  };
  $('#pol-tool-add').addEventListener('click', () => addFrom('#pol-tool-new', 'devTools'));
  $('#pol-tool-new').addEventListener('keydown', (e) => { if (e.key === 'Enter') addFrom('#pol-tool-new', 'devTools'); });
  $('#pol-reason-add').addEventListener('click', () => addFrom('#pol-reason-new', 'reasons'));
  $('#pol-reason-new').addEventListener('keydown', (e) => { if (e.key === 'Enter') addFrom('#pol-reason-new', 'reasons'); });
  $$('[data-rt]').forEach((b) => b.addEventListener('click', () => { p.devTools.splice(Number(b.dataset.rt), 1); renderPolicies(); }));
  $$('[data-rr]').forEach((b) => b.addEventListener('click', () => { p.reasons.splice(Number(b.dataset.rr), 1); renderPolicies(); }));
  $('#pol-reset').addEventListener('click', () => { state.policyDraft = structuredClone(state.policyDefaults); renderPolicies(); });
  $('#pol-save').addEventListener('click', async () => {
    state.policyDraft = await admin.setPolicy(p);
    msg('Saved — agents update within a minute');
  });
}

// ---- settings -----------------------------------------------------------------------------

function serverCard(info) {
  const addr = info.addresses[0]?.address || '';
  return `
    <section class="card">
      <div class="card-head"><h3>Address for employee laptops</h3>
        <span class="status-line ${info.running ? 'ok' : 'bad'}">${info.running ? `${icon('check', 14)} Backend connected` : `${icon('alert', 14)} Backend unreachable`}</span></div>
      ${info.error ? `<div class="banner warn" style="margin-bottom:12px"><span class="bi">${icon('alert', 16)}</span><div class="bt">${esc(info.error)}</div></div>` : ''}
      <div class="sd muted" style="margin-bottom:10px">Employees enter this address in Proglintor → Connect.</div>
      <div class="addr-list">${addr ? `<div class="codebox"><span class="addr">${esc(addr)}</span><button class="btn sm" data-copy="${esc(addr)}">${icon('copy', 13)} Copy</button></div>` : ''}</div>
      ${info.local ? `<div class="small muted" style="margin-top:10px">${icon('alert', 12)} This is a local address, so it only works for an agent on this same computer. For other laptops, run the backend on a server they can reach (for example <span class="mono">http://pulse.proglint.local:8000</span>) and sign in to that address.</div>` : ''}
    </section>`;
}
function bindServerCard() { $$('[data-copy]').forEach((b) => b.addEventListener('click', () => copy(b.dataset.copy, b))); }

async function renderSettings() {
  const [info, s] = await Promise.all([admin.serverInfo(), admin.getSettings()]);
  if (state.page !== 'settings') return;
  view.innerHTML = `
    ${topbar('Settings', 'Backend connection, startup and data')}
    <div class="content settings">
      <section class="card">
        <div class="card-head"><h3>Backend</h3></div>
        <div class="srow"><div><div class="st">Django backend</div><div class="sd mono">${esc(info.url)}</div></div>
          <span class="status-line ${info.running ? 'ok' : 'bad'}">${info.running ? `${icon('check', 14)} Connected` : `${icon('alert', 14)} Unreachable`}</span></div>
        <div class="srow"><div><div class="st">Signed in as</div><div class="sd">${esc(info.user?.name || '')} (${esc(info.user?.username || '')})</div></div>
          <button class="btn" id="logout">${icon('power', 14)} Sign out</button></div>
        <div class="srow"><div><div class="st">Data storage</div><div class="sd">All assets, usage and alerts are stored in PostgreSQL on the backend.</div></div></div>
      </section>
      ${serverCard(info)}
      <section class="card">
        <div class="card-head"><h3>Admin app</h3></div>
        <div class="srow"><div><div class="st">Start at login</div><div class="sd">Keeps weekend-alert notifications coming in the background.</div></div>
          <label class="switch"><input type="checkbox" id="login" ${s.openAtLogin ? 'checked' : ''}><span></span></label></div>
      </section>
      <section class="card">
        <div class="card-head"><h3>Export</h3><span class="toast" id="data-msg"></span></div>
        <div class="srow"><div><div class="st">Usage report</div><div class="sd">All assets, one row per app per day (CSV).</div></div><button class="btn" id="data-export">${icon('download', 14)} Export CSV</button></div>
      </section>
    </div>`;
  bindServerCard();
  $('#logout').addEventListener('click', async () => { await admin.logout(); showLogin(); });
  $('#login').addEventListener('change', async (e) => { const r = await admin.setSettings({ openAtLogin: e.target.checked }); e.target.checked = r.openAtLogin; });
  $('#data-export').addEventListener('click', async () => { if (await admin.exportCSV()) $('#data-msg').textContent = 'Exported'; });
}

// ---- sign in ------------------------------------------------------------------------------

function showLogin(message = '') {
  closeDrawer();
  closeDialog();
  $('.shell').hidden = true;
  let el = $('#login');
  if (!el) { el = document.createElement('div'); el.id = 'login'; document.body.appendChild(el); }
  admin.authStatus().then((st) => {
    el.innerHTML = `
      <div class="login-wrap">
        <form class="login-card card" id="login-form" novalidate>
          <picture class="wordmark login-word"><source srcset="../../../assets/brand/proglint-logo-white.png" media="(prefers-color-scheme: dark)"><img src="../../../assets/brand/proglint-logo.png" alt="Proglint"></picture>
          <h1>Proglintor Admin</h1>
          <p class="muted">Sign in to your Proglintor backend</p>
          <label class="field"><span>Backend address</span><input class="input mono" id="l-url" placeholder="http://127.0.0.1:8000" value="${esc(st.url || 'http://127.0.0.1:8000')}"></label>
          <label class="field"><span>Username</span><input class="input" id="l-user" autocomplete="username" value="${esc(st.user?.username || '')}"></label>
          <label class="field"><span>Password</span><input class="input" id="l-pass" type="password" autocomplete="current-password"></label>
          <div class="form-error" id="l-err">${esc(message)}</div>
          <button class="btn primary" id="l-go" type="submit" style="justify-content:center;padding:10px">Sign in</button>
          <div class="small muted" style="text-align:center">Admin accounts are created on the backend with <span class="mono">python manage.py createsuperuser</span>.</div>
        </form>
      </div>`;
    (st.user?.username ? $('#l-pass') : $('#l-user')).focus();
    $('#login-form').addEventListener('submit', async (e) => {
      e.preventDefault();
      const btn = $('#l-go');
      btn.disabled = true;
      btn.textContent = 'Signing in…';
      const r = await admin.login($('#l-url').value, $('#l-user').value.trim(), $('#l-pass').value);
      if (!r.ok) { $('#l-err').textContent = r.error; btn.disabled = false; btn.textContent = 'Sign in'; return; }
      el.remove();
      $('.shell').hidden = false;
      refreshSide();
      go('dashboard');
    });
  });
}

function offlineBanner(err) {
  view.innerHTML = `${topbar('Backend unreachable', '')}
    <div class="content"><section class="card"><div class="empty"><div class="ei">${icon('wifi', 24)}</div><b>Can't reach the Proglintor backend</b>
      <div style="max-width:520px;margin:6px auto 14px">${esc(err.message)}</div>
      <button class="btn" id="retry">${icon('refresh', 14)} Try again</button> <button class="btn ghost" id="relogin">Change backend</button></div></section></div>`;
  $('#retry').addEventListener('click', () => go(state.page));
  $('#relogin').addEventListener('click', () => showLogin());
}

// ---- navigation & live updates ------------------------------------------------------------------

const PAGES = { dashboard: renderDashboard, assets: renderAssets, alerts: renderAlerts, policies: renderPolicies, settings: renderSettings };

function go(page) {
  state.page = page;
  if (page !== 'policies') state.policyDraft = null;
  $$('#nav button').forEach((b) => b.classList.toggle('active', b.dataset.page === page));
  $('.main').scrollTop = 0;
  Charts.hideTip();
  runPage();
}

/** Runs the current page; sign-in and offline problems show their own screens. */
function runPage() {
  return Promise.resolve(PAGES[state.page]()).catch((err) => {
    if (err.auth) showLogin(err.message);
    else if (err.network) offlineBanner(err);
    else console.error(err);
  });
}
$$('#nav button').forEach((b) => b.addEventListener('click', () => go(b.dataset.page)));
document.addEventListener('click', (e) => { const g = e.target.closest('[data-goto]'); if (g) go(g.dataset.goto); });

async function refreshSide() {
  const info = await admin.serverInfo();
  const alerts = info.loggedIn ? await admin.alerts('new').catch(() => []) : [];
  const badge = $('#alert-badge');
  badge.hidden = !alerts.length;
  badge.textContent = alerts.length;
  $('#side-server').innerHTML = `
    <div class="row"><span class="dot ${info.running ? 'tracking' : 'unavailable'}"></span><span class="name">${info.running ? 'Backend connected' : 'Backend unreachable'}</span></div>
    <div class="meta"><span class="mono" style="overflow:hidden;text-overflow:ellipsis">${esc(info.addresses[0]?.address || '')}</span><span>${esc(info.user?.username || '')}</span></div>`;
}

function refresh() {
  if ($('#login')) return;
  refreshSide().catch(() => {});
  if (state.page !== 'policies') runPage();
  if (state.drawer) renderDrawer().catch(() => {});
}

let t = null;
admin.onUpdate(() => { clearTimeout(t); t = setTimeout(refresh, 250); });
admin.onNavigate((page) => go(page));
admin.onAuthRequired((msg) => { if (!$('#login')) showLogin(msg); });
setInterval(() => {
  $$('[data-since]').forEach((el) => { const s = Number(el.dataset.since); if (s) el.textContent = fmtClock((Date.now() - s) / 1000); });
}, 1000);
window.addEventListener('resize', () => { clearTimeout(t); t = setTimeout(() => { if (state.page === 'dashboard') renderDashboard(); if (state.drawer) renderDrawer(); }, 150); });

window.addEventListener('unhandledrejection', (e) => {
  if (e.reason?.auth) { e.preventDefault(); if (!$('#login')) showLogin(e.reason.message); }
  else if (e.reason?.network) { e.preventDefault(); refreshSide().catch(() => {}); }
});

(async function start() {
  const st = await admin.authStatus();
  if (!st.loggedIn) { showLogin(); return; }
  refreshSide().catch(() => {});
  go('dashboard');
}());
