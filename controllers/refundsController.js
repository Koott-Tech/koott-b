/**
 * /api/refunds — Operations' refund requests (table refund_requests, migration 0023).
 *
 *   GET  /api/refunds/count        the number on the header icon (pending + failed)
 *   GET  /api/refunds?status=open  the list in the popup (open | done | all)
 *   POST /api/refunds/:id/refund   { amount, note } → Razorpay refunds the payment
 *   POST /api/refunds/:id/reject   { note }         → no refund (e.g. outside the policy)
 *
 * Pressing Refund: the request is claimed first (only one press wins), Razorpay is asked to
 * refund, and the request becomes "processing" (or "refunded" when Razorpay says it is
 * already processed). Razorpay's refund.processed / refund.failed webhook finishes it
 * (razorpayWebhookController → refundWebhook). A failed refund can be tried again.
 */
const { supabaseAdmin } = require('../config/supabase');
const { personOf, UUID_RE } = require('../utils/staffRoles');
const { key, namesFor, isMissingTable } = require('../utils/people');
const { rupees } = require('../utils/refunds');

const NOT_READY = 'Refund requests need backend/supabase/RUN_PENDING_0023.sql to be run in Supabase.';
const ok = (res, data, status = 200) => res.status(status).json({ success: true, data });
const fail = (res, status, message, extra) => res.status(status).json({ success: false, message, ...(extra || {}) });
const handle = (res, e, what) => {
  if (isMissingTable(e)) return fail(res, 503, NOT_READY);
  console.error(`refunds: ${what}:`, e?.message || e);
  return fail(res, 500, `Could not ${what}.`);
};
const ATTENTION = ['pending', 'failed'];
const clientRef = (id) => (id ? `K-${String(id).replace(/-/g, '').slice(0, 6).toUpperCase()}` : null);

async function count(req, res) {
  try {
    // Not a HEAD request: on a missing table HEAD answers 204 with no error (the badge would say 0).
    const { count: n, error } = await supabaseAdmin.from('refund_requests').select('id', { count: 'exact' }).in('status', ATTENTION).limit(1);
    if (error) return handle(res, error, 'count refund requests');
    return ok(res, { open: n || 0 });
  } catch (e) {
    return handle(res, e, 'count refund requests');
  }
}

async function list(req, res) {
  try {
    const view = String(req.query.status || 'open');
    let q = supabaseAdmin.from('refund_requests').select('*').order('created_at', { ascending: false }).limit(200);
    if (view === 'open') q = q.in('status', ['pending', 'failed', 'processing']);
    else if (view === 'done') q = q.in('status', ['refunded', 'rejected']);
    const { data, error } = await q;
    if (error) return handle(res, error, 'load refund requests');
    const rows = data || [];
    const ids = (k) => [...new Set(rows.map((r) => r[k]).filter(Boolean))];
    const [sessions, clients, psychs, payments] = await Promise.all([
      ids('session_id').length ? supabaseAdmin.from('sessions').select('id, scheduled_date, scheduled_time, session_type, status, updated_at').in('id', ids('session_id')) : { data: [] },
      ids('client_id').length ? supabaseAdmin.from('clients').select('id, first_name, last_name, phone_number, email').in('id', ids('client_id')) : { data: [] },
      ids('psychologist_id').length ? supabaseAdmin.from('psychologists').select('id, first_name, last_name').in('id', ids('psychologist_id')) : { data: [] },
      ids('payment_id').length ? supabaseAdmin.from('payments').select('id, amount, status, payment_method, created_at, razorpay_order_id').in('id', ids('payment_id')) : { data: [] },
    ]);
    const by = (r) => new Map((r.data || []).map((x) => [x.id, x]));
    const S = by(sessions); const C = by(clients); const P = by(psychs); const PAY = by(payments);
    const people = await namesFor(rows.flatMap((r) => [
      r.requested_by_type && r.requested_by_type !== 'client' && r.requested_by_id ? { type: r.requested_by_type, id: r.requested_by_id } : null,
      r.decided_by ? { type: 'user', id: r.decided_by } : null,
    ]).filter(Boolean));
    const nm = (x) => (x ? `${x.first_name || ''} ${x.last_name || ''}`.trim() : null);
    return ok(res, {
      requests: rows.map((r) => {
        const s = S.get(r.session_id); const c = C.get(r.client_id); const pay = PAY.get(r.payment_id);
        return {
          ...r,
          clientRef: clientRef(r.client_id),
          clientName: nm(c) || null, clientPhone: c?.phone_number || null, clientEmail: c?.email || null,
          therapistName: nm(P.get(r.psychologist_id)),
          session: s ? { date: s.scheduled_date, time: String(s.scheduled_time || '').slice(0, 5), type: s.session_type, status: s.status, cancelledAt: s.updated_at } : null,
          payment: pay ? { amount: Number(pay.amount) || 0, status: pay.status, method: pay.payment_method, paidAt: pay.created_at, orderId: pay.razorpay_order_id } : null,
          requestedBy: r.source === 'client' ? 'The client' : r.source === 'system' ? 'Found automatically'
            : people[key(r.requested_by_type, r.requested_by_id)]?.name || 'Staff',
          decidedBy: r.decided_by ? people[key('user', r.decided_by)]?.name || null : null,
          canRefund: Boolean(r.razorpay_payment_id) && ['pending', 'failed'].includes(r.status),
        };
      }),
    });
  } catch (e) {
    return handle(res, e, 'load refund requests');
  }
}

