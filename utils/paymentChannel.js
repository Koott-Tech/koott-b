/**
 * How a payment reached us, and what it cost to receive.
 *
 *   'razorpay' — paid through Razorpay (website checkout, or a Razorpay payment link sent by
 *                Operations/Admin). Razorpay keeps its fee (fee + GST) and settles the rest to
 *                the company account a few days later.
 *   'direct'   — paid straight into the company account (UPI to our number, bank transfer, cash,
 *                cheque…). No gateway fee.
 *
 * Fee, in rupees, in this order:
 *   1. payments.gateway_fee (from Razorpay's payment entity, or typed in for a payment link)
 *   2. fee found in the stored Razorpay response (paise)
 *   3. an estimate: amount × RAZORPAY_FEE_PERCENT (default 2.36 = 2% + 18% GST), flagged
 *
 * The company bears the fee: therapist commission is worked out on the session price as before;
 * the fee only comes off the company's side (net profit).
 * Columns come from SQL 0026; everything here also works before it is run (derived values).
 */
const { supabaseAdmin } = require('../config/supabase');

const FEE_PERCENT = (() => {
  const n = parseFloat(process.env.RAZORPAY_FEE_PERCENT);
  return Number.isFinite(n) && n >= 0 && n < 20 ? n : 2.36;
})();

// Manual-booking methods that go through Razorpay (everything else lands in our account directly).
const RAZORPAY_METHODS = new Set(['razorpay', 'razorpay_link', 'payment_link']);

const parseJson = (v) => {
  if (!v) return null;
  if (typeof v === 'object') return v;
  try { return JSON.parse(v); } catch { return null; }
};

/** 'razorpay' | 'direct' */
function channelOf(p) {
  if (!p) return null;
  if (p.payment_channel === 'razorpay' || p.payment_channel === 'direct') return p.payment_channel;
  const method = String(p.payment_method || '').toLowerCase();
  if (RAZORPAY_METHODS.has(method)) return 'razorpay';
  if (p.razorpay_payment_id || p.razorpay_order_id) return 'razorpay';
  if (String(p.provider || '').toLowerCase() === 'razorpay') return 'razorpay';
  return 'direct';
}

/** Fee in paise from a stored Razorpay response, or null. */
function feeFromResponse(resp) {
  const r = parseJson(resp);
  if (!r) return null;
  const entity = r.payment?.entity || r.entity || r;
  const fee = Number(entity?.fee);
  return Number.isFinite(fee) && fee > 0 ? fee : null;
}

/** { channel, fee, estimated } — fee in rupees, 0 for direct. */
function feeOf(p) {
  const channel = channelOf(p);
  if (channel !== 'razorpay') return { channel, fee: 0, estimated: false };
  const stored = p.gateway_fee;
  if (stored !== null && stored !== undefined && stored !== '' && Number.isFinite(Number(stored))) {
    return { channel, fee: Math.max(0, Number(stored)), estimated: false };
  }
  const paise = feeFromResponse(p.razorpay_response);
  if (paise !== null) return { channel, fee: paise / 100, estimated: false };
  const amount = Number(p.amount) || 0;
  return { channel, fee: Math.round(amount * FEE_PERCENT) / 100, estimated: true };
}

/** Columns for the channel from a manual booking's chosen method (+ optional known fee). */
function manualChannelFields(method, feeInput) {
  const m = String(method || '').toLowerCase();
  const channel = (m === 'razorpay' || RAZORPAY_METHODS.has(m)) ? 'razorpay' : 'direct'; // 'direct' passes through
  const out = { payment_channel: channel };
  const fee = parseFloat(feeInput);
  if (channel === 'razorpay' && Number.isFinite(fee) && fee >= 0) out.gateway_fee = Math.round(fee * 100) / 100;
  if (channel === 'direct') out.gateway_fee = 0;
  return out;
}

let columnsReady = null; // cached probe: do payments.payment_channel / gateway_fee exist (SQL 0026)?
async function channelColumnsReady() {
  if (columnsReady !== null) return columnsReady;
  const { error } = await supabaseAdmin.from('payments').select('payment_channel, gateway_fee').limit(1);
  columnsReady = !error;
  if (error) setTimeout(() => { columnsReady = null; }, 5 * 60 * 1000).unref?.();
  return columnsReady;
}

