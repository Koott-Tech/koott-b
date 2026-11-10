/**
 * Where a lead or client came from — Instagram, Facebook, Google Ads, Google search,
 * WhatsApp, direct… — read from Koott's own first-party tracking (analytics/, SQL 0011):
 *
 *   booking_attribution  frozen when a client pays (first + latest touch of that visit)
 *   lead_attribution     a verified phone in the booking flow ↔ the visit it came from
 *   leads.meta.attribution  the website contact form (sent with the form, this file)
 *
 * The first touch is "where they first found us"; the last touch is "what brought them
 * back to book". Labels are worded for people ("Instagram ads", "Google search").
 */
const { supabaseAdmin } = require('../config/supabase');

const PLATFORMS = [
  [/instagram|^ig$|l\.instagram/, 'Instagram'],
  [/facebook|^fb$|^meta$|l\.facebook|m\.facebook/, 'Facebook'],
  [/google/, 'Google'], [/youtube|youtu\.be/, 'YouTube'], [/linkedin|lnkd/, 'LinkedIn'],
  [/whatsapp|wa\.me/, 'WhatsApp'], [/twitter|^x$|t\.co/, 'X (Twitter)'], [/bing/, 'Bing'],
  [/chatgpt|openai/, 'ChatGPT'], [/perplexity/, 'Perplexity'], [/gemini/, 'Gemini'], [/claude/, 'Claude'],
];
const platformOf = (source) => {
  const s = String(source || '').toLowerCase();
  const hit = PLATFORMS.find(([re]) => re.test(s));
  return hit ? hit[1] : null;
};

/** "Instagram ads", "Google search", "Direct"… */
function channelLabel(channel, source) {
  const p = platformOf(source);
  switch (channel) {
    case 'paid_social': return p ? `${p} ads` : 'Social media ads';
    case 'organic_social': return p || 'Social media';
    case 'paid_search': return p && p !== 'Google' ? `${p} ads` : 'Google Ads';
    case 'organic_search': return p ? `${p} search` : 'Search engine';
    case 'whatsapp': return 'WhatsApp';
    case 'email': return 'Email';
    case 'ai_platform': return p ? `${p} (AI assistant)` : 'AI assistant';
    case 'referral': return source && source !== '(direct)' ? `Another website (${source})` : 'Another website';
    case 'direct': return 'Direct (typed the address or a saved link)';
    default: return channel ? String(channel).replace(/_/g, ' ') : null;
  }
}

const last10 = (p) => String(p || '').replace(/\D/g, '').slice(-10);

/**
 * The tracker files a utm-tagged search engine (utm_source=google&utm_medium=organic) as a
 * "referral"; for people that is a search. Paid mediums are already "paid_search".
 */
const SEARCH_SOURCE = /^(google|bing|yahoo|duckduckgo|ecosia|yandex|baidu)(\.|$)/i;
function fixChannel(channel, source, medium) {
  if (channel === 'referral' && SEARCH_SOURCE.test(String(source || '')) && (!medium || /organic|search|seo/i.test(medium))) return 'organic_search';
  return channel || null;
}

function shape(row, from) {
  if (!row) return null;
  const firstSource = row.first_source || (row.first_channel === row.last_channel ? row.last_source : null) || null;
  const firstChannel = fixChannel(row.first_channel || row.last_channel, firstSource || row.last_source, row.first_medium || row.last_medium);
  const lastChannel = fixChannel(row.last_channel, row.last_source, row.last_medium);
  const out = {
    from, // booking | phone | contact form
    firstChannel, firstSource,
    first: channelLabel(firstChannel, firstSource || row.last_source),
    lastChannel, lastSource: row.last_source || null,
    last: channelLabel(lastChannel, row.last_source),
    medium: row.last_medium || row.first_medium || null,
    campaign: row.last_campaign || row.first_campaign || null,
    landing: row.landing_group || null,
    device: row.device_class || null,
    at: row.created_at || null,
  };
  out.label = out.first || out.last || null;
  return out.label ? out : null;
}

/**
 * Attribution for many leads / clients at once (one query per table).
 * @param {{ clientIds?: string[], phones?: string[] }} q
 * @returns {Promise<{ byClient: Map<string, object>, byPhone: Map<string, object> }>}
 */
async function attributionsFor({ clientIds = [], phones = [] }) {
  const byClient = new Map();
  const byPhone = new Map();
  const ids = [...new Set(clientIds.filter(Boolean))];
  const tails = [...new Set(phones.map(last10).filter((t) => t.length === 10))];
  try {
    for (let i = 0; i < ids.length; i += 150) {
      const { data } = await supabaseAdmin.from('booking_attribution').select('*')
        .in('client_id', ids.slice(i, i + 150)).order('created_at', { ascending: true });
      // The earliest booking that HAS tracking (bookings made without it are skipped).
      (data || []).forEach((r) => { if (!byClient.get(r.client_id)) { const a = shape(r, 'booking'); if (a) byClient.set(r.client_id, a); } });
    }
  } catch (_) { /* tracking tables not set up: no attribution */ }
  try {
    for (let i = 0; i < tails.length; i += 60) {
      const part = tails.slice(i, i + 60);
      const { data } = await supabaseAdmin.from('lead_attribution').select('*')
        .or(part.map((t) => `phone.like.*${t}`).join(','));
      (data || []).forEach((r) => { const t = last10(r.phone); if (!byPhone.get(t)) { const a = shape(r, 'phone'); if (a) byPhone.set(t, a); } });
    }
  } catch (_) { /* ignore */ }
  return { byClient, byPhone };
}

/** The best answer for one lead (its own form data first, then booking, then phone). */
function pick({ lead = null, clientId = null, phone = null }, maps) {
  const own = lead?.meta?.attribution ? shape(lead.meta.attribution, 'contact form') : null;
  return own
    || (clientId && maps.byClient.get(clientId))
    || (phone && maps.byPhone.get(last10(phone)))
    || null;
}

/** Turn the browser's analytics context into what a lead keeps (contact form). */
function fromContext(rawContext) {
  try {
    const { readContext } = require('../analytics/analytics.service');
    const ctx = readContext(rawContext);
    if (!ctx) return null;
    return {
      first_channel: ctx.first?.channel || null, first_source: ctx.first?.source || null,
      first_medium: ctx.first?.medium || null, first_campaign: ctx.first?.campaign || null,
      last_channel: ctx.touch?.channel || null, last_source: ctx.touch?.source || null,
      last_medium: ctx.touch?.medium || null, last_campaign: ctx.touch?.campaign || null,
      landing_path: ctx.landingPath ? String(ctx.landingPath).slice(0, 200) : null,
      created_at: new Date().toISOString(),
    };
  } catch (_) {
    return null;
  }
}

module.exports = { channelLabel, fixChannel, attributionsFor, pick, fromContext, last10 };
