#!/usr/bin/env node
/**
 * Import the condition pages and blog posts scraped from the live Wix site into
 * the CMS tables (counselling_services, blogs).
 *
 * The page body is stored in counselling_services.content as the single object
 * ConditionPageTemplate renders — see frontend/src/data/conditionPageTemplateSample.js
 * for the shape. Scalar columns (slug, hero_title, seo_*) are filled too so the
 * admin list and the menu can query without parsing jsonb.
 *
 * Migration 0004 adds category / menu_group / menu_label / published_at. This
 * script probes for those columns first and, when they are not there yet, mirrors
 * the menu fields inside `content` so the import still works and nothing is lost —
 * run 0004 and re-run to move them into real columns.
 *
 * Usage:
 *   node scripts/importWixContent.js --check          inspect only, no writes
 *   node scripts/importWixContent.js --conditions     import the 45 condition pages
 *   node scripts/importWixContent.js --blogs          import the 142 blog posts
 *   node scripts/importWixContent.js --all            both
 *   ... --draft                                       import with status='draft'
 *
 * Re-running is safe: rows are matched on slug and updated in place.
 */

require('dotenv').config();
const fs = require('fs');
const path = require('path');
const { supabaseAdmin } = require('../config/supabase');

const DATA_DIR = process.env.WIX_IMPORT_DIR || path.join(__dirname, 'wix-import-data');
const argv = process.argv.slice(2);
const has = (f) => argv.includes(f);
const STATUS = has('--draft') ? 'draft' : 'published';

function loadJson(name) {
  const p = path.join(DATA_DIR, name);
  if (!fs.existsSync(p)) {
    console.error(`missing ${p}\n  Point WIX_IMPORT_DIR at the folder holding conditions.json / blogs.json.`);
    process.exit(1);
  }
  return JSON.parse(fs.readFileSync(p, 'utf8'));
}

/** Which of these columns actually exist on the table right now. */
async function presentColumns(table, candidates) {
  const out = [];
  for (const c of candidates) {
    const { error } = await supabaseAdmin.from(table).select(c).limit(1);
    if (!error) out.push(c);
  }
  return new Set(out);
}

/** Insert when the slug is new, update when it is not. */
async function upsertBySlug(table, row) {
  const { data: existing, error: findErr } = await supabaseAdmin
    .from(table).select('id').eq('slug', row.slug).maybeSingle();
  if (findErr) return { error: findErr, action: 'lookup' };

  if (existing) {
    const { error } = await supabaseAdmin.from(table).update(row).eq('id', existing.id);
    return { error, action: 'updated' };
  }
  const { error } = await supabaseAdmin.from(table).insert([row]);
  return { error, action: 'inserted' };
}

async function importConditions() {
  const pages = loadJson('conditions.json');
  const { transform } = require(path.join(DATA_DIR, 'transform.js'));

  const optional = await presentColumns('counselling_services',
    ['category', 'menu_group', 'menu_label', 'hero_subtext', 'hero_image_url', 'og_image', 'canonical_url']);
  console.log(`counselling_services optional columns present: ${[...optional].join(', ') || '(none — run migration 0004)'}\n`);

  let inserted = 0, updated = 0, failed = 0;
  for (const page of pages) {
    const content = transform(page);

    // Menu placement always travels inside `content` as well, so the header can
    // read it whether or not migration 0004 has been applied.
    content.menu = {
      category: page.category,
      group: page.menuGroup || null,
      label: page.menuLabel,
      order: page.menuOrder,
    };

    const row = {
      slug: page.slug,
      status: STATUS,
      menu_order: page.menuOrder,
      hero_title: content.hero.title,
      seo_title: page.seo.title,
      seo_description: page.seo.description,
      cover_image_url: page.hero.image || page.seo.ogImage || null,
      faqs: content.faqs,
      types: content.types.items,
      reviews: content.reviews.items,
      info_cards: content.symptoms.items,
      benefits: content.why.items,
      content,
    };
    if (optional.has('category')) row.category = page.category;
    if (optional.has('menu_group')) row.menu_group = page.menuGroup || null;
    if (optional.has('menu_label')) row.menu_label = page.menuLabel;
    if (optional.has('hero_subtext')) row.hero_subtext = content.hero.subtitle;
    if (optional.has('hero_image_url')) row.hero_image_url = page.hero.image || null;
    if (optional.has('og_image')) row.og_image = page.seo.ogImage || null;
    if (optional.has('canonical_url')) row.canonical_url = `https://www.koott.in/${page.slug}`;

    const { error, action } = await upsertBySlug('counselling_services', row);
    if (error) { failed++; console.log(`  FAIL ${page.slug}: ${error.message}`); }
    else if (action === 'inserted') inserted++;
    else updated++;
  }
  console.log(`conditions: ${inserted} inserted, ${updated} updated, ${failed} failed (of ${pages.length})`);
}

async function importBlogs() {
  const posts = loadJson('blogs.json');
  const optional = await presentColumns('blogs', ['published_at', 'canonical_url', 'meta_keywords']);
  console.log(`blogs optional columns present: ${[...optional].join(', ') || '(none)'}\n`);

  let inserted = 0, updated = 0, failed = 0, skipped = 0;
  for (const post of posts) {
    if (post.error || !post.content || !post.title) { skipped++; continue; }

    const row = {
      slug: post.slug,
      title: post.title,
      status: STATUS,
      excerpt: post.excerpt || '',
      content: post.content,
      featured_image_url: post.featured_image_url || null,
      author_name: post.author_name || 'Koott',
      categories: post.categories || [],
      tags: post.categories || [],
      read_time_minutes: post.read_time_minutes || 5,
      seo_title: post.seo_title || post.title,
      seo_description: post.excerpt || '',
      created_at: post.created_at || new Date().toISOString(),
    };
    if (optional.has('published_at')) {
      row.published_at = STATUS === 'published' ? (post.created_at || new Date().toISOString()) : null;
    }
    if (optional.has('canonical_url')) row.canonical_url = post.url;

    const { error, action } = await upsertBySlug('blogs', row);
    if (error) { failed++; console.log(`  FAIL ${post.slug}: ${error.message}`); }
    else if (action === 'inserted') inserted++;
    else updated++;
  }
  console.log(`blogs: ${inserted} inserted, ${updated} updated, ${failed} failed, ${skipped} skipped (of ${posts.length})`);
}

async function check() {
  for (const t of ['counselling_services', 'blogs']) {
    const { count, error } = await supabaseAdmin.from(t).select('id', { count: 'exact', head: true });
    console.log(`${t}: ${error ? 'ERROR ' + error.message : count + ' rows'}`);
  }
  const cs = await presentColumns('counselling_services', ['category', 'menu_group', 'menu_label']);
  const bl = await presentColumns('blogs', ['published_at']);
  console.log(`migration 0004 applied: counselling_services ${cs.size}/3 columns, blogs ${bl.size}/1`);

  const conditions = loadJson('conditions.json');
  const blogs = loadJson('blogs.json');
  console.log(`local data: ${conditions.length} condition pages, ${blogs.length} blog posts`);
}

(async () => {
  if (!argv.length || has('--check')) { await check(); return process.exit(0); }
  console.log(`importing with status='${STATUS}'\n`);
  if (has('--conditions') || has('--all')) await importConditions();
  if (has('--blogs') || has('--all')) await importBlogs();
  await check();
  process.exit(0);
})().catch((e) => { console.error(e); process.exit(1); });
