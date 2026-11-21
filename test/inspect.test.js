'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('crypto');
const fs = require('fs');
const http = require('http');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');

const I = require('../src/admin/inspect');
const presets = require('../src/admin/presets');

const IS_MAC = process.platform === 'darwin';
const tmp = (p) => fs.mkdtempSync(path.join(os.tmpdir(), p));
const sha = (b) => crypto.createHash('sha256').update(b).digest('hex');
function serve(body, { status = 200 } = {}) {
  return new Promise((resolve) => {
    const srv = http.createServer((_q, res) => { res.statusCode = status; res.setHeader('content-length', body.length); res.end(body); });
    srv.listen(0, '127.0.0.1', () => resolve({ url: `http://127.0.0.1:${srv.address().port}/Acme-Tool-2.5.1-x64-setup.exe`, close: () => new Promise((r) => srv.close(r)) }));
  });
}
const code = async (p) => { try { await p; } catch (e) { return e.code; } return null; };
const file = (bytes) => { const f = path.join(tmp('pp-det-'), 'f.bin'); fs.writeFileSync(f, bytes); return f; };

test('file type comes from the bytes, not the link', async () => {
  const pad = Buffer.alloc(2000);
  assert.deepEqual(await I.detectKind(file(Buffer.concat([Buffer.from('PK\x03\x04'), pad]))), { type: 'zip', platform: 'darwin' });
  assert.deepEqual(await I.detectKind(file(Buffer.concat([Buffer.from('xar!'), pad]))), { type: 'pkg', platform: 'darwin' });
  assert.deepEqual(await I.detectKind(file(Buffer.concat([Buffer.from('MZ'), pad]))), { type: 'exe', platform: 'win32' });
  assert.deepEqual(await I.detectKind(file(Buffer.concat([Buffer.from([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1]), pad]))), { type: 'msi', platform: 'win32' });
  assert.deepEqual(await I.detectKind(file(Buffer.concat([Buffer.from('\x7fELF'), pad]))), { type: 'appimage', platform: 'linux' });
  assert.deepEqual(await I.detectKind(file(Buffer.concat([Buffer.alloc(1000), Buffer.from('koly'), Buffer.alloc(508)]))), { type: 'dmg', platform: 'darwin' });
  assert.equal(await code(I.detectKind(file(Buffer.from('<!DOCTYPE html><html>sign in</html>' + ' '.repeat(600))))), 'NOT_AN_INSTALLER');
  assert.equal(await code(I.detectKind(file(crypto.randomBytes(900)))), 'UNSUPPORTED_FORMAT');
});

test('names are suggested from file names', () => {
  assert.equal(I.nameFromFile('https://x.example/Visual-Studio-Code-1.140.0-universal.zip'), 'Visual Studio Code');
  assert.equal(I.nameFromFile('https://x.example/dl/Acme_Tool_2.5.1_x64_setup.exe'), 'Acme Tool');
  assert.equal(I.nameFromFile('https://x.example/Firefox%20128.0.dmg'), 'Firefox');
  assert.deepEqual(I.aliasesFor('Visual Studio Code'), ['visualstudiocode']);
  assert.deepEqual(I.aliasesFor('Git'), []);
});

test('every failure has a plain explanation and a next step', () => {
  for (const c of ['LINK_NOT_HTTPS', 'DOWNLOAD_FAILED', 'NOT_AN_INSTALLER', 'UNSUPPORTED_FORMAT', 'UNSIGNED', 'SIGNATURE_INVALID', 'TEAM_MISMATCH', 'LICENSE_PROMPT', 'UNSAFE_ARCHIVE']) {
    const f = I.friendly(c);
    assert.ok(f.message.length > 15 && f.hint.length > 10, c);
    assert.doesNotMatch(f.message + f.hint, /[A-Z]{3,}_[A-Z_]{3,}/);
  }
  assert.ok(I.friendly('SOMETHING_NEW').message);
});

