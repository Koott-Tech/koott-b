/**
 * Razorpay settlements → expenses.
 *
 * Money paid through Razorpay doesn't reach the company bank at once: every few days (not a
 * fixed day) Razorpay pays out what it collected minus its fee + GST. Finance records each
 * payout here: gross collected and amount received. The difference is saved as an expense in
 * the "Razorpay fees" category (normal approval flow), so net profit counts the fee like any
 * other expense. "Still with Razorpay" = Razorpay payments collected − gross settled so far.
 *
 * POST /api/finance/razorpay-settlements          { date, gross, received, reference_number?, notes? }
 * GET  /api/finance/razorpay-settlements/summary
 * Needs SQL 0027 (expenses.settlement_gross / settlement_received).
 */
const { supabaseAdmin } = require('../config/supabase');
const { successResponse, errorResponse } = require('../utils/helpers');
const { channelOf, RAZORPAY_EXPENSE_CATEGORY, isRazorpayExpense } = require('../utils/paymentChannel');

const PAID_STATUSES = new Set(['success', 'paid', 'completed', 'captured']);
const money = (n) => Math.round((Number(n) || 0) * 100) / 100;

async function settlementColumnsReady() {
  const { error } = await supabaseAdmin.from('expenses').select('settlement_gross, settlement_received').limit(1);
  return !error;
}

async function allRows(table, columns, apply) {
  const out = [];
  for (let from = 0; ; from += 1000) {
    let q = supabaseAdmin.from(table).select(columns).range(from, from + 999);
    if (apply) q = apply(q);
    const { data, error } = await q;
    if (error) throw error;
    out.push(...(data || []));
    if (!data || data.length < 1000) break;
  }
  return out;
}

const createSettlement = async (req, res) => {
  try {
    if (!['finance', 'admin', 'superadmin'].includes(req.user.role)) {
      return res.status(403).json(errorResponse('Access denied. Finance role required.'));
    }
    const { date, reference_number, notes } = req.body || {};
    const gross = money(req.body?.gross);
    const received = money(req.body?.received);
    if (!date || !/^\d{4}-\d{2}-\d{2}$/.test(String(date))) {
      return res.status(400).json(errorResponse('Date the money reached the bank is required (YYYY-MM-DD).'));
    }
    if (!(gross > 0)) return res.status(400).json(errorResponse('Enter what Razorpay collected (gross), more than 0.'));
    if (!(received >= 0) || received > gross) {
      return res.status(400).json(errorResponse('Amount received must be between 0 and what Razorpay collected.'));
    }
    if (!(await settlementColumnsReady())) {
      return res.status(503).json(errorResponse('Razorpay settlements need the database update first: run backend/supabase/RUN_PENDING_0027.sql in Supabase.'));
    }
    const fee = money(gross - received);
    const nowIso = new Date().toISOString();
    const { data, error } = await supabaseAdmin.from('expenses').insert([{
      date,
      category: RAZORPAY_EXPENSE_CATEGORY,
      custom_category: null,
      description: `Razorpay settlement: collected ₹${gross.toLocaleString('en-IN')}, received ₹${received.toLocaleString('en-IN')}`,
      amount: fee,
      total_amount: fee,
      payment_method: 'razorpay',
      vendor_supplier: 'Razorpay',
      reference_number: reference_number ? String(reference_number).trim().slice(0, 120) : null,
      notes: notes ? String(notes).slice(0, 2000) : null,
      expense_type: 'additional',
      is_recurring: false,
      settlement_gross: gross,
      settlement_received: received,
      approval_status: 'pending',
      created_by: req.user.id,
      created_at: nowIso,
      updated_at: nowIso,
    }]).select('id, date, category, amount, settlement_gross, settlement_received, reference_number, approval_status').single();
    if (error) throw error;
    return res.status(201).json(successResponse(data, `Saved. Razorpay fee ₹${fee.toLocaleString('en-IN')} added to expenses (waiting for approval).`));
  } catch (e) {
    console.error('createSettlement error:', e);
    return res.status(500).json(errorResponse('Could not save the Razorpay settlement.'));
  }
};

const getSummary = async (req, res) => {
  try {
    if (!['finance', 'admin', 'superadmin'].includes(req.user.role)) {
      return res.status(403).json(errorResponse('Access denied. Finance role required.'));
    }
    const ready = await settlementColumnsReady();
    const [payments, expenses] = await Promise.all([
      allRows('payments', 'id, amount, status, payment_channel, payment_method, provider, razorpay_order_id, razorpay_payment_id'),
      allRows('expenses', ready
        ? 'id, date, category, custom_category, amount, total_amount, approval_status, status, reference_number, settlement_gross, settlement_received, created_at'
        : 'id, date, category, custom_category, amount, total_amount, approval_status, status, reference_number, created_at'),
    ]);
    const collected = payments
      .filter((p) => PAID_STATUSES.has(String(p.status || '').toLowerCase()) && channelOf(p) === 'razorpay')
      .reduce((s, p) => s + (Number(p.amount) || 0), 0);
    const rows = expenses.filter((e) => isRazorpayExpense(e) && String(e.approval_status || e.status || '').toLowerCase() !== 'rejected');
    const settledGross = rows.reduce((s, e) => s + (Number(e.settlement_gross) || 0), 0);
    const settledReceived = rows.reduce((s, e) => s + (Number(e.settlement_received) || 0), 0);
    const fees = rows.reduce((s, e) => s + (Number(e.total_amount ?? e.amount) || 0), 0);
    const recent = rows
      .sort((a, b) => String(b.date || b.created_at).localeCompare(String(a.date || a.created_at)))
      .slice(0, 20)
      .map((e) => ({
        id: e.id, date: e.date, fee: money(e.total_amount ?? e.amount),
        gross: e.settlement_gross == null ? null : money(e.settlement_gross),
        received: e.settlement_received == null ? null : money(e.settlement_received),
        reference_number: e.reference_number || null,
        approval_status: e.approval_status || e.status || 'pending',
      }));
    return res.json(successResponse({
      ready,
      collected_via_razorpay: money(collected),
      settled_gross: money(settledGross),
      settled_received: money(settledReceived),
      fees_recorded: money(fees),
      still_with_razorpay: money(Math.max(0, collected - settledGross)),
      recent,
    }));
  } catch (e) {
    console.error('razorpay settlement summary error:', e);
    return res.status(500).json(errorResponse('Could not load the Razorpay summary.'));
  }
};

module.exports = { createSettlement, getSummary };
