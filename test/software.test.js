'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('crypto');
const fs = require('fs');
const http = require('http');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');

const inst = require('../src/agent/installer');
const { SoftwareAgent, friendlyError } = require('../src/agent/software');

const tmp = (p) => fs.mkdtempSync(path.join(os.tmpdir(), p));
const sha = (buf) => crypto.createHash('sha256').update(buf).digest('hex');
const IS_MAC = process.platform === 'darwin';

/** Serves fixed bytes on a random loopback port. */
function serve(handler) {
  return new Promise((resolve) => {
    const srv = http.createServer(handler);
    srv.listen(0, '127.0.0.1', () => resolve({ srv, url: `http://127.0.0.1:${srv.address().port}/f`, close: () => new Promise((r) => srv.close(r)) }));
  });
}

test('versions compare numerically', () => {
  assert.equal(inst.compareVersions('1.140.0', '1.9.9'), 1);
  assert.equal(inst.compareVersions('1.0', '1.0.0'), 0);
  assert.equal(inst.compareVersions('2.3', '2.10'), -1);
  assert.equal(inst.compareVersions('', '0'), 0);
});

test('only https (or opted-in loopback http) downloads are allowed', () => {
  assert.ok(inst.urlAllowed('https://dl.example.com/a.zip'));
  assert.ok(!inst.urlAllowed('http://dl.example.com/a.zip'));
  assert.ok(!inst.urlAllowed('http://127.0.0.1:9/a.zip'), 'loopback http is off unless enabled');
  assert.ok(inst.urlAllowed('http://127.0.0.1:9/a.zip', true));
  assert.ok(!inst.urlAllowed('http://evil.example/a.zip', true));
  assert.ok(!inst.urlAllowed('file:///etc/passwd', true));
  assert.ok(!inst.urlAllowed('not a url'));
});

test('a tampered or malformed job is refused before anything downloads', () => {
  const ok = { installerType: 'zip', sha256: 'a'.repeat(64), downloadUrl: 'https://x.example/a.zip', platform: process.platform };
  assert.doesNotThrow(() => inst.validateSpec(ok));
  const code = (patch) => { try { inst.validateSpec({ ...ok, ...patch }); } catch (e) { return e.code; } return null; };
  assert.equal(code({ installerType: 'sh' }), 'INSTALLER_UNSUPPORTED');
  assert.equal(code({ sha256: 'abc' }), 'DIGEST_MISMATCH');
  assert.equal(code({ appName: '../Evil.app' }), 'PAYLOAD_NOT_FOUND');
  assert.equal(code({ appName: '.hidden.app' }), 'PAYLOAD_NOT_FOUND');
  assert.equal(code({ platform: process.platform === 'darwin' ? 'win32' : 'darwin' }), 'INSTALLER_UNSUPPORTED');
  assert.equal(code({ arch: process.arch === 'arm64' ? 'x64' : 'arm64' }), 'INSTALLER_UNSUPPORTED');
  assert.throws(() => inst.validateSpec(null), /./);
});

test('zip entries must stay inside the extraction folder', () => {
  assert.ok(inst.zipPathsSafe('Foo.app/Contents/Info.plist\nFoo.app/Contents/MacOS/foo\n'));
  assert.ok(!inst.zipPathsSafe('Foo.app/x\n../../etc/passwd\n'));
  assert.ok(!inst.zipPathsSafe('/etc/passwd\n'));
  assert.ok(!inst.zipPathsSafe('a/../../b\n'));
});

test('symlinks that point outside the extracted folder are rejected', async () => {
  const root = tmp('pp-sl-');
  fs.mkdirSync(path.join(root, 'App.app', 'Contents'), { recursive: true });
  fs.writeFileSync(path.join(root, 'App.app', 'Contents', 'real'), 'x');
  fs.symlinkSync('real', path.join(root, 'App.app', 'Contents', 'inside'));
  assert.equal(await inst.symlinksContained(root), true, 'normal bundle symlinks are fine');
  fs.symlinkSync('/etc', path.join(root, 'App.app', 'escape'));
  assert.equal(await inst.symlinksContained(root), false);
});

