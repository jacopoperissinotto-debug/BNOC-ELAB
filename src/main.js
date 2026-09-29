// BNOC pitch app: join, make calls, see the leaderboard. The admin page lives in admin.js (#/admin).
import './styles.css';
import { api, getToken, setToken } from './api.js';
import { $, esc, ord, toast, openSheet, closeSheet, showError, clearError, avatar, fmtWhen } from './ui.js';
import { CONF, COMMUNITY, isCamEmail, CAM_ONLY_MSG, isBannedTopic, BANNED_MSG } from '../shared/rules.js';
import { renderAdmin, refreshAdmin } from './admin.js';

const TABS = ['calls', 'ranks', 'how', 'me', 'admin'];
const REFRESH_MS = 15000;
const COMMENTS_REFRESH_MS = 6000;
const COMMENT_MAX = 280;
const BUBBLE = '<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M21 12a8 8 0 0 1-11.6 7.1L4 20l1-4.6A8 8 0 1 1 21 12z"/></svg>';

const S = {
  state: null,        // what the server says: me, calls, board, score, rank, people
  loaded: false,
  tab: 'calls',
  filter: 'live',     // 'live' | 'mine' | 'settled'
  callCtx: null,      // the call being answered in the confidence sheet
  commentsFor: null   // the call whose comments are open
};
let commentsTimer = null;

const me = () => S.state?.me;
// Every call has two answers: Yes/No, or two labels the admin chose. Answer 0 is coral, answer 1 plum.
const answer = (c, pick) => c.options[pick];
const tag = (c, pick) => `<span class="side-tag ${pick === 0 ? 'y' : 'n'}">${esc(answer(c, pick))}</span>`;

// ---------- Join ----------
function renderGate() {
  $('#gate').classList.remove('hide');
  $('#top').hidden = true; $('#content').hidden = true; $('#nav').hidden = true;
  if (!S.loaded) {
    $('#gate').innerHTML = '<p class="mark">BN<span>O</span>C</p><p class="full">Loading…</p>';
    return;
  }
  $('#gate').innerHTML = `<p class="mark">BN<span>O</span>C</p>
    <p class="full">Big Name On Campus · ${esc(COMMUNITY.name)}</p>
    <p class="pitch">Call what happens around you. Show up. Top the table.</p>
    <label for="ob-name">Your first name</label>
    <input id="ob-name" type="text" maxlength="30" placeholder="e.g. Araha" autocomplete="given-name">
    <label for="ob-email">Your Cambridge email</label>
    <input id="ob-email" type="email" inputmode="email" autocomplete="email" placeholder="crsid@cam.ac.uk">
    <div class="err" id="gate-err" role="alert"></div>
    <div class="spacer"></div>
    <button class="primary" data-act="join">Join BNOC</button>
    <p class="small">Only @cam.ac.uk addresses. 18+ only. Free to play: no money, nothing to buy, nothing to cash out.
      <button class="linkish" data-act="privacy">Privacy</button></p>`;
}

async function onJoin(btn) {
  const name = $('#ob-name').value.trim(), email = $('#ob-email').value.trim(), err = $('#gate-err');
  clearError(err);
  if (!name) return showError(err, 'Add your first name so people know who made a call.');
  if (!isCamEmail(email)) return showError(err, CAM_ONLY_MSG);
  btn.disabled = true; btn.textContent = 'Joining…';
  const { data, error } = await api.join(name, email);
  btn.disabled = false; btn.textContent = 'Join BNOC';
  if (error) return showError(err, error);
  setToken(data.token);
  S.state = data.state;
  S.tab = 'calls'; S.filter = 'live';
  if (location.hash !== '#/calls') location.hash = '#/calls';
  render();
  toast(data.returning ? `Welcome back, ${data.state.me.name}` : `Welcome, ${data.state.me.name}. Make your first call!`);
}

// ---------- Layout ----------
function render() {
  if (S.tab === 'admin') return renderAdminPage();
  if (!me()) return renderGate();
  $('#gate').classList.add('hide');
  $('#top').hidden = false; $('#content').hidden = false; $('#nav').hidden = false;
  $('#pts').textContent = S.state.score;
  document.querySelectorAll('#nav [data-tab]').forEach(b => {
    if (b.dataset.tab === S.tab) b.setAttribute('aria-current', 'page'); else b.removeAttribute('aria-current');
  });
  $('#content').innerHTML = ({ calls: renderCalls, ranks: renderRanks, how: renderHow, me: renderMe })[S.tab]();
}

