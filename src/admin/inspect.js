'use strict';
// "Add software" without typing technical details: the admin gives a download link (or picks a popular app) and this module
// downloads the file, works out what it is, reads its name / version / identifier / signer, verifies the signature
// and measures the SHA-256 that laptops will later insist on. The admin only reviews the result.
//
// On a Mac the full check runs (codesign, Gatekeeper, Team ID). On other systems the file is still measured and identified,
// but the signature can't be verified here; the draft says so, and laptops still verify before installing.
const fs = require('fs');
const os = require('os');
const path = require('path');
const inst = require('../agent/installer');
const { extractInstallerLinks, rankLinks } = require('./links');
const { inspectExe } = require('./pe');

const { run } = require('../agent/platform/util');

class InspectError extends Error {
  constructor(code, detail = '') {
    super(detail || code);
    this.code = code;
  }
}

/** What the admin reads when a check fails: what happened, and what to do about it. */
const MESSAGES = {
  LINK_NOT_HTTPS: ["That link isn't a secure https:// address.", "Paste the vendor's official https download link."],
  DOWNLOAD_FAILED: ["I couldn't download that link.", 'Open it in a browser to check it works, then try again.'],
  CANCELLED: ['Cancelled.', ''],
  TOO_LARGE: ['That file is larger than I can check.', 'Use the vendor’s standard installer.'],
  INSUFFICIENT_DISK: ["This computer doesn't have enough free space to check that file.", 'Free up some disk space and try again.'],
  NOT_AN_INSTALLER: ['That link opens a web page, and I couldn’t find an installer link on it.', 'Right-click the page’s Download button, choose “Copy Link Address”, and paste that link instead.'],
  CHOOSE_LINK: ['That page has more than one download.', 'Choose the installer you want.'],
  UNSUPPORTED_FORMAT: ["That file isn't a supported installer.", 'Supported: .dmg, .zip or .pkg for Mac, .msi or .exe for Windows, and AppImage for Linux.'],
  UNSUPPORTED_ARCHIVE: ['That’s a compressed archive or Linux package (.tar.xz, .deb, .rpm…), which laptops can’t install.', 'Use the macOS .dmg, .zip or .pkg, the Windows .msi or .exe, or a Linux AppImage.'],
  WRONG_ZIP: ["That zip doesn't contain a Mac app.", 'It looks like a Windows or portable download. Use the macOS .zip or .dmg, or the Windows .exe or .msi installer.'],
  NO_APP_IN_PACKAGE: ["I couldn't find a single app inside that file.", 'It should contain exactly one .app at the top level.'],
  UNSAFE_ARCHIVE: ['That archive contains unsafe file paths or links, so I stopped.', 'Ask the vendor for a clean download.'],
  LICENSE_PROMPT: ['That disk image asks you to accept a licence by hand.', 'Laptops can’t click through it. Use the .pkg or .zip version instead.'],
  UNSIGNED_EXE: ["That installer isn't digitally signed.", 'Laptops only install signed Windows installers. Ask the vendor for the signed build.'],
  UNSIGNED: ["That app isn't signed by a verified developer.", 'Laptops only install signed apps. Ask the vendor for the signed build.'],
  SIGNATURE_INVALID: ["That app's signature didn't check out.", 'The file may be damaged or tampered with. Download it again from the vendor.'],
  GATEKEEPER_REJECTED: ["macOS doesn't trust that app.", 'Laptops would refuse it too. Ask the vendor for a notarised build.'],
  TEAM_MISMATCH: ["That download is signed by a different developer than expected.", 'Nothing was added. Check the link is the vendor’s own.'],
};

const friendly = (code) => {
  const [message, hint] = MESSAGES[code] || ["I couldn't check that file.", 'Try again, or enter the details yourself under “Advanced”.'];
  return { code, message, hint };
};

const hasMac = () => process.platform === 'darwin';

/** Some vendor sites answer an unknown client with a web page; a normal browser identity gets the file. Only used for catalogue checks. */
const BROWSER_HEADERS = {
  'user-agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Safari/605.1.15 Proglintor-Admin',
  accept: '*/*',
};

