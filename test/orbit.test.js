'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const L = require('../src/shared/renderer/orbit-logic');
const { OrbitAgent } = require('../src/agent/orbit');

test('the greeting follows the same table as the server', () => {
  const at = (h) => L.salutation(h);
  assert.deepEqual([4, 5, 11, 12, 16, 17, 20, 21].map(at),
    ['Hello', 'Good morning', 'Good morning', 'Good afternoon', 'Good afternoon', 'Good evening', 'Good evening', 'Hello']);
  assert.equal(L.localGreeting('Asha Rao', new Date(2026, 0, 12, 9, 15)).text, 'Good morning, Asha!');
  assert.equal(L.localGreeting('', new Date(2026, 0, 12, 19, 0)).text, 'Good evening, there!');
});

test('local time is sent with its UTC offset', () => {
  assert.match(L.localIso(new Date(2026, 0, 12, 9, 5, 7)), /^2026-01-12T09:05:07[+-]\d\d:\d\d$/);
});

test('persona input is untrusted: only valid values survive', () => {
  const p = L.sanitizePersona({ name: '<img onerror=x>Nova', color: 'red', style: 'evil', sound: 'loud', volume: 9, speak: 'yes', greet: false, motion: false, extra: 1 });
  assert.equal(p.name, 'img onerrorxNova');
  assert.equal(p.color, L.DEFAULTS.color);
  assert.equal(p.style, 'aurora');
  assert.equal(p.sound, 'chime');
  assert.equal(p.volume, 1);
  assert.equal(p.speak, false);
  assert.equal(p.greet, false);
  assert.equal(p.motion, false);
  assert.equal('extra' in p, false);
  assert.equal(L.sanitizePersona({ color: '#ff8800', name: '  ' }, { ...L.DEFAULTS, name: 'Nova' }).name, 'Nova', 'a blank name keeps the previous one');
  assert.equal(L.sanitizePersona({ color: '#ff8800' }).color, '#FF8800');
  assert.ok(L.sanitizePersona({ name: 'x'.repeat(80) }).name.length <= 24);
  assert.equal(L.sanitizePersona(null).name, 'Orbit');
});

test('the greeting appears once a day, only when connected and switched on', () => {
  const today = '2026-01-12';
  assert.equal(L.shouldGreet({ enabled: true, enrolled: true, lastDay: '2026-01-11', today }), true);
  assert.equal(L.shouldGreet({ enabled: true, enrolled: true, lastDay: today, today }), false, 'not twice on the same day');
  assert.equal(L.shouldGreet({ enabled: false, enrolled: true, lastDay: '', today }), false);
  assert.equal(L.shouldGreet({ enabled: true, enrolled: false, lastDay: '', today }), false);
});

function fakeSync(routes, { enrolled = true, removed = false } = {}) {
  const calls = [];
  return {
    calls, enrolled, status: () => ({ removed }),
    async call(method, path, body) {
      calls.push({ method, path, body });
      const key = Object.keys(routes).find((k) => path.startsWith(k));
      if (!key) throw Object.assign(new Error('nope'), { status: 404 });
      const r = routes[key];
      if (typeof r === 'function') return r(method, path, body);
      return r;
    },
  };
}

const NOW = new Date(2026, 0, 12, 9, 15);

test('briefing and chat carry the laptop clock and a cleaned conversation', async () => {
  const sync = fakeSync({ '/api/agent/orbit/briefing': { greeting: { text: 'Good morning, Asha!' } }, '/api/agent/orbit/chat': { reply: 'ok', actions: [], source: 'llm' } });
  const o = new OrbitAgent({ sync, now: () => NOW });
  const b = await o.briefing();
  assert.equal(b.ok, true);
  assert.match(sync.calls[0].path, /localTime=2026-01-12T09%3A15%3A00%2B|localTime=2026-01-12T09%3A15%3A00-/);
  const c = await o.chat([{ role: 'user', content: 'hi' }], '<b>Nova</b>');
  assert.equal(c.data.reply, 'ok');
  assert.equal(sync.calls[1].body.agentName, 'bNovab');
  assert.match(sync.calls[1].body.localTime, /^2026-01-12T09:15:00/);
});

