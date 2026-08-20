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

// Sensitive columns that must never reach an anonymous visitor, whatever else is added
// to the psychologists table later. Everything not in this list is considered publishable
// for the detail view (the list view stays on the narrow PUBLIC_FIELDS whitelist).
const PRIVATE_FIELDS = new Set([
  'email',
  'phone',
  'password_hash',
  'private_note_password_hash',
  'google_calendar_credentials',
  'wix_staff_id',
  'user_id',
  'bank_account_number',
  'bank_ifsc',
  'pan_number',
  'aadhaar_number',
]);

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

/**
 * GET /api/public/psychologists/:psychologistId/details
 * Full public profile — education, specialities, personality, FAQ fields — for the
 * therapist profile pages. Returns everything except PRIVATE_FIELDS, so a column added
 * to the table later shows up here rather than silently going missing, while credentials
 * stay excluded by name.
 */
router.get('/psychologists/:psychologistId/details', async (req, res) => {
  try {
    const { psychologistId } = req.params;
    if (!psychologistId) return res.status(400).json(errorResponse('psychologistId is required'));

    const { data, error } = await supabaseAdmin
      .from('psychologists')
      .select('*')
      .eq('id', psychologistId)
      .maybeSingle();

    if (error) {
      console.error('[public/psychologist details] query failed:', error.message);
      return res.status(500).json(errorResponse('Failed to fetch psychologist'));
    }
    if (!data) return res.status(404).json(errorResponse('Psychologist not found'));

    const psychologist = {};
    Object.keys(data).forEach((k) => {
      if (!PRIVATE_FIELDS.has(k)) psychologist[k] = data[k];
    });
    psychologist.name = [data.first_name, data.last_name].filter(Boolean).join(' ').trim();
    psychologist.price = data.individual_session_price ?? null;

    res.json(successResponse({ psychologist }));
  } catch (err) {
    console.error('[public/psychologist details] error:', err.message);
    res.status(500).json(errorResponse('Internal server error'));
  }
});

/**
 * GET /api/public/psychologists/:psychologistId/packages
 * Active packages offered by one therapist, for the booking widget.
 */
router.get('/psychologists/:psychologistId/packages', async (req, res) => {
  try {
    const { psychologistId } = req.params;
    if (!psychologistId) return res.status(400).json(errorResponse('psychologistId is required'));

    const { data, error } = await supabaseAdmin
      .from('packages')
      .select('id, name, package_type, session_count, price, description, is_active, psychologist_id')
      .eq('psychologist_id', psychologistId)
      .eq('is_active', true);

    if (error) {
      console.error('[public/psychologist packages] query failed:', error.message);
      return res.status(500).json(errorResponse('Failed to fetch packages'));
    }

    res.json(successResponse({ packages: data || [] }));
  } catch (err) {
    console.error('[public/psychologist packages] error:', err.message);
    res.status(500).json(errorResponse('Internal server error'));
  }
});

module.exports = router;