function renderAdminPage() {
  $('#gate').classList.add('hide');
  $('#top').hidden = true; $('#nav').hidden = true; $('#content').hidden = false;
  renderAdmin($('#content'));
}

// ---------- Calls ----------
const KE_AVATAR = `<span class="avatar" style="background:var(--plum)" aria-hidden="true">${COMMUNITY.short}</span>`;

function callCard(c) {
  const total = c.total, p = total ? Math.round(c.counts[0] / total * 100) : 50;
  let chips = '';
  if (c.status === 'closed') chips += '<span class="chip wait">Closed · result coming soon</span>';
  if (c.status === 'settled') {
    chips += `<span class="chip">Result: ${esc(answer(c, c.result))}</span>`;
    if (c.mine) {
      chips += c.mine.pts > 0
        ? `<span class="chip won">You called it: +${c.mine.pts}</span>`
        : `<span class="chip lost">Missed: ${c.mine.pts === 0 ? 'no points' : '−' + (-c.mine.pts)}</span>`;
    }
  }
  let action = '';
  if (c.status === 'open' && !c.mine) {
    action = `<div class="vote"><button class="yes" data-act="call" data-id="${c.id}" data-pick="0">${esc(answer(c, 0))}</button><button class="no" data-act="call" data-id="${c.id}" data-pick="1">${esc(answer(c, 1))}</button></div>`;
  } else if (c.mine && c.status !== 'settled') {
    const cf = CONF[c.mine.conf];
    action = `<div class="my-stake"><span>You called ${tag(c, c.mine.pick)} · ${cf.label}</span><span>+${cf.win} if right</span></div>`;
  }
  const when = c.status === 'open' ? `Closes ${fmtWhen(c.closesAt)}` : c.status === 'closed' ? `Closed ${fmtWhen(c.closesAt)}` : 'Settled';
  return `<article class="call">
    <div class="call-meta">${KE_AVATAR}<span><b>${esc(COMMUNITY.name)}</b> · official call</span></div>
    <h3>${esc(c.q)}</h3>
    ${chips ? `<div class="chips">${chips}</div>` : ''}
    ${total
      ? `<div class="bar" role="img" aria-label="The crowd says ${p}% ${esc(answer(c, 0))}, ${100 - p}% ${esc(answer(c, 1))}"><div class="y" style="width:${Math.min(Math.max(p, 24), 76)}%"><span class="lbl">${esc(answer(c, 0))}</span><b>${p}%</b></div><div class="n"><span class="lbl">${esc(answer(c, 1))}</span><b>${100 - p}%</b></div></div>`
      : `<div class="bar bar-empty">${c.status === 'open' ? 'No calls yet. Be the first!' : 'Nobody called this one'}</div>`}
    <div class="call-foot"><span>${total ? `${total} ${total === 1 ? 'person' : 'people'} called it · ` : ''}${when}</span>
      <button class="cmt-btn" data-act="comments" data-id="${c.id}" aria-label="${c.comments} comments">${BUBBLE}${c.comments || 'Comment'}</button></div>
    ${action}
  </article>`;
}

function renderCalls() {
  const all = S.state.calls;
  const shown = S.filter === 'live' ? all.filter(c => c.status !== 'settled')
    : S.filter === 'mine' ? all.filter(c => c.mine)
    : all.filter(c => c.status === 'settled');
  const f = (k, l) => `<button data-act="filter" data-f="${k}" aria-pressed="${S.filter === k}">${l}</button>`;
  const empty = S.filter === 'live' ? 'No live calls right now. New ones are on the way.'
    : S.filter === 'mine' ? "You haven't made any calls yet. Tap Yes or No on a live call."
    : 'Nothing settled yet. Results land here once a call closes.';
  return `<h1 class="page-title">Calls</h1>
    <p class="page-sub">What's going to happen at ${esc(COMMUNITY.name)}? Make your call before it closes.</p>
    <div class="host">${KE_AVATAR}<span><b>Official community · ${S.state.people} ${S.state.people === 1 ? 'person' : 'people'}.</b> Calls are posted by the E-Lab team. Tap + to suggest one.</span></div>
    <div class="seg" role="group" aria-label="Filter calls">${f('live', 'Live')}${f('mine', 'Yours')}${f('settled', 'Settled')}</div>
    ${shown.length ? shown.map(callCard).join('') : `<div class="empty">${empty}</div>`}`;
}

