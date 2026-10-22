/**
 * The blocks a therapist puts on their own time, and how availability honours
 * them. Two shapes, both handled here so every caller gets both:
 *
 *   weekly  - "every Sunday", repeating for six months (day_of_week set)
 *   by date - "the 3rd of November", one date only (date set)
 *
 * getRecurringBlocksForPsychologist returns them together, and a slot is
 * unavailable if either kind covers it. Callers that already pass a date get
 * date blocks for free; the two that work from a weekday pass the date too.
 */

const { supabaseAdmin } = require('../config/supabase');

const DAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];

/**
 * Get day of week from date string (YYYY-MM-DD). 0 = Sunday, 6 = Saturday (JavaScript convention).
 */
function getDayOfWeekFromDate(dateStr) {
  if (!dateStr) return null;
  const d = new Date(dateStr + 'T12:00:00');
  if (Number.isNaN(d.getTime())) return null;
  return d.getDay();
}

/**
 * Normalize time slot to 24h HH:MM for comparison.
 * Handles: "08:00", "8:00", "8:00 AM", "1:00 PM", "13:00", "21:00" etc.
 * Default availability stores 12h ("8:00 AM", "9:00 PM"); recurring blocks store 24h ("08:00", "21:00").
 */
function normalizeSlotTime(slot) {
  if (!slot) return null;
  const s = String(slot).trim();
  const match = s.match(/(\d{1,2}):(\d{2})(?::\d{2})?\s*(AM|PM)?/i);
  if (!match) return null;
  let h = parseInt(match[1], 10);
  const m = match[2];
  const period = (match[3] || '').toUpperCase();

  if (period === 'PM' && h !== 12) h += 12;
  else if (period === 'AM' && h === 12) h = 0;
  else if (!period && h >= 0 && h <= 23) { /* already 24h */ }
  else if (!period && h >= 1 && h <= 12) { /* assume 24h if no AM/PM, leave as-is */ }

  const hStr = String(h).padStart(2, '0');
  return `${hStr}:${m}`;
}

/**
 * Normalize an array of time_slots for storage (24h, two-digit hours).
 * Use when saving recurring blocks so only intended slots are blocked (e.g. 08:00-16:00, not 20:00).
 */
function normalizeTimeSlotsForStorage(slots) {
  if (!Array.isArray(slots) || slots.length === 0) return null;
  const out = slots.map(normalizeSlotTime).filter(Boolean);
  return out.length ? out : null;
}

/** Does this one block cover this slot? */
function blockCoversSlot(block, timeSlot) {
  if (!block) return false;
  if (block.block_entire_day) return true;
  const normalized = normalizeSlotTime(timeSlot);
  if (!normalized) return false;
  return (block.time_slots || []).some(s => normalizeSlotTime(s) === normalized);
}

/**
 * Is this slot blocked, by either kind of block?
 * @param {Array} blocks - From getRecurringBlocksForPsychologist
 * @param {number} dayOfWeek - 0-6 (Sunday-Saturday)
 * @param {string} timeSlot - e.g. "09:00" or "9:00 AM"
 * @param {string} [dateStr] - YYYY-MM-DD; without it only weekly blocks apply
 * @returns {boolean}
 */
function isSlotBlockedByRecurring(blocks, dayOfWeek, timeSlot, dateStr = null) {
  if (!blocks || blocks.length === 0) return false;

  // A date block is the more specific statement, so it is checked first.
  if (dateStr) {
    const onDate = blocks.find(b => b.date && String(b.date).slice(0, 10) === dateStr);
    if (blockCoversSlot(onDate, timeSlot)) return true;
  }
  const weekly = blocks.find(b => !b.date && b.day_of_week === dayOfWeek);
  return blockCoversSlot(weekly, timeSlot);
}

/** A table or column that the migration has not created yet. */
const notMigrated = (error) => error?.code === '42P01'
  || error?.code === '42703'
  || /does not exist/i.test(error?.message || '');

async function readBlocks(table, psychologistId) {
  try {
    const { data, error } = await supabaseAdmin
      .from(table)
      .select('*')
      .eq('psychologist_id', psychologistId);

    if (error) {
      if (notMigrated(error)) return [];
      console.error(`Error fetching ${table}:`, error);
      return [];
    }
    return data || [];
  } catch (err) {
    console.error(`Error fetching ${table}:`, err);
    return [];
  }
}

/**
 * Every block for a psychologist: weekly ones and dated ones together.
 *
 * The name is kept because seven call sites read availability through it; what
 * changed is that the list now carries date blocks as well, each with a `date`
 * where a weekly block has a `day_of_week`.
 * @param {string} psychologistId
 * @returns {Promise<Array>}
 */
async function getRecurringBlocksForPsychologist(psychologistId) {
  const [weekly, dated] = await Promise.all([
    readBlocks('psychologist_recurring_blocks', psychologistId),
    readBlocks('psychologist_date_blocks', psychologistId),
  ]);
  return [...weekly, ...dated];
}

/**
 * Filter availability time_slots for a single day by recurring blocks.
 * @param {Array<string>} timeSlots - e.g. ["09:00", "10:00", ...]
 * @param {string} dateStr - YYYY-MM-DD
 * @param {Array} recurringBlocks - From getRecurringBlocksForPsychologist
 * @returns {Array<string>} Filtered slots (excluding blocked)
 */
function filterSlotsByRecurringBlocks(timeSlots, dateStr, recurringBlocks) {
  if (!timeSlots || timeSlots.length === 0) return [];
  if (!recurringBlocks || recurringBlocks.length === 0) return timeSlots;

  const dayOfWeek = getDayOfWeekFromDate(dateStr);
  if (dayOfWeek == null) return timeSlots;

  return timeSlots.filter(slot => !isSlotBlockedByRecurring(recurringBlocks, dayOfWeek, slot, dateStr));
}

/**
 * Get day name for display (0 -> "Sunday", etc.).
 */
function getDayName(dayOfWeek) {
  return DAYS[dayOfWeek] ?? '';
}

module.exports = {
  getDayOfWeekFromDate,
  normalizeSlotTime,
  normalizeTimeSlotsForStorage,
  isSlotBlockedByRecurring,
  getRecurringBlocksForPsychologist,
  filterSlotsByRecurringBlocks,
  getDayName,
  DAYS
};
