#!/usr/bin/env node
/**
 * Clear collected analytics so a period starts from nothing.
 *
 * Useful once: the events recorded while the dashboard was being built are test
 * traffic, and leaving them in makes the first real week look busier than it was.
 *
 * Usage (from backend/):
 *   node scripts/clearAnalyticsData.js                    show what is stored
 *   node scripts/clearAnalyticsData.js --env development  delete one environment
 *   node scripts/clearAnalyticsData.js --env all --yes    delete everything
 *   node scripts/clearAnalyticsData.js --before 2026-09-24 --env production --yes
 *
 * Nothing is deleted without --yes. Production needs --env production named
 * explicitly; "all" will not touch it unless you say --include-production.
 *
 * This only clears what analytics recorded — events, the visitor/session
 * identities behind them, and the attribution rows. It never touches bookings,
 * payments, clients or consent records: consent is a record of what someone
 * chose and deleting it would lose that choice.
 */

require('dotenv').config();
const { supabaseAdmin } = require('../config/supabase');

const args = process.argv.slice(2);
const flag = (name, fallback = null) => {
  const i = args.indexOf(`--${name}`);
  return i === -1 ? fallback : (args[i + 1] && !args[i + 1].startsWith('--') ? args[i + 1] : true);
};
const YES = args.includes('--yes');
const ENV = flag('env');
const BEFORE = flag('before');
const INCLUDE_PROD = args.includes('--include-production');

const TABLES = ['analytics_events', 'analytics_identities', 'booking_attribution', 'lead_attribution', 'analytics_outbox'];

async function counts() {
  const rows = {};
  const { data } = await supabaseAdmin.from('analytics_events').select('environment');
  (data || []).forEach((r) => { rows[r.environment] = (rows[r.environment] || 0) + 1; });
  console.log('\nanalytics_events by environment:');
  if (!Object.keys(rows).length) console.log('  (none)');
  Object.entries(rows).forEach(([k, v]) => console.log(`  ${k.padEnd(14)} ${v}`));

  for (const t of TABLES.slice(1)) {
    const { count, error } = await supabaseAdmin.from(t).select('*', { count: 'exact', head: true });
    console.log(`${t.padEnd(24)} ${error ? `— ${error.code}` : count}`);
  }
  const { count: consent } = await supabaseAdmin.from('consent_records').select('*', { count: 'exact', head: true });
  console.log(`consent_records          ${consent} (kept — a record of what people chose)`);
}

async function clear() {
  if (ENV === 'production' && !YES) throw new Error('Refusing to clear production without --yes.');
  if (ENV === 'all' && !INCLUDE_PROD) console.log('Note: "all" skips production. Add --include-production to include it.');

  const envs = ENV === 'all'
    ? ['development', 'staging', ...(INCLUDE_PROD ? ['production'] : [])]
    : [ENV];

  for (const env of envs) {
    let q = supabaseAdmin.from('analytics_events').delete().eq('environment', env);
    if (BEFORE) q = q.lt('occurred_at', `${BEFORE}T00:00:00+05:30`);
    const { error, count } = await q.select('id', { count: 'exact', head: true });
    if (error) throw error;
    console.log(`  deleted ${count ?? '?'} events from ${env}${BEFORE ? ` before ${BEFORE}` : ''}`);
  }

  // Identities and attribution rows only mean anything alongside events.
  if (!BEFORE) {
    // Each of these is keyed differently, so delete on a column each one has.
    const ROWS = [
      ['analytics_identities', 'linked_at'],
      ['booking_attribution', 'created_at'],
      ['lead_attribution', 'created_at'],
    ];
    for (const [t, since] of ROWS) {
      const { error } = await supabaseAdmin.from(t).delete().gte(since, '1970-01-01T00:00:00Z');
      if (error && error.code !== 'PGRST205') console.warn(`  ${t}: ${error.message}`);
      else console.log(`  cleared ${t}`);
    }
    const { error } = await supabaseAdmin.from('analytics_outbox').delete().in('status', ['done', 'skipped']);
    if (!error) console.log('  cleared finished analytics_outbox rows');
  }
}

(async () => {
  try {
    if (!ENV) {
      await counts();
      console.log('\nNothing deleted. Pass --env <development|staging|production|all> --yes to clear.\n');
      return;
    }
    if (!YES) {
      await counts();
      console.log(`\nWould clear: ${ENV}${BEFORE ? ` before ${BEFORE}` : ''}. Add --yes to do it.\n`);
      return;
    }
    console.log(`Clearing ${ENV}…`);
    await clear();
    await counts();
    console.log('\nDone.\n');
  } catch (e) {
    console.error('❌', e.message);
    process.exit(1);
  }
})();