test('popular apps carry the vendor Team ID that the download must be signed by', () => {
  assert.ok(presets.PRESETS.length >= 5);
  for (const p of presets.PRESETS) {
    assert.match(p.url, /^https:\/\//, p.id);
    assert.match(p.teamId, /^[A-Z0-9]{10}$/, p.id);
  }
  assert.equal(presets.byId('slack').teamId, 'BQR82RBBHL');
  assert.equal(presets.byId('nope'), null);
  assert.deepEqual(Object.keys(presets.listPresets()[0]).sort(), ['description', 'id', 'name', 'publisher'], 'the list shown to the admin carries no URLs');
});

test('link check: measures the file and needs nothing typed (non-Mac installer)', async () => {
  const exe = Buffer.concat([Buffer.from('MZ'), crypto.randomBytes(120 * 1024)]);
  const s = await serve(exe);
  try {
    const stages = [];
    const d = await I.inspectLink(s.url, { allowLoopbackHttp: true, onStage: (st) => stages.push(st.stage) });
    assert.equal(d.sha256, sha(exe));
    assert.equal(d.sizeBytes, exe.length);
    assert.equal(d.installerType, 'exe');
    assert.equal(d.platform, 'win32');
    assert.equal(d.name, 'Acme Tool', 'name suggested from the file name');
    assert.equal(d.verified, false);
    assert.ok(d.warnings.some((w) => w.code === 'NEEDS_SILENT_ARGS'));
    assert.ok(stages.includes('downloading') && stages.includes('checking'));
  } finally { await s.close(); }
});

test('link check: refusals are specific', async () => {
  assert.equal(await code(I.inspectLink('http://example.com/a.dmg')), 'LINK_NOT_HTTPS');
  assert.equal(await code(I.inspectLink('not a link')), 'LINK_NOT_HTTPS');
  const html = await serve(Buffer.from('<!doctype html><html><body>Download page</body></html>' + ' '.repeat(600)));
  const gone = await serve(Buffer.from('nope'), { status: 404 });
  try {
    assert.equal(await code(I.inspectLink(html.url, { allowLoopbackHttp: true })), 'NOT_AN_INSTALLER');
    assert.equal(await code(I.inspectLink(gone.url, { allowLoopbackHttp: true })), 'DOWNLOAD_FAILED');
  } finally { await html.close(); await gone.close(); }
  const ac = new AbortController();
  const slow = await new Promise((resolve) => { const srv = http.createServer((_q, res) => { res.write('x'); }); srv.listen(0, '127.0.0.1', () => resolve(srv)); });
  try {
    const p = I.inspectLink(`http://127.0.0.1:${slow.address().port}/x`, { allowLoopbackHttp: true, signal: ac.signal });
    setTimeout(() => ac.abort(), 150);
    assert.equal(await code(p), 'CANCELLED');
  } finally { slow.closeAllConnections(); slow.close(); }
});

test('mac: an unsigned app is refused, and nothing is left behind', { skip: !IS_MAC }, async () => {
  const work = tmp('pp-zip-');
  const app = path.join(work, 'Fake.app');
  fs.mkdirSync(path.join(app, 'Contents', 'MacOS'), { recursive: true });
  fs.writeFileSync(path.join(app, 'Contents', 'Info.plist'), '<?xml version="1.0"?><plist version="1.0"><dict><key>CFBundleIdentifier</key><string>com.example.fake</string></dict></plist>');
  fs.writeFileSync(path.join(app, 'Contents', 'MacOS', 'run'), '#!/bin/sh\n');
  execFileSync('ditto', ['-c', '-k', '--keepParent', app, path.join(work, 'fake.zip')]);
  const s = await serve(fs.readFileSync(path.join(work, 'fake.zip')));
  const root = tmp('pp-root-'); // its own temp folder, so tests running in parallel can't interfere
  try {
    assert.equal(await code(I.inspectLink(s.url.replace('.exe', '.zip'), { allowLoopbackHttp: true, tempRoot: root })), 'UNSIGNED', 'an app that was never signed is called unsigned, not damaged');
  } finally { await s.close(); }
  assert.deepEqual(fs.readdirSync(root), [], 'temp files removed');
});

const VSCODE = '/Applications/Visual Studio Code.app';
test('mac: a genuinely signed app is read and verified (real codesign + Gatekeeper)', { skip: !IS_MAC || !fs.existsSync(VSCODE), timeout: 240000 }, async () => {
  const d = await I.inspectApp(VSCODE);
  assert.equal(d.verified, true);
  assert.equal(d.appId, 'com.microsoft.VSCode');
  assert.equal(d.teamId, 'UBF8T346G9');
  assert.match(d.publisher, /Microsoft/);
  assert.match(d.version, /^\d+\.\d+/);
  assert.equal(d.appName, 'Visual Studio Code.app');
  assert.match(d.icon, /^data:image\/png;base64,[A-Za-z0-9+/=]{200,}$/, 'the app icon is read from the bundle');
  assert.ok(d.icon.length < 160 * 1024);
  assert.ok(['any', 'arm64', 'x64'].includes(d.arch));
});

test('mac: Apple’s own apps (no Team ID) are not accepted for the catalogue', { skip: !IS_MAC || !fs.existsSync('/System/Applications/Calculator.app'), timeout: 120000 }, async () => {
  assert.equal(await code(I.inspectApp('/System/Applications/Calculator.app')), 'UNSIGNED');
});
