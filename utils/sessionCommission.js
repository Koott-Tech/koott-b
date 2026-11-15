/**
 * Single source of truth for doctor_wallet (per-session doctor commission) calculation.
 *
 * Package rule: total package commission is split EQUALLY across all sessions.
 *   e.g. package of 3 with total doctor commission ₹600 → ₹200 per session.
 *   Sessions #2, #3 have price=0 but still earn their share when completed.
 *
 * Priority order:
 *   1. commission_history row (most authoritative — already settled)
 *   2. therapist_commission field (manually overridden by admin)
 *   3. doctor_commissions rates (auto-calculated)
 */

/**
 * @param {object} session  - The session row (must include session_type, price,
 *                            package_id, session_count, package_session_number,
 *                            therapist_commission, id)
 * @param {object|null} dc  - The doctor_commissions row for this psychologist
 * @param {object|null} ch  - The commission_history row for this session (or null)
 * @param {object}      [opts]              - Optional hints
 * @param {boolean}     [opts.isFirstSession] - true → first-session rate,
 *                                              false → follow-up rate,
 *                                              undefined → legacy fallback
 * @returns {number}        - doctor_wallet in rupees (≥ 0)
 */
function computeSessionDoctorWallet(session, dc, ch, opts) {
  const s = session || {};
  const sessionTypeText = String(s.session_type || '').toLowerCase();
  const totalSessions = Math.max(1, parseInt(s.session_count, 10) || 1);
  const isCoupleSession = sessionTypeText.includes('couple') ||
    sessionTypeText.includes('cpl');

  // A package is a session of a multi-session purchase. A catalog plan id alone is NOT enough:
  // website individual and couple bookings carry the therapist's 1-session "individual" /
  // "couple" plan in package_id, and treating them as packages fell through to
  // "price − company package commission" (usually ₹0) — crediting the therapist 100% of the price.
  const isPackage = isPackageSessionLike(s);

  // ── 1. commission_history (already settled — most authoritative) ─────────
  // commission_history stores per-session amounts (not totals), so no further
  // splitting by totalSessions is needed here.
  if (ch) {
    const sessionAmt = parseFloat(ch.session_amount || s.price || 0);
    const companyAmt = parseFloat(ch.commission_amount || 0);
    const totalDoc = Math.max(0, sessionAmt - companyAmt);
    return Math.round(totalDoc);
  }

  // ── 2. therapist_commission (manually set by admin) ──────────────────────
  // This column stores the PER-SESSION amount, not a whole-package total, so it must NOT be
  // divided by session_count. Verified against live data: of 311 package sessions carrying a
  // value, 273 equal (package_total ÷ N) and ZERO equal the package total.
  // Dividing it again underpaid every package session that has no commission_history row —
  // e.g. a ₹1,000/session 9-pack paid ₹1,000/9 = ₹111, and a ₹100 3-pack paid ₹33.
  const tc = parseFloat(s.therapist_commission);
  if (!isNaN(tc) && tc > 0) {
    return Math.round(tc);
  }

  // ── 3. doctor_commissions rates ──────────────────────────────────────────
  if (!dc) return 0;

  if (isPackage) {
    const pkgPackages = (dc.doctor_commission_packages && typeof dc.doctor_commission_packages === 'object')
      ? dc.doctor_commission_packages : {};

    // Package configs store the doctor's WHOLE-package amount. Split that total
    // equally across completed package sessions, using the caller's first/follow-up hint.
    const packageType = isCoupleSession ? `couple_package_${totalSessions}` : `package_${totalSessions}`;
    const fallbackPackageType = `package_${totalSessions}`;
    const isFirst = opts?.isFirstSession;
    const firstKeys = [
      `${packageType}_first_session`,
      `${fallbackPackageType}_first_session`,
      'doctor_commission_first_session_package'
    ].filter(Boolean);
    const followupKeys = [
      `${packageType}_followup`,
      `${fallbackPackageType}_followup`,
      'doctor_commission_followup_package'
    ].filter(Boolean);
    const orderedKeys = isFirst === true
      ? [...firstKeys, ...followupKeys]
      : (isFirst === false ? [...followupKeys, ...firstKeys] : [...followupKeys, ...firstKeys]);

    const pickTotal = (keys) => keys.reduce((value, key) => {
      if (value != null) return value;
      return Object.prototype.hasOwnProperty.call(pkgPackages, key) ? pkgPackages[key] : dc[key];
    }, null);

    let totalPackageCommission = parseFloat(pickTotal(orderedKeys) ?? 0);

    /**
     * Per-session split.
     *
     * The stored package totals are NOT flat multiples — the rate sheet builds a "first"
     * package as one session at the first-session rate plus the rest at the follow-up rate
     * (Thaniya's 3-pack: 1250 + 1300 + 1300 = 3850). Dividing that total equally gave every
     * session 1283.33: a rate the sheet never specifies, and fractions on screen for a
     * business whose prices are whole rupees.
     *
     * So recover the two per-session rates from the two totals:
     *     follow-up/session = package_N_followup / N
     *     first/session     = package_N_first_session - follow-up/session * (N - 1)
     * then pay session 1 the first rate and sessions 2..N the follow-up rate. The package
     * total still reconciles exactly, and every amount comes out whole.
     *
     * Only the client's FIRST package has a first-rate session; a repeat package is all
     * follow-ups, which is exactly what package_N_followup / N already encodes.
     */
    const followupTotalRaw = parseFloat(pickTotal(followupKeys) ?? NaN);
    const firstTotalRaw = parseFloat(pickTotal(firstKeys) ?? NaN);
    if (
      totalSessions > 1 &&
      Number.isFinite(followupTotalRaw) && followupTotalRaw > 0 &&
      Number.isFinite(firstTotalRaw) && firstTotalRaw > 0
    ) {
      const followupPerSession = followupTotalRaw / totalSessions;
      const firstPerSession = firstTotalRaw - followupPerSession * (totalSessions - 1);
      const positionIsFirst = (parseInt(s.package_session_number, 10) || 1) <= 1;
      // A first-rate session exists only in the client's first package, and only at position 1.
      const useFirstRate = isFirst === true && positionIsFirst;
      const chosen = useFirstRate ? firstPerSession : followupPerSession;
      if (Number.isFinite(chosen) && chosen >= 0) return Math.max(0, Math.round(chosen));
    }

    if ((!totalPackageCommission || totalPackageCommission <= 0) && isCoupleSession) {
      const couplePerSession = parseFloat(pkgPackages.couple_session ?? pkgPackages.cpl_session ?? dc.doctor_commission_individual ?? 0);
      if (Number.isFinite(couplePerSession) && couplePerSession > 0) {
        totalPackageCommission = couplePerSession * totalSessions;
      }
    }

    if ((!totalPackageCommission || totalPackageCommission <= 0) && parseFloat(s.price || 0) > 0) {
      const pkgAmts = (dc.commission_amounts && typeof dc.commission_amounts === 'object') ? dc.commission_amounts : {};
      const companyCommission = parseFloat(
        pkgAmts[packageType] ?? pkgAmts[fallbackPackageType] ?? pkgAmts.package ?? dc.commission_amount_package ?? 0
      );
      totalPackageCommission = Math.max(0, parseFloat(s.price) - companyCommission);
    }
    return Math.max(0, Math.round(totalPackageCommission / totalSessions));
  }

  // Non-package: couple session
  if (isCoupleSession) {
    const pkgPackages = (dc.doctor_commission_packages && typeof dc.doctor_commission_packages === 'object')
      ? dc.doctor_commission_packages : {};
    const coupleRate = parseFloat(
      pkgPackages.couple_session ?? pkgPackages.cpl_session ?? dc.doctor_commission_individual ?? 0
    );
    if (coupleRate > 0) return coupleRate;
  }

  // Non-package individual: must have positive price
  const sessionAmt = parseFloat(s.price || 0);
  if (sessionAmt <= 0) return 0;

  // When the caller knows whether this is a first or follow-up session, pick
  // the matching rate directly. Otherwise fall back to the legacy chain which
  // prefers first-session (backward-compatible for callers that don't track it).
  const isFirst = opts?.isFirstSession;
  let indRate;
  if (isFirst === true) {
    indRate = parseFloat(dc.doctor_commission_first_session || dc.doctor_commission_followup || 0);
  } else if (isFirst === false) {
    indRate = parseFloat(dc.doctor_commission_followup || dc.doctor_commission_first_session || 0);
  } else {
    // Legacy fallback (isFirstSession not provided)
    indRate = parseFloat(dc.doctor_commission_first_session || dc.doctor_commission_followup || 0);
  }
  if (indRate > 0) return indRate;

  // Fallback: session price − individual company commission
  const pkgAmts = (dc.commission_amounts && typeof dc.commission_amounts === 'object') ? dc.commission_amounts : {};
  const companyInd = parseFloat(pkgAmts.individual ?? dc.commission_amount_individual ?? 0);
  return Math.max(0, sessionAmt - companyInd);
}

