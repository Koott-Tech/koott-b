/**
 * Operations reports for the marketing dashboard: bookings, sessions, slots and
 * clients, at three levels — everyone, a team, or one therapist.
 *
 * These read the booking tables rather than the first-party web events the
 * other marketing reports use, because the questions are about what the
 * business did, not about who visited the site.
 *
 * Two distinctions the marketing brief is explicit about, and which are easy to
 * get wrong:
 *
 *   Booking time is when the client made the reservation
 *   (sessions.booking_created_at). Session time is when the appointment is
 *   (scheduled_date + scheduled_time). They are different events and are never
 *   mixed.
 *
 *   "Slots opened in this period", "slots currently bookable" and "slots that
 *   fall in this period" are three different measurements. Each has its own
 *   field in the answer and they are never added together.
 *
 * Everything is IST: Koott books in India time, and a day boundary taken in UTC
 * would file anything before 05:30 under the previous day.
 */

const { supabaseAdmin } = require('../config/supabase');
const { ACTIVE_SESSION_STATUSES } = require('../utils/sessionSlots');

const IST_OFFSET_MS = 5.5 * 3600000;

/** Rows are read in pages; Supabase caps a single select at 1000. */
const PAGE = 1000;

/** The therapists with no team. Their work still counts in the company total. */
const UNGROUPED = { id: 'ungrouped', name: 'Ungrouped', color: null, sort_order: 9999 };

/* ------------------------------------------------------------------ helpers */

/** YYYY-MM-DD in IST for a timestamp. */
const istDay = (ts) => new Date(new Date(ts).getTime() + IST_OFFSET_MS).toISOString().slice(0, 10);

/** Hour 0–23 in IST for a timestamp. */
const istHour = (ts) => new Date(new Date(ts).getTime() + IST_OFFSET_MS).getUTCHours();

/** Hour 0–23 from a "HH:MM[:SS]" time column, which is already IST. */
const hourOfTime = (t) => {
  const m = /^(\d{1,2}):/.exec(String(t || '').trim());
  return m ? Math.min(23, Math.max(0, Number(m[1]))) : null;
};

/** "2 PM", the label the charts show. */
const hourLabel = (h) => `${h % 12 || 12} ${h < 12 ? 'AM' : 'PM'}`;

/** Buckets an hour into a two-hour band, which is what the brief asks for. */
const bandOf = (h) => Math.floor(h / 2) * 2;
const bandLabel = (b) => `${hourLabel(b)}–${hourLabel((b + 2) % 24)}`;

/** Read every matching row, a page at a time. */
async function readAll(build) {
  const out = [];
  for (let from = 0; ; from += PAGE) {
    const { data, error } = await build().range(from, from + PAGE - 1);
    if (error) throw error;
    out.push(...(data || []));
    if (!data || data.length < PAGE) return out;
  }
}

/**
 * Which therapists the answer covers.
 *
 *   all               every therapist
 *   team:<id>         one team, or 'ungrouped' for those with no team
 *   therapist:<id>    one therapist
 *
 * Returns null for "everyone", which lets the callers skip an `in` filter
 * listing every therapist.
 */
async function therapistIdsForScope(scope) {
  if (!scope || scope === 'all') return null;

  const [kind, value] = String(scope).split(':');
  if (kind === 'therapist' && value) return [value];
  if (kind !== 'team' || !value) return null;

  let q = supabaseAdmin.from('psychologists').select('id');
  q = value === UNGROUPED.id ? q.is('therapist_group_id', null) : q.eq('therapist_group_id', value);
  const { data, error } = await q;
  if (error) throw error;
  // An empty team must return nothing, not everything — hence [] rather than null.
  return (data || []).map((r) => r.id);
}

