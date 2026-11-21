'use strict';
/* global admin, InstallView, state, view, esc, icon, rel, fmtDate, fmtTime, $, $$, topbar, closeDialog, refresh, hue, initials, appIcon, hydrate */
// Admin pages for the install assistant: "Approvals" (decide on employees' requests) and "Software catalogue"
// (the approved, pinned installers employees can ask for). Only admins can reach these; the backend enforces it.

const PLATFORM_NAMES = { darwin: 'macOS', win32: 'Windows', linux: 'Linux' };
const ARCH_NAMES = { any: 'Any CPU', arm64: 'ARM64', x64: 'x64' };
const INSTALLERS = { darwin: ['dmg', 'zip', 'pkg'], win32: ['msi', 'exe'], linux: ['appimage'] };

let flashTimer = null;
function flash(message, tone = 'ok') {
  let el = document.getElementById('flash');
  if (!el) { el = document.createElement('div'); el.id = 'flash'; el.setAttribute('role', 'status'); document.body.appendChild(el); }
  el.className = `flash flash-${tone} show`;
  el.textContent = message;
  clearTimeout(flashTimer);
  flashTimer = setTimeout(() => el.classList.remove('show'), tone === 'bad' ? 6000 : 3000);
}

/** The app's icon: the one read from its bundle, else the one laptops reported for the same app id, else a letter tile. */
function itemIcon(i, size = 32) {
  if (i.icon) return `<img class="appicon" style="width:${size}px;height:${size}px" src="${esc(i.icon)}" alt="">`;
  return appIcon(i.appId || i.slug || 'app', '', size, i.name);
}

const swAvatar = (name) => `<span class="avatar" style="--h:${hue(name)}">${esc(initials(name))}</span>`;
const statusPill = (status) => { const b = InstallView.badge(status); return `<span class="sw-badge sw-${b.tone}">${esc(b.label)}</span>`; };
const sizeText = (n) => (n ? InstallView.bytes(n) : '');

// ---- approvals -----------------------------------------------------------------------------------------

/** An employee asked for something that isn't in the catalogue: the assistant found a candidate, the admin checks it for real. */
function newSoftwareCard(r) {
  const p = r.proposal || {};
  const tone = p.licenseClear ? 'sw-ok' : p.licenseKind === 'paid' ? 'sw-bad' : 'sw-wait';
  const checks = (p.checks || []).map((c) => `<li class="${c.ok ? 'chk-ok' : 'chk-warn'}">${esc(c.text)}</li>`).join('');
  return `<article class="card approval approval-new" data-req="${esc(r.id)}">
    <div class="approval-who">${swAvatar(r.employeeName)}<div style="min-width:0"><div class="nm">${esc(r.employeeName)}</div>
      <div class="sub">${esc(r.assetId)}${r.department ? ` · ${esc(r.department)}` : ''}${r.hostname ? ` · ${esc(r.hostname)}` : ''}</div></div>
      <span class="muted small approval-when">${esc(rel(r.createdAt))}</span></div>
    <div class="approval-what"><span class="eyebrow">${icon('spark', 13)} New software · not in the catalogue yet</span>
      <div class="approval-name">${esc(p.name || r.softwareName || r.rawRequest)}</div>
      <div class="muted">${esc([p.vendor, p.host].filter(Boolean).join(' · '))}</div>
      <div class="approval-chips"><span class="sw-badge ${tone}">${esc(p.licenseLabel || 'Licence not confirmed')}</span>
        <span class="pill">${esc(PLATFORM_NAMES[r.assetPlatform] || 'Unknown system')} laptop</span><span class="pill ${r.deviceOnline ? '' : 'pill-warn'}">${r.deviceOnline ? 'Laptop online' : 'Laptop offline'}</span></div>
      ${p.licenseNote ? `<p class="muted small" style="margin:6px 0 0">Licence: ${esc(p.licenseNote)}${p.licenseClear ? '' : ' You will be asked to confirm the company is licensed before approving.'}</p>` : ''}
      <ul class="checks">${checks}</ul>
      <div class="quote">“${esc(r.rawRequest)}”</div>
      <p class="muted small" style="margin:8px 0 0">The link and the licence were suggested by AI and are <b>not verified yet</b>. “Review &amp; approve” downloads the file here and checks the signature, version and checksum before anything is added or installed.</p>
    </div>
    <div class="approval-actions">
      <button class="btn" data-decline="${esc(r.id)}" data-version="${r.requestVersion}">Decline</button>
      <button class="btn primary" data-review="${esc(r.id)}">${icon('shield', 14)} Review &amp; approve</button>
    </div></article>`;
}

/** A .pkg installs system-wide: macOS asks for an administrator's name and password. Tell the approver when the employee isn't one. */
function needsAdminPill(installerType, localAdmin) {
  return installerType === 'pkg' && localAdmin === false
    ? '<span class="pill pill-warn" title="macOS will ask for an administrator’s name and password on their computer to install a .pkg. A .dmg or .zip of the same app installs without one.">Standard user</span>' : '';
}

function approvalCard(r) {
  if (r.kind === 'new') return newSoftwareCard(r);
  const what = [r.softwareName, r.version].filter(Boolean).join(' ');
  const meta = [r.publisher, r.installerType && `.${r.installerType}`, sizeText(r.sizeBytes)].filter(Boolean).map(esc).join(' · ');
  return `<article class="card approval" data-req="${esc(r.id)}">
    <div class="approval-who">${swAvatar(r.employeeName)}<div style="min-width:0"><div class="nm">${esc(r.employeeName)}</div>
      <div class="sub">${esc(r.assetId)}${r.department ? ` · ${esc(r.department)}` : ''}${r.hostname ? ` · ${esc(r.hostname)}` : ''}</div></div>
      <span class="muted small approval-when">${esc(rel(r.createdAt))}</span></div>
    <div class="approval-what"><span class="eyebrow">Wants to install</span>
      <div class="approval-name">${r.icon ? `<img class="appicon" style="width:30px;height:30px" src="${esc(r.icon)}" alt="">` : ''}${esc(what || r.rawRequest)}</div>
      ${meta ? `<div class="muted">${meta}</div>` : ''}
      <div class="approval-chips">${r.sha256Prefix ? `<span class="idpill" title="Laptops only install a file that matches the checksum you pinned">SHA-256 ${esc(r.sha256Prefix)}…</span>` : ''}
        <span class="pill ${r.deviceOnline ? '' : 'pill-warn'}">${r.deviceOnline ? 'Laptop online' : 'Laptop offline'}</span>${needsAdminPill(r.installerType, r.assetLocalAdmin)}</div>
      <div class="quote">“${esc(r.rawRequest)}”</div>
      ${r.deviceOnline ? '' : '<p class="muted small" style="margin:6px 0 0">This laptop is offline. It will install when it reconnects; the approval expires after 24 hours if it doesn’t.</p>'}
    </div>
    <div class="approval-actions">
      <button class="btn" data-decline="${esc(r.id)}" data-version="${r.requestVersion}">Decline</button>
      <button class="btn primary" data-approve="${esc(r.id)}" data-version="${r.requestVersion}">${icon('check', 14)} Approve &amp; install</button>
    </div></article>`;
}

