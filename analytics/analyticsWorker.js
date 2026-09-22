/**
 * Outbox worker. The payments trigger (migration 0011) queues a row whenever a
 * Razorpay payment becomes success / failed / refunded; this turns each into
 * one analytics event, exactly once, whichever path (webhook, success
 * callback, status poll, recovery job) changed the payment.
 *
 * Runs inside the Render web process every minute. Rows are claimed with
 * FOR UPDATE SKIP LOCKED, so a second instance never double-processes.
 * Failures retry with backoff and go to dead_letter after 8 attempts — the
 * dashboard's Conversion delivery page shows them. Nothing here is on the
 * booking path: a slow or failing run never delays a payment.
 *
 * Meta: each verified payment (with advertising consent) also prepares a
 * Purchase row for provider 'meta'. It is held — status 'skipped', reason in
 * last_error — until META_CAPI_ENABLED=true (see providers/meta.js).
 */

const cron = require('node-cron');
const { supabaseAdmin } = require('../config/supabase');
const { recordServerEvent, isMissingTable, logError, env } = require('./analytics.service');
const meta = require('./providers/meta');

const BACKOFF_MIN = [1, 5, 15, 60, 180, 360, 720, 1440];
const MAX_ATTEMPTS = 8;

function log(fields) {
  // structured, and never with personal data or tokens
  console.log(JSON.stringify({ at: new Date().toISOString(), component: 'analytics_outbox', ...fields }));
}

/** Business meaning of a payment, without anything clinical: session vs package, and the broad kind. */
function describePayment(p) {
  const pkg = Number(p.session_count) > 1 || /package/i.test(p.package_type || '') || /package/i.test(p.session_type || '');
  let kind = 'individual';
  if (p.assessment_session_id) kind = 'assessment';
  else if (pkg) kind = 'package';
  else if (/couple/i.test(p.session_type || '') || /couple/i.test(p.package_type || '')) kind = 'couple';
  else if (/psychiatr|consult/i.test(p.session_type || '')) kind = 'psychiatry';
  return { item_kind: pkg ? 'package' : 'session', kind };
}

function ctxFromAttribution(ba) {
  if (!ba) return null;
  return {
    anonymousId: ba.anonymous_id, sessionId: ba.analytics_session_id, region: ba.region,
    touch: { channel: ba.last_channel, source: ba.last_source, medium: ba.last_medium, campaign: ba.last_campaign },
    first: { channel: ba.first_channel },
    landingPath: null,
  };
}

/** Queue (or hold) the Meta Purchase for a verified payment. Only with advertising consent. */
async function prepareMetaPurchase(p, ba) {
  const { data: contact } = p.client_id
    ? await supabaseAdmin.from('clients').select('email, phone_number').eq('id', p.client_id).maybeSingle()
    : { data: null };
  const payload = meta.buildPurchase({ payment: p, attribution: ba, client: contact });
  if (!payload) return; // no advertising consent: nothing is prepared for Meta
  const reason = meta.holdReason();
  const { error } = await supabaseAdmin.from('analytics_outbox').upsert({
    event_id: `purchase_${p.id}`, event_name: 'Purchase', provider: 'meta', payment_id: p.id, payload,
    status: reason ? 'skipped' : 'pending', last_error: reason,
    processed_at: reason ? new Date().toISOString() : null,
  }, { onConflict: 'provider,event_name,event_id', ignoreDuplicates: true });
  if (error) logError('prepare meta purchase', error);
}

async function handleInternal(row) {
  const { data: p, error } = await supabaseAdmin.from('payments')
    .select('id, client_id, psychologist_id, amount, status, session_type, package_type, session_count, assessment_session_id, razorpay_response, paid_at, completed_at, failed_at, updated_at, created_at')
    .eq('id', row.payment_id).maybeSingle();
  if (error) throw error;
  if (!p) return 'skipped';

  const { data: ba } = await supabaseAdmin.from('booking_attribution').select('*').eq('payment_id', p.id).maybeSingle();
  const ctx = ctxFromAttribution(ba);
  const { data: client } = p.client_id
    ? await supabaseAdmin.from('clients').select('user_id').eq('id', p.client_id).maybeSingle()
    : { data: null };
  const overrides = {
    environment: ba?.environment || env(),
    channel: ba?.last_channel || 'unattributed',
    first_channel: ba?.first_channel || ba?.last_channel || 'unattributed',
    landing_group: ba?.landing_group || null,
    landing_topic: ba?.landing_topic || null,
    device_class: ba?.device_class || null,
    utm_content: ba?.utm_content || null,
    utm_term: ba?.utm_term || null,
  };
  const d = describePayment(p);

  if (row.event_name === 'payment_completed') {
    const { count } = await supabaseAdmin.from('payments').select('id', { count: 'exact', head: true })
      .eq('client_id', p.client_id).eq('status', 'success').lt('created_at', p.created_at);
    await recordServerEvent({
      eventId: row.event_id, name: 'booking_completed', ctx, userId: client?.user_id,
      at: p.completed_at || p.paid_at || p.updated_at, paymentId: p.id, psychologistId: p.psychologist_id,
      value: Number(p.amount) || 0, props: { ...d, returning: (count || 0) > 0 ? 'yes' : 'no' }, overrides,
    });
    await prepareMetaPurchase(p, ba);
    return 'sent';
  }
  if (row.event_name === 'payment_failed') {
    const r = p.razorpay_response || {};
    const code = String(r?.error?.code || r?.error_code || r?.code || 'unknown').toLowerCase().replace(/[^a-z0-9_]/g, '_').slice(0, 60);
    await recordServerEvent({
      eventId: row.event_id, name: 'payment_failed', ctx, userId: client?.user_id,
      at: p.failed_at || p.updated_at, paymentId: p.id, psychologistId: p.psychologist_id,
      value: Number(p.amount) || 0, props: { item_kind: d.item_kind, code: /^[a-z]/.test(code) ? code : 'unknown' }, overrides,
    });
    return 'sent';
  }
  if (row.event_name === 'booking_cancelled') {
    await recordServerEvent({
      eventId: row.event_id, name: 'booking_cancelled', ctx, userId: client?.user_id,
      at: p.updated_at, paymentId: p.id, psychologistId: p.psychologist_id,
      value: Number(p.amount) || 0, props: { ...d, reason: 'refund' }, overrides,
    });
    return 'sent';
  }
  return 'skipped';
}

