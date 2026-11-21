'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');

const mac = require('../src/agent/platform/mac')._test;
const win = require('../src/agent/platform/windows')._test;
const linux = require('../src/agent/platform/linux')._test;
const { Catalog } = require('../src/agent/catalog');

test('macOS: parses lsappinfo output', () => {
  const out = '"LSDisplayName"="Code"\n"CFBundleIdentifier"="com.microsoft.VSCode"\n"LSBundlePath"="/Applications/Visual Studio Code.app"\n"pid"=3309\n';
  assert.deepEqual(mac.parseLsappinfo(out), { id: 'com.microsoft.VSCode', name: 'Code', path: '/Applications/Visual Studio Code.app', pid: 3309 });
});

test('macOS: parses mdls -raw output for several files', () => {
  const out = ['com.apple.Safari', 'Safari.app', '2026-11-18 15:28:42 +0000', '20', '18.0',
    '(null)', 'Foo.app', '(null)', '(null)', '(null)'].join('\0');
  const rows = mac.parseMdlsRaw(out, 2);
  assert.equal(rows[0].bundleID, 'com.apple.Safari');
  assert.equal(rows[0].lastUsed, Date.UTC(2026, 10, 18, 15, 28, 42));
  assert.equal(rows[0].useCount, 20);
  assert.equal(rows[1].bundleID, null);
  assert.equal(rows[1].useCount, null);
});

