/**
 * Read every row of a query, 1,000 at a time. Supabase (PostgREST) answers at most
 * 1,000 rows per request whatever .limit() says, so a report that did
 * `.select(...).limit(20000)` silently counted only the first 1,000 rows.
 *
 *   const rows = await fetchAll(() => supabaseAdmin.from('leads').select('stage, source').order('id'));
 *
 * makeQuery must return a NEW query each time (with a stable order). Throws the Supabase
 * error, so callers' error handling (missing table → 503) still works.
 */
async function fetchAll(makeQuery, { pageSize = 1000, max = 100000 } = {}) {
  const out = [];
  for (let from = 0; from < max; from += pageSize) {
    const { data, error } = await makeQuery().range(from, from + pageSize - 1);
    if (error) throw error;
    out.push(...(data || []));
    if (!data || data.length < pageSize) break;
  }
  return out;
}

module.exports = { fetchAll };
