const VALID_ID = /^[A-Za-z0-9_-]{11}$/;

// Only fixed YouTube endpoints are fetched: never follow arbitrary client URLs.
export async function youtubeMetadata(id, fetcher=fetch) {
  if (!VALID_ID.test(id)) throw new Error('Invalid video id');
  const response = await fetcher(`https://www.youtube.com/oembed?url=${encodeURIComponent(`https://www.youtube.com/watch?v=${id}`)}&format=json`,{signal:AbortSignal.timeout(10000)});
  if (!response.ok) throw new Error(`YouTube metadata unavailable (${response.status})`);
  const data = await response.json();
  const channelUrl = String(data.author_url || '');
  return {title:String(data.title || ''),channel:String(data.author_name || ''),channelUrl,
    channelId:channelUrl.match(/\/channel\/(UC[\w-]{22})/)?.[1] || '',
    channelHandle:channelUrl.match(/\/(@[\w.-]+)/)?.[1] || ''};
}

export function jpegDimensions(bytes) {
  if (bytes[0] !== 255 || bytes[1] !== 216) return null;
  for (let i=2; i+8 < bytes.length;) {
    if (bytes[i] !== 255) return null;
    const marker=bytes[i+1];
    if (marker===216 || marker===1) {i+=2;continue;}
    const length=(bytes[i+2]<<8)|bytes[i+3];
    if (length<2) return null;
    if ([192,193,194,195,197,198,199,201,202,203,205,206,207].includes(marker))
      return {width:(bytes[i+7]<<8)|bytes[i+8],height:(bytes[i+5]<<8)|bytes[i+6]};
    i += length+2;
  }
  return null;
}

export async function archiveThumbnail(id, store, fetcher=fetch) {
  if (!VALID_ID.test(id)) throw new Error('Invalid video id');
  for (const quality of ['maxresdefault','hqdefault','mqdefault']) {
    let response;
    try { response=await fetcher(`https://img.youtube.com/vi/${id}/${quality}.jpg`,{signal:AbortSignal.timeout(10000)}); }
    catch { continue; }
    if (!response.ok || !response.headers.get('content-type')?.startsWith('image/jpeg')) continue;
    if (Number(response.headers.get('content-length'))>5242880) continue;
    const bytes=new Uint8Array(await response.arrayBuffer());
    if (bytes.length>5242880) continue;
    const dimensions=jpegDimensions(bytes);
    if (!dimensions || dimensions.width<200 || dimensions.height<100) continue;
    const digest=await crypto.subtle.digest('SHA-256',bytes);
    const hash=Array.from(new Uint8Array(digest),b=>b.toString(16).padStart(2,'0')).join('');
    return {thumbnailUrl:await store.uploadImage(bytes,hash),imageHash:hash,imageWidth:dimensions.width,imageHeight:dimensions.height,archivedAt:new Date().toISOString()};
  }
  throw new Error('Image unavailable on YouTube. Existing saved images were preserved.');
}

export async function processAssetJobs(store, limit=5, fetcher=fetch) {
  const jobs=await store.rpc('tb_claim_jobs',{batch_size:limit});
  const results=[];
  await Promise.all(jobs.map(async job => {
    try {
      const row=await store.get(job.video_id);
      if (!row || row.deleted_at) {await store.jobResult(job,null);return;}
      let patch={};
      if (job.kind==='archive' && !row.data.thumbnailUrl) patch=await archiveThumbnail(job.video_id,store,fetcher);
      if (job.kind==='metadata' && !row.data.channel) {
        const metadata=await youtubeMetadata(job.video_id,fetcher);
        patch=Object.fromEntries(Object.entries(metadata).filter(([key,value])=>!row.data[key] && value));
      }
      if (patch.imageHash) await store.rpc('tb_register_image',{vid:job.video_id,patch});
      else if (Object.keys(patch).length) await store.save([{id:job.video_id,...patch}],'update');
      await store.jobResult(job,null);results.push({id:job.video_id,kind:job.kind,ok:true});
    } catch(error) {
      await store.jobResult(job,error.message);results.push({id:job.video_id,kind:job.kind,ok:false,msg:error.message});
    }
  }));
  return {ok:true,processed:results.length,results};
}
