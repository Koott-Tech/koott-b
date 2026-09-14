const { parse, get, clean } = require('./lib');

/** Wix serves transform URLs (/v1/fill/...) that 404 when hotlinked. Reduce to the bare media URL. */
const bareMedia = (u) => {
  if (!u) return '';
  const m = String(u).match(/^(https:\/\/static\.wixstatic\.com\/media\/[^/]+)(\/v1\/.*)?$/);
  return m ? m[1] : String(u);
};

/** Cards in a section: each h3 is a title, the paragraphs/list items after it are its body. */
function cardsIn(sec, { bullets = false } = {}) {
  const nodes = [...sec.querySelectorAll('h3,p,li')];
  const out = [];
  let cur = null;
  for (const n of nodes) {
    const t = clean(n.textContent);
    if (!t) continue;
    if (n.tagName === 'H3') { cur = { title: t, body: '', items: [] }; out.push(cur); continue; }
    if (!cur) continue;
    if (n.tagName === 'LI') { if (!cur.items.includes(t)) cur.items.push(t); continue; }
    // Wix mirrors each <li> as a <p>; skip a paragraph that just repeats a bullet.
    if (cur.items.includes(t)) continue;
    if (!cur.body) cur.body = t;
  }
  // Most sections give each card a paragraph; the "Types of … We Treat" cards
  // are a bullet list on some pages and a paragraph on others, so keep both and
  // let the caller choose.
  return out
    .map(c => (bullets ? { title: c.title, body: c.body, items: c.items } : { title: c.title, body: c.body }))
    .filter(c => c.title && (c.body || (c.items && c.items.length)));
}

/** Intro paragraph = the first paragraph that sits before the first h3. */
function introOf(sec) {
  const nodes = [...sec.querySelectorAll('h3,p')];
  for (const n of nodes) {
    if (n.tagName === 'H3') return '';
    const t = clean(n.textContent);
    if (t && t.length > 25) return t;
  }
  return '';
}

const headOf = (sec) => clean(sec.querySelector('h2,h1')?.textContent || '');

/** Find the section whose heading matches a pattern. */
const findSec = (secs, re) => secs.find(s => re.test(headOf(s)));

