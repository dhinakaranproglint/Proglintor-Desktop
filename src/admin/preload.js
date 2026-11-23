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
  checkBackend: (url) => ipcRenderer.invoke('auth:check', url),
  login: (url, login, password) => ipcRenderer.invoke('auth:login', url, login, password),
  setupAdmin: (url, form) => ipcRenderer.invoke('auth:setup', url, form),
  forgotPassword: (url, login) => ipcRenderer.invoke('auth:forgot', url, login),
  resetPassword: (url, login, code, password) => ipcRenderer.invoke('auth:reset', url, login, code, password),
  logout: call('auth:logout'),
  // Data
  dashboard: call('dash:get'),
  employees: call('employees:list'),
  createEmployee: (data) => ipcRenderer.invoke('employees:create', data),
  updateEmployee: (id, data) => ipcRenderer.invoke('employees:update', id, data),
  deleteEmployee: (id, name) => ipcRenderer.invoke('employees:delete', id, name),
  assets: call('assets:list'),
  assetDetail: call('assets:detail'),
  createAsset: (data) => ipcRenderer.invoke('assets:create', data),
  updateAsset: (id, data) => ipcRenderer.invoke('assets:update', id, data),
  deleteAsset: call('assets:delete'),
  resetEnrollment: call('assets:reset'),
  alerts: call('alerts:list'),
  updateAlert: call('alerts:update'),
  // Software catalogue & approvals
  softwareItems: call('sw:items'),
  createSoftware: (data) => ipcRenderer.invoke('sw:item:create', data),
  updateSoftware: (slug, data) => ipcRenderer.invoke('sw:item:update', slug, data),
  deleteSoftware: call('sw:item:delete'),
  softwarePresets: call('sw:presets'),
  inspectSoftware: (req) => ipcRenderer.invoke('sw:inspect', req),
  cancelInspect: () => ipcRenderer.invoke('sw:inspect:cancel'),
  onInspect: (fn) => ipcRenderer.on('admin:inspect', (_e, stage) => fn(stage)),
  approveNewSoftware: (id, expectedVersion, item, licenceConfirmed) => ipcRenderer.invoke('sw:approve-new', id, expectedVersion, item, licenceConfirmed),
  softwareApprovals: call('sw:approvals'),
  softwareRequests: call('sw:requests'),
  softwareRequest: call('sw:request'),
  decideSoftware: (id, decision, expectedVersion, comment) => ipcRenderer.invoke('sw:decide', id, decision, expectedVersion, comment),
  // Orbit
  orbitTasks: call('orbit:tasks'),
  createTask: (data) => ipcRenderer.invoke('orbit:task:create', data),
  updateTask: (id, data) => ipcRenderer.invoke('orbit:task:update', id, data),
  deleteTask: (id) => ipcRenderer.invoke('orbit:task:delete', id),
  recognitions: call('orbit:recs'),
  decideRecognition: (id, body) => ipcRenderer.invoke('orbit:rec:decide', id, body),
  awardRecognition: (body) => ipcRenderer.invoke('orbit:rec:award', body),
  certificate: (id) => ipcRenderer.invoke('orbit:rec:cert', id),
  orbitTeam: call('orbit:team'),
  orbitMessages: call('orbit:messages'),
  resolveMessage: (id) => ipcRenderer.invoke('orbit:message:resolve', id),
  employeeTimesheet: call('ts:get'),
  timesheetSummary: call('ts:summary'),
  awardCandidates: call('awards:candidates'),
  awards: call('awards:list'),
  awardCitation: (month, assetId) => ipcRenderer.invoke('awards:citation', month, assetId),
  makeAward: (body) => ipcRenderer.invoke('awards:make', body),
  orbitChat: (messages) => ipcRenderer.invoke('orbit:chat', messages),
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

// The shared UI helpers expect `agent.icon(id)`: icons come from the backend, fetched in batches.
let queue = [];
let timer = null;
function icon(id) {
  return new Promise((resolve) => {
    queue.push({ id, resolve });
    if (!timer) {
      timer = setTimeout(async () => {
        const batch = queue;
        queue = [];
        timer = null;
        let icons = {};
        try { icons = await ipcRenderer.invoke('icons:get', [...new Set(batch.map((b) => b.id))]); } catch { /* show letters */ }
        for (const b of batch) b.resolve(icons?.[b.id] || null);
      }, 40);
    }
  });
}
contextBridge.exposeInMainWorld('agent', { icon, platform: process.platform });
