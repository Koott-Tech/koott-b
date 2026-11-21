/**
 * Finance targets + sales forecast.
 *
 * GET  /api/finance/forecast?from=YYYY-MM&to=YYYY-MM   (default: the current month)
 *      → target, actual, forecast for the period; per-month rows; per-day rows for one month.
 * GET  /api/finance/targets?from=YYYY-MM&to=YYYY-MM
 * PUT  /api/finance/targets { from, to, amount, mode: 'each' | 'split', notes? }
 *      'each'  — every month in from..to gets `amount`
 *      'split' — `amount` is the total for from..to, spread evenly over its months
 *      amount null/'' clears those months' targets.
 *
 * Sales = the dashboard's Total Revenue: session price, on the IST day the booking was made
 * (same sessions: paid statuses incl. refunded/cancelled, no free assessments, no
 * assessment-only psychologist). Forecast maths: utils/salesForecast.js.
 * Targets need SQL 0028 (finance_targets); the forecast works without it.
 */
const { supabaseAdmin } = require('../config/supabase');
const { successResponse, errorResponse } = require('../utils/helpers');
const { getBookingTimeColumnKey } = require('../utils/sessionsBookingTimeColumn');
const { getSessionBookingCreatedIstDateString, getSessionFinanceRevenueAmount } = require('../utils/sessionBookingCreatedAt');
const { daysInMonth, monthsBetween, forecastMonth, forecastPeriod, round2 } = require('../utils/salesForecast');

const STAFF = ['finance', 'admin', 'superadmin'];
const STATUSES = ['booked', 'pending', 'completed', 'rescheduled', 'reschedule_requested', 'no_show', 'noshow', 'refunded', 'cancelled'];
const YM = /^\d{4}-(0[1-9]|1[0-2])$/;
const todayIST = () => new Date(Date.now() + 330 * 60000).toISOString().slice(0, 10);

function period(q) {
  const cur = todayIST().slice(0, 7);
  let from = YM.test(String(q.from || '')) ? q.from : cur;
  let to = YM.test(String(q.to || '')) ? q.to : from;
  if (to < from) [from, to] = [to, from];
  const months = monthsBetween(from, to);
  if (months.length > 120) return { error: 'Pick at most 10 years.' };
  return { from, to, months };
}

async function targetsReady() {
  const { error } = await supabaseAdmin.from('finance_targets').select('month').limit(1);
  return !error;
}

async function loadTargets(months) {
  if (!(await targetsReady())) return { ready: false, map: {} };
  const { data, error } = await supabaseAdmin.from('finance_targets').select('month, amount, notes, updated_at')
    .gte('month', `${months[0]}-01`).lte('month', `${months[months.length - 1]}-01`);
  if (error) throw error;
  const map = {};
  (data || []).forEach((t) => { map[String(t.month).slice(0, 7)] = { amount: Number(t.amount) || 0, notes: t.notes || null, updated_at: t.updated_at }; });
  return { ready: true, map };
}

/** { 'YYYY-MM-DD': sales } for IST booking days in [fromYmd, toYmd]. */
async function dailySales(fromYmd, toYmd) {
  const col = await getBookingTimeColumnKey(supabaseAdmin);
  const assessmentPsych = process.env.ASSESSMENT_PSYCHOLOGIST_ID || '00000000-0000-0000-0000-000000000000';
  // A day of slack each side: IST days don't line up with UTC timestamps.
  const lo = new Date(`${fromYmd}T00:00:00+05:30`); lo.setUTCDate(lo.getUTCDate() - 1);
  const hi = new Date(`${toYmd}T23:59:59+05:30`); hi.setUTCDate(hi.getUTCDate() + 1);
  const cols = `id, price, status, created_at, session_type, psychologist_id${col === 'booking_created_at' ? ', booking_created_at' : ''}`;
  const out = {};
  for (let start = 0; ; start += 1000) {
    const { data, error } = await supabaseAdmin.from('sessions').select(cols)
      .not('psychologist_id', 'is', null)
      .neq('psychologist_id', assessmentPsych)
      .neq('session_type', 'free_assessment')
      .in('status', STATUSES)
      .gte(col, lo.toISOString()).lte(col, hi.toISOString())
      .order(col, { ascending: true })
      .range(start, start + 999);
    if (error) throw error;
    for (const s of data || []) {
      const day = getSessionBookingCreatedIstDateString(s);
      if (!day || day < fromYmd || day > toYmd) continue;
      out[day] = (out[day] || 0) + getSessionFinanceRevenueAmount(s);
    }
    if (!data || data.length < 1000) break;
  }
  return out;
}

