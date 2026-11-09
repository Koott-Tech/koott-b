/**
 * /api/leads — the Operations lead pipeline (table `leads`, migration 0021).
 *
 * Five stages: new → contacted → follow_up → converted | lost. Each lead keeps its
 * source, so Marketing can see which ads and pages bring paying clients
 * (GET /api/leads/sources). "Convert to client" links an existing client (same phone
 * or email) or creates one, and keeps the lead's notes and source on the lead row.
 */
const crypto = require('crypto');
const { supabaseAdmin } = require('../config/supabase');
const { hashPassword } = require('../utils/helpers');
const { personOf, UUID_RE } = require('../utils/staffRoles');
const validDate = (v) => !Number.isNaN(new Date(v).getTime());
const { key, namesFor, isMissingTable, NOT_READY } = require('../utils/people');
const { STAGES, SOURCES, upsertSourceLead } = require('../utils/leads');
const { normalizePhone } = require('../utils/phoneVerification');
const { fetchAll } = require('../utils/fetchAll');

const ok = (res, data, status = 200) => res.status(status).json({ success: true, data });
const fail = (res, status, message) => res.status(status).json({ success: false, message });
const handle = (res, e, what) => {
  if (isMissingTable(e)) return fail(res, 503, NOT_READY);
  console.error(`leads: ${what}:`, e?.message || e);
  return fail(res, 500, `Could not ${what}.`);
};

async function withNames(leads) {
  const refs = leads.filter((l) => l.owner_id).map((l) => ({ type: l.owner_type, id: l.owner_id }));
  const psychIds = [...new Set(leads.map((l) => l.psychologist_id).filter(Boolean))];
  const [names, psychs] = await Promise.all([
    namesFor(refs),
    psychIds.length ? supabaseAdmin.from('psychologists').select('id, first_name, last_name').in('id', psychIds) : { data: [] },
  ]);
  const psychName = new Map((psychs.data || []).map((p) => [p.id, `${p.first_name || ''} ${p.last_name || ''}`.trim()]));
  const now = Date.now();
  return leads.map((l) => ({
    ...l,
    ownerName: l.owner_id ? names[key(l.owner_type, l.owner_id)]?.name || null : null,
    therapistName: l.psychologist_id ? psychName.get(l.psychologist_id) || null : null,
    followUpDue: Boolean(l.next_follow_up_at) && new Date(l.next_follow_up_at).getTime() <= now && !['converted', 'lost'].includes(l.stage),
    waitingTooLong: l.stage === 'new' && now - new Date(l.created_at).getTime() > 2 * 3600 * 1000,
  }));
}

/**
 * Stage / source totals for the Leads header. Every Operations screen polls the list each
 * minute, so the totals are worked out once per 30 s for everyone (COUNT queries: nothing
 * downloaded, and right past Supabase's 1,000-row answer limit).
 */
let countsCache = { at: 0, value: null, pending: null };
async function leadCounts() {
  if (countsCache.value && Date.now() - countsCache.at < 30 * 1000) return countsCache.value;
  if (countsCache.pending) return countsCache.pending;
  const countOf = (col, v) => supabaseAdmin.from('leads').select('id', { count: 'exact', head: true }).eq(col, v);
  countsCache.pending = Promise.all([Promise.all(STAGES.map((s) => countOf('stage', s))), Promise.all(SOURCES.map((s) => countOf('source', s)))])
    .then(([stageCounts, sourceCounts]) => {
      const value = {
        byStage: Object.fromEntries(STAGES.map((s, i) => [s, stageCounts[i].count || 0])),
        bySource: Object.fromEntries(SOURCES.map((s, i) => [s, sourceCounts[i].count || 0]).filter(([, n]) => n)),
      };
      if (![...stageCounts, ...sourceCounts].some((r) => r.error)) countsCache = { at: Date.now(), value, pending: null };
      return value;
    })
    .finally(() => { countsCache.pending = null; });
  return countsCache.pending;
}
/** A lead changed: the next list shows fresh totals. */
const dropLeadCounts = () => { countsCache = { at: 0, value: null, pending: null }; };

