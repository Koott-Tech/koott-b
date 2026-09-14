/**
 * Bookable session slots — the one place the session-length rules live.
 *
 *   individual session   50 min
 *   couple session       80 min (1 h 20 min)
 *   psychiatry consult   15 min or 30 min (psychiatrists only; no couple)
 *   break                10 min after every session
 *
 * `availability.time_slots` holds a therapist's WORKING HOURS as hour blocks
 * ("8:00 AM" = 8:00–9:00 is working time). Contiguous blocks merge into a
 * working window, and sessions are cut from each window at read time:
 *
 *   window 8:00–17:00   individual  8:00, 9:00, 10:00 … 16:00   (60-min step)
 *                       couple      8:00, 9:30, 11:00 … 15:30   (90-min step)
 *
 * A session must finish inside its window. A start is dropped when it would
 * overlap, or leave less than the 10-min break around, any booked session,
 * assessment or live checkout hold — each measured with its own length, so a
 * couple booking at 9:30 correctly blocks the individual 10:00 and 11:00 starts.
 *
 * Used by: the booking flow and profile widget (public slots endpoint), client
 * reschedule, reserve-slot / create-order, and every admin booking and
 * reschedule path (overlap check via findOverlaps).
 *
 * Every date and time here is IST (Asia/Kolkata), as stored in the database.
 * `startsAt` is the absolute instant, for converting to the visitor's zone.
 */

const { supabaseAdmin } = require('../config/supabase');
const {
  getRecurringBlocksForPsychologist,
  filterSlotsByRecurringBlocks,
  normalizeSlotTime,
} = require('./recurringBlocksHelper');

const SESSION_MINUTES = { individual: 50, couple: 80, psychiatry_15: 15, psychiatry_30: 30 };
const BREAK_MINUTES = 10;
const FREE_ASSESSMENT_MINUTES = 20;
const WORK_BLOCK_MINUTES = 60;          // one stored time_slots entry
const IST_OFFSET_MINUTES = 330;

// Every status that still occupies the therapist's time.
const ACTIVE_SESSION_STATUSES = [
  'booked', 'rescheduled', 'reschedule_requested', 'confirmed', 'scheduled', 'upcoming', 'pending',
];
const ACTIVE_LOCK_STATUSES = ['SLOT_HELD', 'PAYMENT_PENDING', 'PAYMENT_SUCCESS'];

const isCoupleType = (packageType) => String(packageType || '').toLowerCase().startsWith('couple');

/**
 * Psychiatrist package types: 'psychiatry_15' (one 15-min consult), 'psychiatry_30'
 * (one 30-min consult), 'psychiatry_15_package_N' (N × 15-min consults).
 * -> 'psychiatry_15' | 'psychiatry_30' | null
 */
const psychiatryKind = (packageType) => {
  const m = /^psychiatry_(15|30)(?:_package_\d+)?$/.exec(String(packageType || '').toLowerCase());
  return m ? `psychiatry_${m[1]}` : null;
};
const isPsychiatryType = (packageType) => Boolean(psychiatryKind(packageType));

/** 'couple_package_6' -> 'couple'; 'psychiatry_15_package_3' -> 'psychiatry_15'; else 'individual' */
const sessionKind = (packageType) => psychiatryKind(packageType) || (isCoupleType(packageType) ? 'couple' : 'individual');

const sessionMinutes = (kind) => SESSION_MINUTES[kind] || SESSION_MINUTES.individual;

const sessionMinutesForPackageType = (packageType) => sessionMinutes(sessionKind(packageType));

/**
 * Length of one session: an explicit admin override wins, then the package
 * type, then the session's own type ('couple' on manual bookings).
 */
function sessionLengthMinutes({ packageType, sessionType, durationMinutes } = {}) {
  const override = Number(durationMinutes);
  if (Number.isFinite(override) && override > 0) return Math.round(override);
  if (sessionType === 'free_assessment') return FREE_ASSESSMENT_MINUTES;
  return sessionMinutesForPackageType(packageType || sessionType);
}