// ---- identify -------------------------------------------------------------------------------------------

/** True when the start of a file is text containing HTML/XML tags (a web page, possibly after a BOM, comment or whitespace). */
function looksLikeMarkup(bytes) {
  if (!bytes.length || bytes.includes(0)) return false;
  const text = bytes.toString('utf8').replace(/^﻿/, '');
  return /^\s*</.test(text) && /<\s*(!doctype|!--|\?xml|html|head|body|meta|title|link|script|style|div|span|a|p|h[1-6]|ul|li|form|table|img)\b/i.test(text);
}

/** Installer type from the file's own bytes (never trusting the URL's extension). */
async function detectKind(file) {
  const fd = await fs.promises.open(file, 'r');
  try {
    const { size } = await fd.stat();
    const head = Buffer.alloc(512);
    const { bytesRead } = await fd.read(head, 0, 512, 0);
    const tail = Buffer.alloc(512);
    if (size >= 512) await fd.read(tail, 0, 512, size - 512);
    if (head.subarray(0, 2).toString('latin1') === 'PK') return { type: 'zip', platform: 'darwin' };
    if (head.subarray(0, 4).toString('latin1') === 'xar!') return { type: 'pkg', platform: 'darwin' };
    if (tail.subarray(0, 4).toString('latin1') === 'koly') return { type: 'dmg', platform: 'darwin' };
    if (head.subarray(0, 8).equals(Buffer.from([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1]))) return { type: 'msi', platform: 'win32' };
    if (head.subarray(0, 2).toString('latin1') === 'MZ') return { type: 'exe', platform: 'win32' };
    if (head.subarray(0, 4).toString('latin1') === '\x7fELF') return { type: 'appimage', platform: 'linux' };
    if (looksLikeMarkup(head.subarray(0, bytesRead))) throw new InspectError('NOT_AN_INSTALLER');
    // Archives and Linux packages that look like downloads but aren't something laptops can install.
    const h = head.toString('latin1');
    if (h.startsWith('ý7zXZ') || h.startsWith('\u001f\u008b') || h.startsWith('BZh') || h.startsWith('7z¼¯') || h.startsWith('!<arch>') || head.subarray(0, 4).equals(Buffer.from([0xed, 0xab, 0xee, 0xdb]))) {
      throw new InspectError('UNSUPPORTED_ARCHIVE');
    }
    throw new InspectError('UNSUPPORTED_FORMAT');
  } finally {
    await fd.close();
  }
}

function fileBase(urlOrName) {
  let base = '';
  try { base = decodeURIComponent(path.basename(new URL(urlOrName).pathname)); } catch { base = path.basename(String(urlOrName)); }
  return base.replace(/\.(dmg|zip|pkg|msi|exe|appimage)$/i, '');
}

/** Words in a file name that describe the build, not the product. */
const BUILD_WORD = /^(v?\d+(\.\d+)*|build|setup|installer|install|x64|x86|x86_64|amd64|arm64|aarch64|win64|win32|windows|win|mac|macos|osx|darwin|universal|portable|release|stable|latest|en|us)$/i;

/** "sublime_text_build_4215_x64_setup" -> "Sublime Text"; "Visual-Studio-Code-1.140.0-universal" -> "Visual Studio Code" */
function nameFromFile(urlOrName) {
  const words = fileBase(urlOrName).split(/[-_.\s]+/).filter(Boolean);
  const kept = [];
  for (const w of words) {
    if (BUILD_WORD.test(w)) { if (kept.length) break; continue; } // the name ends where the build details begin
    kept.push(w);
  }
  return kept.map((w) => (w === w.toLowerCase() ? w[0].toUpperCase() + w.slice(1) : w)).join(' ');
}

/** The version from a file name when the file itself doesn't say: "…_4215_x64_setup" -> "4215", "App-2.5.1" -> "2.5.1". */
function versionFromFile(urlOrName) {
  const hit = fileBase(urlOrName).split(/[-_\s]+/).find((w) => /^v?\d+(\.\d+)+$/.test(w) || /^v?\d{3,}$/.test(w));
  return hit ? hit.replace(/^v/i, '') : '';
}

