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
const { personOf } = require('../utils/staffRoles');
const { key, namesFor, isMissingTable, NOT_READY } = require('../utils/people');
const { STAGES, SOURCES, upsertSourceLead } = require('../utils/leads');
const { normalizePhone } = require('../utils/phoneVerification');

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
    const [{ data, error }, counts] = await Promise.all([q, supabaseAdmin.from('leads').select('stage, source').limit(20000)]);
    if (error) return handle(res, error, 'load leads');
    const byStage = Object.fromEntries(STAGES.map((s) => [s, 0]));
    const bySource = {};
    (counts.data || []).forEach((r) => { byStage[r.stage] = (byStage[r.stage] || 0) + 1; bySource[r.source] = (bySource[r.source] || 0) + 1; });
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
    const [lead] = await withNames([data]);
    return ok(res, { lead }, 201);
  } catch (e) {
    return handle(res, e, 'add the lead');
  }
}

async function updateLead(req, res) {
  try {
    const b = req.body || {};
    const { data: lead, error } = await supabaseAdmin.from('leads').select('*').eq('id', req.params.id).maybeSingle();
    if (error) return handle(res, error, 'update the lead');
    if (!lead) return fail(res, 404, 'Lead not found.');
    const now = new Date().toISOString();
    const patch = { updated_at: now };
    ['name', 'email', 'notes', 'source_detail'].forEach((f) => { if (b[f] !== undefined) patch[f] = b[f] ? String(b[f]).slice(0, f === 'notes' ? 5000 : 200) : null; });
    if (b.phone !== undefined) patch.phone = b.phone ? (normalizePhone(b.phone) || String(b.phone).trim()) : null;
    if (b.next_follow_up_at !== undefined) patch.next_follow_up_at = b.next_follow_up_at ? new Date(b.next_follow_up_at).toISOString() : null;
    if (b.owner !== undefined) {
      if (b.owner === null || b.owner === '') { patch.owner_type = null; patch.owner_id = null; } else {
        const [t, id] = String(b.owner).split(':');
        if (!['user', 'psychologist'].includes(t) || !id) return fail(res, 400, 'Unknown owner.');
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
    const { data: lead, error } = await supabaseAdmin.from('leads').select('*').eq('id', req.params.id).maybeSingle();
    if (error) return handle(res, error, 'convert the lead');
    if (!lead) return fail(res, 404, 'Lead not found.');
    if (lead.stage === 'converted' && lead.client_id) return fail(res, 400, 'This lead is already a client.');

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
    const from = req.query.from ? new Date(req.query.from).toISOString() : new Date(Date.now() - 90 * 864e5).toISOString();
    const to = req.query.to ? new Date(`${req.query.to}T23:59:59`).toISOString() : new Date().toISOString();
    const { data, error } = await supabaseAdmin.from('leads').select('source, source_detail, stage, client_id, lost_reason')
      .gte('created_at', from).lte('created_at', to).limit(20000);
    if (error) return handle(res, error, 'load lead sources');
    const clientIds = [...new Set((data || []).map((l) => l.client_id).filter(Boolean))];
    let paying = new Set();
    if (clientIds.length) {
      const { data: pays } = await supabaseAdmin.from('payments').select('client_id').in('client_id', clientIds.slice(0, 1000)).eq('status', 'success');
      paying = new Set((pays || []).map((p) => p.client_id));
    }
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
  return ok(res, { saved: Boolean(id) }, 201);
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
    if (req.query.from) q = q.gte('timestamp', new Date(req.query.from).toISOString());
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
