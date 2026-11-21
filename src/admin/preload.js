'use strict';
const { contextBridge, ipcRenderer } = require('electron');

/** Main returns errors as { __error, auth, network }; turn them back into rejections. */
const call = (ch) => async (...args) => {
  const r = await ipcRenderer.invoke(ch, ...args);
  if (r && typeof r === 'object' && '__error' in r) {
    throw Object.assign(new Error(r.__error), { auth: r.auth, network: r.network });
  }
  return r;
};

contextBridge.exposeInMainWorld('admin', {
  // Sign-in to the Django backend
  authStatus: call('auth:status'),
  login: (url, username, password) => ipcRenderer.invoke('auth:login', url, username, password),
  logout: call('auth:logout'),
  // Data
  dashboard: call('dash:get'),
  assets: call('assets:list'),
  assetDetail: call('assets:detail'),
  createAsset: (data) => ipcRenderer.invoke('assets:create', data),
  updateAsset: (id, data) => ipcRenderer.invoke('assets:update', id, data),
  deleteAsset: call('assets:delete'),
  resetEnrollment: call('assets:reset'),
  alerts: call('alerts:list'),
  updateAlert: call('alerts:update'),
  getPolicy: call('policy:get'),
  setPolicy: call('policy:set'),
  serverInfo: call('server:info'),
  getSettings: call('settings:get'),
  setSettings: call('settings:set'),
  exportCSV: call('data:export'),
  copy: call('clipboard:write'),
  onUpdate: (fn) => ipcRenderer.on('admin:update', () => fn()),
  onNavigate: (fn) => ipcRenderer.on('admin:navigate', (_e, page) => fn(page)),
  onAuthRequired: (fn) => ipcRenderer.on('admin:auth', (_e, msg) => fn(msg)),
});

// The shared UI helpers expect `agent.icon` / `agent.platform`; remote apps have no local icon.
contextBridge.exposeInMainWorld('agent', { icon: async () => null, platform: process.platform });
