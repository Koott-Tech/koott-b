/**
 * /api/pages — the marketing CMS page registry.
 *
 * Reads and writes are both staff-only. requireMarketing already means
 * marketing, admin or superadmin, so the dashboard's own role gets in without a
 * new role being invented. Authorisation is enforced here, not by hiding
 * buttons in the UI.
 */

const express = require('express');
const router = express.Router();
const { authenticateToken, requireMarketing } = require('../middleware/auth');
const {
  listPages, getPage, scoreDraft, updateSeo,
  getContent, saveDraft, publish, discardDraft,
  listVersions, getVersion, restoreVersion,
} = require('../controllers/pagesController');

router.use(authenticateToken, requireMarketing);

router.get('/', listPages);
router.post('/score', scoreDraft);
router.get('/:key', getPage);
router.patch('/:key/seo', updateSeo);

// Content: a save writes a draft, and only publish touches what the site serves.
router.get('/:key/content', getContent);
router.put('/:key/content', saveDraft);
router.post('/:key/publish', publish);
router.post('/:key/discard-draft', discardDraft);

// History. A restore lands as a draft, never straight onto the live page.
router.get('/:key/versions', listVersions);
router.get('/:key/versions/:id', getVersion);
router.post('/:key/restore/:id', restoreVersion);

module.exports = router;
