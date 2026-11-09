/**
 * Tasks — "Koott dashboards and tasks plan", the Notion way.
 *
 * Anyone who works at Koott (staff roles and therapists) can give a task to any person
 * or any team. A task is seen by the person who gave it, the person (or team) it was
 * given to, whoever picked a team task up, and Admin — nobody else.
 *
 * Status flow: todo → in_progress → waiting → done; cancelled = archived, never deleted.
 * Every change is written to task_events (history); comments can @mention people and
 * teams; the people concerned get a notification in their dashboard (and an email).
 */
const { supabaseAdmin } = require('../config/supabase');
const { isAdmin, personOf } = require('../utils/staffRoles');
const { key, namesFor, teamIdsOf, teamMembers, listPeople, teamByName, isMissingTable, NOT_READY } = require('../utils/people');

const STATUSES = ['todo', 'in_progress', 'waiting', 'done', 'cancelled'];
const PRIORITIES = ['urgent', 'high', 'normal', 'low'];
const PERSON_TYPES = ['user', 'psychologist'];
const ASSIGNEE_TYPES = [...PERSON_TYPES, 'team'];
const LINK_TYPES = ['session', 'client', 'lead', 'therapist', 'blog', 'page', 'booking', 'payout', 'application', 'person', 'url'];

/** Ready-made checklists, created in one click. */
const TEMPLATES = {
  therapist_onboarding: {
    title: 'New therapist onboarding', priority: 'high',
    steps: ['Create the therapist login', 'Upload licence and ID', 'Sign the therapist agreement', 'Write profile and bio',
      'Add profile photo', 'Set session pricing', 'Set working hours / availability', 'Connect Google Calendar',
      'Add to a therapist group', 'Finish the training module'],
  },
  staff_onboarding: {
    title: 'New team member onboarding', priority: 'normal',
    steps: ['Create their login with the right role', 'Add them to their team', 'Set up their accounts and tools',
      'Share the handbook', 'Meet the team lead', 'First-week check-in'],
  },
  offboarding: {
    title: 'Offboarding', priority: 'high',
    steps: ['Switch off their login (same day)', 'Move their open tasks to the team lead', 'Remove access to shared tools',
      'Settle the last payout / salary', 'Collect company equipment'],
  },
  weekly_lead_report: {
    title: 'Weekly lead report', priority: 'normal', recurrence: 'weekly:1',
    steps: ['Count new leads by source', 'Count converted and lost (with reasons)', 'Share with Marketing'],
  },
  monthly_payouts: {
    title: 'Run therapist payouts; check receipts', priority: 'high', recurrence: 'monthly:1',
    steps: ['Check completed sessions', 'Run payouts', 'Check receipts', 'Send payout notes to therapists'],
  },
};

const ok = (res, data, status = 200) => res.status(status).json({ success: true, data });
const fail = (res, status, message) => res.status(status).json({ success: false, message });
const handle = (res, error, what) => {
  if (isMissingTable(error)) return fail(res, 503, NOT_READY);
  console.error(`tasks: ${what}:`, error?.message || error);
  return fail(res, 500, `Could not ${what}.`);
};

/* ----------------------------------------------------------------- access */

/** PostgREST "or" filter for the tasks this person may see. */
async function visibilityFilter(me) {
  const teams = await teamIdsOf(me);
  const parts = [
    `and(creator_type.eq.${me.type},creator_id.eq.${me.id})`,
    `and(assignee_type.eq.${me.type},assignee_id.eq.${me.id})`,
    `and(claimed_by_type.eq.${me.type},claimed_by_id.eq.${me.id})`,
  ];
  if (teams.length) parts.push(`and(assignee_type.eq.team,assignee_id.in.(${teams.join(',')}))`);
  return { filter: parts.join(','), teams };
}

async function canSee(user, task) {
  if (isAdmin(user)) return true;
  const me = personOf(user);
  if (task.creator_type === me.type && task.creator_id === me.id) return true;
  if (task.assignee_type === me.type && task.assignee_id === me.id) return true;
  if (task.claimed_by_type === me.type && task.claimed_by_id === me.id) return true;
  if (task.assignee_type === 'team') return (await teamIdsOf(me)).includes(task.assignee_id);
  return false;
}

/* --------------------------------------------------------------- helpers */

async function recipientsOf(task) {
  if (task.assignee_type === 'team') {
    const members = await teamMembers(task.assignee_id);
    return task.claimed_by_id ? [{ type: task.claimed_by_type, id: task.claimed_by_id }] : members;
  }
  return [{ type: task.assignee_type, id: task.assignee_id }];
}

