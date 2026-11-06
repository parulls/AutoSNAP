import { NextRequest } from "next/server";

export const runtime="nodejs";
export const dynamic="force-dynamic";

async function forward(request:NextRequest){
  const origin=request.headers.get("origin");
  if(origin&&origin!==new URL(request.url).origin)return Response.json({error:"Origin tidak diizinkan."},{status:403});
  const port=Number(process.env.AUTOSNAP_API_PORT??4010);
  const headers=new Headers({"Content-Type":"application/json","X-AutoSnap-Host":new URL(request.url).hostname,"X-AutoSnap-Proto":new URL(request.url).protocol.replace(":","")});
  const cookie=request.headers.get("cookie");if(cookie)headers.set("Cookie",cookie);
  try{
    const upstream=await fetch(`http://127.0.0.1:${port}/autosnap`,{method:request.method,headers,body:request.method==="POST"?await request.text():undefined,cache:"no-store",signal:AbortSignal.timeout(180000)});
    const responseHeaders=new Headers({"Content-Type":upstream.headers.get("content-type")??"application/json","Cache-Control":"no-store"});
    for(const value of upstream.headers.getSetCookie())responseHeaders.append("Set-Cookie",value);
    return new Response(upstream.body,{status:upstream.status,headers:responseHeaders});
  }catch{return Response.json({error:"Backend AutoSNAP tidak tersedia. Jalankan npm run dev untuk memulai frontend dan backend."},{status:503});}
}
export const GET=forward;
export const POST=forward;