/** Teams for the picker, with Ungrouped last when anyone is in it. */
async function teams() {
  const [{ data: groups, error: gErr }, { data: psychs, error: pErr }] = await Promise.all([
    supabaseAdmin.from('therapist_groups').select('id, name, color, sort_order').order('sort_order'),
    supabaseAdmin.from('psychologists').select('id, therapist_group_id'),
  ]);
  if (gErr) throw gErr;
  if (pErr) throw pErr;

  const counts = {};
  let ungrouped = 0;
  (psychs || []).forEach((p) => {
    if (p.therapist_group_id) counts[p.therapist_group_id] = (counts[p.therapist_group_id] || 0) + 1;
    else ungrouped += 1;
  });

  const rows = (groups || []).map((g) => ({ ...g, therapists: counts[g.id] || 0 }));
  // Without this bucket the team totals would not add up to the company total.
  if (ungrouped > 0) rows.push({ ...UNGROUPED, therapists: ungrouped });
  return rows;
}

/** Therapist names for the drill-down, already scoped. */
async function therapists(scope) {
  const ids = await therapistIdsForScope(scope);
  if (ids && ids.length === 0) return [];
  let q = supabaseAdmin.from('psychologists').select('id, first_name, last_name, therapist_group_id');
  if (ids) q = q.in('id', ids);
  const { data, error } = await q;
  if (error) throw error;
  return (data || []).map((p) => ({
    id: p.id,
    name: `${p.first_name || ''} ${p.last_name || ''}`.trim() || 'Therapist',
    team: p.therapist_group_id || UNGROUPED.id,
  }));
}

/**
 * Sessions overlapping the window.
 *
 * `on` picks which date the window applies to: 'booking' filters on when the
 * reservation was made, 'session' on when the appointment is. Reports that
 * answer "when do people book" must use the first; "when are sessions held"
 * the second.
 */
async function sessionsInWindow({ from, to, scope, on = 'booking' }) {
  const ids = await therapistIdsForScope(scope);
  if (ids && ids.length === 0) return [];

  const cols = 'id, client_id, psychologist_id, status, booking_created_at, created_at, scheduled_date, scheduled_time';
  const rows = await readAll(() => {
    let q = supabaseAdmin.from('sessions').select(cols);
    if (ids) q = q.in('psychologist_id', ids);
    if (on === 'session') {
      q = q.gte('scheduled_date', from).lte('scheduled_date', to);
    } else {
      // The window is IST; the column is a timestamp, so the bounds are shifted
      // back by the offset to cover the IST day exactly.
      const startUtc = new Date(Date.parse(`${from}T00:00:00Z`) - IST_OFFSET_MS).toISOString();
      const endUtc = new Date(Date.parse(`${to}T00:00:00Z`) + 86400000 - IST_OFFSET_MS).toISOString();
      q = q.gte('booking_created_at', startUtc).lt('booking_created_at', endUtc);
    }
    return q.order('id');
  });
  return rows;
}

/** When a session was booked. Older rows only have created_at. */
const bookedAt = (s) => s.booking_created_at || s.created_at || null;

/**
 * Which of these clients had already booked before the window opened.
 *
 * sessions.is_first_session is not used: it is null on every live row, written
 * only by the finance reports.
 *
 * This asks one narrow question — "which of these clients have any session
 * earlier than this?" — rather than reading their histories. An earlier version
 * pulled every session for every client in batches of two hundred, which is
 * unbounded by the date filter: a one-day report on a busy month would have
 * read the whole sessions table. This reads client ids only, for sessions
 * strictly before the window, and the set is at most the number of clients.
 */
async function clientsSeenBefore(clientIds, beforeUtc) {
  if (!clientIds.length) return new Set();
  const seen = new Set();
  for (let i = 0; i < clientIds.length; i += 200) {
    const batch = clientIds.slice(i, i + 200);
    const rows = await readAll(() => supabaseAdmin
      .from('sessions')
      .select('client_id')
      .in('client_id', batch)
      .lt('booking_created_at', beforeUtc)
      .order('client_id'));
    rows.forEach((r) => seen.add(r.client_id));
  }
  return seen;
}

/** An empty 24-hour histogram, so quiet hours appear as zero rather than vanish. */
const emptyHours = () => Array.from({ length: 24 }, (_, h) => ({ hour: h, label: hourLabel(h), sessions: 0 }));

