/**
 * /api/people and /api/teams — HR: one list of everyone who works at Koott, employee
 * onboarding (creates the login; the role decides the dashboard), offboarding (access
 * ends the same day, history stays, open tasks move to the team lead), teams with a lead.
 * Finance reads the list and sets salaries.
 */
const crypto = require('crypto');
const { supabaseAdmin } = require('../config/supabase');
const { hashPassword } = require('../utils/helpers');
const { isAdmin, personOf, ONBOARDABLE_ROLES, ROLE_LABEL, STAFF_USER_ROLES, UUID_RE } = require('../utils/staffRoles');
const { key, listPeople, namesFor, teamByName, isMissingTable, NOT_READY, COMPLETE } = require('../utils/people');

const ok = (res, data, status = 200) => res.status(status).json({ success: true, data });
const fail = (res, status, message) => res.status(status).json({ success: false, message });
const handle = (res, e, what) => {
  if (isMissingTable(e)) return fail(res, 503, NOT_READY);
  console.error(`people: ${what}:`, e?.message || e);
  return fail(res, 500, `Could not ${what}.`);
};
const parsePerson = (type, id) => (['user', 'psychologist'].includes(type) && UUID_RE.test(String(id || '')) ? { type, id } : null);
const YMD = /^\d{4}-\d{2}-\d{2}$/;
const validDay = (v) => YMD.test(String(v || '')) && !Number.isNaN(new Date(`${v}T00:00:00Z`).getTime());

/**
 * May this signed-in HR / Admin person act on this login? Superadmins never; admins only
 * by Admin; client logins are not people (they are Operations' clients) — so HR can never
 * hand a staff role to a client account or bring back someone Admin switched off.
 */
async function guardTarget(req, person) {
  if (person.type === 'psychologist') {
    const { data: p, error } = await supabaseAdmin.from('psychologists').select('id').eq('id', person.id).maybeSingle();
    if (error) throw error;
    return p ? null : [404, 'Person not found.'];
  }
  const { data: u, error } = await supabaseAdmin.from('users').select('role').eq('id', person.id).maybeSingle();
  if (error) throw error;
  if (!u) return [404, 'Person not found.'];
  if (!STAFF_USER_ROLES.includes(u.role)) return [400, 'That login is not a Koott staff member.'];
  if (u.role === 'superadmin') return [403, 'The superadmin is managed by the superadmin.'];
  if (u.role === 'admin' && !isAdmin(req.user)) return [403, 'Only Admin can change an admin login.'];
  return null;
}

async function upsertProfile(person, fields) {
  const row = { person_type: person.type, person_id: person.id, ...fields, updated_at: new Date().toISOString() };
  const { error } = await supabaseAdmin.from('staff_profiles').upsert(row, { onConflict: 'person_type,person_id' });
  if (error) throw error;
}

async function setTeams(person, teamIds) {
  const ids = [...new Set((teamIds || []).filter(Boolean))];
  const { error: delErr } = await supabaseAdmin.from('team_members').delete().eq('person_type', person.type).eq('person_id', person.id);
  if (delErr) throw delErr;
  if (ids.length) {
    const { error } = await supabaseAdmin.from('team_members').insert(ids.map((team_id) => ({ team_id, person_type: person.type, person_id: person.id })));
    if (error) throw error;
  }
}

async function getPeople(req, res) {
  try {
    const [people, teams] = await Promise.all([listPeople(), supabaseAdmin.from('teams').select('*').order('name')]);
    if (teams.error) return handle(res, teams.error, 'load people');
    const finance = req.user.role === 'finance';
    return ok(res, {
      people: people.map((p) => (finance ? p : { ...p, salaryMonthly: isAdmin(req.user) || req.user.role === 'hr' ? p.salaryMonthly : undefined })),
      teams: teams.data || [],
      roles: ONBOARDABLE_ROLES.filter((r) => r !== 'admin' || isAdmin(req.user)).map((r) => ({ value: r, label: ROLE_LABEL[r] })),
    });
  } catch (e) {
    return handle(res, e, 'load people');
  }
}

