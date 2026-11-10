/**
 * Automatic tasks — "Koott dashboards and tasks plan" → Automatic tasks.
 *
 * Every 15 minutes the system looks for the moments a person must act and creates one
 * task per moment (tasks.auto_key makes each one unique, so nothing is created twice):
 *
 *   new lead not contacted within 2 h          → Call this lead            Operations team
 *   session cancelled                           → Reschedule the client      Operations team
 *   package has 1 session left                  → Renewal call               Operations team
 *   client missed a session (no-show)           → Check in with the client   Operations team (+ therapist told)
 *   no booking 30 days after a first session    → Follow-up call             Operations team
 *   payment failed / booking left unpaid        → Payment follow-up          Operations team (+ Finance told)
 *   session ended, not marked done              → Mark the session complete  the therapist
 *   therapist has no open slots for 2 weeks     → Update your availability   the therapist          (daily)
 *   therapist's Google Calendar needs reconnect → Reconnect your calendar    the therapist (+ HR)   (daily)
 *   therapist blocks time over booked sessions  → Reschedule the client      Operations team
 *   a licence / contract expires within 30 days → Renew the document     the person (+ HR)      (daily)
 *   blog post not updated for 6 months          → Review this post           Marketing team         (daily)
 *   an event is 3 days away                     → Send reminders, confirm    Marketing team (+ Ops) (daily)
 *   a client cancels a paid session             → Process the refund         Finance team
 *   the month ends                              → Run payouts; check receipts Finance team          (1st)
 *
 * Plus deadline reminders: a notification the day before and on the day.
 * Tasks carry only what is needed to act — never clinical details.
 */
const { supabaseAdmin } = require('../config/supabase');
const { teamByName, teamMembers, isMissingTable } = require('../utils/people');

const IST_OFFSET_MS = 330 * 60 * 1000;
const istNow = () => new Date(Date.now() + IST_OFFSET_MS);
const istDay = (d = new Date()) => new Date(d.getTime() + IST_OFFSET_MS).toISOString().slice(0, 10);
const addDays = (ymd, n) => { const d = new Date(`${ymd}T00:00:00Z`); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10); };
const inHours = (h) => new Date(Date.now() + h * 3600 * 1000).toISOString();
const clientRef = (id) => `K-${String(id || '').replace(/-/g, '').slice(0, 6).toUpperCase()}`;

let lastDaily = null;
let running = false;

async function make(fields) {
  const { createTask } = require('../controllers/tasksController');
  return createTask(fields, { type: 'system' });
}

const warnedMissing = new Set();
async function safe(name, fn) {
  try {
    return await fn();
  } catch (e) {
    // A rule whose table is not there yet (e.g. SQL 0022 not run) is skipped on its own;
    // it must never stop the other rules.
    if (isMissingTable(e)) {
      if (!warnedMissing.has(name)) { console.warn(`autoTasks: ${name} off until its SQL migration is run.`); warnedMissing.add(name); }
      return 0;
    }
    console.warn(`autoTasks: ${name} skipped:`, e.message);
    return 0;
  }
}

/* --------------------------------------------------------------- the rules */

async function uncontactedLeads(ops) {
  const { data } = await supabaseAdmin.from('leads').select('id, name, source, source_detail, created_at')
    .eq('stage', 'new').is('contacted_at', null)
    .lt('created_at', new Date(Date.now() - 2 * 3600 * 1000).toISOString())
    .gt('created_at', new Date(Date.now() - 3 * 864e5).toISOString()) // not the backfilled history
    .limit(100);
  let n = 0;
  for (const l of data || []) {
    const t = await make({
      title: `Call this lead: ${l.name || 'New lead'} (${l.source}${l.source_detail ? ` · ${l.source_detail}` : ''})`,
      assignee_type: 'team', assignee_id: ops.id, priority: 'urgent', deadline: inHours(1), deadline_has_time: true,
      link_type: 'lead', link_id: l.id, link_label: l.name || 'Lead', auto_key: `lead_call:${l.id}`,
    });
    if (t) n += 1;
  }
  return n;
}

