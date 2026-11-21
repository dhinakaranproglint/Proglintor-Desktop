'use strict';
/* global agent, ChatLogic, InstallView, state, view, esc, icon, rel, fmtTime, $, $$, go, refreshStatus */
// "Install software" page: the employee's chat with the install assistant.
// Loaded before app.js; everything that touches `state`, `view` and the shared helpers runs later, on demand.

const chat = {
  inited: false,
  messages: [],            // { id, role, text, requestId?, candidates?, error?, retry?, action?, at }
  ctx: { lastInstallPrompt: null, lastStatus: null, lastReason: null },
  requests: new Map(),     // request id -> latest server copy (single source of truth for every card)
  order: [],               // request ids, newest first
  catalogue: null,
  catalogueAt: 0,
  mode: 'submit',          // 'submit' = make a request, 'ask' = just check what would happen
  busy: false,
  draft: '',
  org: null,
  pollTimer: null,
  clockTimer: null,
  listError: null,
  seen: new Set(),         // thread items already shown once (so only brand-new messages animate)
};

const CHAT_TERMINAL_NOTES = new Set(['SUCCEEDED', 'FAILED', 'FAILED_VERIFICATION', 'REJECTED', 'EXPIRED', 'BLOCKED', 'CANCELLED']);
const RETRYABLE_ERRORS = new Set(['offline', 'server_error', 'not_connected']);

function newKey() {
  return (crypto.randomUUID && crypto.randomUUID()) || `req-${Date.now()}-${Math.random().toString(16).slice(2)}`;
}

function pushMsg(msg) {
  chat.messages.push({ at: Date.now(), ...msg });
  if (state.page === 'install') drawThread(true);
}

// ---- rendering ------------------------------------------------------------------------------------

/**
 * The chat belongs to whoever this laptop is currently assigned to. If it is removed or handed to someone else,
 * nothing from the previous person's conversation or request history may remain on screen.
 * Returns true when the identity changed (the first sighting is not a change).
 */
function syncIdentity(org) {
  const id = org.enrolled ? org.assetId : '';
  const changed = chat.assetId !== undefined && chat.assetId !== id;
  chat.assetId = id;
  if (changed) {
    chat.messages = [];
    chat.requests.clear();
    chat.order = [];
    chat.catalogue = null;
    chat.ctx = { lastInstallPrompt: null, lastStatus: null, lastReason: null, pendingSuggestion: null, pendingProposal: null };
    chat.listError = null;
    chat.seen.clear();
    chat.inited = false;
    chat.busy = false;
    updateInstallBadge();
  }
  return changed;
}

async function renderInstall() {
  chat.org = await agent.orgStatus();
  syncIdentity(chat.org);
  if (state.page !== 'install') return;
  if (!chat.inited) {
    chat.inited = true;
    chat.messages.push({ id: 'welcome', role: 'assistant', text: ChatLogic.welcome(chat.org.employeeName), local: true, at: Date.now() });
  } else if (chat.messages.length === 1 && chat.messages[0].id === 'welcome') {
    chat.messages[0].text = ChatLogic.welcome(chat.org.employeeName); // the name is known once the laptop is connected
  }
  view.innerHTML = `
    <header class="topbar"><div><h1>Install software</h1><div class="sub">Ask for an app and I'll get it on this computer</div></div>
      <div class="controls"><div class="segmented" role="group" aria-label="What should I do with your message?">
        <button data-mode="submit" class="${chat.mode === 'submit' ? 'on' : ''}" title="Send a real request">Request</button>
        <button data-mode="ask" class="${chat.mode === 'ask' ? 'on' : ''}" title="Only check what would happen. Nothing is sent to your admin.">Check only</button>
      </div></div></header>
    <div class="install-page">
      <section class="chat-shell" aria-label="Install assistant">
        <div id="chat-banner"></div>
        <div class="chat-scroll" id="chat-scroll" role="log" aria-live="polite" aria-relevant="additions"><div class="chat-thread" id="chat-thread"></div></div>
        <form class="composer" id="composer" autocomplete="off">
          <div class="composer-box">
            <label class="sr-only" for="composer-input">Message the install assistant</label>
            <textarea id="composer-input" rows="1" maxlength="${ChatLogic.MAX_LEN}" placeholder="What would you like to install?"></textarea>
            <span class="composer-count" id="composer-count" hidden></span>
            <button type="submit" class="btn primary" id="composer-send" aria-label="Send">${icon('send', 15)}</button>
          </div>
          <div class="composer-hint" id="composer-hint"></div>
        </form>
      </section>
      <aside class="install-rail" id="install-rail" aria-label="Your requests"></aside>
    </div>`;
  $$('[data-mode]').forEach((b) => b.addEventListener('click', () => { chat.mode = b.dataset.mode; $$('[data-mode]').forEach((x) => x.classList.toggle('on', x === b)); drawComposerState(); }));
  bindComposer();
  $('#chat-thread').addEventListener('click', onThreadClick);
  drawBanner();
  drawThread(false);
  drawRail();
  drawComposerState();
  startInstallPolling();
  loadCatalogue();
  refreshRequests();
  $('#composer-input').focus();
}

