'use strict';
/* global admin, UI */
/* exported showLogin */
// Sign-in screen: sign in, create the first admin, forgot password, reset with a code.
// The backend connection is a small status pill in the top-right corner (click to change the address).

const Auth = {
  view: 'signin',        // signin | setup | forgot | reset
  url: '',
  login: '',
  status: null,          // { state: 'checking'|'ok'|'down', needsSetup, setupAllowed, message }
  resendAt: 0,
  popOpen: false,
};

const TITLES = { signin: 'Welcome back', setup: 'Create admin account', forgot: 'Reset password', reset: 'Enter code' };

function authEl() {
  let el = document.getElementById('login');
  if (!el) { el = document.createElement('div'); el.id = 'login'; document.body.appendChild(el); }
  return el;
}

/** Entry point (also used when a session expires). */
async function showLogin(message = '') {
  if (typeof closeDrawer === 'function') closeDrawer();
  if (typeof closeDialog === 'function') closeDialog();
  document.querySelector('.shell').hidden = true;
  const st = await admin.authStatus();
  Auth.url = st.url || Auth.url || 'http://127.0.0.1:8000';
  Auth.login = isEmail(st.lastLogin || '') ? st.lastLogin : (isEmail(Auth.login) ? Auth.login : '');
  Auth.view = 'signin';
  renderAuth({ error: message });
  checkBackend();
}

// ---- top-right backend pill ------------------------------------------------------------------

function hostOf(url) { return String(url).replace(/^https?:\/\//, ''); }

function pillHTML() {
  const s = Auth.status;
  const cls = !s || s.state === 'checking' ? 'checking' : s.state === 'ok' ? 'ok' : 'down';
  const tip = cls === 'ok' ? `Connected to ${hostOf(Auth.url)}` : cls === 'down' ? `Can't reach ${hostOf(Auth.url)}` : `Connecting to ${hostOf(Auth.url)}…`;
  return `
    <button type="button" class="bk-server ${cls}" id="bk-pill" title="${UI.esc(tip)}" aria-label="${UI.esc(tip)}">${UI.icon('server', 20)}<span class="bk-badge"></span></button>
    <div class="bk-pop" id="bk-pop" ${Auth.popOpen ? '' : 'hidden'}>
      <input class="input mono" id="bk-url" value="${UI.esc(Auth.url)}" placeholder="http://127.0.0.1:8000" spellcheck="false" aria-label="Server address">
      <button type="button" class="btn primary sm" id="bk-save">Connect</button>
    </div>`;
}

function renderPill() {
  const holder = document.getElementById('bk');
  if (!holder) return;
  holder.innerHTML = pillHTML();
  document.getElementById('bk-pill').addEventListener('click', () => {
    Auth.popOpen = !Auth.popOpen;
    renderPill();
    if (Auth.popOpen) document.getElementById('bk-url').select();
  });
  const save = () => {
    Auth.url = document.getElementById('bk-url').value.trim() || Auth.url;
    Auth.popOpen = false;
    renderPill();
    checkBackend();
  };
  document.getElementById('bk-save')?.addEventListener('click', save);
  document.getElementById('bk-url')?.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') { e.preventDefault(); save(); }
    if (e.key === 'Escape') { Auth.popOpen = false; renderPill(); }
  });
}

// ---- form ------------------------------------------------------------------------------------

/** Text input with a leading icon. */
function iconField(id, label, iconName, attrs = '', value = '') {
  return `<label class="field"><span>${label}</span>
    <div class="icon-input has-clear">${UI.icon(iconName, 16)}<input class="input" id="${id}" ${attrs} value="${UI.esc(value)}">
      <button type="button" class="clear-x" data-clear="${id}" title="Clear" aria-label="Clear ${UI.esc(label)}" tabindex="-1">${UI.icon('close', 13)}</button></div></label>`;
}

function pwField(id, label, autocomplete, aside = '') {
  return `<div class="field"><div class="label-row"><label for="${id}">${label}</label>${aside}</div>
    <div class="pw-wrap icon-input">${UI.icon('lock', 16)}<input class="input" id="${id}" type="password" autocomplete="${autocomplete}">
      <button type="button" class="pw-eye" data-eye="${id}" title="Show password" aria-label="Show password">${UI.icon('eye', 16)}</button></div></div>`;
}

