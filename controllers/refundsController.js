/**
 * /api/refunds — Operations' refund and cancellation requests (table refund_requests, SQL 0023).
 *
 * Two kinds of request share the table:
 *   refund          the session is already cancelled; the money goes back when Operations
 *                   presses Refund (staff "Cancel & refund", or an automatic refund that failed)
 *   cancel request  source 'client_request': the client asked to cancel within 48 h of the
 *                   session. The session stays booked until Operations decides:
 *                     Refund            → cancel the session and refund (Razorpay)
 *                     Cancel, no refund → cancel the session, keep the money (late-cancel policy)
 *                     Keep the session  → nothing changes; the client is told
 *
 *   GET  /api/refunds/count         the number on the header icon
 *   GET  /api/refunds?status=open   the popup list (open | done | all)
 *   POST /api/refunds/:id/refund    { amount, note }
 *   POST /api/refunds/:id/cancel-only { note }   (cancel requests only)
 *   POST /api/refunds/:id/reject    { note }     (refund: no refund · cancel request: keep the session)
 *   POST /api/refunds/:id/manual    { amount, note } refunded outside Razorpay
 *
 * executeRefund is also used for the automatic refund when a client cancels 48 h+ ahead.
 */
const { supabaseAdmin } = require('../config/supabase');
const { personOf, UUID_RE } = require('../utils/staffRoles');
const { key, namesFor, isMissingTable } = require('../utils/people');
const { rupees } = require('../utils/refunds');
const { cancelSessionCore, LIVE } = require('../utils/sessionCancel');

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
const esc = (v) => String(v ?? '').replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
const inr = (n) => `₹${Number(n || 0).toLocaleString('en-IN')}`;

/** An email to the client about their refund / request (never demo addresses). */
async function tellClient(clientId, subject, body) {
  try {
    if (!clientId || process.env.REFUND_EMAILS === 'off') return;
    const { data: c } = await supabaseAdmin.from('clients').select('first_name, email, user:users(email)').eq('id', clientId).maybeSingle();
    const to = c?.email || (Array.isArray(c?.user) ? c.user[0]?.email : c?.user?.email);
    if (!to || /\.invalid$/i.test(to)) return;
    await require('../utils/emailService').sendEmail({ to, subject, html: `<p>Hi ${esc(c?.first_name || '')},</p>${body}<p>— Team Koott</p>` });
  } catch (e) { console.warn('refunds: client email not sent:', e.message); }
}

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
      r.requested_by_type && !['client', 'system'].includes(r.requested_by_type) && r.requested_by_id ? { type: r.requested_by_type, id: r.requested_by_id } : null,
      r.decided_by ? { type: 'user', id: r.decided_by } : null,
    ]).filter(Boolean));
    const nm = (x) => (x ? `${x.first_name || ''} ${x.last_name || ''}`.trim() : null);
    return ok(res, {
      requests: rows.map((r) => {
        const s = S.get(r.session_id); const c = C.get(r.client_id); const pay = PAY.get(r.payment_id);
        const isCancelRequest = r.source === 'client_request';
        const sessionLive = Boolean(s && LIVE.includes(s.status));
        return {
          ...r,
          kind: isCancelRequest ? 'cancel_request' : 'refund',
          sessionLive,
          clientRef: clientRef(r.client_id),
          clientName: nm(c) || null, clientPhone: c?.phone_number || null, clientEmail: c?.email || null,
          therapistName: nm(P.get(r.psychologist_id)),
          session: s ? { date: s.scheduled_date, time: String(s.scheduled_time || '').slice(0, 5), type: s.session_type, status: s.status, cancelledAt: s.updated_at } : null,
          payment: pay ? { amount: Number(pay.amount) || 0, status: pay.status, method: pay.payment_method, paidAt: pay.created_at, orderId: pay.razorpay_order_id } : null,
          requestedBy: ['client', 'client_request'].includes(r.source) ? 'The client' : r.source === 'system' ? 'Found automatically'
            : people[key(r.requested_by_type, r.requested_by_id)]?.name || 'Staff',
          decidedBy: r.decided_by ? people[key('user', r.decided_by)]?.name || null : (r.decision_note && r.status === 'refunded' ? 'Automatic (48 h+ before the session)' : null),
          canRefund: Boolean(r.razorpay_payment_id) && ['pending', 'failed'].includes(r.status),
        };
      }),
    });
  } catch (e) {
    return handle(res, e, 'load refund requests');
  }
}