function drawBanner() {
  const el = $('#chat-banner');
  if (!el) return;
  const o = chat.org || {};
  let html = '';
  if (o.removed) html = bannerHtml('alert', 'This laptop was removed from Proglintor', 'Your admin removed it, so I can’t send requests. Reconnect with a new enrollment code.', 'Reconnect');
  else if (!o.enrolled) html = bannerHtml('building', 'Connect this laptop first', 'Enter the enrollment code from your Proglint admin, then come back to install software.', 'Connect');
  else if (!o.online && o.lastError) html = bannerHtml('wifi', "Can't reach Proglint right now", 'I can’t send or check requests until the connection is back. Check your network or VPN.', null);
  if (el.dataset.sig === html) return; // unchanged: don't touch it (a redraw every poll would make it blink)
  el.dataset.sig = html;
  el.innerHTML = html;
  el.querySelector('[data-go]')?.addEventListener('click', () => go('device'));
}

function bannerHtml(ic, title, text, action) {
  return `<div class="banner warn chat-banner"><span class="bi">${icon(ic, 17)}</span><div class="bt"><b>${esc(title)}</b><span class="muted">${esc(text)}</span></div>${action ? `<button class="btn sm primary" data-go>${esc(action)}</button>` : ''}</div>`;
}

function drawComposerState() {
  const o = chat.org || {};
  const blocked = !o.enrolled || Boolean(o.removed);
  const input = $('#composer-input');
  if (!input) return;
  input.disabled = blocked;
  input.placeholder = blocked ? 'Connect this laptop to start' : chat.mode === 'ask' ? 'Check an app, e.g. “Is Slack available?”' : 'What would you like to install?';
  $('#composer-send').disabled = blocked || chat.busy || !input.value.trim();
  const hint = chat.mode === 'ask'
    ? 'Check only: I’ll tell you what would happen. Nothing is requested.'
    : 'Enter to send · Shift+Enter for a new line · Say “status”, “cancel” or “what can I install?”';
  // Shown only when the company has AI turned on: employees should know before they type.
  const ai = chat.assistant?.chat ? ' AI-assisted: some messages are processed by Google Gemini, so please don’t include personal or confidential details.' : '';
  $('#composer-hint').textContent = hint + ai;
}

function bindComposer() {
  const input = $('#composer-input');
  const count = $('#composer-count');
  input.value = chat.draft;
  const fit = () => {
    input.style.height = 'auto';
    input.style.height = `${Math.min(input.scrollHeight, 140)}px`;
    chat.draft = input.value;
    const left = ChatLogic.MAX_LEN - input.value.length;
    count.hidden = left > 80;
    count.textContent = String(left);
    $('#composer-send').disabled = chat.busy || !input.value.trim() || input.disabled;
  };
  input.addEventListener('input', fit);
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) { e.preventDefault(); $('#composer').requestSubmit(); }
  });
  $('#composer').addEventListener('submit', (e) => {
    e.preventDefault();
    const text = input.value;
    if (!text.trim() || chat.busy || input.disabled) return;
    input.value = '';
    fit();
    sendChat(text);
  });
  fit();
}

function msgTime(at) { return fmtTime(at); }

function drawThread(follow) {
  const scroller = $('#chat-scroll');
  const thread = $('#chat-thread');
  if (!thread) return;
  const nearBottom = scroller.scrollHeight - scroller.scrollTop - scroller.clientHeight < 90;
  const only = chat.messages.length === 1 && chat.messages[0].id === 'welcome';
  const items = [];
  if (only) items.push({ key: 'hero', html: heroHtml() });
  for (const m of chat.messages) items.push({ key: `m:${m.id}`, html: messageHtml(m), message: true });
  if (chat.busy) items.push({ key: 'thinking', html: thinkingHtml() });
  if (only) items.push({ key: 'suggest', html: suggestionsHtml() });
  reconcileThread(thread, items);
  if (follow ? nearBottom || chat.messages.at(-1)?.role === 'user' || chat.busy : false) scroller.scrollTop = scroller.scrollHeight;
}

/**
 * Updates the thread in place: an item whose HTML hasn't changed is left completely alone, so nothing re-animates or blinks
 * when a poll arrives. Only genuinely new messages fade in, and only once.
 */
