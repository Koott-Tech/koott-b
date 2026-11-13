const { supabaseAdmin } = require('../config/supabase');

/**
 * Derive the number of sessions that belong to a package.
 * Attempts the following (in order):
 * 1. Numeric session_count/total_sessions present on the record
 * 2. Parse the first integer from the package_type (e.g. "package_3")
 * 3. Fallback value (defaults to 1)
 *
 * @param {Object} pkg - Package-like payload (can be packages row or client_packages row with nested package)
 * @param {number} fallback - Fallback value when no valid number is found
 * @returns {number}
 */
const deriveSessionCount = (pkg = {}, fallback = 1) => {
  if (!pkg) return fallback;

  const directValue = pkg.session_count ?? pkg.total_sessions ?? pkg?.package?.session_count ?? pkg?.package?.total_sessions;
  const numericValue = Number(directValue);
  if (Number.isFinite(numericValue) && numericValue > 0) {
    return numericValue;
  }

  const typeSource = pkg.package_type || pkg?.package?.package_type || '';
  const match = String(typeSource).match(/\d+/);
  if (match) {
    const parsed = Number(match[0]);
    if (Number.isFinite(parsed) && parsed > 0) {
      return parsed;
    }
  }

  return fallback;
};

/**
 * Count sessions that consume a slot toward the package quota for this client + catalog package.
 * Matches getClientPackages / bookRemainingSession: completed + active (non-cancelled, non–no-show).
 *
 * @param {import('@supabase/supabase-js').SupabaseClient} supabaseAdmin
 * @param {string} clientId
 * @param {string} catalogPackageId - packages.id
 * @returns {Promise<{ error: object|null, used: number }>}
 */
const countSessionsTowardClientPackageQuota = async (supabaseAdmin, clientId, catalogPackageId) => {
  const { data: sessions, error } = await supabaseAdmin
    .from('sessions')
    .select('id, status')
    .eq('client_id', clientId)
    .eq('package_id', catalogPackageId);

  if (error) {
    return { error, used: 0 };
  }

  let used = 0;
  for (const s of sessions || []) {
    if (s.status === 'completed') {
      used++;
    } else if (!['cancelled', 'no_show', 'noshow'].includes(s.status)) {
      used++;
    }
  }
  return { error: null, used };
};

/**
 * Paid purchases of a catalog package by a client — each successful payment buys
 * session_count sessions. excludePaymentId leaves out the purchase being booked now.
 */
const countPaidPurchases = async (supabaseAdmin, clientId, catalogPackageId, excludePaymentId = null) => {
  let query = supabaseAdmin
    .from('payments')
    .select('id', { count: 'exact', head: true })
    .eq('client_id', clientId)
    .eq('package_id', catalogPackageId)
    .in('status', ['success', 'completed']);
  if (excludePaymentId) query = query.neq('id', excludePaymentId);
  const { count, error } = await query;
  return { error, count: count || 0 };
};

/**
 * Returns ok: false if the client has used every session they paid for on this catalog
 * package. Allowance = session_count × paid purchases (at least one), so buying the same
 * plan again — e.g. a second single "Individual session" — adds its own sessions instead
 * of being refused after payment.
 *
 * @param {import('@supabase/supabase-js').SupabaseClient} supabaseAdmin
 * @param {string} clientId
 * @param {object} packageRow - row from packages (must include id, session_count / package_type for deriveSessionCount)
 * @param {{ purchasePaymentId?: string }} [options] - the payment being booked right now
 *   (a paid booking): that purchase counts on top of the earlier ones.
 * @returns {Promise<{ ok: boolean, httpStatus?: number, message?: string, used?: number, limit?: number }>}
 */
const assertClientPackageHasAvailableSlot = async (supabaseAdmin, clientId, packageRow, { purchasePaymentId = null } = {}) => {
  if (!packageRow || !packageRow.id) {
    return { ok: true };
  }

  const perPurchase = deriveSessionCount(packageRow);
  if (!Number.isFinite(perPurchase) || perPurchase < 1) {
    return { ok: true };
  }

  const [{ error, used }, { error: purchaseError, count: paid }] = await Promise.all([
    countSessionsTowardClientPackageQuota(supabaseAdmin, clientId, packageRow.id),
    countPaidPurchases(supabaseAdmin, clientId, packageRow.id, purchasePaymentId)
  ]);
  const purchases = purchasePaymentId ? paid + 1 : Math.max(paid, 1);
  const limit = perPurchase * purchases;

  if (error || purchaseError) {
    return {
      ok: false,
      httpStatus: 500,
      message: 'Failed to verify package session quota'
    };
  }

  if (used >= limit) {
    return {
      ok: false,
      httpStatus: 400,
      used,
      limit,
      message:
        'This package has no remaining sessions. All sessions for this package have already been booked or completed.'
    };
  }

  return { ok: true, used, limit };
};

