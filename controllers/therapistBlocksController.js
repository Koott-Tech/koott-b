/**
 * A therapist blocking their own time, from the therapist dashboard.
 *
 *   GET    /api/psychologists/blocking-options   the slots this therapist can block
 *   GET    /api/psychologists/date-blocks        blocks on specific dates
 *   POST   /api/psychologists/date-blocks        block a date, whole or in part
 *   DELETE /api/psychologists/date-blocks/:id    unblock it
 *
 * The same handlers serve the admin dashboard at
 * /api/admin/psychologists/:psychologistId/..., where the therapist is named in
 * the path instead of being the signed-in user. Working hours stay admin-only;
 * blocking is available to both.
 *
 * Weekly blocks ("every Tuesday", repeating six months) are the other half of
 * this and live in psychologistController.js, next to the rest of availability.
 *
 * Every block is mirrored into the therapist's Google Calendar when one is
 * connected, and the event is removed again when they unblock. A calendar
 * failure does not fail the request: the block still applies on Koott, which is
 * what actually governs bookings, and the response says the mirror did not
 * happen.
 */

const { supabaseAdmin } = require('../config/supabase');
const { successResponse, errorResponse } = require('../utils/helpers');
const timeBlockingService = require('../utils/timeBlockingService');
const { normalizeTimeSlotsForStorage, getDateBlocksForPsychologist } = require('../utils/dateBlocksHelper');
const { normalizeSlotTime, DAYS } = require('../utils/recurringBlocksHelper');
const { DAY_KEYS, DEFAULT_WORKING_HOURS, slotsForRanges, getWorkingHours } = require('../utils/workingHours');

/**
 * Whose time is being blocked.
 *
 * A therapist blocking their own is the common case and carries no id, so it
 * falls back to the signed-in user. An admin blocking on someone's behalf names
 * them in the path, and those routes sit behind requireAdmin, so a therapist
 * cannot reach another therapist's calendar by passing an id.
 */
const targetPsychologistId = (req) => req.params.psychologistId || req.user.id;

/** YYYY-MM-DD for today in IST, the timezone sessions are scheduled in. */
const istToday = () => new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Kolkata' });

const isYmd = (value) => /^\d{4}-\d{2}-\d{2}$/.test(String(value || '').trim());

/** Comma-separated calendar event ids, as stored on a block row. */
const eventIdsOf = (row) => String(row?.google_calendar_event_id || '')
  .split(',')
  .map((id) => id.trim())
  .filter(Boolean);

async function removeCalendarEvents(psychologistId, row) {
  for (const eventId of eventIdsOf(row)) {
    await timeBlockingService.deleteBlockCalendarEvent(psychologistId, eventId);
  }
}

/**
 * The hours this therapist can block, per weekday.
 *
 * These come from their own working_hours (migration 0006), not a fixed list:
 * an admin sets different hours per therapist, and offering a slot nobody can
 * book would let them "block" time that was never bookable. A day with no
 * shifts comes back with an empty list, which the dashboard shows as a day off.
 */
const getBlockingOptions = async (req, res) => {
  try {
    const psychologistId = targetPsychologistId(req);
    const result = await getWorkingHours(psychologistId);
    if (!result.found) return res.status(404).json(errorResponse('Psychologist not found'));

    const schedule = result.workingHours || DEFAULT_WORKING_HOURS;
    const days = DAY_KEYS.map((key, dayOfWeek) => {
      const ranges = schedule.days?.[key] || [];
      const labels = slotsForRanges(ranges, { psychiatrist: result.psychiatrist });
      return {
        day_of_week: dayOfWeek,
        day: DAYS[dayOfWeek],
        working: ranges.length > 0,
        ranges,
        // "09:00" for storage, "9:00 AM" for display — the dashboard shows the
        // label and sends back the value.
        slots: labels.map((label) => ({ value: normalizeSlotTime(label), label })),
      };
    });

    return res.json(successResponse({
      days,
      is_custom: result.isCustom,
      psychiatrist: result.psychiatrist,
    }, 'Blocking options'));
  } catch (error) {
    console.error('Get blocking options error:', error);
    return res.status(500).json(errorResponse('Could not load your working hours'));
  }
};

