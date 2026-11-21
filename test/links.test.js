'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('crypto');
const http = require('http');

const { extractInstallerLinks, classify } = require('../src/admin/links');
const I = require('../src/admin/inspect');

// Modelled on sublimetext.com/download_thanks (real links, trimmed).
const THANKS = `<html><body><ul>
<a href="https://download.sublimetext.com/sublime-text-4215-1-x86_64.pkg.tar.xz">Arch</a>
<a href="https://download.sublimetext.com/sublime-text-4215-1-x86_64.pkg.tar.xz.sig">sig</a>
<a href="https://download.sublimetext.com/sublime-text_build-4215_amd64.deb">deb</a>
<a href="https://download.sublimetext.com/sublime_text_build_4215_arm64.tar.xz">Linux</a>
<a href="https://download.sublimetext.com/sublime_text_build_4215_mac.zip">macOS</a>
<a href="https://download.sublimetext.com/sublime_text_build_4215_x64.zip">Windows portable</a>
<a href="https://download.sublimetext.com/sublime_text_build_4215_x64_setup.exe">Windows</a>
<a href="https://download.sublimetext.com/sublimehq-pub.gpg">key</a></ul></body></html>`;

// Modelled on sublimetext.com/download: links are templates filled in by JavaScript.
const DOWNLOAD_PAGE = `<html><body>
<li><a href="https://download.sublimetext.com/sublime_text_build_\${version}_mac.zip">macOS</a></li>
<li><a href="https://download.sublimetext.com/sublime_text_build_\${version}_x64_setup.exe">Windows</a></li>
<li><a href="https://download.sublimetext.com/sublime_text_build_\${version}_x64.zip">Windows zip</a></li>
<a href="https://download.sublimetext.com/sublime-text_build-4215_amd64.deb.sig">sig</a>
<script>let version_regex = /[0-9]{4}/</script></body></html>`;

test('a vendor page: the installers are found, signatures / Linux packages / Windows zips are not', () => {
  const links = extractInstallerLinks(THANKS, 'https://www.sublimetext.com/download_thanks?target=mac', { preferPlatform: 'darwin' });
  assert.deepEqual(links.map((l) => l.file), ['sublime_text_build_4215_mac.zip', 'sublime_text_build_4215_x64_setup.exe']);
  assert.deepEqual(links.map((l) => [l.platform, l.type, l.recommended]), [['darwin', 'zip', true], ['win32', 'exe', false]]);
});

test('the admin’s own platform is recommended first', () => {
  const links = extractInstallerLinks(THANKS, 'https://www.sublimetext.com/x', { preferPlatform: 'win32' });
  assert.equal(links[0].type, 'exe');
  assert.equal(links[0].recommended, true);
});

test('pages that fill the version in with JavaScript are resolved when the page agrees on one version', () => {
  const links = extractInstallerLinks(DOWNLOAD_PAGE, 'https://www.sublimetext.com/download', { preferPlatform: 'darwin' });
  assert.deepEqual(links.map((l) => l.url), [
    'https://download.sublimetext.com/sublime_text_build_4215_mac.zip',
    'https://download.sublimetext.com/sublime_text_build_4215_x64_setup.exe',
  ]);
  const unsure = extractInstallerLinks(`${DOWNLOAD_PAGE}<a href="https://x.example/a_9999_b.sig">x</a>`, 'https://www.sublimetext.com/download');
  assert.deepEqual(unsure, [], 'two different versions on the page: no guessing');
});

test('relative links, meta refresh, escaped JSON and download endpoints', () => {
  const html = `<meta http-equiv="refresh" content="0; url=/files/App-2.0.dmg">
    <a href="/dl/Tool.pkg?x=1&amp;y=2">pkg</a><script>var u = "https:\\/\\/cdn.example.com\\/Tool-1.0.msi";</script>
    <a href="/sha/download?build=stable&amp;os=darwin-universal">VS Code style</a><a href="/about">about</a><a href="javascript:void(0)">js</a>`;
  const links = extractInstallerLinks(html, 'https://vendor.example/download', { preferPlatform: 'darwin' });
  const urls = links.map((l) => l.url);
  assert.ok(urls.includes('https://vendor.example/files/App-2.0.dmg'), 'meta refresh');
  assert.ok(urls.includes('https://vendor.example/dl/Tool.pkg?x=1&y=2'), 'relative + decoded');
  assert.ok(urls.includes('https://cdn.example.com/Tool-1.0.msi'), 'escaped JSON');
  assert.ok(!urls.some((u) => u.includes('/about')));
  assert.ok(!urls.some((u) => u.includes('/sha/download')), 'download endpoints are not offered next to real installer files');
  // ...but they are the answer when a page has nothing else (VS Code / Firefox style pages).
  const onlyEndpoints = extractInstallerLinks('<a href="/sha/download?build=stable&amp;os=darwin-universal">Mac</a>', 'https://vendor.example/download', { preferPlatform: 'darwin' });
  assert.deepEqual(onlyEndpoints.map((l) => l.url), ['https://vendor.example/sha/download?build=stable&os=darwin-universal']);
  // The page's own address is never a candidate.
  assert.deepEqual(extractInstallerLinks('<a href="https://v.example/download_thanks?target=mac">x</a>', 'https://v.example/download_thanks?target=mac'), []);
});