async function listLeads(req, res) {
  try {
    let q = supabaseAdmin.from('leads').select('*').order('created_at', { ascending: false }).limit(1000);
    if (STAGES.includes(req.query.stage)) q = q.eq('stage', req.query.stage);
    if (SOURCES.includes(req.query.source)) q = q.eq('source', req.query.source);
    if (req.query.owner === 'me') { const me = personOf(req.user); q = q.eq('owner_type', me.type).eq('owner_id', me.id); }
    if (req.query.due === '1') q = q.lte('next_follow_up_at', new Date().toISOString()).in('stage', ['new', 'contacted', 'follow_up']);
    if (req.query.q) {
      const t = String(req.query.q).replace(/[%,()]/g, ' ').trim().slice(0, 60);
      if (t) q = q.or(`name.ilike.%${t}%,phone.ilike.%${t}%,email.ilike.%${t}%`);
    }
    // Counts as COUNT queries (polled every minute by each Operations screen): no rows are
    // downloaded, and they stay right past Supabase's 1,000-row answer limit.
    const [{ data, error }, counts] = await Promise.all([q, leadCounts()]);
    if (error) return handle(res, error, 'load leads');
    const { byStage, bySource } = counts;
    return ok(res, { leads: await withNames(data || []), counts: { byStage, bySource }, stages: STAGES, sources: SOURCES });
  } catch (e) {
    return handle(res, e, 'load leads');
  }
}

async function createLead(req, res) {
  try {
    const b = req.body || {};
    if (!String(b.name || '').trim() && !b.phone && !b.email) return fail(res, 400, 'Add a name, phone or email.');
    const me = personOf(req.user);
    const { data, error } = await supabaseAdmin.from('leads').insert({
      source: SOURCES.includes(b.source) ? b.source : 'manual',
      source_detail: b.source_detail ? String(b.source_detail).slice(0, 200) : null,
      name: b.name ? String(b.name).trim().slice(0, 120) : null,
      phone: b.phone ? (normalizePhone(b.phone) || String(b.phone).trim()) : null,
      email: b.email ? String(b.email).trim().toLowerCase() : null,
      notes: b.notes ? String(b.notes).slice(0, 5000) : null,
      owner_type: me.type, owner_id: me.id,
    }).select('*').single();
    if (error) return handle(res, error, 'add the lead');
    dropLeadCounts();
    const [lead] = await withNames([data]);
    return ok(res, { lead }, 201);
  } catch (e) {
    return handle(res, e, 'add the lead');
  }
}

async function updateLead(req, res) {
  try {
    const b = req.body || {};
    if (!UUID_RE.test(String(req.params.id || ''))) return fail(res, 404, 'Lead not found.');
    const { data: lead, error } = await supabaseAdmin.from('leads').select('*').eq('id', req.params.id).maybeSingle();
    if (error) return handle(res, error, 'update the lead');
    if (!lead) return fail(res, 404, 'Lead not found.');
    if (b.next_follow_up_at && !validDate(b.next_follow_up_at)) return fail(res, 400, 'The follow-up date is not a date.');
    // A converted lead is a client now: its stage is history and stays put.
    if (lead.stage === 'converted' && b.stage !== undefined && b.stage !== 'converted') return fail(res, 400, 'This lead is already a client; its stage cannot change.');
    const now = new Date().toISOString();
    const patch = { updated_at: now };
    ['name', 'email', 'notes', 'source_detail'].forEach((f) => { if (b[f] !== undefined) patch[f] = b[f] ? String(b[f]).slice(0, f === 'notes' ? 5000 : 200) : null; });
    if (b.phone !== undefined) patch.phone = b.phone ? (normalizePhone(b.phone) || String(b.phone).trim()) : null;
    if (b.next_follow_up_at !== undefined) patch.next_follow_up_at = b.next_follow_up_at ? new Date(b.next_follow_up_at).toISOString() : null;
    if (b.owner !== undefined) {
      if (b.owner === null || b.owner === '') { patch.owner_type = null; patch.owner_id = null; } else {
        const [t, id] = String(b.owner).split(':');
        if (b.owner !== 'me' && (!['user', 'psychologist'].includes(t) || !UUID_RE.test(String(id || '')))) return fail(res, 400, 'Unknown owner.');
        patch.owner_type = t; patch.owner_id = id;
      }
    }
    if (b.owner === 'me') { const me = personOf(req.user); patch.owner_type = me.type; patch.owner_id = me.id; }
    if (b.stage !== undefined && b.stage !== lead.stage) {
      if (!STAGES.includes(b.stage)) return fail(res, 400, 'Unknown stage.');
      if (b.stage === 'converted') return fail(res, 400, 'Use "Convert to client" to convert a lead.');
      if (b.stage === 'lost' && !String(b.lost_reason || lead.lost_reason || '').trim()) return fail(res, 400, 'Say why the lead was lost.');
      patch.stage = b.stage;
      patch.stage_changed_at = now;
      if (b.stage === 'contacted' && !lead.contacted_at) patch.contacted_at = now;
      if (b.stage === 'follow_up' && !lead.contacted_at) patch.contacted_at = now;
      if (!lead.owner_id && !patch.owner_id) { const me = personOf(req.user); patch.owner_type = me.type; patch.owner_id = me.id; }
    }
    if (b.lost_reason !== undefined) patch.lost_reason = b.lost_reason ? String(b.lost_reason).slice(0, 500) : null;
    const { data: updated, error: upErr } = await supabaseAdmin.from('leads').update(patch).eq('id', lead.id).select('*').single();
    if (upErr) return handle(res, upErr, 'update the lead');
    dropLeadCounts();
    // The "call this lead" task closes once someone has been in touch.
    if (patch.contacted_at) {
      await supabaseAdmin.from('tasks').update({ status: 'done', completed_at: now, updated_at: now })
        .eq('auto_key', `lead_call:${lead.id}`).not('status', 'in', '(done,cancelled)');
    }
    const [out] = await withNames([updated]);
    return ok(res, { lead: out });
  } catch (e) {
    return handle(res, e, 'update the lead');
  }
}

