'use strict';
/* global agent, UI, Charts */

const { esc, fmtDur, fmtBig, fmtClock, fmtTime, fmtDate, rel, startOfDay, addDays, icon, appIcon, hydrate } = UI;
const $ = (s, r = document) => r.querySelector(s);
const $$ = (s, r = document) => [...r.querySelectorAll(s)];

const PALETTE = ['#EF6A4C', '#6366f1', '#10b981', '#ec4899', '#06b6d4', '#8b5cf6', '#84cc16', '#f59e0b'];
const OTHER = '#94a3b8';
const RANGE_DAYS = { day: 1, week: 7, month: 30 };

document.body.classList.add(`platform-${agent.platform}`);
$$('[data-icon]').forEach((el) => { el.outerHTML = icon(el.dataset.icon, 17); });

const state = {
  page: 'overview',
  range: 'day',
  anchor: Date.now(),
  data: null,
  status: null,
  swift: null,
  apps: null,
  appsQuery: '',
  appsFilter: 'all',
  appsSort: 'recent',
  showAllApps: false,
  drawer: null,
};

const view = $('#view');

// ===================================================================================
// Overview
// ===================================================================================

function colorsFor(d) {
  const map = { other: OTHER };
  d.summaries.slice(0, PALETTE.length).forEach((s, i) => { map[s.id] = PALETTE[i]; });
  return map;
}

function isToday(ts) { return startOfDay(ts) === startOfDay(Date.now()); }

function periodLabel(d) {
  if (d.range === 'day') {
    if (isToday(d.start)) return 'Today';
    if (startOfDay(d.start) === addDays(startOfDay(Date.now()), -1)) return 'Yesterday';
    return fmtDate(d.start, { weekday: 'short', month: 'short', day: 'numeric' });
  }
  if (d.range === 'all') return `Since ${fmtDate(d.start, { month: 'short', day: 'numeric', year: 'numeric' })}`;
  const opts = { month: 'short', day: 'numeric' };
  return `${fmtDate(d.start, opts)} – ${fmtDate(addDays(d.end, -1), opts)}`;
}

function topbarOverview(d) {
  const ranges = [['day', 'Day'], ['week', 'Week'], ['month', 'Month'], ['all', 'All']];
  const canNext = d.range !== 'all' && !d.isCurrent;
  const nav = d.range === 'all' ? '' : `
    <div class="datenav">
      <button class="iconbtn" id="prev" title="Previous">${icon('left')}</button>
      <span class="label">${esc(periodLabel(d))}</span>
      <button class="iconbtn" id="next" title="Next" ${canNext ? '' : 'disabled'}>${icon('right')}</button>
      ${d.isCurrent ? '' : '<button class="btn sm ghost" id="jump-today">Today</button>'}
    </div>`;
  return `
    <header class="topbar">
      <div><h1>Overview</h1><div class="sub">${esc(d.range === 'day' ? fmtDate(d.start, { weekday: 'long', month: 'long', day: 'numeric', year: 'numeric' }) : periodLabel(d))}</div></div>
      <div class="controls">
        <div class="segmented" role="tablist">${ranges.map(([k, l]) => `<button data-range="${k}" class="${d.range === k ? 'on' : ''}">${l}</button>`).join('')}</div>
        ${nav}
      </div>
    </header>`;
}

function deltaChip(d) {
  if (d.prevTotal == null) return '';
  const prevName = { day: 'previous day', week: 'previous 7 days', month: 'previous 30 days' }[d.range];
  if (!d.prevTotal) return `<span class="delta flat">No data for ${prevName}</span>`;
  const ratio = (d.total - d.prevTotal) / d.prevTotal;
  if (Math.abs(ratio) < 0.02) return `<span class="delta flat">Same as ${prevName}</span>`;
  const up = ratio > 0;
  return `<span class="delta ${up ? 'up' : 'down'}">${icon(up ? 'up' : 'down', 12)} ${Math.round(Math.abs(ratio) * 100)}% vs ${prevName}</span>`;
}

function heroCard(d) {
  const avg = d.total / d.elapsedDays;
  const stats = [
    ['Apps used', String(d.summaries.length), d.summaries[0] ? `Most: ${d.summaries[0].name}` : '—'],
    ['App switches', String(d.switches), `${d.sessions} sessions`],
    ['Longest session', d.longest ? fmtDur(d.longest.seconds) : '—', d.longest?.name || ''],
    d.singleDay
      ? ['Peak hour', peakHour(d), '']
      : ['Daily average', fmtDur(avg), `over ${d.elapsedDays} day${d.elapsedDays > 1 ? 's' : ''}`],
  ];
  return `
    <section class="card hero">
      <div class="eyebrow">${icon('clock', 13)} Screen time · ${esc(periodLabel(d))}</div>
      <div class="big">${fmtBig(d.total)}</div>
      ${deltaChip(d)}
      <div class="hero-stats">${stats.map(([l, v, h]) => `<div class="stat"><div class="label">${l}</div><div class="value" title="${esc(v)}">${esc(v)}</div><div class="hint" title="${esc(h)}">${esc(h) || '&nbsp;'}</div></div>`).join('')}</div>
    </section>`;
}

function peakHour(d) {
  const best = (d.hourly || []).reduce((b, h) => (h.total > (b?.total || 0) ? h : b), null);
  if (!best) return '—';
  return `${String(best.hour).padStart(2, '0')}:00 · ${fmtDur(best.total)}`;
}

