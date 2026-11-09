/**
 * Marketing → Blog calendar: planned → drafted → checked by a therapist → published.
 *
 *   planned      a Marketing-team task (template_key 'blog_plan') with the target date
 *   drafted      a blog post in 'draft'
 *   with therapist / checked
 *                a 'blog_review' task given to a therapist about that post — open = with
 *                the therapist, done = checked (the therapist reads it at
 *                /psychologist/blog-review?task=<id>)
 *   published    a published post (published_at)
 */
const { supabaseAdmin } = require('../config/supabase');
const { personOf } = require('../utils/staffRoles');
const { teamByName, isMissingTable, NOT_READY } = require('../utils/people');
const { createTask } = require('./tasksController');

const ok = (res, data, status = 200) => res.status(status).json({ success: true, data });
const fail = (res, status, message) => res.status(status).json({ success: false, message });
const handle = (res, e, what) => {
  if (isMissingTable(e)) return fail(res, 503, NOT_READY);
  console.error(`blog calendar: ${what}:`, e?.message || e);
  return fail(res, 500, `Could not ${what}.`);
};

async function calendar(req, res) {
  try {
    const [blogs, tasks] = await Promise.all([
      supabaseAdmin.from('blogs').select('id, slug, title, status, author_name, created_at, updated_at, published_at').order('updated_at', { ascending: false }).limit(500),
      supabaseAdmin.from('tasks').select('id, title, status, deadline, template_key, link_id, assignee_type, assignee_id, completed_at')
        .in('template_key', ['blog_plan', 'blog_review']).neq('status', 'cancelled').limit(1000),
    ]);
    if (blogs.error) return handle(res, blogs.error, 'load the blog calendar');
    if (tasks.error) return handle(res, tasks.error, 'load the blog calendar');
    const reviews = (tasks.data || []).filter((t) => t.template_key === 'blog_review');
    const psychIds = [...new Set(reviews.filter((t) => t.assignee_type === 'psychologist').map((t) => t.assignee_id))];
    const { data: psychs } = psychIds.length
      ? await supabaseAdmin.from('psychologists').select('id, first_name, last_name').in('id', psychIds) : { data: [] };
    const psychName = new Map((psychs || []).map((p) => [p.id, `${p.first_name || ''} ${p.last_name || ''}`.trim()]));
    const items = [];
    (tasks.data || []).filter((t) => t.template_key === 'blog_plan' && t.status !== 'done').forEach((t) => items.push({
      kind: 'plan', stage: 'planned', id: t.id, title: t.title.replace(/^Planned post:\s*/i, ''), date: t.deadline, taskId: t.id,
    }));
    (blogs.data || []).forEach((b) => {
      const rv = reviews.filter((t) => t.link_id === b.id).sort((x, y) => String(y.completed_at || '').localeCompare(String(x.completed_at || '')));
      const open = rv.find((t) => t.status !== 'done');
      const done = rv.find((t) => t.status === 'done');
      const stage = b.status === 'published' ? 'published' : open ? 'with_therapist' : done ? 'checked' : 'drafted';
      const reviewer = open || done;
      items.push({
        kind: 'post', stage, id: b.id, slug: b.slug, title: b.title, status: b.status,
        date: b.status === 'published' ? (b.published_at || b.updated_at) : (open?.deadline || b.updated_at),
        reviewer: reviewer ? psychName.get(reviewer.assignee_id) || 'Therapist' : null, reviewTaskId: reviewer?.id || null,
      });
    });
    return ok(res, { items });
  } catch (e) {
    return handle(res, e, 'load the blog calendar');
  }
}

async function planPost(req, res) {
  try {
    const title = String(req.body.title || '').trim().slice(0, 200);
    if (!title) return fail(res, 400, 'Give the planned post a title.');
    const date = /^\d{4}-\d{2}-\d{2}$/.test(String(req.body.date || '')) ? req.body.date : null;
    const mkt = await teamByName('Marketing');
    const task = await createTask({
      title: `Planned post: ${title}`, assignee_type: 'team', assignee_id: mkt.id, priority: 'normal',
      deadline: date ? new Date(`${date}T10:00:00+05:30`).toISOString() : null, template_key: 'blog_plan',
      details: req.body.notes ? String(req.body.notes).slice(0, 2000) : null,
      link_type: 'url', link_url: '/marketing/blogs/new', link_label: 'Write the draft',
    }, personOf(req.user));
    return ok(res, { task }, 201);
  } catch (e) {
    return handle(res, e, 'plan the post');
  }
}

async function sendForReview(req, res) {
  try {
    const [t, id] = String(req.body.therapist || '').split(':');
    if (t !== 'psychologist' || !id) return fail(res, 400, 'Pick a therapist.');
    const { data: blog } = await supabaseAdmin.from('blogs').select('id, title, slug, status').eq('id', req.body.blog_id).maybeSingle();
    if (!blog) return fail(res, 404, 'Blog post not found.');
    const task = await createTask({
      title: `Check this blog post for clinical accuracy: "${blog.title}"`, assignee_type: 'psychologist', assignee_id: id,
      priority: 'normal', deadline: new Date(Date.now() + 5 * 864e5).toISOString(), template_key: 'blog_review',
      details: 'Read the post and add a comment with anything that is clinically wrong or unclear, then mark the task done.',
      link_type: 'blog', link_id: blog.id, link_label: blog.title,
    }, personOf(req.user));
    return ok(res, { task }, 201);
  } catch (e) {
    return handle(res, e, 'send the post for a check');
  }
}

/** The therapist reads the post they were asked to check (only with a review task for it). */
async function reviewPreview(req, res) {
  try {
    const me = personOf(req.user);
    const { data: task } = await supabaseAdmin.from('tasks').select('id, link_id, assignee_type, assignee_id, template_key, status')
      .eq('id', req.params.taskId).maybeSingle();
    const allowed = task && task.template_key === 'blog_review'
      && ((task.assignee_type === me.type && task.assignee_id === me.id) || ['admin', 'superadmin', 'marketing'].includes(req.user.role));
    if (!allowed) return fail(res, 404, 'Not found.');
    const { data: blog } = await supabaseAdmin.from('blogs').select('id, title, excerpt, content, featured_image_url, updated_at, status').eq('id', task.link_id).maybeSingle();
    if (!blog) return fail(res, 404, 'The post was removed.');
    return ok(res, { blog, task: { id: task.id, status: task.status } });
  } catch (e) {
    return handle(res, e, 'open the post');
  }
}

module.exports = { calendar, planPost, sendForReview, reviewPreview };