/** Strip the new columns from a payments insert/update when SQL 0026 hasn't been run. */
async function withChannelFields(row, fields) {
  if (!fields) return row;
  return (await channelColumnsReady()) ? { ...row, ...fields } : row;
}

/** After Razorpay captures a payment: store channel + Razorpay's real fee. Never throws. */
async function recordRazorpayFee(paymentRowId, entity) {
  try {
    if (!paymentRowId || !(await channelColumnsReady())) return;
    const patch = { payment_channel: 'razorpay' };
    const fee = Number(entity?.fee);
    if (Number.isFinite(fee) && fee > 0) patch.gateway_fee = fee / 100;
    await supabaseAdmin.from('payments').update(patch).eq('id', paymentRowId);
  } catch (e) {
    console.warn('recordRazorpayFee (non-blocking):', e?.message || e);
  }
}

/** Manual booking / edit: store the channel (and a known Razorpay fee) for a payment. Never throws. */
async function markManualChannel(paymentRowId, method, feeInput) {
  try {
    if (!paymentRowId || !(await channelColumnsReady())) return;
    await supabaseAdmin.from('payments').update(manualChannelFields(method, feeInput)).eq('id', paymentRowId);
  } catch (e) {
    console.warn('markManualChannel (non-blocking):', e?.message || e);
  }
}

const PAYMENT_FEE_COLUMNS = 'id, amount, payment_method, provider, razorpay_order_id, razorpay_payment_id, razorpay_response, package_group_id';

/**
 * Payments behind a list of sessions → Map(sessionId → { channel, fee, estimated, paymentAmount }).
 * A session finds its payment by payment_id, or (package sessions) by package_group_id.
 */
async function paymentsForSessions(sessions) {
  const list = sessions || [];
  const out = new Map();
  if (!list.length) return out;
  const ready = await channelColumnsReady();
  const cols = ready ? `${PAYMENT_FEE_COLUMNS}, payment_channel, gateway_fee` : PAYMENT_FEE_COLUMNS;
  const chunked = async (column, ids) => {
    const unique = [...new Set(ids.filter(Boolean))];
    const rows = [];
    for (let i = 0; i < unique.length; i += 100) {
      const { data } = await supabaseAdmin.from('payments').select(cols).in(column, unique.slice(i, i + 100));
      if (data) rows.push(...data);
    }
    return rows;
  };
  const [byId, byGroup] = await Promise.all([
    chunked('id', list.map((s) => s.payment_id)),
    chunked('package_group_id', list.filter((s) => !s.payment_id).map((s) => s.package_group_id)),
  ]);
  const idMap = new Map(byId.map((p) => [p.id, p]));
  const groupMap = new Map();
  byGroup.forEach((p) => { if (p.package_group_id && !groupMap.has(p.package_group_id)) groupMap.set(p.package_group_id, p); });
  for (const s of list) {
    const p = (s.payment_id && idMap.get(s.payment_id)) || (s.package_group_id && groupMap.get(s.package_group_id)) || null;
    if (!p) continue;
    out.set(s.id, { ...feeOf(p), paymentAmount: Number(p.amount) || 0 });
  }
  return out;
}

/**
 * Fee share for one session: the payment's fee spread over its sessions by price, so a package
 * fee lands on each package session in proportion (sums back to the payment's fee).
 */
function sessionFeeShare(info, sessionPrice) {
  if (!info || info.channel !== 'razorpay' || !info.fee) return 0;
  const price = Number(sessionPrice) || 0;
  if (!info.paymentAmount || info.paymentAmount <= price) return info.fee;
  return (info.fee * price) / info.paymentAmount;
}

module.exports = {
  FEE_PERCENT,
  RAZORPAY_METHODS,
  channelOf,
  feeOf,
  manualChannelFields,
  channelColumnsReady,
  withChannelFields,
  recordRazorpayFee,
  markManualChannel,
  paymentsForSessions,
  sessionFeeShare,
};
