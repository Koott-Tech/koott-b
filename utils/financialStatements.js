/**
 * Profit & Loss and Balance Sheet, built from what the system already records.
 *
 * Revenue / refunds / therapist fees — same rules as the finance dashboard:
 *   sessions (paid statuses incl. refunded/cancelled, no free assessments, no assessment-only
 *   psychologist) counted on the IST day the booking was made; refund = refunded, or cancelled
 *   with a price; therapist share via utils/sessionCommission (0 on refunds).
 * Other income   — income_entries by date.
 * Expenses       — approved expenses by date, grouped into P&L headings; expenses that were
 *                  recorded as a fixed asset are left out (the asset is depreciated instead).
 * Depreciation   — fixed_assets, straight line by day over the useful life, down to salvage
 *                  value, stopping on disposal; sale price − book value = gain / loss.
 * Balance Sheet (as at a date)
 *   Fixed assets (cost − accumulated depreciation) · Razorpay receivable (collected through
 *   Razorpay − gross settled) · Payable to therapists (therapist share earned − paid out) ·
 *   TDS deducted on therapist payouts · Reserves = profit from the start of the books ·
 *   everything else (bank, cash, capital, loans, deposits, GST…) from balance_sheet_items.
 * All dates are IST 'YYYY-MM-DD'.
 */
const { supabaseAdmin } = require('../config/supabase');
const { getBookingTimeColumnKey } = require('./sessionsBookingTimeColumn');
const { getSessionBookingCreatedIstDateString, getSessionFinanceRevenueAmount } = require('./sessionBookingCreatedAt');
const { computeSessionDoctorWallet, resolveFirstSessionFlags } = require('./sessionCommission');
const { channelOf, isRazorpayExpense } = require('./paymentChannel');

const STATUSES = ['booked', 'pending', 'completed', 'rescheduled', 'reschedule_requested', 'no_show', 'noshow', 'refunded', 'cancelled'];
const DAY = 864e5;
const r2 = (n) => Math.round((Number(n) || 0) * 100) / 100;
const rs = (n) => `₹${Math.round(Number(n) || 0).toLocaleString('en-IN')}`;
const ymdToMs = (ymd) => Date.parse(`${ymd}T00:00:00Z`);
const addDays = (ymd, n) => new Date(ymdToMs(ymd) + n * DAY).toISOString().slice(0, 10);
const todayIST = () => new Date(Date.now() + 330 * 60000).toISOString().slice(0, 10);
// Depreciation only for days that have passed (a filter ending later in the month mustn't book future days).
const capToday = (ymd) => { const t = todayIST(); return ymd > t ? t : ymd; };

// ---------------------------------------------------------------- expense headings
const PL_GROUPS = [
  'Employee costs',
  'Rent & utilities',
  'Marketing & advertising',
  'Software & subscriptions',
  'Travel & conveyance',
  'Payment gateway & bank charges',
  'Professional & legal fees',
  'Office & administration',
  'Repairs & maintenance',
  'Other expenses',
];
const GUESS = [
  ['Payment gateway & bank charges', /razorpay|gateway|bank charge|transaction fee|stripe|paytm fee/i],
  ['Employee costs', /salar|wage|staff|stipend|bonus|incentive|payroll|pf\b|esi\b|employee|intern/i],
  ['Rent & utilities', /rent|electric|water|internet|wifi|wi-fi|broadband|utilit|phone bill|mobile bill|recharge/i],
  ['Marketing & advertising', /market|advert|\bads?\b|meta|facebook|instagram|google ads|promotion|seo|campaign|branding|influencer/i],
  ['Software & subscriptions', /software|subscription|saas|zoom|workspace|gsuite|hosting|domain|server|aws|cloud|vercel|supabase|licen[cs]e|app\b/i],
  ['Travel & conveyance', /travel|conveyance|fuel|petrol|diesel|taxi|uber|ola\b|cab|transport|flight|train|bus\b|toll|parking|hotel|accommodation/i],
  ['Professional & legal fees', /legal|audit|account|consult|professional|\bca\b|lawyer|advocate|compliance|registration|filing/i],
  ['Repairs & maintenance', /repair|maintenance|service charge|servicing/i],
  ['Office & administration', /office|stationer|print|courier|postage|suppl|cleaning|housekeep|food|refresh|tea|snack|pantry|admin|misc/i],
];
function plGroupFor(category, override) {
  if (override && PL_GROUPS.includes(override)) return override;
  const c = String(category || '');
  for (const [g, re] of GUESS) if (re.test(c)) return g;
  return 'Other expenses';
}

