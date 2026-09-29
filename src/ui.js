// Small UI helpers carried over from the demo: selectors, escaping, toasts, sheets, avatars.

export const $ = s => document.querySelector(s);
export const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
export const ord = n => n + (n % 10 === 1 && n !== 11 ? 'st' : n % 10 === 2 && n !== 12 ? 'nd' : n % 10 === 3 && n !== 13 ? 'rd' : 'th');

const COLORS = ['#FF6B4A', '#2D1B3D', '#2E8E74', '#8A4FBF', '#D9482A', '#4B6CB7', '#B5487A'];
// Same person, same colour, everywhere: pick a colour from their id.
export const colorOf = id => {
  let h = 0;
  for (const ch of String(id)) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
  return COLORS[h % COLORS.length];
};
export const initials = n => (String(n || '?').trim().slice(0, 1) || '?').toUpperCase();
export const avatar = (id, name, extra = '') =>
  `<span class="avatar ${extra}" style="background:${colorOf(id)}" aria-hidden="true">${esc(initials(name))}</span>`;

let toastTimer;
export function toast(msg) {
  $('#toast-text').textContent = msg;
  const t = $('#toast');
  t.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => t.classList.remove('show'), 2800);
}

export function openSheet(html) {
  const sh = $('#sheet');
  sh.innerHTML = `<div class="grab" aria-hidden="true"></div>${html}`;
  $('#scrim').classList.add('open');
  sh.classList.add('open');
  const f = sh.querySelector('textarea, input, button:not([data-act="close"])');
  if (f) setTimeout(() => f.focus(), 250);
}
export function closeSheet() {
  $('#scrim').classList.remove('open');
  $('#sheet').classList.remove('open');
}

export function showError(el, msg) {
  el.textContent = msg;
  el.classList.add('show');
}
export function clearError(el) {
  el.textContent = '';
  el.classList.remove('show');
}
