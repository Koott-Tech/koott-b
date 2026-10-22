const { google } = require('googleapis');
const { OAuth2Client } = require('google-auth-library');
const { supabaseAdmin } = require('../config/supabase');

class TimeBlockingService {
  constructor() {
    this.calendar = google.calendar({ version: 'v3' });
  }

  /**
   * Create OAuth2 client for psychologist
   */
  createOAuthClient(credentials) {
    const oauth2Client = new OAuth2Client(
      process.env.GOOGLE_CLIENT_ID,
      process.env.GOOGLE_CLIENT_SECRET,
      process.env.GOOGLE_REDIRECT_URI
    );
    oauth2Client.setCredentials({
      access_token: credentials.access_token,
      refresh_token: credentials.refresh_token,
      scope: credentials.scope
    });
    return oauth2Client;
  }

  /**
   * Day-of-week to Google Calendar BYDAY (iCal): 0=Sunday -> SU, 1=Monday -> MO, etc.
   */
  static getRRULEByDay(dayOfWeek) {
    const days = ['SU', 'MO', 'TU', 'WE', 'TH', 'FR', 'SA'];
    return days[dayOfWeek] || 'SU';
  }

  /**
   * How far a weekly block repeats: six months from today, in IST.
   * Returned both as a date (stored on the row) and as the UTC basic-format
   * stamp an RRULE UNTIL takes, so the row and the calendar event agree.
   */
  static sixMonthHorizon(from = new Date()) {
    const end = new Date(from);
    end.setMonth(end.getMonth() + 6);
    const date = end.toLocaleDateString('en-CA', { timeZone: 'Asia/Kolkata' });
    return { date, until: `${date.replace(/-/g, '')}T235959Z` };
  }

  /**
   * The therapist's calendar client, or why it cannot be used.
   */
  async getCalendarClient(psychologistId, { needsWrite = true } = {}) {
    const { data: psychologist, error } = await supabaseAdmin
      .from('psychologists')
      .select('id, google_calendar_credentials')
      .eq('id', psychologistId)
      .single();

    if (error || !psychologist || !psychologist.google_calendar_credentials) {
      return { ok: false, error: 'Google Calendar not connected' };
    }

    const credentials = typeof psychologist.google_calendar_credentials === 'string'
      ? JSON.parse(psychologist.google_calendar_credentials)
      : psychologist.google_calendar_credentials;

    if (needsWrite && credentials.scope && credentials.scope.includes('calendar.readonly')) {
      return { ok: false, error: 'Google Calendar is read-only. Reconnect with full access.' };
    }
    return { ok: true, auth: this.createOAuthClient(credentials) };
  }

  /**
   * Group "HH:MM" slot starts into contiguous hour-long runs.
   * ["09:00","10:00","14:00"] -> [{ start: "09:00", end: "11:00" },
   *                               { start: "14:00", end: "15:00" }]
   * A run becomes one calendar event rather than one per hour, so blocking a
   * morning reads as a single band instead of four stacked entries.
   */
  static groupSlotsIntoRuns(timeSlots) {
    const toMin = (slot) => {
      const [h, m] = String(slot).trim().substring(0, 5).split(':').map(Number);
      return (h || 0) * 60 + (m || 0);
    };
    const toHHMM = (min) => `${String(Math.floor(min / 60) % 24).padStart(2, '0')}:${String(min % 60).padStart(2, '0')}`;

    const mins = [...new Set((timeSlots || []).map(toMin))].sort((a, b) => a - b);
    const runs = [];
    for (const m of mins) {
      const last = runs[runs.length - 1];
      if (last && m === last.endMin) last.endMin = m + 60;
      else runs.push({ startMin: m, endMin: m + 60 });
    }
    return runs.map((r) => ({ start: toHHMM(r.startMin), end: toHHMM(r.endMin) }));
  }

