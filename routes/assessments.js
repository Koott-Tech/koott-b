const express = require('express');
const router = express.Router();
const { allowRoles } = require('../utils/staffRoles');
const { authenticateToken, requireAdmin } = require('../middleware/auth');
const multer = require('multer');
const upload = multer({ storage: multer.memoryStorage() });
const {
  getAllAssessments,
  getAllAssessmentsAdmin,
  getAssessmentBySlug,
  getAssessmentById,
  createAssessment,
  updateAssessment,
  deleteAssessment,
} = require('../controllers/assessmentsController');
const { uploadAssessmentImage } = require('../controllers/assessmentsController');

// Admin (must be before public slug route)
router.get('/admin', authenticateToken, allowRoles('marketing'), getAllAssessmentsAdmin);
router.get('/admin/:id', authenticateToken, allowRoles('marketing'), getAssessmentById);
router.post('/admin', authenticateToken, allowRoles('marketing'), createAssessment);
router.put('/admin/:id', authenticateToken, allowRoles('marketing'), updateAssessment);
router.delete('/admin/:id', authenticateToken, allowRoles('marketing'), deleteAssessment);
router.post('/admin/upload-image', authenticateToken, allowRoles('marketing'), upload.single('image'), uploadAssessmentImage);

// Public
router.get('/', getAllAssessments);
router.get('/:slug', getAssessmentBySlug);

module.exports = router;


