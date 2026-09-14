/**
 * Compare the live koott.in site against what this repo actually serves.
 *
 * Sources of truth:
 *   live   — every <loc> in the Wix sitemap index (pages, blog posts, categories,
 *            booking services, jobs, event pages)
 *   ours   — every app/**\/page.js route, plus whatever the top-level
 *            [conditionSlug] route can resolve out of the CMS
 */
const fs = require('fs');
const path = require('path');

const sm = require('./sitemaps.json');
const conditions = require('./conditions.json');
const blogs = require('./blogs.json');

const APP = 'D:/koott-new/frontend/src/app';

/** Walk app/ and collect every routable path. */
function ourRoutes(dir = APP, prefix = '') {
  const out = [];
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    if (!e.isDirectory()) continue;
    if (e.name.startsWith('_') || e.name === 'api') continue;
    const seg = e.name.startsWith('(') ? '' : e.name;      // route groups add no segment
    const nextPrefix = seg ? `${prefix}/${seg}` : prefix;
    const full = path.join(dir, e.name);
    if (fs.existsSync(path.join(full, 'page.js')) || fs.existsSync(path.join(full, 'page.jsx'))) {
      out.push(nextPrefix.replace(/^\//, ''));
    }
    out.push(...ourRoutes(full, nextPrefix));
  }
  return out;
}

const routes = new Set(ourRoutes());
const cmsSlugs = new Set(conditions.map((c) => c.slug));
const blogSlugs = new Set(blogs.map((b) => b.slug));

const strip = (u) => u.replace(/^https?:\/\/(www\.)?koott\.in/, '').replace(/^\//, '').replace(/\/$/, '');

/** Does this repo serve that live path? */
function servedBy(p) {
  if (p === '') return routes.has('') ? 'route /' : 'route /';
  if (routes.has(p)) return 'route';
  if (cmsSlugs.has(p)) return 'CMS + [conditionSlug]';
  // /post/<slug> on Wix is /blog/<slug> here
  if (p.startsWith('post/')) {
    return blogSlugs.has(p.slice(5)) ? 'CMS + /blog/[slug]' : null;
  }
  // A dynamic segment matches exactly ONE remaining path segment: blog/[slug]
  // serves /blog/foo but NOT /blog/categories/foo, which would bind slug="categories".
  const parts = p.split('/');
  if (parts.length >= 2) {
    const parent = parts.slice(0, -1).join('/');
    if (routes.has(`${parent}/[slug]`) || routes.has(`${parent}/[id]`)) return `dynamic ${parent}/[…]`;
  }
  return null;
}

const report = {};
for (const [name, urls] of Object.entries(sm)) {
  const rows = urls.map(strip).map((p) => ({ path: p, by: servedBy(p) }));
  report[name] = rows;
}

// ---- print -----------------------------------------------------------------
let totalLive = 0, totalMissing = 0;
const missingByGroup = {};

for (const [name, rows] of Object.entries(report)) {
  const missing = rows.filter((r) => !r.by);
  totalLive += rows.length;
  totalMissing += missing.length;
  missingByGroup[name] = missing.map((r) => r.path);
  console.log(`${name.replace('-sitemap.xml', '').padEnd(42)} live ${String(rows.length).padStart(4)}   served ${String(rows.length - missing.length).padStart(4)}   MISSING ${missing.length}`);
}

console.log(`\nTOTAL  live ${totalLive}   missing ${totalMissing}\n`);

for (const [name, list] of Object.entries(missingByGroup)) {
  if (!list.length) continue;
  console.log(`\n### MISSING — ${name.replace('-sitemap.xml', '')} (${list.length})`);
  list.forEach((p, i) => console.log(`${String(i + 1).padStart(3)}. /${p}`));
}

fs.writeFileSync('audit-missing.json', JSON.stringify(missingByGroup, null, 1));