/** A dotted version in the download address ("…/prod/7.2.5.90525/Zoom.pkg"), or ''. */
function versionFromUrl(url) {
  try {
    const hits = new URL(url).pathname.split('/').filter((seg) => /^v?\d+(\.\d+)+$/.test(seg)).map((seg) => seg.replace(/^v/i, ''));
    return hits.sort((a, b) => b.length - a.length)[0] || '';
  } catch { return ''; }
}

/** Versions that installer metadata often carries as a placeholder rather than the app's real version. */
const PLACEHOLDER_VERSION = /^[01](\.0)*$/;

/**
 * Tidies a pasted link: drops stray characters around it (a shell prompt "$ ", quotes, <angle brackets>, trailing punctuation),
 * and takes the first https:// address when other text surrounds it. Returns '' when there is no http(s) address at all.
 */
function cleanLinkInput(raw) {
  const m = /https?:\/\/[^\s"'<>`]+/i.exec(String(raw || ''));
  return m ? m[0].replace(/[)\],.;:!?]+$/, '') : '';
}

/** Processor from a file name ("…x64…", "…arm64…"); 'any' when it doesn't say. Used for Windows and Linux builds. */
function archFromFile(urlOrName) {
  const base = fileBase(urlOrName).toLowerCase();
  if (/(^|[^a-z0-9])(arm64|aarch64)([^a-z0-9]|$)/.test(base)) return 'arm64';
  if (/(^|[^a-z0-9])(x64|amd64|x86_64|win64)([^a-z0-9]|$)/.test(base)) return 'x64';
  return 'any';
}

/** Other names people may type: the name without spaces ("visualstudiocode"). The assistant already handles case and filler words. */
function aliasesFor(name) {
  const lower = name.toLowerCase().trim();
  const joined = lower.replace(/\s+/g, '');
  return joined.length >= 3 && joined !== lower ? [joined] : [];
}

// ---- macOS enrichment -----------------------------------------------------------------------------------------

async function bundleDetails(app) {
  const id = await inst.plistValue(app, 'CFBundleIdentifier');
  const version = (await inst.plistValue(app, 'CFBundleShortVersionString')) || (await inst.plistValue(app, 'CFBundleVersion'));
  const display = (await inst.plistValue(app, 'CFBundleDisplayName')) || (await inst.plistValue(app, 'CFBundleName')) || path.basename(app, '.app');
  const exe = await inst.plistValue(app, 'CFBundleExecutable');
  const minOs = await inst.plistValue(app, 'LSMinimumSystemVersion');
  let arch = 'any';
  if (exe) {
    const { stdout } = await inst.runAll('lipo', ['-archs', path.join(app, 'Contents', 'MacOS', exe)]);
    const list = stdout.trim().split(/\s+/);
    const arm = list.includes('arm64') || list.includes('arm64e');
    const intel = list.includes('x86_64');
    arch = arm && intel ? 'any' : arm ? 'arm64' : intel ? 'x64' : 'any';
  }
  return { id, version, name: display, minOs, arch };
}

/** codesign + Gatekeeper on an .app; returns { teamId, signedBy }. Throws InspectError. */
async function appSignature(app) {
  const verify = await inst.runAll('codesign', ['--verify', '--deep', '--strict', app], { timeout: 120000 });
  if (verify.err) throw new InspectError(/not signed at all/i.test(verify.stderr) ? 'UNSIGNED' : 'SIGNATURE_INVALID');
  const { stderr, stdout } = await inst.runAll('codesign', ['-dv', '--verbose=4', app]);
  const text = stderr + stdout;
  const team = (/TeamIdentifier=(\S+)/.exec(text) || [])[1];
  if (!team || team === 'not') throw new InspectError('UNSIGNED');
  if ((await inst.runAll('spctl', ['--assess', '--type', 'execute', app], { timeout: 120000 })).err) throw new InspectError('GATEKEEPER_REJECTED');
  const signedBy = (/Authority=Developer ID Application: (.+?) \([A-Z0-9]{10}\)/.exec(text) || [])[1] || '';
  return { teamId: team, signedBy };
}

