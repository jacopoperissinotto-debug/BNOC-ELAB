// BNOC pitch back end: one Netlify Function, data kept in Netlify Blobs (Netlify's built-in storage).
//
// Everything that matters for fairness happens here, not in the browser:
//   - answers are locked once made, and refused after a call closes
//   - scores are worked out here from answers + results, so nobody can edit their own score
//   - only someone with the ADMIN_KEY (a Netlify environment variable) can create, close or settle calls
//
// Stored keys:
//   user/{uid}                 { id, pid, name, email, createdAt, sessions: [hash] }
//                              uid is worked out from the email (so two joins at once can't make two
//                              accounts); pid is a random id, the only one phones ever see.
//   email/{sha(email)}         { uid }                  one account per email
//   session/{sha(token)}       { uid }                  "this phone is logged in as…"
//   call/{id}                  { id, q, options, closesAt, createdAt, order, result, settledAt, void }
//                              order: where it sits in the list (admin's ↑/↓); defaults to when it was posted
//                              options: the two possible answers (missing = Yes/No); result: which one
//                              happened, 0 = the first answer (Yes), 1 = the second (No)
//   f/{callId}/{uid}           { pick, conf, at }       the answer itself; written once, never overwritten
//   fx/{callId}/{uid}/{pick}/{conf}/{at}               the same answer as a key, so one list() counts everything
//   suggestion/{id}            { id, q, options, uid, name, at }      options: two answers (missing = Yes/No)
//   comment/{callId}/{at}.{uid}.{cid}  { cid, uid, pid, name, text, at }   comments on a call, oldest first
//   config/reward              { prize, sponsor, who, when, details }       the prize on the Rewards page (set by admin)
//
// Communities. King's E-Lab ("ke") is built in: everyone is in it, the admin posts its calls.
// Others are "member-run": you get in with an invite link, any member posts a call and it goes live
// at once, and whoever asked closes it and gives the result themselves.
//   community/{id}             { id, name, short, mode: 'open', invite, owner, createdAt }
//                              owner = the email of the community's admin: in without an invite, shares the
//                              invite link, can remove any question
//   member/{communityId}/{uid}                          "this person is in this community"
//   calls in a member-run community also carry { community, author, authorName, closedBy }
import { getStore } from '@netlify/blobs';
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { CONF, COMMUNITY, isCamEmail, normaliseEmail, CAM_ONLY_MSG, isBannedTopic, BANNED_MSG } from '../../shared/rules.js';

export const config = { path: '/api/*' };

const sha = s => createHash('sha256').update(String(s)).digest('hex');
const newId = () => randomBytes(9).toString('base64url');
const clean = (s, max) => String(s ?? '').replace(/\s+/g, ' ').trim().slice(0, max);
const json = (status, body) => new Response(JSON.stringify(body), {
  status, headers: { 'content-type': 'application/json', 'cache-control': 'no-store' }
});
// (Not 403 or 404 for our own messages: Netlify can swap those replies for its own "Not found" page.)
const fail = (status, error) => json(status, { error });

// Every call has exactly two answers: Yes/No by default, or two labels the admin chose
// ("Team A" / "Team B"). They're numbered: pick 0 is the first answer, pick 1 the second.
// (The first version stored 'yes'/'no' instead of numbers; those still read correctly.)
const YES_NO = ['Yes', 'No'];
const MAX_OPTIONS = 2;
const optionsOf = c => (Array.isArray(c.options) && c.options.length === 2 ? c.options : YES_NO);
const toPick = v => {
  if (v === 'yes') return 0;
  if (v === 'no') return 1;
  const n = typeof v === 'number' ? v : /^\d+$/.test(String(v ?? '')) ? Number(v) : NaN;
  return Number.isInteger(n) && n >= 0 && n < MAX_OPTIONS ? n : null;
};
const resultOf = c => (c.result === null || c.result === undefined ? null : toPick(c.result));

// ---------- Communities ----------
const KE = { id: 'ke', name: COMMUNITY.name, short: COMMUNITY.short, mode: 'official' };
const UNDO_MS = 15 * 60 * 1000;     // how long the person who closed a call can take the result back
const communityIdOf = c => c.community || KE.id;
const pub = c => ({ id: c.id, name: c.name, short: c.short, mode: c.mode });
// "BNOC & CO" → "BC"
const shortOf = name => {
  const w = name.replace(/[^A-Za-z0-9 ]/g, ' ').trim().split(/\s+/).filter(Boolean);
  return ((w[0]?.[0] || '') + (w[1]?.[0] || w[0]?.[1] || '')).toUpperCase() || 'CO';
};
const findCommunity = (world, cid) => (cid === KE.id ? KE : world.communities.find(c => c.id === cid) || null);
const isOwner = (comm, user) => !!user && !!comm?.owner && normaliseEmail(user.email) === comm.owner;
const isMember = (world, cid, uid) => cid === KE.id || !!world.members.get(cid)?.has(uid);
const myCommunities = (world, me) => [KE, ...world.communities
  .filter(c => me && isMember(world, c.id, me.id)).sort((a, b) => a.name.localeCompare(b.name))];
