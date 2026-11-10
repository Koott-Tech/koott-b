/**
 * /api/documents — staff document store with expiry (HR + the person themselves)
 * /api/safety     — urgent safety path to the clinical lead (controllers/hrExtrasController.js)
 */
const express = require('express');
const multer = require('multer');
const rateLimit = require('express-rate-limit');
const { authenticateToken } = require('../middleware/auth');
const { requireStaffMember, allowRoles } = require('../utils/staffRoles');
const c = require('../controllers/hrExtrasController');

const ALLOWED = /^(image\/(png|jpeg|webp)|application\/pdf|application\/(msword|vnd\.openxmlformats-officedocument\.wordprocessingml\.document))$/;
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 15 * 1024 * 1024 },
  fileFilter: (req, file, cb) => (ALLOWED.test(file.mimetype || '') ? cb(null, true) : cb(new Error('PDF, Word or image files only.'))),
});
const withFile = (req, res, next) => upload.single('file')(req, res, (err) => (err
  ? res.status(400).json({ success: false, message: err.code === 'LIMIT_FILE_SIZE' ? 'Files can be up to 15 MB.' : err.message })
  : next()));

const documents = express.Router();
documents.use(authenticateToken, requireStaffMember);
documents.get('/', c.listDocuments);
documents.post('/', withFile, c.uploadDocument);
documents.get('/:id/file', c.openDocument);
documents.patch('/:id', c.updateDocument);
documents.delete('/:id', allowRoles('hr'), c.deleteDocument);

const safety = express.Router();
safety.use(authenticateToken, requireStaffMember);
safety.get('/lead', c.clinicalLead);
safety.put('/lead', c.setClinicalLead);
// Per person, not per IP: therapists sharing an office network must never block each
// other's URGENT safety alert. 10 in 10 minutes per person only stops a runaway script.
safety.post('/alerts', rateLimit({
  windowMs: 10 * 60 * 1000, max: 10, standardHeaders: true, legacyHeaders: false,
  keyGenerator: (req) => `safety-${req.user?.role === 'psychologist' ? 'p' : 'u'}:${req.user?.id}`,
}), c.raiseAlert);
safety.get('/alerts', c.listAlerts);
safety.patch('/alerts/:id', c.updateAlert);

module.exports = { documents, safety };
