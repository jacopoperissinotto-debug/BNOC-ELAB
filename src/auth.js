// Getting in, two ways (pilot):
//  - Quick join: this device gets its own account; the person types their name and @cam.ac.uk email.
//  - Email code (admins): a login link and 6-digit code are emailed, no passwords.
// The @cam.ac.uk checks here are just for friendly messages. The database enforces them too
// (see supabase/migrations), so they can't be bypassed by skipping this code.
import { supabase } from './supabase.js';

export const CAM_ONLY_MSG = 'BNOC is only open to Cambridge email addresses ending in @cam.ac.uk.';

export function normaliseEmail(raw) {
  return String(raw || '').trim().toLowerCase();
}

export function isCamEmail(email) {
  return /^[^@\s]+@cam\.ac\.uk$/.test(normaliseEmail(email));
}

function friendly(error) {
  const msg = (error?.message || '').toLowerCase();
  if (error?.status === 429 || msg.includes('rate limit') || msg.includes('security purposes')) {
    return 'Too many people joining from this network just now. Wait a minute, then try again.';
  }
  if (msg.includes('anonymous sign-ins are disabled')) {
    return "Quick join isn't switched on yet. Ask a BNOC admin.";
  }
  if (msg.includes('not authorized')) {
    return 'Email login is only for BNOC admins during the pilot. Use Join instead.';
  }
  if (msg.includes('database error') || msg.includes('cam.ac.uk')) return CAM_ONLY_MSG;
  if (msg.includes('expired') || msg.includes('invalid')) {
    return "That code didn't work. Check it against the latest email, or send a new one.";
  }
  return 'Something went wrong. Check your connection and try again.';
}

// Quick join, or naming yourself after a first email-code login (then email is left out).
export async function joinBnoc(name, rawEmail) {
  const { data: { session } } = await supabase.auth.getSession();
  if (!session) {
    const { error } = await supabase.auth.signInAnonymously();
    if (error) return { error: friendly(error) };
  }
  const { error } = await supabase.rpc('join_bnoc', {
    p_display_name: name,
    p_email: rawEmail ? normaliseEmail(rawEmail) : null
  });
  if (!error) return { error: null };
  // Messages raised by join_bnoc() are already written for people; anything else gets a generic one.
  return { error: ['22023', '23505', '28000'].includes(error.code) ? error.message : friendly(error) };
}

export async function sendLoginEmail(rawEmail) {
  const email = normaliseEmail(rawEmail);
  if (!isCamEmail(email)) return { error: CAM_ONLY_MSG };
  const { error } = await supabase.auth.signInWithOtp({
    email,
    options: { shouldCreateUser: true, emailRedirectTo: window.location.origin }
  });
  return { error: error ? friendly(error) : null };
}

export async function verifyCode(rawEmail, rawCode) {
  const email = normaliseEmail(rawEmail);
  const token = String(rawCode || '').replace(/\D/g, '');
  if (token.length < 6) return { error: 'Type the code from the email (6 digits or more).' };
  const { error } = await supabase.auth.verifyOtp({ email, token, type: 'email' });
  return { error: error ? friendly(error) : null };
}

export async function signOut() {
  await supabase.auth.signOut();
}

// If someone opens an old or already-used login link, Supabase sends them back with an error in the URL.
export function linkErrorFromUrl() {
  const params = new URLSearchParams((window.__initialHash || window.location.hash).slice(1));
  if (!params.get('error')) return null;
  history.replaceState(null, '', window.location.pathname);
  return params.get('error_code') === 'otp_expired'
    ? 'That login link has expired or was already used. Type the code from the email instead, or send a new one.'
    : 'That login link didn\'t work. Send a new one below.';
}
