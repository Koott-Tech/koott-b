const { supabaseAdmin } = require('../config/supabase');
const { successResponse, errorResponse } = require('../utils/helpers');

// Admin list
const getAllBetterParentingAdmin = async (req, res) => {
  try {
    const { page = 1, limit = 20, search = '' } = req.query;
    const offset = (page - 1) * limit;

    let query = supabaseAdmin
      .from('better_parenting')
      .select('*', { count: 'exact' })
      .order('created_at', { ascending: false });

    if (search) {
      query = query.or(`slug.ilike.%${search}%,hero_title.ilike.%${search}%,seo_title.ilike.%${search}%`);
    }

    const { data: rows, error, count } = await query.range(offset, offset + limit - 1);
    if (error) throw error;

    return res.json(successResponse({
      pages: rows || [],
      pagination: { page: parseInt(page), limit: parseInt(limit), total: count || 0, totalPages: Math.ceil((count || 0) / limit) }
    }, 'Pages retrieved'));
  } catch (err) {
    return res.status(500).json(errorResponse('Failed to fetch pages', err.message));
  }
};

// Public list (published)
const getAllBetterParenting = async (req, res) => {
  try {
    const { page = 1, limit = 20, search = '' } = req.query;
    const offset = (page - 1) * limit;

    let query = supabaseAdmin
      .from('better_parenting')
      .select('*', { count: 'exact' })
      .eq('status', 'published')
      .order('menu_order', { ascending: true })
      .order('created_at', { ascending: false });

    if (search) {
      query = query.or(`slug.ilike.%${search}%,hero_title.ilike.%${search}%,seo_title.ilike.%${search}%`);
    }

    const { data: rows, error, count } = await query.range(offset, offset + limit - 1);
    if (error) throw error;

    return res.json(successResponse({
      pages: rows || [],
      pagination: { page: parseInt(page), limit: parseInt(limit), total: count || 0, totalPages: Math.ceil((count || 0) / limit) }
    }, 'Pages retrieved'));
  } catch (err) {
    return res.status(500).json(errorResponse('Failed to fetch pages', err.message));
  }
};

// Public by slug - no caching so CMS changes reflect immediately
const getBetterParentingBySlug = async (req, res) => {
  try {
    const { slug } = req.params;
    const { data, error } = await supabaseAdmin
      .from('better_parenting')
      .select('*')
      .eq('slug', slug)
      .eq('status', 'published')
      .maybeSingle();
    if (error) throw error;
    if (!data) return res.status(404).json(errorResponse('Page not found'));
    res.set('Cache-Control', 'no-store, no-cache, must-revalidate');
    return res.json(successResponse(data, 'Page retrieved'));
  } catch (err) {
    return res.status(500).json(errorResponse('Failed to fetch page', err.message));
  }
};

// Admin by id
const getBetterParentingById = async (req, res) => {
  try {
    const { id } = req.params;
    const { data, error } = await supabaseAdmin
      .from('better_parenting')
      .select('*')
      .eq('id', id)
      .maybeSingle();
    if (error) throw error;
    if (!data) return res.status(404).json(errorResponse('Page not found'));
    return res.json(successResponse(data, 'Page retrieved'));
  } catch (err) {
    return res.status(500).json(errorResponse('Failed to fetch page', err.message));
  }
};

// Create (robust to missing optional columns)
const createBetterParenting = async (req, res) => {
  try {
    const body = req.body || {};
    const {
      slug,
      status = 'draft',
      menu_order = 0,
      seo_title = '',
      seo_description,
      seo_keywords,
      og_title,
      og_description,
      og_image,
      canonical_url,
      robots,
      schema_enabled,
      schema_service_type,
      hero_title,
      hero_subtext = '',
      hero_image_url = '',
      benefits = [],
      benefits_title = '',
      benefits_image_url = '',
      types = [],
      types_title = '',
      right_image_url = '',
      mobile_image_url = '',
      faqs = [],
    } = body;

    if (!slug || !hero_title) {
      return res.status(400).json(errorResponse('Slug and hero title are required'));
    }

    const { data: existing } = await supabaseAdmin
      .from('better_parenting')
      .select('id')
      .eq('slug', slug)
      .single();
    if (existing) return res.status(400).json(errorResponse('Slug already exists'));

    // Step 1: minimal insert (always-existing columns)
    const minimalInsert = {
      slug,
      status,
      menu_order: menu_order || 0,
      seo_title,
      hero_title,
    };
    const { data: inserted, error: insertErr } = await supabaseAdmin
      .from('better_parenting')
      .insert([minimalInsert])
      .select('*')
      .single();
    if (insertErr) throw insertErr;

    // Step 2: prepare full payload, then keep only columns that exist in table
    const fullUpdate = {
      seo_description,
      seo_keywords,
      og_title,
      og_description,
      og_image,
      canonical_url,
      robots,
      schema_enabled,
      schema_service_type,
      hero_subtext,
      therapists_heading: body.therapists_heading,
      hero_image_url,
      benefits,
      benefits_title,
      benefits_image_url,
      types,
      types_title,
      right_image_url,
      mobile_image_url,
      faqs,
      info_cards: Array.isArray(body.info_cards) ? body.info_cards : undefined,
      videos: Array.isArray(body.videos) ? body.videos : undefined,
      videos_heading: body.videos_heading,
      videos_subheading: body.videos_subheading,
      videos_featured_index: typeof body.videos_featured_index === 'number' ? body.videos_featured_index : undefined,
      reviews: Array.isArray(body.reviews) ? body.reviews : undefined,
      reviews_heading: body.reviews_heading,
      blog_teaser_enabled: body.blog_teaser_enabled,
      blog_teaser_tag: body.blog_teaser_tag,
    };

    const allowedKeys = new Set(Object.keys(inserted || {}));
    const safeUpdate = {};
    Object.keys(fullUpdate).forEach((k) => {
      if (fullUpdate[k] !== undefined && allowedKeys.has(k)) {
        safeUpdate[k] = fullUpdate[k];
      }
    });

    let finalRow = inserted;
    if (Object.keys(safeUpdate).length > 0) {
      const { data: updatedRow, error: updateErr } = await supabaseAdmin
        .from('better_parenting')
        .update(safeUpdate)
        .eq('id', inserted.id)
        .select('*')
        .single();
      if (updateErr) throw updateErr;
      finalRow = updatedRow;
    }

    return res.status(201).json(successResponse(finalRow, 'Page created'));
  } catch (err) {
    return res.status(500).json(errorResponse('Failed to create page', err.message));
  }
};

