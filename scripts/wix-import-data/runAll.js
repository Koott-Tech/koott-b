const fs = require('fs');
const { extractPage } = require('./extract');
const menu = require('./menu.json');
(async () => {
  const out = [];
  for (let i = 0; i < menu.length; i++) {
    const m = menu[i];
    let d;
    try { d = await extractPage(m.slug); } catch (e) { d = { slug: m.slug, error: e.message }; }
    d.category = m.c; d.menuGroup = m.g; d.menuLabel = m.label; d.menuOrder = i;
    out.push(d);
    const secs = ['about','symptoms','seekHelp','types','therapyHelps','why','plans','howItWorks'].filter(k => d[k]);
    console.log(`${String(i+1).padStart(2)}/45 ${m.slug.padEnd(38)} ${d.error ? 'ERR ' + d.error : `secs=${secs.length}/8 faq=${d.faqs.length} h1=${d.hero.title?'y':'N'}`}`);
    await new Promise(r => setTimeout(r, 250));
  }
  fs.writeFileSync('conditions.json', JSON.stringify(out, null, 1));
  console.log('\nwrote conditions.json', (fs.statSync('conditions.json').size/1024).toFixed(0)+'KB');
})();