async function decide(id, decision, version, comment, btn) {
  if (btn) btn.disabled = true;
  const r = await admin.decideSoftware(id, decision, Number(version), comment);
  if (!r.ok) {
    if (r.network) flash("Couldn't reach the server. Nothing was changed — try again in a moment.", 'bad');
    else flash(r.error, 'bad'); // e.g. someone else decided first; the refresh below shows the current state
    refresh();
    return false;
  }
  flash(decision === 'APPROVED' ? 'Approved. The laptop will install it now.' : 'Declined. The employee has been told.');
  refresh();
  return true;
}

function openDeclineDialog(id, version) {
  $('#dialog-root').innerHTML = `<div class="dialog-backdrop" id="dlg-bg"><div class="dialog" role="dialog" aria-modal="true" style="width:min(480px,100%)">
    <h2>Decline this request?</h2><p class="lead">The employee sees your reason, so a short, kind note helps.</p>
    <label class="field"><span>Reason <small>(optional)</small></span><textarea class="input" id="f-comment" rows="3" maxlength="500" placeholder="e.g. We already have a licensed alternative: Slack."></textarea></label>
    <div class="actions"><button class="btn ghost" id="f-cancel">Cancel</button><button class="btn primary" id="f-confirm">Decline request</button></div></div></div>`;
  $('#dlg-bg').addEventListener('mousedown', (e) => { if (e.target.id === 'dlg-bg') closeDialog(); });
  $('#f-cancel').addEventListener('click', closeDialog);
  $('#f-comment').focus();
  $('#f-confirm').addEventListener('click', async (e) => {
    e.currentTarget.disabled = true;
    const ok = await decide(id, 'REJECTED', version, $('#f-comment').value.trim());
    if (ok) closeDialog(); else e.currentTarget.disabled = false;
  });
}

function historyRow(r) {
  const what = [r.softwareName, r.version].filter(Boolean).join(' ') || r.rawRequest;
  return `<div class="sw-trow item" data-detail="${esc(r.id)}" tabindex="0">
    <span class="muted small">${esc(rel(r.createdAt))}</span>
    <span style="min-width:0;display:flex;gap:10px;align-items:center">${swAvatar(r.employeeName)}<span style="min-width:0"><span class="nm">${esc(r.employeeName)}</span><span class="sub">${esc(r.assetId)}</span></span></span>
    <span style="min-width:0"><span class="nm" style="font-weight:550">${esc(what)}</span><span class="sub">“${esc(r.rawRequest)}”</span></span>
    ${statusPill(r.status)}
    <span class="muted small" style="min-width:0">${esc(r.decidedBy || (r.decisionReason === 'AUTO_APPROVED' ? 'Auto-approved' : '—'))}</span>
    <span class="chev muted">${icon('right', 14)}</span></div>`;
}

const HISTORY_FILTERS = [['', 'All'], ['open', 'In progress'], ['SUCCEEDED', 'Installed'], ['FAILED', 'Failed'], ['REJECTED', 'Declined'], ['NOT_FOUND', 'Not in catalogue']];

async function renderApprovals() {
  if (document.activeElement?.matches('#f-comment')) return;
  const tab = state.swTab || 'pending';
  const [pending, history] = await Promise.all([admin.softwareApprovals(), tab === 'history' ? admin.softwareRequests(state.swFilter || '') : null]);
  if (state.page !== 'approvals') return;
  const items = pending.items || [];
  state.swPending = new Map(items.map((r) => [r.id, r]));
  const nav = $('#approval-badge');
  if (nav) { nav.hidden = !items.length; nav.textContent = items.length; }
  const head = `<div class="chips"><button class="chip ${tab === 'pending' ? 'on' : ''}" data-tab="pending">Needs approval<span class="count">${items.length}</span></button>
    <button class="chip ${tab === 'history' ? 'on' : ''}" data-tab="history">All requests</button></div>`;
  let body;
  if (tab === 'pending') {
    body = items.length ? `<div class="approvals">${items.map(approvalCard).join('')}</div>`
      : `<section class="card"><div class="empty"><div class="ei">${icon('check', 24)}</div><b>All caught up</b>When an employee asks for software that needs approval, it shows up here. You'll also get a notification.</div></section>`;
  } else {
    const rows = history.items || [];
    body = `<div class="chips" style="margin-bottom:2px">${HISTORY_FILTERS.map(([k, l]) => `<button class="chip ${(state.swFilter || '') === k ? 'on' : ''}" data-hf="${k}">${l}</button>`).join('')}</div>
      <div class="table">${rows.length ? `<div class="sw-trow head"><span>Asked</span><span>Employee</span><span>Software</span><span>Status</span><span>Decided by</span><span></span></div>${rows.map(historyRow).join('')}`
        : `<div class="empty"><b>No requests here</b>Nothing matches this filter yet.</div>`}</div>`;
  }
  view.innerHTML = `${topbar('Approvals', 'Software requests from employees', '')}<div class="content">${head}${body}</div>`;
  $$('[data-tab]').forEach((b) => b.addEventListener('click', () => { state.swTab = b.dataset.tab; renderApprovals(); }));
  $$('[data-hf]').forEach((b) => b.addEventListener('click', () => { state.swFilter = b.dataset.hf; renderApprovals(); }));
  $$('[data-approve]').forEach((b) => b.addEventListener('click', () => decide(b.dataset.approve, 'APPROVED', b.dataset.version, '', b)));
  $$('[data-decline]').forEach((b) => b.addEventListener('click', () => openDeclineDialog(b.dataset.decline, b.dataset.version)));
  $$('[data-review]').forEach((b) => b.addEventListener('click', () => openAddDialog({ request: state.swPending.get(b.dataset.review) })));
  $$('[data-detail]').forEach((r) => {
    r.addEventListener('click', () => openRequestDialog(r.dataset.detail));
    r.addEventListener('keydown', (e) => { if (e.key === 'Enter') openRequestDialog(r.dataset.detail); });
  });
}

