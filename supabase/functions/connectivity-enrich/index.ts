import { createClient } from "npm:@supabase/supabase-js@2.111.0";

const BB = "https://api-proxy.ofcom.org.uk/broadband/coverage";
const MOB = "https://api-proxy.ofcom.org.uk/mobile/coverage";
const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};
const networks = [
  ["EE", ["ee"]], ["Three", ["h3","three"]], ["O2", ["tf","o2","virgin","vmo2"]], ["Vodafone", ["vo","vodafone"]]
];

const j = (body, status=200) => new Response(JSON.stringify(body), {status, headers:{...cors,"Content-Type":"application/json"}});
const clamp = v => Math.max(0, Math.min(100, v));
const nk = v => String(v ?? "").toLowerCase().replace(/[^a-z0-9]/g,"");
const num = v => (v === null || v === undefined || v === "" || !Number.isFinite(Number(v))) ? null : Number(v);
const pc = v => { const x=String(v??"").toUpperCase().replace(/\s+/g,""); return x.length>3?`${x.slice(0,-3)} ${x.slice(-3)}`:x; };
const fullPc = v => /^[A-Z]{1,2}\d[A-Z\d]?\s*\d[A-Z]{2}$/i.test(String(v??"").trim());
const med = xs => { xs=xs.filter(Number.isFinite).sort((a,b)=>a-b); if(!xs.length)return null; const m=Math.floor(xs.length/2); return xs.length%2?xs[m]:(xs[m-1]+xs[m])/2; };

function objectRows(payload){
  if(Array.isArray(payload)) return payload.filter(x=>x&&typeof x==="object"&&!Array.isArray(x));
  if(!payload||typeof payload!=="object") return [];
  for(const k of ["BroadbandProvision","MobileProvision","Availability","Results","result","data"]){
    if(Array.isArray(payload[k])) return payload[k].filter(x=>x&&typeof x==="object"&&!Array.isArray(x));
  }
  const q=[payload]; let best=[];
  for(let depth=0; depth<4 && q.length; depth++){
    const next=[];
    for(const obj of q) for(const v of Object.values(obj||{})){
      if(Array.isArray(v)){ const r=v.filter(x=>x&&typeof x==="object"&&!Array.isArray(x)); if(r.length>best.length)best=r; }
      else if(v&&typeof v==="object") next.push(v);
    }
    q.splice(0,q.length,...next);
  }
  return best;
}
function uprn(row){ for(const [k,v] of Object.entries(row||{})) if(nk(k)==="uprn") return String(v??"").replace(/\D/g,""); return ""; }
function chosen(all,u){ u=String(u??"").replace(/\D/g,""); const exact=u&&all.find(r=>uprn(r)===u); return exact?{rows:[exact],mode:"exact_uprn"}:{rows:all,mode:all.length?"postcode_median":"no_rows"}; }
function value(row, patterns, exclude=[]){
  for(const p of patterns) for(const [k,v] of Object.entries(row||{})){
    const n=nk(k); if(p.every(t=>n.includes(t)) && !exclude.some(t=>n.includes(t))){ const x=num(v); if(x!==null)return x; }
  }
  return null;
}
function bool(row, patterns){
  for(const p of patterns) for(const [k,v] of Object.entries(row||{})){
    const n=nk(k); if(!p.every(t=>n.includes(t)))continue;
    if(typeof v==="boolean")return v;
    const s=String(v??"").toLowerCase().trim();
    if(["yes","y","true","available","1"].includes(s))return true;
    if(["no","n","false","unavailable","0"].includes(s))return false;
  }
  return null;
}
function bbScore(d,u,ff,gig){
  if(d===null)return null;
  let ds=d>=1000?100:d>=500?97:d>=300?94:d>=100?90:d>=60?82:d>=30?72:d>=10?50:d>=2?30:10;
  let us=u===null?ds:u>=100?100:u>=50?95:u>=20?88:u>=10?80:u>=5?65:u>=1?45:20;
  return clamp(Math.round(.85*ds+.15*us+(ff?3:0)+(gig||d>=1000?2:0)));
}
function broadband(payload,u){
  const all=objectRows(payload), c=chosen(all,u), downs=[], ups=[], ffs=[], gigs=[];
  for(const r of c.rows){
    const d=value(r,[["max","predicted","down"],["max","down"],["download"],["downstream"]],["percent","percentage","availability","basic","superfast","ultrafast"]);
    const up=value(r,[["max","predicted","up"],["max","up"],["upload"],["upstream"]],["percent","percentage","availability","basic","superfast","ultrafast"]);
    if(d!==null)downs.push(d); if(up!==null)ups.push(up);
    const ff=bool(r,[["full","fibre"],["full","fiber"],["fttp"]]), gig=bool(r,[["gigabit"]]);
    if(ff!==null)ffs.push(ff); if(gig!==null)gigs.push(gig);
  }
  const d=med(downs), up=med(ups), ff=ffs.length?ffs.filter(Boolean).length>=Math.ceil(ffs.length/2):null;
  const gig=gigs.length?gigs.filter(Boolean).length>=Math.ceil(gigs.length/2):(d===null?null:d>=1000);
  return {score:bbScore(d,up,ff,gig),maxDownloadMbps:d,maxUploadMbps:up,fullFibre:ff,gigabit:gig,premiseMode:c.mode,premisesReturned:all.length};
}
function mval(row, aliases, place){
  const vals=[];
  for(const [k,v] of Object.entries(row||{})){
    const n=nk(k); if(!aliases.some(a=>n.startsWith(a))||!n.includes("data")||!n.includes(place)||n.includes("no4g")||n.includes("non4g"))continue;
    const x=num(v); if(x!==null)vals.push(x);
  }
  return vals.length?Math.max(...vals):null;
}
const covScore=v=>v===null?null:v>=4?100:v>=3?65:v>0?40:10;
function mobile(payload,u){
  const all=objectRows(payload), c=chosen(all,u), out=[];
  for(const [label,aliases] of networks){
    const ins=[], outs=[];
    for(const r of c.rows){ const a=mval(r,aliases,"indoor"), b=mval(r,aliases,"outdoor"); if(a!==null)ins.push(a); if(b!==null)outs.push(b); }
    const indoor=med(ins), outdoor=med(outs), a=covScore(indoor), b=covScore(outdoor);
    const score=a!==null&&b!==null?Math.round(.7*a+.3*b):a??b;
    out.push({network:label,indoor,outdoor,score,indoorLabel:indoor===null?"Unknown":indoor>=4?"Likely":indoor>=3?"Limited":"None",outdoorLabel:outdoor===null?"Unknown":outdoor>=4?"Likely":outdoor>=3?"Limited":"None"});
  }
  const scores=out.map(x=>x.score).filter(x=>x!==null), top=[...scores].sort((a,b)=>b-a).slice(0,2);
  const score=scores.length?clamp(Math.round(.6*(scores.reduce((a,b)=>a+b,0)/scores.length)+.4*(top.reduce((a,b)=>a+b,0)/top.length))):null;
  return {score,networks:out,likelyIndoorNetworks:out.filter(x=>x.indoor!==null&&x.indoor>=4).length,likelyOutdoorNetworks:out.filter(x=>x.outdoor!==null&&x.outdoor>=4).length,premiseMode:c.mode,premisesReturned:all.length};
}
async function ofcom(url,key){
  if(!key)return {ok:false,missing:true,status:null,error:"API key not configured"};
  const r=await fetch(url,{headers:{"Accept":"application/json","Ocp-Apim-Subscription-Key":key,"User-Agent":"House-Ranker/1.4"}});
  const t=await r.text(); let data=null; try{data=t?JSON.parse(t):null}catch{}
  if(!r.ok)return {ok:false,missing:false,status:r.status,error:String(data?.message||data?.Error||data?.error||t||`HTTP ${r.status}`).slice(0,300)};
  return {ok:true,status:r.status,data};
}