// The same world, narrowed to one community's calls and members (so scores never mix).
const inCommunity = (world, cid) => ({
  ...world,
  calls: world.calls.filter(c => communityIdOf(c) === cid),
  users: cid === KE.id ? world.users : world.users.filter(u => world.members.get(cid)?.has(u.id))
});

// ---------- Reading everything (small pilot: tens of people, a handful of calls) ----------
// Kept for a few seconds so 20 phones refreshing at once don't each re-read the whole store.
let cached = null;
const CACHE_MS = 3000;
const forget = () => { cached = null; };

async function keys(st, prefix) {
  const { blobs } = await st.list({ prefix });
  return blobs.map(b => b.key);
}

async function loadWorld(st) {
  if (cached && Date.now() - cached.at < CACHE_MS) return cached.world;
  const [callKeys, userKeys, fxKeys, commentKeys, communityKeys, memberKeys] = await Promise.all([
    keys(st, 'call/'), keys(st, 'user/'), keys(st, 'fx/'), keys(st, 'comment/'), keys(st, 'community/'), keys(st, 'member/')
  ]);
  const members = new Map();
  for (const k of memberKeys) {
    const [, cid, uid] = k.split('/');
    if (!members.has(cid)) members.set(cid, new Set());
    members.get(cid).add(uid);
  }
  const commentCounts = new Map();
  for (const k of commentKeys) {
    const callId = k.split('/')[1];
    commentCounts.set(callId, (commentCounts.get(callId) || 0) + 1);
  }
  const [calls, users, communities] = await Promise.all([
    Promise.all(callKeys.map(k => st.get(k, { type: 'json' }))),
    Promise.all(userKeys.map(k => st.get(k, { type: 'json' }))),
    Promise.all(communityKeys.map(k => st.get(k, { type: 'json' })))
  ]);
  // One answer per person per call: if two ever slip through at the same instant, the first one counts.
  const first = new Map();
  for (const k of fxKeys) {
    const [, callId, uid, pick, conf, at] = k.split('/');
    const f = { callId, uid, pick: toPick(pick), conf, at: Number(at) };
    if (!CONF[f.conf] || f.pick === null) continue;
    const prev = first.get(`${callId}/${uid}`);
    if (!prev || f.at < prev.at) first.set(`${callId}/${uid}`, f);
  }
  const forecasts = [...first.values()];
  const reward = await st.get('config/reward', { type: 'json' });
  const world = { calls: calls.filter(Boolean), users: users.filter(Boolean), forecasts, commentCounts, reward, communities: communities.filter(Boolean), members };
  // A community's admin is always a member of it, no invite needed.
  for (const c of world.communities) {
    const owner = c.owner && world.users.find(u => normaliseEmail(u.email) === c.owner);
    if (!owner) continue;
    if (!members.has(c.id)) members.set(c.id, new Set());
    members.get(c.id).add(owner.id);
  }
  cached = { at: Date.now(), world };
  return world;
}

// ---------- Rules ----------
function statusOf(c, now = Date.now()) {
  if (c.void) return 'void';
  if (resultOf(c) !== null) return 'settled';
  return now >= Date.parse(c.closesAt) ? 'closed' : 'open';
}

// An answer counts only if it was made before the call closed.
const inTime = (f, c) => f.at <= Date.parse(c.closesAt);

function pointsFor(f, c) {
  if (!c || c.void || resultOf(c) === null || !inTime(f, c)) return null;
  const cf = CONF[f.conf];
  return f.pick === resultOf(c) ? cf.win : -cf.lose;
}

function scoreboard(world) {
  const callById = new Map(world.calls.map(c => [c.id, c]));
  const score = new Map(world.users.map(u => [u.id, 0]));
  for (const f of world.forecasts) {
    const p = pointsFor(f, callById.get(f.callId));
    if (p !== null && score.has(f.uid)) score.set(f.uid, score.get(f.uid) + p);
  }
  const rows = world.users
    .map(u => ({ id: u.id, pid: u.pid || u.id, name: u.name, score: score.get(u.id) || 0, joined: u.createdAt }))
    .sort((a, b) => b.score - a.score || a.name.localeCompare(b.name));
  // Tied scores share a place: 30, 30, 20 → 1st, 1st, 3rd.
  rows.forEach((r, i) => { r.rank = i && r.score === rows[i - 1].score ? rows[i - 1].rank : i + 1; });
  return rows;
}

// Live calls first, then closed ones waiting for a result, then settled (newest result first).
// Within live and closed, the admin's chosen order: new calls go to the bottom unless moved.
const position = c => (Number.isFinite(c.order) ? c.order : Date.parse(c.createdAt));