function reconcileThread(thread, items) {
  const existing = new Map([...thread.children].map((e) => [e.dataset.key, e]));
  let prev = null;
  for (const it of items) {
    let el = existing.get(it.key);
    existing.delete(it.key);
    if (!el || el.dataset.sig !== it.html) {
      const holder = document.createElement('div');
      holder.innerHTML = it.html;
      const fresh = holder.firstElementChild;
      fresh.dataset.key = it.key;
      fresh.dataset.sig = it.html;
      if (it.message && !chat.seen.has(it.key)) fresh.classList.add('msg-new');
      if (el) el.replaceWith(fresh);
      el = fresh;
    }
    if (it.message) chat.seen.add(it.key);
    if (el.previousElementSibling !== prev || !el.parentNode) thread.insertBefore(el, prev ? prev.nextSibling : thread.firstChild);
    prev = el;
  }
  existing.forEach((e) => e.remove());
}

function heroHtml() {
  return `<header class="chat-hero"><span class="chat-logo">${icon('package', 26)}</span><h2>What do you need installed?</h2>
    <p class="muted">Approved apps only. I'll ask your admin when it's needed and keep you posted.</p></header>`;
}

function suggestionsHtml() {
  const names = (chat.catalogue || []).slice(0, 4).map((i) => `Install ${i.name}`);
  const chips = [...names, 'What can I install?', 'Help'];
  return `<div class="suggestion-row">${chips.map((c) => `<button type="button" class="suggestion-chip" data-say="${esc(c)}">${esc(c)}</button>`).join('')}</div>`;
}

function thinkingHtml() {
  return `<article class="msg msg-assistant" aria-label="Thinking"><div class="msg-avatar" aria-hidden="true">P</div><div class="msg-body"><p class="thinking-dots" aria-hidden="true"><span></span><span></span><span></span></p></div></article>`;
}

function messageHtml(m) {
  if (m.role === 'user') return `<article class="msg msg-user"><p class="msg-text">${esc(m.text)}</p></article>`;
  const found = m.requestId ? chat.requests.get(m.requestId) : null;
  // "Not in the catalogue" has no progress to show: the sentence above says it all (it stays in the requests list).
  const req = found && !InstallView.NO_CARD.has(found.status) ? found : null;
  const chips = (m.candidates || []).length
    ? `<div class="suggestion-row inline">${m.candidates.map((c) => `<button type="button" class="suggestion-chip" data-say="Install ${esc(c)}">${esc(c)}</button>`).join('')}</div>` : '';
  const confirm = m.confirm
    ? `<div class="suggestion-row inline"><button type="button" class="suggestion-chip chip-yes" data-say="yes">Yes, request ${esc(m.confirm)}</button><button type="button" class="suggestion-chip" data-say="no">No</button></div>` : '';
  const propose = m.propose
    ? `<div class="suggestion-row inline"><button type="button" class="suggestion-chip chip-yes" data-act="confirm-new" data-id="${esc(m.propose.id)}">Yes, ask IT to review ${esc(m.propose.name)}</button><button type="button" class="suggestion-chip" data-act="drop-new" data-id="${esc(m.propose.id)}">No, never mind</button></div>` : '';
  const reinstall = m.reinstall
    ? `<div class="suggestion-row inline"><button type="button" class="suggestion-chip" data-say="reinstall ${esc(m.reinstall)}">Reinstall ${esc(m.reinstall)}</button></div>` : '';
  const retry = m.retry ? `<div class="msg-actions"><button class="btn sm" data-act="resend" data-msg="${esc(m.id)}">${icon('refresh', 13)} Try sending again</button></div>` : '';
  const action = m.action === 'device' ? `<div class="msg-actions"><button class="btn sm primary" data-go>Open My Device</button></div>` : '';
  const pv = m.preview ? previewHtml(m.preview) : '';
  return `<article class="msg msg-assistant" data-msg-id="${esc(m.id)}"><div class="msg-avatar" aria-hidden="true">P</div>
    <div class="msg-body"><div class="msg-meta"><b>${esc(ChatLogic.NAME)}</b><span class="muted">${esc(msgTime(m.at))}</span></div>
    <p class="msg-text${m.error ? ' is-error' : ''}">${esc(m.text).replace(/\n/g, '<br>')}</p>${pv}${chips}${confirm}${propose}${reinstall}${req ? cardHtml(req) : ''}${retry}${action}</div></article>`;
}

function previewHtml(p) {
  const tone = { AWAITING_APPROVAL: 'wait', QUEUED: 'ok', ALREADY_INSTALLED: 'ok' }[p.status] || 'muted';
  const label = { AWAITING_APPROVAL: 'Needs approval', QUEUED: 'Would install now', ALREADY_INSTALLED: 'Already installed', NOT_FOUND: 'Not in catalogue', INCOMPATIBLE: 'Not available', NEEDS_CLARIFICATION: 'Which one?' }[p.status] || p.status;
  return `<div class="sw-card sw-preview"><div class="sw-head"><span class="sw-badge sw-${tone}">${esc(label)}</span>${p.match ? `<span class="muted">${esc(p.match.name)} ${esc(p.match.version)}${p.match.publisher ? ` · ${esc(p.match.publisher)}` : ''}</span>` : ''}</div>
    <p class="muted small">Check only. Nothing was requested.</p></div>`;
}

