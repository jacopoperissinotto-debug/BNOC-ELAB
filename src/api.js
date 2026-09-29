// Talking to the BNOC back end (netlify/functions/api.mjs).
// This phone's login token and the admin key are kept in the browser's storage.

const TOKEN_KEY = 'bnoc.token';
const ADMIN_KEY = 'bnoc.adminKey';

const read = k => { try { return localStorage.getItem(k) || ''; } catch { return ''; } };
const write = (k, v) => { try { v ? localStorage.setItem(k, v) : localStorage.removeItem(k); } catch { /* private mode */ } };

export const getToken = () => read(TOKEN_KEY);
export const setToken = t => write(TOKEN_KEY, t);
export const getAdminKey = () => read(ADMIN_KEY);
export const setAdminKey = k => write(ADMIN_KEY, k);

async function call(method, path, body, { admin = false } = {}) {
  const headers = { 'content-type': 'application/json' };
  const token = getToken();
  if (token) headers.authorization = `Bearer ${token}`;
  if (admin) headers['x-admin-key'] = getAdminKey();
  let res;
  try {
    res = await fetch(`/api/${path}`, { method, headers, body: body ? JSON.stringify(body) : undefined });
  } catch {
    return { error: "Can't reach BNOC. Check your connection and try again.", status: 0 };
  }
  const data = await res.json().catch(() => ({}));
  if (!res.ok) return { error: data.error || 'Something went wrong. Try again.', status: res.status };
  return { data, status: res.status };
}

export const api = {
  state: () => call('GET', 'state'),
  join: (name, email) => call('POST', 'join', { name, email }),
  forecast: (callId, side, conf) => call('POST', 'forecast', { callId, side, conf }),
  suggest: q => call('POST', 'suggest', { q }),
  deleteMe: () => call('POST', 'delete-me', {}),
  admin: {
    state: () => call('GET', 'admin', null, { admin: true }),
    createCall: (q, closesAt, fromSuggestion) => call('POST', 'admin/calls', { q, closesAt, fromSuggestion }, { admin: true }),
    updateCall: (id, action, extra = {}) => call('POST', `admin/calls/${id}`, { action, ...extra }, { admin: true }),
    rejectSuggestion: id => call('POST', `admin/suggestions/${id}`, {}, { admin: true })
  }
};
