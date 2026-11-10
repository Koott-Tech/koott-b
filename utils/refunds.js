/**
 * Refund requests (table refund_requests, migration 0023).
 *
 * A paid session that is cancelled — by the client in their profile, by staff with
 * "Cancel & refund", or found later by the automatic-task runner — becomes one refund
 * request for Operations. Nothing is refunded here: Operations checks it and presses
 * Refund (controllers/refundsController.js), which asks Razorpay.
 *
 * createRefundRequest never throws: a request that cannot be saved must never break the
 * cancellation itself (it is logged, and the automatic-task runner tries again).
 */
const { supabaseAdmin } = require('../config/supabase');

const OPEN = ['pending', 'processing', 'failed'];
const rupees = (v) => Math.round((Number(v) || 0) * 100) / 100;

/** The payment behind a session: sessions.payment_id, else a payment row pointing at the session. */
async function paymentForSession(session) {
  if (session.payment_id) {
    const { data } = await supabaseAdmin.from('payments').select('*').eq('id', session.payment_id).maybeSingle();
    if (data) return data;
  }
  const { data } = await supabaseAdmin.from('payments').select('*').eq('session_id', session.id)
    .in('status', ['success', 'completed', 'captured', 'paid', 'refunded']).order('created_at', { ascending: false }).limit(1);
  return (data || [])[0] || null;
}

/**
 * What this one session cost the client. A package payment covers several sessions, so
 * one cancelled session suggests its share of the package.
 */
function sessionAmount(session, payment) {
  const own = Number(session.amount) || Number(session.price) || 0;
  if (!payment) return rupees(own);
  const paid = Number(payment.amount) || 0;
  const count = Number(payment.session_count) || 0;
  if (count > 1 || session.package_id || payment.package_id) {
    const share = count > 1 ? paid / count : own;
    return rupees(Math.min(paid, share || own || paid));
  }
  return rupees(Math.min(paid || own, own || paid));
}

/**
 * Open a refund request for a cancelled session (or return the open one).
 * @param {object} p
 * @param {string} p.sessionId
 * @param {'client'|'staff'|'system'} p.source
 * @param {{type:string,id:string}|null} p.requestedBy
 * @param {string} [p.reason]
 * @returns {Promise<object|null>} the request, or null when there is nothing to refund
 */
async function createRefundRequest({ sessionId, source = 'staff', requestedBy = null, reason = null }) {
  try {
    const { data: session } = await supabaseAdmin.from('sessions')
      .select('id, client_id, psychologist_id, payment_id, package_id, amount, price, status').eq('id', sessionId).maybeSingle();
    if (!session) return null;
    const { data: open } = await supabaseAdmin.from('refund_requests').select('*').eq('session_id', session.id).in('status', OPEN).maybeSingle();
    if (open) return open;

    const payment = await paymentForSession(session);
    if (payment && payment.status === 'refunded') return null; // already refunded in full
    const amount = sessionAmount(session, payment);
    if (!(amount > 0)) return null; // a free / credit session: nothing to refund

    const row = {
      session_id: session.id,
      payment_id: payment?.id || null,
      client_id: session.client_id || payment?.client_id || null,
      psychologist_id: session.psychologist_id || null,
      razorpay_payment_id: payment?.razorpay_payment_id || null,
      currency: payment?.currency || 'INR',
      amount_paid: rupees(payment ? Number(payment.amount) || amount : amount),
      amount_suggested: amount,
      source,
      reason: reason ? String(reason).slice(0, 500) : null,
      requested_by_type: requestedBy?.type || (source === 'system' ? 'system' : null),
      requested_by_id: requestedBy?.id || null,
    };
    const { data, error } = await supabaseAdmin.from('refund_requests').insert(row).select('*').single();
    if (error) {
      if (error.code === '23505') { // made a moment ago by a parallel cancel
        const again = await supabaseAdmin.from('refund_requests').select('*').eq('session_id', session.id).in('status', OPEN).maybeSingle();
        return again.data || null;
      }
      throw error;
    }
    return data;
  } catch (e) {
    if (!/does not exist|Could not find the table/i.test(e.message || '')) console.warn('⚠️ Refund request not saved:', e.message);
    return null;
  }
}

module.exports = { createRefundRequest, paymentForSession, sessionAmount, OPEN, rupees };
