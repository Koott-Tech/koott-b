/**
 * Marketing dashboard API (/api/marketing/*) — the same two reports Koott had
 * on Wix: Analytics Highlights and Traffic Overview.
 *
 * Roles: marketing, admin, superadmin. Answers are totals only (counts and
 * sums from the reporting functions in migrations 0011–0012): no names,
 * phones, emails or individual journeys. Sales and bookings come from the
 * payments and sessions tables; visits and clicks from first-party events
 * (visitors who accepted analytics cookies).
 */

const { supabaseAdmin } = require('../config/supabase');
const { isMissingTable } = require('../analytics/analytics.service');
const meta = require('../analytics/providers/meta');
const { searchSummary, searchQueries } = require('../analytics/searchConsole');

const ENVS = ['production', 'staging', 'development'];

const istToday = () => new Date(Date.now() + 5.5 * 3600000).toISOString().slice(0, 10);
const addDays = (d, n) => { const x = new Date(`${d}T00:00:00Z`); x.setUTCDate(x.getUTCDate() + n); return x.toISOString().slice(0, 10); };
const daysBetween = (a, b) => Math.round((Date.parse(`${b}T00:00:00Z`) - Date.parse(`${a}T00:00:00Z`)) / 86400000) + 1;
const isDate = (s) => typeof s === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(s) && !Number.isNaN(Date.parse(s));

/** Same calendar date a year earlier; 29 Feb becomes 28 Feb. */
const yearBefore = (d) => {
  const [y, m, day] = d.split('-').map(Number);
  const lastDay = new Date(Date.UTC(y - 1, m, 0)).getUTCDate();
  return `${y - 1}-${String(m).padStart(2, '0')}-${String(Math.min(day, lastDay)).padStart(2, '0')}`;
};

const COMPARE = ['previous', 'year', 'none'];

/**
 * The reporting window, and what it is compared with.
 *
 *   previous  the equal-length window immediately before (the default)
 *   year      the same calendar dates a year earlier
 *   none      no comparison is shown; the previous window is still computed so
 *             a report never has to special-case its absence
 *
 * Dates are IST calendar days: a day runs 00:00–24:00 Asia/Kolkata, which is
 * what the reporting functions in 0011–0013 group by.
 */
function scopeOf(q) {
  let to = isDate(q.to) ? q.to : istToday();
  let from = isDate(q.from) ? q.from : addDays(to, -29);
  if (from > to) [from, to] = [to, from];
  if (daysBetween(from, to) > 400) from = addDays(to, -399);
  const len = daysBetween(from, to);
  const compare = COMPARE.includes(q.compare) ? q.compare : 'previous';
  const [prevFrom, prevTo] = compare === 'year'
    ? [yearBefore(from), yearBefore(to)]
    : [addDays(from, -len), addDays(from, -1)];
  return {
    from, to, len, prevFrom, prevTo, compare,
    env: ENVS.includes(q.env) ? q.env : 'production',
    today: istToday(),
  };
}

class NotReady extends Error {}
const fail = (error) => { if (isMissingTable(error)) throw new NotReady(); throw error; };

async function counts(s, events, dims = [], { prev = false, from, to, limit = 500 } = {}) {
  const { data, error } = await supabaseAdmin.rpc('mkt_event_counts', {
    p_from: from || (prev ? s.prevFrom : s.from),
    p_to: to || (prev ? s.prevTo : s.to),
    p_env: s.env, p_events: events, p_dims: dims,
    p_channel: null, p_device: null, p_model: 'last', p_limit: limit,
  });
  if (error) fail(error);
  return (data || []).map((r) => ({ ...(r.dims || {}), events: Number(r.events), visitors: Number(r.visitors), sessions: Number(r.sessions), value: Number(r.value) }));
}
async function rpc(fn, args) {
  const { data, error } = await supabaseAdmin.rpc(fn, args);
  if (error) fail(error);
  return data || [];
}
const sales = (from, to, group) => rpc('mkt_sales', { p_from: from, p_to: to, p_group: group })
  .then((rows) => rows.map((r) => ({ key: r.key, orders: Number(r.orders), revenue: Number(r.revenue) })));
const bookings = (from, to, group) => rpc('mkt_bookings', { p_from: from, p_to: to, p_group: group })
  .then((rows) => rows.map((r) => ({ key: r.key, bookings: Number(r.bookings) })));

const sum = (rows, k) => rows.reduce((t, r) => t + (r[k] || 0), 0);
const byKey = (rows, key) => Object.fromEntries(rows.map((r) => [r[key], r]));
const days = (s) => Array.from({ length: s.len }, (_, i) => addDays(s.from, i));

/** "Facebook (Paid)", "Google (Organic)", "Direct" — the way Wix names traffic sources. */
const CAP = { facebook: 'Facebook', fb: 'Facebook', meta: 'Facebook', instagram: 'Instagram', ig: 'Instagram', google: 'Google', bing: 'Bing', youtube: 'YouTube', linkedin: 'LinkedIn', whatsapp: 'WhatsApp', newsletter: 'Email', duckduckgo: 'DuckDuckGo', yahoo: 'Yahoo', chatgpt: 'ChatGPT', openai: 'ChatGPT', perplexity: 'Perplexity', gemini: 'Gemini', claude: 'Claude', copilot: 'Copilot', deepseek: 'DeepSeek', grok: 'Grok' };
function sourceLabel(channel, source) {
  const base = String(source || '').replace(/^(l|lm|m|www)\./, '').split('.')[0].toLowerCase();
  const name = CAP[base] || (base ? base.charAt(0).toUpperCase() + base.slice(1) : '');
  switch (channel) {
    case 'direct': return 'Direct';
    case 'paid_social': return `${name || 'Social'} (Paid)`;
    case 'paid_search': return `${name || 'Google'} (Paid)`;
    case 'organic_search': return `${name || 'Search'} (Organic)`;
    case 'organic_social': return `${name || 'Social'} (Organic)`;
    case 'whatsapp': return 'WhatsApp';
    case 'email': return 'Email';
    case 'ai_platform': return name || 'AI assistant';
    case 'referral': return name ? `${name} (Referral)` : 'Referral';
    default: return 'Unknown source';
  }
}
const groupBy = (rows, labelOf, field) => {
  const out = {};
  rows.forEach((r) => { const l = labelOf(r); out[l] = (out[l] || 0) + (r[field] || 0); });
  return out;
};

/* ------------------------------------------------------------------ Highlights */

