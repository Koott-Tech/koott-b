const express = require('express');
const router = express.Router();

const {
  listCoupons, createCoupon, updateCoupon, toggleCoupon,
  deleteCoupon, listRedemptions, checkCoupon,
} = require('../controllers/couponController');
const { authenticateToken, requireAdmin } = require('../middleware/auth');

/* Checkout: signed in so per-user redemption limits can be enforced. */
router.post('/validate', authenticateToken, checkCoupon);

/* Admin dashboard. */
router.get('/admin', authenticateToken, requireAdmin, listCoupons);
router.post('/admin', authenticateToken, requireAdmin, createCoupon);
router.put('/admin/:id', authenticateToken, requireAdmin, updateCoupon);
router.patch('/admin/:id/toggle', authenticateToken, requireAdmin, toggleCoupon);
router.delete('/admin/:id', authenticateToken, requireAdmin, deleteCoupon);
router.get('/admin/:id/redemptions', authenticateToken, requireAdmin, listRedemptions);

module.exports = router;
