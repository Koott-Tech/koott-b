/**
 * CMS — pages.
 *
 * The registry the marketing dashboard's "Edit Pages" list reads, plus the SEO
 * metadata each page carries. The page BODY is not duplicated here: it stays in
 * the `cms` table (site_home, site_about, …) where siteConfigController already
 * serves it, so there is one copy of the content and this adds a metadata layer
 * over it.
 *
 * Scores are computed by utils/seoScore.js and never by the dashboard, so the
 * list, the editor and any later publish check cannot disagree.
 */

const { supabaseAdmin } = require('../config/supabase');
const { successResponse, errorResponse } = require('../utils/helpers');
const { calculatePageSEOScore } = require('../utils/seoScore');
const auditLogger = require('../utils/auditLogger');

// The page body lives under the same key in `cms` for the site pages. Anything
// else has no stored body yet, and scores on its metadata alone.
const contentKeyFor = (row) => (row.page_key.startsWith('site_') ? row.page_key : null);

/** Load the stored content for several pages in one query. */
async function loadContent(rows) {
  const keys = rows.map(contentKeyFor).filter(Boolean);
  if (!keys.length) return {};
  const { data, error } = await supabaseAdmin.from('cms').select('key,data').in('key', keys);
  if (error) {
    // Scoring degrades to metadata-only rather than failing the whole list.
    console.error('[pages.loadContent]', error);
    return {};
  }
  return Object.fromEntries((data || []).map((r) => [r.key, r.data]));
}

const shape = (row, content) => {
  const seo = calculatePageSEOScore(row, content ?? null);
  return {
    key: row.page_key,
    name: row.name,
    path: row.path,
    pageType: row.page_type,
    status: row.status,
    editable: row.editable,
    indexable: row.seo?.robots_index !== false,
    seo: row.seo || {},
    social: row.social || {},
    seoScore: seo.score,
    seoStatus: seo.status,
    updatedBy: row.updated_by,
    updatedAt: row.updated_at,
  };
};

/** GET /api/pages — the Pages list. */
const listPages = async (req, res) => {
  try {
    const { data, error } = await supabaseAdmin
      .from('page_meta').select('*').order('page_type').order('name');
    if (error) throw error;

    const rows = data || [];
    const content = await loadContent(rows);
    const pages = rows.map((r) => shape(r, content[contentKeyFor(r) || '']));

    // Counts for the dashboard's SEO status cards — real values, not estimates.
    // System entries (the footer and anything else that is site chrome rather
    // than a page) have no URL and no SEO, so counting them as "critical" would
    // report a problem that cannot be fixed.
    const scored = pages.filter((p) => p.pageType !== 'system');
    const summary = {
      total: pages.length,
      scored: scored.length,
      good: scored.filter((p) => p.seoStatus === 'good').length,
      needsAttention: scored.filter((p) => p.seoStatus === 'needs_attention').length,
      critical: scored.filter((p) => p.seoStatus === 'critical').length,
      noindex: scored.filter((p) => !p.indexable).length,
      missingTitle: scored.filter((p) => !p.seo?.title).length,
      missingDescription: scored.filter((p) => !p.seo?.description).length,
    };

    return res.json(successResponse({ pages, summary }, 'OK'));
  } catch (e) {
    console.error('[pages.list]', e);
    return res.status(500).json(errorResponse('Failed to load pages', e.message));
  }
};

/** GET /api/pages/:key — one page, with its full check list. */
const getPage = async (req, res) => {
  try {
    const { data, error } = await supabaseAdmin
      .from('page_meta').select('*').eq('page_key', req.params.key).maybeSingle();
    if (error) throw error;
    if (!data) return res.status(404).json(errorResponse('Page not found'));

    const contentKey = contentKeyFor(data);
    let content = null;
    if (contentKey) {
      const { data: c } = await supabaseAdmin
        .from('cms').select('data').eq('key', contentKey).maybeSingle();
      content = c?.data ?? null;
    }

    const analysis = calculatePageSEOScore(data, content);
    return res.json(successResponse({ ...shape(data, content), analysis, hasContent: !!content }, 'OK'));
  } catch (e) {
    console.error('[pages.get]', e);
    return res.status(500).json(errorResponse('Failed to load page', e.message));
  }
};

/**
 * POST /api/pages/score — score a draft without saving it.
 * The editor calls this (debounced) so the live preview and the stored score
 * come from the same code.
 */
const scoreDraft = async (req, res) => {
  try {
    const { page, content } = req.body || {};
    if (!page || typeof page !== 'object') {
      return res.status(400).json(errorResponse('A page object is required'));
    }
    return res.json(successResponse(calculatePageSEOScore(page, content ?? null), 'OK'));
  } catch (e) {
    console.error('[pages.score]', e);
    return res.status(500).json(errorResponse('Failed to score page', e.message));
  }
};

const SEO_FIELDS = ['focus_keyword', 'title', 'description', 'canonical', 'robots_index', 'robots_follow'];

