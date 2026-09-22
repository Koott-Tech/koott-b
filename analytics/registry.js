/**
 * The analytics event registry — the only events and fields Koott records.
 *
 * Browser events are accepted from POST /api/analytics/events; anything not
 * listed here (a new event name, an extra prop, a value of the wrong shape) is
 * dropped by the validator, so nothing reaches the database by accident.
 * Server events are written by the backend itself (payments, login) and the
 * browser can never send them.
 *
 * Privacy rules this file enforces:
 *   · no free text: props are ids, enums, small numbers, or the value of a
 *     filter the site itself offers (kept internal, aggregate only)
 *   · nothing typed by a person is ever a prop
 *   · the page path is stored for Koott's own reports; ad platforms only ever
 *     get a redacted form (see docs/analytics/privacy-rules.md)
 */

const ID = /^[a-z][a-z0-9_]{1,59}$/;          // element / popup / code ids: snake_case, short
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

const t = {
  id: (v) => (typeof v === 'string' && ID.test(v) ? v : undefined),
  int: (min, max) => (v) => (Number.isInteger(v) && v >= min && v <= max ? v : undefined),
  oneOf: (...opts) => (v) => (opts.includes(v) ? v : undefined),
  label: (v) => (typeof v === 'string' && v.trim().length > 0 && v.length <= 60 && !/[<>{}]/.test(v) ? v.trim() : undefined),
  // where a button leads: a same-site path without query, or another site's host
  target: (v) => (typeof v === 'string' && v.length <= 120 && /^(\/[^\s?#]*|[a-z0-9.-]+\.[a-z]{2,})$/i.test(v) ? v : undefined),
};

const BOOKING_STEPS = ['phone', 'type', 'time', 'plan', 'about', 'review'];
const ITEM_KIND = t.oneOf('session', 'package');

/** Browser events: name → allowed props. `psychologist` = may carry psychologistId; `value` = may carry a price. */
const BROWSER_EVENTS = {
  page_view:               { props: {} },
  page_engaged:            { props: { seconds: t.int(0, 3600) } },
  scroll_depth:            { props: { depth: t.oneOf(25, 50, 75, 100) } },
  ui_click:                { props: { element: t.id, target: t.target } },
  ui_toggle:               { props: { element: t.id, index: t.int(0, 100) } },
  popup_shown:             { props: { popup: t.id } },
  popup_action:            { props: { popup: t.id, action: t.id } },
  popup_dismissed:         { props: { popup: t.id } },
  filter_applied:          { props: { filter: t.id, value: t.label } },
  search_used:             { props: { length: t.int(0, 500) } },
  contact_clicked:         { props: { method: t.oneOf('whatsapp', 'phone', 'email') } },
  counsellor_list_view:    { props: { count: t.int(0, 500) } },
  counsellor_profile_view: { props: {}, psychologist: true },
  voice_intro_played:      { props: {}, psychologist: true },
  booking_started:         { props: { mode: t.oneOf('new', 'package') }, psychologist: true },
  booking_step_viewed:     { props: { step: t.oneOf(...BOOKING_STEPS) }, psychologist: true },
  booking_step_error:      { props: { step: t.oneOf(...BOOKING_STEPS), code: t.id } },
  phone_verified:          { props: {}, psychologist: true },
  slot_selected:           { props: {}, psychologist: true },
  plan_selected:           { props: { item_kind: ITEM_KIND }, psychologist: true, value: true },
  details_completed:       { props: {}, psychologist: true },
  checkout_started:        { props: { item_kind: ITEM_KIND }, psychologist: true, value: true },
  payment_opened:          { props: { item_kind: ITEM_KIND }, psychologist: true, value: true },
  payment_attempt_failed:  { props: { code: t.id } },
  payment_dismissed:       { props: {} },
  js_error:                { props: { code: t.id } },
  api_error:               { props: { code: t.id, status: t.int(0, 599) } },
};

/** Server-only events (written by the backend; rejected if a browser sends them). */
const SERVER_EVENTS = new Set([
  'registration_completed', 'login_completed',
  'payment_initiated', 'payment_failed', 'booking_completed', 'booking_cancelled',
]);

/* ------------------------------------------------------------------ pages */

const SERVICE_PAGES = new Set([
  'assessments', 'better-parenting', 'plans-pricing', 'online-child-psychologist', 'service-page',
  'counselling', 'events', 'event-list', 'guide',
]);
const ACCOUNT_PAGES = new Set(['profile', 'auth', 'messages']);

/** Condition pages collapse into a handful of topics — the finest grain any report shows. */
const TOPICS = [
  ['anxiety_stress', /anxiety|panic|ocd|phobia|stress|burnout|productivity|sleep/],
  ['depression_mood', /depress|mood|bipolar|postpartum/],
  ['relationships', /marit|marriage|couple|relationship|divorce|newlywed|pre-marital|communication|emotional-connection|family|infertility/],
  ['child_parenting', /child|adhd|autis|parent|teen/],
  ['sexual_intimacy', /sexual|intimacy|vaginismus/],
  ['trauma_crisis', /trauma|ptsd|grief|abuse|crisis|suicid/],
  ['addiction', /addict/],
];
const topicOf = (slug) => (TOPICS.find(([, re]) => re.test(slug)) || ['other_topics'])[0];

/**
 * A path → {group, topic}. `conditionSlugs` is the live set of condition-page
 * slugs (counselling_services), loaded and cached by the service.
 */
function classifyPath(path, conditionSlugs) {
  const clean = String(path || '/').split(/[?#]/)[0].replace(/\/+$/, '') || '/';
  if (clean === '/') return { group: 'home', topic: null };
  const [first, second] = clean.slice(1).split('/');
  if (first === 'book-malayali-psychologists' && !second) return { group: 'listing', topic: null };
  if (first === 'therapist-profile' || (first === 'book-malayali-psychologists' && second)) return { group: 'profile', topic: null };
  if (first === 'online-child-psychologist' && second) return { group: 'profile', topic: null };
  if (first === 'book') return { group: 'booking', topic: null };
  if (first === 'payment') return { group: 'payment', topic: null };
  if (first === 'blog' || first === 'blogs') return { group: 'blog', topic: null };
  if (first === 'counselling' && second) return { group: 'condition', topic: topicOf(second) };
  if (conditionSlugs && conditionSlugs.has(first)) return { group: 'condition', topic: topicOf(first) };
  if (SERVICE_PAGES.has(first)) return { group: 'service', topic: null };
  if (ACCOUNT_PAGES.has(first)) return { group: 'account', topic: null };
  return { group: 'other', topic: null };
}

/** Staff and internal areas are never tracked. */
const UNTRACKED = /^\/(admin|superadmin|finance|psychologist|event-organizer|marketing|dev)(\/|$)/;

/* --------------------------------------------------------------- channels */

const SEARCH_HOSTS = /(^|\.)(google\.[a-z.]+|bing\.com|duckduckgo\.com|search\.yahoo\.com|yahoo\.com|ecosia\.org|yandex\.[a-z]+|baidu\.com|search\.brave\.com)$/;
const SOCIAL_HOSTS = /(^|\.)(facebook\.com|fb\.com|fb\.me|instagram\.com|t\.co|twitter\.com|x\.com|linkedin\.com|lnkd\.in|youtube\.com|youtu\.be|reddit\.com|pinterest\.[a-z.]+|threads\.net|quora\.com)$/;
const SOCIAL_SOURCES = /^(facebook|fb|instagram|ig|meta|twitter|x|linkedin|youtube|threads|pinterest|reddit)$/;
const PAID_MEDIUMS = /^(cpc|ppc|paid|paidsearch|paid_search|paid-search|cpm|cpv|display|paid_social|paidsocial|paid-social|social_paid|ads|ad)$/;

const clip = (v, n = 120) => (typeof v === 'string' && v.trim() ? v.trim().slice(0, n) : null);

// AI assistants that link to sites (ChatGPT also adds utm_source=chatgpt.com)
const AI_HOSTS = /(^|\.)(chatgpt\.com|chat\.openai\.com|openai\.com|perplexity\.ai|gemini\.google\.com|bard\.google\.com|claude\.ai|copilot\.microsoft\.com|you\.com|chat\.deepseek\.com|deepseek\.com|meta\.ai|grok\.com|chat\.mistral\.ai)$/;
const AI_SOURCES = /^(chatgpt(\.com)?|openai|perplexity(\.ai)?|gemini|claude(\.ai)?|copilot|deepseek|grok|meta\.ai)$/;

function hostOf(ref) {
  if (!ref) return null;
  try { return new URL(ref).hostname.toLowerCase().replace(/^www\./, ''); } catch (_) { return null; }
}

/**
 * Raw landing context → channel + normalised source/medium. The browser sends
 * raw values; the channel is always decided here, never trusted from it.
 * Meta adds fbclid to organic links too, so fbclid alone is organic social —
 * tag Meta ads with utm_medium=paid_social.
 */
function classifyTouch(raw = {}, ownHosts = []) {
  const src = clip(raw.utm_source, 80)?.toLowerCase() || null;
  const med = clip(raw.utm_medium, 80)?.toLowerCase() || null;
  const refHost = hostOf(raw.referrer);
  const internalRef = refHost && (ownHosts.includes(refHost) || /razorpay\.com$/.test(refHost));
  const out = {
    channel: 'direct',
    source: src,
    medium: med,
    campaign: clip(raw.utm_campaign, 120),
    content: clip(raw.utm_content, 120),
    term: clip(raw.utm_term, 120),
    referrer_host: internalRef ? null : refHost,
    fbclid: clip(raw.fbclid, 500),
    gclid: clip(raw.gclid, 500),
    gbraid: clip(raw.gbraid, 500),
    wbraid: clip(raw.wbraid, 500),
  };

  if (out.gclid || out.gbraid || out.wbraid) {
    out.channel = 'paid_search';
    out.source ||= 'google'; out.medium ||= 'cpc';
  } else if (med && PAID_MEDIUMS.test(med)) {
    out.channel = (src && SOCIAL_SOURCES.test(src)) || /social/.test(med) || out.fbclid ? 'paid_social' : 'paid_search';
  } else if (src === 'whatsapp' || med === 'whatsapp') {
    out.channel = 'whatsapp';
  } else if (med === 'email' || src === 'newsletter' || src === 'email') {
    out.channel = 'email';
  } else if ((src && AI_SOURCES.test(src)) || (!src && !med && refHost && AI_HOSTS.test(refHost))) {
    out.channel = 'ai_platform';
    out.source = src || refHost; out.medium ||= 'referral';
  } else if (med === 'social' || med === 'organic_social' || (src && SOCIAL_SOURCES.test(src)) || out.fbclid) {
    out.channel = 'organic_social';
    out.source ||= out.fbclid ? 'facebook' : refHost; out.medium ||= 'social';
  } else if (src || med) {
    out.channel = 'referral';
  } else if (out.referrer_host) {
    const h = out.referrer_host;
    if (SEARCH_HOSTS.test(h)) { out.channel = 'organic_search'; out.source = h.replace(/^search\./, '').split('.')[0]; out.medium = 'organic'; }
    else if (/(^|\.)(whatsapp\.com|wa\.me)$/.test(h)) { out.channel = 'whatsapp'; out.source = 'whatsapp'; out.medium = 'referral'; }
    else if (SOCIAL_HOSTS.test(h)) { out.channel = 'organic_social'; out.source = h; out.medium = 'social'; }
    else if (/^mail\.|outlook\./.test(h)) { out.channel = 'email'; out.source = h; out.medium = 'email'; }
    else { out.channel = 'referral'; out.source = h; out.medium = 'referral'; }
  }
  if (out.channel === 'direct') { out.source = '(direct)'; out.medium = '(none)'; }
  return out;
}

/* ---------------------------------------------------------- device, region */

function deviceOf(ua = '') {
  if (/iPad|Tablet|PlayBook|Silk|(Android(?!.*Mobile))/i.test(ua)) return 'tablet';
  if (/Mobi|iPhone|iPod|Android|IEMobile|Opera Mini/i.test(ua)) return 'mobile';
  return 'desktop';
}

const BOT_UA = /bot|crawl|spider|slurp|facebookexternalhit|headless|lighthouse|pagespeed|preview|monitor|curl|wget|python-requests|axios|node-fetch|go-http-client|scrapy|phantom|puppeteer|playwright/i;
const isBot = (ua = '') => !ua || BOT_UA.test(ua);

// Browser time zone → country (names match the world map the dashboard draws).
// Coarse by design: never an IP lookup. Zones not listed fall back to "Other".
const TZ_COUNTRY = {
  'Asia/Kolkata': 'India', 'Asia/Calcutta': 'India',
  'Asia/Dubai': 'United Arab Emirates', 'Asia/Riyadh': 'Saudi Arabia', 'Asia/Qatar': 'Qatar',
  'Asia/Muscat': 'Oman', 'Asia/Kuwait': 'Kuwait', 'Asia/Bahrain': 'Bahrain',
  'Asia/Singapore': 'Singapore', 'Asia/Kuala_Lumpur': 'Malaysia', 'Asia/Colombo': 'Sri Lanka',
  'Asia/Kathmandu': 'Nepal', 'Asia/Dhaka': 'Bangladesh', 'Asia/Karachi': 'Pakistan',
  'Asia/Tokyo': 'Japan', 'Asia/Seoul': 'South Korea', 'Asia/Shanghai': 'China', 'Asia/Hong_Kong': 'Hong Kong',
  'Asia/Bangkok': 'Thailand', 'Asia/Jakarta': 'Indonesia', 'Asia/Manila': 'Philippines', 'Asia/Ho_Chi_Minh': 'Vietnam',
  'Asia/Jerusalem': 'Israel', 'Asia/Amman': 'Jordan', 'Asia/Baghdad': 'Iraq', 'Asia/Tehran': 'Iran',
  'Europe/London': 'United Kingdom', 'Europe/Belfast': 'United Kingdom', 'Europe/Dublin': 'Ireland',
  'Europe/Berlin': 'Germany', 'Europe/Paris': 'France', 'Europe/Amsterdam': 'Netherlands', 'Europe/Brussels': 'Belgium',
  'Europe/Madrid': 'Spain', 'Europe/Rome': 'Italy', 'Europe/Zurich': 'Switzerland', 'Europe/Vienna': 'Austria',
  'Europe/Stockholm': 'Sweden', 'Europe/Oslo': 'Norway', 'Europe/Copenhagen': 'Denmark', 'Europe/Helsinki': 'Finland',
  'Europe/Warsaw': 'Poland', 'Europe/Prague': 'Czechia', 'Europe/Lisbon': 'Portugal', 'Europe/Athens': 'Greece',
  'Europe/Istanbul': 'Turkey', 'Europe/Moscow': 'Russia', 'Europe/Kiev': 'Ukraine', 'Europe/Kyiv': 'Ukraine',
  'Africa/Cairo': 'Egypt', 'Africa/Johannesburg': 'South Africa', 'Africa/Nairobi': 'Kenya', 'Africa/Lagos': 'Nigeria',
  'Australia/Sydney': 'Australia', 'Australia/Melbourne': 'Australia', 'Australia/Brisbane': 'Australia',
  'Australia/Perth': 'Australia', 'Australia/Adelaide': 'Australia', 'Australia/Hobart': 'Australia', 'Australia/Darwin': 'Australia',
  'Pacific/Auckland': 'New Zealand',
  'America/Toronto': 'Canada', 'America/Vancouver': 'Canada', 'America/Edmonton': 'Canada', 'America/Winnipeg': 'Canada',
  'America/Halifax': 'Canada', 'America/Regina': 'Canada', 'America/St_Johns': 'Canada',
  'America/Mexico_City': 'Mexico', 'America/Sao_Paulo': 'Brazil', 'America/Argentina/Buenos_Aires': 'Argentina',
};
const ISO_EXCEPTIONS = { US: 'United States of America', GB: 'United Kingdom', AE: 'United Arab Emirates', KR: 'South Korea', CZ: 'Czechia', RU: 'Russia', VN: 'Vietnam', IR: 'Iran', HK: 'Hong Kong' };
let regionNames = null;
/** ISO 3166 code → country name (from the visitor's edge location, never an IP lookup here). */
function countryFromCode(code) {
  if (typeof code !== 'string' || !/^[A-Z]{2}$/.test(code)) return null;
  if (ISO_EXCEPTIONS[code]) return ISO_EXCEPTIONS[code];
  try { regionNames ||= new Intl.DisplayNames(['en'], { type: 'region' }); return regionNames.of(code) || null; } catch (_) { return null; }
}
const cityOf = (v) => (typeof v === 'string' && v.trim().length <= 60 && /^[\p{L}\p{M} .'’-]+$/u.test(v.trim()) ? v.trim() : null);

function regionOf(tz) {
  if (typeof tz !== 'string' || !tz) return null;
  if (TZ_COUNTRY[tz]) return TZ_COUNTRY[tz];
  if (/^(America\/(New_York|Chicago|Denver|Los_Angeles|Phoenix|Anchorage|Detroit|Boise|Indiana|Kentucky)|US\/|Pacific\/Honolulu)/.test(tz)) return 'United States of America';
  if (/^Canada\//.test(tz)) return 'Canada';
  if (/^Australia\//.test(tz)) return 'Australia';
  return 'Other';
}

module.exports = {
  ID, UUID, BROWSER_EVENTS, SERVER_EVENTS, BOOKING_STEPS,
  classifyPath, classifyTouch, topicOf, deviceOf, isBot, regionOf, countryFromCode, cityOf, hostOf, UNTRACKED,
};
