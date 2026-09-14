/**
 * Psychiatrist pricing → `packages` rows. Psychiatrists offer consultations only
 * (no couple sessions), each followed by the usual 10-min break:
 *
 *   psychiatry_15             one 15-min consultation   = psychiatrist_15min_price
 *   psychiatry_30             one 30-min consultation   = psychiatrist_30min_price
 *   psychiatry_15_package_N   N × 15-min consultations  (priced by admin)
 *
 * Saving writes the two price columns, upserts those rows by package_type and
 * switches the psychiatrist's other packages (old therapy individual / couple /
 * package_N rows, dropped bundles) to is_active = false. Nothing is deleted:
 * clients who already bought a package keep it.
 */

const { supabaseAdmin } = require('../config/supabase');

const BUNDLE_RE = /^psychiatry_15_package_(\d+)$/;
const isPsychiatryType = (t) => /^psychiatry_(15|30)(_package_\d+)?$/.test(String(t || ''));
const isPsychiatristDesignation = (d) => /psychiatr/i.test(String(d || ''));
const money = (v) => {
  const n = Number(v);
  return Number.isFinite(n) && n > 0 ? Math.round(n) : null;
};

async function loadPsychiatrist(psychologistId) {
  const { data, error } = await supabaseAdmin
    .from('psychologists')
    .select('id, first_name, last_name, designation, psychiatrist_15min_price, psychiatrist_30min_price')
    .eq('id', psychologistId)
    .maybeSingle();
  if (error) throw error;
  return data;
}

async function getPsychiatryPricing(psychologistId) {
  const psych = await loadPsychiatrist(psychologistId);
  if (!psych) return { found: false };

  const { data: rows, error } = await supabaseAdmin
    .from('packages')
    .select('id, package_type, session_count, price, is_active')
    .eq('psychologist_id', psychologistId);
  if (error) throw error;

  const active = (rows || []).filter((r) => r.is_active !== false);
  const byType = new Map(active.map((r) => [r.package_type, r]));
  const bundles = active
    .filter((r) => BUNDLE_RE.test(r.package_type))
    .map((r) => ({ sessions: Number(r.session_count), price: Number(r.price) }))
    .sort((a, b) => a.sessions - b.sessions);

  return {
    found: true,
    name: `${psych.first_name || ''} ${psych.last_name || ''}`.trim(),
    isPsychiatrist: isPsychiatristDesignation(psych.designation),
    price15: Number(byType.get('psychiatry_15')?.price ?? psych.psychiatrist_15min_price) || null,
    price30: Number(byType.get('psychiatry_30')?.price ?? psych.psychiatrist_30min_price) || null,
    bundles,
    configured: active.some((r) => isPsychiatryType(r.package_type)),
    otherActivePackages: active.filter((r) => !isPsychiatryType(r.package_type)).length,
  };
}

/** Validate input. → { value } or { error } */
function normalizePricing(input = {}) {
  const price15 = money(input.price15);
  const price30 = money(input.price30);
  if (!price15) return { error: 'Enter the price of a 15-min consultation' };
  if (!price30) return { error: 'Enter the price of a 30-min consultation' };
  const bundles = [];
  const seen = new Set();
  for (const b of Array.isArray(input.bundles) ? input.bundles : []) {
    const sessions = Number(b?.sessions);
    const price = money(b?.price);
    if (!Number.isInteger(sessions) || sessions < 2 || sessions > 30) {
      return { error: 'A package needs between 2 and 30 consultations' };
    }
    if (!price) return { error: `Enter a price for the ${sessions}-consultation package` };
    if (seen.has(sessions)) return { error: `There are two ${sessions}-consultation packages` };
    seen.add(sessions);
    bundles.push({ sessions, price });
  }
  bundles.sort((a, b) => a.sessions - b.sessions);
  return { value: { price15, price30, bundles } };
}

async function savePsychiatryPricing(psychologistId, input) {
  const { value, error: invalid } = normalizePricing(input);
  if (invalid) return { success: false, status: 400, message: invalid };

  const psych = await loadPsychiatrist(psychologistId);
  if (!psych) return { success: false, status: 404, message: 'Psychologist not found' };
  if (!isPsychiatristDesignation(psych.designation)) {
    return { success: false, status: 400, message: 'Psychiatry pricing is only for doctors with a Psychiatrist designation' };
  }

  const stamp = new Date().toISOString();
  const { error: priceErr } = await supabaseAdmin
    .from('psychologists')
    .update({ psychiatrist_15min_price: value.price15, psychiatrist_30min_price: value.price30, updated_at: stamp })
    .eq('id', psychologistId);
  if (priceErr) throw priceErr;

  const desired = [
    {
      package_type: 'psychiatry_15', session_count: 1, price: value.price15,
      name: '15-min consultation', description: 'One 15-minute psychiatry consultation',
    },
    {
      package_type: 'psychiatry_30', session_count: 1, price: value.price30,
      name: '30-min consultation', description: 'One 30-minute psychiatry consultation',
    },
    ...value.bundles.map((b) => ({
      package_type: `psychiatry_15_package_${b.sessions}`, session_count: b.sessions, price: b.price,
      name: `${b.sessions} × 15-min consultations`, description: `${b.sessions} psychiatry consultations of 15 minutes`,
    })),
  ];

  const { data: rows, error: rowsErr } = await supabaseAdmin
    .from('packages')
    .select('id, package_type, is_active')
    .eq('psychologist_id', psychologistId);
  if (rowsErr) throw rowsErr;

  const byType = new Map();
  (rows || []).forEach((r) => { if (!byType.has(r.package_type)) byType.set(r.package_type, r); });
  const keep = new Set(desired.map((d) => d.package_type));

  for (const d of desired) {
    const existing = byType.get(d.package_type);
    if (existing) {
      const { error } = await supabaseAdmin
        .from('packages')
        .update({ ...d, is_active: true, updated_at: stamp })
        .eq('id', existing.id);
      if (error) throw error;
    } else {
      const { error } = await supabaseAdmin
        .from('packages')
        .insert([{ ...d, psychologist_id: psychologistId, is_active: true, created_at: stamp, updated_at: stamp }]);
      if (error) throw error;
    }
  }

  const retire = (rows || []).filter((r) => !keep.has(r.package_type) && r.is_active !== false).map((r) => r.id);
  if (retire.length) {
    const { error } = await supabaseAdmin
      .from('packages')
      .update({ is_active: false, updated_at: stamp })
      .in('id', retire);
    if (error) throw error;
  }

  return {
    success: true,
    message: `Psychiatry pricing saved — ${desired.length} options live${retire.length ? `, ${retire.length} old package(s) switched off` : ''}`,
    pricing: await getPsychiatryPricing(psychologistId),
  };
}

module.exports = { getPsychiatryPricing, savePsychiatryPricing, normalizePricing, isPsychiatryType };