/** Find the client for a phone or email. */
async function findClient(phone, email) {
  if (phone) {
    const { findClientByPhone } = require('../utils/bookingAccounts');
    const c = await findClientByPhone(phone).catch(() => null);
    if (c) return c;
  }
  if (email) {
    const { data: u } = await supabaseAdmin.from('users').select('id, role').eq('email', email.toLowerCase()).maybeSingle();
    if (u && u.role === 'client') {
      const { data: c } = await supabaseAdmin.from('clients').select('*').eq('user_id', u.id).maybeSingle();
      if (c) return c;
    }
    if (u && u.role !== 'client') throw Object.assign(new Error('That email belongs to a staff login, not a client.'), { status: 409 });
  }
  return null;
}

async function convertLead(req, res) {
  try {
    if (!UUID_RE.test(String(req.params.id || ''))) return fail(res, 404, 'Lead not found.');
    const { data: lead, error } = await supabaseAdmin.from('leads').select('*').eq('id', req.params.id).maybeSingle();
    if (error) return handle(res, error, 'convert the lead');
    if (!lead) return fail(res, 404, 'Lead not found.');
    if (lead.stage === 'converted' && lead.client_id) return fail(res, 400, 'This lead is already a client.');
    if (req.body.client_id && !UUID_RE.test(String(req.body.client_id))) return fail(res, 400, 'Unknown client.');
    if (req.body.client_id) {
      const { data: c } = await supabaseAdmin.from('clients').select('id').eq('id', req.body.client_id).maybeSingle();
      if (!c) return fail(res, 404, 'Client not found.');
    }
    // Claim the conversion first (one request wins): pressing "Convert" twice, or two people
    // at once, never creates two client logins. The claim is a write that only succeeds
    // while the row is exactly as we read it (same updated_at).
    const claimAt = new Date().toISOString();
    const { data: claimed, error: claimErr } = await supabaseAdmin.from('leads')
      .update({ updated_at: claimAt })
      .eq('id', lead.id).eq('updated_at', lead.updated_at).or('stage.neq.converted,client_id.is.null').select('id');
    if (claimErr) return handle(res, claimErr, 'convert the lead');
    if (!claimed || !claimed.length) return fail(res, 409, 'This lead was just changed or converted by someone else. Reload it.');

    let clientId = req.body.client_id || lead.client_id || null;
    let created = false;
    if (!clientId) {
      const existing = await findClient(lead.phone, lead.email);
      if (existing) clientId = existing.id;
    }
    if (!clientId) {
      if (!lead.email) return fail(res, 400, 'Add the lead\'s email first — a client login needs one.');
      const password = `${crypto.randomBytes(18).toString('base64url')}Aa1!`;
      const { data: user, error: uErr } = await supabaseAdmin.from('users').insert({
        email: lead.email.toLowerCase(), password_hash: await hashPassword(password), role: 'client',
        name: lead.name || lead.email, phone_number: lead.phone || null,
      }).select('id').single();
      if (uErr) return uErr.code === '23505' ? fail(res, 409, 'That email already has a login.') : handle(res, uErr, 'create the client');
      const { data: client, error: cErr } = await supabaseAdmin.from('clients').insert({
        user_id: user.id, first_name: lead.name || '', last_name: '', email: lead.email.toLowerCase(),
        phone_number: lead.phone || null, child_name: 'Pending', child_age: 1,
      }).select('id').single();
      if (cErr) { await supabaseAdmin.from('users').delete().eq('id', user.id); return handle(res, cErr, 'create the client'); }
      clientId = client.id;
      created = true;
    }
    const now = new Date().toISOString();
    const me = personOf(req.user);
    const { data: updated, error: upErr } = await supabaseAdmin.from('leads').update({
      stage: 'converted', client_id: clientId, converted_at: now, stage_changed_at: now, updated_at: now,
      contacted_at: lead.contacted_at || now,
      owner_type: lead.owner_type || me.type, owner_id: lead.owner_id || me.id,
      meta: { ...(lead.meta || {}), converted_by: key(me.type, me.id), client_created: created },
    }).eq('id', lead.id).select('*').single();
    if (upErr) return handle(res, upErr, 'convert the lead');
    dropLeadCounts();
    await supabaseAdmin.from('tasks').update({ status: 'done', completed_at: now, updated_at: now })
      .eq('auto_key', `lead_call:${lead.id}`).not('status', 'in', '(done,cancelled)');
    const [out] = await withNames([updated]);
    return ok(res, { lead: out, clientId, created });
  } catch (e) {
    if (e.status) return fail(res, e.status, e.message);
    return handle(res, e, 'convert the lead');
  }
}

