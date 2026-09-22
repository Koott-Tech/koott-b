/**
 * Analytics rules that must not drift: channel classification, page grouping,
 * and what the collector accepts or drops.
 */

jest.mock('../../config/supabase', () => {
  const inserted = [];
  const chain = {
    select: () => chain, limit: () => Promise.resolve({ data: [{ slug: 'depression-treatment' }, { slug: 'marital-counseling' }], error: null }),
    upsert: (rows) => { inserted.push(...(Array.isArray(rows) ? rows : [rows])); return Promise.resolve({ error: null }); },
    insert: (rows) => { inserted.push(...(Array.isArray(rows) ? rows : [rows])); return Promise.resolve({ error: null }); },
  };
  return { supabaseAdmin: { from: () => chain, rpc: () => Promise.resolve({ error: null }) }, __inserted: inserted };
});

const { classifyTouch, classifyPath, deviceOf, regionOf, isBot } = require('../registry');
const service = require('../analytics.service');
const { __inserted } = require('../../config/supabase');

const AID = '6b0f9f0e-2a8e-4c1a-9f1e-3c9f1d2b7a10';
const ctx = (extra = {}) => ({ anonymousId: AID, sessionId: '0f6a7f4e-1b2c-4d3e-8f9a-1b2c3d4e5f60', consent: { analytics: true }, touch: {}, ...extra });
const ev = (name, props = {}, extra = {}) => ({ id: require('crypto').randomUUID(), name, at: new Date().toISOString(), path: '/', props, ...extra });

describe('classifyTouch', () => {
  test.each([
    [{ gclid: 'abc' }, 'paid_search'],
    [{ utm_source: 'facebook', utm_medium: 'paid_social' }, 'paid_social'],
    [{ utm_source: 'instagram', utm_medium: 'cpc' }, 'paid_social'],
    [{ utm_source: 'google', utm_medium: 'cpc' }, 'paid_search'],
    [{ fbclid: 'x' }, 'organic_social'],                     // Meta tags organic links too
    [{ utm_source: 'whatsapp' }, 'whatsapp'],
    [{ utm_medium: 'email', utm_source: 'newsletter' }, 'email'],
    [{ referrer: 'https://www.google.co.in' }, 'organic_search'],
    [{ referrer: 'https://l.instagram.com' }, 'organic_social'],
    [{ referrer: 'https://example.org' }, 'referral'],
    [{ referrer: 'https://chatgpt.com/' }, 'ai_platform'],
    [{ utm_source: 'chatgpt.com' }, 'ai_platform'],
    [{ referrer: 'https://gemini.google.com/app' }, 'ai_platform'],   // not organic search
    [{ referrer: 'https://api.razorpay.com' }, 'direct'],     // payment redirects never steal the source
    [{}, 'direct'],
  ])('%j → %s', (touch, channel) => {
    expect(classifyTouch(touch).channel).toBe(channel);
  });

  test('organic search source is the engine name', () => {
    expect(classifyTouch({ referrer: 'https://www.google.co.in' }).source).toBe('google');
    expect(classifyTouch({ referrer: 'https://search.yahoo.com' }).source).toBe('yahoo');
  });
});

describe('classifyPath', () => {
  const slugs = new Set(['depression-treatment', 'marital-counseling', 'counselling-for-suicidal-tendencies']);
  test.each([
    ['/', 'home', null],
    ['/book-malayali-psychologists', 'listing', null],
    ['/therapist-profile/anjali-menon', 'profile', null],
    ['/book/anjali-menon', 'booking', null],
    ['/depression-treatment', 'condition', 'depression_mood'],
    ['/marital-counseling', 'condition', 'relationships'],
    ['/counselling-for-suicidal-tendencies', 'condition', 'trauma_crisis'],
    ['/counselling/ocd-treatment', 'condition', 'anxiety_stress'],
    ['/blog/how-to-choose', 'blog', null],
    ['/payment/success?razorpay_payment_id=pay_123', 'payment', null],
  ])('%s → %s / %s', (path, group, topic) => {
    expect(classifyPath(path, slugs)).toEqual({ group, topic });
  });
});