async function cancelledSessions(ops) {
  const today = istDay();
  // 'cancelled' (admin) and 'canceled' (the client cancelled from their dashboard)
  const { data } = await supabaseAdmin.from('sessions').select('id, client_id, scheduled_date, scheduled_time')
    .in('status', ['cancelled', 'canceled']).gte('updated_at', new Date(Date.now() - 2 * 864e5).toISOString()).gte('scheduled_date', today).limit(100);
  let n = 0;
  for (const s of data || []) {
    if (await make({
      title: `Reschedule the client ${clientRef(s.client_id)} — session on ${s.scheduled_date} was cancelled`,
      assignee_type: 'team', assignee_id: ops.id, priority: 'high', deadline: inHours(24),
      link_type: 'session', link_id: s.id, link_label: `Session ${s.scheduled_date} ${String(s.scheduled_time || '').slice(0, 5)}`,
      auto_key: `reschedule:${s.id}`,
    })) n += 1;
  }
  return n;
}

async function renewals(ops) {
  const { data } = await supabaseAdmin.from('client_packages').select('id, client_id, package_type, remaining_sessions, status')
    .eq('remaining_sessions', 1).limit(200);
  let n = 0;
  for (const p of (data || []).filter((x) => !x.status || x.status === 'active')) {
    if (await make({
      title: `Renewal call: client ${clientRef(p.client_id)} has 1 session left`,
      assignee_type: 'team', assignee_id: ops.id, priority: 'normal', deadline: inHours(72),
      link_type: 'client', link_id: p.client_id, link_label: `Client ${clientRef(p.client_id)}`, auto_key: `renewal:${p.id}`,
    })) n += 1;
  }
  return n;
}

async function missedSessions(ops) {
  const { data } = await supabaseAdmin.from('sessions').select('id, client_id, psychologist_id, scheduled_date')
    .eq('status', 'no_show').gte('updated_at', new Date(Date.now() - 2 * 864e5).toISOString()).limit(100);
  let n = 0;
  const { notify } = require('../controllers/tasksController');
  for (const s of data || []) {
    const t = await make({
      title: `Check in with client ${clientRef(s.client_id)} — missed the session on ${s.scheduled_date}`,
      assignee_type: 'team', assignee_id: ops.id, priority: 'high', deadline: inHours(24),
      link_type: 'session', link_id: s.id, link_label: `Session ${s.scheduled_date}`, auto_key: `noshow:${s.id}`,
    });
    if (t) {
      n += 1;
      if (s.psychologist_id) await notify([{ type: 'psychologist', id: s.psychologist_id }], t, 'status', 'Operations will check in with your client who missed a session.', { type: 'system' });
    }
  }
  return n;
}

async function quietClients(ops) {
  const day = addDays(istDay(), -30);
  const { data: done } = await supabaseAdmin.from('sessions').select('client_id').eq('status', 'completed').eq('scheduled_date', day).limit(200);
  const ids = [...new Set((done || []).map((s) => s.client_id).filter(Boolean))];
  let n = 0;
  for (const clientId of ids) {
    const { count } = await supabaseAdmin.from('sessions').select('id', { count: 'exact', head: true })
      .eq('client_id', clientId).gt('scheduled_date', day);
    if (count) continue;
    if (await make({
      title: `Follow-up call: client ${clientRef(clientId)} hasn't booked for 30 days`,
      assignee_type: 'team', assignee_id: ops.id, priority: 'normal', deadline: inHours(72),
      link_type: 'client', link_id: clientId, link_label: `Client ${clientRef(clientId)}`, auto_key: `followup30:${clientId}:${day}`,
    })) n += 1;
  }
  return n;
}

