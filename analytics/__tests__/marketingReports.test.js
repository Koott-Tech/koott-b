/**
 * The marketing reports' own rules: how a date range and its comparison are
 * worked out, what the funnel is, and what a custom report is allowed to ask
 * for. These are the parts that quietly go wrong — an off-by-one at midnight,
 * a comparison against the wrong window, a dimension the database will refuse.
 *
 * The controller's Supabase calls are stubbed: this is about the arithmetic,
 * not the database.
 */

jest.mock('../../config/supabase', () => {
  const chain = {
    select: () => chain,
    eq: () => chain,
    gte: () => chain,
    order: () => chain,
    limit: () => Promise.resolve({ data: [], error: null }),
  };
  return { supabaseAdmin: { from: () => chain, rpc: () => Promise.resolve({ data: [], error: null }) } };
});

const controller = require('../../controllers/marketingController');

/** Run a report handler and give back what it answered. */
const call = (name, query = {}) => new Promise((resolve) => {
  const res = {
    set() { return this; },
    status(code) { this.code = code; return this; },
    json(body) { resolve({ status: this.code || 200, ...body }); },
  };
  controller.report({ params: { name }, query }, res).catch((e) => resolve({ status: 500, error: e.message }));
});

describe('the reporting window', () => {
  test('defaults to the last 30 days including today', async () => {
    const { scope } = await call('campaigns', {});
    expect(scope.len).toBe(30);
    expect(scope.to).toBe(scope.today);
  });

  test('a custom range is used as given', async () => {
    const { scope } = await call('campaigns', { from: '2026-03-01', to: '2026-03-31' });
    expect(scope).toMatchObject({ from: '2026-03-01', to: '2026-03-31', len: 31 });
  });

  test('reversed dates are put back in order rather than returning nothing', async () => {
    const { scope } = await call('campaigns', { from: '2026-03-31', to: '2026-03-01' });
    expect(scope).toMatchObject({ from: '2026-03-01', to: '2026-03-31' });
  });

  test('the previous period is the equal window immediately before, with no gap or overlap', async () => {
    const { scope } = await call('campaigns', { from: '2026-03-01', to: '2026-03-31' });
    expect(scope.prevTo).toBe('2026-02-28');       // the day before `from`
    expect(scope.prevFrom).toBe('2026-01-29');     // 31 days long, like the range
  });

  test('comparing with last year keeps the same calendar dates', async () => {
    const { scope } = await call('campaigns', { from: '2026-03-01', to: '2026-03-31', compare: 'year' });
    expect(scope).toMatchObject({ prevFrom: '2025-03-01', prevTo: '2025-03-31', compare: 'year' });
  });

  test('29 February a year earlier becomes 28 February, not 1 March', async () => {
    const { scope } = await call('campaigns', { from: '2024-02-29', to: '2024-02-29', compare: 'year' });
    expect(scope.prevFrom).toBe('2023-02-28');
  });

  test('a range longer than 400 days is trimmed rather than refused', async () => {
    const { scope } = await call('campaigns', { from: '2020-01-01', to: '2026-01-01' });
    expect(scope.len).toBeLessThanOrEqual(400);
    expect(scope.to).toBe('2026-01-01');
  });

  test('an unknown comparison falls back to the previous period', async () => {
    const { scope } = await call('campaigns', { compare: 'nonsense' });
    expect(scope.compare).toBe('previous');
  });
});

describe('the booking funnel', () => {
  test('has every step in order, ending at a verified payment', async () => {
    const { data } = await call('booking-funnel', {});
    expect(data.rows.map((r) => r.step)).toEqual([
      'counsellor_list_view', 'counsellor_profile_view', 'booking_started', 'phone_verified',
      'slot_selected', 'plan_selected', 'details_completed', 'checkout_started',
      'payment_opened', 'booking_completed',
    ]);
  });

  test('the first step has nothing above it to fall from', async () => {
    const { data } = await call('booking-funnel', {});
    expect(data.rows[0].toPrevious).toBeNull();
    expect(data.rows[0].dropped).toBeNull();
  });

  test('an empty period reports zeros, not NaN', async () => {
    const { data } = await call('booking-funnel', {});
    expect(data.summary).toMatchObject({ entered: 0, completed: 0, conversion: 0, abandoned: 0 });
    data.rows.forEach((r) => expect(Number.isFinite(r.ofEntry)).toBe(true));
  });
});

describe('custom reports', () => {
  test('keep only dimensions the database will accept', async () => {
    const { data } = await call('custom', { dims: 'page_group,utm_content,device_class' });
    expect(data.dims).toEqual(['page_group', 'device_class']);   // utm_content is not allowed
  });

  test('group by at most three dimensions', async () => {
    const { data } = await call('custom', { dims: 'day,channel,device_class,region,city' });
    expect(data.dims).toHaveLength(3);
  });

  test('offer only events that are actually recorded', async () => {
    const { data } = await call('custom', {});
    expect(data.available.events).toContain('booking_completed');
    expect(data.available.events).not.toContain('made_up_event');
  });
});

describe('real-time activity', () => {
  test('only accepts the windows the dashboard offers', async () => {
    expect((await call('realtime', { minutes: 15 })).data.minutes).toBe(15);
    expect((await call('realtime', { minutes: 7 })).data.minutes).toBe(15);   // not offered → default
    expect((await call('realtime', { minutes: 60 })).data.minutes).toBe(60);
  });
});

describe('unknown reports', () => {
  test('are a 404, not a 500', async () => {
    const answer = await call('nothing-like-this', {});
    expect(answer.status).toBe(404);
  });
});