test('unsupported archive links are refused before anything is downloaded', async () => {
  let hits = 0;
  const s = await site(() => { hits += 1; return { body: Buffer.alloc(10) }; });
  try {
    for (const f of ['a.tar.xz', 'a.deb', 'a.rpm', 'a.tar.gz', 'a.7z']) assert.equal((await I.inspectLink(`${s.base}/${f}`, { allowLoopbackHttp: true }).catch((e) => e)).code, 'UNSUPPORTED_ARCHIVE', f);
    assert.equal(hits, 0, 'nothing was fetched');
  } finally { await s.close(); }
});

test('only https, and never more than a handful of choices', () => {
  assert.deepEqual(extractInstallerLinks('<a href="http://x.example/a.dmg">a</a>', 'https://x.example/'), []);
  assert.equal(extractInstallerLinks('<a href="http://127.0.0.1:1/a.dmg">a</a>', 'http://127.0.0.1:1/', { allowHttp: true }).length, 1);
  const many = Array.from({ length: 30 }, (_, i) => `<a href="https://x.example/app${i}.dmg">a</a>`).join('');
  assert.equal(extractInstallerLinks(many, 'https://x.example/').length, 8);
  assert.equal(classify('https://x.example/portable-win-x64.zip'), null);
});

// ---- inspectLink on pages --------------------------------------------------------------------------------------------

function site(routes) {
  return new Promise((resolve) => {
    const srv = http.createServer((q, res) => {
      const r = routes(q);
      if (!r) { res.statusCode = 404; return res.end('no'); }
      res.setHeader('content-type', r.type || 'application/octet-stream');
      res.setHeader('content-length', r.body.length);
      res.end(r.body);
    });
    srv.listen(0, '127.0.0.1', () => { const base = `http://127.0.0.1:${srv.address().port}`; resolve({ base, close: () => new Promise((x) => srv.close(x)) }); });
  });
}
const html = (s) => ({ type: 'text/html', body: Buffer.from(s + ' '.repeat(600)) });
const exe = Buffer.concat([Buffer.from('MZ'), crypto.randomBytes(40 * 1024)]);
const opts = { allowLoopbackHttp: true };

test('a page with exactly one installer link is followed automatically', async () => {
  const s = await site((q) => (q.url === '/page' ? html('<a href="/files/Acme-1.2.0-setup.exe">Download</a>') : q.url === '/files/Acme-1.2.0-setup.exe' ? { body: exe } : null));
  try {
    const d = await I.inspectLink(`${s.base}/page`, opts);
    assert.equal(d.installerType, 'exe');
    assert.equal(d.downloadUrl, `${s.base}/files/Acme-1.2.0-setup.exe`);
    assert.equal(d.foundOn, `${s.base}/page`, 'the admin is told the link came from the page');
    assert.equal(d.sizeBytes, exe.length);
  } finally { await s.close(); }
});

test('a page with several installers asks which one (with a recommendation)', async () => {
  const s = await site((q) => (q.url === '/page' ? html('<a href="/a.dmg">mac</a><a href="/b.exe">win</a>') : null));
  try {
    const err = await I.inspectLink(`${s.base}/page`, opts).catch((e) => e);
    assert.equal(err.code, 'CHOOSE_LINK');
    assert.deepEqual(err.choices.map((c) => c.file), process.platform === 'win32' ? ['b.exe', 'a.dmg'] : ['a.dmg', 'b.exe']);
    assert.equal(err.choices.filter((c) => c.recommended).length, 1);
    assert.ok(I.friendly('CHOOSE_LINK').message.includes('more than one'));
  } finally { await s.close(); }
});