/** PATCH /api/pages/:key/seo — update the SEO block, keeping a revision. */
const updateSeo = async (req, res) => {
  const { key } = req.params;
  try {
    const { data: row, error: readErr } = await supabaseAdmin
      .from('page_meta').select('*').eq('page_key', key).maybeSingle();
    if (readErr) throw readErr;
    if (!row) return res.status(404).json(errorResponse('Page not found'));

    // The footer is chrome, not a page: giving it SEO metadata would put a
    // non-existent URL into the sitemap.
    if (row.page_type === 'system') {
      return res.status(400).json(errorResponse('This item has no page of its own, so it has no SEO settings'));
    }

    const incoming = req.body?.seo ?? req.body ?? {};
    const next = { ...(row.seo || {}) };
    for (const f of SEO_FIELDS) {
      if (Object.prototype.hasOwnProperty.call(incoming, f)) next[f] = incoming[f];
    }

    if (typeof next.title === 'string' && next.title.length > 300) {
      return res.status(400).json(errorResponse('SEO title is too long'));
    }
    if (typeof next.description === 'string' && next.description.length > 1000) {
      return res.status(400).json(errorResponse('Meta description is too long'));
    }

    const actor = req.user?.email || null;
    const { error: writeErr } = await supabaseAdmin
      .from('page_meta')
      .update({ seo: next, updated_by: actor, updated_at: new Date().toISOString() })
      .eq('page_key', key);
    if (writeErr) throw writeErr;

    // History first-class: the previous value is kept whole so a restore needs
    // no reconstruction.
    await supabaseAdmin.from('page_revisions').insert({
      page_key: key,
      kind: 'seo',
      before: row.seo || {},
      after: next,
      user_email: actor,
      user_role: req.user?.role || null,
    });

    // The save and its revision are already committed. Audit logging must never
    // turn a successful save into an error the user sees, or they retry and a
    // second revision is written for a change that already landed.
    try {
      await auditLogger.logRequest(req, 'cms.page.seo_updated', 'page_meta', key, {
        changed: SEO_FIELDS.filter((f) => (row.seo || {})[f] !== next[f]),
      });
    } catch (logErr) {
      console.error('[pages.updateSeo] audit log failed (save was kept)', logErr);
    }

    return res.json(successResponse({ key, seo: next }, 'SEO settings saved'));
  } catch (e) {
    console.error('[pages.updateSeo]', e);
    return res.status(500).json(errorResponse('Failed to save SEO settings', e.message));
  }
};

/** GET /api/pages/:key/versions — revision history, newest first. */
const listVersions = async (req, res) => {
  try {
    const { data, error } = await supabaseAdmin
      .from('page_revisions')
      .select('id,kind,note,user_email,user_role,created_at')
      .eq('page_key', req.params.key)
      .order('created_at', { ascending: false })
      .limit(50);
    if (error) throw error;
    return res.json(successResponse({ versions: data || [] }, 'OK'));
  } catch (e) {
    console.error('[pages.listVersions]', e);
    return res.status(500).json(errorResponse('Failed to load version history', e.message));
  }
};


/* ----------------------------------------------------------- content/draft */

/**
 * GET /api/pages/:key/content
 * The published content and the draft, so the editor can open the draft when
 * there is one and fall back to what is live when there is not.
 */
const getContent = async (req, res) => {
  const { key } = req.params;
  try {
    const { data, error } = await supabaseAdmin
      .from('cms')
      .select('data,draft_data,draft_updated_at,draft_updated_by,published_at,published_by')
      .eq('key', key).maybeSingle();
    if (error) throw error;
    return res.json(successResponse({
      key,
      published: data?.data ?? null,
      draft: data?.draft_data ?? null,
      hasDraft: !!data?.draft_data,
      draftUpdatedAt: data?.draft_updated_at ?? null,
      draftUpdatedBy: data?.draft_updated_by ?? null,
      publishedAt: data?.published_at ?? null,
      publishedBy: data?.published_by ?? null,
    }, 'OK'));
  } catch (e) {
    console.error('[pages.getContent]', e);
    return res.status(500).json(errorResponse('Failed to load content', e.message));
  }
};

/**
 * PUT /api/pages/:key/content — save a draft.
 * Deliberately does not touch `data`, so the live site keeps showing the last
 * published version while someone works.
 */
const saveDraft = async (req, res) => {
  const { key } = req.params;
  const draft = req.body?.data ?? req.body;
  if (!draft || typeof draft !== 'object' || Array.isArray(draft)) {
    return res.status(400).json(errorResponse('A content object is required'));
  }
  try {
    const actor = req.user?.email || null;
    const { error } = await supabaseAdmin.from('cms').upsert({
      key,
      draft_data: draft,
      draft_updated_at: new Date().toISOString(),
      draft_updated_by: actor,
      updated_at: new Date().toISOString(),
    }, { onConflict: 'key' });
    if (error) throw error;
    return res.json(successResponse({ key, savedAt: new Date().toISOString() }, 'Draft saved'));
  } catch (e) {
    console.error('[pages.saveDraft]', e);
    return res.status(500).json(errorResponse('Failed to save draft', e.message));
  }
};

/**
 * POST /api/pages/:key/publish — make the draft live.
 * The version being replaced is written to page_revisions first, so publishing
 * can always be undone.
 */