async function extractPage(slug) {
  const html = await get(`https://www.koott.in/${slug}`);
  if (!html) return { slug, error: 'fetch failed' };
  const doc = parse(html);
  const secs = [...doc.querySelectorAll('section')];
  if (!secs.length) return { slug, error: 'no sections' };

  const heroSec = secs[0];
  const heroImg = [...heroSec.querySelectorAll('img')].map(i => i.src).filter(Boolean)[0] || '';

  // Hero stats: h4 (figure) + following p (caption).
  const stats = [];
  [...heroSec.querySelectorAll('h4')].forEach(h => {
    const fig = clean(h.textContent);
    let p = h.parentElement;
    let cap = '';
    for (let up = 0; up < 4 && p && !cap; up++, p = p.parentElement) {
      const cand = [...p.querySelectorAll('p')].map(x => clean(x.textContent)).filter(t => t.length > 20)[0];
      if (cand) cap = cand;
    }
    if (fig) stats.push({ figure: fig, caption: cap });
  });

  const heroPs = [...heroSec.querySelectorAll('p')].map(p => clean(p.textContent)).filter(Boolean);
  const verified = heroPs.find(t => /^✔/.test(t)) || '';

  const used = new Set();
  const secIndex = {};
  const sec = (re, opts, fallbackIndex, key) => {
    let s = findSec(secs, re);
    if (s) used.add(secs.indexOf(s));
    if (!s && fallbackIndex != null && secs[fallbackIndex] && !used.has(fallbackIndex)
        && headOf(secs[fallbackIndex])) {
      s = secs[fallbackIndex];
      used.add(fallbackIndex);
    }
    if (!s) return null;
    if (key) secIndex[key] = secs.indexOf(s);
    const cards = cardsIn(s, opts);
    // Every paragraph that is not part of a card — the "What is X?" body runs to
    // several paragraphs (English then Malayalam) and all of them are content.
    const cardText = new Set();
    cards.forEach(c => { if (c.body) cardText.add(c.body); (c.items || []).forEach(i => cardText.add(i)); });
    const paras = [...s.querySelectorAll('p')].map(p => clean(p.textContent))
      .filter(t => t.length > 25 && !cardText.has(t));
    return { head: headOf(s), intro: paras[0] || '', paras, cards };
  };

  const built = {
    slug,
    seo: {
      title: clean(doc.querySelector('title')?.textContent),
      description: doc.querySelector('meta[name=description]')?.content || '',
      ogImage: bareMedia(doc.querySelector('meta[property="og:image"]')?.content || ''),
      canonical: doc.querySelector('link[rel=canonical]')?.href || `https://www.koott.in/${slug}`,
    },
    hero: {
      eyebrow: clean(heroSec.querySelector('h5')?.textContent),
      title: clean(heroSec.querySelector('h1')?.textContent),
      subtitle: heroPs.find(t => t.length > 40 && !/^✔/.test(t)) || '',
      verified,
      image: bareMedia(heroImg),
    },
    stats,
    therapistsHeading: headOf(secs[1] || {}) || '',
    // Headings vary page to page ("Why Koott for X?" vs "Why Choose Koott for X?"),
    // but the strip ORDER is identical across all 45 pages. Match on the heading
    // first and fall back to the section's position when the wording is novel.
    howItWorks: sec(/how online (counselling|couple therapy) works/i, {}, 2, 'howItWorks'),
    why: sec(/^why (koott|choose)/i, {}, 3, 'why'),
    plans: sec(/affordable online .*plans/i, {}, 4, 'plans'),
    about: sec(/^what (is|are|does)/i, {}, 6, 'about'),
    symptoms: sec(/common signs|signs and symptoms/i, {}, 8, 'symptoms'),
    seekHelp: sec(/when should you (seek|take)/i, {}, 10, 'seekHelp'),
    types: sec(/^types of |^[a-z ]+ (struggles|issues|concerns) we (treat|help)|we (treat|offer|help with) *$/i, { bullets: true }, 12, 'types'),
    supportKit: sec(/support kit/i, {}, null, 'supportKit'),
    therapyHelps: sec(/how (does |do )?(online |couple )*therapy helps?/i, {}, 13, 'therapyHelps'),
    related: sec(/support for related concerns/i, {}, null, 'related'),
    finalCta: sec(/confused, how to start/i, {}, null, 'finalCta'),
    faqs: [...(findSec(secs, /^faq/i) || secs[secs.length - 3] || heroSec).querySelectorAll('button')]
      .map(b => clean(b.textContent)).filter(q => q.endsWith('?')).map(q => ({ q, a: '' })),
  };

  // ---- pieces that sit between the titled strips -------------------------

  // Pillars (Mind / Emotions / Energy / Life) are the untitled card row that
  // follows the "What is X?" section.
  const pillarSec = secIndex.about != null ? secs[secIndex.about + 1] : null;
  built.pillars = pillarSec && !headOf(pillarSec) ? cardsIn(pillarSec) : [];

  // "Starting from ₹749" lives on a button inside each plan card.
  built.planPrices = secIndex.plans != null
    ? [...secs[secIndex.plans].querySelectorAll('button,a')]
        .map(b => clean(b.textContent))
        .filter(t => /₹|starting from/i.test(t))
    : [];

  // The narrow green CTA bands between sections: short, unheaded, one button.
  built.bands = secs
    .map((s, i) => ({ s, i }))
    .filter(({ s, i }) => {
      if (used.has(i) || headOf(s)) return false;
      if (pillarSec && s === pillarSec) return false;   // that row is `pillars`
      const t = clean(s.textContent);
      return t.length > 30 && t.length < 420;
    })
    .map(({ s, i }) => {
      const btn = [...s.querySelectorAll('button,a')].map(b => clean(b.textContent)).filter(Boolean);
      const text = [...s.querySelectorAll('p,h3,h4,h5,span,div')].map(p => clean(p.textContent))
        .filter(t => t.length > 20 && !btn.includes(t))
        .sort((a, b) => a.length - b.length)[0]
        || clean(s.textContent);
      return { index: i, text, cta: btn[0] || '' };
    })
    .filter(b => b.text);

  return built;
}

module.exports = { extractPage, bareMedia };

if (require.main === module) {
  (async () => {
    const d = await extractPage(process.argv[2] || 'depression-treatment');
    console.log(JSON.stringify(d, null, 1).slice(0, 4500));
  })();
}