/** Collapse an hour histogram into the two-hour bands the brief asks for. */
function toBands(hours) {
  const bands = Array.from({ length: 12 }, (_, i) => ({ band: i * 2, label: bandLabel(i * 2), sessions: 0 }));
  hours.forEach((h) => { bands[Math.floor(h.hour / 2)].sessions += h.sessions; });
  return bands;
}

/** The busiest band, which is the headline the marketing team asked for. */
function peakOf(bands) {
  const top = bands.reduce((a, b) => (b.sessions > a.sessions ? b : a), bands[0]);
  return top && top.sessions > 0 ? { label: top.label, sessions: top.sessions } : null;
}

/* ------------------------------------------------------------------ reports */

/** When clients make reservations. */
async function bookingTime({ from, to, scope }) {
  const rows = await sessionsInWindow({ from, to, scope, on: 'booking' });
  const hours = emptyHours();
  rows.forEach((s) => {
    const at = bookedAt(s);
    if (at) hours[istHour(at)].sessions += 1;
  });
  const bands = toBands(hours);
  return { total: rows.length, hours, bands, peak: peakOf(bands) };
}

/** When appointments are scheduled. */
async function sessionTime({ from, to, scope }) {
  const rows = await sessionsInWindow({ from, to, scope, on: 'session' });
  const hours = emptyHours();
  let undated = 0;
  rows.forEach((s) => {
    const h = hourOfTime(s.scheduled_time);
    if (h == null) undated += 1;
    else hours[h].sessions += 1;
  });
  const bands = toBands(hours);
  return { total: rows.length, undated, hours, bands, peak: peakOf(bands) };
}

/**
 * Sessions, and how many came from clients booking for the first time.
 *
 * Counted two ways on purpose: `sessions` counts bookings, `clients` counts
 * people. A client who books three times in the window is one returning client
 * but three sessions, and conflating them would inflate the new-client count.
 */
async function clientMix({ from, to, scope }) {
  const rows = await sessionsInWindow({ from, to, scope, on: 'booking' });
  const clientIds = [...new Set(rows.map((s) => s.client_id).filter(Boolean))];
  const windowStartUtc = new Date(Date.parse(`${from}T00:00:00Z`) - IST_OFFSET_MS).toISOString();
  const seenBefore = await clientsSeenBefore(clientIds, windowStartUtc);

  let newSessions = 0;
  let returningSessions = 0;
  const newClients = new Set();
  const returningClients = new Set();

  // A client is new on the first booking they make, and only if they had none
  // before the window. Their second booking inside the same window is already a
  // repeat, which is what stops one person inflating the new-client count.
  const countedFirst = new Set();
  const ordered = [...rows].sort((a, b) => String(bookedAt(a) || '').localeCompare(String(bookedAt(b) || '')));

  ordered.forEach((s) => {
    if (!s.client_id) return;
    const isFirstEver = !seenBefore.has(s.client_id) && !countedFirst.has(s.client_id);
    if (isFirstEver) {
      countedFirst.add(s.client_id);
      newSessions += 1;
      newClients.add(s.client_id);
    } else {
      returningSessions += 1;
      returningClients.add(s.client_id);
    }
  });

  const byStatus = {};
  rows.forEach((s) => { byStatus[s.status || 'unknown'] = (byStatus[s.status || 'unknown'] || 0) + 1; });

  return {
    sessions: { total: rows.length, new: newSessions, returning: returningSessions },
    // A client whose first booking and a repeat both fall in the window counts
    // in both sets, so these need not sum to the unique total. `total` is the
    // honest count of distinct people.
    clients: { total: clientIds.length, new: newClients.size, returning: returningClients.size },
    byStatus: Object.entries(byStatus).map(([status, sessions]) => ({ status, sessions })).sort((a, b) => b.sessions - a.sessions),
    activeStatuses: ACTIVE_SESSION_STATUSES,
  };
}

/**
 * When therapists opened slots, and how far ahead.
 *
 * Reads slot_events (migration 0019). There is no history before that table
 * started filling, so the answer carries `trackingSince` and the dashboard says
 * so rather than showing an empty chart as if those weeks were quiet.
 */