test('Windows: foreground identity, including UWP host', () => {
  assert.deepEqual(
    win.identityFromForeground({ pid: 10, proc: 'chrome', path: 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe', desc: 'Google Chrome', title: 'New Tab' }),
    { id: 'chrome.exe', name: 'Google Chrome', path: 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe', title: 'New Tab' },
  );
  assert.equal(win.identityFromForeground({ pid: 11, proc: 'ApplicationFrameHost', path: 'C:\\Windows\\System32\\ApplicationFrameHost.exe', title: 'Calculator' }).id, 'uwp:calculator');
  // Elevated processes may have no path.
  assert.equal(win.identityFromForeground({ pid: 12, proc: 'Taskmgr', path: null }).id, 'taskmgr.exe');
});

function userAssistEntry(path, count, lastRunMs) {
  const buf = Buffer.alloc(72);
  buf.writeUInt32LE(count, 4);
  buf.writeUInt32LE(60000, 12);
  buf.writeBigUInt64LE(BigInt(lastRunMs + 11644473600000) * 10000n, 60);
  return { n: win.rot13(path), d: buf.toString('base64') };
}

test('Windows: decodes UserAssist and links history to registry apps', () => {
  process.env.ProgramW6432 = 'C:\\Program Files';
  const last = Date.UTC(2026, 10, 1, 12, 0, 0);
  const raw = {
    apps: [
      { key: 'Google Chrome', name: 'Google Chrome', version: '131.0', publisher: 'Google LLC',
        location: 'C:\\Program Files\\Google\\Chrome\\Application', icon: '"C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",0', date: '20260115' },
      { key: 'Google Chrome dup', name: 'Google Chrome', version: '131.0' },
      { key: '7-Zip', name: '7-Zip 24.08', location: 'C:\\Program Files\\7-Zip\\', icon: 'C:\\Program Files\\7-Zip\\7zFM.exe' },
    ],
    ua: [userAssistEntry('{6D809377-6AF0-444B-8957-A3773F02200E}\\Google\\Chrome\\Application\\chrome.exe', 42, last)],
  };
  const apps = win.buildInstalledList(raw);
  assert.equal(apps.length, 2, 'duplicates removed');
  const chrome = apps.find((a) => a.name === 'Google Chrome');
  assert.equal(chrome.useCount, 42);
  assert.equal(chrome.lastUsed, last);
  assert.equal(chrome.installedAt, new Date(2026, 0, 15).getTime());
  assert.ok(chrome.matchKeys.includes('chrome.exe'));
  assert.equal(apps.find((a) => a.name.startsWith('7-Zip')).installDir, 'C:\\Program Files\\7-Zip');
  assert.equal(win.cleanIconPath('"C:\\x\\app.exe",-101'), 'C:\\x\\app.exe');
});

test('Linux: parses xprop output', () => {
  assert.equal(linux.parseXpropActive('_NET_ACTIVE_WINDOW(WINDOW): window id # 0x3c00007\n'), '0x3c00007');
  assert.equal(linux.parseXpropActive('_NET_ACTIVE_WINDOW(WINDOW): window id # 0x0\n'), null);
  const w = linux.parseXpropWindow('_NET_WM_PID(CARDINAL) = 4242\nWM_CLASS(STRING) = "Navigator", "firefox"\n_NET_WM_NAME(UTF8_STRING) = "Say \\"hi\\" - Mozilla Firefox"\n');
  assert.deepEqual(w, { pid: 4242, instance: 'Navigator', cls: 'firefox', title: 'Say "hi" - Mozilla Firefox' });
});

test('Linux: unwraps GNOME Window Calls D-Bus reply', () => {
  const out = `('[{"wm_class":"firefox","wm_class_instance":"Navigator","pid":42,"focus":true,"title":"It\\'s \\\\"quoted\\\\""}]',)\n`;
  const list = JSON.parse(linux.unwrapGVariantString(out));
  assert.equal(list[0].wm_class, 'firefox');
  assert.equal(list[0].title, 'It\'s "quoted"');
});

test('Linux: parses .desktop entries and Exec lines', () => {
  const e = linux.parseDesktopFile('[Desktop Entry]\nType=Application\nName=Files\nName[de]=Dateien\nExec=nautilus --new-window %U\nIcon=org.gnome.Nautilus\nStartupWMClass=org.gnome.Nautilus\n\n[Desktop Action new-window]\nName=New Window\nExec=nautilus --new-window\n');
  assert.equal(e.Name, 'Files');
  assert.equal(e.Exec, 'nautilus --new-window %U');
  assert.equal(linux.parseExec('env BAMF_DESKTOP_FILE_HINT=/x.desktop /snap/bin/firefox %u').programName, 'firefox');
  assert.equal(linux.parseExec('/usr/bin/flatpak run --branch=stable --arch=x86_64 --command=spotify com.spotify.Client').flatpakId, 'com.spotify.Client');
  assert.equal(linux.parseExec('"/opt/My App/app" --flag').programName, 'app');
});

test('Linux: parses GNOME application_state', () => {
  const xml = '<?xml version="1.0"?>\n<application-state>\n  <context id="">\n    <application id="firefox_firefox.desktop" open-window-count="1" score="120" last-seen="1763650000"/>\n  </context>\n</application-state>';
  assert.equal(linux.parseGnomeAppState(xml)['firefox_firefox.desktop'], 1763650000 * 1000);
});

test('Catalog: links tracked apps to installed apps on each OS', async () => {
  const cat = new Catalog({
    listInstalledApps: async () => [
      { id: 'win:chrome', name: 'Google Chrome', installDir: 'C:\\Program Files\\Google\\Chrome\\Application', matchKeys: ['chrome.exe'] },
      { id: 'win:vlc', name: 'VLC media player', installDir: 'C:\\Program Files\\VideoLAN\\VLC', matchKeys: [] },
      { id: 'win:bad', name: 'Too Generic', installDir: 'C:\\Program Files', matchKeys: [] },
      { id: 'com.apple.Safari', name: 'Safari', installDir: '/Applications/Safari.app', matchKeys: ['com.apple.Safari'] },
      { id: 'desktop:org.gnome.Nautilus', name: 'Files', installDir: '', matchKeys: ['org.gnome.nautilus', 'nautilus'] },
    ],
  });
  await cat.refresh();
  assert.equal(cat.match({ id: 'chrome.exe', path: '' })?.name, 'Google Chrome');
  assert.equal(cat.match({ id: 'vlc.exe', path: 'C:\\Program Files\\VideoLAN\\VLC\\vlc.exe' })?.name, 'VLC media player');
  assert.equal(cat.match({ id: 'other.exe', path: 'C:\\Program Files\\Other\\other.exe' }), null, 'generic dir must not match');
  assert.equal(cat.match({ id: 'com.apple.Safari', path: '/Applications/Safari.app' })?.name, 'Safari');
  assert.equal(cat.resolve({ id: 'org.gnome.nautilus', name: 'org.gnome.Nautilus', path: '/usr/bin/nautilus' }).name, 'Files');
});