function cardHtml(req) {
  const b = InstallView.badge(req.status);
  const steps = InstallView.steps(req);
  const live = InstallView.isActive(req.status);
  const now = Date.now();
  const prog = InstallView.progress(req, now);
  const failure = ChatLogic.failureInfo(req.decisionReason);
  const failed = ['FAILED', 'FAILED_VERIFICATION', 'BLOCKED'].includes(req.status);
  const canRetry = (failed && (failure ? failure.retry : true)) || ['EXPIRED'].includes(req.status);
  const escalate = failed && (!failure || failure.escalate);
  const bar = live ? `<div class="sw-progress"><div class="sw-bar ${prog.indeterminate ? 'is-indeterminate' : ''}" role="progressbar" aria-valuemin="0" aria-valuemax="100" ${prog.percent != null ? `aria-valuenow="${prog.percent}"` : ''} aria-valuetext="${esc(prog.detail)}"><i style="${prog.percent != null && !prog.indeterminate ? `width:${prog.percent}%` : ''}"></i></div>
    <div class="sw-progress-meta"><span>${esc(prog.detail)}${prog.percent != null && !prog.indeterminate ? ` · ${prog.percent}%` : ''}</span><span class="num">${esc(InstallView.elapsed(req, now))}</span></div></div>` : '';
  const stepper = steps ? `<ol class="sw-steps" aria-label="Progress">${steps.map((s) => `<li class="sw-step sw-step-${s.state}">${esc(s.label)}</li>`).join('')}</ol>` : '';
  const what = [req.softwareName, req.version].filter(Boolean).join(' ');
  const buttons = [
    InstallView.isCancellable(req.status) ? `<button class="btn sm" data-act="cancel" data-id="${esc(req.id)}">Cancel request</button>` : '',
    canRetry ? `<button class="btn sm primary" data-act="retry" data-id="${esc(req.id)}">${icon('refresh', 13)} Try again</button>` : '',
    escalate ? `<button class="btn sm" data-act="copy" data-id="${esc(req.id)}">${icon('copy', 13)} Copy details for IT</button>` : '',
  ].filter(Boolean).join('');
  const headline = req.status === 'REJECTED' && req.decisionComment ? `Declined: “${req.decisionComment}”` : InstallView.headline(req.status, req.kind);
  const fresh = req.kind === 'new' && req.proposal
    ? `<p class="sw-note sw-note-info">New to the approved list${req.proposal.host ? ` · ${esc(req.proposal.host)}` : ''}${req.proposal.licenseLabel ? ` · ${esc(req.proposal.licenseLabel)}` : ''}. IT checks the download and the licence before approving.</p>` : '';
  return `<div class="sw-card ${live ? 'is-live' : ''}" role="status" data-card="${esc(req.id)}">
    <div class="sw-head"><span class="sw-badge sw-${b.tone}">${esc(b.label)}</span><span class="sw-title">${esc(what || 'Your request')}</span></div>
    <p class="sw-headline">${esc(headline)}</p>${req.status === 'AWAITING_APPROVAL' ? fresh : ''}${bar}${stepper}
    ${failed && failure ? `<p class="sw-note">${esc(failure.text)}</p>` : ''}
    ${buttons ? `<div class="sw-actions">${buttons}</div>` : ''}
    <p class="sw-foot muted small">Request ${esc(req.id.slice(0, 8))} · ${esc(rel(req.createdAt))}${req.decidedBy ? ` · ${esc(req.decidedBy)} decided` : ''}</p></div>`;
}

function drawRail() {
  const el = $('#install-rail');
  if (!el) return;
  const rows = chat.order.map((id) => chat.requests.get(id)).filter(Boolean).slice(0, 12);
  // "Not connected" is already explained by the banner; only show other problems (offline, server trouble) here.
  const showListError = Boolean(chat.listError) && !rows.length && !['not_enrolled', 'removed'].includes(chat.listError.code);
  el.innerHTML = `<div class="card rail-card"><div class="card-head"><h3>Your requests</h3>${rows.length ? `<span class="muted small">${rows.length}</span>` : ''}</div>
    ${showListError ? `<p class="muted small">${esc(chat.listError.error)}</p>` : ''}
    ${rows.length ? `<ul class="rail-list">${rows.map((r) => { const b = InstallView.badge(r.status); return `<li><button class="rail-item" data-focus="${esc(r.id)}"><span class="rail-name">${esc(r.softwareName || r.rawRequest)}</span><span class="sw-badge sw-${b.tone}">${esc(b.label)}</span><span class="rail-time muted">${esc(rel(r.createdAt))}</span></button></li>`; }).join('')}</ul>`
      : showListError ? '' : '<p class="muted small">Nothing yet. Your requests and their results will show up here.</p>'}</div>
    <div class="card rail-card"><div class="card-head"><h3>How it works</h3></div><ol class="rail-steps"><li>Ask for an app</li><li>An admin approves it if needed</li><li>I download, install and verify it</li></ol></div>`;
  el.querySelectorAll('[data-focus]').forEach((b) => b.addEventListener('click', () => focusRequest(b.dataset.focus)));
}

