/**
 * Ask Razorpay what really happened to an order before the cleanup jobs give up on it.
 *
 * A client can pay and then lose the connection (or close the app) before the browser
 * tells us, and the webhook may be missing or late. Without this check the cleanup job
 * marked such payments "failed" after ~15 minutes: money taken, no session, no alert.
 *
 *   orderPaymentState(orderId) -> { state: 'captured' | 'authorized' | 'unpaid', payment? }
 *                                 throws when Razorpay cannot be asked (then do nothing)
 *   recoverIfPaid(orderId)     -> { state, result? } and, when captured, creates the
 *                                 booking through the same path as the webhook
 */
const { getRazorpayInstance } = require('../config/razorpay');

async function orderPaymentState(orderId) {
  const razorpay = getRazorpayInstance();
  const res = await razorpay.orders.fetchPayments(orderId);
  const items = (res && res.items) || [];
  const newest = (list) => list.sort((a, b) => (b.created_at || 0) - (a.created_at || 0))[0];
  const captured = newest(items.filter((p) => p.status === 'captured'));
  if (captured) return { state: 'captured', payment: captured };
  // Auto-capture is on, so "authorized" means the bank is still settling it.
  const authorized = newest(items.filter((p) => p.status === 'authorized'));
  if (authorized) return { state: 'authorized', payment: authorized };
  return { state: 'unpaid' };
}

async function recoverIfPaid(orderId) {
  const found = await orderPaymentState(orderId);
  if (found.state !== 'captured') return found;
  // Required here, not at the top: the webhook controller requires slotLockService,
  // which requires this file.
  const { processPaymentCaptured } = require('../controllers/razorpayWebhookController');
  const p = found.payment;
  console.log('💡 Cleanup found a paid order with no booking — creating it now:', orderId);
  const result = await processPaymentCaptured({
    payment: { entity: { id: p.id, order_id: orderId, amount: p.amount, currency: p.currency, status: p.status } },
  }, `cleanup_${p.id}`, true);
  return { state: 'captured', result };
}

module.exports = { orderPaymentState, recoverIfPaid };
