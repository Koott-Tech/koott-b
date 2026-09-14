const { supabaseAdmin } = require('../config/supabase');

/**
 * Coupon rules live here so the public "check this code" endpoint and the
 * payment path apply exactly the same logic. The payment path must never trust
 * a discounted amount sent by the browser — it passes the code and the true
 * order amount, and gets the discount back.
 */

const PERCENTAGE = 'percentage';
const FIXED = 'fixed';

/** Round to paise so Razorpay never sees a fraction it cannot represent. */
function round2(n) {
  return Math.round((Number(n) + Number.EPSILON) * 100) / 100;
}

/**
 * Work out what a coupon takes off a given order amount.
 * @returns {{discount:number, final:number}}
 */
function computeDiscount(coupon, orderAmount) {
  const amount = Number(orderAmount) || 0;
  let discount;

  if (coupon.discount_type === FIXED) {
    discount = Number(coupon.discount_value) || 0;
  } else {
    discount = (amount * (Number(coupon.discount_value) || 0)) / 100;
    const cap = coupon.max_discount_amount;
    if (cap != null && discount > Number(cap)) discount = Number(cap);
  }

  // Never discount below zero, and never below the order amount.
  discount = Math.min(Math.max(discount, 0), amount);
  return { discount: round2(discount), final: round2(amount - discount) };
}

/** Fetch by code, case-insensitively. */
async function findByCode(code) {
  const clean = String(code || '').trim();
  if (!clean) return null;
  const { data, error } = await supabaseAdmin
    .from('coupons')
    .select('*')
    .ilike('code', clean)
    .maybeSingle();
  if (error) {
    console.error('[couponService.findByCode]', error);
    return null;
  }
  return data || null;
}

/**
 * Validate a code for a specific client and order amount.
 *
 * Resolves to { valid:false, reason } rather than throwing, so callers can pass
 * the reason straight to the user.
 *
 * @param {{code:string, amount:number, clientId?:string}} args
 */
async function validateCoupon({ code, amount, clientId }) {
  const coupon = await findByCode(code);
  if (!coupon) return { valid: false, reason: 'That coupon code is not recognised.' };

  if (!coupon.is_active) {
    return { valid: false, reason: 'That coupon is no longer active.' };
  }

  const now = new Date();

  // valid_from defaults to the DATABASE clock, which can run ahead of this
  // process — measured ~700ms against Supabase. Without a tolerance a coupon is
  // "not active yet" for a moment right after an admin creates it. Start time is
  // therefore lenient by a small window; expiry below stays strict, so an
  // expired coupon is never honoured.
  const START_SKEW_MS = 2 * 60 * 1000;
  if (coupon.valid_from && new Date(coupon.valid_from).getTime() - now.getTime() > START_SKEW_MS) {
    return { valid: false, reason: 'That coupon is not active yet.' };
  }
  if (coupon.expires_at && new Date(coupon.expires_at) <= now) {
    return { valid: false, reason: 'That coupon has expired.' };
  }

  const orderAmount = Number(amount) || 0;
  const minOrder = Number(coupon.min_order_amount) || 0;
  if (minOrder > 0 && orderAmount < minOrder) {
    return { valid: false, reason: `This coupon needs a minimum order of ₹${minOrder}.` };
  }

  // Count redemptions from the table rather than trusting redemption_count.
  if (coupon.max_redemptions != null) {
    const { count, error } = await supabaseAdmin
      .from('coupon_redemptions')
      .select('id', { count: 'exact', head: true })
      .eq('coupon_id', coupon.id);
    if (error) {
      console.error('[couponService] total redemption count failed:', error);
      return { valid: false, reason: 'We could not verify that coupon just now.' };
    }
    if ((count || 0) >= coupon.max_redemptions) {
      return { valid: false, reason: 'That coupon has reached its usage limit.' };
    }
  }

  if (clientId && coupon.per_user_limit != null) {
    const { count, error } = await supabaseAdmin
      .from('coupon_redemptions')
      .select('id', { count: 'exact', head: true })
      .eq('coupon_id', coupon.id)
      .eq('client_id', clientId);
    if (error) {
      console.error('[couponService] per-user redemption count failed:', error);
      return { valid: false, reason: 'We could not verify that coupon just now.' };
    }
    if ((count || 0) >= coupon.per_user_limit) {
      return { valid: false, reason: 'You have already used this coupon.' };
    }
  }

  const { discount, final } = computeDiscount(coupon, orderAmount);
  if (discount <= 0) {
    return { valid: false, reason: 'That coupon does not apply to this booking.' };
  }

  return {
    valid: true,
    coupon,
    originalAmount: round2(orderAmount),
    discountAmount: discount,
    finalAmount: final,
    label: coupon.discount_type === FIXED
      ? `₹${Number(coupon.discount_value)} off`
      : `${Number(coupon.discount_value)}% off`,
  };
}

/**
 * Record a redemption. Called only after a payment order is actually created,
 * so an abandoned checkout does not consume a coupon.
 */
async function recordRedemption({
  couponId, clientId, orderId, paymentId, sessionId,
  originalAmount, discountAmount, finalAmount,
}) {
  const { data, error } = await supabaseAdmin
    .from('coupon_redemptions')
    .insert([{
      coupon_id: couponId,
      client_id: clientId || null,
      order_id: orderId || null,
      payment_id: paymentId || null,
      session_id: sessionId || null,
      original_amount: originalAmount,
      discount_amount: discountAmount,
      final_amount: finalAmount,
    }])
    .select('id')
    .single();

  if (error) {
    console.error('[couponService.recordRedemption]', error);
    return null;
  }

  // Keep the denormalised counter roughly in step. A failure here is not fatal:
  // validateCoupon counts the redemption rows, not this column.
  const { error: bumpErr } = await supabaseAdmin.rpc('increment_coupon_redemptions', {
    p_coupon_id: couponId,
  });
  if (bumpErr) {
    const { data: fresh } = await supabaseAdmin
      .from('coupons').select('redemption_count').eq('id', couponId).maybeSingle();
    await supabaseAdmin
      .from('coupons')
      .update({ redemption_count: (fresh?.redemption_count || 0) + 1 })
      .eq('id', couponId);
  }

  return data?.id || null;
}

module.exports = {
  PERCENTAGE,
  FIXED,
  computeDiscount,
  findByCode,
  validateCoupon,
  recordRedemption,
  round2,
};