async function highlightsData(s) {
  const yesterday = addDays(s.today, -1);
  const near = { from: yesterday, to: s.today };
  const [
    tot, totPrev, daily, near2,
    contactDaily, contactPrev, contactNear,
    salesDaily, salesPrev, salesNear,
    bookDaily, bookPrev, bookNear,
    blogDaily, blogPrev, blogNear,
    topItems, topItemsPrev, bySource, bySourcePrev,
    sources, sourcesPrev, countries,
    pages, pagesPrev, stats, statsPrev, buttons,
    blogPaths, blogPathsPrev, heat,
    posts, metaRows, search,
  ] = await Promise.all([
    counts(s, null, []), counts(s, null, [], { prev: true }), counts(s, null, ['day']), counts(s, null, ['day'], near),
    counts(s, ['contact_clicked'], ['day']), counts(s, ['contact_clicked'], [], { prev: true }), counts(s, ['contact_clicked'], ['day'], near),
    sales(s.from, s.to, 'day'), sales(s.prevFrom, s.prevTo, 'total'), sales(yesterday, s.today, 'day'),
    bookings(s.from, s.to, 'day'), bookings(s.prevFrom, s.prevTo, 'total'), bookings(yesterday, s.today, 'day'),
    counts(s, ['page_view'], ['day', 'page_group']), counts(s, ['page_view'], ['page_group'], { prev: true }), counts(s, ['page_view'], ['day', 'page_group'], near),
    sales(s.from, s.to, 'psychologist'), sales(s.prevFrom, s.prevTo, 'psychologist'),
    sales(s.from, s.to, 'source'), sales(s.prevFrom, s.prevTo, 'source'),
    counts(s, null, ['channel', 'utm_source']), counts(s, null, ['channel', 'utm_source'], { prev: true }), counts(s, null, ['region']),
    counts(s, ['page_view'], ['page_path'], { limit: 50 }), counts(s, ['page_view'], ['page_path'], { prev: true, limit: 200 }),
    rpc('mkt_session_stats', { p_from: s.from, p_to: s.to, p_env: s.env }), rpc('mkt_session_stats', { p_from: s.prevFrom, p_to: s.prevTo, p_env: s.env }),
    counts(s, ['ui_click'], ['element', 'page_path'], { limit: 20 }),
    rpc('mkt_path_engagement', { p_from: s.from, p_to: s.to, p_env: s.env, p_prefix: '/blog/' }),
    rpc('mkt_path_engagement', { p_from: s.prevFrom, p_to: s.prevTo, p_env: s.env, p_prefix: '/blog/' }),
    counts(s, ['page_view'], ['dow', 'hour', 'page_group'], { limit: 2000 }),
    supabaseAdmin.from('blogs').select('slug, title, featured_image_url, published_at').eq('status', 'published').order('published_at', { ascending: false }).limit(3),
    supabaseAdmin.from('analytics_outbox').select('status, last_error, created_at').eq('provider', 'meta')
      .gte('created_at', new Date(`${s.from}T00:00:00+05:30`).toISOString()).limit(5000),
    searchSummary({ from: s.from, to: s.to, prevFrom: s.prevFrom, prevTo: s.prevTo }),
  ]);

  const dayList = days(s);
  const dMap = byKey(daily, 'day'); const nMap = byKey(near2, 'day');
  const series = (map, pick) => dayList.map((d) => pick(map[d]));
  const tdy = (map, pick) => ({ today: pick(map[s.today]), yesterday: pick(map[yesterday]) });
  const cD = byKey(contactDaily, 'day'); const cN = byKey(contactNear, 'day');
  const sD = byKey(salesDaily, 'key'); const sN = byKey(salesNear, 'key');
  const bD = byKey(bookDaily, 'key'); const bN = byKey(bookNear, 'key');
  const blogOnly = (rows) => rows.filter((r) => r.page_group === 'blog');
  const pvD = byKey(blogOnly(blogDaily), 'day'); const pvN = byKey(blogOnly(blogNear), 'day');
  const n = (x, k) => (x ? x[k] || 0 : 0);

  const keyStats = {
    sessions: { value: tot[0]?.sessions || 0, prev: totPrev[0]?.sessions || 0, spark: series(dMap, (x) => n(x, 'sessions')), ...tdy(nMap, (x) => n(x, 'sessions')) },
    contactClicks: { value: sum(contactDaily, 'events'), prev: contactPrev[0]?.events || 0, spark: series(cD, (x) => n(x, 'events')), ...tdy(cN, (x) => n(x, 'events')) },
    totalSales: { value: sum(salesDaily, 'revenue'), prev: salesPrev[0]?.revenue || 0, spark: series(sD, (x) => n(x, 'revenue')), ...tdy(sN, (x) => n(x, 'revenue')) },
    totalOrders: { value: sum(salesDaily, 'orders'), prev: salesPrev[0]?.orders || 0, spark: series(sD, (x) => n(x, 'orders')), ...tdy(sN, (x) => n(x, 'orders')) },
    uniqueVisitors: { value: tot[0]?.visitors || 0, prev: totPrev[0]?.visitors || 0, spark: series(dMap, (x) => n(x, 'visitors')), ...tdy(nMap, (x) => n(x, 'visitors')) },
    bookings: { value: sum(bookDaily, 'bookings'), prev: bookPrev[0]?.bookings || 0, spark: series(bD, (x) => n(x, 'bookings')), ...tdy(bN, (x) => n(x, 'bookings')) },
    postViews: { value: sum(blogOnly(blogDaily), 'events'), prev: blogOnly(blogPrev)[0]?.events || 0, spark: series(pvD, (x) => n(x, 'events')), ...tdy(pvN, (x) => n(x, 'events')) },
  };

  // Track your sales
  const ids = topItems.map((r) => r.key).filter(Boolean);
  const { data: ps } = ids.length
    ? await supabaseAdmin.from('psychologists').select('id, first_name, last_name, cover_image_url, profile_picture_url').in('id', ids)
    : { data: [] };
  const who = byKey(ps || [], 'id'); const itemsPrev = byKey(topItemsPrev, 'key');
  const topSelling = topItems.sort((a, b) => b.revenue - a.revenue).slice(0, 3).map((r) => ({
    name: who[r.key] ? `${who[r.key].first_name || ''} ${who[r.key].last_name || ''}`.trim() : 'Therapist',
    photo: who[r.key]?.cover_image_url || who[r.key]?.profile_picture_url || null,
    itemsSold: r.orders, revenue: r.revenue, prevRevenue: itemsPrev[r.key]?.revenue || 0,
  }));
  const srcLabel = (r) => { const [ch, src] = String(r.key).split('|'); return sourceLabel(ch, src); };
  const srcNow = groupBy(bySource, srcLabel, 'revenue'); const srcPrev = groupBy(bySourcePrev, srcLabel, 'revenue');
  const salesBySource = Object.entries(srcNow).sort((a, b) => b[1] - a[1]).slice(0, 3).map(([label, revenue]) => ({ label, revenue, prev: srcPrev[label] || 0 }));

  // Get to know your visitors
  const tsNow = groupBy(sources, (r) => sourceLabel(r.channel, r.utm_source), 'sessions');
  const tsPrev = groupBy(sourcesPrev, (r) => sourceLabel(r.channel, r.utm_source), 'sessions');
  const topSources = Object.entries(tsNow).sort((a, b) => b[1] - a[1]).map(([label, sessions]) => ({ label, sessions, prev: tsPrev[label] || 0 }));

  // Explore visitor engagement
  const pPrev = byKey(pagesPrev, 'page_path');
  const topPages = pages.filter((p) => p.page_path).sort((a, b) => b.sessions - a.sessions).slice(0, 3)
    .map((p) => ({ path: p.page_path, sessions: p.sessions, prev: pPrev[p.page_path]?.sessions || 0 }));
  const st = (x) => ({
    pagesPerSession: x?.sessions ? Number(x.page_views) / Number(x.sessions) : 0,
    avgDuration: Number(x?.avg_duration_seconds) || 0,
    bounceRate: Number(x?.bounce_rate) || 0,
  });

  // Monitor blog performance
  const bNow = byKey(blogPaths.map((r) => ({ ...r, views: Number(r.views), clicks: Number(r.clicks), avg: Number(r.avg_seconds) })), 'page_path');
  const bPrev = byKey(blogPathsPrev, 'page_path');
  const blogPosts = (posts.data || []).map((p) => {
    const path = `/blog/${p.slug}`;
    return { title: p.title, image: p.featured_image_url, publishedAt: p.published_at, path, views: bNow[path]?.views || 0, clicks: bNow[path]?.clicks || 0, avgReadSeconds: bNow[path]?.avg || 0, prevViews: Number(bPrev[path]?.views) || 0 };
  });
  const heatmap = Array.from({ length: 7 }, () => Array(12).fill(0));
  heat.filter((r) => r.page_group === 'blog').forEach((r) => { heatmap[Number(r.dow)][Math.floor(Number(r.hour) / 2)] += r.events; });

  // Meta (set up, not sending)
  const mr = metaRows.data || [];
  const metaStatus = {
    ...meta.status(),
    prepared: mr.length,
    held: mr.filter((r) => r.status === 'skipped').length,
    sent: mr.filter((r) => r.status === 'sent').length,
    failed: mr.filter((r) => ['failed', 'dead_letter'].includes(r.status)).length,
    holdReason: meta.holdReason(),
  };

  return {
    keyStats,
    sales: { topSelling, bySource: salesBySource },
    visitors: {
      sessionsOverTime: dayList.map((d) => ({ day: d, sessions: n(dMap[d], 'sessions') })),
      topSources: topSources.slice(0, 3),
      countries: countries.filter((c) => c.region).sort((a, b) => b.sessions - a.sessions).map((c) => ({ country: c.region, sessions: c.sessions })),
    },
    engagement: {
      topPages,
      stats: { current: st(stats[0]), previous: st(statsPrev[0]) },
      buttons: buttons.sort((a, b) => b.events - a.events).slice(0, 3).map((b) => ({ element: b.element, path: b.page_path, clicks: b.events })),
    },
    marketing: { search, meta: metaStatus },
    blog: { posts: blogPosts, heatmap },
  };
}

