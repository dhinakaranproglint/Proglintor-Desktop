'use strict';
// Windows: frontmost window via a long-running PowerShell helper (Win32 GetForegroundWindow),
// installed apps from the registry Uninstall keys, history from the UserAssist registry key.
const { spawn } = require('child_process');
const path = require('path');
const { run, basename, NOT_APP_EXE } = require('./util');

const PS_ARGS = ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-EncodedCommand'];
const encode = (script) => Buffer.from(script, 'utf16le').toString('base64');

const FOREGROUND_SCRIPT = String.raw`
$ErrorActionPreference = 'SilentlyContinue'
[Console]::OutputEncoding = [Text.Encoding]::UTF8
Add-Type @"
using System; using System.Runtime.InteropServices; using System.Text;
public static class MMForeground {
  [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr h, out uint pid);
  [DllImport("user32.dll", CharSet = CharSet.Unicode)] public static extern int GetWindowText(IntPtr h, StringBuilder s, int n);
}
"@
while ($true) {
  $h = [MMForeground]::GetForegroundWindow()
  $procId = [uint32]0
  [void][MMForeground]::GetWindowThreadProcessId($h, [ref]$procId)
  $sb = New-Object System.Text.StringBuilder 512
  [void][MMForeground]::GetWindowText($h, $sb, 512)
  $p = Get-Process -Id $procId
  $o = [ordered]@{ pid = $procId; proc = $p.ProcessName; path = $p.Path; desc = $p.Description; product = $p.Product; title = $sb.ToString() }
  [Console]::Out.WriteLine(($o | ConvertTo-Json -Compress))
  [Console]::Out.Flush()
  Start-Sleep -Milliseconds 500
}
`;

const INSTALLED_SCRIPT = String.raw`
$ErrorActionPreference = 'SilentlyContinue'
[Console]::OutputEncoding = [Text.Encoding]::UTF8
$keys = @(
  @{ p = 'HKLM:\Software\Microsoft\Windows\CurrentVersion\Uninstall\*'; scope = 'machine' },
  @{ p = 'HKLM:\Software\WOW6432Node\Microsoft\Windows\CurrentVersion\Uninstall\*'; scope = 'machine' },
  @{ p = 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Uninstall\*'; scope = 'user' }
)
$apps = foreach ($k in $keys) {
  Get-ItemProperty $k.p | Where-Object { $_.DisplayName -and -not $_.SystemComponent -and -not $_.ParentKeyName -and -not $_.ReleaseType } |
    ForEach-Object { [ordered]@{ key = $_.PSChildName; name = $_.DisplayName; version = $_.DisplayVersion; publisher = $_.Publisher;
      location = $_.InstallLocation; icon = $_.DisplayIcon; date = $_.InstallDate; size = $_.EstimatedSize; scope = $k.scope } }
}
$ua = foreach ($g in Get-ChildItem 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Explorer\UserAssist') {
  $c = Get-Item (Join-Path $g.PSPath 'Count')
  if ($c) { foreach ($n in $c.GetValueNames()) { $v = $c.GetValue($n); if ($v -is [byte[]] -and $v.Length -ge 68) { [ordered]@{ n = $n; d = [Convert]::ToBase64String($v) } } } }
}
[ordered]@{ apps = @($apps); ua = @($ua) } | ConvertTo-Json -Depth 4 -Compress
`;

// ---- foreground window ------------------------------------------------------

function identityFromForeground(o) {
  if (!o || !o.pid) return null;
  const exe = basename(o.path) || (o.proc ? `${o.proc}.exe` : '');
  if (!exe) return null;
  // UWP apps (Settings, Calculator, ...) are hosted by ApplicationFrameHost; use the window title.
  if (/^applicationframehost\.exe$/i.test(exe) && o.title) {
    return { id: `uwp:${o.title.toLowerCase()}`, name: o.title, path: '', title: o.title };
  }
  return { id: exe.toLowerCase(), name: o.desc || o.product || o.proc || exe, path: o.path || '', title: o.title || '' };
}

