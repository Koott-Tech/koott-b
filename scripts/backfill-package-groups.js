/**
 * Puts package sessions that have no group into their purchase's group
 * (sessions.package_group_id = client_packages.id) — for sessions booked before grouping
 * was keyed on the purchase (services/packageService.js, "Package grouping").
 *
 * For each client + plan: purchases are taken oldest first; each purchase gets its first
 * session (client_packages.first_session_id) and then the client's next ungrouped sessions
 * of that plan in date order, up to the package size. Sessions that already have a group are
 * never touched.
 *
 *   node scripts/backfill-package-groups.js          # preview only (default)
 *   node scripts/backfill-package-groups.js --apply  # write the changes
 */
require('dotenv').config({ quiet: true });
const { supabaseAdmin } = require('../config/supabase');
const { deriveSessionCount } = require('../services/packageService');

const APPLY = process.argv.includes('--apply');
const LIVE = (st) => !['cancelled', 'canceled', 'no_show', 'noshow'].includes(st);

async function all(table, select, build = (q) => q) {
  let out = []; let from = 0;
  for (;;) {
    const { data, error } = await build(supabaseAdmin.from(table).select(select)).range(from, from + 999);
    if (error) throw error;
    out = out.concat(data || []);
    if (!data || data.length < 1000) return out;
    from += 1000;
  }
}

(async () => {
  const purchases = await all('client_packages', 'id, client_id, package_id, first_session_id, session_count, total_sessions, package_type, purchased_at, created_at');
  const sessions = await all('sessions', 'id, client_id, package_id, package_group_id, status, scheduled_date, scheduled_time',
    (q) => q.not('package_id', 'is', null));
  const plans = await all('packages', 'id, session_count, package_type');
  const planById = Object.fromEntries(plans.map((p) => [p.id, p]));

  const byPair = {};
  for (const p of purchases) {
    if (!p.client_id || !p.package_id) continue;
    (byPair[`${p.client_id}|${p.package_id}`] = byPair[`${p.client_id}|${p.package_id}`] || []).push(p);
  }
  const ungroupedByPair = {};
  for (const s of sessions) {
    if (s.package_group_id) continue;
    (ungroupedByPair[`${s.client_id}|${s.package_id}`] = ungroupedByPair[`${s.client_id}|${s.package_id}`] || []).push(s);
  }

  const changes = [];
  for (const [pair, list] of Object.entries(byPair)) {
    let pool = (ungroupedByPair[pair] || []).sort((a, b) =>
      `${a.scheduled_date || ''} ${a.scheduled_time || ''}`.localeCompare(`${b.scheduled_date || ''} ${b.scheduled_time || ''}`));
    if (!pool.length) continue;
    list.sort((a, b) => String(a.purchased_at || a.created_at || '').localeCompare(String(b.purchased_at || b.created_at || '')));
    for (const p of list) {
      const total = deriveSessionCount({ ...p, session_count: p.session_count ?? p.total_sessions ?? planById[p.package_id]?.session_count, package_type: p.package_type || planById[p.package_id]?.package_type }, 1);
      if (total <= 1) continue; // single-session purchases are not packages: never grouped
      const already = sessions.filter((s) => s.package_group_id === p.id && LIVE(s.status)).length;
      let room = total - already;
      let number = already;
      const take = [];
      const first = pool.find((s) => s.id === p.first_session_id);
      if (first) take.push(first);
      for (const s of pool) {
        if (take.length >= room) break;
        if (!take.includes(s)) take.push(s);
      }
      // Cancelled sessions ride along with their purchase but don't use a slot.
      for (const s of take.slice(0, Math.max(room, 0))) {
        if (LIVE(s.status)) number += 1;
        changes.push({ session: s.id, purchase: p.id, number: LIVE(s.status) ? number : null, total, date: s.scheduled_date, status: s.status });
      }
      pool = pool.filter((s) => !take.includes(s));
      room -= take.length;
      if (!pool.length) break;
    }
    if (pool.length) console.log(`  ${pool.length} session(s) for ${pair} have no purchase with a free slot — left ungrouped:`, pool.map((s) => s.id).join(', '));
  }

  console.log(`${APPLY ? 'Applying' : 'Preview'}: ${changes.length} session(s) to group.`);
  for (const c of changes) console.log(`  session ${c.session.slice(0, 8)} (${c.date}, ${c.status}) → purchase ${c.purchase.slice(0, 8)}${c.number ? `, session ${c.number} of ${c.total}` : ''}`);
  if (!APPLY) { console.log('Nothing written. Run with --apply to save.'); return; }
  for (const c of changes) {
    const patch = { package_group_id: c.purchase, session_count: c.total };
    if (c.number) patch.package_session_number = c.number;
    const { error } = await supabaseAdmin.from('sessions').update(patch).eq('id', c.session).is('package_group_id', null);
    if (error) console.error('  failed', c.session, error.message);
  }
  console.log('Done.');
})().catch((e) => { console.error(e.message || e); process.exit(1); });
