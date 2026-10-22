/**
 * Date blocks — a therapist blocking one calendar date rather than a weekday.
 *
 * The weekday counterpart lives in recurringBlocksHelper.js and answers "is
 * every Tuesday blocked"; this answers "is the 3rd of November blocked". Both
 * are consulted when availability is read, and a slot is unavailable if either
 * one covers it.
 *
 * time_slots holds 24h "HH:MM" starts. Stored availability uses 12h labels
 * ("9:00 AM"), so comparison goes through normalizeSlotTime from the recurring
 * helper, which reads both.
 */

const { supabaseAdmin } = require('../config/supabase');
const { normalizeSlotTime } = require('./recurringBlocksHelper');

/** True while the table has not been created yet (migration 0018 not run). */
const missingTable = (error) => error?.code === '42P01'
  || /does not exist/i.test(error?.message || '');

/**
 * Normalize slots for storage: 24h, two digits, duplicates dropped, sorted.
 * Returns null for an empty list so the column reads as "no specific slots".
 */
function normalizeTimeSlotsForStorage(slots) {
  if (!Array.isArray(slots) || slots.length === 0) return null;
  const out = [...new Set(slots.map(normalizeSlotTime).filter(Boolean))].sort();
  return out.length ? out : null;
}

/**
 * Every date block for a psychologist from `fromDate` onward.
 * Past blocks are left out: they can no longer affect a bookable slot, and the
 * therapist's list should not fill up with dates that have gone by.
 * @param {string} psychologistId
 * @param {string} [fromDate] - YYYY-MM-DD, defaults to today in IST
 * @returns {Promise<Array>}
 */
async function getDateBlocksForPsychologist(psychologistId, fromDate = null) {
  const from = fromDate || new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Kolkata' });
  try {
    const { data, error } = await supabaseAdmin
      .from('psychologist_date_blocks')
      .select('*')
      .eq('psychologist_id', psychologistId)
      .gte('date', from)
      .order('date', { ascending: true });

    if (error) {
      if (missingTable(error)) return [];
      console.error('Error fetching date blocks:', error);
      return [];
    }
    return data || [];
  } catch (err) {
    console.error('Error fetching date blocks:', err);
    return [];
  }
}

/**
 * Is this slot blocked on this date?
 * @param {Array} dateBlocks - from getDateBlocksForPsychologist
 * @param {string} dateStr - YYYY-MM-DD
 * @param {string} timeSlot - "09:00" or "9:00 AM"
 * @returns {boolean}
 */
function isSlotBlockedByDate(dateBlocks, dateStr, timeSlot) {
  if (!dateBlocks || dateBlocks.length === 0) return false;
  const block = dateBlocks.find((b) => String(b.date).slice(0, 10) === dateStr);
  if (!block) return false;
  if (block.block_entire_day) return true;

  const slots = block.time_slots || [];
  const wanted = normalizeSlotTime(timeSlot);
  if (!wanted) return false;
  return slots.some((s) => normalizeSlotTime(s) === wanted);
}

/**
 * Drop the slots a date block covers.
 * @param {Array<string>} timeSlots
 * @param {string} dateStr - YYYY-MM-DD
 * @param {Array} dateBlocks
 * @returns {Array<string>}
 */
function filterSlotsByDateBlocks(timeSlots, dateStr, dateBlocks) {
  if (!timeSlots || timeSlots.length === 0) return [];
  if (!dateBlocks || dateBlocks.length === 0) return timeSlots;
  return timeSlots.filter((slot) => !isSlotBlockedByDate(dateBlocks, dateStr, slot));
}

module.exports = {
  normalizeTimeSlotsForStorage,
  getDateBlocksForPsychologist,
  isSlotBlockedByDate,
  filterSlotsByDateBlocks,
};
