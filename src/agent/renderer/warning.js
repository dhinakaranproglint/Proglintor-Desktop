'use strict';
/* global agent, UI */
// Weekend work check: shown when a development tool is used on a weekend day.

const { esc, icon, appIcon, hydrate, fmtDate } = UI;
document.body.classList.add(`platform-${agent.platform}`);
const root = document.getElementById('root');
const DURATIONS = ['Under 1 hour', '1–3 hours', '3–6 hours', 'Full day'];

(async function start() {
  const info = await agent.warningInfo();
  if (!info) { agent.warningClose(); return; }
  const first = (info.employee || '').split(/\s+/)[0];
  const dayName = fmtDate(Date.now(), { weekday: 'long' });

  root.innerHTML = `
    <div class="hero-warn">
      ${'<picture class="wordmark"><source srcset="../../../assets/brand/proglint-logo-white.png" media="(prefers-color-scheme: dark)"><img src="../../../assets/brand/proglint-logo.png" alt="Proglint"></picture>'.replace('class="wordmark"', 'class="wordmark warn-word"')}
      <div class="warn-icon">${icon('alert', 32)}</div>
      <h1>Working on the weekend?</h1>
      <p>${first ? `Hi ${esc(first)}, we` : 'We'} noticed <span class="apppill">${appIcon(info.app.id, '', 16, info.app.name)}${esc(info.app.name)}</span> is open on ${esc(dayName)}.</p>
    </div>

    <div class="policy">${icon('shield', 16)}<div>${esc(info.policy.message)}</div></div>

    <form id="form" novalidate>
      <div class="q">Why are you working today? <span class="muted small">(required)</span></div>
      <div class="choices" id="reasons">${info.policy.reasons.map((r, i) => `
        <label class="choice"><input type="radio" name="reason" value="${esc(r)}" ${i === 0 ? '' : ''}><span>${esc(r)}</span></label>`).join('')}
      </div>

      <div class="q" style="margin-top:16px">How long do you expect to work?</div>
      <div class="segmented seg-full" id="duration">${DURATIONS.map((d) => `<button type="button" data-v="${esc(d)}">${esc(d)}</button>`).join('')}</div>

      <div class="form-grid" style="margin-top:16px">
        <label class="field full"><span id="details-label">Details</span>
          <textarea class="input" id="details" maxlength="2000" placeholder="e.g. Fixing the payment failure reported by the client (ticket PGL-1234)"></textarea></label>
        <label class="field full"><span id="approver-label">Approved by (manager)</span>
          <input class="input" id="approver" maxlength="200" placeholder="Manager name — optional"></label>
      </div>
      <div class="form-error" id="err" role="alert"></div>
    </form>

    <div class="foot">
      <span class="note">${icon('send', 12)} Your answer is sent to your ${esc(info.company)} admin.</span>
      <button class="btn ghost" id="later">Remind me later</button>
      <button class="btn primary" id="submit">${icon('send', 14)} Submit</button>
    </div>`;
  hydrate(root);

  let duration = '';
  const err = document.getElementById('err');
  const details = document.getElementById('details');
  const approver = document.getElementById('approver');

  const reasonValue = () => document.querySelector('input[name=reason]:checked')?.value || '';
  const needsDetails = (r) => /other/i.test(r);
  const needsApprover = (r) => /approved/i.test(r);

  document.getElementById('reasons').addEventListener('change', () => {
    const r = reasonValue();
    document.getElementById('details-label').innerHTML = needsDetails(r) ? 'Details <em>*</em>' : 'Details';
    document.getElementById('approver-label').innerHTML = needsApprover(r) ? 'Approved by (manager) <em>*</em>' : 'Approved by (manager)';
    approver.placeholder = needsApprover(r) ? 'Manager name' : 'Manager name — optional';
    err.textContent = '';
  });

  document.querySelectorAll('#duration button').forEach((b) => b.addEventListener('click', () => {
    duration = b.dataset.v;
    document.querySelectorAll('#duration button').forEach((x) => x.classList.toggle('on', x === b));
  }));

  document.getElementById('later').addEventListener('click', () => agent.warningLater());

  document.getElementById('submit').addEventListener('click', async (e) => {
    const reason = reasonValue();
    details.classList.remove('invalid');
    approver.classList.remove('invalid');
    if (!reason) { err.textContent = 'Please choose a reason.'; return; }
    if (needsDetails(reason) && !details.value.trim()) { details.classList.add('invalid'); details.focus(); err.textContent = 'Please add a few words about the work.'; return; }
    if (needsApprover(reason) && !approver.value.trim()) { approver.classList.add('invalid'); approver.focus(); err.textContent = 'Please enter the manager who approved it.'; return; }
    e.currentTarget.disabled = true;
    const ok = await agent.warningSubmit({ reason, details: details.value.trim(), approver: approver.value.trim(), duration });
    if (!ok) { err.textContent = 'Could not save your answer. Please try again.'; e.currentTarget.disabled = false; return; }
    root.innerHTML = `
      <div class="done">
        <div class="ok-icon">${icon('check', 34)}</div>
        <h2>Thanks${first ? `, ${esc(first)}` : ''}!</h2>
        <div class="muted">Your answer has been sent to your ${esc(info.company)} admin.<br>You won't be asked again today.</div>
      </div>`;
    setTimeout(() => agent.warningClose(), 2200);
  });
}());