function stateInfo(st) {
  return {
    tracking: ['tracking', 'Tracking'],
    idle: ['idle', 'Idle — not counting'],
    locked: ['locked', 'Screen locked'],
    paused: ['paused', st?.paused ? 'Paused' : 'Paused (sleep)'],
    unavailable: ['unavailable', 'Detection unavailable'],
    starting: ['', 'Starting…'],
  }[st?.state] || ['', '…'];
}

function nowCard() {
  const st = state.status;
  const [cls, text] = stateInfo(st);
  const cur = st?.current;
  const body = cur
    ? `<div class="now-app">${appIcon(cur.id, cur.path, 48, cur.name)}<div style="min-width:0"><div class="now-name">${esc(cur.name)}</div><div class="now-timer" data-timer>${fmtClock(st.sessionStart ? (Date.now() - st.sessionStart) / 1000 : 0)}</div></div></div>`
    : `<div class="now-empty"><span class="bigicon">${icon('clock', 20)}</span><div>${esc(st?.state === 'unavailable' ? st.detector : st?.state === 'idle' ? 'No keyboard or mouse input — time is not being counted.' : 'Waiting for activity…')}</div></div>`;
  return `
    <section class="card now">
      <div class="eyebrow"><span class="dot ${cls}"></span> Now</div>
      ${body}
      <div class="foot">
        <span class="state-pill ${cls}">${esc(text)}</span>
      </div>
    </section>`;
}

function appRows(d, colors, limit) {
  const max = d.summaries[0]?.seconds || 1;
  const rows = d.summaries.slice(0, limit).map((s) => `
    <button class="approw" data-app="${esc(s.id)}">
      ${appIcon(s.id, s.path, 32, s.name)}
      <span style="min-width:0"><span class="nm">${esc(s.name)}</span><span class="sub">${s.sessions} session${s.sessions === 1 ? '' : 's'} · last ${esc(d.singleDay ? fmtTime(s.lastActive) : rel(s.lastActive))}</span></span>
      <span class="bar"><i style="width:${(s.seconds / max) * 100}%;background:${colors[s.id] || OTHER}"></i></span>
      <span class="tm">${fmtDur(s.seconds)}<small>${d.total ? Math.round((s.seconds / d.total) * 100) : 0}%</small></span>
    </button>`).join('');
  return rows;
}

function swiftBanner() {
  const sw = state.swift;
  if (!sw?.available || sw.importedAt || state.swiftDismissed) return '';
  return `
    <div class="banner">
      <span class="bi">${icon('import', 18)}</span>
      <div class="bt"><b>Bring over your history from the Swift edition</b><span class="muted">${sw.days} day${sw.days === 1 ? '' : 's'} · ${fmtDur(sw.seconds)} recorded. Time already tracked here is never counted twice.</span></div>
      <button class="btn ghost sm" id="swift-later">Later</button>
      <button class="btn primary sm" id="swift-import">${icon('import', 13)} Import</button>
    </div>`;
}

function orgBanner() {
  const org = state.status?.org;
  if (!org || org.enrolled) return '';
  const removed = org.removed;
  return `
    <div class="banner ${removed ? 'warn' : ''}">
      <span class="bi">${icon(removed ? 'alert' : 'building', 18)}</span>
      <div class="bt"><b>${removed ? 'This laptop was removed from Proglintor' : 'Connect this laptop to Proglint'}</b><span class="muted">${removed ? `Asset ${esc(removed.assetId)} was removed by your admin, so nothing is being sent to Proglint. Reconnect with a new enrollment code.` : 'Enter the enrollment code from your Proglint admin.'}</span></div>
      <button class="btn primary sm" id="go-connect">${removed ? 'Reconnect' : 'Connect'}</button>
    </div>`;
}

function detectorBanner() {
  const st = state.status;
  if (!st || st.state !== 'unavailable') return '';
  return `<div class="banner warn"><span class="bi">${icon('spark', 18)}</span><div class="bt"><b>Active-window detection isn't working</b><span>${esc(st.detector)}</span></div></div>`;
}

async function loadOverview() {
  const d = await agent.rangeView(state.range, state.anchor);
  if (state.page !== 'overview') return;
  state.data = d;
  renderOverview();
}

