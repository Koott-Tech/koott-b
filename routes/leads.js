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

const inboundLimiter = rateLimit({ windowMs: 15 * 60 * 1000, max: 10, standardHeaders: true, legacyHeaders: false });
router.post('/inbound', inboundLimiter, c.inboundLead);

router.use(authenticateToken);
router.get('/sources', allowRoles('operations', 'marketing'), c.leadSources);
const { logOnSuccess } = require('../utils/accessLog');
const byId = (r) => r.params.id;
router.get('/', allowRoles('operations'), c.listLeads);
router.post('/', allowRoles('operations'), logOnSuccess('created', 'lead'), c.createLead);
router.patch('/:id', allowRoles('operations'), logOnSuccess('changed', 'lead', byId), c.updateLead);
router.post('/:id/convert', allowRoles('operations'), logOnSuccess('converted', 'lead', byId), c.convertLead);
// The lead panel was opened (record of access)
router.post('/:id/viewed', allowRoles('operations'), logOnSuccess('viewed', 'lead', byId), (req, res) => res.json({ success: true, data: {} }));
// Operations: one timeline per client (lead source, bookings, payments, tasks)
router.get('/client-timeline/:id', allowRoles('operations'), c.clientTimeline);
// Admin: the record of access for clients, leads and sessions
router.get('/access-log', require('../utils/staffRoles').allowRoles(), c.accessLog);

module.exports = router;
