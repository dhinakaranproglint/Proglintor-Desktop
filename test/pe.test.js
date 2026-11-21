'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('crypto');
const fs = require('fs');
const http = require('http');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');

const { inspectExe, readVersionStrings } = require('../src/admin/pe');
const I = require('../src/admin/inspect');

const tmp = (p) => fs.mkdtempSync(path.join(os.tmpdir(), p));
const u16 = (s) => Buffer.from(s, 'utf16le');
const align4 = (n) => (n + 3) & ~3;

/** A VERSIONINFO string entry: wLength, wValueLength, wType, key, padding, value (as Inno Setup writes them, padded with spaces). */
function versionEntry(key, value) {
  const k = Buffer.concat([u16(key), Buffer.from([0, 0])]);
  const head = Buffer.alloc(6);
  const padded = Buffer.alloc(align4(6 + k.length) - 6 - k.length);
  const v = Buffer.concat([u16(value), Buffer.from([0, 0])]);
  const whole = Buffer.concat([head, k, padded, v]);
  whole.writeUInt16LE(whole.length, 0);
  whole.writeUInt16LE(value.length + 1, 2);
  whole.writeUInt16LE(1, 4);
  return Buffer.concat([whole, Buffer.alloc(align4(whole.length) - whole.length)]);
}

/** A minimal but structurally valid PE file. */
function buildExe({ signature = null, framework = 'Inno Setup Setup Data (6.2.0)', strings = {}, machine = 0x14c, bulk = 300 * 1024 } = {}) {
  const e = 0x80;
  const head = Buffer.alloc(0x400);
  head.write('MZ', 0, 'latin1');
  head.writeUInt32LE(e, 0x3c);
  head.write('PE\0\0', e, 'latin1');
  head.writeUInt16LE(machine, e + 4);
  head.writeUInt16LE(0x10b, e + 24);
  const body = Buffer.concat([
    Buffer.from(framework), Buffer.alloc(64),
    u16('VS_VERSION_INFO'), Buffer.alloc(8),
    ...Object.entries(strings).map(([k, v]) => versionEntry(k, v)), Buffer.alloc(64),
    crypto.randomBytes(bulk),
  ]);
  let file = Buffer.concat([head, body]);
  if (signature) {
    const cert = Buffer.alloc(8 + signature.length);
    cert.writeUInt32LE(cert.length, 0);
    cert.writeUInt16LE(0x200, 4);
    cert.writeUInt16LE(2, 6);
    signature.copy(cert, 8);
    const at = align4(file.length);
    file = Buffer.concat([file, Buffer.alloc(at - file.length), cert]);
    file.writeUInt32LE(at, e + 24 + 96 + 32);
    file.writeUInt32LE(cert.length, e + 24 + 96 + 36);
  }
  return file;
}

/** A real PKCS#7 signature (self-signed "Acme Corp"), made with openssl. Null when openssl isn't available. */
function pkcs7() {
  try {
    const d = tmp('pp-sig-');
    execFileSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-subj', '/C=IN/O=Acme Corp/CN=Acme Corp', '-keyout', `${d}/k.pem`, '-out', `${d}/c.pem`, '-days', '2'], { stdio: 'ignore' });
    fs.writeFileSync(`${d}/data`, 'x');
    return execFileSync('openssl', ['smime', '-sign', '-binary', '-noattr', '-in', `${d}/data`, '-signer', `${d}/c.pem`, '-inkey', `${d}/k.pem`, '-outform', 'DER']);
  } catch { return null; }
}
const SIG = pkcs7();
const write = (buf) => { const f = path.join(tmp('pp-exe-'), 'setup.exe'); fs.writeFileSync(f, buf); return f; };

test('version resource strings are read, padding trimmed', () => {
  const block = Buffer.concat([u16('VS_VERSION_INFO'), Buffer.alloc(8), versionEntry('CompanyName', 'Sublime HQ Pty Ltd      '), versionEntry('ProductName', 'Sublime Text   '), versionEntry('FileVersion', '   ')]);
  assert.deepEqual(readVersionStrings(block), { CompanyName: 'Sublime HQ Pty Ltd', ProductName: 'Sublime Text' }, 'blank values are left out');
});

