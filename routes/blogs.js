const express = require('express');
const router = express.Router();
const { allowRoles } = require('../utils/staffRoles');
const { authenticateToken, requireAdmin, requireSuperAdmin } = require('../middleware/auth');
const {
  getAllBlogs,
  getBlogBySlug,
  getBlogById,
  createBlog,
  updateBlog,
  deleteBlog,
} = require('../controllers/blogController');
const { upload, uploadBlogImage, uploadMultipleBlogImages } = require('../controllers/blogUploadController');

// Public routes
// Public list, cached briefly (cleared by any write — see utils/cache.js)
router.get('/', require('../utils/cache').cachePublic(10 * 60 * 1000), getAllBlogs);
router.get('/slug/:slug', getBlogBySlug);

// Admin routes
router.get('/admin', authenticateToken, allowRoles('marketing'), getAllBlogs); // Get all blogs for admin panel
router.get('/admin/:id', authenticateToken, allowRoles('marketing'), getBlogById);
router.post('/admin', authenticateToken, allowRoles('marketing'), createBlog);
router.put('/admin/:id', authenticateToken, allowRoles('marketing'), updateBlog);
router.delete('/admin/:id', authenticateToken, allowRoles('marketing'), deleteBlog);

// Image upload route
router.post('/admin/upload-image', authenticateToken, allowRoles('marketing'), upload.single('image'), uploadBlogImage);

// Multiple images upload route
router.post('/admin/upload-multiple-images', authenticateToken, allowRoles('marketing'), upload.array('images', 10), uploadMultipleBlogImages);


module.exports = router;
