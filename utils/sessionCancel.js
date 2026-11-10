/**
 * Cancel one session the same way everywhere: status, the therapist's Google Calendar
 * event removed (the slot reopens), and the cancellation emails to client and therapist.
 * Used by the client's Cancel (48 h rule) and by Operations approving a cancellation
 * request. Calendar and email problems never stop the cancellation.
 */
const { supabaseAdmin } = require('../config/supabase');

const LIVE = ['booked', 'rescheduled', 'confirmed', 'scheduled', 'upcoming'];

/** When the session starts (sessions store IST date + time). */
function sessionStart(s) {
  if (!s?.scheduled_date) return null;
  const t = String(s.scheduled_time || '00:00:00').slice(0, 8).padEnd(8, ':00');
  const d = new Date(`${s.scheduled_date}T${t}+05:30`);
  return Number.isNaN(d.getTime()) ? null : d;
}

async function cancelSessionCore(sessionId, { status = 'canceled', notify = true } = {}) {
  const { data: session, error } = await supabaseAdmin.from('sessions').select(`
      id, status, psychologist_id, client_id, scheduled_date, scheduled_time, google_calendar_event_id,
      client:clients(id, first_name, last_name, child_name, email, user:users(email)),
      psychologist:psychologists!sessions_psychologist_id_fkey(id, first_name, last_name, email, google_calendar_credentials)
    `).eq('id', sessionId).maybeSingle();
  if (error) throw error;
  if (!session) return { ok: false, message: 'Session not found.' };
  if (!LIVE.includes(session.status)) return { ok: false, message: `This session is already ${session.status}.` };

  // Only a live session is cancelled (two cancels at once → one)
  const { data: rows, error: upErr } = await supabaseAdmin.from('sessions')
    .update({ status, updated_at: new Date().toISOString() }).eq('id', sessionId).in('status', LIVE).select('id');
  if (upErr) throw upErr;
  if (!rows || !rows.length) return { ok: false, message: 'This session was just changed by someone else.' };

  const one = (x) => (Array.isArray(x) ? x[0] : x);
  const psych = one(session.psychologist);
  const client = one(session.client);

  let calendarEventRemoved = false;
  if (session.google_calendar_event_id) {
    try {
      const meetLinkService = require('./meetLinkService');
      const creds = psych?.google_calendar_credentials;
      const userAuth = creds?.access_token ? { access_token: creds.access_token, refresh_token: creds.refresh_token, expiry_date: creds.expiry_date } : null;
      for (const eid of String(session.google_calendar_event_id).split(',').map((x) => x.trim()).filter(Boolean)) {
        const r = await meetLinkService.deleteCalendarEvent(eid, userAuth);
        if (r?.success) calendarEventRemoved = true;
      }
      if (calendarEventRemoved) await supabaseAdmin.from('sessions').update({ google_calendar_event_id: null }).eq('id', sessionId);
    } catch (e) {
      console.warn('[sessionCancel] calendar delete failed (non-fatal):', e.message || e);
    }
  }

  if (notify) {
    (async () => {
      try {
        const emailService = require('./emailService');
        const { getClientDisplayName } = require('./sessionTitleFormatter');
        const clientEmail = one(client?.user)?.email || client?.email || null;
        const clientName = getClientDisplayName(client, 'Client');
        const psychologistName = `${psych?.first_name || ''} ${psych?.last_name || ''}`.trim() || 'Therapist';
        const base = { clientName, psychologistName, sessionDate: session.scheduled_date, sessionTime: session.scheduled_time, sessionId };
        if (clientEmail) await emailService.sendCancellationNotification({ to: clientEmail, ...base, isPsychologist: false });
        if (psych?.email) await emailService.sendCancellationNotification({ to: psych.email, ...base, isPsychologist: true });
      } catch (e) {
        console.warn('[sessionCancel] email failed (non-fatal):', e.message || e);
      }
    })();
  }
  return { ok: true, session, calendarEventRemoved };
}

module.exports = { cancelSessionCore, sessionStart, LIVE };
