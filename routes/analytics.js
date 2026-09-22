/**
 * First-party analytics collection (public, rate-limited).
 *
 *   POST /api/analytics/events    batched browser events (validated against analytics/registry.js)
 *   POST /api/analytics/consent   a cookie-banner choice
 *   POST /api/analytics/identify  after login / sign-up: link the anonymous visitor to the account
 *
 * Always answers 202 quickly; nothing here can fail a page.
 */

const express = require('express');
const jwt = require('jsonwebtoken');
const rateLimit = require('express-rate-limit');
const { authenticateToken } = require('../middleware/auth');
const analytics = require('../analytics/analytics.service');

const router = express.Router();

const limiter = (max) => rateLimit({
  windowMs: 60 * 1000,
  max,
  standardHeaders: true,
  legacyHeaders: false,
  message: { success: false, message: 'Too many analytics requests.' },
});

// The browser's JWT, if any, only to attach user_id — an invalid token just means "anonymous".
function optionalUserId(req) {
  const header = req.headers.authorization || '';
  const token = header.startsWith('Bearer ') ? header.slice(7) : null;
  if (!token) return null;
  try {
    const payload = jwt.verify(token, process.env.JWT_SECRET, { algorithms: ['HS256'] });
    return payload?.role === 'client' ? payload.userId : null;
  } catch (_) {
    return null;
  }
}

// sendBeacon posts text/plain; accept that as JSON too.
const beaconJson = express.text({ type: 'text/plain', limit: '64kb' });
const parseBody = (req) => {
  if (typeof req.body === 'string') {
    try { return JSON.parse(req.body); } catch (_) { return null; }
  }
  return req.body;
};

router.post('/events', limiter(240), beaconJson, async (req, res) => {
  try {
    const result = await analytics.recordBrowserBatch({
      body: parseBody(req),
      userId: optionalUserId(req),
      userAgent: req.headers['user-agent'] || '',
    });
    res.status(202).json({ success: true, ...result });
  } catch (e) {
    analytics.logError('events route', e);
    res.status(202).json({ success: false });
  }
});

router.post('/consent', limiter(30), beaconJson, async (req, res) => {
  const ok = await analytics.recordConsent({ body: parseBody(req), userId: optionalUserId(req) }).catch(() => false);
  res.status(202).json({ success: ok });
});

router.post('/identify', limiter(30), authenticateToken, async (req, res) => {
  try {
    const result = await analytics.identify({ user: req.user, body: req.body, userAgent: req.headers['user-agent'] || '' });
    res.status(202).json({ success: !!result.ok });
  } catch (e) {
    analytics.logError('identify route', e);
    res.status(202).json({ success: false });
  }
});

module.exports = router;