async function processBatch() {
  const { data: rows, error } = await supabaseAdmin.rpc('analytics_claim_outbox', { batch: 50 });
  if (error) { if (!isMissingTable(error)) logError('claim outbox', error); return; }
  for (const row of rows || []) {
    try {
      let status;
      let note = null;
      if (row.provider === 'internal') status = await handleInternal(row);
      else if (row.provider === 'meta') {
        const reason = meta.holdReason();
        if (reason) { status = 'skipped'; note = reason; } // switched off since it was queued
        else { await meta.send(row.payload); status = 'sent'; }
      } else status = 'skipped';
      await supabaseAdmin.from('analytics_outbox')
        .update({ status, processed_at: new Date().toISOString(), locked_until: null, last_error: note })
        .eq('id', row.id);
      log({ event_id: row.event_id, provider: row.provider, event_name: row.event_name, status, attempt: row.attempt_count });
    } catch (e) {
      const dead = row.attempt_count >= MAX_ATTEMPTS;
      const wait = BACKOFF_MIN[Math.min(row.attempt_count - 1, BACKOFF_MIN.length - 1)] || 1;
      await supabaseAdmin.from('analytics_outbox').update({
        status: dead ? 'dead_letter' : 'failed',
        next_retry_at: new Date(Date.now() + wait * 60000).toISOString(),
        locked_until: null,
        last_error: String(e?.message || e).replace(/(token|secret|key)=[^&\s]+/gi, '$1=[redacted]').slice(0, 300),
      }).eq('id', row.id);
      log({ event_id: row.event_id, provider: row.provider, event_name: row.event_name, status: dead ? 'dead_letter' : 'failed', attempt: row.attempt_count });
    }
  }
}

/** Retention: what the privacy plan promises, enforced daily. */
async function purge() {
  const days = (n) => new Date(Date.now() - n * 86400000).toISOString();
  const ipDays = Number(process.env.ANALYTICS_IP_RETENTION_DAYS) || 30;
  const eventDays = Number(process.env.ANALYTICS_EVENT_RETENTION_DAYS) || 395;
  const jobs = [
    supabaseAdmin.from('booking_attribution').update({ client_ip: null, client_user_agent: null }).lt('created_at', days(ipDays)).not('client_ip', 'is', null),
    supabaseAdmin.from('visitor_attribution').update({ fbclid: null, gclid: null, gbraid: null, wbraid: null }).lt('last_seen_at', days(90)),
    supabaseAdmin.from('analytics_events').delete().lt('occurred_at', days(eventDays)),
    supabaseAdmin.from('analytics_outbox').delete().eq('status', 'sent').lt('processed_at', days(30)),
    // held / failed rows can carry an IP for Meta matching: same 30-day limit
    supabaseAdmin.from('analytics_outbox').delete().in('status', ['dead_letter', 'skipped']).lt('created_at', days(ipDays)),
  ];
  const results = await Promise.all(jobs);
  results.forEach((r) => r.error && logError('retention', r.error));
}

let running = false;
function startAnalyticsWorker() {
  if (process.env.ANALYTICS_OUTBOX_ENABLED === 'false') {
    console.log('ℹ️ Analytics outbox worker disabled (ANALYTICS_OUTBOX_ENABLED=false)');
    return;
  }
  cron.schedule('* * * * *', async () => {
    if (running) return;
    running = true;
    try { await processBatch(); } catch (e) { logError('outbox run', e); } finally { running = false; }
  });
  cron.schedule('20 3 * * *', () => purge().catch((e) => logError('retention', e)), { timezone: 'Asia/Kolkata' });
  console.log('✅ Analytics outbox worker started (every minute; retention purge 03:20 IST)');
}

module.exports = { startAnalyticsWorker, processBatch, purge, describePayment };