/** One delegated handler: cards are redrawn often, so buttons inside them never carry their own listeners. */
function onThreadClick(e) {
  const t = e.target.closest('[data-say],[data-go],[data-act]');
  if (!t) return;
  if (t.dataset.say !== undefined) { if (!chat.busy) sendChat(t.dataset.say); }
  else if (t.dataset.go !== undefined) go('device');
  else onCardAction(t.dataset.act, t.dataset.id, t.dataset.msg);
}

// ---- actions ----------------------------------------------------------------------------------------

function focusRequest(id) {
  const card = $(`[data-card="${CSS.escape(id)}"]`);
  if (card) { card.scrollIntoView({ block: 'center', behavior: 'smooth' }); card.classList.add('flash'); setTimeout(() => card.classList.remove('flash'), 1200); return; }
  const r = chat.requests.get(id);
  if (!r) return;
  chat.messages.push({ id: `a-${id}`, role: 'assistant', text: `Here's where “${r.softwareName || r.rawRequest}” stands.`, requestId: id, at: Date.now() });
  drawThread(true);
}

async function copyText(text) {
  try { await navigator.clipboard.writeText(text); return true; } catch { /* fall through */ }
  const t = document.createElement('textarea');
  t.value = text; t.style.position = 'fixed'; t.style.opacity = '0';
  document.body.appendChild(t); t.select();
  let ok = false;
  try { ok = document.execCommand('copy'); } catch { /* ignore */ }
  t.remove();
  return ok;
}

async function onCardAction(act, id, msgId) {
  if (act === 'resend') {
    const m = chat.messages.find((x) => x.id === msgId);
    if (m?.retry) { m.retry = null; drawThread(false); runInstall(m.retryPrompt, m.retryKey); }
    return;
  }
  if (act === 'confirm-new') { await confirmProposal(id); return; }
  if (act === 'drop-new') { await dropProposal(id); return; }
  const req = chat.requests.get(id);
  if (!req) return;
  if (act === 'cancel') { await cancelRequest(req); return; }
  if (act === 'retry') { if (!chat.busy) sendChat(req.rawRequest, { echo: 'Try again' }); return; }
  if (act === 'copy') {
    const text = [`Proglintor install request`, `Request ID: ${req.id}`, `Software: ${[req.softwareName, req.version].filter(Boolean).join(' ')}`, `Status: ${req.status}`,
      `Reason: ${req.decisionReason || '-'}`, `Asset: ${chat.org?.assetId || '-'}`, `Time: ${new Date(req.updatedAt || req.createdAt).toISOString()}`].join('\n');
    const ok = await copyText(text);
    pushMsg({ id: `a-copy-${Date.now()}`, role: 'assistant', text: ok ? 'Copied. Paste it into a message to IT and they can find this request straight away.' : "I couldn't copy that. The request ID above is all IT needs.", local: true });
  }
}

/** "Yes, ask IT to review it": the suggestion is sent to the admins. */
async function confirmProposal(id) {
  if (chat.busy) return;
  chat.ctx.pendingProposal = null;
  chat.busy = true; drawThread(true); drawComposerState();
  const r = await agent.software.confirm(id);
  chat.busy = false; drawComposerState();
  if (!r.ok) { pushMsg({ id: `a-conf-err-${Date.now()}`, role: 'assistant', text: r.error, error: true, local: true }); return; }
  chat.requests.set(r.data.id, r.data);
  chat.order = [r.data.id, ...chat.order.filter((x) => x !== r.data.id)];
  pushMsg({ id: `a-conf-${Date.now()}`, role: 'assistant', text: ChatLogic.friendlyOutcome(r.data), requestId: r.data.id });
  drawRail();
  refreshRequests();
}

async function dropProposal(id) {
  chat.ctx.pendingProposal = null;
  await agent.software.cancel(id);
  pushMsg({ id: `a-drop-${Date.now()}`, role: 'assistant', text: "No problem, I haven't sent anything to IT. Tell me if you need something else.", local: true });
  refreshRequests();
}

