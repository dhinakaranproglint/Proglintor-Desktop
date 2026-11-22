'use strict';
// The timesheet screens as HTML, shared by the agent (the employee's own) and the admin app (any employee). Each app fetches the data and
// handles the actions; this only draws. All text is escaped here.
const TimesheetView = (() => {
  const T = typeof TimesheetLogic !== 'undefined' ? TimesheetLogic : require('./timesheet-logic');
  const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

  function totalsHtml(ts) {
    const t = ts.totals;
    const chip = (v, l) => `<div class="ts-stat"><b>${esc(v)}</b><span>${esc(l)}</span></div>`;
    return `<div class="ts-stats">${chip(T.fmtHours(t.activeHours), 'Active time')}${chip(t.workdays, 'Working days')}${chip(t.avgHoursPerWorkday ? T.fmtHours(t.avgHoursPerWorkday) : '-', 'Avg per day')}${chip(t.tasksCompleted, 'Tasks done')}${chip(t.onTimeRate == null ? '-' : `${t.onTimeRate}%`, 'On time')}${chip(t.weekendHours ? T.fmtHours(t.weekendHours) : '-', 'Weekend')}</div>`;
  }

  function calendarHtml(ts, selected) {
    const head = T.WEEKDAYS.map((d) => `<div class="ts-wd">${d}</div>`).join('');
    const body = T.gridWeeks(ts).map((w) => w.map((d) => {
      if (!d) return '<div class="ts-cell blank"></div>';
      const num = Number(d.date.slice(8));
      const cls = ['ts-cell', `l${d.level}`, d.weekend ? 'wk' : '', d.future ? 'fut' : '', d.over ? 'over' : '', d.date === selected ? 'sel' : '', d.date === ts.today ? 'today' : ''].filter(Boolean).join(' ');
      const done = d.tasksDone.length ? `<span class="ts-done" title="${esc(d.tasksDone.join(', '))}">${d.tasksDone.length}</span>` : '';
      const title = d.future ? '' : `${d.date}: ${T.fmtHours(d.activeHours)} active${d.tasksDone.length ? `, ${d.tasksDone.length} task${d.tasksDone.length > 1 ? 's' : ''} done` : ''}${d.over ? ' (a very long day)' : ''}`;
      return `<button class="${cls}" data-day="${esc(d.date)}" ${d.future ? 'disabled' : ''} title="${esc(title)}"><i>${num}</i><em>${d.activeHours ? esc(T.fmtHours(d.activeHours)) : ''}</em>${done}</button>`;
    }).join('')).join('');
    return `<div class="ts-grid" role="grid" aria-label="Month calendar">${head}${body}</div>
      <div class="ts-legend"><span>Less</span>${[0, 1, 2, 3, 4].map((l) => `<i class="ts-cell l${l}" style="width:18px;height:18px;min-height:0"></i>`).join('')}<span>More</span><span class="ts-sep"></span><span class="ts-done static">n</span><span>tasks finished that day</span></div>`;
  }

  function dayHtml(d) {
    if (!d) return '<div class="ts-day empty">Pick a day on the calendar to see what happened.</div>';
    const when = new Date(`${d.date}T00:00:00`).toLocaleDateString(undefined, { weekday: 'long', day: 'numeric', month: 'long' });
    const tasks = d.tasksWorked.length
      ? d.tasksWorked.map((w) => `<div class="ts-line"><span>${esc(w.title)}${d.tasksDone.includes(w.title) ? ' <em class="ts-ok">done</em>' : ''}</span><b>${esc(T.fmtHours(w.hours))}</b></div>`).join('') + '<div class="ts-note">Task hours are an estimate: the day\'s tracked time shared across the tasks that were worked on.</div>'
      : (d.activeSeconds ? `<div class="ts-note">No task activity was recorded this day, so ${esc(T.fmtHours(d.unassignedHours))} is unassigned.</div>` : '');
    const apps = d.topApps.length ? `<div class="ts-sub">Most used</div>${d.topApps.map((a) => `<div class="ts-line"><span>${esc(a.app)}</span><b>${esc(T.fmtHours(a.hours))}</b></div>`).join('')}` : '';
    const extra = [d.meetingHours ? `${T.fmtHours(d.meetingHours)} in meetings` : '', d.due.length ? `Due: ${d.due.map(esc).join(', ')}` : '', d.over ? 'A very long day: worth some rest.' : ''].filter(Boolean).map((x) => `<div class="ts-note">${x}</div>`).join('');
    return `<div class="ts-day"><h4>${esc(when)}</h4><div class="ts-big">${esc(T.fmtHours(d.activeHours))}<span> active</span></div>${d.tasksWorked.length ? '<div class="ts-sub">Tasks</div>' : ''}${tasks}${apps}${extra}</div>`;
  }

  function summaryHtml(s, period, busy) {
    const tabs = `<div class="segmented" role="group" aria-label="Summary period"><button data-period="week" class="${period === 'week' ? 'on' : ''}">This week</button><button data-period="month" class="${period === 'month' ? 'on' : ''}">This month</button></div>`;
    const body = busy ? '<p class="ts-text muted">Writing your summary…</p>'
      : s ? `<p class="ts-text">${esc(s.text)}</p><div class="ts-note">${s.source === 'llm' ? 'Written by AI from your tracked time and tasks.' : 'Built from your tracked time and tasks.'} ${esc(s.label)}.</div>`
        : '<p class="ts-text muted">No summary yet.</p>';
    return `<section class="ts-card ts-summary"><div class="ts-card-head"><h3>Summary</h3>${tabs}</div>${body}<button class="btn sm" data-refresh>Refresh</button></section>`;
  }

  function tasksHtml(ts) {
    const list = T.topTasks(ts);
    if (!list.length) return '<section class="ts-card"><h3>Where the time went</h3><p class="muted">No task activity this month yet.</p></section>';
    const max = Math.max(...list.map((t) => t.hours), 1);
    return `<section class="ts-card"><h3>Where the time went <span class="sub">estimated, by task</span></h3>${list.map((t) => `<div class="ts-task"><div class="ts-line"><span>${esc(t.title)}</span><b>${esc(T.fmtHours(t.hours))}</b></div><div class="ts-bar"><i style="width:${Math.round((t.hours / max) * 100)}%"></i></div></div>`).join('')}</section>`;
  }

  return { esc, totalsHtml, calendarHtml, dayHtml, summaryHtml, tasksHtml };
})();
if (typeof module === 'object' && module.exports) module.exports = TimesheetView;
