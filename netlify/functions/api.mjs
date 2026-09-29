// BNOC pitch back end: one Netlify Function, data kept in Netlify Blobs (Netlify's built-in storage).
//
// Everything that matters for fairness happens here, not in the browser:
//   - answers are locked once made, and refused after a call closes
//   - scores are worked out here from answers + results, so nobody can edit their own score
//   - only someone with the ADMIN_KEY (a Netlify environment variable) can create, close or settle calls
//
// Stored keys:
//   user/{uid}                 { id, name, email, createdAt, sessions: [hash] }
//   email/{sha(email)}         { uid }                  one account per email
//   session/{sha(token)}       { uid }                  "this phone is logged in as…"
//   call/{id}                  { id, q, closesAt, createdAt, result, settledAt, void }
//   f/{callId}/{uid}           { side, conf, at }       the answer itself; written once, never overwritten
//   fx/{callId}/{uid}/{side}/{conf}/{at}               the same answer as a key, so one list() counts everything
//   suggestion/{id}            { id, q, uid, name, at }
import { getStore } from '@netlify/blobs';
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { CONF, isCamEmail, normaliseEmail, CAM_ONLY_MSG, isBannedTopic, BANNED_MSG } from '../../shared/rules.js';

export const config = { path: '/api/*' };

const sha = s => createHash('sha256').update(String(s)).digest('hex');
const newId = () => randomBytes(9).toString('base64url');
const clean = (s, max) => String(s ?? '').replace(/\s+/g, ' ').trim().slice(0, max);
const json = (status, body) => new Response(JSON.stringify(body), {
  status, headers: { 'content-type': 'application/json', 'cache-control': 'no-store' }
});
const fail = (status, error) => json(status, { error });

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
  const [callKeys, userKeys, fxKeys] = await Promise.all([keys(st, 'call/'), keys(st, 'user/'), keys(st, 'fx/')]);
  const [calls, users] = await Promise.all([
    Promise.all(callKeys.map(k => st.get(k, { type: 'json' }))),
    Promise.all(userKeys.map(k => st.get(k, { type: 'json' })))
  ]);
  const forecasts = fxKeys.map(k => {
    const [, callId, uid, side, conf, at] = k.split('/');
    return { callId, uid, side, conf, at: Number(at) };
  }).filter(f => CONF[f.conf] && (f.side === 'yes' || f.side === 'no'));
  const world = { calls: calls.filter(Boolean), users: users.filter(Boolean), forecasts };
  cached = { at: Date.now(), world };
  return world;
}

// ---------- Rules ----------
function statusOf(c, now = Date.now()) {
  if (c.void) return 'void';
  if (c.result) return 'settled';
  return now >= Date.parse(c.closesAt) ? 'closed' : 'open';
}

function pointsFor(f, c) {
  if (!c || c.void || !c.result) return null;
  const cf = CONF[f.conf];
  return f.side === c.result ? cf.win : -cf.lose;
}

function scoreboard(world) {
  const callById = new Map(world.calls.map(c => [c.id, c]));
  const score = new Map(world.users.map(u => [u.id, 0]));
  for (const f of world.forecasts) {
    const p = pointsFor(f, callById.get(f.callId));
    if (p !== null && score.has(f.uid)) score.set(f.uid, score.get(f.uid) + p);
  }
  return world.users
    .map(u => ({ id: u.id, name: u.name, score: score.get(u.id) || 0, joined: u.createdAt }))
    .sort((a, b) => b.score - a.score || a.joined.localeCompare(b.joined));
}

function callOrder(a, b) {
  const rank = { open: 0, closed: 1, settled: 2 };
  const sa = statusOf(a), sb = statusOf(b);
  if (sa !== sb) return rank[sa] - rank[sb];
  if (sa === 'settled') return (b.settledAt || '').localeCompare(a.settledAt || '');
  return Date.parse(a.closesAt) - Date.parse(b.closesAt);
}

function tally(world, callId) {
  const fs = world.forecasts.filter(f => f.callId === callId);
  const yes = fs.filter(f => f.side === 'yes').length;
  return { yes, no: fs.length - yes };
}

