/**
 * Canonical "when the client booked", plus the finance-dashboard aggregation helpers
 * built on top of it.
 *
 * Booking time is read from the persisted `booking_created_at` column, falling back to
 * the row's `created_at`, which is written at checkout.
 */
function parseIsoFlexible(value) {
  if (value == null || value === '') return null;
  if (typeof value === 'number') {
    const d = new Date(value < 1e12 ? value * 1000 : value);
    return Number.isNaN(d.getTime()) ? null : d.toISOString();
  }
  const s = String(value).trim();
  if (!s) return null;
  if (/^\d+$/.test(s)) {
    const n = Number(s);
    if (!Number.isFinite(n)) return null;
    const d = new Date(n < 1e12 ? n * 1000 : n);
    return Number.isNaN(d.getTime()) ? null : d.toISOString();
  }
  const d = new Date(s);
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
}

/** @returns {string|null} ISO timestamp */
function getSessionBookingCreatedAtIso(sessionRow) {
  if (!sessionRow || typeof sessionRow !== 'object') return null;
  return parseIsoFlexible(sessionRow.booking_created_at) || parseIsoFlexible(sessionRow.created_at);
}

/** YYYY-MM-DD for `iso` in a given IANA zone. */
function getCalendarYmdInTimeZone(iso, timeZone = 'Asia/Kolkata') {
  if (!iso) return '';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  try {
    return new Intl.DateTimeFormat('sv-SE', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit' }).format(d).slice(0, 10);
  } catch {
    return '';
  }
}

/** IST calendar booking day — the business day ops and finance reconcile against. */
function getSessionBookingCreatedIstDateString(sessionRow) {
  return getCalendarYmdInTimeZone(getSessionBookingCreatedAtIso(sessionRow), 'Asia/Kolkata');
}

/** Legacy UTC booking day — prefer {@link getSessionBookingCreatedIstDateString}. */
function getSessionBookingCreatedUtcDateString(sessionRow) {
  const iso = getSessionBookingCreatedAtIso(sessionRow);
  if (!iso) return '';
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? '' : d.toISOString().split('T')[0];
}

/**
 * Stable key so one client checkout counts once on the finance dashboard.
 *
 * A package checkout creates one session row per included session, and all of them share
 * a single `payment_id` — so keying on the payment collapses them into the one booking the
 * client actually made. Rows without a payment (manual/record-only bookings) count
 * individually by row id.
 */
function getFinanceBookingDedupeKey(sessionRow) {
  if (!sessionRow || typeof sessionRow !== 'object') return '';
  const pid = sessionRow.payment_id;
  if (pid != null && String(pid).trim() !== '') return `payment:${String(pid).trim()}`;
  if (sessionRow.id != null && String(sessionRow.id).trim() !== '') return `row:${String(sessionRow.id)}`;
  return '';
}

function countDistinctFinanceBookings(sessionRows) {
  const keys = new Set();
  if (!sessionRows || !Array.isArray(sessionRows)) return 0;
  for (let i = 0; i < sessionRows.length; i++) {
    const k = getFinanceBookingDedupeKey(sessionRows[i]);
    if (k) keys.add(k);
  }
  return keys.size;
}

/** Recognized revenue for a session row. */
function getSessionFinanceRevenueAmount(sessionRow) {
  if (!sessionRow || typeof sessionRow !== 'object') return 0;
  return parseFloat(sessionRow.price) || 0;
}

module.exports = {
  parseIsoFlexible,
  getSessionBookingCreatedAtIso,
  getCalendarYmdInTimeZone,
  getSessionBookingCreatedIstDateString,
  getSessionBookingCreatedUtcDateString,
  getFinanceBookingDedupeKey,
  countDistinctFinanceBookings,
  getSessionFinanceRevenueAmount,
};
