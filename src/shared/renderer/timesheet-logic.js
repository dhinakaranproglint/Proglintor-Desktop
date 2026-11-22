'use strict';
// Timesheet helpers shared by the agent, the admin app and the tests: month arithmetic, the calendar grid, per-task totals and CSV.
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.TimesheetLogic = factory();
}(typeof self !== 'undefined' ? self : this, () => {
  const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
  const WEEKDAYS = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];
  const YM = /^(\d{4})-(0[1-9]|1[0-2])$/;

  const currentMonth = (d = new Date()) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;

  function shiftMonth(ym, delta) {
    const m = YM.exec(ym);
    if (!m) return currentMonth();
    const idx = Number(m[1]) * 12 + (Number(m[2]) - 1) + delta;
    return `${Math.floor(idx / 12)}-${String((idx % 12) + 1).padStart(2, '0')}`;
  }

  const monthLabel = (ym) => { const m = YM.exec(ym); return m ? `${MONTHS[Number(m[2]) - 1]} ${m[1]}` : ''; };
  const isValidMonth = (ym) => YM.test(String(ym));

  /** "6.5" -> "6h 30m", 0.4 -> "24m", 0 -> "-" */
  function fmtHours(h) {
    if (!h || h <= 0) return '-';
    const mins = Math.round(h * 60);
    const hh = Math.floor(mins / 60);
    const mm = mins % 60;
    return hh ? `${hh}h${mm ? ` ${mm}m` : ''}` : `${mm}m`;
  }

  /** Monday-first weeks of 7 cells; days outside the month are null. */
  function gridWeeks(ts) {
    const cells = Array(ts.firstWeekday || 0).fill(null).concat(ts.days || []);
    while (cells.length % 7) cells.push(null);
    const weeks = [];
    for (let i = 0; i < cells.length; i += 7) weeks.push(cells.slice(i, i + 7));
    return weeks;
  }

  /** Hours per task across the month (the estimate the server made), biggest first. */
  function topTasks(ts, limit = 8) {
    const map = new Map();
    for (const d of ts.days || []) {
      for (const w of d.tasksWorked || []) {
        const t = map.get(w.id) || { id: w.id, title: w.title, hours: 0, days: 0, status: w.status };
        t.hours += w.hours; t.days += 1; t.status = w.status;
        map.set(w.id, t);
      }
    }
    return [...map.values()].map((t) => ({ ...t, hours: Math.round(t.hours * 10) / 10 })).sort((a, b) => b.hours - a.hours).slice(0, limit);
  }

  const csvCell = (v) => {
    let s = String(v ?? '');
    if (/^[=+\-@\t\r]/.test(s)) s = `'${s}`;       // a spreadsheet must never run a task title as a formula
    return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };

  /** One row per day and task (or per day when there is no task activity), ready for a spreadsheet. */
  function toCsv(ts, who = '') {
    const rows = [['Employee', 'Date', 'Weekday', 'Active hours', 'Meeting hours', 'Task', 'Task hours (estimated)', 'Task status', 'Completed that day']];
    for (const d of ts.days || []) {
      if (!d.activeSeconds && !d.tasksWorked.length) continue;
      const wd = WEEKDAYS[d.weekday];
      if (!d.tasksWorked.length) rows.push([who, d.date, wd, d.activeHours, d.meetingHours, '(no task activity)', d.unassignedHours, '', '']);
      for (const w of d.tasksWorked) rows.push([who, d.date, wd, d.activeHours, d.meetingHours, w.title, w.hours, w.status, d.tasksDone.includes(w.title) ? 'yes' : '']);
    }
    return rows.map((r) => r.map(csvCell).join(',')).join('\n');
  }

  return { MONTHS, WEEKDAYS, currentMonth, shiftMonth, monthLabel, isValidMonth, fmtHours, gridWeeks, topTasks, toCsv };
}));