// ---------------------------------------------------------------- fixed assets
const ASSET_CATEGORIES = {
  'Computers & IT equipment': 36,
  'Furniture & fixtures': 120,
  'Office equipment': 60,
  'Therapy & medical equipment': 96,
  'Electrical fittings': 120,
  Vehicles: 96,
  Other: 60,
};

/** Accumulated depreciation of one asset at the end of `ymd`. */
function accumulatedDepreciation(a, ymd) {
  if (!a || !a.purchase_date || ymd < a.purchase_date) return 0;
  const end = a.disposed_date && a.disposed_date < ymd ? a.disposed_date : ymd;
  const base = Math.max(0, (Number(a.cost) || 0) - (Number(a.salvage_value) || 0));
  const lifeDays = Math.max(1, (Number(a.useful_life_months) || 1) * 30.4375);
  const days = (ymdToMs(end) - ymdToMs(a.purchase_date)) / DAY + 1; // purchase day counts
  return Math.min(base, (base / lifeDays) * days);
}
function depreciationBetween(a, fromYmd, toYmd) {
  return accumulatedDepreciation(a, toYmd) - (fromYmd ? accumulatedDepreciation(a, addDays(fromYmd, -1)) : 0);
}
function bookValue(a, ymd) {
  if (!a || ymd < a.purchase_date) return 0;
  if (a.disposed_date && a.disposed_date <= ymd) return 0;
  return (Number(a.cost) || 0) - accumulatedDepreciation(a, ymd);
}

// ---------------------------------------------------------------- loaders
const { schemaReady } = require('./schemaReady');
function tableReady(table, cols = 'id') {
  return schemaReady(table, cols); // remembered: no round trip per request
}

async function allRows(build) {
  const out = [];
  for (let start = 0; ; start += 1000) {
    const { data, error } = await build().range(start, start + 999);
    if (error) throw error;
    out.push(...(data || []));
    if (!data || data.length < 1000) break;
  }
  return out;
}

async function loadAssets() {
  if (!(await tableReady('fixed_assets'))) return { ready: false, assets: [] };
  const assets = await allRows(() => supabaseAdmin.from('fixed_assets').select('*').order('purchase_date', { ascending: true }));
  return { ready: true, assets };
}

