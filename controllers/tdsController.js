/**
 * TDS on therapist payouts (fixed 10%, section 194J professional fees).
 *
 * Deducted  — payouts.tds_amount on paid payouts, in the month of payout_date (IST date).
 * Deposited — tds_deposits rows (challans), against the month the TDS was deducted in.
 * Due dates — monthly deposit by the 7th of the next month (March: 30 April);
 *             quarterly return 26Q by 31 Jul / 31 Oct / 31 Jan / 31 May.
 *
 * GET    /finance/tds?fy=2026        financial year starting April 2026 (default: current FY)
 * POST   /finance/tds/deposits       { period_month: 'YYYY-MM', deposit_date, amount, challan_no?, notes? }
 * DELETE /finance/tds/deposits/:id
 * Deposits need SQL 0030; the deducted figures work without it.
 */
const { supabaseAdmin } = require('../config/supabase');
const { successResponse, errorResponse } = require('../utils/helpers');

const STAFF = ['finance', 'admin', 'superadmin'];
const TDS_PERCENT = 10;
const pad = (n) => String(n).padStart(2, '0');
const r2 = (n) => Math.round((Number(n) || 0) * 100) / 100;
const todayIST = () => new Date(Date.now() + 330 * 60000).toISOString().slice(0, 10);
const fyStartOf = (ymd) => { const [y, m] = ymd.split('-').map(Number); return m >= 4 ? y : y - 1; };
const YMD = /^\d{4}-\d{2}-\d{2}$/;
const YM = /^\d{4}-(0[1-9]|1[0-2])$/;

function guard(req, res) {
  if (!STAFF.includes(req.user?.role)) { res.status(403).json(errorResponse('Access denied. Finance role required.')); return false; }
  return true;
}

async function depositsReady() {
  const { error } = await supabaseAdmin.from('tds_deposits').select('id').limit(1);
  return !error;
}

/** Deposit due date for TDS deducted in month 'YYYY-MM'. */
function depositDue(ym) {
  const [y, m] = ym.split('-').map(Number);
  if (m === 3) return `${y}-04-30`;
  const ny = m === 12 ? y + 1 : y; const nm = m === 12 ? 1 : m + 1;
  return `${ny}-${pad(nm)}-07`;
}
/** Quarter (1–4 of the Indian FY) for a month 'YYYY-MM', and its 26Q return due date. */
function quarterOf(ym, fy) {
  const m = Number(ym.slice(5, 7));
  const q = m >= 4 && m <= 6 ? 1 : m >= 7 && m <= 9 ? 2 : m >= 10 && m <= 12 ? 3 : 4;
  const due = { 1: `${fy}-07-31`, 2: `${fy}-10-31`, 3: `${fy + 1}-01-31`, 4: `${fy + 1}-05-31` }[q];
  const label = { 1: 'Q1 (Apr–Jun)', 2: 'Q2 (Jul–Sep)', 3: 'Q3 (Oct–Dec)', 4: 'Q4 (Jan–Mar)' }[q];
  return { q, due, label };
}

async function allRows(build) {
  const out = [];
  for (let s = 0; ; s += 1000) {
    const { data, error } = await build().range(s, s + 999);
    if (error) throw error;
    out.push(...(data || []));
    if (!data || data.length < 1000) break;
  }
  return out;
}

