/**
 * SEO scoring for pages and blog posts.
 *
 * One implementation, deliberately on the server: the Pages list, the SEO
 * Assistant and the publish check all read the same numbers, and the dashboard
 * never computes a score of its own. The editor scores a draft by POSTing it
 * here rather than reimplementing any of this in the browser.
 *
 * Every check is derived from real stored values. A field that has not been
 * filled in scores as missing — nothing here invents a result.
 */

// Google truncates around these; they are advice, not limits, so going over
// warns and never blocks.
const TITLE_MIN = 30;
const TITLE_MAX = 60;
const DESC_MIN = 70;
const DESC_MAX = 160;

const text = (v) => (typeof v === 'string' ? v.trim() : '');
const has = (v) => text(v).length > 0;
const lower = (v) => text(v).toLowerCase();

/** Words of the focus keyword, so "online counselling" matches "counselling online". */
const keywordParts = (kw) => lower(kw).split(/\s+/).filter(Boolean);

const containsKeyword = (haystack, kw) => {
  const parts = keywordParts(kw);
  if (!parts.length) return false;
  const h = lower(haystack);
  return parts.every((p) => h.includes(p));
};

/**
 * Walk a page's content object and pull out the strings worth scoring.
 * The shape differs per page (hero/sections/items/…), so this collects rather
 * than assuming any particular schema.
 */
function collectContent(content, depth = 0) {
  const out = { headings: [], body: [], links: [], images: [] };
  if (!content || depth > 6) return out;

  if (Array.isArray(content)) {
    for (const v of content) {
      const sub = collectContent(v, depth + 1);
      out.headings.push(...sub.headings);
      out.body.push(...sub.body);
      out.links.push(...sub.links);
      out.images.push(...sub.images);
    }
    return out;
  }
  if (typeof content !== 'object') return out;

  for (const [k, v] of Object.entries(content)) {
    const key = k.toLowerCase();
    if (typeof v === 'string') {
      if (!v.trim()) continue;
      if (/(^|_)(title|heading|headline|eyebrow)($|_)/.test(key)) out.headings.push(v);
      else if (/(href|url|link)$/.test(key)) out.links.push(v);
      else if (/(image|photo|img|src)$/.test(key)) out.images.push({ url: v });
      else if (/alt$/.test(key)) out.images.push({ alt: v });
      else out.body.push(v);
    } else if (v && typeof v === 'object') {
      const sub = collectContent(v, depth + 1);
      out.headings.push(...sub.headings);
      out.body.push(...sub.body);
      out.links.push(...sub.links);
      out.images.push(...sub.images);
    }
  }
  return out;
}

const check = (key, status, message) => ({ key, status, message });

/**
 * @param {object} page     page_meta row: { name, path, page_type, status, seo, social }
 * @param {object} content  the page's stored content (cms.data), optional
 * @returns {{score:number, status:'good'|'needs_attention'|'critical', checks:Array}}
 */