/** Sessions booked in [from, to] (from null = from the start) with revenue / refund / therapist share. */
async function sessionLedger(fromYmd, toYmd) {
  const col = await getBookingTimeColumnKey(supabaseAdmin);
  const assessmentPsych = process.env.ASSESSMENT_PSYCHOLOGIST_ID || '00000000-0000-0000-0000-000000000000';
  const hi = new Date(`${toYmd}T23:59:59+05:30`); hi.setUTCDate(hi.getUTCDate() + 1);
  const lo = fromYmd ? new Date(`${fromYmd}T00:00:00+05:30`) : null;
  if (lo) lo.setUTCDate(lo.getUTCDate() - 1);
  const cols = 'id, psychologist_id, client_id, session_type, package_id, price, scheduled_date, original_scheduled_date, status, payment_id, created_at, updated_at, completion_date, package_session_number, session_count, package_group_id, source'
    + (col === 'booking_created_at' ? ', booking_created_at' : '');
  const raw = await allRows(() => {
    let q = supabaseAdmin.from('sessions').select(cols)
      .not('psychologist_id', 'is', null).neq('psychologist_id', assessmentPsych)
      .neq('session_type', 'free_assessment').in('status', STATUSES);
    if (col === 'booking_created_at') {
      // No booking date saved → its created date counts (same rule as the dashboard).
      const range = (c) => [lo && `${c}.gte.${lo.toISOString()}`, `${c}.lte.${hi.toISOString()}`].filter(Boolean).join(',');
      q = q.or(`and(${range('booking_created_at')}),and(booking_created_at.is.null,${range('created_at')})`);
    } else {
      q = q.lte(col, hi.toISOString());
      if (lo) q = q.gte(col, lo.toISOString());
    }
    return q.order('created_at', { ascending: true }).order('id', { ascending: true });
  });
  const sessions = raw.filter((s) => {
    const d = getSessionBookingCreatedIstDateString(s);
    return d && d <= toYmd && (!fromYmd || d >= fromYmd);
  });
  if (!sessions.length) return { revenue: 0, refunds: 0, therapist: 0, count: 0 };

  const psychIds = [...new Set(sessions.map((s) => s.psychologist_id))];
  const completedIds = sessions.filter((s) => s.status === 'completed').map((s) => s.id);
  const chunk = (arr, n = 100) => { const o = []; for (let i = 0; i < arr.length; i += n) o.push(arr.slice(i, i + n)); return o; };
  const [rates, history, flags] = await Promise.all([
    Promise.all(chunk(psychIds).map((ids) => supabaseAdmin.from('doctor_commissions')
      .select('psychologist_id, commission_amounts, commission_amount_individual, commission_amount_package, doctor_commission_first_session, doctor_commission_followup, doctor_commission_individual, doctor_commission_first_session_package, doctor_commission_followup_package, doctor_commission_packages, effective_from')
      .eq('is_active', true).in('psychologist_id', ids).order('effective_from', { ascending: false }))),
    Promise.all(chunk(completedIds).map((ids) => supabaseAdmin.from('commission_history')
      .select('session_id, commission_amount, session_amount, payment_status').in('session_id', ids))),
    resolveFirstSessionFlags(supabaseAdmin, sessions),
  ]);
  const rateBy = {};
  rates.forEach((r) => (r.data || []).forEach((c) => { if (!rateBy[c.psychologist_id]) rateBy[c.psychologist_id] = c; }));
  const histBy = {};
  history.forEach((r) => (r.data || []).forEach((h) => { histBy[h.session_id] = h; }));

  let revenue = 0; let refunds = 0; let therapist = 0;
  for (const s of sessions) {
    const price = getSessionFinanceRevenueAmount(s);
    const refunded = s.status === 'refunded' || (s.status === 'cancelled' && parseFloat(s.price || 0) > 0);
    revenue += price;
    if (refunded) { refunds += price; continue; }
    const ch = s.status === 'completed' ? (histBy[s.id] || null) : null;
    therapist += computeSessionDoctorWallet(s, rateBy[s.psychologist_id] || null, ch, { isFirstSession: flags.isFirstSession(s) });
  }
  return { revenue, refunds, therapist, count: sessions.length };
}

async function expenseLedger(fromYmd, toYmd, capitalizedIdsOrPromise) {
  const [rows, cats, capitalizedIds] = await Promise.all([
    allRows(() => {
      let q = supabaseAdmin.from('expenses').select('id, date, category, custom_category, amount, total_amount, approval_status').eq('approval_status', 'approved').lte('date', toYmd);
      if (fromYmd) q = q.gte('date', fromYmd);
      return q;
    }),
    supabaseAdmin.from('expense_categories').select('name, pl_group').then((r) => (r.error ? supabaseAdmin.from('expense_categories').select('name') : r)),
    Promise.resolve(capitalizedIdsOrPromise),
  ]);
  const override = {};
  (cats.data || []).forEach((c) => { override[String(c.name).toLowerCase()] = c.pl_group || null; });
  const groups = {}; let total = 0; let capitalized = 0;
  for (const e of rows) {
    const amt = parseFloat(e.total_amount || e.amount || 0) || 0;
    if (capitalizedIds.has(e.id)) { capitalized += amt; continue; }
    const cat = (e.custom_category && e.custom_category.trim()) || e.category || 'Uncategorised';
    const g = isRazorpayExpense(e) ? 'Payment gateway & bank charges' : plGroupFor(cat, override[String(cat).toLowerCase()]);
    groups[g] = groups[g] || { total: 0, categories: {} };
    groups[g].total += amt;
    groups[g].categories[cat] = (groups[g].categories[cat] || 0) + amt;
    total += amt;
  }
  return { total, groups, capitalized };
}

