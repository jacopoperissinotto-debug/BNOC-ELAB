// Admin page (bnoc.netlify.app/#/admin): post calls, close them, settle results, review suggestions,
// see who joined, and show the join QR code for the pitch. Unlocked with the ADMIN_KEY passphrase.
import QRCode from 'qrcode';
import { api, getAdminKey, setAdminKey } from './api.js';
import { esc, toast, showError, clearError, sideLabel, fmtWhen } from './ui.js';

const A = { data: null, error: null };
let root = null;

// datetime-local inputs work in the device's local time (UK for us).
const pad = n => String(n).padStart(2, '0');
const toLocalInput = d => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
function preset(kind) {
  const d = new Date();
  if (kind === 'hour') { d.setHours(d.getHours() + 1); return d; }
  if (kind === 'tonight') { d.setHours(23, 59, 0, 0); return d; }
  d.setDate(d.getDate() + 1);
  d.setHours(kind === 'noon' ? 12 : 18, 0, 0, 0);
  return d;
}
const defaultClose = () => (new Date().getHours() < 23 ? preset('tonight') : preset('evening'));

export function renderAdmin(el) {
  root = el;
  const hasKey = !!getAdminKey();
  el.innerHTML = `<div data-admin>
    <h1 class="page-title">Admin</h1>
    <p class="page-sub">Post calls, close them and settle results. <a href="#/calls">Back to the app</a></p>
    ${hasKey ? `
      <button class="primary dark" data-act="qr">Show the join QR code</button>
      <h2 class="section-h">New call</h2>
      <div class="err" id="ad-err" role="alert"></div>
      <div class="field"><label for="ad-q">Question</label><textarea id="ad-q" maxlength="140" placeholder="Will our pitch be under 3 minutes?"></textarea></div>
      <div class="field"><label for="ad-close">Closes (UK time)</label>
        <div class="opts" style="margin-bottom:8px">
          <button class="opt" data-act="preset" data-k="hour">In 1 hour</button>
          <button class="opt" data-act="preset" data-k="tonight">Tonight 23:59</button>
          <button class="opt" data-act="preset" data-k="noon">Tomorrow 12:00</button>
          <button class="opt" data-act="preset" data-k="evening">Tomorrow 18:00</button>
        </div>
        <input type="datetime-local" id="ad-close" value="${toLocalInput(defaultClose())}">
        <div class="hint">Answers lock automatically at this time. Suggestions you publish below use it too.</div></div>
      <button class="primary" data-act="post">Post call</button>
      <div id="admin-lists"><div class="empty">Loading…</div></div>
      <button class="secondary" data-act="forget-key" style="margin-top:24px">Forget the admin key on this device</button>`
    : `
      <div class="err ${A.error ? 'show' : ''}" id="ad-key-err" role="alert">${esc(A.error || '')}</div>
      <div class="field"><label for="ad-key">Admin key</label><input type="password" id="ad-key" autocomplete="current-password">
        <div class="hint">The passphrase saved as ADMIN_KEY in Netlify. This device remembers it.</div></div>
      <button class="primary dark" data-act="save-key">Open admin</button>`}
  </div>`;
  if (hasKey) refreshAdmin();
}

export async function refreshAdmin() {
  if (!root || !getAdminKey()) return;
  const { data, error, status } = await api.admin.state();
  if (error) return handleError(error, status);
  A.data = data; A.error = null;
  const lists = root.querySelector('#admin-lists');
  if (lists) lists.innerHTML = listsHtml();
}

function handleError(error, status) {
  if (status === 401 || status === 503) {
    A.error = error;
    if (status === 401) setAdminKey('');
    renderAdmin(root);
  } else {
    toast(error);
  }
}

function statusChip(c) {
  if (c.status === 'open') return `<span class="chip ok">Live · closes ${fmtWhen(c.closesAt)}</span>`;
  if (c.status === 'closed') return '<span class="chip wait">Closed · needs a result</span>';
  return `<span class="chip won">Settled: ${sideLabel(c.result)}</span>`;
}