test('a page with no installer, a page of pages, and unsupported archives are explained', async () => {
  const s = await site((q) => ({
    '/empty': html('<h1>Sign in</h1><a href="/about">About</a>'),
    '/hop': html('<a href="/empty">next</a><a href="/x.dmg">dmg</a>'.replace('<a href="/x.dmg">dmg</a>', '')),
    '/pkg.tar.xz': { body: Buffer.concat([Buffer.from([0xfd, 0x37, 0x7a, 0x58, 0x5a, 0x00]), crypto.randomBytes(800)]) },
    '/pkg.deb': { body: Buffer.concat([Buffer.from('!<arch>\n'), crypto.randomBytes(800)]) },
    '/pkg.gz': { body: Buffer.concat([Buffer.from([0x1f, 0x8b, 8, 0]), crypto.randomBytes(800)]) },
  }[q.url] || null));
  try {
    for (const [p, code] of [['/empty', 'NOT_AN_INSTALLER'], ['/hop', 'NOT_AN_INSTALLER'], ['/pkg.tar.xz', 'UNSUPPORTED_ARCHIVE'], ['/pkg.deb', 'UNSUPPORTED_ARCHIVE'], ['/pkg.gz', 'UNSUPPORTED_ARCHIVE']]) {
      assert.equal((await I.inspectLink(`${s.base}${p}`, opts).catch((e) => e)).code, code, p);
    }
    assert.match(I.friendly('NOT_AN_INSTALLER').hint, /Copy Link Address/);
    assert.match(I.friendly('UNSUPPORTED_ARCHIVE').message, /\.tar\.xz/);
  } finally { await s.close(); }
});

test('a page that links to another page does not send the check around in circles', async () => {
  const s = await site((q) => (q.url === '/a' ? html('<a href="/b.exe">x</a>') : q.url === '/b.exe' ? html('<a href="/c.exe">y</a>') : null));
  try {
    // /b.exe is itself a web page (wrong file): one hop is allowed, a second is not.
    assert.equal((await I.inspectLink(`${s.base}/a`, opts).catch((e) => e)).code, 'NOT_AN_INSTALLER');
  } finally { await s.close(); }
});

test('the check identifies itself like a normal browser', async () => {
  let seen = '';
  const s = await site((q) => { seen = q.headers['user-agent'] || ''; return { body: exe }; });
  try { await I.inspectLink(`${s.base}/a.exe`, opts); assert.match(seen, /Mozilla\/5\.0/); } finally { await s.close(); }
});

test('ranking puts what was asked for first, using the button labels of a script-built page', () => {
  const { rankLinks } = require('../src/admin/links');
  const captured = [
    { url: 'https://zoom.us/client/latest/ZoomRooms.pkg', file: 'ZoomRooms.pkg', platform: 'darwin', type: 'pkg', label: 'Download Zoom Rooms Client' },
    { url: 'https://zoom.us/client/latest/Zoom.pkg', file: 'Zoom.pkg', platform: 'darwin', type: 'pkg', label: 'Download Zoom Workplace desktop client' },
    { url: 'https://zoom.us/client/latest/ZoomInstaller.exe', file: 'ZoomInstaller.exe', platform: 'win32', type: 'exe', label: 'Download Zoom Workplace' },
  ];
  const ranked = rankLinks(captured, { preferPlatform: 'darwin', hintName: 'Zoom Workplace' });
  assert.equal(ranked[0].file, 'Zoom.pkg', 'the Mac build of the named app leads');
  assert.equal(ranked.filter((l) => l.recommended).length, 1);
  assert.equal(rankLinks(captured, { preferPlatform: 'darwin' })[0].platform, 'darwin', 'without a name, the admin platform leads');
});

