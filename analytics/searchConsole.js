/**
 * Google Search Console — "Clicks by Google searches" on the dashboard.
 *
 * Needs: SEARCH_CONSOLE_SITE_URL (e.g. "sc-domain:koott.in" or "https://koott.in/")
 * and GOOGLE_SERVICE_ACCOUNT_JSON, with that service account added as a user
 * on the property (Search Console → Settings → Users and permissions → Add
 * user → the service account's email, "Restricted" is enough).
 * Answers are cached for 6 hours; Google's data lags 2–3 days.
 */

const { google } = require('googleapis');

const cache = new Map();
const SIX_HOURS = 6 * 3600 * 1000;

function client() {
  const site = process.env.SEARCH_CONSOLE_SITE_URL;
  const raw = process.env.GOOGLE_SERVICE_ACCOUNT_JSON;
  if (!site || !raw) return null;
  const credentials = JSON.parse(raw);
  const auth = new google.auth.GoogleAuth({ credentials, scopes: ['https://www.googleapis.com/auth/webmasters.readonly'] });
  return { site, api: google.searchconsole({ version: 'v1', auth }) };
}

async function query(c, startDate, endDate, dimensions, rowLimit) {
  const { data } = await c.api.searchanalytics.query({
    siteUrl: c.site,
    requestBody: { startDate, endDate, dimensions, rowLimit, dataState: 'final' },
  });
  return data.rows || [];
}

/** Total clicks, previous-period clicks, top 3 queries (with change) and the last reported day. */
async function searchSummary({ from, to, prevFrom, prevTo }) {
  const c = client();
  if (!c) return { configured: false };
  const key = `${from}|${to}`;
  const hit = cache.get(key);
  if (hit && Date.now() - hit.at < SIX_HOURS) return hit.value;
  try {
    const [total, prev, top, prevTop, days] = await Promise.all([
      query(c, from, to, [], 1),
      query(c, prevFrom, prevTo, [], 1),
      query(c, from, to, ['query'], 3),
      query(c, prevFrom, prevTo, ['query'], 200),
      query(c, from, to, ['date'], 400),
    ]);
    const before = Object.fromEntries(prevTop.map((r) => [r.keys[0], r.clicks]));
    const value = {
      configured: true,
      clicks: total[0]?.clicks || 0,
      previousClicks: prev[0]?.clicks || 0,
      queries: top.map((r) => ({ query: r.keys[0], clicks: r.clicks, position: Math.round(r.position * 10) / 10, previousClicks: before[r.keys[0]] ?? null })),
      lastReported: days.map((r) => r.keys[0]).sort().pop() || null,
    };
    cache.set(key, { at: Date.now(), value });
    return value;
  } catch (e) {
    return { configured: true, error: e?.errors?.[0]?.message || e?.message || 'Search Console request failed' };
  }
}

/** Top Search Queries on Google: impressions, clicks, CTR and average position per query. */
async function searchQueries({ from, to, limit = 100, split = null }) {
  const c = client();
  if (!c) return { configured: false };
  const key = `q|${from}|${to}|${limit}|${split}`;
  const hit = cache.get(key);
  if (hit && Date.now() - hit.at < SIX_HOURS) return hit.value;
  try {
    const [total, rows, bySplit] = await Promise.all([
      query(c, from, to, [], 1),
      query(c, from, to, ['query'], limit),
      split === 'device' ? query(c, from, to, ['query', 'device'], limit * 3) : [],
    ]);
    const t = total[0] || {};
    const value = {
      configured: true,
      summary: { impressions: t.impressions || 0, clicks: t.clicks || 0, ctr: t.ctr || 0, position: Math.round((t.position || 0) * 10) / 10 },
      rows: rows.map((r) => ({ query: r.keys[0], impressions: r.impressions, clicks: r.clicks, ctr: r.ctr, position: Math.round(r.position * 10) / 10 })),
      split,
      splits: bySplit.map((r) => ({ key: r.keys[0], device: String(r.keys[1] || '').toLowerCase(), clicks: r.clicks, impressions: r.impressions })),
    };
    cache.set(key, { at: Date.now(), value });
    return value;
  } catch (e) {
    return { configured: true, error: e?.errors?.[0]?.message || e?.message || 'Search Console request failed' };
  }
}

module.exports = { searchSummary, searchQueries };
