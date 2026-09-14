const fs = require('fs');
const { parse, get, clean } = require('./lib');
const sm = require('./sitemaps.json');

const urls = sm['blog-categories-sitemap.xml'].filter(Boolean);
(async () => {
  const out = [];
  for (let i = 0; i < urls.length; i++) {
    const u = urls[i];
    const slug = decodeURIComponent(u.split('/blog/categories/')[1] || '');
    if (!slug) continue;
    const html = await get(u);
    if (!html) { out.push({ slug, error: 'fetch failed', posts: [] }); process.stdout.write('x'); continue; }
    const doc = parse(html);
    const label = clean(doc.querySelector('title')?.textContent || '').replace(/\s*\|\s*Koott.*$/i, '');
    const posts = [...new Set([...doc.querySelectorAll('a')]
      .map((a) => a.getAttribute('href') || '')
      .filter((h) => h.includes('/post/'))
      .map((h) => h.split('/post/')[1].split('?')[0].replace(/\/$/, '')))];
    const desc = doc.querySelector('meta[name=description]')?.content || '';
    out.push({ slug, label, description: desc, posts });
    process.stdout.write(posts.length ? '.' : 'o');
    await new Promise((r) => setTimeout(r, 180));
  }
  fs.writeFileSync('blogCategories.json', JSON.stringify(out, null, 1));
  const withPosts = out.filter((c) => c.posts.length);
  console.log(`\ncategories: ${out.length}  with posts: ${withPosts.length}  total refs: ${out.reduce((a, c) => a + c.posts.length, 0)}`);
  console.log('sample:', withPosts.slice(0, 4).map((c) => `${c.label}(${c.posts.length})`).join(', '));
})();
