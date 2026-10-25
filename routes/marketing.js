/**
 * Marketing & analytics dashboard (/marketing in the frontend).
 * Roles: marketing, admin, superadmin — aggregates only (see controllers/marketingController.js).
 *
 * Reports (the two Wix screens): /highlights and /traffic
 *   ?from=YYYY-MM-DD&to=YYYY-MM-DD&env=production|staging|development
 * Live corner feed: /live
 */

const express = require('express');
const { authenticateToken, requireMarketing } = require('../middleware/auth');
const auditLogger = require('../utils/auditLogger');
const c = require('../controllers/marketingController');

const ops = require('../controllers/marketingOpsController');
const router = express.Router();
router.use(authenticateToken, requireMarketing);

// Opening the dashboard is audited (who looked at marketing data, and when).
router.get('/meta', (req, res, next) => {
  auditLogger.logAction({
    userId: req.user.id, userEmail: req.user.email, userRole: req.user.role,
    action: 'MARKETING_DASHBOARD_OPENED', resource: 'marketing_dashboard',
    endpoint: '/api/marketing/meta', method: 'GET',
    ip: req.ip, userAgent: req.headers['user-agent'] || 'Unknown',
  }).catch(() => {});
  next();
}, c.meta);

router.get('/live', c.live);
router.get('/highlights', c.highlights);
router.get('/traffic', c.traffic);
// Detailed reports: traffic-over-time, traffic-sources, location, page-visits,
// button-clicks, blog-posts, blog-time, search-queries, booking-funnel,
// therapist-performance, journeys, campaigns, technical, realtime, custom
router.get('/report/:name', c.report);

/**
 * Operations reports: bookings, sessions, slots and clients, at three levels.
 * ?scope=all | team:<id> | therapist:<id>, with the same from/to the other
 * reports take. Same role guard as the rest of the dashboard.
 */
router.get('/ops/teams', ops.teams);
router.get('/ops/therapists', ops.therapists);
router.get('/ops/:name', ops.report);

// A user's own saved custom reports (the question, never the answer).
router.get('/saved', c.savedReports);
router.post('/saved', c.savedReports);
router.delete('/saved/:id', c.savedReports);

module.exports = router;