/* ------------------------------------------------------------------ Traffic */

async function trafficData(s) {
  const [tot, totPrev, daily, dailyPrev, src, srcPrev, dow, split, devices, countries, pages, pagesPrev] = await Promise.all([
    counts(s, null, []), counts(s, null, [], { prev: true }),
    counts(s, null, ['day']), counts(s, null, ['day'], { prev: true }),
    counts(s, null, ['channel', 'utm_source']), counts(s, null, ['channel', 'utm_source'], { prev: true }),
    counts(s, null, ['dow']),
    rpc('mkt_visitor_split', { p_from: s.from, p_to: s.to, p_env: s.env }),
    counts(s, null, ['device_class']),
    counts(s, null, ['region']),
    counts(s, ['page_view'], ['page_path'], { limit: 300 }), counts(s, ['page_view'], ['page_path'], { prev: true, limit: 300 }),
  ]);
  const dayList = days(s);
  const cur = byKey(daily, 'day'); const prv = byKey(dailyPrev, 'day');
  const sNow = groupBy(src, (r) => sourceLabel(r.channel, r.utm_source), 'sessions');
  const sPrev = groupBy(srcPrev, (r) => sourceLabel(r.channel, r.utm_source), 'sessions');

  // average sessions per weekday = sessions on that weekday ÷ how many of that weekday the range has
  const weekdayCount = Array(7).fill(0);
  dayList.forEach((d) => { weekdayCount[new Date(`${d}T00:00:00Z`).getUTCDay()] += 1; });
  const dowMap = byKey(dow, 'dow');

  // Traffic insights: the page whose sessions fell (or rose) most against the previous period
  const before = byKey(pagesPrev, 'page_path');
  const changes = pages.filter((p) => p.page_path).map((p) => ({ path: p.page_path, now: p.sessions, before: before[p.page_path]?.sessions || 0 }));
  pagesPrev.forEach((p) => { if (p.page_path && !changes.some((c) => c.path === p.page_path)) changes.push({ path: p.page_path, now: 0, before: p.sessions }); });
  const insights = [];
  const drops = changes.filter((c) => c.before >= 20 && c.now < c.before * 0.7).sort((a, b) => (a.now / a.before) - (b.now / b.before));
  const rises = changes.filter((c) => c.now >= 20 && c.now > Math.max(1, c.before) * 1.5).sort((a, b) => (b.now / Math.max(1, b.before)) - (a.now / Math.max(1, a.before)));
  drops.slice(0, 3).forEach((c) => insights.push({ kind: 'drop', path: c.path, now: c.now, before: c.before }));
  rises.slice(0, 3).forEach((c) => insights.push({ kind: 'rise', path: c.path, now: c.now, before: c.before }));

  const newV = Number(split[0]?.new_visitors) || 0; const retV = Number(split[0]?.returning_visitors) || 0;
  return {
    sessions: tot[0]?.sessions || 0, prevSessions: totPrev[0]?.sessions || 0,
    visitors: tot[0]?.visitors || 0, prevVisitors: totPrev[0]?.visitors || 0,
    sessionsOverTime: dayList.map((d, i) => ({ day: d, sessions: cur[d]?.sessions || 0, previous: prv[addDays(s.prevFrom, i)]?.sessions || 0 })),
    sources: Object.entries(sNow).sort((a, b) => b[1] - a[1]).slice(0, 6).map(([label, sessions]) => ({ label, sessions, prev: sPrev[label] || 0 })),
    avgByDay: Array.from({ length: 7 }, (_, i) => ({ dow: i, avg: weekdayCount[i] ? (dowMap[String(i)]?.sessions || 0) / weekdayCount[i] : 0 })),
    newVsReturning: { total: newV + retV, new: newV, returning: retV },
    devices: ['mobile', 'desktop', 'tablet'].map((d) => ({ device: d, sessions: devices.find((x) => x.device_class === d)?.sessions || 0 })),
    countries: countries.filter((c) => c.region).sort((a, b) => b.sessions - a.sessions).map((c) => ({ country: c.region, sessions: c.sessions })),
    insights,
  };
}


/* ------------------------------------------------------------------ detailed reports */

const CATEGORY = {
  paid_social: 'Paid social', paid_search: 'Paid search', organic_search: 'Organic search', organic_social: 'Organic social',
  direct: 'Direct', referral: 'Referral', email: 'Automated emails', ai_platform: 'AI platforms', whatsapp: 'WhatsApp', unattributed: 'Unknown',
};
const SOURCE_NAME = (channel, source) => {
  if (channel === 'direct') return 'Direct';
  // gemini.google.com → Gemini, not Google
  const host = String(source || '').replace(/^(l|lm|m|www|chat)\./, '').toLowerCase();
  const base = channel === 'ai_platform' && host.endsWith('.google.com') ? host.split('.')[0] : host.split('.')[0];
  return CAP[base] || (base ? base.charAt(0).toUpperCase() + base.slice(1) : '—');
};
const DEVICES = ['mobile', 'desktop', 'tablet'];
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
/** The booking funnel, in order — the same list as mkt_funnel_step_order (0013). */
const FUNNEL = [
  ['counsellor_list_view', 'Viewed the therapist list'],
  ['counsellor_profile_view', 'Viewed a therapist profile'],
  ['booking_started', 'Started booking'],
  ['phone_verified', 'Verified their number'],
  ['slot_selected', 'Chose a date and time'],
  ['plan_selected', 'Chose a plan'],
  ['details_completed', 'Filled in their details'],
  ['checkout_started', 'Reached checkout'],
  ['payment_opened', 'Opened payment'],
  ['booking_completed', 'Paid — booking confirmed'],
];
const LABEL_OF = Object.fromEntries(FUNNEL);
const LABEL_AT = Object.fromEntries(FUNNEL.map(([step, label], i) => [i + 1, label]));