function renderOverview() {
  const d = state.data;
  if (!d) return;
  const colors = colorsFor(d);
  const names = Object.fromEntries(d.summaries.map((s) => [s.id, s.name]));
  names.other = 'Other apps';
  const keys = [...d.top, 'other'];
  const limit = state.showAllApps ? d.summaries.length : 8;
  const scroll = $('.main').scrollTop;

  const empty = !d.summaries.length;
  view.innerHTML = `
    ${topbarOverview(d)}
    <div class="content">
      ${orgBanner()}
      ${detectorBanner()}
      ${swiftBanner()}
      <div class="grid-hero">${heroCard(d)}${nowCard()}</div>
      ${empty ? `
        <section class="card"><div class="empty"><div class="ei">${icon('overview', 26)}</div><b>No activity ${d.isCurrent && d.range === 'day' ? 'yet today' : 'in this period'}</b>
          ${d.isCurrent ? 'Keep Proglintor running — time in each app is recorded automatically.' : 'Use the arrows to browse other dates.'}</div></section>` : `
      <section class="card">
        <div class="card-head"><h3>${d.singleDay ? 'Activity by hour' : 'Daily activity'}</h3>
          <div class="legend">${keys.filter((k) => k !== 'other' || d.summaries.length > d.top.length).map((k) => `<span><i class="swatch" style="background:${colors[k] || OTHER}"></i>${esc(names[k])}</span>`).join('')}</div></div>
        <div class="chart" id="main-chart"></div>
        ${d.singleDay ? '' : '<div class="small muted" style="margin-top:6px">Click a day to open it.</div>'}
      </section>
      <div class="grid-2">
        <section class="card">
          <div class="card-head"><h3>Apps</h3><span class="muted small">${d.summaries.length} used · click for details</span></div>
          <div class="applist">${appRows(d, colors, limit)}</div>
          ${d.summaries.length > 8 ? `<button class="btn ghost sm more" id="toggle-all">${state.showAllApps ? 'Show fewer' : `Show all ${d.summaries.length} apps`}</button>` : ''}
        </section>
        <div class="stack">
          <section class="card"><div class="card-head"><h3>Share of time</h3></div><div id="donut"></div></section>
          ${d.singleDay
            ? '<section class="card"><div class="card-head"><h3>Timeline</h3><span class="muted small">Hover a block for times</span></div><div id="timeline"></div></section>'
            : insightsCard(d)}
        </div>
      </div>`}
    </div>`;
  $('.main').scrollTop = scroll;

  if (!empty) {
    drawMainChart(d, keys, colors, names);
    const items = d.summaries.slice(0, 6).map((s) => ({ id: s.id, name: s.name, seconds: s.seconds, color: colors[s.id] }));
    const rest = d.total - items.reduce((t, i) => t + i.seconds, 0);
    if (rest > 1) items.push({ id: 'other', name: 'Other apps', seconds: rest, color: OTHER });
    Charts.donut($('#donut'), items, d.total);
    if (d.singleDay) {
      Charts.timeline($('#timeline'), d.timeline.map((r) => ({ ...r, color: colors[r.id] || OTHER, path: d.summaries.find((s) => s.id === r.id)?.path })),
        d.start, d.end, (r) => appIcon(r.id, r.path, 20, r.name));
    }
  }
  bindOverview(d);
  hydrate(view);
}

function insightsCard(d) {
  const busiest = d.busiest && d.busiest.total > 0 ? d.busiest : null;
  const activeDays = d.daily.filter((x) => x.total > 0).length;
  return `
    <section class="card"><div class="card-head"><h3>Insights</h3></div>
      <div class="insights">
        <div class="insight"><div class="label">${icon('clock', 12)} Daily average</div><div class="value">${fmtDur(d.total / d.elapsedDays)}</div><div class="hint">per day</div></div>
        <div class="insight ${busiest ? 'link' : ''}" ${busiest ? `data-day="${busiest.date}"` : ''}><div class="label">${icon('spark', 12)} Busiest day</div><div class="value">${busiest ? esc(fmtDate(busiest.date, { weekday: 'short', month: 'short', day: 'numeric' })) : '—'}</div><div class="hint">${busiest ? fmtDur(busiest.total) : ''}</div></div>
        <div class="insight"><div class="label">${icon('calendar', 12)} Active days</div><div class="value">${activeDays} of ${d.elapsedDays}</div><div class="hint">with recorded use</div></div>
        <div class="insight"><div class="label">${icon('apps', 12)} Top app</div><div class="value">${esc(d.summaries[0]?.name || '—')}</div><div class="hint">${d.summaries[0] ? fmtDur(d.summaries[0].seconds) : ''}</div></div>
      </div>
    </section>`;
}

function drawMainChart(d, keys, colors, names) {
  const el = $('#main-chart');
  if (!el) return;
  if (d.singleDay) {
    const nowHour = isToday(d.start) ? new Date().getHours() : null;
    Charts.bars(el, d.hourly, {
      keys, colors, names,
      label: (b) => (b.hour % 3 === 0 ? `${String(b.hour).padStart(2, '0')}:00` : ''),
      title: (b) => `${String(b.hour).padStart(2, '0')}:00 – ${String((b.hour + 1) % 24).padStart(2, '0')}:00${b.hour === nowHour ? ' (now)' : ''}`,
    });
  } else {
    const n = d.daily.length;
    const every = n <= 7 ? 1 : n <= 31 ? 5 : Math.ceil(n / 8);
    Charts.bars(el, d.daily, {
      keys, colors, names,
      label: (b, i) => (n <= 7 ? fmtDate(b.date, { weekday: 'short' }) : (i % every === 0 ? fmtDate(b.date, { month: 'short', day: 'numeric' }) : '')),
      title: (b) => fmtDate(b.date, { weekday: 'long', month: 'short', day: 'numeric' }),
      onClick: (b) => openDay(b.date),
    });
  }
}

function openDay(ts) {
  state.range = 'day';
  state.anchor = ts;
  loadOverview();
}

function shift(dir) {
  const n = RANGE_DAYS[state.range] || 1;
  const next = addDays(startOfDay(state.anchor), dir * n);
  state.anchor = Math.min(next, Date.now());
  loadOverview();
}

function bindOverview(d) {
  $$('[data-range]').forEach((b) => b.addEventListener('click', () => {
    state.range = b.dataset.range;
    if (state.range === 'all') state.anchor = Date.now();
    loadOverview();
  }));
  $('#prev')?.addEventListener('click', () => shift(-1));
  $('#next')?.addEventListener('click', () => shift(1));
  $('#jump-today')?.addEventListener('click', () => { state.anchor = Date.now(); loadOverview(); });
  $('#toggle-all')?.addEventListener('click', () => { state.showAllApps = !state.showAllApps; renderOverview(); });
  $$('.approw[data-app]').forEach((r) => r.addEventListener('click', () => openDrawer(r.dataset.app, d.singleDay ? d.start : null)));
  $$('.insight[data-day]').forEach((r) => r.addEventListener('click', () => openDay(Number(r.dataset.day))));
  bindPause();
  bindSwiftBanner();
  $('#go-connect')?.addEventListener('click', () => go('device'));
}

