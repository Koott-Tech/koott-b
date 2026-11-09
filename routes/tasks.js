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
// Report a problem: 20 an hour per person (each one is a task + notifications for Developers)
const reportLimiter = require('express-rate-limit')({
  windowMs: 60 * 60 * 1000, max: 20, standardHeaders: true, legacyHeaders: false,
  keyGenerator: (req) => `report-${req.user?.role === 'psychologist' ? 'p' : 'u'}:${req.user?.id}`,
  message: { success: false, message: 'That is a lot of reports in an hour. Please try again later.' },
});
router.post('/report', reportLimiter, c.reportProblem);
// Admin: run the automatic-task rules now (they also run every 15 minutes)
router.post('/auto/run', async (req, res) => {
  if (!require('../utils/staffRoles').isAdmin(req.user)) return res.status(403).json({ success: false, message: 'Admin only.' });
  const auto = require('../services/autoTasksService');
  // A run is already going (the 15-minute timer, or another admin pressed it)
  if (auto.isRunning()) return res.status(409).json({ success: false, message: 'The automatic tasks are running right now. Try again in a minute.' });
  const out = await auto.runAutoTasks({ daily: true });
  return res.json({ success: true, data: out });
});
router.post('/', c.createTaskHandler);
router.get('/:id', c.getTask);
router.patch('/:id', c.updateTask);
router.post('/:id/claim', c.claimTask);
router.post('/:id/comments', c.addComment);

// Files on a task (private bucket; opened through a 5-minute link)
const multer = require('multer');
const ALLOWED = /^(image\/(png|jpeg|webp|gif)|application\/pdf|text\/plain|text\/csv|application\/(msword|vnd\.openxmlformats-officedocument\.(wordprocessingml\.document|spreadsheetml\.sheet|presentationml\.presentation)|vnd\.ms-excel))$/;
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 15 * 1024 * 1024 },
  fileFilter: (req, file, cb) => (ALLOWED.test(file.mimetype || '') ? cb(null, true) : cb(new Error('Images, PDF, Word, Excel, PowerPoint, CSV or text files only.'))),
});
router.get('/:id/attachments', c.getAttachments);
router.post('/:id/attachments', (req, res, next) => upload.single('file')(req, res, (err) => (err
  ? res.status(400).json({ success: false, message: err.code === 'LIMIT_FILE_SIZE' ? 'Files can be up to 15 MB.' : err.message })
  : next())), c.uploadAttachment);
router.get('/:id/attachments/:file', c.openAttachment);
router.delete('/:id/attachments/:file', c.deleteAttachment);

module.exports = router;
