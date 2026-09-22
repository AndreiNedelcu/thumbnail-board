// Run repeatedly to complete the resumable image/channel backfill.
const api=process.env.TB_API_URL?.replace(/\/$/,'');
if(!api||!process.env.TB_AUTH_TOKEN)throw new Error('Set TB_API_URL and TB_AUTH_TOKEN.');
const max=Number(process.env.TB_JOB_BATCHES||20);
for(let i=0;i<max;i++){
  const response=await fetch(api+'/api/maintenance/run',{method:'POST',headers:{'Content-Type':'application/json','X-Auth-Token':process.env.TB_AUTH_TOKEN},body:JSON.stringify({limit:5}),signal:AbortSignal.timeout(180000)});
  const data=await response.json();
  if(!response.ok||!data.ok)throw new Error(data.msg||'Asset batch failed');
  console.log(JSON.stringify({batch:i+1,...data}));
  if(!data.processed)break;
}
