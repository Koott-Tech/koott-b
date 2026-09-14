const fs = require('fs');
const { extractPost } = require('./blogExtract');
const urls = require('./sitemaps.json')['blog-posts-sitemap.xml'];
(async () => {
  const out = [];
  for (let i = 0; i < urls.length; i++) {
    let d;
    try { d = await extractPost(urls[i]); } catch (e) { d = { url: urls[i], error: e.message }; }
    out.push(d);
    const bad = d.error || !d.content || d.content.length < 400 || !d.title;
    if (bad || i % 20 === 0) {
      console.log(`${String(i + 1).padStart(3)}/${urls.length} ${(d.slug || d.url).slice(0, 52).padEnd(52)} ${d.error ? 'ERR ' + d.error : `${d.content.length}c ${d.read_time_minutes}m tags=${d.categories.length}`}${bad ? '  <-- CHECK' : ''}`);
    }
    await new Promise(r => setTimeout(r, 200));
  }
  fs.writeFileSync('blogs.json', JSON.stringify(out, null, 1));
  const ok = out.filter(d => !d.error && d.content && d.content.length > 400 && d.title);
  console.log(`\nDONE  good=${ok.length}/${out.length}  size=${(fs.statSync('blogs.json').size / 1024).toFixed(0)}KB`);
  const bad = out.filter(d => !ok.includes(d));
  if (bad.length) console.log('problem posts:', bad.map(d => d.slug || d.url).join(', '));
})();