/* ------------------------------------------------------------------------------------
 * First-session rate: who gets it (one rule for every finance screen and for payouts)
 *
 *   · A client's FIRST session is their earliest session at Koott (any therapist, any
 *     date) that wasn't cancelled — read from their whole history, never from the date
 *     range or therapist a screen happens to have loaded (a range-filtered list made a
 *     long-standing client's first session "of the month" look like their first ever).
 *   · Clients imported from past contact lists (created before PRE_EXISTING_CLIENT_CUTOFF)
 *     are past clients: none of their sessions is a first session.
 *   · For packages, the first package is the PURCHASE that contains that first session
 *     (sessions.package_group_id = client_packages.id). It used to be the catalog plan id,
 *     which is shared by every client of the therapist — so once any client started on a
 *     therapist's 3-pack, every client's 3-pack (and every repeat 3-pack) got the first rate.
 *     computeSessionDoctorWallet then applies the first rate to position 1 only.
 * ---------------------------------------------------------------------------------- */

const PRE_EXISTING_CLIENT_CUTOFF = '2025-06-01';
const HISTORY_STATUSES = ['booked', 'pending', 'completed', 'rescheduled', 'reschedule_requested', 'no_show', 'noshow', 'refunded'];

/** client_ids imported from past contact lists (they never get the first-session rate). */
async function getPreExistingClientIds(supabaseAdmin, clientIds) {
  const ids = Array.from(new Set((clientIds || []).filter(Boolean)));
  const result = new Set();
  for (let i = 0; i < ids.length; i += 500) {
    const { data } = await supabaseAdmin
      .from('clients')
      .select('id, created_at')
      .in('id', ids.slice(i, i + 500))
      .lt('created_at', PRE_EXISTING_CLIENT_CUTOFF);
    (data || []).forEach((c) => result.add(c.id));
  }
  return result;
}

