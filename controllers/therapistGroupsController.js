/**
 * Therapist groups — internal admin / finance reporting. See utils/therapistGroups.js.
 *
 * Admin (routes/admin.js, CSRF + requireAdmin):
 *   GET    /api/admin/therapist-groups
 *   POST   /api/admin/therapist-groups                       { name, color?, description? }
 *   PUT    /api/admin/therapist-groups/:groupId              { name?, color?, description? }
 *   DELETE /api/admin/therapist-groups/:groupId              (members become ungrouped)
 *   PUT    /api/admin/psychologists/:psychologistId/therapist-group  { groupId | null }
 * Finance, admin, superadmin (routes/therapistGroups.js, read-only):
 *   GET    /api/therapist-groups
 *   GET    /api/therapist-groups/report?dateFrom=&dateTo=
 */

const groups = require('../utils/therapistGroups');
const { successResponse, errorResponse } = require('../utils/helpers');

const send = (res, result, okMessage) => (result.success === false
  ? res.status(result.status || 400).json(errorResponse(result.message))
  : res.json(successResponse(result, result.message || okMessage)));

const handle = (label, run) => async (req, res) => {
  try {
    return send(res, await run(req), label);
  } catch (error) {
    console.error(`Therapist groups — ${label} failed:`, error);
    return res.status(500).json(errorResponse(`Could not ${label.toLowerCase()}`));
  }
};

module.exports = {
  list: handle('Load therapist groups', () => groups.listGroups()),
  create: handle('Create the group', (req) => groups.createGroup(req.body || {})),
  update: handle('Save the group', (req) => groups.updateGroup(req.params.groupId, req.body || {})),
  remove: handle('Delete the group', (req) => groups.deleteGroup(req.params.groupId)),
  assign: handle('Move the therapist', (req) => groups.assignTherapist(req.params.psychologistId, req.body?.groupId ?? null)),
  report: handle('Build the group report', (req) => groups.groupReport({ dateFrom: req.query.dateFrom, dateTo: req.query.dateTo })),
};