/** Mark the payment and the session refunded once Razorpay has the money going back. */
async function markRefunded(reqRow, amount, full) {
  const now = new Date().toISOString();
  if (reqRow.payment_id && full) {
    await supabaseAdmin.from('payments').update({ status: 'refunded', updated_at: now }).eq('id', reqRow.payment_id).then(() => {}, () => {});
  }
  if (reqRow.session_id) {
    await supabaseAdmin.from('sessions').update({ status: 'refunded', updated_at: now }).eq('id', reqRow.session_id).then(() => {}, () => {});
  }
  // The automatic "Process the refund" task (if one was made) is done now.
  if (reqRow.session_id) {
    await supabaseAdmin.from('tasks').update({ status: 'done', completed_at: now, updated_at: now })
      .eq('auto_key', `refund:${reqRow.session_id}`).not('status', 'in', '(done,cancelled)').then(() => {}, () => {});
  }
}

async function refund(req, res) {
  const me = personOf(req.user);
  try {
    if (!UUID_RE.test(String(req.params.id || ''))) return fail(res, 404, 'Refund request not found.');
    const { data: r, error } = await supabaseAdmin.from('refund_requests').select('*').eq('id', req.params.id).maybeSingle();
    if (error) return handle(res, error, 'refund');
    if (!r) return fail(res, 404, 'Refund request not found.');
    if (!['pending', 'failed'].includes(r.status)) return fail(res, 409, r.status === 'refunded' ? 'This was already refunded.' : `This request is ${r.status}.`);
    if (!r.razorpay_payment_id) return fail(res, 400, 'This booking was not paid through Razorpay. Refund it by hand (or as credit), then mark it with "Don\'t refund" and a note.');

    const amount = rupees(req.body?.amount ?? r.amount_suggested);
    if (!(amount > 0)) return fail(res, 400, 'Enter an amount above ₹0.');
    if (amount > Number(r.amount_paid)) return fail(res, 400, `That is more than was paid (₹${Number(r.amount_paid).toLocaleString('en-IN')}).`);
    const note = req.body?.note ? String(req.body.note).slice(0, 500) : null;

    // What Razorpay still holds for this payment (another refund may have gone out already).
    const { getRazorpayInstance } = require('../config/razorpay');
    const rzp = getRazorpayInstance();
    let rzpPayment;
    try { rzpPayment = await rzp.payments.fetch(r.razorpay_payment_id); } catch (e) {
      return fail(res, 502, `Razorpay could not find this payment: ${e?.error?.description || e?.message || 'unknown error'}`);
    }
    if (rzpPayment.status !== 'captured' && rzpPayment.status !== 'refunded') return fail(res, 400, `Razorpay shows this payment as "${rzpPayment.status}", so it cannot be refunded.`);
    const left = (Number(rzpPayment.amount) - Number(rzpPayment.amount_refunded || 0)) / 100;
    if (amount > left + 0.001) return fail(res, 400, `Only ₹${left.toLocaleString('en-IN')} of this payment is left to refund.`);

    // Claim it: only one press of Refund goes to Razorpay.
    const now = new Date().toISOString();
    const { data: claimed, error: claimErr } = await supabaseAdmin.from('refund_requests')
      .update({ status: 'processing', decided_by: req.user.id, decided_at: now, decision_note: note, failure_reason: null, updated_at: now })
      .eq('id', r.id).in('status', ['pending', 'failed']).select('id');
    if (claimErr) return handle(res, claimErr, 'refund');
    if (!claimed || !claimed.length) return fail(res, 409, 'Someone else is refunding this right now.');

    // A refund already made for this request (e.g. the server stopped mid-way last time) is reused.
    let made = null;
    try {
      const existing = await rzp.payments.fetchMultipleRefund(r.razorpay_payment_id);
      made = (existing?.items || []).find((x) => x?.notes?.refund_request_id === r.id && x.status !== 'failed') || null;
    } catch (_) { /* listing is a safety net only */ }
    if (!made) {
      try {
        made = await rzp.payments.refund(r.razorpay_payment_id, {
          amount: Math.round(amount * 100), // paise
          speed: 'normal',
          receipt: `rr_${r.id.replace(/-/g, '').slice(0, 30)}`,
          notes: { refund_request_id: r.id, session_id: r.session_id || '', approved_by: key(me.type, me.id) },
        });
      } catch (e) {
        const why = e?.error?.description || e?.message || 'Razorpay refused the refund.';
        await supabaseAdmin.from('refund_requests').update({ status: 'failed', failure_reason: String(why).slice(0, 500), updated_at: new Date().toISOString() }).eq('id', r.id);
        require('../utils/accessLog').logAccess(req, { action: 'changed', resource: 'session', resourceId: r.session_id, details: { refund: 'failed', amount } });
        return fail(res, 502, `Razorpay did not refund: ${why}`);
      }
    }

    const processed = made.status === 'processed';
    const full = Math.abs(amount - (Number(rzpPayment.amount) - Number(rzpPayment.amount_refunded || 0)) / 100) < 0.01;
    const { data: updated } = await supabaseAdmin.from('refund_requests').update({
      status: processed ? 'refunded' : 'processing', razorpay_refund_id: made.id, razorpay_status: made.status,
      amount_refunded: rupees(Number(made.amount) / 100), refunded_at: processed ? new Date().toISOString() : null, updated_at: new Date().toISOString(),
    }).eq('id', r.id).select('*').single();
    await markRefunded(r, amount, full);
    require('../utils/accessLog').logAccess(req, { action: 'changed', resource: 'session', resourceId: r.session_id, details: { refund: made.id, amount } });

    // Tell the client (never demo addresses)
    try {
      const { data: c } = await supabaseAdmin.from('clients').select('first_name, email').eq('id', r.client_id).maybeSingle();
      if (c?.email && !/\.invalid$/i.test(c.email) && process.env.REFUND_EMAILS !== 'off') {
        await require('../utils/emailService').sendEmail({
          to: c.email,
          subject: 'Your Koott refund is on its way',
          html: `<p>Hi ${String(c.first_name || '').replace(/[&<>"']/g, '')},</p><p>We have refunded ₹${amount.toLocaleString('en-IN')} for your cancelled session. It usually reaches your account in 5–7 working days.</p><p>Refund reference: ${made.id}</p><p>— Team Koott</p>`,
        });
      }
    } catch (e) { console.warn('refund email not sent:', e.message); }

    return ok(res, { request: updated, refund: { id: made.id, status: made.status, amount } });
  } catch (e) {
    return handle(res, e, 'refund');
  }
}