function bindPause() { /* tracking is always on */ }

function bindSwiftBanner() {
  $('#swift-later')?.addEventListener('click', () => { state.swiftDismissed = true; renderOverview(); });
  $('#swift-import')?.addEventListener('click', async (e) => {
    e.currentTarget.disabled = true;
    e.currentTarget.textContent = 'Importing…';
    await runSwiftImport();
    loadOverview();
  });
}

async function runSwiftImport() {
  const r = await agent.swiftImport();
  state.swift = await agent.swiftCheck();
  state.apps = null;
  return r;
}

// ===================================================================================
// Applications
// ===================================================================================

const FILTERS = [
  ['all', 'All', () => true],
  ['week', 'Used this week', (a) => a.lastUsed && Date.now() - a.lastUsed < 7 * 86400e3],
  ['tracked', 'Tracked', (a) => a.trackedSeconds > 0],
  ['never', 'Never opened', (a) => !a.lastUsed && !a.trackedSeconds],
  ['system', 'System', (a) => a.isSystem],
];
const SORTS = {
  recent: ['Recently opened', (a, b) => (b.lastUsed || 0) - (a.lastUsed || 0)],
  tracked: ['Most used (tracked)', (a, b) => b.trackedSeconds - a.trackedSeconds],
  opens: ['Times opened', (a, b) => (b.useCount ?? -1) - (a.useCount ?? -1)],
  name: ['Name', (a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: 'base' })],
  installed: ['Recently installed', (a, b) => (b.installedAt || 0) - (a.installedAt || 0)],
};

async function loadApps(refresh = false) {
  if (!state.apps || refresh) {
    view.innerHTML = `${appsTopbar(null)}<div class="content"><section class="card"><div class="empty"><div class="ei">${icon('refresh', 24)}</div><b>Scanning installed applications…</b>This takes a few seconds the first time.</div></section></div>`;
    state.apps = await agent.installed(refresh);
    if (state.page !== 'apps') return;
  }
  renderApps();
}

function appsTopbar(data) {
  return `
    <header class="topbar">
      <div><h1>Applications</h1><div class="sub">${data ? `${data.apps.length} installed · ${esc(data.platform)} · history from ${esc(data.historySource)}` : 'Scanning…'}</div></div>
      <div class="controls">
        <label class="search">${icon('search', 14)}<input id="q" type="search" placeholder="Search apps, publishers, IDs" value="${esc(state.appsQuery)}"></label>
        <button class="btn" id="rescan" ${data ? '' : 'disabled'}>${icon('refresh', 14)} Rescan</button>
      </div>
    </header>`;
}

function renderApps() {
  const data = state.apps;
  const scroll = $('.main').scrollTop;
  view.innerHTML = `
    ${appsTopbar(data)}
    <div class="content">
      ${data.error ? `<div class="banner warn"><span class="bi">${icon('spark', 18)}</span><div class="bt"><b>Scan problem</b><span>${esc(data.error)}</span></div></div>` : ''}
      <div class="apps-toolbar">
        <div class="chips">${FILTERS.map(([k, l, f]) => `<button class="chip ${state.appsFilter === k ? 'on' : ''}" data-filter="${k}">${l}<span class="count">${data.apps.filter(f).length}</span></button>`).join('')}</div>
        <select id="sort" aria-label="Sort">${Object.entries(SORTS).map(([k, [l]]) => `<option value="${k}" ${state.appsSort === k ? 'selected' : ''}>Sort: ${l}</option>`).join('')}</select>
      </div>
      <div class="table" id="apps-table"></div>
    </div>`;
  drawAppsTable();
  $('.main').scrollTop = scroll;

  $('#q').addEventListener('input', (e) => { state.appsQuery = e.target.value; drawAppsTable(); });
  $('#rescan').addEventListener('click', () => loadApps(true));
  $('#sort').addEventListener('change', (e) => { state.appsSort = e.target.value; drawAppsTable(); });
  $$('[data-filter]').forEach((c) => c.addEventListener('click', () => { state.appsFilter = c.dataset.filter; renderApps(); }));
}

