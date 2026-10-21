const express = require('express');
const router = express.Router();
const { authenticateToken, requireMarketing } = require('../middleware/auth');
const { getConfig, putConfig } = require('../controllers/siteConfigController');

// Public read — the footer needs this on every page.
// Site-wide chrome (footer…) is read on every page: cached, cleared by any write.
router.get('/:key', require('../utils/cache').cachePublic(10 * 60 * 1000), getConfig);

// Admin write.
// Page content is the marketing team's to edit (requireMarketing covers
// marketing, admin and superadmin). What they may change is still bounded by
// the field schema in SitePageEditor, so the design cannot be altered here.
router.put('/:key', authenticateToken, requireMarketing, putConfig);

module.exports = router;