function callOrder(a, b) {
  const rank = { open: 0, closed: 1, settled: 2 };
  const sa = statusOf(a), sb = statusOf(b);
  if (sa !== sb) return rank[sa] - rank[sb];
  if (sa === 'settled') return (b.settledAt || '').localeCompare(a.settledAt || '');
  return position(a) - position(b) || a.id.localeCompare(b.id);
}

// Pick up to n evenly spaced values (always the first and last), so the trend line
// shows the shape without revealing each individual call.
const sample = (arr, n) => arr.length <= n ? arr : Array.from({ length: n }, (_, k) => arr[Math.round(k * (arr.length - 1) / (n - 1))]);

// How many people picked each answer, plus the crowd forecast: the average of everyone's
// calls as probabilities. "Certain: Yes" counts as 90% Yes, "Hunch: No" as 40% Yes, and so on,
// so surer calls move it more. Every call also starts with two invisible "don't know" (50%)
// votes, so a handful of early calls nudge the forecast instead of swinging it to an extreme.
// `forecast` is the % chance of the first answer; `trend` is how it moved from the 50% start
// (from the first call, smoothed to at most 12 points). Phones only get it once they've called.
const PRIOR_VOTES = 2;

function tally(world, call) {
  const counts = optionsOf(call).map(() => 0);
  const fs = world.forecasts
    .filter(f => f.callId === call.id && inTime(f, call) && f.pick < counts.length)
    .sort((a, b) => a.at - b.at);
  const path = [50];
  let sum = PRIOR_VOTES * 0.5;
  fs.forEach((f, i) => {
    counts[f.pick]++;
    const p = CONF[f.conf].p;
    sum += f.pick === 0 ? p : 1 - p;
    path.push(Math.round(sum / (i + 1 + PRIOR_VOTES) * 100));
  });
  return {
    counts,
    total: fs.length,
    forecast: fs.length ? path[path.length - 1] : null,
    trend: fs.length ? sample(path, 12) : []
  };
}

const callSummary = (world, c) => ({
  id: c.id, q: c.q, options: optionsOf(c), closesAt: c.closesAt, status: statusOf(c), result: resultOf(c),
  comments: world.commentCounts.get(c.id) || 0,
  by: c.authorName || null, closedBy: c.closedBy || null,     // member-run communities: who asked, who closed
  ...tally(world, c)
});

// What one person sees. Other people's individual answers and emails are never sent.
// While a call is open, its crowd forecast (and the answer counts) are only revealed to people
// who have already made that call, so nobody just copies the crowd.
function publicState(all, me, cid = KE.id) {
  // Asking for a community you're not in (or that's gone) quietly gives you King's E-Lab.
  const wanted = me && findCommunity(all, cid);
  const comm = wanted && isMember(all, wanted.id, me.id) ? wanted : KE;
  const world = inCommunity(all, comm.id);
  const board = scoreboard(world);
  const now = Date.now();
  const calls = world.calls.filter(c => !c.void).sort(callOrder).map(c => {
    const mineF = me && world.forecasts.find(f => f.callId === c.id && f.uid === me.id && inTime(f, c));
    const summary = callSummary(world, c);
    if (summary.status === 'open' && !mineF) Object.assign(summary, { counts: null, forecast: null, trend: [], hidden: true });
    const yours = !!me && !!c.author && c.author === me.id;
    return {
      ...summary,
      yours,
      canUndo: yours && summary.status === 'settled' && now - Date.parse(c.settledAt) < UNDO_MS,
      mine: mineF ? { pick: mineF.pick, conf: mineF.conf, pts: pointsFor(mineF, c) } : null
    };
  });
  const mine = me && board.find(r => r.id === me.id);
  const admin = isOwner(comm, me);
  if (admin) calls.forEach(c => { c.canManage = true; });
  return {
    me: me ? { id: me.pid || me.id, name: me.name, email: me.email } : null,
    community: pub(comm),
    communities: myCommunities(all, me).map(pub),
    admin,                                                  // you run this community
    invite: admin ? comm.invite : null,                     // only its admin shares the invite link
    calls,
    board: board.map(({ pid, name, score, rank }) => ({ id: pid, name, score, rank })),
    score: mine?.score || 0,
    rank: mine?.rank || 0,
    people: board.length,
    settled: calls.filter(c => c.status === 'settled').length,
    reward: comm.id === KE.id ? all.reward || null : null
  };
}

// ---------- Who's asking ----------
function tokenFrom(req) {
  const h = req.headers.get('authorization') || '';
  return h.startsWith('Bearer ') ? h.slice(7).trim() : '';
}

async function currentUser(st, req) {
  const token = tokenFrom(req);
  if (!token) return null;
  const sess = await st.get(`session/${sha(token)}`, { type: 'json' });
  if (!sess) return null;
  return st.get(`user/${sess.uid}`, { type: 'json' });
}

