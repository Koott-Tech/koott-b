/**
 * Fold the browser-harvested pages into staticPages.json.
 *
 * These pages render their copy client-side, so the server-side scrape saw only
 * furniture. The browser pass captured ordered blocks instead; this rebuilds
 * them into the {heading, paras, cards} section shape the rest of the pipeline
 * expects, cutting a new section at every heading.
 */
const fs = require('fs');
const sp = require('./staticPages.json');
const browser = require('./staticBrowser.json');

// Pages that have no portable copy on the live site: Wix apps (a forum that has
// been discontinued, an events widget, a quiz) or interactive pickers. Cloning
// them means building the feature, not porting text.
const NOT_CONTENT = new Set([
  'community',          // live shows "Wix Forum is no longer available"
  'workshops',          // empty widget shell
  'depression-test',    // quiz widget, no copy
  'couple-feelings',    // interactive concern picker
  'teens-feelings',
  'indvidual-feelings',
  'feedback',           // feedback form
  'event-list',         // list of events, driven by event_pages
  'plans-pricing',      // pricing widget — and the live copy is half placeholder
]);

let merged = 0;
for (const [slug, b] of Object.entries(browser)) {
  if (NOT_CONTENT.has(slug)) continue;
  const blocks = b.blocks || [];
  if (!blocks.length) continue;

  const h1 = (b.h1 || '').replace(/\s+/g, ' ').trim();
  const sections = [];
  let cur = { heading: '', paras: [], cards: [] };

  for (const blk of blocks) {
    const x = blk.x.replace(/\s+/g, ' ').trim();
    if (!x) continue;
    if (blk.t === 'H1') continue;                       // becomes the page title
    if (blk.t === 'H2' || blk.t === 'H3') {
      if (cur.heading || cur.paras.length || cur.cards.length) sections.push(cur);
      cur = { heading: x, paras: [], cards: [] };
      continue;
    }
    // Short list items read as card titles; longer ones are body copy.
    if (blk.t === 'LI' && x.length < 90) {
      cur.cards.push({ title: x, body: '', items: [] });
      continue;
    }
    if (x.length > 25) cur.paras.push(x);
  }
  if (cur.heading || cur.paras.length || cur.cards.length) sections.push(cur);

  // A card with no body is only useful in a group; otherwise fold it back to copy.
  sections.forEach((s) => {
    if (s.cards.length === 1 && !s.cards[0].body) {
      s.paras.push(s.cards[0].title);
      s.cards = [];
    }
  });

  sp[slug] = {
    ...(sp[slug] || {}),
    slug,
    group: sp[slug]?.group || 'MISSING',
    h1: h1 || sp[slug]?.h1 || '',
    seo: sp[slug]?.seo || { title: b.title, description: '', ogImage: '' },
    sections: sections.map((s) => ({
      heading: s.heading,
      paras: s.paras,
      cards: s.cards,
      buttons: [],
      images: [],
      chars: s.paras.join(' ').length,
    })),
  };
  merged++;
  console.log(`merged ${slug.padEnd(24)} ${sections.length} sections, ${sections.reduce((a, s) => a + s.paras.length, 0)} paras`);
}

fs.writeFileSync('staticPages.json', JSON.stringify(sp, null, 1));
console.log(`\nmerged ${merged} browser-harvested pages`);
console.log('deliberately not ported (no content to clone):', [...NOT_CONTENT].join(', '));
