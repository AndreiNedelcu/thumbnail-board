// Independent, resumable backup before cutover. Original JSON files stay untouched.
import {readFile,writeFile,mkdir,rename} from 'node:fs/promises';
import {archiveThumbnail,youtubeMetadata} from '../supabase/functions/_shared/assets.mjs';
const dir='.local/asset-backup';await mkdir(dir+'/images',{recursive:true});
let records={};try{records=JSON.parse(await readFile(dir+'/records.json','utf8'));}catch(e){if(e.code!=='ENOENT')throw e;}
const seen=new Map();
for(const file of ['data.json','eagle-pending.json','scrape_inbox.json'])for(const v of JSON.parse(await readFile(file,'utf8')))if(!seen.has(v.id))seen.set(v.id,v);
const items=[...seen.values()];
const limit=Number(process.env.TB_BACKUP_LIMIT||items.length);let cursor=0,done=0,writing=Promise.resolve();
function checkpoint(){writing=writing.then(async()=>{await writeFile(dir+'/records.tmp',JSON.stringify(records));await rename(dir+'/records.tmp',dir+'/records.json');});return writing;}
const store={uploadImage:async(bytes,hash)=>{await writeFile(dir+'/images/'+hash+'.jpg',bytes);return 'local-backup:'+hash;}};
await Promise.all(Array.from({length:6},async()=>{
  while(cursor<Math.min(limit,items.length)){
    const video=items[cursor++];let record=records[video.id]||{};
    if(!record.imageHash){
      try{record={...record,...await archiveThumbnail(video.id,store)};delete record.imageError;}
      catch(e){record.imageError=e.message;}
    }
    if(!video.channel&&!record.channel){
      try{record={...record,...await youtubeMetadata(video.id)};delete record.metadataError;}
      catch(e){record.metadataError=e.message;}
    }
    records[video.id]=record;done++;
    if(done%20===0)await checkpoint();
    if(done%100===0)console.log(`Backed up/checked ${done}/${Math.min(limit,items.length)}`);
  }
}));
await checkpoint();
console.log(JSON.stringify({checked:done,archived:Object.values(records).filter(v=>v.imageHash).length,channelsRecovered:Object.values(records).filter(v=>v.channel).length,unavailable:Object.values(records).filter(v=>v.imageError).length}));
