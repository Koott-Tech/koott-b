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
router.get('/', allowRoles('operations'), c.listLeads);
router.post('/', allowRoles('operations'), c.createLead);
router.patch('/:id', allowRoles('operations'), c.updateLead);
router.post('/:id/convert', allowRoles('operations'), c.convertLead);

module.exports = router;