  /**
   * Block one calendar date - the whole day, or only the given hours.
   * The date-block counterpart to createRecurringBlockCalendarEvent: no RRULE,
   * so it marks that one date.
   * @param {string} psychologistId
   * @param {Object} block - { date: 'YYYY-MM-DD', block_entire_day: boolean, time_slots?: string[] }
   * @param {string} reason
   * @returns {Promise<{ success: boolean, eventIds?: string[], error?: string }>}
   */
  async createDateBlockCalendarEvent(psychologistId, block, reason = 'Blocked') {
    try {
      const client = await this.getCalendarClient(psychologistId);
      if (!client.ok) return { success: false, error: client.error };

      const date = String(block.date).trim();
      const timeSlots = Array.isArray(block.time_slots) ? block.time_slots.filter(Boolean) : [];
      const base = {
        summary: `🚫 BLOCKED - ${reason}`,
        description: `Blocked by psychologist - ${reason}. Synced from Koott.`,
        colorId: '11',
        transparency: 'opaque',
        visibility: 'private'
      };

      const events = [];
      if (block.block_entire_day || timeSlots.length === 0) {
        const next = new Date(`${date}T00:00:00Z`);
        next.setUTCDate(next.getUTCDate() + 1);
        events.push({ ...base, start: { date }, end: { date: next.toISOString().split('T')[0] } });
      } else {
        for (const run of TimeBlockingService.groupSlotsIntoRuns(timeSlots)) {
          events.push({
            ...base,
            start: { dateTime: `${date}T${run.start}:00`, timeZone: 'Asia/Kolkata' },
            end: { dateTime: `${date}T${run.end}:00`, timeZone: 'Asia/Kolkata' }
          });
        }
      }

      const eventIds = [];
      for (const resource of events) {
        const response = await this.calendar.events.insert({
          auth: client.auth,
          calendarId: 'primary',
          resource
        });
        eventIds.push(response.data.id);
      }
      console.log(`✅ Date block GCal: ${eventIds.length} event(s) for psychologist ${psychologistId} on ${date}`);
      return { success: true, eventIds };
    } catch (error) {
      console.error('Error creating date block calendar event:', error);
      return { success: false, error: error.message };
    }
  }

  /**
   * Delete a block event. Works for date blocks and recurring blocks alike -
   * deleting a recurring event removes the whole series.
   */
  async deleteBlockCalendarEvent(psychologistId, eventId) {
    return this.deleteRecurringBlockCalendarEvent(psychologistId, eventId);
  }

