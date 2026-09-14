#!/usr/bin/env node
/**
 * Demo LOGIN accounts — one for every dashboard, so each can be opened and checked.
 *
 *   superadmin      /superadmin        admin            /admin
 *   finance         /finance           event_organizer  /event-organizer
 *   client (India)  /profile           client (Dubai)   /profile  — emails/WhatsApp in Gulf time
 *   therapist       /psychologist      (demo therapist Anjali Menon)
 *   psychiatrist    /psychologist      (demo psychiatrist Vishnu Prasad, 15/30-min consults)
 *
 * All emails are on demo.koott.invalid — a reserved TLD that can never receive
 * mail. The two therapist logins are added to the demo profiles created by
 * seedDemoTherapists.js (run that first). NOT for production: remove before launch.
 *
 * Usage (from backend/):
 *   node scripts/seedDemoUsers.js           create / refresh the accounts (safe to re-run; resets the password)
 *   node scripts/seedDemoUsers.js --list    show what exists
 *   node scripts/seedDemoUsers.js --remove  delete the demo users + clients, clear the demo therapists' logins
 *
 * Password: DEMO_USERS_PASSWORD in backend/.env — required to create accounts; never
 * committed (these include a superadmin login).
 */

require('dotenv').config();
const { supabaseAdmin } = require('../config/supabase');
const { hashPassword, comparePassword } = require('../utils/helpers');
const { validatePassword } = require('../utils/passwordPolicy');

const DOMAIN = '@demo.koott.invalid';
const PASSWORD = process.env.DEMO_USERS_PASSWORD;
if (!PASSWORD && !process.argv.includes('--list') && !process.argv.includes('--remove')) {
  console.error('Set DEMO_USERS_PASSWORD in backend/.env before creating demo accounts.');
  process.exit(1);
}

const STAFF = [
  { email: `demo.superadmin${DOMAIN}`, role: 'superadmin', name: 'Demo Superadmin', dashboard: '/superadmin' },
  { email: `demo.admin${DOMAIN}`, role: 'admin', name: 'Demo Admin', dashboard: '/admin' },
  { email: `demo.finance${DOMAIN}`, role: 'finance', name: 'Demo Finance', dashboard: '/finance' },
  { email: `demo.events${DOMAIN}`, role: 'event_organizer', name: 'Demo Event Organizer', dashboard: '/event-organizer' },
];

const CLIENTS = [
  { email: `demo.client${DOMAIN}`, first: 'Demo', last: 'Client', phone: '+919000000001', timeZone: 'Asia/Kolkata', label: 'client (India)' },
  { email: `demo.client.dubai${DOMAIN}`, first: 'Demo', last: 'Client Dubai', phone: '+971500000001', timeZone: 'Asia/Dubai', label: 'client (Dubai)' },
];

const THERAPISTS = [
  { email: `anjali.menon${DOMAIN}`, label: 'therapist' },
  { email: `vishnu.prasad${DOMAIN}`, label: 'psychiatrist' },
];

const stamp = () => new Date().toISOString();
const allUserEmails = [...STAFF, ...CLIENTS].map((a) => a.email);

async function upsertUser({ email, role, name, phone }, passwordHash) {
  const { data: existing, error: readErr } = await supabaseAdmin.from('users').select('id').eq('email', email).maybeSingle();
  if (readErr) throw readErr;
  const fields = { password_hash: passwordHash, role, name, phone_number: phone || null, is_active: true, updated_at: stamp() };
  if (existing) {
    const { error } = await supabaseAdmin.from('users').update(fields).eq('id', existing.id);
    if (error) throw error;
    return existing.id;
  }
  const { data, error } = await supabaseAdmin
    .from('users')
    .insert({ email, ...fields, created_at: stamp() })
    .select('id')
    .single();
  if (error) throw error;
  return data.id;
}

async function upsertClientProfile(userId, c) {
  const { data: existing, error: readErr } = await supabaseAdmin.from('clients').select('id').eq('user_id', userId).maybeSingle();
  if (readErr) throw readErr;
  const fields = {
    first_name: c.first, last_name: c.last, email: c.email, phone_number: c.phone,
    terms_accepted: true, therapy_agreement_accepted: true, updated_at: stamp(),
  };
  const withZone = { ...fields, time_zone: c.timeZone };
  const write = async (row) => (existing
    ? supabaseAdmin.from('clients').update(row).eq('id', existing.id)
    : supabaseAdmin.from('clients').insert({ user_id: userId, ...row, created_at: stamp() }));
  let { error } = await write(withZone);
  if (error && /time_zone/.test(error.message || '')) ({ error } = await write(fields)); // before migration 0005
  if (error) throw error;
}

