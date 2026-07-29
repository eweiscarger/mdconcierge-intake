const CORS={ "Access-Control-Allow-Origin":"*","Access-Control-Allow-Headers":"authorization, x-client-info, apikey, content-type","Access-Control-Allow-Methods":"POST, OPTIONS" };
const J=(o,s=200)=>new Response(JSON.stringify(o),{status:s,headers:{...CORS,"Content-Type":"application/json"}});
const RULES=`You write physician-outreach emails as Eric Weiscarger, founder of MDconcierge. Match his voice exactly.
HARD RULES (never break):
- Brief. Fits a phone screen, a few short lines. Say it and stop.
- NO em dashes or en dashes, ever. Use periods or commas. Normal word hyphens like "work-comp" are fine.
- Warm, personable, peer to peer. Sound like a real person firing off a genuine note, never salesy, no marketing gloss.
- Ranges in plain words, like "20 to 30 minutes", never a dashed range.
- Lead with value. State BOTH the patient benefit (workers' comp medications delivered to the patient's home, typically overnight, at no out-of-pocket cost) AND a meaningful ancillary revenue opportunity for the practice.
- NEVER mention commission or Eric's compensation.
- Banned phrases: "check in", "circle back", "follow up". Never use them.
- Never invent numbers, names, facts, or legal conclusions.
- Soft, flexible close asking for a short call or Zoom (15 to 30 minutes).
- Sign off exactly: "Best," then a new line, then "Eric".
- Natural variation every time. Never sound templated.`;
const BUCKETS={
 cold:`COLD prospect (no known relationship). Lead with targeted relevance and value, build credibility fast (named program, named attorneys/materials on hand). Keep the ask small and low pressure.`,
 warm:`WARM prospect (Eric knows them personally or professionally, program not discussed). Open with a brief, genuine personal note, then get to value quickly. Softer framing, offer a couple of easy meeting formats (Zoom, phone, or in person).`,
 previously_engaged:`PREVIOUSLY ENGAGED (has seen it before, has not moved). Reintroduce the value and remove friction. No nagging. Give a concrete, low-effort next step and a light reason to decide now.`,
 existing_low_util:`EXISTING LOW-UTILIZATION (already signed up, not using it much). Protect the relationship, never imply failure. Frame as unrealized opportunity and simple workflow optimization. Offer a brief utilization review and what higher-performing offices do. Tie to both patient service and practice revenue.`
};
Deno.serve(async (req)=>{
  if(req.method==="OPTIONS")return new Response("ok",{headers:CORS});
  try{
    const aKey=Deno.env.get("ANTHROPIC_API_KEY"); if(!aKey)return J({ok:false,error:"no anthropic key"},500);
    const p=await req.json();
    const isPA=String(p.state||"").toUpperCase()==="PA";
    const hasPharm=!!(p.pharmacy && p.program_name);
    const name=[p.first_name,p.last_name].filter(Boolean).join(" ")||"Doctor";
    const merge={ name, last_name:p.last_name||"", specialty:p.specialty||"", practice:p.practice_name||"", state:p.state||"", wc_volume:p.wc_volume||"", hook:p.hook||"", mutual_contact:p.mutual_contact||"", prior_touch:p.prior_touch||"" };
    const pharmClause = hasPharm
      ? `PHARMACY: name the program in full as "${p.program_name}". ${p.partner_name?('Copy the partner explicitly with a line like "I have copied my partner, '+p.partner_name+', so we are all connected." Offer to send a brief overview, the compliance opinion from Alice G. Gosfield and Associates, and the supporting agreements.'):''}`
      : `NO pharmacy is selected for this provider: do NOT name any specific program, partner, or documents. Keep it a general, warm note offering to share more.`;
    const paClause = isPA
      ? `PENNSYLVANIA HOOK (optional, use one tasteful sentence near the top only if it fits): "With recent Pennsylvania Supreme Court authority confirming that physicians may hold an economic interest in a properly structured workers' compensation pharmacy receivable, more practices are taking another look." Deliver it as settled permission, not a lecture. Do not overstate beyond this wording.`
      : `The provider is NOT in Pennsylvania. Do NOT include any Pennsylvania or Supreme Court line.`;
    const prompt=`${RULES}\n\nTHIS EMAIL IS A: ${BUCKETS[p.bucket]||BUCKETS.cold}\n\nMERGE FIELDS (use only the ones that are filled, never output blanks or brackets): ${JSON.stringify(merge)}\n${pharmClause}\n${paClause}\n\nPersonalization: if specialty is given, you may note that ${p.specialty||"their"} practices see a steady flow of workers' compensation injuries where this fits. If a mutual contact or prior touchpoint is given, reference it naturally. Never fabricate any of these.\n\nWrite the email now. Return ONLY a JSON object: {"subject":"...","body":"..."} where body is the full email body (greeting through the Eric sign-off), no subject line inside the body, and no dashes as punctuation.`;
    const r=await fetch("https://api.anthropic.com/v1/messages",{method:"POST",headers:{"x-api-key":aKey,"anthropic-version":"2023-06-01","content-type":"application/json"},body:JSON.stringify({model:"claude-haiku-4-5-20251001",max_tokens:700,messages:[{role:"user",content:prompt}]})});
    const jd=await r.json();
    let txt=((jd.content&&jd.content[0]&&jd.content[0].text)||"").trim().replace(/^```(?:json)?/i,"").replace(/```$/,"").trim();
    let out; try{ out=JSON.parse(txt); }catch(e){ out={subject:"", body:txt}; }
    return J({ok:true, subject:out.subject||"", body:out.body||""});
  }catch(e){ return J({ok:false,error:String((e&&e.message)||e)},500); }
});