/**
 * The packages these rules govern: therapy (individual / couple / package_N) and
 * psychiatry (psychiatry_15 / psychiatry_30 / psychiatry_15_package_N).
 * Child-specialist (`cs_*`) sessions have their own lengths and keep their own flow.
 */
const isStandardTherapyType = (packageType) => !packageType
  || /^(individual|couple)(_package_\d+)?$/.test(packageType)
  || /^package_\d+$/.test(packageType)
  || isPsychiatryType(packageType);

/** "9:00 AM" | "09:00" | "09:00:00" -> minutes after midnight (null if unreadable) */
function toMinutes(value) {
  const hhmm = normalizeSlotTime(value);
  if (!hhmm) return null;
  const [h, m] = hhmm.split(':').map(Number);
  return Number.isFinite(h) && Number.isFinite(m) ? h * 60 + m : null;
}

const pad = (n) => String(n).padStart(2, '0');

/** 570 -> "09:30:00" — the format the time columns store */
const toTimeString = (min) => `${pad(Math.floor(min / 60))}:${pad(min % 60)}:00`;

/** 570 -> "9:30 AM" */
function toLabel(min) {
  const h = Math.floor(min / 60);
  const h12 = h % 12 === 0 ? 12 : h % 12;
  return `${h12}:${pad(min % 60)} ${h < 12 ? 'AM' : 'PM'}`;
}

/** IST wall-clock date + minutes -> ISO instant */
function istInstant(date, min) {
  const [y, m, d] = date.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d, 0, min) - IST_OFFSET_MINUTES * 60000).toISOString();
}

/** Today's IST date and the minutes elapsed in it. */
function nowInIst() {
  const ist = new Date(Date.now() + IST_OFFSET_MINUTES * 60000);
  return { date: ist.toISOString().slice(0, 10), minutes: ist.getUTCHours() * 60 + ist.getUTCMinutes() };
}

/**
 * Stored blocks -> merged working windows [{start, end}] in minutes. Therapists'
 * hours are hour blocks; psychiatrists' are stored on a 15-minute grid
 * ("6:00 PM", "6:15 PM" … "11:45 PM"), so a day with 15-minute steps is read as
 * 15-minute blocks — otherwise the last one would add 45 minutes of phantom time.
 */
function workingWindows(timeSlots) {
  const starts = [...new Set((timeSlots || []).map(toMinutes).filter((n) => n != null))]
    .sort((a, b) => a - b);
  const block = starts.some((s, i) => i > 0 && s - starts[i - 1] === 15) ? 15 : WORK_BLOCK_MINUTES;
  const windows = [];
  starts.forEach((start) => {
    const end = start + block;
    const last = windows[windows.length - 1];
    if (last && start <= last.end) last.end = Math.max(last.end, end);
    else windows.push({ start, end });
  });
  return windows;
}

/** Session starts inside each window: session, break, session, … */
function cutSessions(windows, duration) {
  const starts = [];
  windows.forEach((w) => {
    for (let s = w.start; s + duration <= w.end; s += duration + BREAK_MINUTES) starts.push(s);
  });
  return starts;
}

/** Would a session at `start` overlap, or crowd the break of, anything in `busy`? */
const clashes = (start, duration, busy) => busy.some(
  (b) => start < b.start + b.minutes + BREAK_MINUTES && b.start < start + duration + BREAK_MINUTES,
);

async function packageTypesById(ids) {
  if (!ids.length) return new Map();
  const { data } = await supabaseAdmin.from('packages').select('id, package_type').in('id', ids);
  return new Map((data || []).map((p) => [p.id, p.package_type]));
}