test('a Windows installer: name, company, framework and silent options', async () => {
  const r = await inspectExe(write(buildExe({ strings: { ProductName: 'Acme Notes', CompanyName: 'Acme Corp', FileDescription: 'Acme Notes Setup', ProductVersion: '3.1.4.0' } })));
  assert.equal(r.valid, true);
  assert.equal(r.productName, 'Acme Notes');
  assert.equal(r.company, 'Acme Corp');
  assert.equal(r.version, '3.1.4.0');
  assert.equal(r.framework, 'inno');
  assert.deepEqual(r.silentArgs, ['/VERYSILENT', '/SUPPRESSMSGBOXES', '/NORESTART', '/SP-']);
  assert.equal(r.signed, false);
});

test('other installer frameworks get their own standard silent options', async () => {
  const cases = [['Nullsoft Install System v3.08', 'nsis', ['/S']], ['.wixburn', 'burn', ['/quiet', '/norestart']], ['Squirrel.Windows', 'squirrel', ['--silent']]];
  for (const [marker, id, args] of cases) {
    const r = await inspectExe(write(buildExe({ framework: marker })));
    assert.equal(r.framework, id);
    assert.deepEqual(r.silentArgs, args);
  }
  const unknown = await inspectExe(write(buildExe({ framework: 'something custom' })));
  assert.deepEqual([unknown.framework, unknown.silentArgs], ['', []], 'an unknown installer is not guessed at');
  assert.deepEqual((await inspectExe(write(buildExe({ framework: 'InstallShield' })))).silentArgs, [], 'InstallShield options vary per package');
});

test('the signature: present or absent, and who signed it', { skip: !SIG }, async () => {
  const signed = await inspectExe(write(buildExe({ signature: SIG })));
  assert.equal(signed.signed, true);
  assert.equal(signed.signer, 'Acme Corp');
  // a blob that isn't a readable signature still counts as "signed" (the laptop checks it for real), just without a name
  const odd = await inspectExe(write(buildExe({ signature: crypto.randomBytes(300) })));
  assert.deepEqual([odd.signed, odd.signer], [true, '']);
});

test('files that are not Windows programs are reported as unreadable, never as an error', async () => {
  assert.equal((await inspectExe(write(Buffer.concat([Buffer.from('MZ'), crypto.randomBytes(5000)])))).valid, false);
  assert.equal((await inspectExe(write(Buffer.from('MZ')))).valid, false);
  assert.equal((await inspectExe(write(Buffer.alloc(100)))).valid, false);
});

test('names, versions and processors from file names', () => {
  const name = (f) => I.nameFromFile(`https://x.example/dl/${f}`);
  assert.equal(name('sublime_text_build_4215_x64_setup.exe'), 'Sublime Text');
  assert.equal(name('Visual-Studio-Code-1.140.0-universal.zip'), 'Visual Studio Code');
  assert.equal(name('Acme_Tool_2.5.1_x64_setup.exe'), 'Acme Tool');
  assert.equal(name('firefox-128.0.dmg'), 'Firefox');
  assert.equal(name('Slack-4.53.292-macOS.dmg'), 'Slack');
  assert.equal(name('Git-2.45.0-64-bit.exe'), 'Git');
  assert.equal(name('windows-terminal-1.20.msi'), 'Terminal');
  const version = (f) => I.versionFromFile(`https://x.example/${f}`);
  assert.equal(version('sublime_text_build_4215_x64_setup.exe'), '4215');
  assert.equal(version('Acme_Tool_2.5.1_x64_setup.exe'), '2.5.1');
  assert.equal(version('App-v3.2.dmg'), '3.2');
  assert.equal(version('Setup.exe'), '');
  const arch = (f) => I.archFromFile(`https://x.example/${f}`);
  assert.equal(arch('sublime_text_build_4215_x64_setup.exe'), 'x64');
  assert.equal(arch('app-arm64.msi'), 'arm64');
  assert.equal(arch('app_amd64.exe'), 'x64');
  assert.equal(arch('app-aarch64.exe'), 'arm64');
  assert.equal(arch('Setup.exe'), 'any');
});

// ---- the whole add flow, with a Windows installer from a local server -------------------------------------------------------

function serve(buf, name = 'Acme-Notes-2.5.1-x64-setup.exe') {
  return new Promise((resolve) => {
    const srv = http.createServer((_q, res) => { res.setHeader('content-length', buf.length); res.end(buf); });
    srv.listen(0, '127.0.0.1', () => resolve({ url: `http://127.0.0.1:${srv.address().port}/${name}`, close: () => new Promise((r) => srv.close(r)) }));
  });
}
const opts = { allowLoopbackHttp: true };