const EVENT_TEXT = {
  requested: 'Asked for it', awaiting_approval: 'Sent for approval', queued: 'Ready to install', auto_approved: 'Approved automatically', approved: 'Approved',
  rejected: 'Declined', cancelled: 'Cancelled by the employee', claimed: 'Laptop picked it up', downloading: 'Downloading', installing: 'Installing', verifying: 'Verifying',
  succeeded: 'Installed and verified', failed: 'Failed', expired: 'Expired', blocked: 'Stopped for safety', not_found: 'Not in the catalogue', already_installed: 'Already installed', incompatible: 'Not compatible',
};

async function openRequestDialog(id) {
  const r = await admin.softwareRequest(id).catch((e) => { flash(e.message, 'bad'); return null; });
  if (!r) return;
  $('#dialog-root').innerHTML = `<div class="dialog-backdrop" id="dlg-bg"><div class="dialog" role="dialog" aria-modal="true">
    <div style="display:flex;align-items:center;gap:10px;flex-wrap:wrap"><h2 style="margin:0">${esc([r.softwareName, r.version].filter(Boolean).join(' ') || 'Request')}</h2>${statusPill(r.status)}</div>
    <p class="lead">${esc(r.employeeName)} · ${esc(r.assetId)} · “${esc(r.rawRequest)}”</p>
    <dl class="kv"><dt>Request ID</dt><dd class="mono">${esc(r.id)}</dd><dt>Result</dt><dd>${esc(r.decisionReason || '—')}</dd>
      ${r.decidedBy ? `<dt>Decided by</dt><dd>${esc(r.decidedBy)}${r.decisionComment ? ` — “${esc(r.decisionComment)}”` : ''}</dd>` : ''}
      ${r.sha256Prefix ? `<dt>Pinned checksum</dt><dd class="mono">${esc(r.sha256Prefix)}…</dd>` : ''}</dl>
    <div class="eyebrow" style="margin:16px 0 8px">Audit trail</div>
    <ol class="audit">${(r.events || []).map((e) => `<li><span class="audit-time">${esc(fmtDate(e.at, { month: 'short', day: 'numeric' }))} ${esc(fmtTime(e.at))}</span><span><b>${esc(EVENT_TEXT[e.kind] || e.kind)}</b>${e.detail ? ` <span class="muted">· ${esc(e.detail)}</span>` : ''}<span class="sub">${esc(e.actor)}</span></span></li>`).join('')}</ol>
    <div class="actions"><button class="btn primary" id="f-done">Close</button></div></div></div>`;
  $('#dlg-bg').addEventListener('mousedown', (e) => { if (e.target.id === 'dlg-bg') closeDialog(); });
  $('#f-done').addEventListener('click', closeDialog);
}

// ---- catalogue -------------------------------------------------------------------------------------------

function itemRow(i) {
  return `<div class="sw-crow item ${i.enabled ? '' : 'is-off'}" data-slug="${esc(i.slug)}" tabindex="0">
    <span class="sw-app">${itemIcon(i, 34)}<span style="min-width:0"><span class="nm">${esc(i.name)} <span class="muted" style="font-weight:500">${esc(i.version)}</span></span><span class="sub">${esc(i.publisher || i.slug)}</span></span></span>
    <span><span class="pill">${esc(PLATFORM_NAMES[i.platform] || i.platform)}</span> <span class="pill">${esc(ARCH_NAMES[i.arch] || i.arch)}</span> <span class="pill sys">.${esc(i.installerType)}</span></span>
    <span>${i.requiresApproval ? '<span class="sw-badge sw-wait">Needs approval</span>' : '<span class="sw-badge sw-ok">Auto-approved</span>'}</span>
    <span class="num muted">${i.requests || 0}</span>
    <label class="switch" title="${i.enabled ? 'Available to employees' : 'Hidden from employees'}"><input type="checkbox" data-toggle="${esc(i.slug)}" ${i.enabled ? 'checked' : ''} aria-label="Available to employees"><span></span></label>
    <span class="row-actions"><button class="iconbtn" data-edit="${esc(i.slug)}" title="Edit" aria-label="Edit ${esc(i.name)}">${icon('edit', 15)}</button>
      <button class="iconbtn" data-remove="${esc(i.slug)}" data-name="${esc(i.name)}" title="Remove" aria-label="Remove ${esc(i.name)}">${icon('trash', 15)}</button></span></div>`;
}

async function renderSoftware() {
  const data = await admin.softwareItems();
  if (state.page !== 'software') return;
  const items = data.items || [];
  state.swItems = items;
  view.innerHTML = `${topbar('Software catalogue', `${items.length} approved installer${items.length === 1 ? '' : 's'}`,
    `<label class="search">${icon('search', 14)}<input id="sw-q" type="search" placeholder="Search software" value="${esc(state.swQuery || '')}"></label><button class="btn primary" id="sw-new">${icon('plus', 14)} Add software</button>`)}
    <div class="content">
      <div class="banner"><span class="bi">${icon('shield', 18)}</span><div class="bt"><b>Employees can only install what’s listed here</b><span class="muted">Each entry pins the installer’s SHA-256 checksum. Laptops delete any download that doesn’t match it, so a swapped or tampered file never runs.</span></div></div>
      <div class="table" id="sw-table"></div>
    </div>`;
  $('#sw-q').addEventListener('input', (e) => { state.swQuery = e.target.value; drawSoftwareTable(); });
  $('#sw-new').addEventListener('click', () => openAddDialog());
  drawSoftwareTable();
}

