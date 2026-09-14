/**
 * Accounts and leads from the booking flow's verified mobile number.
 *
 * After the WhatsApp code checks out (routes/phoneVerification.js):
 *   - a client whose account already has that number is signed straight in
 *     ("we found your account") — e.g. logged out, or on another device;
 *   - a signed-in client without a number gets it attached to their account;
 *   - anyone else is kept as a lead, and when they fill "About yourself" their
 *     client account is created from those details and they are signed in.
 * booking_leads (migration 0010) keeps every verified number — booked or not —
 * for Admin → Leads. Lead writes never block or fail the booking.
 */

const crypto = require('crypto');
const { parsePhoneNumberFromString } = require('libphonenumber-js');
const { supabaseAdmin } = require('../config/supabase');
const { generateToken, hashPassword } = require('./helpers');

const LEAD_ORDER = ['verified', 'details', 'account', 'booked'];
const now = () => new Date().toISOString();

/** The forms a number may be stored in: +919876543210, 919876543210, 9876543210, 09876543210, "+91 9876543210". */
function phoneVariants(e164) {
  const variants = new Set([e164, e164.replace(/\D/g, '')]);
  const parsed = parsePhoneNumberFromString(e164);
  if (parsed) {
    const national = parsed.nationalNumber;
    variants.add(national);
    variants.add(`0${national}`);
    variants.add(`+${parsed.countryCallingCode} ${national}`);
  }
  return [...variants];
}

const displayName = (client) => [client.first_name, client.last_name]
  .filter((s) => s && s !== 'Pending').join(' ').trim() || client.user?.name || '';

/** Active client account holding this number (newest first), or null. */
async function findClientByPhone(e164) {
  const { data, error } = await supabaseAdmin
    .from('clients')
    .select('*, user:users(id, email, name, role, is_active, profile_picture_url)')
    .in('phone_number', phoneVariants(e164))
    .order('created_at', { ascending: false })
    .limit(5);
  if (error) throw error;
  return (data || []).find((c) => c.user && c.user.role === 'client' && c.user.is_active !== false) || null;
}

/** Same session payload as POST /api/auth/login for a client. */
function signIn(client) {
  // A freshly inserted users row carries password_hash — never send it to the browser.
  const { user: { password_hash, ...user }, ...clientFields } = client;
  return {
    token: generateToken(user.id, 'client'),
    user: {
      id: user.id,
      email: user.email,
      role: 'client',
      profile_picture_url: user.profile_picture_url || null,
      profile: { ...user, ...clientFields }
    }
  };
}

/** Insert or update the lead for a number. Status only moves forward. */
async function saveLead(phone, fields = {}) {
  try {
    const { data: existing, error } = await supabaseAdmin
      .from('booking_leads').select('id, status').eq('phone', phone).maybeSingle();
    if (error) throw error;

    const next = { ...fields, updated_at: now() };
    Object.keys(next).forEach((k) => { if (next[k] === undefined || next[k] === '') delete next[k]; });
    if (existing && next.status && LEAD_ORDER.indexOf(existing.status) > LEAD_ORDER.indexOf(next.status)) delete next.status;

    const { error: writeError } = existing
      ? await supabaseAdmin.from('booking_leads').update(next).eq('id', existing.id)
      : await supabaseAdmin.from('booking_leads').insert({ phone, ...next });
    if (writeError) throw writeError;
  } catch (e) {
    console.warn('⚠️ Booking lead not saved (is migration 0010 applied?):', e.message);
  }
}

/** A paid session for this client turns their lead into "booked". */
async function markLeadBooked(clientId) {
  if (!clientId) return;
  const { error } = await supabaseAdmin
    .from('booking_leads').update({ status: 'booked', updated_at: now() }).eq('client_id', clientId);
  if (error && error.code !== 'PGRST205') console.warn('⚠️ Could not mark lead booked:', error.message);
}

/** Update a client row, retrying without columns a database may not have yet (migration 0010). */
async function updateClient(clientId, fields) {
  let { error } = await supabaseAdmin.from('clients').update(fields).eq('id', clientId);
  if (error?.code === 'PGRST204') {
    const { phone_verified_at, age, emergency_contact, ...rest } = fields;
    if (Object.keys(rest).length) ({ error } = await supabaseAdmin.from('clients').update(rest).eq('id', clientId));
    else error = null;
  }
  return error;
}

/**
 * Right after a code is verified. Returns extra fields for the /verify response:
 *   { found: true, auth, name }  — signed in to the account holding the number
 *   { attached: true }            — number added to the signed-in client
 *   { found: false }              — new visitor, kept as a lead
 *   { ok: false, status, message } on a conflict
 */