/**
 * Ensure that a client_packages record exists for a package purchase.
 * Will skip creation if a record already exists for the supplied session.
 *
 * @param {Object} params
 * @param {string} params.clientId
 * @param {string} params.psychologistId
 * @param {string} params.packageId
 * @param {string} params.sessionId
 * @param {string} [params.purchasedAt]
 * @param {Object} [params.packageData] - Optional package row to avoid refetch
 * @returns {Promise<{created: boolean, data: Object|null, error: object|null}>}
 */
const ensureClientPackageRecord = async ({
  clientId,
  psychologistId,
  packageId,
  sessionId,
  purchasedAt = new Date().toISOString(),
  packageData = null,
  consumedSessions = 1
}) => {
  if (!clientId || !psychologistId || !packageId) {
    return {
      created: false,
      data: null,
      error: new Error('Missing required fields to create client package record')
    };
  }

  try {
    // Avoid duplicate rows for the same first session
    const { data: existing, error: existingError } = await supabaseAdmin
      .from('client_packages')
      .select('id, client_id, package_id, first_session_id, session_count, total_sessions, package_type')
      .eq('client_id', clientId)
      .eq('package_id', packageId)
      .eq('first_session_id', sessionId || null)
      .maybeSingle();

    if (existingError && existingError.code !== 'PGRST116') {
      return {
        created: false,
        data: null,
        error: existingError
      };
    }

    if (existing) {
      // Older rows may predate grouping: make sure the first session is in this purchase.
      if (sessionId) await assignSessionToPurchase(sessionId, existing);
      return {
        created: false,
        data: existing,
        error: null
      };
    }

    let effectivePackage = packageData;
    if (!effectivePackage) {
      const { data: fetchedPackage, error: packageFetchError } = await supabaseAdmin
        .from('packages')
        .select('*')
        .eq('id', packageId)
        .single();

      if (packageFetchError) {
        return {
          created: false,
          data: null,
          error: packageFetchError
        };
      }

      effectivePackage = fetchedPackage;
    }

    const totalSessions = deriveSessionCount(effectivePackage);
    const consumed = Number.isFinite(consumedSessions) && consumedSessions >= 0
      ? consumedSessions
      : 1;
    const remainingSessions = Math.max(totalSessions - consumed, 0);

    const clientPackagePayload = {
      client_id: clientId,
      psychologist_id: psychologistId,
      package_id: packageId,
      package_type: effectivePackage.package_type,
      total_sessions: totalSessions,
      remaining_sessions: remainingSessions,
      total_amount: effectivePackage.price,
      amount_paid: effectivePackage.price,
      status: remainingSessions > 0 ? 'active' : 'completed',
      purchased_at: purchasedAt,
      first_session_id: sessionId || null
    };

    const { data: inserted, error: insertError } = await supabaseAdmin
      .from('client_packages')
      .insert([clientPackagePayload])
      .select('*')
      .single();

    if (insertError) {
      return {
        created: false,
        data: null,
        error: insertError
      };
    }

    // The first session belongs to this purchase (its group id is the purchase id).
    if (sessionId) await assignSessionToPurchase(sessionId, inserted);

    return {
      created: true,
      data: inserted,
      error: null
    };
  } catch (error) {
    return {
      created: false,
      data: null,
      error
    };
  }
};

/* ------------------------------------------------------------------------------------
 * Package grouping
 *
 * Every purchase (a client_packages row) is its own group, and its id is the group id on
 * each of its sessions (sessions.package_group_id). Two purchases of the same plan with the
 * same therapist therefore stay apart: labels (A, B, … Z, A1 …) follow purchase order, and
 * "book next session" always adds to the purchase it was booked from. Grouping used to key
 * on the catalog plan (sessions.package_id), which is the same for both purchases, so their
 * sessions merged into one group.
 * ---------------------------------------------------------------------------------- */