// What one person sees. Other people's individual answers and emails are never sent.
function publicState(world, me) {
  const board = scoreboard(world);
  const calls = world.calls.filter(c => !c.void).sort(callOrder).map(c => {
    const mineF = me && world.forecasts.find(f => f.callId === c.id && f.uid === me.id);
    return {
      id: c.id, q: c.q, closesAt: c.closesAt, status: statusOf(c), result: c.result || null,
      ...tally(world, c.id),
      mine: mineF ? { side: mineF.side, conf: mineF.conf, pts: pointsFor(mineF, c) } : null
    };
  });
  const rank = me ? board.findIndex(r => r.id === me.id) + 1 : 0;
  return {
    me: me ? { id: me.id, name: me.name, email: me.email } : null,
    calls,
    board: board.map(({ id, name, score }) => ({ id, name, score })),
    score: me ? (board.find(r => r.id === me.id)?.score || 0) : 0,
    rank,
    people: board.length
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

function isAdmin(req) {
  const key = process.env.ADMIN_KEY || '';
  if (key.length < 8) return false;
  const given = req.headers.get('x-admin-key') || '';
  return timingSafeEqual(Buffer.from(sha(key)), Buffer.from(sha(given)));
}

// ---------- People ----------
async function join(st, body) {
  const name = clean(body.name, 30);
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
    const uid = existing?.uid || newId();
    const claimed = existing ? { modified: true } : await st.setJSON(emailKey, { uid }, { onlyIfNew: true });
    if (!claimed.modified) {
      // Someone joined with this email a split second earlier: use that account.
      const winner = await st.get(emailKey, { type: 'json' });
      user = await st.get(`user/${winner.uid}`, { type: 'json' });
    }
    if (!user) {
      user = { id: uid, name, email, createdAt: new Date().toISOString(), sessions: [] };
    }
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
  const toDelete = [
    `user/${me.id}`,
    `email/${sha(me.email)}`,
    ...(me.sessions || []).map(h => `session/${h}`),
    ...mine,
    ...mine.map(k => `f/${k.split('/')[1]}/${me.id}`),
    ...suggestions.filter(s => s && s.uid === me.id).map(s => `suggestion/${s.id}`)
  ];
  await Promise.all(toDelete.map(k => st.delete(k)));
  forget();
}

// ---------- Calls ----------
async function forecast(st, me, body) {
  const { callId, side, conf } = body;
  if (side !== 'yes' && side !== 'no') return fail(400, 'Pick Yes or No.');
  if (!CONF[conf]) return fail(400, 'Pick how sure you are.');
  const call = typeof callId === 'string' && await st.get(`call/${callId}`, { type: 'json' });
  if (!call || call.void) return fail(404, "That call isn't available any more.");
  if (statusOf(call) !== 'open') return fail(409, 'This call has closed, so answers are locked.');

  const at = Date.now();
  const first = await st.setJSON(`f/${call.id}/${me.id}`, { side, conf, at }, { onlyIfNew: true });
  if (!first.modified) return fail(409, "You've already made this call. Calls are locked once made.");
  await st.set(`fx/${call.id}/${me.id}/${side}/${conf}/${at}`, '1');
  forget();
  return json(200, { state: publicState(await loadWorld(st), me) });
}

async function suggest(st, me, body) {
  let q = clean(body.q, 140);
  if (q.length < 10) return fail(400, 'Write a full question, like "Will the E-Lab social run past 10pm?"');
  if (isBannedTopic(q)) return fail(422, BANNED_MSG);
  if (!q.endsWith('?')) q += '?';
  const s = { id: newId(), q, uid: me.id, name: me.name, at: new Date().toISOString() };
  await st.setJSON(`suggestion/${s.id}`, s);
  return json(200, { ok: true });
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
  const board = scoreboard(world);
  const suggestions = (await Promise.all((await keys(st, 'suggestion/')).map(k => st.get(k, { type: 'json' }))))
    .filter(Boolean).sort((a, b) => b.at.localeCompare(a.at));
  return json(200, {
    calls: world.calls.filter(c => !c.void).sort(callOrder).map(c => ({
      id: c.id, q: c.q, closesAt: c.closesAt, status: statusOf(c), result: c.result || null, ...tally(world, c.id)
    })),
    suggestions,
    people: board.map(r => ({ ...r, email: world.users.find(u => u.id === r.id)?.email }))
  });
}

async function createCall(st, body) {
  let q = clean(body.q, 140);
  const closesAt = parseClose(body.closesAt);
  if (q.length < 10) return fail(400, 'Write a full question (at least 10 characters).');
  if (!closesAt) return fail(400, 'Pick when the call closes.');
  if (Date.parse(closesAt) <= Date.now()) return fail(400, 'The closing time needs to be in the future.');
  if (!q.endsWith('?')) q += '?';
  const call = { id: newId(), q, closesAt, createdAt: new Date().toISOString(), result: null, settledAt: null, void: false };
  await st.setJSON(`call/${call.id}`, call);
  if (body.fromSuggestion) await st.delete(`suggestion/${String(body.fromSuggestion)}`);
  return adminState(st);
}

async function updateCall(st, id, body) {
  const call = await st.get(`call/${id}`, { type: 'json' });
  if (!call) return fail(404, 'Call not found.');
  const status = statusOf(call);
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
    case 'settle':
      if (body.result !== 'yes' && body.result !== 'no') return fail(400, 'Pick Yes or No.');
      if (status === 'open') return fail(409, 'Close the call before settling it, so nobody can answer after the result is known.');
      call.result = body.result;
      call.settledAt = new Date().toISOString();
      break;
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
  const body = req.method === 'POST' ? await req.json().catch(() => ({})) : {};

  try {
    if (parts[0] === 'admin') {
      if (!process.env.ADMIN_KEY) return fail(503, 'Admin is switched off: set ADMIN_KEY in Netlify → Environment variables.');
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
      if (route === 'POST admin/suggestions' && parts[2]) {
        await st.delete(`suggestion/${parts[2]}`);
        return adminState(st);
      }
      return fail(404, 'Not found.');
    }

    if (route === 'POST join') return join(st, body);

    const me = await currentUser(st, req);
    if (route === 'GET state') return json(200, publicState(await loadWorld(st), me));
    if (!me) return fail(401, 'Please join first.');
    if (route === 'POST forecast') return forecast(st, me, body);
    if (route === 'POST suggest') return suggest(st, me, body);
    if (route === 'POST delete-me') { await deleteUser(st, me); return json(200, { ok: true }); }
    return fail(404, 'Not found.');
  } catch (err) {
    console.error(err);
    return fail(500, 'Something went wrong on our side. Try again in a moment.');
  }
};
