const { createClient } = require('@supabase/supabase-js');

// Prefer the shared NEXT_PUBLIC_* env vars so frontend and backend
// use the same Supabase project URL; fall back to backend-only
// SUPABASE_* vars for compatibility.
const supabaseUrl =
  process.env.NEXT_PUBLIC_SUPABASE_URL || process.env.SUPABASE_URL;
const supabaseAnonKey =
  process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY || process.env.SUPABASE_ANON_KEY;
const supabaseServiceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;

if (!supabaseUrl || !supabaseAnonKey) {
  throw new Error('Missing Supabase environment variables');
}

// Every Supabase call gives up after SUPABASE_TIMEOUT_MS (default 20 s; file storage 2 min):
// without it a slow database kept each request — and the browser — waiting indefinitely.
const TIMEOUT_MS = Number(process.env.SUPABASE_TIMEOUT_MS) || 20000;
const timedFetch = (input, init = {}) => {
  const url = typeof input === 'string' ? input : (input instanceof URL ? input.href : input?.url || '');
  const ms = /\/storage\/v1\//.test(url) ? Math.max(TIMEOUT_MS, 120000) : TIMEOUT_MS;
  const signal = init.signal ? AbortSignal.any([init.signal, AbortSignal.timeout(ms)]) : AbortSignal.timeout(ms);
  return fetch(input, { ...init, signal });
};

// Create client with anonymous key for user operations
const supabase = createClient(supabaseUrl, supabaseAnonKey, { global: { fetch: timedFetch } });

// Create client with service role key for admin operations (bypasses RLS)
const supabaseAdmin = createClient(supabaseUrl, supabaseServiceKey, {
  auth: {
    autoRefreshToken: false,
    persistSession: false
  },
  global: { fetch: timedFetch }
});

// Export both for backward compatibility
module.exports = supabase;
module.exports.supabaseAdmin = supabaseAdmin;