/** Employee onboarding: creates the login with the chosen role, profile, team and checklist. */
async function onboard(req, res) {
  try {
    const b = req.body || {};
    const name = String(b.name || '').trim().slice(0, 120);
    const email = String(b.email || '').trim().toLowerCase();
    const role = String(b.role || '');
    if (!name || !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) return fail(res, 400, 'Name and a valid email are needed.');
    if (!ONBOARDABLE_ROLES.includes(role)) return fail(res, 400, 'Pick a role.');
    if (role === 'admin' && !isAdmin(req.user)) return fail(res, 403, 'Only Admin can create another admin.');
    if (b.start_date && !validDay(b.start_date)) return fail(res, 400, 'Start date must be a date (YYYY-MM-DD).');
    if (b.team_id && !UUID_RE.test(String(b.team_id))) return fail(res, 400, 'Unknown team.');

    const [{ data: takenUser }, { data: takenPsych }] = await Promise.all([
      supabaseAdmin.from('users').select('id').eq('email', email).maybeSingle(),
      supabaseAdmin.from('psychologists').select('id').eq('email', email).maybeSingle(),
    ]);
    if (takenUser || takenPsych) return fail(res, 409, 'That email already has a Koott login. One email, one role.');

    // A temporary password HR passes on once; they change it with "Forgot password".
    const tempPassword = `Koott-${crypto.randomBytes(5).toString('hex')}-${crypto.randomInt(10, 99)}!`;
    const { data: user, error: uErr } = await supabaseAdmin.from('users').insert({
      email, name, role, password_hash: await hashPassword(tempPassword),
      phone_number: b.phone ? String(b.phone).slice(0, 30) : null, is_active: true,
    }).select('id, email, name, role').single();
    if (uErr) return handle(res, uErr, 'create the login');
    const person = { type: 'user', id: user.id };
    const me = personOf(req.user);
    await upsertProfile(person, {
      job_title: b.job_title ? String(b.job_title).slice(0, 120) : null,
      start_date: b.start_date || null,
      phone: b.phone ? String(b.phone).slice(0, 30) : null,
      created_by: req.user.id,
    });
    if (b.team_id) await setTeams(person, [b.team_id]);

    // Onboarding checklist: for the new person, and for HR to follow it through.
    const { createTask, TEMPLATES } = require('./tasksController');
    const steps = (t) => TEMPLATES[t].steps.map((text, i) => ({ id: `s${i}`, text, done: false }));
    const due = b.start_date ? new Date(`${b.start_date}T12:00:00+05:30`) : new Date(Date.now() + 7 * 864e5);
    await createTask({
      title: `Welcome to Koott, ${name} — your first steps`, assignee_type: 'user', assignee_id: user.id,
      checklist: [{ id: 'a', text: 'Change your temporary password', done: false }, { id: 'b', text: 'Read the team handbook', done: false }, { id: 'c', text: 'Meet your team lead', done: false }],
      deadline: due.toISOString(), priority: 'normal', link_type: 'person', link_id: key('user', user.id), link_label: name,
      template_key: 'staff_onboarding',
    }, me);
    const hr = await teamByName('HR');
    await createTask({
      title: `Onboard ${name} (${ROLE_LABEL[role]})`, assignee_type: 'team', assignee_id: hr.id,
      checklist: steps('staff_onboarding'), deadline: due.toISOString(), priority: 'normal',
      link_type: 'person', link_id: key('user', user.id), link_label: name, template_key: 'staff_onboarding',
    }, me);
    if (b.team_id) {
      const { data: team } = await supabaseAdmin.from('teams').select('lead_person_type, lead_person_id, name').eq('id', b.team_id).maybeSingle();
      if (team?.lead_person_id) {
        await createTask({
          title: `Meet ${name}, new in ${team.name}`, assignee_type: team.lead_person_type, assignee_id: team.lead_person_id,
          deadline: due.toISOString(), link_type: 'person', link_id: key('user', user.id), link_label: name,
        }, me);
      }
    }
    return ok(res, { person: { ...user, type: 'user' }, tempPassword, dashboard: require('../utils/staffRoles').DASHBOARD_BY_ROLE[role] }, 201);
  } catch (e) {
    return handle(res, e, 'onboard the person');
  }
}

