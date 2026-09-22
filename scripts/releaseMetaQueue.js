/**
 * After switching Meta sending on (META_CAPI_ENABLED=true, META_PIXEL_ID,
 * META_CAPI_ACCESS_TOKEN set on Render): re-queue the Purchases that were held
 * while it was off. Only the last 7 days — Meta rejects older events.
 *
 *   node scripts/releaseMetaQueue.js           show what would be released
 *   node scripts/releaseMetaQueue.js --go      release them
 */
require('dotenv').config();
const { supabaseAdmin } = require('../config/supabase');

(async () => {
  const since = new Date(Date.now() - 7 * 86400000 + 3600000).toISOString(); // an hour's margin
  const { data, error } = await supabaseAdmin.from('analytics_outbox').select('id')
    .eq('provider', 'meta').eq('status', 'skipped').gte('created_at', since).limit(5000);
  if (error) { console.error('❌', error.message); process.exit(1); }
  console.log(`${data.length} held Meta conversion(s) from the last 7 days.`);
  if (!process.argv.includes('--go')) { console.log('Dry run. Add --go to release them.'); process.exit(0); }
  if (process.env.META_CAPI_ENABLED !== 'true') { console.error('❌ META_CAPI_ENABLED is not "true" here — they would just be held again.'); process.exit(1); }
  for (let i = 0; i < data.length; i += 500) {
    const ids = data.slice(i, i + 500).map((r) => r.id);
    const { error: e } = await supabaseAdmin.from('analytics_outbox')
      .update({ status: 'pending', next_retry_at: new Date().toISOString(), last_error: null, attempt_count: 0 }).in('id', ids);
    if (e) { console.error('❌', e.message); process.exit(1); }
  }
  console.log('✅ Released. The worker sends them within a minute.');
  process.exit(0);
})();
