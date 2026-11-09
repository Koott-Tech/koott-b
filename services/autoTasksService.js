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
 *   blog post not updated for 6 months          → Review this post           Marketing team         (daily)
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

async function safe(name, fn) {
  try {
    return await fn();
  } catch (e) {
    if (isMissingTable(e)) throw e;
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
  const { data } = await supabaseAdmin.from('sessions').select('id, client_id, scheduled_date, scheduled_time')
    .eq('status', 'cancelled').gte('updated_at', new Date(Date.now() - 2 * 864e5).toISOString()).gte('scheduled_date', today).limit(100);
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
  for (const p of data || []) {
    const t = await make({
      title: `Payment follow-up: client ${clientRef(p.client_id)} — ₹${Number(p.amount || 0).toLocaleString('en-IN')} not paid`,
      assignee_type: 'team', assignee_id: ops.id, priority: 'high', deadline: inHours(24),
      link_type: 'client', link_id: p.client_id, link_label: `Client ${clientRef(p.client_id)}`, auto_key: `payfail:${p.id}`,
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

/** Deadline reminders: the day before and on the day (once each). */
async function reminders() {
  const today = istDay();
  const tomorrow = addDays(today, 1);
  const { data } = await supabaseAdmin.from('tasks').select('*').not('status', 'in', '(done,cancelled)')
    .gte('deadline', new Date(`${today}T00:00:00+05:30`).toISOString())
    .lt('deadline', new Date(`${addDays(today, 2)}T00:00:00+05:30`).toISOString()).limit(500);
  const { notify } = require('../controllers/tasksController');
  let n = 0;
  for (const t of data || []) {
    const due = istDay(new Date(t.deadline));
    const kind = due === today ? 'due_today' : due === tomorrow ? 'due_tomorrow' : null;
    if (!kind) continue;
    const people = t.claimed_by_id
      ? [{ type: t.claimed_by_type, id: t.claimed_by_id }]
      : t.assignee_type === 'team' ? await teamMembers(t.assignee_id) : [{ type: t.assignee_type, id: t.assignee_id }];
    await notify(people, t, kind, kind === 'due_today' ? 'A task is due today.' : 'A task is due tomorrow.', { type: 'system' }, `${kind}:${t.id}`);
    n += 1;
  }
  return n;
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
    out.reminders = await safe('reminders', () => reminders());
    const today = istDay();
    const runDaily = daily === true || (daily === null && lastDaily !== today && istNow().getUTCHours() >= 9);
    if (runDaily) {
      lastDaily = today;
      out.quiet = await safe('quiet clients', () => quietClients(ops));
      out.availability = await safe('availability', () => therapistAvailability());
      out.calendar = await safe('calendar', () => calendarReconnect());
      out.blog = await safe('blog', () => staleBlogPosts(mkt));
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

module.exports = { runAutoTasks, startAutoTasks };