const getForecast = async (req, res) => {
  try {
    if (!STAFF.includes(req.user.role)) return res.status(403).json(errorResponse('Access denied. Finance role required.'));
    const p = period(req.query);
    if (p.error) return res.status(400).json(errorResponse(p.error));
    const today = todayIST();
    const last = p.months[p.months.length - 1];
    const toYmd = `${last}-${String(daysInMonth(last)).padStart(2, '0')}`;
    const [sales, targets] = await Promise.all([
      dailySales(`${p.months[0]}-01`, toYmd < today ? toYmd : today),
      loadTargets(p.months),
    ]);
    const monthRows = p.months.map((ym) => forecastMonth(ym, sales, today));
    const summary = forecastPeriod(monthRows);
    const targetTotal = p.months.reduce((s, ym) => s + (targets.map[ym]?.amount || 0), 0);
    const monthsWithTarget = p.months.filter((ym) => targets.map[ym]).length;
    const target = monthsWithTarget ? round2(targetTotal) : null;

    // To reach the target: what's still needed, per remaining day (one month) or month (longer).
    let needed = null;
    if (target != null && summary.forecast != null) {
      const remaining = Math.max(0, target - summary.actual);
      if (p.months.length === 1 && monthRows[0].status === 'current') {
        const daysLeft = monthRows[0].days_in_month - monthRows[0].days_used;
        needed = { remaining: round2(remaining), per: 'day', count: daysLeft, each: daysLeft > 0 ? round2(remaining / daysLeft) : null };
      } else if (p.months.length > 1) {
        const left = monthRows.filter((m) => m.status !== 'past').length;
        needed = { remaining: round2(remaining), per: 'month', count: left, each: left > 0 ? round2(remaining / left) : null };
      }
    }
    const pct = (a, b) => (b ? Math.round((a / b) * 1000) / 10 : null);
    return res.json(successResponse({
      from: p.from,
      to: p.to,
      today,
      targets_ready: targets.ready,
      target,
      target_months_set: monthsWithTarget,
      actual: summary.actual,
      forecast: summary.forecast,
      method: summary.method,
      days_used: summary.days_used ?? null,
      days_total: summary.days_total ?? null,
      months_used: summary.months_used,
      months_total: summary.months_total,
      achieved_pct: target ? pct(summary.actual, target) : null,
      forecast_pct: target && summary.forecast != null ? pct(summary.forecast, target) : null,
      needed,
      months: monthRows.map((m) => ({
        month: m.month, status: m.status, actual: m.actual, forecast: m.forecast,
        days_used: m.days_used, days_in_month: m.days_in_month,
        target: targets.map[m.month]?.amount ?? null,
      })),
      days: p.months.length === 1 ? monthRows[0].days : [],
    }));
  } catch (e) {
    console.error('getForecast error:', e);
    return res.status(500).json(errorResponse('Could not work out the forecast.'));
  }
};

const getTargets = async (req, res) => {
  try {
    if (!STAFF.includes(req.user.role)) return res.status(403).json(errorResponse('Access denied. Finance role required.'));
    const p = period(req.query);
    if (p.error) return res.status(400).json(errorResponse(p.error));
    const t = await loadTargets(p.months);
    return res.json(successResponse({
      ready: t.ready,
      months: p.months.map((ym) => ({ month: ym, amount: t.map[ym]?.amount ?? null, notes: t.map[ym]?.notes ?? null })),
    }));
  } catch (e) {
    console.error('getTargets error:', e);
    return res.status(500).json(errorResponse('Could not load targets.'));
  }
};

const setTargets = async (req, res) => {
  try {
    if (!STAFF.includes(req.user.role)) return res.status(403).json(errorResponse('Access denied. Finance role required.'));
    const body = req.body || {};
    if (!YM.test(String(body.from || '')) || !YM.test(String(body.to || body.from || ''))) {
      return res.status(400).json(errorResponse('Pick the month(s): from and to as YYYY-MM.'));
    }
    const p = period({ from: body.from, to: body.to || body.from });
    if (p.error) return res.status(400).json(errorResponse(p.error));
    if (!(await targetsReady())) {
      return res.status(503).json(errorResponse('Targets need the database update first: run backend/supabase/RUN_PENDING_0028.sql in Supabase.'));
    }
    const clear = body.amount === null || body.amount === '' || body.amount === undefined;
    if (clear) {
      const { error } = await supabaseAdmin.from('finance_targets').delete()
        .gte('month', `${p.months[0]}-01`).lte('month', `${p.months[p.months.length - 1]}-01`);
      if (error) throw error;
      return res.json(successResponse({ cleared: p.months }, 'Targets cleared.'));
    }
    const amount = Number(body.amount);
    if (!Number.isFinite(amount) || amount < 0) return res.status(400).json(errorResponse('Target must be a number, 0 or more.'));
    const split = body.mode === 'split';
    // Split: even share per month in whole rupees, the rounding difference on the last month.
    const each = split ? Math.floor(amount / p.months.length) : amount;
    const nowIso = new Date().toISOString();
    const rows = p.months.map((ym, i) => ({
      month: `${ym}-01`,
      amount: split && i === p.months.length - 1 ? round2(amount - each * (p.months.length - 1)) : round2(each),
      notes: body.notes ? String(body.notes).slice(0, 500) : null,
      updated_by: req.user.id || null,
      updated_at: nowIso,
    }));
    const { error } = await supabaseAdmin.from('finance_targets').upsert(rows, { onConflict: 'month' });
    if (error) throw error;
    return res.json(successResponse({ months: rows.map((r) => ({ month: r.month.slice(0, 7), amount: r.amount })) },
      split ? `Target split over ${rows.length} month${rows.length > 1 ? 's' : ''}.` : `Target set for ${rows.length} month${rows.length > 1 ? 's' : ''}.`));
  } catch (e) {
    console.error('setTargets error:', e);
    return res.status(500).json(errorResponse('Could not save the target.'));
  }
};

module.exports = { getForecast, getTargets, setTargets, dailySales };
