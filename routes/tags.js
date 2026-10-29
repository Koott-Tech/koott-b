/**
 * The tag vocabulary the booking filters are built from (migration 0020).
 *
 * Open, like the therapist listing it serves: therapy topics, languages and
 * session types, with nobody's data in them. The kinds clients never see
 * (team, employment) are left out by the controller rather than filtered in
 * the browser.
 */

const express = require('express');
const router = express.Router();
const { publicTags } = require('../controllers/tagOptionsController');

router.get('/', publicTags);

module.exports = router;
