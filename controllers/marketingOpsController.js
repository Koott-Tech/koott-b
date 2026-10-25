/**
 * HTTP layer for the operations reports (/api/marketing/ops/*).
 *
 * The reports themselves are in marketingOpsReports.js; this validates the
 * window and the scope and shapes the answer. Access follows the rest of the
 * marketing dashboard — marketing, admin or superadmin, enforced on the router.
 *
 * Answers are counts and timings. The only identifiers that appear are
 * therapist and team ids, which the drill-down needs; no client names, emails
 * or session content ever leave here.
 */

const reports = require('./marketingOpsReports');

const REPORTS = {
  overview: reports.overview,
  'booking-time': reports.bookingTime,
  'session-time': reports.sessionTime,
  clients: reports.clientMix,
  'slot-openings': reports.slotOpenings,
  'slots-available': reports.slotsAvailable,
  comparison: reports.comparison,
};

const isDate = (s) => typeof s === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(s) && !Number.isNaN(Date.parse(s));

const istToday = () => new Date(Date.now() + 5.5 * 3600000).toISOString().slice(0, 10);
const addDays = (d, n) => {
  const x = new Date(`${d}T00:00:00Z`);
  x.setUTCDate(x.getUTCDate() + n);
  return x.toISOString().slice(0, 10);
};

/** A scope the reports accept: all, team:<uuid|ungrouped>, therapist:<uuid>. */
const SCOPE_RE = /^(all|team:[0-9a-f-]{8,36}|team:ungrouped|therapist:[0-9a-f-]{8,36})$/i;

/**
 * The window, defaulting to the last seven days including today.
 *
 * The presets the marketing team asked for (today, yesterday, 7 days, a month,
 * custom) are all expressible as a from/to pair, so the dashboard sends dates
 * and the API stays unaware of what the buttons are called.
 */
function windowOf(query) {
  const today = istToday();
  let to = isDate(query.to) ? query.to : today;
  let from = isDate(query.from) ? query.from : addDays(to, -6);
  if (from > to) [from, to] = [to, from];
  // A year at a time is plenty for a dashboard and keeps one request from
  // reading the whole history.
  if (Date.parse(to) - Date.parse(from) > 366 * 86400000) from = addDays(to, -366);
  return { from, to };
}

async function report(req, res) {
  const build = REPORTS[req.params.name];
  if (!build) return res.status(404).json({ success: false, message: 'Unknown report.' });

  const scope = SCOPE_RE.test(req.query.scope || '') ? req.query.scope : 'all';
  const { from, to } = windowOf(req.query);

  try {
    const data = await build({ from, to, scope });
    res.set('Cache-Control', 'private, max-age=60');
    return res.json({ success: true, scope: { from, to, scope }, data });
  } catch (e) {
    console.error(`❌ marketing ops ${req.params.name}:`, e?.message || e);
    return res.status(500).json({ success: false, message: 'Could not load this report.' });
  }
}

async function teams(req, res) {
  try {
    return res.json({ success: true, data: await reports.teams() });
  } catch (e) {
    console.error('❌ marketing ops teams:', e?.message || e);
    return res.status(500).json({ success: false, message: 'Could not load teams.' });
  }
}

async function therapists(req, res) {
  const scope = SCOPE_RE.test(req.query.scope || '') ? req.query.scope : 'all';
  try {
    return res.json({ success: true, data: await reports.therapists(scope) });
  } catch (e) {
    console.error('❌ marketing ops therapists:', e?.message || e);
    return res.status(500).json({ success: false, message: 'Could not load therapists.' });
  }
}

module.exports = { report, teams, therapists };