test('chat refuses empty, oversized or assistant-last conversations before sending', async () => {
  const sync = fakeSync({});
  const o = new OrbitAgent({ sync, now: () => NOW });
  assert.equal((await o.chat([])).ok, false);
  assert.equal((await o.chat([{ role: 'assistant', content: 'hi' }])).ok, false);
  assert.equal((await o.chat([{ role: 'user', content: '   ' }])).ok, false);
  assert.equal((await o.chat(Array.from({ length: 21 }, () => ({ role: 'user', content: 'x' })))).ok, false);
  assert.equal(sync.calls.length, 0, 'nothing was sent');
  await o.chat([{ role: 'user', content: 'x'.repeat(5000) }]).catch(() => {});
  assert.equal(sync.calls[0].body.messages[0].content.length, 1000, 'long text is cut, not sent whole');
});

test('every call is refused politely when the laptop is not connected or was removed', async () => {
  for (const opts of [{ enrolled: false }, { removed: true }]) {
    const o = new OrbitAgent({ sync: fakeSync({}, opts), now: () => NOW });
    const r = await o.briefing();
    assert.equal(r.ok, false);
    assert.match(r.error, /laptop/i);
  }
});

test('task updates validate the id and only send known fields', async () => {
  const sync = fakeSync({ '/api/agent/orbit/tasks/': { id: 'x' } });
  const o = new OrbitAgent({ sync, now: () => NOW });
  assert.equal((await o.updateTask('../../etc/passwd', { status: 'done' })).ok, false);
  const id = '123e4567-e89b-12d3-a456-426614174000';
  const r = await o.updateTask(id, { status: 'done', percent: 50.5, evil: 'x' });
  assert.equal(r.ok, true);
  assert.deepEqual(sync.calls[0].body, { status: 'done' });
  assert.equal(sync.calls[0].method, 'PATCH');
});

test('nominating sends either a server-found achievement or the employee\'s own words, never both', async () => {
  const sync = fakeSync({ '/api/agent/orbit/recognitions': { id: 'r1' } });
  const o = new OrbitAgent({ sync, now: () => NOW });
  await o.nominate({ dedupeKey: 'delivery:2026-W03', title: 'ignored' });
  assert.equal(sync.calls[0].body.dedupeKey, 'delivery:2026-W03');
  assert.equal('title' in sync.calls[0].body, false);
  await o.nominate({ title: 'Covered the incident', details: 'Saturday' });
  assert.equal(sync.calls[1].body.title, 'Covered the incident');
  assert.equal('dedupeKey' in sync.calls[1].body, false);
});

test('new tasks and decisions are announced, but nothing is announced at start-up', async () => {
  let payload = { enabled: true, tasks: [{ id: 't1', title: 'Old task' }], recognitions: [{ id: 'r1', status: 'pending', title: 'Weekend work' }] };
  const sync = fakeSync({ '/api/agent/orbit/pulse': () => payload });
  const told = [];
  let changed = 0;
  const o = new OrbitAgent({ sync, notify: (t, b) => told.push([t, b]), onChange: () => { changed++; }, now: () => NOW });
  await o.pulse();
  assert.deepEqual(told, [], 'first look: no announcements');
  payload = { enabled: true, tasks: [{ id: 't1', title: 'Old task' }, { id: 't2', title: 'Fix the login bug' }], recognitions: [{ id: 'r1', status: 'approved', title: 'Weekend work', reward: 'Comp-off day' }] };
  await o.pulse();
  assert.equal(told.length, 2);
  assert.equal(told[0][1], 'Fix the login bug');
  assert.match(told[1][0], /approved/);
  assert.match(told[1][1], /Comp-off day/);
  assert.equal(changed, 1);
  await o.pulse();
  assert.equal(told.length, 2, 'the same news is not repeated');
});

