const { JSDOM, VirtualConsole } = require('D:/koott-new/frontend/node_modules/jsdom');
const vc = new VirtualConsole(); // swallow CSS parse errors
function parse(html){ return new JSDOM(html, { virtualConsole: vc }).window.document; }
async function get(url){
  for (let a=0;a<3;a++){
    try{
      const r = await fetch(url,{headers:{'User-Agent':'Mozilla/5.0 (Windows NT 10.0; Win64; x64)'}});
      if(r.ok) return await r.text();
      if(r.status===404) return null;
    }catch(e){}
    await new Promise(r=>setTimeout(r,800*(a+1)));
  }
  return null;
}
const clean = s => (s||'').replace(/\u00a0/g,' ').replace(/\s+/g,' ').trim();
module.exports = { parse, get, clean };
