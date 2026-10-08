// Extract GraphQL operation text (fragments resolved) from downloaded bundles.
//   node scripts/extract-ops.mjs <bundle-dir> <out.graphql> <OpName>...

import fs from 'node:fs';
const [dir, out, ...names] = process.argv.slice(2);
const src = fs.readdirSync(dir).filter(f=>f.endsWith('.js')).map(f=>fs.readFileSync(dir+'/'+f,'utf8')).join('\n');
const grab=(kw,n)=>{const i=src.search(new RegExp(kw+' '+n+'\\b'));if(i<0)return null;let s=src.indexOf('{',i),k=0,e=s;
 // for operations with var list, first { is selection after (...)
 for(;e<src.length;e++){if(src[e]=='{')k++;else if(src[e]=='}'){k--;if(!k)break}}
 return src.slice(i,e+1).replace(/\\n/g,'\n')};
let o='';const seen=new Set();
const addFrags=(t)=>{for(const m of t.matchAll(/\.\.\.([A-Z][A-Za-z0-9_]+)/g)){const f=m[1];if(seen.has(f))continue;seen.add(f);const ft=grab('fragment',f);if(ft){o+='\n'+ft+'\n';addFrags(ft)}}};
for(const n of names){const t=grab('(?:mutation|query)',n);o+='\n### '+n+'\n'+(t||'NOT FOUND')+'\n';if(t)addFrags(t)}
fs.writeFileSync(out,o);console.log(o.length);
