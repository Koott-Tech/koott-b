const express = require('express');
const router = express.Router();
const multer = require('multer');
const { authenticateToken, requireAdmin } = require('../middleware/auth');
const {
  getAllCounsellingServices,
  getAllCounsellingServicesAdmin,
  getCounsellingServiceBySlug,
  getCounsellingServiceById,
  createCounsellingService,
  updateCounsellingService,
  deleteCounsellingService,
  uploadCounsellingImage
} = require('../controllers/counsellingController');

// Configure multer for memory storage
const upload = multer({ storage: multer.memoryStorage() });

// Public routes
router.get('/', getAllCounsellingServices);

// Admin routes (require authentication and admin role)
router.get('/admin', authenticateToken, requireAdmin, getAllCounsellingServicesAdmin);
router.get('/admin/:id', authenticateToken, requireAdmin, getCounsellingServiceById);
router.post('/admin', authenticateToken, requireAdmin, createCounsellingService);
router.put('/admin/:id', authenticateToken, requireAdmin, updateCounsellingService);
router.delete('/admin/:id', authenticateToken, requireAdmin, deleteCounsellingService);
router.post('/admin/upload-image', authenticateToken, requireAdmin, upload.single('image'), uploadCounsellingImage);

// Public slug route (must be after admin routes)
router.get('/:slug', getCounsellingServiceBySlug);

module.exports = router;
