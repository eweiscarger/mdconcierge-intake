// ADMIN-ONLY commission calc. Server-side so the formula/margins never live in the public page.
// verify_jwt=true -> only a logged-in admin can call it. Result is never part of any doctor-facing quote.
const CORS={ "Access-Control-Allow-Origin":"*","Access-Control-Allow-Headers":"authorization, x-client-info, apikey, content-type","Access-Control-Allow-Methods":"POST, OPTIONS" };
const J=(o,s=200)=>new Response(JSON.stringify(o),{status:s,headers:{...CORS,"Content-Type":"application/json"}});
Deno.serve(async (req)=>{
  if(req.method==="OPTIONS")return new Response("ok",{headers:CORS});
  try{
    const b=await req.json();
    const net=Number(b.net)||0;
    const share=(b.share!=null?Number(b.share):0.65);      // practice share of net (doctor keeps this)
    const pct=(b.commission_pct!=null?Number(b.commission_pct):30); // Eric's % of the company-kept portion
    const companyKept=net*(1-share);        // 35% of net by default
    const commission=companyKept*(pct/100); // 30% of that
    return J({ ok:true, monthly:commission, annual:commission*12, company_kept_monthly:companyKept });
  }catch(e){ return J({ok:false,error:String((e&&e.message)||e)},500); }
});
