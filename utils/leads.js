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
      source_detail: sourceDetail, name, phone, email, client_id: clientId, psychologist_id: psychologistId,
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

/** A paid booking: this client's open leads are converted. */
async function markClientConverted(clientId) {
  if (!clientId) return;
  try {
    const now = new Date().toISOString();
    await supabaseAdmin.from('leads')
      .update({ stage: 'converted', converted_at: now, stage_changed_at: now, updated_at: now })
      .eq('client_id', clientId).in('stage', ['new', 'contacted', 'follow_up']);
  } catch (_) { /* table not there yet */ }
}

module.exports = { STAGES, SOURCES, upsertSourceLead, markClientConverted };
