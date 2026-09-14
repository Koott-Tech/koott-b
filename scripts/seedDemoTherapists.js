#!/usr/bin/env node
/**
 * Seed a handful of DEMO therapist profiles.
 *
 * These are placeholders so the home page, the therapist grid and the filters
 * have something to render while the real profiles are still to be imported.
 * They are NOT real people: every row's description starts with "DEMO PROFILE"
 * and the emails are on demo.koott.invalid, which is a reserved TLD and can
 * never receive mail.
 *
 * Remove them before the site is public:
 *   node scripts/seedDemoTherapists.js --remove
 *
 * Usage:
 *   node scripts/seedDemoTherapists.js           insert the demo rows
 *   node scripts/seedDemoTherapists.js --remove  delete them again
 *   node scripts/seedDemoTherapists.js --list    show what is stored
 */

require('dotenv').config();
const { supabaseAdmin } = require('../config/supabase');

const DEMO_MARK = 'DEMO PROFILE —';
const DEMO_DOMAIN = '@demo.koott.invalid';

/**
 * Spread across designations, specialities, experience and price so the
 * Speciality / Needs / Experience / Budget filters all have something to bite
 * on. Expertise values match the slugs used elsewhere on the site.
 */
const DEMO = [
  {
    first_name: 'Anjali', last_name: 'Menon',
    designation: 'Clinical Psychologist',
    experience_years: 9,
    area_of_expertise: ['anxiety', 'depression', 'stress'],
    individual_session_price: 1799,
    ug_college: 'University of Calicut', pg_college: 'Christ University',
  },
  {
    first_name: 'Rahul', last_name: 'Nair',
    designation: 'Consultant Psychologist',
    experience_years: 6,
    area_of_expertise: ['relationships', 'anxiety', 'sleep'],
    individual_session_price: 1299,
    ug_college: 'MG University', pg_college: 'University of Madras',
  },
  {
    first_name: 'Fathima', last_name: 'Noora',
    designation: 'Senior Psychologist',
    experience_years: 12,
    area_of_expertise: ['trauma', 'depression', 'grief'],
    individual_session_price: 2299,
    pg_college: 'NIMHANS', mphil_college: 'NIMHANS',
  },
  {
    first_name: 'Vishnu', last_name: 'Prasad',
    designation: 'Psychiatrist',
    experience_years: 15,
    area_of_expertise: ['adhd', 'bipolar-disorder', 'ocd'],
    individual_session_price: 2999,
    psychiatrist_15min_price: 1699, psychiatrist_30min_price: 2999,
    ug_college: 'Government Medical College, Kozhikode',
  },
  {
    first_name: 'Sneha', last_name: 'Thomas',
    designation: 'Child & Adolescent Psychologist',
    experience_years: 7,
    area_of_expertise: ['child-behaviour', 'parenting', 'school-stress'],
    individual_session_price: 1499,
    child_specialist_pricing: 1499, better_parent_pricing: 1299,
    pg_college: 'Tata Institute of Social Sciences',
  },
  {
    first_name: 'Arun', last_name: 'Krishnan',
    designation: 'Couples Therapist',
    experience_years: 10,
    area_of_expertise: ['relationships', 'intimacy', 'communication'],
    individual_session_price: 1999,
    pg_college: 'Bangalore University',
  },
];

/**
 * The booking flow needs something to sell: a single session and three packages
 * for each of individual and couple. package_type follows the convention the
 * admin controller uses — 'individual' / 'package_<n>' / 'couple' /
 * 'couple_package_<n>'.
 */
