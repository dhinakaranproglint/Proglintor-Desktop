'use strict';
/* global agent */
/* exported UI */
// Shared helpers for the dashboard and the tray popover.

const UI = (() => {
  const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

  /** 2h 14m · 12m 5s · 40s */
  function fmtDur(sec) {
    const t = Math.round(sec || 0);
    const h = Math.floor(t / 3600), m = Math.floor((t % 3600) / 60), s = t % 60;
    if (h) return `${h}h ${m}m`;
    if (m) return m < 10 && s ? `${m}m ${s}s` : `${m}m`;
    return `${s}s`;
  }

  /** Big-number markup: <b>2</b><small>h</small> <b>14</b><small>m</small> */
  function fmtBig(sec) {
    const t = Math.round(sec || 0);
    const h = Math.floor(t / 3600), m = Math.floor((t % 3600) / 60), s = t % 60;
    const part = (v, u) => `<b>${v}</b><small>${u}</small>`;
    if (h) return `${part(h, 'h')} ${part(m, 'm')}`;
    if (m) return `${part(m, 'm')} ${part(s, 's')}`;
    return part(s, 's');
  }

  /** Live timer: 1:02:09 or 12:09 */
  function fmtClock(sec) {
    const t = Math.max(0, Math.floor(sec || 0));
    const h = Math.floor(t / 3600), m = Math.floor((t % 3600) / 60), s = t % 60;
    const p = (n) => String(n).padStart(2, '0');
    return h ? `${h}:${p(m)}:${p(s)}` : `${m}:${p(s)}`;
  }

  const fmtTime = (ts) => new Date(ts).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  const fmtDate = (ts, opts = { month: 'short', day: 'numeric', year: 'numeric' }) => new Date(ts).toLocaleDateString([], opts);

  function rel(ts) {
    if (!ts) return 'Never';
    const diff = Date.now() - ts;
    const rtf = new Intl.RelativeTimeFormat([], { numeric: 'auto' });
    if (diff < 60e3) return 'just now';
    if (diff < 3600e3) return rtf.format(-Math.round(diff / 60e3), 'minute');
    if (diff < 86400e3) return rtf.format(-Math.round(diff / 3600e3), 'hour');
    if (diff < 30 * 86400e3) return rtf.format(-Math.round(diff / 86400e3), 'day');
    return fmtDate(ts);
  }

  const startOfDay = (ts) => { const d = new Date(ts); d.setHours(0, 0, 0, 0); return d.getTime(); };
  const addDays = (ts, n) => { const d = new Date(ts); d.setDate(d.getDate() + n); return d.getTime(); };

  // Lucide-style line icons (MIT), inlined so the app works offline.
  const ICONS = {
    overview: '<path d="M3 3v18h18"/><path d="M7 15l4-4 3 3 5-6"/>',
    apps: '<rect x="3" y="3" width="7" height="7" rx="1.5"/><rect x="14" y="3" width="7" height="7" rx="1.5"/><rect x="3" y="14" width="7" height="7" rx="1.5"/><rect x="14" y="14" width="7" height="7" rx="1.5"/>',
    settings: '<path d="M12.2 2h-.4a2 2 0 0 0-2 2v.2a2 2 0 0 1-1 1.7l-.4.3a2 2 0 0 1-2 0l-.2-.1a2 2 0 0 0-2.7.7l-.2.4a2 2 0 0 0 .7 2.7l.2.1a2 2 0 0 1 1 1.7v.6a2 2 0 0 1-1 1.7l-.2.1a2 2 0 0 0-.7 2.7l.2.4a2 2 0 0 0 2.7.7l.2-.1a2 2 0 0 1 2 0l.4.3a2 2 0 0 1 1 1.7v.2a2 2 0 0 0 2 2h.4a2 2 0 0 0 2-2v-.2a2 2 0 0 1 1-1.7l.4-.3a2 2 0 0 1 2 0l.2.1a2 2 0 0 0 2.7-.7l.2-.4a2 2 0 0 0-.7-2.7l-.2-.1a2 2 0 0 1-1-1.7v-.6a2 2 0 0 1 1-1.7l.2-.1a2 2 0 0 0 .7-2.7l-.2-.4a2 2 0 0 0-2.7-.7l-.2.1a2 2 0 0 1-2 0l-.4-.3a2 2 0 0 1-1-1.7V4a2 2 0 0 0-2-2z"/><circle cx="12" cy="12" r="3"/>',
    left: '<path d="M15 18l-6-6 6-6"/>',
    right: '<path d="M9 18l6-6-6-6"/>',
    search: '<circle cx="11" cy="11" r="7"/><path d="M21 21l-4.3-4.3"/>',
    refresh: '<path d="M21 12a9 9 0 0 1-15.5 6.2L3 16"/><path d="M3 21v-5h5"/><path d="M3 12a9 9 0 0 1 15.5-6.2L21 8"/><path d="M21 3v5h-5"/>',
    open: '<path d="M15 3h6v6"/><path d="M10 14L21 3"/><path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6"/>',
    folder: '<path d="M4 20h16a2 2 0 0 0 2-2V8a2 2 0 0 0-2-2h-7.9a2 2 0 0 1-1.7-.9l-.8-1.2A2 2 0 0 0 7.9 3H4a2 2 0 0 0-2 2v13a2 2 0 0 0 2 2z"/>',
    pause: '<rect x="6" y="4" width="4" height="16" rx="1"/><rect x="14" y="4" width="4" height="16" rx="1"/>',
    play: '<path d="M6 4l14 8-14 8z"/>',
    close: '<path d="M18 6L6 18"/><path d="M6 6l12 12"/>',
    clock: '<circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/>',
    up: '<path d="M7 17L17 7"/><path d="M8 7h9v9"/>',
    down: '<path d="M7 7l10 10"/><path d="M17 8v9H8"/>',
    download: '<path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><path d="M7 10l5 5 5-5"/><path d="M12 15V3"/>',
    trash: '<path d="M3 6h18"/><path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6"/><path d="M10 11v6M14 11v6"/><path d="M9 6V4a1 1 0 0 1 1-1h4a1 1 0 0 1 1 1v2"/>',
    power: '<path d="M12 2v10"/><path d="M18.4 6.6a9 9 0 1 1-12.8 0"/>',
    import: '<path d="M12 3v12"/><path d="M7 10l5 5 5-5"/><path d="M5 21h14"/>',
    spark: '<path d="M13 2L3 14h9l-1 8 10-12h-9z"/>',
    calendar: '<rect x="3" y="4" width="18" height="18" rx="2"/><path d="M16 2v4M8 2v4M3 10h18"/>',
    alert: '<path d="M10.3 3.9L1.8 18a2 2 0 0 0 1.7 3h17a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0z"/><path d="M12 9v4"/><path d="M12 17h.01"/>',
    check: '<path d="M20 6L9 17l-5-5"/>',
    send: '<path d="M22 2L11 13"/><path d="M22 2l-7 20-4-9-9-4z"/>',
    plus: '<path d="M12 5v14M5 12h14"/>',
    copy: '<rect x="9" y="9" width="13" height="13" rx="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/>',
    edit: '<path d="M12 20h9"/><path d="M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4z"/>',
    user: '<circle cx="12" cy="8" r="4"/><path d="M4 21a8 8 0 0 1 16 0"/>',
    monitor: '<rect x="2" y="3" width="20" height="14" rx="2"/><path d="M8 21h8M12 17v4"/>',
    wifi: '<path d="M5 12.6a10 10 0 0 1 14 0"/><path d="M8.5 16.1a5 5 0 0 1 7 0"/><path d="M2 8.8a15 15 0 0 1 20 0"/><path d="M12 20h.01"/>',
    server: '<rect x="3" y="3" width="18" height="7.5" rx="2"/><rect x="3" y="13.5" width="18" height="7.5" rx="2"/><path d="M7 6.75h.01M7 17.25h.01"/><path d="M11 6.75h6M11 17.25h6"/>',
    mail: '<rect x="2" y="4" width="20" height="16" rx="2.5"/><path d="M22 7l-10 6L2 7"/>',
    lock: '<rect x="4" y="11" width="16" height="10" rx="2"/><path d="M8 11V7a4 4 0 0 1 8 0v4"/>',
    eye: '<path d="M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7-10-7-10-7z"/><circle cx="12" cy="12" r="3"/>',
    eyeOff: '<path d="M9.9 4.2A10.4 10.4 0 0 1 12 4c6.5 0 10 8 10 8a17.6 17.6 0 0 1-2.4 3.4M6.6 6.6A17 17 0 0 0 2 12s3.5 8 10 8a9.7 9.7 0 0 0 5.4-1.6"/><path d="M14.1 14.1a3 3 0 0 1-4.2-4.2"/><path d="M2 2l20 20"/>',
    shield: '<path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"/>',
    dashboard: '<rect x="3" y="3" width="7" height="9" rx="1.5"/><rect x="14" y="3" width="7" height="5" rx="1.5"/><rect x="14" y="12" width="7" height="9" rx="1.5"/><rect x="3" y="16" width="7" height="5" rx="1.5"/>',
    bell: '<path d="M6 8a6 6 0 0 1 12 0c0 7 3 9 3 9H3s3-2 3-9"/><path d="M10.3 21a1.9 1.9 0 0 0 3.4 0"/>',
    building: '<rect x="4" y="2" width="16" height="20" rx="2"/><path d="M9 22v-4h6v4M8 6h.01M16 6h.01M12 6h.01M12 10h.01M12 14h.01M16 10h.01M16 14h.01M8 10h.01M8 14h.01"/>',
  };
  const icon = (name, size = 16) => `<svg class="i" width="${size}" height="${size}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${ICONS[name] || ''}</svg>`;

  // ---- app icons (cached so re-renders never flicker) ----
  const iconCache = new Map();
  const pending = new Map();

  function hue(str) {
    let h = 0;
    for (const c of String(str)) h = (h * 31 + c.charCodeAt(0)) % 360;
    return h;
  }

  function appIcon(id, path, size = 28, name = '') {
    const key = `${id}|${path || ''}`;
    const url = iconCache.get(key);
    const style = `width:${size}px;height:${size}px`;
    if (url) return `<img class="appicon" style="${style}" src="${url}" alt="">`;
    const letter = esc((name || id || '?').replace(/^(com|org|net|io)\./, '').charAt(0).toUpperCase());
    const ph = `<span class="appicon ph" style="${style};font-size:${Math.round(size * 0.45)}px;--h:${hue(id)}" data-icon-key="${esc(key)}" data-icon-id="${esc(id)}" data-icon-path="${esc(path || '')}">${letter}</span>`;
    return ph;
  }

  const missUntil = new Map(); // key -> time before which we don't ask again (icon may be uploaded later)

  async function hydrate(root = document) {
    for (const el of root.querySelectorAll('[data-icon-key]')) {
      const key = el.dataset.iconKey;
      if ((missUntil.get(key) || 0) > Date.now()) continue; // no icon yet: keep the letter for now
      if (!pending.has(key)) {
        pending.set(key, agent.icon(el.dataset.iconId, el.dataset.iconPath).then((u) => {
          if (u) iconCache.set(key, u); else missUntil.set(key, Date.now() + 90 * 1000);
          pending.delete(key);
          return u;
        }));
      }
      const u = await pending.get(key);
      if (u && el.isConnected) {
        const img = document.createElement('img');
        img.className = 'appicon';
        img.src = u;
        img.alt = '';
        img.style.cssText = el.style.cssText;
        el.replaceWith(img);
      }
    }
  }

  return { esc, fmtDur, fmtBig, fmtClock, fmtTime, fmtDate, rel, startOfDay, addDays, icon, appIcon, hydrate };
})();
