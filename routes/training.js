/**
 * /api/training — the training module (migration 0022, tables training_*).
 *   Everyone who works at Koott: GET / (their published courses + progress),
 *     POST /lessons/:id/complete, DELETE /lessons/:id/complete.
 *   HR / Admin: manage courses and lessons, GET /progress (who finished what).
 * A published required course gives each person in its audience a task to finish it.
 */
const express = require('express');
const router = express.Router();
const { authenticateToken } = require('../middleware/auth');
const { requireStaffMember, allowRoles, isAdmin, personOf } = require('../utils/staffRoles');
const { supabaseAdmin } = require('../config/supabase');
const { key, listPeople, isMissingTable } = require('../utils/people');

const NOT_READY = 'Training needs backend/supabase/RUN_PENDING_0022.sql to be run in Supabase.';
const ok = (res, data, status = 200) => res.status(status).json({ success: true, data });
const fail = (res, status, message) => res.status(status).json({ success: false, message });
const handle = (res, e, what) => {
  if (isMissingTable(e)) return fail(res, 503, NOT_READY);
  console.error(`training: ${what}:`, e?.message || e);
  return fail(res, 500, `Could not ${what}.`);
};
const audienceOf = (user) => (user.role === 'psychologist' ? 'therapists' : 'staff');
const canManage = (user) => isAdmin(user) || user.role === 'hr';
const url = (v) => { const s = String(v || '').trim(); return /^https?:\/\/\S+$/i.test(s) ? s.slice(0, 500) : null; };

router.use(authenticateToken, requireStaffMember);

router.get('/', async (req, res) => {
  try {
    const me = personOf(req.user);
    let q = supabaseAdmin.from('training_courses').select('*').order('created_at');
    if (!canManage(req.user) || req.query.mine === '1') q = q.eq('is_published', true).in('audience', [audienceOf(req.user), 'all']);
    const { data: courses, error } = await q;
    if (error) return handle(res, error, 'load training');
    const ids = (courses || []).map((c) => c.id);
    const [lessons, progress] = await Promise.all([
      ids.length ? supabaseAdmin.from('training_lessons').select('*').in('course_id', ids).order('position') : { data: [] },
      supabaseAdmin.from('training_progress').select('lesson_id, completed_at').eq('person_type', me.type).eq('person_id', me.id),
    ]);
    const done = new Map((progress.data || []).map((p) => [p.lesson_id, p.completed_at]));
    return ok(res, {
      courses: (courses || []).map((c) => {
        const ls = (lessons.data || []).filter((l) => l.course_id === c.id).map((l) => ({ ...l, completedAt: done.get(l.id) || null }));
        return { ...c, lessons: ls, done: ls.filter((l) => l.completedAt).length, total: ls.length };
      }),
      canManage: canManage(req.user),
    });
  } catch (e) {
    return handle(res, e, 'load training');
  }
});

router.post('/lessons/:id/complete', async (req, res) => {
  try {
    const me = personOf(req.user);
    const { error } = await supabaseAdmin.from('training_progress')
      .upsert({ person_type: me.type, person_id: me.id, lesson_id: req.params.id }, { onConflict: 'person_type,person_id,lesson_id', ignoreDuplicates: true });
    if (error) return handle(res, error, 'save progress');
    // Finishing every lesson of a course closes its "finish the training" task.
    const { data: lesson } = await supabaseAdmin.from('training_lessons').select('course_id').eq('id', req.params.id).maybeSingle();
    if (lesson) {
      const [{ data: all }, { data: mine }] = await Promise.all([
        supabaseAdmin.from('training_lessons').select('id').eq('course_id', lesson.course_id),
        supabaseAdmin.from('training_progress').select('lesson_id').eq('person_type', me.type).eq('person_id', me.id),
      ]);
      const doneIds = new Set((mine || []).map((m) => m.lesson_id));
      if ((all || []).every((l) => doneIds.has(l.id))) {
        const now = new Date().toISOString();
        await supabaseAdmin.from('tasks').update({ status: 'done', completed_at: now, updated_at: now })
          .eq('auto_key', `training:${lesson.course_id}:${key(me.type, me.id)}`).not('status', 'in', '(done,cancelled)');
      }
    }
    return ok(res, { completed: true });
  } catch (e) {
    return handle(res, e, 'save progress');
  }
});

router.delete('/lessons/:id/complete', async (req, res) => {
  try {
    const me = personOf(req.user);
    await supabaseAdmin.from('training_progress').delete().eq('person_type', me.type).eq('person_id', me.id).eq('lesson_id', req.params.id);
    return ok(res, { completed: false });
  } catch (e) {
    return handle(res, e, 'save progress');
  }
});

/* ------------------------------------------------------------- HR / Admin */
const manage = allowRoles('hr');

async function assignRequired(course, by) {
  if (!course.is_published || !course.required) return 0;
  const people = (await listPeople({ includeInactive: false })).filter((p) => p.role !== 'superadmin'
    && (course.audience === 'all' || (course.audience === 'therapists' ? p.type === 'psychologist' : p.type === 'user')));
  const { createTask } = require('../controllers/tasksController');
  let n = 0;
  for (const p of people) {
    const t = await createTask({
      title: `Finish the training: ${course.title}`, assignee_type: p.type, assignee_id: p.id, priority: 'normal',
      deadline: new Date(Date.now() + 14 * 864e5).toISOString(),
      link_type: 'url', link_url: p.type === 'psychologist' ? '/psychologist/training' : '/staff/training', link_label: course.title,
      auto_key: `training:${course.id}:${key(p.type, p.id)}`,
    }, by);
    if (t) n += 1;
  }
  return n;
}