async function updatePerson(req, res) {
  try {
    const person = parsePerson(req.params.type, req.params.id);
    if (!person) return fail(res, 400, 'Unknown person.');
    const b = req.body || {};
    const denied = await guardTarget(req, person);
    if (denied) return fail(res, denied[0], denied[1]);
    if (b.start_date && !validDay(b.start_date)) return fail(res, 400, 'Start date must be a date (YYYY-MM-DD).');
    if (Array.isArray(b.team_ids) && b.team_ids.some((t) => !UUID_RE.test(String(t)))) return fail(res, 400, 'Unknown team.');
    const role = req.user.role;
    const canHr = isAdmin(req.user) || role === 'hr';
    const canPay = isAdmin(req.user) || role === 'finance' || role === 'hr';
    const profile = {};
    if (canHr) {
      if (b.job_title !== undefined) profile.job_title = b.job_title ? String(b.job_title).slice(0, 120) : null;
      if (b.start_date !== undefined) profile.start_date = b.start_date || null;
      if (b.phone !== undefined) profile.phone = b.phone ? String(b.phone).slice(0, 30) : null;
      if (b.notes !== undefined) profile.notes = b.notes ? String(b.notes).slice(0, 2000) : null;
    }
    if (canPay && b.salary_monthly !== undefined) {
      const n = b.salary_monthly === '' || b.salary_monthly === null ? null : Number(b.salary_monthly);
      if (n !== null && (!Number.isFinite(n) || n < 0)) return fail(res, 400, 'Salary must be a number.');
      profile.salary_monthly = n;
    }
    if (Object.keys(profile).length) await upsertProfile(person, profile);
    if (canHr && Array.isArray(b.team_ids)) await setTeams(person, b.team_ids);
    if (canHr && b.role !== undefined && person.type === 'user') {
      if (!ONBOARDABLE_ROLES.includes(b.role)) return fail(res, 400, 'Pick a role.');
      const { data: target } = await supabaseAdmin.from('users').select('role').eq('id', person.id).maybeSingle();
      if (!target) return fail(res, 404, 'Person not found.');
      if (target.role === 'superadmin' || ((b.role === 'admin' || target.role === 'admin') && !isAdmin(req.user))) {
        return fail(res, 403, 'Only Admin can change an admin login.');
      }
      if (target.role !== b.role) {
        await supabaseAdmin.from('users').update({ role: b.role, updated_at: new Date().toISOString() }).eq('id', person.id);
        // The role is read from the database on each request (cached 60 s): drop the cache
        // so the new role applies at once; they open their new dashboard after signing in again.
        require('../utils/cache').globalCache.delete(`auth_user:${person.id}`);
      }
    }
    const people = await listPeople();
    return ok(res, { person: people.find((p) => p.key === key(person.type, person.id)) || null });
  } catch (e) {
    return handle(res, e, 'update the person');
  }
}

