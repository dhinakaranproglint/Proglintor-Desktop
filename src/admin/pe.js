'use strict';
// Reads what a Windows installer (.exe) says about itself, on any operating system: who made it, what it is called, whether it
// is digitally signed and by whom, and which installer framework built it (which tells us the standard silent-install options).
//
// This does NOT prove the signature is valid or trusted; that needs Windows. Laptops check it there (Authenticode) before
// installing. Here it is used to name the app, pre-fill the silent options, and refuse installers that carry no signature at all.
const fs = require('fs');
const os = require('os');
const path = require('path');
const { run } = require('../agent/platform/util');

const CHUNK = 4 * 1024 * 1024;
const u16 = (s) => Buffer.from(s, 'utf16le');

/** Markers inside the file that identify the installer framework, with that framework's standard silent options. */
const FRAMEWORKS = [
  { id: 'inno', label: 'Inno Setup', marker: Buffer.from('Inno Setup Setup Data'), silentArgs: ['/VERYSILENT', '/SUPPRESSMSGBOXES', '/NORESTART', '/SP-'] },
  { id: 'nsis', label: 'NSIS', marker: Buffer.from('Nullsoft Install System'), silentArgs: ['/S'] },
  { id: 'burn', label: 'WiX Burn', marker: Buffer.from('.wixburn'), silentArgs: ['/quiet', '/norestart'] },
  { id: 'squirrel', label: 'Squirrel', marker: Buffer.from('Squirrel.Windows'), silentArgs: ['--silent'] },
  { id: 'installshield', label: 'InstallShield', marker: Buffer.from('InstallShield'), silentArgs: [] }, // options vary per package: not guessed
];
const VERSION_INFO = u16('VS_VERSION_INFO');

/** One streaming pass over the file, finding the first offset of each marker (files can be hundreds of MB). */
async function scan(file, patterns) {
  const fd = await fs.promises.open(file, 'r');
  const found = Object.fromEntries(Object.keys(patterns).map((k) => [k, -1]));
  const overlap = Math.max(...Object.values(patterns).map((p) => p.length)) - 1;
  try {
    const { size } = await fd.stat();
    const buf = Buffer.alloc(CHUNK + overlap);
    let pos = 0;
    while (pos < size && Object.values(found).some((v) => v < 0)) {
      const { bytesRead } = await fd.read(buf, 0, CHUNK + overlap, pos);
      if (!bytesRead) break;
      const view = buf.subarray(0, bytesRead);
      for (const [k, pattern] of Object.entries(patterns)) {
        if (found[k] >= 0) continue;
        const i = view.indexOf(pattern);
        if (i >= 0) found[k] = pos + i;
      }
      pos += CHUNK;
    }
  } finally {
    await fd.close();
  }
  return found;
}

/** The string table of a VERSIONINFO resource: { ProductName, CompanyName, ... } (values trimmed; Inno pads them with spaces). */
function readVersionStrings(block) {
  const out = {};
  for (const key of ['CompanyName', 'FileDescription', 'FileVersion', 'ProductName', 'ProductVersion', 'InternalName', 'OriginalFilename']) {
    const at = block.indexOf(Buffer.concat([u16(key), Buffer.from([0, 0])]));
    if (at < 6) continue;
    const start = at - 6; // the three WORDs (length, value length, type) that precede the key
    const keyEnd = at + key.length * 2 + 2;
    const valueAt = start + (((keyEnd - start) + 3) & ~3); // the value starts on a 4-byte boundary relative to the entry
    const text = block.subarray(valueAt, valueAt + 400).toString('utf16le').split('\0')[0].trim();
    if (text) out[key] = text;
  }
  return out;
}

/** Headers: machine type and where the digital-signature blob sits. Returns null when this isn't a readable PE file. */
function readHeaders(head, fileSize) {
  if (head.length < 0x40 || head.toString('latin1', 0, 2) !== 'MZ') return null;
  const pe = head.readUInt32LE(0x3c);
  if (pe + 160 > head.length || head.toString('latin1', pe, pe + 4) !== 'PE\0\0') return null;
  const machine = head.readUInt16LE(pe + 4);
  const magic = head.readUInt16LE(pe + 24);
  if (magic !== 0x10b && magic !== 0x20b) return null;
  const dd = pe + 24 + (magic === 0x20b ? 112 : 96);
  const sigOffset = head.readUInt32LE(dd + 32); // certificate table (a file offset, unlike the other directories)
  const sigSize = head.readUInt32LE(dd + 36);
  const sane = sigSize > 8 && sigOffset > 0 && sigOffset + sigSize <= fileSize;
  return { machine, sigOffset: sane ? sigOffset : 0, sigSize: sane ? sigSize : 0 };
}