const samePerson = (a, b) => a && b && a.type === b.type && a.id === b.id;

/** Dashboard notification (+ email when the person has a real address). Never throws. */
async function notify(people, task, kind, message, actor, dedupeKey) {
  try {
    const unique = [];
    people.forEach((p) => {
      if (!p?.id || !PERSON_TYPES.includes(p.type) || samePerson(p, actor)) return;
      if (!unique.some((u) => samePerson(u, p))) unique.push(p);
    });
    if (!unique.length) return;
    const rows = unique.map((p) => ({
      recipient_type: p.type, recipient_id: p.id, task_id: task.id, kind, message,
      dedupe_key: dedupeKey ? `${dedupeKey}:${key(p.type, p.id)}` : null,
    }));
    await supabaseAdmin.from('task_notifications').upsert(rows, { onConflict: 'dedupe_key', ignoreDuplicates: true });
    // WhatsApp for URGENT tasks, once a Meta-approved template is set (INTERAKT_TPL_URGENT_TASK,
    // body {{1}} = task title, {{2}} = deadline). Off until then.
    if (task.priority === 'urgent' && kind === 'assigned' && process.env.INTERAKT_TPL_URGENT_TASK) {
      whatsappPeople(unique, task).catch(() => {});
    }
    if (process.env.TASK_EMAILS === 'off') return;
    emailPeople(unique, task, message).catch(() => {});
  } catch (e) {
    console.warn('tasks: notification not saved:', e.message);
  }
}

async function whatsappPeople(people, task) {
  const { sendTemplateMessage } = require('../utils/interaktService');
  const users = people.filter((p) => p.type === 'user').map((p) => p.id);
  const psychs = people.filter((p) => p.type === 'psychologist').map((p) => p.id);
  const [u, p, prof] = await Promise.all([
    users.length ? supabaseAdmin.from('users').select('id, phone_number').in('id', users) : { data: [] },
    psychs.length ? supabaseAdmin.from('psychologists').select('id, phone').in('id', psychs) : { data: [] },
    supabaseAdmin.from('staff_profiles').select('person_type, person_id, phone'),
  ]);
  const profPhone = new Map((prof.data || []).map((r) => [key(r.person_type, r.person_id), r.phone]));
  const phones = [
    ...(u.data || []).map((r) => profPhone.get(key('user', r.id)) || r.phone_number),
    ...(p.data || []).map((r) => profPhone.get(key('psychologist', r.id)) || r.phone),
  ].filter((x) => x && String(x).replace(/\D/g, '').length >= 10);
  const due = task.deadline ? new Date(task.deadline).toLocaleString('en-IN', { timeZone: 'Asia/Kolkata', dateStyle: 'medium', timeStyle: 'short' }) : 'as soon as possible';
  await Promise.all([...new Set(phones)].map((ph) => sendTemplateMessage(ph, process.env.INTERAKT_TPL_URGENT_TASK,
    process.env.INTERAKT_TPL_URGENT_TASK_LANG || 'en', { bodyValues: [String(task.title).slice(0, 120), due] }).catch(() => {})));
}

async function emailPeople(people, task, message) {
  const emailService = require('../utils/emailService');
  const users = people.filter((p) => p.type === 'user').map((p) => p.id);
  const psychs = people.filter((p) => p.type === 'psychologist').map((p) => p.id);
  const [u, p] = await Promise.all([
    users.length ? supabaseAdmin.from('users').select('email').in('id', users) : { data: [] },
    psychs.length ? supabaseAdmin.from('psychologists').select('email').in('id', psychs) : { data: [] },
  ]);
  const site = (process.env.FRONTEND_URL || 'https://www.koott.in').replace(/\/$/, '');
  const emails = [...(u.data || []), ...(p.data || [])].map((r) => r.email).filter((e) => e && !/\.invalid$/i.test(e));
  await Promise.all(emails.map((to) => emailService.sendEmail({
    to,
    subject: `Koott task: ${task.title}`,
    html: `<p>${message}</p><p><strong>${task.title}</strong>${task.deadline ? `<br>Due ${new Date(task.deadline).toLocaleString('en-IN', { timeZone: 'Asia/Kolkata', dateStyle: 'medium', timeStyle: task.deadline_has_time ? 'short' : undefined })}` : ''}</p><p><a href="${site}/tasks/open?id=${task.id}">Open the task</a></p>`,
  }).catch(() => {})));
}

