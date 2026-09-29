// App start-up: decide whether to show the join/login screens or the app itself,
// and switch between tabs. Screens for calls, groups and ranks arrive in later phases.
import './styles.css';
import { supabase } from './supabase.js';
import { joinBnoc, sendLoginEmail, verifyCode, signOut, linkErrorFromUrl, isCamEmail, CAM_ONLY_MSG } from './auth.js';
import { $, esc, toast, closeSheet, openSheet, showError, avatar } from './ui.js';

const TABS = ['calls', 'groups', 'ranks', 'me'];

const S = {
  session: null,
  profile: null,
  email: null,          // this account's @cam.ac.uk address (private to them)
  gate: 'join',         // which logged-out screen: 'join' | 'email' | 'code'
  gateError: null,
  draftName: '',
  draftEmail: '',
  joining: false,
  tab: 'calls'
};

const isAnon = () => !!S.session?.user?.is_anonymous;

// ---------- Gate: join, admin email login, first-time name ----------
const MARK = '<p class="mark">BN<span>O</span>C</p><p class="full">Big Name On Campus</p>';
const errBox = () => `<div class="err ${S.gateError ? 'show' : ''}" id="gate-err" role="alert">${esc(S.gateError || '')}</div>`;

function renderGate() {
  const g = $('#gate');
  g.classList.remove('hide');
  $('#top').hidden = true; $('#content').hidden = true; $('#nav').hidden = true;

  // Join: everyone at the pitch. Also the "what's your name" step after a first admin email login.
  if (S.session || S.gate === 'join') {
    const needEmail = !S.session || isAnon();
    g.innerHTML = `${MARK}
      <p class="pitch">Call what happens around you. Show up. Top the table.</p>
      <label for="ob-name">Your first name</label>
      <input id="ob-name" type="text" maxlength="30" placeholder="e.g. Araha" autocomplete="given-name" value="${esc(S.draftName)}">
      ${needEmail ? `<label for="ob-email">Your Cambridge email</label>
      <input id="ob-email" type="email" inputmode="email" autocomplete="email" placeholder="crsid@cam.ac.uk" value="${esc(S.draftEmail)}">` : ''}
      ${errBox()}
      <div class="spacer"></div>
      <button class="primary" data-act="join">Join BNOC</button>
      ${S.session ? '' : '<button class="secondary" data-act="gate" data-to="email">Admin? Log in with an email code</button>'}
      <p class="small">Only @cam.ac.uk addresses. This phone remembers you: no password, no email to check. 18+ only. Free to play: no money, nothing to buy, nothing to cash out.</p>`;
    setTimeout(() => $('#ob-name')?.focus(), 50);
    return;
  }

  if (S.gate === 'code') {
    g.innerHTML = `${MARK}
      <p class="pitch">Check your email</p>
      <p class="lead">We sent a login link and a code to <b>${esc(S.draftEmail)}</b>. Tap the link, or type the code here.</p>
      <label for="login-code">Code from the email</label>
      <input id="login-code" class="code-input" type="text" inputmode="numeric" autocomplete="one-time-code" maxlength="10" placeholder="••••••">
      ${errBox()}
      <div class="spacer"></div>
      <button class="primary" data-act="verify-code">Log in</button>
      <button class="secondary" data-act="gate" data-to="email">Use a different email</button>
      <p class="small">Nothing yet? It can take a minute. Check junk or quarantine, then send a new one.</p>`;
    setTimeout(() => $('#login-code')?.focus(), 50);
    return;
  }

  g.innerHTML = `${MARK}
    <p class="pitch">Admin login</p>
    <p class="lead">We'll email you a login link and a code, so you can use your admin account on any device.</p>
    <label for="login-email">Your Cambridge email</label>
    <input id="login-email" type="email" inputmode="email" autocomplete="email" placeholder="crsid@cam.ac.uk" value="${esc(S.draftEmail)}">
    ${errBox()}
    <div class="spacer"></div>
    <button class="primary" data-act="send-link">Email me a login code</button>
    <button class="secondary" data-act="gate" data-to="join">Back to Join</button>`;
  setTimeout(() => $('#login-email')?.focus(), 50);
}

function gateError(msg) {
  S.gateError = msg;
  showError($('#gate-err'), msg);
}

async function onJoin(btn) {
  S.draftName = $('#ob-name').value.trim();
  const emailEl = $('#ob-email');
  if (emailEl) S.draftEmail = emailEl.value.trim();
  if (!S.draftName) return gateError('Add your first name so people know who made a call.');
  if (emailEl && !isCamEmail(S.draftEmail)) return gateError(CAM_ONLY_MSG);

  btn.disabled = true; btn.textContent = 'Joining…';
  S.joining = true;
  const { error } = await joinBnoc(S.draftName, emailEl ? S.draftEmail : null);
  S.joining = false;
  S.gateError = error;
  const { data: { session } } = await supabase.auth.getSession();
  await onSession(session);
  if (!error) toast(`Welcome, ${S.profile?.display_name}`);
}

async function onSendLink(btn) {
  S.draftEmail = $('#login-email').value.trim();
  if (!isCamEmail(S.draftEmail)) return gateError(CAM_ONLY_MSG);
  btn.disabled = true; btn.textContent = 'Sending…';
  const { error } = await sendLoginEmail(S.draftEmail);
  btn.disabled = false; btn.textContent = 'Email me a login code';
  if (error) return gateError(error);
  S.gate = 'code'; S.gateError = null;
  renderGate();
}

