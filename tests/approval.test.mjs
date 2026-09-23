import {test,before,after} from 'node:test';
import assert from 'node:assert/strict';
import {openLocalStore} from '../tools/local-store.mjs';
import {createHandler} from '../supabase/functions/_shared/api.mjs';

let store,handler;
before(async()=>{store=await openLocalStore();handler=createHandler({store,authToken:'test-only-token',embed:async()=>Array(384).fill(0.1)});});
after(async()=>store?.db.close());
const id=n=>'appr'+String(n).padStart(7,'0');
const post=(path,body)=>handler(new Request('https://example.test/board-api'+path,{method:'POST',headers:{'X-Auth-Token':'test-only-token'},body:JSON.stringify(body)}));
const get=(path,headers={})=>handler(new Request('https://example.test/board-api'+path,{headers}));
const boardIds=async()=>(await (await get('/api/data')).json()).map(v=>v.id);

test('approving inbox items to the board puts them last, like the old append order',async()=>{
  await store.save([{id:id(1),title:'Old candidate'}],'add','inbox');
  await store.save([{id:id(2),title:'Board item'},{id:id(3),title:'Newer board item',tags:['style-minimal']}]);
  const response=await (await post('/api/inbox/approve',{ids:[id(1)],destination:'board'})).json();
  assert.equal(response.moved,1);
  const ids=await boardIds();
  assert.equal(ids.at(-1),id(1));
  assert.ok((await store.get(id(1))).data.approvedAt);
  assert.deepEqual((await store.get(id(3))).data.tags,['style-minimal']);
});

test('items waiting in pending can be published without losing data or resurrecting deletions',async()=>{
  await store.save([{id:id(4),title:'Waiting'},{id:id(5),title:'Deleted'}],'add','pending');
  await store.delete([id(5)]);
  const result=await (await post('/api/pending/publish',{ids:[id(4),id(5)]})).json();
  assert.equal(result.moved,1);
  const row=await store.get(id(4));
  assert.equal(row.status,'board');assert.equal(row.data.title,'Waiting');
  assert.equal((await store.get(id(5))).deleted_at!==null,true);
  assert.equal((await boardIds()).at(-1),id(4));
  assert.equal((await post('/api/pending/publish',{ids:['bad']})).status,400);
});

test('public board list supports ETag revalidation',async()=>{
  const first=await get('/api/data');
  const etag=first.headers.get('ETag');
  assert.match(etag,/^"[0-9a-f]{40}"$/);
  assert.equal(first.headers.get('Cache-Control'),'no-cache');
  assert.equal((await get('/api/data',{'If-None-Match':etag})).status,304);
  await store.save([{id:id(6),title:'Changes the list'}]);
  assert.equal((await get('/api/data',{'If-None-Match':etag})).status,200);
});

test('publishing pending items requires the owner token',async()=>{
  const r=await handler(new Request('https://example.test/board-api/api/pending/publish',{method:'POST',body:JSON.stringify({ids:[id(4)]})}));
  assert.equal(r.status,401);
});

test('the tagger publishing a pending item moves it to the end with its tags',async()=>{
  await store.save([{id:id(7),title:'Tagged later'}],'add','pending');
  const response=await (await post('/api/add-batch',{items:[{id:id(7),tags:['style-minimal']},{id:id(8),title:'Brand new'}]})).json();
  assert.equal(response.changed,2);
  const row=await store.get(id(7));
  assert.equal(row.status,'board');assert.deepEqual(row.data.tags,['style-minimal']);assert.equal(row.data.title,'Tagged later');
  assert.deepEqual((await boardIds()).slice(-2).sort(),[id(7),id(8)].sort());
  assert.equal((await (await post('/api/add',{id:id(7)})).json()).ok,false);
});

test('auto-tagging untagged board items never overwrites tags the user added',async()=>{
  await store.save([{id:id(9),title:'Untagged'},{id:id(10),title:'Tagged by hand',tags:['mood-happy']}]);
  const result=await (await post('/api/tag-untagged',{items:[{id:id(9),tags:['style-minimal','fake-tag']},{id:id(10),tags:['style-busy']}]})).json();
  assert.equal(result.changed,1);
  assert.deepEqual((await store.get(id(9))).data.tags,['style-minimal']);
  assert.deepEqual((await store.get(id(10))).data.tags,['mood-happy']);
});
