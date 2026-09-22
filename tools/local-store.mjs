import { PGlite } from '@electric-sql/pglite';
import { vector } from '@electric-sql/pglite-pgvector';
import { readFile, mkdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';

export async function openLocalStore(directory, seed=false) {
  const db=new PGlite({dataDir:directory,extensions:{vector}});
  const exists=await db.query("select to_regclass('public.tb_videos') as name");
  if(!exists.rows[0].name) {
    await db.exec("create schema if not exists extensions; create schema if not exists storage; create role anon; create role authenticated; create role service_role; create table storage.buckets(id text primary key,name text,public boolean,file_size_limit bigint,allowed_mime_types text[]);");
    await db.exec(await readFile(new URL('../supabase/migrations/202609230001_board.sql',import.meta.url),'utf8'));
  }
  const store=new LocalStore(db);
  if(seed) {
    const count=await db.query('select count(*)::integer as n from tb_videos');
    if(!count.rows[0].n) {
      for(const [file,status] of [['data.json','board'],['eagle-pending.json','pending'],['scrape_inbox.json','inbox'],['scrape_rejected.json','rejected'],['discovery_queue.json','discovery']]) {
        const items=JSON.parse(await readFile(new URL('../'+file,import.meta.url),'utf8')).map(v=>typeof v==='string'?{id:v}:v);
        await store.save(items,'add',status);
      }
      await store.setSetting('scrape_sources',JSON.parse(await readFile(new URL('../scrape_sources.json',import.meta.url),'utf8')));
      await store.setSetting('blocked_channels',JSON.parse(await readFile(new URL('../scrape_channel_blocklist.json',import.meta.url),'utf8')));
    }
  }
  if(seed) {
    let backup={};
    try {backup=JSON.parse(await readFile(new URL('../.local/asset-backup/records.json',import.meta.url),'utf8'));}
    catch(error){if(error.code!=='ENOENT')throw error;}
    for(const [id,cached] of Object.entries(backup)) {
      const row=await store.get(id);if(!row||row.deleted_at)continue;
      const patch={};
      for(const field of ['title','channel','channelId','channelHandle','channelUrl'])if(!row.data[field]&&cached[field])patch[field]=cached[field];
      if(cached.imageHash&&!row.data.thumbnailUrl)Object.assign(patch,{thumbnailUrl:'/local-images/'+cached.imageHash+'.jpg',imageHash:cached.imageHash,archivedAt:cached.archivedAt});
      if(Object.keys(patch).length)await store.save([{id,...patch}],'update');
    }
  }
  return store;
}

class LocalStore {
  constructor(db){this.db=db;}
  async rpc(name,args){
    const names={tb_save:['items','mode','destination'],tb_delete:['ids'],tb_decide:['ids','destination'],tb_claim_jobs:['batch_size'],tb_collect:['candidates','history','max_size'],tb_register_image:['vid','patch'],tb_match:['query_embedding','match_count','include_own','include_discovery'],tb_block_channel:['channel_id','channel_name']};
    if(!names[name])throw new Error('Unknown local RPC');
    const keys=names[name];
    const values=keys.map(k=>['items','candidates','history','patch','query_embedding'].includes(k)?JSON.stringify(args[k]):args[k]);
    const setReturning=['tb_claim_jobs','tb_match'].includes(name);
    const query=setReturning?`select * from public.${name}(${keys.map((_,i)=>'$'+(i+1))})`:`select public.${name}(${keys.map((_,i)=>'$'+(i+1))}) as result`;
    const result=await this.db.query(query,values);
    return setReturning?result.rows:result.rows[0].result;
  }
  async list(status){return (await this.db.query('select id,data from tb_videos where status=$1 and deleted_at is null order by position',[status])).rows.map(v=>({...v.data,id:v.id}));}
  async discoveryQueue(){return (await this.db.query('select data from tb_discovery_queue limit 100')).rows.map(v=>v.data);}
  async allIds(){return (await this.db.query('select id from tb_videos')).rows;}
  async get(id){return (await this.db.query('select * from tb_videos where id=$1',[id])).rows[0]||null;}
  save(items,mode='add',destination='board'){return this.rpc('tb_save',{items,mode,destination});}
  delete(ids){return this.rpc('tb_delete',{ids});}
  decide(ids,destination){return this.rpc('tb_decide',{ids,destination});}
  async setting(name,fallback){return (await this.db.query('select value from tb_settings where name=$1',[name])).rows[0]?.value??fallback;}
  async setSetting(name,value){await this.db.query('insert into tb_settings(name,value) values($1,$2) on conflict(name) do update set value=excluded.value',[name,JSON.stringify(value)]);}
  async favorites(){return (await this.db.query('select video_id from tb_favorites')).rows.map(v=>v.video_id);}
  async favorite(id,saved){
    await this.db.query(saved?'insert into tb_favorites(video_id) values($1) on conflict do nothing':'delete from tb_favorites where video_id=$1',[id]);
    return {ok:true,id,saved};
  }
  async jobResult(job,error){
    if(error)await this.db.query("update tb_jobs set last_error=$3,next_attempt=now()+interval '1 hour' where video_id=$1 and kind=$2",[job.video_id,job.kind,error]);
    else await this.db.query('update tb_jobs set completed_at=now(),last_error=null where video_id=$1 and kind=$2',[job.video_id,job.kind]);
  }
  async rest(path){
    if(path.startsWith('tb_jobs?'))return (await this.db.query('select video_id,kind,attempts,last_error from tb_jobs where completed_at is null')).rows;
    throw new Error('Unsupported local request');
  }
  async uploadImage(bytes,hash){
    await mkdir(resolve('.local/images'),{recursive:true});
    await writeFile(resolve('.local/images',hash+'.jpg'),bytes);
    return '/local-images/'+hash+'.jpg';
  }
  async upsertEmbedding(id,embedding,metadata,source='board'){
    await this.db.query('insert into tb_embeddings(video_id,embedding,metadata,source) values($1,$2,$3,$4) on conflict(video_id) do update set embedding=excluded.embedding,metadata=excluded.metadata,source=excluded.source',[id,JSON.stringify(embedding),JSON.stringify(metadata),source]);
  }
  async getEmbedding(id){return (await this.db.query('select embedding,metadata from tb_embeddings where video_id=$1',[id])).rows[0];}
  async match(vector,body){
    const rows=await this.rpc('tb_match',{query_embedding:vector,match_count:body.topK||12,include_own:body.includeOwnChannels!==false,include_discovery:body.includeDiscovery!==false});
    return rows.map(v=>({...v.data,...v.metadata,id:v.id,score:v.score,source:v.source}));
  }
}
