/**
 * Start a query now, read it later — so lookups that don't depend on each other overlap
 * instead of queueing one database round trip after another.
 *
 *   const rowsP = early(supabaseAdmin.from('x').select('…'));   // sent at once
 *   …
 *   const { data, error } = await late(rowsP);                    // exactly what `await q` gave
 *
 * late() returns the same { data, error } the query would have returned, or rethrows what it
 * threw, at the line that used to await it — so error handling stays where it was. A pending
 * early() that is never read cannot raise an unhandled rejection.
 */
const early = (q) => Promise.resolve(q).then((ok) => ({ ok }), (err) => ({ err }));
const late = async (p) => {
  const r = await p;
  if ('err' in r) throw r.err;
  return r.ok;
};

module.exports = { early, late };
