/**
 * Admin: a psychiatrist's consultation pricing (15 / 30 min, 15-min packages).
 * See utils/psychiatryPackages.js.
 *   GET /api/admin/psychologists/:psychologistId/psychiatry-pricing
 *   PUT /api/admin/psychologists/:psychologistId/psychiatry-pricing  { price15, price30, bundles: [{ sessions, price }] }
 */

const { getPsychiatryPricing, savePsychiatryPricing } = require('../utils/psychiatryPackages');
const { successResponse, errorResponse } = require('../utils/helpers');

const getPricing = async (req, res) => {
  try {
    const result = await getPsychiatryPricing(req.params.psychologistId);
    if (!result.found) return res.status(404).json(errorResponse('Psychologist not found'));
    return res.json(successResponse(result, 'Psychiatry pricing'));
  } catch (error) {
    console.error('Error loading psychiatry pricing:', error);
    return res.status(500).json(errorResponse('Could not load psychiatry pricing'));
  }
};

const updatePricing = async (req, res) => {
  try {
    const result = await savePsychiatryPricing(req.params.psychologistId, req.body || {});
    if (!result.success) return res.status(result.status || 400).json(errorResponse(result.message));
    return res.json(successResponse(result, result.message));
  } catch (error) {
    console.error('Error saving psychiatry pricing:', error);
    return res.status(500).json(errorResponse('Could not save psychiatry pricing'));
  }
};

module.exports = { getPricing, updatePricing };