/** What a custom report may group by — the dimensions mkt_event_counts allows. */
const DIMENSIONS = [
  'day', 'dow', 'hour', 'channel', 'utm_source', 'utm_medium', 'utm_campaign',
  'device_class', 'region', 'city', 'page_path', 'page_group', 'page_topic',
  'landing_group', 'landing_topic', 'element', 'target', 'psychologist_id',
];
/** Events worth grouping by name in a custom report. */
const REPORTABLE_EVENTS = [
  'page_view', 'page_engaged', 'scroll_depth', 'ui_click', 'filter_applied', 'contact_clicked',
  'counsellor_list_view', 'counsellor_profile_view', 'booking_started', 'phone_verified',
  'slot_selected', 'plan_selected', 'details_completed', 'checkout_started', 'payment_opened',
  'booking_completed', 'booking_cancelled', 'payment_failed', 'payment_attempt_failed',
  'js_error', 'api_error', 'booking_step_error', 'registration_completed', 'login_completed', 'web_vital',
];

/**
 * One session's events in order. Props are the registry's own ids, enums and
 * numbers (analytics/registry.js) — there is no free text in them to leak.
 */
async function timeline(s, sessionId) {
  const { data, error } = await supabaseAdmin
    .from('analytics_events')
    .select('event_name, occurred_at, page_path, page_group, channel, utm_source, utm_campaign, device_class, region, value, props')
    .eq('session_id', sessionId)
    .eq('environment', s.env)
    .order('occurred_at', { ascending: true })
    .limit(500);
  if (error) fail(error);
  const rows = (data || []).map((e) => ({
    event: e.event_name,
    at: e.occurred_at,
    path: e.page_path,
    group: e.page_group,
    step: LABEL_OF[e.event_name] || null,
    value: e.event_name === 'booking_completed' ? Number(e.value) || null : null,
    props: e.props && Object.keys(e.props).length ? e.props : null,
  }));
  const first = data?.[0] || {};
  return {
    id: sessionId,
    startedAt: rows[0]?.at || null,
    endedAt: rows[rows.length - 1]?.at || null,
    channel: first.channel || null,
    source: first.utm_source || null,
    campaign: first.utm_campaign || null,
    device: first.device_class || null,
    region: first.region || null,
    truncated: rows.length >= 500,
    rows,
  };
}
const splitOf = (q) => (q.split === 'device' ? 'device' : null);
const MODELS = ['last_non_direct', 'last_non_direct_facebook', 'last_non_direct_google', 'first', 'last'];
const displayCountry = (c) => (c === 'United States of America' ? 'United States' : c);
const weekdayCounts = (s) => { const w = Array(7).fill(0); days(s).forEach((d) => { w[new Date(`${d}T00:00:00Z`).getUTCDay()] += 1; }); return w; };

