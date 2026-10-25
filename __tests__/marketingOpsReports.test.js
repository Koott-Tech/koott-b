/**
 * The arithmetic behind the marketing dashboard's operations reports.
 *
 * These are the cases the brief names, and the ones where a wrong answer would
 * be believed rather than noticed: a client counted as new twice, a cancelled
 * session still holding a slot, a booking just after midnight filed under the
 * wrong day.
 *
 * Supabase is stubbed so the shapes are fixed and the test says nothing about
 * what happens to be in the database today.
 */

const mockRows = {
  sessions: [],
  availability: [],
  psychologists: [],
  therapist_groups: [],
  slot_events: [],
};

/**
 * Enough of the query builder for these reports: the filters they use, and a
 * thenable that applies them to the fixture.
 */
function mockMakeQuery(table) {
  const filters = [];
  const q = {
    select() { return q; },
    order() { return q; },
    in(col, vals) { filters.push((r) => vals.includes(r[col])); return q; },
    eq(col, v) { filters.push((r) => r[col] === v); return q; },
    is(col, v) { filters.push((r) => (v === null ? r[col] == null : r[col] === v)); return q; },
    gte(col, v) { filters.push((r) => String(r[col] ?? '') >= v); return q; },
    lte(col, v) { filters.push((r) => String(r[col] ?? '') <= v); return q; },
    lt(col, v) { filters.push((r) => r[col] != null && String(r[col]) < v); return q; },
    maybeSingle() { return Promise.resolve({ data: apply()[0] || null, error: null }); },
    limit() { return q; },
    range(from, to) {
      const data = apply().slice(from, to + 1);
      return Promise.resolve({ data, error: null });
    },
    then(resolve) { return Promise.resolve({ data: apply(), error: null }).then(resolve); },
  };
  const apply = () => (mockRows[table] || []).filter((r) => filters.every((f) => f(r)));
  return q;
}

jest.mock('../config/supabase', () => ({
  supabaseAdmin: { from: (table) => mockMakeQuery(table) },
}));

const reports = require('../controllers/marketingOpsReports');

/** IST timestamp as the database would hold it (UTC). */
const ist = (day, hhmm) => {
  const [h, m] = hhmm.split(':').map(Number);
  return new Date(Date.parse(`${day}T00:00:00Z`) + (h * 60 + m - 330) * 60000).toISOString();
};

const session = (o) => ({
  id: o.id, client_id: o.client, psychologist_id: o.psych || 'p1',
  status: o.status || 'booked',
  booking_created_at: o.bookedAt, created_at: o.bookedAt,
  scheduled_date: o.date || '2026-10-20', scheduled_time: o.time || '18:00:00',
});

beforeEach(() => {
  Object.keys(mockRows).forEach((k) => { mockRows[k] = []; });
  mockRows.psychologists = [
    { id: 'p1', first_name: 'Ann', last_name: 'T', therapist_group_id: 'g1' },
    { id: 'p2', first_name: 'Rahul', last_name: 'K', therapist_group_id: null },
  ];
  mockRows.therapist_groups = [{ id: 'g1', name: 'Group A', color: null, sort_order: 0 }];
});

const WINDOW = { from: '2026-10-01', to: '2026-10-31', scope: 'all' };

describe('new vs returning clients', () => {
  it('counts a client once however often they book in the window', async () => {
    mockRows.sessions = [
      session({ id: 's1', client: 'c1', bookedAt: ist('2026-10-05', '10:00') }),
      session({ id: 's2', client: 'c1', bookedAt: ist('2026-10-12', '10:00') }),
      session({ id: 's3', client: 'c1', bookedAt: ist('2026-10-20', '10:00') }),
    ];
    const r = await reports.clientMix(WINDOW);
    // One person, new once, repeating twice.
    expect(r.clients.new).toBe(1);
    expect(r.sessions.new).toBe(1);
    expect(r.sessions.returning).toBe(2);
    expect(r.sessions.new + r.sessions.returning).toBe(r.sessions.total);
  });

  it('treats a client who booked before the window as returning', async () => {
    mockRows.sessions = [
      session({ id: 'old', client: 'c1', bookedAt: ist('2026-08-01', '10:00') }),
      session({ id: 's1', client: 'c1', bookedAt: ist('2026-10-05', '10:00') }),
    ];
    const r = await reports.clientMix(WINDOW);
    expect(r.clients.new).toBe(0);
    expect(r.clients.returning).toBe(1);
  });

  it('separates two first-timers from one repeat', async () => {
    mockRows.sessions = [
      session({ id: 's1', client: 'c1', bookedAt: ist('2026-10-05', '10:00') }),
      session({ id: 's2', client: 'c2', bookedAt: ist('2026-10-06', '10:00') }),
      session({ id: 's3', client: 'c1', bookedAt: ist('2026-10-07', '10:00') }),
    ];
    const r = await reports.clientMix(WINDOW);
    expect(r.sessions).toEqual({ total: 3, new: 2, returning: 1 });
    expect(r.clients.total).toBe(2);
  });

  it('does not depend on the order rows come back in', async () => {
    const a = session({ id: 's1', client: 'c1', bookedAt: ist('2026-10-05', '10:00') });
    const b = session({ id: 's2', client: 'c1', bookedAt: ist('2026-10-12', '10:00') });
    mockRows.sessions = [b, a];           // later row first
    const r = await reports.clientMix(WINDOW);
    expect(r.sessions.new).toBe(1);
    expect(r.sessions.returning).toBe(1);
  });
});