/** The app's own icon as a small PNG data URL (read from its .icns with the system tool `sips`), or '' when it has none to read. */
async function appIconData(app) {
  const dir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'proglintor-icon-'));
  try {
    let name = await inst.plistValue(app, 'CFBundleIconFile');
    if (!name) return '';
    name = path.basename(name);
    if (!/\.icns$/i.test(name)) name += '.icns';
    const src = path.join(app, 'Contents', 'Resources', name);
    const out = path.join(dir, 'icon.png');
    if (!fs.existsSync(src) || (await inst.runAll('sips', ['-s', 'format', 'png', '-Z', '128', src, '--out', out])).err) return '';
    const png = await fs.promises.readFile(out);
    return png.length && png.length <= 120 * 1024 ? `data:image/png;base64,${png.toString('base64')}` : '';
  } catch {
    return '';
  } finally {
    await fs.promises.rm(dir, { recursive: true, force: true }).catch(() => {});
  }
}

async function inspectApp(app) {
  const info = await bundleDetails(app);
  const sig = await appSignature(app);
  return { name: info.name, version: info.version, appId: info.id, appName: path.basename(app), arch: info.arch, minOs: info.minOs, teamId: sig.teamId, publisher: sig.signedBy, verified: true, icon: await appIconData(app) };
}

async function inspectMacZip(file, dir) {
  let listing = '';
  try { listing = await run('unzip', ['-Z1', file], { timeout: 60000 }); } catch { throw new InspectError('UNSUPPORTED_FORMAT'); }
  if (!inst.zipPathsSafe(listing)) throw new InspectError('UNSAFE_ARCHIVE');
  if (!/\.app\//.test(listing)) throw new InspectError(/\.(exe|dll|msi)$/im.test(listing) ? 'WRONG_ZIP' : 'NO_APP_IN_PACKAGE'); // checked before unpacking anything
  const out = path.join(dir, 'extract');
  await fs.promises.mkdir(out, { recursive: true });
  try { await run('ditto', ['-x', '-k', file, out], { timeout: 10 * 60 * 1000 }); } catch { throw new InspectError('UNSUPPORTED_FORMAT'); }
  if (!(await inst.symlinksContained(out))) throw new InspectError('UNSAFE_ARCHIVE');
  let app;
  try { app = await inst.findApp(out, {}); } catch { throw new InspectError('NO_APP_IN_PACKAGE'); }
  return inspectApp(app);
}

async function inspectMacDmg(file) {
  try {
    return await inst.withMountedDmg(file, async (mount) => {
      let app;
      try { app = await inst.findApp(mount, {}); } catch { throw new InspectError('NO_APP_IN_PACKAGE'); }
      return inspectApp(app);
    });
  } catch (err) {
    if (err instanceof InspectError) throw err;
    if (err.code === 'DMG_LICENSE_PROMPT') throw new InspectError('LICENSE_PROMPT');
    throw new InspectError('UNSUPPORTED_FORMAT');
  }
}

async function inspectMacPkg(file, dir) {
  const { err, stdout } = await inst.runAll('pkgutil', ['--check-signature', file], { timeout: 60000 });
  if (err || !/Status:\s*signed/i.test(stdout)) throw new InspectError('UNSIGNED');
  const m = /Developer ID Installer: (.+?) \(([A-Z0-9]{10})\)/.exec(stdout);
  if (!m) throw new InspectError('UNSIGNED');
  const out = path.join(dir, 'expanded');
  let version = '', identifier = '', title = '';
  if (!(await inst.runAll('pkgutil', ['--expand', file, out], { timeout: 120000 })).err) {
    const read = (f) => { try { return fs.readFileSync(path.join(out, f), 'utf8'); } catch { return ''; } };
    const xml = read('Distribution') || read('PackageInfo');
    version = (/\bversion="([^"]+)"/.exec(xml) || [])[1] || '';
    identifier = (/\b(?:pkg-ref id|identifier)="([^"]+)"/.exec(xml) || [])[1] || '';
    title = (/<title>([^<]+)<\/title>/.exec(xml) || [])[1] || '';
  }
  // The app the package puts in /Applications, so "is it installed?" can look for it later ("zoom.us.app" for Zoom's installer).
  let appName = '';
  const files = await inst.runAll('pkgutil', ['--payload-files', file], { timeout: 60000 });
  if (!files.err) {
    const apps = [...new Set(files.stdout.split('\n').map((l) => (/^\.?\/?Applications\/([^/]+\.app)\/?$/.exec(l.trim()) || [])[1]).filter(Boolean))];
    if (apps.length === 1) appName = apps[0]; // several apps: don't guess
  }
  return { name: title, version, appId: identifier, appName, arch: 'any', teamId: m[2], publisher: m[1], verified: true };
}