async function cancelRequest(req) {
  chat.busy = true; drawThread(true);
  const r = await agent.software.cancel(req.id);
  chat.busy = false;
  if (r.ok) {
    chat.requests.set(r.data.id, r.data);
    Object.assign(chat.ctx, ChatLogic.nextContext(req.rawRequest, 'CANCELLED', 'CANCELLED_BY_EMPLOYEE'));
    pushMsg({ id: `a-cancel-${Date.now()}`, role: 'assistant', text: ChatLogic.friendlyOutcome(r.data), local: true });
    refreshRequests();
  } else {
    pushMsg({ id: `a-cancel-err-${Date.now()}`, role: 'assistant', text: r.error, error: true, local: true });
    refreshRequests();
  }
  drawComposerState();
}

function latestRequest() { return chat.requests.get(chat.order[0]); }

async function loadCatalogue(force = false) {
  if (!force && chat.catalogue && Date.now() - chat.catalogueAt < 60000) return chat.catalogue;
  const r = await agent.software.catalogue();
  if (r.ok) { chat.catalogue = r.data.items || []; chat.assistant = r.data.assistant || null; chat.catalogueAt = Date.now(); if (state.page === 'install') drawComposerState(); if (state.page === 'install' && chat.messages.length === 1) drawThread(false); }
  return chat.catalogue;
}

/** Handles one user message. `opts.echo` overrides the text shown as the user's bubble. */
async function sendChat(raw, opts = {}) {
  if (chat.busy) return;
  const plan = ChatLogic.planTurn(raw, chat.ctx);
  chat.ctx.pendingSuggestion = null; // a "did you mean…?" is answered (or dropped) by whatever the employee says next
  if (plan.kind !== 'confirmProposal' && plan.kind !== 'dropProposal') chat.ctx.pendingProposal = null;
  chat.messages.push({ id: `u-${Date.now()}`, role: 'user', text: opts.echo || String(raw).replace(/\s+/g, ' ').trim(), at: Date.now() });
  drawThread(true);

  if (plan.kind === 'reply') {
    if (plan.llm) { await askAssistant(raw, plan.text); return; }
    setTimeout(() => pushMsg({ id: `a-${Date.now()}`, role: 'assistant', text: plan.text, local: true }), 180);
    return;
  }
  if (plan.kind === 'confirmProposal') { await confirmProposal(plan.id); return; }
  if (plan.kind === 'dropProposal') { await dropProposal(plan.id); return; }
  if (plan.kind === 'status') {
    await refreshRequests();
    const r = latestRequest();
    pushMsg(r ? { id: `a-${Date.now()}`, role: 'assistant', text: ChatLogic.friendlyOutcome(r), requestId: r.id } : { id: `a-${Date.now()}`, role: 'assistant', text: "You haven't asked for anything yet. Tell me which app you need.", local: true });
    return;
  }
  if (plan.kind === 'cancel') {
    await refreshRequests();
    const r = latestRequest();
    if (r && InstallView.isCancellable(r.status)) { await cancelRequest(r); return; }
    const text = r && InstallView.isActive(r.status) ? 'The install has already started, so it can’t be cancelled now. It should be done shortly.' : 'There’s nothing waiting that I can cancel.';
    pushMsg({ id: `a-${Date.now()}`, role: 'assistant', text, local: true });
    return;
  }
  if (plan.kind === 'catalogue') {
    chat.busy = true; drawThread(true);
    const items = await loadCatalogue(true);
    chat.busy = false;
    const names = (items || []).map((i) => i.name);
    pushMsg({ id: `a-${Date.now()}`, role: 'assistant', local: true, candidates: names.slice(0, 24),
      text: names.length ? 'Here’s what’s approved for this computer. Tap one to request it:' : 'Your admin hasn’t added any software for this computer yet. Ask IT to add what you need.' });
    return;
  }
  runInstall(plan.prompt, newKey(), plan.resumeNote);
}

/**
 * Conversation that isn't a request (small talk, off-topic, "what are you"): the server's language model answers in the assistant's
 * voice and may suggest an approved app, which the employee must confirm. If it is unavailable the built-in reply is used.
 */
async function askAssistant(raw, fallback) {
  chat.busy = true; drawThread(true); drawComposerState();
  const history = chat.messages.slice(-8, -1).filter((m) => !m.error && m.text).map((m) => ({ role: m.role, text: m.text }));
  const r = await agent.software.assist(String(raw), history);
  chat.busy = false; drawComposerState();
  const id = `a-${Date.now()}`;
  if (r.ok && r.data.available && r.data.reply) {
    if (r.data.suggestion) chat.ctx.pendingSuggestion = r.data.suggestion;
    pushMsg({ id, role: 'assistant', text: ChatLogic.guardOutputText(r.data.reply), local: true, confirm: r.data.suggestion || null });
  } else {
    pushMsg({ id, role: 'assistant', text: fallback, local: true });
  }
}