test('download: verifies the pinned digest, reports progress, and deletes bad files', async () => {
  const body = crypto.randomBytes(300 * 1024);
  const s = await serve((req, res) => { res.setHeader('content-length', body.length); res.end(body); });
  try {
    const dir = tmp('pp-dl-');
    const seen = [];
    const spec = { downloadUrl: s.url, sha256: sha(body), installerType: 'zip', sizeBytes: body.length };
    const file = await inst.download(spec, dir, { allowLoopbackHttp: true, onProgress: (d, t) => seen.push([d, t]) });
    assert.equal(fs.statSync(file).size, body.length);
    assert.equal(path.basename(file), 'installer.zip', 'the file name never comes from the URL');
    assert.equal(seen.at(-1)[0], body.length);

    await assert.rejects(inst.download({ ...spec, sha256: 'f'.repeat(64) }, dir, { allowLoopbackHttp: true }), { code: 'DIGEST_MISMATCH' });
    assert.ok(!fs.existsSync(path.join(dir, 'installer.zip')), 'a file that fails the check is deleted');

    await assert.rejects(inst.download(spec, dir, { allowLoopbackHttp: false }), { code: 'DOWNLOAD_FAILED' }, 'plain http refused');
    await assert.rejects(inst.download({ ...spec, sizeBytes: 1000 }, dir, { allowLoopbackHttp: true }), { code: 'DIGEST_MISMATCH' }, 'bigger than the approved file');
  } finally { await s.close(); }
});

test('download: server errors and dropped connections become DOWNLOAD_FAILED', async () => {
  const s404 = await serve((_q, res) => { res.statusCode = 404; res.end('nope'); });
  const sDrop = await serve((req) => { req.socket.destroy(); });
  try {
    const base = { sha256: 'a'.repeat(64), installerType: 'zip' };
    await assert.rejects(inst.download({ ...base, downloadUrl: s404.url }, tmp('pp-dl-'), { allowLoopbackHttp: true }), { code: 'DOWNLOAD_FAILED' });
    await assert.rejects(inst.download({ ...base, downloadUrl: sDrop.url }, tmp('pp-dl-'), { allowLoopbackHttp: true }), { code: 'DOWNLOAD_FAILED' });
  } finally { await s404.close(); await sDrop.close(); }
});

test('download: cancelling stops it', async () => {
  const s = await serve((_q, res) => { res.write('x'); /* never ends */ });
  try {
    const ac = new AbortController();
    const p = inst.download({ downloadUrl: s.url, sha256: 'a'.repeat(64), installerType: 'zip' }, tmp('pp-dl-'), { allowLoopbackHttp: true, signal: ac.signal });
    setTimeout(() => ac.abort(), 150);
    await assert.rejects(p, { code: 'INSTALL_INTERRUPTED' });
  } finally { s.srv.closeAllConnections(); await s.close(); }
});

// ---- macOS bundle handling, on a synthetic .app (no signing needed: trust is injected) ----------------

function fakeApp(root, name, bundleId, version) {
  const app = path.join(root, name);
  fs.mkdirSync(path.join(app, 'Contents', 'MacOS'), { recursive: true });
  fs.writeFileSync(path.join(app, 'Contents', 'MacOS', 'run'), '#!/bin/sh\n');
  fs.writeFileSync(path.join(app, 'Contents', 'Info.plist'), `<?xml version="1.0" encoding="UTF-8"?>
<plist version="1.0"><dict><key>CFBundleIdentifier</key><string>${bundleId}</string>
<key>CFBundleShortVersionString</key><string>${version}</string></dict></plist>`);
  return app;
}

