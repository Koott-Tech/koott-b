const express = require('express');
const router = express.Router();
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
router.get('/', getAllBlogs);
router.get('/slug/:slug', getBlogBySlug);

// Admin routes
router.get('/admin', authenticateToken, requireAdmin, getAllBlogs); // Get all blogs for admin panel
router.get('/admin/:id', authenticateToken, requireAdmin, getBlogById);
router.post('/admin', authenticateToken, requireAdmin, createBlog);
router.put('/admin/:id', authenticateToken, requireAdmin, updateBlog);
router.delete('/admin/:id', authenticateToken, requireAdmin, deleteBlog);

// Image upload route
router.post('/admin/upload-image', authenticateToken, requireAdmin, upload.single('image'), uploadBlogImage);

// Multiple images upload route
router.post('/admin/upload-multiple-images', authenticateToken, requireAdmin, upload.array('images', 10), uploadMultipleBlogImages);


module.exports = router;
