'use strict';
// Downloads and installs one approved catalogue item on this computer.
//
// Safety model (the laptop never trusts the network or even the server blindly):
//   * the download must be https and must hash to the SHA-256 the admin pinned, otherwise it is deleted unopened;
//   * file names inside the download come only from the catalogue (never from the archive or the URL);
//   * zip paths and symlinks that could escape the extraction folder are refused;
//   * on macOS the app is signature-checked (and Team ID / bundle id matched) in a staging folder BEFORE it replaces
//     anything in Applications, and an existing copy is only swapped in after that, with automatic rollback.
// Every failure is an InstallError with a short code the chat turns into plain-language advice.
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { Readable, Transform } = require('stream');
const { pipeline } = require('stream/promises');
const { execFile } = require('child_process');
const { run } = require('./platform/util');

/** Like run(), but never rejects: returns { err, stdout, stderr } (some tools print their details on stderr). */
function runAll(cmd, args, opts = {}) {
  return new Promise((resolve) => {
    execFile(cmd, args, { timeout: 30000, windowsHide: true, ...opts }, (err, stdout, stderr) => resolve({ err, stdout: String(stdout || ''), stderr: String(stderr || '') }));
  });
}

const MAX_BYTES = 6 * 1024 ** 3;
const IDLE_MS = 60 * 1000;
const TYPES = new Set(['dmg', 'zip', 'pkg', 'msi', 'exe', 'appimage']);

class InstallError extends Error {
  constructor(code, detail = '') {
    super(detail || code);
    this.code = code;
  }
}

// ---- helpers ------------------------------------------------------------------------------

/** "1.140.0" vs "1.139" -> 1 / 0 / -1 (numeric parts only). */
function compareVersions(a, b) {
  const nums = (v) => (String(v || '').match(/\d+/g) || []).slice(0, 6).map(Number);
  const x = nums(a), y = nums(b);
  for (let i = 0; i < Math.max(x.length, y.length, 1); i += 1) {
    const d = (x[i] || 0) - (y[i] || 0);
    if (d) return d > 0 ? 1 : -1;
  }
  return 0;
}

const isLoopback = (host) => host === 'localhost' || host === '127.0.0.1' || host === '[::1]';

/** https only. Plain http is accepted for loopback addresses when explicitly enabled (local development and tests). */
function urlAllowed(url, allowLoopbackHttp = false) {
  let u;
  try { u = new URL(url); } catch { return false; }
  return u.protocol === 'https:' || (allowLoopbackHttp && u.protocol === 'http:' && isLoopback(u.hostname));
}

/** Rejects a malformed or tampered job before anything is downloaded. */
function validateSpec(spec) {
  if (!spec || typeof spec !== 'object') throw new InstallError('INSTALLER_UNSUPPORTED', 'Missing install instructions');
  if (!TYPES.has(spec.installerType)) throw new InstallError('INSTALLER_UNSUPPORTED', `Unsupported installer type ${spec.installerType}`);
  if (!/^[0-9a-f]{64}$/i.test(spec.sha256 || '')) throw new InstallError('DIGEST_MISMATCH', 'No pinned checksum');
  if (spec.appName && (/[\\/]/.test(spec.appName) || spec.appName.startsWith('.'))) throw new InstallError('PAYLOAD_NOT_FOUND', 'Invalid app name');
  if (spec.platform && spec.platform !== process.platform) throw new InstallError('INSTALLER_UNSUPPORTED', 'Built for a different operating system');
  if (spec.arch && spec.arch !== 'any' && spec.arch !== process.arch) throw new InstallError('INSTALLER_UNSUPPORTED', 'Built for a different processor');
}

// ---- download -----------------------------------------------------------------------------

/**
 * Streams the installer to `dir`, hashing as it goes. Resolves with the file path.
 * @param {object} spec        catalogue spec (downloadUrl, sha256, sizeBytes, installerType)
 * @param {string} dir         private temp folder
 * @param {{onProgress?:(done:number,total:number|null)=>void, signal?:AbortSignal, allowLoopbackHttp?:boolean, fetchImpl?:Function}} opts
 */