describe('booking time and session time are different questions', () => {
  it('files a booking and its session in different hours', async () => {
    // Booked at 3 PM IST for a 9 PM appointment.
    mockRows.sessions = [session({ id: 's1', client: 'c1', bookedAt: ist('2026-10-10', '15:00'), date: '2026-10-11', time: '21:00:00' })];
    const booking = await reports.bookingTime(WINDOW);
    const sess = await reports.sessionTime(WINDOW);
    expect(booking.hours[15].sessions).toBe(1);
    expect(sess.hours[21].sessions).toBe(1);
    expect(booking.peak.label).toBe('2 PM–4 PM');
    expect(sess.peak.label).toBe('8 PM–10 PM');
  });

  it('keeps a booking made just after IST midnight on that day', async () => {
    // 00:30 IST on the 10th is 19:00 UTC on the 9th. Grouping in UTC would
    // file it under the 9th and, at the edge of a window, drop it entirely.
    mockRows.sessions = [session({ id: 's1', client: 'c1', bookedAt: ist('2026-10-10', '00:30') })];
    const r = await reports.bookingTime({ from: '2026-10-10', to: '2026-10-10', scope: 'all' });
    expect(r.total).toBe(1);
    expect(r.hours[0].sessions).toBe(1);
  });

  it('reports no peak when nothing happened', async () => {
    const r = await reports.bookingTime(WINDOW);
    expect(r.total).toBe(0);
    expect(r.peak).toBeNull();
    expect(r.hours).toHaveLength(24);
    expect(r.bands).toHaveLength(12);
  });
});

describe('slots', () => {
  it('frees a slot whose session was cancelled', async () => {
    mockRows.availability = [{ psychologist_id: 'p1', date: '2026-10-20', time_slots: ['09:00', '10:00'], is_available: true }];
    mockRows.sessions = [
      session({ id: 's1', client: 'c1', bookedAt: ist('2026-10-01', '10:00'), date: '2026-10-20', time: '09:00:00', status: 'booked' }),
      session({ id: 's2', client: 'c2', bookedAt: ist('2026-10-01', '11:00'), date: '2026-10-20', time: '10:00:00', status: 'cancelled' }),
    ];
    const r = await reports.slotsAvailable(WINDOW);
    expect(r.scheduledInPeriod).toBe(2);
    // Only the live booking holds a slot; the cancelled one does not.
    expect(r.booked).toBe(1);
    expect(r.bookable).toBe(1);
  });

  it('ignores a day marked unavailable', async () => {
    mockRows.availability = [{ psychologist_id: 'p1', date: '2026-10-20', time_slots: ['09:00'], is_available: false }];
    const r = await reports.slotsAvailable(WINDOW);
    expect(r.scheduledInPeriod).toBe(0);
  });

  it('keeps booked and bookable adding up to the total', async () => {
    mockRows.availability = [
      { psychologist_id: 'p1', date: '2026-10-20', time_slots: ['09:00', '10:00', '11:00'], is_available: true },
      { psychologist_id: 'p2', date: '2026-10-21', time_slots: ['14:00'], is_available: true },
    ];
    mockRows.sessions = [session({ id: 's1', client: 'c1', bookedAt: ist('2026-10-01', '10:00'), date: '2026-10-20', time: '10:00:00' })];
    const r = await reports.slotsAvailable(WINDOW);
    expect(r.booked + r.bookable).toBe(r.scheduledInPeriod);
    expect(r.scheduledInPeriod).toBe(4);
  });
});