async function runInstall(prompt, key, resumeNote) {
  const o = chat.org || {};
  if (o.removed || !o.enrolled) {
    pushMsg({ id: `a-${Date.now()}`, role: 'assistant', error: true, action: 'device', local: true, text: o.removed ? 'This laptop was removed from Proglintor, so I can’t request anything. Reconnect it with a new code first.' : 'This laptop isn’t connected to Proglint yet. Connect it first, then ask me again.' });
    return;
  }
  if (resumeNote) pushMsg({ id: `a-resume-${Date.now()}`, role: 'assistant', text: resumeNote, local: true });
  chat.busy = true; drawThread(true); drawComposerState();
  const ask = chat.mode === 'ask';
  const r = ask ? await agent.software.preview(prompt) : await agent.software.submit(prompt, key, ChatLogic.wantsReinstall(prompt));
  chat.busy = false;
  drawComposerState();
  const id = `a-${Date.now()}`;
  if (!r.ok) {
    if (r.code === 'removed' || r.code === 'not_enrolled') { chat.org = await agent.orgStatus(); drawBanner(); drawComposerState(); }
    pushMsg({ id, role: 'assistant', error: true, text: r.error, local: true,
      ...(RETRYABLE_ERRORS.has(r.code) && !ask ? { retry: true, retryPrompt: prompt, retryKey: key } : {}), ...(r.code === 'not_enrolled' || r.code === 'removed' ? { action: 'device' } : {}) });
    return;
  }
  const d = r.data;
  if (ask) {
    Object.assign(chat.ctx, ChatLogic.nextContext(prompt, d.status, d.reasonCode));
    pushMsg({ id, role: 'assistant', text: ChatLogic.guardOutputText(d.explanation), preview: d, candidates: d.candidates, local: true });
    return;
  }
  if (!d.id) {
    if (d.status === 'NEEDS_CONFIRMATION' && d.candidates?.[0]) {
      // "I couldn't find 'slakc'. Did you mean Slack?": nothing is requested until the employee says yes.
      chat.ctx.pendingSuggestion = d.candidates[0];
      pushMsg({ id, role: 'assistant', text: ChatLogic.guardOutputText(d.explanation), local: true, confirm: d.candidates[0] });
      return;
    }
    if (d.status === 'CHAT') { pushMsg({ id, role: 'assistant', text: ChatLogic.guardOutputText(d.explanation), local: true }); return; }
    if (d.status === 'ALREADY_INSTALLED' && d.decisionReason === 'ALREADY_INSTALLED' && d.candidates?.[0]) {
      Object.assign(chat.ctx, ChatLogic.nextContext(prompt, d.status, d.decisionReason));
      pushMsg({ id, role: 'assistant', text: ChatLogic.guardOutputText(d.explanation), local: true, reinstall: d.candidates[0] });
      return;
    }
    // Answered but nothing to track: a question back, "already installed", "not available for this computer".
    if (d.status !== 'NEEDS_CLARIFICATION') Object.assign(chat.ctx, ChatLogic.nextContext(prompt, d.status, d.decisionReason));
    pushMsg({ id, role: 'assistant', text: ChatLogic.guardOutputText(d.explanation), candidates: d.candidates, local: true });
    return;
  }
  chat.requests.set(d.id, d);
  chat.order = [d.id, ...chat.order.filter((x) => x !== d.id)];
  if (d.status === 'PROPOSED') {
    // An app that isn't approved yet, found by the assistant: nothing goes to IT until the employee agrees.
    chat.ctx.pendingProposal = d.id;
    pushMsg({ id, role: 'assistant', text: ChatLogic.guardOutputText(d.explanation), local: true, propose: { id: d.id, name: d.proposal?.name || d.softwareName || 'it' } });
    drawRail();
    return;
  }
  Object.assign(chat.ctx, ChatLogic.nextContext(prompt, d.status, d.decisionReason));
  const lead = d.replayed ? 'You already asked for this, so here’s where it stands. ' : '';
  pushMsg({ id, role: 'assistant', text: ChatLogic.guardOutputText(lead + ChatLogic.friendlyOutcome(d)), requestId: d.id });
  drawRail();
}

// ---- live updates ------------------------------------------------------------------------------------

/** A cheap fingerprint, so we only redraw when something a card or the list shows has really changed. */
function requestsSignature() {
  return JSON.stringify([chat.messages.length, chat.order, [...chat.requests.values()].map((r) => [r.id, r.status, r.requestVersion, r.progressPhase, r.progressBytesDone, r.progressUpdatedAt])]);
}