function calculatePageSEOScore(page = {}, content = null) {
  const seo = page.seo || {};
  const social = page.social || {};
  const checks = [];

  const kw = text(seo.focus_keyword);
  const title = text(seo.title);
  const desc = text(seo.description);
  const path = text(page.path);
  const collected = collectContent(content);
  const headings = collected.headings;
  const body = collected.body.join(' ');

  // ---- critical: without these the page cannot rank at all -----------------
  const indexable = seo.robots_index !== false;
  checks.push(indexable
    ? check('indexable', 'pass', 'Search engines are allowed to show this page')
    : check('indexable', 'fail', 'This page is hidden from Google (noindex)'));

  checks.push(has(title)
    ? check('meta_title', 'pass', 'SEO title is set')
    : check('meta_title', 'fail', 'SEO title is missing'));

  checks.push(has(desc)
    ? check('meta_description', 'pass', 'Meta description is set')
    : check('meta_description', 'fail', 'Meta description is missing'));

  // A page whose text is not in the CMS yet has nothing to read, which is not
  // the same as having no heading. Reporting a failure there would mark every
  // not-yet-migrated page critical over something the marketing team cannot fix.
  if (content == null) {
    checks.push(check('h1', 'warn', 'This page\u2019s text is not in the CMS yet, so its headings cannot be checked'));
  } else {
    checks.push(headings.length
      ? check('h1', 'pass', 'The page has a main heading')
      : check('h1', 'fail', 'No main heading found in the page content'));
  }

  // ---- focus keyword -------------------------------------------------------
  if (!has(kw)) {
    checks.push(check('focus_keyword', 'warn', 'No focus keyword set, so keyword checks are skipped'));
  } else {
    checks.push(check('focus_keyword', 'pass', `Focus keyword: "${kw}"`));
    checks.push(containsKeyword(title, kw)
      ? check('keyword_in_title', 'pass', 'Focus keyword appears in the SEO title')
      : check('keyword_in_title', 'warn', 'Focus keyword is not in the SEO title'));
    checks.push(headings.some((h) => containsKeyword(h, kw))
      ? check('keyword_in_heading', 'pass', 'Focus keyword appears in a heading')
      : check('keyword_in_heading', 'warn', 'Focus keyword is not in any heading'));
    checks.push(containsKeyword(desc, kw)
      ? check('keyword_in_description', 'pass', 'Focus keyword appears in the meta description')
      : check('keyword_in_description', 'warn', 'Focus keyword is not in the meta description'));
    checks.push(containsKeyword(path.replace(/[-/]/g, ' '), kw)
      ? check('keyword_in_url', 'pass', 'Focus keyword appears in the URL')
      : check('keyword_in_url', 'warn', 'Focus keyword is not in the URL'));
    if (body) {
      checks.push(containsKeyword(body, kw)
        ? check('keyword_in_body', 'pass', 'Focus keyword appears in the page text')
        : check('keyword_in_body', 'warn', 'Focus keyword is not in the page text'));
    }
  }

  // ---- length advice -------------------------------------------------------
  if (has(title)) {
    const n = title.length;
    checks.push(n >= TITLE_MIN && n <= TITLE_MAX
      ? check('title_length', 'pass', `SEO title is ${n} characters`)
      : check('title_length', 'warn', n < TITLE_MIN
        ? `SEO title is short (${n}); around ${TITLE_MIN}–${TITLE_MAX} reads better in Google`
        : `SEO title is long (${n}); Google may cut it off after about ${TITLE_MAX}`));
  }
  if (has(desc)) {
    const n = desc.length;
    checks.push(n >= DESC_MIN && n <= DESC_MAX
      ? check('description_length', 'pass', `Meta description is ${n} characters`)
      : check('description_length', 'warn', n < DESC_MIN
        ? `Meta description is short (${n}); around ${DESC_MIN}–${DESC_MAX} reads better`
        : `Meta description is long (${n}); Google may cut it off after about ${DESC_MAX}`));
  }

  // ---- supporting signals --------------------------------------------------
  checks.push(has(seo.canonical)
    ? check('canonical', 'pass', 'Canonical URL is set')
    : check('canonical', 'warn', 'No canonical URL set; the page URL will be used'));

  const internal = collected.links.filter((l) => /^\/(?!\/)/.test(text(l)));
  checks.push(internal.length
    ? check('internal_links', 'pass', `${internal.length} internal link(s) found`)
    : check('internal_links', 'warn', 'No internal links found in the page content'));

  const imgs = collected.images.filter((i) => i.url);
  const alts = collected.images.filter((i) => i.alt);
  if (imgs.length) {
    checks.push(alts.length >= imgs.length
      ? check('image_alt', 'pass', 'Images have alt text')
      : check('image_alt', 'warn', `${imgs.length - alts.length} image(s) have no alt text`));
  }

  checks.push(has(social.og_title) || has(social.og_description) || has(social.og_image)
    ? check('social', 'pass', 'Social sharing metadata is set')
    : check('social', 'warn', 'No social sharing metadata; the SEO title and description will be used'));

  // ---- score ---------------------------------------------------------------
  // A failure costs far more than a warning: a noindex page or a missing title
  // is not "slightly worse", it is the difference between ranking and not.
  const fails = checks.filter((c) => c.status === 'fail').length;
  const warns = checks.filter((c) => c.status === 'warn').length;
  const total = checks.length || 1;
  let score = Math.round(((total - fails * 1 - warns * 0.4) / total) * 100);
  score = Math.max(0, Math.min(100, score));

  const status = fails > 0 ? 'critical' : warns > 2 ? 'needs_attention' : 'good';

  return { score, status, checks, counts: { pass: total - fails - warns, warn: warns, fail: fails } };
}

module.exports = { calculatePageSEOScore, collectContent, TITLE_MIN, TITLE_MAX, DESC_MIN, DESC_MAX };
