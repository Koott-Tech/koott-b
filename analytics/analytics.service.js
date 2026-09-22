/**
 * First-party analytics: collection, attribution and identity.
 *
 * Every write here is best-effort. A failure is logged and swallowed — analytics
 * must never slow down or break a page, a login, or a booking. Until migration
 * 0011 is applied the calls are no-ops (one warning, then silence).
 */

const crypto = require('crypto');
const { supabaseAdmin } = require('../config/supabase');
const {
  UUID, BROWSER_EVENTS, SERVER_EVENTS, classifyPath, classifyTouch, deviceOf, isBot, regionOf, countryFromCode, cityOf, UNTRACKED,
} = require('./registry');

const MAX_BATCH = 50;
const env = () => process.env.ANALYTICS_ENV || (process.env.NODE_ENV === 'production' ? 'production' : 'development');

/* ------------------------------------------------------------ plumbing */

let warnedMissing = false;
function isMissingTable(error) {
  if (!error) return false;
  if (error.code === 'PGRST205' || error.code === '42P01' || error.code === 'PGRST202') {
    if (!warnedMissing) {
      warnedMissing = true;
      console.warn('⚠️ Analytics tables are missing — run supabase/migrations/0011_analytics.sql. Analytics is off until then.');
    }
    return true;
  }
  return false;
}
const logError = (where, error) => { if (!isMissingTable(error)) console.error(`❌ analytics ${where}:`, error?.message || error); };

// analytics_events.city arrives with migration 0013; until then write without it.
let hasCity = true;
async function upsertEvents(rows) {
  const list = Array.isArray(rows) ? rows : [rows];
  const strip = (r) => { const { city, ...rest } = r; return rest; };
  let res = await supabaseAdmin.from('analytics_events').upsert(hasCity ? list : list.map(strip), { onConflict: 'event_id', ignoreDuplicates: true });
  if (res.error && hasCity && /city/.test(res.error.message || '') && (res.error.code === 'PGRST204' || res.error.code === '42703')) {
    hasCity = false;
    res = await supabaseAdmin.from('analytics_events').upsert(list.map(strip), { onConflict: 'event_id', ignoreDuplicates: true });
  }
  return res;
}

const ownHosts = () => {
  const hosts = [];
  [process.env.FRONTEND_URL, process.env.CLIENT_SITE_URL, process.env.SITE_URL, process.env.PUBLIC_APP_URL].forEach((u) => {
    try { if (u) hosts.push(new URL(u).hostname.replace(/^www\./, '')); } catch (_) { /* ignore */ }
  });
  return hosts;
};

// Condition-page slugs, refreshed every 10 minutes, so a newly published page is grouped correctly.
let slugCache = { at: 0, set: new Set() };
async function conditionSlugs() {
  if (Date.now() - slugCache.at < 10 * 60 * 1000) return slugCache.set;
  const { data, error } = await supabaseAdmin.from('counselling_services').select('slug').limit(1000);
  if (!error && data) slugCache = { at: Date.now(), set: new Set(data.map((r) => r.slug).filter(Boolean)) };
  else slugCache.at = Date.now();
  return slugCache.set;
}