function drawAppsTable() {
  const data = state.apps;
  const q = state.appsQuery.trim().toLowerCase();
  const filter = FILTERS.find(([k]) => k === state.appsFilter)[2];
  const rows = data.apps
    .filter(filter)
    .filter((a) => !q || a.name.toLowerCase().includes(q) || (a.publisher || '').toLowerCase().includes(q) || a.id.toLowerCase().includes(q))
    .sort(SORTS[state.appsSort][1]);
  const el = $('#apps-table');
  if (!rows.length) {
    el.innerHTML = `<div class="empty"><div class="ei">${icon('search', 24)}</div><b>No matching apps</b>Try a different search or filter.</div>`;
    return;
  }
  el.innerHTML = `
    <div class="trow head"><span>Application</span><span>Version</span><span>Tracked</span><span>Last opened</span><span>Opened</span><span></span></div>
    ${rows.map((a) => `
      <div class="trow item" data-track="${esc(a.trackId)}" data-name="${esc(a.name)}" tabindex="0">
        <span class="app">${appIcon(a.id, a.path, 32, a.name)}<span style="min-width:0"><span class="nm">${esc(a.name)} ${a.isSystem ? '<span class="pill sys">System</span>' : ''}</span><span class="sub">${esc(a.publisher || a.bundleId || a.id.replace(/^(win|desktop):/, ''))}</span></span></span>
        <span class="muted">${esc(a.version) || '—'}</span>
        <span class="cell-2 num">${a.trackedSeconds ? fmtDur(a.trackedSeconds) : '<span class="muted">—</span>'}${a.weekSeconds ? `<small>${fmtDur(a.weekSeconds)} this week</small>` : ''}</span>
        <span class="cell-2" title="${a.lastUsed ? esc(new Date(a.lastUsed).toLocaleString()) : ''}">${a.lastUsed ? esc(rel(a.lastUsed)) : '<span class="muted">Never</span>'}</span>
        <span class="num">${a.useCount != null ? `${a.useCount}×` : '<span class="muted">—</span>'}</span>
        <span class="chev">${icon('right', 14)}</span>
      </div>`).join('')}`;
  $$('.trow.item', el).forEach((r) => {
    const open = () => openDrawer(r.dataset.track, null);
    r.addEventListener('click', open);
    r.addEventListener('keydown', (e) => { if (e.key === 'Enter') open(); });
  });
  hydrate(el);
}

// ===================================================================================
// Settings
// ===================================================================================

async function loadSettings() {
  const [s, st, sw] = await Promise.all([agent.getSettings(), agent.status(), agent.swiftCheck()]);
  if (state.page !== 'settings') return;
  state.swift = sw;
  const idle = [[60, '1 min'], [120, '2 min'], [300, '5 min'], [600, '10 min'], [900, '15 min'], [1800, '30 min'], [31536000, 'Never']];
  view.innerHTML = `
    <header class="topbar"><div><h1>Settings</h1><div class="sub">Tracking, data and agent status</div></div></header>
    <div class="content settings">

      <section class="card">
        <div class="card-head"><h3>Tracking</h3></div>
        <div class="srow"><div><div class="st">Stop counting after inactivity</div><div class="sd">Time with no keyboard or mouse input is not counted. Locked screen and sleep are never counted.</div></div>
          <select id="set-idle">${idle.map(([v, l]) => `<option value="${v}" ${v === s.idleThreshold ? 'selected' : ''}>${l}</option>`).join('')}</select></div>
        ${st.managedStartup
          ? `<div class="srow"><div><div class="st">Starts automatically</div><div class="sd">Proglintor starts when this computer is turned on and keeps running in the background, even when this window is closed. Managed by Proglint IT.</div></div><span class="status-line ok">${icon('check', 14)} On</span></div>`
          : `<div class="srow"><div><div class="st">Start at login</div><div class="sd">Runs quietly in the ${agent.platform === 'darwin' ? 'menu bar' : 'system tray'} after you sign in. Always on in installed builds.</div></div>
          <label class="switch"><input type="checkbox" id="set-login" ${s.openAtLogin ? 'checked' : ''}><span></span></label></div>`}
      </section>

      ${sw.available ? `
      <section class="card">
        <div class="card-head"><h3>Import from the Swift edition</h3></div>
        <div class="srow"><div><div class="st">Machine Monitor (Swift) history</div>
          <div class="sd">${sw.days} day${sw.days === 1 ? '' : 's'} · ${fmtDur(sw.seconds)} recorded${sw.since ? ` since ${esc(fmtDate(sw.since))}` : ''}. ${sw.importedAt ? `Last imported ${esc(rel(sw.importedAt))}. Importing again only adds new time.` : 'Time already tracked here is never counted twice.'}</div></div>
          <button class="btn ${sw.importedAt ? '' : 'primary'}" id="set-import">${icon('import', 14)} ${sw.importedAt ? 'Import new data' : 'Import'}</button></div>
      </section>` : ''}

      <section class="card">
        <div class="card-head"><h3>Agent</h3></div>
        <div class="srow"><div class="st">Platform</div><div>${esc(st.platform)}</div></div>
        <div class="srow"><div><div class="st">Active-window detection</div><div class="sd">${esc(st.detector)}</div></div><div class="${st.detectorOk ? 'ok' : 'warn-text'}">${st.detectorOk ? 'Working' : 'Not available'}</div></div>
        <div class="srow"><div class="st">Tracking since</div><div>${esc(new Date(st.trackingStarted).toLocaleString())}</div></div>
        <div class="srow"><div class="st">Days recorded</div><div>${st.days}</div></div>
      </section>

      <section class="card">
        <div class="card-head"><h3>Data</h3><span class="toast" id="set-msg"></span></div>
        <div class="srow"><div><div class="st">Data file</div><div class="sd"><code>${esc(st.dataFile)}</code></div></div><button class="btn" id="set-folder">${icon('folder', 14)} Show</button></div>
        <div class="srow"><div><div class="st">Export</div><div class="sd">All recorded usage as CSV (one row per app per day).</div></div><button class="btn" id="set-export">${icon('download', 14)} Export CSV</button></div>
        <div class="srow"><div><div class="st">Delete all data</div><div class="sd">Permanently removes recorded usage from this computer.</div></div><button class="btn danger" id="set-clear">${icon('trash', 14)} Clear data</button></div>
      </section>
    </div>`;

  const msg = (t) => { $('#set-msg').textContent = t; };
  $('#set-idle').addEventListener('change', (e) => agent.setSettings({ idleThreshold: Number(e.target.value) }).then(() => msg('Saved')));
  $('#set-login')?.addEventListener('change', async (e) => {
    const r = await agent.setSettings({ openAtLogin: e.target.checked });
    e.target.checked = r.openAtLogin;
    msg(r.openAtLogin ? 'Will start at login' : 'Won’t start at login');
  });
  $('#set-folder').addEventListener('click', () => agent.openDataFolder());
  $('#set-export').addEventListener('click', async () => { const p = await agent.exportCSV(); if (p) msg('Exported'); });
  $('#set-clear').addEventListener('click', async () => { if (await agent.clearData()) { state.apps = null; msg('All data deleted'); loadSettings(); } });
  $('#set-import')?.addEventListener('click', async (e) => {
    e.currentTarget.disabled = true;
    const r = await runSwiftImport();
    await loadSettings();
    msg(r ? `Imported ${fmtDur(r.seconds)}` : 'Nothing to import');
  });
}

