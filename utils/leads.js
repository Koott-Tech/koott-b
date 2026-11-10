/**
 * The Operations lead list (table `leads`, migration 0021): every kind of lead in one
 * place, tagged with its source — booking flow, contact form, event, assessment, ad,
 * manual. Stages: new → contacted → follow_up → converted | lost.
 *
 * These helpers feed it from the places leads arrive and never throw: a lead that
 * cannot be saved must never break a booking or a form.
 */
const { supabaseAdmin } = require('../config/supabase');

const STAGES = ['new', 'contacted', 'follow_up', 'converted', 'lost'];
const SOURCES = ['booking', 'contact', 'event', 'assessment', 'ad', 'manual', 'phone', 'whatsapp', 'referral', 'newsletter'];

/** A phone as a lead keeps it: normalised when possible, else digits and + only (no spaces / dashes),
 *  so matching a client on the last 10 digits always works. */
function cleanPhone(p) {
  if (!p) return null;
  try { const n = require('./phoneVerification').normalizePhone(p); if (n) return n; } catch (_) { /* fall through */ }
  const s = String(p).replace(/[^\d+]/g, '');
  return s || null;
}

const clean = (o) => Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined && v !== null && v !== ''));

/**
 * Insert or refresh the lead for a source row. A lead an operator already moved on
 * keeps its stage; only "converted" (a paid booking) moves it forward by itself.
 */
async function upsertSourceLead({ source, sourceRef, sourceDetail, name, phone, email, clientId, psychologistId, converted, meta }) {
  try {
    if (!SOURCES.includes(source)) return null;
    const ref = sourceRef ? String(sourceRef) : null;
    let existing = null;
    if (ref) {
      const { data } = await supabaseAdmin.from('leads').select('id, stage').eq('source', source).eq('source_ref', ref).maybeSingle();
      existing = data;
    }
    const now = new Date().toISOString();
    const fields = clean({
      source_detail: sourceDetail, name, phone: cleanPhone(phone), email, client_id: clientId, psychologist_id: psychologistId,
      meta: meta && typeof meta === 'object' ? meta : undefined, updated_at: now,
    });
    if (converted) Object.assign(fields, { stage: 'converted', converted_at: now, stage_changed_at: now });
    if (existing) {
      if (existing.stage === 'converted' || existing.stage === 'lost') delete fields.stage;
      await supabaseAdmin.from('leads').update(fields).eq('id', existing.id);
      return existing.id;
    }
    const { data, error } = await supabaseAdmin.from('leads')
      .insert({ source, source_ref: ref, ...fields }).select('id').single();
    if (error) throw error;
    return data.id;
  } catch (e) {
    if (!/does not exist|schema cache/i.test(e.message || '')) console.warn('⚠️ Lead not saved:', e.message);
    return null;
  }
}

const OPEN_STAGES = ['new', 'contacted', 'follow_up'];
const last10 = (p) => String(p || '').replace(/\D/g, '').slice(-10);

/**
 * A client booked: every open lead that is this person — the same client, the same phone
 * (last 10 digits, so +91 / spaces / dashes do not matter) or the same email — becomes
 * "converted" and is linked to the client. Its "Call this lead" task closes.
 * @returns {Promise<number>} how many leads were converted
 */
async function convertLeadsForClient(clientId, { reason = 'Booked a session' } = {}) {
  if (!clientId) return 0;
  try {
    const { data: c } = await supabaseAdmin.from('clients').select('id, phone_number, email, user_id').eq('id', clientId).maybeSingle();
    if (!c) return 0;
    let email = c.email ? String(c.email).trim().toLowerCase() : null;
    if (!email && c.user_id) {
      const { data: u } = await supabaseAdmin.from('users').select('email').eq('id', c.user_id).maybeSingle();
      email = u?.email ? String(u.email).trim().toLowerCase() : null;
    }
    const tail = last10(c.phone_number);
    const parts = [`client_id.eq.${c.id}`];
    if (tail.length === 10) parts.push(`phone.like.*${tail}`);
    if (email && /^[^@\s,()]+@[^@\s,()]+$/.test(email)) parts.push(`email.eq.${email}`);
    const { data: open } = await supabaseAdmin.from('leads').select('id, meta, phone, email').in('stage', OPEN_STAGES).or(parts.join(',')).limit(50);
    const mine = open || [];
    let n = 0;
    const now = new Date().toISOString();
    for (const l of mine) {
      const { data: done } = await supabaseAdmin.from('leads').update({
        stage: 'converted', client_id: c.id, converted_at: now, stage_changed_at: now, updated_at: now,
        meta: { ...(l.meta || {}), converted_automatically: reason },
      }).eq('id', l.id).in('stage', OPEN_STAGES).select('id');
      if (done && done.length) {
        n += 1;
        await supabaseAdmin.from('tasks').update({ status: 'done', completed_at: now, updated_at: now })
          .eq('auto_key', `lead_call:${l.id}`).not('status', 'in', '(done,cancelled)');
      }
    }
    return n;
  } catch (_) {
    return 0; /* table not there yet */
  }
}

/** A paid booking: this client's open leads are converted (matched by client, phone or email). */
async function markClientConverted(clientId) {
  return convertLeadsForClient(clientId, { reason: 'Paid for a session' });
}

module.exports = { STAGES, SOURCES, upsertSourceLead, markClientConverted, convertLeadsForClient, cleanPhone };
