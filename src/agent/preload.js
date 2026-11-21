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
  enroll: (server, code) => ipcRenderer.invoke('org:enroll', server, code),
  syncNow: () => ipcRenderer.invoke('org:sync'),
  // Weekend work check
  warningInfo: () => ipcRenderer.invoke('warning:info'),
  warningSubmit: (answer) => ipcRenderer.invoke('warning:submit', answer),
  warningLater: () => ipcRenderer.invoke('warning:later'),
  warningClose: () => ipcRenderer.invoke('warning:close'),
  quit: () => ipcRenderer.invoke('app:quit'),
  /** Called when the current app/state changes (instant) or periodically (running totals). */
  onUpdate: (fn) => {
    ipcRenderer.on('agent:update', () => fn('update'));
    ipcRenderer.on('agent:tick', () => fn('tick'));
  },
  platform: process.platform,
});