function openCall(id, pick) {
  const c = S.state.calls.find(x => x.id === id);
  if (!c) return;
  S.callCtx = { id, pick, conf: 'sure' };
  openSheet(`<h2 id="sheet-title">${esc(c.q)}</h2>
    <p class="lead">You're calling ${tag(c, pick)}. How sure are you?</p>
    <div class="conf" role="group" aria-label="Confidence">${Object.entries(CONF).map(([k, v]) => `<button data-act="conf" data-k="${k}" aria-pressed="${k === 'sure'}"><b>${v.label}</b><span>${v.pct}</span></button>`).join('')}</div>
    <div class="est" id="call-est"></div>
    <div class="err" id="call-err" role="alert"></div>
    <button class="primary" data-act="confirm-call">Call ${esc(answer(c, pick))}</button>
    <button class="secondary" data-act="close">Cancel</button>
    <p class="lead center" style="font-size:12.5px;margin:12px 0 0">Calls are locked once made.</p>`);
  updateEst();
}

function updateEst() {
  const cf = CONF[S.callCtx.conf];
  $('#call-est').innerHTML = `Right: <b>+${cf.win}</b>. Wrong: <b>${cf.lose ? '−' + cf.lose : 'no change'}</b>. You aren't spending anything.`;
}

async function confirmCall(btn) {
  const { id, pick, conf } = S.callCtx;
  const label = answer(S.state.calls.find(x => x.id === id), pick);
  btn.disabled = true;
  const { data, error } = await api.forecast(id, pick, conf);
  btn.disabled = false;
  if (error) {
    showError($('#call-err'), error);
    refresh();
    return;
  }
  S.state = data.state;
  closeSheet(); render();
  toast(`Called ${label}, ${CONF[conf].label.toLowerCase()}`);
}

// ---------- Comments ----------
function openComments(id) {
  const c = S.state.calls.find(x => x.id === id);
  if (!c) return;
  S.commentsFor = id;
  S.commentsFresh = true;   // the first draw jumps to the newest comment, like a chat
  openSheet(`<h2 id="sheet-title">Comments</h2>
    <p class="lead">${esc(c.q)}</p>
    <div class="cmts" id="cmts" aria-live="polite"><div class="empty">Loading…</div></div>
    <div class="err" id="cm-err" role="alert"></div>
    <div class="field"><label class="sr" for="cm-text">Your comment</label>
      <textarea id="cm-text" maxlength="${COMMENT_MAX}" placeholder="Add a comment…"></textarea>
      <div class="hint">Be kind. Everyone in ${esc(COMMUNITY.name)} sees your first name. No comments about relationships, health, appearance or grades.</div></div>
    <button class="primary" data-act="post-comment">Post comment</button>
    <button class="secondary" data-act="close">Close</button>`);
  loadComments();
  clearInterval(commentsTimer);
  commentsTimer = setInterval(() => {
    if (!$('#sheet').classList.contains('open') || !$('#cmts')) return stopComments();
    if (document.visibilityState === 'visible') loadComments();
  }, COMMENTS_REFRESH_MS);
}

function stopComments() {
  clearInterval(commentsTimer);
  S.commentsFor = null;
}

function drawComments(list) {
  const box = $('#cmts');
  if (!box) return;
  const call = S.state.calls.find(x => x.id === S.commentsFor);
  if (call) call.comments = list.length;   // keeps the count on the card right when the sheet closes
  const nearBottom = box.scrollHeight - box.scrollTop - box.clientHeight < 40;
  box.innerHTML = list.length ? list.map(m => `<div class="cmt">
      ${avatar(m.pid, m.name)}
      <div class="cmt-body"><div class="cmt-meta"><b>${esc(m.mine ? 'You' : m.name)}</b> · ${fmtWhen(m.at)}
        ${m.mine ? `<button class="link-btn" data-act="delete-comment" data-cid="${esc(m.id)}">Delete</button>` : ''}</div>
        <div class="cmt-text">${esc(m.text)}</div></div>
    </div>`).join('') : '<div class="empty">No comments yet. Start the conversation.</div>';
  if (nearBottom || S.commentsFresh) box.scrollTop = box.scrollHeight;
  S.commentsFresh = false;
}