async function download(spec, dir, opts = {}) {
  const { onProgress, signal, allowLoopbackHttp = false, fetchImpl = fetch } = opts;
  if (!urlAllowed(spec.downloadUrl, allowLoopbackHttp)) throw new InstallError('DOWNLOAD_FAILED', 'The download address is not a secure https link');
  const expectedSize = Number(spec.sizeBytes) > 0 ? Number(spec.sizeBytes) : null;
  const cap = expectedSize ? Math.min(MAX_BYTES, Math.ceil(expectedSize * 1.1) + 64 * 1024) : MAX_BYTES;

  if (expectedSize && fs.statfs) {
    try {
      const s = await fs.promises.statfs(dir);
      if (s.bavail * s.bsize < expectedSize * 2.5) throw new InstallError('INSUFFICIENT_DISK');
    } catch (err) {
      if (err instanceof InstallError) throw err; // a statfs failure alone never blocks the install
    }
  }

  const file = path.join(dir, `installer.${opts.ext || spec.installerType}`);
  let finalUrl = spec.downloadUrl;
  const idle = new AbortController();
  let idleTimer = null;
  const arm = () => { clearTimeout(idleTimer); idleTimer = setTimeout(() => idle.abort(), IDLE_MS); };
  const signals = [idle.signal, ...(signal ? [signal] : [])];
  const hash = crypto.createHash('sha256');
  let done = 0;
  try {
    arm();
    const res = await fetchImpl(spec.downloadUrl, { redirect: 'follow', signal: AbortSignal.any(signals), ...(opts.headers ? { headers: opts.headers } : {}) });
    if (!res.ok || !res.body) throw new InstallError('DOWNLOAD_FAILED', `Server answered ${res.status}`);
    if (res.url && !urlAllowed(res.url, allowLoopbackHttp)) throw new InstallError('DOWNLOAD_FAILED', 'Redirected to an insecure address');
    finalUrl = res.url || finalUrl;
    const total = Number(res.headers.get('content-length')) || expectedSize;
    if (total && total > cap) throw new InstallError('DIGEST_MISMATCH', 'The file is larger than the approved installer');

    const meter = new Transform({
      transform(chunk, _enc, cb) {
        arm();
        done += chunk.length;
        if (done > cap) return cb(new InstallError('DIGEST_MISMATCH', 'The file is larger than the approved installer'));
        hash.update(chunk);
        onProgress?.(done, total || null);
        cb(null, chunk);
      },
    });
    await pipeline(Readable.fromWeb(res.body), meter, fs.createWriteStream(file, { mode: 0o600 }), { signal: AbortSignal.any(signals) });
  } catch (err) {
    await fs.promises.rm(file, { force: true });
    if (err instanceof InstallError) throw err;
    if (signal?.aborted) throw new InstallError('INSTALL_INTERRUPTED', 'Cancelled');
    if (err?.code === 'ENOSPC') throw new InstallError('INSUFFICIENT_DISK');
    throw new InstallError('DOWNLOAD_FAILED', err?.cause?.code || err?.code || err?.message);
  } finally {
    clearTimeout(idleTimer);
  }
  const digest = hash.digest('hex');
  // Catalogue inspection (admin app) measures a file it has no pinned checksum for yet; installs always pin.
  if (opts.measure) Object.assign(opts.measure, { sha256: digest, size: done, finalUrl });
  if (spec.sha256 && digest !== spec.sha256.toLowerCase()) {
    await fs.promises.rm(file, { force: true });
    throw new InstallError('DIGEST_MISMATCH');
  }
  onProgress?.(done, done);
  return file;
}

// ---- zip / dmg payloads (macOS) ---------------------------------------------------------------

/** Every entry must stay inside the extraction folder. */
function zipPathsSafe(list) {
  return list.split('\n').map((l) => l.trim()).filter(Boolean)
    .every((p) => !p.startsWith('/') && !/^[a-z]:/i.test(p) && !p.split(/[\\/]/).includes('..'));
}

/** Refuses archives holding symlinks that point outside the folder they were extracted to. */
async function symlinksContained(root) {
  const base = await fs.promises.realpath(root);
  let seen = 0;
  const walk = async (dir) => {
    for (const e of await fs.promises.readdir(dir, { withFileTypes: true })) {
      if (++seen > 300000) return false;
      const full = path.join(dir, e.name);
      if (e.isSymbolicLink()) {
        const target = path.resolve(dir, await fs.promises.readlink(full));
        if (target !== base && !target.startsWith(base + path.sep)) return false;
      } else if (e.isDirectory()) {
        if (!(await walk(full))) return false;
      }
    }
    return true;
  };
  return walk(base);
}

async function plistValue(appPath, key) {
  try { return (await run('/usr/libexec/PlistBuddy', ['-c', `Print :${key}`, path.join(appPath, 'Contents', 'Info.plist')], { timeout: 10000 })).trim(); } catch { return ''; }
}