function formBody(error) {
  const esc = UI.esc;
  const err = `<div class="form-error" id="a-err" role="alert">${esc(error)}</div>`;
  if (Auth.view === 'signin') {
    return `
      ${iconField('a-login', 'E-mail', 'mail', 'type="email" autocomplete="email"', Auth.login)}
      ${pwField('a-pass', 'Password', 'current-password', '<button type="button" class="link" data-view="forgot">Forgot password?</button>')}
      ${err}
      <button class="btn primary wide" type="submit" id="a-go">Sign in ${UI.icon('right', 16)}</button>`;
  }
  if (Auth.view === 'setup') {
    if (Auth.status?.setupAllowed === false) {
      return `<div class="form-error">Create the first admin on the backend computer.</div>`;
    }
    return `
      ${iconField('s-name', 'Full name', 'user', 'autocomplete="name"')}
      ${iconField('s-email', 'E-mail', 'mail', 'type="email" autocomplete="email"')}
      ${pwField('s-pass', 'Password', 'new-password')}
      ${pwField('s-pass2', 'Confirm password', 'new-password')}
      ${err}
      <button class="btn primary wide" type="submit" id="a-go">Create account</button>`;
  }
  if (Auth.view === 'forgot') {
    return `
      ${iconField('f-login', 'E-mail', 'mail', 'type="email" autocomplete="email"', Auth.login)}
      ${err}
      <button class="btn primary wide" type="submit" id="a-go">Send code</button>
      <div class="auth-links"><button type="button" class="link" data-view="signin">${UI.icon('left', 13)} Back to sign in</button></div>`;
  }
  const wait = Math.max(0, Math.ceil((Auth.resendAt - Date.now()) / 1000));
  return `
    <label class="field"><span>Code from e-mail</span><div class="icon-input">${UI.icon('shield', 16)}<input class="input code-input" id="r-code" inputmode="numeric" autocomplete="one-time-code" maxlength="7"></div></label>
    ${pwField('r-pass', 'New password', 'new-password')}
    ${pwField('r-pass2', 'Confirm new password', 'new-password')}
    ${err}
    <button class="btn primary wide" type="submit" id="a-go">Reset password</button>
    <div class="auth-links">
      <button type="button" class="link" data-view="signin">${UI.icon('left', 13)} Back to sign in</button>
      <button type="button" class="link" id="r-resend" ${wait ? 'disabled' : ''}>${wait ? `Resend in ${wait}s` : 'Resend code'}</button>
    </div>`;
}

const BRAND_PANEL = `
  <aside class="auth-brand" aria-hidden="true">
    <img class="auth-brand-logo" src="../../../assets/brand/proglint-logo-white.png" alt="">
    <div class="auth-art">
      <div class="art-card art-main">
        <div class="art-head"><span></span><span></span><span></span></div>
        <div class="art-bars">${[38, 62, 48, 80, 56, 92, 70, 44, 66, 84, 52, 74].map((h) => `<i style="height:${h}%"></i>`).join('')}</div>
      </div>
      <div class="art-card art-side">
        ${[0, 1, 2].map((n) => `<div class="art-row"><b class="av av${n}"></b><span><i></i><i></i></span><em class="${n === 1 ? 'off' : ''}"></em></div>`).join('')}
      </div>
    </div>
    <div class="auth-title">Proglintor<span>Admin</span></div>
    <div class="auth-foot">© ${new Date().getFullYear()} Proglint</div>
  </aside>`;

function renderAuth({ error = '', field = '' } = {}) {
  const el = authEl();
  el.innerHTML = `
    ${BRAND_PANEL}
    <main class="auth-main">
      <div class="bk" id="bk"></div>
      <form class="auth-form" id="auth-form" novalidate>
        <img class="auth-mini-logo" src="../../../assets/admin-icon.png" alt="">
        <h1>${UI.esc(TITLES[Auth.view])}</h1>
        ${formBody(error)}
      </form>
    </main>`;
  renderPill();
  bindAuth(field);
}

function bindAuth(field) {
  const $ = (s) => document.querySelector(s);
  if (field) {
    const map = { login: ['#a-login', '#f-login'], password: ['#a-pass', '#s-pass', '#r-pass'], code: ['#r-code'], username: ['#s-user'], email: ['#s-email'] }[field] || [];
    const input = map.map((s) => $(s)).find(Boolean);
    if (input) { input.classList.add('invalid'); input.focus(); }
  } else {
    const first = ['#a-login', '#s-name', '#f-login', '#r-code'].map((s) => $(s)).find((i) => i && !i.value) || $('#a-pass');
    first?.focus();
  }
  document.querySelectorAll('[data-eye]').forEach((b) => b.addEventListener('click', () => {
    const input = document.getElementById(b.dataset.eye);
    const show = input.type === 'password';
    input.type = show ? 'text' : 'password';
    b.innerHTML = UI.icon(show ? 'eyeOff' : 'eye', 16);
    b.title = show ? 'Hide password' : 'Show password';
  }));
  document.querySelectorAll('[data-view]').forEach((b) => b.addEventListener('click', () => {
    Auth.login = ($('#a-login') || $('#f-login'))?.value.trim() || Auth.login;
    Auth.view = b.dataset.view;
    renderAuth();
  }));
  $('#r-resend')?.addEventListener('click', () => sendCode());
  document.querySelectorAll('[data-clear]').forEach((b) => b.addEventListener('click', () => {
    const input = document.getElementById(b.dataset.clear);
    input.value = '';
    input.classList.remove('invalid');
    syncClear();
    input.focus();
  }));
  document.querySelectorAll('.has-clear .input').forEach((i) => i.addEventListener('input', syncClear));
  syncClear();
  $('#auth-form').addEventListener('submit', (e) => { e.preventDefault(); submitAuth(); });
  $('#auth-form').addEventListener('mousedown', () => { if (Auth.popOpen) { Auth.popOpen = false; renderPill(); } });
}