async function incomeLedger(fromYmd, toYmd) {
  const rows = await allRows(() => {
    let q = supabaseAdmin.from('income_entries').select('*').lte('date', toYmd);
    if (fromYmd) q = q.gte('date', fromYmd);
    return q;
  }).catch(() => []);
  const bySource = {}; let total = 0;
  for (const r of rows) {
    const amt = parseFloat(r.amount || 0) || 0;
    const src = r.income_source || r.source || 'Other income';
    bySource[src] = (bySource[src] || 0) + amt;
    total += amt;
  }
  return { total, bySource };
}

// ---------------------------------------------------------------- statements
/** Profit & Loss for [from, to]. from null = from the start of the books. */
async function profitAndLoss(fromYmd, toYmd, preloaded = {}) {
  // Everything at once: assets, sessions, expenses, income (each is its own query).
  const assetsP = preloaded.assets ? Promise.resolve({ assets: preloaded.assets }) : (preloaded.assetsP || loadAssets());
  const capIdsP = assetsP.then(({ assets: a }) => new Set(a.map((x) => x.expense_id).filter(Boolean)));
  const [{ assets }, s, ex, inc] = await Promise.all([assetsP, sessionLedger(fromYmd, toYmd), expenseLedger(fromYmd, toYmd, capIdsP), incomeLedger(fromYmd, toYmd)]);
  let depreciation = 0; let disposalGain = 0;
  const depByCategory = {};
  for (const a of assets) {
    const d = fromYmd && fromYmd > capToday(toYmd) ? 0 : depreciationBetween(a, fromYmd, capToday(toYmd));
    if (d > 0) { depreciation += d; depByCategory[a.category] = (depByCategory[a.category] || 0) + d; }
    if (a.disposed_date && a.disposed_date <= toYmd && (!fromYmd || a.disposed_date >= fromYmd)) {
      disposalGain += (Number(a.disposal_amount) || 0) - ((Number(a.cost) || 0) - accumulatedDepreciation(a, a.disposed_date));
    }
  }
  const netRevenue = s.revenue - s.refunds;
  const otherIncome = inc.total + Math.max(0, disposalGain);
  const totalIncome = netRevenue + otherIncome;
  const grossProfit = netRevenue - s.therapist;
  const lossOnDisposal = Math.max(0, -disposalGain);
  const totalExpenses = s.therapist + ex.total + depreciation + lossOnDisposal;
  const netProfit = totalIncome - totalExpenses;
  const groupList = PL_GROUPS.filter((g) => ex.groups[g]).map((g) => ({
    group: g,
    amount: r2(ex.groups[g].total),
    categories: Object.entries(ex.groups[g].categories).sort((a, b) => b[1] - a[1]).map(([name, amount]) => ({ name, amount: r2(amount) })),
  }));
  return {
    from: fromYmd, to: toYmd,
    income: {
      session_fees: r2(s.revenue),
      refunds: r2(s.refunds),
      revenue_from_operations: r2(netRevenue),
      other_income: Object.entries(inc.bySource).map(([name, amount]) => ({ name, amount: r2(amount) }))
        .concat(disposalGain > 0 ? [{ name: 'Gain on sale of fixed assets', amount: r2(disposalGain) }] : []),
      other_income_total: r2(otherIncome),
      total: r2(totalIncome),
    },
    expenses: {
      therapist_fees: r2(s.therapist),
      operating: groupList,
      operating_total: r2(ex.total),
      depreciation: r2(depreciation),
      depreciation_by_category: Object.entries(depByCategory).map(([name, amount]) => ({ name, amount: r2(amount) })),
      loss_on_disposal: r2(lossOnDisposal),
      total: r2(totalExpenses),
    },
    gross_profit: r2(grossProfit),
    gross_margin_pct: netRevenue ? Math.round((grossProfit / netRevenue) * 1000) / 10 : null,
    net_profit: r2(netProfit),
    net_margin_pct: totalIncome ? Math.round((netProfit / totalIncome) * 1000) / 10 : null,
    capitalized_expenses: r2(ex.capitalized),
    sessions_counted: s.count,
  };
}