const REPORTS = {
  /** Traffic over Time: group by day / week / month. */
  async 'traffic-over-time'(s, q) {
    const grain = ['day', 'week', 'month'].includes(q.grain) ? q.grain : 'day';
    const [rows, tot, stats] = await Promise.all([
      rpc('mkt_period_stats', { p_from: s.from, p_to: s.to, p_env: s.env, p_grain: grain }),
      counts(s, null, []),
      rpc('mkt_session_stats', { p_from: s.from, p_to: s.to, p_env: s.env }),
    ]);
    const st = stats[0] || {};
    return {
      grain,
      summary: { pageViews: Number(st.page_views) || 0, sessions: tot[0]?.sessions || 0, visitors: tot[0]?.visitors || 0, bounceRate: Number(st.bounce_rate) || 0, avgDuration: Number(st.avg_duration_seconds) || 0 },
      rows: rows.map((r) => ({ period: r.period, pageViews: Number(r.page_views), sessions: Number(r.sessions), visitors: Number(r.visitors), bounceRate: Number(r.bounce_rate), avgDuration: Number(r.avg_duration_seconds), pagesPerSession: Number(r.sessions) ? Number(r.page_views) / Number(r.sessions) : 0 })),
    };
  },

  /** Top Traffic Sources: attribution model (see mkt_source_stats in 0013), optional device split. */
  async 'traffic-sources'(s, q) {
    const model = MODELS.includes(q.model) ? q.model : 'last_non_direct';
    const split = splitOf(q);
    const stats = (p_split) => rpc('mkt_source_stats', { p_from: s.from, p_to: s.to, p_env: s.env, p_model: model, p_split });
    const [rows, bySplit, tot] = await Promise.all([stats(null), split ? stats('device') : [], counts(s, null, [])]);
    const bySource = {};
    rows.forEach((r) => {
      const c = r.channel || 'unattributed';
      const name = SOURCE_NAME(c, r.source);
      const k = `${name}|${c}`;
      bySource[k] ||= { source: name, category: CATEGORY[c] || c, sessions: 0, visitors: 0 };
      bySource[k].sessions += Number(r.sessions); bySource[k].visitors += Number(r.visitors);
    });
    const byCategory = {};
    Object.values(bySource).forEach((r) => { byCategory[r.category] = (byCategory[r.category] || 0) + r.sessions; });
    return {
      model, split,
      summary: { sessions: tot[0]?.sessions || 0, visitors: tot[0]?.visitors || 0 },
      categories: Object.entries(byCategory).sort((a, b) => b[1] - a[1]).map(([category, sessions]) => ({ category, sessions })),
      rows: Object.values(bySource).sort((a, b) => b.sessions - a.sessions),
      splits: bySplit.map((r) => ({ key: CATEGORY[r.channel] || r.channel || 'Unknown', device: r.split, sessions: Number(r.sessions), visitors: Number(r.visitors) })),
    };
  },

  /** Traffic by Location: city (with country) and country totals for the map. */
  async location(s) {
    const [cities, views, countries, countryViews, tot, totViews] = await Promise.all([
      counts(s, null, ['region', 'city'], { limit: 2000 }),
      counts(s, ['page_view'], ['region', 'city'], { limit: 2000 }),
      counts(s, null, ['region'], { limit: 300 }),
      counts(s, ['page_view'], ['region'], { limit: 300 }),
      counts(s, null, []),
      counts(s, ['page_view'], []),
    ]);
    const pv = Object.fromEntries(views.map((r) => [`${r.region}|${r.city}`, r.events]));
    return {
      summary: { pageViews: totViews[0]?.events || 0, sessions: tot[0]?.sessions || 0, visitors: tot[0]?.visitors || 0 },
      countries: countries.filter((c) => c.region).map((c) => ({
        country: c.region, label: displayCountry(c.region), sessions: c.sessions, visitors: c.visitors,
        pageViews: countryViews.find((v) => v.region === c.region)?.events || 0,
      })),
      rows: cities.map((r) => ({ city: r.city || 'Unknown', country: r.region ? displayCountry(r.region) : 'Unknown', pageViews: pv[`${r.region}|${r.city}`] || 0, sessions: r.sessions, visitors: r.visitors }))
        .sort((a, b) => b.sessions - a.sessions),
    };
  },

  /** Page Visits: by page (default) or by day. */
  async 'page-visits'(s, q) {
    const group = q.group === 'day' ? 'day' : 'page';
    const split = splitOf(q);
    const [paths, tot, stats, bySplit] = await Promise.all([
      rpc('mkt_path_stats', { p_from: s.from, p_to: s.to, p_env: s.env, p_prefix: '' }),
      counts(s, null, []),
      rpc('mkt_session_stats', { p_from: s.from, p_to: s.to, p_env: s.env }),
      split ? counts(s, ['page_view'], ['page_path', 'device_class'], { limit: 5000 }) : [],
    ]);
    const splits = bySplit.map((r) => ({ key: r.page_path, device: r.device_class || 'unknown', pageViews: r.events, sessions: r.sessions, visitors: r.visitors }));
    const st = stats[0] || {};
    const pages = paths.map((r) => ({ path: r.page_path, pageViews: Number(r.views), sessions: Number(r.sessions), visitors: Number(r.visitors) })).filter((r) => r.pageViews > 0);
    const summary = { pageViews: Number(st.page_views) || 0, sessions: tot[0]?.sessions || 0, visitors: tot[0]?.visitors || 0, pagesPerSession: Number(st.sessions) ? Number(st.page_views) / Number(st.sessions) : 0, avgDuration: Number(st.avg_duration_seconds) || 0, bounceRate: Number(st.bounce_rate) || 0 };
    const top = [...pages].sort((a, b) => b.pageViews - a.pageViews).slice(0, 8);
    if (group === 'page') return { group, split, summary, top, splits, rows: pages.sort((a, b) => b.sessions - a.sessions) };
    const byDay = await rpc('mkt_period_stats', { p_from: s.from, p_to: s.to, p_env: s.env, p_grain: 'day' });
    return {
      group, split, summary, top, splits,
      rows: byDay.map((r) => ({ period: r.period, sessions: Number(r.sessions), visitors: Number(r.visitors), pagesPerSession: Number(r.sessions) ? Number(r.page_views) / Number(r.sessions) : 0, avgDuration: Number(r.avg_duration_seconds), bounceRate: Number(r.bounce_rate) })),
    };
  },

  /**
   * Button Clicks, the way Wix counts them: unique clicks = people who clicked,
   * unique visitors = everyone on the site in the period, CTR = the two divided.
   */
  async 'button-clicks'(s, q) {
    const split = splitOf(q);
    const [clicks, clickers, tot, bySplit] = await Promise.all([
      counts(s, ['ui_click'], ['element', 'page_path', 'target'], { limit: 1000 }),
      counts(s, ['ui_click'], []),
      counts(s, null, []),
      split ? counts(s, ['ui_click'], ['element', 'device_class'], { limit: 1000 }) : [],
    ]);
    const visitors = tot[0]?.visitors || 0;
    const byButton = {};
    clicks.forEach((c) => {
      byButton[c.element] ||= { element: c.element, uniqueClicks: 0, clicks: 0 };
      byButton[c.element].uniqueClicks += c.visitors; byButton[c.element].clicks += c.events;
    });
    return {
      split,
      summary: { visitors, uniqueClicks: clickers[0]?.visitors || 0, clicks: clickers[0]?.events || 0 },
      buttons: Object.values(byButton).sort((a, b) => b.uniqueClicks - a.uniqueClicks),
      rows: clicks.map((c) => ({ element: c.element, path: c.page_path, target: c.target || null, visitors, uniqueClicks: c.visitors, clicks: c.events }))
        .sort((a, b) => b.uniqueClicks - a.uniqueClicks),
      splits: bySplit.map((r) => ({ key: r.element, device: r.device_class || 'unknown', uniqueClicks: r.visitors, clicks: r.events })),
    };
  },

  /** Top Blog Posts: views and unique visitors per post. */
  async 'blog-posts'(s, q) {
    const split = splitOf(q);
    const [paths, posts, bySplit] = await Promise.all([
      rpc('mkt_path_stats', { p_from: s.from, p_to: s.to, p_env: s.env, p_prefix: '/blog/' }),
      supabaseAdmin.from('blogs').select('slug, title, featured_image_url, published_at').eq('status', 'published').limit(1000),
      split ? counts(s, ['page_view'], ['page_path', 'device_class'], { limit: 5000 }) : [],
    ]);
    const bySlug = Object.fromEntries((posts.data || []).map((p) => [`/blog/${p.slug}`, p]));
    const rows = paths.filter((r) => bySlug[r.page_path]).map((r) => {
      const p = bySlug[r.page_path];
      return { path: r.page_path, title: p.title, image: p.featured_image_url, publishedAt: p.published_at, views: Number(r.views), visitors: Number(r.visitors), clicks: Number(r.clicks), avgReadSeconds: Number(r.avg_seconds) };
    }).sort((a, b) => b.views - a.views);
    return {
      split,
      summary: { views: rows.reduce((t, r) => t + r.views, 0), visitors: rows.reduce((t, r) => t + r.visitors, 0) },
      rows,
      splits: bySplit.filter((r) => bySlug[r.page_path]).map((r) => ({ key: bySlug[r.page_path].title, device: r.device_class || 'unknown', views: r.events, visitors: r.visitors })),
    };
  },

  /** Blog Activity by Time of Day: sessions per weekday and hour, averaged over the weeks in range. */
  async 'blog-time'(s) {
    const [views, clicks] = await Promise.all([
      counts(s, ['page_view'], ['dow', 'hour', 'page_group'], { limit: 2000 }),
      counts(s, ['ui_click'], ['dow', 'hour', 'page_group'], { limit: 2000 }),
    ]);
    const w = weekdayCounts(s);
    const clk = Object.fromEntries(clicks.filter((r) => r.page_group === 'blog').map((r) => [`${r.dow}|${r.hour}`, r.events]));
    const cells = views.filter((r) => r.page_group === 'blog').map((r) => ({
      dow: Number(r.dow), hour: Number(r.hour),
      avgSessions: w[Number(r.dow)] ? r.sessions / w[Number(r.dow)] : 0,
      avgVisitors: w[Number(r.dow)] ? r.visitors / w[Number(r.dow)] : 0,
      clicks: clk[`${r.dow}|${r.hour}`] || 0, sessions: r.sessions,
    }));
    return {
      summary: {
        sessions: cells.reduce((t, c) => t + c.sessions, 0),
        avgSessions: cells.reduce((t, c) => t + c.avgSessions, 0),
        avgVisitors: cells.reduce((t, c) => t + c.avgVisitors, 0),
        clicks: cells.reduce((t, c) => t + c.clicks, 0),
      },
      cells: cells.sort((a, b) => b.avgSessions - a.avgSessions),
    };
  },

  /** Top Search Queries on Google (Search Console). */
  async 'search-queries'(s, q) {
    return searchQueries({ from: s.from, to: s.to, limit: 250, split: splitOf(q) });
  },

  /**
   * Booking Funnel: how far sessions get, and where they stop.
   *
   * Every step but the last is a browser event; booking_completed is written by
   * the payments trigger from a verified Razorpay payment. Steps are counted per
   * session and a session is not required to pass through every one, so read a
   * step as "reached", not "reached in order" — `toPrevious` can exceed 100%
   * when sessions skip a step, and that is the data telling you something.
   */
  async 'booking-funnel'(s, q) {
    const args = (from, to) => ({
      p_from: from, p_to: to, p_env: s.env,
      p_channel: q.channel && CATEGORY[q.channel] ? q.channel : null,
      p_device: DEVICES.includes(q.device) ? q.device : null,
      p_psychologist: UUID.test(String(q.therapist || '')) ? q.therapist : null,
    });
    const [now, before, dropoff] = await Promise.all([
      rpc('mkt_funnel', args(s.from, s.to)),
      rpc('mkt_funnel', args(s.prevFrom, s.prevTo)),
      rpc('mkt_funnel_dropoff', args(s.from, s.to)),
    ]);
    const at = (rows, step) => rows.find((r) => r.step === step) || {};
    const rows = FUNNEL.map(([step, label], i) => {
      const sessions = Number(at(now, step).sessions) || 0;
      const first = Number(at(now, FUNNEL[0][0]).sessions) || 0;
      const above = i ? Number(at(now, FUNNEL[i - 1][0]).sessions) || 0 : 0;
      return {
        step, label, order: i + 1,
        sessions,
        visitors: Number(at(now, step).visitors) || 0,
        prevSessions: Number(at(before, step).sessions) || 0,
        toPrevious: i === 0 ? null : (above ? sessions / above : 0),
        ofEntry: first ? sessions / first : 0,
        dropped: i === 0 ? null : Math.max(0, above - sessions),
      };
    });
    const entered = Number(at(now, 'booking_started').sessions) || 0;
    const completed = Number(at(now, 'booking_completed').sessions) || 0;
    const stopped = dropoff
      .filter((r) => r.step && r.step !== 'booking_completed')
      .map((r) => ({ step: r.step, label: LABEL_OF[r.step] || r.step, order: Number(r.step_order), sessions: Number(r.sessions) }))
      .sort((a, b) => b.sessions - a.sessions);
    return {
      filters: { channel: q.channel || null, device: q.device || null, therapist: q.therapist || null },
      summary: {
        entered,
        completed,
        conversion: entered ? completed / entered : 0,
        abandoned: Math.max(0, entered - completed),
        abandonRate: entered ? Math.max(0, entered - completed) / entered : 0,
      },
      rows,
      stopped,
    };
  },

  /**
   * Custom reports: the marketing team picks the dimensions and the events, and
   * this answers exactly that question — nothing is combined that the stored
   * data cannot answer honestly.
   *
   * Only dimensions 0011's counts function allows are offered (DIMENSIONS), and
   * only events the registry records. Sessions and visitors are distinct counts
   * within the window, so they never sum across rows — the summary is its own
   * count, not the column added up.
   */
  async custom(s, q) {
    const dims = String(q.dims || '').split(',').map((d) => d.trim()).filter((d) => DIMENSIONS.includes(d)).slice(0, 3);
    const events = String(q.events || '').split(',').map((e) => e.trim()).filter(Boolean).slice(0, 10);
    const rows = await counts(s, events.length ? events : null, dims, { limit: 1000 });
    const totals = await counts(s, events.length ? events : null, []);
    return {
      dims,
      events,
      available: { dimensions: DIMENSIONS, events: REPORTABLE_EVENTS },
      summary: {
        events: totals[0]?.events || 0,
        sessions: totals[0]?.sessions || 0,
        visitors: totals[0]?.visitors || 0,
        value: totals[0]?.value || 0,
      },
      rows: rows.map((r) => {
        const row = { events: r.events, sessions: r.sessions, visitors: r.visitors, value: r.value };
        dims.forEach((d) => { row[d] = r[d] ?? null; });
        return row;
      }).sort((a, b) => b.sessions - a.sessions),
    };
  },

  /**
   * Real-Time Activity: who is on the site now, and what each session has done.
   *
   * A session's steps are the events actually recorded for it. Nothing is
   * inferred to fill a gap — a session that jumped from the listing to checkout
   * shows exactly that, because a step we did not observe is not a step we can
   * claim. Sessions are anonymous and stay that way.
   */
  async realtime(s, q) {
    const minutes = [5, 15, 30, 60].includes(Number(q.minutes)) ? Number(q.minutes) : 15;
    const since = new Date(Date.now() - minutes * 60000).toISOString();
    const { data, error } = await supabaseAdmin
      .from('analytics_events')
      .select('session_id, anonymous_id, occurred_at, event_name, page_path, page_group, channel, utm_campaign, device_class, region')
      .eq('environment', s.env)
      .eq('is_bot', false)
      .gte('occurred_at', since)
      .order('occurred_at', { ascending: true })
      .limit(5000);
    if (error) fail(error);

    const bySession = new Map();
    (data || []).forEach((e) => {
      if (!e.session_id) return;
      const cur = bySession.get(e.session_id) || {
        session: e.session_id, startedAt: e.occurred_at, landing: e.page_path,
        channel: e.channel, campaign: e.utm_campaign, device: e.device_class, region: e.region,
        events: 0, pages: [], furthest: 0, lastEvent: null, lastAt: null,
      };
      cur.events += 1;
      cur.lastEvent = e.event_name;
      cur.lastAt = e.occurred_at;
      if (e.page_path && cur.pages[cur.pages.length - 1] !== e.page_path) cur.pages.push(e.page_path);
      const step = FUNNEL.findIndex(([name]) => name === e.event_name) + 1;
      if (step > cur.furthest) cur.furthest = step;
      bySession.set(e.session_id, cur);
    });

    const sessions = [...bySession.values()].map((c) => ({
      session: c.session,
      startedAt: c.startedAt,
      lastAt: c.lastAt,
      seconds: Math.max(0, Math.round((Date.parse(c.lastAt) - Date.parse(c.startedAt)) / 1000)),
      landing: c.landing || null,
      current: c.pages[c.pages.length - 1] || null,
      previous: c.pages.length > 1 ? c.pages[c.pages.length - 2] : null,
      pages: c.pages.length,
      events: c.events,
      lastEvent: c.lastEvent,
      stage: c.furthest ? LABEL_AT[c.furthest] : 'Browsing',
      furthest: c.furthest,
      channel: c.channel || null,
      campaign: c.campaign || null,
      device: c.device || null,
      region: c.region || null,
    })).sort((a, b) => Date.parse(b.lastAt) - Date.parse(a.lastAt));

    const tally = (key) => {
      const m = {};
      sessions.forEach((x) => { const k = x[key] || 'unknown'; m[k] = (m[k] || 0) + 1; });
      return Object.entries(m).map(([k, n]) => ({ key: k, sessions: n })).sort((a, b) => b.sessions - a.sessions);
    };
    return {
      minutes,
      generatedAt: new Date().toISOString(),
      summary: {
        sessions: sessions.length,
        visitors: new Set((data || []).map((e) => e.anonymous_id).filter(Boolean)).size,
        inBooking: sessions.filter((x) => x.furthest >= 3).length,
        booked: sessions.filter((x) => x.furthest >= 10).length,
      },
      byPage: tally('current').slice(0, 10),
      byChannel: tally('channel').slice(0, 8),
      rows: sessions,
    };
  },

  /**
   * Technical Performance: Core Web Vitals as the browser measured them, and
   * the errors visitors actually hit.
   *
   * Vitals come from `web_vital` events (frontend src/analytics/vitals.js), so
   * they are field data from real visits, not a lab score — they will not match
   * PageSpeed's simulated run, and the p75 is the number Google grades on.
   * INP is approximated by the slowest interaction's duration.
   *
   * Errors are counted from the events the site reports about itself. A page
   * that errors and a page that converts badly are two different facts: this
   * report puts them side by side, it does not claim one causes the other.
   */
  async technical(s, q) {
    const [vitals, errors, byPage, apiErrors] = await Promise.all([
      rpc('mkt_vitals', { p_from: s.from, p_to: s.to, p_env: s.env, p_group: q.group || null }),
      counts(s, ['js_error', 'api_error', 'booking_step_error', 'payment_attempt_failed'], ['event_name', 'code'], { limit: 200 }),
      counts(s, ['js_error', 'api_error'], ['page_group'], { limit: 50 }),
      counts(s, ['api_error'], ['code'], { limit: 50 }),
    ]);
    const metrics = {};
    vitals.forEach((v) => {
      const m = v.metric;
      metrics[m] ||= { metric: m, samples: 0, good: 0, needsImprovement: 0, poor: 0, weighted: 0 };
      const n = Number(v.samples) || 0;
      metrics[m].samples += n;
      metrics[m].good += Number(v.good) || 0;
      metrics[m].needsImprovement += Number(v.needs_improvement) || 0;
      metrics[m].poor += Number(v.poor) || 0;
      metrics[m].weighted += Number(v.p75) * n;
    });
    const unit = (m, v) => (m === 'CLS' ? Number((v / 1000).toFixed(3)) : Math.round(v));
    return {
      note: 'Field data from real visits, only from visitors who accepted analytics. INP is approximated by the slowest interaction.',
      metrics: Object.values(metrics).map((m) => ({
        ...m,
        p75: m.samples ? unit(m.metric, m.weighted / m.samples) : null,
        goodRate: m.samples ? m.good / m.samples : 0,
      })),
      rows: vitals.map((v) => ({
        metric: v.metric,
        pageGroup: v.page_group,
        device: v.device_class,
        samples: Number(v.samples),
        p50: unit(v.metric, Number(v.p50)),
        p75: unit(v.metric, Number(v.p75)),
        p95: unit(v.metric, Number(v.p95)),
        good: Number(v.good),
        poor: Number(v.poor),
      })),
      errors: errors.map((e) => ({ event: e.event_name, code: e.code || 'unknown', events: e.events, sessions: e.sessions }))
        .sort((a, b) => b.events - a.events),
      errorPages: byPage.map((e) => ({ pageGroup: e.page_group || 'other', events: e.events, sessions: e.sessions }))
        .sort((a, b) => b.events - a.events),
      apiErrors: apiErrors.map((e) => ({ code: e.code || 'unknown', events: e.events })).sort((a, b) => b.events - a.events),
    };
  },

  /**
   * Marketing Campaigns: what each utm_campaign brought, from the first visit
   * through to a paid booking.
   *
   * Sessions, starts and checkouts are browser events; bookings and their value
   * come from booking_completed, which the payments trigger writes after
   * Razorpay verifies the payment. Cost, CPC and ROAS are not here: no ad spend
   * is imported, and inventing them from impressions would be a guess.
   *
   * utm_content and utm_term are collected but not reportable yet — the counts
   * function (0011) does not allow them as dimensions.
   */
  async campaigns(s) {
    const dims = ['utm_campaign', 'utm_source', 'channel'];
    const [all, prev, started, checkout, booked, landing] = await Promise.all([
      counts(s, null, dims, { limit: 500 }),
      counts(s, null, dims, { prev: true, limit: 500 }),
      counts(s, ['booking_started'], dims, { limit: 500 }),
      counts(s, ['checkout_started'], dims, { limit: 500 }),
      counts(s, ['booking_completed'], dims, { limit: 500 }),
      counts(s, null, ['utm_campaign', 'landing_group'], { limit: 500 }),
    ]);
    const key = (r) => `${r.utm_campaign || ''}|${r.utm_source || ''}|${r.channel || ''}`;
    const pick = (rows, k) => rows.find((r) => key(r) === k);
    const named = all.filter((r) => r.utm_campaign);
    const rows = named.map((r) => {
      const k = key(r);
      const sessions = r.sessions || 0;
      const bookings = pick(booked, k)?.sessions || 0;
      return {
        campaign: r.utm_campaign,
        source: SOURCE_NAME(r.channel, r.utm_source),
        category: CATEGORY[r.channel] || r.channel || 'Unknown',
        sessions,
        visitors: r.visitors || 0,
        prevSessions: pick(prev, k)?.sessions || 0,
        bookingStarted: pick(started, k)?.sessions || 0,
        checkoutStarted: pick(checkout, k)?.sessions || 0,
        bookings,
        revenue: pick(booked, k)?.value || 0,
        conversion: sessions ? bookings / sessions : 0,
        landing: landing.filter((l) => l.utm_campaign === r.utm_campaign)
          .sort((a, b) => b.sessions - a.sessions)[0]?.landing_group || null,
      };
    }).sort((a, b) => b.sessions - a.sessions);
    const untagged = all.filter((r) => !r.utm_campaign).reduce((t, r) => t + (r.sessions || 0), 0);
    return {
      summary: {
        sessions: sum(rows, 'sessions'), visitors: sum(rows, 'visitors'),
        bookingStarted: sum(rows, 'bookingStarted'), bookings: sum(rows, 'bookings'),
        revenue: sum(rows, 'revenue'),
      },
      untagged,
      rows,
    };
  },

  /**
   * Visitor Journeys: one row per session — how it arrived, what it saw, how far
   * it got. `session` returns that one session's timeline instead.
   *
   * Sessions are anonymous here and stay that way: analytics_events holds no
   * name, email or phone, and nothing in this report joins to a client record.
   */
  async journeys(s, q) {
    const page = Math.max(0, Number(q.page) || 0);
    const limit = Math.min(200, Math.max(10, Number(q.limit) || 50));
    if (UUID.test(String(q.session || ''))) return { session: await timeline(s, q.session) };
    const rows = await rpc('mkt_sessions', {
      p_from: s.from, p_to: s.to, p_env: s.env,
      p_channel: q.channel && CATEGORY[q.channel] ? q.channel : null,
      p_device: DEVICES.includes(q.device) ? q.device : null,
      p_stage: Number(q.stage) > 0 ? Number(q.stage) : null,
      p_booked: q.booked === 'yes' ? true : q.booked === 'no' ? false : null,
      p_limit: limit, p_offset: page * limit,
    });
    return {
      page, limit, total: Number(rows[0]?.total) || 0,
      filters: { channel: q.channel || null, device: q.device || null, stage: q.stage || null, booked: q.booked || null },
      rows: rows.map((r) => ({
        session: r.session_id,
        visitor: r.anonymous_id,
        startedAt: r.started_at,
        endedAt: r.ended_at,
        seconds: Math.max(0, Math.round((Date.parse(r.ended_at) - Date.parse(r.started_at)) / 1000)),
        events: Number(r.events), pageViews: Number(r.page_views),
        landing: r.landing_path, last: r.last_path,
        channel: r.channel, source: r.utm_source, campaign: r.utm_campaign,
        device: r.device_class, region: r.region,
        furthest: Number(r.furthest),
        stage: LABEL_AT[Number(r.furthest)] || 'Browsed the site',
        booked: !!r.booked,
      })),
    };
  },

  /**
   * Therapist Performance — and the sales-by-therapist report Koott had on Wix.
   *
   * Views and booking starts come from events (so they only count visitors who
   * accepted analytics); bookings and revenue come from `payments`, which counts
   * everyone. The two columns are not measuring the same population, and the
   * conversion between them is therefore a floor, not a rate.
   */
  async 'therapist-performance'(s) {
    const [now, before, people] = await Promise.all([
      rpc('mkt_therapist_stats', { p_from: s.from, p_to: s.to, p_env: s.env }),
      rpc('mkt_therapist_stats', { p_from: s.prevFrom, p_to: s.prevTo, p_env: s.env }),
      supabaseAdmin.from('psychologists').select('id, first_name, last_name, designation'),
    ]);
    const name = Object.fromEntries((people.data || []).map((p) => [p.id, {
      name: [p.first_name, p.last_name].filter(Boolean).join(' ').trim() || 'Unnamed',
      role: p.designation || '',
    }]));
    const prev = byKey(before.map((r) => ({ ...r, key: r.psychologist_id })), 'key');
    const rows = now.map((r) => {
      const views = Number(r.profile_views) || 0;
      const started = Number(r.booking_started) || 0;
      const bookings = Number(r.bookings) || 0;
      return {
        id: r.psychologist_id,
        name: name[r.psychologist_id]?.name || '—',
        role: name[r.psychologist_id]?.role || '',
        profileViews: views,
        visitors: Number(r.visitors) || 0,
        bookingStarted: started,
        checkoutStarted: Number(r.checkout_started) || 0,
        bookings,
        revenue: Number(r.revenue) || 0,
        startRate: views ? started / views : 0,
        prevBookings: Number(prev[r.psychologist_id]?.bookings) || 0,
        prevRevenue: Number(prev[r.psychologist_id]?.revenue) || 0,
      };
    }).sort((a, b) => b.revenue - a.revenue || b.profileViews - a.profileViews);
    return {
      summary: {
        profileViews: sum(rows, 'profileViews'),
        bookingStarted: sum(rows, 'bookingStarted'),
        bookings: sum(rows, 'bookings'),
        revenue: sum(rows, 'revenue'),
      },
      rows,
    };
  },
};

