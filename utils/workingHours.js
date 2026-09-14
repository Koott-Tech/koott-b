/**
 * Weekly working hours per therapist, set by admin (psychologists.working_hours,
 * migration 0006). All times IST, "HH:MM"; an end of "24:00" is midnight:
 *   { days: { mon: [{ start: '08:00', end: '17:00' }], …, sun: [] } }
 * A day may hold several shifts (e.g. 09:00–13:00 and 17:00–21:00); an empty
 * list is a day off. Therapists without a schedule keep the platform default,
 * 08:00–22:00 every day.
 *
 * availability.time_slots stays what the slot engine reads: each entry is one
 * hour of working time ("8:00 AM" = 8:00–9:00) and overlapping entries merge, so
 * a shift becomes hourly labels from its start plus one that ends exactly at its
 * end (08:00–17:30 → 8:00 … 4:00 PM, 4:30 PM). Psychiatrists keep a 15-minute grid.
 */

const { supabaseAdmin } = require('../config/supabase');
const { getRecurringBlocksForPsychologist, filterSlotsByRecurringBlocks } = require('./recurringBlocksHelper');
const sessionSlots = require('./sessionSlots');

const DAY_KEYS = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'];
const DEFAULT_WORKING_HOURS = {
  days: Object.fromEntries(DAY_KEYS.map((k) => [k, [{ start: '08:00', end: '22:00' }]])),
};
const HORIZON_DAYS = 21; // the 3-week window the daily job keeps filled
const ACTIVE_STATUSES = sessionSlots.ACTIVE_SESSION_STATUSES
  || ['booked', 'scheduled', 'confirmed', 'rescheduled', 'reschedule_requested'];

const toMin = (hhmm) => {
  const m = /^(\d{1,2}):(\d{2})$/.exec(String(hhmm || '').trim());
  if (!m || +m[2] > 59) return null;
  const v = +m[1] * 60 + +m[2];
  return v <= 1440 ? v : null;
};
const toHHMM = (min) => `${String(Math.floor(min / 60)).padStart(2, '0')}:${String(min % 60).padStart(2, '0')}`;
const toLabel = (min) => {
  const h = Math.floor(min / 60);
  return `${h % 12 || 12}:${String(min % 60).padStart(2, '0')} ${h < 12 ? 'AM' : 'PM'}`;
};
const isPsychiatrist = (p) => String(p?.designation || '').toLowerCase().includes('psychiatrist');
const missingColumn = (error) => /working_hours/.test(error?.message || '');

/** Validate and normalise a schedule. → { value } or { error } */
function normalizeWorkingHours(input) {
  const src = input?.days;
  if (!src || typeof src !== 'object') return { error: 'Working hours need a "days" object' };
  const days = {};
  for (const key of DAY_KEYS) {
    const ranges = [];
    for (const r of Array.isArray(src[key]) ? src[key] : []) {
      const s = toMin(r?.start);
      const e = toMin(r?.end);
      if (s == null || e == null) return { error: `${key}: times must be HH:MM (end up to 24:00)` };
      if (s % 30 || e % 30) return { error: `${key}: use whole or half hours` };
      if (e - s < 60) return { error: `${key}: each shift needs at least 1 hour` };
      ranges.push({ s, e });
    }
    ranges.sort((a, b) => a.s - b.s);
    for (let i = 1; i < ranges.length; i += 1) {
      if (ranges[i].s < ranges[i - 1].e) return { error: `${key}: shifts overlap` };
    }
    days[key] = ranges.map(({ s, e }) => ({ start: toHHMM(s), end: toHHMM(e) }));
  }
  return { value: { days } };
}

const storedSchedule = (wh) => (wh ? normalizeWorkingHours(wh).value || null : null);

/** time_slots labels for a list of shifts. */
function slotsForRanges(ranges, { psychiatrist = false } = {}) {
  const out = new Set();
  for (const r of ranges || []) {
    const s = toMin(r.start);
    const e = toMin(r.end);
    if (s == null || e == null || e <= s) continue;
    if (psychiatrist) {
      for (let t = s; t + 15 <= e; t += 15) out.add(t);
      continue;
    }
    let t = s;
    for (; t + 60 <= e; t += 60) out.add(t);
    if (t < e && e - 60 >= s) out.add(e - 60); // last block ends exactly at the shift end
  }
  return [...out].sort((a, b) => a - b).map(toLabel);
}

const dayKeyOf = (dateStr) => DAY_KEYS[new Date(`${dateStr}T12:00:00Z`).getUTCDay()];

/** Working-time labels for one date: the therapist's schedule, else the platform default. */
function slotsForDate(psych, dateStr) {
  const schedule = storedSchedule(psych?.working_hours) || DEFAULT_WORKING_HOURS;
  return slotsForRanges(schedule.days[dayKeyOf(dateStr)] || [], { psychiatrist: isPsychiatrist(psych) });
}

/** psychologists rows (id, designation, working_hours) — without working_hours before migration 0006. */
async function loadPsychologistsForAvailability(id = null) {
  const run = (cols) => {
    let q = supabaseAdmin.from('psychologists').select(cols);
    if (id) q = q.eq('id', id);
    return q;
  };
  let { data, error } = await run('id, designation, working_hours');
  if (error && missingColumn(error)) ({ data, error } = await run('id, designation'));
  if (error) throw error;
  return data || [];
}

