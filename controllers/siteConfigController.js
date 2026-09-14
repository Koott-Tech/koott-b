const { supabaseAdmin } = require('../config/supabase');
const { successResponse, errorResponse } = require('../utils/helpers');

/**
 * Site-wide configuration held in the `cms` table (key -> jsonb).
 *
 * This is for chrome that is not page content and does not belong to any one
 * table: the footer's link columns, for instance. Reads are public and cached
 * briefly; writes are admin-only.
 *
 * Keys are whitelisted so this cannot be turned into an arbitrary key/value
 * store readable by anyone.
 */

// Site pages edited from the admin "Pages" section. Each page merges what is
// stored here over its built-in copy, section by section.
const PUBLIC_KEYS = new Set(['site_footer', 'site_home', 'site_about', 'site_faq', 'site_pricing']);

const isPublic = (key) => PUBLIC_KEYS.has(String(key || ''));

/** GET /api/site-config/:key — public, returns {} when nothing is stored yet. */
const getConfig = async (req, res) => {
  const { key } = req.params;
  if (!isPublic(key)) return res.status(404).json(errorResponse('Unknown configuration key'));

  try {
    const { data, error } = await supabaseAdmin
      .from('cms').select('data').eq('key', key).maybeSingle();

    if (error) {
      // The table not existing is a setup problem, not a request problem: the
      // caller falls back to its built-in defaults either way.
      console.error('[siteConfig.get]', error);
      return res.json(successResponse({ key, data: null }, 'No stored configuration'));
    }

    res.set('Cache-Control', 'public, max-age=60, s-maxage=300');
    return res.json(successResponse({ key, data: data?.data ?? null }, 'OK'));
  } catch (e) {
    console.error('[siteConfig.get]', e);
    return res.status(500).json(errorResponse('Failed to load configuration', e.message));
  }
};

/** PUT /api/site-config/:key — admin only. Body is the whole config object. */
const putConfig = async (req, res) => {
  const { key } = req.params;
  if (!isPublic(key)) return res.status(404).json(errorResponse('Unknown configuration key'));

  const data = req.body?.data ?? req.body;
  if (!data || typeof data !== 'object' || Array.isArray(data)) {
    return res.status(400).json(errorResponse('A configuration object is required'));
  }

  try {
    const { error } = await supabaseAdmin
      .from('cms')
      .upsert({ key, data, updated_at: new Date().toISOString() }, { onConflict: 'key' });
    if (error) throw error;
    return res.json(successResponse({ key, data }, 'Configuration saved'));
  } catch (e) {
    console.error('[siteConfig.put]', e);
    return res.status(500).json(errorResponse('Failed to save configuration', e.message));
  }
};

module.exports = { getConfig, putConfig, PUBLIC_KEYS };
