/**
 * Read-only therapist-group endpoints for finance (admins and superadmins pass
 * requireFinance too). Creating, editing and assigning live under /api/admin.
 */

const express = require('express');
const { authenticateToken, requireFinance } = require('../middleware/auth');
const therapistGroupsController = require('../controllers/therapistGroupsController');

const router = express.Router();

router.use(authenticateToken);
router.use(requireFinance);

router.get('/', therapistGroupsController.list);
router.get('/report', therapistGroupsController.report);

module.exports = router;