async function reject(req, res) {
  try {
    if (!UUID_RE.test(String(req.params.id || ''))) return fail(res, 404, 'Refund request not found.');
    const note = String(req.body?.note || '').trim().slice(0, 500);
    if (!note) return fail(res, 400, 'Say why there is no refund (the client may ask).');
    const now = new Date().toISOString();
    const { data, error } = await supabaseAdmin.from('refund_requests')
      .update({ status: 'rejected', decided_by: req.user.id, decided_at: now, decision_note: note, updated_at: now })
      .eq('id', req.params.id).in('status', ['pending', 'failed']).select('*');
    if (error) return handle(res, error, 'update the request');
    if (!data || !data.length) return fail(res, 409, 'This request was already handled.');
    return ok(res, { request: data[0] });
  } catch (e) {
    return handle(res, e, 'update the request');
  }
}

/** Refunded outside Razorpay (cash, bank transfer, credit): recorded, no money moved here. */
async function manual(req, res) {
  try {
    if (!UUID_RE.test(String(req.params.id || ''))) return fail(res, 404, 'Refund request not found.');
    const note = String(req.body?.note || '').trim().slice(0, 500);
    if (!note) return fail(res, 400, 'Say how it was refunded (e.g. bank transfer, ref no.).');
    const { data: r } = await supabaseAdmin.from('refund_requests').select('*').eq('id', req.params.id).maybeSingle();
    if (!r) return fail(res, 404, 'Refund request not found.');
    const amount = rupees(req.body?.amount ?? r.amount_suggested);
    if (!(amount > 0) || amount > Number(r.amount_paid)) return fail(res, 400, 'Enter the amount that was refunded.');
    const now = new Date().toISOString();
    const { data, error } = await supabaseAdmin.from('refund_requests')
      .update({ status: 'refunded', amount_refunded: amount, refunded_at: now, decided_by: req.user.id, decided_at: now, decision_note: `By hand: ${note}`, updated_at: now })
      .eq('id', r.id).in('status', ['pending', 'failed']).select('*');
    if (error) return handle(res, error, 'update the request');
    if (!data || !data.length) return fail(res, 409, 'This request was already handled.');
    await markRefunded(r, amount, amount >= Number(r.amount_paid));
    return ok(res, { request: data[0] });
  } catch (e) {
    return handle(res, e, 'update the request');
  }
}