/** Finds the .app described by the catalogue inside an extracted/mounted folder (top level only). */
async function findApp(root, spec) {
  const entries = await fs.promises.readdir(root);
  const apps = entries.filter((e) => e.endsWith('.app'));
  const hit = spec.appName ? apps.find((a) => a === spec.appName) : apps.length === 1 ? apps[0] : null;
  if (!hit) throw new InstallError('PAYLOAD_NOT_FOUND');
  return path.join(root, hit);
}

async function withMountedDmg(file, fn) {
  let info = '';
  try { info = await run('hdiutil', ['imageinfo', file], { timeout: 60000 }); } catch { throw new InstallError('DMG_ATTACH_FAILED'); }
  if (/Software License Agreement:\s*true/i.test(info)) throw new InstallError('DMG_LICENSE_PROMPT');
  let out;
  try { out = await run('hdiutil', ['attach', '-nobrowse', '-readonly', '-noverify', '-noautoopen', '-plist', file], { timeout: 120000 }); } catch { throw new InstallError('DMG_ATTACH_FAILED'); }
  const mount = (/<key>mount-point<\/key>\s*<string>([^<]+)<\/string>/.exec(out) || [])[1];
  if (!mount) throw new InstallError('DMG_ATTACH_FAILED');
  try { return await fn(mount); } finally { await run('hdiutil', ['detach', mount, '-force'], { timeout: 60000 }).catch(() => {}); }
}

/** Default macOS trust check: bundle id, signature, Team ID, Gatekeeper, version. Throws InstallError. */
async function macTrust(appPath, spec) {
  if (spec.appId) {
    const id = await plistValue(appPath, 'CFBundleIdentifier');
    if (id && id.toLowerCase() !== spec.appId.toLowerCase()) throw new InstallError('BUNDLE_ID_MISMATCH', id);
  }
  try { await run('codesign', ['--verify', '--deep', '--strict', appPath], { timeout: 120000 }); } catch { throw new InstallError('SIGNATURE_INVALID'); }
  if (spec.teamId) {
    const { stderr, stdout } = await runAll('codesign', ['-dv', '--verbose=4', appPath]); // details go to stderr
    const m = /TeamIdentifier=(\S+)/.exec(stderr + stdout);
    if (!m || m[1] !== spec.teamId) throw new InstallError('TEAM_ID_MISMATCH');
  }
  try { await run('spctl', ['--assess', '--type', 'execute', appPath], { timeout: 120000 }); } catch { throw new InstallError('GATEKEEPER_REJECTED'); }
  if (spec.version) {
    const v = await plistValue(appPath, 'CFBundleShortVersionString');
    if (v && compareVersions(v, spec.version) < 0) throw new InstallError('VERSION_MISMATCH', v);
  }
}

function pickDestDir(candidates) {
  for (const dir of candidates) {
    try { fs.mkdirSync(dir, { recursive: true }); fs.accessSync(dir, fs.constants.W_OK); return dir; } catch { /* try the next one */ }
  }
  throw new InstallError('DESTINATION_NOT_WRITABLE');
}

/**
 * Copies a verified .app into Applications: stage -> trust-check -> swap (with rollback). Resolves with the final path.
 * @param {{isRunning?:(spec)=>Promise<boolean>, trust?:Function, destDirs?:string[], onPhase?:(p:string)=>void}} ctx
 */
async function placeApp(srcApp, spec, ctx = {}) {
  const { isRunning, trust = macTrust, destDirs = ['/Applications', path.join(os.homedir(), 'Applications')], onPhase } = ctx;
  const dir = pickDestDir(destDirs);
  const name = path.basename(srcApp);
  const target = path.join(dir, name);
  const staging = path.join(dir, `.${name}.proglintor-new`);
  const backup = path.join(dir, `.${name}.proglintor-old`);

  const existing = fs.existsSync(target);
  if (existing) {
    const id = await plistValue(target, 'CFBundleIdentifier');
    if (spec.appId && id && id.toLowerCase() !== spec.appId.toLowerCase()) throw new InstallError('DESTINATION_CONFLICT', id);
    if (await isRunning?.(spec)) throw new InstallError('APP_IN_USE');
    const have = await plistValue(target, 'CFBundleShortVersionString');
    if (have && spec.version && compareVersions(have, spec.version) > 0) throw new InstallError('NEWER_VERSION_INSTALLED', have);
  }

  await fs.promises.rm(staging, { recursive: true, force: true });
  await fs.promises.rm(backup, { recursive: true, force: true });
  try {
    await run('ditto', [srcApp, staging], { timeout: 10 * 60 * 1000 });
    onPhase?.('VERIFYING');
    await trust(staging, spec);
    if (existing) await fs.promises.rename(target, backup);
    try {
      await fs.promises.rename(staging, target);
    } catch (err) {
      if (existing) await fs.promises.rename(backup, target).catch(() => {}); // roll back
      throw err;
    }
    await fs.promises.rm(backup, { recursive: true, force: true });
  } catch (err) {
    await fs.promises.rm(staging, { recursive: true, force: true }).catch(() => {});
    if (err instanceof InstallError) throw err;
    if (err?.code === 'EACCES' || err?.code === 'EPERM') throw new InstallError('DESTINATION_NOT_WRITABLE');
    if (err?.code === 'ENOSPC') throw new InstallError('INSUFFICIENT_DISK');
    throw new InstallError('INSTALL_FAILED', err?.message);
  }
  return target;
}

