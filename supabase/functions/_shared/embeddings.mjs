// Search embeddings. The pgvector column is 384-dimensional, so every provider
// must return 384 values. Each stored vector records the model that produced it
// and search only compares vectors from the same model.
export const DIMENSIONS=384;

function normalize(values) {
  if(!Array.isArray(values)||values.length!==DIMENSIONS||values.some(v=>!Number.isFinite(v))) throw new Error(`Embedding provider must return ${DIMENSIONS} finite values.`);
  const norm=Math.hypot(...values);
  if(!norm) throw new Error('Embedding provider returned an empty vector.');
  return values.map(v=>v/norm);
}

// OpenAI-compatible /embeddings endpoint (OpenAI text-embedding-3-*, Jina v3, …).
// The provider must honour `dimensions`; a wrong length is rejected, never stored.
export function openAiCompatibleEmbedder({url,key,model,fetcher=fetch}) {
  if(!url||!key||!model) throw new Error('EMBEDDING_API_URL, EMBEDDING_API_KEY and EMBEDDING_MODEL are required together.');
  return {
    model,
    async embed(text) {
      let response;
      for(let attempt=0;attempt<3;attempt++) {
        response=await fetcher(url,{method:'POST',headers:{'Content-Type':'application/json',Authorization:`Bearer ${key}`},body:JSON.stringify({model,input:text,dimensions:DIMENSIONS}),signal:AbortSignal.timeout(30000)});
        if(response.status!==429&&response.status<500) break;
        if(attempt<2) await new Promise(resolve=>setTimeout(resolve,1000*2**attempt));
      }
      if(!response.ok) throw new Error(`Embedding provider failed (${response.status}).`);
      const body=await response.json();
      return normalize(body?.data?.[0]?.embedding);
    },
  };
}

export function createEmbedder(env, nativeSession) {
  if(env.EMBEDDING_API_URL||env.EMBEDDING_API_KEY||env.EMBEDDING_MODEL) {
    return openAiCompatibleEmbedder({url:env.EMBEDDING_API_URL,key:env.EMBEDDING_API_KEY,model:env.EMBEDDING_MODEL});
  }
  return {model:'gte-small',embed:async text=>normalize(Array.from(await nativeSession().run(text,{mean_pool:true,normalize:true})))};
}
