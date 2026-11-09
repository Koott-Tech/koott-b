/**
 * Staff roles and what each may reach — "Koott dashboards and tasks plan".
 *
 * One email, one role, one dashboard. Roles live in users.role (free text);
 * therapists sign in from the psychologists table with role 'psychologist'.
 */

const ADMINS = ['admin', 'superadmin'];

/** Every role that works at Koott (everyone except clients). */
const STAFF_USER_ROLES = ['superadmin', 'admin', 'operations', 'hr', 'marketing', 'finance', 'event_organizer', 'staff'];

/** Roles HR may give when onboarding (superadmin is never handed out here). */
const ONBOARDABLE_ROLES = ['admin', 'operations', 'hr', 'marketing', 'finance', 'event_organizer', 'staff'];

const ROLE_LABEL = {
  superadmin: 'Superadmin', admin: 'Admin', operations: 'Operations', hr: 'HR', marketing: 'Marketing',
  finance: 'Finance', event_organizer: 'Event organizer', staff: 'Staff', psychologist: 'Therapist', client: 'Client',
};

const DASHBOARD_BY_ROLE = {
  superadmin: '/superadmin', admin: '/admin', operations: '/operations', hr: '/hr', marketing: '/marketing',
  finance: '/finance', event_organizer: '/event-organizer', staff: '/staff', psychologist: '/psychologist',
};

const isAdmin = (user) => ADMINS.includes(user?.role);
const isStaff = (user) => STAFF_USER_ROLES.includes(user?.role) || user?.role === 'psychologist';

/** The signed-in person as { type, id } — therapists are 'psychologist', everyone else 'user'. */
const personOf = (user) => (user?.role === 'psychologist'
  ? { type: 'psychologist', id: user.id }
  : { type: 'user', id: user?.id });

/** Express middleware: only these roles (admins always pass). */
const allowRoles = (...roles) => (req, res, next) => {
  const role = req.user?.role;
  if (!role) return res.status(401).json({ success: false, message: 'Authentication required' });
  if (ADMINS.includes(role) || roles.includes(role)) return next();
  return res.status(403).json({ success: false, message: 'Your role does not have access to this.' });
};

/** Any staff member, therapists included (the Tasks page is for everyone who works at Koott). */
const requireStaffMember = (req, res, next) => {
  if (!req.user) return res.status(401).json({ success: false, message: 'Authentication required' });
  if (isStaff(req.user)) return next();
  return res.status(403).json({ success: false, message: 'Staff only.' });
};

/**
 * Path rules for the /api/admin router. The first rule whose method + path match decides
 * which roles (besides admin / superadmin) may call it; no match → admins only.
 * Operations and Admin share the bookings, clients and sessions pages, so they share
 * these endpoints; HR shares therapist onboarding, people and teams.
 */
const ADMIN_ROUTE_RULES = [
  // Operations: clients, bookings, sessions, rescheduling, leads
  { methods: ['GET'], path: /^\/users(\/[^/]+)?$/, roles: ['operations', 'hr'] },
  { methods: ['POST'], path: /^\/users$/, roles: ['operations', 'hr'] },                 // new client from manual booking; HR onboarding
  { methods: ['PUT'], path: /^\/users\/[^/]+$/, roles: ['operations', 'hr'] },
  { methods: ['PUT'], path: /^\/users\/[^/]+\/(role|deactivate)$/, roles: ['hr'] },      // offboarding / role change
  { methods: ['GET'], path: /^\/(search\/users|recent-users|recent-bookings|stats\/(platform|dashboard))$/, roles: ['operations'] },
  { path: /^\/sessions(\/|$)/, roles: ['operations'] },
  { path: /^\/bookings(\/|$)/, roles: ['operations'] },
  { methods: ['GET'], path: /^\/booking-leads$/, roles: ['operations', 'marketing'] },
  { methods: ['GET'], path: /^\/reschedule-requests$/, roles: ['operations'] },
  { methods: ['DELETE'], path: /^\/assessment-sessions\/[^/]+$/, roles: ['operations'] },
  { methods: ['GET'], path: /^\/psychologists\/[^/]+\/(availability|calendar-events|blocking-options|booking-details)$/, roles: ['operations', 'hr'] },

  // HR: therapist onboarding (profile, pricing, availability, calendar), groups, tags
  { methods: ['POST'], path: /^\/psychologists$/, roles: ['hr'] },
  { methods: ['PUT'], path: /^\/psychologists\/[^/]+$/, roles: ['hr'] },
  { path: /^\/psychologists\/[^/]+\/(working-hours|date-blocks|recurring-blocks|psychiatry-pricing|therapist-group)(\/|$)/, roles: ['hr', 'operations'] },
  { path: /^\/therapist-groups(\/|$)/, roles: ['hr'] },
  { path: /^\/tags$/, roles: ['hr'] },
  { methods: ['POST'], path: /^\/availability\/update-all$/, roles: ['hr'] },
];

function adminRouteGate(req, res, next) {
  const role = req.user?.role;
  if (ADMINS.includes(role)) return next();
  const rule = ADMIN_ROUTE_RULES.find((r) => (!r.methods || r.methods.includes(req.method)) && r.path.test(req.path));
  if (rule && rule.roles.includes(role)) return next();
  return res.status(403).json({ error: 'Forbidden', message: 'Insufficient permissions' });
}

module.exports = {
  ADMINS, STAFF_USER_ROLES, ONBOARDABLE_ROLES, ROLE_LABEL, DASHBOARD_BY_ROLE,
  isAdmin, isStaff, personOf, allowRoles, requireStaffMember, adminRouteGate,
};
