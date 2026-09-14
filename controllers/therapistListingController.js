/**
 * Admin: the booking-page card pattern (groups A, B, B, C …). See utils/therapistListing.js.
 *   GET /api/admin/therapist-listing-pattern   → { pattern, repeat, updatedAt, preview }
 *   PUT /api/admin/therapist-listing-pattern   { pattern: [groupId, …], repeat } → same, after saving
 */

const listing = require('../utils/therapistListing');
const { successResponse, errorResponse } = require('../utils/helpers');

const getPattern = async (req, res) => {
  try {
    const [pattern, preview] = await Promise.all([listing.getListingPattern(), listing.listingPreview()]);
    return res.json(successResponse({ ...pattern, preview }, 'Booking-page order'));
  } catch (error) {
    console.error('Error loading the listing pattern:', error);
    return res.status(500).json(errorResponse('Could not load the booking-page order'));
  }
};

const savePattern = async (req, res) => {
  try {
    const result = await listing.saveListingPattern(req.body || {});
    if (!result.success) return res.status(result.status || 400).json(errorResponse(result.message));
    const [pattern, preview] = await Promise.all([listing.getListingPattern(), listing.listingPreview()]);
    return res.json(successResponse({ ...pattern, preview, message: result.message }, result.message));
  } catch (error) {
    console.error('Error saving the listing pattern:', error);
    return res.status(500).json(errorResponse('Could not save the booking-page order'));
  }
};

module.exports = { getPattern, savePattern };