async function logEvent(taskId, actor, action, fromValue, toValue) {
  await supabaseAdmin.from('task_events').insert({
    task_id: taskId, actor_type: actor.type, actor_id: actor.id || null, action,
    from_value: fromValue === undefined ? null : fromValue, to_value: toValue === undefined ? null : toValue,
  });
}

async function enrich(tasks) {
  const refs = [];
  tasks.forEach((t) => {
    refs.push({ type: t.assignee_type, id: t.assignee_id });
    if (t.creator_type !== 'system') refs.push({ type: t.creator_type, id: t.creator_id });
    if (t.claimed_by_id) refs.push({ type: t.claimed_by_type, id: t.claimed_by_id });
  });
  const names = await namesFor(refs);
  const now = Date.now();
  return tasks.map((t) => ({
    ...t,
    assignee: { type: t.assignee_type, id: t.assignee_id, key: key(t.assignee_type, t.assignee_id), name: names[key(t.assignee_type, t.assignee_id)]?.name || 'Unknown' },
    creator: t.creator_type === 'system'
      ? { type: 'system', name: 'Created automatically' }
      : { type: t.creator_type, id: t.creator_id, key: key(t.creator_type, t.creator_id), name: names[key(t.creator_type, t.creator_id)]?.name || 'Unknown' },
    claimedBy: t.claimed_by_id ? { type: t.claimed_by_type, id: t.claimed_by_id, name: names[key(t.claimed_by_type, t.claimed_by_id)]?.name } : null,
    overdue: Boolean(t.deadline) && !['done', 'cancelled'].includes(t.status) && new Date(t.deadline).getTime() < now,
    checklistDone: (t.checklist || []).filter((c) => c.done).length,
    checklistTotal: (t.checklist || []).length,
  }));
}

function cleanChecklist(list) {
  if (!Array.isArray(list)) return [];
  return list.slice(0, 50).map((c, i) => ({
    id: String(c.id || `${Date.now().toString(36)}${i}`),
    text: String(c.text || '').slice(0, 300),
    done: Boolean(c.done),
  })).filter((c) => c.text.trim());
}

function parseAssignee(body, me) {
  const type = body.assignee_type || (body.assignee && body.assignee.type) || me.type;
  const id = body.assignee_id || (body.assignee && body.assignee.id) || me.id;
  if (!ASSIGNEE_TYPES.includes(type) || !id) return null;
  return { type, id };
}

/** Next deadline for a recurring task. weekly:<0-6 weekday> | monthly:<1-28 day>. */
function nextOccurrence(recurrence, from) {
  const base = from ? new Date(from) : new Date();
  const [kind, raw] = String(recurrence || '').split(':');
  const n = Number(raw);
  const d = new Date(base);
  if (kind === 'weekly' && n >= 0 && n <= 6) {
    d.setDate(d.getDate() + 1);
    while (d.getDay() !== n) d.setDate(d.getDate() + 1);
    return d;
  }
  if (kind === 'monthly' && n >= 1 && n <= 28) {
    d.setMonth(d.getMonth() + 1, n);
    return d;
  }
  return null;
}

/**
 * Create a task (used by the API, automatic tasks and templates).
 * creator: { type: 'user'|'psychologist'|'system', id }
 */
async function createTask(fields, creator) {
  const row = {
    title: String(fields.title || '').trim().slice(0, 300),
    details: fields.details ? String(fields.details).slice(0, 10000) : null,
    checklist: cleanChecklist(fields.checklist),
    status: STATUSES.includes(fields.status) ? fields.status : 'todo',
    priority: PRIORITIES.includes(fields.priority) ? fields.priority : 'normal',
    deadline: fields.deadline ? new Date(fields.deadline).toISOString() : null,
    deadline_has_time: Boolean(fields.deadline_has_time),
    assignee_type: fields.assignee_type,
    assignee_id: fields.assignee_id,
    creator_type: creator.type,
    creator_id: creator.id || null,
    link_type: LINK_TYPES.includes(fields.link_type) ? fields.link_type : null,
    link_id: fields.link_id ? String(fields.link_id).slice(0, 200) : null,
    link_label: fields.link_label ? String(fields.link_label).slice(0, 200) : null,
    link_url: fields.link_url ? String(fields.link_url).slice(0, 500) : null,
    recurrence: fields.recurrence && nextOccurrence(fields.recurrence) ? fields.recurrence : null,
    template_key: fields.template_key || null,
    auto_key: fields.auto_key || null,
  };
  if (!row.title) throw Object.assign(new Error('A task needs a title.'), { status: 400 });
  const query = supabaseAdmin.from('tasks');
  const { data, error } = row.auto_key
    ? await query.upsert(row, { onConflict: 'auto_key', ignoreDuplicates: true }).select('*')
    : await query.insert(row).select('*');
  if (error) throw error;
  const task = Array.isArray(data) ? data[0] : data;
  if (!task) return null; // automatic task that already exists
  await logEvent(task.id, creator, 'created', null, { title: task.title });
  const who = creator.type === 'system' ? 'A new task was created automatically for you.' : 'You have a new task.';
  await notify(await recipientsOf(task), task, 'assigned', who, creator, `assigned:${task.id}`);
  return task;
}

