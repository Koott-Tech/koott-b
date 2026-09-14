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
// Header condition menu (frontend ConditionMenu): only the columns the menu needs —
// a few KB instead of every page's full content (~1 MB). Same { data: { services } }
// shape as GET /. Must stay above '/:slug'.
router.get('/menu', require('../utils/cache').cachePublic(10 * 60 * 1000), async (req, res) => {
  try {
    const { supabaseAdmin } = require('../config/supabase');
    let { data, error } = await supabaseAdmin
      .from('counselling_services')
      .select('slug, status, category, menu_group, menu_label, menu_order, hero_title, menu:content->menu')
      .eq('status', 'published');
    if (error?.code === '42703') {
      // Menu columns from migration 0004 missing — placement lives in content.menu
      ({ data, error } = await supabaseAdmin
        .from('counselling_services')
        .select('slug, status, hero_title, menu:content->menu')
        .eq('status', 'published'));
    }
    if (error) throw error;
    const services = (data || []).map(({ menu, ...row }) => ({ ...row, content: { menu: menu || null } }));
    res.set('Cache-Control', 'public, max-age=60');
    res.json({ success: true, data: { services } });
  } catch (error) {
    console.error('❌ counselling menu:', error.message);
    res.status(500).json({ success: false, message: 'Could not load the menu' });
  }
});

// Cached briefly; ?preview (the CMS editor) always reads fresh.
router.get('/:slug', require('../utils/cache').cachePublic(10 * 60 * 1000), getCounsellingServiceBySlug);

module.exports = router;