router.post('/courses', manage, async (req, res) => {
  try {
    const b = req.body || {};
    const title = String(b.title || '').trim().slice(0, 200);
    if (!title) return fail(res, 400, 'Give the course a title.');
    const { data, error } = await supabaseAdmin.from('training_courses').insert({
      title, description: b.description ? String(b.description).slice(0, 2000) : null,
      audience: ['therapists', 'staff', 'all'].includes(b.audience) ? b.audience : 'therapists',
      required: Boolean(b.required), is_published: false, created_by: req.user.id,
    }).select('*').single();
    if (error) return handle(res, error, 'create the course');
    return ok(res, { course: data }, 201);
  } catch (e) {
    return handle(res, e, 'create the course');
  }
});

router.patch('/courses/:id', manage, async (req, res) => {
  try {
    const b = req.body || {};
    const patch = { updated_at: new Date().toISOString() };
    if (b.title !== undefined) patch.title = String(b.title).trim().slice(0, 200);
    if (b.description !== undefined) patch.description = b.description ? String(b.description).slice(0, 2000) : null;
    if (b.audience !== undefined && ['therapists', 'staff', 'all'].includes(b.audience)) patch.audience = b.audience;
    if (b.required !== undefined) patch.required = Boolean(b.required);
    if (b.is_published !== undefined) patch.is_published = Boolean(b.is_published);
    const { data, error } = await supabaseAdmin.from('training_courses').update(patch).eq('id', req.params.id).select('*').single();
    if (error) return handle(res, error, 'update the course');
    const assigned = await assignRequired(data, personOf(req.user));
    return ok(res, { course: data, assigned });
  } catch (e) {
    return handle(res, e, 'update the course');
  }
});

router.delete('/courses/:id', manage, async (req, res) => {
  try {
    const { error } = await supabaseAdmin.from('training_courses').delete().eq('id', req.params.id);
    if (error) return handle(res, error, 'delete the course');
    return ok(res, { deleted: true });
  } catch (e) {
    return handle(res, e, 'delete the course');
  }
});

router.post('/courses/:id/lessons', manage, async (req, res) => {
  try {
    const b = req.body || {};
    const title = String(b.title || '').trim().slice(0, 200);
    if (!title) return fail(res, 400, 'Give the lesson a title.');
    const { count } = await supabaseAdmin.from('training_lessons').select('id', { count: 'exact', head: true }).eq('course_id', req.params.id);
    const { data, error } = await supabaseAdmin.from('training_lessons').insert({
      course_id: req.params.id, position: Number(count) || 0, title,
      body: b.body ? String(b.body).slice(0, 20000) : null, video_url: url(b.video_url), resource_url: url(b.resource_url),
    }).select('*').single();
    if (error) return handle(res, error, 'add the lesson');
    return ok(res, { lesson: data }, 201);
  } catch (e) {
    return handle(res, e, 'add the lesson');
  }
});

router.patch('/lessons/:id', manage, async (req, res) => {
  try {
    const b = req.body || {};
    const patch = { updated_at: new Date().toISOString() };
    if (b.title !== undefined) patch.title = String(b.title).trim().slice(0, 200);
    if (b.body !== undefined) patch.body = b.body ? String(b.body).slice(0, 20000) : null;
    if (b.video_url !== undefined) patch.video_url = url(b.video_url);
    if (b.resource_url !== undefined) patch.resource_url = url(b.resource_url);
    if (b.position !== undefined) patch.position = Number(b.position) || 0;
    const { data, error } = await supabaseAdmin.from('training_lessons').update(patch).eq('id', req.params.id).select('*').single();
    if (error) return handle(res, error, 'update the lesson');
    return ok(res, { lesson: data });
  } catch (e) {
    return handle(res, e, 'update the lesson');
  }
});

router.delete('/lessons/:id', manage, async (req, res) => {
  try {
    const { error } = await supabaseAdmin.from('training_lessons').delete().eq('id', req.params.id);
    if (error) return handle(res, error, 'delete the lesson');
    return ok(res, { deleted: true });
  } catch (e) {
    return handle(res, e, 'delete the lesson');
  }
});

router.get('/progress', manage, async (req, res) => {
  try {
    const [courses, lessons, progress, people] = await Promise.all([
      supabaseAdmin.from('training_courses').select('id, title, audience, is_published, required').eq('is_published', true),
      supabaseAdmin.from('training_lessons').select('id, course_id'),
      supabaseAdmin.from('training_progress').select('person_type, person_id, lesson_id, completed_at'),
      listPeople({ includeInactive: false }),
    ]);
    if (courses.error) return handle(res, courses.error, 'load progress');
    const lessonCourse = new Map((lessons.data || []).map((l) => [l.id, l.course_id]));
    const totals = {};
    (lessons.data || []).forEach((l) => { totals[l.course_id] = (totals[l.course_id] || 0) + 1; });
    const done = {};
    (progress.data || []).forEach((p) => {
      const c = lessonCourse.get(p.lesson_id); if (!c) return;
      const k = `${key(p.person_type, p.person_id)}|${c}`;
      done[k] = (done[k] || 0) + 1;
    });
    const rows = people.filter((p) => p.role !== 'superadmin').map((p) => ({
      key: p.key, name: p.name, roleLabel: p.roleLabel,
      courses: (courses.data || []).filter((c) => c.audience === 'all' || (c.audience === 'therapists' ? p.type === 'psychologist' : p.type === 'user'))
        .map((c) => ({ id: c.id, done: done[`${p.key}|${c.id}`] || 0, total: totals[c.id] || 0 })),
    })).filter((r) => r.courses.length);
    return ok(res, { courses: courses.data || [], people: rows });
  } catch (e) {
    return handle(res, e, 'load progress');
  }
});

module.exports = router;
