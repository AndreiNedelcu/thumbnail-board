import { processAssetJobs } from './assets.mjs';
import { runScrape } from './scrape.mjs';

const idPattern=/^[\w-]{11}$/;
const prefixes=new Set(['style','mood','text','element','camera','subject','formation','topic','callout','backdrop','channel']);
const cors={'Access-Control-Allow-Origin':'*','Access-Control-Allow-Methods':'GET, POST, OPTIONS','Access-Control-Allow-Headers':'Content-Type, X-Auth-Token','Cache-Control':'no-store'};
const json=(value,status=200)=>new Response(JSON.stringify(value),{status,headers:{...cors,'Content-Type':'application/json'}});
// Public lists are revalidated with an ETag: an unchanged board costs a 304, not ~0.5 MB.
async function cachedJson(req,value) {
  const body=JSON.stringify(value);
  const digest=await crypto.subtle.digest('SHA-1',new TextEncoder().encode(body));
  const etag='"'+Array.from(new Uint8Array(digest),b=>b.toString(16).padStart(2,'0')).join('')+'"';
  const headers={...cors,'Cache-Control':'no-cache','ETag':etag,'Access-Control-Expose-Headers':'ETag'};
  if(req.headers.get('If-None-Match')===etag) return new Response(null,{status:304,headers});
  return new Response(body,{headers:{...headers,'Content-Type':'application/json'}});
}
const own=v=>(v.tags||[]).some(t=>['channel-theseniordev-main','channel-theseniordev-podcast'].includes(t)) || ['theseniordev','therealseniordev','theseniordevpodcast'].includes(String(v.channel||'').toLowerCase().replace(/[^a-z0-9]/g,''));
function validIds(ids) {
  if (!Array.isArray(ids) || !ids.length || ids.length>5000 || ids.some(id=>typeof id!=='string'||!idPattern.test(id))) throw new Error('Provide valid YouTube video IDs.');
  return [...new Set(ids)];
}
function videoItem(item, partial=false) {
  const id=item?.vid||item?.id||item?.videoId;
  validIds([id]);
  const data={id};
  for (const field of ['title','channel','channelId','channelHandle','channelUrl','views','eid']) {
    const value=field==='title' ? item.title??item.name : item[field];
    if (typeof value==='string') data[field]=value.slice(0,1000);

  }
  if (Array.isArray(item.tags)) data.tags=[...new Set(item.tags.filter(t=>typeof t==='string').map(t=>t.trim().toLowerCase()).filter(t=>/^[a-z]+-[a-z0-9-]+$/.test(t)&&prefixes.has(t.split('-')[0])))].slice(0,50);
  else if (!partial) data.tags=[];
  return data;
}