/** Marketing: leads, converted and paying clients per source over a date range. */
async function leadSources(req, res) {
  try {
    if ((req.query.from && !validDate(req.query.from)) || (req.query.to && !/^\d{4}-\d{2}-\d{2}$/.test(String(req.query.to)))) return fail(res, 400, 'Dates must be YYYY-MM-DD.');
    const from = req.query.from ? new Date(req.query.from).toISOString() : new Date(Date.now() - 90 * 864e5).toISOString();
    const to = req.query.to ? new Date(`${req.query.to}T23:59:59+05:30`).toISOString() : new Date().toISOString();
    const data = await fetchAll(() => supabaseAdmin.from('leads').select('id, source, source_detail, stage, client_id, lost_reason')
      .gte('created_at', from).lte('created_at', to).order('id'));
    const clientIds = [...new Set((data || []).map((l) => l.client_id).filter(Boolean))];
    const paying = await payingClients(clientIds);
    const rows = {};
    const lost = {};
    (data || []).forEach((l) => {
      const r = rows[l.source] || (rows[l.source] = { source: l.source, leads: 0, contacted: 0, converted: 0, lost: 0, paying: 0 });
      r.leads += 1;
      if (['contacted', 'follow_up', 'converted'].includes(l.stage)) r.contacted += 1;
      if (l.stage === 'converted') r.converted += 1;
      if (l.stage === 'lost') { r.lost += 1; const k = (l.lost_reason || 'No reason given').slice(0, 60); lost[k] = (lost[k] || 0) + 1; }
      if (l.client_id && paying.has(l.client_id)) r.paying += 1;
    });
    return ok(res, {
      from, to,
      sources: Object.values(rows).sort((a, b) => b.leads - a.leads),
      lostReasons: Object.entries(lost).map(([reason, count]) => ({ reason, count })).sort((a, b) => b.count - a.count),
    });
  } catch (e) {
    return handle(res, e, 'load lead sources');
  }
}