/* -------------------------------------------------------------- handlers */

async function listTasks(req, res) {
  try {
    const me = personOf(req.user);
    const view = String(req.query.view || 'mine');
    let q = supabaseAdmin.from('tasks').select('*').order('created_at', { ascending: false }).limit(500);

    if (view === 'all') {
      if (!isAdmin(req.user)) return fail(res, 403, 'All tasks are for Admin only.');
    } else if (view === 'by_me') {
      q = q.eq('creator_type', me.type).eq('creator_id', me.id);
    } else if (view === 'mine') {
      const teams = await teamIdsOf(me);
      const parts = [`and(assignee_type.eq.${me.type},assignee_id.eq.${me.id})`, `and(claimed_by_type.eq.${me.type},claimed_by_id.eq.${me.id})`];
      if (teams.length) parts.push(`and(assignee_type.eq.team,assignee_id.in.(${teams.join(',')}))`);
      q = q.or(parts.join(','));
    } else {
      // overdue / visible / anything else: what this person may see (admins: everything)
      if (!isAdmin(req.user)) q = q.or((await visibilityFilter(me)).filter);
    }

    const statuses = String(req.query.status || '').split(',').filter((s) => STATUSES.includes(s));
    if (statuses.length) q = q.in('status', statuses);
    else if (req.query.archived === '1') q = q.eq('status', 'cancelled');
    else q = q.neq('status', 'cancelled');
    if (view === 'overdue') q = q.lt('deadline', new Date().toISOString()).not('status', 'in', '(done,cancelled)');
    if (PRIORITIES.includes(req.query.priority)) q = q.eq('priority', req.query.priority);
    if (req.query.assignee) {
      const [t, id] = String(req.query.assignee).split(':');
      if (ASSIGNEE_TYPES.includes(t) && id) q = q.eq('assignee_type', t).eq('assignee_id', id);
    }
    if (req.query.q) q = q.ilike('title', `%${String(req.query.q).replace(/[%,()]/g, ' ').slice(0, 80)}%`);
    if (req.query.from) q = q.gte('deadline', new Date(req.query.from).toISOString());
    if (req.query.to) q = q.lte('deadline', new Date(req.query.to).toISOString());
    if (req.query.link_type && req.query.link_id) q = q.eq('link_type', req.query.link_type).eq('link_id', String(req.query.link_id));

    const { data, error } = await q;
    if (error) return handle(res, error, 'load tasks');
    return ok(res, { tasks: await enrich(data || []), me: { ...me, key: key(me.type, me.id), isAdmin: isAdmin(req.user) } });
  } catch (e) {
    return handle(res, e, 'load tasks');
  }
}

async function getTask(req, res) {
  try {
    const { data: task, error } = await supabaseAdmin.from('tasks').select('*').eq('id', req.params.id).maybeSingle();
    if (error) return handle(res, error, 'load the task');
    if (!task || !(await canSee(req.user, task))) return fail(res, 404, 'Task not found.');
    const [comments, events] = await Promise.all([
      supabaseAdmin.from('task_comments').select('*').eq('task_id', task.id).order('created_at'),
      supabaseAdmin.from('task_events').select('*').eq('task_id', task.id).order('created_at'),
    ]);
    const refs = [
      ...(comments.data || []).map((c) => ({ type: c.author_type, id: c.author_id })),
      ...(events.data || []).map((e) => ({ type: e.actor_type, id: e.actor_id })),
    ];
    const names = await namesFor(refs);
    const nameOf = (t, id) => (t === 'system' ? 'Koott' : names[key(t, id)]?.name || 'Someone');
    const [enriched] = await enrich([task]);
    return ok(res, {
      task: enriched,
      comments: (comments.data || []).map((c) => ({ ...c, authorName: nameOf(c.author_type, c.author_id) })),
      history: (events.data || []).map((e) => ({ ...e, actorName: nameOf(e.actor_type, e.actor_id) })),
    });
  } catch (e) {
    return handle(res, e, 'load the task');
  }
}