async function report(req, res) {
  const build = REPORTS[req.params.name];
  if (!build) return res.status(404).json({ success: false, message: 'Unknown report.' });
  const s = scopeOf(req.query);
  try {
    const data = await build(s, req.query);
    res.set('Cache-Control', 'private, max-age=60');
    res.json({ success: true, scope: s, data });
  } catch (e) {
    if (e instanceof NotReady || /mkt_period_stats|mkt_path_stats|mkt_source_stats|mkt_funnel|mkt_therapist_stats|dimension not allowed|city/.test(e?.message || '')) {
      return res.status(503).json({ success: false, code: 'NOT_MIGRATED', message: 'Run supabase/migrations/0013_marketing_detail_reports.sql to switch on the detailed reports.' });
    }
    console.error(`❌ marketing report ${req.params.name}:`, e?.message || e);
    res.status(500).json({ success: false, message: 'Could not load this report.' });
  }
}

/* --------------------------------------------------------------- saved reports */

/**
 * A marketing user's own saved custom reports. The row holds the question (the
 * dimensions and events they picked), never an answer, so nothing here ages or
 * leaks. Keyed by users.id: a report follows the person, not the browser.
 */
async function savedReports(req, res) {
  const userId = req.user?.id;
  try {
    if (req.method === 'GET') {
      const { data, error } = await supabaseAdmin
        .from('marketing_saved_reports')
        .select('id, name, config, updated_at')
        .eq('user_id', userId)
        .order('updated_at', { ascending: false })
        .limit(100);
      if (error) throw error;
      return res.json({ success: true, data: { reports: data || [] } });
    }

    if (req.method === 'DELETE') {
      const { error } = await supabaseAdmin
        .from('marketing_saved_reports').delete().eq('user_id', userId).eq('id', req.params.id);
      if (error) throw error;
      return res.json({ success: true });
    }

    const name = String(req.body?.name || '').trim().slice(0, 80);
    if (!name) return res.status(400).json({ success: false, message: 'Give the report a name.' });
    const config = req.body?.config && typeof req.body.config === 'object' ? req.body.config : {};
    const { data, error } = await supabaseAdmin
      .from('marketing_saved_reports')
      .upsert({ user_id: userId, name, config, updated_at: new Date().toISOString() }, { onConflict: 'user_id,name' })
      .select('id, name, config, updated_at')
      .single();
    if (error) throw error;
    return res.json({ success: true, data: { report: data } });
  } catch (e) {
    if (isMissingTable(e)) {
      return res.status(503).json({ success: false, code: 'NOT_MIGRATED', message: 'Run supabase/migrations/0013_marketing_detail_reports.sql to save reports.' });
    }
    console.error('❌ marketing/saved:', e?.message || e);
    return res.status(500).json({ success: false, message: 'Could not save that report.' });
  }
}

