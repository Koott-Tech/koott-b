/**
 * Turn the scraped koott.in content pages into the data file StaticPageTemplate
 * renders. Drops the site furniture that appears on every Wix page (footer
 * trust badges, the crisis-line disclaimer, the workshop button row) so only
 * the page's own copy survives.
 */
const fs = require('fs');
const sp = require('./staticPages.json');

// Text that appears in the footer/header of every Wix page.
const FURNITURE = [
  /^your companion in your healing journey$/i,
  /^certified & available$/i,
  /^private & secure$/i,
  /^ssl secured/i,
  /we are not a suicide prevention helpline/i,
  /^©\s*2020-25 koott wellness/i,
  /^koott wellness pvt\. ltd\.?$/i,
  /^share this/i,
  /^subscribe/i,
  /^enter your email/i,
];
const isFurniture = (t) => FURNITURE.some((re) => re.test(t.trim()));

const clean = (t) => t.replace(/\u200b/g, '').replace(/\s+/g, ' ').trim();

function buildPage(slug, d) {
  const sections = [];
  for (const s of d.sections) {
    const paras = (s.paras || []).map(clean).filter((p) => p.length > 30 && !isFurniture(p));
    const cards = (s.cards || [])
      .map((c) => ({
        title: clean(c.title),
        body: clean(c.body || ''),
        items: (c.items || []).map(clean).filter(Boolean),
      }))
      .filter((c) => c.title && !isFurniture(c.title) && (c.body || c.items.length));

    const heading = clean(s.heading || '');
    if (!heading && !paras.length && !cards.length) continue;
    // The hero heading is rendered as the page <h1>; do not repeat it.
    if (heading && clean(d.h1) && heading === clean(d.h1) && !cards.length && paras.length <= 1) {
      if (paras.length) sections.push({ heading: '', paras, cards: [] });
      continue;
    }
    sections.push({ heading, paras, cards });
  }

  // Trim leading/trailing sections that ended up empty after cleaning.
  while (sections.length && !sections[0].heading && !sections[0].paras.length && !sections[0].cards.length) sections.shift();
  while (sections.length && !sections.at(-1).heading && !sections.at(-1).paras.length && !sections.at(-1).cards.length) sections.pop();

  const intro = sections.find((s) => s.paras.length)?.paras[0] || '';
  // Whichever section supplied the intro should not repeat it.
  if (intro) {
    const owner = sections.find((s) => s.paras[0] === intro);
    if (owner) owner.paras = owner.paras.slice(1);
  }

  return {
    slug,
    group: d.group,
    title: clean(d.h1) || clean(d.seo.title).replace(/\s*\|.*$/, ''),
    intro,
    seo: {
      title: clean(d.seo.title),
      description: d.seo.description || '',
      image: d.seo.ogImage || '',
    },
    sections: sections.filter((s) => s.heading || s.paras.length || s.cards.length),
  };
}

const pages = {};
let kept = 0, skipped = 0;
for (const [slug, d] of Object.entries(sp)) {
  if (d.error || d.group === 'SYNC') { skipped++; continue; }
  const p = buildPage(slug, d);
  const weight = p.sections.reduce((a, s) => a + s.paras.join(' ').length + s.cards.length * 60, 0);
  if (weight < 400) { console.log(`  THIN, needs browser harvest: ${slug} (${weight})`); skipped++; continue; }
  pages[slug] = p;
  kept++;
}

const header = `/**
 * Content pages ported from koott.in — the city landing pages plus the standalone
 * pages (/business, /selfhelp, /partnership-clinic and the rest).
 *
 * Each entry is the page's own copy: heading, intro, then its sections. They are
 * rendered by StaticPageTemplate and resolved by the top-level [conditionSlug]
 * route, which checks the CMS for a condition page first and falls back here.
 *
 * Generated from the live site — regenerate rather than hand-editing the copy.
 */

export const KOOTT_STATIC_PAGES = ${JSON.stringify(pages, null, 2)};

/** Look up one ported page by its URL slug. */
export function findStaticPage(slug) {
  return KOOTT_STATIC_PAGES[String(slug || '').toLowerCase()] || null;
}

export const STATIC_PAGE_SLUGS = Object.keys(KOOTT_STATIC_PAGES);

export default KOOTT_STATIC_PAGES;
`;

fs.writeFileSync('D:/koott-new/frontend/src/data/koottStaticPages.js', header);
const size = (fs.statSync('D:/koott-new/frontend/src/data/koottStaticPages.js').size / 1024).toFixed(0);
console.log(`\nwrote koottStaticPages.js — ${kept} pages, ${skipped} skipped, ${size}KB`);
Object.entries(pages).forEach(([s, p]) =>
  console.log(`  ${s.padEnd(40)} ${String(p.sections.length).padStart(2)} secs  ${p.sections.reduce((a, x) => a + x.cards.length, 0)} cards`));