const adminKey = () => (process.env.ADMIN_KEY || '').trim();

function isAdmin(req) {
  const key = adminKey();
  const given = (req.headers.get('x-admin-key') || '').trim();
  return timingSafeEqual(Buffer.from(sha(key)), Buffer.from(sha(given)));
}

// ---------- People ----------
async function join(st, body) {
  const raw = clean(body.name, 30);
  const name = raw.charAt(0).toUpperCase() + raw.slice(1);   // "jacopo" → "Jacopo"
  const email = normaliseEmail(body.email);
  if (!name) return fail(400, 'Add your first name so people know who you are.');
  if (!isCamEmail(email)) return fail(400, CAM_ONLY_MSG);

  // Pitch shortcut: typing the same email again gets you back into the same account,
  // so switching browser or phone doesn't lose your points. (No email check yet.)
  const emailKey = `email/${sha(email)}`;
  let user = null;
  const existing = await st.get(emailKey, { type: 'json' });
  if (existing) user = await st.get(`user/${existing.uid}`, { type: 'json' });
  if (!user) {
    // Every join with this email arrives at the same uid, so a double-tapped Join
    // (or two phones at once) can never create two accounts.
    const uid = existing?.uid || sha(`bnoc-user:${email}`).slice(0, 24);
    if (!existing) await st.setJSON(emailKey, { uid });
    user = await st.get(`user/${uid}`, { type: 'json' })
      || { id: uid, pid: newId(), name, email, createdAt: new Date().toISOString(), sessions: [] };
  }

  const token = randomBytes(24).toString('base64url');
  const tokenHash = sha(token);
  await st.setJSON(`session/${tokenHash}`, { uid: user.id });
  user.sessions = [...(user.sessions || []), tokenHash];
  await st.setJSON(`user/${user.id}`, user);
  forget();
  return json(200, { token, returning: !!existing, state: publicState(await loadWorld(st), user) });
}

// Used by "Delete my account" and by the admin's "Remove" on the People list.
async function deleteUser(st, me) {
  const mine = (await keys(st, 'fx/')).filter(k => k.split('/')[2] === me.id);
  const suggestions = await Promise.all((await keys(st, 'suggestion/')).map(k => st.get(k, { type: 'json' })));
  const comments = (await keys(st, 'comment/')).filter(k => k.split('/')[2].split('.')[1] === me.id);
  const memberships = (await keys(st, 'member/')).filter(k => k.split('/')[2] === me.id);
  const toDelete = [
    ...memberships,
    `user/${me.id}`,
    `email/${sha(me.email)}`,
    ...(me.sessions || []).map(h => `session/${h}`),
    ...mine,
    ...mine.map(k => `f/${k.split('/')[1]}/${me.id}`),
    ...suggestions.filter(s => s && s.uid === me.id).map(s => `suggestion/${s.id}`),
    ...comments
  ];
  await Promise.all(toDelete.map(k => st.delete(k)));
  forget();
}

// ---------- Calls ----------
async function forecast(st, me, body) {
  const { callId, conf } = body;
  const pick = toPick(body.pick ?? body.side);
  if (!CONF[conf]) return fail(400, 'Pick how sure you are.');
  const call = typeof callId === 'string' && await st.get(`call/${callId}`, { type: 'json' });
  if (!call || call.void) return fail(404, "That call isn't available any more.");
  if (pick === null || pick >= optionsOf(call).length) return fail(400, 'Pick one of the answers.');
  if (statusOf(call) !== 'open') return fail(409, 'This call has closed, so answers are locked.');
  if (!isMember(await loadWorld(st), communityIdOf(call), me.id)) return fail(400, "This call is in a community you haven't joined.");

  const at = Date.now();
  const first = await st.setJSON(`f/${call.id}/${me.id}`, { pick, conf, at }, { onlyIfNew: true });
  if (!first.modified) return fail(409, "You've already made this call. Calls are locked once made.");
  try {
    await st.set(`fx/${call.id}/${me.id}/${pick}/${conf}/${at}`, '1');
  } catch (err) {
    await st.delete(`f/${call.id}/${me.id}`).catch(() => {});
    throw err;
  }
  forget();
  return json(200, { state: publicState(await loadWorld(st), me, communityIdOf(call)) });
}

// ---------- Member-run communities: join by invite, post your own calls, close them yourself ----------
async function joinCommunity(st, me, body) {
  const token = clean(body.invite, 60);
  const comm = token && (await loadWorld(st)).communities.find(c => c.invite === token);
  if (!comm) return fail(410, "That invite link doesn't work any more. Ask for a new one.");
  await st.set(`member/${comm.id}/${me.id}`, '1');
  forget();
  return json(200, { community: pub(comm), state: publicState(await loadWorld(st), me, comm.id) });
}

