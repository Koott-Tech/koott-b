#!/usr/bin/env node
/**
 * Seed the minimum rows needed to log in and exercise a booking on a fresh database.
 *
 *   node scripts/seed-initial-data.js
 *
 * Reads SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY from .env. Idempotent: every row
 * is upserted on a natural key, so re-running updates rather than duplicating.
 *
 * Passwords come from the environment when set, otherwise a random one is
 * generated and printed once. Nothing is hard-coded.
 */
const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '..', '.env') });

const bcrypt = require('bcryptjs');
const crypto = require('crypto');
const { supabaseAdmin } = require('../config/supabase');

const randomPassword = () => crypto.randomBytes(12).toString('base64url');

async function upsertUser({ email, name, role, password }) {
  const password_hash = await bcrypt.hash(password, 12);
  const { data: existing } = await supabaseAdmin
    .from('users').select('id').eq('email', email).maybeSingle();

  if (existing) {
    const { data, error } = await supabaseAdmin
      .from('users')
      .update({ name, role, password_hash, is_active: true })
      .eq('id', existing.id).select('id, email, role').single();
    if (error) throw new Error(`update ${email}: ${error.message}`);
    return { ...data, created: false };
  }
  const { data, error } = await supabaseAdmin
    .from('users')
    .insert([{ email, name, role, password_hash, is_active: true }])
    .select('id, email, role').single();
  if (error) throw new Error(`insert ${email}: ${error.message}`);
  return { ...data, created: true };
}

(async () => {
  const created = [];

  // ── 1. Superadmin ─────────────────────────────────────────────────────────
  const adminEmail = process.env.SEED_ADMIN_EMAIL || 'admin@koott.in';
  const adminPassword = process.env.SEED_ADMIN_PASSWORD || randomPassword();
  const admin = await upsertUser({
    email: adminEmail, name: 'Koott Admin', role: 'superadmin', password: adminPassword,
  });
  created.push({ role: 'superadmin', email: admin.email, password: adminPassword });

  // ── 2. A therapist, with a users row and a psychologists profile ──────────
  const psychEmail = process.env.SEED_PSYCHOLOGIST_EMAIL || 'therapist@koott.in';
  const psychPassword = process.env.SEED_PSYCHOLOGIST_PASSWORD || randomPassword();
  const psychUser = await upsertUser({
    email: psychEmail, name: 'Test Therapist', role: 'psychologist', password: psychPassword,
  });
  created.push({ role: 'psychologist', email: psychUser.email, password: psychPassword });

  const psychRow = {
    user_id: psychUser.id,
    first_name: 'Test', last_name: 'Therapist',
    email: psychEmail, phone: '+910000000000',
    designation: 'Consultant Psychologist',
    description: 'Seeded profile for local testing.',
    experience_years: 5,
    area_of_expertise: ['anxiety', 'depression'],
    individual_session_price: 1500,
    is_active: true,
    password_hash: await bcrypt.hash(psychPassword, 12),
  };
  const { data: existingPsych } = await supabaseAdmin
    .from('psychologists').select('id').eq('email', psychEmail).maybeSingle();
  let psychologistId;
  if (existingPsych) {
    const { data, error } = await supabaseAdmin
      .from('psychologists').update(psychRow).eq('id', existingPsych.id).select('id').single();
    if (error) throw new Error(`psychologist update: ${error.message}`);
    psychologistId = data.id;
  } else {
    const { data, error } = await supabaseAdmin
      .from('psychologists').insert([psychRow]).select('id').single();
    if (error) throw new Error(`psychologist insert: ${error.message}`);
    psychologistId = data.id;
  }

  // Commission rates — without these every payout computes to zero.
  const { data: existingComm } = await supabaseAdmin
    .from('doctor_commissions').select('id').eq('psychologist_id', psychologistId).maybeSingle();
  const commRow = {
    psychologist_id: psychologistId,
    is_active: true,
    doctor_commission_first_session: 900,
    doctor_commission_followup: 800,
    commission_amount_individual: 600,
    doctor_commission_packages: {
      package_3_first_session: 2500,
      package_3_followup: 2400,
      couple_session: 1200,
    },
  };
  if (existingComm) {
    await supabaseAdmin.from('doctor_commissions').update(commRow).eq('id', existingComm.id);
  } else {
    const { error } = await supabaseAdmin.from('doctor_commissions').insert([commRow]);
    if (error) throw new Error(`doctor_commissions: ${error.message}`);
  }

  // A package so package booking can be exercised.
  const { data: existingPkg } = await supabaseAdmin
    .from('packages').select('id').eq('psychologist_id', psychologistId).eq('session_count', 3).maybeSingle();
  if (!existingPkg) {
    const { error } = await supabaseAdmin.from('packages').insert([{
      psychologist_id: psychologistId,
      name: '3-Session Package', package_type: 'package',
      session_count: 3, price: 4200, is_active: true,
      description: 'Seeded package for local testing.',
    }]);
    if (error) throw new Error(`packages: ${error.message}`);
  }

  // ── 3. A client ───────────────────────────────────────────────────────────
  const clientEmail = process.env.SEED_CLIENT_EMAIL || 'client@koott.in';
  const clientPassword = process.env.SEED_CLIENT_PASSWORD || randomPassword();
  const clientUser = await upsertUser({
    email: clientEmail, name: 'Test Client', role: 'client', password: clientPassword,
  });
  created.push({ role: 'client', email: clientUser.email, password: clientPassword });

  const { data: existingClient } = await supabaseAdmin
    .from('clients').select('id').eq('user_id', clientUser.id).maybeSingle();
  if (!existingClient) {
    const { error } = await supabaseAdmin.from('clients').insert([{
      user_id: clientUser.id,
      first_name: 'Test', last_name: 'Client',
      email: clientEmail, phone_number: '+910000000001',
      terms_accepted: true, therapy_agreement_accepted: true,
    }]);
    if (error) throw new Error(`clients: ${error.message}`);
  }

  // ── 4. Finance reference data ─────────────────────────────────────────────
  for (const name of ['Salaries', 'Marketing', 'Software', 'Office']) {
    await supabaseAdmin.from('expense_categories').upsert({ name, is_active: true }, { onConflict: 'name' });
  }
  for (const name of ['Sessions', 'Workshops', 'Assessments']) {
    await supabaseAdmin.from('income_sources').upsert({ name, is_active: true }, { onConflict: 'name' });
  }

  console.log('\nSeed complete.\n');
  console.log('  Sign in with:');
  for (const c of created) {
    console.log(`    ${c.role.padEnd(13)} ${c.email.padEnd(24)} ${c.password}`);
  }
  console.log('\n  Passwords are shown once. Set SEED_ADMIN_PASSWORD etc. in .env to pin them.');
  console.log('  Change them before this database is reachable from anywhere but localhost.\n');
  process.exit(0);
})().catch((e) => {
  console.error('\nSeed failed:', e.message);
  console.error('If this is a "relation does not exist" error, run the migration first:');
  console.error('  supabase/migrations/0001_initial_schema.sql\n');
  process.exit(1);
});