describe('device, region, bots', () => {
  test('device', () => {
    expect(deviceOf('Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) Mobile/15E148')).toBe('mobile');
    expect(deviceOf('Mozilla/5.0 (iPad; CPU OS 17_0 like Mac OS X)')).toBe('tablet');
    expect(deviceOf('Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36')).toBe('desktop');
  });
  test('country from time zone, never IP', () => {
    expect(regionOf('Asia/Dubai')).toBe('United Arab Emirates');
    expect(regionOf('Asia/Kolkata')).toBe('India');
    expect(regionOf('Europe/London')).toBe('United Kingdom');
    expect(regionOf('America/Chicago')).toBe('United States of America');
    expect(regionOf('Antarctica/Troll')).toBe('Other');
    expect(regionOf(null)).toBeNull();
  });
  test('bots', () => {
    expect(isBot('Googlebot/2.1')).toBe(true);
    expect(isBot('')).toBe(true);
    expect(isBot('Mozilla/5.0 (Macintosh)')).toBe(false);
  });
});

describe('recordBrowserBatch', () => {
  const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)';
  beforeEach(() => { __inserted.length = 0; });

  test('nothing is stored without analytics consent', async () => {
    const r = await service.recordBrowserBatch({ body: { context: ctx({ consent: { analytics: false } }), events: [ev('page_view')] }, userAgent: UA });
    expect(r).toMatchObject({ accepted: 0, reason: 'no_consent' });
    expect(__inserted).toHaveLength(0);
  });

  test('valid events are stored; unknown events, extra props and server-only names are dropped', async () => {
    const r = await service.recordBrowserBatch({
      userAgent: UA,
      body: {
        context: ctx({ touch: { utm_source: 'facebook', utm_medium: 'paid_social', utm_campaign: 'uae' } }),
        events: [
          ev('page_view'),
          ev('ui_click', { element: 'hero_consult_now' }),
          ev('ui_click', { element: 'Hero Consult!' }),          // bad id
          ev('scroll_depth', { depth: 33 }),                      // not an allowed depth
          ev('page_view', { email: 'a@b.c' }),                    // unknown prop
          ev('booking_completed', {}, { value: 999 }),            // server-only
          ev('made_up_event'),
          ev('checkout_started', { item_kind: 'session' }, { value: 1299, psychologistId: '11111111-2222-4333-8444-555555555555' }),
        ],
      },
    });
    expect(r).toEqual({ accepted: 3, rejected: 5 });
    const names = __inserted.map((x) => x.event_name);
    expect(names).toEqual(['page_view', 'ui_click', 'checkout_started']);
    const checkout = __inserted[2];
    expect(checkout).toMatchObject({ channel: 'paid_social', utm_campaign: 'uae', value: 1299, currency: 'INR', device_class: 'desktop' });
  });

  test('staff pages are never recorded, and query strings are stripped', async () => {
    await service.recordBrowserBatch({
      userAgent: UA,
      body: { context: ctx(), events: [ev('page_view', {}, { path: '/admin/bookings' }), ev('page_view', {}, { path: '/payment/success?razorpay_payment_id=pay_1' })] },
    });
    expect(__inserted).toHaveLength(1);
    expect(__inserted[0].page_path).toBe('/payment/success');
  });

  test('a filter value is kept only as a short label', async () => {
    const r = await service.recordBrowserBatch({
      userAgent: UA,
      body: { context: ctx(), events: [ev('filter_applied', { filter: 'concern', value: 'Anxiety' }), ev('filter_applied', { filter: 'concern', value: 'x'.repeat(200) })] },
    });
    expect(r).toEqual({ accepted: 1, rejected: 1 });
  });
});