/**
 * Everything already occupying the therapist, by IST date:
 * { 'YYYY-MM-DD': [{ start, minutes, source, id }] }.
 *   ignoreClientId    skip that client's own checkout holds, so retrying a
 *                     payment does not collide with the first attempt's hold
 *   excludeSessionId  skip the session being moved (reschedule)
 */
async function loadBusy(psychologistId, startDate, endDate, { ignoreClientId, excludeSessionId } = {}) {
  const [sessionsRes, assessmentsRes, locksRes] = await Promise.all([
    supabaseAdmin
      .from('sessions')
      .select('id, scheduled_date, scheduled_time, package_id, session_type')
      .eq('psychologist_id', psychologistId)
      .gte('scheduled_date', startDate)
      .lte('scheduled_date', endDate)
      .in('status', ACTIVE_SESSION_STATUSES),
    supabaseAdmin
      .from('assessment_sessions')
      .select('id, scheduled_date, scheduled_time')
      .eq('psychologist_id', psychologistId)
      .gte('scheduled_date', startDate)
      .lte('scheduled_date', endDate)
      .in('status', ['booked', 'reserved']),
    supabaseAdmin
      .from('slot_locks')
      .select('id, scheduled_date, scheduled_time, order_id, client_id')
      .eq('psychologist_id', psychologistId)
      .gte('scheduled_date', startDate)
      .lte('scheduled_date', endDate)
      .in('status', ACTIVE_LOCK_STATUSES)
      .gt('slot_expires_at', new Date().toISOString()),
  ]);

  // Offering slots without knowing the bookings would invite double-booking.
  if (sessionsRes.error) throw sessionsRes.error;
  if (assessmentsRes.error) console.error('sessionSlots: assessment sessions unavailable:', assessmentsRes.error.message);
  if (locksRes.error) console.error('sessionSlots: slot locks unavailable:', locksRes.error.message);

  const sessions = (sessionsRes.data || []).filter((s) => !excludeSessionId || s.id !== excludeSessionId);
  const locks = (locksRes.data || []).filter((l) => !ignoreClientId || l.client_id !== ignoreClientId);

  // A hold only knows its order; the order's payment row knows the package.
  const orderIds = locks.map((l) => l.order_id).filter(Boolean);
  let packageByOrder = new Map();
  if (orderIds.length) {
    const { data } = await supabaseAdmin
      .from('payments')
      .select('razorpay_order_id, package_id')
      .in('razorpay_order_id', orderIds);
    packageByOrder = new Map((data || []).map((p) => [p.razorpay_order_id, p.package_id]));
  }

  const types = await packageTypesById([
    ...new Set([...sessions.map((s) => s.package_id), ...packageByOrder.values()].filter(Boolean)),
  ]);

  const busy = {};
  const add = (date, time, minutes, source, id) => {
    const start = toMinutes(time);
    if (!date || start == null) return;
    (busy[date] = busy[date] || []).push({ start, minutes, source, id });
  };
  sessions.forEach((s) => add(
    s.scheduled_date, s.scheduled_time,
    sessionLengthMinutes({ packageType: types.get(s.package_id), sessionType: s.session_type }),
    'session', s.id,
  ));
  (assessmentsRes.data || []).forEach((a) => add(a.scheduled_date, a.scheduled_time, SESSION_MINUTES.individual, 'assessment', a.id));
  locks.forEach((l) => add(
    l.scheduled_date, l.scheduled_time,
    sessionMinutesForPackageType(types.get(packageByOrder.get(l.order_id))),
    'checkout_hold', l.id,
  ));
  return busy;
}

/**
 * Free session starts for one therapist between two IST dates (inclusive).
 * `options` = { ignoreClientId, excludeSessionId } (see loadBusy).
 * @returns {Promise<Array<{date, slots: Array<{time, displayTime, startsAt}>}>>}
 *          only the days with at least one free start
 */
