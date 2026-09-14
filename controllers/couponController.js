const { supabaseAdmin } = require('../config/supabase');
const couponService = require('../services/couponService');

/**
 * Coupon admin CRUD plus the public "check this code" endpoint.
 *
 * The check endpoint deliberately returns only the discount figures and a
 * label — never the coupon row — so limits and internal rules are not exposed
 * to the browser.
 */

const VALID_TYPES = ['percentage', 'fixed'];

function bad(res, message, status = 400) {
  return res.status(status).json({ success: false, message });
}

/** Normalise and validate the admin payload. Returns {error} or {row}. */
function buildRow(body, userId) {
  const code = String(body.code || '').trim().toUpperCase();
  if (!code) return { error: 'A coupon code is required.' };
  if (!/^[A-Z0-9_-]{3,32}$/.test(code)) {
    return { error: 'Code must be 3–32 characters: letters, numbers, hyphen or underscore.' };
  }

  const discountType = String(body.discount_type || 'percentage').toLowerCase();
  if (!VALID_TYPES.includes(discountType)) {
    return { error: "Discount type must be 'percentage' or 'fixed'." };
  }

  const discountValue = Number(body.discount_value);
  if (!Number.isFinite(discountValue) || discountValue <= 0) {
    return { error: 'Discount value must be greater than zero.' };
  }
  if (discountType === 'percentage' && discountValue > 100) {
    return { error: 'A percentage discount cannot exceed 100%.' };
  }

  // Expiry may arrive as an absolute timestamp or as "expires in N days".
  let expiresAt = null;
  if (body.expires_at) {
    const d = new Date(body.expires_at);
    if (Number.isNaN(d.getTime())) return { error: 'Expiry date is not a valid date.' };
    expiresAt = d.toISOString();
  } else if (body.expires_in_days != null && body.expires_in_days !== '') {
    const days = Number(body.expires_in_days);
    if (!Number.isFinite(days) || days <= 0) {
      return { error: 'Expiry in days must be a positive number.' };
    }
    expiresAt = new Date(Date.now() + days * 86400000).toISOString();
  }
  if (expiresAt && new Date(expiresAt) <= new Date()) {
    return { error: 'Expiry must be in the future.' };
  }

  const intOrNull = (v) => {
    if (v == null || v === '') return null;
    const n = Number(v);
    return Number.isFinite(n) && n > 0 ? Math.floor(n) : null;
  };
  const numOrNull = (v) => {
    if (v == null || v === '') return null;
    const n = Number(v);
    return Number.isFinite(n) && n >= 0 ? n : null;
  };

  return {
    row: {
      code,
      description: body.description ? String(body.description).trim().slice(0, 300) : null,
      discount_type: discountType,
      discount_value: discountValue,
      max_discount_amount: discountType === 'percentage' ? numOrNull(body.max_discount_amount) : null,
      min_order_amount: numOrNull(body.min_order_amount) ?? 0,
      expires_at: expiresAt,
      max_redemptions: intOrNull(body.max_redemptions),
      per_user_limit: intOrNull(body.per_user_limit) ?? 1,
      is_active: body.is_active === undefined ? true : Boolean(body.is_active),
      ...(userId ? { created_by: userId } : {}),
    },
  };
}

/** GET /api/coupons/admin — all coupons, newest first, with live usage counts. */
const listCoupons = async (req, res) => {
  try {
    const { data, error } = await supabaseAdmin
      .from('coupons')
      .select('*')
      .order('created_at', { ascending: false });
    if (error) throw error;

    // Real usage from the redemption table, so the list never shows a stale count.
    const withUsage = await Promise.all((data || []).map(async (c) => {
      const { count } = await supabaseAdmin
        .from('coupon_redemptions')
        .select('id', { count: 'exact', head: true })
        .eq('coupon_id', c.id);
      return { ...c, used_count: count || 0 };
    }));

    return res.json({ success: true, data: { coupons: withUsage } });
  } catch (err) {
    console.error('[couponController.list]', err);
    return bad(res, 'Could not load coupons.', 500);
  }
};

/** POST /api/coupons/admin */
const createCoupon = async (req, res) => {
  const { error: invalid, row } = buildRow(req.body, req.user?.id);
  if (invalid) return bad(res, invalid);

  try {
    const existing = await couponService.findByCode(row.code);
    if (existing) return bad(res, 'A coupon with that code already exists.', 409);

    const { data, error } = await supabaseAdmin
      .from('coupons').insert([row]).select('*').single();
    if (error) throw error;

    return res.status(201).json({ success: true, data: { coupon: data } });
  } catch (err) {
    console.error('[couponController.create]', err);
    return bad(res, 'Could not create the coupon.', 500);
  }
};