/** Public: the website contact form (via the Next /api/contact route). */
async function inboundLead(req, res) {
  const b = req.body || {};
  const name = String(b.name || '').trim().slice(0, 120);
  const email = String(b.email || '').trim().toLowerCase().slice(0, 200);
  const phone = String(b.phone || '').trim().slice(0, 30);
  if (!name || (!email && !phone)) return fail(res, 400, 'Name and an email or phone are needed.');
  if (email && !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) return fail(res, 400, 'That email does not look right.');
  const id = await upsertSourceLead({
    source: 'contact', sourceRef: `contact:${crypto.randomUUID()}`, sourceDetail: b.topic ? String(b.topic).slice(0, 120) : 'Contact form',
    name, email: email || null, phone: phone ? (normalizePhone(phone) || phone) : null,
    meta: { message: String(b.message || '').slice(0, 2000) },
  });
  // A complaint (contact-form topic, or the words in the message) → Respond to it (Operations, Admin told).
  const text = `${b.topic || ''} ${b.message || ''}`;
  if (/complain|complaint|unhappy|disappointed|refund|bad experience|feedback/i.test(text)) {
    try {
      const { teamByName, teamMembers } = require('../utils/people');
      const ops = await teamByName('Operations');
      const { createTask, notify } = require('./tasksController');
      const t = await createTask({
        title: `Respond to a complaint from ${name}`, assignee_type: 'team', assignee_id: ops.id, priority: 'high',
        deadline: new Date(Date.now() + 24 * 3600e3).toISOString(),
        details: `From the contact form${b.topic ? ` (${String(b.topic).slice(0, 80)})` : ''}. Their message is on the lead.`,
        link_type: id ? 'lead' : null, link_id: id || null, link_label: name, auto_key: id ? `complaint:${id}` : null,
      }, { type: 'system' });
      if (t) {
        const { data: admins } = await supabaseAdmin.from('users').select('id').in('role', ['admin', 'superadmin']).eq('is_active', true);
        await notify((admins || []).map((a) => ({ type: 'user', id: a.id })), t, 'status', 'FYI: a complaint came in through the website.', { type: 'system' });
      }
    } catch (e) { console.warn('complaint task not created:', e.message); }
  }
  return ok(res, { saved: Boolean(id) }, 201);
}

/** Which of these clients have a successful payment (in chunks: long .in() lists break the URL). */
async function payingClients(clientIds) {
  const paying = new Set();
  for (let i = 0; i < clientIds.length; i += 150) {
    const rows = await fetchAll(() => supabaseAdmin.from('payments').select('id, client_id').in('client_id', clientIds.slice(i, i + 150)).eq('status', 'success').order('id'));
    rows.forEach((p) => paying.add(p.client_id));
  }
  return paying;
}

module.exports = { listLeads, createLead, updateLead, convertLead, leadSources, inboundLead };

/** Admin: who viewed or changed client, lead and session records (audit_logs, utils/accessLog). */
async function accessLog(req, res) {
  try {
    let q = supabaseAdmin.from('audit_logs')
      .select('id, user_email, user_role, action, resource, resource_id, timestamp')
      .like('action', 'RECORD_%').in('resource', ['client', 'lead', 'session'])
      .order('timestamp', { ascending: false }).limit(300);
    if (['client', 'lead', 'session'].includes(req.query.resource)) q = q.eq('resource', req.query.resource);
    if (req.query.who) q = q.ilike('user_email', `%${String(req.query.who).replace(/[%,()]/g, ' ').slice(0, 80)}%`);
    if (req.query.record) q = q.eq('resource_id', String(req.query.record));
    if (req.query.from) { if (!validDate(req.query.from)) return fail(res, 400, 'Bad date.'); q = q.gte('timestamp', new Date(req.query.from).toISOString()); }
    const { data, error } = await q;
    if (error) return handle(res, error, 'load the access record');
    const rows = data || [];
    // Name each record so the log reads "Demo Operations viewed client Anjali …"
    const ids = (r) => [...new Set(rows.filter((x) => x.resource === r && x.resource_id).map((x) => x.resource_id))];
    const [users, leads, sessions] = await Promise.all([
      ids('client').length ? supabaseAdmin.from('users').select('id, name, email').in('id', ids('client')) : { data: [] },
      ids('lead').length ? supabaseAdmin.from('leads').select('id, name, phone').in('id', ids('lead')) : { data: [] },
      ids('session').length ? supabaseAdmin.from('sessions').select('id, scheduled_date, scheduled_time').in('id', ids('session')) : { data: [] },
    ]);
    const label = new Map([
      ...(users.data || []).map((u) => [`client:${u.id}`, u.name || u.email]),
      ...(leads.data || []).map((l) => [`lead:${l.id}`, l.name || l.phone || 'Lead']),
      ...(sessions.data || []).map((s) => [`session:${s.id}`, `Session ${s.scheduled_date} ${String(s.scheduled_time || '').slice(0, 5)}`]),
    ]);
    return ok(res, {
      entries: rows.map((r) => ({
        ...r,
        verb: String(r.action).replace(/^RECORD_/, '').toLowerCase(),
        record: r.resource_id ? label.get(`${r.resource}:${r.resource_id}`) || (r.resource === 'lead' ? 'Lead (deleted)' : r.resource_id.slice(0, 8)) : '—',
      })),
    });
  } catch (e) {
    return handle(res, e, 'load the access record');
  }
}
module.exports.accessLog = accessLog;

