/**
 * /api/leads — Operations lead pipeline (controllers/leadsController.js).
 * Operations + Admin manage leads; Marketing reads the per-source numbers.
 * POST /inbound is public (rate-limited): the website contact form.
 */
const express = require('express');
const rateLimit = require('express-rate-limit');
const router = express.Router();
const { authenticateToken } = require('../middleware/auth');
const { allowRoles } = require('../utils/staffRoles');
const c = require('../controllers/leadsController');

// The website's contact form posts here from the Next server, so every visitor would share
// that server's IP (one spammer = no enquiries for anyone). The Next route sends the
// visitor's IP with a shared secret (CONTACT_RELAY_SECRET); only then is that IP the key.
const relayKey = (req) => {
  const secret = process.env.CONTACT_RELAY_SECRET;
  const given = String(req.headers['x-koott-relay'] || '');
  if (secret && given.length === secret.length && require('crypto').timingSafeEqual(Buffer.from(given), Buffer.from(secret))) {
    const ip = String(req.headers['x-client-ip'] || '').trim().slice(0, 64);
    if (ip) return `relay:${ip}`;
  }
  return req.ip;
};
const inboundLimiter = rateLimit({ windowMs: 15 * 60 * 1000, max: 10, standardHeaders: true, legacyHeaders: false, keyGenerator: relayKey });
router.post('/inbound', inboundLimiter, c.inboundLead);

router.use(authenticateToken);
router.get('/sources', allowRoles('operations', 'marketing'), c.leadSources);
router.get('/event-results', allowRoles('operations', 'marketing'), c.eventResults);
const { logOnSuccess } = require('../utils/accessLog');
const byId = (r) => r.params.id;
router.get('/', allowRoles('operations'), c.listLeads);
router.post('/', allowRoles('operations'), logOnSuccess('created', 'lead'), c.createLead);
router.patch('/:id', allowRoles('operations'), logOnSuccess('changed', 'lead', byId), c.updateLead);
router.post('/:id/convert', allowRoles('operations'), logOnSuccess('converted', 'lead', byId), c.convertLead);
router.post('/:id/contact', allowRoles('operations'), logOnSuccess('changed', 'lead', byId), c.logContact);
// The lead panel was opened (record of access)
router.post('/:id/viewed', allowRoles('operations'), logOnSuccess('viewed', 'lead', byId), (req, res) => res.json({ success: true, data: {} }));
// Operations: one timeline per client (lead source, bookings, payments, tasks)
router.get('/client-timeline/:id', allowRoles('operations'), c.clientTimeline);
// Where a client came from (Instagram, Google Ads, direct…) — the client profile popup
router.get('/client-source/:id', allowRoles('operations'), c.clientSource);
// Admin: the record of access for clients, leads and sessions
router.get('/access-log', require('../utils/staffRoles').allowRoles(), c.accessLog);

module.exports = router;