function callAdminCard(c) {
  let action = '';
  if (c.status === 'open') {
    action = `<button class="settle-btn" data-act="close-call" data-id="${c.id}">Close now</button>`;
  } else if (c.status === 'closed') {
    action = `<div class="vote"><button class="yes" data-act="settle" data-id="${c.id}" data-r="yes">It happened: Yes</button><button class="no" data-act="settle" data-id="${c.id}" data-r="no">It didn't: No</button></div>
      <button class="link-btn" data-act="reopen" data-id="${c.id}">Reopen until the time above</button>`;
  } else {
    action = `<div class="my-stake"><span>Result: <b>${sideLabel(c.result)}</b>. Scores updated.</span><button class="link-btn" data-act="unsettle" data-id="${c.id}">Undo</button></div>`;
  }
  return `<article class="call">
    <h3>${esc(c.q)}</h3>
    <div class="chips">${statusChip(c)}</div>
    <div class="call-foot"><span><b>${c.yes}</b> Yes · <b>${c.no}</b> No</span><button class="report" data-act="remove" data-id="${c.id}">Remove call</button></div>
    ${action}
  </article>`;
}

function listsHtml() {
  const { calls, suggestions, people } = A.data;
  return `
    <h2 class="section-h">Calls (${calls.length})</h2>
    ${calls.length ? calls.map(callAdminCard).join('') : '<div class="empty">No calls yet. Post the first one above.</div>'}
    <h2 class="section-h">Suggestions (${suggestions.length})</h2>
    ${suggestions.length ? suggestions.map(s => `<article class="call">
        <div class="call-meta"><span><b>${esc(s.name)}</b> suggested · ${fmtWhen(s.at)}</span></div>
        <h3>${esc(s.q)}</h3>
        <div class="vote"><button class="yes" data-act="publish" data-id="${s.id}">Publish</button><button class="no" data-act="reject" data-id="${s.id}">Reject</button></div>
      </article>`).join('') : '<div class="empty">No suggestions waiting.</div>'}
    <h2 class="section-h">People (${people.length})</h2>
    ${people.length ? people.map((p, i) => `<div class="row"><span class="rank">${i + 1}</span><span class="who">${esc(p.name)}<br><span class="email">${esc(p.email || '')}</span></span><span class="sc">${p.score}</span></div>`).join('') : '<div class="empty">Nobody has joined yet.</div>'}`;
}

function closeTime() {
  const v = root.querySelector('#ad-close')?.value;
  const d = v ? new Date(v) : null;
  return d && !isNaN(d) ? d.toISOString() : null;
}

async function post(btn, fromSuggestion) {
  const err = root.querySelector('#ad-err');
  clearError(err);
  const q = fromSuggestion ? A.data.suggestions.find(s => s.id === fromSuggestion)?.q : root.querySelector('#ad-q').value.trim();
  const closesAt = closeTime();
  if (!q || q.length < 10) return showError(err, 'Write a full question (at least 10 characters).');
  if (!closesAt) return showError(err, 'Pick when the call closes.');
  btn.disabled = true;
  const { data, error, status } = await api.admin.createCall(q, closesAt, fromSuggestion);
  btn.disabled = false;
  if (error) {
    if (status === 401 || status === 503) return handleError(error, status);
    showError(err, error);
    return err.scrollIntoView({ block: 'center', behavior: 'smooth' });
  }
  if (!fromSuggestion) root.querySelector('#ad-q').value = '';
  A.data = data;
  root.querySelector('#admin-lists').innerHTML = listsHtml();
  toast(`Posted. Closes ${fmtWhen(closesAt)}`);
}

