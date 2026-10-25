/**
 * Recording when slots open and close, for the marketing dashboard.
 *
 * Availability is stored as one row per (psychologist_id, date) holding a jsonb
 * array of start times, and every write replaces that array wholesale. That
 * shape cannot say which hours were added or when, so each change is also
 * written here as its own row — see migration 0019.
 *
 * Callers pass the slots before and after; this works out the difference and
 * records only that. Writing the delta rather than the new state is what keeps
 * "slots opened" from counting a therapist who edits one hour as having opened
 * the whole day again.
 *
 * Recording never fails a write. A slot that was opened but not logged costs a
 * row in a report; a booking flow that throws because logging failed costs a
 * client their session, so every error here is swallowed and logged.
 */

const { supabaseAdmin } = require('../config/supabase');
const { normalizeSlotTime } = require('./recurringBlocksHelper');

/** The table arrives with migration 0019; before that, quietly do nothing. */
const missingTable = (error) => error?.code === '42P01'
  || /does not exist/i.test(error?.message || '');

/** "9:00 AM" and "09:00" both become "09:00:00", which is what a time column takes. */
function toSqlTime(slot) {
  const hhmm = normalizeSlotTime(slot);
  return hhmm ? `${hhmm}:00` : null;
}

const uniqueTimes = (slots) => {
  const out = new Set();
  for (const s of slots || []) {
    const t = toSqlTime(s);
    if (t) out.add(t);
  }
  return out;
};

/**
 * Write rows, ignoring ones that clash with the dedupe index.
 *
 * Two code paths reacting to a single action would otherwise each add a row and
 * double the count. The index covers (therapist, date, time, event, instant),
 * so a genuine second change a moment later still lands.
 */
async function writeEvents(rows) {
  if (!rows.length) return { recorded: 0 };
  try {
    const { error } = await supabaseAdmin
      .from('slot_events')
      .upsert(rows, {
        onConflict: 'psychologist_id,slot_date,slot_time,event,occurred_at',
        ignoreDuplicates: true,
      });
    if (error) {
      if (missingTable(error)) return { recorded: 0, skipped: 'table missing' };
      console.error('slot_events: could not record', error.message);
      return { recorded: 0, error: error.message };
    }
    return { recorded: rows.length };
  } catch (err) {
    console.error('slot_events: could not record', err.message);
    return { recorded: 0, error: err.message };
  }
}

/**
 * Record what changed between two slot lists for one therapist and date.
 *
 * @param {Object} args
 * @param {string} args.psychologistId
 * @param {string} args.date            YYYY-MM-DD, the appointment date
 * @param {Array<string>} args.before   slots as they were ([] for a new day)
 * @param {Array<string>} args.after    slots as they now are ([] when cleared)
 * @param {string} [args.actor]         system | therapist | admin | client
 * @param {string} [args.actorId]
 * @param {string} [args.source]        the code path, for tracing
 * @param {boolean} [args.isNewDay]     true when the row did not exist before,
 *                                      so the slots read as 'created' rather
 *                                      than 'opened'
 */
async function recordSlotChange({
  psychologistId, date, before = [], after = [],
  actor = 'system', actorId = null, source = null, isNewDay = false,
}) {
  if (!psychologistId || !date) return { recorded: 0 };

  const was = uniqueTimes(before);
  const now = uniqueTimes(after);

  const added = [...now].filter((t) => !was.has(t));
  const removed = [...was].filter((t) => !now.has(t));
  if (!added.length && !removed.length) return { recorded: 0 };

  // One instant for the whole change, so a day opened in one action groups
  // together and the dedupe index can do its job.
  const occurredAt = new Date().toISOString();
  const slotDate = String(date).slice(0, 10);
  const base = { psychologist_id: psychologistId, slot_date: slotDate, actor, actor_id: actorId, source, occurred_at: occurredAt };

  const rows = [
    ...added.map((slot_time) => ({ ...base, slot_time, event: isNewDay ? 'created' : 'opened' })),
    ...removed.map((slot_time) => ({ ...base, slot_time, event: 'closed' })),
  ];
  return writeEvents(rows);
}

/**
 * Record one slot being taken or released.
 * Booking does not change the availability array — a booked slot is filtered
 * out at read time — so this is recorded from the booking flow, not from a diff.
 */
async function recordSlotBooking({
  psychologistId, date, time, event, actor = 'client', actorId = null, source = null,
}) {
  if (!psychologistId || !date || !time) return { recorded: 0 };
  if (!['booked', 'cancelled'].includes(event)) return { recorded: 0 };
  const slotTime = toSqlTime(time);
  if (!slotTime) return { recorded: 0 };

  return writeEvents([{
    psychologist_id: psychologistId,
    slot_date: String(date).slice(0, 10),
    slot_time: slotTime,
    event,
    actor,
    actor_id: actorId,
    source,
    occurred_at: new Date().toISOString(),
  }]);
}

/**
 * The slots a therapist has on a date right now, for use as `before`.
 * Returns [] when the day has no row yet, which is also the signal for
 * isNewDay.
 */
async function currentSlots(psychologistId, date) {
  try {
    const { data, error } = await supabaseAdmin
      .from('availability')
      .select('time_slots')
      .eq('psychologist_id', psychologistId)
      .eq('date', String(date).slice(0, 10))
      .maybeSingle();
    if (error || !data) return [];
    return Array.isArray(data.time_slots) ? data.time_slots : [];
  } catch (_) {
    return [];
  }
}

module.exports = {
  recordSlotChange,
  recordSlotBooking,
  currentSlots,
  toSqlTime,
};