const publish = async (req, res) => {
  const { key } = req.params;
  try {
    const { data: row, error: readErr } = await supabaseAdmin
      .from('cms').select('data,draft_data').eq('key', key).maybeSingle();
    if (readErr) throw readErr;

    // Allow publishing a body sent straight from the editor, so "Publish" works
    // even if the draft save has not landed yet.
    const next = req.body?.data ?? row?.draft_data ?? null;
    if (!next) return res.status(400).json(errorResponse('There is nothing to publish'));

    const actor = req.user?.email || null;
    const now = new Date().toISOString();

    // History before the change, so a restore needs no reconstruction.
    await supabaseAdmin.from('page_revisions').insert({
      page_key: key,
      kind: 'publish',
      before: row?.data ?? null,
      after: next,
      user_email: actor,
      user_role: req.user?.role || null,
    });

    const { error: writeErr } = await supabaseAdmin.from('cms').upsert({
      key,
      data: next,
      draft_data: null,
      draft_updated_at: null,
      draft_updated_by: null,
      published_at: now,
      published_by: actor,
      updated_at: now,
    }, { onConflict: 'key' });
    if (writeErr) throw writeErr;

    try {
      await auditLogger.logRequest(req, 'cms.page.published', 'cms', key, {});
    } catch (logErr) {
      console.error('[pages.publish] audit log failed (publish was kept)', logErr);
    }

    return res.json(successResponse({ key, publishedAt: now }, 'Published — the live page now shows this version'));
  } catch (e) {
    console.error('[pages.publish]', e);
    return res.status(500).json(errorResponse('Failed to publish', e.message));
  }
};

/** POST /api/pages/:key/discard-draft — throw the unpublished work away. */
const discardDraft = async (req, res) => {
  const { key } = req.params;
  try {
    const { data: row } = await supabaseAdmin
      .from('cms').select('draft_data').eq('key', key).maybeSingle();
    if (!row?.draft_data) return res.status(400).json(errorResponse('There is no draft to discard'));

    // Kept as a revision rather than deleted outright: discarding is easy to do
    // by accident and the work is otherwise unrecoverable.
    await supabaseAdmin.from('page_revisions').insert({
      page_key: key,
      kind: 'draft_discarded',
      before: row.draft_data,
      after: null,
      user_email: req.user?.email || null,
      user_role: req.user?.role || null,
    });

    const { error } = await supabaseAdmin.from('cms')
      .update({ draft_data: null, draft_updated_at: null, draft_updated_by: null })
      .eq('key', key);
    if (error) throw error;
    return res.json(successResponse({ key }, 'Draft discarded'));
  } catch (e) {
    console.error('[pages.discardDraft]', e);
    return res.status(500).json(errorResponse('Failed to discard draft', e.message));
  }
};

/** GET /api/pages/:key/versions/:id — one revision in full, for viewing. */
const getVersion = async (req, res) => {
  try {
    const { data, error } = await supabaseAdmin
      .from('page_revisions').select('*')
      .eq('id', req.params.id).eq('page_key', req.params.key).maybeSingle();
    if (error) throw error;
    if (!data) return res.status(404).json(errorResponse('Version not found'));
    return res.json(successResponse(data, 'OK'));
  } catch (e) {
    console.error('[pages.getVersion]', e);
    return res.status(500).json(errorResponse('Failed to load version', e.message));
  }
};

/**
 * POST /api/pages/:key/restore/:id — put an earlier version back.
 * It is restored as a DRAFT, not published: restoring is then reviewable, and
 * one wrong click cannot change the live site.
 */
const restoreVersion = async (req, res) => {
  const { key, id } = req.params;
  try {
    const { data: rev, error } = await supabaseAdmin
      .from('page_revisions').select('*').eq('id', id).eq('page_key', key).maybeSingle();
    if (error) throw error;
    if (!rev) return res.status(404).json(errorResponse('Version not found'));

    // 'before' is the content that was replaced, which is what restoring means.
    const target = rev.before ?? rev.after;
    if (!target || typeof target !== 'object') {
      return res.status(400).json(errorResponse('This version holds no content to restore'));
    }

    const actor = req.user?.email || null;
    const { error: writeErr } = await supabaseAdmin.from('cms').upsert({
      key,
      draft_data: target,
      draft_updated_at: new Date().toISOString(),
      draft_updated_by: actor,
      updated_at: new Date().toISOString(),
    }, { onConflict: 'key' });
    if (writeErr) throw writeErr;

    await supabaseAdmin.from('page_revisions').insert({
      page_key: key, kind: 'restore', before: null, after: target,
      note: `Restored from ${new Date(rev.created_at).toISOString()}`,
      user_email: actor, user_role: req.user?.role || null,
    });

    return res.json(successResponse({ key }, 'Restored as a draft — review it, then publish'));
  } catch (e) {
    console.error('[pages.restoreVersion]', e);
    return res.status(500).json(errorResponse('Failed to restore version', e.message));
  }
};

module.exports = {
  listPages, getPage, scoreDraft, updateSeo,
  getContent, saveDraft, publish, discardDraft,
  listVersions, getVersion, restoreVersion,
};