/**
 * Operations: one timeline per client — where they came from (lead + source), every
 * booking/session, payment, and the tasks about them, newest first. Accepts the
 * users.id or the clients.id. No clinical notes: only dates, statuses and amounts.
 */
async function clientTimeline(req, res) {
  try {
    const id = String(req.params.id || '');
    let { data: client } = await supabaseAdmin.from('clients').select('id, user_id, first_name, last_name, email, phone_number, created_at').eq('id', id).maybeSingle();
    if (!client) ({ data: client } = await supabaseAdmin.from('clients').select('id, user_id, first_name, last_name, email, phone_number, created_at').eq('user_id', id).maybeSingle());
    if (!client) return fail(res, 404, 'Client not found.');
    const [leads, sessions, payments] = await Promise.all([
      supabaseAdmin.from('leads').select('id, source, source_detail, stage, created_at, contacted_at, converted_at, lost_reason').eq('client_id', client.id),
      supabaseAdmin.from('sessions').select('id, scheduled_date, scheduled_time, status, session_type, created_at, psychologist:psychologists!sessions_psychologist_id_fkey(first_name, last_name)').eq('client_id', client.id).order('scheduled_date', { ascending: false }).limit(200),
      supabaseAdmin.from('payments').select('id, amount, status, created_at, session_type').eq('client_id', client.id).order('created_at', { ascending: false }).limit(200),
    ]);
    const sessionIds = (sessions.data || []).map((s) => s.id);
    const linkFilters = [`and(link_type.eq.client,link_id.eq.${client.id})`];
    if (sessionIds.length) linkFilters.push(`and(link_type.eq.session,link_id.in.(${sessionIds.slice(0, 150).join(',')}))`);
    const tasks = await supabaseAdmin.from('tasks').select('id, title, status, created_at, completed_at').or(linkFilters.join(',')).neq('status', 'cancelled').limit(200);
    const name = (p) => (Array.isArray(p) ? p[0] : p) ? `${(Array.isArray(p) ? p[0] : p).first_name || ''} ${(Array.isArray(p) ? p[0] : p).last_name || ''}`.trim() : '';
    const ev = [];
    (leads.data || []).forEach((l) => {
      ev.push({ at: l.created_at, kind: 'lead', text: `Arrived as a lead from ${l.source}${l.source_detail ? ` (${l.source_detail})` : ''}` });
      if (l.contacted_at) ev.push({ at: l.contacted_at, kind: 'lead', text: 'Contacted by Operations' });
      if (l.converted_at) ev.push({ at: l.converted_at, kind: 'lead', text: 'Converted to client' });
      if (l.stage === 'lost') ev.push({ at: l.created_at, kind: 'lead', text: `Lead lost: ${l.lost_reason || 'no reason given'}` });
    });
    (sessions.data || []).forEach((s) => ev.push({
      at: s.scheduled_date ? `${s.scheduled_date}T${String(s.scheduled_time || '00:00:00').slice(0, 8)}+05:30` : s.created_at,
      kind: 'session', text: `Session ${String(s.status || '').replace(/_/g, ' ')}${name(s.psychologist) ? ` with ${name(s.psychologist)}` : ''}`,
      detail: `${s.scheduled_date || ''} ${String(s.scheduled_time || '').slice(0, 5)}${s.session_type ? ` · ${s.session_type}` : ''}`, id: s.id,
    }));
    (payments.data || []).forEach((p) => ev.push({ at: p.created_at, kind: 'payment', text: `Payment ${p.status} — ₹${Number(p.amount || 0).toLocaleString('en-IN')}`, detail: p.session_type || '' }));
    (tasks.data || []).forEach((t) => ev.push({ at: t.created_at, kind: 'task', text: `Task: ${t.title}`, detail: t.status.replace('_', ' '), id: t.id }));
    ev.push({ at: client.created_at, kind: 'account', text: 'Client account created' });
    ev.sort((a, b) => new Date(b.at) - new Date(a.at));
    require('../utils/accessLog').logAccess(req, { action: 'viewed', resource: 'client', resourceId: client.user_id || client.id, details: { view: 'timeline' } });
    return ok(res, {
      client: { id: client.id, userId: client.user_id, name: `${client.first_name || ''} ${client.last_name || ''}`.trim() || client.email, email: client.email, phone: client.phone_number },
      events: ev,
      counts: { sessions: (sessions.data || []).length, payments: (payments.data || []).filter((p) => p.status === 'success').length, tasks: (tasks.data || []).length },
    });
  } catch (e) {
    return handle(res, e, 'load the timeline');
  }
}
module.exports.clientTimeline = clientTimeline;