test('mac: install, upgrade with rollback safety, and every refusal', { skip: !IS_MAC }, async () => {
  const work = tmp('pp-mac-');
  const dest = path.join(work, 'Applications');
  fs.mkdirSync(dest);
  const spec = { appId: 'com.example.foo', name: 'Foo', version: '2.0.0' };
  const src = fakeApp(work, 'Foo.app', 'com.example.foo', '2.0.0');
  const trustOk = async () => {};
  const ctx = (extra = {}) => ({ destDirs: [dest], trust: trustOk, ...extra });

  const target = await inst.placeApp(src, spec, ctx());
  assert.equal(target, path.join(dest, 'Foo.app'));
  assert.ok(fs.existsSync(path.join(target, 'Contents', 'Info.plist')));
  assert.deepEqual(fs.readdirSync(dest), ['Foo.app'], 'no staging leftovers');

  // upgrade from an older copy
  fs.rmSync(target, { recursive: true });
  fakeApp(dest, 'Foo.app', 'com.example.foo', '1.0.0');
  await inst.placeApp(src, spec, ctx());
  assert.match(fs.readFileSync(path.join(dest, 'Foo.app', 'Contents', 'Info.plist'), 'utf8'), /2\.0\.0/);
  assert.deepEqual(fs.readdirSync(dest), ['Foo.app']);

  // the running app is never replaced
  await assert.rejects(inst.placeApp(src, spec, ctx({ isRunning: async () => true })), { code: 'APP_IN_USE' });
  // a different app with the same file name
  fs.rmSync(path.join(dest, 'Foo.app'), { recursive: true });
  fakeApp(dest, 'Foo.app', 'com.other.thing', '9.0');
  await assert.rejects(inst.placeApp(src, spec, ctx()), { code: 'DESTINATION_CONFLICT' });
  assert.match(fs.readFileSync(path.join(dest, 'Foo.app', 'Contents', 'Info.plist'), 'utf8'), /com\.other\.thing/, 'untouched');
  // a newer version is never downgraded
  fs.rmSync(path.join(dest, 'Foo.app'), { recursive: true });
  fakeApp(dest, 'Foo.app', 'com.example.foo', '3.0.0');
  await assert.rejects(inst.placeApp(src, spec, ctx()), { code: 'NEWER_VERSION_INSTALLED' });
  // a failed trust check leaves the existing app alone and cleans up
  fs.rmSync(path.join(dest, 'Foo.app'), { recursive: true });
  fakeApp(dest, 'Foo.app', 'com.example.foo', '1.0.0');
  await assert.rejects(inst.placeApp(src, spec, ctx({ trust: async () => { throw new inst.InstallError('SIGNATURE_INVALID'); } })), { code: 'SIGNATURE_INVALID' });
  assert.match(fs.readFileSync(path.join(dest, 'Foo.app', 'Contents', 'Info.plist'), 'utf8'), /1\.0\.0/);
  assert.deepEqual(fs.readdirSync(dest), ['Foo.app'], 'staging removed');
  // no writable destination
  await assert.rejects(inst.placeApp(src, spec, { destDirs: ['/System/nope/x'], trust: trustOk }), { code: 'DESTINATION_NOT_WRITABLE' });
});

test('mac: full job from a zip over the network, and the real trust check refuses an unsigned app', { skip: !IS_MAC }, async () => {
  const work = tmp('pp-job-');
  const dest = path.join(work, 'Applications');
  fs.mkdirSync(dest);
  const app = fakeApp(work, 'Foo.app', 'com.example.foo', '2.0.0');
  execFileSync('ditto', ['-c', '-k', '--keepParent', app, path.join(work, 'foo.zip')]);
  const zip = fs.readFileSync(path.join(work, 'foo.zip'));
  const s = await serve((_q, res) => { res.setHeader('content-length', zip.length); res.end(zip); });
  try {
    const spec = { slug: 'foo', name: 'Foo', version: '2.0.0', appId: 'com.example.foo', appName: 'Foo.app', installerType: 'zip',
      downloadUrl: s.url, sha256: sha(zip), sizeBytes: zip.length, platform: 'darwin', arch: 'any' };
    const phases = [];
    const done = await inst.runJob(spec, { allowLoopbackHttp: true, tempRoot: work, onPhase: (p) => phases.push(p), mac: { destDirs: [dest], trust: async () => {} },
      detect: async (_s, p) => fs.existsSync(p) });
    assert.equal(done.path, path.join(dest, 'Foo.app'));
    assert.deepEqual([...new Set(phases)], ['DOWNLOADING', 'INSTALLING', 'VERIFYING']);
    assert.deepEqual(fs.readdirSync(work).filter((n) => n.startsWith('proglintor-install-')), [], 'temp folder removed');

    // wrong catalogue name inside the zip
    await assert.rejects(inst.runJob({ ...spec, appName: 'Bar.app' }, { allowLoopbackHttp: true, tempRoot: work, mac: { destDirs: [dest] } }), { code: 'PAYLOAD_NOT_FOUND' });
    // the real trust check: an unsigned bundle must not be installed
    fs.rmSync(path.join(dest, 'Foo.app'), { recursive: true });
    await assert.rejects(inst.runJob(spec, { allowLoopbackHttp: true, tempRoot: work, mac: { destDirs: [dest] } }), { code: 'SIGNATURE_INVALID' });
    assert.deepEqual(fs.readdirSync(dest), [], 'nothing installed');
    // post-install detection failing is reported, not ignored
    await assert.rejects(inst.runJob(spec, { allowLoopbackHttp: true, tempRoot: work, mac: { destDirs: [dest], trust: async () => {} }, detect: async () => false }), { code: 'NOT_DETECTED_AFTER_INSTALL' });
  } finally { await s.close(); }
});

