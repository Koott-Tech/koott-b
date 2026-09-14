const fs = require('fs');
const { parse, get, clean } = require('./lib');
// live slug -> our route
const MAP = {
  'privacy-policy': 'privacy-policy',
  'terms-and-conditions': 'terms-and-conditions',
  'refundpolicy': 'refund-policy',
  'agreement': 'therapy-agreement',
};
(async () => {
  const out = {};
  for (const slug of Object.keys(MAP)) {
    const doc = parse(await get('https://www.koott.in/' + slug));
    const secs = [...doc.querySelectorAll('section')];
    let best = null, bl = 0;
    secs.forEach(s => { const t = clean(s.textContent); if (t.length > bl) { bl = t.length; best = s; } });
    const blocks = [];
    best.querySelectorAll('h1,h2,h3,h4,h5,p,li').forEach(el => {
      // Wix renders <li><p>text</p></li>; keep the <li> and drop the inner <p>.
      if (el.tagName === 'P' && el.closest('li')) return;
      const t = clean(el.textContent);
      if (!t) return;
      const tag = el.tagName;
      const b = /^H/.test(tag) ? { type: 'h', level: Number(tag[1]), text: t } : { type: tag === 'LI' ? 'li' : 'p', text: t };
      if (!blocks.some(x => x.text === t)) blocks.push(b);
    });
    out[slug] = { ourRoute: MAP[slug], chars: bl, blocks, seoTitle: clean(doc.querySelector('title')?.textContent), seoDescription: doc.querySelector('meta[name=description]')?.content || '' };
    console.log(slug.padEnd(22), 'chars', String(bl).padStart(6), 'blocks', blocks.length);
  }
  fs.writeFileSync('policies.json', JSON.stringify(out, null, 1));
})();
