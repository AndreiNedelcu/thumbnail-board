// Resumable importer. Conflicts are ignored, including deletion tombstones.
// Run without --apply to audit the local snapshot without network access.
import {readFile,writeFile,mkdir} from 'node:fs/promises';
import {SupabaseStore} from '../supabase/functions/_shared/store.mjs';
const root=new URL('../',import.meta.url);
const files=[['data.json','board'],['eagle-pending.json','pending'],['scrape_inbox.json','inbox'],['scrape_rejected.json','rejected'],['discovery_queue.json','discovery']];
const entries=new Map(),counts={};
for(const [file,status] of files){
  const items=JSON.parse(await readFile(new URL(file,root),'utf8'));counts[status]={source:items.length,unique:0};
  for(let item of items){
    if(typeof item==='string')item={id:item};
    if(!/^[\w-]{11}$/.test(item.id||''))throw new Error(`Invalid ID in ${file}; import stopped`);
    if(entries.has(item.id))continue;
    entries.set(item.id,{id:item.id,data:item,status});counts[status].unique++;
  }
}
console.log(JSON.stringify({counts,total:entries.size,dryRun:!process.argv.includes('--apply')},null,2));
if(!process.argv.includes('--apply'))process.exit(0);
const {SUPABASE_URL,SUPABASE_SERVICE_ROLE_KEY}=process.env;
if(!SUPABASE_URL||!SUPABASE_SERVICE_ROLE_KEY)throw new Error('Set SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY in a private environment file.');
const store=new SupabaseStore(SUPABASE_URL,SUPABASE_SERVICE_ROLE_KEY);
const items=[...entries.values()];
for(let offset=0;offset<items.length;offset+=200){
  await store.rest('tb_videos?on_conflict=id',{method:'POST',headers:{Prefer:'resolution=ignore-duplicates,return=minimal'},body:JSON.stringify(items.slice(offset,offset+200))});
  console.log(`Imported/verified ${Math.min(offset+200,items.length)}/${items.length}`);
}
for(const [name,file] of [['scrape_sources','scrape_sources.json'],['blocked_channels','scrape_channel_blocklist.json']]){
  const value=JSON.parse(await readFile(new URL(file,root),'utf8'));
  await store.rest('tb_settings?on_conflict=name',{method:'POST',headers:{Prefer:'resolution=ignore-duplicates,return=minimal'},body:JSON.stringify({name,value})});
}
let backup={};
try {backup=JSON.parse(await readFile('.local/asset-backup/records.json','utf8'));}
catch(error){if(error.code!=='ENOENT')throw error;}
let imagesUploaded=0,metadataRecovered=0;
const targetRows=new Map((await store.rows('select=*')).map(v=>[v.id,v]));
const backupEntries=Object.entries(backup);let nextAsset=0;
await Promise.all(Array.from({length:4},async()=>{
while(nextAsset<backupEntries.length){
  const [id,record]=backupEntries[nextAsset++];
  const row=targetRows.get(id);if(!row||row.deleted_at)continue;
  const patch={};
  for(const field of ['title','channel','channelId','channelHandle','channelUrl'])if(!row.data[field]&&record[field])patch[field]=record[field];
  if(patch.channel)metadataRecovered++;
  if(record.imageHash&&!row.data.thumbnailUrl){
    const bytes=await readFile('.local/asset-backup/images/'+record.imageHash+'.jpg');
    Object.assign(patch,{thumbnailUrl:await store.uploadImage(bytes,record.imageHash),imageHash:record.imageHash,imageWidth:record.imageWidth,imageHeight:record.imageHeight,archivedAt:record.archivedAt});
    await store.rpc('tb_register_image',{vid:id,patch});
    await store.jobResult({video_id:id,kind:'archive'},null);imagesUploaded++;
    if(imagesUploaded%100===0)console.log(`Archived ${imagesUploaded} images in Supabase Storage`);
  }else if(Object.keys(patch).length)await store.save([{id,...patch}],'update');
  if(patch.channel)await store.jobResult({video_id:id,kind:'metadata'},null);
}
}));
const stored=new Set((await store.allIds()).map(v=>v.id));
const missing=items.filter(v=>!stored.has(v.id)).map(v=>v.id);
if(missing.length)throw new Error(`Verification failed: ${missing.length} missing IDs`);
const report={at:new Date().toISOString(),project:SUPABASE_URL,counts,total:items.length,imagesUploaded,metadataRecovered,missing:0,board:(await store.list('board')).length,inbox:(await store.list('inbox')).length};
await mkdir('.local',{recursive:true});await writeFile('.local/migration-report.json',JSON.stringify(report,null,2));
console.log('Import verified. Image archiving and metadata jobs are queued; no frontend switch was made.');