/** "Mar 4, 2026, 10:12 AM" */
const fmtWhen = (ts) => (ts ? new Date(ts).toLocaleString([], { dateStyle: 'medium', timeStyle: 'short' }) : '—');
const initialsOf = (name) => String(name || '?').split(/\s+/).filter(Boolean).slice(0, 2).map((w) => w[0].toUpperCase()).join('');
const hueOf = (str) => { let h = 0; for (const c of String(str)) h = (h * 31 + c.charCodeAt(0)) % 360; return h; };

function codeForm(buttonLabel) {
  return `
    <label class="field"><span>Enrollment code</span>
      <input class="input mono" id="org-code" placeholder="ABCD-2345" maxlength="12" autocomplete="off" spellcheck="false" style="text-transform:uppercase;letter-spacing:.06em"></label>
    <div class="form-error" id="org-err" style="margin-top:10px"></div>
    <div style="display:flex;justify-content:flex-end"><button class="btn primary" id="org-connect">${icon('building', 14)} ${buttonLabel}</button></div>`;
}

function person(name, email, dept, location, extra = '') {
  return `
    <div class="dev-hero">
      <span class="dev-avatar" style="--h:${hueOf(name)}">${esc(initialsOf(name))}</span>
      <div style="min-width:0;flex:1">
        <div class="dev-name">${esc(name)}</div>
        <div class="muted">${icon('mail', 13)} ${esc(email)}</div>
        <div class="dev-chips">${dept ? `<span class="pill">${icon('building', 11)} ${esc(dept)}</span>` : ''}${location ? `<span class="pill">${esc(location)}</span>` : ''}</div>
      </div>
      ${extra}
    </div>`;
}

function item(label, value, mono = false) {
  return `<div class="dev-item"><div class="label">${label}</div><div class="value ${mono ? 'mono' : ''}">${value || '<span class="muted">—</span>'}</div></div>`;
}

function connectedBody(org) {
  const dev = org.device || {};
  return `
    <section class="card">
      <div class="card-head"><h3>Assigned to</h3>
        <span class="status-line ${org.online ? 'ok' : 'bad'}">${icon(org.online ? 'check' : 'wifi', 14)} ${org.online ? 'Connected to Proglint' : 'Offline — data is saved and will be sent later'}</span></div>
      ${person(org.employeeName, org.employeeEmail, org.department, org.location, `<button class="btn sm" id="org-sync">${icon('refresh', 13)} Sync now</button>`)}
    </section>
    <section class="card">
      <div class="card-head"><h3>Asset details</h3></div>
      <div class="dev-grid">
        ${item('Asset ID', org.assetId ? `<span class="idpill">${esc(org.assetId)}</span>` : '')}
        ${item('Device type', esc(org.deviceType))}
        ${item('Computer name', esc(dev.hostname))}
        ${item('Operating system', esc(dev.os))}
        ${item('Agent version', esc(dev.agentVersion))}
        ${item('Connected since', esc(fmtWhen(org.connectedAt)))}
        ${item('Last sync', org.lastSync ? esc(rel(org.lastSync)) : '')}
        ${item('Waiting to send', org.pendingAlerts ? `${org.pendingAlerts} weekend answer${org.pendingAlerts === 1 ? '' : 's'}` : 'Nothing')}
      </div>
      ${org.lastError ? `<div class="banner warn" style="margin-top:14px"><span class="bi">${icon('wifi', 16)}</span><div class="bt">${esc(org.lastError)}</div></div>` : ''}
    </section>`;
}

function removedBody(org) {
  const r = org.removed;
  return `
    <section class="card removed">
      <div class="removed-head">
        <span class="removed-icon">${icon('alert', 26)}</span>
        <div>
          <h2>This laptop was removed from Proglintor</h2>
          <p class="muted">Your admin removed this laptop on <b>${esc(fmtWhen(r.at))}</b>. Nothing is being sent to Proglint, and any answers that were waiting to be sent were discarded. Your own usage history stays on this laptop.</p>
        </div>
      </div>
      <div class="removed-was"><div class="eyebrow">It was assigned to</div>${person(r.employeeName || 'Unknown', r.employeeEmail || '', r.department, r.location)}
        <div class="dev-grid" style="margin-top:12px">${item('Asset ID', r.assetId ? `<span class="idpill">${esc(r.assetId)}</span>` : '')}${item('Removed', esc(fmtWhen(r.at)))}</div></div>
    </section>
    <section class="card">
      <div class="card-head"><h3>Reconnect this laptop</h3></div>
      <p class="muted" style="margin:0 0 14px">To use this laptop with Proglintor again, ask your admin for a new enrollment code.</p>
      ${codeForm('Reconnect')}
    </section>`;
}

