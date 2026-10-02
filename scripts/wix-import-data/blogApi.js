/**
 * Pull the blog straight from the live Wix site's own API, rather than scraping
 * the rendered page.
 *
 * Why: the post body on koott.in is lazy-loaded, so the server HTML carries the
 * text but none of the in-article images, and the byline ("5 days ago",
 * "5 min read") ends up inside the body. The API returns the post as structured
 * content — paragraphs, headings, lists, quotes and images, in order — which is
 * what the site's own editor stores.
 *
 * It needs a signed `instance` token, which the live page carries. Get one by
 * opening https://www.koott.in/blog and reading it out of the page:
 *
 *   document.documentElement.innerHTML.match(/instance=([A-Za-z0-9_\-.]{60,})/)[1]
 *
 * Tokens last a few hours. Usage (from backend/scripts/wix-import-data):
 *
 *   node blogApi.js --token <token> --probe          one post, printed
 *   node blogApi.js --token <token>                  all posts → blogs.json
 */

const fs = require('fs');

const SITE = 'https://www.koott.in';
const API = `${SITE}/_api/communities-blog-node-api/_api`;

const arg = (name) => {
  const i = process.argv.indexOf(`--${name}`);
  return i === -1 ? null : (process.argv[i + 1] || true);
};
const TOKEN = arg('token') || process.env.WIX_INSTANCE;
const PROBE = process.argv.includes('--probe');

const api = async (path) => {
  const r = await fetch(`${API}${path}`, {
    headers: { instance: TOKEN, 'User-Agent': 'Mozilla/5.0', Accept: 'application/json' },
  });
  if (!r.ok) throw new Error(`${r.status} ${path} — ${(await r.text()).slice(0, 120)}`);
  return r.json();
};

/** Wix media ids become plain URLs; the transform in the middle is theirs. */
const mediaUrl = (m) => {
  if (!m) return '';
  const file = typeof m === 'string' ? m : (m.file_name || m.fileName || m.src?.id || m.url || '');
  if (!file) return '';
  if (/^https?:/i.test(file)) return file.split('/v1/')[0];
  return `https://static.wixstatic.com/media/${file}`;
};

/* ------------------------------------------------------------------ content */

const textOf = (node) => (node.nodes || [])
  .map((n) => (n.type === 'TEXT' ? (n.textData?.text || '') : textOf(n)))
  .join('');

/**
 * Wix's rich content → the markdown shape BlogArticle renders:
 * "## ", "### ", "- ", "> ", "![](src)", blank line between paragraphs.
 */
function toMarkdown(rich, cover) {
  const out = [];
  const push = (s) => { const t = String(s || '').replace(/\s+/g, ' ').trim(); if (t) out.push(t); };

  const walk = (nodes) => {
    (nodes || []).forEach((n) => {
      switch (n.type) {
        case 'HEADING': {
          const level = n.headingData?.level || 2;
          push(`${level <= 2 ? '## ' : '### '}${textOf(n)}`);
          break;
        }
        case 'PARAGRAPH':
          push(textOf(n));
          break;
        case 'BULLETED_LIST':
        case 'ORDERED_LIST':
          (n.nodes || []).forEach((li) => push(`- ${textOf(li)}`));
          break;
        case 'BLOCKQUOTE':
          push(`> ${textOf(n)}`);
          break;
        case 'IMAGE': {
          const src = mediaUrl(n.imageData?.image?.src || n.imageData?.image);
          // the cover is rendered above the body, not inside it
          if (src && src !== cover) push(`![](${src})`);
          break;
        }
        case 'VIDEO':
        case 'EMBED':
        case 'DIVIDER':
          break;
        default:
          if (n.nodes) walk(n.nodes);
      }
    });
  };
  walk(rich?.nodes);
  return out.join('\n\n');
}

/* --------------------------------------------------------------------- posts */

async function listPosts() {
  const all = [];
  for (let offset = 0; ; offset += 50) {
    const page = await api(`/posts?offset=${offset}&size=50`);
    all.push(...page);
    if (page.length < 50) break;
  }
  return all;
}

async function fullPost(id) {
  // fieldsets bring the body back; without them the list is metadata only
  return api(`/posts/${id}?fieldsets=CONTENT&fieldsets=CONTENT_TEXT&fieldsets=URL`);
}

async function categoryNames() {
  const cats = await api('/categories?offset=0&size=100').catch(() => []);
  return Object.fromEntries((cats || []).map((c) => [c._id || c.id, c.menuLabel || c.label || c.title]));
}

(async () => {
  if (!TOKEN) {
    console.error('Need --token <instance>. See the header of this file for where to get one.');
    process.exit(1);
  }
  try {
    const [list, catNames] = await Promise.all([listPosts(), categoryNames()]);
    console.log(`posts on the live site: ${list.length}`);

    const out = [];
    for (let i = 0; i < list.length; i++) {
      const stub = list[i];
      const post = await fullPost(stub.id || stub._id).catch((e) => ({ error: e.message }));
      if (post.error) { console.log(`  ! ${stub.slug}: ${post.error}`); continue; }

      const cover = mediaUrl(post.coverImage?.src || post.heroImage);
      const content = toMarkdown(post.richContent || post.content, cover);
      out.push({
        slug: post.slug || stub.slug,
        url: `${SITE}/post/${post.slug || stub.slug}`,
        title: post.title || stub.title,
        seo_title: post.seoTitle || post.seoData?.tags?.find((t) => t.type === 'title')?.children || '',
        excerpt: post.excerpt || stub.excerpt || '',
        featured_image_url: cover,
        author_name: post.owner?.name || stub.owner?.name || 'Koott',
        created_at: post.firstPublishedDate || post.createdDate || stub.firstPublishedDate || '',
        updated_at: post.lastPublishedDate || '',
        categories: (post.categoryIds || stub.categoryIds || []).map((id) => catNames[id]).filter(Boolean),
        tags: post.hashtags || stub.hashtags || [],
        read_time_minutes: post.timeToRead || stub.timeToRead || 0,
        content,
      });

      if (PROBE) break;
      if (i % 20 === 0) console.log(`  ${i + 1}/${list.length} ${out[out.length - 1].slug.slice(0, 48)}`);
      await new Promise((r) => setTimeout(r, 120));
    }

    if (PROBE) {
      const p = out[0];
      const { content, ...rest } = p;
      console.log(JSON.stringify(rest, null, 1));
      console.log('--- content head ---\n' + content.slice(0, 500));
      console.log(`--- chars: ${content.length}  images: ${(content.match(/!\[\]\(/g) || []).length}`);
      return;
    }

    fs.writeFileSync('blogs.json', JSON.stringify(out, null, 1));
    const withImages = out.filter((p) => /!\[\]\(/.test(p.content)).length;
    const short = out.filter((p) => p.content.length < 400);
    console.log(`\nwrote blogs.json — ${out.length} posts, ${withImages} with in-body images`);
    if (short.length) console.log(`short/empty bodies (check): ${short.map((p) => p.slug).join(', ')}`);
  } catch (e) {
    console.error('❌', e.message);
    process.exit(1);
  }
})();