async function loadComments() {
  const id = S.commentsFor;
  const { data, error } = await api.comments(id);
  if (id !== S.commentsFor) return;
  if (error) { if ($('#cmts')) $('#cmts').innerHTML = `<div class="empty">${esc(error)}</div>`; return; }
  drawComments(data.comments);
}

async function postComment(btn) {
  const text = $('#cm-text').value.trim(), err = $('#cm-err');
  clearError(err);
  if (!text) return showError(err, 'Write something first.');
  if (isBannedTopic(text)) return showError(err, "This comment can't be posted. BNOC doesn't allow comments about relationships, health, appearance or grades.");
  btn.disabled = true;
  const { data, error } = await api.addComment(S.commentsFor, text);
  btn.disabled = false;
  if (error) return showError(err, error);
  $('#cm-text').value = '';
  const box = $('#cmts');
  drawComments(data.comments);
  box.scrollTop = box.scrollHeight;
}

async function deleteComment(btn) {
  if (!confirm('Delete your comment?')) return;
  btn.disabled = true;
  const { data, error } = await api.deleteComment(S.commentsFor, btn.dataset.cid);
  if (error) { btn.disabled = false; return toast(error); }
  drawComments(data.comments);
}

// ---------- Suggest a call ----------
function openSuggest() {
  openSheet(`<h2 id="sheet-title">Suggest a call</h2>
    <p class="lead">Suggest a yes/no question for everyone in ${esc(COMMUNITY.name)}. The E-Lab team checks suggestions before they go live.</p>
    <div class="err" id="sg-err" role="alert"></div>
    <div class="field"><label for="sg-q">Your question</label><textarea id="sg-q" maxlength="140" placeholder="Will more than 40 people come to Thursday's social?"></textarea>
      <div class="hint">Not allowed: relationships, health, appearance or grades.</div></div>
    <button class="primary" data-act="send-suggestion">Send suggestion</button>
    <button class="secondary" data-act="close">Cancel</button>`);
}

async function sendSuggestion(btn) {
  const q = $('#sg-q').value.trim(), err = $('#sg-err');
  clearError(err);
  if (q.length < 10) return showError(err, 'Write a full question, like "Will the E-Lab social run past 10pm?"');
  if (isBannedTopic(q)) return showError(err, BANNED_MSG);
  btn.disabled = true;
  const { error } = await api.suggest(q);
  btn.disabled = false;
  if (error) return showError(err, error);
  closeSheet();
  toast('Suggestion sent. The E-Lab team reviews it before it goes live.');
}

// ---------- Ranks ----------
function renderRanks() {
  const b = S.state.board, myId = me().id;
  const label = x => x.id === myId ? 'You' : x.name;
  const row = (x, rank) => `<div class="row ${x.id === myId ? 'me' : ''}"><span class="rank">${rank}</span>${avatar(x.id, x.name)}<span class="who">${esc(x.id === myId ? `${x.name} (you)` : x.name)}</span><span class="sc">${x.score}</span></div>`;
  const head = `<h1 class="page-title">Ranks</h1>
    <p class="page-sub">Season 1 in ${esc(COMMUNITY.name)}. Points land when a call is settled.</p>`;
  // Before the first result everyone is on 0, so there's no podium yet: just who's playing.
  if (!S.state.settled) {
    return `${head}
      <div class="banner"><span aria-hidden="true">★</span><span><b>No results yet.</b> The table fills up once the first call is settled. ${S.state.people} ${S.state.people === 1 ? 'person is' : 'people are'} playing.</span></div>
      ${b.map(x => row(x, '–')).join('')}`;
  }
  const pod = (x, cls) => x ? `<div class="pod ${cls}">${avatar(x.id, x.name)}<div class="n">${esc(label(x))}</div><div class="s">${x.score}</div><div class="place">${ord(x.rank)}</div></div>` : '<div></div>';
  return `${head}
    <div class="banner"><span aria-hidden="true">★</span><span><b>You're ${ord(S.state.rank)} of ${S.state.people}.</b> Honest confidence scores best over a season.</span></div>
    <div class="podium">${pod(b[1], '')}${pod(b[0], 'first')}${pod(b[2], '')}</div>
    ${b.slice(3).map(x => row(x, x.rank)).join('')}`;
}

