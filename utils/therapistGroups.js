/**
 * Therapist groups (A, B, C …) — internal only, for admin and finance. Each
 * therapist is in at most one group (psychologists.therapist_group_id), so the
 * group totals add up to the company total. Clients never see groups.
 * Tables: migration 0007 (therapist_groups + psychologists.therapist_group_id).
 *
 * The report, for an IST date range, per group and per therapist:
 *   sales        successful payments (₹ and count), by payment date
 *   sessions     scheduled in the range: all, completed, cancelled, no-show, still booked
 *   open slots   bookable starts left from today to the end of the range
 *                (individual 50-min grid; psychiatrists 15-min consults)
 *   utilisation  booked ahead ÷ (booked ahead + open slots)
 */

const { supabaseAdmin } = require('../config/supabase');
const { getBookableSlots, ACTIVE_SESSION_STATUSES } = require('./sessionSlots');

const PAID = ['success', 'captured', 'completed', 'paid', 'cash'];
const CANCELLED = ['cancelled', 'canceled'];
const NO_SHOW = ['no_show', 'noshow'];
const NAME_MAX = 40;
const COLOR_RE = /^#[0-9a-f]{6}$/i;
const READY_MSG = 'Therapist groups need the database update — run backend/supabase/RUN_PENDING.sql in the Supabase SQL editor.';

const notReady = (error) => ['42P01', 'PGRST205', '42703', 'PGRST204'].includes(error?.code)
  || /therapist_group/.test(error?.message || '');
const fail = (status, message) => ({ success: false, status, message });
function dbFail(error) {
  if (notReady(error)) return fail(409, READY_MSG);
  if (error?.code === '23505') return fail(400, 'A group with that name already exists');
  throw error;
}

const isYmd = (s) => /^\d{4}-\d{2}-\d{2}$/.test(String(s || ''));
const istToday = () => new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Kolkata' });
const shiftDay = (ymd, n) => {
  const [y, m, d] = ymd.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d + n)).toISOString().slice(0, 10);
};
const lastDayOfMonth = (ymd) => {
  const [y, m] = ymd.split('-').map(Number);
  return new Date(Date.UTC(y, m, 0)).toISOString().slice(0, 10);
};
const fullName = (p) => `${p.first_name || ''} ${p.last_name || ''}`.trim();

/** Every row of a query, 1000 at a time (PostgREST caps a response at 1000). */
async function fetchAll(build) {
  const out = [];
  for (let from = 0; ; from += 1000) {
    const { data, error } = await build().range(from, from + 999);
    if (error) throw error;
    out.push(...(data || []));
    if (!data || data.length < 1000) return out;
  }
}

async function mapLimit(items, limit, fn) {
  const queue = [...items];
  await Promise.all(Array.from({ length: Math.min(limit, queue.length) }, async () => {
    while (queue.length) await fn(queue.shift());
  }));
}

/** Groups (with member ids) and every therapist with their group. */
async function listGroups() {
  const groupsRes = await supabaseAdmin
    .from('therapist_groups')
    .select('id, name, color, description, sort_order, created_at')
    .order('sort_order')
    .order('name');
  let psychRes = await supabaseAdmin
    .from('psychologists')
    .select('id, first_name, last_name, designation, is_active, therapist_group_id')
    .order('first_name');

  if (groupsRes.error && !notReady(groupsRes.error)) throw groupsRes.error;
  const ready = !groupsRes.error && !psychRes.error;
  if (psychRes.error && notReady(psychRes.error)) {
    psychRes = await supabaseAdmin
      .from('psychologists')
      .select('id, first_name, last_name, designation, is_active')
      .order('first_name');
  }
  if (psychRes.error) throw psychRes.error;

  const therapists = (psychRes.data || []).map((p) => ({
    id: p.id,
    name: fullName(p),
    designation: p.designation || '',
    active: p.is_active !== false,
    groupId: p.therapist_group_id || null,
  }));
  const groups = (ready ? groupsRes.data || [] : []).map((g) => ({
    ...g,
    memberIds: therapists.filter((t) => t.groupId === g.id).map((t) => t.id),
  }));
  return { ready, message: ready ? undefined : READY_MSG, groups, therapists };
}