/** Razorpay webhook: refund.processed / refund.failed (and refund.created). Never throws. */
async function refundWebhook(event, refundEntity) {
  try {
    if (!refundEntity?.id) return;
    const now = new Date().toISOString();
    const byId = await supabaseAdmin.from('refund_requests').select('*').eq('razorpay_refund_id', refundEntity.id).maybeSingle();
    let row = byId.data;
    if (!row && refundEntity.notes?.refund_request_id && UUID_RE.test(refundEntity.notes.refund_request_id)) {
      row = (await supabaseAdmin.from('refund_requests').select('*').eq('id', refundEntity.notes.refund_request_id).maybeSingle()).data;
    }
    if (!row) return; // a refund made in the Razorpay dashboard: the payment.refunded handler covers it
    if (event === 'refund.processed') {
      await supabaseAdmin.from('refund_requests').update({
        status: 'refunded', razorpay_refund_id: refundEntity.id, razorpay_status: 'processed',
        amount_refunded: rupees(Number(refundEntity.amount) / 100), refunded_at: row.refunded_at || now, updated_at: now,
      }).eq('id', row.id);
    } else if (event === 'refund.failed') {
      await supabaseAdmin.from('refund_requests').update({
        status: 'failed', razorpay_status: 'failed', failure_reason: 'Razorpay could not complete the refund (refund.failed). Try again, or refund by hand.', updated_at: now,
      }).eq('id', row.id);
    } else if (event === 'refund.created' && row.status === 'pending') {
      await supabaseAdmin.from('refund_requests').update({ status: 'processing', razorpay_refund_id: refundEntity.id, razorpay_status: refundEntity.status, updated_at: now }).eq('id', row.id);
    }
  } catch (e) {
    console.warn('refund webhook not applied:', e.message);
  }
}

module.exports = { count, list, refund, reject, manual, refundWebhook };
