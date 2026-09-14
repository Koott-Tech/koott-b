const { parse, get, clean } = require('./lib');
const { bareMedia } = require('./extract');

const NL2 = '\n\n';

/**
 * Walk the <article> in document order and emit the markdown-ish shape that
 * BlogArticle renders: "## " heading, "### " sub-heading, "- " list item,
 * "> " blockquote, blank line between paragraphs.
 *
 * Wix mirrors some nodes (a <li> is often repeated as a <p>), so every emitted
 * block is de-duplicated by its text.
 */
function toMarkdown(article) {
  const out = [];
  const seen = new Set();
  const walk = (el) => {
    for (const n of el.children) {
      const tag = n.tagName;
      if (/^H[1-6]$/.test(tag)) {
        const t = clean(n.textContent);
        if (t && !seen.has('h' + t)) { seen.add('h' + t); out.push((tag === 'H2' ? '## ' : '### ') + t); }
        continue;
      }
      if (tag === 'UL' || tag === 'OL') {
        [...n.querySelectorAll('li')].forEach((li) => {
          const t = clean(li.textContent);
          if (t && !seen.has('l' + t)) { seen.add('l' + t); out.push('- ' + t); }
        });
        continue;
      }
      if (tag === 'P') {
        const t = clean(n.textContent);
        if (t && !seen.has('p' + t)) { seen.add('p' + t); out.push(t); }
        continue;
      }
      if (tag === 'BLOCKQUOTE') {
        const t = clean(n.textContent);
        if (t && !seen.has('q' + t)) { seen.add('q' + t); out.push('> ' + t); }
        continue;
      }
      if (n.children.length) walk(n);
    }
  };
  walk(article);
  return out;
}

/**
 * The rendered <article> carries the post header (repeated title, byline, date,
 * read time) and a trailing "Tags:" list. Split those off so `content` is the
 * body alone, and hand back the metadata they held.
 */
function splitChrome(blocks, title) {
  let readMinutes = 0;
  const tags = [];
  const norm = (t) => t.replace(/[^a-z0-9]/gi, '').toLowerCase();

  // Head: the repeated title heading plus the byline / date / read-time items.
  let start = 0;
  for (let i = 0; i < Math.min(8, blocks.length); i++) {
    const b = blocks[i];
    const bare = b.replace(/^(#{2,3}|-|>)\s*/, '');
    const isTitle = /^#{2,3} /.test(b) && norm(bare) === norm(title);
    const isRead = /^-\s*\d+\s*min read$/i.test(b);
    const isDate = /^-\s*[A-Z][a-z]{2}\s+\d{1,2}(,\s*\d{4})?$/.test(b);
    const isByline = /^-\s/.test(b) && bare.split(/\s+/).length <= 4
      && /^[A-Z]/.test(bare) && !/[.?!]$/.test(bare);
    if (isRead) { readMinutes = Number(b.match(/(\d+)/)[1]); start = i + 1; continue; }
    if (isTitle || isDate || isByline) { start = i + 1; continue; }
    break;
  }

  // Tail: everything from "Tags:" onward is the tag list, not body copy.
  let end = blocks.length;
  for (let i = start; i < blocks.length; i++) {
    const label = blocks[i].replace(/^-\s*/, '').trim();
    if (/^tags:?$/i.test(label)) {
      end = i;
      blocks.slice(i + 1).forEach((t) => {
        const v = t.replace(/^-\s*/, '').trim();
        if (v) tags.push(v);
      });
      break;
    }
  }

  return { body: blocks.slice(start, end), readMinutes, tags };
}

async function extractPost(url) {
  const html = await get(url);
  if (!html) return { url, error: 'fetch failed' };
  const doc = parse(html);
  const slug = url.split('/post/')[1] || url.split('/').pop();

  let ld = {};
  for (const s of doc.querySelectorAll('script[type="application/ld+json"]')) {
    try {
      const j = JSON.parse(s.textContent);
      if (j['@type'] === 'BlogPosting') ld = j;
    } catch (_) { /* Wix ships a few non-JSON blocks here */ }
  }

  const hook = (h) => {
    const e = doc.querySelector(`[data-hook="${h}"]`);
    return e ? clean(e.textContent) : '';
  };
  const title = hook('post-title') || clean(doc.querySelector('h1')?.textContent) || ld.headline || '';

  const article = doc.querySelector('article') || doc.body;
  const { body, readMinutes, tags } = splitChrome(toMarkdown(article), title);
  const content = body.join(NL2);

  const cats = tags.length
    ? tags
    : [...doc.querySelectorAll('[data-hook="post-page-category-label"], [data-hook="category-label"]')]
        .map((e) => clean(e.textContent)).filter(Boolean);

  return {
    slug,
    url,
    title,
    seo_title: clean(doc.querySelector('title')?.textContent),
    excerpt: doc.querySelector('meta[name=description]')?.content
      || hook('post-description').slice(0, 300) || '',
    featured_image_url: bareMedia(doc.querySelector('meta[property="og:image"]')?.content || ''),
    author_name: (ld.author && (ld.author.name || ld.author)) || hook('user-name') || 'Koott',
    created_at: ld.datePublished || '',
    categories: [...new Set(cats)],
    read_time_minutes: readMinutes || Math.max(1, Math.round(content.split(/\s+/).length / 200)),
    content,
  };
}

module.exports = { extractPost };

if (require.main === module) {
  (async () => {
    const sm = require('./sitemaps.json');
    const d = await extractPost(process.argv[2] || sm['blog-posts-sitemap.xml'][0]);
    const { content, ...rest } = d;
    console.log(JSON.stringify(rest, null, 1));
    console.log('--- content head ---');
    console.log(content.slice(0, 500));
    console.log('--- tail ---');
    console.log(content.slice(-300));
    console.log('--- chars:', content.length);
  })();
}