async function installMacZip(file, spec, dir, ctx) {
  let listing = '';
  try { listing = await run('unzip', ['-Z1', file], { timeout: 60000 }); } catch { throw new InstallError('PAYLOAD_NOT_FOUND', 'Not a valid zip'); }
  if (!zipPathsSafe(listing)) throw new InstallError('ZIP_PATH_REJECTED');
  const out = path.join(dir, 'extract');
  await fs.promises.mkdir(out, { recursive: true });
  try { await run('ditto', ['-x', '-k', file, out], { timeout: 10 * 60 * 1000 }); } catch { throw new InstallError('PAYLOAD_NOT_FOUND', 'Could not unpack the zip'); }
  if (!(await symlinksContained(out))) throw new InstallError('SYMLINK_REJECTED');
  return placeApp(await findApp(out, spec), spec, ctx);
}

async function installMacDmg(file, spec, _dir, ctx) {
  return withMountedDmg(file, async (mount) => placeApp(await findApp(mount, spec), spec, ctx));
}

/** .pkg: signature checked first; installing needs administrator rights, which macOS asks the employee for. */
async function installMacPkg(file, spec) {
  let sig = '';
  try { sig = await run('pkgutil', ['--check-signature', file], { timeout: 60000 }); } catch { throw new InstallError('SIGNATURE_INVALID'); }
  if (!/Status:\s*signed/i.test(sig)) throw new InstallError('SIGNATURE_INVALID');
  if (spec.teamId && !sig.includes(`(${spec.teamId})`)) throw new InstallError('TEAM_ID_MISMATCH');
  if (!/^[A-Za-z0-9_./ -]+$/.test(file) || file.includes("'")) throw new InstallError('INSTALL_FAILED', 'Unsafe installer path');
  try {
    await run('osascript', ['-e', `do shell script "/usr/sbin/installer -pkg '${file}' -target /" with administrator privileges`], { timeout: 20 * 60 * 1000 });
  } catch (err) {
    if (/-128|User canceled/i.test(String(err.stderr || err.message))) throw new InstallError('ELEVATION_DENIED');
    throw new InstallError('INSTALL_FAILED', String(err.stderr || err.message).slice(0, 200));
  }
  return spec.appName ? path.join('/Applications', spec.appName) : '';
}

/**
 * Did this .pkg really install? macOS keeps a receipt for every package it installs, under the package identifier
 * (e.g. "us.zoom.pkg.videomeeting"), which is NOT an app bundle id: the app inside may be named and identified completely
 * differently ("zoom.us", "us.zoom.xos"). The receipt is therefore the proof, not a search for an app with that name.
 */
async function pkgReceiptExists(identifier, runImpl = run) {
  if (!/^[A-Za-z0-9][A-Za-z0-9._+-]{2,200}$/.test(String(identifier || ''))) return false; // never pass odd text to a command
  try { await runImpl('pkgutil', ['--pkg-info', identifier], { timeout: 15000 }); return true; } catch { return false; }
}

// ---- Windows / Linux -----------------------------------------------------------------------------

async function winSignatureValid(file) {
  try {
    const out = await run('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', '(Get-AuthenticodeSignature -LiteralPath $env:PROGLINTOR_FILE).Status'],
      { timeout: 60000, env: { ...process.env, PROGLINTOR_FILE: file } });
    return out.trim() === 'Valid';
  } catch { return false; }
}

