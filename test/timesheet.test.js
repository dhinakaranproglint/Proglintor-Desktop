'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const T = require('../src/shared/renderer/timesheet-logic');
const V = require('../src/shared/renderer/timesheet-view');

const day = (date, weekday, hours, o = {}) => ({ date, weekday, weekend: weekday >= 5, future: false, activeSeconds: hours * 3600, activeHours: hours, level: hours ? 2 : 0, over: false, meetingHours: 0, topApps: [], tasksWorked: [], tasksDone: [], due: [], unassignedHours: 0, ...o });
const ts = (days, first = 0) => ({ month: '2026-03', firstWeekday: first, days, today: '2026-03-18', totals: { activeHours: 20, workdays: 3, avgHoursPerWorkday: 6.7, tasksCompleted: 2, onTimeRate: 50, weekendHours: 0 } });

test('month arithmetic', () => {
  assert.equal(T.shiftMonth('2026-12', 1), '2027-01');
  assert.equal(T.shiftMonth('2026-01', -1), '2025-12');
  assert.equal(T.shiftMonth('2026-03', 0), '2026-03');
  assert.equal(T.monthLabel('2026-03'), 'March 2026');
  assert.equal(T.monthLabel('nope'), '');
  assert.equal(T.isValidMonth('2026-13'), false);
  assert.equal(T.isValidMonth('2026-11'), true);
  assert.match(T.currentMonth(new Date(2026, 10, 5)), /^2026-11$/);
});

test('hours read like a person would say them', () => {
  assert.deepEqual([0, 0.4, 1, 6.5, 8.25, null].map(T.fmtHours), ['-', '24m', '1h', '6h 30m', '8h 15m', '-']);
});

test('the calendar is Monday-first and padded to whole weeks', () => {
  // March 2026 starts on a Sunday (weekday 6), 31 days
  const days = Array.from({ length: 31 }, (_, i) => day(`2026-03-${String(i + 1).padStart(2, '0')}`, (6 + i) % 7, 0));
  const weeks = T.gridWeeks(ts(days, 6));
  assert.ok(weeks.every((w) => w.length === 7));
  assert.equal(weeks[0].slice(0, 6).every((c) => c === null), true, 'six blanks before Sunday the 1st');
  assert.equal(weeks[0][6].date, '2026-03-01');
  assert.equal(weeks.flat().filter(Boolean).length, 31);
});

test('hours per task add up across days, biggest first', () => {
  const t = ts([
    day('2026-03-02', 0, 6, { tasksWorked: [{ id: 'a', title: 'A', hours: 3, status: 'in_progress' }, { id: 'b', title: 'B', hours: 3, status: 'done' }] }),
    day('2026-03-03', 1, 4, { tasksWorked: [{ id: 'a', title: 'A', hours: 4, status: 'done' }] }),
  ]);
  assert.deepEqual(T.topTasks(t).map((x) => [x.title, x.hours, x.days]), [['A', 7, 2], ['B', 3, 1]]);
});

test('the CSV export is spreadsheet-safe', () => {
  const t = ts([day('2026-03-02', 0, 6, { tasksWorked: [{ id: 'a', title: '=HYPERLINK("http://evil")', hours: 3, status: 'done' }, { id: 'b', title: 'Fix, then "ship"', hours: 3, status: 'todo' }], tasksDone: ['Fix, then "ship"'] }), day('2026-03-03', 1, 0), day('2026-03-04', 2, 2)]);
  const lines = T.toCsv(t, 'Asha').split('\n');
  assert.equal(lines.length, 4, 'header, two task rows, one day with no task activity; the empty day is skipped');
  assert.match(lines[1], /'=HYPERLINK/, 'a formula is neutralised');
  assert.match(lines[2], /"Fix, then ""ship"""/);
  assert.match(lines[2], /,yes$/);
  assert.match(lines[3], /\(no task activity\)/);
});

test('the screens escape everything they show', () => {
  const evil = '<img src=x onerror=alert(1)>';
  const t = ts([day('2026-03-02', 0, 6, { tasksDone: [evil], tasksWorked: [{ id: 'a', title: evil, hours: 6, status: 'done' }], topApps: [{ app: evil, hours: 6 }], due: [evil] })]);
  const html = V.calendarHtml(t, '2026-03-02') + V.dayHtml(t.days[0]) + V.tasksHtml(t) + V.summaryHtml({ text: evil, source: 'llm', label: evil }, 'month', false);
  assert.doesNotMatch(html, /<img src=x/);
  assert.match(html, /&lt;img src=x onerror=alert\(1\)&gt;/);
  assert.match(V.dayHtml(null), /Pick a day/);
  assert.match(V.summaryHtml(null, 'week', true), /Writing your summary/);
  assert.match(V.summaryHtml({ text: 'Fine.', source: 'template', label: 'March' }, 'week', false), /Built from your tracked time/);
  assert.match(V.summaryHtml({ text: 'Fine.', source: 'llm', label: 'March' }, 'week', false), /Written by AI/);
});

test('future days cannot be opened, and a very long day is marked', () => {
  const t = ts([day('2026-03-02', 0, 11, { over: true }), day('2026-03-30', 0, 0, { future: true })]);
  const html = V.calendarHtml(t, '');
  assert.match(html, /class="ts-cell l2 over"/);
  assert.match(html, /disabled/);
});