async function createTaskHandler(req, res) {
  try {
    const me = personOf(req.user);
    const assignee = parseAssignee(req.body, me);
    if (!assignee) return fail(res, 400, 'Pick who the task is for.');
    let fields = { ...req.body, assignee_type: assignee.type, assignee_id: assignee.id };
    if (req.body.template_key && TEMPLATES[req.body.template_key]) {
      const t = TEMPLATES[req.body.template_key];
      fields = {
        ...fields,
        title: req.body.title || t.title,
        priority: req.body.priority || t.priority,
        recurrence: req.body.recurrence || t.recurrence || null,
        checklist: t.steps.map((text, i) => ({ id: `s${i}`, text, done: false })),
      };
    }
    const task = await createTask(fields, me);
    const [enriched] = await enrich([task]);
    return ok(res, { task: enriched }, 201);
  } catch (e) {
    if (e.status === 400) return fail(res, 400, e.message);
    return handle(res, e, 'create the task');
  }
}

const EDITABLE = ['title', 'details', 'checklist', 'status', 'priority', 'deadline', 'deadline_has_time',
  'assignee_type', 'assignee_id', 'link_type', 'link_id', 'link_label', 'link_url', 'recurrence'];

async function updateTask(req, res) {
  try {
    const me = personOf(req.user);
    const { data: task, error } = await supabaseAdmin.from('tasks').select('*').eq('id', req.params.id).maybeSingle();
    if (error) return handle(res, error, 'update the task');
    if (!task || !(await canSee(req.user, task))) return fail(res, 404, 'Task not found.');

    const patch = {};
    EDITABLE.forEach((f) => { if (req.body[f] !== undefined) patch[f] = req.body[f]; });
    if (patch.status !== undefined && !STATUSES.includes(patch.status)) return fail(res, 400, 'Unknown status.');
    if (patch.priority !== undefined && !PRIORITIES.includes(patch.priority)) return fail(res, 400, 'Unknown priority.');
    if (patch.title !== undefined) { patch.title = String(patch.title).trim().slice(0, 300); if (!patch.title) return fail(res, 400, 'A task needs a title.'); }
    if (patch.checklist !== undefined) patch.checklist = cleanChecklist(patch.checklist);
    if (patch.deadline !== undefined) patch.deadline = patch.deadline ? new Date(patch.deadline).toISOString() : null;
    if (patch.assignee_type !== undefined || patch.assignee_id !== undefined) {
      const a = { type: patch.assignee_type || task.assignee_type, id: patch.assignee_id || task.assignee_id };
      if (!ASSIGNEE_TYPES.includes(a.type) || !a.id) return fail(res, 400, 'Pick who the task is for.');
      patch.assignee_type = a.type; patch.assignee_id = a.id;
      patch.claimed_by_type = null; patch.claimed_by_id = null;
    }
    if (patch.link_type !== undefined && patch.link_type && !LINK_TYPES.includes(patch.link_type)) return fail(res, 400, 'Unknown link.');
    if (patch.recurrence !== undefined && patch.recurrence && !nextOccurrence(patch.recurrence)) patch.recurrence = null;
    // Cancelling (archiving) is for whoever gave the task, or Admin.
    if (patch.status === 'cancelled' && !isAdmin(req.user) && !(task.creator_type === me.type && task.creator_id === me.id)) {
      return fail(res, 403, 'Only the person who gave the task (or Admin) can archive it.');
    }
    if (patch.status === 'done' && task.status !== 'done') patch.completed_at = new Date().toISOString();
    if (patch.status && patch.status !== 'done') patch.completed_at = null;
    patch.updated_at = new Date().toISOString();

    const { data: updated, error: upErr } = await supabaseAdmin.from('tasks').update(patch).eq('id', task.id).select('*').single();
    if (upErr) return handle(res, upErr, 'update the task');

    // History: one entry per field that changed.
    const tracked = ['title', 'status', 'priority', 'deadline', 'details', 'checklist', 'recurrence', 'link_label'];
    for (const f of tracked) {
      if (patch[f] !== undefined && JSON.stringify(task[f]) !== JSON.stringify(updated[f])) {
        const brief = (v) => (f === 'details' || f === 'checklist' ? null : v);
        await logEvent(task.id, me, f === 'link_label' ? 'link' : f, brief(task[f]), brief(updated[f]));
      }
    }
    if (patch.assignee_id && (task.assignee_id !== updated.assignee_id || task.assignee_type !== updated.assignee_type)) {
      await logEvent(task.id, me, 'assignee', { type: task.assignee_type, id: task.assignee_id }, { type: updated.assignee_type, id: updated.assignee_id });
      await notify(await recipientsOf(updated), updated, 'assigned', 'A task was given to you.', me, `assigned:${task.id}:${updated.assignee_id}`);
    }
    if (patch.status && patch.status !== task.status) {
      const label = { todo: 'To do', in_progress: 'In progress', waiting: 'Waiting', done: 'Done', cancelled: 'Archived' }[patch.status];
      const creator = task.creator_type === 'system' ? null : { type: task.creator_type, id: task.creator_id };
      await notify([creator, ...(await recipientsOf(updated))], updated, 'status', `Status changed to ${label}.`, me);
      // A repeating task comes back with its next deadline once it is done.
      if (patch.status === 'done' && updated.recurrence) {
        const next = nextOccurrence(updated.recurrence, updated.deadline || new Date());
        if (next) {
          await createTask({
            ...updated, status: 'todo', deadline: next.toISOString(),
            checklist: (updated.checklist || []).map((c) => ({ ...c, done: false })),
            auto_key: `recur:${updated.id}:${next.toISOString().slice(0, 10)}`,
          }, task.creator_type === 'system' ? { type: 'system' } : { type: task.creator_type, id: task.creator_id });
        }
      }
    }
    const [enriched] = await enrich([updated]);
    return ok(res, { task: enriched });
  } catch (e) {
    return handle(res, e, 'update the task');
  }
}