async function failedPayments(ops) {
  const { data } = await supabaseAdmin.from('payments').select('id, client_id, amount, created_at')
    .eq('status', 'failed').not('razorpay_order_id', 'is', null)
    .gte('created_at', new Date(Date.now() - 2 * 864e5).toISOString()).limit(100);
  let n = 0;
  const { notify } = require('../controllers/tasksController');
  const finance = await teamByName('Finance');
  // One task per client per day, however many times they retried checkout — and none
  // when they paid successfully afterwards.
  const latest = new Map();
  (data || []).forEach((p) => {
    if (!p.client_id) return;
    const prev = latest.get(p.client_id);
    if (!prev || new Date(p.created_at) > new Date(prev.created_at)) latest.set(p.client_id, p);
  });
  for (const p of latest.values()) {
    const { count: paidAfter } = await supabaseAdmin.from('payments').select('id', { count: 'exact', head: true })
      .eq('client_id', p.client_id).eq('status', 'success').gt('created_at', p.created_at);
    if (paidAfter) continue;
    const t = await make({
      title: `Payment follow-up: client ${clientRef(p.client_id)} — ₹${Number(p.amount || 0).toLocaleString('en-IN')} not paid`,
      assignee_type: 'team', assignee_id: ops.id, priority: 'high', deadline: inHours(24),
      link_type: 'client', link_id: p.client_id, link_label: `Client ${clientRef(p.client_id)}`,
      auto_key: `payfail:${p.client_id}:${istDay(new Date(p.created_at))}`,
    });
    if (t) {
      n += 1;
      await notify(await teamMembers(finance.id), t, 'status', 'FYI: Operations is following up an unpaid booking.', { type: 'system' });
    }
  }
  return n;
}

async function sessionsNotCompleted() {
  const today = istDay();
  const { data } = await supabaseAdmin.from('sessions').select('id, psychologist_id, client_id, scheduled_date, scheduled_time, status')
    .in('status', ['booked', 'rescheduled', 'confirmed', 'scheduled', 'upcoming'])
    .gte('scheduled_date', addDays(today, -3)).lte('scheduled_date', today).limit(300);
  const cutoff = Date.now() - 2 * 3600 * 1000; // 2 h after the start
  let n = 0;
  for (const s of data || []) {
    if (!s.psychologist_id || !s.scheduled_time) continue;
    const start = new Date(`${s.scheduled_date}T${String(s.scheduled_time).slice(0, 8)}+05:30`).getTime();
    if (start > cutoff) continue;
    if (await make({
      title: `Mark the session complete: ${s.scheduled_date} ${String(s.scheduled_time).slice(0, 5)} with client ${clientRef(s.client_id)}`,
      assignee_type: 'psychologist', assignee_id: s.psychologist_id, priority: 'normal', deadline: inHours(24),
      link_type: 'session', link_id: s.id, link_label: `Session ${s.scheduled_date}`, auto_key: `complete:${s.id}`,
    })) n += 1;
  }
  return n;
}

async function therapistAvailability() {
  const { getBookableSlots } = require('../utils/sessionSlots');
  const { data } = await supabaseAdmin.from('psychologists').select('id, designation, is_active').neq('is_active', false);
  const from = istDay();
  const to = addDays(from, 14);
  const week = `${istNow().getUTCFullYear()}-w${Math.ceil(((istNow() - new Date(Date.UTC(istNow().getUTCFullYear(), 0, 1))) / 864e5 + 1) / 7)}`;
  let n = 0;
  for (const p of data || []) {
    const kind = /psychiatr/i.test(p.designation || '') ? 'psychiatry_15' : 'individual';
    const days = await getBookableSlots(p.id, from, to, kind).catch(() => null);
    if (!days || days.some((d) => d.slots.length)) continue;
    if (await make({
      title: 'Update your availability — no open slots for the next 2 weeks',
      assignee_type: 'psychologist', assignee_id: p.id, priority: 'high', deadline: inHours(48),
      link_type: 'url', link_url: '/psychologist/availability', link_label: 'Your availability', auto_key: `availability:${p.id}:${week}`,
    })) n += 1;
  }
  return n;
}

async function calendarReconnect() {
  const { data } = await supabaseAdmin.from('psychologists').select('id, google_calendar_credentials, is_active').neq('is_active', false);
  const { notify } = require('../controllers/tasksController');
  const hr = await teamByName('HR');
  let n = 0;
  for (const p of data || []) {
    const c = p.google_calendar_credentials;
    if (!c || typeof c !== 'object' || c.refresh_token || !c.access_token) continue; // connected, or never connected
    const t = await make({
      title: 'Reconnect your Google Calendar — the sync has stopped',
      assignee_type: 'psychologist', assignee_id: p.id, priority: 'high', deadline: inHours(48),
      link_type: 'url', link_url: '/psychologist/settings', link_label: 'Calendar settings', auto_key: `calendar:${p.id}:${istDay()}`,
    });
    if (t) { n += 1; await notify(await teamMembers(hr.id), t, 'status', 'FYI: a therapist\'s calendar sync has stopped.', { type: 'system' }); }
  }
  return n;
}