async function refreshRequests() {
  const r = await agent.software.list();
  if (!r.ok) { if (!chat.listError) { chat.listError = r; if (state.page === 'install') drawRail(); } return; }
  const sigBefore = requestsSignature();
  chat.listError = null;
  const shown = new Set(chat.messages.map((m) => m.requestId).filter(Boolean));
  for (const req of r.data.items) {
    const before = chat.requests.get(req.id);
    chat.requests.set(req.id, req);
    if (before && before.status !== req.status && shown.has(req.id)) announceChange(before, req);
  }
  chat.order = r.data.items.map((x) => x.id);
  const tracked = [...chat.messages].reverse().find((m) => m.requestId && chat.requests.get(m.requestId));
  if (tracked) { const t = chat.requests.get(tracked.requestId); Object.assign(chat.ctx, ChatLogic.nextContext(t.rawRequest, t.status, t.decisionReason)); }
  updateInstallBadge();
  if (state.page === 'install' && requestsSignature() !== sigBefore) { drawThread(true); drawRail(); }
}

/** The card above updates in place; also say it in words so a result doesn't go unnoticed further down the thread. */
function announceChange(before, req) {
  const approved = before.status === 'AWAITING_APPROVAL' && req.status === 'QUEUED';
  if (!approved && !CHAT_TERMINAL_NOTES.has(req.status)) return;
  if (req.status === 'CANCELLED') return; // the employee just did it themselves
  const failed = ['FAILED', 'FAILED_VERIFICATION', 'BLOCKED', 'EXPIRED'].includes(req.status);
  const text = approved ? `Good news: ${req.softwareName} was approved. I'm installing it now.`
    : failed ? `Sorry, ${req.softwareName || 'that app'} didn't install. The card above explains why.` : ChatLogic.friendlyOutcome(req);
  chat.messages.push({ id: `a-n-${req.id}-${req.status}`, role: 'assistant', text, local: true, at: Date.now() });
}

function startInstallPolling() {
  clearInterval(chat.pollTimer);
  clearInterval(chat.clockTimer);
  chat.pollTimer = setInterval(async () => {
    if (state.page !== 'install' || document.hidden) return;
    const all = [...chat.requests.values()];
    const running = all.some((r) => InstallView.isActive(r.status));
    const waiting = !running && all.some((r) => InstallView.isOpen(r.status));
    // Running install: every 3s. Only waiting for an admin: every ~12s. Nothing open: every ~30s.
    if (!running && Date.now() % (waiting ? 12000 : 30000) > 3000) return;
    chat.org = await agent.orgStatus().catch(() => chat.org);
    drawBanner();
    refreshRequests();
  }, 3000);
  chat.clockTimer = setInterval(() => {
    if (state.page !== 'install') return;
    // The elapsed time (and the "no update from this computer" note) tick every second: change just that text,
    // never the card, so the progress bar's animation keeps running smoothly.
    for (const req of chat.requests.values()) {
      if (!InstallView.isActive(req.status)) continue;
      const meta = $(`[data-card="${CSS.escape(req.id)}"] .sw-progress-meta`);
      if (!meta || meta.children.length < 2) continue;
      const now = Date.now();
      const prog = InstallView.progress(req, now);
      const detail = `${prog.detail}${prog.percent != null && !prog.indeterminate ? ` · ${prog.percent}%` : ''}`;
      const elapsed = InstallView.elapsed(req, now);
      if (meta.children[0].textContent !== detail) meta.children[0].textContent = detail;
      if (meta.children[1].textContent !== elapsed) meta.children[1].textContent = elapsed;
    }
  }, 1000);
}

// Coming back to the window (it may have been hidden while an approval arrived): catch up immediately.
document.addEventListener('visibilitychange', () => { if (!document.hidden && state.page === 'install') refreshRequests().catch(() => {}); });

// The main process tells us the moment something changes (approval, progress, result).
agent.onSoftware?.(() => { refreshRequests().catch(() => {}); });
agent.onGoto?.((page) => { if (page === 'install' || page === 'device' || page === 'orbit') go(page); });

// Keep the sidebar badge (open requests) current even when this page isn't showing.
function updateInstallBadge() {
  const badge = document.getElementById('install-badge');
  if (!badge) return;
  const open = [...chat.requests.values()].filter((r) => InstallView.isOpen(r.status)).length;
  badge.hidden = open === 0;
  badge.textContent = String(open);
}
setTimeout(() => { refreshRequests().catch(() => {}); }, 2500);

// Connection changes (the admin removed this laptop, it was reassigned, or the server became reachable again).
agent.onUpdate?.(async () => {
  const o = await agent.orgStatus().catch(() => null);
  if (!o) return;
  const changed = syncIdentity(o);
  chat.org = o;
  if (state.page !== 'install') return;
  if (changed) renderInstall().catch(() => {});
  else { drawBanner(); drawComposerState(); }
});