async function claimTask(req, res) {
  try {
    const me = personOf(req.user);
    const { data: task } = await supabaseAdmin.from('tasks').select('*').eq('id', req.params.id).maybeSingle();
    if (!task || !(await canSee(req.user, task))) return fail(res, 404, 'Task not found.');
    if (task.assignee_type !== 'team') return fail(res, 400, 'Only team tasks are picked up.');
    const { data: updated, error } = await supabaseAdmin.from('tasks')
      .update({ claimed_by_type: me.type, claimed_by_id: me.id, status: task.status === 'todo' ? 'in_progress' : task.status, updated_at: new Date().toISOString() })
      .eq('id', task.id).select('*').single();
    if (error) return handle(res, error, 'pick up the task');
    await logEvent(task.id, me, 'claimed', null, { type: me.type, id: me.id });
    const [enriched] = await enrich([updated]);
    return ok(res, { task: enriched });
  } catch (e) {
    return handle(res, e, 'pick up the task');
  }
}

async function addComment(req, res) {
  try {
    const me = personOf(req.user);
    const body = String(req.body.body || '').trim().slice(0, 5000);
    if (!body) return fail(res, 400, 'Write a comment first.');
    const { data: task } = await supabaseAdmin.from('tasks').select('*').eq('id', req.params.id).maybeSingle();
    if (!task || !(await canSee(req.user, task))) return fail(res, 404, 'Task not found.');
    const mentions = (Array.isArray(req.body.mentions) ? req.body.mentions : [])
      .filter((m) => m && ASSIGNEE_TYPES.includes(m.type) && m.id).slice(0, 20);
    const { data: comment, error } = await supabaseAdmin.from('task_comments')
      .insert({ task_id: task.id, author_type: me.type, author_id: me.id, body, mentions }).select('*').single();
    if (error) return handle(res, error, 'add the comment');
    await logEvent(task.id, me, 'comment', null, null);

    const mentionPeople = [];
    for (const m of mentions) {
      if (m.type === 'team') mentionPeople.push(...(await teamMembers(m.id)));
      else mentionPeople.push(m);
    }
    await notify(mentionPeople, task, 'mention', 'You were mentioned in a task comment.', me);
    const creator = task.creator_type === 'system' ? null : { type: task.creator_type, id: task.creator_id };
    const others = [creator, ...(await recipientsOf(task))].filter((p) => p && !mentionPeople.some((m) => samePerson(m, p)));
    await notify(others, task, 'comment', 'New comment on a task.', me);
    const names = await namesFor([{ type: me.type, id: me.id }]);
    return ok(res, { comment: { ...comment, authorName: names[key(me.type, me.id)]?.name || 'You' } }, 201);
  } catch (e) {
    return handle(res, e, 'add the comment');
  }
}

