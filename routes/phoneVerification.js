/**
 * Public phone verification for the booking flow (utils/phoneVerification.js,
 * utils/bookingAccounts.js).
 *
 *   POST /api/phone-verification/send            { phone }
 *        -> { phone, expiresAt, resendAfter }
 *   POST /api/phone-verification/verify          { phone, code, psychologistId? }
 *        -> { phone, token } plus one of
 *           { found: true, auth, name }  number already on a client: signed in
 *           { attached: true }           signed-in client (Bearer): number saved to them
 *           { found: false }             new visitor: kept as a lead
 *   POST /api/phone-verification/create-account  { phoneToken, name, email, age?, emergency?, psychologistId? }
 *        -> { auth, created }  client account from "About yourself", signed in
 *
 * Per-IP limits here; per-number limits (resend gap, sends per hour, tries per
 * code) live in the service.
 */

const express = require('express');
const jwt = require('jsonwebtoken');
const rateLimit = require('express-rate-limit');
const { sendCode, verifyCode, phoneFromToken } = require('../utils/phoneVerification');
const { afterVerified, createAccount } = require('../utils/bookingAccounts');

const router = express.Router();

const limiter = (max) => rateLimit({
  windowMs: 15 * 60 * 1000,
  max,
  standardHeaders: true,
  legacyHeaders: false,
  message: { success: false, message: 'Too many requests. Please try again in a few minutes.' }
});

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const uuidOrNull = (v) => (typeof v === 'string' && UUID.test(v) ? v : null);

/** users.id of a signed-in client (Bearer token), else null. */
function signedInClientUserId(req) {
  const header = req.headers.authorization || '';
  const token = header.startsWith('Bearer ') ? header.slice(7) : null;
  if (!token) return null;
  try {
    const payload = jwt.verify(token, process.env.JWT_SECRET);
    return payload?.role === 'client' ? payload.userId : null;
  } catch (_) {
    return null;
  }
}

const reply = (res, result) => {
  if (!result.ok) {
    const { ok, status, message, ...extra } = result;
    return res.status(status).json({ success: false, message, ...extra });
  }
  const { ok, ...data } = result;
  return res.json({ success: true, data });
};

router.post('/send', limiter(10), async (req, res) => {
  try {
    reply(res, await sendCode(req.body?.phone));
  } catch (error) {
    console.error('❌ phone-verification/send:', error.message);
    res.status(500).json({ success: false, message: 'We could not send a code just now. Please try again.' });
  }
});

router.post('/verify', limiter(20), async (req, res) => {
  try {
    const result = await verifyCode(req.body?.phone, req.body?.code);
    if (!result.ok) return reply(res, result);

    const account = await afterVerified(result.phone, {
      signedInUserId: signedInClientUserId(req),
      psychologistId: uuidOrNull(req.body?.psychologistId)
    });
    if (account.ok === false) return reply(res, account);
    reply(res, { ...result, ...account });
  } catch (error) {
    console.error('❌ phone-verification/verify:', error.message);
    res.status(500).json({ success: false, message: 'We could not check the code just now. Please try again.' });
  }
});

router.post('/create-account', limiter(10), async (req, res) => {
  try {
    const phone = phoneFromToken(req.body?.phoneToken);
    if (!phone) {
      return res.status(400).json({
        success: false, code: 'PHONE_NOT_VERIFIED', message: 'Please verify your mobile number again.'
      });
    }
    const name = String(req.body?.name || '').trim();
    const email = String(req.body?.email || '').trim();
    if (name.length < 2) return res.status(400).json({ success: false, message: 'Please enter your full name.' });
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
      return res.status(400).json({ success: false, message: 'Please enter a valid email address.' });
    }

    const result = await createAccount({
      phone,
      name,
      email,
      age: req.body?.age,
      emergency: req.body?.emergency,
      psychologistId: uuidOrNull(req.body?.psychologistId)
    });
    if (result.conflict === 'email') {
      return res.status(409).json({
        success: false,
        code: 'EMAIL_EXISTS',
        message: 'An account with this email already exists. Log in with it, or use a different email.'
      });
    }
    res.json({ success: true, data: result });
  } catch (error) {
    console.error('❌ phone-verification/create-account:', error.message);
    res.status(500).json({ success: false, message: 'We could not save your details. Please try again.' });
  }
});

module.exports = router;
