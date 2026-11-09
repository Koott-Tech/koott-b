/**
 * Job applications (table job_applications, migration 0021).
 * The careers pages post here; HR sees them in Job postings → Applications and moves
 * them through applied → interview → offer → hired | rejected. Each new application
 * creates a "Review the application" task for the HR team.
 */
const { supabaseAdmin } = require('../config/supabase');
const { isMissingTable, NOT_READY, teamByName } = require('../utils/people');

const STAGES = ['applied', 'interview', 'offer', 'hired', 'rejected'];
const ok = (res, data, status = 200) => res.status(status).json({ success: true, data });
const fail = (res, status, message) => res.status(status).json({ success: false, message });
const handle = (res, e, what) => {
  if (isMissingTable(e)) return fail(res, 503, NOT_READY);
  console.error(`applications: ${what}:`, e?.message || e);
  return fail(res, 500, `Could not ${what}.`);
};
const url = (v) => {
  const s = String(v || '').trim();
  return /^https?:\/\/\S+$/i.test(s) ? s.slice(0, 500) : null;
};

async function apply(req, res) {
  try {
    const b = req.body || {};
    const name = String(b.name || '').trim().slice(0, 120);
    const email = String(b.email || '').trim().toLowerCase().slice(0, 200);
    if (!name || !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) return fail(res, 400, 'Your name and a valid email are needed.');
    const { data: career } = await supabaseAdmin.from('careers').select('id, title, status').eq('slug', req.params.slug).maybeSingle();
    if (!career) return fail(res, 404, 'That job is not open.');
    const { data, error } = await supabaseAdmin.from('job_applications').insert({
      career_id: career.id, career_title: career.title, name, email,
      phone: b.phone ? String(b.phone).slice(0, 30) : null,
      resume_url: url(b.resume_url), linkedin_url: url(b.linkedin_url),
      cover_note: b.cover_note ? String(b.cover_note).slice(0, 4000) : null,
    }).select('id').single();
    if (error) return handle(res, error, 'send your application');
    try {
      const hr = await teamByName('HR');
      await require('./tasksController').createTask({
        title: `Review the application: ${name} — ${career.title}`, assignee_type: 'team', assignee_id: hr.id,
        priority: 'normal', deadline: new Date(Date.now() + 3 * 864e5).toISOString(),
        link_type: 'application', link_id: data.id, link_label: `${name} (${career.title})`, auto_key: `application:${data.id}`,
      }, { type: 'system' });
    } catch (e) { console.warn('applications: review task not created:', e.message); }
    return ok(res, { received: true }, 201);
  } catch (e) {
    return handle(res, e, 'send your application');
  }
}

async function list(req, res) {
  try {
    let q = supabaseAdmin.from('job_applications').select('*').order('created_at', { ascending: false }).limit(500);
    if (STAGES.includes(req.query.stage)) q = q.eq('stage', req.query.stage);
    if (req.query.career_id) q = q.eq('career_id', req.query.career_id);
    const { data, error } = await q;
    if (error) return handle(res, error, 'load applications');
    return ok(res, { applications: data || [], stages: STAGES });
  } catch (e) {
    return handle(res, e, 'load applications');
  }
}

async function update(req, res) {
  try {
    const patch = { updated_at: new Date().toISOString() };
    if (req.body.stage !== undefined) {
      if (!STAGES.includes(req.body.stage)) return fail(res, 400, 'Unknown stage.');
      patch.stage = req.body.stage;
    }
    if (req.body.notes !== undefined) patch.notes = req.body.notes ? String(req.body.notes).slice(0, 4000) : null;
    const { data, error } = await supabaseAdmin.from('job_applications').update(patch).eq('id', req.params.id).select('*').single();
    if (error) return handle(res, error, 'update the application');
    if (patch.stage && patch.stage !== 'applied') {
      await supabaseAdmin.from('tasks').update({ status: 'done', completed_at: patch.updated_at, updated_at: patch.updated_at })
        .eq('auto_key', `application:${data.id}`).not('status', 'in', '(done,cancelled)');
    }
    return ok(res, { application: data });
  } catch (e) {
    return handle(res, e, 'update the application');
  }
}

module.exports = { apply, list, update };
