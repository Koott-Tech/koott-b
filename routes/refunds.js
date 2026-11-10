/**
 * /api/refunds — Operations' refund requests (controllers/refundsController.js).
 * Operations (and Admin) see them under the refund icon and press Refund.
 */
const express = require('express');
const rateLimit = require('express-rate-limit');
const router = express.Router();
const { authenticateToken } = require('../middleware/auth');
const { allowRoles } = require('../utils/staffRoles');
const c = require('../controllers/refundsController');

router.use(authenticateToken, allowRoles('operations'));
router.get('/count', c.count);
router.get('/', c.list);
// Money moves here: a modest per-person limit against a stuck button or a script
const moneyLimiter = rateLimit({
  windowMs: 10 * 60 * 1000, max: 30, standardHeaders: true, legacyHeaders: false,
  keyGenerator: (req) => `refund-${req.user?.id}`,
});
router.post('/:id/refund', moneyLimiter, c.refund);
router.post('/:id/cancel-only', c.cancelOnly);
router.post('/:id/reject', c.reject);
router.post('/:id/manual', c.manual);

module.exports = router;