// The community's admin can swap the invite link for a new one (the old one stops working).
async function newInvite(st, me, cid) {
  const comm = await st.get(`community/${cid}`, { type: 'json' });
  if (!comm || !isOwner(comm, me)) return fail(400, "Only the community's admin can change the invite link.");
  comm.invite = newId() + newId();
  await st.setJSON(`community/${cid}`, comm);
  forget();
  return json(200, { state: publicState(await loadWorld(st), me, cid) });
}

const MAX_OPEN_OWN = 10;          // calls one person can have waiting for a result
const POST_GAP_MS = 10000;        // one new call every few seconds per person
const MAX_AHEAD_MS = 60 * 864e5;  // a call can stay open for at most 60 days

async function postCall(st, me, body) {
  const world = await loadWorld(st);
  const comm = findCommunity(world, String(body.c || ''));
  if (!comm || comm.mode !== 'open' || !isMember(world, comm.id, me.id)) return fail(400, 'You can only post calls in a member-run community you belong to.');
  let q = clean(body.q, 140);
  const closesAt = parseClose(body.closesAt);
  const { options, error } = parseOptions(body.options);
  if (q.length < 10) return fail(400, 'Write a full question (at least 10 characters).');
  if (error) return fail(400, error);
  // No banned-topic filter in member-run communities for now: the beta runs inside the team.
  if (!closesAt || Date.parse(closesAt) <= Date.now()) return fail(400, 'Pick a closing time in the future.');
  if (Date.parse(closesAt) > Date.now() + MAX_AHEAD_MS) return fail(400, 'A call can stay open for 60 days at most.');
  const own = world.calls.filter(c => communityIdOf(c) === comm.id && c.author === me.id && !c.void);
  if (own.filter(c => resultOf(c) === null).length >= MAX_OPEN_OWN) return fail(429, `You have ${MAX_OPEN_OWN} calls waiting for a result. Close some first.`);
  if (own.some(c => Date.now() - Date.parse(c.createdAt) < POST_GAP_MS)) return fail(429, 'Slow down a little: wait a few seconds between calls.');
  if (!q.endsWith('?')) q += '?';
  const call = {
    id: newId(), q, options, closesAt, createdAt: new Date().toISOString(), result: null, settledAt: null, void: false,
    community: comm.id, author: me.id, authorName: me.name, closedBy: null
  };
  await st.setJSON(`call/${call.id}`, call);
  forget();
  return json(200, { state: publicState(await loadWorld(st), me, comm.id) });
}

// The person who asked gives the result (or cancels the call). Closing an open call locks answers at that moment.
// The community's admin can do the same on anyone's call, and can also change or undo a result at any time.
async function ownCall(st, me, id) {
  const call = await st.get(`call/${id}`, { type: 'json' });
  if (!call || call.void) return { error: fail(410, "That call isn't available any more.") };
  const admin = isOwner(findCommunity(await loadWorld(st), communityIdOf(call)), me);
  if (!admin && (!call.author || call.author !== me.id)) return { error: fail(400, 'Only the person who asked can close this call.') };
  return { call, admin };
}

async function closeOwnCall(st, me, id, body) {
  const { call, admin, error } = await ownCall(st, me, id);
  if (error) return error;
  if (resultOf(call) !== null && !admin) return fail(409, 'This call already has a result.');
  if (body.result === 'cancel') {
    call.void = true;
  } else {
    const result = toPick(body.result);
    if (result === null || result >= optionsOf(call).length) return fail(400, 'Pick the answer that happened.');
    const now = new Date().toISOString();
    if (statusOf(call) === 'open') call.closesAt = now;
    call.result = result;
    call.settledAt = now;
    call.closedBy = me.name;
  }
  await st.setJSON(`call/${id}`, call);
  forget();
  return json(200, { state: publicState(await loadWorld(st), me, communityIdOf(call)) });
}

async function undoOwnClose(st, me, id) {
  const { call, admin, error } = await ownCall(st, me, id);
  if (error) return error;
  if (resultOf(call) === null) return fail(409, "This call doesn't have a result to undo.");
  if (!admin && Date.now() - Date.parse(call.settledAt) > UNDO_MS) return fail(409, 'A result can only be undone in the first 15 minutes.');
  call.result = null;
  call.settledAt = null;
  call.closedBy = null;
  await st.setJSON(`call/${id}`, call);
  forget();
  return json(200, { state: publicState(await loadWorld(st), me, communityIdOf(call)) });
}

async function suggest(st, me, body) {
  let q = clean(body.q, 140);
  const { options, error } = parseOptions(body.options);
  if (q.length < 10) return fail(400, 'Write a full question, like "Will the E-Lab social run past 10pm?"');
  if (error) return fail(400, error);
  if (isBannedTopic(q) || (options || []).some(isBannedTopic)) return fail(422, BANNED_MSG);
  if (!q.endsWith('?')) q += '?';
  const s = { id: newId(), q, options, uid: me.id, name: me.name, at: new Date().toISOString() };
  await st.setJSON(`suggestion/${s.id}`, s);
  return json(200, { ok: true });
}

