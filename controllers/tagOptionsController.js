/**
 * The tag vocabulary (migration 0020).
 *
 *   GET  /api/tags              every kind, for the booking filters
 *   GET  /api/admin/tags        the same, plus inactive values
 *   POST /api/admin/tags        add or edit a value
 *
 * Values are controlled rather than typed: seven therapists had produced 37
 * different conditions, most used once, and the booking filter is built from
 * whatever is stored. The admin picks from these lists instead.
 *
 * The public read is open. It is a list of therapy topics and languages with no
 * one's data in it, the booking page needs it before anyone signs in, and the
 * kinds clients never see are left out rather than filtered in the browser.
 */

const { supabaseAdmin } = require('../config/supabase');
const { successResponse, errorResponse } = require('../utils/helpers');

/** Everything a client can filter by. Team and employment are internal. */
const PUBLIC_KINDS = ['condition', 'language', 'method', 'type', 'mode'];
const ALL_KINDS = [...PUBLIC_KINDS, 'employment'];

/** Before migration 0020 the table does not exist; the page should still load. */
const notMigrated = (error) => error?.code === '42P01'
  || /does not exist/i.test(error?.message || '');

const EMPTY = () => Object.fromEntries(ALL_KINDS.map((k) => [k, []]));

/** Rows grouped by kind, each already in display order. */
async function readTags({ kinds, includeInactive = false }) {
  let q = supabaseAdmin
    .from('tag_options')
    .select('kind, value, label, sort_order, is_active')
    .in('kind', kinds)
    .order('kind')
    .order('sort_order');
  if (!includeInactive) q = q.eq('is_active', true);

  const { data, error } = await q;
  if (error) {
    if (notMigrated(error)) return { tags: EMPTY(), ready: false };
    throw error;
  }

  const tags = Object.fromEntries(kinds.map((k) => [k, []]));
  (data || []).forEach((r) => {
    (tags[r.kind] ||= []).push({
      value: r.value, label: r.label, sortOrder: r.sort_order, isActive: r.is_active,
    });
  });
  return { tags, ready: true };
}

/** The lists the booking filters are built from. */
const publicTags = async (req, res) => {
  try {
    const { tags, ready } = await readTags({ kinds: PUBLIC_KINDS });
    res.set('Cache-Control', 'public, max-age=300');
    return res.json(successResponse({ tags, ready }, 'Tag options'));
  } catch (error) {
    console.error('Get tag options error:', error);
    return res.status(500).json(errorResponse('Could not load tag options'));
  }
};

/** Everything, including values switched off and the internal kinds. */
const adminTags = async (req, res) => {
  try {
    const { tags, ready } = await readTags({ kinds: ALL_KINDS, includeInactive: true });
    return res.json(successResponse({ tags, ready }, 'Tag options'));
  } catch (error) {
    console.error('Get admin tag options error:', error);
    return res.status(500).json(errorResponse('Could not load tag options'));
  }
};

/**
 * Add a value, or change one.
 *
 * `value` is what therapists carry and what filters compare, so it is written
 * once and then left alone — editing it would orphan every therapist already
 * tagged with it. The label is what people read and is free to change. To
 * retire a value, set is_active false: existing therapists keep it and it stops
 * being offered, which deleting it would not do.
 */
const upsertTag = async (req, res) => {
  const { kind, value, label, sortOrder, isActive } = req.body || {};
  if (!ALL_KINDS.includes(kind)) {
    return res.status(400).json(errorResponse(`kind must be one of: ${ALL_KINDS.join(', ')}`));
  }
  const slug = String(value || '').trim().toLowerCase().replace(/\s+/g, '-');
  if (!slug) return res.status(400).json(errorResponse('value is required'));
  if (!String(label || '').trim()) return res.status(400).json(errorResponse('label is required'));

  try {
    const { data, error } = await supabaseAdmin
      .from('tag_options')
      .upsert({
        kind,
        value: slug,
        label: String(label).trim(),
        sort_order: Number.isFinite(Number(sortOrder)) ? Number(sortOrder) : 999,
        is_active: isActive !== false,
      }, { onConflict: 'kind,value' })
      .select()
      .single();
    if (error) {
      if (notMigrated(error)) {
        return res.status(503).json(errorResponse('Run supabase/migrations/0020_therapist_tags.sql first.'));
      }
      throw error;
    }
    return res.json(successResponse(data, 'Tag saved'));
  } catch (error) {
    console.error('Save tag option error:', error);
    return res.status(500).json(errorResponse('Could not save that tag'));
  }
};

module.exports = { publicTags, adminTags, upsertTag, PUBLIC_KINDS, ALL_KINDS };
