// THE-63: compare semantic search for Spanish queries against their English twins.
// Read-only: it only calls /api/ideas/search. Run it before and after changing the
// embedding model, then review both reports side by side:
//   node --env-file=.env.migration tools/search-eval.mjs
//   node tools/search-eval.mjs --compare .local/search-eval/A.json .local/search-eval/B.json
// overlap@k = shared results between the Spanish query and its English twin. English
// works well with every model, so higher overlap means Spanish finds the same videos.
// It is a proxy: the reports list titles so a person can judge relevance too.
import {readFile,writeFile,mkdir} from 'node:fs/promises';

const args=process.argv.slice(2);
const K=10;
const mean=values=>values.length?values.reduce((a,b)=>a+b,0)/values.length:0;

if(args[0]==='--compare') {
  const [a,b]=await Promise.all(args.slice(1,3).map(async f=>JSON.parse(await readFile(f,'utf8'))));
  console.log(`overlap@${K}: ${a.model} ${a.meanOverlap.toFixed(2)} → ${b.model} ${b.meanOverlap.toFixed(2)}\n`);
  for(const [i,row] of a.queries.entries()) {
    const other=b.queries[i];
    console.log(`«${row.es}»  ${row.overlap}/${K} → ${other.overlap}/${K}`);
    for(let r=0;r<5;r++) console.log(`  ${String(r+1).padStart(2)}. ${(row.esResults[r]?.title||'—').slice(0,55).padEnd(55)} | ${(other.esResults[r]?.title||'—').slice(0,55)}`);
  }
  process.exit(0);
}

const api=(process.env.TB_API_URL||'').replace(/\/$/,'');
const token=process.env.TB_AUTH_TOKEN||'';
if(!api||!token){console.error('Set TB_API_URL and TB_AUTH_TOKEN privately (e.g. node --env-file=.env.migration).');process.exit(1);}
const health=await (await fetch(api+'/api/health')).json();
const model=health.features?.embeddingModel||'gte-small';
async function search(title) {
  const response=await fetch(api+'/api/ideas/search',{method:'POST',headers:{'Content-Type':'application/json','X-Auth-Token':token},body:JSON.stringify({title,topK:K,includeOwnChannels:false,includeDiscovery:false})});
  const body=await response.json();
  if(!body.ok) throw new Error(body.msg||`Search failed (${response.status})`);
  return body.results.map(v=>({id:v.id,title:v.title,channel:v.channel,score:Number(v.score?.toFixed?.(4)??v.score)}));
}
const queries=[];
for(const pair of JSON.parse(await readFile(args[0]||new URL('./search-eval-queries.json',import.meta.url),'utf8'))) {
  const [esResults,enResults]=[await search(pair.es),await search(pair.en)];
  const en=new Set(enResults.map(v=>v.id));
  const overlap=esResults.filter(v=>en.has(v.id)).length;
  queries.push({...pair,overlap,esResults,enResults});
  console.log(`${String(overlap).padStart(2)}/${K}  ${pair.es}`);
}
const report={model,createdAt:new Date().toISOString(),k:K,meanOverlap:mean(queries.map(q=>q.overlap)),queries};
await mkdir('.local/search-eval',{recursive:true});
const file=`.local/search-eval/${model.replace(/[^\w.-]/g,'_')}-${report.createdAt.slice(0,19).replace(/:/g,'')}.json`;
await writeFile(file,JSON.stringify(report,null,2));
console.log(`\n${model}: mean overlap@${K} ${report.meanOverlap.toFixed(2)} · ${file}`);