describe('scope', () => {
  it('returns nothing for a team with no therapists, not everything', async () => {
    mockRows.sessions = [session({ id: 's1', client: 'c1', bookedAt: ist('2026-10-05', '10:00') })];
    const ids = await reports.therapistIdsForScope('team:missing');
    expect(ids).toEqual([]);
    const r = await reports.clientMix({ ...WINDOW, scope: 'team:missing' });
    expect(r.sessions.total).toBe(0);
  });

  it('puts therapists with no team in the Ungrouped bucket', async () => {
    const list = await reports.teams();
    expect(list.map((t) => t.name)).toEqual(['Group A', 'Ungrouped']);
    expect(list.find((t) => t.id === 'ungrouped').therapists).toBe(1);
  });

  it('resolves the ungrouped scope to exactly those therapists', async () => {
    expect(await reports.therapistIdsForScope('team:ungrouped')).toEqual(['p2']);
  });

  it('adds team totals up to the overall total', async () => {
    mockRows.sessions = [
      session({ id: 's1', client: 'c1', psych: 'p1', bookedAt: ist('2026-10-05', '10:00') }),
      session({ id: 's2', client: 'c2', psych: 'p2', bookedAt: ist('2026-10-06', '10:00') }),
    ];
    const all = await reports.clientMix(WINDOW);
    const a = await reports.clientMix({ ...WINDOW, scope: 'team:g1' });
    const u = await reports.clientMix({ ...WINDOW, scope: 'team:ungrouped' });
    expect(a.sessions.total + u.sessions.total).toBe(all.sessions.total);
  });
});

describe('slot openings', () => {
  it('measures notice from the opening day to the appointment', async () => {
    mockRows.slot_events = [
      // five a week ahead
      ...['09:00', '10:00', '11:00', '12:00', '13:00'].map((t) => ({
        psychologist_id: 'p1', slot_date: '2026-10-25', slot_time: `${t}:00`,
        event: 'created', actor: 'therapist', occurred_at: ist('2026-10-18', '09:00'),
      })),
      // two more on the day
      ...['14:00', '15:00'].map((t) => ({
        psychologist_id: 'p1', slot_date: '2026-10-25', slot_time: `${t}:00`,
        event: 'opened', actor: 'therapist', occurred_at: ist('2026-10-25', '08:30'),
      })),
    ];
    const r = await reports.slotOpenings(WINDOW);
    expect(r.total).toBe(7);
    expect(r.leadTime.within7).toBe(5);
    expect(r.leadTime.sameDay).toBe(2);
    expect(r.openedByPeople).toBe(7);
  });

  it('separates the nightly job from the people', async () => {
    mockRows.slot_events = [
      { psychologist_id: 'p1', slot_date: '2026-10-25', slot_time: '09:00:00', event: 'created', actor: 'system', occurred_at: ist('2026-10-04', '00:00') },
      { psychologist_id: 'p1', slot_date: '2026-10-25', slot_time: '10:00:00', event: 'opened', actor: 'therapist', occurred_at: ist('2026-10-05', '11:00') },
      { psychologist_id: 'p1', slot_date: '2026-10-25', slot_time: '11:00:00', event: 'opened', actor: 'admin', occurred_at: ist('2026-10-05', '12:00') },
    ];
    const r = await reports.slotOpenings(WINDOW);
    expect(r.total).toBe(3);
    // Counting the cron alongside therapists would make this 3.
    expect(r.openedByPeople).toBe(2);
    expect(r.byActor.system).toBe(1);
  });

  it('leaves closures out of the opening count', async () => {
    mockRows.slot_events = [
      { psychologist_id: 'p1', slot_date: '2026-10-25', slot_time: '09:00:00', event: 'opened', actor: 'therapist', occurred_at: ist('2026-10-05', '10:00') },
      { psychologist_id: 'p1', slot_date: '2026-10-25', slot_time: '09:00:00', event: 'closed', actor: 'therapist', occurred_at: ist('2026-10-06', '10:00') },
    ];
    const r = await reports.slotOpenings(WINDOW);
    expect(r.total).toBe(1);
  });

  it('says nothing was tracked rather than nothing happened', async () => {
    const r = await reports.slotOpenings(WINDOW);
    expect(r.total).toBe(0);
    expect(r.trackingSince).toBeNull();
  });
});
