import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,readFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {PGlite} from '@electric-sql/pglite';
import {vector} from '@electric-sql/pglite-pgvector';
import {openLocalStore} from '../tools/local-store.mjs';
import {createHandler} from '../supabase/functions/_shared/api.mjs';
import {createEmbedder,openAiCompatibleEmbedder} from '../supabase/functions/_shared/embeddings.mjs';

const id=n=>'embed'+String(n).padStart(6,'0');
const unit=i=>Array.from({length:384},(_,j)=>j===i?1:0);

test('search, related and discovery queue never mix vectors from different models',async()=>{
  const store=await openLocalStore();
  try {
    const handler=createHandler({store,authToken:'test-only-token',embed:async()=>unit(0),embeddingModel:'multilingual'});
    const post=(path,body)=>handler(new Request('https://example.test/board-api'+path,{method:'POST',headers:{'X-Auth-Token':'test-only-token'},body:JSON.stringify(body)}));
    await store.save([{id:id(1),title:'Old vector'},{id:id(2),title:'New vector'}]);
    await store.save([{id:id(3),title:'Discovery old'}],'add','discovery');
    await store.upsertEmbedding(id(1),unit(0),{},'board','gte-small');
    await store.upsertEmbedding(id(3),unit(0),{},'discovery','gte-small');
    assert.equal((await post('/api/ideas/embed',{id:id(2),text:'nuevo'})).status,200);
    assert.equal((await store.getEmbedding(id(2))).model,'multilingual');
    const search=await (await post('/api/ideas/search',{title:'carrera de programador'})).json();
    assert.deepEqual(search.results.map(v=>v.id),[id(2)]);
    assert.equal((await post('/api/ideas/related',{id:id(1)})).status,404);
    assert.deepEqual((await store.discoveryQueue('multilingual')).map(v=>v.id),[id(3)]);
    assert.deepEqual(await store.discoveryQueue('gte-small'),[]);
    const health=await (await handler(new Request('https://example.test/board-api/api/health'))).json();
    assert.equal(health.features.embeddingModel,'multilingual');
  } finally {await store.db.close();}
});

test('existing local databases receive new migrations without losing records',async()=>{
  const dir=await mkdtemp(join(tmpdir(),'tb-migrate-'));
  try {
    const old=new PGlite({dataDir:dir,extensions:{vector}});
    await old.exec("create schema if not exists extensions; create schema if not exists storage; create role anon; create role authenticated; create role service_role; create table storage.buckets(id text primary key,name text,public boolean,file_size_limit bigint,allowed_mime_types text[]);");
    await old.exec(await readFile(new URL('../supabase/migrations/202609230001_board.sql',import.meta.url),'utf8'));
    await old.query(`select tb_save('[{"id":"${id(9)}","title":"Kept"}]'::jsonb)`);
    await old.close();
    let store=await openLocalStore(dir);
    assert.equal((await store.get(id(9))).data.title,'Kept');
    assert.deepEqual(await store.discoveryQueue('gte-small'),[]);
    await store.db.close();
    store=await openLocalStore(dir); // reopening must not re-run migrations
    assert.equal((await store.db.query('select count(*)::int as n from tb_local_migrations')).rows[0].n,2);
    await store.db.close();
  } finally {await rm(dir,{recursive:true,force:true});}
});

test('OpenAI-compatible provider requests 384 dimensions and validates the response',async()=>{
  const calls=[];
  const reply=values=>async(url,options)=>{calls.push({url,options});return new Response(JSON.stringify({data:[{embedding:values}]}));};
  const embedder=openAiCompatibleEmbedder({url:'https://api.example.test/v1/embeddings',key:'test-key',model:'text-embedding-3-small',fetcher:reply(Array(384).fill(2))});
  const values=await embedder.embed('¿Cómo ascender a senior?');
  assert.ok(Math.abs(Math.hypot(...values)-1)<1e-9);
  const body=JSON.parse(calls[0].options.body);
  assert.deepEqual([body.model,body.dimensions,body.input],['text-embedding-3-small',384,'¿Cómo ascender a senior?']);
  assert.equal(calls[0].options.headers.Authorization,'Bearer test-key');
  const wrong=openAiCompatibleEmbedder({url:'https://api.example.test',key:'k',model:'m',fetcher:reply(Array(1536).fill(1))});
  await assert.rejects(wrong.embed('x'),/384/);
  assert.throws(()=>createEmbedder({EMBEDDING_MODEL:'m'},()=>null),/required together/);
  assert.equal(createEmbedder({},()=>null).model,'gte-small');
});