function connectBody() {
  return `
    <section class="card">
      <div class="empty" style="padding:30px 10px 10px"><div class="ei">${icon('monitor', 26)}</div><b>Connect this laptop to Proglintor</b>
        Enter the one-time enrollment code your Proglint admin gave you.</div>
      <div style="max-width:420px;margin:0 auto 18px">${codeForm('Connect')}</div>
    </section>`;
}

async function loadDevice() {
  const org = await agent.orgStatus();
  if (state.page !== 'device') return;
  if (document.activeElement?.id === 'org-code') return; // don't wipe what is being typed
  const sub = org.enrolled ? 'Who this laptop is assigned to, and its details' : org.removed ? 'Removed by your admin' : 'Not connected yet';
  view.innerHTML = `
    <header class="topbar"><div><h1>My Device</h1><div class="sub">${sub}</div></div></header>
    <div class="content device">${org.enrolled ? connectedBody(org) : org.removed ? removedBody(org) : connectBody()}</div>`;
  bindOrgCard();
}

function bindOrgCard() {
  $('#org-sync')?.addEventListener('click', async (e) => {
    e.currentTarget.disabled = true;
    await agent.syncNow();
    loadDevice();
  });
  $('#org-code')?.addEventListener('keydown', (e) => { if (e.key === 'Enter') $('#org-connect').click(); });
  $('#org-code')?.addEventListener('input', () => { $('#org-err').textContent = ''; });
  $('#org-connect')?.addEventListener('click', async (e) => {
    const btn = e.currentTarget;
    const label = btn.innerHTML;
    btn.disabled = true;
    btn.textContent = 'Connecting…';
    const r = await agent.enroll($('#org-code').value);
    if (!r.ok) {
      $('#org-err').textContent = r.error;
      btn.disabled = false;
      btn.innerHTML = label;
      return;
    }
    await refreshStatus();
    loadDevice();
  });
}

// ===================================================================================
// App detail drawer
// ===================================================================================

async function openDrawer(id, day) {
  state.drawer = { id, day: day || Date.now() };
  await renderDrawer();
  $('#drawer').classList.add('open');
  $('#drawer').setAttribute('aria-hidden', 'false');
  $('#scrim').classList.add('open');
}

function closeDrawer() {
  state.drawer = null;
  $('#drawer').classList.remove('open');
  $('#drawer').setAttribute('aria-hidden', 'true');
  $('#scrim').classList.remove('open');
  Charts.hideTip();
}

async function renderDrawer() {
  const { id, day } = state.drawer;
  const d = await agent.appDetail(id, day);
  if (!state.drawer || state.drawer.id !== id) return;
  const inst = d.installed;
  const name = inst?.name || d.name;
  const appPath = inst?.path || d.path;
  const sessions = [...d.sessions].reverse();
  const dayTotal = d.sessions.reduce((t, [s, e]) => t + (e - s) / 1000, 0);
  const isTodaySel = isToday(d.day);
  const about = [
    ['Version', inst?.version],
    ['Publisher', inst?.publisher],
    ['Last opened', inst?.lastUsed && new Date(inst.lastUsed).toLocaleString()],
    ['Times opened', inst?.useCount != null && `${inst.useCount}`],
    ['Installed', inst?.installedAt && fmtDate(inst.installedAt)],
    ['Switches to app', String(d.activations)],
    ['Location', appPath],
  ].filter(([, v]) => v);

  $('#drawer').innerHTML = `
    <div class="dhead">
      ${appIcon(id, d.path || appPath, 56, name)}
      <div style="min-width:0"><div class="nm">${esc(name)}</div><div class="id">${esc(id)}</div></div>
      <button class="iconbtn" id="d-close" title="Close (Esc)">${icon('close', 18)}</button>
    </div>
    ${appPath ? `<div class="dactions"><button class="btn sm" id="d-open">${icon('open', 13)} Open app</button><button class="btn sm" id="d-reveal">${icon('folder', 13)} Show in ${agent.platform === 'darwin' ? 'Finder' : agent.platform === 'win32' ? 'Explorer' : 'Files'}</button></div>` : ''}
    <div class="tiles">
      <div class="tile"><div class="label">Today</div><div class="value">${fmtDur(d.today)}</div></div>
      <div class="tile"><div class="label">Last 7 days</div><div class="value">${fmtDur(d.week)}</div></div>
      <div class="tile"><div class="label">All time</div><div class="value">${fmtDur(d.allTime)}</div></div>
      <div class="tile"><div class="label">Longest session</div><div class="value">${d.longest ? fmtDur(d.longest) : '—'}</div></div>
    </div>
    <section class="card"><div class="card-head"><h3>Last 30 days</h3><span class="muted small">Click a day for its sessions</span></div><div class="chart" id="d-chart"></div></section>
    <section class="card">
      <div class="card-head"><h3>Sessions</h3>
        <div class="datenav">
          <button class="iconbtn" id="d-prev">${icon('left')}</button>
          <span class="label" style="min-width:110px">${isTodaySel ? 'Today' : esc(fmtDate(d.day, { weekday: 'short', month: 'short', day: 'numeric' }))}</span>
          <button class="iconbtn" id="d-next" ${isTodaySel ? 'disabled' : ''}>${icon('right')}</button>
        </div>
      </div>
      ${sessions.length ? `<div class="small muted" style="margin-bottom:6px">${sessions.length} session${sessions.length === 1 ? '' : 's'} · ${fmtDur(dayTotal)}</div>
        <div class="sessions">${sessions.map(([s, e]) => `<div class="sess"><span>${fmtTime(s)} – ${fmtTime(e)}</span><span class="bar"><i style="width:${Math.min(100, ((e - s) / 1000 / Math.max(...sessions.map(([a, b]) => (b - a) / 1000))) * 100)}%;background:var(--accent)"></i></span><span class="v">${fmtDur((e - s) / 1000)}</span></div>`).join('')}</div>`
        : '<div class="muted small">No sessions on this day.</div>'}
    </section>
    ${about.length ? `<section class="card"><div class="card-head"><h3>About</h3></div><dl class="kv">${about.map(([k, v]) => `<dt>${k}</dt><dd>${esc(v)}</dd>`).join('')}</dl></section>` : ''}`;

  const selIndex = d.daily30.findIndex((x) => startOfDay(x.date) === startOfDay(d.day));
  Charts.bars($('#d-chart'), d.daily30.map((x) => ({ ...x, total: x.seconds, parts: { v: x.seconds } })), {
    keys: ['v'], colors: { v: 'var(--accent)' }, names: { v: name }, height: 170, highlight: selIndex >= 0 ? selIndex : null,
    label: (b, i) => (i % 7 === 0 ? fmtDate(b.date, { month: 'short', day: 'numeric' }) : ''),
    title: (b) => fmtDate(b.date, { weekday: 'long', month: 'short', day: 'numeric' }),
    onClick: (b) => { state.drawer.day = b.date; renderDrawer(); },
  });

  $('#d-close').addEventListener('click', closeDrawer);
  $('#d-open')?.addEventListener('click', () => agent.openApp(appPath));
  $('#d-reveal')?.addEventListener('click', () => agent.revealApp(appPath));
  $('#d-prev').addEventListener('click', () => { state.drawer.day = addDays(startOfDay(d.day), -1); renderDrawer(); });
  $('#d-next').addEventListener('click', () => { state.drawer.day = Math.min(addDays(startOfDay(d.day), 1), Date.now()); renderDrawer(); });
  hydrate($('#drawer'));
}