// ---------- Comments ----------
const COMMENT_MAX = 280;
const COMMENT_GAP_MS = 5000;   // one comment every few seconds per person, to stop spam
const commentKey = (callId, at, uid, cid) => `comment/${callId}/${String(at).padStart(13, '0')}.${uid}.${cid}`;

// What phones see: never the internal uid, only the public pid (for the avatar colour).
async function listComments(st, callId, viewer) {
  const ks = await keys(st, `comment/${callId}/`);
  const items = (await Promise.all(ks.map(k => st.get(k, { type: 'json' })))).filter(Boolean);
  return items.sort((a, b) => a.at - b.at).map(c => ({
    id: `${c.at}.${c.cid}`, pid: c.pid, name: c.name, text: c.text, at: new Date(c.at).toISOString(),
    mine: !!viewer && c.uid === viewer.id
  }));
}

async function findCommentKey(st, callId, commentId) {
  const [at, cid] = String(commentId).split('.');
  if (!/^\d+$/.test(at || '') || !cid) return null;
  const ks = await keys(st, `comment/${callId}/${String(at).padStart(13, '0')}.`);
  return ks.find(k => k.endsWith(`.${cid}`)) || null;
}

async function addComment(st, me, callId, body) {
  const text = clean(body.text, COMMENT_MAX);
  if (!text) return fail(400, 'Write something first.');
  const call = await st.get(`call/${callId}`, { type: 'json' });
  if (!call || call.void) return fail(404, "That call isn't available any more.");
  if (!isMember(await loadWorld(st), communityIdOf(call), me.id)) return fail(400, "This call is in a community you haven't joined.");
  // The banned-topic filter only applies in King's E-Lab (member-run communities are team-only for now).
  if (communityIdOf(call) === KE.id && isBannedTopic(text)) return fail(422, "This comment can't be posted. BNOC doesn't allow comments about relationships, health, appearance or grades.");
  const now = Date.now();
  const recent = (await keys(st, `comment/${callId}/`)).some(k => {
    const [at, uid] = k.split('/')[2].split('.');
    return uid === me.id && now - Number(at) < COMMENT_GAP_MS;
  });
  if (recent) return fail(429, 'Slow down a little: wait a few seconds between comments.');
  const cid = newId();
  await st.setJSON(commentKey(callId, now, me.id, cid), { cid, uid: me.id, pid: me.pid || me.id, name: me.name, text, at: now });
  forget();
  return json(200, { comments: await listComments(st, callId, me) });
}

async function removeComment(st, callId, commentId, me, admin) {
  const key = await findCommentKey(st, callId, commentId);
  if (!key) return fail(404, 'That comment has already gone.');
  if (!admin && key.split('/')[2].split('.')[1] !== me?.id) return fail(400, 'You can only delete your own comments.');
  await st.delete(key);
  forget();
  return json(200, { comments: await listComments(st, callId, me) });
}

// ---------- Reward (the prize shown on the Rewards page) ----------
async function saveReward(st, body) {
  const reward = {
    prize: clean(body.prize, 60),
    sponsor: clean(body.sponsor, 40),
    who: clean(body.who, 80),
    when: clean(body.when, 80),
    details: clean(body.details, 300)
  };
  if (!reward.prize) {
    await st.delete('config/reward');   // an empty prize means "no reward right now"
  } else {
    await st.setJSON('config/reward', reward);
  }
  return adminState(st);
}

// ---------- Admin ----------
function parseClose(v) {
  const t = Date.parse(v);
  if (!Number.isFinite(t)) return null;
  return new Date(t).toISOString();
}

async function adminState(st) {
  forget();
  const world = await loadWorld(st);
  const board = scoreboard(inCommunity(world, KE.id));
  const suggestions = (await Promise.all((await keys(st, 'suggestion/')).map(k => st.get(k, { type: 'json' }))))
    .filter(Boolean).sort((a, b) => b.at.localeCompare(a.at));
  const nameOf = cid => findCommunity(world, cid)?.name || 'A removed community';
  return json(200, {
    calls: world.calls.filter(c => !c.void).sort(callOrder).map(c => ({
      ...callSummary(world, c), community: communityIdOf(c), communityName: nameOf(communityIdOf(c))
    })),
    communities: world.communities.sort((a, b) => a.name.localeCompare(b.name)).map(c => ({
      ...pub(c), invite: c.invite, owner: c.owner || '',
      members: world.members.get(c.id)?.size || 0,
      calls: world.calls.filter(x => !x.void && communityIdOf(x) === c.id).length
    })),
    suggestions,
    reward: world.reward || null,
    people: board.map(({ id, name, score, rank }) => ({ id, name, score, rank, email: world.users.find(u => u.id === id)?.email }))
  });
}