async function onVerifyCode(btn) {
  btn.disabled = true; btn.textContent = 'Checking…';
  const { error } = await verifyCode(S.draftEmail, $('#login-code').value);
  btn.disabled = false; btn.textContent = 'Log in';
  if (error) gateError(error);
  // On success, onAuthStateChange below takes over.
}

// ---------- The app ----------
function tabFromHash() {
  const t = window.location.hash.replace(/^#\//, '');
  return TABS.includes(t) ? t : 'calls';
}

function render() {
  if (!S.session || !S.profile?.display_name) return renderGate();
  $('#gate').classList.add('hide');
  $('#top').hidden = false; $('#content').hidden = false; $('#nav').hidden = false;
  document.querySelectorAll('#nav [data-tab]').forEach(b => {
    if (b.dataset.tab === S.tab) b.setAttribute('aria-current', 'page'); else b.removeAttribute('aria-current');
  });
  $('#content').innerHTML = ({ calls: renderCalls, groups: renderSoon, ranks: renderSoon, me: renderMe })[S.tab]();
}

function renderCalls() {
  return `<h1 class="page-title">Hi, ${esc(S.profile.display_name)}</h1>
    <p class="page-sub">You're in. Calls for King's E-Lab arrive in the next phase.</p>
    <div class="empty">Nothing here yet.</div>`;
}

function renderSoon() {
  const title = S.tab[0].toUpperCase() + S.tab.slice(1);
  return `<h1 class="page-title">${title}</h1><div class="empty">Coming in a later phase.</div>`;
}

function renderMe() {
  const p = S.profile;
  return `<h1 class="page-title">Me</h1>
    <div class="me-card">${avatar(p.id, p.display_name)}
      <p style="margin:10px 0 0"><b>${esc(p.display_name)}</b>${p.is_admin ? ' · admin' : ''}<br>
      <span class="muted">${esc(S.email || '')}</span></p>
      ${isAnon() ? '<p class="muted" style="margin:8px 0 0">Your account lives on this device.</p>' : ''}</div>
    <button class="secondary" data-act="sign-out">Log out</button>`;
}

function confirmSignOut() {
  if (!isAnon()) return signOut();
  openSheet(`<h2 id="sheet-title">Log out for good?</h2>
    <p class="lead">Your account lives on this device. If you log out, you can't get back into it, and your points stay with the old account.</p>
    <button class="primary" data-act="sign-out-confirm">Log out</button>
    <button class="secondary" data-act="close">Stay logged in</button>`);
}

function openAbout() {
  openSheet(`<h2 id="sheet-title">How BNOC works</h2>
    <p class="lead">Make yes/no calls about what happens around King's E-Lab. Pick how sure you are, earn points for being right, and get a bonus for showing up to events. There's no money anywhere: nothing to buy, stake or cash out.</p>
    <button class="primary" data-act="close">Got it</button>`);
}

// ---------- Session ----------
async function loadProfile() {
  const uid = S.session.user.id;
  const [prof, mail] = await Promise.all([
    supabase.from('profiles').select('id, display_name, is_admin').eq('id', uid).maybeSingle(),
    supabase.from('account_emails').select('email').eq('user_id', uid).maybeSingle()
  ]);
  if (prof.error) toast("Couldn't load your profile. Try refreshing.");
  S.profile = prof.data;
  S.email = mail.data?.email || null;
}

async function onSession(session) {
  S.session = session;
  S.profile = null;
  if (session) await loadProfile();
  else { S.gate = 'join'; S.email = null; }
  render();
}

// ---------- Events ----------
document.addEventListener('click', e => {
  const b = e.target.closest('[data-act]');
  if (!b) return;
  switch (b.dataset.act) {
    case 'join': onJoin(b); break;
    case 'gate': S.gate = b.dataset.to; S.gateError = null; renderGate(); break;
    case 'send-link': onSendLink(b); break;
    case 'verify-code': onVerifyCode(b); break;
    case 'tab': closeSheet(); window.location.hash = `#/${b.dataset.tab}`; break;
    case 'new-call': toast('Making calls arrives in the next phase'); break;
    case 'switch-comm': toast("King's E-Lab is the only community for now"); break;
    case 'about': openAbout(); break;
    case 'close': closeSheet(); break;
    case 'sign-out': confirmSignOut(); break;
    case 'sign-out-confirm': closeSheet(); signOut(); break;
  }
});
document.addEventListener('keydown', e => {
  if (e.key === 'Escape' && $('#sheet').classList.contains('open')) closeSheet();
  if (e.key !== 'Enter') return;
  const act = { 'ob-name': 'join', 'ob-email': 'join', 'login-email': 'send-link', 'login-code': 'verify-code' }[e.target.id];
  if (act) $(`[data-act="${act}"]`)?.click();
});
window.addEventListener('hashchange', () => {
  S.tab = tabFromHash();
  if (S.session && S.profile?.display_name) { render(); $('#content').scrollTop = 0; }
});

// ---------- Start ----------
S.tab = tabFromHash();
S.gateError = linkErrorFromUrl();
if (S.gateError) S.gate = 'email';
supabase.auth.onAuthStateChange((event, session) => {
  // While joining, onJoin handles the result itself (avoids redrawing the form mid-way).
  if (S.joining) { S.session = session; return; }
  // Only redraw when someone logs in or out, not on routine token refreshes.
  if (event === 'SIGNED_IN' || event === 'SIGNED_OUT' || event === 'INITIAL_SESSION') {
    if (event === 'SIGNED_IN' && session?.user?.id === S.session?.user?.id && S.profile) return;
    // Supabase advises not to await other Supabase calls inside this callback.
    setTimeout(() => onSession(session), 0);
  }
});