$('#scrim').addEventListener('click', closeDrawer);
document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && state.drawer) closeDrawer(); });

// ===================================================================================
// Navigation, status & live updates
// ===================================================================================

function go(page) {
  state.page = page;
  $$('#nav button').forEach((b) => b.classList.toggle('active', b.dataset.page === page));
  $('.main').scrollTop = 0;
  Charts.hideTip();
  if (page === 'overview') loadOverview();
  else if (page === 'apps') loadApps();
  else if (page === 'device') loadDevice();
  else loadSettings();
}
$$('#nav button').forEach((b) => b.addEventListener('click', () => go(b.dataset.page)));

function renderSideNow() {
  const st = state.status;
  if (!st) return;
  const [cls, text] = stateInfo(st);
  const cur = st.current;
  $('#side-now').innerHTML = `
    <div class="row"><span class="dot ${cls}"></span>${cur ? `${appIcon(cur.id, cur.path, 18, cur.name)}<span class="name">${esc(cur.name)}</span>` : `<span class="name">${esc(text)}</span>`}</div>
    <div class="meta"><span>Today ${fmtDur(st.today)}</span>${cur && st.sessionStart ? `<span class="num" data-timer>${fmtClock((Date.now() - st.sessionStart) / 1000)}</span>` : ''}</div>`;
  hydrate($('#side-now'));
}

async function refreshStatus() {
  const prev = state.status;
  state.status = await agent.status();
  renderSideNow();
  // Re-render the Now card when the app or state changes.
  const changed = !prev || prev.state !== state.status.state || prev.current?.id !== state.status.current?.id || prev.paused !== state.status.paused;
  if (changed && state.page === 'overview' && state.data) {
    const now = $('.now');
    if (now) { now.outerHTML = nowCard(); bindPause(); hydrate(view); }
  }
}

// Live timers tick locally every second.
setInterval(() => {
  const st = state.status;
  if (!st?.sessionStart) return;
  const txt = fmtClock((Date.now() - st.sessionStart) / 1000);
  $$('[data-timer]').forEach((el) => { el.textContent = txt; });
}, 1000);

let refreshTimer = null;
agent.onNavigate?.(() => go('device')); // clicking the "removed" notification

agent.onUpdate((kind) => {
  clearTimeout(refreshTimer);
  refreshTimer = setTimeout(async () => {
    await refreshStatus();
    // Refresh totals for the current period (not while browsing the past or reading details).
    if (state.page === 'overview' && state.data?.isCurrent && !state.drawer) {
      const d = await agent.rangeView(state.range, state.anchor);
      if (state.page === 'overview') { state.data = d; renderOverview(); }
    } else if (state.page === 'device') {
      loadDevice(); // e.g. the admin removed this laptop
    } else if (state.drawer && kind === 'tick' && isToday(state.drawer.day)) {
      renderDrawer();
    }
  }, kind === 'update' ? 150 : 0);
});

// Redraw charts to fit after resizing.
let resizeTimer = null;
window.addEventListener('resize', () => {
  clearTimeout(resizeTimer);
  resizeTimer = setTimeout(() => { if (state.page === 'overview') renderOverview(); else if (state.drawer) renderDrawer(); }, 120);
});

(async function start() {
  await refreshStatus();
  state.swift = await agent.swiftCheck();
  go('overview');
})();
