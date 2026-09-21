/**
 * Phone verification for the booking flow — a 6-digit code sent on WhatsApp
 * (Interakt "Authentication" template) before the client books.
 *
 * Codes are stored as a keyed hash in phone_verifications (migration 0009),
 * live 5 minutes, allow 5 tries, and can be re-sent every 30 s (5 per hour per
 * number). A verified number gets a signed 2-hour token; createPaymentOrder
 * checks it so the phone saved on the booking is one the client proved they hold.
 *
 * PHONE_OTP_DEV_ECHO=true (never in production) returns the code in the API
 * response when WhatsApp sending fails — for local testing before the
 * template is approved.
 *
 * TEST NUMBERS — TEMPORARY, REMOVE BEFORE LAUNCH. Numbers listed in
 * PHONE_OTP_TEST_NUMBERS skip WhatsApp entirely and take PHONE_OTP_TEST_CODE
 * (default 1234) as their code, so the booking flow can be walked end to end
 * while the Interakt template is still in review. Deliberately a short list of
 * reserved numbers rather than "any number with 1234": a verified number signs
 * the client straight into the account holding it, so a blanket code would let
 * anyone type someone else's number and land inside their account. Unset the
 * variable and the bypass does not exist.
 */

const crypto = require('crypto');
const jwt = require('jsonwebtoken');
const { parsePhoneNumberFromString } = require('libphonenumber-js');
const { supabaseAdmin } = require('../config/supabase');
const interaktService = require('./interaktService');

const CODE_TTL_MINUTES = 5;
const MAX_ATTEMPTS = 5;
const RESEND_GAP_SECONDS = 30;
const MAX_SENDS_PER_HOUR = 5;
const TOKEN_TTL = '2h';
const TOKEN_PURPOSE = 'phone_verified';

// Derived from JWT_SECRET but distinct, so a phone token can never pass as a login token.
const secret = () => crypto.createHash('sha256').update(`${process.env.JWT_SECRET}:phone-verification`).digest('hex');

/** Any user-typed number -> E.164 ("+919876543210"), or null. Bare 10 digits = India. */
function normalizePhone(raw) {
  const cleaned = String(raw || '').trim().replace(/[\s\-().]/g, '');
  if (!cleaned) return null;
  const candidate = /^\d{10}$/.test(cleaned) ? `+91${cleaned}` : (cleaned.startsWith('+') ? cleaned : `+${cleaned}`);
  const parsed = parsePhoneNumberFromString(candidate);
  return parsed && parsed.isValid() ? parsed.number : null;
}

/** Reserved numbers that take the fixed code instead of one sent on WhatsApp. */
const testNumbers = () => String(process.env.PHONE_OTP_TEST_NUMBERS || '')
  .split(',').map((n) => normalizePhone(n)).filter(Boolean);
const testCode = () => String(process.env.PHONE_OTP_TEST_CODE || '1234').trim();
const isTestNumber = (phone) => testNumbers().includes(phone);

const hashCode = (phone, code) => crypto.createHmac('sha256', secret()).update(`${phone}:${code}`).digest('hex');

const fail = (status, message, extra = {}) => ({ ok: false, status, message, ...extra });