/** Mark the payment and the session refunded once Razorpay has the money going back. */
async function markRefunded(reqRow, full) {
  const now = new Date().toISOString();
  if (reqRow.payment_id && full) {
    await supabaseAdmin.from('payments').update({ status: 'refunded', updated_at: now }).eq('id', reqRow.payment_id).then(() => {}, () => {});
  }
  if (reqRow.session_id) {
    await supabaseAdmin.from('sessions').update({ status: 'refunded', updated_at: now }).eq('id', reqRow.session_id).then(() => {}, () => {});
    await supabaseAdmin.from('tasks').update({ status: 'done', completed_at: now, updated_at: now })
      .eq('auto_key', `refund:${reqRow.session_id}`).not('status', 'in', '(done,cancelled)').then(() => {}, () => {});
  }
}

/**
 * Send the refund through Razorpay for one request. Shared by Operations' Refund button and
 * the automatic refund. Never refunds twice: the request is claimed first, Razorpay's own
 * remaining amount is checked, and a refund already made for this request is reused.
 * @returns {{ ok: boolean, status: number, message?: string, request?: object, refund?: object }}
 */
async function executeRefund(r, { amount, note = null, decidedBy = null, approvedBy = 'system' }) {
  if (!['pending', 'failed'].includes(r.status)) return { ok: false, status: 409, message: r.status === 'refunded' ? 'This was already refunded.' : `This request is ${r.status}.` };
  if (!r.razorpay_payment_id) return { ok: false, status: 400, message: 'This booking was not paid through Razorpay. Refund it by hand (or as credit), then use "Refunded by hand".' };
  amount = rupees(amount ?? r.amount_suggested);
  if (!(amount > 0)) return { ok: false, status: 400, message: 'Enter an amount above ₹0.' };
  if (amount > Number(r.amount_paid)) return { ok: false, status: 400, message: `That is more than was paid (${inr(r.amount_paid)}).` };

  const { getRazorpayInstance } = require('../config/razorpay');
  const rzp = getRazorpayInstance();
  // Razorpay refusing before any refund is made: the request shows "Failed — try again" with why.
  const refused = async (status, message) => {
    await supabaseAdmin.from('refund_requests').update({ status: 'failed', failure_reason: String(message).slice(0, 500), updated_at: new Date().toISOString() })
      .eq('id', r.id).in('status', ['pending', 'failed']);
    return { ok: false, status, message };
  };
  let rzpPayment;
  try { rzpPayment = await rzp.payments.fetch(r.razorpay_payment_id); } catch (e) {
    return refused(502, `Razorpay could not find this payment: ${e?.error?.description || e?.message || 'unknown error'}`);
  }
  if (rzpPayment.status !== 'captured' && rzpPayment.status !== 'refunded') return refused(400, `Razorpay shows this payment as "${rzpPayment.status}", so it cannot be refunded.`);
  const left = (Number(rzpPayment.amount) - Number(rzpPayment.amount_refunded || 0)) / 100;
  if (amount > left + 0.001) return { ok: false, status: 400, message: `Only ${inr(left)} of this payment is left to refund.` };

  const now = new Date().toISOString();
  const { data: claimed, error: claimErr } = await supabaseAdmin.from('refund_requests')
    .update({ status: 'processing', decided_by: decidedBy, decided_at: now, decision_note: note, failure_reason: null, updated_at: now })
    .eq('id', r.id).in('status', ['pending', 'failed']).select('id');
  if (claimErr) throw claimErr;
  if (!claimed || !claimed.length) return { ok: false, status: 409, message: 'Someone else is refunding this right now.' };

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
        notes: { refund_request_id: r.id, session_id: r.session_id || '', approved_by: approvedBy },
      });
    } catch (e) {
      let why = e?.error?.description || e?.message || 'Razorpay refused the refund.';
      // Razorpay pays refunds out of the account's Razorpay balance (payments minus its fees, until they
      // are settled to the bank). A refund larger than that balance comes back as this vague error.
      if (/invalid request sent/i.test(why)) {
        why = 'Razorpay refused it, most likely because the Razorpay balance is lower than the refund '
          + '(refunds are paid from the balance; Razorpay keeps ~2% of each payment and settles the rest to the bank). '
          + 'Add funds or turn on Refund Credits in the Razorpay dashboard, then press Refund again — or refund a smaller amount.';
      }
      await supabaseAdmin.from('refund_requests').update({ status: 'failed', failure_reason: String(why).slice(0, 500), updated_at: new Date().toISOString() }).eq('id', r.id);
      return { ok: false, status: 502, message: `Razorpay did not refund: ${why}` };
    }
  }
  const processed = made.status === 'processed';
  const full = Math.abs(amount - left) < 0.01;
  const { data: updated } = await supabaseAdmin.from('refund_requests').update({
    status: processed ? 'refunded' : 'processing', razorpay_refund_id: made.id, razorpay_status: made.status,
    amount_refunded: rupees(Number(made.amount) / 100), refunded_at: processed ? new Date().toISOString() : null, updated_at: new Date().toISOString(),
  }).eq('id', r.id).select('*').single();
  await markRefunded(r, full);
  await tellClient(r.client_id, 'Your Koott refund is on its way',
    `<p>We have refunded ${inr(amount)} for your cancelled session. It usually reaches your account in 5–7 working days.</p><p>Refund reference: ${esc(made.id)}</p>`);
  return { ok: true, status: 200, request: updated, refund: { id: made.id, status: made.status, amount } };
}