// No answers given, or plain Yes/No = a Yes/No call. Otherwise exactly two different labels, up to 20 characters.
function parseOptions(raw) {
  if (raw === undefined || raw === null) return { options: null };
  if (!Array.isArray(raw) || raw.length !== 2) return { error: 'Every call needs exactly two answers.' };
  const options = raw.map(o => clean(o, 20));
  if (!options[0] || !options[1]) return { error: 'Fill in both answers.' };
  if (options[0].toLowerCase() === options[1].toLowerCase()) return { error: 'The two answers need to be different.' };
  if (options[0].toLowerCase() === 'yes' && options[1].toLowerCase() === 'no') return { options: null };
  return { options };
}

async function createCall(st, body) {
  let q = clean(body.q, 140);
  const closesAt = parseClose(body.closesAt);
  const { options, error } = parseOptions(body.options);
  if (q.length < 10) return fail(400, 'Write a full question (at least 10 characters).');
  if (error) return fail(400, error);
  if (!closesAt) return fail(400, 'Pick when the call closes.');
  if (Date.parse(closesAt) <= Date.now()) return fail(400, 'The closing time needs to be in the future.');
  if (!q.endsWith('?')) q += '?';
  const call = { id: newId(), q, options, closesAt, createdAt: new Date().toISOString(), result: null, settledAt: null, void: false };
  await st.setJSON(`call/${call.id}`, call);
  if (body.fromSuggestion) await st.delete(`suggestion/${String(body.fromSuggestion)}`);
  return adminState(st);
}

// Member-run communities are set up here; people then get in with the invite link.
async function createCommunity(st, body) {
  const name = clean(body.name, 30);
  const owner = normaliseEmail(body.owner || '');
  if (name.length < 2) return fail(400, 'Give the community a name.');
  if (!isCamEmail(owner)) return fail(400, "Add the @cam.ac.uk email of the person who'll run it.");
  const world = await loadWorld(st);
  if ([KE, ...world.communities].some(c => c.name.toLowerCase() === name.toLowerCase())) return fail(409, 'There is already a community with that name.');
  const comm = { id: newId(), name, short: shortOf(name), mode: 'open', invite: newId() + newId(), owner, createdAt: new Date().toISOString() };
  await st.setJSON(`community/${comm.id}`, comm);
  forget();
  return adminState(st);
}

async function updateCommunity(st, id, body) {
  const comm = await st.get(`community/${id}`, { type: 'json' });
  if (!comm) return fail(404, 'Community not found.');
  if (body.action === 'new-link') {
    comm.invite = newId() + newId();     // the old link stops working; people already in stay in
    await st.setJSON(`community/${id}`, comm);
  } else if (body.action === 'remove') {
    const world = await loadWorld(st);
    const gone = world.calls.filter(c => communityIdOf(c) === id);
    await Promise.all([
      st.delete(`community/${id}`),
      ...(await keys(st, `member/${id}/`)).map(k => st.delete(k)),
      ...gone.map(c => st.setJSON(`call/${c.id}`, { ...c, void: true }))
    ]);
  } else {
    return fail(400, 'Unknown action.');
  }
  forget();
  return adminState(st);
}

// Swap a call with its neighbour in the list (same group: live or closed).
async function moveCall(st, call, direction) {
  forget();
  const world = await loadWorld(st);
  const group = world.calls.filter(c => !c.void && communityIdOf(c) === communityIdOf(call) && statusOf(c) === statusOf(call)).sort(callOrder);
  const i = group.findIndex(c => c.id === call.id);
  const j = direction === 'up' ? i - 1 : i + 1;
  if (i < 0 || j < 0 || j >= group.length) return adminState(st);
  // Give every call in the group an explicit, evenly spaced position, then swap the two.
  group.forEach((c, k) => { c.order = k; });
  [group[i].order, group[j].order] = [group[j].order, group[i].order];
  await Promise.all(group.map(c => st.setJSON(`call/${c.id}`, c)));
  return adminState(st);
}

async function updateCall(st, id, body) {
  const call = await st.get(`call/${id}`, { type: 'json' });
  if (!call) return fail(404, 'Call not found.');
  const status = statusOf(call);
  if (body.action === 'move') return moveCall(st, call, body.direction);
  switch (body.action) {
    case 'close':
      if (status !== 'open') return fail(409, 'This call is already closed.');
      call.closesAt = new Date().toISOString();
      break;
    case 'reopen': {
      const closesAt = parseClose(body.closesAt);
      if (status === 'settled') return fail(409, 'Undo the result first.');
      if (!closesAt || Date.parse(closesAt) <= Date.now()) return fail(400, 'Pick a closing time in the future.');
      call.closesAt = closesAt;
      break;
    }
    case 'settle': {
      const result = toPick(body.result);
      if (result === null || result >= optionsOf(call).length) return fail(400, 'Pick the answer that happened.');
      if (status === 'open') return fail(409, 'Close the call before settling it, so nobody can answer after the result is known.');
      call.result = result;
      call.settledAt = new Date().toISOString();
      break;
    }
    case 'unsettle':
      call.result = null;
      call.settledAt = null;
      break;
    case 'remove':
      call.void = true;
      break;
    default:
      return fail(400, 'Unknown action.');
  }
  await st.setJSON(`call/${id}`, call);
  return adminState(st);
}