function createWatcher() {
  let child = null;
  let latest = null;
  let latestAt = 0;
  let lastError = null;
  let stopped = false;
  let restarts = 0;
  const listeners = [];

  const start = () => {
    child = spawn('powershell.exe', [...PS_ARGS, encode(FOREGROUND_SCRIPT)], { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    let buf = '';
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (chunk) => {
      buf += chunk;
      let i;
      while ((i = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, i).trim();
        buf = buf.slice(i + 1);
        if (!line.startsWith('{')) continue;
        try {
          const next = identityFromForeground(JSON.parse(line));
          const changed = (next?.id || null) !== (latest?.id || null);
          latest = next;
          latestAt = Date.now();
          lastError = null;
          if (changed) listeners.forEach((fn) => fn(latest));
        } catch { /* skip */ }
      }
    });
    child.stderr.on('data', (d) => { lastError = String(d).trim().slice(0, 300); });
    child.on('error', (err) => { lastError = err.message; });
    child.on('exit', () => {
      child = null;
      if (!stopped) setTimeout(start, Math.min(30000, 1000 * 2 ** Math.min(restarts++, 5)));
    });
  };
  start();

  return {
    async getActive() {
      return Date.now() - latestAt < 5000 ? latest : null;
    },
    onChange(fn) { listeners.push(fn); },
    status() {
      if (Date.now() - latestAt < 5000) return { ok: true, message: 'Using Win32 foreground window (PowerShell helper)' };
      return { ok: false, message: lastError ? `Foreground helper error: ${lastError}` : 'Starting foreground window helper…' };
    },
    stop() { stopped = true; child?.kill(); },
  };
}

// ---- installed apps ---------------------------------------------------------

const rot13 = (s) => s.replace(/[a-z]/gi, (c) => String.fromCharCode((c <= 'Z' ? 65 : 97) + ((c.toLowerCase().charCodeAt(0) - 97 + 13) % 26)));

const KNOWN_FOLDERS = {
  '{6D809377-6AF0-444B-8957-A3773F02200E}': () => process.env.ProgramW6432 || process.env.ProgramFiles,
  '{7C5A40EF-A0FB-4BFC-874A-C0F2E0B9FA8E}': () => process.env['ProgramFiles(x86)'],
  '{1AC14E77-02E7-4E5D-B744-2EB1AE5198B7}': () => path.join(process.env.SystemRoot || 'C:\\Windows', 'System32'),
  '{F38BF404-1D43-42F2-9305-67DE0B28FC23}': () => process.env.SystemRoot || 'C:\\Windows',
  '{D65231B0-B2F1-4857-A4CE-A8E7C6EA7D27}': () => path.join(process.env.SystemRoot || 'C:\\Windows', 'SysWOW64'),
};

/** Decodes UserAssist entries into exe usage history: run count, focus time, last run. */
function decodeUserAssist(entries) {
  const out = [];
  for (const { n, d } of entries || []) {
    let name = rot13(n);
    for (const [guid, resolve] of Object.entries(KNOWN_FOLDERS)) {
      if (name.toUpperCase().startsWith(guid)) { name = (resolve() || guid) + name.slice(guid.length); break; }
    }
    if (!/\.exe$/i.test(name)) continue;
    const buf = Buffer.from(d, 'base64');
    if (buf.length < 68) continue;
    const ft = buf.readBigUInt64LE(60);
    const lastRun = ft > 0n ? Number(ft / 10000n) - 11644473600000 : null;
    out.push({ path: name, exe: basename(name).toLowerCase(), count: buf.readUInt32LE(4), focusMs: buf.readUInt32LE(12), lastRun: lastRun > 0 ? lastRun : null });
  }
  return out;
}

function cleanIconPath(icon) {
  if (!icon) return '';
  return String(icon).replace(/^"+|"+$/g, '').replace(/,\s*-?\d+$/, '').replace(/^"+|"+$/g, '').trim();
}

function parseInstallDate(s) {
  const m = /^(\d{4})(\d\d)(\d\d)$/.exec(String(s || ''));
  return m ? new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3])).getTime() : null;
}