/**
 * Marketing → Event results: per event, registrations, attended, leads that became
 * clients and paying clients (event registrations + the event-tagged leads).
 */
async function eventResults(req, res) {
  try {
    const [regRows, pages, leadRows] = await Promise.all([
      fetchAll(() => supabaseAdmin.from('event_registrations').select('id, event_slug, event_title, attendance_status, metadata, created_at').order('id')),
      supabaseAdmin.from('event_pages').select('slug, title, is_published').limit(1000),
      fetchAll(() => supabaseAdmin.from('leads').select('id, source_ref, source_detail, stage, client_id').eq('source', 'event').order('id')),
    ]);
    const regs = { data: regRows };
    const leads = { data: leadRows };
    const titleOf = new Map((pages.data || []).map((p) => [p.slug, p.title]));
    const leadByReg = new Map((leads.data || []).map((l) => [String(l.source_ref), l]));
    const clientIds = [...new Set((leads.data || []).map((l) => l.client_id).filter(Boolean))];
    const paying = await payingClients(clientIds);
    const rows = {};
    (regs.data || []).forEach((r) => {
      const k = r.event_slug || 'unknown';
      const row = rows[k] || (rows[k] = { slug: k, title: titleOf.get(k) || r.event_title || r.metadata?.event_title || k, registrations: 0, attended: 0, converted: 0, paying: 0, first: r.created_at, last: r.created_at });
      row.registrations += 1;
      if (/attend|present|joined/i.test(r.attendance_status || '')) row.attended += 1;
      const lead = leadByReg.get(String(r.id));
      if (lead?.stage === 'converted') row.converted += 1;
      if (lead?.client_id && paying.has(lead.client_id)) row.paying += 1;
      if (r.created_at < row.first) row.first = r.created_at;
      if (r.created_at > row.last) row.last = r.created_at;
    });
    return ok(res, { events: Object.values(rows).sort((a, b) => new Date(b.last) - new Date(a.last)) });
  } catch (e) {
    return handle(res, e, 'load event results');
  }
}
module.exports.eventResults = eventResults;

/** Operations pressed Call / WhatsApp / Email on a lead: log it, and a New lead becomes Contacted. */
async function logContact(req, res) {
  try {
    const channel = ['call', 'whatsapp', 'email'].includes(req.body.channel) ? req.body.channel : 'call';
    if (!UUID_RE.test(String(req.params.id || ''))) return fail(res, 404, 'Lead not found.');
    const { data: lead, error } = await supabaseAdmin.from('leads').select('*').eq('id', req.params.id).maybeSingle();
    if (error) return handle(res, error, 'log the contact');
    if (!lead) return fail(res, 404, 'Lead not found.');
    const me = personOf(req.user);
    const now = new Date().toISOString();
    const log = Array.isArray(lead.meta?.contacts) ? lead.meta.contacts.slice(-49) : [];
    log.push({ at: now, channel, by: key(me.type, me.id) });
    const patch = { meta: { ...(lead.meta || {}), contacts: log }, updated_at: now };
    if (!lead.contacted_at) patch.contacted_at = now;
    if (lead.stage === 'new') { patch.stage = 'contacted'; patch.stage_changed_at = now; }
    if (!lead.owner_id) { patch.owner_type = me.type; patch.owner_id = me.id; }
    const { data: updated, error: upErr } = await supabaseAdmin.from('leads').update(patch).eq('id', lead.id).select('*').single();
    if (upErr) return handle(res, upErr, 'log the contact');
    await supabaseAdmin.from('tasks').update({ status: 'done', completed_at: now, updated_at: now })
      .eq('auto_key', `lead_call:${lead.id}`).not('status', 'in', '(done,cancelled)');
    const [out] = await withNames([updated]);
    return ok(res, { lead: out });
  } catch (e) {
    return handle(res, e, 'log the contact');
  }
}
module.exports.logContact = logContact;