async function slotOpenings({ from, to, scope }) {
  const ids = await therapistIdsForScope(scope);
  if (ids && ids.length === 0) return emptyOpenings();

  const startUtc = new Date(Date.parse(`${from}T00:00:00Z`) - IST_OFFSET_MS).toISOString();
  const endUtc = new Date(Date.parse(`${to}T00:00:00Z`) + 86400000 - IST_OFFSET_MS).toISOString();

  let rows;
  try {
    rows = await readAll(() => {
      let q = supabaseAdmin
        .from('slot_events')
        .select('psychologist_id, slot_date, slot_time, event, actor, occurred_at')
        .in('event', ['created', 'opened'])
        .gte('occurred_at', startUtc)
        .lt('occurred_at', endUtc);
      if (ids) q = q.in('psychologist_id', ids);
      return q.order('id');
    });
  } catch (e) {
    if (/does not exist/i.test(e?.message || '')) return { ...emptyOpenings(), notTracked: true };
    throw e;
  }

  const { data: firstRow } = await supabaseAdmin
    .from('slot_events').select('occurred_at').order('occurred_at').limit(1).maybeSingle();

  const byActor = { system: 0, therapist: 0, admin: 0, client: 0 };
  const byDay = {};
  const leadBuckets = { sameDay: 0, within3: 0, within7: 0, beyond7: 0 };
  const perTherapist = {};
  const openings = [];

  rows.forEach((r) => {
    byActor[r.actor] = (byActor[r.actor] || 0) + 1;

    const openedDay = istDay(r.occurred_at);
    byDay[openedDay] = (byDay[openedDay] || 0) + 1;

    // How far ahead of the appointment the slot was opened.
    const lead = Math.round((Date.parse(`${r.slot_date}T00:00:00Z`) - Date.parse(`${openedDay}T00:00:00Z`)) / 86400000);
    if (lead <= 0) leadBuckets.sameDay += 1;
    else if (lead <= 3) leadBuckets.within3 += 1;
    else if (lead <= 7) leadBuckets.within7 += 1;
    else leadBuckets.beyond7 += 1;

    perTherapist[r.psychologist_id] = (perTherapist[r.psychologist_id] || 0) + 1;

    openings.push({
      psychologistId: r.psychologist_id,
      slotDate: r.slot_date,
      slotTime: r.slot_time,
      openedDate: openedDay,
      openedAt: r.occurred_at,
      actor: r.actor,
      leadDays: lead,
      sameDay: lead <= 0,
    });
  });

  return {
    total: rows.length,
    byActor,
    // The nightly job keeps three weeks filled, so counting it alongside
    // therapist action would measure the cron rather than the people.
    openedByPeople: (byActor.therapist || 0) + (byActor.admin || 0),
    byDay: Object.entries(byDay).sort().map(([date, slots]) => ({ date, slots })),
    leadTime: leadBuckets,
    perTherapist: Object.entries(perTherapist).map(([id, slots]) => ({ psychologistId: id, slots })).sort((a, b) => b.slots - a.slots),
    openings: openings.sort((a, b) => b.openedAt.localeCompare(a.openedAt)).slice(0, 500),
    trackingSince: firstRow?.occurred_at || null,
  };
}

const emptyOpenings = () => ({
  total: 0,
  byActor: { system: 0, therapist: 0, admin: 0, client: 0 },
  openedByPeople: 0,
  byDay: [],
  leadTime: { sameDay: 0, within3: 0, within7: 0, beyond7: 0 },
  perTherapist: [],
  openings: [],
  trackingSince: null,
});

/**
 * How many slots exist, kept as three separate measurements.
 *
 *   scheduledInPeriod  slots whose appointment falls in the window
 *   bookable           of those, the ones nobody has taken
 *   openedInPeriod     slots that were opened during the window, whenever the
 *                      appointment itself happens to be
 *
 * The brief is explicit that these must not be mixed, so they are returned side
 * by side and never summed.
 */
