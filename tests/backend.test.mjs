import {test,before,after} from 'node:test';
import assert from 'node:assert/strict';
import {openLocalStore} from '../tools/local-store.mjs';
import {createHandler} from '../supabase/functions/_shared/api.mjs';
import {archiveThumbnail,processAssetJobs} from '../supabase/functions/_shared/assets.mjs';
let store,handler;
before(async()=>{store=await openLocalStore();handler=createHandler({store,authToken:'test-only-token',embed:async()=>Array(384).fill(0.1)});});
after(async()=>store?.db.close());
const id=n=>'video'+String(n).padStart(6,'0');
async function post(path,body,authorized=true){return handler(new Request('https://example.test/functions/v1/board-api'+path,{method:'POST',headers:{'Content-Type':'application/json',...(authorized?{'X-Auth-Token':'test-only-token'}:{})},body:JSON.stringify(body)}));}
test('Postgres migration denies direct anonymous table and RPC access',async()=>{
  assert.equal((await store.db.query("select has_table_privilege('anon','tb_videos','SELECT') as allowed")).rows[0].allowed,false);
  assert.equal((await store.db.query("select has_function_privilege('anon','tb_delete(text[])','EXECUTE') as allowed")).rows[0].allowed,false);
});
test('API protects writes and rejects malformed requests without changing records',async()=>{
  assert.equal((await post('/api/add',{id:id(1)},false)).status,401);
  assert.equal((await post('/api/bulk-delete',{ids:['bad']})).status,400);
  assert.equal((await post('/api/favorites',{id:id(1),saved:'true'})).status,400);
  assert.equal(await store.get(id(1)),null);
});
test('one bulk transaction deletes exactly requested IDs, retains assets and blocks resurrection',async()=>{
  await store.save([1,2,3].map(n=>({id:id(n),title:'Fixture',thumbnailUrl:'https://archive.test/'+n+'.jpg',channel:'Channel'})));
  await store.favorite(id(1),true);
  const response=await post('/api/bulk-delete',{ids:[id(1),id(2),id(1),id(99)]});
  const data=await response.json();assert.equal(response.status,200);assert.equal(data.deleted,2);
  assert.deepEqual(new Set(data.deletedIds),new Set([id(1),id(2)]));
  assert.equal((await store.list('board')).length,1);
  assert.ok((await store.get(id(1))).data.thumbnailUrl);assert.deepEqual(await store.favorites(),[]);
  assert.equal((await store.save([{id:id(1),title:'Background tagger'}])).changed,0);
  assert.equal((await store.save([{id:id(1),title:'Metadata retry'}],'update')).changed,0);
  assert.equal((await store.delete([id(1)])).deleted,1);
});
test('pending tagger promotion preserves archived image and existing metadata',async()=>{
  await store.save([{id:id(4),title:'Pending',channel:'Creator',thumbnailUrl:'https://archive.test/4.jpg'}],'add','pending');
  assert.equal((await store.save([{id:id(4),tags:['style-minimal']}])).changed,1);
  const row=await store.get(id(4));assert.equal(row.status,'board');assert.equal(row.data.channel,'Creator');assert.ok(row.data.thumbnailUrl);
  assert.equal((await post('/api/update',{id:'EAGLEITEM',vid:id(4),tags:['style-colorful']})).status,200);
  const edited=await store.get(id(4));assert.equal(edited.data.channel,'Creator');assert.ok(edited.data.thumbnailUrl);
  await store.favorite(id(4),true);await store.favorite(id(4),true);assert.deepEqual(await store.favorites(),[id(4)]);
});
test('collector persists history, respects inbox capacity and never re-adds deleted records',async()=>{
  const items=[1,5,6,7].map(n=>({id:id(n),channelId:'UC'+'x'.repeat(22)}));
  const result=await store.rpc('tb_collect',{candidates:items,history:items,max_size:2});
  assert.equal(result.added,2);assert.equal((await store.list('inbox')).length,2);
  await store.decide([id(5)],'rejected');
  const again=await store.rpc('tb_collect',{candidates:items,history:items,max_size:2});
  assert.equal(again.added,1);assert.equal((await store.get(id(5))).status,'rejected');assert.ok((await store.get(id(1))).deleted_at);
});
test('identical downloaded images are rejected in inbox, retained in board',async()=>{
  const patch={imageHash:'samehash',thumbnailUrl:'https://archive.test/image.jpg'};
  await store.rpc('tb_register_image',{vid:id(3),patch});
  await store.rpc('tb_register_image',{vid:id(6),patch});
  assert.equal((await store.get(id(6))).status,'rejected');
  assert.equal((await store.get(id(6))).data.duplicateOf,id(3));
  await store.rpc('tb_register_image',{vid:id(4),patch});assert.equal((await store.get(id(4))).status,'board');
});
test('job claims are leased; unavailable YouTube images never remove board records',async()=>{
  await store.save([{id:id(8),title:'Unavailable',channel:'Known'}]);
  const result=await processAssetJobs(store,10,async()=>new Response('',{status:404}));
  assert.ok(result.results.some(v=>v.id===id(8)&&!v.ok));
  assert.equal((await store.get(id(8))).deleted_at,null);
  assert.deepEqual(await store.rpc('tb_claim_jobs',{batch_size:10}),[]);
});
test('archiver rejects tiny placeholders and saves valid fallback bytes',async()=>{
  const jpeg=(width,height)=>new Uint8Array([255,216,255,192,0,17,8,height>>8,height&255,width>>8,width&255,3,1,17,0,2,17,0,3,17,0,255,217]);
  let attempts=0,uploads=0;
  const patch=await archiveThumbnail(id(9),{uploadImage:async(bytes,hash)=>{uploads++;assert.equal(hash.length,64);return 'https://archive.test/'+hash+'.jpg';}},async()=>new Response(jpeg(++attempts===1?120:480,360),{headers:{'Content-Type':'image/jpeg'}}));
  assert.equal(attempts,2);assert.equal(uploads,1);assert.equal(patch.imageWidth,480);
});
test('visual review keeps suggestions separate from approved tags and checks score bounds',async()=>{
  await store.save([{id:id(10),title:'Visual review',tags:[]}],'add','inbox');
  assert.equal((await post('/api/inbox/visual-review',{id:id(10),visualQuality:5,visualConfidence:.9})).status,400);
  assert.equal((await post('/api/inbox/visual-review',{id:id(10),visualQuality:3,visualConfidence:.9,tags:['style-minimal','unknown-thing'],visualNotes:'Clear focal point'})).status,200);
  const row=await store.get(id(10));assert.equal(row.status,'inbox');assert.deepEqual(row.data.tags,[]);assert.deepEqual(row.data.tagSuggestions,['style-minimal']);
});
test('semantic search filters own channels and deletion removes search matches',async()=>{
  await store.save([{id:id(11),title:'Mine'},{id:id(12),title:'Other'}]);
  const vector=Array(384).fill(.1);
  await store.upsertEmbedding(id(11),vector,{is_own:true});await store.upsertEmbedding(id(12),vector,{is_own:false});
  assert.deepEqual((await store.match(vector,{includeOwnChannels:false})).map(v=>v.id),[id(12)]);
  await store.delete([id(12)]);assert.deepEqual(await store.match(vector,{includeOwnChannels:false}),[]);
});
