/**
 * Record of access — "Log who viewed or changed a client or lead record"
 * (plans/Koott dashboards and tasks plan → Privacy and safety).
 *
 * Writes to the existing audit_logs table (utils/auditLogger) with resource
 * 'client' | 'lead' | 'session' and action 'VIEWED' | 'CHANGED' | 'CONVERTED' | 'CREATED'.
 * Never throws and never blocks the request.
 */
const auditLogger = require('./auditLogger');

function logAccess(req, { action, resource, resourceId, details }) {
  try {
    const u = req.user || {};
    auditLogger.logAction({
      userId: u.id || null,
      userEmail: u.email || null,
      userRole: u.role || null,
      action: `RECORD_${String(action).toUpperCase()}`,
      resource,
      resourceId: resourceId ? String(resourceId) : null,
      endpoint: req.originalUrl,
      method: req.method,
      details: details || null,
      ip: req.ip || req.headers['x-forwarded-for'] || null,
      userAgent: req.headers['user-agent'] || null,
    }).catch(() => {});
  } catch (_) { /* never block */ }
}

/** Route middleware: log once the request succeeded. idFrom(req) picks the record id. */
const logOnSuccess = (action, resource, idFrom) => (req, res, next) => {
  res.on('finish', () => {
    if (res.statusCode < 400) logAccess(req, { action, resource, resourceId: idFrom ? idFrom(req) : null });
  });
  next();
};

module.exports = { logAccess, logOnSuccess };
