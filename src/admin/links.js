'use strict';
// People paste the vendor's *download page* ("sublimetext.com/download") instead of the installer's own link. This module reads
// such a page and finds the real installer links in it, so the admin doesn't have to hunt for them.
//
// Only supported installer types are returned (.dmg, .zip, .pkg, .msi, .exe, AppImage). Signature files (.sig/.asc), Linux packages
// (.deb/.rpm/.tar.xz), unfilled templates (`${version}`) and Windows/portable zips are left out.

const TYPE_RANK = { dmg: 0, zip: 1, pkg: 2, msi: 3, exe: 4, appimage: 5 };
const PLATFORM_ORDER = { darwin: 0, win32: 1, linux: 2 };
const MAX_LINKS = 8;

/** HTML/JSON escapes that commonly hide inside page source. */
function decode(text) {
  return text
    .replaceAll('&amp;', '&').replaceAll('&quot;', '"').replaceAll('&#x3D;', '=').replaceAll('&#x3d;', '=').replaceAll('&#61;', '=')
    .replaceAll(String.raw`&`, '&').replaceAll(String.raw`\/`, '/');
}

const isTemplate = (raw) => /\$\{|\{\{|%7B%7B|%24%7B/i.test(raw);

/** Platform a download is built for, judged from its address. Windows/Linux zips are 'other' (not installable). */
function classify(url) {
  const p = new URL(url).pathname.toLowerCase();
  const q = new URL(url).search.toLowerCase();
  const ext = (/\.([a-z]+)$/.exec(p) || [])[1] || '';
  if (ext === 'msi' || ext === 'exe') return { platform: 'win32', type: ext };
  if (ext === 'appimage') return { platform: 'linux', type: 'appimage' };
  if (ext === 'dmg' || ext === 'pkg') return { platform: 'darwin', type: ext };
  if (ext === 'zip') {
    if (/(mac|osx|darwin|universal)/.test(p)) return { platform: 'darwin', type: 'zip' };
    if (/(win|x64|x86|portable|msvc|linux)/.test(p)) return null; // a Windows/portable zip: laptops can't install it
    return { platform: 'darwin', type: 'zip' }; // unlabelled zip: most likely a Mac app, the check will say if not
  }
  // No file extension: a "download" endpoint that redirects to the file (e.g. ...?os=darwin-universal).
  if (/download|latest|release/.test(p + q) && /(darwin|osx|macos|\bmac\b)/.test(p + q)) return { platform: 'darwin', type: '' };
  return null;
}

/**
 * @param {string} html     page source
 * @param {string} baseUrl  page address (relative links are resolved against it)
 * @param {{allowHttp?:boolean, preferPlatform?:string}} opts
 * @returns {{url:string,file:string,platform:string,type:string,recommended:boolean}[]} best first
 */
function extractInstallerLinks(html, baseUrl, opts = {}) {
  const { allowHttp = false, preferPlatform = process.platform, hintName = '', preferArch = '' } = opts;
  const text = decode(String(html || '').slice(0, 2_000_000));
  const raws = new Set();
  for (const m of text.matchAll(/(?:href|src|data-href|data-url|data-download)\s*=\s*["']([^"']+)["']/gi)) raws.add(m[1]);
  for (const m of text.matchAll(/http-equiv\s*=\s*["']refresh["'][^>]*content\s*=\s*["'][^"']*url\s*=\s*([^"']+)["']/gi)) raws.add(m[1]);
  for (const m of text.matchAll(/https?:\/\/[^\s"'<>\\]+/gi)) raws.add(m[0]); // addresses sitting in scripts or JSON

  // Pages that fill the version in with JavaScript ("…_${version}_mac.zip"): if the page's real links agree on one version, use it.
  const versions = new Set();
  for (const raw of raws) {
    if (isTemplate(raw)) continue;
    const m = /[_-](\d{3,}(?:\.\d+)*)(?=[_.-])/.exec(raw.split('?')[0].split('/').pop() || '');
    if (m) versions.add(m[1]);
  }
  const version = versions.size === 1 ? [...versions][0] : '';

  const seen = new Set();
  const found = [];
  for (let raw of raws) {
    if (version && /\$\{version\}|\{version\}/.test(raw)) raw = raw.replace(/\$\{version\}|\{version\}/g, version);
    if (isTemplate(raw)) continue;
    let u;
    try { u = new URL(raw.trim().replace(/[)\],.;]+$/, ''), baseUrl); } catch { continue; }
    if (u.protocol !== 'https:' && !(allowHttp && u.protocol === 'http:')) continue;
    u.hash = '';
    const key = u.toString();
    if (seen.has(key)) continue;
    seen.add(key);
    const kind = classify(key);
    if (!kind) continue;
    let file = '';
    try { file = decodeURIComponent(u.pathname.split('/').filter(Boolean).pop() || ''); } catch { file = ''; }
    found.push({ url: key, file: file || `${u.hostname} download`, platform: kind.platform, type: kind.type });
  }

  // "Download endpoints" (no file extension) are only a fallback for pages that have no real installer files; the page itself is never one.
  const self = new URL(baseUrl).toString();
  const real = found.filter((l) => l.type);
  const candidates = real.length ? real : found.filter((l) => l.url !== self);
  found.length = 0;
  found.push(...candidates);

  return rankLinks(found, { preferPlatform, hintName, preferArch });
}

/**
 * Orders candidate downloads: the ones that name the software being looked for first, then the admin's own platform, then
 * dmg > zip > pkg > msi > exe. Marks the best as recommended and keeps at most a handful.
 */
const ARCH_WORDS = { x64: /intel|x64|x86[_-]?64|amd64/i, arm64: /apple\s*silicon|arm64|aarch64|\bm[1-9]\b/i };

function rankLinks(list, { preferPlatform = process.platform, hintName = '', preferArch = '' } = {}) {
  const tokens = String(hintName || '').toLowerCase().match(/[a-z0-9]{3,}/g) || [];
  const mention = (l) => {
    const text = `${l.label || ''} ${l.file || ''}`.toLowerCase();
    return tokens.filter((t) => text.includes(t)).length;
  };
  // A build that says it is for this laptop's processor ("for Intel", "arm64") beats one that says it is for the other.
  const archFit = (l) => {
    if (!preferArch || !ARCH_WORDS[preferArch]) return 1;
    const text = `${l.label || ''} ${l.file || ''}`;
    const other = preferArch === 'x64' ? 'arm64' : 'x64';
    if (ARCH_WORDS[preferArch].test(text)) return 0;
    return ARCH_WORDS[other].test(text) ? 2 : 1;
  };
  const rank = (l) => [
    -mention(l),
    archFit(l),
    l.type ? 0 : 1,
    l.platform === preferPlatform ? 0 : 1 + (PLATFORM_ORDER[l.platform] ?? 3),
    TYPE_RANK[l.type] ?? 9,
    l.url.length,
  ];
  const out = [...list].sort((a, b) => { const x = rank(a); const y = rank(b); for (let i = 0; i < x.length; i += 1) if (x[i] !== y[i]) return x[i] - y[i]; return 0; }).slice(0, MAX_LINKS);
  return out.map((l, i) => ({ ...l, recommended: i === 0 }));
}

module.exports = { extractInstallerLinks, rankLinks, classify };