test('when the admin has switched Orbit off the app says so plainly', async () => {
  const sync = fakeSync({ '/api/agent/orbit/briefing': () => { throw Object.assign(new Error('off'), { status: 404, code: 'orbit_disabled' }); } });
  const r = await new OrbitAgent({ sync, now: () => NOW }).briefing();
  assert.equal(r.ok, false);
  assert.equal(r.code, 'orbit_disabled');
});

test('a decision is announced even if the poll never saw the request while it was pending', async () => {
  let payload = { enabled: true, tasks: [], recognitions: [] };
  const sync = fakeSync({ '/api/agent/orbit/pulse': () => payload });
  const told = [];
  let changed = 0;
  const o = new OrbitAgent({ sync, notify: (t, b) => told.push([t, b]), onChange: () => { changed++; }, now: () => NOW });
  await o.pulse();
  payload = { enabled: true, tasks: [], recognitions: [{ id: 'r9', status: 'approved', title: 'Saved the release', reward: 'Gift card' }] };
  await o.pulse();
  assert.equal(told.length, 1);
  assert.match(told[0][1], /Gift card/);
  assert.equal(changed, 1, 'the open page is told to refresh');
});

test('the floating companion docks to a corner, can be dragged, and always stays on screen', () => {
  const wa = { x: 0, y: 25, width: 1440, height: 875 };
  const br = L.placement({ dock: 'bottom-right', size: 'm' }, wa);
  assert.equal(br.x + br.width + 20, wa.width, 'right margin');
  assert.equal(br.y + br.height + 20, wa.y + wa.height, 'bottom margin');
  assert.deepEqual([br.side, br.vert], ['right', 'bottom']);
  const tl = L.placement({ dock: 'top-left', size: 's' }, wa);
  assert.deepEqual([tl.x, tl.y, tl.side, tl.vert], [20, 45, 'left', 'top']);
  const lost = L.placement({ dock: 'free', size: 'l', x: -900, y: 99999 }, wa);
  assert.ok(lost.x >= 0 && lost.y + lost.height <= wa.y + wa.height, 'a position outside the screen (unplugged monitor) is pulled back in');
  const p = L.sanitizePersona({ dock: 'free', x: 300.6, y: 200 });
  assert.deepEqual([p.dock, p.x, p.y], ['free', 301, 200]);
  assert.deepEqual([L.sanitizePersona({ dock: 'top-left' }, p).x, L.sanitizePersona({ dock: 'top-left' }, p).dock], [null, 'top-left'], 'picking a corner forgets the dragged spot');
  assert.equal(L.sanitizePersona({ dock: 'nowhere' }).dock, 'bottom-right');
  assert.equal(L.sanitizePersona({ size: 'huge' }).size, 'm');
  assert.equal(L.DEFAULTS.show, true);
});

test('welcome back is short, specific and an invitation to start', () => {
  const tasks = { openCount: 2, overdue: [], dueToday: [{ title: 'Fix the login bug' }], upcoming: [{ title: 'Write the doc' }], later: [] };
  const t = L.welcomeBackText({ name: 'Asha Rao', tasks, hour: 14 });
  assert.match(t, /Good afternoon again, Asha!/);
  assert.match(t, /Fix the login bug/);
  assert.match(t, /due today/);
  assert.match(L.welcomeBackText({ name: 'Asha', tasks: { openCount: 1, overdue: [{ title: 'Late one' }], dueToday: [], upcoming: [], later: [] }, hour: 10 }), /overdue/);
  assert.match(L.welcomeBackText({ name: 'Asha', tasks: { openCount: 0 }, hour: 10 }), /no open tasks/);
  assert.match(L.welcomeBackText({ name: 'Asha', tasks: null, hour: 23 }), /^Welcome back, Asha!/);
  assert.equal(L.sanitizePersona({ welcomeBack: 999 }).welcomeBack, 240);
  assert.equal(L.sanitizePersona({ welcomeBack: -5 }).welcomeBack, 0);
  assert.equal(L.sanitizePersona({}).welcomeBack, 20);
});

