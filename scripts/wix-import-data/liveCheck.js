/**
 * Request every live koott.in URL against the local app and report what happens.
 * Redirects are followed, so a 200 means the URL resolves to a real page whether
 * it is served directly or via a redirect rule.
 */
const fs = require('fs');
const sm = require('./sitemaps.json');

const BASE = process.env.BASE || 'http://localhost:3000';
const strip = (u) => u.replace(/^https?:\/\/(www\.)?koott\.in/, '') || '/';

const GROUPS = {
  pages: sm['pages-sitemap.xml'],
  'blog-categories': sm['blog-categories-sitemap.xml'],
  jobs: sm['dynamic-jobs_p_95db3e64_3fa4_4a71_9c25_f877bc63a43f_0_5000-sitemap.xml'],
  events: sm['event-pages-sitemap.xml'],
  'therapist-profiles': sm['booking-services-sitemap.xml'],
  // Blog posts were verified separately; sample them to keep the run short.
  'blog-posts': sm['blog-posts-sitemap.xml'].filter((_, i) => i % 10 === 0),
};

async function check(path) {
  try {
    const res = await fetch(BASE + path, { redirect: 'follow' });
    return { status: res.status, final: new URL(res.url).pathname };
  } catch (e) {
    return { status: 'ERR', final: e.message.slice(0, 40) };
  }
}

(async () => {
  const failures = [];
  const summary = {};

  for (const [group, urls] of Object.entries(GROUPS)) {
    if (!urls) continue;
    let ok = 0;
    for (const u of urls.filter(Boolean)) {
      const path = strip(u);
      const r = await check(path);
      if (r.status === 200) { ok++; process.stdout.write('.'); }
      else { failures.push({ group, path, ...r }); process.stdout.write('x'); }
    }
    summary[group] = { total: urls.filter(Boolean).length, ok };
    console.log(`  ${group} ${ok}/${urls.filter(Boolean).length}`);
  }

  console.log('\n================ SUMMARY ================');
  let t = 0, o = 0;
  for (const [g, s] of Object.entries(summary)) {
    t += s.total; o += s.ok;
    const pct = Math.round((s.ok / s.total) * 100);
    console.log(`${g.padEnd(22)} ${String(s.ok).padStart(4)}/${String(s.total).padEnd(4)}  ${pct}%`);
  }
  console.log(`${'TOTAL'.padEnd(22)} ${String(o).padStart(4)}/${String(t).padEnd(4)}  ${Math.round((o / t) * 100)}%`);

  if (failures.length) {
    console.log(`\n================ FAILURES (${failures.length}) ================`);
    failures.forEach((f) => console.log(`  ${String(f.status).padEnd(5)} ${f.path}`));
  }
  fs.writeFileSync('liveCheck-failures.json', JSON.stringify(failures, null, 1));
})();
