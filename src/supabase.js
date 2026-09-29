// The one connection to Supabase. Only the PUBLIC (anon / publishable) key is used here;
// what each person can read or change is decided by Row Level Security in the database.
import { createClient } from '@supabase/supabase-js';

const url = import.meta.env.VITE_SUPABASE_URL;
const key = import.meta.env.VITE_SUPABASE_ANON_KEY;

if (!url || !key) {
  throw new Error('Missing VITE_SUPABASE_URL or VITE_SUPABASE_ANON_KEY. Copy .env.example to .env and fill them in.');
}

export const supabase = createClient(url, key, {
  auth: {
    // Implicit flow: the login link works even if the email opens in a different browser.
    flowType: 'implicit',
    detectSessionInUrl: true,
    persistSession: true,
    autoRefreshToken: true
  }
});