const uuidOr = (v) => (typeof v === 'string' && UUID.test(v) ? v.toLowerCase() : null);
const boolOr = (v) => v === true;
const clip = (v, n) => (typeof v === 'string' && v.trim() ? v.trim().slice(0, n) : null);
const cleanPath = (p) => {
  if (typeof p !== 'string' || !p.startsWith('/')) return null;
  return p.split(/[?#]/)[0].slice(0, 300); // never keep query strings: they can carry ids
};
const clampTime = (iso) => {
  const t = Date.parse(iso);
  const now = Date.now();
  if (!Number.isFinite(t) || Math.abs(now - t) > 24 * 3600 * 1000) return new Date(now).toISOString();
  return new Date(t).toISOString();
};
const money = (v) => (Number.isFinite(v) && v >= 0 && v <= 10000000 ? Math.round(v * 100) / 100 : null);

/**
 * The shared context the browser sends with every batch and with booking calls.
 * Returns null when it isn't usable (no anonymous id) — callers then store nothing
 * visitor-level.
 */
function readContext(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const anonymousId = uuidOr(raw.anonymousId);
  if (!anonymousId) return null;
  const consent = raw.consent || {};
  const hosts = ownHosts();
  const touch = classifyTouch(raw.touch || {}, hosts);
  const first = raw.first ? classifyTouch(raw.first, hosts) : touch;
  const ids = raw.ids || {};
  return {
    anonymousId,
    sessionId: uuidOr(raw.sessionId),
    consent: { analytics: boolOr(consent.analytics), advertising: boolOr(consent.advertising), version: clip(consent.version, 20) || 'v1' },
    touch,
    first,
    landingPath: cleanPath(raw.landingPath),
    // country + city from Vercel's edge headers (via /api/geo); time zone as the fallback
    region: countryFromCode(raw.geo?.country) || regionOf(clip(raw.tz, 60)),
    city: cityOf(raw.geo?.city),
    ids: {
      fbp: clip(ids.fbp, 200), fbc: clip(ids.fbc, 500),
      gaClientId: clip(ids.gaClientId, 100), gaSessionId: clip(ids.gaSessionId, 60),
    },
  };
}

/* ------------------------------------------------------- browser events */

/**
 * POST /api/analytics/events. Validates each event against the registry; an
 * invalid event is dropped on its own, the rest of the batch still counts.
 */
async function recordBrowserBatch({ body, userId, userAgent }) {
  const ctx = readContext(body?.context);
  const events = Array.isArray(body?.events) ? body.events.slice(0, MAX_BATCH) : [];
  if (!ctx) return { accepted: 0, rejected: events.length, reason: 'context' };
  if (!ctx.consent.analytics) return { accepted: 0, rejected: 0, reason: 'no_consent' };

  const slugs = await conditionSlugs().catch(() => new Set());
  const bot = isBot(userAgent);
  const device = deviceOf(userAgent);
  const landing = ctx.landingPath ? classifyPath(ctx.landingPath, slugs) : { group: null, topic: null };
  const environment = env();

  const rows = [];
  let rejected = 0;
  for (const e of events) {
    const def = BROWSER_EVENTS[e?.name];
    const eventId = uuidOr(e?.id);
    const path = cleanPath(e?.path);
    if (!def || SERVER_EVENTS.has(e?.name) || !eventId || (path && UNTRACKED.test(path))) { rejected += 1; continue; }

    const props = {};
    let bad = false;
    for (const [k, v] of Object.entries(e.props || {})) {
      const check = def.props[k];
      const ok = check ? check(v) : undefined;
      if (ok === undefined) { bad = true; break; }
      props[k] = ok;
    }
    if (bad) { rejected += 1; continue; }

    const page = path ? classifyPath(path, slugs) : { group: null, topic: null };
    rows.push({
      event_id: eventId,
      event_name: e.name,
      occurred_at: clampTime(e.at),
      environment,
      source: 'browser',
      anonymous_id: ctx.anonymousId,
      user_id: userId || null,
      session_id: ctx.sessionId,
      page_path: path,
      page_group: page.group,
      page_topic: page.topic,
      landing_group: landing.group,
      landing_topic: landing.topic,
      channel: ctx.touch.channel,
      first_channel: ctx.first.channel,
      utm_source: ctx.touch.source,
      utm_medium: ctx.touch.medium,
      utm_campaign: ctx.touch.campaign,
      utm_content: ctx.touch.content,
      utm_term: ctx.touch.term,
      referrer_host: ctx.touch.referrer_host,
      device_class: device,
      region: ctx.region,
      city: ctx.city,
      is_bot: bot,
      psychologist_id: def.psychologist ? uuidOr(e.psychologistId) : null,
      value: def.value ? money(e.value) : null,
      currency: def.value && money(e.value) != null ? 'INR' : null,
      props,
    });
  }

  if (rows.length) {
    const { error } = await upsertEvents(rows);
    if (error) { logError('insert events', error); return { accepted: 0, rejected: events.length, reason: 'storage' }; }
    if (!bot && rows.some((r) => r.event_name === 'page_view')) touchVisitor(ctx, landing).catch(() => {});
  }
  return { accepted: rows.length, rejected };
}

async function touchVisitor(ctx, landing) {
  const t = ctx.touch; const f = ctx.first;
  const { error } = await supabaseAdmin.rpc('analytics_touch_visitor', {
    p_anonymous_id: ctx.anonymousId, p_env: env(),
    p_channel: t.channel, p_source: t.source, p_medium: t.medium, p_campaign: t.campaign,
    p_landing_group: landing.group, p_referrer_host: t.referrer_host,
    p_fbclid: t.fbclid, p_gclid: t.gclid, p_gbraid: t.gbraid, p_wbraid: t.wbraid,
    p_first_channel: f.channel, p_first_source: f.source, p_first_medium: f.medium, p_first_campaign: f.campaign,
  });
  if (error) logError('touch visitor', error);
}

/* -------------------------------------------------------------- consent */

async function recordConsent({ body, userId }) {
  const anonymousId = uuidOr(body?.anonymousId);
  if (!anonymousId) return false;
  const { error } = await supabaseAdmin.from('consent_records').insert({
    anonymous_id: anonymousId,
    user_id: userId || null,
    environment: env(),
    analytics: boolOr(body.analytics),
    advertising: boolOr(body.advertising),
    version: clip(body.version, 20) || 'v1',
    source: body.source === 'settings' ? 'settings' : 'banner',
  });
  if (error) { logError('consent', error); return false; }
  return true;
}

/* ------------------------------------------------------------- identity */

/**
 * After a login or sign-up (called by the browser with its JWT): link the
 * anonymous visitor to the account and record login_completed, or
 * registration_completed when the account is under 15 minutes old.
 */
async function identify({ user, body, userAgent }) {
  const ctx = readContext(body?.context);
  const userId = uuidOr(user?.id);
  if (!userId || !ctx) return { ok: false };
  if (user.role && user.role !== 'client') return { ok: true, skipped: 'staff' }; // staff activity is never tracked

  const method = ['phone', 'google', 'email', 'password'].includes(body?.method) ? body.method : 'password';
  await supabaseAdmin.from('analytics_identities').upsert({ anonymous_id: ctx.anonymousId, user_id: userId }, { onConflict: 'anonymous_id,user_id', ignoreDuplicates: true })
    .then(({ error }) => error && logError('identity', error));
  await supabaseAdmin.from('visitor_attribution').update({ user_id: userId }).eq('anonymous_id', ctx.anonymousId)
    .then(({ error }) => error && logError('identity attribution', error));

  if (!ctx.consent.analytics) return { ok: true };

  const { data: u } = await supabaseAdmin.from('users').select('created_at').eq('id', userId).maybeSingle();
  const isNew = u?.created_at && Date.now() - Date.parse(u.created_at) < 15 * 60 * 1000;
  await recordServerEvent({
    eventId: isNew ? `signup_${userId}` : `login_${crypto.randomUUID()}`,
    name: isNew ? 'registration_completed' : 'login_completed',
    ctx, userId, userAgent, props: { method },
  });
  return { ok: true, registered: !!isNew };
}

/* --------------------------------------------------------- server events */

async function recordServerEvent({ eventId, name, ctx, userId, userAgent, at, paymentId, psychologistId, value, props, overrides }) {
  if (!SERVER_EVENTS.has(name)) throw new Error(`not a server event: ${name}`);
  const slugs = await conditionSlugs().catch(() => new Set());
  const landing = ctx?.landingPath ? classifyPath(ctx.landingPath, slugs) : { group: null, topic: null };
  const row = {
    event_id: eventId,
    event_name: name,
    occurred_at: at || new Date().toISOString(),
    environment: env(),
    source: 'server',
    anonymous_id: ctx?.anonymousId || null,
    user_id: userId || null,
    session_id: ctx?.sessionId || null,
    landing_group: landing.group,
    landing_topic: landing.topic,
    channel: ctx?.touch?.channel || null,
    first_channel: ctx?.first?.channel || null,
    utm_source: ctx?.touch?.source || null,
    utm_medium: ctx?.touch?.medium || null,
    utm_campaign: ctx?.touch?.campaign || null,
    device_class: userAgent ? deviceOf(userAgent) : null,
    region: ctx?.region || null,
    city: ctx?.city || null,
    payment_id: paymentId || null,
    psychologist_id: psychologistId || null,
    value: value ?? null,
    currency: value != null ? 'INR' : null,
    props: props || {},
    ...(overrides || {}),
  };
  const { error } = await upsertEvents(row);
  if (error) { logError(`server event ${name}`, error); return false; }
  return true;
}

/* ----------------------------------------------------- booking & leads */

/**
 * Freeze where a booking came from, at the moment its Razorpay order is
 * created. Called without await from createPaymentOrder. IP and user agent are
 * only kept with advertising consent (needed later for Meta matching) and are
 * purged 30 days after delivery.
 */
async function recordBookingAttribution({ paymentId, clientId, psychologistId, amount, itemKind, rawContext, req }) {
  try {
    const ctx = readContext(rawContext);
    const slugs = await conditionSlugs().catch(() => new Set());
    const landing = ctx?.landingPath ? classifyPath(ctx.landingPath, slugs) : { group: null, topic: null };
    const ua = req?.headers?.['user-agent'] || '';
    const ip = (req?.headers?.['x-forwarded-for'] || '').split(',')[0].trim() || req?.ip || null;
    const ad = !!ctx?.consent.advertising;

    const { error } = await supabaseAdmin.from('booking_attribution').upsert({
      payment_id: paymentId,
      client_id: clientId || null,
      psychologist_id: psychologistId || null,
      environment: env(),
      anonymous_id: ctx?.anonymousId || null,
      analytics_session_id: ctx?.sessionId || null,
      first_channel: ctx?.first.channel || null, first_source: ctx?.first.source || null,
      first_medium: ctx?.first.medium || null, first_campaign: ctx?.first.campaign || null,
      last_channel: ctx?.touch.channel || null, last_source: ctx?.touch.source || null,
      last_medium: ctx?.touch.medium || null, last_campaign: ctx?.touch.campaign || null,
      utm_content: ctx?.touch.content || null, utm_term: ctx?.touch.term || null,
      landing_group: landing.group, landing_topic: landing.topic,
      device_class: ua ? deviceOf(ua) : null,
      region: ctx?.region || null,
      fbclid: ad ? ctx.touch.fbclid || ctx.first.fbclid : null,
      fbc: ad ? ctx.ids.fbc : null, fbp: ad ? ctx.ids.fbp : null,
      gclid: ctx?.touch.gclid || ctx?.first.gclid || null,
      gbraid: ctx?.touch.gbraid || null, wbraid: ctx?.touch.wbraid || null,
      ga_client_id: ctx?.consent.analytics ? ctx.ids.gaClientId : null,
      ga_session_id: ctx?.consent.analytics ? ctx.ids.gaSessionId : null,
      client_ip: ad && ip ? ip : null,
      client_user_agent: ad ? ua.slice(0, 400) : null,
      consent_analytics: !!ctx?.consent.analytics,
      consent_advertising: ad,
      consent_version: ctx?.consent.version || null,
    }, { onConflict: 'payment_id', ignoreDuplicates: true });
    if (error) return logError('booking attribution', error);

    if (ctx?.consent.analytics) {
      await recordServerEvent({
        eventId: `payinit_${paymentId}`, name: 'payment_initiated', ctx, userAgent: ua,
        paymentId, psychologistId, value: money(Number(amount)), props: itemKind ? { item_kind: itemKind } : {},
      });
    }
  } catch (e) {
    logError('booking attribution', e);
  }
}

/** A verified phone number (a lead) ↔ the visit it came from. First visit wins. */
async function recordLeadAttribution({ phone, rawContext, req }) {
  try {
    const ctx = readContext(rawContext);
    if (!phone || !ctx) return;
    const slugs = await conditionSlugs().catch(() => new Set());
    const landing = ctx.landingPath ? classifyPath(ctx.landingPath, slugs) : { group: null };
    const { error } = await supabaseAdmin.from('lead_attribution').upsert({
      phone,
      anonymous_id: ctx.anonymousId,
      environment: env(),
      first_channel: ctx.first.channel, last_channel: ctx.touch.channel,
      last_source: ctx.touch.source, last_medium: ctx.touch.medium, last_campaign: ctx.touch.campaign,
      landing_group: landing.group,
      device_class: deviceOf(req?.headers?.['user-agent'] || ''),
      region: ctx.region,
    }, { onConflict: 'phone', ignoreDuplicates: true });
    if (error) logError('lead attribution', error);
  } catch (e) {
    logError('lead attribution', e);
  }
}

module.exports = {
  env, readContext, recordBrowserBatch, recordConsent, identify, recordServerEvent,
  recordBookingAttribution, recordLeadAttribution, isMissingTable, logError,
};