/** Offboarding: access ends now, history stays, open tasks go to the team lead (else HR). */
async function offboard(req, res) {
  try {
    const person = parsePerson(req.params.type, req.params.id);
    if (!person) return fail(res, 400, 'Unknown person.');
    const me = personOf(req.user);
    if (person.type === me.type && person.id === me.id) return fail(res, 400, 'You cannot offboard yourself.');
    const now = new Date().toISOString();
    let name = 'Person';
    if (person.type === 'user') {
      const { data: u } = await supabaseAdmin.from('users').select('role, name, email').eq('id', person.id).maybeSingle();
      if (!u) return fail(res, 404, 'Person not found.');
      if (u.role === 'superadmin' || (u.role === 'admin' && !isAdmin(req.user))) return fail(res, 403, 'Only Admin can offboard an admin.');
      if (u.role === 'client') return fail(res, 400, 'Clients are not offboarded here.');
      name = u.name || u.email;
      await supabaseAdmin.from('users').update({ is_active: false, updated_at: now }).eq('id', person.id);
    } else {
      const { data: p } = await supabaseAdmin.from('psychologists').select('first_name, last_name, email').eq('id', person.id).maybeSingle();
      if (!p) return fail(res, 404, 'Person not found.');
      name = `${p.first_name || ''} ${p.last_name || ''}`.trim() || p.email;
      await supabaseAdmin.from('psychologists').update({ is_active: false, updated_at: now }).eq('id', person.id);
    }
    await require('../utils/tokenRevocation').revokeUserTokens(person.id, 'offboarded').catch(() => {});
    await upsertProfile(person, { offboarded_at: now, offboarded_by: req.user.id });

    // Their open tasks move to their team lead (first team with a lead), else to HR.
    const { data: memberships } = await supabaseAdmin.from('team_members').select('team_id, teams(lead_person_type, lead_person_id)')
      .eq('person_type', person.type).eq('person_id', person.id);
    const lead = (memberships || []).map((m) => m.teams).find((t) => t?.lead_person_id && !(t.lead_person_type === person.type && t.lead_person_id === person.id));
    const hr = await teamByName('HR');
    const to = lead ? { type: lead.lead_person_type, id: lead.lead_person_id } : { type: 'team', id: hr.id };
    const { data: moved } = await supabaseAdmin.from('tasks')
      .update({ assignee_type: to.type, assignee_id: to.id, claimed_by_type: null, claimed_by_id: null, updated_at: now })
      .eq('assignee_type', person.type).eq('assignee_id', person.id).not('status', 'in', '(done,cancelled)').select('id');
    await supabaseAdmin.from('tasks').update({ claimed_by_type: null, claimed_by_id: null, updated_at: now })
      .eq('claimed_by_type', person.type).eq('claimed_by_id', person.id).not('status', 'in', '(done,cancelled)');

    const { createTask, TEMPLATES } = require('./tasksController');
    await createTask({
      title: `Offboarding: ${name}`, assignee_type: 'team', assignee_id: hr.id, priority: 'high',
      checklist: TEMPLATES.offboarding.steps.map((text, i) => ({ id: `s${i}`, text, done: i < 2 })), // login switched off and tasks moved: done above,
      deadline: new Date(Date.now() + 2 * 864e5).toISOString(), link_type: 'person', link_id: key(person.type, person.id), link_label: name,
      template_key: 'offboarding',
    }, me);
    const finance = await teamByName('Finance');
    await createTask({
      title: `Settle the last payout / salary for ${name}`, assignee_type: 'team', assignee_id: finance.id, priority: 'high',
      deadline: new Date(Date.now() + 5 * 864e5).toISOString(), link_type: 'person', link_id: key(person.type, person.id), link_label: name,
    }, me);
    return ok(res, { offboarded: true, tasksMoved: (moved || []).length, movedTo: to });
  } catch (e) {
    return handle(res, e, 'offboard the person');
  }
}

async function reactivate(req, res) {
  try {
    const person = parsePerson(req.params.type, req.params.id);
    if (!person) return fail(res, 400, 'Unknown person.');
    const denied = await guardTarget(req, person);
    if (denied) return fail(res, denied[0], denied[1]);
    const now = new Date().toISOString();
    if (person.type === 'user') await supabaseAdmin.from('users').update({ is_active: true, updated_at: now }).eq('id', person.id);
    else await supabaseAdmin.from('psychologists').update({ is_active: true, updated_at: now }).eq('id', person.id);
    await supabaseAdmin.from('revoked_users').delete().eq('user_id', person.id).then(() => {}, () => {});
    const { globalCache } = require('../utils/cache');
    globalCache.delete(`revoked_user:${person.id}`); globalCache.delete(`auth_user:${person.id}`); globalCache.delete(`user_ok:${person.id}`);
    await upsertProfile(person, { offboarded_at: null, offboarded_by: null });
    return ok(res, { reactivated: true });
  } catch (e) {
    return handle(res, e, 'reactivate the person');
  }
}

/* ------------------------------------------------------------------ teams */