  /**
   * Create a recurring block event on Google Calendar (full-day or time range, e.g. every Sunday 11 AM–3 PM).
   * Used when psychologist adds a recurring block (e.g. "block every Sunday" or "block 11 AM–3 PM every Sunday").
   * @param {string} psychologistId - Psychologist ID
   * @param {Object} block - { day_of_week: 0-6, block_entire_day: boolean, time_slots?: string[] }
   * @param {string} reason - Display reason (e.g. "Recurring block")
   * @returns {Promise<{ success: boolean, eventIds?: string[], until?: string, error?: string }>}
   */
  async createRecurringBlockCalendarEvent(psychologistId, block, reason = 'Recurring block') {
    try {
      const client = await this.getCalendarClient(psychologistId);
      if (!client.ok) return { success: false, error: client.error };

      const dayOfWeek = Number(block.day_of_week);
      const byDay = TimeBlockingService.getRRULEByDay(dayOfWeek);
      const blockEntireDay = !!block.block_entire_day;
      const timeSlots = Array.isArray(block.time_slots) ? block.time_slots.filter(Boolean) : [];

      if (!blockEntireDay && timeSlots.length === 0) {
        return { success: false, error: 'No time range specified for partial-day block' };
      }

      // The repeat stops after six months rather than running forever, so a
      // therapist is not blocked into next year by a block they set once.
      const horizon = block.until || TimeBlockingService.sixMonthHorizon();
      const rrule = `RRULE:FREQ=WEEKLY;BYDAY=${byDay};UNTIL=${horizon.until}`;

      // The first occurrence has to land on the chosen weekday; 2020-01-05 was a Sunday.
      const refSunday = new Date('2020-01-05T00:00:00Z');
      const startDate = new Date(refSunday);
      startDate.setUTCDate(refSunday.getUTCDate() + dayOfWeek);
      const startDateStr = startDate.toISOString().split('T')[0];

      const base = {
        summary: `🚫 BLOCKED - ${reason}`,
        description: `Recurring block by psychologist - ${reason}. Synced from Koott.`,
        recurrence: [rrule],
        colorId: '11',
        transparency: 'opaque',
        visibility: 'private'
      };

      const events = [];
      if (blockEntireDay) {
        const next = new Date(startDate);
        next.setUTCDate(next.getUTCDate() + 1);
        events.push({
          ...base,
          start: { date: startDateStr },
          end: { date: next.toISOString().split('T')[0] }
        });
      } else {
        // Contiguous hours collapse into one band; a gap starts a new event, so
        // blocking 9-11 and 2-3 marks those two bands and nothing between them.
        for (const run of TimeBlockingService.groupSlotsIntoRuns(timeSlots)) {
          events.push({
            ...base,
            start: { dateTime: `${startDateStr}T${run.start}:00`, timeZone: 'Asia/Kolkata' },
            end: { dateTime: `${startDateStr}T${run.end}:00`, timeZone: 'Asia/Kolkata' }
          });
        }
      }

      const eventIds = [];
      for (const resource of events) {
        const response = await this.calendar.events.insert({
          auth: client.auth,
          calendarId: 'primary',
          resource
        });
        eventIds.push(response.data.id);
      }

      console.log(`✅ Recurring block GCal: ${eventIds.length} event(s) for psychologist ${psychologistId}, day ${dayOfWeek}, until ${horizon.date}`);
      return { success: true, eventIds, eventId: eventIds[0], until: horizon.date };
    } catch (error) {
      console.error('Error creating recurring block calendar event:', error);
      return { success: false, error: error.message };
    }
  }

  /**
   * Delete a recurring block event from Google Calendar (deletes the entire series).
   * @param {string} psychologistId - Psychologist ID
   * @param {string} eventId - Google Calendar event ID (recurring event id)
   * @returns {Promise<{ success: boolean, error?: string }>}
   */
  async deleteRecurringBlockCalendarEvent(psychologistId, eventId) {
    if (!eventId) return { success: true };
    try {
      const { data: psychologist, error: psychError } = await supabaseAdmin
        .from('psychologists')
        .select('id, google_calendar_credentials')
        .eq('id', psychologistId)
        .single();

      if (psychError || !psychologist || !psychologist.google_calendar_credentials) {
        return { success: false, error: 'Psychologist or Google Calendar not found' };
      }

      const credentials = typeof psychologist.google_calendar_credentials === 'string'
        ? JSON.parse(psychologist.google_calendar_credentials)
        : psychologist.google_calendar_credentials;
      const oauth2Client = this.createOAuthClient(credentials);

      await this.calendar.events.delete({
        auth: oauth2Client,
        calendarId: 'primary',
        eventId: eventId
      });

      console.log(`✅ Recurring block GCal event deleted for psychologist ${psychologistId}, eventId=${eventId}`);
      return { success: true };
    } catch (error) {
      // 410 Gone / 404 Not Found = event already deleted (e.g. user deleted in GCal or previous run) — treat as success
      const status = error.response?.status ?? error.code ?? error.status;
      if (status === 410 || status === 404) {
        console.log(`Recurring block GCal event already gone (${status}) for psychologist ${psychologistId}, eventId=${eventId}`);
        return { success: true };
      }
      console.error('Error deleting recurring block calendar event:', error);
      return { success: false, error: error.message };
    }
  }
}

module.exports = new TimeBlockingService();
