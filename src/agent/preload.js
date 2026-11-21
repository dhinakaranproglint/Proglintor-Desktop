'use strict';
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('agent', {
  rangeView: (range, anchor) => ipcRenderer.invoke('usage:range', range, anchor),
  appDetail: (id, day) => ipcRenderer.invoke('usage:detail', id, day),
  installed: (refresh = false) => ipcRenderer.invoke('apps:installed', refresh),
  icon: (id, path) => ipcRenderer.invoke('icon:get', id, path),
  status: () => ipcRenderer.invoke('status:get'),
  getSettings: () => ipcRenderer.invoke('settings:get'),
  setSettings: (patch) => ipcRenderer.invoke('settings:set', patch),
  swiftCheck: () => ipcRenderer.invoke('swift:check'),
  swiftImport: () => ipcRenderer.invoke('swift:import'),
  exportCSV: () => ipcRenderer.invoke('data:export'),
  clearData: () => ipcRenderer.invoke('data:clear'),
  openDataFolder: () => ipcRenderer.invoke('data:folder'),
  openApp: (path) => ipcRenderer.invoke('app:open', path),
  revealApp: (path) => ipcRenderer.invoke('app:reveal', path),
  showWindow: () => ipcRenderer.invoke('window:show'),
  // Proglint organization
  orgStatus: () => ipcRenderer.invoke('org:status'),
  enroll: (code) => ipcRenderer.invoke('org:enroll', code),
  syncNow: () => ipcRenderer.invoke('org:sync'),
  // Install assistant
  software: {
    catalogue: () => ipcRenderer.invoke('sw:catalogue'),
    list: () => ipcRenderer.invoke('sw:list'),
    preview: (prompt) => ipcRenderer.invoke('sw:preview', prompt),
    assist: (message, history) => ipcRenderer.invoke('sw:assist', message, history),
    submit: (prompt, key, reinstall) => ipcRenderer.invoke('sw:submit', prompt, key, reinstall === true),
    confirm: (id) => ipcRenderer.invoke('sw:confirm', id),
    cancel: (id) => ipcRenderer.invoke('sw:cancel', id),
  },
  /** An install request changed (approved, progress, finished). */
  onSoftware: (fn) => ipcRenderer.on('agent:software', () => fn()),
  /** A notification asked to open a page. */
  onGoto: (fn) => ipcRenderer.on('agent:goto', (_e, page) => fn(page)),
  // Weekend work check
  warningInfo: () => ipcRenderer.invoke('warning:info'),
  warningSubmit: (answer) => ipcRenderer.invoke('warning:submit', answer),
  warningLater: () => ipcRenderer.invoke('warning:later'),
  warningClose: () => ipcRenderer.invoke('warning:close'),
  quit: () => ipcRenderer.invoke('app:quit'),
  /** Called when the current app/state changes (instant) or periodically (running totals). */
  onNavigate: (fn) => ipcRenderer.on('agent:navigate', () => fn()),
  onUpdate: (fn) => {
    ipcRenderer.on('agent:update', () => fn('update'));
    ipcRenderer.on('agent:tick', () => fn('tick'));
  },
  platform: process.platform,
});