function cleanGroup(input = {}, { partial = false } = {}) {
  const out = {};
  if (!partial || input.name !== undefined) {
    const name = String(input.name || '').trim().replace(/\s+/g, ' ');
    if (!name) return { error: 'Give the group a name (e.g. Group A)' };
    if (name.length > NAME_MAX) return { error: `Keep the name under ${NAME_MAX} characters` };
    out.name = name;
  }
  if (input.color !== undefined) {
    if (input.color && !COLOR_RE.test(input.color)) return { error: 'Colour must look like #189E4F' };
    out.color = input.color || null;
  }
  if (input.description !== undefined) out.description = String(input.description || '').trim().slice(0, 200) || null;
  const order = input.sortOrder ?? input.sort_order;
  if (order !== undefined && Number.isFinite(Number(order))) out.sort_order = Math.round(Number(order));
  return { value: out };
}

async function createGroup(input) {
  const { value, error } = cleanGroup(input);
  if (error) return fail(400, error);
  const stamp = new Date().toISOString();
  const res = await supabaseAdmin
    .from('therapist_groups')
    .insert({ ...value, created_at: stamp, updated_at: stamp })
    .select('*')
    .single();
  if (res.error) return dbFail(res.error);
  return { success: true, message: `Group "${res.data.name}" created`, group: res.data };
}

async function updateGroup(groupId, input) {
  const { value, error } = cleanGroup(input, { partial: true });
  if (error) return fail(400, error);
  const res = await supabaseAdmin
    .from('therapist_groups')
    .update({ ...value, updated_at: new Date().toISOString() })
    .eq('id', groupId)
    .select('*');
  if (res.error) return dbFail(res.error);
  if (!res.data?.length) return fail(404, 'Group not found');
  return { success: true, message: `Group "${res.data[0].name}" saved`, group: res.data[0] };
}

async function deleteGroup(groupId) {
  const unassign = await supabaseAdmin
    .from('psychologists')
    .update({ therapist_group_id: null })
    .eq('therapist_group_id', groupId)
    .select('id');
  if (unassign.error) return dbFail(unassign.error);
  const res = await supabaseAdmin.from('therapist_groups').delete().eq('id', groupId).select('name');
  if (res.error) return dbFail(res.error);
  if (!res.data?.length) return fail(404, 'Group not found');
  const moved = unassign.data?.length || 0;
  return {
    success: true,
    message: `Group "${res.data[0].name}" deleted${moved ? ` — ${moved} therapist(s) are now ungrouped` : ''}`,
  };
}

/** Put a therapist in one group, or none (groupId null). */
async function assignTherapist(psychologistId, groupId) {
  const target = groupId || null;
  if (target) {
    const g = await supabaseAdmin.from('therapist_groups').select('id').eq('id', target).maybeSingle();
    if (g.error) return dbFail(g.error);
    if (!g.data) return fail(404, 'Group not found');
  }
  const res = await supabaseAdmin
    .from('psychologists')
    .update({ therapist_group_id: target })
    .eq('id', psychologistId)
    .select('id');
  if (res.error) return dbFail(res.error);
  if (!res.data?.length) return fail(404, 'Therapist not found');
  return { success: true, message: target ? 'Therapist moved to the group' : 'Therapist removed from their group' };
}