// ---------- Rules ----------
function scoringTable() {
  return `<table class="score-table"><thead><tr><th>Confidence</th><th>Right</th><th>Wrong</th></tr></thead><tbody>
    ${Object.values(CONF).map(c => `<tr><td>${c.label} (${c.pct})</td><td class="plus">+${c.win}</td><td class="minus">${c.lose ? '−' + c.lose : '0'}</td></tr>`).join('')}
    </tbody></table>`;
}

function renderHow() {
  return `<h1 class="page-title">How it works</h1>
    <p class="page-sub">Forecasting, not betting. There's no money anywhere.</p>
    <div class="rules"><b>1. Make a call.</b> Pick one of the two answers (usually Yes or No) on a question about ${esc(COMMUNITY.name)}, and say how sure you are:
      ${scoringTable()}
      <b>2. Wait for the result.</b> Calls lock at their closing time, then the E-Lab team settles them.<br>
      <b>3. Climb the table.</b> You never put points in, so you can't lose anything you own. Honest confidence scores best over a season.<br><br>
      Points can't be bought, sold or cashed out.</div>
    <div class="rules"><b>House rules.</b> No calls about relationships, health, appearance or grades. Tap + to suggest a call; the E-Lab team checks every suggestion.</div>
    <button class="secondary" data-act="privacy">Privacy notice</button>`;
}

// ---------- Me ----------
function renderMe() {
  const m = me(), s = S.state;
  const log = s.calls.filter(c => c.mine).map(c => {
    const short = c.q.length > 46 ? c.q.slice(0, 44) + '…' : c.q;
    if (c.status === 'settled') {
      const p = c.mine.pts;
      return `<li><span>${p > 0 ? 'Right' : 'Wrong'}: ${esc(short)}</span><span class="${p >= 0 ? 'plus' : 'minus'}">${p > 0 ? '+' + p : p < 0 ? '−' + (-p) : '0'}</span></li>`;
    }
    return `<li><span>Called ${esc(answer(c, c.mine.pick))} (${CONF[c.mine.conf].label.toLowerCase()}): ${esc(short)}</span><span>·</span></li>`;
  });
  return `<h1 class="page-title">Me</h1>
    <div class="balance"><div class="big">${s.score}</div><div class="lbl">season score · ${s.settled ? `${ord(s.rank)} of ${s.people}` : 'no results yet'} in ${esc(COMMUNITY.name)}</div>
      <div class="fine">Signed in as ${esc(m.name)} · ${esc(m.email)}</div></div>
    <h2 class="section-h">Activity</h2>
    ${log.length ? `<ul class="log">${log.join('')}</ul>` : '<div class="empty">No calls yet. Your results will show up here.</div>'}
    <h2 class="section-h">Account</h2>
    <button class="secondary" data-act="privacy">Privacy notice</button>
    <button class="secondary" data-act="sign-out">Log out</button>
    <button class="secondary danger" data-act="delete-me">Delete my account</button>`;
}

function openPrivacy() {
  openSheet(`<h2 id="sheet-title">Privacy notice</h2>
    <div class="privacy-text">
      <p><b>What we collect.</b> Your first name, your Cambridge email address, the calls you make (your answer, how sure you were, and when), and any comments you post.</p>
      <p><b>Why.</b> Only to run BNOC: to work out results and scores, and to show the leaderboard. No ads, and we never sell your data.</p>
      <p><b>Who can see it.</b> Other members see your first name, your score and any comments you post. They see how many people picked each answer on a call, but never your individual calls or your email. The small E-Lab team running the pilot can see names, emails and scores, to run the game and contact winners.</p>
      <p><b>Where it's kept.</b> On Netlify, the service that hosts BNOC.</p>
      <p><b>Deleting your account.</b> Go to Me, then Delete my account. Your name, email, calls and comments are removed straight away. You can also delete any single comment of yours.</p>
      <p><b>Pilot note.</b> During the pilot we don't verify email addresses, so please only use your own.</p>
    </div>
    <button class="primary" data-act="close">Got it</button>`);
}

