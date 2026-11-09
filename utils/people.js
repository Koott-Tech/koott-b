/**
 * People at Koott — one list of everyone who works here: staff logins (users with a
 * staff role) and therapists (psychologists). A person is { type: 'user' | 'psychologist', id }.
 * Teams group people; tasks can go to a person or a team.
 */
const { supabaseAdmin } = require('../config/supabase');
const { STAFF_USER_ROLES, ROLE_LABEL } = require('./staffRoles');

const key = (type, id) => `${type}:${id}`;
const COMPLETE = Symbol('namesFor.complete');
const psychName = (p) => `${p.first_name || ''} ${p.last_name || ''}`.trim() || p.email || 'Therapist';

/** Missing table (migration 0021 not run yet) → a clear message instead of a 500 with SQL text. */
function isMissingTable(error) {
  if (!error) return false;
  if (error.code === '42P01' || error.code === 'PGRST205') return true;
  // "Could not query the database for the schema cache" (PGRST002) and timeouts happen when
  // Supabase is busy: that is not a missing migration, and must not tell staff to run SQL.
  if (error.code === 'PGRST002' || /could not query|timeout|fetch failed/i.test(error.message || '')) return false;
  return /relation .* does not exist|Could not find the table .* in the schema cache/i.test(error.message || '');
}
const NOT_READY = 'The tasks / people tables are not set up yet. Run backend/supabase/RUN_PENDING_0021.sql in Supabase.';

/**
 * Everyone, with profile, teams and status.
 * @param {{ includeInactive?: boolean }} opts
 */
async function listPeople({ includeInactive = true } = {}) {
  const [usersRes, psychRes, profRes, membersRes, teamsRes] = await Promise.all([
    supabaseAdmin.from('users').select('id, email, name, role, is_active, phone_number, created_at').in('role', STAFF_USER_ROLES),
    supabaseAdmin.from('psychologists').select('id, email, first_name, last_name, designation, is_active, phone, created_at, google_calendar_credentials'),
    supabaseAdmin.from('staff_profiles').select('*'),
    supabaseAdmin.from('team_members').select('team_id, person_type, person_id'),
    supabaseAdmin.from('teams').select('id, name, lead_person_type, lead_person_id'),
  ]);
  if (usersRes.error) throw usersRes.error;
  if (psychRes.error) throw psychRes.error;
  const profiles = new Map((profRes.data || []).map((p) => [key(p.person_type, p.person_id), p]));
  const teamsById = new Map((teamsRes.data || []).map((t) => [t.id, t]));
  const teamsOf = new Map();
  (membersRes.data || []).forEach((m) => {
    const k = key(m.person_type, m.person_id);
    const t = teamsById.get(m.team_id);
    if (t) teamsOf.set(k, [...(teamsOf.get(k) || []), { id: t.id, name: t.name }]);
  });

  const calendarState = (creds) => {
    if (!creds || typeof creds !== 'object' || (!creds.refresh_token && !creds.access_token)) return 'not_connected';
    return creds.refresh_token ? 'connected' : 'needs_reconnect';
  };

  const people = [
    ...(usersRes.data || []).map((u) => {
      const k = key('user', u.id);
      const prof = profiles.get(k) || {};
      return {
        key: k, type: 'user', id: u.id, name: u.name || u.email, email: u.email, role: u.role,
        roleLabel: ROLE_LABEL[u.role] || u.role, active: u.is_active !== false && !prof.offboarded_at,
        jobTitle: prof.job_title || null, startDate: prof.start_date || null, salaryMonthly: prof.salary_monthly ?? null,
        phone: prof.phone || u.phone_number || null, offboardedAt: prof.offboarded_at || null,
        teams: teamsOf.get(k) || [], createdAt: u.created_at,
      };
    }),
    ...(psychRes.data || []).map((p) => {
      const k = key('psychologist', p.id);
      const prof = profiles.get(k) || {};
      return {
        key: k, type: 'psychologist', id: p.id, name: psychName(p), email: p.email, role: 'psychologist',
        roleLabel: 'Therapist', active: p.is_active !== false && !prof.offboarded_at,
        jobTitle: prof.job_title || p.designation || null, startDate: prof.start_date || null,
        salaryMonthly: prof.salary_monthly ?? null, phone: prof.phone || p.phone || null,
        offboardedAt: prof.offboarded_at || null, teams: teamsOf.get(k) || [],
        calendar: calendarState(p.google_calendar_credentials), createdAt: p.created_at,
      };
    }),
  ];
  return includeInactive ? people : people.filter((p) => p.active);
}

/** { 'user:<id>': 'Name', 'psychologist:<id>': 'Name', 'team:<id>': 'Team' } for the given refs. */
async function namesFor(refs) {
  const ids = { user: new Set(), psychologist: new Set(), team: new Set() };
  refs.filter((r) => r && r.type && r.id && ids[r.type]).forEach((r) => ids[r.type].add(r.id));
  const out = {};
  const [u, p, t] = await Promise.all([
    ids.user.size ? supabaseAdmin.from('users').select('id, name, email, role').in('id', [...ids.user]) : { data: [] },
    ids.psychologist.size ? supabaseAdmin.from('psychologists').select('id, first_name, last_name, email').in('id', [...ids.psychologist]) : { data: [] },
    ids.team.size ? supabaseAdmin.from('teams').select('id, name').in('id', [...ids.team]) : { data: [] },
  ]);
  // Non-enumerable flag: every lookup answered (callers that delete "unknown" rows check it).
  Object.defineProperty(out, COMPLETE, { value: ![u, p, t].some((r) => r.error), enumerable: false });
  (u.data || []).forEach((x) => { out[key('user', x.id)] = { name: x.name || x.email, role: x.role }; });
  (p.data || []).forEach((x) => { out[key('psychologist', x.id)] = { name: psychName(x), role: 'psychologist' }; });
  (t.data || []).forEach((x) => { out[key('team', x.id)] = { name: `${x.name} team`, role: 'team' }; });
  return out;
}

/** Team ids a person belongs to. */
async function teamIdsOf(person) {
  const { data, error } = await supabaseAdmin
    .from('team_members').select('team_id').eq('person_type', person.type).eq('person_id', person.id);
  if (error) return [];
  return (data || []).map((r) => r.team_id);
}

/** Members of a team as persons. */
async function teamMembers(teamId) {
  const { data } = await supabaseAdmin.from('team_members').select('person_type, person_id').eq('team_id', teamId);
  return (data || []).map((m) => ({ type: m.person_type, id: m.person_id }));
}

/** A team by name (the teams automatic tasks go to), created on first use. */
async function teamByName(name) {
  const { data } = await supabaseAdmin.from('teams').select('id, name, lead_person_type, lead_person_id').eq('name', name).maybeSingle();
  if (data) return data;
  const { data: created, error } = await supabaseAdmin.from('teams').insert({ name }).select('id, name, lead_person_type, lead_person_id').single();
  if (error && error.code === '23505') { // created by a parallel request a moment ago
    const again = await supabaseAdmin.from('teams').select('id, name, lead_person_type, lead_person_id').eq('name', name).maybeSingle();
    if (again.data) return again.data;
  }
  if (error) throw error;
  return created;
}

module.exports = { COMPLETE, key, psychName, listPeople, namesFor, teamIdsOf, teamMembers, teamByName, isMissingTable, NOT_READY };