/** Signer (the leaf certificate: the one that issued nothing else, ignoring timestamp certificates) from a PKCS#7 blob, via openssl. */
async function readSigner(der, dir) {
  const file = path.join(dir, 'signature.der');
  await fs.promises.writeFile(file, der);
  let text = '';
  try { text = await run('openssl', ['pkcs7', '-inform', 'DER', '-in', file, '-print_certs'], { timeout: 20000 }); } catch { return null; }
  const certs = [];
  for (const m of text.matchAll(/subject\s*[=:]\s*(.+)\nissuer\s*[=:]\s*(.+)/g)) certs.push({ subject: m[1].trim(), issuer: m[2].trim() });
  const issuers = new Set(certs.map((c) => c.issuer));
  const leaf = certs.find((c) => !issuers.has(c.subject) && !/time\s*stamp/i.test(c.subject)) || certs[0];
  if (!leaf) return null;
  const field = (dn, k) => (new RegExp(`(?:^|[,/]\\s*)${k}\\s*=\\s*([^,/]+)`).exec(dn) || [])[1]?.trim() || '';
  return { signer: field(leaf.subject, 'O') || field(leaf.subject, 'CN'), issuer: field(leaf.issuer, 'O') || field(leaf.issuer, 'CN') };
}

/**
 * @returns {Promise<{valid:boolean, arch?:string, signed?:boolean, signer?:string, issuer?:string, framework?:string, frameworkLabel?:string, silentArgs?:string[],
 *   productName?:string, company?:string, description?:string, version?:string}>}
 */
async function inspectExe(file) {
  const stat = await fs.promises.stat(file);
  const fd = await fs.promises.open(file, 'r');
  const head = Buffer.alloc(4096);
  try { await fd.read(head, 0, 4096, 0); } finally { await fd.close(); }
  const hdr = readHeaders(head, stat.size);
  if (!hdr) return { valid: false };

  const patterns = Object.fromEntries([['versionInfo', VERSION_INFO], ...FRAMEWORKS.map((f) => [f.id, f.marker])]);
  const at = await scan(file, patterns);
  const framework = FRAMEWORKS.filter((f) => at[f.id] >= 0).sort((a, b) => at[a.id] - at[b.id])[0] || null; // the earliest marker is the real stub

  let strings = {};
  if (at.versionInfo >= 0) {
    const fd2 = await fs.promises.open(file, 'r');
    try {
      const block = Buffer.alloc(4096);
      const { bytesRead } = await fd2.read(block, 0, 4096, at.versionInfo);
      strings = readVersionStrings(block.subarray(0, bytesRead));
    } finally { await fd2.close(); }
  }

  let signer = null;
  if (hdr.sigSize) {
    const fd3 = await fs.promises.open(file, 'r');
    const cert = Buffer.alloc(hdr.sigSize);
    try { await fd3.read(cert, 0, hdr.sigSize, hdr.sigOffset); } finally { await fd3.close(); }
    const dir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'proglintor-sig-'));
    try { signer = await readSigner(cert.subarray(8), dir); } finally { await fs.promises.rm(dir, { recursive: true, force: true }).catch(() => {}); }
  }

  const version = [strings.ProductVersion, strings.FileVersion].find((v) => /^\d+(\.\d+)+/.test(v || '')) || '';
  return {
    valid: true,
    machine: hdr.machine,
    signed: hdr.sigSize > 0,
    signer: signer?.signer || '',
    issuer: signer?.issuer || '',
    framework: framework?.id || '',
    frameworkLabel: framework?.label || '',
    silentArgs: framework ? framework.silentArgs : [],
    productName: strings.ProductName || '',
    company: strings.CompanyName || '',
    description: strings.FileDescription || '',
    version,
  };
}

module.exports = { inspectExe, readHeaders, readVersionStrings, FRAMEWORKS };