async function slotsAvailable({ from, to, scope }) {
  const ids = await therapistIdsForScope(scope);
  if (ids && ids.length === 0) {
    return { scheduledInPeriod: 0, bookable: 0, booked: 0, byDay: [], perTherapist: [] };
  }

  const avail = await readAll(() => {
    let q = supabaseAdmin.from('availability')
      .select('psychologist_id, date, time_slots, is_available')
      .gte('date', from).lte('date', to);
    if (ids) q = q.in('psychologist_id', ids);
    return q.order('date');
  });

  const booked = await readAll(() => {
    let q = supabaseAdmin.from('sessions')
      .select('psychologist_id, scheduled_date, scheduled_time')
      .gte('scheduled_date', from).lte('scheduled_date', to)
      .in('status', ACTIVE_SESSION_STATUSES);
    if (ids) q = q.in('psychologist_id', ids);
    return q.order('id');
  });

  // A slot is taken when a live session sits on that therapist, date and time.
  const takenKey = (p, d, t) => `${p}|${d}|${String(t || '').slice(0, 5)}`;
  const taken = new Set(booked.map((s) => takenKey(s.psychologist_id, s.scheduled_date, s.scheduled_time)));

  const byDay = {};
  const perTherapist = {};
  let total = 0;
  let free = 0;

  avail.forEach((row) => {
    if (!row.is_available) return;
    const slots = Array.isArray(row.time_slots) ? row.time_slots : [];
    const day = String(row.date).slice(0, 10);
    byDay[day] ||= { date: day, slots: 0, bookable: 0 };
    perTherapist[row.psychologist_id] ||= { psychologistId: row.psychologist_id, slots: 0, bookable: 0 };

    slots.forEach((slot) => {
      const hhmm = /^(\d{1,2}):(\d{2})/.exec(String(slot).trim());
      const key = hhmm ? takenKey(row.psychologist_id, day, `${hhmm[1].padStart(2, '0')}:${hhmm[2]}`) : null;
      const isFree = !key || !taken.has(key);
      total += 1;
      byDay[day].slots += 1;
      perTherapist[row.psychologist_id].slots += 1;
      if (isFree) {
        free += 1;
        byDay[day].bookable += 1;
        perTherapist[row.psychologist_id].bookable += 1;
      }
    });
  });

  return {
    scheduledInPeriod: total,
    bookable: free,
    booked: total - free,
    byDay: Object.values(byDay).sort((a, b) => a.date.localeCompare(b.date)),
    perTherapist: Object.values(perTherapist).sort((a, b) => b.slots - a.slots),
  };
}

/** Everything the overview needs, in one round trip. */
/**
 * The same figures as the overview, but one row per team — or, inside a team,
 * one row per therapist.
 *
 * The level follows the scope, so the table always answers "how do the parts of
 * what I am looking at compare". Everything is grouped from a single pass over
 * the window rather than one request per row: asking the API eight times to
 * fill an eight-row table would be eight times the work for an answer that
 * reads the same rows each time.
 *
 * Rows are the parts of the current scope and so add up to its total, which is
 * only true because a therapist belongs to at most one team and those with
 * none fall into Ungrouped.
 */
