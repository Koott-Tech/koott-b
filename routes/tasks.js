/**
 * /api/tasks — the shared Tasks page of every staff dashboard (controllers/tasksController.js).
 * Any staff role or therapist; visibility is decided per task in the controller.
 */
const express = require('express');
const router = express.Router();
const { authenticateToken } = require('../middleware/auth');
const { requireStaffMember } = require('../utils/staffRoles');
const c = require('../controllers/tasksController');

router.use(authenticateToken, requireStaffMember);

router.get('/', c.listTasks);
router.get('/people', c.assignable);
router.get('/workload', c.workload);
router.get('/notifications', c.listNotifications);
router.post('/notifications/read', c.markNotificationsRead);
router.post('/report', c.reportProblem);
// Admin: run the automatic-task rules now (they also run every 15 minutes)
router.post('/auto/run', async (req, res) => {
  if (!require('../utils/staffRoles').isAdmin(req.user)) return res.status(403).json({ success: false, message: 'Admin only.' });
  const out = await require('../services/autoTasksService').runAutoTasks({ daily: true });
  return res.json({ success: true, data: out });
});
router.post('/', c.createTaskHandler);
router.get('/:id', c.getTask);
router.patch('/:id', c.updateTask);
router.post('/:id/claim', c.claimTask);
router.post('/:id/comments', c.addComment);

module.exports = router;
