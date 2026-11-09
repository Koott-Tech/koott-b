/**
 * HR extras (migration 0022): a document store with expiry dates, and the urgent
 * safety path to the clinical lead.
 *
 * Documents: licences, ID, contracts and agreements per person, files in the private
 * bucket "staff-documents" (opened through a 5-minute link). The person can see and
 * upload their own; HR and Admin see everyone's. 30 days before an expiry date the
 * automatic tasks give HR and the person "Renew the document".
 *
 * Safety alerts: a therapist's urgent concern about a client's safety. It never goes
 * into the task queue — it is emailed at once to the named clinical lead (Admin sets
 * who, under Settings) and shown on Admin's Safety alerts page until acknowledged.
 * Wording of the in-app guidance is a placeholder until the clinical lead approves it.
 */
const crypto = require('crypto');
const { supabaseAdmin } = require('../config/supabase');
const { isAdmin, personOf } = require('../utils/staffRoles');
const { key, namesFor, isMissingTable } = require('../utils/people');

const NOT_READY = 'Documents and safety alerts need backend/supabase/RUN_PENDING_0022.sql to be run in Supabase.';
const ok = (res, data, status = 200) => res.status(status).json({ success: true, data });
const fail = (res, status, message) => res.status(status).json({ success: false, message });
const handle = (res, e, what) => {
  if (isMissingTable(e)) return fail(res, 503, NOT_READY);
  console.error(`hr extras: ${what}:`, e?.message || e);
  return fail(res, 500, `Could not ${what}.`);
};
const KINDS = ['licence', 'id_proof', 'contract', 'agreement', 'certificate', 'other'];
const BUCKET = 'staff-documents';
const canManage = (user) => isAdmin(user) || user?.role === 'hr';
const cleanName = (n) => String(n || 'file').replace(/[^\w.\- ]+/g, '_').slice(0, 120);

/* ------------------------------------------------------------------ documents */

async function listDocuments(req, res) {
  try {
    const me = personOf(req.user);
    let q = supabaseAdmin.from('staff_documents').select('*').order('expires_on', { ascending: true, nullsFirst: false }).limit(1000);
    if (!canManage(req.user)) q = q.eq('person_type', me.type).eq('person_id', me.id);
    else if (req.query.person) { const [t, id] = String(req.query.person).split(':'); q = q.eq('person_type', t).eq('person_id', id); }
    const { data, error } = await q;
    if (error) return handle(res, error, 'load documents');
    const names = await namesFor((data || []).map((d) => ({ type: d.person_type, id: d.person_id })));
    const today = new Date(Date.now() + 330 * 60000).toISOString().slice(0, 10);
    const soon = new Date(Date.now() + (330 * 60000) + 30 * 864e5).toISOString().slice(0, 10);
    return ok(res, {
      documents: (data || []).map((d) => ({
        ...d, personName: names[key(d.person_type, d.person_id)]?.name || 'Unknown',
        expiry: !d.expires_on ? 'none' : d.expires_on < today ? 'expired' : d.expires_on <= soon ? 'soon' : 'ok',
      })),
      kinds: KINDS,
    });
  } catch (e) {
    return handle(res, e, 'load documents');
  }
}

async function uploadDocument(req, res) {
  try {
    const me = personOf(req.user);
    const b = req.body || {};
    let person = me;
    if (b.person && canManage(req.user)) { const [t, id] = String(b.person).split(':'); if (['user', 'psychologist'].includes(t) && id) person = { type: t, id }; }
    const title = String(b.title || '').trim().slice(0, 150);
    if (!title) return fail(res, 400, 'Give the document a name.');
    const kind = KINDS.includes(b.kind) ? b.kind : 'other';
    const expires = /^\d{4}-\d{2}-\d{2}$/.test(String(b.expires_on || '')) ? b.expires_on : null;
    let filePath = null;
    if (req.file) {
      filePath = `${person.type}-${person.id}/${crypto.randomUUID().slice(0, 8)}__${cleanName(req.file.originalname)}`;
      const put = () => supabaseAdmin.storage.from(BUCKET).upload(filePath, req.file.buffer, { contentType: req.file.mimetype, upsert: false });
      let { error } = await put();
      if (error && /not found/i.test(error.message || '')) {
        await supabaseAdmin.storage.createBucket(BUCKET, { public: false, fileSizeLimit: 15 * 1024 * 1024 }).catch(() => {});
        ({ error } = await put());
      }
      if (error) return handle(res, error, 'upload the file');
    }
    const { data, error } = await supabaseAdmin.from('staff_documents').insert({
      person_type: person.type, person_id: person.id, kind, title, file_path: filePath,
      file_name: req.file ? cleanName(req.file.originalname) : null, expires_on: expires, uploaded_by: req.user.id,
    }).select('*').single();
    if (error) return handle(res, error, 'save the document');
    return ok(res, { document: data }, 201);
  } catch (e) {
    return handle(res, e, 'save the document');
  }
}

