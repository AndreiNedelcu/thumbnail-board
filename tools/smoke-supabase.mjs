// Cloud smoke check creates disposable references, then soft-deletes them.
import assert from 'node:assert/strict';
import {randomBytes} from 'node:crypto';
const base=process.env.TB_API_URL?.replace(/\/$/,'');
if(!base||!process.env.TB_AUTH_TOKEN)throw new Error('Set TB_API_URL and TB_AUTH_TOKEN');
async function request(path,body,auth=true){
  const r=await fetch(base+path,{method:body?'POST':'GET',headers:{'Content-Type':'application/json',...(auth?{'X-Auth-Token':process.env.TB_AUTH_TOKEN}:{})},body:body?JSON.stringify(body):undefined});
  const d=await r.json();if(!r.ok)throw new Error(`${path}: ${r.status} ${d.msg||''}`);return d;
}
const before=await request('/api/data');
assert.equal((await request('/api/health')).backend,'supabase');
const unauthorized=await fetch(base+'/api/favorites');assert.equal(unauthorized.status,401);
const ids=Array.from({length:3},()=>('tbQ'+randomBytes(6).toString('base64url')).slice(0,11));
try{
  const result=await request('/api/add-batch',{items:ids.map(id=>({id,title:'[Migration smoke test]',tags:[],channel:'Disposable test'}))});assert.equal(result.added,3);
  await request('/api/favorites',{id:ids[0],saved:true});assert.ok((await request('/api/favorites')).ids.includes(ids[0]));
  let start=performance.now();const single=await request('/api/delete',{id:ids[0]});assert.equal(single.deleted,1);console.log('Single deletion:',Math.round(performance.now()-start),'ms');
  start=performance.now();const bulk=await request('/api/bulk-delete',{ids:ids.slice(1)});assert.equal(bulk.deleted,2);console.log('Bulk deletion:',Math.round(performance.now()-start),'ms');
  assert.equal((await request('/api/data')).length,before.length);assert.ok(!(await request('/api/favorites')).ids.includes(ids[0]));
  const image=before.find(v=>v.thumbnailUrl);assert.ok(image);const asset=await fetch(image.thumbnailUrl,{method:'HEAD'});assert.equal(asset.status,200);
  console.log(JSON.stringify({ok:true,board:before.length,archived:before.filter(v=>v.thumbnailUrl).length,missingChannels:before.filter(v=>!v.channel).length,storage:asset.status}));
}finally{await request('/api/bulk-delete',{ids});}