async function groupReport({ dateFrom, dateTo } = {}) {
  const today = istToday();
  let from = isYmd(dateFrom) ? dateFrom : `${today.slice(0, 8)}01`;
  let to = isYmd(dateTo) ? dateTo : lastDayOfMonth(from);
  if (from > to) [from, to] = [to, from];
  if ((Date.parse(to) - Date.parse(from)) / 864e5 > 366) return fail(400, 'Pick a range of one year or less');

  const { ready, message, groups, therapists } = await listGroups();

  const [sessions, payments] = await Promise.all([
    fetchAll(() => supabaseAdmin
      .from('sessions')
      .select('psychologist_id, status, scheduled_date')
      .gte('scheduled_date', from)
      .lte('scheduled_date', to)),
    fetchAll(() => supabaseAdmin
      .from('payments')
      .select('psychologist_id, amount, status, created_at')
      .in('status', PAID)
      .gte('created_at', `${from}T00:00:00+05:30`)
      .lt('created_at', `${shiftDay(to, 1)}T00:00:00+05:30`)),
  ]);

  const blank = () => ({
    sales: 0, payments: 0, sessions: 0, booked: 0, completed: 0, cancelled: 0, noShow: 0, bookedAhead: 0, openSlots: 0,
  });
  const stats = new Map(therapists.map((t) => [t.id, blank()]));

  for (const s of sessions) {
    const st = stats.get(s.psychologist_id);
    if (!st) continue;
    const status = String(s.status || '').toLowerCase();
    st.sessions += 1;
    if (status === 'completed') st.completed += 1;
    else if (CANCELLED.includes(status)) st.cancelled += 1;
    else if (NO_SHOW.includes(status)) st.noShow += 1;
    else if (ACTIVE_SESSION_STATUSES.includes(status)) {
      st.booked += 1;
      if (s.scheduled_date >= today) st.bookedAhead += 1;
    }
  }
  for (const p of payments) {
    const st = stats.get(p.psychologist_id);
    if (!st) continue;
    st.sales += Number(p.amount) || 0;
    st.payments += 1;
  }

  // Open slots exist only from today on; a range fully in the past has none.
  const slotFrom = from > today ? from : today;
  if (slotFrom <= to) {
    await mapLimit(therapists.filter((t) => t.active), 4, async (t) => {
      const kind = /psychiatr/i.test(t.designation) ? 'psychiatry_15' : 'individual';
      try {
        const days = await getBookableSlots(t.id, slotFrom, to, kind);
        stats.get(t.id).openSlots = days.reduce((n, d) => n + d.slots.length, 0);
      } catch (err) {
        console.error(`therapist groups: slots unavailable for ${t.id}:`, err.message);
      }
    });
  }

  const withRates = (m) => ({
    ...m,
    sales: Math.round(m.sales),
    utilisation: m.bookedAhead + m.openSlots > 0 ? Math.round((m.bookedAhead / (m.bookedAhead + m.openSlots)) * 100) : null,
  });
  const sum = (rows) => rows.reduce((acc, r) => {
    Object.keys(acc).forEach((k) => { acc[k] += r[k] || 0; });
    return acc;
  }, blank());
  const bucket = (g, members) => {
    const rows = members
      .map((t) => ({ id: t.id, name: t.name, designation: t.designation, active: t.active, ...withRates(stats.get(t.id)) }))
      .sort((a, b) => b.sales - a.sales || a.name.localeCompare(b.name));
    return {
      id: g?.id || null,
      name: g?.name || 'Ungrouped',
      color: g?.color || null,
      description: g?.description || null,
      therapistCount: members.length,
      ...withRates(sum(rows)),
      therapists: rows,
    };
  };

  const known = new Set(groups.map((g) => g.id));
  const out = groups.map((g) => bucket(g, therapists.filter((t) => t.groupId === g.id)));
  const ungrouped = therapists.filter((t) => !t.groupId || !known.has(t.groupId));
  if (ungrouped.length) out.push(bucket(null, ungrouped));

  return {
    success: true,
    ready,
    message,
    dateFrom: from,
    dateTo: to,
    slotWindow: slotFrom <= to ? { from: slotFrom, to } : null,
    groups: out,
    totals: withRates(sum(out)),
  };
}

module.exports = { listGroups, createGroup, updateGroup, deleteGroup, assignTherapist, groupReport };