/** Who a task can be given to: everyone active, and every team. */
async function assignable(req, res) {
  try {
    const [people, teams] = await Promise.all([
      listPeople({ includeInactive: false }),
      supabaseAdmin.from('teams').select('id, name').order('name'),
    ]);
    if (teams.error) return handle(res, teams.error, 'load people');
    return ok(res, {
      people: people.map((p) => ({ key: p.key, type: p.type, id: p.id, name: p.name, roleLabel: p.roleLabel, teams: p.teams })),
      teams: (teams.data || []).map((t) => ({ key: key('team', t.id), type: 'team', id: t.id, name: t.name })),
      templates: Object.entries(TEMPLATES).map(([k, t]) => ({ key: k, title: t.title, steps: t.steps.length, recurrence: t.recurrence || null })),
    });
  } catch (e) {
    return handle(res, e, 'load people');
  }
}

/** Admin: open and overdue tasks per person / team. */
async function workload(req, res) {
  try {
    if (!isAdmin(req.user)) return fail(res, 403, 'Workload is for Admin only.');
    const { data, error } = await supabaseAdmin.from('tasks')
      .select('assignee_type, assignee_id, claimed_by_type, claimed_by_id, status, deadline').not('status', 'in', '(done,cancelled)');
    if (error) return handle(res, error, 'load the workload');
    const now = Date.now();
    const rows = new Map();
    (data || []).forEach((t) => {
      const owner = t.claimed_by_id ? { type: t.claimed_by_type, id: t.claimed_by_id } : { type: t.assignee_type, id: t.assignee_id };
      const k = key(owner.type, owner.id);
      const r = rows.get(k) || { ...owner, key: k, open: 0, overdue: 0, urgent: 0 };
      r.open += 1;
      if (t.deadline && new Date(t.deadline).getTime() < now) r.overdue += 1;
      rows.set(k, r);
    });
    const names = await namesFor([...rows.values()]);
    const list = [...rows.values()].map((r) => ({ ...r, name: names[r.key]?.name || 'Unknown', role: names[r.key]?.role }))
      .sort((a, b) => b.overdue - a.overdue || b.open - a.open);
    return ok(res, { workload: list });
  } catch (e) {
    return handle(res, e, 'load the workload');
  }
}

/** "Report a problem": a task for the Developers team with the page filled in. */
async function reportProblem(req, res) {
  try {
    const me = personOf(req.user);
    const summary = String(req.body.summary || '').trim().slice(0, 200);
    if (!summary) return fail(res, 400, 'Say what went wrong in a line.');
    const team = await teamByName('Developers');
    const page = String(req.body.page || '').slice(0, 500);
    const task = await createTask({
      title: `Problem: ${summary}`,
      details: [req.body.details ? String(req.body.details).slice(0, 4000) : '', page ? `Page: ${page}` : '',
        req.body.userAgent ? `Browser: ${String(req.body.userAgent).slice(0, 300)}` : '', `Reported by role: ${req.user.role}`]
        .filter(Boolean).join('\n\n'),
      priority: PRIORITIES.includes(req.body.priority) ? req.body.priority : 'high',
      assignee_type: 'team', assignee_id: team.id,
      link_type: page ? 'url' : null, link_label: page ? 'Page with the problem' : null, link_url: page || null,
    }, me);
    return ok(res, { task }, 201);
  } catch (e) {
    return handle(res, e, 'report the problem');
  }
}

async function listNotifications(req, res) {
  try {
    const me = personOf(req.user);
    const { data, error } = await supabaseAdmin.from('task_notifications')
      .select('id, task_id, kind, message, read_at, created_at, task:tasks(title, status)')
      .eq('recipient_type', me.type).eq('recipient_id', me.id)
      .order('created_at', { ascending: false }).limit(40);
    if (error) return handle(res, error, 'load notifications');
    return ok(res, { notifications: data || [], unread: (data || []).filter((n) => !n.read_at).length });
  } catch (e) {
    return handle(res, e, 'load notifications');
  }
}

async function markNotificationsRead(req, res) {
  try {
    const me = personOf(req.user);
    let q = supabaseAdmin.from('task_notifications').update({ read_at: new Date().toISOString() })
      .eq('recipient_type', me.type).eq('recipient_id', me.id).is('read_at', null);
    if (Array.isArray(req.body.ids) && req.body.ids.length) q = q.in('id', req.body.ids.slice(0, 100));
    const { error } = await q;
    if (error) return handle(res, error, 'update notifications');
    return ok(res, {});
  } catch (e) {
    return handle(res, e, 'update notifications');
  }
}

module.exports = {
  listTasks, getTask, createTaskHandler, updateTask, claimTask, addComment, assignable, workload,
  reportProblem, listNotifications, markNotificationsRead,
  createTask, notify, TEMPLATES, STATUSES, PRIORITIES,
};