async function installWindows(file, spec) {
  if (!(await winSignatureValid(file))) throw new InstallError('SIGNATURE_INVALID');
  const silent = Array.isArray(spec.silentArgs) ? spec.silentArgs : [];
  let cmd, args;
  if (spec.installerType === 'msi') { cmd = 'msiexec.exe'; args = ['/i', file, ...(silent.length ? silent : ['/qn', '/norestart'])]; }
  else { if (!silent.length) throw new InstallError('INSTALLER_UNSUPPORTED', 'No silent install options in the catalogue'); cmd = file; args = silent; }
  try {
    await run(cmd, args, { timeout: 30 * 60 * 1000 });
  } catch (err) {
    const code = Number(err.code);
    if (code === 3010 || code === 1641) return ''; // success, restart required
    if (code === 1602 || code === 1223) throw new InstallError('ELEVATION_DENIED');
    if (code === 740 || err.code === 'EACCES') throw new InstallError('ELEVATION_REQUIRED');
    if (err.killed) throw new InstallError('INSTALLER_TIMEOUT');
    throw new InstallError('INSTALL_FAILED', `exit ${err.code}`);
  }
  return '';
}

async function installAppImage(file, spec) {
  const dir = path.join(os.homedir(), 'Applications');
  await fs.promises.mkdir(dir, { recursive: true });
  const target = path.join(dir, `${(spec.name || 'app').replace(/[^A-Za-z0-9._-]+/g, '-')}.AppImage`);
  const head = Buffer.alloc(4);
  const fd = await fs.promises.open(file, 'r');
  try { await fd.read(head, 0, 4, 0); } finally { await fd.close(); }
  if (head.toString('latin1') !== '\x7fELF') throw new InstallError('PAYLOAD_NOT_FOUND', 'Not an AppImage');
  await fs.promises.copyFile(file, target);
  await fs.promises.chmod(target, 0o755);
  return target;
}

// ---- entry point ------------------------------------------------------------------------------------

/**
 * Runs a whole job: download -> install -> verify. `hooks.onPhase('DOWNLOADING'|'INSTALLING'|'VERIFYING')` and
 * `hooks.onProgress(done,total)` report progress; `hooks.detect(spec,installedPath)` confirms the app is really there.
 * Resolves with { path }. Rejects with InstallError. Always removes its temp folder.
 */
async function runJob(spec, hooks = {}) {
  validateSpec(spec);
  const { onPhase, onProgress, detect, signal, tempRoot = os.tmpdir(), allowLoopbackHttp, fetchImpl, mac = {} } = hooks;
  const dir = await fs.promises.mkdtemp(path.join(tempRoot, 'proglintor-install-'));
  await fs.promises.chmod(dir, 0o700);
  try {
    onPhase?.('DOWNLOADING');
    const file = await download(spec, dir, { onProgress, signal, allowLoopbackHttp, fetchImpl });
    onPhase?.('INSTALLING');
    let installed = '';
    const ctx = { ...mac, onPhase };
    if (process.platform === 'darwin') {
      if (spec.installerType === 'zip') installed = await installMacZip(file, spec, dir, ctx);
      else if (spec.installerType === 'dmg') installed = await installMacDmg(file, spec, dir, ctx);
      else if (spec.installerType === 'pkg') installed = await installMacPkg(file, spec);
      else throw new InstallError('INSTALLER_UNSUPPORTED');
    } else if (process.platform === 'win32' && (spec.installerType === 'msi' || spec.installerType === 'exe')) {
      installed = await installWindows(file, spec);
    } else if (process.platform === 'linux' && spec.installerType === 'appimage') {
      installed = await installAppImage(file, spec);
    } else {
      throw new InstallError('INSTALLER_UNSUPPORTED');
    }
    onPhase?.('VERIFYING');
    // A .pkg is verified by its receipt; everything else by finding the app (the `detect` hook).
    const receipt = process.platform === 'darwin' && spec.installerType === 'pkg' && (await pkgReceiptExists(spec.appId));
    if (detect && !receipt && !(await detect(spec, installed))) throw new InstallError('NOT_DETECTED_AFTER_INSTALL');
    return { path: installed };
  } finally {
    await fs.promises.rm(dir, { recursive: true, force: true }).catch(() => {});
  }
}

module.exports = {
  InstallError, compareVersions, urlAllowed, validateSpec, download, zipPathsSafe, symlinksContained, placeApp, runJob, macTrust,
  plistValue, findApp, withMountedDmg, runAll, pkgReceiptExists,
};