const SECTIONS = ['cash_bank', 'current_asset', 'non_current_asset', 'current_liability', 'non_current_liability', 'equity'];

async function manualItemsAsOf(asOf) {
  if (!(await tableReady('balance_sheet_items'))) return { ready: false, bySection: {} };
  const rows = await allRows(() => supabaseAdmin.from('balance_sheet_items').select('*').lte('as_of', asOf).order('as_of', { ascending: false }));
  const latest = new Map();
  for (const r of rows) {
    const k = `${r.section}|${String(r.name).trim().toLowerCase()}`;
    if (!latest.has(k)) latest.set(k, r);
  }
  const bySection = Object.fromEntries(SECTIONS.map((s) => [s, []]));
  for (const r of latest.values()) bySection[r.section]?.push({ id: r.id, name: r.name, amount: r2(r.amount), as_of: r.as_of, notes: r.notes || null });
  Object.values(bySection).forEach((l) => l.sort((a, b) => a.name.localeCompare(b.name)));
  return { ready: true, bySection };
}

async function razorpayReceivable(asOf) {
  const [payments, settlements] = await Promise.all([
    allRows(() => supabaseAdmin.from('payments').select('id, amount, status, payment_channel, payment_method, provider, razorpay_order_id, razorpay_payment_id, completed_at, created_at'))
      .catch(() => allRows(() => supabaseAdmin.from('payments').select('id, amount, status, payment_method, provider, razorpay_order_id, razorpay_payment_id, completed_at, created_at'))),
    allRows(() => supabaseAdmin.from('expenses').select('id, date, category, custom_category, settlement_gross, approval_status').lte('date', asOf)).catch(() => []),
  ]);
  const ist = (iso) => (iso ? new Date(Date.parse(iso) + 330 * 60000).toISOString().slice(0, 10) : null);
  const collected = payments
    .filter((p) => ['success', 'paid', 'completed', 'captured'].includes(String(p.status || '').toLowerCase()) && channelOf(p) === 'razorpay')
    .filter((p) => { const d = ist(p.completed_at || p.created_at); return d && d <= asOf; })
    .reduce((s, p) => s + (Number(p.amount) || 0), 0);
  const settled = settlements
    .filter((e) => isRazorpayExpense(e) && String(e.approval_status || '').toLowerCase() !== 'rejected')
    .reduce((s, e) => s + (Number(e.settlement_gross) || 0), 0);
  return Math.max(0, collected - settled);
}

async function therapistPayouts(asOf) {
  const rows = await allRows(() => supabaseAdmin.from('payouts').select('net_payout, tds_amount, status, payout_date').lte('payout_date', asOf)).catch(() => []);
  let paid = 0; let tds = 0;
  for (const p of rows) {
    if (String(p.status || '').toLowerCase() !== 'paid') continue;
    const t = Number(p.tds_amount) || 0;
    paid += (Number(p.net_payout) || 0) + t; // gross settled with the therapist
    tds += t;
  }
  return { paid, tds };
}