export function createHandler({store,authToken,embed,youtubeKey,fetcher=fetch,embeddingModel='gte-small'}) {
  return async function handler(req) {
    if(req.method==='OPTIONS') return new Response(null,{status:204,headers:cors});
    const path=new URL(req.url).pathname.replace(/^.*\/board-api(?=\/|$)/,'');
    const protectedRead=['/api/favorites','/api/ideas/discovery-queue','/api/maintenance/status','/api/pending'].includes(path);
    if((req.method!=='GET'||protectedRead) && (!authToken||req.headers.get('X-Auth-Token')!==authToken)) return json({ok:false,msg:'Unauthorized'},401);
    try {
      if(path==='/api/health' && req.method==='GET') return json({ok:true,backend:'supabase',features:{favorites:true,archive:true,embeddingModel}});
      if(path==='/api/pending' && req.method==='GET') return json(await store.list('pending'));
      if(path==='/api/data' && req.method==='GET') return cachedJson(req,await store.list('board'));
      if(path==='/api/inbox' && req.method==='GET') return cachedJson(req,await store.list('inbox'));
      if(path==='/api/favorites' && req.method==='GET') return json({ok:true,ids:await store.favorites()});
      if(path==='/api/ideas/discovery-queue' && req.method==='GET') return json(await store.discoveryQueue(embeddingModel));
      if(path==='/api/maintenance/status' && req.method==='GET') return json(await store.rest('tb_jobs?completed_at=is.null&select=video_id,kind,attempts,last_error&limit=10000'));
      if(req.method!=='POST') return json({ok:false,msg:'Not found'},404);
      const raw=await req.text();
      if(raw.length>2000000) return json({ok:false,msg:'Request too large'},413);
      let body;
      try { body=JSON.parse(raw); } catch {return json({ok:false,msg:'Invalid JSON'},400);}
      if(!body || typeof body!=='object' || Array.isArray(body)) return json({ok:false,msg:'Expected an object'},400);
      if(path==='/api/delete'||path==='/api/bulk-delete') return json(await store.delete(validIds(path.endsWith('bulk-delete')?body.ids:[body.id])));
      if(path==='/api/favorites') {
        validIds([body.id]);
        if(typeof body.saved!=='boolean') return json({ok:false,msg:'saved must be a boolean'},400);
        const row=await store.get(body.id);
        if(!row||row.deleted_at||row.status!=='board') return json({ok:false,msg:'Thumbnail not found'},404);
        return json(await store.favorite(body.id,body.saved));
      }
      if(['/api/add','/api/add-batch','/api/update','/api/update-batch','/api/eagle/update'].includes(path)) {
        const mode=path.includes('update')?'update':'add';
        const input=path.endsWith('-batch')?body.items:[body];
        if(!Array.isArray(input)||!input.length||input.length>500) return json({ok:false,msg:'Provide 1–500 items'},400);
        const items=input.map(item=>videoItem(item,mode==='update'));
        const result=await store.save(items,mode);
        if(input.length===1 && !result.changed) return json({ok:false,msg:mode==='add'?'Already in board or previously removed':'Thumbnail not found'},409);
        return json({...result,entry:items[0]});
      }
      if(path==='/api/inbox/approve'||path==='/api/inbox/reject') {
        const destination=path.endsWith('reject')?'rejected':body.destination==='board'?'board':'pending';
        return json(await store.decide(validIds(body.ids),destination));
      }
      if(path==='/api/pending/publish') return json(await store.rpc('tb_publish_pending',{ids:validIds(body.ids)}));
      if(path==='/api/tag-untagged') {
        if(!Array.isArray(body.items)||!body.items.length||body.items.length>500) return json({ok:false,msg:'Provide 1–500 items'},400);
        return json(await store.rpc('tb_tag_untagged',{items:body.items.map(item=>{const v=videoItem(item,true);return {id:v.id,tags:v.tags||[]};})}));
      }
      if(path==='/api/inbox/visual-review') {
        validIds([body.id]);
        if(!Number.isFinite(body.visualQuality)||body.visualQuality<0||body.visualQuality>4||!Number.isFinite(body.visualConfidence)||body.visualConfidence<0||body.visualConfidence>1)return json({ok:false,msg:'Invalid visual review'},400);
        const row=await store.get(body.id);
        if(!row||row.deleted_at||row.status!=='inbox')return json({ok:false,msg:'Inbox candidate not found'},404);
        return json(await store.save([{id:body.id,visualQuality:body.visualQuality,visualConfidence:body.visualConfidence,visualNotes:String(body.visualNotes||'').slice(0,12000),tagSuggestions:videoItem(body,true).tags||[],visualReviewedAt:new Date().toISOString()}],'update'));
      }
      if(path==='/api/inbox/block-channel') {
        if(!/^UC[\w-]{22}$/.test(body.channelId||'')) return json({ok:false,msg:'Invalid channel ID'},400);
        return json(await store.rpc('tb_block_channel',{channel_id:body.channelId,channel_name:body.channelName||''}));
      }
      if(path==='/api/maintenance/run') return json(await processAssetJobs(store,Math.min(10,Math.max(1,Number(body.limit)||5)),fetcher));
      if(path==='/api/scrape/run') {
        if(!youtubeKey) return json({ok:false,msg:'YOUTUBE_API_KEY is not configured'},503);
        const sources=await store.setting('scrape_sources',{});
        sources.thresholds={...(sources.thresholds||{})};
        for(const key of ['min_outlier_score','cap_per_run','min_views','max_age_days','min_duration_seconds']) if(Number.isFinite(body[key])&&body[key]>=0) sources.thresholds[key]=body[key];
        const inbox=await store.list('inbox');
        if(inbox.length >= (sources.thresholds.max_inbox_size||100)) return json({ok:true,added:0,msg:'Inbox is full. Review candidates before collecting more.',stats:{inbox_size_before:inbox.length}});
        const ids=new Set((await store.allIds()).map(v=>v.id));
        const blocklist=new Set((await store.setting('blocked_channels',[])).map(v=>v.channelId));
        const result=await runScrape({YOUTUBE_API_KEY:youtubeKey},sources,ids,blocklist);
        const saved=await store.rpc('tb_collect',{candidates:result.candidates,history:result.discoveryCandidates||result.candidates,max_size:sources.thresholds.max_inbox_size||100});
        return json({...saved,stats:result.stats});
      }
      if(path==='/api/ideas/embed'||path==='/api/ideas/discovery-enrich') {
        validIds([body.id]);
        const row=await store.get(body.id);
        if(!row||row.deleted_at) return json({ok:false,msg:'Thumbnail not found'},404);
        const text=String(body.text||[body.title,body.channel,body.transcript].filter(Boolean).join('\n')).slice(0,12000);
        if(!text) return json({ok:false,msg:'Text required'},400);
        const source=path.endsWith('discovery-enrich')?'discovery':'board';
        await store.upsertEmbedding(body.id,await embed(text),{title:body.title||row.data.title,channel:body.channel||row.data.channel,is_own:own(row.data)},source,embeddingModel);
        return json({ok:true,id:body.id});
      }
      if(path==='/api/ideas/search') {
        const text=[body.title,body.script].filter(v=>typeof v==='string').join('\n').trim();
        if(!text) return json({ok:false,msg:'Add a title or some ideas'},400);
        return json({ok:true,results:await store.match(await embed(text.slice(0,12000)),body,embeddingModel)});
      }
      if(path==='/api/ideas/related') {
        validIds([body.id]);
        const entry=await store.getEmbedding(body.id);
        if(!entry||(entry.model&&entry.model!==embeddingModel)) return json({ok:false,msg:'Thumbnail has not been indexed with the current search model yet'},404);
        const vector=typeof entry.embedding==='string'?JSON.parse(entry.embedding):entry.embedding;
        const results=await store.match(vector,{...body,topK:Math.min(49,Number(body.topK)||8)+1},embeddingModel);
        return json({ok:true,results:results.filter(v=>v.id!==body.id).slice(0,body.topK||8)});
      }
      return json({ok:false,msg:'Not found'},404);
    } catch(error) {
      const invalid=/valid YouTube|Provide 1/.test(error.message);
      return json({ok:false,msg:invalid?'Invalid request':error.message},invalid?400:500);
    }
  };
}