async function getTeams(req, res) {
  try {
    const [teams, members] = await Promise.all([
      supabaseAdmin.from('teams').select('*').order('name'),
      supabaseAdmin.from('team_members').select('team_id, person_type, person_id'),
    ]);
    if (teams.error) return handle(res, teams.error, 'load teams');
    const refs = [...(members.data || []).map((m) => ({ type: m.person_type, id: m.person_id })),
      ...(teams.data || []).filter((t) => t.lead_person_id).map((t) => ({ type: t.lead_person_type, id: t.lead_person_id }))];
    if (members.error) return handle(res, members.error, 'load teams');
    const names = await namesFor(refs);
    // A member is removed only when the name lookups really worked: a Supabase blip must
    // never read as "every member was deleted" and empty the teams.
    const orphans = names[COMPLETE] ? (members.data || []).filter((m) => !names[key(m.person_type, m.person_id)]) : [];
    orphans.forEach((m) => {
      supabaseAdmin.from('team_members').delete().eq('team_id', m.team_id).eq('person_type', m.person_type).eq('person_id', m.person_id).then(() => {}, () => {});
    });
    return ok(res, {
      teams: (teams.data || []).map((t) => ({
        ...t,
        lead: t.lead_person_id ? { key: key(t.lead_person_type, t.lead_person_id), name: names[key(t.lead_person_type, t.lead_person_id)]?.name } : null,
        // A member whose login was deleted has no name: left out (and removed below).
        members: (members.data || []).filter((m) => m.team_id === t.id && names[key(m.person_type, m.person_id)]).map((m) => ({
          key: key(m.person_type, m.person_id), type: m.person_type, id: m.person_id, name: names[key(m.person_type, m.person_id)].name,
        })),
      })),
    });
  } catch (e) {
    return handle(res, e, 'load teams');
  }
}

async function saveTeam(req, res) {
  try {
    const b = req.body || {};
    const row = { updated_at: new Date().toISOString() };
    if (b.name !== undefined) { row.name = String(b.name).trim().slice(0, 80); if (!row.name) return fail(res, 400, 'A team needs a name.'); }
    if (b.description !== undefined) row.description = b.description ? String(b.description).slice(0, 300) : null;
    if (b.lead !== undefined) {
      if (!b.lead) { row.lead_person_type = null; row.lead_person_id = null; } else {
        const [t, id] = String(b.lead).split(':');
        if (!parsePerson(t, id)) return fail(res, 400, 'Unknown team lead.');
        row.lead_person_type = t; row.lead_person_id = id;
      }
    }
    const q = req.params.id
      ? supabaseAdmin.from('teams').update(row).eq('id', req.params.id)
      : supabaseAdmin.from('teams').insert(row);
    const { data, error } = await q.select('*').single();
    if (error) return error.code === '23505' ? fail(res, 409, 'A team with that name already exists.') : handle(res, error, 'save the team');
    // The lead is a member too.
    if (data.lead_person_id) {
      await supabaseAdmin.from('team_members').upsert({ team_id: data.id, person_type: data.lead_person_type, person_id: data.lead_person_id },
        { onConflict: 'team_id,person_type,person_id', ignoreDuplicates: true });
    }
    return ok(res, { team: data }, req.params.id ? 200 : 201);
  } catch (e) {
    return handle(res, e, 'save the team');
  }
}

async function deleteTeam(req, res) {
  try {
    const { count } = await supabaseAdmin.from('tasks').select('id', { count: 'exact', head: true })
      .eq('assignee_type', 'team').eq('assignee_id', req.params.id).not('status', 'in', '(done,cancelled)');
    if (count) return fail(res, 400, `This team still has ${count} open task(s). Move them first.`);
    const { error } = await supabaseAdmin.from('teams').delete().eq('id', req.params.id);
    if (error) return handle(res, error, 'delete the team');
    return ok(res, { deleted: true });
  } catch (e) {
    return handle(res, e, 'delete the team');
  }
}