async function comparison({ from, to, scope }) {
  const [kind] = String(scope || 'all').split(':');
  // Inside a team the parts are its therapists; at the top they are the teams.
  const groupBy = kind === 'team' ? 'therapist' : 'team';
  if (kind === 'therapist') return { groupBy: 'therapist', rows: [] };

  const ids = await therapistIdsForScope(scope);
  if (ids && ids.length === 0) return { groupBy, rows: [] };

  let pq = supabaseAdmin.from('psychologists').select('id, first_name, last_name, therapist_group_id');
  if (ids) pq = pq.in('id', ids);
  const [{ data: psychs, error: pErr }, groups] = await Promise.all([pq, teams()]);
  if (pErr) throw pErr;

  const teamName = new Map(groups.map((g) => [g.id, g.name]));
  const keyOf = (psychId) => {
    if (groupBy === 'therapist') return psychId;
    const p = (psychs || []).find((x) => x.id === psychId);
    return p?.therapist_group_id || UNGROUPED.id;
  };
  const labelOf = (key) => {
    if (groupBy === 'team') return teamName.get(key) || UNGROUPED.name;
    const p = (psychs || []).find((x) => x.id === key);
    return `${p?.first_name || ''} ${p?.last_name || ''}`.trim() || 'Therapist';
  };

  // Every therapist in scope gets a row, so a team with no activity shows as a
  // zero rather than disappearing — which would read as "no such team".
  const rows = new Map();
  const blank = (key) => ({
    id: key, name: labelOf(key),
    sessions: 0, newClients: 0, returningClients: 0,
    slotsScheduled: 0, slotsBookable: 0, slotsOpened: 0, slotsOpenedByPeople: 0,
  });
  (psychs || []).forEach((p) => {
    const key = keyOf(p.id);
    if (!rows.has(key)) rows.set(key, blank(key));
  });
  const row = (psychId) => {
    const key = keyOf(psychId);
    if (!rows.has(key)) rows.set(key, blank(key));
    return rows.get(key);
  };

  const [sessions, slots, openings] = await Promise.all([
    sessionsInWindow({ from, to, scope, on: 'booking' }),
    slotsAvailable({ from, to, scope }),
    slotOpenings({ from, to, scope }),
  ]);

  // New vs returning is decided the same way as everywhere else, then
  // attributed to whichever part the session's therapist belongs to.
  const clientIds = [...new Set(sessions.map((x) => x.client_id).filter(Boolean))];
  const windowStartUtc = new Date(Date.parse(`${from}T00:00:00Z`) - IST_OFFSET_MS).toISOString();
  const seenBefore = await clientsSeenBefore(clientIds, windowStartUtc);
  const countedFirst = new Set();

  [...sessions]
    .sort((a, b) => String(bookedAt(a) || '').localeCompare(String(bookedAt(b) || '')))
    .forEach((x) => {
      if (!x.psychologist_id) return;
      const r = row(x.psychologist_id);
      r.sessions += 1;
      if (!x.client_id) return;
      if (!seenBefore.has(x.client_id) && !countedFirst.has(x.client_id)) {
        countedFirst.add(x.client_id);
        r.newClients += 1;
      } else {
        r.returningClients += 1;
      }
    });

  slots.perTherapist.forEach((t) => {
    const r = row(t.psychologistId);
    r.slotsScheduled += t.slots;
    r.slotsBookable += t.bookable;
  });
  openings.perTherapist.forEach((t) => { row(t.psychologistId).slotsOpened += t.slots; });
  openings.openings.forEach((o) => {
    if (o.actor === 'therapist' || o.actor === 'admin') row(o.psychologistId).slotsOpenedByPeople += 1;
  });

  const out = [...rows.values()].sort((a, b) => b.sessions - a.sessions || a.name.localeCompare(b.name));
  // Ungrouped reads as a remainder, so it sits last whatever its numbers.
  return { groupBy, rows: out.sort((a, b) => (a.id === UNGROUPED.id ? 1 : b.id === UNGROUPED.id ? -1 : 0)) };
}

async function overview(args) {
  const [booking, session, mix, openings, slots, compare] = await Promise.all([
    bookingTime(args), sessionTime(args), clientMix(args), slotOpenings(args), slotsAvailable(args), comparison(args),
  ]);
  return {
    kpis: {
      sessions: mix.sessions.total,
      newClients: mix.clients.new,
      returningClients: mix.clients.returning,
      slotsOpened: openings.total,
      slotsOpenedByPeople: openings.openedByPeople,
      slotsBookable: slots.bookable,
      slotsScheduled: slots.scheduledInPeriod,
      peakBookingHour: booking.peak?.label || null,
      peakSessionHour: session.peak?.label || null,
    },
    bookingTime: booking,
    sessionTime: session,
    clients: mix,
    slotOpenings: openings,
    slots,
    comparison: compare,
  };
}

module.exports = {
  teams,
  comparison,
  therapists,
  overview,
  bookingTime,
  sessionTime,
  clientMix,
  slotOpenings,
  slotsAvailable,
  therapistIdsForScope,
  UNGROUPED,
};