function confirmSignOut() {
  openSheet(`<h2 id="sheet-title">Log out?</h2>
    <p class="lead">You can come back any time by joining with the same email. Your points stay with your account.</p>
    <button class="primary" data-act="sign-out-confirm">Log out</button>
    <button class="secondary" data-act="close">Stay logged in</button>`);
}

function confirmDelete() {
  openSheet(`<h2 id="sheet-title">Delete your account?</h2>
    <p class="lead">This removes your name, email, all your calls and your comments from BNOC straight away. You'll disappear from the leaderboard. This can't be undone.</p>
    <div class="err" id="del-err" role="alert"></div>
    <button class="primary" data-act="delete-confirm">Delete my account</button>
    <button class="secondary" data-act="close">Keep my account</button>`);
}

async function deleteAccount(btn) {
  btn.disabled = true;
  const { error } = await api.deleteMe();
  btn.disabled = false;
  if (error) return showError($('#del-err'), error);
  setToken('');
  S.state = { ...S.state, me: null };
  closeSheet(); render();
  toast('Your account has been deleted');
}

// ---------- Data ----------
async function refresh() {
  if (S.tab === 'admin') return refreshAdmin();
  const { data, error } = await api.state();
  S.loaded = true;
  if (error) {
    if (!S.state) { S.state = { me: null }; render(); }
    return;
  }
  if (!data.me && getToken()) setToken('');   // this phone's login no longer exists
  S.state = data;
  // Don't redraw the join form under someone's fingers.
  if (!me() && !$('#gate').classList.contains('hide') && $('#ob-name')) return;
  render();
}

// ---------- Events ----------
function tabFromHash() {
  const t = location.hash.replace(/^#\//, '');
  return TABS.includes(t) ? t : 'calls';
}

document.addEventListener('click', e => {
  const b = e.target.closest('[data-act]');
  if (!b || b.closest('[data-admin]')) return;   // admin.js handles its own buttons
  const id = b.dataset.id;
  switch (b.dataset.act) {
    case 'join': onJoin(b); break;
    case 'tab': closeSheet(); location.hash = `#/${b.dataset.tab}`; break;
    case 'filter': S.filter = b.dataset.f; render(); break;
    case 'call': openCall(id, Number(b.dataset.pick)); break;
    case 'conf':
      S.callCtx.conf = b.dataset.k;
      document.querySelectorAll('[data-act="conf"]').forEach(x => x.setAttribute('aria-pressed', String(x.dataset.k === S.callCtx.conf)));
      updateEst();
      break;
    case 'confirm-call': confirmCall(b); break;
    case 'suggest': openSuggest(); break;
    case 'send-suggestion': sendSuggestion(b); break;
    case 'switch-comm': toast(`${COMMUNITY.name} is the only community in the pilot`); break;
    case 'privacy': openPrivacy(); break;
    case 'sign-out': confirmSignOut(); break;
    case 'sign-out-confirm': setToken(''); S.state = { ...S.state, me: null }; closeSheet(); render(); break;
    case 'delete-me': confirmDelete(); break;
    case 'delete-confirm': deleteAccount(b); break;
    case 'comments': openComments(id); break;
    case 'post-comment': postComment(b); break;
    case 'delete-comment': deleteComment(b); break;
    case 'close': closeSheet(); break;
  }
  // Closing the sheet (Close button or tapping outside) stops the comments refreshing and updates the card.
  if (S.commentsFor && !$('#sheet').classList.contains('open')) { stopComments(); render(); }
});
document.addEventListener('keydown', e => {
  if (e.key === 'Escape' && $('#sheet').classList.contains('open')) {
    closeSheet();
    if (S.commentsFor) { stopComments(); render(); }
  }
  if (e.key === 'Enter' && (e.target.id === 'ob-name' || e.target.id === 'ob-email')) $('[data-act="join"]')?.click();
});
window.addEventListener('hashchange', () => {
  const was = S.tab;
  S.tab = tabFromHash();
  render();
  $('#content').scrollTop = 0;
  if (was === 'admin' && S.tab !== 'admin') refresh();
});
document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible') refresh(); });
setInterval(() => { if (document.visibilityState === 'visible' && !$('#sheet').classList.contains('open')) refresh(); }, REFRESH_MS);

// ---------- Start ----------
S.tab = tabFromHash();
render();
refresh();
