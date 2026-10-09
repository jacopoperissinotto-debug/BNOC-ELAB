// BNOC pitch app: join, make calls, see the leaderboard. The admin page lives in admin.js (#/admin).
import './styles.css';
import { api, getToken, setToken } from './api.js';
import { $, esc, ord, toast, openSheet, closeSheet, showError, clearError, avatar, fmtWhen, capitalise, colorOf } from './ui.js';
import { CONF, COMMUNITY, isCamEmail, CAM_ONLY_MSG, isBannedTopic, BANNED_MSG } from '../shared/rules.js';
import { renderAdmin, refreshAdmin } from './admin.js';

const TABS = ['calls', 'ranks', 'rewards', 'how', 'me', 'admin'];
const GELATO = '<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M7 11a5 5 0 0 1 10 0"/><path d="M6 11h12l-6 11z"/></svg>';
const STAR = '<svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M12 2.5l2.9 6 6.6.8-4.9 4.5 1.3 6.5L12 17l-5.9 3.3 1.3-6.5L2.5 9.3l6.6-.8z"/></svg>';
const REFRESH_MS = 15000;
const COMMENTS_REFRESH_MS = 6000;
const COMMENT_MAX = 280;
const BUBBLE = '<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M21 12a8 8 0 0 1-11.6 7.1L4 20l1-4.6A8 8 0 1 1 21 12z"/></svg>';

const S = {
  state: null,        // what the server says: me, calls, board, score, rank, people
  loaded: false,
  tab: 'calls',
  filter: 'live',     // 'live' | 'asked' (member-run communities only) | 'results'
  community: localStorage.getItem('bnoc.community') || 'ke',   // the community on screen
  callCtx: null,      // the call being answered in the confidence sheet
  choosing: false,    // just signed in and in more than one community: pick where to go first
  closeCtx: null,     // the call you're closing, and the result you picked
  askClose: 'late',   // closing time picked in the "Ask a question" sheet
  commentsFor: null,  // the call whose comments are open
  justCalled: new Set()  // calls answered since the app was opened: they keep their place on Live
                         // (showing the revealed forecast) instead of dropping to the bottom at once
};
let commentsTimer = null;

const me = () => S.state?.me;
// The community on screen. King's E-Lab is "official" (the team posts and settles calls); the others
// are "open": member-run, joined with an invite link, and whoever asks a question closes it.
const comm = () => S.state?.community || { id: 'ke', name: COMMUNITY.name, short: COMMUNITY.short, mode: 'official' };
const isOpen = () => comm().mode === 'open';
const dot = (c, extra = '') => `<span class="avatar ${extra}" style="background:${c.id === 'ke' ? 'var(--plum)' : colorOf(c.id)}" aria-hidden="true">${esc(c.short)}</span>`;

