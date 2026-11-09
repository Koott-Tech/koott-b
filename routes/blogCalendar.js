/** /api/blog-calendar — Marketing's blog calendar (controllers/blogCalendarController.js). */
const express = require('express');
const router = express.Router();
const { authenticateToken } = require('../middleware/auth');
const { allowRoles, requireStaffMember } = require('../utils/staffRoles');
const c = require('../controllers/blogCalendarController');

router.use(authenticateToken);
router.get('/', allowRoles('marketing'), c.calendar);
router.post('/plan', allowRoles('marketing'), c.planPost);
router.post('/review', allowRoles('marketing'), c.sendForReview);
router.get('/review/:taskId', requireStaffMember, c.reviewPreview);

module.exports = router;
