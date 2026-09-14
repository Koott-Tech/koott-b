#!/usr/bin/env node
/**
 * Give the DEMO therapists some availability so the booking calendar has
 * something to show.
 *
 * Writes `availability` rows for the next N days (default 45), skipping
 * Sundays, with a varied slot list per weekday so the calendar does not look
 * uniform. Only touches the demo profiles (emails on demo.koott.invalid).
 *
 * Usage:
 *   node scripts/seedDemoAvailability.js            next 45 days
 *   node scripts/seedDemoAvailability.js --days 60
 *   node scripts/seedDemoAvailability.js --remove   delete what this wrote
 */

require('dotenv').config();
const { supabaseAdmin } = require('../config/supabase');

const DEMO_DOMAIN = '@demo.koott.invalid';

// Slot menus, picked per weekday so different days offer different times.
const MENUS = [
  ['11:00 AM', '11:30 AM', '1:30 PM', '3:00 PM', '3:30 PM'],
  ['9:00 AM', '10:00 AM', '11:00 AM', '4:00 PM', '5:00 PM', '6:00 PM'],
  ['10:30 AM', '12:00 PM', '2:00 PM', '6:30 PM'],
  ['9:30 AM', '11:00 AM', '2:30 PM', '4:30 PM', '7:00 PM'],
  ['12:00 PM', '1:00 PM', '5:30 PM'],
  ['8:00 AM', '9:00 AM', '10:00 AM', '11:00 AM', '12:00 PM', '4:00 PM', '5:00 PM'],
];

const iso = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;

(async () => {
  const argv = process.argv.slice(2);
  const daysArg = argv.indexOf('--days');
  const days = daysArg > -1 ? Number(argv[daysArg + 1]) || 45 : 45;

  const { data: demo, error } = await supabaseAdmin
    .from('psychologists').select('id,first_name,last_name')
    .like('email', `%${DEMO_DOMAIN}`);

  if (error) { console.error('could not read psychologists:', error.message); process.exit(1); }
  if (!demo.length) { console.log('no demo therapists — run seedDemoTherapists.js first'); process.exit(0); }

  const ids = demo.map((d) => d.id);

  if (argv.includes('--remove')) {
    const { error: delErr } = await supabaseAdmin.from('availability').delete().in('psychologist_id', ids);
    if (delErr) { console.error('remove failed:', delErr.message); process.exit(1); }
    console.log(`removed availability for ${ids.length} demo therapist(s)`);
    process.exit(0);
  }

  // Start tomorrow: today's slots would mostly be in the past already.
  const rows = [];
  const start = new Date(); start.setHours(0, 0, 0, 0); start.setDate(start.getDate() + 1);

  demo.forEach((t, ti) => {
    for (let i = 0; i < days; i += 1) {
      const d = new Date(start); d.setDate(start.getDate() + i);
      if (d.getDay() === 0) continue;                    // no Sundays
      const menu = MENUS[(d.getDay() + ti) % MENUS.length];
      rows.push({
        psychologist_id: t.id,
        date: iso(d),
        time_slots: menu,
        is_available: true,
      });
    }
  });

  // Replace rather than duplicate.
  await supabaseAdmin.from('availability').delete().in('psychologist_id', ids);

  const chunk = 500;
  let written = 0;
  for (let i = 0; i < rows.length; i += chunk) {
    const { error: insErr } = await supabaseAdmin.from('availability').insert(rows.slice(i, i + chunk));
    if (insErr) { console.error('insert failed:', insErr.message); process.exit(1); }
    written += rows.slice(i, i + chunk).length;
  }

  console.log(`seeded ${written} availability days across ${demo.length} demo therapists`);
  console.log(`(${days} days from ${iso(start)}, Sundays skipped)`);
  console.log('Remove with:  node scripts/seedDemoAvailability.js --remove');
  process.exit(0);
})();