// An invite link looks like bnoc.netlify.app/#/invite/abc123. The code is kept until you're signed in.
const INVITE_KEY = 'bnoc.invite';
const inviteLink = token => `${location.origin}/#/invite/${token}`;
function catchInvite() {
  const m = location.hash.match(/^#\/invite\/([\w-]{6,60})$/);
  if (!m) return;
  localStorage.setItem(INVITE_KEY, m[1]);
  history.replaceState(null, '', '#/calls');
}
function setCommunity(id) {
  S.community = id;
  localStorage.setItem('bnoc.community', id);
}
async function useInvite() {
  const token = localStorage.getItem(INVITE_KEY);
  if (!token || !me()) return;
  localStorage.removeItem(INVITE_KEY);
  const { data, error } = await api.joinCommunity(token);
  if (error) { render(); return toast(error); }
  S.state = data.state;
  setCommunity(data.community.id);
  S.tab = 'calls'; S.filter = 'live';
  render();
  toast(`You're in ${data.community.name}`);
}
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
    <p class="full">Big Name On Campus</p>
    <p class="pitch">${localStorage.getItem(INVITE_KEY) ? "You've been invited to a community. Join BNOC to get in." : 'Call what happens around you. Show up. Top the table.'}</p>
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

// Right after signing in, people in more than one community choose which one to open.
function renderChooser() {
  $('#gate').classList.remove('hide');
  $('#top').hidden = true; $('#content').hidden = true; $('#nav').hidden = true;
  $('#gate').innerHTML = `<p class="mark">BN<span>O</span>C</p>
    <p class="full">Big Name On Campus</p>
    <p class="pitch">Hi ${esc(capitalise(me().name))}. Where to?</p>
    <div class="comm-list">${S.state.communities.map(c => `<button class="comm-row" data-act="choose-comm" data-id="${esc(c.id)}">
        ${dot(c)}<span class="who"><b>${esc(c.name)}</b><br><small>${c.mode === 'open' ? 'Member-run · invite only' : 'Official community'}</small></span>
        <span class="tick" aria-hidden="true">›</span></button>`).join('')}</div>
    <div class="spacer"></div>
    <p class="small">You can switch any time from the button at the top left.</p>`;
}

function chooseCommunity(id) {
  S.choosing = false;
  setCommunity(id);
  S.filter = 'live';
  if (id === comm().id) return render();
  $('#gate').innerHTML = '<p class="mark">BN<span>O</span>C</p><p class="full">Loading…</p>';
  refresh();
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
  if (localStorage.getItem(INVITE_KEY)) return useInvite();
  if ((data.state.communities || []).length > 1) { S.choosing = true; return render(); }
  if (S.community !== 'ke') refresh();
}

// ---------- Layout ----------
function render() {
  if (S.tab === 'admin') return renderAdminPage();
  if (!me()) return renderGate();
  if (S.choosing) return renderChooser();
  $('#gate').classList.add('hide');
  $('#top').hidden = false; $('#content').hidden = false; $('#nav').hidden = false;
  $('#pts').textContent = S.state.score;
  const c = comm();
  $('#comm-dot').textContent = c.short;
  $('#comm-dot').style.background = c.id === 'ke' ? '' : colorOf(c.id);
  $('#comm-name').textContent = c.name;
  $('#nav .fab').setAttribute('aria-label', isOpen() ? 'Ask a question' : 'Suggest a call');
  if (S.filter === 'asked' && !isOpen()) S.filter = 'live';
  document.querySelectorAll('#nav [data-tab]').forEach(b => {
    if (b.dataset.tab === S.tab) b.setAttribute('aria-current', 'page'); else b.removeAttribute('aria-current');
  });
  $('#content').innerHTML = ({ calls: renderCalls, ranks: renderRanks, rewards: renderRewards, how: renderHow, me: renderMe })[S.tab]();
}

function renderAdminPage() {
  $('#gate').classList.add('hide');
  $('#top').hidden = true; $('#nav').hidden = true; $('#content').hidden = false;
  renderAdmin($('#content'));
}

// ---------- Calls ----------
const EARLY_READ = 5;   // below this many calls, the forecast is labelled "Early read"

// A small smooth line showing how the forecast moved (up = more likely), on a fixed 0–100% scale
// so small wobbles look small. Drawn as a curve through the points rather than sharp zig-zags.
function sparkline(trend) {
  if (!trend || trend.length < 2) return '';
  const w = 88, h = 26, pad = 3;
  const pts = trend.map((v, i) => [pad + i / (trend.length - 1) * (w - 2 * pad), pad + (1 - v / 100) * (h - 2 * pad)]);
  const f = n => n.toFixed(1);
  let d = `M${f(pts[0][0])},${f(pts[0][1])}`;
  for (let i = 0; i < pts.length - 1; i++) {
    const p0 = pts[i - 1] || pts[i], p1 = pts[i], p2 = pts[i + 1], p3 = pts[i + 2] || p2;
    d += ` C${f(p1[0] + (p2[0] - p0[0]) / 6)},${f(p1[1] + (p2[1] - p0[1]) / 6)} ${f(p2[0] - (p3[0] - p1[0]) / 6)},${f(p2[1] - (p3[1] - p1[1]) / 6)} ${f(p2[0])},${f(p2[1])}`;
  }
  const [ex, ey] = pts[pts.length - 1];
  return `<svg class="spark" width="${w}" height="${h}" viewBox="0 0 ${w} ${h}" aria-hidden="true">
    <line x1="0" y1="${h / 2}" x2="${w}" y2="${h / 2}" class="mid"/><path d="${d}"/><circle cx="${f(ex)}" cy="${f(ey)}" r="2.5"/></svg>`;
}

// The crowd forecast as a probability, the same for everyone so people can talk about one number.
// It always tracks the first answer ("63% chance it happens", "38% chance of Less than 50"), so the
// number and graph never flip meaning when the lead changes. Your own odds are shown separately,
// in your "You called" row, in your answer's colour.
const LOCK = '<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="5" y="11" width="14" height="10" rx="2"/><path d="M8 11V7a4 4 0 0 1 8 0v4"/></svg>';

function forecastBlock(c) {
  if (!c.total) return `<div class="bar bar-empty">${c.status === 'open' ? 'No calls yet. Be the first!' : 'Nobody called this one'}</div>`;
  if (c.hidden) return `<div class="bar bar-empty fc-locked">${LOCK}Make your call to see the crowd forecast</div>`;
  const yesNo = c.options[0] === 'Yes' && c.options[1] === 'No';
  const pct = c.forecast, trend = c.trend;
  const what = yesNo ? 'chance it happens' : `chance of ${esc(answer(c, 0))}`;
  const early = c.total < EARLY_READ;
  const status = c.status === 'open'
    ? '<span class="live"><i aria-hidden="true"></i>Updated live</span>'
    : '<span class="live off">Final forecast</span>';
  return `<div class="fc ${early ? 'early' : ''}" role="img" aria-label="Crowd forecast: ${pct}% ${what}${early ? ', early read' : ''}">
      <div class="fc-top">
        <div class="fc-main">
          <div><span class="fc-num">${pct}%</span>${early ? '<span class="early-pill">Early read</span>' : ''}</div>
          <div class="fc-sub">${what}</div>
        </div>
        <div class="fc-side">${status}${sparkline(trend)}</div>
      </div>
      <div class="meter"><i style="width:${pct}%"></i></div>
    </div>`;
}

function callCard(c) {
  const total = c.total;
  let chips = '';
  if (c.status === 'closed') chips += `<span class="chip wait">${!c.by ? 'Closed · result coming soon' : c.yours ? 'Closed · waiting for your result' : `Closed · waiting for ${esc(c.by)}'s result`}</span>`;
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
    // Your personal odds: the crowd's chance of the answer you picked, in that answer's colour.
    const myPct = c.forecast === null || c.forecast === undefined ? null : c.mine.pick === 0 ? c.forecast : 100 - c.forecast;
    const right = myPct === null ? '<span class="locked">Locked in</span>' : `<span class="my-odds pick-${c.mine.pick}">${myPct}% chance</span>`;
    action = `<div class="my-stake"><span>You called ${tag(c, c.mine.pick)} · ${cf.label}</span>${right}</div>`;
  }
  const when = c.status === 'open' ? `Closes ${fmtWhen(c.closesAt)}` : c.status === 'closed' ? `Closed ${fmtWhen(c.closesAt)}` : 'Settled';
  // Member-run communities show who asked. On your own question you get an extra strip to close it.
  const meta = !c.by ? `${dot(comm())}<span><b>${esc(comm().name)}</b> · official call</span>`
    : c.yours ? `${avatar(me().id, me().name)}<span><b>You</b> asked this</span>`
    : `<span class="avatar" style="background:${colorOf(c.by)}" aria-hidden="true">${esc(c.by.slice(0, 1).toUpperCase())}</span><span><b>${esc(c.by)}</b> asked this</span>`;
  let owner = '';
  if (c.yours && c.status !== 'settled') {
    owner = `<div class="owner"><span><b>Your question.</b> ${c.status === 'open' ? 'You decide when it ends.' : 'Tell everyone what happened.'}</span>
      <button data-act="close-own" data-id="${c.id}">${c.status === 'open' ? 'Close it' : 'Give the result'}</button></div>`;
  } else if (c.canUndo) {
    owner = `<div class="owner done"><span>You closed this as <b>${esc(answer(c, c.result))}</b>.</span>
      <button data-act="undo-own" data-id="${c.id}">Undo</button></div>`;
  } else if (c.canManage) {
    // You run this community: close, settle, correct or remove anyone's question.
    owner = `<div class="owner admin"><span><b>Admin.</b> ${c.status === 'settled' ? `Closed as ${esc(answer(c, c.result))}${c.closedBy ? ` by ${esc(c.closedBy)}` : ''}.` : c.status === 'open' ? 'You can close this for them.' : 'Still waiting for a result.'}</span>
      <button data-act="close-own" data-id="${c.id}">${c.status === 'settled' ? 'Change' : c.status === 'open' ? 'Close it' : 'Give the result'}</button></div>`;
  }
  return `<article class="call ${c.yours ? 'yours' : ''}">
    <div class="call-meta">${meta}</div>
    <h3>${esc(c.q)}</h3>
    ${chips ? `<div class="chips">${chips}</div>` : ''}
    ${forecastBlock(c)}
    <div class="call-foot"><span>${total ? `${total} ${total === 1 ? 'person' : 'people'} called it · ` : ''}${when}</span>
      <button class="cmt-btn" data-act="comments" data-id="${c.id}" aria-label="${c.comments} comments">${BUBBLE}${c.comments || 'Comment'}</button></div>
    ${action}
    ${owner}
  </article>`;
}

