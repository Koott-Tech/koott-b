/**
 * Client change requests → an Operations task.
 *
 * A client can cancel, reschedule or switch therapist on their own only 24 hours or more
 * before the session (CLIENT_CHANGE_HOURS). Closer than that — or for changes the system
 * can't make on its own (a package session's therapist, a pricier therapist) — the client
 * either sends a request, which lands here as a task for the Operations team, or talks to
 * Operations on WhatsApp. One open task per session and kind (auto_key), so pressing the
 * button twice doesn't create two.
 */
const { supabaseAdmin } = require('../config/supabase');

const CLIENT_CHANGE_HOURS = Number(process.env.CLIENT_CHANGE_HOURS) || 24;
const KINDS = {
  cancel: { verb: 'cancel', label: 'Cancel' },
  reschedule: { verb: 'reschedule', label: 'Reschedule' },
  switch: { verb: 'switch therapist for', label: 'Switch therapist' },
};
const OPEN = ['todo', 'in_progress', 'waiting'];

/** Session start as a Date (scheduled_date + scheduled_time are IST). */
function sessionStartIST(s) {
  if (!s?.scheduled_date || !s?.scheduled_time) return null;
  const t = String(s.scheduled_time).slice(0, 8).padEnd(8, ':00');
  const d = new Date(`${s.scheduled_date}T${t}+05:30`);
  return Number.isNaN(d.getTime()) ? null : d;
}

function hoursUntil(s) {
  const start = sessionStartIST(s);
  return start ? (start.getTime() - Date.now()) / 3600000 : null;
}

const isPackageSession = (s) => Boolean(
  s?.package_group_id || (parseInt(s?.session_count, 10) || 1) > 1 || String(s?.session_type || '').toLowerCase().includes('package')
);

const requestKey = (kind, sessionId) => `client_request:${kind}:${sessionId}`;

/**
 * Create (or return the open) Operations task for a client's request.
 * session needs id, scheduled_date/time, psychologist_id; client needs id + name/phone/email.
 */
async function createClientRequest({ session, client, kind, note, reason }) {
  if (!KINDS[kind]) throw new Error('Unknown request');
  const key = requestKey(kind, session.id);
  const { data: existing } = await supabaseAdmin.from('tasks').select('id, created_at, status')
    .eq('auto_key', key).in('status', OPEN).maybeSingle();
  if (existing) return { task: existing, existing: true };

  const { teamByName } = require('./people');
  const { createTask } = require('../controllers/tasksController');
  const ops = await teamByName('Operations');
  const { data: psych } = await supabaseAdmin.from('psychologists').select('first_name, last_name').eq('id', session.psychologist_id).maybeSingle();
  const therapist = [psych?.first_name, psych?.last_name].filter(Boolean).join(' ') || 'their therapist';
  const name = [client.first_name, client.last_name].filter(Boolean).join(' ') || client.child_name || 'A client';
  const start = sessionStartIST(session);
  const when = start ? start.toLocaleString('en-IN', { timeZone: 'Asia/Kolkata', dateStyle: 'medium', timeStyle: 'short' }) : `${session.scheduled_date} ${session.scheduled_time}`;
  const hrs = hoursUntil(session);
  const late = hrs !== null && hrs < CLIENT_CHANGE_HOURS;
  const why = reason || (late ? `less than ${CLIENT_CHANGE_HOURS} h before the session` : 'needs Operations');

  const details = [
    `${name} asked to ${KINDS[kind].verb} their session with ${therapist} on ${when} IST (${why}).`,
    kind === 'cancel' && late ? `Policy: cancelling less than ${CLIENT_CHANGE_HOURS} hours before is not refunded.` : null,
    `Phone: ${client.phone_number || '—'} · Email: ${client.email || '—'}`,
    note ? `Client's note: ${String(note).slice(0, 500)}` : null,
    'Reply to the client, then make the change from Bookings (or keep the session as it is).',
  ].filter(Boolean).join('\n');

  const task = await createTask({
    title: `${KINDS[kind].label} request: ${name} with ${therapist}, ${when}`,
    details,
    assignee_type: 'team', assignee_id: ops.id,
    priority: late ? 'urgent' : 'high',
    deadline: start ? start.toISOString() : null, deadline_has_time: Boolean(start),
    link_type: 'session', link_id: session.id, link_label: `Session ${session.scheduled_date}`,
    auto_key: key,
  }, { type: 'system' });
  return { task, existing: false };
}

/** Open requests for these sessions: Map(sessionId → { kind, requested_at }). */
async function openRequestsFor(sessionIds) {
  const out = new Map();
  if (!sessionIds?.length) return out;
  const keys = sessionIds.flatMap((id) => Object.keys(KINDS).map((k) => requestKey(k, id)));
  for (let i = 0; i < keys.length; i += 150) {
    const { data } = await supabaseAdmin.from('tasks').select('auto_key, created_at')
      .in('auto_key', keys.slice(i, i + 150)).in('status', OPEN);
    (data || []).forEach((t) => {
      const [, kind, id] = t.auto_key.split(':');
      out.set(id, { kind, requested_at: t.created_at });
    });
  }
  return out;
}

module.exports = { CLIENT_CHANGE_HOURS, KINDS, sessionStartIST, hoursUntil, isPackageSession, requestKey, createClientRequest, openRequestsFor };
