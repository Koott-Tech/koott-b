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
