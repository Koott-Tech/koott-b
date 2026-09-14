const fs = require('fs');
const { extractGeneric } = require('./genericExtract');

const MISSING = ['plans-pricing','community','workshops','event-list','selfhelp','depression-test',
  'business','partnership-clinic','psychology-internships','feedback','sex-education',
  'student-counselling-discount','teens-feelings','couple-feelings','indvidual-feelings','womens-mental-health'];

const LOCATION = ['brampton','malayalam-online-counselling-in-dubai','malayali-psychologist-in-canada',
  'malayali-psychologist-abudhabi','malayali-psychologist-sharjah','best-online-psychologist-in-kozhikode',
  'malayali-psychologist-in-uk','online-counseling-in-kerala','online-malayali-psychologist-bangalore',
  'best-psychologist-in-kochi','malayali-psychologist-in-chennai','malayali-psychologist-in-us',
  'best-psychologist-in-thiruvananthapuram','malayali-psychologist-in-toronto'];

const SYNC = ['about-us','get-in-touch','jobs','faq','blog'];

(async () => {
  const all = {};
  for (const [group, list] of Object.entries({ MISSING, LOCATION, SYNC })) {
    console.log(`\n### ${group}`);
    for (const slug of list) {
      let d;
      try { d = await extractGeneric(slug); } catch (e) { d = { slug, error: e.message }; }
      d.group = group;
      all[slug] = d;
      const chars = d.sections ? d.sections.reduce((a, s) => a + s.chars, 0) : 0;
      const cards = d.sections ? d.sections.reduce((a, s) => a + s.cards.length, 0) : 0;
      const thin = !d.error && chars < 1200;
      console.log(`  ${slug.padEnd(40)} ${d.error ? 'ERR' : `${String(d.sections.length).padStart(2)} secs  ${String(chars).padStart(6)} chars  ${String(cards).padStart(3)} cards`}${thin ? '   <-- THIN (client-rendered)' : ''}`);
      await new Promise(r => setTimeout(r, 200));
    }
  }
  fs.writeFileSync('staticPages.json', JSON.stringify(all, null, 1));
  console.log('\nwrote staticPages.json', (fs.statSync('staticPages.json').size / 1024).toFixed(0) + 'KB');
})();