function buildInstalledList(raw) {
  const history = decodeUserAssist(raw.ua);
  const seen = new Set();
  const apps = [];
  for (const r of raw.apps || []) {
    const dedupe = `${r.name}|${r.version || ''}`.toLowerCase();
    if (seen.has(dedupe)) continue;
    seen.add(dedupe);

    const icon = cleanIconPath(r.icon);
    const iconExe = /\.exe$/i.test(icon) ? basename(icon).toLowerCase() : '';
    const dir = String(r.location || '').replace(/^"+|"+$/g, '').replace(/[\\/]+$/, '') || (iconExe ? path.win32.dirname(icon) : '');
    const matchKeys = iconExe && !NOT_APP_EXE.test(iconExe) ? [iconExe] : [];

    // Usage history for exes that belong to this app (by name or by install folder).
    let lastUsed = null;
    let useCount = 0;
    const dirLower = dir.toLowerCase();
    for (const h of history) {
      const inDir = dirLower && h.path.toLowerCase().startsWith(dirLower + '\\');
      if ((matchKeys.includes(h.exe) || inDir) && !NOT_APP_EXE.test(h.exe)) {
        useCount += h.count;
        if (h.lastRun && (!lastUsed || h.lastRun > lastUsed)) lastUsed = h.lastRun;
        if (!matchKeys.includes(h.exe)) matchKeys.push(h.exe);
      }
    }

    apps.push({
      id: `win:${r.key}`,
      name: r.name,
      version: r.version || '',
      publisher: r.publisher || '',
      category: '',
      path: iconExe ? icon : dir,
      iconPath: icon && /\.(exe|ico|dll)$/i.test(icon) ? icon : '',
      installDir: dir,
      isSystem: /^microsoft (visual c\+\+|\.net|windows|edge webview|update health)/i.test(r.name),
      lastUsed,
      useCount: useCount || null,
      installedAt: parseInstallDate(r.date),
      sizeKB: r.size || null,
      matchKeys,
    });
  }
  return apps;
}

async function listInstalledApps() {
  const out = await run('powershell.exe', [...PS_ARGS, encode(INSTALLED_SCRIPT)], { timeout: 120000 });
  return buildInstalledList(JSON.parse(out.replace(/^\uFEFF/, '').trim() || '{}'));
}

const RUNNING_SCRIPT = String.raw`
$ErrorActionPreference = 'SilentlyContinue'
[Console]::OutputEncoding = [Text.Encoding]::UTF8
@(Get-Process | Where-Object { $_.MainWindowHandle -ne 0 } | ForEach-Object { [ordered]@{ pid = $_.Id; proc = $_.ProcessName; path = $_.Path; desc = $_.Description; product = $_.Product; title = $_.MainWindowTitle } }) | ConvertTo-Json -Compress
`;

/** Processes that currently have a window. */
async function listRunningApps() {
  const out = (await run('powershell.exe', [...PS_ARGS, encode(RUNNING_SCRIPT)], { timeout: 20000 })).replace(/^﻿/, '').trim();
  if (!out) return [];
  const list = JSON.parse(out);
  return (Array.isArray(list) ? list : [list]).map(identityFromForeground).filter(Boolean);
}

module.exports = {
  name: 'Windows',
  historySource: 'UserAssist registry (last run, run count)',
  createWatcher,
  listInstalledApps,
  listRunningApps,
  // Idle and lock state come from Electron's powerMonitor on Windows.
  _test: { identityFromForeground, decodeUserAssist, buildInstalledList, cleanIconPath, rot13 },
};
