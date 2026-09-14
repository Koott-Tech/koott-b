/**
 * Admin: a therapist's weekly working hours (IST). See utils/workingHours.js.
 *   GET /api/admin/psychologists/:psychologistId/working-hours
 *   PUT /api/admin/psychologists/:psychologistId/working-hours  { workingHours: { days } }
 */

const { getWorkingHours, saveWorkingHours } = require('../utils/workingHours');
const { successResponse, errorResponse } = require('../utils/helpers');

const getWorkingHoursHandler = async (req, res) => {
  try {
    const result = await getWorkingHours(req.params.psychologistId);
    if (!result.found) return res.status(404).json(errorResponse('Psychologist not found'));
    return res.json(successResponse(result, 'Working hours'));
  } catch (error) {
    console.error('Error loading working hours:', error);
    return res.status(500).json(errorResponse('Could not load working hours'));
  }
};

const updateWorkingHoursHandler = async (req, res) => {
  try {
    const input = req.body?.workingHours ?? req.body;
    const result = await saveWorkingHours(req.params.psychologistId, input);
    if (!result.success) return res.status(result.status || 400).json(errorResponse(result.message));
    return res.json(successResponse(result, result.message));
  } catch (error) {
    console.error('Error saving working hours:', error);
    return res.status(500).json(errorResponse('Could not save working hours'));
  }
};

module.exports = {
  getWorkingHours: getWorkingHoursHandler,
  updateWorkingHours: updateWorkingHoursHandler,
};