/** Blocks on specific dates, today onward. */
const getDateBlocks = async (req, res) => {
  try {
    const blocks = await getDateBlocksForPsychologist(targetPsychologistId(req));
    return res.json(successResponse(blocks, 'Date blocks fetched'));
  } catch (error) {
    console.error('Get date blocks error:', error);
    return res.status(500).json(errorResponse('Failed to fetch date blocks'));
  }
};

/**
 * Block one date, whole or in part.
 *
 * Saving the same date twice replaces the earlier block rather than adding a
 * second one, so the row always reflects what the therapist last chose. The
 * old calendar events go first, or unblocking later would leave them behind.
 */
const addDateBlock = async (req, res) => {
  try {
    const psychologistId = targetPsychologistId(req);
    const { date, block_entire_day = true, time_slots, reason } = req.body || {};

    if (!isYmd(date)) {
      return res.status(400).json(errorResponse('date must be a calendar date, as YYYY-MM-DD'));
    }
    if (String(date).trim() < istToday()) {
      return res.status(400).json(errorResponse('That date has already passed'));
    }

    const wholeDay = !!block_entire_day;
    const slots = wholeDay ? null : normalizeTimeSlotsForStorage(time_slots);
    if (!wholeDay && !slots) {
      return res.status(400).json(errorResponse('Choose at least one time slot, or block the whole day'));
    }

    const payload = {
      psychologist_id: psychologistId,
      date: String(date).trim(),
      block_entire_day: wholeDay,
      time_slots: slots,
      reason: reason || null,
      updated_at: new Date().toISOString(),
    };

    const { data: existing } = await supabaseAdmin
      .from('psychologist_date_blocks')
      .select('id, google_calendar_event_id')
      .eq('psychologist_id', psychologistId)
      .eq('date', payload.date)
      .maybeSingle();

    if (existing) await removeCalendarEvents(psychologistId, existing);

    const gcal = await timeBlockingService.createDateBlockCalendarEvent(
      psychologistId,
      { date: payload.date, block_entire_day: wholeDay, time_slots: slots },
      reason || 'Blocked'
    );
    if (gcal.success && gcal.eventIds?.length) {
      payload.google_calendar_event_id = gcal.eventIds.join(',');
    }

    const { data: block, error } = await supabaseAdmin
      .from('psychologist_date_blocks')
      .upsert(payload, { onConflict: 'psychologist_id,date', ignoreDuplicates: false })
      .select()
      .single();

    if (error) {
      console.error('Add date block error:', error);
      return res.status(500).json(errorResponse(error.message || 'Failed to block that date'));
    }

    return res.json(successResponse(
      { ...block, calendar_synced: !!gcal.success, calendar_error: gcal.success ? null : gcal.error },
      wholeDay ? 'That whole day is blocked' : 'Those hours are blocked'
    ));
  } catch (error) {
    console.error('Add date block error:', error);
    return res.status(500).json(errorResponse('Internal server error while blocking that date'));
  }
};

/** Unblock a date, and remove the calendar events that mirrored it. */
const deleteDateBlock = async (req, res) => {
  try {
    const psychologistId = targetPsychologistId(req);

    const { data: block } = await supabaseAdmin
      .from('psychologist_date_blocks')
      .select('id, google_calendar_event_id')
      .eq('id', req.params.blockId)
      .eq('psychologist_id', psychologistId)
      .maybeSingle();

    if (!block) return res.status(404).json(errorResponse('Block not found'));

    await removeCalendarEvents(psychologistId, block);

    const { error } = await supabaseAdmin
      .from('psychologist_date_blocks')
      .delete()
      .eq('id', block.id)
      .eq('psychologist_id', psychologistId);

    if (error) {
      console.error('Delete date block error:', error);
      return res.status(500).json(errorResponse('Failed to unblock that date'));
    }
    return res.json(successResponse(null, 'That date is available again'));
  } catch (error) {
    console.error('Delete date block error:', error);
    return res.status(500).json(errorResponse('Internal server error while unblocking that date'));
  }
};

module.exports = {
  getBlockingOptions,
  getDateBlocks,
  addDateBlock,
  deleteDateBlock,
};