// ---- SoftwareAgent (chat API + worker) -------------------------------------------------------------

function fakeSync(handler, opts = {}) {
  const calls = [];
  return {
    calls,
    enrolled: opts.enrolled !== false,
    status: () => ({ removed: opts.removed || null }),
    call: async (method, p, body) => { calls.push({ method, p, body }); return handler(method, p, body); },
  };
}
const netErr = () => Object.assign(new Error('fetch failed'), { cause: { code: 'ECONNREFUSED' } });
const agent = (sync, extra = {}) => new SoftwareAgent({ dir: tmp('pp-sw-'), sync, runningApps: async () => [], retryDelays: [1, 1], ...extra });

test('chat calls explain a missing or removed enrollment instead of failing silently', async () => {
  const a = agent(fakeSync(() => ({}), { enrolled: false }));
  const r = await a.submit('install git', 'key-12345678');
  assert.deepEqual([r.ok, r.code], [false, 'not_enrolled']);
  assert.match(r.error, /My Device/);
  const b = agent(fakeSync(() => ({}), { removed: { at: 1 } }));
  assert.equal((await b.preview('x')).code, 'removed');
});

test('errors are phrased for employees', () => {
  assert.equal(friendlyError(Object.assign(new Error('Too many'), { status: 429, code: 'rate_limited' })).error, 'Too many');
  assert.equal(friendlyError(Object.assign(new Error('boom'), { status: 500 })).code, 'server_error');
  assert.equal(friendlyError(Object.assign(new Error('x'), { status: 401 })).code, 'not_connected');
  const off = friendlyError(netErr());
  assert.equal(off.code, 'offline');
  assert.match(off.error, /not sent/);
  assert.doesNotMatch(off.error, /127\.0\.0\.1|https?:\/\//, 'no server addresses shown to employees');
});

test('submit tracks the request and wakes the worker; offline returns a clear error', async () => {
  const s = fakeSync((m, p) => (p.endsWith('/requests') ? { id: 'r1', status: 'AWAITING_APPROVAL' } : {}));
  const a = agent(s);
  let poked = 0;
  a.poke = () => { poked += 1; };
  const r = await a.submit('install git', 'key-12345678');
  assert.equal(r.data.status, 'AWAITING_APPROVAL');
  assert.equal(poked, 1);
  assert.equal(a.known.get('r1'), 'AWAITING_APPROVAL');
  assert.equal(a.watching, 1, 'a request waiting for approval switches the worker to fast polling');
  a._track({ id: 'r1', status: 'SUCCEEDED' });
  assert.equal(a.watching, 0, 'and back to relaxed polling once nothing is open');
  const clar = await agent(fakeSync(() => ({ id: null, status: 'NEEDS_CLARIFICATION' }))).submit('visual studio', 'key-12345678');
  assert.equal(clar.data.status, 'NEEDS_CLARIFICATION');
  const off = await agent(fakeSync(() => { throw netErr(); })).submit('x', 'key-12345678');
  assert.deepEqual([off.ok, off.code], [false, 'offline']);
});

test('worker: claims a job, reports phases and success, cleans up its state file', async () => {
  const job = { requestId: 'r1', spec: { name: 'Git', sizeBytes: 10 } };
  const s = fakeSync((m, p) => {
    if (p.endsWith('/jobs/next')) return { job };
    if (p.endsWith('/progress')) return { continue: true };
    if (p.endsWith('/result')) return { status: 'SUCCEEDED' };
    return { items: [] };
  });
  const installer = { runJob: async (spec, h) => { h.onPhase('DOWNLOADING'); h.onProgress(5, 10); h.onPhase('INSTALLING'); h.onPhase('VERIFYING'); return { path: '/x' }; } };
  let after = 0;
  const a = agent(s, { installer, afterInstall: async () => { after += 1; } });
  await a._claimAndRun();
  const posts = s.calls.filter((c) => c.p.endsWith('/progress')).map((c) => c.body.phase);
  assert.ok(posts.includes('INSTALLING') && posts.includes('VERIFYING'));
  assert.deepEqual(s.calls.find((c) => c.p.endsWith('/result')).body, { ok: true });
  assert.equal(fs.existsSync(a.file), false, 'job state removed once delivered');
  assert.equal(a.busy, false);
  assert.equal(after, 1, 'installed apps are rescanned and reported');
});

test('worker: a failed install reports the reason code', async () => {
  const s = fakeSync((m, p) => (p.endsWith('/jobs/next') ? { job: { requestId: 'r1', spec: {} } } : { continue: true, items: [] }));
  const mk = (err) => agent(s, { installer: { runJob: async () => { throw err; } } });
  await mk(Object.assign(new Error('x'), { code: 'APP_IN_USE' }))._claimAndRun();
  assert.equal(s.calls.filter((c) => c.p.endsWith('/result')).at(-1).body.code, 'APP_IN_USE');
  await mk(new Error('something odd'))._claimAndRun();
  assert.equal(s.calls.filter((c) => c.p.endsWith('/result')).at(-1).body.code, 'INSTALL_FAILED', 'unknown errors never leak details as codes');
});

test('worker: an undeliverable result is kept on disk and delivered later', async () => {
  let online = false;
  const s = fakeSync((m, p) => {
    if (p.endsWith('/jobs/next')) return { job: { requestId: 'r1', spec: {} } };
    if (p.endsWith('/progress')) { if (!online) throw netErr(); return { continue: true }; }
    if (p.endsWith('/result')) { if (!online) throw netErr(); return {}; }
    return { items: [] };
  });
  const a = agent(s, { installer: { runJob: async () => ({}) } });
  await a._claimAndRun();
  assert.deepEqual(JSON.parse(fs.readFileSync(a.file, 'utf8')).result, { ok: true }, 'still saved');
  assert.equal(a.busy, false);
  online = true;
  await a._flushResult();
  assert.equal(fs.existsSync(a.file), false);
});

test('worker: a job the server closed (cancel/removed) aborts the install', async () => {
  let aborted = false;
  const s = fakeSync((m, p) => (p.endsWith('/jobs/next') ? { job: { requestId: 'r1', spec: {} } } : p.endsWith('/progress') ? { continue: false } : { items: [] }));
  const installer = { runJob: async (spec, h) => { await new Promise((r) => setTimeout(r, 30)); aborted = h.signal.aborted; if (aborted) throw Object.assign(new Error('x'), { code: 'INSTALL_INTERRUPTED' }); } };
  await agent(s, { installer })._claimAndRun();
  assert.equal(aborted, true);
});

test('worker: an install interrupted by a crash is reported on the next start', async () => {
  const dir = tmp('pp-crash-');
  fs.writeFileSync(path.join(dir, 'software-job.json'), JSON.stringify({ requestId: 'r9', startedAt: 1 }));
  const s = fakeSync(() => ({ job: null }));
  const a = new SoftwareAgent({ dir, sync: s, runningApps: async () => [], retryDelays: [1] });
  a.start();
  a.stop();
  await a._flushResult();
  const res = s.calls.find((c) => c.p.includes('/jobs/r9/result'));
  assert.equal(res.body.code, 'INSTALL_INTERRUPTED');
  assert.equal(fs.existsSync(path.join(dir, 'software-job.json')), false);
});

test('notifications fire on approval, rejection, success and failure only', () => {
  const sent = [];
  const a = agent(fakeSync(() => ({})), { notify: (t, b) => sent.push([t, b]) });
  const req = (status, extra = {}) => ({ id: 'r1', status, softwareName: 'Git', ...extra });
  a._track(req('AWAITING_APPROVAL'));      // first sighting: silent
  a._track(req('AWAITING_APPROVAL'));      // unchanged: silent
  a._track(req('QUEUED'));
  a._track(req('RUNNING'));                // progress: silent
  a._track(req('SUCCEEDED'));
  a._track({ id: 'r2', status: 'AWAITING_APPROVAL', softwareName: 'Slack' });
  a._track({ id: 'r2', status: 'REJECTED', softwareName: 'Slack', decisionComment: 'No licence' });
  a._track({ id: 'r3', status: 'RUNNING', softwareName: 'Zoom' });
  a._track({ id: 'r3', status: 'FAILED', softwareName: 'Zoom' });
  assert.deepEqual(sent.map((s) => s[0]), ['Install approved', 'Installed', 'Request declined', "Couldn't install"]);
  assert.match(sent[2][1], /No licence/);
});

test('the job id and prompt rules also live in the main process (renderer is not trusted)', () => {
  const main = fs.readFileSync(path.join(__dirname, '..', 'src', 'agent', 'main.js'), 'utf8');
  assert.match(main, /prompt\.length > 600/);
  assert.match(main, /UUID\.test\(id\)/);
});

test('removing the laptop stops the install and forgets its requests', () => {
  const a = agent(fakeSync(() => ({})));
  a.abort = new AbortController();
  a._track({ id: 'r1', status: 'RUNNING' });
  a._writeJob({ requestId: 'r1', startedAt: 1 });
  a.reset();
  assert.equal(a.abort.signal.aborted, true);
  assert.equal(a.known.size, 0);
  assert.equal(a.watching, 0);
  assert.equal(fs.existsSync(a.file), false, 'no leftover job to report to the next owner');
});

test('a .pkg counts as installed when its receipt exists, whatever the app inside is called', async () => {
  const calls = [];
  const yes = async (cmd, args) => { calls.push([cmd, ...args]); return ''; };
  const no = async () => { throw new Error('No receipt for package'); };
  assert.equal(await inst.pkgReceiptExists('us.zoom.pkg.videomeeting', yes), true);
  assert.deepEqual(calls, [['pkgutil', '--pkg-info', 'us.zoom.pkg.videomeeting']]);
  assert.equal(await inst.pkgReceiptExists('us.zoom.pkg.videomeeting', no), false);
  calls.length = 0;
  for (const odd of ['', null, undefined, '-v', 'a b', 'x; rm -rf /', '$(whoami)', 'ab', 'a'.repeat(300)]) assert.equal(await inst.pkgReceiptExists(odd, yes), false, String(odd));
  assert.deepEqual(calls, [], 'odd identifiers never reach a command');
});

test('real receipt lookup (a package that exists on every Mac, and one that does not)', { skip: !IS_MAC }, async () => {
  assert.equal(await inst.pkgReceiptExists('com.apple.pkg.CLTools_Executables'), await inst.pkgReceiptExists('com.apple.pkg.CLTools_Executables'));
  assert.equal(await inst.pkgReceiptExists('com.example.definitely.not.installed'), false);
});

test('the installed-apps list is refreshed before a request, so an uninstalled app is not reported as installed', async () => {
  const order = [];
  const s = fakeSync((m, p) => { order.push(`${m} ${p.split('/').pop()}`); return { id: 'r1', status: 'AWAITING_APPROVAL' }; });
  const a = agent(s, { refreshInventory: async () => { order.push('rescan+report'); } });
  await a.submit('install sublime text', 'key-12345678');
  assert.deepEqual(order, ['rescan+report', 'POST requests'], 'the fresh list goes up before the question is asked');
  await a.submit('install slack', 'key-22345678');
  assert.deepEqual(order.slice(2), ['POST requests'], 'not again within 15 seconds');
  await a.preview('install zoom');
  assert.equal(order.filter((x) => x === 'rescan+report').length, 1);
  a.inventoryAt = Date.now() - 20000;
  await a.preview('install zoom');
  assert.equal(order.filter((x) => x === 'rescan+report').length, 2, 'after 15 seconds it rescans again');
});

test('a failing or hanging rescan never blocks or fails the request', async () => {
  const broken = agent(fakeSync(() => ({ id: 'r1', status: 'AWAITING_APPROVAL' })), { refreshInventory: async () => { throw new Error('mdls failed'); } });
  assert.equal((await broken.submit('install git', 'key-12345678')).ok, true);
  const gated = agent(fakeSync(() => ({}), { enrolled: false }), { refreshInventory: async () => { throw new Error('must not run when not connected'); } });
  assert.equal((await gated.submit('install git', 'key-12345678')).code, 'not_enrolled');
});

test('reinstall is sent explicitly to the server', async () => {
  const s = fakeSync(() => ({ id: 'r1', status: 'QUEUED' }));
  const a = agent(s);
  await a.submit('reinstall sublime text', 'key-12345678', true);
  assert.equal(s.calls.at(-1).body.reinstall, true);
  await a.submit('install slack', 'key-22345678');
  assert.equal(s.calls.at(-1).body.reinstall, false);
});

test('apps added or removed are noticed within seconds, once things settle', async () => {
  const { watchApps } = require('../src/agent/appwatch');
  const waitFor = async (cond, ms = 5000) => { const end = Date.now() + ms; while (!cond() && Date.now() < end) await new Promise((r) => setTimeout(r, 40)); };
  const dir = tmp('pp-apps-');
  let changes = 0;
  const w = watchApps([dir, path.join(dir, 'missing')], () => { changes += 1; }, { debounceMs: 120 });
  assert.deepEqual(w.watching, [dir], 'a missing folder is skipped');
  await new Promise((r) => setTimeout(r, 300)); // macOS needs a moment to arm a new watcher
  fs.mkdirSync(path.join(dir, 'Sublime Text.app'));
  fs.mkdirSync(path.join(dir, 'Other.app'));
  await waitFor(() => changes >= 1);
  await new Promise((r) => setTimeout(r, 400));
  assert.equal(changes, 1, 'a burst of changes is reported once');
  fs.rmdirSync(path.join(dir, 'Sublime Text.app'));      // the employee uninstalls it
  await waitFor(() => changes >= 2);
  assert.equal(changes, 2);
  fs.writeFileSync(path.join(dir, '.DS_Store'), 'x');   // hidden files are not app changes
  await new Promise((r) => setTimeout(r, 500));
  assert.equal(changes, 2);
  w.close();
  fs.mkdirSync(path.join(dir, 'Late.app'));
  await new Promise((r) => setTimeout(r, 500));
  assert.equal(changes, 2, 'closed watchers stay quiet');
});

test('when the apps folders have changed, the list is refreshed even a moment after the last refresh (uninstall, then ask at once)', async () => {
  let rescans = 0;
  let folderState = 'a';
  const s = fakeSync(() => ({ id: 'r1', status: 'AWAITING_APPROVAL' }));
  let lastReported = '';
  const a = agent(s, { refreshInventory: async () => { rescans += 1; lastReported = folderState; }, inventoryUnchanged: () => folderState === lastReported });
  await a.submit('install sublime text', 'key-12345678');
  await a.submit('install slack', 'key-22345678');
  assert.equal(rescans, 1, 'nothing changed: no second rescan');
  folderState = 'b';                                  // the employee uninstalls an app
  await a.submit('install sublime text', 'key-32345678');
  assert.equal(rescans, 2, 'changed: rescanned straight away, not after the 15 s throttle');
  a.inventoryAt = Date.now() - 61000;
  await a.submit('install zoom', 'key-42345678');
  assert.equal(rescans, 3, 'and never trusted for more than a minute');
});