Deno.serve(async req=>{
  if(req.method==="OPTIONS")return new Response("ok",{headers:cors});
  if(req.method!=="POST")return j({error:"Method not allowed"},405);
  const auth=req.headers.get("Authorization")??"";
  if(!auth.startsWith("Bearer "))return j({error:"Authentication required"},401);

  const url=Deno.env.get("SUPABASE_URL")??"", anon=Deno.env.get("SUPABASE_ANON_KEY")??"";
  let key=anon; try{key=JSON.parse(Deno.env.get("SUPABASE_PUBLISHABLE_KEYS")??"{}").default||anon}catch{}
  const sb=createClient(url,key,{auth:{persistSession:false,autoRefreshToken:false},global:{headers:{Authorization:auth}}});
  const token=auth.replace(/^Bearer\s+/i,""), {data:ud,error:ue}=await sb.auth.getUser(token);
  if(ue||!ud.user)return j({error:"Invalid session"},401);

  let propertyId=""; try{propertyId=String((await req.json())?.propertyId??"")}catch{return j({error:"Invalid JSON body"},400)}
  if(!propertyId)return j({error:"propertyId is required"},400);

  const {data:p,error:pe}=await sb.from("properties").select("id,address,postcode,epc_uprn,metrics").eq("id",propertyId).single();
  if(pe||!p)return j({error:"Property not found"},404);

  const activeSince=new Date(Date.now()-120000).toISOString();
  const {data:active}=await sb.from("enrichment_runs").select("id").eq("property_id",propertyId).eq("source","connectivity").eq("status","running").gte("started_at",activeSince).limit(1);
  if(active?.length)return j({status:"already_running",property:p});

  const {data:run}=await sb.from("enrichment_runs").insert({property_id:propertyId,source:"connectivity",status:"running",started_at:new Date().toISOString(),payload:{postcode:p.postcode||null,uprn:p.epc_uprn||null}}).select("id").single();
  const finish=async(status,payload,msg=null)=>{if(run?.id)await sb.from("enrichment_runs").update({status,finished_at:new Date().toISOString(),payload,error_message:msg}).eq("id",run.id)};

  try{
    const postcode=pc(p.postcode), now=new Date().toISOString();
    if(!fullPc(postcode)){
      const {data:updated}=await sb.from("properties").update({connectivity_status:"needs_location",connectivity_enriched_at:now,updated_at:now}).eq("id",propertyId).select("*").single();
      await finish("succeeded",{outcome:"needs_location"}); return j({status:"needs_location",property:updated});
    }

    const bbKey=Deno.env.get("OFCOM_BROADBAND_API_KEY")??"", mobKey=Deno.env.get("OFCOM_MOBILE_API_KEY")??"";
    if(!bbKey&&!mobKey){
      const {data:updated}=await sb.from("properties").update({connectivity_status:"needs_api_keys",connectivity_enriched_at:now,updated_at:now}).eq("id",propertyId).select("*").single();
      await finish("succeeded",{outcome:"needs_api_keys"}); return j({status:"needs_api_keys",property:updated});
    }

    const compact=postcode.replace(/\s+/g,"");
    const [br,mr]=await Promise.all([ofcom(`${BB}/${encodeURIComponent(compact)}`,bbKey),ofcom(`${MOB}/${encodeURIComponent(compact)}`,mobKey)]);
    const b=br.ok?broadband(br.data,p.epc_uprn):null, m=mr.ok?mobile(mr.data,p.epc_uprn):null;
    const bs=b?.score??null, ms=m?.score??null;
    const score=bs!==null&&ms!==null?clamp(Math.round(.7*bs+.3*ms)):bs??ms;
    const successes=(br.ok?1:0)+(mr.ok?1:0), status=successes===2?"matched":successes===1?"partial":"error";
    const metrics={...(p.metrics??{})}; if(score!==null)metrics.connectivity=score;

    const {data:updated,error:upErr}=await sb.from("properties").update({
      connectivity_status:status,connectivity_score:score,broadband_score:bs,mobile_score:ms,
      broadband_max_download_mbps:b?.maxDownloadMbps??null,broadband_max_upload_mbps:b?.maxUploadMbps??null,
      broadband_full_fibre:b?.fullFibre??null,broadband_gigabit:b?.gigabit??null,
      mobile_likely_indoor_networks:m?.likelyIndoorNetworks??null,mobile_likely_outdoor_networks:m?.likelyOutdoorNetworks??null,
      connectivity_enriched_at:now,metrics,updated_at:now
    }).eq("id",propertyId).select("*").single();
    if(upErr)throw upErr;

    const {data:area}=await sb.from("area_metrics").select("raw_data").eq("property_id",propertyId).maybeSingle();
    const raw={...(area?.raw_data??{}),connectivity:{
      source:"Ofcom Connected Nations postcode coverage APIs",postcode,uprn:p.epc_uprn||null,status,score,
      scoreMethod:"70% broadband + 30% mobile when both sources are available",
      broadband:b?{...b,apiStatus:br.status}:{apiStatus:br.status,error:br.error,missingKey:br.missing||false},
      mobile:m?{...m,apiStatus:mr.status}:{apiStatus:mr.status,error:mr.error,missingKey:mr.missing||false},
      note:"Ofcom coverage figures are predictions. Exact-premises matching uses the EPC UPRN when returned; otherwise House Ranker uses the postcode median."
    }};
    const {error:ae}=await sb.from("area_metrics").upsert({property_id:propertyId,connectivity_score:score,raw_data:raw,refreshed_at:now},{onConflict:"property_id"});
    if(ae)throw ae;

    const failures=[br.ok?null:`Broadband: ${br.error}`,mr.ok?null:`Mobile: ${mr.error}`].filter(Boolean);
    await finish(status==="error"?"failed":"succeeded",{outcome:status,score,broadbandScore:bs,mobileScore:ms,failures},failures.join(" | ")||null);
    return j({status,score,broadbandScore:bs,mobileScore:ms,broadband:b,mobile:m,property:updated,failures},status==="error"?502:200);
  }catch(e){
    const msg=e instanceof Error?e.message:String(e), now=new Date().toISOString();
    await sb.from("properties").update({connectivity_status:"error",connectivity_enriched_at:now,updated_at:now}).eq("id",propertyId);
    await finish("failed",{outcome:"error"},msg);
    return j({error:"Connectivity lookup failed",detail:msg},502);
  }
});