const getTds = async (req, res) => {
  if (!guard(req, res)) return;
  try {
    const today = todayIST();
    const fy = /^\d{4}$/.test(String(req.query.fy || '')) ? Number(req.query.fy) : fyStartOf(today);
    const from = `${fy}-04-01`; const to = `${fy + 1}-03-31`;
    const months = [];
    for (let i = 0; i < 12; i++) { const d = new Date(Date.UTC(fy, 3 + i, 1)); months.push(`${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}`); }

    const ready = await depositsReady();
    const [payouts, deposits] = await Promise.all([
      allRows(() => supabaseAdmin.from('payouts').select('id, psychologist_id, payout_date, net_payout, tds_amount, tds_percentage, status, notes')
        .gte('payout_date', from).lte('payout_date', to).order('payout_date', { ascending: true })),
      ready ? allRows(() => supabaseAdmin.from('tds_deposits').select('*').gte('period_month', `${fy}-04-01`).lte('period_month', `${fy + 1}-03-01`).order('deposit_date', { ascending: false })) : [],
    ]);
    const paid = payouts.filter((p) => String(p.status || '').toLowerCase() === 'paid');
    const psychIds = [...new Set(paid.map((p) => p.psychologist_id).filter(Boolean))];
    const names = {};
    for (let i = 0; i < psychIds.length; i += 100) {
      const { data } = await supabaseAdmin.from('psychologists').select('id, first_name, last_name, email').in('id', psychIds.slice(i, i + 100));
      (data || []).forEach((p) => { names[p.id] = { name: `${p.first_name || ''} ${p.last_name || ''}`.trim() || p.email || 'Therapist', email: p.email || null }; });
    }

    const byMonth = Object.fromEntries(months.map((m) => [m, { month: m, payouts: 0, gross: 0, tds: 0, deposited: 0, deposits: [] }]));
    const byQuarterTherapist = {};
    for (const p of paid) {
      const m = String(p.payout_date).slice(0, 7);
      if (!byMonth[m]) continue;
      const tds = Number(p.tds_amount) || 0;
      const gross = (Number(p.net_payout) || 0) + tds;
      byMonth[m].payouts += 1; byMonth[m].gross += gross; byMonth[m].tds += tds;
      const { q } = quarterOf(m, fy);
      const key = `${q}|${p.psychologist_id}`;
      const row = byQuarterTherapist[key] = byQuarterTherapist[key] || { q, psychologist_id: p.psychologist_id, ...(names[p.psychologist_id] || { name: 'Therapist', email: null }), payouts: 0, gross: 0, tds: 0, net: 0 };
      row.payouts += 1; row.gross += gross; row.tds += tds; row.net += Number(p.net_payout) || 0;
    }
    for (const d of deposits) {
      const m = String(d.period_month).slice(0, 7);
      if (!byMonth[m]) continue;
      byMonth[m].deposited += Number(d.amount) || 0;
      byMonth[m].deposits.push({ id: d.id, deposit_date: d.deposit_date, amount: r2(d.amount), challan_no: d.challan_no, section: d.section, notes: d.notes });
    }
    const monthRows = months.map((m) => {
      const x = byMonth[m];
      const outstanding = r2(x.tds - x.deposited);
      const due = depositDue(m);
      const started = `${m}-01` <= today;
      const status = !started ? 'future' : x.tds <= 0 && x.deposited <= 0 ? 'none'
        : outstanding <= 0.5 ? (x.deposited - x.tds > 0.5 ? 'over' : 'deposited')
          : today > due ? 'overdue' : 'due';
      return { month: m, quarter: quarterOf(m, fy).q, payouts: x.payouts, gross: r2(x.gross), tds: r2(x.tds), deposited: r2(x.deposited), outstanding, due, status, deposits: x.deposits };
    });
    const quarters = [1, 2, 3, 4].map((q) => {
      const ms = monthRows.filter((r) => r.quarter === q);
      const { due, label } = quarterOf(ms[0].month, fy);
      return {
        q, label, return_due: due,
        gross: r2(ms.reduce((s, r) => s + r.gross, 0)),
        tds: r2(ms.reduce((s, r) => s + r.tds, 0)),
        deposited: r2(ms.reduce((s, r) => s + r.deposited, 0)),
        therapists: Object.values(byQuarterTherapist).filter((t) => t.q === q)
          .map((t) => ({ ...t, gross: r2(t.gross), tds: r2(t.tds), net: r2(t.net) }))
          .sort((a, b) => b.tds - a.tds),
      };
    });
    const totals = {
      gross: r2(monthRows.reduce((s, r) => s + r.gross, 0)),
      tds: r2(monthRows.reduce((s, r) => s + r.tds, 0)),
      deposited: r2(monthRows.reduce((s, r) => s + r.deposited, 0)),
    };
    totals.outstanding = r2(totals.tds - totals.deposited);
    const nextDue = monthRows.find((r) => r.status === 'overdue') || monthRows.find((r) => r.status === 'due') || null;
    return res.json(successResponse({
      fy, label: `FY ${fy}-${String(fy + 1).slice(2)}`, tds_percent: TDS_PERCENT, section: '194J',
      deposits_ready: ready, totals, months: monthRows, quarters,
      next_due: nextDue && { month: nextDue.month, due: nextDue.due, amount: nextDue.outstanding, overdue: nextDue.status === 'overdue' },
      overdue_count: monthRows.filter((r) => r.status === 'overdue').length,
    }));
  } catch (e) {
    console.error('getTds error:', e);
    return res.status(500).json(errorResponse('Could not load TDS.'));
  }
};

const addDeposit = async (req, res) => {
  if (!guard(req, res)) return;
  try {
    if (!(await depositsReady())) return res.status(503).json(errorResponse('TDS deposits need the database update first: run backend/supabase/RUN_PENDING_0030.sql in Supabase.'));
    const b = req.body || {};
    const errs = [];
    if (!YM.test(String(b.period_month || ''))) errs.push('Pick the month the TDS was deducted in.');
    if (!YMD.test(String(b.deposit_date || ''))) errs.push('Pick the date it was paid.');
    else if (b.deposit_date > todayIST()) errs.push('The payment date can\'t be in the future.');
    const amount = Number(b.amount);
    if (!(amount > 0)) errs.push('Amount must be more than 0.');
    if (errs.length) return res.status(400).json(errorResponse(errs.join(' ')));
    const { data, error } = await supabaseAdmin.from('tds_deposits').insert({
      period_month: `${b.period_month}-01`,
      deposit_date: b.deposit_date,
      amount: r2(amount),
      section: '194J',
      challan_no: b.challan_no ? String(b.challan_no).trim().slice(0, 80) : null,
      notes: b.notes ? String(b.notes).slice(0, 1000) : null,
      created_by: req.user.id || null,
    }).select('*').single();
    if (error) throw error;
    return res.status(201).json(successResponse(data, 'TDS payment recorded.'));
  } catch (e) {
    console.error('addDeposit error:', e);
    return res.status(500).json(errorResponse('Could not record the TDS payment.'));
  }
};

const deleteDeposit = async (req, res) => {
  if (!guard(req, res)) return;
  try {
    if (!(await depositsReady())) return res.status(503).json(errorResponse('Run RUN_PENDING_0030.sql first.'));
    const { error, count } = await supabaseAdmin.from('tds_deposits').delete({ count: 'exact' }).eq('id', req.params.id);
    if (error) throw error;
    if (!count) return res.status(404).json(errorResponse('Not found.'));
    return res.json(successResponse({ deleted: true }, 'Removed.'));
  } catch (e) {
    console.error('deleteDeposit error:', e);
    return res.status(500).json(errorResponse('Could not remove it.'));
  }
};

/** TDS deposited on or before a date (for the Balance Sheet). 0 before SQL 0030. */
async function depositedUpTo(asOf) {
  if (!(await depositsReady())) return 0;
  const rows = await allRows(() => supabaseAdmin.from('tds_deposits').select('amount').lte('deposit_date', asOf));
  return rows.reduce((s, r) => s + (Number(r.amount) || 0), 0);
}

module.exports = { getTds, addDeposit, deleteDeposit, depositedUpTo, depositDue, quarterOf, TDS_PERCENT };