/** Balance Sheet as at `asOf`. */
async function balanceSheet(asOf) {
  const assetsP = loadAssets();
  const { depositedUpTo } = require('../controllers/tdsController');
  const [assetsRes, pl, manual, rzp, pay, tdsDeposited] = await Promise.all([
    assetsP,
    profitAndLoss(null, asOf, { assetsP }),
    manualItemsAsOf(asOf),
    razorpayReceivable(asOf),
    therapistPayouts(asOf),
    depositedUpTo(asOf).catch(() => 0),
  ]);
  const earned = pl.expenses.therapist_fees; // therapist share of everything booked to date
  const live = assetsRes.assets.filter((a) => a.purchase_date <= asOf && !(a.disposed_date && a.disposed_date <= asOf));
  const byCat = {};
  for (const a of live) {
    const c = byCat[a.category] = byCat[a.category] || { name: a.category, cost: 0, depreciation: 0, net: 0, count: 0 };
    const dep = accumulatedDepreciation(a, capToday(asOf));
    c.cost += Number(a.cost) || 0; c.depreciation += dep; c.net += (Number(a.cost) || 0) - dep; c.count += 1;
  }
  const fixed = Object.values(byCat).map((c) => ({ ...c, cost: r2(c.cost), depreciation: r2(c.depreciation), net: r2(c.net) }));
  const sum = (l) => r2(l.reduce((s, x) => s + (Number(x.amount ?? x.net) || 0), 0));
  const m = manual.bySection;

  const nonCurrentAssets = [
    ...fixed.map((f) => ({ name: `${f.name} (net)`, amount: f.net, computed: true, detail: `Cost ${rs(f.cost)} − depreciation ${rs(f.depreciation)}` })),
    ...(m.non_current_asset || []),
  ];
  const currentAssets = [
    ...(m.cash_bank || []).map((x) => ({ ...x, kind: 'cash_bank' })),
    { name: 'Receivable from Razorpay (not yet settled)', amount: r2(rzp), computed: true },
    ...(m.current_asset || []),
  ];
  const therapistPayable = r2(earned - pay.paid);
  const currentLiabilities = [
    { name: 'Payable to therapists', amount: therapistPayable, computed: true, detail: `Earned ${rs(earned)} − paid ${rs(pay.paid)}` },
    { name: 'TDS payable (deducted from therapists, not yet paid to government)', amount: r2(pay.tds - tdsDeposited), computed: true, detail: `Deducted ${rs(pay.tds)} − paid to government ${rs(tdsDeposited)} (Finance → TDS)` },
    ...(m.current_liability || []),
  ];
  const nonCurrentLiabilities = [...(m.non_current_liability || [])];
  const equity = [
    ...(m.equity || []),
    { name: 'Reserves & surplus (profit to date)', amount: pl.net_profit, computed: true },
  ];
  const totals = {
    non_current_assets: sum(nonCurrentAssets),
    current_assets: sum(currentAssets),
    current_liabilities: sum(currentLiabilities),
    non_current_liabilities: sum(nonCurrentLiabilities),
    equity: sum(equity),
  };
  totals.assets = r2(totals.non_current_assets + totals.current_assets);
  totals.liabilities = r2(totals.current_liabilities + totals.non_current_liabilities);
  totals.equity_and_liabilities = r2(totals.equity + totals.liabilities);
  totals.difference = r2(totals.assets - totals.equity_and_liabilities);
  return {
    as_of: asOf,
    ready: { fixed_assets: assetsRes.ready, manual_items: manual.ready },
    assets: { non_current: nonCurrentAssets, current: currentAssets },
    liabilities: { non_current: nonCurrentLiabilities, current: currentLiabilities },
    equity,
    fixed_assets: fixed,
    totals,
    cash_bank_entered: (m.cash_bank || []).length > 0,
  };
}

/** For the dashboard: depreciation in a range + ids of expenses recorded as assets. */
async function assetAdjustments(fromYmd, toYmd) {
  const { assets } = await loadAssets();
  let depreciation = 0;
  const end = capToday(toYmd);
  if (!fromYmd || fromYmd <= end) for (const a of assets) depreciation += Math.max(0, depreciationBetween(a, fromYmd, end));
  return { depreciation, capitalizedIds: new Set(assets.map((a) => a.expense_id).filter(Boolean)) };
}

module.exports = {
  PL_GROUPS, ASSET_CATEGORIES, SECTIONS,
  plGroupFor, accumulatedDepreciation, depreciationBetween, bookValue,
  profitAndLoss, balanceSheet, assetAdjustments, sessionLedger, tableReady,
};
