const express = require('express');
const router = express.Router();
const { supabaseAdmin } = require('../config/supabase');
const { successResponse, errorResponse } = require('../utils/helpers');

/**
 * Public (unauthenticated) endpoints used by the marketing site.
 *
 * These back the therapist strips on the CMS-driven pages (counselling,
 * assessments, better-parenting). They are read-only and must never expose
 * columns beyond the whitelist below — the psychologists row carries
 * credentials, calendar tokens and private-note hashes.
 */

// Columns safe to serve to anonymous visitors.
const PUBLIC_FIELDS = [
  'id',
  'first_name',
  'last_name',
  'designation',
  'specialization',
  'area_of_expertise',
  'description',
  'experience_years',
  'languages',
  'cover_image_url',
  'profile_picture_url',
  'individual_session_price'
];

const toPublicShape = (row) => {
  const out = {};
  PUBLIC_FIELDS.forEach((f) => {
    if (row[f] !== undefined) out[f] = row[f];
  });
  // Convenience aliases the frontend cards read.
  out.name = [row.first_name, row.last_name].filter(Boolean).join(' ').trim();
  out.price = row.individual_session_price ?? null;
  return out;
};

/**
 * GET /api/public/psychologists
 * Anonymous therapist listing. The internal free-assessment account is
 * excluded server-side so its address never reaches the browser.
 */
router.get('/psychologists', async (req, res) => {
  try {
    const limit = Math.min(parseInt(req.query.limit, 10) || 50, 100);

    const { data, error } = await supabaseAdmin
      .from('psychologists')
      .select('*')
      .limit(limit);

    if (error) {
      console.error('[public/psychologists] query failed:', error.message);
      return res.status(500).json(errorResponse('Failed to fetch psychologists'));
    }

    const assessmentEmail = (
      process.env.FREE_ASSESSMENT_PSYCHOLOGIST_EMAIL || 'assessment.koott@gmail.com'
    ).toLowerCase();

    const psychologists = (data || [])
      .filter((row) => String(row.email || '').toLowerCase() !== assessmentEmail)
      .map(toPublicShape);

    res.json(successResponse({ psychologists }));
  } catch (err) {
    console.error('[public/psychologists] error:', err.message);
    res.status(500).json(errorResponse('Internal server error'));
  }
});

module.exports = router;