test('adding an Inno Setup .exe needs nothing typed: name, version, processor and silent options are filled in', { skip: !SIG }, async () => {
  const s = await serve(buildExe({ signature: SIG, strings: { ProductName: 'Acme Notes', CompanyName: 'Acme Corp', FileDescription: 'Acme Notes Setup' } }));
  try {
    const d = await I.inspectLink(s.url, opts);
    assert.equal(d.name, 'Acme Notes', 'from the installer itself, not the file name');
    assert.equal(d.version, '2.5.1', 'the file says nothing, so the file name is used');
    assert.equal(d.arch, 'x64');
    assert.equal(d.platform, 'win32');
    assert.equal(d.installerType, 'exe');
    assert.deepEqual(d.silentArgs, ['/VERYSILENT', '/SUPPRESSMSGBOXES', '/NORESTART', '/SP-']);
    assert.equal(d.publisher, 'Acme Corp');
    assert.equal(d.signedBy, 'Acme Corp');
    assert.equal(d.verified, false, "a Windows signature can't be proven valid on this computer");
    const codes = d.warnings.map((w) => w.code);
    assert.ok(codes.includes('SIGNATURE_NOT_VERIFIED_HERE') && codes.includes('SILENT_DETECTED'));
    assert.ok(!codes.includes('NEEDS_SILENT_ARGS'));
    assert.ok(d.warnings.filter((w) => w.tone === 'info').length === 2, 'these are information, not alarms');
    assert.deepEqual(d.aliases, ['acmenotes']);
  } finally { await s.close(); }
});

test('an unknown installer type still asks for the silent options', { skip: !SIG }, async () => {
  const s = await serve(buildExe({ framework: 'custom', signature: SIG, strings: { ProductName: 'Acme Notes' } }));
  try {
    const d = await I.inspectLink(s.url, opts);
    assert.deepEqual(d.silentArgs, []);
    assert.ok(d.warnings.some((w) => w.code === 'NEEDS_SILENT_ARGS'));
  } finally { await s.close(); }
});

test('an installer with no digital signature at all is refused (laptops would refuse it too)', async () => {
  const s = await serve(buildExe({ signature: null, strings: { ProductName: 'Acme Notes' } }));
  try {
    const err = await I.inspectLink(s.url, opts).catch((e) => e);
    assert.equal(err.code, 'UNSIGNED_EXE');
    assert.match(I.friendly('UNSIGNED_EXE').message, /isn't digitally signed/);
  } finally { await s.close(); }
});

// The real Sublime Text installer, when it has been downloaded for this run: SUBLIME_EXE=/path/to/sublime_text_build_4215_x64_setup.exe
test('the real Sublime Text installer is understood', { skip: !process.env.SUBLIME_EXE || !fs.existsSync(process.env.SUBLIME_EXE) }, async () => {
  const r = await inspectExe(process.env.SUBLIME_EXE);
  assert.deepEqual([r.productName, r.company, r.framework, r.signed, r.signer], ['Sublime Text', 'Sublime HQ Pty Ltd', 'inno', true, 'Sublime HQ Pty Ltd']);
  assert.equal(r.issuer, 'DigiCert');
});

test('the version: the installer says it, else the download address, else the file name; placeholders do not count', () => {
  assert.equal(I.versionFromUrl('https://cdn.zoom.us/prod/7.2.5.90525/zoomusInstallerFull.pkg'), '7.2.5.90525');
  assert.equal(I.versionFromUrl('https://x.example/releases/v3.4/App.dmg'), '3.4');
  assert.equal(I.versionFromUrl('https://x.example/download/latest/App.dmg'), '');
  assert.equal(I.versionFromUrl('not a url'), '');
});

test('pasted links are tidied', () => {
  const clean = I.cleanLinkInput;
  assert.equal(clean('$https://zoom.us/download'), 'https://zoom.us/download', 'a shell prompt symbol stuck to the link');
  assert.equal(clean('  <https://zoom.us/download>  '), 'https://zoom.us/download');
  assert.equal(clean('"https://zoom.us/download",'), 'https://zoom.us/download');
  assert.equal(clean('curl -LO https://x.example/a.dmg'), 'https://x.example/a.dmg');
  assert.equal(clean('(see https://x.example/a.dmg).'), 'https://x.example/a.dmg');
  assert.equal(clean('https://x.example/a?b=1&c=2'), 'https://x.example/a?b=1&c=2', 'a real address is left alone');
  for (const none of ['', 'zoom', 'ftp://x.example/a', null, undefined]) assert.equal(clean(none), '', String(none));
});