async function staleBlogPosts(mkt) {
  const { data } = await supabaseAdmin.from('blogs').select('id, title, updated_at')
    .eq('status', 'published').lt('updated_at', new Date(Date.now() - 182 * 864e5).toISOString()).limit(20);
  let n = 0;
  for (const b of data || []) {
    if (await make({
      title: `Review this post: "${b.title}" (not updated for 6 months)`,
      assignee_type: 'team', assignee_id: mkt.id, priority: 'low', deadline: inHours(24 * 14),
      link_type: 'blog', link_id: b.id, link_label: b.title, auto_key: `blogreview:${b.id}:${String(b.updated_at).slice(0, 10)}`,
    })) n += 1;
  }
  return n;
}

async function monthEnd(finance) {
  const now = istNow();
  if (now.getUTCDate() !== 1) return 0;
  const prev = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - 1, 1));
  const label = prev.toLocaleDateString('en-GB', { month: 'long', year: 'numeric', timeZone: 'UTC' });
  const t = await make({
    title: `Run ${label} therapist payouts; check receipts`, assignee_type: 'team', assignee_id: finance.id, priority: 'high',
    deadline: inHours(24 * 9), template_key: 'monthly_payouts',
    checklist: require('../controllers/tasksController').TEMPLATES.monthly_payouts.steps.map((text, i) => ({ id: `s${i}`, text, done: false })),
    link_type: 'url', link_url: '/finance/payouts', link_label: 'Payouts', auto_key: `payouts:${prev.toISOString().slice(0, 7)}`,
  });
  return t ? 1 : 0;
}

/** A client cancelled a paid session → Process the refund (Finance). Admin's "cancel & refund" refunds itself. */
async function refundRequests(finance) {
  const { data } = await supabaseAdmin.from('sessions').select('id, client_id, scheduled_date, scheduled_time, payment_id, price, amount')
    .eq('status', 'canceled').gte('updated_at', new Date(Date.now() - 3 * 864e5).toISOString()).limit(100);
  let n = 0;
  // Refunds are Operations' refund requests now (header icon → Refund → Razorpay). This
  // rule is the safety net: a cancelled paid session without a request gets one.
  const { createRefundRequest } = require('../utils/refunds');
  const { data: existing } = await supabaseAdmin.from('refund_requests').select('session_id')
    .in('session_id', (data || []).map((s) => s.id).concat(['00000000-0000-0000-0000-000000000000']));
  const has = new Set((existing || []).map((r) => r.session_id));
  for (const s of data || []) {
    const paid = s.payment_id || Number(s.price) > 0 || Number(s.amount) > 0;
    if (!paid || has.has(s.id)) continue;
    if (await createRefundRequest({ sessionId: s.id, source: 'system', reason: 'Cancelled by the client (found automatically)' })) n += 1;
  }
  return n;
}

/** Therapist blocks out time that already has booked sessions → reschedule them (Operations). */
async function unavailableOverBookings(ops) {
  const today = istDay();
  const { data: blocks } = await supabaseAdmin.from('psychologist_date_blocks')
    .select('id, psychologist_id, date, block_entire_day, time_slots, updated_at')
    .gte('date', today).gte('updated_at', new Date(Date.now() - 3 * 864e5).toISOString()).limit(200);
  const toMin = (t) => { const m = /^(\d{1,2}):(\d{2})/.exec(String(t || '')); return m ? Number(m[1]) * 60 + Number(m[2]) : null; };
  let n = 0;
  for (const b of blocks || []) {
    const { data: sessions } = await supabaseAdmin.from('sessions')
      .select('id, client_id, scheduled_date, scheduled_time, session_type')
      .eq('psychologist_id', b.psychologist_id).eq('scheduled_date', b.date)
      .in('status', ['booked', 'rescheduled', 'confirmed', 'scheduled', 'upcoming']);
    const hours = (b.time_slots || []).map(toMin).filter((x) => x !== null);
    for (const s of sessions || []) {
      const start = toMin(s.scheduled_time);
      const len = /couple/i.test(s.session_type || '') ? 80 : 50;
      const hit = b.block_entire_day || hours.some((h) => start !== null && start < h + 60 && h < start + len);
      if (!hit) continue;
      if (await make({
        title: `Reschedule client ${clientRef(s.client_id)} — the therapist is now unavailable on ${s.scheduled_date} at ${String(s.scheduled_time).slice(0, 5)}`,
        assignee_type: 'team', assignee_id: ops.id, priority: 'urgent', deadline: inHours(12),
        link_type: 'session', link_id: s.id, link_label: `Session ${s.scheduled_date} ${String(s.scheduled_time).slice(0, 5)}`,
        auto_key: `unavailable:${s.id}:${b.date}`,
      })) n += 1;
    }
  }
  return n;
}