async function afterVerified(phone, { signedInUserId = null, psychologistId = null } = {}) {
  if (signedInUserId) {
    const { data: me } = await supabaseAdmin
      .from('clients').select('id, first_name, last_name').eq('user_id', signedInUserId).maybeSingle();
    if (me) {
      const holder = await findClientByPhone(phone);
      if (holder && holder.id !== me.id) {
        return {
          ok: false,
          status: 409,
          message: 'This number is linked to another Koott account. Log out and verify it again to sign in to that account.'
        };
      }
      const error = await updateClient(me.id, { phone_number: phone, phone_verified_at: now() });
      if (error) console.warn('⚠️ Could not attach verified phone:', error.message);
      saveLead(phone, {
        status: 'account', client_id: me.id, psychologist_id: psychologistId, verified_at: now(),
        existing_account: true, name: displayName(me)
      });
      return { attached: true };
    }
  }

  const client = await findClientByPhone(phone);
  if (client) {
    updateClient(client.id, { phone_verified_at: now() });
    const name = displayName(client);
    saveLead(phone, {
      status: 'account', client_id: client.id, psychologist_id: psychologistId, verified_at: now(),
      existing_account: true, name, email: client.user.email
    });
    return { found: true, auth: signIn(client), name };
  }

  saveLead(phone, { status: 'verified', psychologist_id: psychologistId, verified_at: now() });
  return { found: false };
}

/**
 * Create the client account for a verified number from "About yourself" and sign
 * them in. Returns { auth, created } or { conflict: 'email' }.
 */
async function createAccount({ phone, name, email, age, emergency, psychologistId }) {
  const cleanEmail = String(email).trim().toLowerCase();
  const cleanName = String(name).trim().slice(0, 120);
  const ageNum = Number.isInteger(Number(age)) && Number(age) > 0 && Number(age) < 130 ? Number(age) : null;
  const emergencyContact = String(emergency || '').trim().slice(0, 40) || null;
  const leadDetails = {
    name: cleanName, email: cleanEmail, age: ageNum, emergency_contact: emergencyContact,
    psychologist_id: psychologistId
  };

  // Someone may have created the account for this number meanwhile — just sign in.
  const holder = await findClientByPhone(phone);
  if (holder) {
    saveLead(phone, { ...leadDetails, status: 'account', client_id: holder.id, existing_account: true });
    return { auth: signIn(holder), created: false };
  }

  const { data: emailOwner } = await supabaseAdmin
    .from('users').select('id').eq('email', cleanEmail).maybeSingle();
  if (emailOwner) {
    saveLead(phone, { ...leadDetails, status: 'details' });
    return { conflict: 'email' };
  }

  // Random password: they sign in with their number (or "Forgot password") later.
  const password = `${crypto.randomBytes(18).toString('base64url')}Aa1!`;
  const { data: user, error: userError } = await supabaseAdmin
    .from('users')
    .insert({
      email: cleanEmail,
      password_hash: await hashPassword(password),
      role: 'client',
      name: cleanName,
      phone_number: phone
    })
    .select()
    .single();
  if (userError) {
    if (userError.code === '23505') {
      saveLead(phone, { ...leadDetails, status: 'details' });
      return { conflict: 'email' };
    }
    throw new Error(`Failed to create user: ${userError.message}`);
  }

  const row = {
    user_id: user.id,
    first_name: cleanName,
    last_name: '',
    email: cleanEmail,
    phone_number: phone,
    child_name: 'Pending',
    child_age: 1,
    phone_verified_at: now(),
    age: ageNum,
    emergency_contact: emergencyContact
  };
  let { data: client, error: clientError } = await supabaseAdmin.from('clients').insert(row).select('*').single();
  if (clientError?.code === 'PGRST204') {
    const { phone_verified_at, age: _a, emergency_contact, ...base } = row;
    ({ data: client, error: clientError } = await supabaseAdmin.from('clients').insert(base).select('*').single());
  }
  if (clientError) {
    await supabaseAdmin.from('users').delete().eq('id', user.id);
    throw new Error(`Failed to create client: ${clientError.message}`);
  }

  console.log('✅ Client account created from the booking flow:', { userId: user.id, clientId: client.id });
  saveLead(phone, { ...leadDetails, status: 'account', client_id: client.id });

  // Same admin "new user" email as a normal sign-up.
  const adminRecipients = [process.env.COMPANY_ADMIN_EMAIL, 'meet.koott@gmail.com'].filter(Boolean).join(', ');
  if (adminRecipients) {
    const emailService = require('./emailService');
    emailService.sendNewUserRegistrationNotification({
      to: adminRecipients,
      email: cleanEmail,
      role: 'client',
      firstName: cleanName,
      lastName: '',
      phone,
      userId: user.id,
      clientId: client.id,
      createdAt: client.created_at
    }).catch((e) => console.warn('⚠️ New-user admin email failed:', e.message));
  }

  return { auth: signIn({ ...client, user }), created: true };
}

module.exports = { findClientByPhone, afterVerified, createAccount, saveLead, markLeadBooked };