function renderCalls() {
  const all = S.state.calls, c = comm(), open = isOpen();
  // Live = every call still open: the ones you haven't answered first, the ones you have underneath.
  // Asked (member-run communities) = your own questions. Results = calls that have closed.
  const todoList = all.filter(x => x.status === 'open' && (!x.mine || S.justCalled.has(x.id)));
  const doneList = all.filter(x => x.status === 'open' && x.mine && !S.justCalled.has(x.id));
  const order = { closed: 0, open: 1, settled: 2 };
  const asked = all.filter(x => x.yours).sort((a, b) => order[a.status] - order[b.status]);
  const results = all.filter(x => x.status !== 'open');
  const todo = todoList.filter(x => !x.mine).length;
  const waiting = asked.filter(x => x.status === 'closed').length;   // your questions that need a result
  const f = (k, l, n) => `<button data-act="filter" data-f="${k}" aria-pressed="${S.filter === k}">${l}${n ? ` <span class="seg-count">${n}</span>` : ''}</button>`;
  const empty = t => `<div class="empty">${t}</div>`;
  const people = `${S.state.people} ${S.state.people === 1 ? 'person' : 'people'}`;
  let list;
  if (S.filter === 'asked') {
    list = asked.length ? asked.map(callCard).join('') : empty('You haven\'t asked anything yet. Tap + to ask your first question.');
  } else if (S.filter === 'results') {
    list = results.length ? results.map(callCard).join('') : empty('No results yet. Calls land here once they close.');
  } else if (!todoList.length && !doneList.length) {
    list = empty(open ? 'No live calls right now. Tap + to ask the first one.' : 'No live calls right now. New ones are on the way.');
  } else {
    list = (todoList.length ? todoList.map(callCard).join('') : empty("You've made every live call."))
      + (doneList.length ? `<h2 class="sub-h">You've called these</h2>${doneList.map(callCard).join('')}` : '');
  }
  const host = open
    ? `<div class="host">${dot(c)}<span><b>Member-run · ${people}.</b> Anyone here can ask a question, and whoever asked closes it.</span>${S.state.admin ? '<button class="host-btn" data-act="switch-comm">Invite</button>' : ''}</div>`
    : `<div class="host">${dot(c)}<span><b>Official community · ${people}.</b> Calls are posted by the E-Lab team. Tap + to suggest one.</span></div>`;
  return `<h1 class="page-title">Calls</h1>
    <p class="page-sub">What's going to happen at ${esc(c.name)}? Make your call before it closes.</p>
    ${host}
    <div class="seg" role="group" aria-label="Filter calls">${f('live', 'Live', todo)}${open ? f('asked', 'Asked', waiting) : ''}${f('results', 'Results')}</div>
    ${list}`;
}