/** Shows the clear (x) button only while a box has text. */
function syncClear() {
  document.querySelectorAll('.has-clear').forEach((w) => w.classList.toggle('has-value', Boolean(w.querySelector('input')?.value)));
}

// ---- backend status ----------------------------------------------------------------------------

async function checkBackend() {
  const url = Auth.url.trim();
  if (!url) return;
  Auth.status = { state: 'checking' };
  renderPill();
  const r = await admin.checkBackend(url);
  if (url !== Auth.url.trim()) return; // address changed meanwhile
  Auth.status = r.ok ? { state: 'ok', ...r.data } : { state: 'down', message: r.error };
  if (r.ok) {
    if (r.data.needsSetup && Auth.view !== 'setup') { Auth.view = 'setup'; renderAuth(); return; }
    if (!r.data.needsSetup && Auth.view === 'setup') { Auth.view = 'signin'; renderAuth(); return; }
  }
  renderPill();
}

// ---- actions -------------------------------------------------------------------------------------

const isEmail = (s) => /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(s);

function setBusy(busy, label) {
  const btn = document.getElementById('a-go');
  if (!btn) return;
  if (busy) { btn.dataset.label = btn.innerHTML; btn.disabled = true; btn.textContent = label; } else { btn.disabled = false; btn.innerHTML = btn.dataset.label || btn.innerHTML; }
}

/** Shows an error without losing what was typed (except a wrong sign-in password). */
function showError(r) {
  if (r.needsSetup) { Auth.view = 'setup'; renderAuth(); return; }
  const values = {};
  document.querySelectorAll('#auth-form input').forEach((i) => { values[i.id] = i.value; });
  renderAuth({ error: r.error, field: r.field });
  for (const [id, v] of Object.entries(values)) {
    const i = document.getElementById(id);
    if (i && !(id === 'a-pass' && r.field === 'password')) i.value = v;
  }
  syncClear();
}

async function sendCode() {
  const login = (document.getElementById('f-login')?.value || Auth.login).trim();
  if (!isEmail(login)) return showError({ error: 'Enter a valid e-mail address.', field: 'login' });
  Auth.login = login;
  setBusy(true, 'Sending…');
  const r = await admin.forgotPassword(Auth.url, login);
  setBusy(false);
  if (!r.ok) return showError(r);
  Auth.view = 'reset';
  Auth.resendAt = Date.now() + 60 * 1000;
  renderAuth();
  const tick = setInterval(() => {
    const b = document.getElementById('r-resend');
    if (!b) { clearInterval(tick); return; }
    const wait = Math.max(0, Math.ceil((Auth.resendAt - Date.now()) / 1000));
    b.disabled = wait > 0;
    b.textContent = wait ? `Resend in ${wait}s` : 'Resend code';
    if (!wait) clearInterval(tick);
  }, 1000);
  return null;
}

async function submitAuth() {
  const v = (id) => document.getElementById(id)?.value || '';
  if (Auth.status?.state === 'down') return showError({ error: "Can't reach the server. Check the connection at the top right." });

  if (Auth.view === 'signin') {
    const login = v('a-login').trim();
    if (!isEmail(login)) return showError({ error: 'Enter a valid e-mail address.', field: 'login' });
    if (!v('a-pass')) return showError({ error: 'Enter your password.', field: 'password' });
    Auth.login = login;
    setBusy(true, 'Signing in…');
    const r = await admin.login(Auth.url, login, v('a-pass'));
    setBusy(false);
    return r.ok ? enterConsole() : showError(r);
  }
  if (Auth.view === 'setup') {
    if (!isEmail(v('s-email').trim())) return showError({ error: 'Enter a valid e-mail address.', field: 'email' });
    if (v('s-pass') !== v('s-pass2')) return showError({ error: "Passwords don't match.", field: 'password' });
    setBusy(true, 'Creating…');
    const r = await admin.setupAdmin(Auth.url, { name: v('s-name').trim(), email: v('s-email').trim(), password: v('s-pass') });
    setBusy(false);
    return r.ok ? enterConsole() : showError(r);
  }
  if (Auth.view === 'forgot') return sendCode();
  if (Auth.view === 'reset') {
    if (v('r-code').replace(/\D/g, '').length !== 6) return showError({ error: 'Enter the 6-digit code.', field: 'code' });
    if (v('r-pass') !== v('r-pass2')) return showError({ error: "Passwords don't match.", field: 'password' });
    setBusy(true, 'Resetting…');
    const r = await admin.resetPassword(Auth.url, Auth.login, v('r-code'), v('r-pass'));
    setBusy(false);
    return r.ok ? enterConsole() : showError(r);
  }
  return null;
}

function enterConsole() {
  Auth.popOpen = false;
  document.getElementById('login')?.remove();
  document.querySelector('.shell').hidden = false;
  refreshSide().catch(() => {}).finally(() => go('dashboard'));
}