async function getDoc(req) {
  const { data } = await supabaseAdmin.from('staff_documents').select('*').eq('id', req.params.id).maybeSingle();
  if (!data) return null;
  const me = personOf(req.user);
  if (canManage(req.user) || (data.person_type === me.type && data.person_id === me.id)) return data;
  return null;
}

async function openDocument(req, res) {
  try {
    const doc = await getDoc(req);
    if (!doc || !doc.file_path) return fail(res, 404, 'Document not found.');
    const { data, error } = await supabaseAdmin.storage.from(BUCKET).createSignedUrl(doc.file_path, 300);
    if (error || !data?.signedUrl) return fail(res, 404, 'File not found.');
    return ok(res, { url: data.signedUrl });
  } catch (e) {
    return handle(res, e, 'open the document');
  }
}

async function updateDocument(req, res) {
  try {
    const doc = await getDoc(req);
    if (!doc) return fail(res, 404, 'Document not found.');
    const patch = { updated_at: new Date().toISOString() };
    if (req.body.title !== undefined) patch.title = String(req.body.title || '').trim().slice(0, 150) || doc.title;
    if (req.body.kind !== undefined && KINDS.includes(req.body.kind)) patch.kind = req.body.kind;
    if (req.body.expires_on !== undefined) patch.expires_on = /^\d{4}-\d{2}-\d{2}$/.test(String(req.body.expires_on || '')) ? req.body.expires_on : null;
    const { data, error } = await supabaseAdmin.from('staff_documents').update(patch).eq('id', doc.id).select('*').single();
    if (error) return handle(res, error, 'update the document');
    return ok(res, { document: data });
  } catch (e) {
    return handle(res, e, 'update the document');
  }
}

async function deleteDocument(req, res) {
  try {
    const doc = await getDoc(req);
    if (!doc) return fail(res, 404, 'Document not found.');
    if (!canManage(req.user)) return fail(res, 403, 'Ask HR to remove a document.');
    if (doc.file_path) await supabaseAdmin.storage.from(BUCKET).remove([doc.file_path]);
    await supabaseAdmin.from('staff_documents').delete().eq('id', doc.id);
    return ok(res, { deleted: true });
  } catch (e) {
    return handle(res, e, 'delete the document');
  }
}

/* --------------------------------------------------------------- safety path */

async function getSetting(k) {
  // Retried once: a network blip here would send an urgent alert as if no clinical lead were set.
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const { data, error } = await supabaseAdmin.from('app_settings').select('value').eq('key', k).maybeSingle();
    if (!error) return data?.value ?? null;
    if (attempt === 0) await new Promise((r) => setTimeout(r, 400));
    else console.error(`settings: could not read ${k}:`, error.message);
  }
  return null;
}

async function clinicalLead(req, res) {
  try {
    const value = await getSetting('clinical_lead');
    if (!value) return ok(res, { lead: null });
    const names = await namesFor([{ type: value.type, id: value.id }]);
    return ok(res, { lead: { ...value, key: key(value.type, value.id), name: names[key(value.type, value.id)]?.name || value.name || null } });
  } catch (e) {
    return handle(res, e, 'load the clinical lead');
  }
}

async function setClinicalLead(req, res) {
  try {
    if (!isAdmin(req.user)) return fail(res, 403, 'Admin only.');
    const [t, id] = String(req.body.person || '').split(':');
    if (!['user', 'psychologist'].includes(t) || !id) return fail(res, 400, 'Pick a person.');
    const table = t === 'user' ? 'users' : 'psychologists';
    const { data: p } = await supabaseAdmin.from(table).select('email').eq('id', id).maybeSingle();
    if (!p) return fail(res, 404, 'Person not found.');
    const backupEmail = req.body.backup_email ? String(req.body.backup_email).trim().slice(0, 200) : null;
    const phone = req.body.phone ? String(req.body.phone).trim().slice(0, 30) : null;
    const value = { type: t, id, email: p.email, backupEmail, phone };
    const { error } = await supabaseAdmin.from('app_settings').upsert({ key: 'clinical_lead', value, updated_by: req.user.id, updated_at: new Date().toISOString() });
    if (error) return handle(res, error, 'save the clinical lead');
    return ok(res, { lead: value });
  } catch (e) {
    return handle(res, e, 'save the clinical lead');
  }
}