/** An event is 3 days away → send reminders, confirm the link or venue (Marketing; Operations told). */
const MONTHS = { jan: 0, feb: 1, mar: 2, apr: 3, may: 4, jun: 5, jul: 6, aug: 7, sep: 8, oct: 9, nov: 10, dec: 11 };
function eventDayOf(page) {
  const text = JSON.stringify(page.cms_data || page.content || {});
  const sched = /"schedule"\s*:\s*"([^"]+)"/.exec(text)?.[1] || /"date"\s*:\s*"([^"]+)"/.exec(text)?.[1] || '';
  const m = /(\d{1,2})\s+([A-Za-z]{3})[a-z]*,?\s+(\d{4})/.exec(sched);
  if (!m || MONTHS[m[2].toLowerCase()] === undefined) return null;
  return new Date(Date.UTC(Number(m[3]), MONTHS[m[2].toLowerCase()], Number(m[1]))).toISOString().slice(0, 10);
}
async function eventsSoon(mkt, ops) {
  const { data } = await supabaseAdmin.from('event_pages').select('slug, title, is_published, cms_data, content').eq('is_published', true).limit(200);
  const today = istDay();
  const { notify } = require('../controllers/tasksController');
  let n = 0;
  for (const p of data || []) {
    const day = eventDayOf(p);
    if (!day || day < today || day > addDays(today, 3)) continue;
    const t = await make({
      title: `Event on ${day}: send reminders and confirm the meeting link or venue — ${p.title || p.slug}`,
      assignee_type: 'team', assignee_id: mkt.id, priority: 'high', deadline: new Date(`${addDays(day, -1)}T18:00:00+05:30`).toISOString(),
      link_type: 'url', link_url: `/events/${p.slug}`, link_label: p.title || p.slug, auto_key: `event3:${p.slug}:${day}`,
    });
    if (t) { n += 1; await notify(await teamMembers(ops.id), t, 'status', 'FYI: an event is 3 days away.', { type: 'system' }); }
  }
  return n;
}

/** A licence / contract expires within 30 days → Renew the document (HR team + the person). */
async function expiringDocuments(hr) {
  const today = istDay();
  const { data, error } = await supabaseAdmin.from('staff_documents').select('id, person_type, person_id, title, kind, expires_on')
    .not('expires_on', 'is', null).lte('expires_on', addDays(today, 30)).gte('expires_on', addDays(today, -60)).limit(200);
  if (error) throw error;
  const { notify } = require('../controllers/tasksController');
  let n = 0;
  for (const d of data || []) {
    const t = await make({
      title: `Renew the ${d.kind === 'id_proof' ? 'ID' : d.kind}: "${d.title}" ${d.expires_on < today ? 'expired' : 'expires'} on ${d.expires_on}`,
      assignee_type: d.person_type, assignee_id: d.person_id, priority: d.expires_on < today ? 'urgent' : 'high',
      deadline: new Date(`${d.expires_on}T12:00:00+05:30`).toISOString(),
      details: 'Upload the renewed document in Documents (HR keeps a copy).',
      link_type: 'person', link_id: `${d.person_type}:${d.person_id}`, link_label: d.title, auto_key: `docexpiry:${d.id}:${d.expires_on}`,
    });
    if (t) { n += 1; await notify(await teamMembers(hr.id), t, 'status', 'FYI: a document is about to expire.', { type: 'system' }); }
  }
  return n;
}

/** Deadline reminders: the day before and on the day (once each). */
async function reminders() {
  const today = istDay();
  const tomorrow = addDays(today, 1);
  const { data } = await supabaseAdmin.from('tasks').select('*').not('status', 'in', '(done,cancelled)')
    .gte('deadline', new Date(`${today}T00:00:00+05:30`).toISOString())
    .lt('deadline', new Date(`${addDays(today, 2)}T00:00:00+05:30`).toISOString()).limit(500);
  const { notifyMany } = require('../controllers/tasksController');
  // Members of every team involved, in one query (was one query per task: N+1).
  const teamIds = [...new Set((data || []).filter((t) => t.assignee_type === 'team' && !t.claimed_by_id).map((t) => t.assignee_id))];
  const membersOf = new Map(teamIds.map((id) => [id, []]));
  if (teamIds.length) {
    const { data: rows, error } = await supabaseAdmin.from('team_members').select('team_id, person_type, person_id').in('team_id', teamIds);
    if (error) throw error;
    (rows || []).forEach((m) => membersOf.get(m.team_id)?.push({ type: m.person_type, id: m.person_id }));
  }
  const entries = [];
  for (const t of data || []) {
    const due = istDay(new Date(t.deadline));
    const kind = due === today ? 'due_today' : due === tomorrow ? 'due_tomorrow' : null;
    if (!kind) continue;
    const people = t.claimed_by_id
      ? [{ type: t.claimed_by_type, id: t.claimed_by_id }]
      : t.assignee_type === 'team' ? (membersOf.get(t.assignee_id) || []) : [{ type: t.assignee_type, id: t.assignee_id }];
    entries.push({ people, task: t, kind, message: kind === 'due_today' ? 'A task is due today.' : 'A task is due tomorrow.', dedupeKey: `${kind}:${t.id}` });
  }
  // One batched write for all of them; returns how many reminders were new this run.
  return notifyMany(entries);
}

/* ------------------------------------------------------------------ runner */

async function runAutoTasks({ daily = null } = {}) {
  if (running) return null;
  running = true;
  const out = {};
  try {
    const [ops, finance, mkt] = await Promise.all([teamByName('Operations'), teamByName('Finance'), teamByName('Marketing')]);
    out.leads = await safe('leads', () => uncontactedLeads(ops));
    out.cancelled = await safe('cancelled', () => cancelledSessions(ops));
    out.renewals = await safe('renewals', () => renewals(ops));
    out.missed = await safe('missed', () => missedSessions(ops));
    out.payments = await safe('payments', () => failedPayments(ops));
    out.complete = await safe('complete', () => sessionsNotCompleted());
    out.unavailable = await safe('unavailable', () => unavailableOverBookings(ops));
    out.refunds = await safe('refunds', () => refundRequests(finance));
    out.reminders = await safe('reminders', () => reminders());
    const today = istDay();
    const runDaily = daily === true || (daily === null && lastDaily !== today && istNow().getUTCHours() >= 9);
    if (runDaily) {
      lastDaily = today;
      out.quiet = await safe('quiet clients', () => quietClients(ops));
      out.availability = await safe('availability', () => therapistAvailability());
      out.calendar = await safe('calendar', () => calendarReconnect());
      out.blog = await safe('blog', () => staleBlogPosts(mkt));
      out.events = await safe('events', () => eventsSoon(mkt, ops));
      out.documents = await safe('documents', async () => expiringDocuments(await teamByName('HR')));
      out.monthEnd = await safe('month end', () => monthEnd(finance));
    }
    const made = Object.values(out).reduce((a, b) => a + (Number(b) || 0), 0);
    if (made) console.log('🗂️  Automatic tasks:', out);
    return out;
  } catch (e) {
    if (isMissingTable(e)) {
      if (!runAutoTasks.warned) { console.warn('🗂️  Automatic tasks are off until migration 0021 is run (backend/supabase/RUN_PENDING_0021.sql).'); runAutoTasks.warned = true; }
      return null;
    }
    console.warn('autoTasks: run failed:', e.message);
    return null;
  } finally {
    running = false;
  }
}

function startAutoTasks() {
  if (process.env.AUTO_TASKS === 'off') return;
  setTimeout(() => runAutoTasks(), 30 * 1000);
  setInterval(() => runAutoTasks(), 15 * 60 * 1000);
  console.log('🗂️  Automatic tasks scheduled (every 15 minutes)');
}

module.exports = { runAutoTasks, startAutoTasks, eventDayOf, monthEnd, isRunning: () => running };