async function getWorkingHours(psychologistId) {
  let columnReady = true;
  const read = (cols) => supabaseAdmin.from('psychologists').select(cols).eq('id', psychologistId).maybeSingle();
  let { data, error } = await read('id, first_name, last_name, designation, working_hours');
  if (error && missingColumn(error)) {
    columnReady = false;
    ({ data, error } = await read('id, first_name, last_name, designation'));
  }
  if (error) throw error;
  if (!data) return { found: false };
  const custom = storedSchedule(data.working_hours);
  return {
    found: true,
    columnReady,
    isCustom: Boolean(custom),
    workingHours: custom || DEFAULT_WORKING_HOURS,
    psychiatrist: isPsychiatrist(data),
    name: `${data.first_name || ''} ${data.last_name || ''}`.trim(),
  };
}

/** Active sessions in [from, to] that no longer fit inside the working hours. Never modified. */
async function bookingsOutsideHours(psych, fromDate, toDate) {
  const { data, error } = await supabaseAdmin
    .from('sessions')
    .select('id, scheduled_date, scheduled_time, session_type, status, client_id')
    .eq('psychologist_id', psych.id)
    .gte('scheduled_date', fromDate)
    .lte('scheduled_date', toDate)
    .in('status', ACTIVE_STATUSES);
  if (error || !data?.length) return [];

  const out = [];
  for (const s of data) {
    const start = sessionSlots.toMinutes(s.scheduled_time);
    if (start == null) continue;
    const minutes = /couple/i.test(s.session_type || '') ? 80 : 50;
    const windows = sessionSlots.workingWindows(slotsForDate(psych, s.scheduled_date));
    if (!windows.some((w) => start >= w.start && start + minutes <= w.end)) {
      out.push({
        sessionId: s.id,
        date: s.scheduled_date,
        time: String(s.scheduled_time).slice(0, 5),
        status: s.status,
        clientId: s.client_id,
      });
    }
  }

  const ids = [...new Set(out.map((c) => c.clientId).filter(Boolean))];
  if (ids.length) {
    const { data: clients } = await supabaseAdmin.from('clients').select('id, first_name, last_name').in('id', ids);
    const names = new Map((clients || []).map((c) => [c.id, `${c.first_name || ''} ${c.last_name || ''}`.trim()]));
    out.forEach((c) => { c.clientName = names.get(c.clientId) || 'Client'; });
  }
  return out.sort((a, b) => `${a.date} ${a.time}`.localeCompare(`${b.date} ${b.time}`));
}

const istYmd = (date) => date.toLocaleDateString('en-CA', { timeZone: 'Asia/Kolkata' });

/**
 * Save a schedule, then rewrite today + the next 3 weeks of availability from
 * it (weekly blocks the therapist set still apply). Booked sessions are never
 * touched; any that now fall outside the hours come back as `conflicts`.
 */
async function saveWorkingHours(psychologistId, input) {
  const { value, error: invalid } = normalizeWorkingHours(input);
  if (invalid) return { success: false, status: 400, message: invalid };

  const { data: saved, error: saveErr } = await supabaseAdmin
    .from('psychologists')
    .update({ working_hours: value, updated_at: new Date().toISOString() })
    .eq('id', psychologistId)
    .select('id, designation');
  if (saveErr) {
    if (missingColumn(saveErr)) {
      return {
        success: false,
        status: 409,
        message: 'The working_hours column is missing — run backend/supabase/migrations/0006_psychologist_working_hours.sql in the Supabase SQL editor first.',
      };
    }
    throw saveErr;
  }
  if (!saved?.length) return { success: false, status: 404, message: 'Psychologist not found' };
  const psych = { ...saved[0], working_hours: value };

  const now = Date.now();
  const dates = Array.from({ length: HORIZON_DAYS + 1 }, (_, i) => istYmd(new Date(now + i * 86400000)));
  const blocks = await getRecurringBlocksForPsychologist(psychologistId);
  const { data: rows, error: rowsErr } = await supabaseAdmin
    .from('availability')
    .select('id, date')
    .eq('psychologist_id', psychologistId)
    .gte('date', dates[0])
    .lte('date', dates[dates.length - 1]);
  if (rowsErr) throw rowsErr;

  const idByDate = new Map((rows || []).map((r) => [r.date, r.id]));
  const stamp = new Date().toISOString();
  const fresh = [];
  let updatedDays = 0;
  for (const date of dates) {
    const time_slots = filterSlotsByRecurringBlocks(slotsForDate(psych, date), date, blocks);
    const is_available = time_slots.length > 0;
    const id = idByDate.get(date);
    if (id) {
      const { error } = await supabaseAdmin
        .from('availability')
        .update({ time_slots, is_available, updated_at: stamp })
        .eq('id', id);
      if (error) console.error(`working hours: could not update ${date}:`, error.message);
      else updatedDays += 1;
    } else {
      fresh.push({ psychologist_id: psychologistId, date, time_slots, is_available, created_at: stamp, updated_at: stamp });
    }
  }
  let createdDays = 0;
  if (fresh.length) {
    const { error } = await supabaseAdmin.from('availability').insert(fresh);
    if (error) console.error('working hours: could not add days:', error.message);
    else createdDays = fresh.length;
  }

  const conflicts = await bookingsOutsideHours(psych, dates[0], dates[dates.length - 1]);
  return {
    success: true,
    message: `Working hours saved — ${updatedDays + createdDays} upcoming days updated`,
    workingHours: value,
    updatedDays,
    createdDays,
    conflicts,
  };
}

module.exports = {
  DAY_KEYS,
  DEFAULT_WORKING_HOURS,
  normalizeWorkingHours,
  slotsForRanges,
  slotsForDate,
  loadPsychologistsForAvailability,
  getWorkingHours,
  saveWorkingHours,
};