/* ------------------------------------------------------------ attachments */
// Files live in the private storage bucket "task-files" under <taskId>/; nothing in the
// database. Opening one goes through the API (visibility checked) to a 5-minute link.
const TASK_BUCKET = 'task-files';
const cleanName = (n) => String(n || 'file').replace(/[^\w.\- ]+/g, '_').replace(/\s+/g, ' ').slice(0, 120);

async function ensureBucket() {
  const { error } = await supabaseAdmin.storage.createBucket(TASK_BUCKET, { public: false, fileSizeLimit: 15 * 1024 * 1024 });
  if (error && !/already exists|already_exists|duplicate/i.test(error.message || '')) throw error;
}

async function listAttachments(taskId) {
  const { data, error } = await supabaseAdmin.storage.from(TASK_BUCKET).list(taskId, { limit: 100, sortBy: { column: 'created_at', order: 'asc' } });
  if (error) return [];
  return (data || []).filter((f) => f.name && f.id).map((f) => ({
    id: f.name, name: f.name.split('__').slice(1).join('__') || f.name,
    size: f.metadata?.size || null, type: f.metadata?.mimetype || null, at: f.created_at,
  }));
}

async function getAttachments(req, res) {
  try {
    const { data: task } = await supabaseAdmin.from('tasks').select('*').eq('id', req.params.id).maybeSingle();
    if (!task || !(await canSee(req.user, task))) return fail(res, 404, 'Task not found.');
    return ok(res, { attachments: await listAttachments(task.id) });
  } catch (e) {
    return handle(res, e, 'load the files');
  }
}

async function uploadAttachment(req, res) {
  try {
    if (!req.file) return fail(res, 400, 'Choose a file.');
    const { data: task } = await supabaseAdmin.from('tasks').select('*').eq('id', req.params.id).maybeSingle();
    if (!task || !(await canSee(req.user, task))) return fail(res, 404, 'Task not found.');
    if ((await listAttachments(task.id)).length >= 20) return fail(res, 400, 'A task can hold up to 20 files.');
    const objectPath = `${task.id}/${require('crypto').randomUUID().slice(0, 8)}__${cleanName(req.file.originalname)}`;
    const put = () => supabaseAdmin.storage.from(TASK_BUCKET).upload(objectPath, req.file.buffer, { contentType: req.file.mimetype, upsert: false });
    let { error } = await put();
    if (error && /bucket not found|not found/i.test(error.message || '')) { await ensureBucket(); ({ error } = await put()); }
    if (error) return handle(res, error, 'upload the file');
    await logEvent(task.id, personOf(req.user), 'attachment', null, { name: cleanName(req.file.originalname) });
    return ok(res, { attachments: await listAttachments(task.id) }, 201);
  } catch (e) {
    return handle(res, e, 'upload the file');
  }
}

async function openAttachment(req, res) {
  try {
    const { data: task } = await supabaseAdmin.from('tasks').select('*').eq('id', req.params.id).maybeSingle();
    if (!task || !(await canSee(req.user, task))) return fail(res, 404, 'Task not found.');
    const name = String(req.params.file || '');
    if (!name || name.includes('/') || name.includes('..')) return fail(res, 400, 'Unknown file.');
    const { data, error } = await supabaseAdmin.storage.from(TASK_BUCKET).createSignedUrl(`${task.id}/${name}`, 300);
    if (error || !data?.signedUrl) return fail(res, 404, 'File not found.');
    return ok(res, { url: data.signedUrl });
  } catch (e) {
    return handle(res, e, 'open the file');
  }
}

async function deleteAttachment(req, res) {
  try {
    const { data: task } = await supabaseAdmin.from('tasks').select('*').eq('id', req.params.id).maybeSingle();
    if (!task || !(await canSee(req.user, task))) return fail(res, 404, 'Task not found.');
    const name = String(req.params.file || '');
    if (!name || name.includes('/') || name.includes('..')) return fail(res, 400, 'Unknown file.');
    await supabaseAdmin.storage.from(TASK_BUCKET).remove([`${task.id}/${name}`]);
    await logEvent(task.id, personOf(req.user), 'attachment_removed', null, { name: name.split('__').slice(1).join('__') });
    return ok(res, { attachments: await listAttachments(task.id) });
  } catch (e) {
    return handle(res, e, 'remove the file');
  }
}

module.exports.getAttachments = getAttachments;
module.exports.uploadAttachment = uploadAttachment;
module.exports.openAttachment = openAttachment;
module.exports.deleteAttachment = deleteAttachment;