const COUNTS_TOWARD_PACKAGE = (status) => !['cancelled', 'canceled', 'no_show', 'noshow'].includes(status);

/** Sessions in this purchase that use up one of its slots (booked, done, rescheduled…). */
const countSessionsInPurchase = async (clientPackageId, { excludeSessionId = null } = {}) => {
  let q = supabaseAdmin.from('sessions').select('id, status').eq('package_group_id', clientPackageId);
  if (excludeSessionId) q = q.neq('id', excludeSessionId);
  const { data, error } = await q;
  if (error) return { error, used: 0 };
  return { error: null, used: (data || []).filter((s) => COUNTS_TOWARD_PACKAGE(s.status)).length };
};

/** ok: false when every session of this purchase is already booked or done. */
const purchaseHasRoom = async (clientPackage) => {
  const total = deriveSessionCount(clientPackage, 0);
  if (!clientPackage?.id || total < 1) return { ok: true };
  const { error, used } = await countSessionsInPurchase(clientPackage.id);
  if (error) return { ok: false, httpStatus: 500, message: 'Failed to verify package session quota' };
  if (used >= total) {
    return {
      ok: false, httpStatus: 400, used, limit: total,
      message: 'This package has no remaining sessions. All sessions for this package have already been booked or completed.',
    };
  }
  return { ok: true, used, limit: total };
};

/**
 * Put a session into its purchase's group: package_group_id = the purchase id,
 * package_session_number = its place among the purchase's live sessions, session_count = the
 * package size. Safe to call twice for the same session.
 */
const assignSessionToPurchase = async (sessionId, clientPackage) => {
  if (!sessionId || !clientPackage?.id) return { ok: false, error: new Error('session and purchase are required') };
  const total = deriveSessionCount(clientPackage, 0);
  // A single-session purchase is not a package: no group (the admin list shows any grouped
  // session as "Package n/total").
  if (total <= 1) return { ok: true, skipped: true, number: 1, total };
  const { error, used } = await countSessionsInPurchase(clientPackage.id, { excludeSessionId: sessionId });
  if (error) return { ok: false, error };
  const patch = { package_group_id: clientPackage.id, package_session_number: used + 1 };
  if (total > 1) patch.session_count = total;
  const { error: updErr } = await supabaseAdmin.from('sessions').update(patch).eq('id', sessionId);
  if (updErr) return { ok: false, error: updErr };
  return { ok: true, number: used + 1, total };
};

/**
 * Purchase order: the purchase DAY first (admin enters a date, the website a full time, so
 * comparing full timestamps would put an admin entry made later that day first), then when
 * the record was created. A back-dated purchase still sorts on its real day.
 */
const purchaseSortKey = (p) => [
  String(p?.purchased_at || p?.created_at || '').slice(0, 10),
  String(p?.created_at || p?.purchased_at || ''),
];
const comparePurchases = (a, b) => {
  const [ad, at] = purchaseSortKey(a); const [bd, bt] = purchaseSortKey(b);
  return ad.localeCompare(bd) || at.localeCompare(bt) || String(a?.id || '').localeCompare(String(b?.id || ''));
};

/** The client's oldest active purchase of this plan that still has a free slot (or null). */
const findOpenPurchase = async (clientId, catalogPackageId) => {
  const { data, error } = await supabaseAdmin
    .from('client_packages')
    .select('*')
    .eq('client_id', clientId)
    .eq('package_id', catalogPackageId)
    .eq('status', 'active');
  if (error) return { error, purchase: null };
  for (const p of [...(data || [])].sort(comparePurchases)) {
    if ((await purchaseHasRoom(p)).ok) return { error: null, purchase: p };
  }
  return { error: null, purchase: null };
};

/** A, B, … Z, then A1 … Z1, A2 … — never runs out. */
const packageLabel = (index) => {
  const letter = String.fromCharCode(65 + (index % 26));
  const round = Math.floor(index / 26);
  return round === 0 ? letter : `${letter}${round}`;
};

module.exports = {
  deriveSessionCount,
  ensureClientPackageRecord,
  countSessionsInPurchase,
  purchaseHasRoom,
  assignSessionToPurchase,
  findOpenPurchase,
  comparePurchases,
  packageLabel,
  countSessionsTowardClientPackageQuota,
  assertClientPackageHasAvailableSlot
};

