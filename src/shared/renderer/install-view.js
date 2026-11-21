'use strict';
// Turns a request's status/progress into what the activity card shows: steps, an honest progress bar, a headline.
// Loaded as a plain script in the renderer (global `InstallView`) and with require() in tests.
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.InstallView = factory();
}(typeof self !== 'undefined' ? self : this, () => {
  const ACTIVE = new Set(['QUEUED', 'DISPATCHED', 'RUNNING', 'VERIFYING']);
  const TERMINAL = new Set(['SUCCEEDED', 'FAILED', 'FAILED_VERIFICATION', 'CANCELLED', 'EXPIRED', 'REJECTED', 'BLOCKED', 'NOT_FOUND', 'INCOMPATIBLE', 'ALREADY_INSTALLED']);
  /** Statuses that never reached the install pipeline: they get a simple outcome card, not a stepper. */
  const NO_STEPS = new Set(['NOT_FOUND', 'INCOMPATIBLE', 'ALREADY_INSTALLED', 'NEEDS_CLARIFICATION', 'PROPOSED']);
  /** Outcomes that are fully explained by the sentence in the chat, so they get no activity card. */
  const NO_CARD = NO_STEPS;

  const isActive = (s) => ACTIVE.has(s);
  const isTerminal = (s) => TERMINAL.has(s);
  const isOpen = (s) => s === 'AWAITING_APPROVAL' || ACTIVE.has(s);
  const isCancellable = (s) => s === 'AWAITING_APPROVAL' || s === 'QUEUED';

  const STEPS = ['Requested', 'Approved', 'Downloading', 'Installing', 'Verified'];

  /** Step index being worked on (or that failed): 1 approval · 2 download · 3 install · 4 verify · 5 finished. */
  function stepIndex(req) {
    const phase = String(req.progressPhase || '').toUpperCase();
    switch (req.status) {
      case 'AWAITING_APPROVAL': case 'REJECTED': return 1;
      case 'QUEUED': return 2;
      case 'DISPATCHED': return 2;
      case 'RUNNING': return 3;
      case 'VERIFYING': return 4;
      case 'SUCCEEDED': return 5;
      case 'CANCELLED': case 'EXPIRED': case 'BLOCKED': case 'FAILED': case 'FAILED_VERIFICATION':
        if (phase === 'VERIFYING') return 4;
        if (phase === 'INSTALLING') return 3;
        if (phase === 'DOWNLOADING') return 2;
        return req.decidedBy || req.status === 'FAILED' || req.status === 'BLOCKED' ? 2 : 1;
      default: return 1;
    }
  }

  /** -> [{ label, state: 'done'|'active'|'failed'|'todo' }] or null when no stepper applies. */
  function steps(req) {
    if (NO_STEPS.has(req.status)) return null;
    const at = stepIndex(req);
    const failed = ['FAILED', 'FAILED_VERIFICATION', 'BLOCKED', 'REJECTED', 'CANCELLED', 'EXPIRED'].includes(req.status);
    return STEPS.map((label, i) => {
      if (req.status === 'SUCCEEDED') return { label, state: 'done' };
      if (i === 0) return { label, state: 'done' };
      if (i < at) return { label, state: 'done' };
      if (i === at) {
        if (failed) {
          const early = at <= 1; // stopped while waiting for approval: name what happened instead of the step
          const named = { REJECTED: 'Declined', CANCELLED: early ? 'Cancelled' : label, EXPIRED: early ? 'Expired' : label }[req.status];
          return { label: named || label, state: 'failed' };
        }
        if (req.status === 'AWAITING_APPROVAL') return { label: req.kind === 'new' ? 'IT is reviewing it' : 'Waiting for approval', state: 'active' };
        if (req.status === 'QUEUED') return { label: 'Starting', state: 'active' };
        return { label, state: 'active' };
      }
      return { label, state: 'todo' };
    });
  }

  const BADGE = {
    AWAITING_APPROVAL: ['Waiting for approval', 'wait'], PROPOSED: ['Needs your OK', 'wait'], QUEUED: ['Starting', 'live'], DISPATCHED: ['Downloading', 'live'], RUNNING: ['Installing', 'live'],
    VERIFYING: ['Verifying', 'live'], SUCCEEDED: ['Installed', 'ok'], FAILED: ['Failed', 'bad'], FAILED_VERIFICATION: ['Failed', 'bad'],
    REJECTED: ['Declined', 'bad'], CANCELLED: ['Cancelled', 'muted'], EXPIRED: ['Expired', 'muted'], BLOCKED: ['Stopped', 'bad'],
    NOT_FOUND: ['Not in catalogue', 'muted'], INCOMPATIBLE: ['Not available', 'muted'], ALREADY_INSTALLED: ['Already installed', 'ok'],
  };
  const badge = (status) => { const [label, tone] = BADGE[status] || [String(status || '').replace(/_/g, ' ').toLowerCase(), 'muted']; return { label, tone }; };

  function headline(status, kind) {
    switch (status) {
      case 'AWAITING_APPROVAL': return kind === 'new' ? 'IT is checking this app before adding it to the approved list' : 'Waiting for an admin to approve this';
      case 'QUEUED': return 'Approved — getting ready to install';
      case 'DISPATCHED': return 'Downloading the installer';
      case 'RUNNING': return 'Installing…';
      case 'VERIFYING': return 'Checking the installation…';
      case 'SUCCEEDED': return 'Installed and verified';
      case 'REJECTED': return 'Declined by your admin';
      case 'CANCELLED': return 'Cancelled';
      case 'EXPIRED': return 'Expired';
      case 'BLOCKED': return 'Stopped for safety';
      case 'FAILED': case 'FAILED_VERIFICATION': return "Couldn't finish the install";
      default: return String(status || '').replace(/_/g, ' ').toLowerCase();
    }
  }

  function bytes(n) {
    if (!Number.isFinite(n) || n < 0) return '0 B';
    const units = ['B', 'KB', 'MB', 'GB'];
    let v = n, i = 0;
    while (v >= 1024 && i < units.length - 1) { v /= 1024; i += 1; }
    return `${v.toFixed(i === 0 || v >= 10 ? 0 : 1)} ${units[i]}`;
  }

  /**
   * Honest progress: the download band (10–55%) comes from real byte counts; install and verify are shown as
   * "working" (indeterminate) — there's no invented percentage. If the laptop stops reporting, say so.
   * @returns {{percent:number|null, indeterminate:boolean, detail:string}}
   */
  function progress(req, nowMs = Date.now()) {
    const { status } = req;
    if (status === 'SUCCEEDED') return { percent: 100, indeterminate: false, detail: 'Done' };
    if (status === 'QUEUED') return { percent: 5, indeterminate: true, detail: 'Waiting for this computer to start…' };
    if (!ACTIVE.has(status)) return { percent: null, indeterminate: false, detail: '' };

    const stale = req.progressUpdatedAt && nowMs - Number(req.progressUpdatedAt) > 3 * 60 * 1000;
    const done = Number.isFinite(req.progressBytesDone) ? Math.max(0, req.progressBytesDone) : null;
    const total = Number.isFinite(req.progressBytesTotal) && req.progressBytesTotal > 0 ? req.progressBytesTotal : null;
    if (stale && status !== 'VERIFYING') return { percent: null, indeterminate: true, detail: "No update from this computer for a few minutes — I'm still waiting…" };

    if (status === 'DISPATCHED') {
      if (done !== null && total !== null) return { percent: Math.round(10 + Math.min(1, done / total) * 45), indeterminate: false, detail: `Downloading ${bytes(done)} of ${bytes(total)}` };
      if (done) return { percent: null, indeterminate: true, detail: `Downloading ${bytes(done)}…` };
      return { percent: 12, indeterminate: true, detail: 'Preparing the download…' };
    }
    if (status === 'VERIFYING') return { percent: 92, indeterminate: true, detail: 'Checking the app is signed and in place…' };
    return { percent: 60, indeterminate: true, detail: 'Installing on this computer…' };
  }

  /** "2m 05s" since the install started. */
  function elapsed(req, nowMs = Date.now()) {
    const started = Number(req.jobClaimedAt || req.createdAt);
    if (!Number.isFinite(started) || started > nowMs) return '';
    const sec = Math.floor((nowMs - started) / 1000);
    return sec < 60 ? `${sec}s` : `${Math.floor(sec / 60)}m ${String(sec % 60).padStart(2, '0')}s`;
  }

  return { ACTIVE, STEPS, NO_CARD, isActive, isTerminal, isOpen, isCancellable, steps, badge, headline, progress, elapsed, bytes };
}));