// Update (robust to missing optional columns)
const updateBetterParenting = async (req, res) => {
  try {
    const { id } = req.params;
    const src = req.body || {};

    const slugify = (val = '') => val
      .toString()
      .toLowerCase()
      .trim()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/(^-|-$)/g, '');

    const updateData = {
      slug: src.slug,
      status: src.status,
      menu_order: src.menu_order,
      seo_title: src.seo_title,
      seo_description: src.seo_description,
      seo_keywords: src.seo_keywords,
      og_title: src.og_title,
      og_description: src.og_description,
      og_image: src.og_image,
      canonical_url: src.canonical_url,
      robots: src.robots,
      schema_enabled: src.schema_enabled,
      schema_service_type: src.schema_service_type,
      hero_title: src.hero_title,
      hero_subtext: src.hero_subtext,
      therapists_heading: src.therapists_heading,
      hero_image_url: src.hero_image_url,
      benefits_title: src.benefits_title,
      benefits: Array.isArray(src.benefits) ? src.benefits : undefined,
      benefits_image_url: src.benefits_image_url,
      types_title: src.types_title,
      types: Array.isArray(src.types) ? src.types : undefined,
      right_image_url: src.right_image_url,
      mobile_image_url: src.mobile_image_url,
      faqs: Array.isArray(src.faqs) ? src.faqs : undefined,
      info_cards: Array.isArray(src.info_cards) ? src.info_cards : undefined,
      videos: Array.isArray(src.videos) ? src.videos : undefined,
      videos_heading: src.videos_heading,
      videos_subheading: src.videos_subheading,
      videos_featured_index: typeof src.videos_featured_index === 'number' ? src.videos_featured_index : undefined,
      reviews: Array.isArray(src.reviews) ? src.reviews : undefined,
      reviews_heading: src.reviews_heading,
      blog_teaser_enabled: src.blog_teaser_enabled,
      blog_teaser_tag: src.blog_teaser_tag,
    };
    Object.keys(updateData).forEach((k) => updateData[k] === undefined && delete updateData[k]);

    // Fetch existing row to derive existing columns
    const { data: existingRow, error: fetchErr } = await supabaseAdmin
      .from('better_parenting')
      .select('*')
      .eq('id', id)
      .single();
    if (fetchErr) throw fetchErr;

    const allowedKeys = new Set(Object.keys(existingRow || {}));
    const safeUpdate = {};
    Object.keys(updateData).forEach((k) => {
      if (updateData[k] !== undefined && allowedKeys.has(k)) {
        safeUpdate[k] = updateData[k];
      }
    });

    if (safeUpdate.slug !== undefined) {
      const normalizedSlug = slugify(safeUpdate.slug);
      if (!normalizedSlug) {
        return res.status(400).json(errorResponse('Slug cannot be empty.'));
      }
      if (normalizedSlug !== existingRow.slug) {
        const { data: existingSlug } = await supabaseAdmin
          .from('better_parenting')
          .select('id')
          .eq('slug', normalizedSlug)
          .neq('id', id)
          .maybeSingle();
        if (existingSlug) {
          return res.status(400).json(errorResponse('Another better parenting page already uses this slug.'));
        }
      }
      safeUpdate.slug = normalizedSlug;
    }

    const { data, error } = await supabaseAdmin
      .from('better_parenting')
      .update(safeUpdate)
      .eq('id', id)
      .select('*')
      .single();
    if (error) throw error;
    return res.json(successResponse(data, 'Page updated'));
  } catch (err) {
    return res.status(500).json(errorResponse('Failed to update page', err.message));
  }
};

// Delete
const deleteBetterParenting = async (req, res) => {
  try {
    const { id } = req.params;
    const { error } = await supabaseAdmin
      .from('better_parenting')
      .delete()
      .eq('id', id);
    if (error) throw error;
    return res.json(successResponse(null, 'Page deleted'));
  } catch (err) {
    return res.status(500).json(errorResponse('Failed to delete page', err.message));
  }
};

module.exports = {
  getAllBetterParentingAdmin,
  getAllBetterParenting,
  getBetterParentingBySlug,
  getBetterParentingById,
  createBetterParenting,
  updateBetterParenting,
  deleteBetterParenting,
};