/** Redraws only the table, so typing in the search box never loses focus. */
function drawSoftwareTable() {
  const items = state.swItems || [];
  const q = (state.swQuery || '').trim().toLowerCase();
  const shown = items.filter((i) => !q || [i.name, i.publisher, i.slug, ...(i.aliases || [])].some((v) => String(v || '').toLowerCase().includes(q)));
  const el = $('#sw-table');
  if (!el) return;
  el.innerHTML = shown.length ? `<div class="sw-crow head"><span>Software</span><span>Build</span><span>Approval</span><span>Requests</span><span>Live</span><span></span></div>${shown.map(itemRow).join('')}`
    : items.length ? '<div class="empty"><b>No matching software</b></div>'
      : `<div class="empty"><div class="ei">${icon('layers', 24)}</div><b>No software yet</b>Add the apps your team may install, with the official download link and checksum.<div style="margin-top:14px"><button class="btn primary" id="sw-new2">${icon('plus', 14)} Add software</button></div></div>`;
  $('#sw-new2')?.addEventListener('click', () => openAddDialog());
  hydrate(el);
  $$('[data-edit]', el).forEach((b) => b.addEventListener('click', (e) => { e.stopPropagation(); openItemDialog(items.find((i) => i.slug === b.dataset.edit)); }));
  $$('.sw-crow.item', el).forEach((r) => r.addEventListener('dblclick', () => openItemDialog(items.find((i) => i.slug === r.dataset.slug))));
  $$('[data-toggle]', el).forEach((c) => c.addEventListener('change', async () => {
    const r = await admin.updateSoftware(c.dataset.toggle, { enabled: c.checked });
    if (!r.ok) { c.checked = !c.checked; flash(r.error, 'bad'); } else flash(c.checked ? 'Now available to employees.' : 'Hidden from employees.');
  }));
  $$('[data-remove]', el).forEach((b) => b.addEventListener('click', async (e) => {
    e.stopPropagation();
    try { if (await admin.deleteSoftware(b.dataset.remove, b.dataset.name)) flash('Removed from the catalogue.'); } catch (err) { flash(err.message, 'bad'); }
  }));
}

// ---- add software: pick an app or paste a link; the details are worked out and verified for you ---------------------------

const ARCH_FRIENDLY = { any: 'Apple silicon + Intel', arm64: 'Apple silicon', x64: 'Intel' };
const FORMAT_FRIENDLY = { dmg: 'Disk image (.dmg)', zip: 'Zip (.zip)', pkg: 'Installer package (.pkg)', msi: 'Windows installer (.msi)', exe: 'Windows installer (.exe)', appimage: 'AppImage' };

let inspectListener = null;
if (typeof admin.onInspect === 'function') admin.onInspect((stage) => { if (inspectListener) inspectListener(stage); });

function dialogShell(inner, width = 720) {
  $('#dialog-root').innerHTML = `<div class="dialog-backdrop" id="dlg-bg"><div class="dialog" role="dialog" aria-modal="true" style="width:min(${width}px,100%)">${inner}</div></div>`;
  $('#dlg-bg').addEventListener('mousedown', (e) => { if (e.target.id === 'dlg-bg') { admin.cancelInspect(); closeDialog(); } });
}

function inspectProgressHtml(label) {
  return `<div class="inspect" role="status" aria-live="polite"><p class="inspect-title" id="inspect-title">${esc(label)}</p>
    <div class="sw-bar is-indeterminate" id="inspect-bar"><i></i></div><p class="muted small" id="inspect-note">Fetching the file…</p></div>`;
}

/** Runs one check, showing live progress inside the dialog. Resolves { ok, data | message, hint }. */
async function runInspect(request, label) {
  $('#wiz-body').innerHTML = inspectProgressHtml(label);
  inspectListener = (st) => {
    const bar = $('#inspect-bar');
    const note = $('#inspect-note');
    if (!bar || !note) return;
    if (st.stage === 'rendering') {
      bar.classList.add('is-indeterminate');
      bar.firstElementChild.style.width = '';
      note.textContent = 'That page builds its download links with a script, so I’m opening it like a browser to find them…';
    } else if (st.stage === 'checking') {
      bar.classList.add('is-indeterminate');
      bar.firstElementChild.style.width = '';
      note.textContent = 'Opening it safely and checking who signed it…';
    } else if (st.total) {
      bar.classList.remove('is-indeterminate');
      bar.firstElementChild.style.width = `${Math.round((st.done / st.total) * 100)}%`;
      note.textContent = `Downloaded ${InstallView.bytes(st.done)} of ${InstallView.bytes(st.total)}`;
    } else if (st.done) {
      note.textContent = `Downloaded ${InstallView.bytes(st.done)}…`;
    }
  };
  try { return await admin.inspectSoftware(request); } finally { inspectListener = null; }
}

const PLATFORM_LABEL = { darwin: 'macOS', win32: 'Windows', linux: 'Linux' };

/** A failed check: what happened and what to do. When a web page offers several downloads, they are listed to pick from. */
function errorHtml(error) {
  if (!error) return '';
  const hint = error.hint ? `<div class="muted" style="font-weight:500">${esc(error.hint)}</div>` : '';
  if (!error.choices?.length) return `<div class="form-error" role="alert" style="margin-top:12px"><b>${esc(error.message)}</b>${hint}</div>`;
  const rows = error.choices.map((c, i) => `<button type="button" class="pick" data-pick="${i}"><span class="pick-title"><span class="pick-file">${esc(c.label || c.file)}</span>${c.label ? `<span class="pick-sub">${esc(c.file)}</span>` : ''}</span>
    <span class="pick-meta"><span class="pill">${esc(PLATFORM_LABEL[c.platform] || c.platform)}</span>${c.type ? `<span class="pill sys">.${esc(c.type)}</span>` : ''}${c.recommended ? '<span class="sw-badge sw-ok">Recommended</span>' : ''}</span></button>`).join('');
  return `<div role="status" style="margin-top:12px"><b>${esc(error.message)}</b>${hint}<div class="picker">${rows}</div></div>`;
}