async function getBookableSlots(psychologistId, startDate, endDate, kind = 'individual', options = {}) {
  const duration = sessionMinutes(kind);

  const [availabilityRes, recurringBlocks, busy] = await Promise.all([
    supabaseAdmin
      .from('availability')
      .select('date, time_slots, is_available')
      .eq('psychologist_id', psychologistId)
      .gte('date', startDate)
      .lte('date', endDate)
      .order('date', { ascending: true }),
    getRecurringBlocksForPsychologist(psychologistId),
    loadBusy(psychologistId, startDate, endDate, options),
  ]);
  if (availabilityRes.error) throw availabilityRes.error;

  const now = nowInIst();
  const days = [];
  (availabilityRes.data || []).forEach((row) => {
    if (!row.is_available || row.date < now.date) return;
    const hours = filterSlotsByRecurringBlocks(row.time_slots || [], row.date, recurringBlocks);
    const starts = cutSessions(workingWindows(hours), duration)
      .filter((s) => row.date > now.date || s > now.minutes)
      .filter((s) => !clashes(s, duration, busy[row.date] || []));
    if (!starts.length) return;
    days.push({
      date: row.date,
      slots: starts.map((s) => ({ time: toTimeString(s), displayTime: toLabel(s), startsAt: istInstant(row.date, s) })),
    });
  });
  return days;
}

/**
 * Client-side guard (reserve-slot, create-order, client reschedule): is this
 * exact start still one of the bookable starts for this package's length?
 */
async function checkSlotBookable({ psychologistId, date, time, packageType, ignoreClientId, excludeSessionId }) {
  if (!isStandardTherapyType(packageType)) return { ok: true, skipped: true };

  // Psychiatry packages are checked on their own 15/30-min grid. A psychiatrist
  // booked on an old therapy package (legacy data) keeps the old unchecked path.
  if (!isPsychiatryType(packageType)) {
    const { data: psych } = await supabaseAdmin
      .from('psychologists')
      .select('designation')
      .eq('id', psychologistId)
      .maybeSingle();
    if ((psych?.designation || '').toLowerCase().includes('psychiatrist')) return { ok: true, skipped: true };
  }

  const target = toMinutes(time);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(date || '')) || target == null) {
    return { ok: false, message: 'Please pick a valid date and time.' };
  }

  const [day] = await getBookableSlots(
    psychologistId, date, date, sessionKind(packageType), { ignoreClientId, excludeSessionId },
  );
  if (day && day.slots.some((s) => toMinutes(s.time) === target)) return { ok: true };
  return { ok: false, message: 'That time is no longer available for this session. Please pick another slot.' };
}

/**
 * Admin guard: what would a `minutes`-long session at date/time overlap
 * (break included)? Admins may book outside the working-hours grid, but never
 * on top of another session, assessment or live checkout hold.
 * @returns {Promise<Array<{start, minutes, source, id}>>} empty when clear
 */
async function findOverlaps({ psychologistId, date, time, minutes, excludeSessionId }) {
  const start = toMinutes(time);
  if (!psychologistId || !/^\d{4}-\d{2}-\d{2}$/.test(String(date || '')) || start == null) return [];
  const length = Number(minutes) > 0 ? Number(minutes) : SESSION_MINUTES.individual;
  const busy = (await loadBusy(psychologistId, date, date, { excludeSessionId }))[date] || [];
  return busy.filter((b) => clashes(start, length, [b]));
}

/** "HH:MM" of a busy entry, for error messages. */
const busyLabel = (b) => toLabel(b.start);

module.exports = {
  SESSION_MINUTES,
  BREAK_MINUTES,
  ACTIVE_SESSION_STATUSES,
  isPsychiatryType,
  sessionKind,
  sessionMinutes,
  sessionMinutesForPackageType,
  sessionLengthMinutes,
  isStandardTherapyType,
  toMinutes,
  toTimeString,
  workingWindows,
  cutSessions,
  getBookableSlots,
  checkSlotBookable,
  findOverlaps,
  busyLabel,
};