/** PUT /api/coupons/admin/:id */
const updateCoupon = async (req, res) => {
  const { error: invalid, row } = buildRow(req.body, null);
  if (invalid) return bad(res, invalid);

  try {
    const clash = await couponService.findByCode(row.code);
    if (clash && clash.id !== req.params.id) {
      return bad(res, 'Another coupon already uses that code.', 409);
    }
    const { data, error } = await supabaseAdmin
      .from('coupons').update(row).eq('id', req.params.id).select('*').single();
    if (error) throw error;
    if (!data) return bad(res, 'Coupon not found.', 404);

    return res.json({ success: true, data: { coupon: data } });
  } catch (err) {
    console.error('[couponController.update]', err);
    return bad(res, 'Could not update the coupon.', 500);
  }
};

/** PATCH /api/coupons/admin/:id/toggle — flip is_active without a full edit. */
const toggleCoupon = async (req, res) => {
  try {
    const { data: current } = await supabaseAdmin
      .from('coupons').select('is_active').eq('id', req.params.id).maybeSingle();
    if (!current) return bad(res, 'Coupon not found.', 404);

    const { data, error } = await supabaseAdmin
      .from('coupons')
      .update({ is_active: !current.is_active })
      .eq('id', req.params.id)
      .select('*')
      .single();
    if (error) throw error;

    return res.json({ success: true, data: { coupon: data } });
  } catch (err) {
    console.error('[couponController.toggle]', err);
    return bad(res, 'Could not update the coupon.', 500);
  }
};

/**
 * DELETE /api/coupons/admin/:id
 * Refuses when the coupon has been redeemed — deleting would orphan the
 * discount recorded against real payments. Deactivate instead.
 */
const deleteCoupon = async (req, res) => {
  try {
    const { count } = await supabaseAdmin
      .from('coupon_redemptions')
      .select('id', { count: 'exact', head: true })
      .eq('coupon_id', req.params.id);

    if ((count || 0) > 0) {
      return bad(
        res,
        `This coupon has been used ${count} time(s) and cannot be deleted. Deactivate it instead.`,
        409
      );
    }

    const { error } = await supabaseAdmin.from('coupons').delete().eq('id', req.params.id);
    if (error) throw error;
    return res.json({ success: true, message: 'Coupon deleted.' });
  } catch (err) {
    console.error('[couponController.delete]', err);
    return bad(res, 'Could not delete the coupon.', 500);
  }
};

/** GET /api/coupons/admin/:id/redemptions */
const listRedemptions = async (req, res) => {
  try {
    const { data, error } = await supabaseAdmin
      .from('coupon_redemptions')
      .select('*, client:clients(first_name, last_name, email)')
      .eq('coupon_id', req.params.id)
      .order('redeemed_at', { ascending: false })
      .limit(200);
    if (error) throw error;
    return res.json({ success: true, data: { redemptions: data || [] } });
  } catch (err) {
    console.error('[couponController.listRedemptions]', err);
    return bad(res, 'Could not load redemptions.', 500);
  }
};

/**
 * POST /api/coupons/validate  { code, amount }
 * Authenticated so per-user limits can be enforced. Returns only the figures
 * the checkout needs — never the coupon row itself.
 */
const checkCoupon = async (req, res) => {
  try {
    const { code, amount } = req.body || {};
    if (!code) return bad(res, 'Enter a coupon code.');

    const orderAmount = Number(amount);
    if (!Number.isFinite(orderAmount) || orderAmount <= 0) {
      return bad(res, 'A valid order amount is required.');
    }

    // Resolve the caller's client row so per-user limits apply.
    let clientId = null;
    if (req.user?.id) {
      const { data: client } = await supabaseAdmin
        .from('clients').select('id').eq('user_id', req.user.id).maybeSingle();
      clientId = client?.id || null;
    }

    const result = await couponService.validateCoupon({ code, amount: orderAmount, clientId });
    if (!result.valid) return res.status(200).json({ success: false, message: result.reason });

    return res.json({
      success: true,
      data: {
        code: result.coupon.code,
        label: result.label,
        description: result.coupon.description || null,
        originalAmount: result.originalAmount,
        discountAmount: result.discountAmount,
        finalAmount: result.finalAmount,
      },
    });
  } catch (err) {
    console.error('[couponController.check]', err);
    return bad(res, 'Could not check that coupon.', 500);
  }
};

module.exports = {
  listCoupons,
  createCoupon,
  updateCoupon,
  toggleCoupon,
  deleteCoupon,
  listRedemptions,
  checkCoupon,
};
