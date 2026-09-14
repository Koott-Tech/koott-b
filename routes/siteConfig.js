const express = require('express');
const router = express.Router();
const { authenticateToken, requireAdmin } = require('../middleware/auth');
const { getConfig, putConfig } = require('../controllers/siteConfigController');

// Public read — the footer needs this on every page.
// Site-wide chrome (footer…) is read on every page: cached, cleared by any write.
router.get('/:key', require('../utils/cache').cachePublic(10 * 60 * 1000), getConfig);

// Admin write.
router.put('/:key', authenticateToken, requireAdmin, putConfig);

module.exports = router;