test('a page with no links in its HTML is opened like a browser, and what its buttons open is offered', async () => {
  let asked = null;
  const stages = [];
  const s = await site((q) => (q.url === '/download' ? html('<h1>Download Center</h1><button class="go">Download</button>') : q.url === '/files/Zoom.pkg' ? { body: exe } : null));
  try {
    const renderPage = async (u) => { asked = u; return [{ url: `${s.base}/files/Zoom.pkg`, file: 'Zoom.pkg', platform: 'win32', type: 'exe', label: 'Download Zoom Workplace' }]; };
    const d = await I.inspectLink(`${s.base}/download`, { ...opts, renderPage, hintName: 'Zoom Workplace', onStage: (x) => stages.push(x.stage) });
    assert.equal(asked, `${s.base}/download`);
    assert.ok(stages.includes('rendering'), 'the admin is told what is happening');
    assert.equal(d.downloadUrl, `${s.base}/files/Zoom.pkg`);
    assert.equal(d.foundOn, `${s.base}/download`);
    // several buttons: the admin chooses, with the button labels to go by
    const many = async () => [
      { url: `${s.base}/a`, file: 'a', platform: 'darwin', type: '', label: 'Download Zoom Rooms' },
      { url: `${s.base}/files/Zoom.pkg`, file: 'Zoom.pkg', platform: 'darwin', type: 'pkg', label: 'Download Zoom Workplace' },
    ];
    const err = await I.inspectLink(`${s.base}/download`, { ...opts, renderPage: many, hintName: 'Zoom Workplace' }).catch((e) => e);
    assert.equal(err.code, 'CHOOSE_LINK');
    assert.deepEqual(err.choices.map((c) => c.label), ['Download Zoom Workplace', 'Download Zoom Rooms']);
    // nothing captured, or the renderer fails: the usual explanation
    for (const rp of [async () => [], async () => { throw new Error('boom'); }]) {
      assert.equal((await I.inspectLink(`${s.base}/download`, { ...opts, renderPage: rp }).catch((e) => e)).code, 'NOT_AN_INSTALLER');
    }
    // a page that already has links never needs the renderer
    const never = async () => { throw new Error('should not be called'); };
    const s2 = await site((q) => (q.url === '/p' ? html('<a href="/x.exe">x</a>') : q.url === '/x.exe' ? { body: exe } : null));
    try { assert.equal((await I.inspectLink(`${s2.base}/p`, { ...opts, renderPage: never })).installerType, 'exe'); } finally { await s2.close(); }
  } finally { await s.close(); }
});

test('the hidden browser only allows public https requests', () => {
  const { allowedRequest } = require('../src/admin/render');
  for (const ok of ['https://zoom.us/download', 'https://cdn.zoom.us/prod/x.pkg', 'data:text/plain,hi', 'wss://live.example.com/socket']) assert.ok(allowedRequest(ok), ok);
  for (const bad of ['http://zoom.us/', 'https://127.0.0.1/', 'https://10.0.0.5/x', 'https://localhost/x', 'https://intranet/x', 'https://printer.local/', 'https://[::1]/', 'file:///etc/passwd', 'ftp://x.example/a', 'zoomus://zoom.us/router', 'not a url']) assert.ok(!allowedRequest(bad), bad);
});

test('the build for this laptop\'s processor is recommended', () => {
  const { rankLinks } = require('../src/admin/links');
  const list = [
    { url: 'https://v.example/arm/Z.pkg', file: 'Z.pkg', platform: 'darwin', type: 'pkg', label: 'Download Zoom Workplace for Apple silicon' },
    { url: 'https://v.example/intel/Z.pkg', file: 'Z.pkg', platform: 'darwin', type: 'pkg', label: 'Download Zoom Workplace for Intel' },
  ];
  assert.match(rankLinks(list, { preferArch: 'x64', hintName: 'Zoom' })[0].label, /Intel/);
  assert.match(rankLinks(list, { preferArch: 'arm64', hintName: 'Zoom' })[0].label, /Apple silicon/);
  assert.equal(rankLinks(list, { hintName: 'Zoom' }).length, 2, 'unknown processor: both stay on offer');
});

test('script-built pages: only real downloads are offered, not app stores or the page itself', () => {
  const { keepCaptured } = require('../src/admin/render');
  const page = 'https://zoom.us/download';
  for (const ok of ['https://zoom.us/client/latest/Zoom.pkg', 'https://cdn.zoom.us/prod/7.2.5/zoomusInstallerFull.pkg', 'https://zoom.us/client/latest/arm64/zoomusInstallerFull.pkg', 'https://x.example/download/mac']) assert.ok(keepCaptured(ok, page), ok);
  for (const bad of ['https://apps.apple.com/us/app/zoom/id546505307', 'https://play.google.com/store/apps/details?id=us.zoom', 'https://zoom.us/download', 'https://zoom.us/download#section', 'https://zoom.us/plugins/app.aspx', 'https://x.example/portable-win.zip', 'https://x.example/a.tar.xz', 'http://zoom.us/client/latest/Zoom.pkg', 'javascript:void(0)']) assert.ok(!keepCaptured(bad, page), bad);
});