/* ------------------------------------------------------------------ live + meta */

/**
 * Live activity: people active in the last 5 minutes and the newest key
 * actions after a cursor. Anonymous — no visitor id, page path, condition
 * topic, therapist or filter value.
 */
const LIVE_EVENTS = [
  'page_view', 'counsellor_profile_view', 'booking_started', 'phone_verified', 'slot_selected',
  'checkout_started', 'payment_opened', 'payment_attempt_failed', 'booking_completed',
  'registration_completed', 'contact_clicked', 'voice_intro_played', 'payment_failed',
];
async function live(req, res) {
  const env = ENVS.includes(req.query.env) ? req.query.env : 'production';
  const after = Number.isInteger(Number(req.query.after)) ? Number(req.query.after) : 0;
  try {
    let q = supabaseAdmin.from('analytics_events')
      .select('id, event_name, occurred_at, page_group, channel, region, device_class, value, props')
      .eq('environment', env).eq('is_bot', false).in('event_name', LIVE_EVENTS)
      .gte('occurred_at', new Date(Date.now() - 24 * 3600000).toISOString()).order('id', { ascending: false }).limit(20);
    if (after > 0) q = q.gt('id', after);
    const [{ data, error }, active] = await Promise.all([
      q,
      supabaseAdmin.from('analytics_events').select('anonymous_id').eq('environment', env).eq('is_bot', false)
        .gte('occurred_at', new Date(Date.now() - 5 * 60000).toISOString()).limit(5000),
    ]);
    if (error) { if (isMissingTable(error)) return res.status(503).json({ success: false, code: 'NOT_MIGRATED' }); throw error; }
    res.set('Cache-Control', 'no-store');
    res.json({
      success: true,
      data: {
        activeNow: new Set((active.data || []).map((r) => r.anonymous_id).filter(Boolean)).size,
        events: (data || []).map((e) => ({
          id: e.id, name: e.event_name, at: e.occurred_at,
          page: e.page_group === 'condition' ? 'topic' : e.page_group,
          channel: e.channel, region: e.region, device: e.device_class,
          value: e.event_name === 'booking_completed' ? Number(e.value) || null : null,
          method: e.event_name === 'contact_clicked' ? e.props?.method || null : null,
        })),
      },
    });
  } catch (e) {
    console.error('❌ marketing/live:', e?.message || e);
    res.status(500).json({ success: false, message: 'Could not load live activity.' });
  }
}