function openAddDialog(opts = {}) {
  const reqCtx = opts.request || null; // set when an admin reviews an employee's request for software that isn't in the catalogue
  const proposal = reqCtx?.proposal || {};
  const have = (name) => (state.swItems || []).some((i) => i.name.toLowerCase() === name.toLowerCase());
  let tab = reqCtx ? 'link' : 'preset';
  let presets = null;
  let error = null;
  const cleanUrl = (t) => ((/https?:\/\/[^\s"'<>`]+/i.exec(String(t || '')) || [''])[0]).replace(/[)\],.;:!?]+$/, ''); // a pasted link may carry a prompt symbol, quotes or <brackets>
  let lastUrl = reqCtx ? cleanUrl(proposal.downloadUrl) : ''; // kept so a failed check doesn't make the admin retype the link

  const choose = () => {
    const tabs = reqCtx ? [['link', 'Download link']] : [['preset', 'Popular apps'], ['link', 'Download link']];
    const body = tab === 'preset'
      ? (presets === null ? '<p class="muted">Loading…</p>'
        : `<div class="preset-grid">${presets.map((p) => `<button type="button" class="preset-card" data-preset="${esc(p.id)}"><span class="preset-name">${esc(p.name)}</span><span class="muted small">${esc(p.publisher)}</span><span class="small">${esc(p.description)}</span>${have(p.name) ? '<span class="sw-badge sw-ok">In catalogue</span>' : ''}</button>`).join('')}</div>`)
      : `<label class="field"><span>Download link</span><input class="input mono" id="w-url" value="${esc(lastUrl)}" placeholder="https://example.com/App.dmg" maxlength="2000" autocomplete="off" spellcheck="false"><small>The installer’s own https link, or the vendor’s download page: I’ll look for the installer on it.<br>Supported: <b>.dmg</b>, <b>.zip</b> (containing one app) or <b>.pkg</b> for Mac · <b>.msi</b> or <b>.exe</b> for Windows · <b>AppImage</b> for Linux. Not supported: .tar.xz, .deb, .rpm, Windows .zip.</small></label>
        <div style="display:flex;justify-content:flex-end;margin-top:12px"><button class="btn primary" id="w-check">Check link</button></div>`;
    $('#wiz-body').innerHTML = `<div class="segmented" role="tablist">${tabs.map(([k, l]) => `<button role="tab" aria-selected="${tab === k}" data-wtab="${k}" class="${tab === k ? 'on' : ''}">${l}</button>`).join('')}</div>
      <div style="margin-top:14px">${body}</div>${errorHtml(error)}`;
    $$('[data-pick]').forEach((b) => b.addEventListener('click', () => {
      const c = error.choices[Number(b.dataset.pick)];
      start({ url: c.url }, `Downloading ${c.file}`);
    }));
    $$('[data-wtab]').forEach((b) => b.addEventListener('click', () => { tab = b.dataset.wtab; error = null; choose(); }));
    $$('[data-preset]').forEach((b) => b.addEventListener('click', () => start({ presetId: b.dataset.preset }, `Downloading ${presets.find((p) => p.id === b.dataset.preset).name}`)));
    $('#w-check')?.addEventListener('click', () => {
      const raw = $('#w-url').value.trim();
      const url = cleanUrl(raw);
      if (!url) { error = { message: 'That doesn’t look like a web address.', hint: 'Paste the full link, starting with https://' }; choose(); return; }
      start({ url }, 'Downloading the installer');
    });
    $('#w-url')?.addEventListener('keydown', (e) => { if (e.key === 'Enter') $('#w-check').click(); });
    $('#w-url')?.focus();
  };

  const start = async (request, label) => {
    error = null;
    if (request.url && !request.presetId) lastUrl = request.url;
    $('#wiz-foot').innerHTML = '<button class="btn ghost" id="w-cancel2">Cancel check</button>';
    $('#w-cancel2').addEventListener('click', () => admin.cancelInspect());
    let r = await runInspect(reqCtx ? { ...request, preferPlatform: reqCtx.assetPlatform, preferArch: reqCtx.assetArch, hintName: proposal.name } : request, label);
    if (!r.ok && reqCtx && r.code === 'NOT_AN_INSTALLER' && !request.presetId) {
      // The suggested page gave nothing, but this may be one of the popular apps whose vetted download we already know.
      const known = await popularMatch();
      if (known) {
        setNote(`I couldn’t find an installer on the suggested page, but ${known.name} is a popular app, so I’m using its verified download instead.`);
        r = await runInspect({ presetId: known.id, preferPlatform: reqCtx.assetPlatform }, `Downloading ${known.name}`);
      }
    }
    $('#wiz-foot').innerHTML = footChoose;
    bindFoot();
    if (!r.ok) { if (r.code !== 'CANCELLED') error = r; choose(); return; }
    review(r.data);
  };

  const setNote = (text) => { const el = $('#wiz-note'); if (el) el.textContent = text; };
  const popularMatch = async () => {
    const list = typeof admin.softwarePresets === 'function' ? await admin.softwarePresets().catch(() => []) : [];
    const squash = (t) => String(t || '').toLowerCase().replace(/[^a-z0-9]/g, '');
    const want = squash(proposal.name);
    return want ? list.find((p) => want.includes(squash(p.name)) || squash(p.name).includes(want)) || null : null;
  };

  const footChoose = reqCtx ? '<button class="btn ghost" id="w-close">Cancel</button>' : '<button class="btn ghost" id="w-close">Cancel</button><button class="btn ghost" id="w-manual">Enter details yourself</button>';
  const bindFoot = () => {
    $('#w-close')?.addEventListener('click', closeDialog);
    $('#w-manual')?.addEventListener('click', () => openItemDialog(null, { manual: true }));
  };

  const context = reqCtx ? `<div class="banner" style="margin-bottom:12px"><span class="bi">${icon('user', 16)}</span><div class="bt"><b>${esc(reqCtx.employeeName)} (${esc(reqCtx.assetId)}) asked for “${esc(reqCtx.rawRequest)}”</b>
      <span class="muted">AI suggested <strong>${esc(proposal.name || '')}</strong>${proposal.vendor ? ` by ${esc(proposal.vendor.replace(/[.\s]+$/, ''))}` : ''}. Checking the file now: nothing is added or installed until you approve.</span></div></div>` : '';
  dialogShell(`<h2>${reqCtx ? 'Review &amp; approve' : 'Add software'}</h2><p class="lead">${reqCtx ? 'I download the file here and check who signed it, so you approve what is really there.' : 'Pick a popular app or paste a download link. I’ll check who signed it and fill in the details for you.'}</p>
    ${context}<p class="muted small" id="wiz-note" style="margin:-4px 0 10px"></p><div id="wiz-body"></div><div class="dialog-foot"><div class="actions" id="wiz-foot">${footChoose}</div></div>`);
  bindFoot();
  choose();
  if (reqCtx && lastUrl) start({ url: lastUrl }, 'Checking the suggested download');
  if (!reqCtx && typeof admin.softwarePresets === 'function') admin.softwarePresets().then((p) => { presets = p; if (tab === 'preset' && $('#wiz-body [data-wtab]')) choose(); }).catch(() => { presets = []; choose(); });

  const review = (d) => {
    const fact = (label, value) => (value ? `<div class="dev-item"><div class="label">${label}</div><div class="value">${value}</div></div>` : '');
    const WIN_ARCH = { x64: ' · 64-bit Intel/AMD', arm64: ' · ARM' };
    const platformNote = d.platform === 'darwin' ? ARCH_FRIENDLY[d.arch] || d.arch
      : d.platform === 'win32' ? `Windows${WIN_ARCH[d.arch] || ''}` : '';
    $('#wiz-body').innerHTML = `
      ${d.foundOn ? `<p class="muted small" style="margin:0 0 8px">That was a web page, so I looked for the installer on it and used <b>${esc(d.downloadUrl.split('/').pop().split('?')[0] || 'its download')}</b>.</p>` : ''}
      ${d.icon ? `<div class="review-app"><img class="appicon" style="width:48px;height:48px" src="${esc(d.icon)}" alt=""><b>${esc(d.name)}</b></div>` : ''}
      ${d.verified ? `<div class="verified"><span class="sw-badge sw-ok">Signature verified</span><span>Signed by <b>${esc(d.publisher || 'a verified developer')}</b>${d.teamId ? ` · Team ID <code>${esc(d.teamId)}</code>` : ''}</span></div>` : ''}
      ${(d.warnings || []).map((w) => `<div class="banner ${w.tone === 'info' ? '' : 'warn'}" style="margin:10px 0"><span class="bi">${icon(w.tone === 'info' ? 'shield' : 'alert', 16)}</span><div class="bt">${esc(w.text)}</div></div>`).join('')}
      <div class="dev-grid" style="margin:12px 0">${fact('Format', esc(FORMAT_FRIENDLY[d.installerType] || d.installerType))}${fact('Runs on', esc(platformNote || { linux: 'Linux' }[d.platform] || ''))}${fact('Signed by', esc(d.signedBy))}
        ${fact('Size', esc(InstallView.bytes(d.sizeBytes)))}${fact('Needs macOS', d.minOs ? `${esc(d.minOs)}+` : '')}${fact('Identifier', d.appId ? `<code>${esc(d.appId)}</code>` : '')}${fact('SHA-256', `<code title="${esc(d.sha256)}">${esc(d.sha256.slice(0, 16))}…</code>`)}</div>
      ${reqCtx ? requestPanel(d) : ''}
      <div class="form-grid">
        <label class="field"><span>Name employees see<em>*</em></span><input class="input" id="r-name" data-key="name" value="${esc(d.name)}" maxlength="120"></label>
        <label class="field"><span>Version<em>*</em></span><input class="input" id="r-version" data-key="version" value="${esc(d.version)}" maxlength="40" placeholder="e.g. 4.38.0">${d.version ? '' : '<small>I couldn’t read the version from this file. Please type it.</small>'}</label>
        <label class="field full"><span>Other names people search for</span><input class="input" id="r-aliases" value="${esc((d.aliases || []).join(', '))}" placeholder="comma separated"></label>
        ${d.installerType === 'exe' ? `<label class="field full"><span>Silent install options<em>*</em></span><input class="input mono" id="r-silent" data-key="silentArgs" placeholder="/S /norestart" value="${esc((d.silentArgs || []).join(' '))}"></label>` : ''}
        <label class="srow full" style="grid-column:1/-1;padding:6px 0"><span><span class="st">Needs an admin’s approval</span><span class="sd" style="display:block">Recommended. Turn off only for apps everyone may install on request.</span></span>
          <span class="switch"><input type="checkbox" id="r-approval" checked><span></span></span></label>
      </div><div class="form-error" id="f-err" role="alert"></div>`;
    const blocker = reqCtx ? requestBlocker(d) : '';
    $('#wiz-foot').innerHTML = `<button class="btn ghost" id="r-back">Back</button><button class="btn primary" id="r-add" ${blocker ? 'disabled' : ''}>${reqCtx ? 'Add to catalogue &amp; approve' : 'Add to catalogue'}</button>`;
    if (blocker) $('#f-err').textContent = blocker;
    const licence = $('#r-licence');
    if (licence && !blocker) { $('#r-add').disabled = true; licence.addEventListener('change', () => { $('#r-add').disabled = !licence.checked; }); }
    $('#r-back').addEventListener('click', () => { $('#wiz-foot').innerHTML = footChoose; bindFoot(); choose(); });
    $('#r-name').focus();
    $('#r-add').addEventListener('click', async (e) => {
      const btn = e.currentTarget;
      $$('.invalid').forEach((x) => x.classList.remove('invalid'));
      const payload = {
        name: $('#r-name').value.trim(), version: $('#r-version').value.trim(), publisher: d.publisher, description: d.description || '', platform: d.platform, arch: d.arch,
        installerType: d.installerType, sizeBytes: d.sizeBytes, downloadUrl: d.downloadUrl, sha256: d.sha256, appName: d.appName, appId: d.appId, teamId: d.teamId,
        aliases: $('#r-aliases').value, silentArgs: $('#r-silent')?.value.trim() || '', requiresApproval: $('#r-approval').checked, icon: d.icon || '',
      };
      if (d.installerType === 'exe' && !payload.silentArgs) {
        $('#f-err').textContent = 'Add the silent-install options for this .exe (for example /S /norestart). Without them laptops can’t install it.';
        $('#r-silent').classList.add('invalid');
        $('#r-silent').focus();
        return;
      }
      btn.disabled = true;
      const r = reqCtx
        ? await admin.approveNewSoftware(reqCtx.id, reqCtx.requestVersion, payload, Boolean($('#r-licence')?.checked) || Boolean(proposal.licenseClear))
        : await admin.createSoftware(payload);
      btn.disabled = false;
      if (!r.ok && reqCtx && (r.code === 'stale' || r.code === 'not_pending')) { closeDialog(); flash(r.error, 'bad'); refresh(); return; }
      if (!r.ok) {
        $('#f-err').textContent = r.network ? "Couldn't reach the server. Check your connection and try again."
          : r.code === 'duplicate' ? `${payload.name} is already in the catalogue. Decline this request and ask ${reqCtx ? reqCtx.employeeName : 'the employee'} to request it again.` : r.error;
        const bad = r.code && document.querySelector(`#wiz-body [data-key="${CSS.escape(r.code)}"]`);
        if (bad) { bad.classList.add('invalid'); bad.focus(); }
        return;
      }
      refresh();
      $('#wiz-body').innerHTML = reqCtx
        ? `<div class="empty" style="padding:26px 10px"><div class="ei">${icon('check', 24)}</div><b>${esc(payload.name)} ${esc(payload.version)} approved and added to the catalogue</b>It is installing on ${esc(reqCtx.employeeName)}’s computer now. Other employees can ask for it by name${payload.requiresApproval ? ', and those requests will wait for approval' : ''}.</div>`
        : `<div class="empty" style="padding:26px 10px"><div class="ei">${icon('check', 24)}</div><b>${esc(payload.name)} ${esc(payload.version)} is in the catalogue</b>Employees can now ask for it by name${payload.requiresApproval ? '. Their requests will wait for your approval' : ' and it installs without approval'}.</div>`;
      $('#wiz-foot').innerHTML = '<button class="btn ghost" id="d-more">Add another</button><button class="btn primary" id="d-close">Done</button>';
      $('#d-close').addEventListener('click', closeDialog);
      $('#d-more').addEventListener('click', () => { $('#wiz-foot').innerHTML = footChoose; bindFoot(); choose(); });
      if (reqCtx) $('#d-more').hidden = true;
    });
  };

  /** What the admin must weigh up when approving new software: the licence, who asked, and whether the file matches the request. */
  function requestPanel(d) {
    const compact = (t) => String(t || '').toLowerCase().replace(/[^a-z0-9]/g, '');
    const nameOk = !proposal.name || compact(d.name).includes(compact(proposal.name)) || compact(proposal.name).includes(compact(d.name));
    const tone = proposal.licenseClear ? 'sw-ok' : proposal.licenseKind === 'paid' ? 'sw-bad' : 'sw-wait';
    const adminNote = d.installerType === 'pkg' && reqCtx.assetLocalAdmin === false
      ? `<div class="banner warn" style="margin:10px 0"><span class="bi">${icon('alert', 16)}</span><div class="bt">${esc(reqCtx.employeeName)} is a standard user on a Mac. Installing a <strong>.pkg</strong> will ask for an administrator’s name and password on their computer; a .dmg or .zip build of the same app would not. Consider that build, or have an admin ready.</div></div>` : '';
    return `${adminNote}${nameOk ? '' : `<div class="banner warn" style="margin:10px 0"><span class="bi">${icon('alert', 16)}</span><div class="bt">The file is called <strong>${esc(d.name)}</strong>, but ${esc(reqCtx.employeeName)} asked for <strong>${esc(proposal.name)}</strong>. Make sure it is the right app.</div></div>`}
      <div class="licence-box"><div><span class="eyebrow">Licence (AI-suggested, please confirm)</span><div style="margin-top:6px"><span class="sw-badge ${tone}">${esc(proposal.licenseLabel || 'Licence not confirmed')}</span></div>
        ${proposal.licenseNote ? `<p class="muted small" style="margin:6px 0 0">${esc(proposal.licenseNote)}</p>` : ''}</div>
        ${proposal.licenseClear ? '' : `<label class="checkbox-row"><input type="checkbox" id="r-licence"> <span>I confirm our company is licensed to use ${esc(d.name || proposal.name)} on ${esc(reqCtx.employeeName)}’s computer.</span></label>`}</div>`;
  }

  /** Reasons the approval can't go ahead from this file (shown under the form; the Add button stays off). */
  function requestBlocker(d) {
    const names = PLATFORM_NAMES;
    if (reqCtx.assetPlatform && d.platform !== reqCtx.assetPlatform) {
      return `That build is for ${names[d.platform] || d.platform}, but ${reqCtx.employeeName}’s computer runs ${names[reqCtx.assetPlatform] || reqCtx.assetPlatform}. Go back and use a link for their system.`;
    }
    if (d.platform === 'darwin' && d.arch !== 'any' && reqCtx.assetArch && d.arch !== reqCtx.assetArch) {
      return `That build only runs on ${ARCH_FRIENDLY[d.arch] || d.arch}, and ${reqCtx.employeeName}’s computer is ${ARCH_FRIENDLY[reqCtx.assetArch] || reqCtx.assetArch}.`;
    }
    return '';
  }
}

// ---- edit (and "enter details yourself") --------------------------------------------------------------------------------

function openItemDialog(existing = null, opts = {}) {
  const a = existing || { platform: 'darwin', arch: 'any', installerType: 'dmg', requiresApproval: true, enabled: true, aliases: [], silentArgs: [] };
  const input = (key, label, value, o = {}) => `<label class="field ${o.full ? 'full' : ''}"><span>${label}${o.req ? '<em>*</em>' : ''}</span>
    <input class="input ${o.mono ? 'mono' : ''}" data-key="${key}" value="${esc(value ?? '')}" placeholder="${esc(o.ph || '')}" ${o.max ? `maxlength="${o.max}"` : ''}>${o.hint ? `<small>${o.hint}</small>` : ''}</label>`;
  const select = (key, label, list, value) => `<label class="field"><span>${label}</span><select class="input" data-key="${key}">${list.map(([v, l]) => `<option value="${esc(v)}" ${v === value ? 'selected' : ''}>${esc(l)}</option>`).join('')}</select></label>`;
  let newIcon = null; // set when "Update to a newer version" reads a fresh icon
  const updateBox = existing ? `<div class="update-box"><div><b>Update to a newer version</b><div class="muted small">Paste the new download link. I’ll check it’s signed by the same developer and fill in the details below.</div></div>
      <div class="update-row"><input class="input mono" id="u-url" placeholder="https://…" autocomplete="off" spellcheck="false"><button class="btn" id="u-check">Check</button></div><div class="small" id="u-note" role="status"></div></div>` : '';
  dialogShell(`<h2 style="display:flex;align-items:center;gap:12px">${existing ? `${itemIcon(existing, 36)}Edit ${esc(existing.name)}` : 'Enter details yourself'}</h2>
    <p class="lead">${existing ? 'Changes apply to new requests. Requests already waiting are stopped for safety.' : 'For installers the automatic check can’t read. Laptops still insist on the checksum below.'}</p>
    ${updateBox}
    <div class="form-grid">
      ${input('name', 'Name', a.name, { req: true, ph: 'Visual Studio Code', max: 120 })}
      ${input('version', 'Version', a.version, { req: true, ph: '1.140.0', max: 40 })}
      ${input('aliases', 'Other names people use', (a.aliases || []).join(', '), { full: true, ph: 'vscode, vs code', hint: 'Comma separated. Helps the assistant find it.' })}
      <label class="srow full" style="grid-column:1/-1;padding:6px 0"><span><span class="st">Needs an admin’s approval</span><span class="sd" style="display:block">Turn off only for software everyone may install on request.</span></span>
        <span class="switch"><input type="checkbox" data-key="requiresApproval" ${a.requiresApproval ? 'checked' : ''}><span></span></span></label>
    </div>
    <details class="advanced" ${existing ? '' : 'open'}><summary>Advanced details</summary>
      <div class="form-grid" style="margin-top:12px">
        ${input('publisher', 'Publisher', a.publisher, { ph: 'Microsoft', max: 120 })}
        ${select('platform', 'Operating system', Object.entries(PLATFORM_NAMES), a.platform)}
        ${select('arch', 'Processor', Object.entries(ARCH_NAMES), a.arch)}
        ${select('installerType', 'Installer type', (INSTALLERS[a.platform] || INSTALLERS.darwin).map((t) => [t, `.${t}`]), a.installerType)}
        ${input('downloadUrl', 'Download link', a.downloadUrl, { req: true, full: true, mono: true, ph: 'https://…', hint: 'Must be a secure https:// link.' })}
        ${input('sha256', 'SHA-256 checksum', a.sha256, { req: true, full: true, mono: true, ph: '64 hexadecimal characters', hint: 'Run <b>shasum -a 256 file</b> (macOS/Linux) or <b>Get-FileHash file</b> (Windows) on the file you reviewed.' })}
        ${input('sizeBytes', 'File size (bytes)', a.sizeBytes ?? '', { ph: '104857600', hint: 'Optional. Enables progress and a disk-space check.' })}
        ${input('description', 'Description', a.description, { max: 300, ph: 'Short note shown to employees' })}
        <div class="full form-grid" data-only="darwin">
          ${input('appName', 'App file name', a.appName, { ph: 'Visual Studio Code.app', hint: 'The .app inside the dmg/zip.' })}
          ${input('appId', 'Bundle identifier', a.appId, { mono: true, ph: 'com.microsoft.VSCode' })}
          ${input('teamId', 'Apple Team ID', a.teamId, { mono: true, ph: 'UBF8T346G9', max: 10, hint: 'Rejects apps signed by anyone else.' })}
        </div>
        <div class="full form-grid" data-only="win32 linux">
          ${input('appId', 'App name on the computer', a.appId, { ph: 'Visual Studio Code' })}
          ${input('silentArgs', 'Silent install options', (a.silentArgs || []).join(' '), { mono: true, ph: '/S /norestart', hint: '.exe installers need these.' })}
        </div>
      </div></details>
    <div class="dialog-foot"><div class="form-error" id="f-err" role="alert"></div>
      <div class="actions"><button class="btn ghost" id="f-cancel">Cancel</button><button class="btn primary" id="f-save">${existing ? 'Save changes' : 'Add to catalogue'}</button></div></div>`);

  const dlg = $('#dialog-root');
  const field = (k) => dlg.querySelector(`[data-key="${k}"]:not([disabled])`);
  const val = (k) => { const el = field(k); return el ? (el.type === 'checkbox' ? el.checked : el.value.trim()) : ''; };
  const sync = () => {
    const platform = dlg.querySelector('[data-key="platform"]').value;
    dlg.querySelectorAll('[data-only]').forEach((g) => { const on = g.dataset.only.split(' ').includes(platform); g.hidden = !on; g.querySelectorAll('[data-key]').forEach((el) => { el.disabled = !on; }); });
    const sel = dlg.querySelector('[data-key="installerType"]');
    const types = INSTALLERS[platform];
    if (sel.options.length !== types.length || ![...sel.options].every((o, i) => o.value === types[i])) {
      const cur = sel.value;
      sel.innerHTML = types.map((t) => `<option value="${t}">.${t}</option>`).join('');
      sel.value = types.includes(cur) ? cur : types[0];
    }
  };
  dlg.querySelector('[data-key="platform"]').addEventListener('change', sync);
  sync();
  $('#f-cancel').addEventListener('click', () => { admin.cancelInspect(); closeDialog(); });
  field('name').focus();
  dlg.addEventListener('input', () => { $('#f-err').textContent = ''; dlg.querySelectorAll('.invalid').forEach((x) => x.classList.remove('invalid')); });

  $('#u-check')?.addEventListener('click', async (e) => {
    const url = $('#u-url').value.trim();
    if (!url) return;
    const btn = e.currentTarget;
    const note = $('#u-note');
    btn.disabled = true;
    note.className = 'small muted';
    note.textContent = 'Downloading and checking…';
    inspectListener = (st) => { note.textContent = st.stage === 'checking' ? 'Checking who signed it…' : st.total ? `Downloaded ${InstallView.bytes(st.done)} of ${InstallView.bytes(st.total)}` : 'Downloading…'; };
    const r = await admin.inspectSoftware({ url, expectTeamId: existing.teamId || '' });
    inspectListener = null;
    btn.disabled = false;
    if (!r.ok) {
      note.className = 'small bad-text';
      note.textContent = r.choices?.length
        ? `${r.message} Paste the exact link of the one you want, for example: ${r.choices.slice(0, 3).map((c) => c.file).join(', ')}.`
        : `${r.message} ${r.hint || ''}`;
      return;
    }
    const d = r.data;
    const set = (k, v) => { const el = field(k); if (el && v !== undefined && v !== null && v !== '') el.value = v; };
    set('version', d.version); set('downloadUrl', d.downloadUrl); set('sha256', d.sha256); set('sizeBytes', d.sizeBytes);
    set('appName', d.appName); set('appId', d.appId); set('teamId', d.teamId); set('installerType', d.installerType);
    if (d.icon) newIcon = d.icon;
    note.className = 'small ok';
    note.textContent = `Filled in from ${d.name || 'the download'} ${d.version || ''}${d.verified ? ' (signature verified)' : ''}. Review and save.`;
  });

  $('#f-save').addEventListener('click', async (e) => {
    const btn = e.currentTarget;
    const data = {
      name: val('name'), version: val('version'), publisher: val('publisher'), aliases: val('aliases'), platform: val('platform'), arch: val('arch'),
      installerType: val('installerType'), sizeBytes: val('sizeBytes'), downloadUrl: val('downloadUrl'), sha256: val('sha256'), appName: val('appName'),
      appId: val('appId'), teamId: val('teamId'), silentArgs: val('silentArgs'), description: val('description'), requiresApproval: val('requiresApproval'),
    };
    if (newIcon) data.icon = newIcon;
    btn.disabled = true;
    dlg.querySelectorAll('.invalid').forEach((x) => x.classList.remove('invalid'));
    const r = existing ? await admin.updateSoftware(existing.slug, data) : await admin.createSoftware(data);
    btn.disabled = false;
    if (!r.ok) {
      $('#f-err').textContent = r.network ? "Couldn't reach the server. Check your connection and try again." : r.error;
      const bad = r.code && field(r.code);
      if (bad) {
        const box = bad.closest('details');
        if (box) box.open = true; // the problem field may be inside "Advanced details"
        bad.classList.add('invalid');
        bad.focus();
      }
      return;
    }
    closeDialog();
    flash(existing ? 'Saved.' : `${data.name} added to the catalogue.`);
    refresh();
  });
}