async function raiseAlert(req, res) {
  try {
    const me = personOf(req.user);
    const summary = String(req.body.summary || '').trim().slice(0, 1500);
    if (!summary) return fail(res, 400, 'Say briefly what is happening.');
    const clientId = req.body.client_id || null;
    const clientRef = clientId ? `K-${String(clientId).replace(/-/g, '').slice(0, 6).toUpperCase()}` : null;
    const { data: alert, error } = await supabaseAdmin.from('safety_alerts').insert({
      raised_by_type: me.type, raised_by_id: me.id, client_id: clientId, client_ref: clientRef, summary,
      contact_now: req.body.contact_now ? String(req.body.contact_now).slice(0, 120) : null,
    }).select('*').single();
    if (error) return handle(res, error, 'send the alert');
    const lead = await getSetting('clinical_lead');
    const names = await namesFor([{ type: me.type, id: me.id }]);
    const from = names[key(me.type, me.id)]?.name || req.user.email;
    // Demo accounts (…@demo.koott.invalid) are for testing: never wake a real person up.
    const demo = /\.invalid$/i.test(req.user.email || '');
    const to = demo ? [] : [lead?.email, lead?.backupEmail, process.env.PAYMENT_ALERT_EMAIL || process.env.COMPANY_ADMIN_EMAIL]
      .filter((e) => e && !/\.invalid$/i.test(e));
    const site = (process.env.FRONTEND_URL || 'https://www.koott.in').replace(/\/$/, '');
    if (to.length) {
      const emailService = require('../utils/emailService');
      await Promise.all([...new Set(to)].map((addr) => emailService.sendEmail({
        to: addr,
        subject: `URGENT safety concern from ${from}`,
        html: `<p><strong>${from}</strong> raised an urgent safety concern${clientRef ? ` about client ${clientRef}` : ''}.</p>
<p style="white-space:pre-wrap">${summary.replace(/</g, '&lt;')}</p>
${alert.contact_now ? `<p>Reach them now: <strong>${String(alert.contact_now).replace(/</g, '&lt;')}</strong></p>` : ''}
<p><a href="${site}/admin/safety">Open the alert</a> and acknowledge it so they know you have it.</p>`,
      }).catch((e) => console.error('safety alert email failed:', e.message))));
    }
    // WhatsApp to the lead too, once a template is approved (INTERAKT_TPL_SAFETY_ALERT: {{1}} = who, {{2}} = client ref)
    if (!demo && lead?.phone && process.env.INTERAKT_TPL_SAFETY_ALERT) {
      require('../utils/interaktService').sendTemplateMessage(lead.phone, process.env.INTERAKT_TPL_SAFETY_ALERT,
        process.env.INTERAKT_TPL_SAFETY_ALERT_LANG || 'en', { bodyValues: [from, clientRef || 'not given'] }).catch(() => {});
    }
    console.warn(`🚨 SAFETY ALERT ${alert.id} raised by ${me.type}:${me.id}${lead ? '' : ' — NO CLINICAL LEAD SET'}`);
    return ok(res, { alert, leadSet: Boolean(lead), emailed: to.length }, 201);
  } catch (e) {
    return handle(res, e, 'send the alert');
  }
}

async function listAlerts(req, res) {
  try {
    const me = personOf(req.user);
    const lead = await getSetting('clinical_lead');
    const isLead = lead && lead.type === me.type && lead.id === me.id;
    let q = supabaseAdmin.from('safety_alerts').select('*').order('created_at', { ascending: false }).limit(200);
    if (!isAdmin(req.user) && !isLead) q = q.eq('raised_by_type', me.type).eq('raised_by_id', me.id);
    const { data, error } = await q;
    if (error) return handle(res, error, 'load alerts');
    const names = await namesFor((data || []).flatMap((a) => [{ type: a.raised_by_type, id: a.raised_by_id }]));
    return ok(res, {
      alerts: (data || []).map((a) => ({ ...a, raisedBy: names[key(a.raised_by_type, a.raised_by_id)]?.name || 'Unknown' })),
      canAct: isAdmin(req.user) || Boolean(isLead),
    });
  } catch (e) {
    return handle(res, e, 'load alerts');
  }
}

async function updateAlert(req, res) {
  try {
    const me = personOf(req.user);
    const lead = await getSetting('clinical_lead');
    const isLead = lead && lead.type === me.type && lead.id === me.id;
    if (!isAdmin(req.user) && !isLead) return fail(res, 403, 'Only the clinical lead or Admin.');
    const patch = { updated_at: new Date().toISOString() };
    if (req.body.status === 'acknowledged') { patch.status = 'acknowledged'; patch.acknowledged_by = req.user.id; patch.acknowledged_at = patch.updated_at; }
    if (req.body.status === 'closed') { patch.status = 'closed'; patch.closed_note = req.body.note ? String(req.body.note).slice(0, 1000) : null; }
    const { data, error } = await supabaseAdmin.from('safety_alerts').update(patch).eq('id', req.params.id).select('*').single();
    if (error) return handle(res, error, 'update the alert');
    if (patch.status === 'acknowledged') {
      // Tell the therapist someone has it (dashboard notification, not a task).
      await supabaseAdmin.from('task_notifications').insert({
        recipient_type: data.raised_by_type, recipient_id: data.raised_by_id, task_id: null, kind: 'status',
        message: 'Your urgent safety concern was acknowledged by the clinical lead.',
      }).then(() => {}, () => {});
    }
    return ok(res, { alert: data });
  } catch (e) {
    return handle(res, e, 'update the alert');
  }
}

module.exports = {
  listDocuments, uploadDocument, openDocument, updateDocument, deleteDocument,
  clinicalLead, setClinicalLead, raiseAlert, listAlerts, updateAlert, getSetting,
};
