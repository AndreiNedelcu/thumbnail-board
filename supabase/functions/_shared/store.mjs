export class SupabaseStore {
  constructor(url, key, fetcher = fetch) {
    this.url = url.replace(/\/$/, ''); this.key = key; this.fetcher = fetcher;
  }
  async rest(path, options = {}) {
    const response = await this.fetcher(`${this.url}/rest/v1/${path}`, {
      ...options,
      headers: { apikey: this.key, Authorization: `Bearer ${this.key}`, 'Content-Type': 'application/json', ...options.headers },
    });
    if (!response.ok) {
      const error = await response.json().catch(() => ({}));
      throw new Error(`Database request failed (${response.status}, ${error.code || 'unknown'}).`);
    }
    const text = await response.text();
    return text ? JSON.parse(text) : null;
  }
  rpc(name, body) { return this.rest(`rpc/${name}`, {method:'POST', body:JSON.stringify(body)}); }
  async rows(query) {
    const all = [];
    for (let offset = 0; ; offset += 1000) {
      const page = await this.rest(`tb_videos?${query}&order=position.asc&limit=1000&offset=${offset}`);
      all.push(...page); if (page.length < 1000) return all;
    }
  }
  async list(status) {
    const rows = await this.rows(`select=id,data&status=eq.${status}&deleted_at=is.null`);
    return rows.map(row => ({...row.data, id:row.id}));
  }
  discoveryQueue(model='gte-small') { return this.rpc('tb_discovery_queue_for',{current_model:model}).then(rows=>rows.map(v=>v.data)); }
  allIds() { return this.rows('select=id'); }
  async get(id) { return (await this.rest(`tb_videos?select=*&id=eq.${encodeURIComponent(id)}&limit=1`))[0] || null; }
  save(items, mode='add', destination='board') { return this.rpc('tb_save',{items,mode,destination}); }
  delete(ids) { return this.rpc('tb_delete',{ids}); }
  decide(ids,destination) { return this.rpc('tb_decide',{ids,destination}); }
  async setting(name, fallback) {
    const rows = await this.rest(`tb_settings?select=value&name=eq.${encodeURIComponent(name)}`);
    return rows[0]?.value ?? fallback;
  }
  setSetting(name, value) {
    return this.rest('tb_settings?on_conflict=name',{method:'POST',headers:{Prefer:'resolution=merge-duplicates,return=minimal'},body:JSON.stringify({name,value})});
  }
  async favorites() { return (await this.rest('tb_favorites?select=video_id&limit=10000')).map(row=>row.video_id); }
  async favorite(id, saved) {
    if (saved) await this.rest('tb_favorites?on_conflict=video_id',{method:'POST',headers:{Prefer:'resolution=ignore-duplicates,return=minimal'},body:JSON.stringify({video_id:id})});
    else await this.rest(`tb_favorites?video_id=eq.${encodeURIComponent(id)}`,{method:'DELETE',headers:{Prefer:'return=minimal'}});
    return {ok:true,id,saved};
  }
  async jobResult(job, error) {
    const update = error ? {last_error:String(error).slice(0,300),next_attempt:new Date(Date.now()+Math.min(86400000,60000*2**job.attempts)).toISOString()} : {completed_at:new Date().toISOString(),last_error:null};
    return this.rest(`tb_jobs?video_id=eq.${encodeURIComponent(job.video_id)}&kind=eq.${job.kind}`,{method:'PATCH',headers:{Prefer:'return=minimal'},body:JSON.stringify(update)});
  }
  async uploadImage(bytes, hash) {
    const path = `${hash}.jpg`;
    let response;
    for(let attempt=0;attempt<4;attempt++) {
      try {
        response = await this.fetcher(`${this.url}/storage/v1/object/thumbnails/${path}`, {
          method:'POST', headers:{apikey:this.key,Authorization:`Bearer ${this.key}`,'Content-Type':'image/jpeg','x-upsert':'false'}, body:bytes, signal:AbortSignal.timeout(30000),
        });
        if(response.status<500 && response.status!==429)break;
      }catch(error){if(attempt===3)throw new Error('Image archive connection failed; retry is safe.');}
      if(attempt<3)await new Promise(resolve=>setTimeout(resolve,1000*2**attempt));
    }
    if (!response.ok) {
      const body = await response.json().catch(()=>({}));
      if (!(response.status === 409 || body.error === 'Duplicate' || body.statusCode === '409')) throw new Error(`Image archive failed (${response.status})`);
    }
    return `${this.url}/storage/v1/object/public/thumbnails/${path}`;
  }
  async upsertEmbedding(id, embedding, metadata, source='board', model='gte-small') {
    return this.rest('tb_embeddings?on_conflict=video_id',{method:'POST',headers:{Prefer:'resolution=merge-duplicates,return=minimal'},body:JSON.stringify({video_id:id,embedding,metadata,source,model,updated_at:new Date().toISOString()})});
  }
  async getEmbedding(id) { return (await this.rest(`tb_embeddings?video_id=eq.${encodeURIComponent(id)}&select=embedding,metadata,model`))[0]; }
  async match(vector, body, model=null) {
    const rows = await this.rpc('tb_match',{query_embedding:vector,match_count:Math.min(50,Math.max(1,Number(body.topK)||12)),include_own:body.includeOwnChannels!==false,include_discovery:body.includeDiscovery!==false,match_model:model});
    return rows.map(row=>({...row.data,...row.metadata,id:row.id,score:row.score,source:row.source}));
  }
}
