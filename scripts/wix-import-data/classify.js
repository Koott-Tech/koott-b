/**
 * Sort the audit's "missing" list into things that genuinely have no page here
 * versus things that exist under a different URL (a slug rename, or a different
 * route shape) and therefore only need a redirect.
 */
const fs = require('fs');
const missing = require('./audit-missing.json');

// Live slug -> the route in this repo that already serves the same content.
const RENAMED = {
  'agreement': '/therapy-agreement',
  'refundpolicy': '/refund-policy',
  'koottaksharangal': '/blog',            // live blog landing carries this name
};

// Whole live sections we serve under a different route shape.
const RESHAPED = [
  { test: (p) => p.startsWith('service-page/'), ours: '/online-child-psychologist/[slug] (therapist profiles)' },
  { test: (p) => p.startsWith('event-details/'), ours: '/events/[slug]' },
];

// Location / city landing pages — one template, many slugs.
const LOCATION = /^(malayali-psychologist|malayalam-online-counselling|online-malayali-psychologist|best-online-psychologist|best-psychologist|online-counseling-in-kerala|brampton)/;

// Wix editor leftovers, not real pages.
const WIX_JUNK = /^copy-of-/;

const buckets = {
  renamed: [], reshaped: [], location: [], junk: [], real: [],
};

for (const [group, list] of Object.entries(missing)) {
  for (const p of list) {
    if (RENAMED[p]) { buckets.renamed.push(`/${p}  ->  ${RENAMED[p]}`); continue; }
    const rs = RESHAPED.find((r) => r.test(p));
    if (rs) { buckets.reshaped.push({ group, path: `/${p}`, ours: rs.ours }); continue; }
    if (WIX_JUNK.test(p)) { buckets.junk.push(`/${p}`); continue; }
    if (LOCATION.test(p)) { buckets.location.push(`/${p}`); continue; }
    buckets.real.push(`/${p}`);
  }
}

const head = (t) => console.log(`\n${'='.repeat(72)}\n${t}\n${'='.repeat(72)}`);

head(`A. SAME CONTENT, DIFFERENT URL — needs a redirect (${buckets.renamed.length})`);
buckets.renamed.forEach((x) => console.log('   ' + x));

head(`B. SERVED BY A DIFFERENT ROUTE SHAPE (${buckets.reshaped.length})`);
const byOurs = {};
buckets.reshaped.forEach((r) => { (byOurs[r.ours] = byOurs[r.ours] || []).push(r.path); });
Object.entries(byOurs).forEach(([ours, paths]) => {
  console.log(`   ${paths.length} live URLs  ->  ${ours}`);
  console.log(`      e.g. ${paths.slice(0, 3).join(', ')}`);
});

head(`C. LOCATION / CITY SEO PAGES — no route at all (${buckets.location.length})`);
buckets.location.forEach((x) => console.log('   ' + x));

head(`D. WIX EDITOR LEFTOVERS — safe to skip (${buckets.junk.length})`);
buckets.junk.forEach((x) => console.log('   ' + x));

head(`E. GENUINELY MISSING PAGES (${buckets.real.length})`);
buckets.real.forEach((x) => console.log('   ' + x));

fs.writeFileSync('audit-classified.json', JSON.stringify(buckets, null, 1));
console.log(`\nsummary: redirect ${buckets.renamed.length} · reshaped ${buckets.reshaped.length} · location ${buckets.location.length} · junk ${buckets.junk.length} · build ${buckets.real.length}`);