async function metaInfo(req, res) {
  const probe = await supabaseAdmin.from('analytics_events').select('id').limit(1);
  if (probe.error && isMissingTable(probe.error)) {
    return res.status(503).json({ success: false, code: 'NOT_MIGRATED', message: 'Run supabase/migrations/0011_analytics.sql and 0012_marketing_reports.sql.' });
  }
  const out = {};
  for (const e of ENVS) {
    const { count } = await supabaseAdmin.from('analytics_events').select('id', { count: 'exact', head: true }).eq('environment', e);
    out[e] = count || 0;
  }
  res.json({ success: true, data: { environments: out, today: istToday() } });
}

function page(build) {
  return async (req, res) => {
    const s = scopeOf(req.query);
    try {
      const data = await build(s);
      res.set('Cache-Control', 'private, max-age=60');
      res.json({ success: true, scope: s, data });
    } catch (e) {
      if (e instanceof NotReady || /mkt_session_stats|mkt_sales|mkt_bookings|mkt_visitor_split|mkt_path_engagement|dimension not allowed/.test(e?.message || '')) {
        return res.status(503).json({ success: false, code: 'NOT_MIGRATED', message: 'Run supabase/migrations/0012_marketing_reports.sql to finish setting up these reports.' });
      }
      console.error('❌ marketing report:', e?.message || e);
      res.status(500).json({ success: false, message: 'Could not load this report.' });
    }
  };
}

module.exports = {
  savedReports,
  meta: metaInfo,
  live,
  highlights: page(highlightsData),
  traffic: page(trafficData),
  report,
  scopeOf, sourceLabel,
};