test('weekend check-in is calm, names real high-priority work, and offers the company\'s own reasons', () => {
  const sunday = new Date(2026, 10, 22, 11, 0);   // a Sunday
  const sections = {
    overdue: [], dueToday: [],
    upcoming: [
      { title: 'Fix the login redirect bug', priority: 'urgent', dueDate: '2026-11-23', status: 'in_progress' },
      { title: 'Plan the offsite', priority: 'low', dueDate: '2026-11-23', status: 'todo' },
      { title: 'Next month report', priority: 'high', dueDate: '2026-12-20', status: 'todo' },
      { title: 'Review the notifications design', priority: 'high', dueDate: '2026-11-24', status: 'todo' },
    ],
  };
  const urgent = L.pickUrgentTasks(sections, sunday);
  assert.deepEqual(urgent.map((t) => t.title), ['Fix the login redirect bug', 'Review the notifications design'], 'only high or urgent work that is actually close, most urgent first');
  const ask = L.weekendCheckIn({ name: 'Asha Rao', urgent, reasons: ['Urgent production issue', 'Project deadline', 'Other'], now: sunday });
  assert.match(ask.text, /^It's Sunday, Asha\./);
  assert.match(ask.text, /Fix the login redirect bug/);
  assert.match(ask.text, /urgent priority and due tomorrow/);
  assert.match(ask.text, /No pressure/);
  assert.deepEqual(ask.choices.map((c) => c.id), ['task:0', 'task:1', 'reason:0', 'reason:1', 'look']);
  assert.equal(ask.choices[0].reason, 'Assigned high-priority task');
  assert.equal(ask.choices.some((c) => /^Other$/i.test(c.label)), false);
  const quiet = L.weekendCheckIn({ name: 'Asha', urgent: [], reasons: [], now: sunday });
  assert.match(quiet.text, /don't see any urgent work/);
  assert.deepEqual(quiet.choices.map((c) => c.id), ['look']);
  assert.match(L.replyFor(ask.choices[0]), /noted it for your admin/);
  assert.match(L.replyFor(ask.choices[4]), /Enjoy/);
  assert.equal(L.dueLabel('2026-11-20', sunday), 'overdue');
  assert.equal(L.dueLabel('2026-11-22', sunday), 'due today');
  assert.equal(L.dueLabel('2026-11-26', sunday), 'due Thursday');
  assert.deepEqual(L.pickUrgentTasks(null, sunday), []);
});

test('the latest tracked time is sent to the server before a question is asked, but a slow server never blocks the chat', async () => {
  const order = [];
  const sync = fakeSync({ '/api/agent/orbit/chat': () => { order.push('chat'); return { reply: 'ok', actions: [], source: 'llm' }; } });
  const o = new OrbitAgent({ sync, now: () => NOW, flush: async () => { order.push('flush'); } });
  await o.chat([{ role: 'user', content: 'how many hours today on VS Code?' }]);
  assert.deepEqual(order, ['flush', 'chat']);
  const failing = new OrbitAgent({ sync, now: () => NOW, flush: async () => { throw new Error('offline'); } });
  assert.equal((await failing.chat([{ role: 'user', content: 'hi' }])).ok, true, 'a failed push does not stop the answer');
});

test('the timesheet calls validate their input before anything is sent', async () => {
  const sync = fakeSync({ '/api/agent/orbit/timesheet': { month: '2026-03' } });
  const o = new OrbitAgent({ sync, now: () => NOW });
  assert.equal((await o.timesheet('../../x')).ok, false);
  assert.equal((await o.timesheet('2026-13')).ok, false);
  assert.equal((await o.timesheetSummary('year')).ok, false);
  assert.equal((await o.timesheetSummary('week', 'soon')).ok, false);
  assert.equal(sync.calls.length, 0, 'nothing odd was sent');
  assert.equal((await o.timesheet('2026-03')).ok, true);
  assert.match(sync.calls[0].path, /timesheet\?month=2026-03$/);
  await o.timesheetSummary('week', '2026-03-16');
  assert.match(sync.calls[1].path, /summary\?period=week&start=2026-03-16$/);
});