// ---------- Router ----------
export default async (req) => {
  const st = getStore({ name: 'bnoc', consistency: 'strong' });
  const parts = new URL(req.url).pathname.replace(/^\/api\/?/, '').split('/').filter(Boolean);
  const route = `${req.method} ${parts[0] || ''}${parts[1] ? '/' + parts[1] : ''}`;
  const body = (req.method === 'POST' ? await req.json().catch(() => null) : null) || {};

  try {
    if (parts[0] === 'admin') {
      if (!adminKey()) return fail(503, 'Admin is switched off: set ADMIN_KEY in Netlify → Environment variables.');
      if (adminKey().length < 8) return fail(503, 'The ADMIN_KEY in Netlify is too short: use at least 8 characters.');
      if (!isAdmin(req)) return fail(401, "That admin key isn't right.");
      if (route === 'GET admin') return adminState(st);
      if (route === 'POST admin/calls' && !parts[2]) return createCall(st, body);
      if (route === 'POST admin/calls' && parts[2]) return updateCall(st, parts[2], body);
      if (route === 'POST admin/people' && parts[2]) {
        const user = await st.get(`user/${parts[2]}`, { type: 'json' });
        if (!user) return fail(404, 'That person has already been removed.');
        await deleteUser(st, user);
        return adminState(st);
      }
      if (route === 'POST admin/reward') return saveReward(st, body);
      if (route === 'POST admin/communities' && !parts[2]) return createCommunity(st, body);
      if (route === 'POST admin/communities' && parts[2]) return updateCommunity(st, parts[2], body);
      if (route === 'GET admin/comments' && parts[2]) return json(200, { comments: await listComments(st, parts[2], null) });
      if (route === 'POST admin/comments' && parts[2] && parts[3]) return removeComment(st, parts[2], parts[3], null, true);
      if (route === 'POST admin/suggestions' && parts[2]) {
        await st.delete(`suggestion/${parts[2]}`);
        return adminState(st);
      }
      return fail(404, 'Not found.');
    }

    if (route === 'POST join') return join(st, body);

    const me = await currentUser(st, req);
    if (route === 'GET state') {
      // Readable from other pages too (the pitch slides show the live player and call counts).
      // It carries no login cookie, so another site only ever sees what a signed-out visitor sees.
      const res = json(200, publicState(await loadWorld(st), me, new URL(req.url).searchParams.get('c') || KE.id));
      res.headers.set('access-control-allow-origin', '*');
      return res;
    }
    if (!me) return fail(401, 'Please join first.');
    if (route === 'POST forecast') return forecast(st, me, body);
    if (route === 'POST suggest') return suggest(st, me, body);
    if (route === 'POST delete-me') { await deleteUser(st, me); return json(200, { ok: true }); }
    if (route === 'POST communities/join') return joinCommunity(st, me, body);
    if (req.method === 'POST' && parts[0] === 'communities' && parts[2] === 'new-link') return newInvite(st, me, parts[1]);
    // Member-run communities: /api/calls posts one, /api/calls/{id}/close and /undo are for whoever asked it.
    if (req.method === 'POST' && parts[0] === 'calls' && !parts[1]) return postCall(st, me, body);
    if (req.method === 'POST' && parts[0] === 'calls' && parts[2] === 'close') return closeOwnCall(st, me, parts[1], body);
    if (req.method === 'POST' && parts[0] === 'calls' && parts[2] === 'undo') return undoOwnClose(st, me, parts[1]);
    // Comments are for members only: /api/comments/{callId}, and /api/comments/{callId}/{commentId} to delete your own.
    if (parts[0] === 'comments' && parts[1]) {
      const [, callId, commentId] = parts;
      const call = await st.get(`call/${callId}`, { type: 'json' });
      if (call && !isMember(await loadWorld(st), communityIdOf(call), me.id)) return fail(400, "This call is in a community you haven't joined.");
      if (req.method === 'GET' && !commentId) return json(200, { comments: await listComments(st, callId, me) });
      if (req.method === 'POST' && !commentId) return addComment(st, me, callId, body);
      if (req.method === 'POST' && commentId) return removeComment(st, callId, commentId, me, false);
    }
    return fail(404, 'Not found.');
  } catch (err) {
    console.error(err);
    return fail(500, 'Something went wrong on our side. Try again in a moment.');
  }
};