async function loadRequest(req, res) {
  if (!UUID_RE.test(String(req.params.id || ''))) { fail(res, 404, 'Refund request not found.'); return null; }
  const { data: r, error } = await supabaseAdmin.from('refund_requests').select('*').eq('id', req.params.id).maybeSingle();
  if (error) { handle(res, error, 'load the request'); return null; }
  if (!r) { fail(res, 404, 'Refund request not found.'); return null; }
  return r;
}

/** A cancellation request whose session is still booked: cancel it now (Operations approved). */
async function cancelIfStillBooked(r) {
  if (r.source !== 'client_request' || !r.session_id) return { ok: true };
  const { data: s } = await supabaseAdmin.from('sessions').select('status').eq('id', r.session_id).maybeSingle();
  if (!s || !LIVE.includes(s.status)) return { ok: true }; // already cancelled
  const out = await cancelSessionCore(r.session_id, { status: 'canceled' });
  return out.ok ? { ok: true } : { ok: false, message: out.message };
}

async function refund(req, res) {
  const me = personOf(req.user);
  try {
    const r = await loadRequest(req, res);
    if (!r) return undefined;
    if (!['pending', 'failed'].includes(r.status)) return fail(res, 409, r.status === 'refunded' ? 'This was already refunded.' : `This request is ${r.status}.`);
    if (!r.razorpay_payment_id) return fail(res, 400, 'This booking was not paid through Razorpay. Refund it by hand (or as credit), then use "Refunded by hand".');
    const amount = rupees(req.body?.amount ?? r.amount_suggested);
    if (!(amount > 0)) return fail(res, 400, 'Enter an amount above ₹0.');
    if (amount > Number(r.amount_paid)) return fail(res, 400, `That is more than was paid (${inr(r.amount_paid)}).`);
    // Approving a client's cancellation request: the session is cancelled first.
    const c = await cancelIfStillBooked(r);
    if (!c.ok) return fail(res, 409, c.message);
    const out = await executeRefund(r, { amount, note: req.body?.note ? String(req.body.note).slice(0, 500) : null, decidedBy: req.user.id, approvedBy: key(me.type, me.id) });
    require('../utils/accessLog').logAccess(req, { action: 'changed', resource: 'session', resourceId: r.session_id, details: { refund: out.refund?.id || 'failed', amount } });
    if (!out.ok) return fail(res, out.status, out.message);
    return ok(res, { request: out.request, refund: out.refund });
  } catch (e) {
    return handle(res, e, 'refund');
  }
}

