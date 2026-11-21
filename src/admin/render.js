'use strict';
// Some vendor download pages (Zoom, for one) contain no installer links in their HTML: a script creates them when you click
// "Download". This opens such a page in a hidden, locked-down browser, clicks its Download buttons like a person would, and
// records the addresses the page tries to open or download. Nothing is ever executed or saved: the addresses are only handed back
// to be checked like any other link (download, signature, checksum).
//
// The window is sandboxed with no Node access and no preload script, uses a throw-away in-memory session, refuses every permission
// request, cannot open other windows, never saves a download, only talks https to public hosts, and is destroyed after a short deadline.
const { classify } = require('./links');

const DEADLINE_MS = 25 * 1000;
const SETTLE_MS = 4500;
const MAX_CLICKS = 10;
const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Safari/605.1.15';

/** Requests the page may make: https (or data/blob) to public host names only. */
function allowedRequest(urlString) {
  let u;
  try { u = new URL(urlString); } catch { return false; }
  if (u.protocol === 'data:' || u.protocol === 'blob:' || u.protocol === 'devtools:') return true;
  if (u.protocol !== 'https:' && u.protocol !== 'wss:') return false;
  const h = u.hostname.toLowerCase();
  if (h === 'localhost' || h.endsWith('.local') || h.endsWith('.internal') || !h.includes('.')) return false;
  if (/^\d+\.\d+\.\d+\.\d+$/.test(h)) return false; // IP addresses: never (this also keeps the page off the local network)
  return !h.includes(':'); // IPv6 literals
}

const STORE_HOSTS = /(^|\.)(apps\.apple\.com|itunes\.apple\.com|play\.google\.com|chromewebstore\.google\.com|microsoft\.com\/store|apps\.microsoft\.com|snapcraft\.io|flathub\.org)$/i;

/** Which captured addresses are worth offering: real files, and download endpoints on the vendor's side. Not app stores, not the page itself. */
function keepCaptured(urlString, pageUrl) {
  let u;
  try { u = new URL(urlString); } catch { return false; }
  if (u.protocol !== 'https:' || STORE_HOSTS.test(u.hostname)) return false;
  u.hash = '';
  const page = new URL(pageUrl);
  page.hash = '';
  if (u.toString() === page.toString()) return false;
  const kind = classify(u.toString());
  if (kind) return Boolean(kind.type) || /download|latest|client|release|installer|\/dl\//i.test(u.pathname + u.search);
  return !/\.(zip|tar\.\w+|tgz|deb|rpm|7z|gz|xz|msix?|appx)$/i.test(u.pathname) && /download|latest|client|release|installer|\/dl\//i.test(u.pathname + u.search);
}

/**
 * @param {string} pageUrl
 * @param {{ electron?: object, deadlineMs?: number }} [opts]  `electron` lets tests pass a stand-in
 * @returns {Promise<{url:string,file:string,platform:string,type:string,label:string}[]>}  addresses the page tried to download, best guesses first
 */
async function renderAndCapture(pageUrl, opts = {}) {
  const { BrowserWindow, session } = opts.electron || require('electron');
  const deadlineMs = opts.deadlineMs || DEADLINE_MS;
  const captured = []; // { url, label }
  let label = '';
  const note = (url) => { if (/^https:/i.test(url)) captured.push({ url, label }); };

  const ses = session.fromPartition(`render-${Date.now()}-${Math.random().toString(16).slice(2)}`); // no "persist:": memory only
  ses.setPermissionRequestHandler((_wc, _perm, cb) => cb(false));
  ses.setPermissionCheckHandler(() => false);
  ses.webRequest.onBeforeRequest((details, cb) => cb({ cancel: !allowedRequest(details.url) }));
  ses.on('will-download', (event, item) => { note(item.getURL()); event.preventDefault(); });

  const win = new BrowserWindow({
    show: false, width: 1280, height: 900,
    webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false, session: ses, webSecurity: true, allowRunningInsecureContent: false, images: false, spellcheck: false },
  });
  win.webContents.setAudioMuted(true);
  win.webContents.setWindowOpenHandler(({ url }) => { note(url); return { action: 'deny' }; });
  win.webContents.on('will-navigate', (event, url) => { if (url !== win.webContents.getURL()) { note(url); event.preventDefault(); } });

  const run = async () => {
    await win.loadURL(pageUrl, { userAgent: UA });
    await new Promise((r) => setTimeout(r, SETTLE_MS));
    // Download buttons (and links) on the page, each with a human label taken from the button or the heading above it.
    const buttons = await win.webContents.executeJavaScript(`(() => {
      const out = [];
      const nodes = [...document.querySelectorAll('a,button,[role="button"]')];
      for (const el of nodes) {
        const text = ((el.getAttribute('aria-label') || el.innerText || el.textContent || '') + '').replace(/\\s+/g, ' ').trim();
        if (!/download|install|get\\s/i.test(text) || text.length > 120) continue;
        const href = el.tagName === 'A' ? el.href : '';
        const box = el.closest('section,article,li,div') || el;
        const heading = (box.querySelector('h1,h2,h3,h4') || {}).innerText || '';
        out.push({ index: nodes.indexOf(el), text, heading: heading.replace(/\\s+/g, ' ').trim().slice(0, 80), href });
      }
      return out.slice(0, ${MAX_CLICKS * 3});
    })()`);
    let clicks = 0;
    for (const b of buttons) {
      if (clicks >= MAX_CLICKS) break;
      if (b.href && /^https:/i.test(b.href) && !b.href.split('#')[0].endsWith(new URL(pageUrl).pathname) && classify(b.href)) { label = b.text; note(b.href); continue; }
      label = [b.text, b.heading].filter(Boolean).join(' · ').slice(0, 120);
      clicks += 1;
      await win.webContents.executeJavaScript(`(() => { const el = [...document.querySelectorAll('a,button,[role="button"]')][${b.index}]; if (el) el.click(); })()`).catch(() => {});
      await new Promise((r) => setTimeout(r, 700));
    }
  };

  try {
    await Promise.race([run(), new Promise((_, reject) => setTimeout(() => reject(new Error('timeout')), deadlineMs))]);
  } catch { /* a slow or broken page: keep whatever was captured */ } finally {
    if (!win.isDestroyed()) win.destroy();
    await ses.clearStorageData().catch(() => {});
  }

  const seen = new Set();
  const out = [];
  for (const c of captured) {
    let u;
    try { u = new URL(c.url); } catch { continue; }
    u.hash = '';
    const key = u.toString();
    if (seen.has(key)) continue;
    seen.add(key);
    if (!keepCaptured(key, pageUrl)) continue;
    let kind = classify(key);
    if (!kind) {
      if (/\.(zip|tar\.\w+|tgz|deb|rpm|7z|gz|xz|msix?|appx)$/i.test(u.pathname)) continue; // a Windows/portable/Linux package: not installable
      kind = { platform: 'darwin', type: '' }; // a click on a Download button: an endpoint without a file extension is fine
    }
    out.push({ url: key, file: decodeURIComponent(u.pathname.split('/').filter(Boolean).pop() || u.hostname), platform: kind.platform, type: kind.type, label: c.label });
  }
  return out;
}

module.exports = { renderAndCapture, allowedRequest, keepCaptured };