// ---- entry point --------------------------------------------------------------------------------------------------

/**
 * Downloads and checks a package link. Resolves with a draft the admin can review; rejects with InspectError.
 * @param {string} url
 * @param {{expectTeamId?:string, hintName?:string, onStage?:Function, signal?:AbortSignal, allowLoopbackHttp?:boolean, fetchImpl?:Function, tempRoot?:string}} opts
 */
async function inspectLink(url, opts = {}) {
  const { expectTeamId = '', hintName = '', onStage, signal, allowLoopbackHttp = false, fetchImpl, tempRoot = os.tmpdir(), depth = 0, preferPlatform, preferArch, renderPage } = opts;
  if (!inst.urlAllowed(url, allowLoopbackHttp)) throw new InspectError('LINK_NOT_HTTPS');
  // Known-unsupported file types are refused straight away instead of downloading hundreds of MB first.
  if (/\.(tar\.(xz|gz|bz2)|tgz|txz|deb|rpm|7z|rar|iso|apk|snap|flatpak)$/i.test(new URL(url).pathname)) throw new InspectError('UNSUPPORTED_ARCHIVE');
  const dir = await fs.promises.mkdtemp(path.join(tempRoot, 'proglintor-inspect-'));
  await fs.promises.chmod(dir, 0o700);
  try {
    const measure = {};
    onStage?.({ stage: 'downloading', done: 0, total: null });
    let file;
    try {
      file = await inst.download({ downloadUrl: url }, dir, {
        ext: 'bin', measure, signal, allowLoopbackHttp, fetchImpl, headers: BROWSER_HEADERS,
        onProgress: (done, total) => onStage?.({ stage: 'downloading', done, total }),
      });
    } catch (err) {
      const map = { INSTALL_INTERRUPTED: 'CANCELLED', INSUFFICIENT_DISK: 'INSUFFICIENT_DISK', DIGEST_MISMATCH: 'TOO_LARGE' };
      throw new InspectError(map[err.code] || 'DOWNLOAD_FAILED');
    }
    onStage?.({ stage: 'checking' });
    let kind;
    try {
      kind = await detectKind(file);
    } catch (err) {
      if (err.code !== 'NOT_AN_INSTALLER' || depth >= 1) throw err;
      // A web page: look for the real installer link(s) on it instead of giving up.
      const size = (await fs.promises.stat(file)).size;
      const html = size <= 3 * 1024 * 1024 ? await fs.promises.readFile(file, 'utf8') : '';
      let links = extractInstallerLinks(html, measure.finalUrl || url, { allowHttp: allowLoopbackHttp, hintName, preferArch, ...(preferPlatform ? { preferPlatform } : {}) });
      if (!links.length && renderPage) {
        // No installer links in the page's own HTML: a script probably builds them when "Download" is clicked. Open the page the way a person would.
        onStage?.({ stage: 'rendering' });
        const captured = await Promise.resolve(renderPage(measure.finalUrl || url)).catch(() => []);
        links = rankLinks(captured, { hintName, preferArch, ...(preferPlatform ? { preferPlatform } : {}) });
      }
      if (links.length === 1) {
        const found = await inspectLink(links[0].url, { ...opts, depth: depth + 1 });
        return { ...found, foundOn: url };
      }
      if (links.length > 1) throw Object.assign(new InspectError('CHOOSE_LINK'), { choices: links });
      throw err;
    }
    const typed = path.join(dir, `installer.${kind.type}`);
    await fs.promises.rename(file, typed);

    const warnings = [];
    let facts = { name: '', version: '', appId: '', appName: '', arch: 'any', teamId: '', publisher: '', verified: false };
    if (kind.platform === 'darwin' && hasMac()) {
      facts = await (kind.type === 'zip' ? inspectMacZip(typed, dir) : kind.type === 'dmg' ? inspectMacDmg(typed) : inspectMacPkg(typed, dir));
      if (expectTeamId && facts.teamId !== expectTeamId) throw new InspectError('TEAM_MISMATCH');
    } else if (kind.type === 'exe') {
      // A Windows installer, read on any operating system: name, company, signature presence and signer, framework (silent options).
      const pe = await inspectExe(typed);
      if (pe.valid && !pe.signed) throw new InspectError('UNSIGNED_EXE');
      const bits = [];
      if (pe.signed && pe.signer) bits.push(`Digitally signed by ${pe.signer}${pe.issuer ? ` (certificate from ${pe.issuer})` : ''}. I can't confirm Windows trusts it from this computer; laptops check it before installing.`);
      else bits.push("I couldn't read this installer's signature here. Laptops check it before installing.");
      for (const text of bits) warnings.push({ code: 'SIGNATURE_NOT_VERIFIED_HERE', text, tone: pe.signed && pe.signer ? 'info' : 'warn' });
      if (pe.silentArgs?.length) warnings.push({ code: 'SILENT_DETECTED', text: `This is an ${pe.frameworkLabel} installer, so I filled in its standard silent-install options. Check they suit this app.`, tone: 'info' });
      else warnings.push({ code: 'NEEDS_SILENT_ARGS', text: `Add the silent-install options for this installer${pe.frameworkLabel ? ` (${pe.frameworkLabel} varies per package)` : ''}, or installs will be refused.` });
      facts = {
        ...facts, name: pe.productName || (pe.description || '').replace(/\s+(setup|installer)$/i, ''), version: pe.version || versionFromFile(url),
        publisher: pe.signer || pe.company, silentArgs: pe.silentArgs || [], signedBy: pe.signer || '', arch: archFromFile(measure.finalUrl || url),
      };
    } else {
      const text = kind.platform === 'darwin'
        ? "This computer can't check Mac signatures, so I couldn't verify who signed it. Laptops still verify before installing."
        : "I can only check this kind of installer's signature on its own operating system, so I couldn't verify who signed it. Laptops still verify before installing.";
      warnings.push({ code: 'NOT_VERIFIED_HERE', text });
      if (kind.type === 'exe') warnings.push({ code: 'NEEDS_SILENT_ARGS', text: 'Add the silent-install options for this .exe under Advanced, or installs will be refused.' });
    }

    const final = measure.finalUrl && inst.urlAllowed(measure.finalUrl, allowLoopbackHttp) && measure.finalUrl.length <= 900 ? measure.finalUrl : url;
    const name = facts.name || hintName || nameFromFile(final);
    // The file's own version, unless it is a placeholder like "1.0" (Zoom's .pkg says that): then the address or file name usually knows better.
    const real = facts.version && !PLACEHOLDER_VERSION.test(facts.version) ? facts.version : '';
    const version = real || versionFromUrl(final) || facts.version || versionFromFile(final);
    const arch = kind.platform === 'darwin' || facts.arch !== 'any' ? facts.arch : archFromFile(final);
    return {
      name, version, publisher: facts.publisher, platform: kind.platform, arch, installerType: kind.type,
      silentArgs: facts.silentArgs || [], signedBy: facts.signedBy || '',
      downloadUrl: final, sha256: measure.sha256, sizeBytes: measure.size, appName: facts.appName, appId: facts.appId, teamId: facts.teamId || expectTeamId,
      verified: facts.verified, minOs: facts.minOs || '', icon: facts.icon || '', aliases: aliasesFor(name), warnings,
    };
  } finally {
    await fs.promises.rm(dir, { recursive: true, force: true }).catch(() => {});
  }
}

module.exports = { InspectError, friendly, detectKind, nameFromFile, versionFromFile, versionFromUrl, cleanLinkInput, archFromFile, aliasesFor, inspectLink, inspectApp };