function openCall(id, pick) {
  const c = S.state.calls.find(x => x.id === id);
  if (!c) return;
  S.callCtx = { id, pick, conf: 'sure' };
  const dots = n => `<span class="dots" aria-hidden="true">${[1, 2, 3].map(i => `<i class="${i <= n ? 'on' : ''}"></i>`).join('')}</span>`;
  openSheet(`<p class="sheet-q">${esc(c.q)}</p>
    <h2 id="sheet-title">You're calling ${tag(c, pick)}</h2>
    <p class="lead">How sure are you?</p>
    <div class="conf" role="group" aria-label="How sure are you?">${Object.entries(CONF).map(([k, v]) => `<button data-act="conf" data-k="${k}" aria-pressed="${k === 'sure'}">${dots(v.level)}<b>${v.label}</b><span>${v.hint}</span></button>`).join('')}</div>
    <p class="conf-note">The surer you are, the more you win if you're right, and the more you risk if you're wrong.</p>
    <div class="err" id="call-err" role="alert"></div>
    <button class="primary" data-act="confirm-call">Lock in my call</button>
    <button class="secondary" data-act="close">Cancel</button>
    <p class="lead center" style="font-size:12.5px;margin:12px 0 0">You can't change a call once it's locked in.</p>`);
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
  S.justCalled.add(id);   // keep its place on Live for now, showing the revealed forecast
  closeSheet(); render();
  toast(`Locked in: ${label}. Here's what the crowd thinks`);
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
      <div class="hint">Be kind. Everyone sees your first name.</div></div>
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
    <p class="lead">Suggest a question with two possible answers for everyone in ${esc(comm().name)}. The E-Lab team checks suggestions before they go live.</p>
    <div class="err" id="sg-err" role="alert"></div>
    <div class="field"><label for="sg-q">Your question</label><textarea id="sg-q" maxlength="140" placeholder="Will more than 40 people come to Thursday's social?"></textarea>
      <div class="hint">Not allowed: relationships, health, appearance or grades.</div></div>
    <div class="field"><label id="sg-ans-l">The two answers</label>
      <div class="pair" role="group" aria-labelledby="sg-ans-l">
        <input type="text" id="sg-a0" maxlength="20" value="Yes" aria-label="First answer">
        <input type="text" id="sg-a1" maxlength="20" value="No" aria-label="Second answer">
      </div>
      <div class="hint">Leave as Yes / No, or change them, e.g. "The Eagle" / "The Bath House".</div></div>
    <button class="primary" data-act="send-suggestion">Send suggestion</button>
    <button class="secondary" data-act="close">Cancel</button>`);
}

async function sendSuggestion(btn) {
  const q = $('#sg-q').value.trim(), err = $('#sg-err');
  const options = [$('#sg-a0').value.trim(), $('#sg-a1').value.trim()];
  clearError(err);
  if (q.length < 10) return showError(err, 'Write a full question, like "Will the E-Lab social run past 10pm?"');
  if (!options[0] || !options[1]) return showError(err, 'Fill in both answers.');
  if (options[0].toLowerCase() === options[1].toLowerCase()) return showError(err, 'The two answers need to be different.');
  if ([q, ...options].some(isBannedTopic)) return showError(err, BANNED_MSG);
  btn.disabled = true;
  const { error } = await api.suggest(q, options);
  btn.disabled = false;
  if (error) return showError(err, error);
  closeSheet();
  toast('Suggestion sent. The E-Lab team reviews it before it goes live.');
}

// ---------- Member-run communities: ask a question, close your own, switch, invite ----------
const pad2 = n => String(n).padStart(2, '0');
const toLocalInput = d => `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}T${pad2(d.getHours())}:${pad2(d.getMinutes())}`;
const ASK_TIMES = [['hour', 'In 1 hour'], ['tonight', 'Tonight'], ['late', 'Tomorrow night'], ['week', 'In a week'], ['custom', 'Pick a time']];
function askTime(kind) {
  const d = new Date();
  if (kind === 'hour') d.setHours(d.getHours() + 1);
  else if (kind === 'tonight') d.setHours(23, 59, 0, 0);
  else if (kind === 'late') { d.setDate(d.getDate() + 1); d.setHours(23, 59, 0, 0); }
  else if (kind === 'week') { d.setDate(d.getDate() + 7); d.setHours(23, 59, 0, 0); }
  else { const v = $('#ask-when')?.value, c = v ? new Date(v) : null; return c && !isNaN(c) ? c : null; }
  return d;
}

function openAsk() {
  S.askClose = 'late';
  openSheet(`<h2 id="sheet-title">Ask a question</h2>
    <p class="lead">It goes live for everyone in ${esc(comm().name)} straight away. You close it and give the result.</p>
    <div class="err" id="ask-err" role="alert"></div>
    <div class="field"><label for="ask-q">Your question</label><textarea id="ask-q" maxlength="140" placeholder="Will more than 10 of us make it to Friday's social?"></textarea>
      <div class="hint">Not allowed: relationships, health, appearance or grades.</div></div>
    <div class="field"><label id="ask-ans-l">The two answers</label>
      <div class="pair" role="group" aria-labelledby="ask-ans-l">
        <input type="text" id="ask-a0" maxlength="20" value="Yes" aria-label="First answer">
        <input type="text" id="ask-a1" maxlength="20" value="No" aria-label="Second answer">
      </div></div>
    <div class="field"><label id="ask-when-l">Answers lock</label>
      <div class="opts" role="group" aria-labelledby="ask-when-l">${ASK_TIMES.map(([k, l]) => `<button class="opt" data-act="ask-time" data-k="${k}" aria-pressed="${k === S.askClose}">${l}</button>`).join('')}</div>
      <input type="datetime-local" id="ask-when" aria-label="Closing time" value="${toLocalInput(askTime('late'))}" hidden style="margin-top:8px">
      <div class="hint">You can also close it yourself earlier, any time.</div></div>
    <button class="primary" data-act="send-ask">Post it</button>
    <button class="secondary" data-act="close">Cancel</button>`);
}

async function sendAsk(btn) {
  const q = $('#ask-q').value.trim(), err = $('#ask-err');
  const options = [$('#ask-a0').value.trim(), $('#ask-a1').value.trim()];
  const when = askTime(S.askClose);
  clearError(err);
  if (q.length < 10) return showError(err, 'Write a full question, like "Will we finish the deck by Thursday?"');
  if (!options[0] || !options[1]) return showError(err, 'Fill in both answers.');
  if (options[0].toLowerCase() === options[1].toLowerCase()) return showError(err, 'The two answers need to be different.');
  if ([q, ...options].some(isBannedTopic)) return showError(err, BANNED_MSG);
  if (!when || when <= new Date()) return showError(err, 'Pick a closing time in the future.');
  btn.disabled = true;
  const { data, error } = await api.postCall(comm().id, q, options, when.toISOString());
  btn.disabled = false;
  if (error) return showError(err, error);
  S.state = data.state;
  S.filter = 'live';
  closeSheet(); render();
  toast('Your question is live');
}

function openCloseOwn(id) {
  const c = S.state.calls.find(x => x.id === id);
  if (!c) return;
  S.closeCtx = { id, result: null };
  const settled = c.status === 'settled';
  const top = settled ? 'Change the result' : !c.yours ? `Admin · ${esc(c.by)}'s question` : c.status === 'open' ? 'Close your question' : 'Your question has closed';
  const lead = settled ? `It was closed as <b>${esc(answer(c, c.result))}</b>. Pick what really happened and everyone's points update straight away.`
    : `What happened? ${c.status === 'open' ? 'Answers lock the moment you close it, and points go out straight away.' : 'Points go out as soon as you give the result.'}`;
  openSheet(`<p class="sheet-q">${top}</p>
    <h2 id="sheet-title">${esc(c.q)}</h2>
    <p class="lead">${lead}</p>
    <div class="vote pick-result" role="group" aria-label="What happened?">
      <button class="yes" data-act="pick-result" data-r="0" aria-pressed="false">${esc(answer(c, 0))}</button>
      <button class="no" data-act="pick-result" data-r="1" aria-pressed="false">${esc(answer(c, 1))}</button>
    </div>
    <div class="err" id="close-err" role="alert"></div>
    <button class="primary" data-act="confirm-close" disabled>Pick what happened</button>
    <button class="secondary" data-act="close">Not yet</button>
    ${settled ? `<button class="secondary" data-act="undo-own" data-id="${c.id}">Take the result back (no points until it's closed again)</button>` : ''}
    <button class="secondary danger" data-act="cancel-own">${c.yours ? 'Cancel' : 'Remove'} this question (nobody gets points)</button>
    ${S.state.admin ? '' : '<p class="lead center" style="font-size:12.5px;margin:12px 0 0">Picked the wrong one? You can undo for 15 minutes.</p>'}`);
}

async function finishOwn(btn, result) {
  btn.disabled = true;
  const { data, error } = await api.closeCall(S.closeCtx.id, result);
  btn.disabled = false;
  if (error) { showError($('#close-err'), error); return; }
  const c = S.state.calls.find(x => x.id === S.closeCtx.id);
  S.state = data.state;
  if (result !== 'cancel') S.filter = 'results';
  closeSheet(); render();
  toast(result === 'cancel' ? 'Question cancelled' : `Closed as ${answer(c, result)}. Points are out.`);
}

async function undoOwn(btn, id) {
  btn.disabled = true;
  const { data, error } = await api.undoClose(id);
  btn.disabled = false;
  if (error) { toast(error); return refresh(); }
  S.state = data.state;
  closeSheet(); render();
  toast('Result undone. Close it again when you\'re ready.');
}

function openCommunities() {
  const cur = comm(), list = S.state.communities || [cur];
  const invite = S.state.invite;
  openSheet(`<h2 id="sheet-title">Your communities</h2>
    <div class="comm-list">${list.map(c => `<button class="comm-row" data-act="pick-comm" data-id="${esc(c.id)}" aria-pressed="${c.id === cur.id}">
        ${dot(c)}<span class="who"><b>${esc(c.name)}</b><br><small>${c.mode === 'open' ? `Member-run · invite only${c.id === cur.id && S.state.admin ? ' · you run it' : ''}` : 'Official community'}</small></span>
        ${c.id === cur.id ? '<span class="tick" aria-hidden="true">✓</span>' : ''}</button>`).join('')}</div>
    ${invite ? `<h3 class="sub-h">Invite people to ${esc(cur.name)}</h3>
      <p class="lead" style="margin-bottom:8px">Anyone who opens this link and joins BNOC gets in. Only share it with people you want here.</p>
      <div class="field"><input type="text" id="inv-link" readonly value="${esc(inviteLink(invite))}" aria-label="Invite link"></div>
      <button class="primary dark" data-act="copy-invite">Copy invite link</button>
      <button class="link-btn" data-act="new-invite">Make a new link (the old one stops working)</button>`
      : `<p class="lead" style="margin-top:14px">${cur.mode === 'open' ? `Only the admin of ${esc(cur.name)} can invite people. ` : ''}Other communities are invite only: open an invite link on this phone to join one.</p>`}
    <button class="secondary" data-act="close">Close</button>`);
}

async function copyInvite(btn) {
  const link = inviteLink(S.state.invite);
  try {
    await navigator.clipboard.writeText(link);
    toast('Invite link copied');
  } catch {
    $('#inv-link').select();
    toast('Press and hold the link to copy it');
  }
}

async function newInvite(btn) {
  if (!confirm('Make a new invite link? The old one stops working. People already in stay in.')) return;
  btn.disabled = true;
  const { data, error } = await api.newInvite(comm().id);
  btn.disabled = false;
  if (error) return toast(error);
  S.state = data.state;
  openCommunities();
  toast('New invite link ready');
}

function pickCommunity(id) {
  closeSheet();
  if (id === comm().id) return;
  setCommunity(id);
  S.filter = 'live'; S.justCalled.clear();
  if (S.tab !== 'calls') location.hash = '#/calls';
  $('#content').innerHTML = '<div class="empty">Loading…</div>';
  refresh();
}

// ---------- Ranks ----------
function renderRanks() {
  const b = S.state.board, myId = me().id;
  const label = x => x.id === myId ? 'You' : x.name;
  const row = (x, rank) => `<div class="row ${x.id === myId ? 'me' : ''}"><span class="rank">${rank}</span>${avatar(x.id, x.name)}<span class="who">${esc(x.id === myId ? `${x.name} (you)` : x.name)}</span><span class="sc">${x.score}</span></div>`;
  const head = `<h1 class="page-title">Ranks</h1>
    <p class="page-sub">Season 1 in ${esc(comm().name)}. Points land when a call is settled.</p>`;
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

// ---------- Rewards ----------
function renderRewards() {
  const r = S.state.reward, s = S.state;
  const standing = !s.settled
    ? `<b>No results yet.</b> ${s.people} ${s.people === 1 ? 'person is' : 'people are'} playing. Points land when the first call is settled.`
    : `<b>You're ${ord(s.rank)} of ${s.people}</b> with ${s.score} ${Math.abs(s.score) === 1 ? 'point' : 'points'}.${s.rank === 1 ? ' Top of the table: hold on to it!' : ''}`;
  const prize = r ? `<article class="chal reward">
      ${r.sponsor ? `<div class="biz"><span class="logo">${GELATO}</span>${esc(r.sponsor)}</div>` : ''}
      <h3>${esc(r.prize)}</h3>
      ${r.who ? `<p>${esc(r.who)}</p>` : ''}
      ${r.when ? `<span class="prize">${STAR} ${esc(r.when)}</span>` : ''}
      <div class="chal-actions"><button data-act="tab" data-tab="ranks">See the leaderboard</button></div>
      ${r.details ? `<div class="fine">${esc(r.details)}</div>` : ''}
    </article>`
    : `<div class="empty">${isOpen() ? 'No prize in this community: just bragging rights.' : 'No reward right now. Keep calling: the next one is on its way.'}</div>`;
  return `<h1 class="page-title">Rewards</h1>
    <p class="page-sub">${isOpen() ? `Top the ${esc(comm().name)} table.` : `Top the ${esc(comm().name)} table to win.`} Free to play: nothing to buy, nothing to cash out.</p>
    ${prize}
    <div class="banner"><span aria-hidden="true">${STAR}</span><span>${standing}</span></div>
    <button class="secondary" data-act="tab" data-tab="how">How scoring works</button>`;
}

// ---------- Rules ----------
function scoringTable() {
  return `<table class="score-table"><thead><tr><th>Confidence</th><th>Right</th><th>Wrong</th></tr></thead><tbody>
    ${Object.values(CONF).map(c => `<tr><td>${c.label} (${c.pct})</td><td class="plus">+${c.win}</td><td class="minus">${c.lose ? '−' + c.lose : '0'}</td></tr>`).join('')}
    </tbody></table>`;
}

function renderHow() {
  const open = isOpen(), name = esc(comm().name);
  return `<h1 class="page-title">How it works</h1>
    <p class="page-sub">Forecasting, not betting. There's no money anywhere.</p>
    <div class="rules"><b>1. Make a call.</b> Pick one of the two answers (usually Yes or No) on a question about ${name}, and say how sure you are:
      ${scoringTable()}
      <b>The crowd forecast</b> on each call averages everyone's calls, weighted by how sure they were: a Certain call moves it more than a Hunch. You see it once you've made your call.<br>
      <b>2. Wait for the result.</b> ${open ? 'Calls lock at their closing time, or sooner if the person who asked closes them. Whoever asked gives the result.' : 'Calls lock at their closing time, then the E-Lab team settles them.'}<br>
      <b>3. Climb the table.</b> You never put points in, so you can't lose anything you own. The points are set so that saying how sure you really are always scores best.<br><br>
      Points can't be bought, sold or cashed out.</div>
    ${open ? `<div class="rules"><b>This community runs itself.</b> Tap + to ask a question: it goes live for everyone in ${name} straight away. On your own questions you'll see a "Close it" button, and the Asked tab lists everything you've asked. Each community has its own table, so points here don't mix with other communities.</div>` : ''}
    <div class="rules"><b>House rules.</b> No calls about relationships, health, appearance or grades. ${open ? 'Be fair when you close your own question: everyone can see who closed it.' : 'Tap + to suggest a call; the E-Lab team checks every suggestion.'}</div>
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
  return `<h1 class="page-title">${esc(capitalise(m.name))}</h1>
    <div class="balance"><div class="big">${s.score}</div><div class="lbl">season score · ${s.settled ? `${ord(s.rank)} of ${s.people}` : 'no results yet'} in ${esc(comm().name)}</div>
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
  setToken(''); setCommunity('ke');
  S.state = { ...S.state, me: null };
  closeSheet(); render();
  toast('Your account has been deleted');
}

// ---------- Data ----------
async function refresh() {
  if (S.tab === 'admin') return refreshAdmin();
  const asked = S.community;
  const { data, error } = await api.state(asked);
  if (asked !== S.community) return;   // switched community while this was loading
  S.loaded = true;
  if (error) {
    if (!S.state) { S.state = { me: null }; render(); }
    return;
  }
  if (!data.me && getToken()) setToken('');   // this phone's login no longer exists
  S.state = data;
  if (data.me && data.community.id !== S.community) setCommunity(data.community.id);   // no longer a member
  if (data.me && localStorage.getItem(INVITE_KEY)) return useInvite();
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
      break;
    case 'confirm-call': confirmCall(b); break;
    case 'suggest': isOpen() ? openAsk() : openSuggest(); break;
    case 'ask-time':
      S.askClose = b.dataset.k;
      document.querySelectorAll('[data-act="ask-time"]').forEach(x => x.setAttribute('aria-pressed', String(x.dataset.k === S.askClose)));
      $('#ask-when').hidden = S.askClose !== 'custom';
      break;
    case 'send-ask': sendAsk(b); break;
    case 'close-own': openCloseOwn(id); break;
    case 'pick-result': {
      S.closeCtx.result = Number(b.dataset.r);
      document.querySelectorAll('[data-act="pick-result"]').forEach(x => x.setAttribute('aria-pressed', String(x === b)));
      const go = $('[data-act="confirm-close"]');
      go.disabled = false; go.textContent = `${S.state.calls.find(x => x.id === S.closeCtx.id)?.status === 'settled' ? 'Set the result to' : 'Close it as'} ${b.textContent}`;
      break;
    }
    case 'confirm-close': if (S.closeCtx.result !== null) finishOwn(b, S.closeCtx.result); break;
    case 'cancel-own': if (confirm('Cancel this question? It disappears for everyone and nobody gets points.')) finishOwn(b, 'cancel'); break;
    case 'undo-own': undoOwn(b, id); break;
    case 'pick-comm': pickCommunity(id); break;
    case 'choose-comm': chooseCommunity(id); break;
    case 'copy-invite': copyInvite(b); break;
    case 'new-invite': newInvite(b); break;
    case 'send-suggestion': sendSuggestion(b); break;
    case 'switch-comm': openCommunities(); break;
    case 'privacy': openPrivacy(); break;
    case 'sign-out': confirmSignOut(); break;
    case 'sign-out-confirm': setToken(''); setCommunity('ke'); S.state = { ...S.state, me: null }; closeSheet(); render(); break;
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
  if (location.hash.startsWith('#/invite/')) { catchInvite(); S.tab = 'calls'; return me() ? useInvite() : render(); }
  const was = S.tab;
  S.tab = tabFromHash();
  render();
  $('#content').scrollTop = 0;
  if (was === 'admin' && S.tab !== 'admin') refresh();
});
document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible') refresh(); });
setInterval(() => { if (document.visibilityState === 'visible' && !$('#sheet').classList.contains('open')) refresh(); }, REFRESH_MS);

// ---------- Start ----------
catchInvite();
S.tab = tabFromHash();
render();
refresh();