/** Cancellation request: cancel the session but keep the payment (e.g. late-cancellation policy). */
async function cancelOnly(req, res) {
  try {
    const r = await loadRequest(req, res);
    if (!r) return undefined;
    if (r.source !== 'client_request') return fail(res, 400, 'Only a client\'s cancellation request can be cancelled without a refund here.');
    if (!['pending', 'failed'].includes(r.status)) return fail(res, 409, 'This request was already handled.');
    const note = String(req.body?.note || '').trim().slice(0, 500);
    if (!note) return fail(res, 400, 'Say why there is no refund (the client will be told).');
    const now = new Date().toISOString();
    const { data, error } = await supabaseAdmin.from('refund_requests')
      .update({ status: 'rejected', decided_by: req.user.id, decided_at: now, decision_note: `Cancelled without refund: ${note}`, updated_at: now })
      .eq('id', r.id).in('status', ['pending', 'failed']).select('*');
    if (error) return handle(res, error, 'update the request');
    if (!data || !data.length) return fail(res, 409, 'This request was already handled.');
    const c = await cancelIfStillBooked(r);
    if (!c.ok) return fail(res, 409, c.message);
    await tellClient(r.client_id, 'Your Koott session is cancelled',
      `<p>Your session has been cancelled as you asked. As it was within 48 hours of the session, it is not refunded.</p><p>${esc(note)}</p>`);
    return ok(res, { request: data[0] });
  } catch (e) {
    return handle(res, e, 'update the request');
  }
}

/** Refund: no refund. Cancellation request: keep the session as booked. */
async function reject(req, res) {
  try {
    const r = await loadRequest(req, res);
    if (!r) return undefined;
    const note = String(req.body?.note || '').trim().slice(0, 500);
    if (!note) return fail(res, 400, r.source === 'client_request' ? 'Say why the session stays (the client will be told).' : 'Say why there is no refund (the client may ask).');
    const now = new Date().toISOString();
    const keep = r.source === 'client_request';
    const { data, error } = await supabaseAdmin.from('refund_requests')
      .update({ status: 'rejected', decided_by: req.user.id, decided_at: now, decision_note: keep ? `Session kept: ${note}` : note, updated_at: now })
      .eq('id', r.id).in('status', ['pending', 'failed']).select('*');
    if (error) return handle(res, error, 'update the request');
    if (!data || !data.length) return fail(res, 409, 'This request was already handled.');
    if (keep) {
      await tellClient(r.client_id, 'About your cancellation request',
        `<p>We could not cancel this session, so it stays booked.</p><p>${esc(note)}</p><p>Reply to this email or message us if you have any questions.</p>`);
    }
    return ok(res, { request: data[0] });
  } catch (e) {
    return handle(res, e, 'update the request');
  }
}

/** Refunded outside Razorpay (cash, bank transfer, credit): recorded, no money moved here. */
async function manual(req, res) {
  try {
    const r = await loadRequest(req, res);
    if (!r) return undefined;
    const note = String(req.body?.note || '').trim().slice(0, 500);
    if (!note) return fail(res, 400, 'Say how it was refunded (e.g. bank transfer, ref no.).');
    const amount = rupees(req.body?.amount ?? r.amount_suggested);
    if (!(amount > 0) || amount > Number(r.amount_paid)) return fail(res, 400, 'Enter the amount that was refunded.');
    if (!['pending', 'failed'].includes(r.status)) return fail(res, 409, 'This request was already handled.');
    const c = await cancelIfStillBooked(r);
    if (!c.ok) return fail(res, 409, c.message);
    const now = new Date().toISOString();
    const { data, error } = await supabaseAdmin.from('refund_requests')
      .update({ status: 'refunded', amount_refunded: amount, refunded_at: now, decided_by: req.user.id, decided_at: now, decision_note: `By hand: ${note}`, updated_at: now })
      .eq('id', r.id).in('status', ['pending', 'failed']).select('*');
    if (error) return handle(res, error, 'update the request');
    if (!data || !data.length) return fail(res, 409, 'This request was already handled.');
    await markRefunded(r, amount >= Number(r.amount_paid));
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
    if (!row) return 'unmatched'; // a refund made in the Razorpay dashboard (handled by the caller)
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

module.exports = { count, list, refund, cancelOnly, reject, manual, refundWebhook, executeRefund };