async function sendCode(rawPhone) {
  const phone = normalizePhone(rawPhone);
  if (!phone) return fail(400, 'Please enter a valid mobile number.');

  // A reserved test number: nothing is sent and nothing is stored, and the
  // fixed code is what verifyCode will accept.
  if (isTestNumber(phone)) {
    console.warn(`⚠️  OTP bypass used for test number ${phone} — clear PHONE_OTP_TEST_NUMBERS before launch`);
    return {
      ok: true,
      phone,
      expiresAt: new Date(Date.now() + CODE_TTL_MINUTES * 60 * 1000).toISOString(),
      resendAfter: 0,
      devCode: testCode(),
      testNumber: true,
    };
  }

  const hourAgo = new Date(Date.now() - 60 * 60 * 1000).toISOString();
  const { data: recent, error } = await supabaseAdmin
    .from('phone_verifications')
    .select('created_at')
    .eq('phone', phone)
    .gte('created_at', hourAgo)
    .order('created_at', { ascending: false });
  if (error) {
    console.error('❌ phone_verifications lookup failed (is migration 0009 applied?):', error.message);
    return fail(500, 'We could not send a code just now. Please try again.');
  }

  if (recent.length) {
    const since = (Date.now() - new Date(recent[0].created_at).getTime()) / 1000;
    if (since < RESEND_GAP_SECONDS) {
      const wait = Math.ceil(RESEND_GAP_SECONDS - since);
      return fail(429, `Please wait ${wait} seconds before asking for a new code.`, { retryAfter: wait });
    }
  }
  if (recent.length >= MAX_SENDS_PER_HOUR) {
    return fail(429, 'Too many codes were requested for this number. Please try again in an hour.');
  }

  const code = String(crypto.randomInt(0, 1000000)).padStart(6, '0');
  const expiresAt = new Date(Date.now() + CODE_TTL_MINUTES * 60 * 1000).toISOString();
  const { data: row, error: insertError } = await supabaseAdmin
    .from('phone_verifications')
    .insert({ phone, code_hash: hashCode(phone, code), expires_at: expiresAt })
    .select('id')
    .single();
  if (insertError) {
    console.error('❌ phone_verifications insert failed:', insertError.message);
    return fail(500, 'We could not send a code just now. Please try again.');
  }

  const sent = await interaktService.sendOtp(phone, code);
  const devEcho = process.env.PHONE_OTP_DEV_ECHO === 'true' && process.env.NODE_ENV !== 'production';
  if (!sent.success && !devEcho) {
    // Not delivered, so it shouldn't count against the client's resend limit.
    await supabaseAdmin.from('phone_verifications').delete().eq('id', row.id);
    return fail(502, 'We could not send the code on WhatsApp. Please check the number is on WhatsApp and try again.');
  }

  return {
    ok: true,
    phone,
    expiresAt,
    resendAfter: RESEND_GAP_SECONDS,
    ...(devEcho && !sent.success ? { devCode: code } : {})
  };
}

async function verifyCode(rawPhone, rawCode) {
  const phone = normalizePhone(rawPhone);
  const code = String(rawCode || '').replace(/\D/g, '');
  if (!phone) return fail(400, 'Please enter a valid mobile number.');

  if (isTestNumber(phone)) {
    if (code !== testCode()) return fail(400, 'That code is not right.');
    console.warn(`⚠️  OTP bypass accepted for test number ${phone}`);
    return { ok: true, phone, token: jwt.sign({ purpose: TOKEN_PURPOSE, phone }, secret(), { expiresIn: TOKEN_TTL }) };
  }

  if (code.length !== 6) return fail(400, 'Please enter the 6-digit code.');

  const { data: row, error } = await supabaseAdmin
    .from('phone_verifications')
    .select('id, code_hash, attempts')
    .eq('phone', phone)
    .is('verified_at', null)
    .gt('expires_at', new Date().toISOString())
    .order('created_at', { ascending: false })
    .limit(1)
    .maybeSingle();
  if (error) {
    console.error('❌ phone_verifications lookup failed:', error.message);
    return fail(500, 'We could not check the code just now. Please try again.');
  }
  if (!row) return fail(400, 'This code has expired. Please ask for a new one.');
  if (row.attempts >= MAX_ATTEMPTS) return fail(429, 'Too many wrong attempts. Please ask for a new code.');

  const matches = crypto.timingSafeEqual(Buffer.from(row.code_hash, 'hex'), Buffer.from(hashCode(phone, code), 'hex'));
  if (!matches) {
    await supabaseAdmin.from('phone_verifications').update({ attempts: row.attempts + 1 }).eq('id', row.id);
    const left = MAX_ATTEMPTS - row.attempts - 1;
    return fail(400, left > 0
      ? `That code is not right. ${left} ${left === 1 ? 'try' : 'tries'} left.`
      : 'Too many wrong attempts. Please ask for a new code.');
  }

  await supabaseAdmin
    .from('phone_verifications')
    .update({ attempts: row.attempts + 1, verified_at: new Date().toISOString() })
    .eq('id', row.id);

  const token = jwt.sign({ purpose: TOKEN_PURPOSE, phone }, secret(), { expiresIn: TOKEN_TTL });
  return { ok: true, phone, token };
}

/** The verified E.164 number inside a token from verifyCode, or null. */
function phoneFromToken(token) {
  if (!token) return null;
  try {
    const payload = jwt.verify(token, secret());
    return payload?.purpose === TOKEN_PURPOSE ? payload.phone : null;
  } catch (_) {
    return null;
  }
}

module.exports = { normalizePhone, sendCode, verifyCode, phoneFromToken };