async function addMember(req, res) {
  try {
    const [t, id] = String(req.body.person || '').split(':');
    if (!parsePerson(t, id)) return fail(res, 400, 'Unknown person.');
    const { error } = await supabaseAdmin.from('team_members').upsert({ team_id: req.params.id, person_type: t, person_id: id },
      { onConflict: 'team_id,person_type,person_id', ignoreDuplicates: true });
    if (error) return handle(res, error, 'add the member');
    return ok(res, { added: true }, 201);
  } catch (e) {
    return handle(res, e, 'add the member');
  }
}

async function removeMember(req, res) {
  try {
    const [t, id] = String(req.params.person || '').split(':');
    if (!parsePerson(t, id)) return fail(res, 400, 'Unknown person.');
    const { error } = await supabaseAdmin.from('team_members').delete().eq('team_id', req.params.id).eq('person_type', t).eq('person_id', id);
    if (error) return handle(res, error, 'remove the member');
    const { data: team } = await supabaseAdmin.from('teams').select('lead_person_type, lead_person_id').eq('id', req.params.id).maybeSingle();
    if (team && team.lead_person_type === t && team.lead_person_id === id) {
      await supabaseAdmin.from('teams').update({ lead_person_type: null, lead_person_id: null }).eq('id', req.params.id);
    }
    return ok(res, { removed: true });
  } catch (e) {
    return handle(res, e, 'remove the member');
  }
}

module.exports = { getPeople, onboard, updatePerson, offboard, reactivate, getTeams, saveTeam, deleteTeam, addMember, removeMember };

/**
 * HR → Therapist onboarding: each therapist's steps, worked out from their record —
 * profile (photo + description + designation), pricing (an active package or a price),
 * availability (working hours or open days ahead), Google Calendar, group, login.
 */
async function therapistOnboarding(req, res) {
  try {
    const today = new Date(Date.now() + 330 * 60000).toISOString().slice(0, 10);
    const [psychs, pkgs, avail] = await Promise.all([
      supabaseAdmin.from('psychologists').select('id, first_name, last_name, email, designation, description, profile_picture_url, cover_image_url, individual_session_price, psychiatrist_15min_price, working_hours, google_calendar_credentials, therapist_group_id, password_hash, is_active, created_at'),
      supabaseAdmin.from('packages').select('psychologist_id, is_active'),
      supabaseAdmin.from('availability').select('psychologist_id, is_available').gte('date', today).eq('is_available', true).limit(5000),
    ]);
    if (psychs.error) return handle(res, psychs.error, 'load therapists');
    const hasPkg = new Set((pkgs.data || []).filter((p) => p.is_active !== false).map((p) => p.psychologist_id));
    const hasDays = new Set((avail.data || []).map((a) => a.psychologist_id));
    const rows = (psychs.data || []).filter((p) => p.is_active !== false).map((p) => {
      const creds = p.google_calendar_credentials;
      const steps = [
        { key: 'login', label: 'Login created', done: Boolean(p.password_hash) },
        { key: 'profile', label: 'Profile, photo and bio', done: Boolean((p.profile_picture_url || p.cover_image_url) && String(p.description || '').trim().length > 40 && p.designation) },
        { key: 'pricing', label: 'Session pricing', done: hasPkg.has(p.id) || Number(p.individual_session_price) > 0 || Number(p.psychiatrist_15min_price) > 0 },
        { key: 'availability', label: 'Working hours / availability', done: Boolean(p.working_hours) || hasDays.has(p.id) },
        { key: 'calendar', label: 'Google Calendar connected', done: Boolean(creds && typeof creds === 'object' && creds.refresh_token) },
        { key: 'group', label: 'In a therapist group', done: Boolean(p.therapist_group_id) },
      ];
      return {
        id: p.id, name: `${p.first_name || ''} ${p.last_name || ''}`.trim() || p.email, email: p.email, designation: p.designation,
        steps, done: steps.filter((s) => s.done).length, total: steps.length, createdAt: p.created_at,
      };
    }).sort((a, b) => a.done / a.total - b.done / b.total || a.name.localeCompare(b.name));
    return ok(res, { therapists: rows });
  } catch (e) {
    return handle(res, e, 'load therapists');
  }
}
module.exports.therapistOnboarding = therapistOnboarding;