function packagesFor(psychologistId, base, doctor = {}) {
  // Psychiatrists: 15-min and 30-min consultations plus 15-min packages, no couple
  // (same rows the admin "Psychiatry pricing" editor writes — utils/psychiatryPackages.js).
  if (/psychiatr/i.test(doctor.designation || '')) {
    const p15 = doctor.psychiatrist_15min_price || Math.round(base * 0.6 / 50) * 50;
    const p30 = doctor.psychiatrist_30min_price || base;
    return [
      { psychologist_id: psychologistId, name: '15-min consultation', description: 'One 15-minute psychiatry consultation',
        package_type: 'psychiatry_15', session_count: 1, price: p15, is_active: true },
      { psychologist_id: psychologistId, name: '30-min consultation', description: 'One 30-minute psychiatry consultation',
        package_type: 'psychiatry_30', session_count: 1, price: p30, is_active: true },
      ...[{ n: 3, off: 0.05 }, { n: 6, off: 0.10 }].map(({ n, off }) => ({
        psychologist_id: psychologistId, name: `${n} × 15-min consultations`,
        description: `${n} psychiatry consultations of 15 minutes`,
        package_type: `psychiatry_15_package_${n}`, session_count: n,
        price: Math.round(p15 * n * (1 - off) / 50) * 50, is_active: true,
      })),
    ];
  }
  const couple = Math.round(base * 1.7 / 50) * 50;
  const tiers = [
    { n: 3, off: 0.10 }, { n: 6, off: 0.15 }, { n: 9, off: 0.20 },
  ];
  const out = [
    {
      psychologist_id: psychologistId, name: 'Individual session',
      description: 'A 50-minute one-to-one session.',
      package_type: 'individual', session_count: 1, price: base, is_active: true,
    },
    {
      psychologist_id: psychologistId, name: 'Couple session',
      description: 'An 80-minute session for you and your partner.',
      package_type: 'couple', session_count: 1, price: couple, is_active: true,
    },
  ];
  for (const { n, off } of tiers) {
    out.push({
      psychologist_id: psychologistId, name: `${n}-session package`,
      description: `${n} individual sessions.`,
      package_type: `package_${n}`, session_count: n,
      price: Math.round(base * n * (1 - off) / 50) * 50, is_active: true,
    });
    out.push({
      psychologist_id: psychologistId, name: `Couple ${n}-session package`,
      description: `${n} couple sessions.`,
      package_type: `couple_package_${n}`, session_count: n,
      price: Math.round(couple * n * (1 - off) / 50) * 50, is_active: true,
    });
  }
  return out;
}

const row = (t, i) => ({
  ...t,
  email: `${t.first_name}.${t.last_name}`.toLowerCase() + DEMO_DOMAIN,
  description: `${DEMO_MARK} placeholder record for layout and filter testing. `
    + `${t.designation} with ${t.experience_years} years of practice.`,
  is_active: true,
  display_order: i + 2, // the existing seed row sits first
});

(async () => {
  const argv = process.argv.slice(2);

  const stored = await supabaseAdmin
    .from('psychologists').select('id,first_name,last_name,email,description')
    .like('email', `%${DEMO_DOMAIN}`);

  if (stored.error) {
    console.error('could not read psychologists:', stored.error.message);
    process.exit(1);
  }

  if (argv.includes('--list')) {
    console.log(stored.data.length ? stored.data.map((r) => `${r.first_name} ${r.last_name}  ${r.email}`).join('\n') : '(no demo rows)');
    process.exit(0);
  }

  if (argv.includes('--remove')) {
    const ids = stored.data.map((r) => r.id);
    if (ids.length) await supabaseAdmin.from('packages').delete().in('psychologist_id', ids);
    const { error } = await supabaseAdmin
      .from('psychologists').delete().like('email', `%${DEMO_DOMAIN}`);
    if (error) { console.error('remove failed:', error.message); process.exit(1); }
    console.log(`removed ${stored.data.length} demo profile(s) and their packages`);
    process.exit(0);
  }

  if (stored.data.length) {
    console.log(`${stored.data.length} demo profile(s) already present. --remove first to reseed.`);
    process.exit(0);
  }

  const { data, error } = await supabaseAdmin
    .from('psychologists')
    .insert(DEMO.map(row))
    .select('id,first_name,last_name,designation,individual_session_price,psychiatrist_15min_price,psychiatrist_30min_price');

  if (error) { console.error('seed failed:', error.message); process.exit(1); }

  const packages = data.flatMap((r) => packagesFor(r.id, r.individual_session_price, r));
  const pkg = await supabaseAdmin.from('packages').insert(packages);
  if (pkg.error) console.warn('packages not seeded:', pkg.error.message);

  console.log(`seeded ${data.length} demo therapists:`);
  data.forEach((r) => console.log(`  ${r.first_name} ${r.last_name}`));
  if (!pkg.error) console.log(`plus ${packages.length} packages (single + 3/6/9, individual and couple)`);
  console.log('\nThese are placeholders, not real practitioners.');
  console.log('Remove before launch:  node scripts/seedDemoTherapists.js --remove');
  process.exit(0);
})();
