/**
 * "Does this table / column exist yet?" — remembered, so a request doesn't pay a database round
 * trip (~300 ms) just to find out. Used by features whose SQL may not have been run yet.
 * A yes is kept for the life of the process (tables don't disappear); a no is re-checked after a
 * minute, so running the SQL takes effect without a restart.
 */
const { supabaseAdmin } = require('../config/supabase');

const cache = new Map(); // key -> { ok, at } | Promise
const RETRY_MS = 60 * 1000;

function schemaReady(table, columns = 'id') {
  const key = `${table}:${columns}`;
  const hit = cache.get(key);
  if (hit instanceof Promise) return hit;
  if (hit && (hit.ok || Date.now() - hit.at < RETRY_MS)) return Promise.resolve(hit.ok);
  const p = supabaseAdmin.from(table).select(columns).limit(1)
    .then(({ error }) => !error, () => false)
    .then((ok) => { cache.set(key, { ok, at: Date.now() }); return ok; });
  cache.set(key, p);
  return p;
}

module.exports = { schemaReady };
