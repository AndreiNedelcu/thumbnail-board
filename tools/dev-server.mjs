// Local preview uses a separate PostgreSQL database. Never writes to the repo data.
import { createServer } from 'node:http';
import { readFile, mkdir } from 'node:fs/promises';
import { randomBytes } from 'node:crypto';
import { resolve, extname } from 'node:path';
import { openLocalStore } from './local-store.mjs';
import { createHandler } from '../supabase/functions/_shared/api.mjs';

await mkdir('.local',{recursive:true});
const store=await openLocalStore('.local/database',true);
const token=randomBytes(32).toString('hex');
const port=Number(process.env.PORT||8080);
const allowed=new Set([`127.0.0.1:${port}`,`localhost:${port}`]);
const handler=createHandler({store,authToken:token,youtubeKey:process.env.YOUTUBE_API_KEY,
  embed:async()=>{throw new Error('Semantic search requires the Supabase AI runtime.');}});
const mime={'.html':'text/html','.js':'text/javascript','.css':'text/css','.json':'application/json','.svg':'image/svg+xml','.png':'image/png','.jpg':'image/jpeg'};
createServer(async(req,res)=>{
  if(!allowed.has(req.headers.host)){res.writeHead(403).end();return;}
  const base='http://'+req.headers.host;
  const path=new URL(req.url,base).pathname;
  try{
    if(path.startsWith('/api/')){
      const origin=req.headers.origin;
      if(origin&&origin!==base){res.writeHead(403).end();return;}
      const headers=new Headers(req.headers);
      if(req.headers.cookie?.split(';').some(c=>c.trim()==='tb-local='+token))headers.set('X-Auth-Token',token);
      const chunks=[];let size=0;
      for await(const chunk of req){size+=chunk.length;if(size>2000000){res.writeHead(413).end();return;}chunks.push(chunk);}
      const response=await handler(new Request(base+path,{method:req.method,headers,body:['GET','HEAD'].includes(req.method)?undefined:Buffer.concat(chunks)}));
      res.writeHead(response.status,Object.fromEntries(response.headers));res.end(Buffer.from(await response.arrayBuffer()));return;
    }
    let file;
    if(/^\/local-images\/[a-f0-9]{64}\.jpg$/.test(path))file=resolve('.local/images',path.split('/').pop());
    else if(path==='/'||/^\/[\w.-]+\.(html|js|css|json|svg|png)$/.test(path))file=resolve(path==='/'?'index.html':path.slice(1));
    else {res.writeHead(404).end();return;}
    let body;
    try {body=await readFile(file);}
    catch(error){if(path.startsWith('/local-images/')&&error.code==='ENOENT')body=await readFile(resolve('.local/asset-backup/images',path.split('/').pop()));else throw error;}
    res.writeHead(200,{'Content-Type':mime[extname(file)]||'application/octet-stream','Cache-Control':'no-store','Set-Cookie':`tb-local=${token}; HttpOnly; SameSite=Strict; Path=/`});res.end(body);
  }catch(error){res.writeHead(500,{'Content-Type':'application/json'}).end(JSON.stringify({ok:false,msg:error.message}));}
}).listen(port,'127.0.0.1',()=>console.log(`Thumbnail Board preview: http://127.0.0.1:${port} (separate local database)`));