/** Which purchase a package session belongs to (the plan, per client, for ungrouped legacy rows). */
function purchaseKeyOf(s) {
  if (!s) return null;
  if (s.package_group_id) return `g:${s.package_group_id}`;
  if (s.package_id && s.client_id) return `p:${s.client_id}|${s.package_id}`;
  return null;
}

function isPackageSessionLike(s) {
  if (!s) return false;
  const type = String(s.session_type || '').toLowerCase();
  if ((parseInt(s.session_count, 10) || 1) > 1 || type.includes('package')) return true;
  // Old rows with no session type: a plan id still marks a package (previous behaviour).
  const hasPlan = !!(s.package_id && s.package_id !== 'null' && s.package_id !== 'undefined');
  return hasPlan && !type;
}

/**
 * For the given sessions, load their clients' full history and work out first sessions.
 * Returns { firstSessionIds, firstPurchaseKeys, isFirstSession(session) } where
 * isFirstSession is the hint to pass to computeSessionDoctorWallet({ isFirstSession }).
 */
async function resolveFirstSessionFlags(supabaseAdmin, sessions) {
  const clientIds = Array.from(new Set((sessions || []).map((s) => s && s.client_id).filter(Boolean)));
  const firstSessionIds = new Set();
  const firstPurchaseKeys = new Set();
  if (clientIds.length) {
    const history = [];
    for (let i = 0; i < clientIds.length; i += 100) {
      let from = 0;
      for (;;) {
        const { data, error } = await supabaseAdmin
          .from('sessions')
          .select('id, client_id, created_at, scheduled_date, status, session_type, package_id, package_group_id, session_count')
          .in('client_id', clientIds.slice(i, i + 100))
          .in('status', HISTORY_STATUSES)
          .neq('session_type', 'free_assessment')
          .range(from, from + 999);
        if (error) throw error;
        history.push(...(data || []));
        if (!data || data.length < 1000) break;
        from += 1000;
      }
    }
    const byClient = {};
    history.forEach((s) => { (byClient[s.client_id] = byClient[s.client_id] || []).push(s); });
    const preExisting = await getPreExistingClientIds(supabaseAdmin, Object.keys(byClient));
    Object.entries(byClient).forEach(([clientId, list]) => {
      if (preExisting.has(clientId)) return;
      const first = list.sort((a, b) =>
        String(a.created_at || a.scheduled_date || '').localeCompare(String(b.created_at || b.scheduled_date || ''))
        || String(a.id).localeCompare(String(b.id)))[0];
      if (!first) return;
      firstSessionIds.add(first.id);
      if (isPackageSessionLike(first)) {
        const key = purchaseKeyOf(first);
        if (key) firstPurchaseKeys.add(key);
      }
    });
  }
  const isFirstSession = (s) => {
    if (!s) return false;
    if (isPackageSessionLike(s)) {
      const key = purchaseKeyOf(s);
      return key ? firstPurchaseKeys.has(key) : firstSessionIds.has(s.id);
    }
    return firstSessionIds.has(s.id);
  };
  return { firstSessionIds, firstPurchaseKeys, isFirstSession };
}

module.exports = {
  computeSessionDoctorWallet,
  resolveFirstSessionFlags,
  getPreExistingClientIds,
  purchaseKeyOf,
  isPackageSessionLike,
  PRE_EXISTING_CLIENT_CUTOFF,
};
