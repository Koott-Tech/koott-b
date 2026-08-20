const { supabaseAdmin } = require('../config/supabase');
const meetLinkService = require('../utils/meetLinkService');
const { addMinutesToTime } = require('../utils/helpers');
const { resolveSessionDurationMinutes } = require('../utils/sessionMeetDuration');
const {
  buildKoottSessionDescription,
  buildKoottSessionTitle,
  getClientDisplayName,
  getPsychologistDisplayName,
} = require('../utils/sessionTitleFormatter');

const LOG_PREFIX = '[meetRepair]';

/**
 * Silently (re)create the Google Calendar event + Meet link for ONE session — no emails,
 * no WhatsApp. Used by the daily crawler to self-heal sessions that ended up with a master
 * fallback link and no calendar event (e.g. calendar creation failed at booking time but
 * notified_at was still stamped, so the normal pipeline never retries them).
 *
 * @returns {Promise<{ success: boolean, eventId?: string, error?: string }>}
 */
async function regenerateSessionMeet(sessionId) {
  const { data: session, error: sErr } = await supabaseAdmin
    .from('sessions')
    .select('id, client_id, psychologist_id, scheduled_date, scheduled_time, status, session_type, package_id, google_meet_link, google_calendar_event_id')
    .eq('id', sessionId)
    .maybeSingle();
  if (sErr || !session) return { success: false, error: sErr?.message || 'session not found' };
  if (session.google_calendar_event_id) return { success: true, eventId: session.google_calendar_event_id };
  if (!session.client_id || !session.psychologist_id) return { success: false, error: 'client/psychologist not resolved' };

  const { data: clientDetails } = await supabaseAdmin
    .from('clients')
    .select('id, email, first_name, last_name, child_name, phone_number, user:users(id, email)')
    .eq('id', session.client_id).maybeSingle();
  const { data: psychologistDetails } = await supabaseAdmin
    .from('psychologists')
    .select('id, first_name, last_name, email, phone, google_calendar_credentials')
    .eq('id', session.psychologist_id).maybeSingle();
  if (!clientDetails || !psychologistDetails) return { success: false, error: 'client/psychologist row missing' };
  if (!psychologistDetails.google_calendar_credentials) return { success: false, error: 'therapist has no Google Calendar connected' };

  const clientName = getClientDisplayName(clientDetails, 'Client');
  const psychologistName = getPsychologistDisplayName(psychologistDetails, 'Therapist');
  const cu = Array.isArray(clientDetails.user) ? clientDetails.user?.[0] : clientDetails.user;
  const clientEmail = cu?.email || clientDetails.email || null;
  const clientPhone = clientDetails.phone_number || null;

  const typeDefaults = { couple: 80, assessment: 30, discovery: 30, individual: 50 };
  const meetDurationMinutes = typeDefaults[session.session_type]
    || resolveSessionDurationMinutes({ packageInfo: session.package_id ? { packageType: session.session_type } : null })
    || 50;
  const endTime = addMinutesToTime(session.scheduled_time || '00:00', meetDurationMinutes);
  const oauthEmail = psychologistDetails.google_calendar_credentials?.oauth_email || null;

  const meetSessionData = {
    summary: buildKoottSessionTitle({ clientName, psychologistName }),
    description: buildKoottSessionDescription({ clientName, psychologistName, clientPhone }),
    startDate: session.scheduled_date,
    startTime: session.scheduled_time,
    endTime,
    clientEmail: clientEmail || null,
    psychologistEmail: psychologistDetails.email || null,
    calendarOwnerEmail: oauthEmail || psychologistDetails.email || null,
  };
  const creds = psychologistDetails.google_calendar_credentials;
  const userAuth = { access_token: creds.access_token, refresh_token: creds.refresh_token, expiry_date: creds.expiry_date };

  try {
    const meetResult = await meetLinkService.generateSessionMeetLink(meetSessionData, userAuth);
    if (!meetResult?.eventId) {
      return { success: false, error: meetResult?.error || 'calendar event not created (no eventId returned)' };
    }
    await supabaseAdmin.from('sessions').update({
      google_meet_link: meetResult.meetLink || session.google_meet_link,
      google_meet_join_url: meetResult.meetLink || session.google_meet_link,
      google_meet_start_url: meetResult.meetLink || session.google_meet_link,
      google_calendar_event_id: meetResult.eventId,
      google_calendar_id: meetResult.calendarId || null,
    }).eq('id', sessionId);
    console.log(`${LOG_PREFIX} 🔧 regenerated calendar event for ${sessionId} → ${meetResult.eventId}`);
    return { success: true, eventId: meetResult.eventId };
  } catch (e) {
    return { success: false, error: e?.message || String(e) };
  }
}

module.exports = { regenerateSessionMeet };