async function update(btn, id, action, extra, doneMsg) {
  btn.disabled = true;
  const { data, error, status } = await api.admin.updateCall(id, action, extra);
  btn.disabled = false;
  if (error) return status === 401 || status === 503 ? handleError(error, status) : toast(error);
  A.data = data;
  root.querySelector('#admin-lists').innerHTML = listsHtml();
  toast(doneMsg);
}

// ---------- Join QR code (full screen, for the projector) ----------
async function showQr() {
  const url = window.location.origin;
  const svg = await QRCode.toString(url, { type: 'svg', margin: 1, errorCorrectionLevel: 'M', color: { dark: '#2D1B3D', light: '#FFFFFF' } });
  const ov = document.createElement('div');
  ov.className = 'qr-overlay';
  ov.setAttribute('data-admin', '');
  ov.setAttribute('role', 'dialog');
  ov.setAttribute('aria-label', 'Join BNOC QR code');
  ov.innerHTML = `<div class="qr-card">
      <p class="mark">BN<span>O</span>C</p>
      <div class="qr-img">${svg}</div>
      <p class="qr-url">${esc(url.replace(/^https?:\/\//, ''))}</p>
      <p class="qr-sub">Scan to join with your Cambridge email</p>
    </div>
    <button class="qr-close" data-act="qr-close">Close</button>`;
  document.body.appendChild(ov);
}
const closeQr = () => document.querySelector('.qr-overlay')?.remove();

// ---------- Events ----------
document.addEventListener('click', e => {
  const b = e.target.closest('[data-admin] [data-act]');
  if (!b) return;
  const id = b.dataset.id;
  const find = () => A.data?.calls.find(c => c.id === id);
  switch (b.dataset.act) {
    case 'save-key': {
      const k = root.querySelector('#ad-key').value.trim();
      if (!k) return showError(root.querySelector('#ad-key-err'), 'Type the admin key.');
      setAdminKey(k); A.error = null; renderAdmin(root);
      break;
    }
    case 'forget-key': setAdminKey(''); A.data = null; renderAdmin(root); break;
    case 'preset': root.querySelector('#ad-close').value = toLocalInput(preset(b.dataset.k)); break;
    case 'post': post(b); break;
    case 'publish': post(b, id); break;
    case 'reject':
      if (confirm('Reject this suggestion? It will be deleted.')) {
        api.admin.rejectSuggestion(id).then(({ data, error }) => {
          if (error) return toast(error);
          A.data = data; root.querySelector('#admin-lists').innerHTML = listsHtml();
        });
      }
      break;
    case 'close-call':
      if (confirm(`Close "${find()?.q}" now? Nobody can answer after this.`)) update(b, id, 'close', {}, 'Closed. Answers are locked.');
      break;
    case 'settle':
      if (confirm(`Settle "${find()?.q}" as ${sideLabel(b.dataset.r).toUpperCase()}? Scores update straight away.`)) {
        update(b, id, 'settle', { result: b.dataset.r }, `Settled as ${sideLabel(b.dataset.r)}. Scores updated.`);
      }
      break;
    case 'unsettle':
      if (confirm('Undo this result? Points from this call are taken back until you settle it again.')) update(b, id, 'unsettle', {}, 'Result undone');
      break;
    case 'reopen': {
      const closesAt = closeTime();
      if (!closesAt) return toast('Pick a closing time in the New call box first.');
      update(b, id, 'reopen', { closesAt }, `Reopened until ${fmtWhen(closesAt)}`);
      break;
    }
    case 'remove':
      if (confirm(`Remove "${find()?.q}"? It disappears for everyone and its points no longer count.`)) update(b, id, 'remove', {}, 'Call removed');
      break;
    case 'qr': showQr(); break;
    case 'qr-close': closeQr(); break;
  }
});
document.addEventListener('keydown', e => {
  if (e.key === 'Escape') closeQr();
  if (e.key === 'Enter' && e.target.id === 'ad-key') root.querySelector('[data-act="save-key"]')?.click();
});
