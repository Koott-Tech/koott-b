/**
 * Meta Conversions API — built, and OFF until META_CAPI_ENABLED=true.
 *
 * What is prepared: one Purchase per verified Razorpay payment, only for
 * visitors who accepted advertising cookies. While sending is off, each
 * prepared conversion waits in analytics_outbox (provider 'meta', status
 * 'skipped', reason in last_error) so it can be inspected — nothing leaves
 * Koott. `node scripts/releaseMetaQueue.js` re-queues the last 7 days of held
 * conversions once sending is switched on (Meta accepts events up to 7 days old).
 *
 * Only an allowlisted payload is ever built — never a raw row:
 *   event:     Purchase · event_id purchase_<payment id> (the dedupe key) · time
 *   user_data: em, ph, external_id (SHA-256, normalised) · client_ip_address,
 *              client_user_agent, fbp, fbc (unhashed, per Meta's spec)
 *   custom:    currency INR, value
 * No therapist, session type, date, page or anything clinical.
 * Current API: https://developers.facebook.com/docs/marketing-api/conversions-api/parameters
 */

const crypto = require('crypto');
const axios = require('axios');

const config = () => ({
  pixelId: process.env.META_PIXEL_ID || null,
  token: process.env.META_CAPI_ACCESS_TOKEN || null,
  version: process.env.META_GRAPH_API_VERSION || 'v26.0',
  enabled: process.env.META_CAPI_ENABLED === 'true',
  testCode: process.env.META_TEST_EVENT_CODE || null,
  site: (process.env.FRONTEND_URL || process.env.SITE_URL || 'https://koott.in').replace(/\/+$/, ''),
});

const sha256 = (v) => crypto.createHash('sha256').update(v).digest('hex');
const normEmail = (e) => (typeof e === 'string' && e.includes('@') ? e.trim().toLowerCase() : null);
/** Digits only, with country code (Meta's rule). A bare 10-digit number is taken as Indian. */
const normPhone = (p) => {
  if (!p) return null;
  let d = String(p).replace(/\D/g, '').replace(/^0+/, '');
  if (d.length === 10) d = `91${d}`;
  return d.length >= 8 ? d : null;
};

/** Why a conversion is held instead of sent — shown on the dashboard. */
function holdReason() {
  const c = config();
  if (!c.enabled) return 'Held: Meta sending is switched off (META_CAPI_ENABLED is not "true")';
  if (!c.pixelId || !c.token) return 'Held: META_PIXEL_ID / META_CAPI_ACCESS_TOKEN not set';
  return null;
}

/**
 * Purchase payload for one verified payment. Returns null when it must not be
 * sent at all (no advertising consent recorded for this booking).
 */
function buildPurchase({ payment, attribution, client }) {
  if (!attribution?.consent_advertising) return null;
  const c = config();
  const em = normEmail(client?.email);
  const ph = normPhone(client?.phone_number);
  const user = {
    ...(em ? { em: [sha256(em)] } : {}),
    ...(ph ? { ph: [sha256(ph)] } : {}),
    ...(payment.client_id ? { external_id: [sha256(String(payment.client_id))] } : {}),
    ...(attribution.client_ip ? { client_ip_address: String(attribution.client_ip) } : {}),
    ...(attribution.client_user_agent ? { client_user_agent: attribution.client_user_agent } : {}),
    ...(attribution.fbp ? { fbp: attribution.fbp } : {}),
    ...(attribution.fbc ? { fbc: attribution.fbc } : {}),
  };
  const at = Date.parse(payment.completed_at || payment.paid_at || payment.updated_at || payment.created_at) || Date.now();
  return {
    data: [{
      event_name: 'Purchase',
      event_time: Math.floor(at / 1000),
      event_id: `purchase_${payment.id}`,
      action_source: 'website',
      event_source_url: `${c.site}/payment/success`,
      user_data: user,
      custom_data: { currency: 'INR', value: Number(payment.amount) || 0 },
    }],
    ...(c.testCode ? { test_event_code: c.testCode } : {}),
  };
}

/** POST to Meta. Throws on HTTP or semantic failure so the outbox retries. */
async function send(payload) {
  const c = config();
  const reason = holdReason();
  if (reason) { const e = new Error(reason); e.hold = true; throw e; }
  const url = `https://graph.facebook.com/${c.version}/${c.pixelId}/events`;
  const res = await axios.post(url, payload, {
    params: { access_token: c.token },
    timeout: 10000,
    validateStatus: () => true,
  });
  if (res.status >= 400) {
    const msg = res.data?.error?.message || `HTTP ${res.status}`;
    const e = new Error(`Meta ${res.status}: ${msg}`); e.status = res.status; throw e;
  }
  if (!(res.data?.events_received >= 1)) {
    const e = new Error('Meta accepted the request but reported 0 events received'); e.status = res.status; throw e;
  }
  return { status: res.status, fbtraceId: res.data?.fbtrace_id || null };
}

/** For the dashboard: what is configured, never the token. */
function status() {
  const c = config();
  return { pixelConfigured: !!c.pixelId, tokenConfigured: !!c.token, sending: c.enabled && !!c.pixelId && !!c.token, testMode: !!c.testCode, version: c.version };
}

module.exports = { buildPurchase, send, holdReason, status, _norm: { normEmail, normPhone } };