/** The same check login runs: stored hash vs the password. */
async function verify(table, email) {
  const { data } = await supabaseAdmin.from(table).select('id, password_hash').eq('email', email).maybeSingle();
  return Boolean(data?.password_hash) && comparePassword(PASSWORD, data.password_hash);
}

async function seed() {
  const policy = validatePassword(PASSWORD);
  if (!policy.valid) {
    console.error('Password does not meet the site policy:', policy.errors.join('; '));
    process.exit(1);
  }
  const passwordHash = await hashPassword(PASSWORD);
  const rows = [];

  for (const s of STAFF) {
    try {
      await upsertUser(s, passwordHash);
      rows.push([s.role, s.email, s.dashboard, await verify('users', s.email) ? 'ok' : 'CHECK FAILED']);
    } catch (e) {
      rows.push([s.role, s.email, s.dashboard, `NOT CREATED: ${e.message}`]);
    }
  }

  for (const c of CLIENTS) {
    try {
      const userId = await upsertUser({ email: c.email, role: 'client', name: `${c.first} ${c.last}`, phone: c.phone }, passwordHash);
      await upsertClientProfile(userId, c);
      rows.push([c.label, c.email, '/profile', await verify('users', c.email) ? 'ok' : 'CHECK FAILED']);
    } catch (e) {
      rows.push([c.label, c.email, '/profile', `NOT CREATED: ${e.message}`]);
    }
  }

  for (const t of THERAPISTS) {
    const { data, error } = await supabaseAdmin
      .from('psychologists')
      .update({ password_hash: passwordHash, updated_at: stamp() })
      .eq('email', t.email)
      .select('id');
    if (error) rows.push([t.label, t.email, '/psychologist', `NOT SET: ${error.message}`]);
    else if (!data?.length) rows.push([t.label, t.email, '/psychologist', 'profile missing — run seedDemoTherapists.js first']);
    else rows.push([t.label, t.email, '/psychologist', await verify('psychologists', t.email) ? 'ok' : 'CHECK FAILED']);
  }

  console.log('\nDemo logins (password for all: ' + PASSWORD + '):\n');
  rows.forEach(([role, email, dash, status]) => console.log(`  ${role.padEnd(18)} ${email.padEnd(40)} ${dash.padEnd(17)} ${status}`));
  console.log('\nThese are test accounts. Remove before launch: node scripts/seedDemoUsers.js --remove\n');
}

async function list() {
  const { data: users } = await supabaseAdmin.from('users').select('email, role, is_active').in('email', allUserEmails);
  const { data: psychs } = await supabaseAdmin.from('psychologists').select('email, password_hash').in('email', THERAPISTS.map((t) => t.email));
  (users || []).forEach((u) => console.log(`  ${u.role.padEnd(16)} ${u.email}${u.is_active === false ? ' (inactive)' : ''}`));
  (psychs || []).forEach((p) => console.log(`  ${'psychologist'.padEnd(16)} ${p.email}${p.password_hash ? '' : ' (no login)'}`));
  if (!(users || []).length) console.log('  (no demo users)');
}

async function remove() {
  const { data: users } = await supabaseAdmin.from('users').select('id').in('email', allUserEmails);
  const ids = (users || []).map((u) => u.id);
  if (ids.length) {
    const { error: cErr } = await supabaseAdmin.from('clients').delete().in('user_id', ids);
    if (cErr) console.warn('client profiles not removed:', cErr.message);
    const { error: uErr } = await supabaseAdmin.from('users').delete().in('id', ids);
    if (uErr) { console.error('remove failed:', uErr.message); process.exit(1); }
  }
  await supabaseAdmin.from('psychologists').update({ password_hash: null }).in('email', THERAPISTS.map((t) => t.email));
  console.log(`removed ${ids.length} demo user(s); demo therapist logins cleared`);
}

(async () => {
  const argv = process.argv.slice(2);
  if (argv.includes('--list')) await list();
  else if (argv.includes('--remove')) await remove();
  else await seed();
  process.exit(0);
})().catch((e) => { console.error(e); process.exit(1); });
