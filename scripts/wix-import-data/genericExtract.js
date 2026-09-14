/**
 * Generic page extractor for the koott.in pages that are not condition pages.
 *
 * Condition pages have a fixed strip order (extract.js exploits that); the rest
 * — plans-pricing, community, the city landing pages, about-us and so on — do
 * not. So this walks each <section> in document order and records whatever it
 * finds: heading, paragraphs, cards (h3 + following copy), bullet lists, images
 * and button labels. That is enough to rebuild a page faithfully without
 * assuming a layout.
 */
const { parse, get, clean } = require('./lib');
const { bareMedia } = require('./extract');

/** Cards in a section: each h3 starts one, the copy after it belongs to it. */
function cardsIn(sec) {
  const out = [];
  let cur = null;
  for (const n of sec.querySelectorAll('h3,h4,p,li')) {
    const t = clean(n.textContent);
    if (!t) continue;
    if (n.tagName === 'H3' || n.tagName === 'H4') {
      cur = { title: t, body: '', items: [] };
      out.push(cur);
      continue;
    }
    if (!cur) continue;
    if (n.tagName === 'LI') { if (!cur.items.includes(t)) cur.items.push(t); continue; }
    if (cur.items.includes(t)) continue;          // Wix mirrors <li> as <p>
    if (!cur.body) cur.body = t;
  }
  return out.filter((c) => c.body || c.items.length);
}

async function extractGeneric(slug) {
  const url = `https://www.koott.in/${slug}`;
  const html = await get(url);
  if (!html) return { slug, error: 'fetch failed' };
  const doc = parse(html);

  const sections = [];
  for (const sec of doc.querySelectorAll('section')) {
    const text = clean(sec.textContent);
    if (!text || text.length < 25) continue;
    // Wix ships one enormous section of CSS custom properties for its galleries.
    if (text.length > 20000) continue;

    const heading = clean(sec.querySelector('h1,h2')?.textContent || '');
    const cards = cardsIn(sec);
    const cardText = new Set();
    cards.forEach((c) => { if (c.body) cardText.add(c.body); c.items.forEach((i) => cardText.add(i)); });

    const paras = [...sec.querySelectorAll('p')].map((p) => clean(p.textContent))
      .filter((t) => t.length > 25 && !cardText.has(t));
    const buttons = [...sec.querySelectorAll('button,a')].map((b) => clean(b.textContent))
      .filter((t) => t && t.length < 40);
    const images = [...sec.querySelectorAll('img')].map((i) => bareMedia(i.src)).filter(Boolean);

    sections.push({
      id: sec.id || null,
      heading,
      paras,
      cards,
      buttons: [...new Set(buttons)].slice(0, 6),
      images: [...new Set(images)].slice(0, 6),
      chars: text.length,
    });
  }

  // FAQ questions live on accordion buttons; the answers are React-gated and are
  // harvested separately in the browser when a page needs them.
  const faqQuestions = [...doc.querySelectorAll('button')]
    .map((b) => clean(b.textContent))
    .filter((t) => t.endsWith('?') && t.length > 12);

  return {
    slug,
    url,
    seo: {
      title: clean(doc.querySelector('title')?.textContent),
      description: doc.querySelector('meta[name=description]')?.content || '',
      ogImage: bareMedia(doc.querySelector('meta[property="og:image"]')?.content || ''),
    },
    h1: clean(doc.querySelector('h1')?.textContent || ''),
    sections,
    faqQuestions: [...new Set(faqQuestions)],
  };
}

module.exports = { extractGeneric };

if (require.main === module) {
  (async () => {
    const d = await extractGeneric(process.argv[2] || 'plans-pricing');
    console.log('slug:', d.slug, '| h1:', d.h1);
    console.log('seo:', d.seo.title);
    console.log('sections:', d.sections.length);
    d.sections.forEach((s, i) => {
      console.log(`\n[${i}] ${s.heading || '(no heading)'}  (${s.chars} chars, ${s.cards.length} cards)`);
      s.paras.slice(0, 2).forEach((p) => console.log('    p:', p.slice(0, 110)));
      s.cards.slice(0, 4).forEach((c) => console.log('    -', c.title, '|', (c.body || c.items.join(' / ')).slice(0, 80)));
      if (s.buttons.length) console.log('    btns:', s.buttons.join(' · '));
    });
  })();
}
