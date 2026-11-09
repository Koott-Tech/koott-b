const express = require('express');
const router = express.Router();
const { allowRoles } = require('../utils/staffRoles');
const { authenticateToken, requireAdmin } = require('../middleware/auth');
const {
  getAllCareers,
  getCareerBySlug,
  getCareerById,
  createCareer,
  updateCareer,
  deleteCareer,
} = require('../controllers/careerController');

// Public routes
router.get('/', getAllCareers);
router.get('/slug/:slug', getCareerBySlug);

// Applications (controllers/jobApplicationsController.js): public apply, HR review
const applications = require('../controllers/jobApplicationsController');
const applyLimiter = require('express-rate-limit')({ windowMs: 60 * 60 * 1000, max: 5, standardHeaders: true, legacyHeaders: false });
router.post('/slug/:slug/apply', applyLimiter, applications.apply);
router.get('/admin/applications', authenticateToken, allowRoles('hr'), applications.list);
router.patch('/admin/applications/:id', authenticateToken, allowRoles('hr'), applications.update);

// Admin routes
router.get('/admin', authenticateToken, allowRoles('hr'), getAllCareers);
router.get('/admin/:id', authenticateToken, allowRoles('hr'), getCareerById);
router.post('/admin', authenticateToken, allowRoles('hr'), createCareer);
router.put('/admin/:id', authenticateToken, allowRoles('hr'), updateCareer);
router.delete('/admin/:id', authenticateToken, allowRoles('hr'), deleteCareer);

module.exports = router;

